// GIF 动图 → 多张静态帧（dataUrl 数组）。
//
// ── 为什么需要这个模块（2026-10-18 现场）─────────────────────────────────
// 现在用的模型（deepseek v4.1 flash）**只能看静态图**：
//   · 把 GIF 原样当 `image_url` 发过去 → 模型只解得到第一帧，回答"这张图不动/就一张"；
//   · 关掉「模型支持视频输入」(`api.video=false`) 后，核心对 GIF 就走 `gif-image` 路线，
//     原样发送 → 还是只有第一帧；
//   · 打开 `api.video` 又把 GIF 转成 mp4 发 `video_url` → DeepSeek 接口直接 422
//     （unknown variant `video_url`），整轮失败。
// 所以对这类模型唯一正确的做法是：**在本地把动图抽成 6~12 张静态帧**，
// 以多张 `image_url` 发给模型 —— 既能看到动作，又不需要模型支持视频。
//
// 抽帧实现不在核心：`plugins/video-frames/frames.js`（能力 `video.frames` 的提供者）
// 已经能处理 GIF，本模块只负责「字节 → 临时文件 → 按时长定帧数 → 抽帧 → 去重」。
//
// 帧数口径与 frame-detective / image-ref-hint 保持一致：约 4 帧/秒，夹在 6~12 帧
// （GIF 是循环动作，1 帧/秒太稀，超过 12 帧对模型意义不大还费 token）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './config.js';

const FRAMES_MIN = 6;
const FRAMES_MAX = 12;
const MAX_WIDTH = 768;

let framesMod = null;
let framesModTried = false;

/** 找到能抽帧的实现：优先插件目录里的 frames.js，其次能力注册表。 */
async function loadFramesModule() {
  if (framesModTried) return framesMod;
  framesModTried = true;
  for (const rel of [
    ['plugins', 'video-frames', 'frames.js'],
    ['plugins', 'frame-detective', 'frames.js']
  ]) {
    try {
      const mod = await import(pathToFileURL(path.join(ROOT, ...rel)).href);
      if (typeof mod?.extractFrames === 'function') {
        framesMod = mod;
        return framesMod;
      }
    } catch {
      /* 换下一个候选 */
    }
  }
  // 兜底：Skill 注册的 `video.frames` 能力（只接受文件路径，形状与 extractFrames 同）
  try {
    const { skillManager } = await import('./skills/manager.js');
    const providers = skillManager.getCapabilityProviders('video.frames', {});
    if (providers.length) {
      framesMod = {
        extractFrames: async (opts) => {
          for (const p of providers) {
            try {
              const r = await p.fn(opts);
              if (r && Array.isArray(r.frames) && r.frames.length) return r;
            } catch {
              /* 换下一个提供者 */
            }
          }
          return { frames: [] };
        }
      };
    }
  } catch {
    /* 拿不到就算了，调用方会退回原图 */
  }
  return framesMod;
}

/** 去掉重复帧：同一张图（首帧被重复输出）字节相同。 */
function dedupeFrames(frames) {
  const seen = new Set();
  const out = [];
  for (const u of frames) {
    if (typeof u !== 'string' || !u.startsWith('data:')) continue;
    const comma = u.indexOf(',');
    if (comma < 0) continue;
    const key = u.slice(comma + 1, comma + 400);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

/**
 * 把 GIF 字节抽成多张静态帧。
 *
 * @param {Buffer} buffer GIF 文件字节
 * @param {{max?:number,min?:number,maxWidth?:number}} [opts]
 * @returns {Promise<string[]>} dataUrl 数组（≥2 张才有意义；抽不出来返回 []）
 */
export async function gifFramesDataUrls(buffer, { max = FRAMES_MAX, min = FRAMES_MIN, maxWidth = MAX_WIDTH } = {}) {
  if (!buffer || !buffer.length) return [];
  const mod = await loadFramesModule();
  if (!mod?.extractFrames) return [];
  const tmp = path.join(os.tmpdir(), `qq-agent-gif-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.gif`);
  try {
    fs.writeFileSync(tmp, buffer);
    let count = 0;
    if (typeof mod.probeDuration === 'function') {
      try {
        const dur = await mod.probeDuration(tmp);
        if (Number(dur) > 0) count = Math.min(max, Math.max(min, Math.round(Number(dur) * 4)));
      } catch {
        /* 读不到时长就用 frames.js 的默认帧数 */
      }
    }
    const r = await mod.extractFrames({ filePath: tmp, count: count || undefined, maxWidth, labels: true });
    const frames = dedupeFrames(Array.isArray(r?.frames) ? r.frames : []);
    return frames.length > 1 ? frames.slice(0, max) : [];
  } catch {
    return [];
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 删不掉就算了 */
    }
  }
}

export const GIF_FRAMES_MIN = FRAMES_MIN;
export const GIF_FRAMES_MAX = FRAMES_MAX;
