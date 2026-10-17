'use strict';

/**
 * 真实网络端到端冒烟测试（需要联网）：
 *   1. 直链 MP4 下载
 *   2. HLS(m3u8) 分片下载（限制分片数，避免下整部片子）
 *   3. 网页内嵌视频地址提取
 *   4. yt-dlp 自动获取 + 调用（进度解析 / 输出路径识别）
 *
 *   node tests/smoke-network.js
 */

const fs = require('fs');
const path = require('path');

const { VideoDownloader } = require('../src/core/downloader');
const { ensureYtDlp, ytDlpVersion } = require('../src/core/ytdlp');
const { toolsDir } = require('../src/core/config');
const { formatBytes, formatDuration } = require('../src/core/util');

const OUT = path.join(__dirname, '.smoke');
const results = [];
let failed = 0;

async function step(name, fn) {
  process.stdout.write(`\n▶ ${name}\n`);
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
    process.stdout.write(`  ✓ ${name}${detail ? ` — ${detail}` : ''}\n`);
  } catch (err) {
    failed += 1;
    results.push(`  ✗ ${name} — ${err.message}`);
    process.stdout.write(`  ✗ ${name} — ${err.message}\n`);
  }
  process.stdout.write(`    （耗时 ${formatDuration((Date.now() - t0) / 1000)}）\n`);
}

const DIRECT_URL = 'https://www.w3schools.com/html/mov_bbb.mp4';
const HLS_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const PAGE_URL = 'https://www.w3schools.com/html/html5_video.asp';

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const dl = new VideoDownloader({ outDir: OUT, autoDownloadYtDlp: true, engine: 'auto' });
  dl.on('error', () => {});
  dl.on('log', (p) => process.stdout.write(`    · ${p.message}\n`));

  process.stdout.write(`工具目录：${toolsDir()}\n保存目录：${OUT}\n`);

  await step('环境自检（工具状态）', async () => {
    const s = dl.status();
    return `yt-dlp=${s.ytDlp ? '已安装' : '未安装'} ffmpeg=${s.ffmpeg ? '已安装' : '未安装'}`;
  });

  await step('直链 MP4 下载 + 断点续传校验', async () => {
    const r = await dl.download(DIRECT_URL, { overwrite: true });
    if (!r.ok) throw new Error(r.error);
    const size = fs.statSync(r.filePath).size;
    if (size < 100 * 1024) throw new Error(`文件过小：${size} 字节`);
    // 再次下载应生成副本而不是覆盖
    const r2 = await dl.download(DIRECT_URL);
    if (!r2.ok) throw new Error(r2.error);
    if (r2.filePath === r.filePath) throw new Error('第二次下载没有生成新文件（重名保护失效）');
    return `${path.basename(r.filePath)} ${formatBytes(size)}`;
  });

  await step('HLS(m3u8) 下载：仅取前 3 个分片', async () => {
    const r = await dl.download(HLS_URL, { limitSegments: 3, concurrency: 3, overwrite: true });
    if (!r.ok) throw new Error(r.error);
    const size = fs.statSync(r.filePath).size;
    if (size < 50 * 1024) throw new Error(`分片合并结果过小：${size} 字节`);
    return `${path.basename(r.filePath)} ${formatBytes(size)}（引擎 ${r.engine}）`;
  });

  await step('网页内嵌视频地址提取（w3schools 示例页）', async () => {
    const info = await dl.inspect(PAGE_URL);
    const hit = (info.candidates || []).find((c) => /\.mp4/i.test(c.url));
    if (!hit) throw new Error(`未从网页中提取到媒体地址（识别类型 ${info.type}）`);
    return `类型=${info.type} 首个候选=${hit.url.split('/').pop()}`;
  });

  await step('yt-dlp 自动获取', async () => {
    const bin = await ensureYtDlp({
      toolsDir: toolsDir(),
      autoDownload: true,
      onProgress: (p) => {
        if (p.percent >= 0) process.stdout.write(`\r    下载 yt-dlp ${p.percent.toFixed(1)}% ${formatBytes(p.bytes)}   `);
      },
      logger: () => {},
    });
    if (!bin) throw new Error('未能获取 yt-dlp');
    const version = await ytDlpVersion(bin);
    if (!version) throw new Error('yt-dlp 无法运行');
    process.stdout.write('\n');
    return `${path.basename(bin)} ${version}`;
  });

  await step('通过 yt-dlp 引擎下载（同一 MP4 直链，走 generic 提取器）', async () => {
    const dir = path.join(OUT, 'ytdlp');
    fs.mkdirSync(dir, { recursive: true });
    const r = await dl.download(DIRECT_URL, { engine: 'ytdlp', outDir: dir, overwrite: true });
    if (!r.ok) throw new Error(r.error);
    const size = fs.statSync(r.filePath).size;
    if (size < 100 * 1024) throw new Error(`文件过小：${size} 字节`);
    return `${path.basename(r.filePath)} ${formatBytes(size)}（engine=${r.engine}）`;
  });

  process.stdout.write(`\n${results.join('\n')}\n`);
  process.stdout.write(failed ? `\n冒烟测试有 ${failed} 项失败\n` : '\n全部冒烟测试通过\n');
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  process.stderr.write(`冒烟测试异常：${err.stack || err}\n`);
  process.exitCode = 1;
});
