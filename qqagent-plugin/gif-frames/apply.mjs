#!/usr/bin/env node
// 核心补丁：让 **GIF 动图自动抽成多张静态帧**（给"只能看静态图"的模型）。
//
// ── 为什么 ────────────────────────────────────────────────────────────────
// 现在用的模型（deepseek v4.1 flash）只能看静态图，而核心原来对 GIF 只有三条路：
//   · `api.video=true`  → 转 mp4 发 `video_url` → DeepSeek 接口 422（unknown variant video_url）
//   · `api.video=false` → 原样发 GIF → 模型只解得到**第一帧**
//   · 视觉关掉          → 看图工具整个不存在
// 两条能用的路都拿不到动作。于是补一档：**本地抽帧**，把动图变成 6~12 张静态图，
// 以多张 `image_url` 发过去。不需要模型支持视频，也不改任何 UI 设置。
//
// 改动（`src/tools.js` 三处 + 新增 `src/gif-frames.js`）：
//   1. 顶部加一行 `import { gifFramesDataUrls } from './gif-frames.js';`
//   2. `downloadImageAsDataUrl()` 里，GIF 且没走 video 路线时 → 抽帧，返回 `{ frames: [...] }`
//   3. `getImagePartsOrVideo()` 里，`frames` 有多张时逐张 push `image_url`
//
// ── 用法 ──────────────────────────────────────────────────────────────────
//   node qqagent-plugin/gif-frames/apply.mjs            # 打补丁 + 自检（真抽一次帧）
//   node qqagent-plugin/gif-frames/apply.mjs --check    # 只看状态 + 跑自检（不改文件）
//   node qqagent-plugin/gif-frames/apply.mjs --revert   # 还原（删掉新文件 + 恢复 tools.js）
//   node qqagent-plugin/gif-frames/apply.mjs --app "D:\别的路径\resources\app"
//
// ⚠️ `src/tools.js` 是**核心文件**，要**重启 QQ Agent** 才生效。
//    本补丁是新功能，不打也不会崩：GIF 仍按原样发（模型只看到第一帧）。
//    QQ Agent 升级会覆盖 resources/app → 补丁没了，重跑一次即可。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_APP = 'D:\\qqagent\\QQ Agent\\resources\\app';
const MODULE_SRC = path.join(HERE, 'gif-frames.js');

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const APP_DIR = argValue('--app', process.env.QQ_AGENT_APP || DEFAULT_APP);
const TOOLS = path.join(APP_DIR, 'src', 'tools.js');
const MODULE_DST = path.join(APP_DIR, 'src', 'gif-frames.js');
const BACKUP = `${TOOLS}.bak-gifframes`;

const MARK = '/* gif-frames patch */';
const mode = process.argv.includes('--revert')
  ? 'revert'
  : process.argv.includes('--check')
    ? 'check'
    : 'apply';

function fail(msg) {
  console.log(`✗ ${msg}`);
  process.exitCode = 1;
}

if (!fs.existsSync(TOOLS)) {
  fail(`找不到核心文件：${TOOLS}（用 --app 指定 resources/app）`);
  process.exit(1);
}

const RAW = fs.readFileSync(TOOLS, 'utf8');
// 统一按 LF 做匹配（核心文件是 CRLF，多行锚点直接比会全部落空 —— 2026-10-18 踩过）
const EOL = RAW.includes('\r\n') ? '\r\n' : '\n';
const source = RAW.replace(/\r\n/g, '\n');
const patched = source.includes(MARK);
console.log(`核心文件：${TOOLS}`);
console.log(`当前状态：${patched ? '已打补丁' : '未打补丁'}（模块 ${fs.existsSync(MODULE_DST) ? '在位' : '缺失'}）`);

// ── 自检：真拿一张 GIF 抽一次帧 ───────────────────────────────────────────
async function selfTest() {
  if (!fs.existsSync(MODULE_DST)) {
    console.log('  ✗ 抽帧模块不在位，跳过自检');
    return false;
  }
  const mod = await import(`${pathToFileURL(MODULE_DST).href}?v=${Date.now()}`);
  if (typeof mod.gifFramesDataUrls !== 'function') {
    console.log('  ✗ 模块没有导出 gifFramesDataUrls');
    return false;
  }
  const gif = findSampleGif();
  if (!gif) {
    console.log('  · 没找到样本 GIF，只做静态检查');
    return true;
  }
  const buf = fs.readFileSync(gif);
  const t0 = Date.now();
  const frames = await mod.gifFramesDataUrls(buf);
  const ok = Array.isArray(frames) && frames.length >= 6;
  console.log(
    `  ${ok ? '✓' : '✗'} 抽帧自检：${path.basename(gif)}（${(buf.length / 1048576).toFixed(1)}MB）→ ${frames.length} 帧，耗时 ${Math.round((Date.now() - t0) / 1000)}s`
  );
  if (frames.length) {
    const sizes = frames.slice(0, 4).map((u) => `${Math.round(u.length / 1024)}KB`).join(' ');
    console.log(`      前几帧：${sizes}；全部 data URL：${frames.every((u) => u.startsWith('data:image/'))}`);
  }
  return ok;
}

/** 找样本 GIF：优先用户目录里下过/缓存过的动图。 */
function findSampleGif() {
  const roots = [
    path.join(APP_DIR, '..', '..', 'data'),
    path.resolve(APP_DIR, '..', '..', '..', 'data')
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const hit = walkForGif(root, 3);
    if (hit) return hit;
  }
  return '';
}

function walkForGif(dir, depth) {
  if (depth < 0) return '';
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const e of entries) {
    if (e.isFile() && /\.gif$/i.test(e.name)) {
      const full = path.join(dir, e.name);
      try {
        if (fs.statSync(full).size > 20000) return full;
      } catch {
        /* ignore */
      }
    }
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = walkForGif(path.join(dir, e.name), depth - 1);
    if (hit) return hit;
  }
  return '';
}

// ── 撤回 ─────────────────────────────────────────────────────────────────
if (mode === 'revert') {
  if (fs.existsSync(BACKUP)) {
    fs.copyFileSync(BACKUP, TOOLS);
    fs.unlinkSync(BACKUP);
    console.log('✓ 已恢复 tools.js（备份已删除）');
  } else {
    console.log('· 没有备份，tools.js 未改动');
  }
  if (fs.existsSync(MODULE_DST)) {
    fs.unlinkSync(MODULE_DST);
    console.log('✓ 已删除 src/gif-frames.js');
  }
  console.log('重启 QQ Agent 后生效');
  process.exit(0);
}

if (mode === 'check') {
  if (!patched) {
    console.log('结论：未打补丁（GIF 仍按原样发，静态图模型只看到第一帧）');
    process.exit(0);
  }
  const ok = await selfTest();
  console.log(ok ? '结论：已打补丁且抽帧可用' : '结论：已打补丁但抽帧自检没过，建议 --revert 后重打');
  process.exit(ok ? 0 : 1);
}

if (patched && fs.existsSync(MODULE_DST)) {
  const ok = await selfTest();
  console.log(ok ? '✓ 补丁已在位，无需重复打' : '✗ 补丁在但自检没过，建议 --revert 后重打');
  process.exit(ok ? 0 : 1);
}

// ── 打补丁 ───────────────────────────────────────────────────────────────
const ANCHOR_IMPORT = "import { isGifBuffer, gifToVideoDataUrl, resolveGifRoute } from './gif-to-video.js';";
const ANCHOR_VIDEO_BRANCH = `  if (isGifBuffer(buffer) && currentGifRoute() === 'video') {`;
const ANCHOR_PARTS = `  for (const r of results) {
    if (r?.gifVideo) {
      parts.push({ type: 'video_url', video_url: { url: r.gifVideo.dataUrl } });
    } else {
      parts.push({ type: 'image_url', image_url: { url: r.dataUrl } });
      if (r?.isGif) gifAsImage.push(r);
    }
  }`;

for (const [name, anchor] of [
  ['import 行', ANCHOR_IMPORT],
  ['video 分支', ANCHOR_VIDEO_BRANCH],
  ['getImagePartsOrVideo 循环', ANCHOR_PARTS]
]) {
  const count = source.split(anchor).length - 1;
  if (count !== 1) {
    fail(`定位失败：${name} 出现 ${count} 次（应为 1）—— 核心版本可能变了`);
    process.exit(1);
  }
}

fs.copyFileSync(TOOLS, BACKUP);
fs.copyFileSync(MODULE_SRC, MODULE_DST);
console.log(`✓ 已安装 src/gif-frames.js（备份：${BACKUP}）`);

let next = source.replace(
  ANCHOR_IMPORT,
  `${ANCHOR_IMPORT}\n${MARK}
import { gifFramesDataUrls } from './gif-frames.js';`
);

// 在 video 分支的整个 if 块之后插入抽帧分支：用 "转换失败 … 落到下面的普通图片路径" 那句作锚
const anchorAfterVideoBranch = `    // 转换失败（没 ffmpeg / 文件异常）→ 落到下面的普通图片路径，按原样发
  }`;
if (next.split(anchorAfterVideoBranch).length - 1 !== 1) {
  fs.copyFileSync(BACKUP, TOOLS);
  fail('定位失败：video 分支结尾（"转换失败…"那句话）找不到或重复');
  process.exit(1);
}
next = next.replace(
  anchorAfterVideoBranch,
  `${anchorAfterVideoBranch}
  // ${MARK} 静态图模型只能看到 GIF 的第一帧 → 本地抽成多张静态帧（6~12 张）
  if (isGifBuffer(buffer)) {
    const frames = await gifFramesDataUrls(buffer);
    if (frames.length > 1) {
      return { dataUrl: frames[0], frames, isGif: true, gifBuffer: buffer };
    }
  }`
);

next = next.replace(
  ANCHOR_PARTS,
  `  let gifFramesPosts = 0;
  for (const r of results) {
    if (r?.gifVideo) {
      parts.push({ type: 'video_url', video_url: { url: r.gifVideo.dataUrl } });
    } else if (Array.isArray(r?.frames) && r.frames.length > 1) {
      // ${MARK} 抽帧路线：一张动图 = 多张静态图，模型能逐帧看出动作
      for (const u of r.frames) parts.push({ type: 'image_url', image_url: { url: u } });
      gifFramesPosts += 1;
    } else {
      parts.push({ type: 'image_url', image_url: { url: r.dataUrl } });
      if (r?.isGif) gifAsImage.push(r);
    }
  }
  if (gifFramesPosts) {
    parts[0].text += \`\\n（其中 \${gifFramesPosts} 张是 GIF 动图，已抽成多张静态图按顺序发送，不是多张不同的图）\`;
  }`
);

fs.writeFileSync(TOOLS, next.replace(/\n/g, EOL), 'utf8');
console.log('✓ tools.js 已打补丁（3 处）');

const ok = await selfTest();
if (!ok) {
  fs.copyFileSync(BACKUP, TOOLS);
  if (fs.existsSync(MODULE_DST)) fs.unlinkSync(MODULE_DST);
  fail('自检没过，已自动还原');
  process.exit(1);
}
console.log('✓ 自检通过 —— **重启 QQ Agent 后生效**');
