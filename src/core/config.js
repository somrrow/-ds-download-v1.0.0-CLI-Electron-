'use strict';

/** 全局路径与默认配置 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

/** 工具目录（存放 yt-dlp.exe / ffmpeg.exe）；Electron 打包后由主进程改写环境变量 */
function toolsDir() {
  const custom = process.env.VIDEOGRAB_TOOLS_DIR;
  if (custom) return custom;
  return path.join(ROOT, 'tools');
}

let cachedDownloadDir = null;

/**
 * 读取 Windows 注册表里配置的「下载」文件夹（用户可能把它移到了别的盘）。
 * 读取失败（例如受限环境）时安静返回空字符串。
 */
function windowsKnownDownloads() {
  if (process.platform !== 'win32') return '';
  try {
    const { execSync } = require('child_process');
    const out = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders" /v "{374DE290-123F-4565-9164-39C4925E467B}"',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000, windowsHide: true },
    );
    const m = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(String(out).trim());
    if (!m) return '';
    return m[1]
      .trim()
      .replace(/%([^%]+)%/g, (_, name) => process.env[name] || '');
  } catch {
    return '';
  }
}

/** 默认下载目录：系统「下载」文件夹（不存在时会在下载前自动创建） */
function defaultDownloadDir() {
  if (cachedDownloadDir) return cachedDownloadDir;
  const home = process.env.USERPROFILE || os.homedir();
  const candidates = [];
  const known = windowsKnownDownloads();
  if (known) candidates.push(known);
  if (process.env.USERPROFILE) candidates.push(path.join(process.env.USERPROFILE, 'Downloads'));
  candidates.push(path.join(os.homedir(), 'Downloads'));

  cachedDownloadDir = candidates.find((c) => c && fs.existsSync(c)) || candidates.find(Boolean) || home;
  return cachedDownloadDir;
}

function configFile() {
  const dir = process.env.VIDEOGRAB_CONFIG_DIR || path.join(ROOT, '.config');
  return path.join(dir, 'settings.json');
}

/** 内置浏览器登录后导出的 Cookie 文件（yt-dlp 与内置下载引擎共用） */
function loginCookiesFile() {
  return path.join(toolsDir(), 'login-cookies.txt');
}

/** 是否已有登录状态 */
function hasLoginCookies() {
  try {
    return fs.statSync(loginCookiesFile()).size > 0;
  } catch {
    return false;
  }
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');
  return file;
}

const DEFAULTS = {
  outDir: null, // 运行时用 defaultDownloadDir()
  quality: 'best',
  concurrency: 8,
  engine: 'auto',
  autoDownloadYtDlp: true,
  autoFetchFfmpeg: true, // 站点需要合并音视频而本机没有 ffmpeg 时，自动获取一次
  codec: 'h264', // 编码偏好：h264 兼容性最好（可选 hevc / av1 / best）
  overwrite: false,
  live: false,
  historyLimit: 20, // 下载历史保留条数
  recordHistory: true,
};

module.exports = {
  ROOT,
  toolsDir,
  defaultDownloadDir,
  loginCookiesFile,
  hasLoginCookies,
  configFile,
  loadSettings,
  saveSettings,
  DEFAULTS,
  YTDLP_NAME: process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp',
  FFMPEG_NAME: process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
};
