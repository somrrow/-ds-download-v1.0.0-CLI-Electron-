'use strict';

/**
 * 通用工具函数：文件名处理、体积/速度格式化、Cookie 解析等。
 * 全部为零依赖实现。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 默认浏览器 UA，很多站点会拒绝默认的 node/undici UA */
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** 去掉 ANSI 颜色控制符 */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '');
}

/** 把任意字符串清洗成合法（Windows 友好）的文件名主体，不含目录 */
function sanitizeFilename(name, fallback = 'video') {
  let s = String(name == null ? '' : name);
  try {
    s = decodeURIComponent(s);
  } catch {
    /* 保留原样 */
  }
  s = stripAnsi(s)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!s || s === '.' || s === '..') s = fallback;
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
  s = truncateMiddle(s, 120);
  return s || fallback;
}

/** 过长时保留头尾（尽量保住扩展名） */
function truncateMiddle(s, max) {
  if (s.length <= max) return s;
  const ext = path.extname(s);
  if (ext && ext.length < 12) {
    const base = s.slice(0, s.length - ext.length);
    return base.slice(0, max - ext.length) + ext;
  }
  return s.slice(0, max);
}

/** 取扩展名（含点），返回小写，如 '.mp4'；没有则返回 '' */
function extFromUrl(url) {
  try {
    const u = new URL(url);
    const base = u.pathname.split('/').filter(Boolean).pop() || '';
    const m = /(\.[a-z0-9]{2,5})$/i.exec(base);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

/** 从路径/URL 中猜测基础文件名（不含扩展名） */
function basenameFromUrl(url, fallback = 'video') {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop() || '';
    const withoutExt = seg.replace(/\.[a-z0-9]{2,5}$/i, '');
    return sanitizeFilename(withoutExt, fallback);
  } catch {
    return fallback;
  }
}

const MIME_EXT = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'video/quicktime': '.mov',
  'video/x-flv': '.flv',
  'video/x-msvideo': '.avi',
  'video/mp2t': '.ts',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'application/vnd.apple.mpegurl': '.m3u8',
  'application/x-mpegurl': '.m3u8',
  'audio/mpegurl': '.m3u8',
  'application/dash+xml': '.mpd',
};

/** 根据 Content-Type 猜扩展名 */
function extFromMime(mime, fallback = '.mp4') {
  if (!mime) return fallback;
  const clean = String(mime).split(';')[0].trim().toLowerCase();
  return MIME_EXT[clean] || fallback;
}

/** 解析 Content-Disposition，优先 filename* (RFC5987) */
function filenameFromDisposition(value) {
  if (!value) return '';
  const star = /filename\*\s*=\s*([^;]+)/i.exec(value);
  if (star) {
    let raw = star[1].trim().replace(/^"|"$/g, '');
    const m = /^([\w-]+)'([\w-]*)'(.*)$/.exec(raw);
    if (m) raw = m[3];
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(value);
  if (plain) return (plain[2] || plain[3] || '').trim();
  return '';
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!isFinite(n) || n <= 0) return n === 0 ? '0 B' : '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function formatSpeed(bytesPerSecond) {
  if (!isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '--';
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatDuration(seconds) {
  const s = Number(seconds);
  if (!isFinite(s) || s < 0) return '--:--';
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** 目标文件已存在时生成 "name (1).ext" 形式的新路径 */
function uniquePath(filePath) {
  if (!fileExists(filePath)) return filePath;
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fileExists(candidate)) return candidate;
  }
  return path.join(dir, `${base} (${Date.now()})${ext}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function randomId(prefix = 'task') {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

/** 把 HTML 实体转义符还原（只处理常见几个） */
function decodeHtmlEntities(str) {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2f;/gi, '/')
    .replace(/&nbsp;/g, ' ');
}

/**
 * 解析 Netscape 格式的 cookies.txt（yt-dlp --cookies 用的也是这个格式）。
 * @returns {Array<{domain:string,name:string,value:string}>}
 */
function parseNetscapeCookies(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || (t.startsWith('#') && !t.startsWith('#HttpOnly_'))) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const domain = parts[0].replace(/^#HttpOnly_/, '').trim();
    const name = parts[5];
    const value = parts[6];
    if (!name) continue;
    out.push({ domain, name, value });
  }
  return out;
}

/** 依据 URL 主机名挑出匹配的 cookie，拼成 Cookie 头 */
function cookieHeaderFor(url, cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return '';
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
  const picked = cookies.filter((c) => {
    const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
    if (!d) return false;
    return host === d || host.endsWith(`.${d}`);
  });
  return picked.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** 判断本进程是否需要在代理环境下运行（Node 需要 NODE_USE_ENV_PROXY=1 才让 fetch 走代理） */
function envProxyUrl(env = process.env) {
  return (
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    env.ALL_PROXY ||
    env.all_proxy ||
    ''
  );
}

/**
 * 读取 Windows「系统代理」（就是浏览器用的那个：设置 → 网络和 Internet → 代理）。
 * 国内用户大多是把 Clash / v2rayN 设成系统代理，浏览器能开 pixiv 靠的就是它；
 * 内置下载引擎要跟浏览器表现一致，就得把这一项也读出来。
 * @returns {string} 形如 http://127.0.0.1:7897，读不到返回空字符串
 */
function systemProxyUrl() {
  if (process.platform !== 'win32') return '';
  try {
    const { execFileSync } = require('child_process');
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const out = execFileSync('reg', ['query', key], { encoding: 'latin1', timeout: 5000, windowsHide: true });
    const lines = String(out).split(/\r?\n/);
    const read = (name) => {
      const line = lines.find((l) => new RegExp(`\\s${name}\\s+REG_SZ\\s+`, 'i').test(l));
      if (!line) return '';
      return line.split(/REG_SZ\s+/i)[1].trim();
    };
    const enabled = lines.find((l) => /\sProxyEnable\s+REG_DWORD\s+/i.test(l));
    const isOn = enabled ? parseInt(enabled.split(/REG_DWORD\s+/i)[1], 16) !== 0 : false;
    if (!isOn) return '';
    const server = read('ProxyServer');
    if (!server) return '';
    const override = read('ProxyOverride');
    // 系统代理栏里可能写成 "http=127.0.0.1:7890;https=127.0.0.1:7890" 或单个 "127.0.0.1:7890"
    const perProto = /(^|;)\s*(https?)=([^;]+)/i.exec(server);
    let hostPort = '';
    if (perProto) {
      const all = [...server.matchAll(/(?:^|;)\s*(https?)=([^;]+)/gi)];
      const https = all.find((m) => m[1].toLowerCase() === 'https');
      const http = all.find((m) => m[1].toLowerCase() === 'http');
      hostPort = (https || http || all[0])[2].trim();
    } else {
      hostPort = server.trim();
    }
    if (!hostPort || /^socks/i.test(hostPort)) return '';
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(hostPort) ? hostPort : `http://${hostPort}`;
    let parsed;
    try {
      parsed = new URL(withScheme);
    } catch {
      return '';
    }
    if (parsed.protocol === 'socks:' || parsed.protocol === 'socks5:') return '';
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

/**
 * 启动「真正的 Electron」时要用的环境变量。
 *
 * ⚠️ 必须摘掉 ELECTRON_RUN_AS_NODE：这个变量会让 electron.exe 以**纯 Node 模式**启动
 * （我们自己就靠它在本机没有 node.exe 时跑 CLI，QQ Agent 插件也是这么调我们的）。
 * 一旦它被继承进辅助进程，那个 "Electron" 只会去当 Node 跑 appRoot 目录，结果是
 * `内置浏览器没有返回页面数据：Cannot find module ...` —— 内置浏览器兜底
 * （抖音视频/抖音图文/图文帖/Pixiv 接口）会全部失效，而且报错完全不提环境变量，极难排查。
 */
function electronChildEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}

module.exports = {
  DEFAULT_UA,
  stripAnsi,
  sanitizeFilename,
  truncateMiddle,
  extFromUrl,
  basenameFromUrl,
  extFromMime,
  filenameFromDisposition,
  formatBytes,
  formatSpeed,
  formatDuration,
  ensureDir,
  fileExists,
  fileSize,
  uniquePath,
  sleep,
  randomId,
  decodeHtmlEntities,
  parseNetscapeCookies,
  cookieHeaderFor,
  envProxyUrl,
  systemProxyUrl,
  electronChildEnv,
};
