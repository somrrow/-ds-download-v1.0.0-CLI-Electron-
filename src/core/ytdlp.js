'use strict';

/**
 * yt-dlp / ffmpeg 集成：
 *  - 自动定位或下载 yt-dlp 可执行文件（首次使用时）
 *  - 解析站点信息（--dump-single-json）
 *  - 调用下载并按行解析进度
 *  - 可选的 ffmpeg 获取（用于合并音视频轨 / 转封装）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { openStream, request } = require('./http');
const { ProgressMeter } = require('./progress');
const {
  ensureDir,
  fileExists,
  fileSize,
  formatBytes,
  uniquePath,
  stripAnsi,
  sleep,
} = require('./util');

const IS_WIN = process.platform === 'win32';
const YTDLP_NAME = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp';
const FFMPEG_NAME = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';

/** 视为「成品」的媒体扩展名（.part / .ytdl 等临时文件不算） */
const MEDIA_EXTS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.flv', '.m4a', '.mp3', '.aac', '.opus', '.ts', '.m4v', '.avi', '.wav']);

/** 在下载目录里找本次任务刚产出的媒体文件（yt-dlp 用了 --no-mtime，所以 mtime 就是下载时间） */
function findRecentMediaFile(outDir, sinceMs) {
  try {
    const files = fs
      .readdirSync(outDir)
      .map((f) => path.join(outDir, f))
      .filter((f) => MEDIA_EXTS.has(path.extname(f).toLowerCase()))
      .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
      .filter((x) => x.t >= sinceMs - 2000)
      .sort((a, b) => b.t - a.t);
    return files.length ? files[0].f : '';
  } catch {
    return '';
  }
}

const YTDLP_DIRECT_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';

// ---------------------------------------------------------------- 定位

/** 在 PATH 中查找可执行文件 */
function which(name) {
  const paths = (process.env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean);
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of paths) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + (IS_WIN && !name.toLowerCase().endsWith(ext.toLowerCase()) ? ext : ''));
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* 继续找 */
      }
    }
  }
  return null;
}

/** 定位 yt-dlp：显式路径 > 项目 tools 目录 > PATH */
function findYtDlp({ toolsDir, explicitPath } = {}) {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  if (toolsDir) candidates.push(path.join(toolsDir, YTDLP_NAME));
  for (const c of candidates) {
    if (c && fileExists(c) && fileSize(c) > 1000) return c;
  }
  return which('yt-dlp') || which('yt-dlp.exe');
}

/** 定位 ffmpeg：显式路径 > 项目 tools 目录 > PATH */
function findFfmpeg({ toolsDir, explicitPath } = {}) {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  if (toolsDir) candidates.push(path.join(toolsDir, FFMPEG_NAME));
  for (const c of candidates) {
    if (c && fileExists(c) && fileSize(c) > 1000) return c;
  }
  return which('ffmpeg') || which('ffmpeg.exe');
}

// ---------------------------------------------------------------- 下载可执行文件

/**
 * 带进度、停滞检测与速度下限的文件下载（用于 yt-dlp.exe / ffmpeg 各源）。
 * 慢到不像话或长时间没有数据时主动中断，让上层换一个下载源。
 */
async function downloadFile(
  url,
  destPath,
  { onProgress, signal, logger = () => {}, stallMs = 20000, minRate = 150 * 1024, rateWindowMs = 12000 } = {},
) {
  ensureDir(path.dirname(destPath));
  const tmpPath = `${destPath}.download`;
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(new Error('已取消'));
  if (signal) {
    if (signal.aborted) throw new Error('已取消');
    signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  let res;
  try {
    res = await openStream(url, { timeout: 30000, signal: controller.signal, retries: 1 });
  } catch (err) {
    if (signal) signal.removeEventListener('abort', onOuterAbort);
    throw new Error(err.cause?.message || err.message);
  }
  if (res.status >= 400) {
    if (signal) signal.removeEventListener('abort', onOuterAbort);
    res.stream?.destroy?.();
    throw new Error(`下载失败：HTTP ${res.status}`);
  }
  const total = Number(res.headers.get('content-length') || 0);
  const meter = new ProgressMeter({ total, minEmitInterval: 400 });
  let lastData = Date.now();
  let windowStart = Date.now();
  let windowBytes = 0;
  let stopReason = '';
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - lastData > stallMs) {
      stopReason = `下载停滞超过 ${Math.round(stallMs / 1000)} 秒`;
      controller.abort(new Error(stopReason));
      return;
    }
    if (now - windowStart >= rateWindowMs) {
      const rate = windowBytes / ((now - windowStart) / 1000);
      if (rate < minRate) {
        stopReason = `速度过慢（${(rate / 1024).toFixed(0)} KB/s）`;
        controller.abort(new Error(stopReason));
      }
      windowStart = now;
      windowBytes = 0;
    }
  }, 3000);

  const out = fs.createWriteStream(tmpPath);
  try {
    for await (const chunk of res.stream) {
      meter.add(chunk.length);
      windowBytes += chunk.length;
      lastData = Date.now();
      if (!out.write(chunk)) await drainStream(out);
      if (meter.emit() && onProgress) onProgress(meter.snapshot());
    }
    await closeStream(out);
  } catch (err) {
    out.destroy();
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    if (stopReason) throw new Error(stopReason);
    throw new Error(signal?.aborted ? '已取消' : err.cause?.message || err.message);
  } finally {
    clearInterval(watchdog);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
  if (total > 0 && fileSize(tmpPath) !== total) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw new Error(`文件下载不完整：期望 ${formatBytes(total)}，实际 ${formatBytes(fileSize(tmpPath))}`);
  }
  if (fileExists(destPath)) fs.unlinkSync(destPath);
  fs.renameSync(tmpPath, destPath);
  logger(`已下载 ${path.basename(destPath)}（${formatBytes(fileSize(destPath))}）`);
  return destPath;
}

/**
 * ffmpeg 下载源（按速度/可用性排序）。
 * 国内直连 GitHub 常常只有百 KB/s，npmmirror 镜像通常快十几倍，所以镜像优先。
 */
const FFMPEG_SOURCES = [
  {
    name: 'npmmirror 镜像 · ffmpeg-static 6.1.1',
    url: 'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffmpeg-win32-x64.gz',
    kind: 'gz',
  },
  {
    name: 'npmmirror 镜像 · @ffmpeg-installer 4.1',
    url: 'https://registry.npmmirror.com/@ffmpeg-installer/win32-x64/-/win32-x64-4.1.0.tgz',
    kind: 'tgz',
  },
  {
    name: 'GitHub · ffmpeg-static 6.1.1',
    url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz',
    kind: 'gz',
  },
  {
    name: 'BtbN (GitHub)',
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
    kind: 'zip',
  },
  {
    name: 'gyan.dev',
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    kind: 'zip',
  },
];

/** 写入流背压等待 */
function drainStream(out) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      out.off('drain', onDrain);
      out.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    out.once('drain', onDrain);
    out.once('error', onError);
  });
}

function closeStream(out) {
  return new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
}

/** 判断进程退出是否因为取消 */
function abortReason(signal) {
  return signal && signal.aborted ? '已取消' : '';
}

/** 下载 yt-dlp 可执行文件到 tools 目录 */
async function downloadYtDlp({ toolsDir, onProgress, signal, logger = () => {} }) {
  ensureDir(toolsDir);
  const dest = path.join(toolsDir, YTDLP_NAME);
  logger('正在获取 yt-dlp（约 20MB，仅首次需要）...');
  // yt-dlp 只有 GitHub 一个来源，阈值放宽一点，宁可慢也别失败
  await downloadFile(YTDLP_DIRECT_URL, dest, {
    onProgress,
    signal,
    logger,
    minRate: 40 * 1024,
    stallMs: 45000,
  });
  if (IS_WIN) {
    try {
      fs.chmodSync(dest, 0o755);
    } catch {
      /* ignore */
    }
  }
  let version = '';
  try {
    version = await ytDlpVersion(dest);
  } catch (err) {
    throw new Error(`yt-dlp 下载后无法运行：${err.message}`);
  }
  if (!version) throw new Error('yt-dlp 下载后没有版本输出，可能被杀毒软件拦截，请检查后重试');
  logger(`yt-dlp 就绪：${version}`);
  return dest;
}

/** 解压下载到的压缩包，返回其中的 ffmpeg.exe 路径 */
async function extractFfmpegFrom(archivePath, kind, workDir) {
  if (kind === 'gz') {
    const out = path.join(workDir, FFMPEG_NAME);
    await new Promise((resolve, reject) => {
      const zlib = require('zlib');
      const input = fs.createReadStream(archivePath);
      const output = fs.createWriteStream(out);
      const gunzip = zlib.createGunzip();
      input.on('error', reject);
      gunzip.on('error', reject);
      output.on('error', reject);
      output.on('finish', resolve);
      input.pipe(gunzip).pipe(output);
    });
    return fileExists(out) ? out : null;
  }
  // zip / tgz 交给系统 tar（Windows 10+ 自带 bsdtar，两者都能解）
  const args = kind === 'tgz' ? ['-xzf', archivePath, '-C', workDir] : ['-xf', archivePath, '-C', workDir];
  await new Promise((resolve, reject) => {
    const child = spawn('tar', args, { windowsHide: true });
    let err = '';
    child.stderr?.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`解压失败（tar 退出码 ${code}）：${err.trim().slice(0, 200)}`)),
    );
  });
  return findFileRecursive(workDir, FFMPEG_NAME);
}

/** 验证 ffmpeg 能否运行 */
function probeBinary(binPath, arg = '-version') {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binPath, [arg], { windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(false);
    }, 20000);
    child.stdout?.on('data', (d) => {
      out += d.toString();
    });
    child.stderr?.on('data', (d) => {
      out += d.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && /ffmpeg version/i.test(out));
    });
  });
}

/**
 * 这个媒体文件里**有没有音轨**（2026-10-23）。
 *
 * 用 `ffmpeg -i <file>` 的 stderr 里有没有 `Audio:` 来判断 —— ffmpeg 只读不转，
 * 几毫秒就返回；没有 ffmpeg 就返回 `null`（表示"不知道"，调用方不要当成没有）。
 * @returns {Promise<boolean|null>}
 */
function mediaHasAudio(ffmpegPath, filePath) {
  if (!ffmpegPath || !fileExists(filePath)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpegPath, ['-hide_banner', '-i', filePath], { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve(null);
    }, 15000);
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.stderr?.on('data', (d) => { out += d.toString(); if (out.length > 20000) out = out.slice(-20000); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      if (!/Input #0/i.test(out)) { resolve(null); return; }   // 打不开/不是媒体 → 不判断
      resolve(/Stream #\d+:\d+.*: Audio:/i.test(out));
    });
  });
}

/**
 * 获取 ffmpeg：依次尝试多个源，遇到 404 / 解压失败 / 速度过慢会自动换下一个源。
 */
async function downloadFfmpeg({ toolsDir, onProgress, signal, logger = () => {} }) {
  if (!IS_WIN) throw new Error('自动获取 ffmpeg 目前仅支持 Windows，请用系统包管理器安装');
  ensureDir(toolsDir);
  const dest = path.join(toolsDir, FFMPEG_NAME);
  const workDir = path.join(toolsDir, 'ffmpeg-tmp');
  fs.rmSync(workDir, { recursive: true, force: true });
  ensureDir(workDir);

  const failures = [];
  for (const src of FFMPEG_SOURCES) {
    if (signal?.aborted) throw new Error('已取消');
    const ext = src.kind === 'gz' ? 'gz' : src.kind === 'tgz' ? 'tgz' : 'zip';
    const archive = path.join(workDir, `ffmpeg-download.${ext}`);
    try {
      logger(`正在从「${src.name}」获取 ffmpeg...`);
      await downloadFile(src.url, archive, { onProgress, signal, logger });
      logger(`下载完成（${formatBytes(fileSize(archive))}），正在解压...`);
      const bin = await extractFfmpegFrom(archive, src.kind, workDir);
      if (!bin) throw new Error('压缩包里没有找到 ffmpeg.exe');
      fs.copyFileSync(bin, dest);
      if (!(await probeBinary(dest))) throw new Error('解压出的 ffmpeg 无法运行（可能被杀毒软件拦截）');
      logger(`ffmpeg 就绪：${dest}`);
      fs.rmSync(workDir, { recursive: true, force: true });
      return dest;
    } catch (err) {
      const reason = abortReason(signal);
      if (reason) throw new Error(reason);
      failures.push(`${src.name}：${err.message}`);
      logger(`该源不可用（${err.message}），换下一个源...`);
      try {
        fs.rmSync(archive, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  fs.rmSync(workDir, { recursive: true, force: true });
  throw new Error(`所有 ffmpeg 下载源都失败了：\n  - ${failures.join('\n  - ')}`);
}

function findFileRecursive(dir, name) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase() === name.toLowerCase()) return p;
    }
  }
  return null;
}

// ---------------------------------------------------------------- 执行

/**
 * 解码子进程输出：优先 UTF-8，出现替换字符说明是 Windows 本地代码页（GBK）编码，改用它。
 * yt-dlp 在非交互管道下可能按系统代码页输出，中文路径会乱码。
 */
function decodeChunk(buf) {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gb18030').decode(buf);
  } catch {
    return utf8;
  }
}

/**
 * 运行 yt-dlp 并按行回调输出。
 * @returns {Promise<{code:number, stdout:string, stderr:string, lines:string[]}>}
 */
function runYtDlp(binPath, args, { onLine, signal, cwd, logger } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binPath, args, {
        windowsHide: true,
        cwd,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      });
    } catch (err) {
      reject(err);
      return;
    }
    const lines = [];
    let stdout = '';
    let stderr = '';
    const handle = (chunk, isErr) => {
      const text = stripAnsi(decodeChunk(chunk));
      if (isErr) stderr += text;
      else stdout += text;
      for (const raw of text.split(/\r?\n|\r/)) {
        const line = raw.trimEnd();
        if (!line.trim()) continue;
        lines.push(line);
        if (onLine) onLine(line, isErr);
      }
    };
    child.stdout?.on('data', (d) => handle(d, false));
    child.stderr?.on('data', (d) => handle(d, true));
    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new Error(`无法启动 yt-dlp：${err.message}`));
    });
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, lines });
    });
  });
}

async function ytDlpVersion(binPath) {
  const res = await runYtDlp(binPath, ['--version'], {});
  if (res.code !== 0) return '';
  return (res.stdout || '').trim().split(/\r?\n/).pop() || '';
}

/** 确保可用的 yt-dlp；autoDownload 为真时自动获取 */
async function ensureYtDlp({ toolsDir, explicitPath, autoDownload = true, onProgress, signal, logger = () => {} } = {}) {
  let bin = findYtDlp({ toolsDir, explicitPath });
  if (bin) return bin;
  if (!autoDownload) return null;
  if (!IS_WIN) {
    logger('未找到 yt-dlp，请先安装：pip install -U yt-dlp');
    return null;
  }
  bin = await downloadYtDlp({ toolsDir, onProgress, signal, logger });
  return bin;
}

/**
 * 取单个链接的解析信息（含是否直播、各格式的真实流地址）。
 * 直播时据此改用内置录制引擎，才能「随时结束并保存成可播放文件」。
 */
async function getStreamInfo(url, opts = {}) {
  const bin = opts.ytDlpPath || (await ensureYtDlp(opts));
  if (!bin) throw new Error('yt-dlp 不可用');
  const args = [
    '-J',
    '--no-warnings',
    '--no-playlist',
    '--socket-timeout',
    String(opts.socketTimeout || 20),
    ...buildCommonArgs(opts),
    url,
  ];
  const res = await runYtDlp(bin, args, opts);
  if (res.code !== 0) throw new Error(translateYtDlpError(parseYtDlpError(res)) || 'yt-dlp 解析失败');
  const jsonLine = res.lines.find((l) => l.trim().startsWith('{'));
  if (!jsonLine) throw new Error('yt-dlp 未返回 JSON 数据');
  const info = JSON.parse(jsonLine);
  return {
    title: info.title || '',
    uploader: info.uploader || info.channel || '',
    isLive: Boolean(info.is_live),
    duration: info.duration || 0,
    webpageUrl: info.webpage_url || url,
    formats: (info.formats || [])
      .filter((f) => f.url)
      .map((f) => ({
        formatId: f.format_id,
        url: f.url,
        protocol: f.protocol || '',
        ext: f.ext || '',
        vcodec: f.vcodec || '',
        acodec: f.acodec || '',
        width: f.width || 0,
        height: f.height || 0,
        abr: f.abr || 0,
        tbr: f.tbr || 0,
        note: f.format_note || '',
      })),
  };
}

/** 列出可选清晰度/格式 */
async function listFormats(url, opts = {}) {
  const bin = opts.ytDlpPath || (await ensureYtDlp(opts));
  if (!bin) throw new Error('yt-dlp 不可用');
  const args = [
    '--no-warnings',
    '--no-playlist',
    '--dump-single-json',
    '--no-check-certificates',
    ...buildCommonArgs(opts),
    url,
  ];
  const res = await runYtDlp(bin, args, opts);
  if (res.code !== 0) throw new Error(translateYtDlpError(parseYtDlpError(res)) || 'yt-dlp 解析失败');
  const jsonLine = res.lines.find((l) => l.trim().startsWith('{'));
  if (!jsonLine) throw new Error('yt-dlp 未返回 JSON 数据');
  const info = JSON.parse(jsonLine);
  return {
    title: info.title || '',
    id: info.id || '',
    uploader: info.uploader || info.channel || '',
    duration: info.duration || 0,
    thumbnail: info.thumbnail || '',
    webpageUrl: info.webpage_url || url,
    extractor: info.extractor_key || info.extractor || '',
    formats: (info.formats || [])
      .filter((f) => f.url || f.format_id)
      .map((f) => ({
        formatId: f.format_id,
        ext: f.ext,
        resolution: f.resolution || (f.height ? `${f.width || ''}x${f.height}` : ''),
        height: f.height || 0,
        fps: f.fps || 0,
        vcodec: f.vcodec,
        acodec: f.acodec,
        filesize: f.filesize || f.filesize_approx || 0,
        tbr: f.tbr || 0,
        note: f.format_note || '',
      })),
  };
}

function parseYtDlpError(res) {
  const errLines = (res.stderr || '').split(/\r?\n/).filter((l) => /^ERROR/i.test(l.trim()));
  if (errLines.length) return errLines[errLines.length - 1].replace(/^ERROR:\s*/i, '');
  const anyErr = (res.lines || []).filter((l) => /^ERROR/i.test(l));
  if (anyErr.length) return anyErr[anyErr.length - 1].replace(/^ERROR:\s*/i, '');
  // 用法错误（如参数不被支持）时 yt-dlp 只打印 usage，需要把 stderr 尾部带出来
  const tail = (res.stderr || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^usage:/i.test(l));
  if (tail.length) return tail.slice(-2).join(' | ').slice(0, 300);
  return '';
}

/**
 * 给 yt-dlp 用的 cookie 文件路径。
 *
 * yt-dlp 是打包好的 Python 程序，路径里带中文（比如装在 D:\视频下载工具）时，
 * 某些环境下参数会被按错误的编码传给子进程，于是报
 * `FileNotFoundError: ... 'D:\瑙嗛...\tools\login-cookies.txt'` 这种乱码路径。
 * 这里统一复制一份到纯英文的临时目录再传过去，绕开编码问题。
 */
function ytDlpCookiesPath(cookiesFile) {
  const file = String(cookiesFile || '');
  if (!file || !fs.existsSync(file)) return file;
  if (/^[\x20-\x7e]+$/.test(file)) return file; // 全英文路径直接用
  try {
    const target = path.join(os.tmpdir(), `vgrab-cookies-${process.pid}.txt`);
    fs.copyFileSync(file, target);
    return target;
  } catch {
    return file;
  }
}

/** 把通用选项（cookie / 代理 / 请求头 / ffmpeg 位置）转成 yt-dlp 参数 */
function buildCommonArgs(opts = {}) {
  const args = [];
  if (opts.ffmpegPath) args.push('--ffmpeg-location', opts.ffmpegPath);
  if (opts.cookiesFile) args.push('--cookies', ytDlpCookiesPath(opts.cookiesFile));
  if (opts.cookiesFromBrowser) args.push('--cookies-from-browser', opts.cookiesFromBrowser);
  if (opts.proxy) args.push('--proxy', opts.proxy);
  if (opts.referer) args.push('--referer', opts.referer);
  if (opts.userAgent) args.push('--user-agent', opts.userAgent);
  if (opts.socketTimeout) args.push('--socket-timeout', String(opts.socketTimeout));
  for (const [k, v] of Object.entries(opts.extraHeaders || {})) args.push('--add-header', `${k}:${v}`);
  return args;
}

/** 依据质量档位生成 -f 表达式 */
function buildFormatSelector(quality, { hasFfmpeg, audioOnly } = {}) {
  const isAudio = Boolean(audioOnly) || String(quality || '').toLowerCase() === 'audio';
  if (isAudio) {
    return hasFfmpeg ? 'bestaudio/best' : 'bestaudio[ext=m4a]/bestaudio/best';
  }
  const h = Number(String(quality || '').replace(/[^\d]/g, ''));
  if (!hasFfmpeg) {
    // 没有 ffmpeg 时只能选「已同时包含音视频」的格式，否则 yt-dlp 会报 Requested format is not available
    if (quality === 'worst') return 'w[ext=mp4]/w';
    if (h > 0) return `b[height<=${h}][ext=mp4]/b[height<=${h}]/b[ext=mp4]/b`;
    return 'b[ext=mp4]/b';
  }
  /**
   * ⚠️ 必须保证"带音轨"（2026-10-23 用户报小红书没声音）：
   * `bv*+ba/b` 在"站点只给合体格式"时没问题，但小红书这类站点有时会给出**纯视频流**，
   * `bv*` 一旦恰好是它，合出来就是无声视频。所以选择器里显式要求 `acodec!=none`，
   * 下完还有一道`mediaHasAudio()`复检兜底。
   */
  if (quality === 'worst') return 'wv*+wa/w[acodec!=none]/w';
  if (h > 0) return `bv*[height<=${h}]+ba/b[height<=${h}][acodec!=none]/b[height<=${h}]/bv*+ba/b`;
  return 'bv*+ba/b[acodec!=none]/b';
}

/**
 * 编码偏好排序（-S）。默认优先 H.264 + AAC：兼容性最好，
 * Windows 自带播放器、剪辑软件、老设备都能直接播；想追画质可传 codec: 'best'。
 */
function buildFormatSort(codec = 'h264') {
  const key = String(codec || 'h264').toLowerCase();
  if (key === 'best' || key === 'auto' || key === 'none') return '';
  const map = { h264: 'h264', avc: 'h264', hevc: 'h265', h265: 'h265', av1: 'av01', av01: 'av01', vp9: 'vp9' };
  const want = map[key];
  if (!want) return '';
  return `res,fps,hdr:12,vcodec:${want},acodec:aac,br`;
}

/** 该错误是否可能因为缺少 ffmpeg 引起（需要重新选流 / 合并音视频） */function needsFfmpeg(message) {
  const m = String(message || '').toLowerCase();
  return (
    m.includes('requested format is not available') ||
    m.includes('ffmpeg') ||
    m.includes('merging') ||
    m.includes('merge')
  );
}

/** 把 yt-dlp 的英文报错翻译成可操作的中文提示 */
function translateYtDlpError(message) {
  const text = String(message || '').trim();
  if (!text) return '';
  const m = text.toLowerCase();
  const hint = (s) => `${text}\n  → ${s}`;
  if (m.includes('requested format is not available')) {
    return hint('该清晰度没有可直接下载的现成文件：装好 ffmpeg 后可自动合并高清音视频（vgrab --fetch-ffmpeg），或换个清晰度（-q 720 / -q best）');
  }
  if (m.includes('ffmpeg')) {
    return hint('需要 ffmpeg 来合并音视频：执行 vgrab --fetch-ffmpeg，或在界面顶部点 ffmpeg 的「获取」');
  }
  if (m.includes('sign in') || m.includes('log in') || m.includes('login') || m.includes('registered users') || m.includes('premium') || m.includes('vip') || m.includes('member')) {
    return hint('该内容需要登录：请提供 Cookie（--cookies-from-browser chrome / edge / firefox，或 --cookies cookies.txt）');
  }
  if (m.includes('403') || m.includes('forbidden')) {
    return hint('可能被限制访问：加上 Cookie（--cookies-from-browser）或代理（--proxy http://127.0.0.1:7890）再试');
  }
  if (m.includes('not available in your country') || m.includes('geo') || m.includes('region')) {
    return hint('该视频有地区限制，可尝试挂代理（--proxy）');
  }
  if (m.includes('unsupported url')) {
    return hint('yt-dlp 不支持该站点：可尝试抓取真实直链或 m3u8 后用内置引擎下载');
  }
  if (m.includes('404') || m.includes('not found') || m.includes('unavailable') || m.includes('removed')) {
    return hint('视频可能已被删除、设为私密或链接有误');
  }
  if (m.includes('timed out') || m.includes('timeout')) {
    return hint('网络超时：可加 --proxy，或稍后重试');
  }
  return text;
}

/**
 * 用 yt-dlp 下载。
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.outDir 输出目录
 * @param {string} [opts.quality='best'] best|1080|720|480|worst|audio
 * @param {string} [opts.outName] 指定输出文件名（不含扩展名），留空则用视频标题
 */
async function downloadWithYtDlp(opts) {
  const {
    url,
    outDir,
    quality = 'best',
    outName,
    onProgress,
    onLine,
    signal,
    logger = () => {},
    playlist = false,
  } = opts;

  const bin = opts.ytDlpPath || (await ensureYtDlp(opts));
  if (!bin) throw new Error('未找到 yt-dlp，无法解析该站点');
  ensureDir(outDir);

  let ffmpegPath = opts.ffmpegPath || null;
  const audioOnly = quality === 'audio';
  const outputTemplate = outName
    ? path.join(outDir, `${outName}.%(ext)s`)
    : path.join(outDir, '%(title).120B.%(ext)s');

  const progressTemplate =
    'download:@@PROGRESS@@ %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s %(progress.fragment_index)s %(progress.fragment_count)s';

  /** 每次尝试都重新构造参数：ffmpeg 可能出现（自动获取）或消失 */
  const buildArgs = () => {
    const hasFfmpeg = Boolean(ffmpegPath);
    const args = [
      '--newline',
      '--no-warnings',
      '--progress-template',
      progressTemplate,
      '--no-simulate',
      '--print',
      'after_move:@@FINAL@@%(filepath)s',
      '-o',
      outputTemplate,
      '--windows-filenames',
      '--trim-filenames',
      '150',
      '--no-mtime',
      '--concurrent-fragments',
      String(opts.concurrentFragments || 4),
      ...buildCommonArgs({ ...opts, ffmpegPath }),
    ];
    if (playlist) args.push('--yes-playlist');
    else args.push('--no-playlist');
    const selector = buildFormatSelector(quality, { hasFfmpeg, audioOnly });
    args.push('-f', selector);
    if (!audioOnly) {
      const sort = buildFormatSort(opts.codec);
      if (sort) args.push('-S', sort);
    }
    if (audioOnly) {
      if (hasFfmpeg && opts.audioFormat !== 'none') args.push('-x', '--audio-format', opts.audioFormat || 'mp3');
    } else if (hasFfmpeg) {
      args.push('--merge-output-format', 'mp4');
    }
    if (opts.embedThumbnail) args.push('--embed-thumbnail');
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);
    args.push(url);
    return { args, selector, hasFfmpeg };
  };

  const meter = new ProgressMeter({ total: 0 });
  let finalPath = '';
  const startTime = Date.now();

  const parseLine = (line) => {
    if (onLine) onLine(line);
    if (line.startsWith('@@PROGRESS@@')) {
      const parts = line.replace('@@PROGRESS@@', '').trim().split(/\s+/);
      const num = (v) => {
        const n = Number(v);
        return isFinite(n) && n > 0 ? n : 0;
      };
      const downloaded = num(parts[0]);
      const total = num(parts[1]) || num(parts[2]);
      meter.setBytes(downloaded);
      meter.setTotal(total);
      meter.extra = {
        fragment: num(parts[5]) || undefined,
        fragmentCount: num(parts[6]) || undefined,
      };
      if (onProgress) onProgress(meter.snapshot());
      return;
    }
    if (line.startsWith('@@FINAL@@')) {
      finalPath = line.replace('@@FINAL@@', '').trim();
      return;
    }
    if (/^\[(download|Merger|ExtractAudio|FixupM3u8|FixupM4a|VideoConvertor|Metadata|EmbedThumbnail)\]/i.test(line)) {
      logger(line.replace(/^\[download\]\s*/i, ''));
    } else if (/^\[(info|warning|generic|youtube)\]/i.test(line)) {
      logger(line);
    }
  };

  // 第一次可能因为「没有现成的合体格式」失败，此时自动获取 ffmpeg 后重试一次
  for (let attempt = 1; ; attempt += 1) {
    const { args, selector, hasFfmpeg } = buildArgs();
    logger(`调用 yt-dlp：-f ${selector}${hasFfmpeg ? '（可合并音视频）' : '（未安装 ffmpeg，仅能选现成格式）'}`);
    finalPath = '';
    const res = await runYtDlp(bin, args, { onLine: parseLine, signal, logger });
    if (res.code === 0) break;
    if (signal?.aborted) throw new Error('已取消');
    const raw = parseYtDlpError(res) || `yt-dlp 退出码 ${res.code}`;

    // 现实中会遇到：文件其实已经下好了，只是收尾步骤（写元数据、缩略图等）报错，
    // 使得 yt-dlp 以非 0 退出。这种情况文件是好的，不能当失败处理。
    const produced = findRecentMediaFile(outDir, startTime);
    if (produced) {
      logger(`yt-dlp 报了错，但文件已经下载完成，按成功处理：${String(raw).split('\n')[0]}`, { notice: true });
      finalPath = produced;
      break;
    }

    if (attempt === 1 && !ffmpegPath && opts.autoFetchFfmpeg !== false && needsFfmpeg(raw)) {
      logger(`yt-dlp 提示：${raw.split('\n')[0]}`);
      logger('该清晰度需要合并音视频轨，正在自动获取 ffmpeg（约 30MB，仅首次使用）...');
      try {
        ffmpegPath = await downloadFfmpeg({
          toolsDir: opts.toolsDir,
          onProgress: opts.onSetupProgress,
          signal,
          logger,
        });
        meter.setBytes(0);
        continue;
      } catch (err) {
        logger(`自动获取 ffmpeg 失败：${err.message}`);
      }
    }
    throw new Error(translateYtDlpError(raw));
  }

  // 输出路径兜底：yt-dlp 打印的路径可能不存在（重命名 / 打印的是临时路径等）
  if (!finalPath || !fileExists(finalPath)) {
    const found = findRecentMediaFile(outDir, startTime);
    if (found) {
      if (finalPath) logger(`yt-dlp 报告的路径不存在，改用目录里最新的文件：${path.basename(found)}`, { notice: true });
      finalPath = found;
    }
  }
  if (!finalPath) throw new Error('yt-dlp 已完成，但没能确定输出文件位置（可尝试 --engine builtin 或查看日志）');
  if (!fileExists(finalPath)) throw new Error(`yt-dlp 报告的输出文件不存在：${JSON.stringify(finalPath)}`);
  /**
   * 有道「无声视频」的保险（2026-10-23 用户报：小红书下载下来没有声音）。
   *
   * 现场：同一条小红书链接，`-f 6`（hevc+aac）下出来是有声音的，
   * 但用户那次拿到的文件比正常版小了一整条音轨（5,021,869 vs 5,394,682 字节）——
   * 也就是**选到了纯视频轨**（小红书/部分站点的 `bv*` 就是无音轨的）。
   * 因为选流还受清晰度/编码偏好/站点返回的影响，光靠格式选择器不能保证，
   * 所以下完**验一遍有没有音轨**：没有就自动用「必须带音频」的选择器重下一次。
   */
  if (!audioOnly && finalPath && /\.(mp4|mkv|webm|mov|flv|ts|m4v)$/i.test(finalPath)) {
    let hasAudio = null;
    try {
      hasAudio = await mediaHasAudio(ffmpegPath, finalPath);
    } catch {
      hasAudio = null;   // 探测失败就当"不知道"，不要因此打断正常下载
    }
    if (hasAudio === false) {
      logger('⚠ 这个文件没有音轨（选到了纯视频流），正在用「必须带音频」的方式重新下载一次…', { notice: true });
      const retryArgs = buildArgs().args;
      // 把 -f <selector> 换成"优先带音频的合体格式 → 否则视频+音频合并"
      const idx = retryArgs.indexOf('-f');
      if (idx >= 0 && retryArgs[idx + 1]) retryArgs[idx + 1] = 'b[acodec!=none]/bv*+ba/b';
      else retryArgs.push('-f', 'b[acodec!=none]/bv*+ba/b');
      finalPath = '';
      const retry = await runYtDlp(bin, retryArgs, { onLine: parseLine, signal, logger });
      if (retry.code === 0 && finalPath && fileExists(finalPath)) {
        const again = await mediaHasAudio(ffmpegPath, finalPath).catch(() => null);
        logger(again ? '✔ 重新下载完成，这次带音轨了' : '⚠ 重新下载完成，但仍然没有音轨（可能是源本身就没有声音）', { notice: true });
      } else {
        const produced = findRecentMediaFile(outDir, startTime);
        if (produced) finalPath = produced;
        logger('重新下载没有成功，保留第一次的文件', { notice: true });
      }
    }
  }
  if (onProgress) onProgress(meter.snapshot({ done: true, label: path.basename(finalPath) }));
  return { filePath: finalPath, bytes: fileSize(finalPath), engine: 'ytdlp' };
}

module.exports = {
  IS_WIN,
  which,
  findYtDlp,
  findFfmpeg,
  ensureYtDlp,
  downloadYtDlp,
  downloadFfmpeg,
  downloadFile,
  runYtDlp,
  decodeChunk,
  probeBinary,
  mediaHasAudio,
  FFMPEG_SOURCES,
  ytDlpVersion,
  getStreamInfo,
  listFormats,
  downloadWithYtDlp,
  buildCommonArgs,
  buildFormatSelector,
  buildFormatSort,
  findRecentMediaFile,
  MEDIA_EXTS,
  parseYtDlpError,
  translateYtDlpError,
  needsFfmpeg,
};
