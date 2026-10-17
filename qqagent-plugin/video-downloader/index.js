// 视频下载 —— 把本机的「肥鱼当劳（ds-download）」（源码目录 D:\视频下载工具）接到 QQ Agent 上：
// 群里出现受支持的链接就自动下下来，然后把视频 / 图文图片发回当前会话。
//
// ── 为什么是「插件」而不是「技能」────────────────────────────────────────────
// 核心 src/media-links.js 已经把这件事做成了**确定性调度**：它从消息文本里抽候选链接，
// 逐个问所有 `media.download` 提供者「谁认领谁处理」，整条链路没有任何"让模型决定"的环节。
// 规则能写死 → 插件（providers / hooks）。放进 skills/ 会静默失效：模型看不到 providers，
// 功能永远不被触发（plugin-loader 的 lintKindPlacement 就是专门警告这件事的）。
//
// ── 为什么用子进程调它的 CLI，而不是 require 它的模块 ──────────────────────
// 那套工具自带：yt-dlp / ffmpeg 自动获取、抖音等站点的内置浏览器兜底（它要拉起自己的
// Electron 渲染页面）、登录 Cookie、代理自动跟随系统代理、直播录制、图文帖逐张翻页……
// 直接 require 它的模块会把"进程与 Electron 归属"搅在一起（它的兜底需要以**它自己**为
// appRoot 启动 Electron）。而它的命令行本来就是给脚本用的：`--json` 输出结构化结果。
// 所以这里只做一件事：spawn 它的 CLI，读回 JSON。
//
// 子进程用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 启动 —— QQ Agent 本身是 Electron
// 应用，机器上不一定有独立的 node.exe；这个环境变量让同一个二进制以纯 Node 模式跑。
//
// ── 为什么用 file:// 而不是 base64 ───────────────────────────────────────
// 视频动辄几十 MB，base64 内联会把整个文件塞进 HTTP body（还要涨 33%），必然超时；
// 传本地路径让协议端自己读磁盘，body 只有几十字节。项目自己的 sender.sendImage 也是这么做的
// （内部用 toFileUri 转换）。这里保持一致，并在发送失败时回退成裸绝对路径再试一次。
//
// ── 契约（来自 src/media-links.js）──────────────────────────────────────
//   provider({ url, onebot, sender, kind, chatId, text })
//     不认领 → { skip: true }（把机会让给下一个提供者，零副作用）
//     认领并成功（已经自己把消息发出去了）→ { ok: true, platform, title }
//     认领但失败 → { ok: false, error, friendly? }；给了 friendly 时核心会把它发到群里
//
// ⚠️ 发送**必须**走 ctx.sender（sendMedia / sendImage / sendTextBatch），不能自己调 onebot：
//    那样会绕过限频与留档（README 与 sender 注释都写明了这一条）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../../src/config.js';

/**
 * 插件自己的目录。
 *
 * ⚠️ 这里是 **ESM**：`__dirname` 在 ESM 里根本不存在，用它会报
 * `ERR_AMBIGUOUS_MODULE_SYNTAX: Cannot determine intended module format`（踩过）——
 * 必须从 import.meta.url 推。
 */
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_TOOL_DIR = path.join(PLUGIN_DIR, 'tool');

const CAPABILITY = 'media.download';
/** 老写死的工具目录：现在只当"内置工具缺失时的兜底"，正常路径是插件自带的 tool/ */
const DEFAULT_TOOL_ROOT = 'D:\\视频下载工具';

/**
 * 工具跑在哪儿：
 *   1. 设置里填了「工具目录」→ 用填的那个（老用法，兼容）
 *   2. 否则 → **插件自带的 tool/**（`node qqagent-plugin/bundle-tool.mjs` 内置进来的那份）
 *   3. 再不行 → 老的 D:\视频下载工具（万一没内置又恰好有源码）
 * 这样插件不再依赖外部工具目录：QQ Agent 装到哪、这份插件就在哪跑。
 */
function toolRootOf(c = cfg()) {
  const custom = String(c.toolRoot || '').trim();
  // 老配置里存着默认值 D:\视频下载工具 —— 那不算"用户指定"，别让它挡住内置的那份
  if (custom && path.resolve(custom) !== path.resolve(DEFAULT_TOOL_ROOT)) return custom;
  const bundled = BUNDLED_TOOL_DIR;
  if (fs.existsSync(path.join(bundled, 'src', 'cli.js'))) return bundled;
  return custom || DEFAULT_TOOL_ROOT;
}

/**
 * yt-dlp / ffmpeg 放哪。
 *
 * 内置那份直接用**插件目录里的 tools/**（随包带来的二进制就在那儿，原地就能跑），
 * 不往数据目录再复制一份 96MB；只有"包里没带、别处有"时才复制过去（见 seedBinaries）。
 */
function toolWorkDir(c = cfg()) {
  const root = toolRootOf(c);
  return path.join(root, 'tools');
}

/** 已知平台的主机后缀（命中即认领） */
const PLATFORM_HOSTS = [
  // B 站：b23.tv 是分享短链，bilibili.com 覆盖视频/专栏/图文/直播
  'bilibili.com', 'b23.tv', 'acg.tv',
  // 抖音：v.douyin.com 分享短链，iesdouyin.com 手机分享页
  'douyin.com', 'iesdouyin.com', 'douyinpic.com',
  'youtube.com', 'youtu.be', 'youtube-nocookie.com',
  'twitter.com', 'x.com', 't.co',
  'instagram.com', 'facebook.com', 'fb.watch', 'fb.com',
  'tiktok.com', 'vimeo.com', 'dailymotion.com', 'twitch.tv',
  'weibo.com', 'weibo.cn', 'xiaohongshu.com', 'xhslink.com',
  'kuaishou.com', 'chenzhongtech.com', 'zhihu.com', 'pixiv.net',
  'nicovideo.jp', 'soundcloud.com', 'reddit.com', 'redd.it',
  'acfun.cn', 'iqiyi.com', 'youku.com', 'mgtv.com', 'v.qq.com', 'bilibili.tv',
  'mp.weixin.qq.com', 'ixigua.com', 'huya.com', 'douyu.com'
];

/** 看起来就是媒体直链的后缀 */
const MEDIA_EXT_RE = /\.(mp4|mkv|webm|mov|m4v|flv|f4v|avi|ts|m4s|mp3|m4a|aac|flac|wav|ogg|opus|m3u8|mpd|mp4v)(\?|#|$)/i;
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.flv', '.f4v', '.avi', '.ts', '.mpg', '.mpeg', '.wmv']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus', '.wma']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);

/** 同一个链接多久之内不重复处理 */
const RECENT_TTL_MS = 10 * 60 * 1000;

let API = null;
/** url → 时间戳：防止同一条链接被反复贴时重复下载 */
const recent = new Map();
/** 正在下载的链接（同一条链接并发进来时直接跳过） */
const running = new Set();
/** 正在跑的子进程，dispose 时要清理干净 */
const children = new Set();
let disposed = false;

// ── 串行队列 ──────────────────────────────────────────────────────────────
// 下载吃带宽和磁盘，默认一次只做一个；同时进来的请求排队而不是并发打满。
let active = 0;
const waiting = [];

function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active += 1;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          const next = waiting.shift();
          if (next) next();
        });
    };
    const limit = Math.max(1, Math.min(4, Number(cfg().concurrency) || 1));
    if (active < limit) run();
    else waiting.push(run);
  });
}

// ── 配置 ──────────────────────────────────────────────────────────────────

const DEFAULTS = {
  enabled: true,
  toolRoot: DEFAULT_TOOL_ROOT,
  outDir: '',
  keepDays: 0,
  acceptLinks: 'known+direct',
  proxy: '',
  allowLive: true,
  liveSeconds: 60,
  quality: 'best',
  maxImages: 9,
  imageOverflow: 'rest',
  zipMaxMb: 200,
  convertImages: 'risky',
  searchEnabled: true,
  searchCount: 2,
  searchSendMode: 'download',
  searchCommand: true,
  searchCommandMaxLen: 40,
  pixivAllowR18: false,
  videoAsFileMb: 100,
  concurrency: 1,
  timeoutSec: 300,
  notifyFailure: true,
  notifySuccess: false,
  extraArgs: ''
};

/**
 * 取当前配置。用 API.config() 而不是自己缓存 —— 界面上改设置要能**立即生效**，
 * 缓存住就会出现"改了设置却还是按老参数下"这种极难解释的现象。
 */
function cfg() {
  let live = {};
  try {
    live = API?.config?.() || {};
  } catch {
    live = {};
  }
  return { ...DEFAULTS, ...live };
}

/** 产物目录：默认 data/video-downloader */
function outRoot(c = cfg()) {
  const custom = String(c.outDir || '').trim();
  return custom || path.join(DATA_DIR, 'video-downloader');
}

// ── 小工具 ────────────────────────────────────────────────────────────────

/**
 * 本地路径 → file:// URI。
 *
 * 刻意不 import 核心的 toFileUri：核心内部工具改过导出（pixiv 插件就因为
 * `import { safeSlice } from '../../src/util.js'` 在核心改版后整个插件加载失败），
 * 十几行的东西自带一份，核心怎么改都不会连累本插件。
 */
function fileUri(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  let s = raw.split('\\').join('/');
  if (s.slice(0, 7).toLowerCase() === 'file://') return s;
  const unc = s.startsWith('//');
  const body = unc ? s.slice(2) : s.split('/').filter(Boolean).join('/');
  if (!body) return '';
  const encoded = encodeURI(body).replace(/[?#]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `file:///${encoded}`;
}

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function splitArgs(text) {
  return String(text || '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 拔掉 URL 里的查询串，做成安全的目录名 */
function slugFromUrl(url) {
  let base = '';
  try {
    const u = new URL(url);
    base = `${u.hostname}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    base = String(url);
  }
  const slug = base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${slug || 'media'}_${stamp}`;
}

/** Windows 下连子进程树一起结束（下载工具会再拉起 Electron / yt-dlp / ffmpeg） */
function killTree(child) {
  if (!child || child.killed) return;
  const pid = child.pid;
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  if (process.platform === 'win32' && pid) {
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => {});
    } catch {
      /* ignore */
    }
  }
}

/** 删掉超过 keepDays 天的产物（0 = 不清理） */
function pruneOld(c = cfg()) {
  const days = Number(c.keepDays) || 0;
  if (days <= 0) return 0;
  const root = outRoot(c);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    try {
      if (fs.statSync(full).mtimeMs >= cutoff) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* 正在被别的进程占用的文件删不掉，下次再说 */
    }
  }
  return removed;
}

// ── 认领规则 ──────────────────────────────────────────────────────────────

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 已知平台？ */
function isPlatform(url) {
  const host = hostOf(url);
  if (!host) return false;
  return PLATFORM_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** URL 看起来像不像直播 */
function looksLive(url) {
  const s = String(url).toLowerCase();
  if (/\/(live|lives|liveroom|live_room)(\/|$)/.test(s)) return true;
  try {
    if (/^live\./.test(new URL(url).hostname.toLowerCase())) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * 是否认领这条链接。
 *
 * ⚠️ 认领 = 失败也算在我们头上（core 会把 friendly 文案发到群里），
 * 所以默认只认"明显是媒体"的链接，不认普通网页 —— 否则群里贴个新闻链接，
 * 机器人就会回一句"下载失败"，很吵。
 */
function shouldClaim(url, c = cfg()) {
  const mode = String(c.acceptLinks || 'known+direct');
  if (!/^https?:\/\//i.test(url)) return false;
  if (isPlatform(url)) {
    if (!c.allowLive && looksLive(url)) return false;
    return true;
  }
  if (mode === 'known') return false;
  const isDirectLooking = MEDIA_EXT_RE.test(url) || /\/hls\//i.test(url);
  if (mode === 'all') return true;
  return isDirectLooking;
}

/** 平台名（只用于日志与返回值） */
function platformOf(url) {
  const host = hostOf(url);
  const rules = [
    [/bilibili\.com|b23\.tv|acg\.tv/, 'bilibili'],
    [/douyin\.com|iesdouyin\.com/, 'douyin'],
    [/youtube\.com|youtu\.be/, 'youtube'],
    [/twitter\.com|x\.com|t\.co/, 'twitter'],
    [/instagram\.com/, 'instagram'],
    [/tiktok\.com/, 'tiktok'],
    [/weibo\.(com|cn)/, 'weibo'],
    [/xiaohongshu\.com|xhslink\.com/, 'xiaohongshu'],
    [/pixiv\.net/, 'pixiv'],
    [/zhihu\.com/, 'zhihu'],
    [/weixin\.qq\.com/, 'weixin'],
    [/kuaishou\.com|chenzhongtech\.com/, 'kuaishou']
  ];
  for (const [re, name] of rules) if (re.test(host)) return name;
  if (MEDIA_EXT_RE.test(url)) return 'direct';
  return host || 'unknown';
}

// ── 调用下载工具 ──────────────────────────────────────────────────────────

/** 选一个可用的 Node 运行时：Electron 自带的（ELECTRON_RUN_AS_NODE）优先 */
function nodeRuntime() {
  const exe = process.execPath;
  if (exe && /electron|qq\s*agent/i.test(path.basename(exe))) {
    return { bin: exe, env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return { bin: process.env.QQ_AGENT_NODE || 'node', env: {} };
}

/**
 * 起工具子进程时的环境变量。
 *
 * 两件事必须在这里定死，否则内置工具会"跑到插件目录里去写东西"：
 *   · `VIDEOGRAB_TOOLS_DIR` —— yt-dlp / ffmpeg 放哪（内置那份在 plugins/ 里，QQ Agent
 *     升级会覆盖 resources/app，所以二进制要放到数据目录去，否则每次升级都得重下 96MB）；
 *   · `VIDEOGRAB_CONFIG_DIR` —— 设置、下载历史、登录 Cookie 放哪（同上，放数据目录）。
 * 再用 `seedBundledTools()` 把插件里自带的那份二进制"种"进数据目录（只复制、不下载）。
 */
function toolChildEnv(toolRoot, c = cfg()) {
  const { env } = nodeRuntime();
  const toolsDir = toolWorkDir(c);
  try {
    fs.mkdirSync(toolsDir, { recursive: true });
  } catch { /* 建不出来就让工具自己报错 */ }
  seedBinaries(path.join(toolRoot, 'tools'), toolsDir);
  const browserRuntime = findBrowserRuntime();
  return {
    ...process.env,
    ...env,
    VIDEOGRAB_TOOLS_DIR: toolsDir,
    VIDEOGRAB_CONFIG_DIR: path.join(DATA_DIR, 'video-downloader'),
    // 下载历史默认写在 tools 目录里 —— 内置版的 tools 在插件目录（升级会被覆盖），
    // 所以显式把它指到数据目录，跟 Cookie/设置放一起。
    VIDEOGRAB_HISTORY_FILE: path.join(DATA_DIR, 'video-downloader', 'history.json'),
    // 渲染引擎（抖音这类站点要用）：显式告诉工具在哪，别让它自己猜（内置版猜不到）
    ...(browserRuntime ? { VIDEOGRAB_ELECTRON: browserRuntime } : {}),
  };
}

/**
 * 找一份可用的登录 Cookie（Netscape 格式）。
 *
 * 为什么需要：工具靠 `--cookies` / `<toolsDir>/login-cookies.txt` 拿登录态，
 * 而登录态是**桌面版**用内置浏览器登录后导出的。内置工具的 toolsDir 在插件目录里
 * （插件自带的那份二进制就在那儿），所以不会自动看到桌面版的 Cookie ——
 * 表现出来就是"以前能下的 B 站专栏/会员清晰度，内置之后下不动了"（踩过）。
 * 这里按优先级找一份，找到就显式 `--cookies` 传给工具；一个都没有就照旧（不影响免登录的站点）。
 *
 * 优先级：插件自己的（用户想单独给机器人一份） > 桌面版打包版（%APPDATA%） > 桌面版源码目录。
 * 内置版完全自给自足，前两项都不存在时才去碰源码目录，纯粹是"顺手复用"。
 */
function findCookiesFile() {
  const candidates = [
    path.join(DATA_DIR, 'video-downloader', 'login-cookies.txt'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'ds-download', 'tools', 'login-cookies.txt') : '',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'videograb', 'tools', 'login-cookies.txt') : '',
    path.join(DEFAULT_TOOL_ROOT, 'tools', 'login-cookies.txt'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.statSync(p).size > 0) return p;
    } catch {
      /* 下一个 */
    }
  }
  return '';
}

/**
 * 找一份**真的能用**的 Electron 二进制给工具当"渲染引擎"。
 *
 * 为什么需要：抖音这类站点的签名是 JS 算的，必须用 Chromium 渲染页面（工具会起一个隐藏窗口）。
 * 工具的浏览器兜底要 `electron.exe <工具目录>` 这样跑；**打包版 Electron（比如 QQ Agent.exe）
 * 不认传进去的 app 目录**（实测：传了只会加载它自己的应用，进程直接退出），所以不能拿 QQ Agent 的 exe 顶。
 *
 * 顺序：
 *   1. 环境变量 VIDEOGRAB_ELECTRON（显式指定）
 *   2. 插件里自带的那份（`bundle-tool.mjs --with-electron`，约 210MB，真正免外部依赖）
 *   3. 源码工程里那份（本机装了桌面版就有：node_modules/electron/dist/electron.exe）
 *   4. 开发态：当前进程自己是**未打包的** electron.exe 时也能用
 * 找不到也不致命 —— 只有需要渲染的站点会失败，日志里会说清楚。
 */
function findBrowserRuntime() {
  const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron';
  const candidates = [
    process.env.VIDEOGRAB_ELECTRON,
    path.join(BUNDLED_TOOL_DIR, 'electron', exeName),
    path.join(DEFAULT_TOOL_ROOT, 'node_modules', 'electron', 'dist', exeName),
    /^electron(\.exe)?$/i.test(path.basename(process.execPath || '')) ? process.execPath : '',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) {
        if (!browserRuntimeLogged) {
          browserRuntimeLogged = true;
          vlog('渲染引擎（抖音等需要渲染的站点用）：%s', c);
        }
        return c;
      }
    } catch {
      /* 下一个 */
    }
  }
  if (!browserRuntimeWarned) {
    browserRuntimeWarned = true;
    vwarn('找不到可用的 Electron 渲染引擎 —— 需要渲染的站点（抖音等）会失败；可用 bundle-tool.mjs --with-electron 把它内置进来');
  }
  return '';
}
let browserRuntimeLogged = false;
let browserRuntimeWarned = false;

/**
 * 备好 yt-dlp / ffmpeg：`toolsDir` 里缺哪个，就从候选来源里复制一个过去。
 *
 * 内置版通常**不需要这一步**（包里就带着二进制，原地就能跑）；它的用处是
 * "包里没带 / 用户把那两个文件删了 / 本机别处已经下过一份" 时，别让工具白下 96MB。
 * 只复制，不覆盖已有文件，也绝不碰用户数据（history.json / login-cookies.txt）。
 */
function seedBinaries(bundledDir, toolsDir) {
  const names = process.platform === 'win32' ? ['yt-dlp.exe', 'ffmpeg.exe'] : ['yt-dlp', 'ffmpeg'];
  const missing = names.filter((n) => !fs.existsSync(path.join(toolsDir, n)));
  if (!missing.length) return;
  const sources = [
    bundledDir,
    path.join(DEFAULT_TOOL_ROOT, 'tools'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'ds-download', 'tools') : '',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'videograb', 'tools') : '',
  ].filter(Boolean);
  for (const name of missing) {
    for (const dir of sources) {
      try {
        const from = path.join(dir, name);
        if (!fs.existsSync(from)) continue;
        if (path.resolve(from) === path.resolve(path.join(toolsDir, name))) break;
        fs.mkdirSync(toolsDir, { recursive: true });
        const to = path.join(toolsDir, name);
        const tmp = `${to}.seeding`;
        fs.copyFileSync(from, tmp);   // 先写临时文件再改名：中断也不会留半个 exe
        fs.renameSync(tmp, to);
        vlog('已从 %s 复制 %s 到 %s', dir, name, toolsDir);
        break;
      } catch (error) {
        vwarn('复制 %s 失败（工具会自己下载）：%s', name, error?.message ?? error);
      }
    }
  }
}

/**
 * 从 stdout 里解析工具输出的 JSON（`--json` 时它最后打印一个 JSON 对象或数组）。
 *
 * ⚠️ 这里踩过一个真实故障：原来是"找最后一个 `\n{` 往前截"。单个结果（对象）没问题，
 * 但**多个结果时工具打印的是数组**，而数组元素是缩进过的（`\n    {`），
 * 于是 `lastIndexOf('\n{')` 找不着、退化成 `indexOf('{')`（数组第一个元素），
 * 截出来是残缺 JSON → 解析失败 → 表现为"搜图失败、但图片其实已经下好了"。
 *
 * 现在的做法：把所有"以 `{` 或 `[` 开头的行"都当候选起点，**从后往前**试解析，
 * 谁能解析成功就用谁（工具的 JSON 总是最后打印的）。数组原样返回，调用方自己拍平。
 */
function parseToolJson(stdout) {
  const text = String(stdout || '');
  const starts = [];
  const re = /^[ \t]*([[{])/gm;
  let m;
  while ((m = re.exec(text)) !== null) starts.push(m.index + m[0].length - 1);
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(text.slice(starts[i]).trim());
    } catch {
      /* 这个起点不是完整 JSON，继续往前试 */
    }
  }
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

/** 把解析出来的东西统一成数组（工具单个结果时是对象，多个结果时是数组） */
function asResultList(parsed) {
  if (!parsed) return [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** 兜底：工具没给出 JSON 时，找目录里刚产出的东西（与工具自己的 findRecentMediaFile 同思路） */
function newestArtifact(dir, sinceMs) {
  let best = '';
  let bestTime = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < sinceMs) continue;
      if (st.mtimeMs > bestTime) {
        bestTime = st.mtimeMs;
        best = full;
      }
    } catch {
      /* ignore */
    }
  }
  return best;
}

/**
 * 跑一次下载。返回 { ok, filePath, bytes, title, engine, error }
 */
function runTool(url, c = cfg()) {
  return new Promise((resolve) => {
    const toolRoot = toolRootOf(c);
    const cli = path.join(toolRoot, 'src', 'cli.js');
    if (!fs.existsSync(cli)) {
      resolve({ ok: false, error: `找不到下载工具的命令行入口：${cli}（用 bundle-tool.mjs 把工具内置进插件，或在设置里填「工具目录」）` });
      return;
    }
    const target = path.join(outRoot(c), slugFromUrl(url));
    try {
      fs.mkdirSync(target, { recursive: true });
    } catch (error) {
      resolve({ ok: false, error: `创建保存目录失败：${error.message}` });
      return;
    }

    const args = [cli, url, '-o', target, '--json', '--quiet'];
    const quality = String(c.quality || '').trim();
    if (quality) args.push('-q', quality);
    // 登录态：桌面版登录过就把那份 cookies 显式传给工具（内置版看不到桌面版的 tools 目录），
    // 这样 B 站专栏/会员清晰度、需要登录的站点在群里照样能下。
    const cookies = findCookiesFile();
    if (cookies) args.push('--cookies', cookies);
    // 显式代理：工具的 HTTP 层、yt-dlp、内置浏览器都会用它。
    // 不填的话工具自己会跟随 Windows 系统代理 —— 但"系统代理开没开"这件事很容易在
    // 换节点/切模式时被关掉，表现就是 pixiv 这类站点突然全失败且报的是"直连超时"。
    // 所以留一个明确开关：填了就一定走它。
    const proxy = String(c.proxy || '').trim();
    if (proxy) args.push('--proxy', proxy);
    if (c.allowLive && looksLive(url)) {
      const secs = Math.max(0, Number(c.liveSeconds) || 0);
      args.push('--live');
      if (secs > 0) args.push('--live-seconds', String(secs));
    }
    args.push(...splitArgs(c.extraArgs));

    const { bin, env } = nodeRuntime();
    const startedAt = Date.now();
    const timeoutMs = Math.max(30, Number(c.timeoutSec) || 300) * 1000;
    vlog('开始下载 %s（%s）', url, path.basename(target));

    let child;
    try {
      child = spawn(bin, args, {
        cwd: toolRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: toolChildEnv(toolRoot, c)
      });
    } catch (error) {
      resolve({ ok: false, error: `启动下载工具失败：${error.message}` });
      return;
    }
    children.add(child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = 256 * 1024;
    child.stdout?.on('data', (d) => {
      if (stdout.length < cap) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d) => {
      if (stderr.length < cap) stderr += d.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const finish = (payload) => {
      clearTimeout(timer);
      children.delete(child);
      resolve(payload);
    };

    child.once('error', (error) => finish({ ok: false, error: `下载工具无法启动：${error.message}` }));
    child.once('close', (code) => {
      if (timedOut) {
        finish({ ok: false, error: `下载超时（超过 ${Math.round(timeoutMs / 1000)} 秒），已结束子进程` });
        return;
      }
      const parsed = asResultList(parseToolJson(stdout)).find((r) => r && (r.ok || r.error)) || null;
      if (parsed && parsed.ok) {
        finish({
          ok: true,
          filePath: parsed.filePath || '',
          bytes: Number(parsed.bytes) || 0,
          title: parsed.title || '',
          engine: parsed.engine || '',
          // Pixiv 专用：分级（0 全年龄 / 1 成人向）与取图来源（mirror/api）
          pixivRating: Number(parsed.pixivRating) || 0,
          pixivSource: parsed.pixivSource || '',
          elapsedMs: Date.now() - startedAt
        });
        return;
      }
      if (parsed && parsed.ok === false && parsed.error) {
        finish({ ok: false, error: String(parsed.error) });
        return;
      }
      // 没解析出 JSON（工具版本变化、被信号打断等）→ 看看目录里有没有新东西
      const artifact = newestArtifact(target, startedAt - 5000);
      if (artifact) {
        let size = 0;
        try {
          size = fs.statSync(artifact).size;
        } catch {
          /* ignore */
        }
        finish({ ok: true, filePath: artifact, bytes: size, title: '', engine: 'unknown', elapsedMs: Date.now() - startedAt });
        return;
      }
      const reason = (stderr.split(/\r?\n/).find((l) => l.trim()) || stdout.split(/\r?\n/).filter((l) => l.trim() && l.trim().startsWith('✖')).pop() || '').trim();
      finish({ ok: false, error: reason || `下载工具退出码 ${code}，且没有产出文件` });
    });
  });
}

// ── 产物识别与发送 ────────────────────────────────────────────────────────

/** 把工具的产物整理成"要发什么" */
function collectArtifacts(filePath, c = cfg(), opts = {}) {
  const result = { dir: '', video: '', audio: '', images: [], other: '' };
  const p = String(filePath || '').trim();
  if (!p) return result;
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return result;
  }
  if (st.isDirectory()) {
    result.dir = p;
    // recursive：搜图那种"一个作品一个子目录"的产物要往里走一层（默认只扫本层）
    const walk = (dir, depth) => {
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((n) => !n.endsWith('.part'));
      } catch {
        names = [];
      }
      for (const name of names.sort()) {
        const full = path.join(dir, name);
        let entry = null;
        try {
          entry = fs.statSync(full);
        } catch {
          continue;
        }
        if (entry.isDirectory()) {
          if (opts.recursive && depth < 2) walk(full, depth + 1);
          continue;
        }
        const ext = path.extname(full).toLowerCase();
        if (IMAGE_EXT.has(ext)) result.images.push(full);
        else if (VIDEO_EXT.has(ext) && !result.video) result.video = full;
        else if (AUDIO_EXT.has(ext) && !result.audio) result.audio = full;
        else if (!result.other && ext !== '.json') result.other = full;
      }
    };
    walk(p, 0);
    return result;
  }
  const ext = path.extname(p).toLowerCase();
  if (IMAGE_EXT.has(ext)) result.images.push(p);
  else if (VIDEO_EXT.has(ext)) result.video = p;
  else if (AUDIO_EXT.has(ext)) result.audio = p;
  else result.other = p;
  return result;
}

// ── 打包（图太多时压成一个压缩包发，而不是丢在后面不发）────────────────────

/** 压缩包文件名：优先用帖子标题 */
function zipNameFor(artifacts, title, url) {
  const raw = String(title || '').trim() || path.basename(artifacts.dir || '') || slugFromUrl(url);
  const safe = raw
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return `${safe || 'images'}.zip`;
}

/** 用 Windows 自带的 tar.exe（bsdtar，Win10 1803+ 内置）打包；`-a` 按扩展名自动选 zip 格式 */
function zipWithTar(files, zipPath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(files[0]);
    const names = files.map((f) => path.basename(f));
    const child = spawn('tar.exe', ['-a', '-c', '-f', zipPath, '-C', dir, ...names], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let err = '';
    child.stderr?.on('data', (d) => {
      if (err.length < 4000) err += d.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve(zipPath) : reject(new Error(err.trim() || `tar 退出码 ${code}`))));
  });
}

/**
 * 兜底：PowerShell 的 Compress-Archive。
 * 脚本走 `-EncodedCommand`（UTF-16LE + base64）传过去 —— 直接拼 -Command 的话，
 * 中文/日文路径会在控制台代码页上被啃成乱码，压出来的包名对不上。
 */
function zipWithPowershell(files, zipPath) {
  return new Promise((resolve, reject) => {
    const list = files.map((f) => `'${String(f).replace(/'/g, "''")}'`).join(',');
    const script = `Compress-Archive -LiteralPath @(${list}) -DestinationPath '${String(zipPath).replace(/'/g, "''")}' -Force`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let err = '';
    child.stderr?.on('data', (d) => {
      if (err.length < 4000) err += d.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve(zipPath) : reject(new Error(err.trim() || `Compress-Archive 退出码 ${code}`))
    );
  });
}

/** 打包一组文件，返回 zip 绝对路径（失败抛错） */
async function makeZip(files, zipPath, log = () => {}) {
  if (!files.length) throw new Error('要打包的文件为空');
  try {
    fs.rmSync(zipPath, { force: true });
  } catch {
    /* ignore */
  }
  try {
    await zipWithTar(files, zipPath);
    return zipPath;
  } catch (error) {
    log('tar 打包失败（%s），改用 PowerShell Compress-Archive', error?.message ?? error);
  }
  await zipWithPowershell(files, zipPath);
  return zipPath;
}

/**
 * 用 sender 把媒体发出去。
 * 主路径走 file://（协议端自己读磁盘），失败回退成裸绝对路径（个别实现对 URI 支持不全）。
 */
async function sendSegments(sender, chatKey, segments, options, log) {
  try {
    return await sender.sendMedia(chatKey, segments, options);
  } catch (error) {
    const plain = segments.map((s) => ({
      ...s,
      data: { ...s.data, file: String(s.data?.file || '').replace(/^file:\/\/\//i, '') }
    }));
    log('file:// 发送失败（%s），改用裸路径重试一次', error?.message ?? error);
    return await sender.sendMedia(chatKey, plain, options);
  }
}

// ── 发送前的格式归一化 ────────────────────────────────────────────────────
//
// B 站的图很多是 **avif**（新版 opus/专栏特别明显），而 QQ 的图片消息只认常见格式：
// 协议端的图片格式嗅探（SnowLuma 的 detectImageFormat）压根没有 avif 分支，
// 传上去轻则当未知格式、重则直接发失败。所以发送前用工具自带的 ffmpeg 转成 jpg。
// 压缩包里保留原图（zip 与格式无关，转了就白丢信息）。

/** QQ 图片消息基本都能吃的格式 */
const SAFE_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']);

/** 找 ffmpeg：优先用下载工具 tools/ 下自带的那份，其次 PATH 里的 */
function ffmpegBin(c = cfg()) {
  const local = path.join(toolWorkDir(c), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  try {
    if (fs.existsSync(local)) return local;
  } catch {
    /* ignore */
  }
  return 'ffmpeg';
}

/** 转成 jpg（转不了就返回空串，由调用方决定是否按原格式硬发） */
function convertToJpg(file, log = () => {}, c = cfg()) {
  return new Promise((resolve) => {
    const out = `${file.replace(/\.[^./\\]+$/, '')}.jpg`;
    try {
      if (fs.existsSync(out) && fs.statSync(out).size > 0) return resolve(out);
    } catch {
      /* ignore */
    }
    const bin = ffmpegBin(c);
    const child = spawn(bin, ['-y', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-q:v', '2', out], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let err = '';
    child.stderr?.on('data', (d) => {
      if (err.length < 2000) err += d.toString('utf8');
    });
    child.once('error', () => resolve(''));
    child.once('close', (code) => {
      if (code === 0) return resolve(out);
      log('ffmpeg 转换失败（%s）：%s', path.basename(file), err.trim().slice(0, 120) || `退出码 ${code}`);
      resolve('');
    });
  });
}

/**
 * 把要直接发到群里的图片过一遍格式归一化。
 * convertImages 设置：risky（默认，只转不安全格式）/ all（全转 jpg）/ off（不动）
 */
async function ensureSendableImages(files, c = cfg(), log = () => {}) {
  const mode = String(c.convertImages || 'risky');
  if (mode === 'off') return files;
  const out = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const safe = SAFE_IMAGE_EXT.has(ext);
    if (safe && mode !== 'all') {
      out.push(f);
      continue;
    }
    if (ext === '.gif') {
      out.push(f); // 动图转成 jpg 就只剩一帧了，宁可按原样试
      continue;
    }
    const converted = await convertToJpg(f, log, c);
    out.push(converted || f);
  }
  return out;
}

/**
 * 发送下载结果；返回一句话描述（用于日志/返回值）。
 *
 * `quiet = true`：**只发媒体，不发任何文字**（搜图那条链路用得上 —— 只发图/只下载的
 * 模式下群里不该冒出"前 9 张发在上面了…"这类话）。注意它只压制说明文字，
 * 不改变发什么媒体；返回的字符串照旧带着情况，交给日志与工具返回值。
 */
async function deliver({ sender, chatKey, artifacts, url, title = '', c = cfg(), log = () => {}, quiet = false }) {
  const maxSendMb = Math.max(1, Number(c.videoAsFileMb) || 100);
  const maxBytes = maxSendMb * 1024 * 1024;

  if (artifacts.video) {
    let size = 0;
    try {
      size = fs.statSync(artifacts.video).size;
    } catch {
      size = 0;
    }
    const name = path.basename(artifacts.video);
    if (size && size > maxBytes) {
      log('视频 %s（%s）超过 %dMB，改发群文件', name, humanSize(size), maxSendMb);
      await sendSegments(
        sender,
        chatKey,
        [{ type: 'file', data: { file: fileUri(artifacts.video), name } }],
        { label: `[文件]${name}`, dedupeKey: artifacts.video },
        log
      );
      return `已发送文件 ${name}（${humanSize(size)}）`;
    }
    await sendSegments(
      sender,
      chatKey,
      [{ type: 'video', data: { file: fileUri(artifacts.video) } }],
      { label: `[视频]${name}`, dedupeKey: artifacts.video },
      log
    );
    return `已发送视频 ${name}${size ? `（${humanSize(size)}）` : ''}`;
  }

  if (artifacts.images.length) {
    const maxImages = Math.max(0, Number(c.maxImages) || 0);
    const overflowMode = String(c.imageOverflow || 'rest');
    const head = maxImages > 0 ? artifacts.images.slice(0, maxImages) : [];
    const rest = maxImages > 0 ? artifacts.images.slice(maxImages) : artifacts.images;

    let sentHead = 0;
    if (head.length) {
      // avif 这类 QQ 不认的格式先转成 jpg 再发（压缩包里仍保留原图）
      const sendable = await ensureSendableImages(head, c, log);
      const segments = sendable.map((f) => ({ type: 'image', data: { file: fileUri(f) } }));
      await sendSegments(
        sender,
        chatKey,
        segments,
        { label: `[图片×${segments.length}]`, dedupeKey: sendable.join('|') },
        log
      );
      sentHead = segments.length;
    }

    // 多出来的图：打包成一个压缩包发（群里看不到 60 张图刷屏，但一张都不会丢）
    if (rest.length && overflowMode !== 'off') {
      const zipFiles = overflowMode === 'all' ? artifacts.images : rest;
      const zipPath = path.join(artifacts.dir || outRoot(c), zipNameFor(artifacts, title, url));
      try {
        await makeZip(zipFiles, zipPath, log);
        const size = fs.statSync(zipPath).size;
        const zipMaxMb = Math.max(1, Number(c.zipMaxMb) || 200);
        if (size > zipMaxMb * 1024 * 1024) {
          log('压缩包 %s 超过 %dMB，不发文件了（留在本地）', humanSize(size), zipMaxMb);
          if (!quiet) {
            await sender.sendTextBatch(chatKey, [
              `图有 ${artifacts.images.length} 张，前 ${sentHead} 张发在上面了；剩下的打包后有 ${humanSize(size)}，超过发送上限，存在本机：${path.dirname(zipPath)}`
            ]);
          }
          return `已发送 ${sentHead} 张图片；其余打包过大未发送（${humanSize(size)}）`;
        }
        const zipSource = overflowMode === 'all' ? `全部 ${zipFiles.length} 张` : `剩下 ${zipFiles.length} 张`;
        const name = path.basename(zipPath);
        await sendSegments(
          sender,
          chatKey,
          [{ type: 'file', data: { file: fileUri(zipPath), name } }],
          { label: `[压缩包]${name}`, dedupeKey: zipPath },
          log
        );
        try {
          if (!quiet) {
            await sender.sendTextBatch(chatKey, [
              `图一共 ${artifacts.images.length} 张：前 ${sentHead} 张直接发在上面了，${zipSource}打包成压缩包（${humanSize(size)}）一起发过来`
            ]);
          }
        } catch (error) {
          log('补一句说明失败（不影响压缩包）：%s', error?.message ?? error);
        }
        return `已发送 ${sentHead} 张图片 + 压缩包 ${name}（${zipSource}，${humanSize(size)}）`;
      } catch (error) {
        log('打包失败：%s', error?.message ?? error);
        if (!quiet) {
          await sender.sendTextBatch(chatKey, [
            `图一共 ${artifacts.images.length} 张，前 ${sentHead} 张发在上面了；其余打包失败，存在本机：${artifacts.dir || zipPath}`
          ]);
        }
        return `已发送 ${sentHead} 张图片；其余打包失败（${error?.message ?? error}）`;
      }
    }

    if (!sentHead) {
      // maxImages=0 且不允许打包 → 明说，避免"下完了却什么都没发"
      throw new Error(`图片有 ${artifacts.images.length} 张，但设置里既不发图也不打包（图文帖最多发几张 = 0，且打包方式 = 关闭）`);
    }
    return `已发送 ${sentHead} 张图片`;
  }

  if (artifacts.audio) {
    const name = path.basename(artifacts.audio);
    await sendSegments(
      sender,
      chatKey,
      [{ type: 'file', data: { file: fileUri(artifacts.audio), name } }],
      { label: `[文件]${name}`, dedupeKey: artifacts.audio },
      log
    );
    return `已发送音频文件 ${name}`;
  }

  if (artifacts.other) {
    const name = path.basename(artifacts.other);
    let size = 0;
    try {
      size = fs.statSync(artifacts.other).size;
    } catch {
      /* ignore */
    }
    if (size && size > maxBytes) return `产物太大（${humanSize(size)}），未发送：${artifacts.other}`;
    await sendSegments(
      sender,
      chatKey,
      [{ type: 'file', data: { file: fileUri(artifacts.other), name } }],
      { label: `[文件]${name}`, dedupeKey: artifacts.other },
      log
    );
    return `已发送文件 ${name}`;
  }

  throw new Error(`下载完成但产物认不出来（目录：${artifacts.dir || url}）`);
}

/** 失败时给群里的一句人话（尽量短） */
function friendlyOf(error) {
  const text = String(error || '');
  if (/登录|Cookie|cookies|会员|大会员|需要登录/i.test(text)) return '这个视频要登录后才能下（工具里登录一次就行）';
  if (/超时|timeout/i.test(text)) return '这个视频下得太慢，超时了，稍后再试试';
  if (/404|不存在|已删除|失效|not found/i.test(text)) return '这个链接的内容已经不存在了';
  if (/地区|region|geo/i.test(text)) return '这个视频有地区限制，下不了';
  if (/体积|太大|超过|too large/i.test(text)) return '这个视频太大了，发不出来';
  if (/代理|proxy|ECONNRESET|ENOTFOUND|fetch failed/i.test(text)) return '网络连不上这个站点（可能要配代理）';
  return '这个视频没下下来（原因已经记在控制台日志里了）';
}

// ── 提供者入口 ────────────────────────────────────────────────────────────

/**
 * media.download 提供者：核心把消息里抽到的链接逐个交过来，谁认领谁处理。
 */
async function handleDownload(args = {}) {
  const c = cfg();
  if (disposed || c.enabled === false) return { skip: true };

  const url = String(args.url || '').trim();
  const { sender, kind, chatId } = args;
  if (!url || !sender || !kind || chatId === undefined || chatId === null) return { skip: true };
  if (!shouldClaim(url, c)) return { skip: true };

  const chatKey = `${kind}:${chatId}`;
  const platform = platformOf(url);

  // 重复 / 并发保护：同一条链接 10 分钟内只处理一次
  const now = Date.now();
  for (const [key, ts] of recent) if (now - ts > RECENT_TTL_MS) recent.delete(key);
  if (recent.has(url) || running.has(url)) {
    vlog('链接刚处理过或正在处理，跳过：%s', url);
    return { skip: true };
  }
  running.add(url);

  const log = (...a) => vlog(...a);
  const warn = (...a) => vwarn(...a);

  try {
    if (c.notifySuccess) {
      try {
        await sender.sendTextBatch(chatKey, ['在下这个视频，稍等一下～']);
      } catch {
        /* 提示失败不影响下载 */
      }
    }

    const result = await withSlot(() => runTool(url, c));
    let delivered = '';
    if (result.ok) {
      // 成人向作品默认**不发到群里**（link 这条路上也可能贴到 R18 作品）。
      // 工具会在反代取图时顺带反查分级，放进 JSON 的 pixivRating 里。
      if (result.pixivRating > 0 && c.pixivAllowR18 !== true) {
        warn('作品是成人向，按设置没有发出来：%s', url);
        return {
          ok: false,
          error: '成人向作品（插件设置里「允许成人向」未打开）',
          friendly: '这个是成人向作品，按当前设置就不发出来了'
        };
      }
      const artifacts = collectArtifacts(result.filePath, c);
      delivered = await deliver({ sender, chatKey, artifacts, url, title: result.title, c, log });
      recent.set(url, Date.now());
      const pruned = pruneOld(c);
      if (pruned) log('顺手清理了 %d 个过期产物', pruned);
      log('转发完成：%s → %s（%s）', url, delivered, result.engine || '?');
      return { ok: true, platform, title: result.title || delivered };
    }

    warn('下载失败：%s → %s', url, result.error);
    recent.set(url, Date.now());   // 失败也记一笔，免得同一条坏链接被反复重试
    return {
      ok: false,
      error: result.error,
      friendly: c.notifyFailure ? friendlyOf(result.error) : ''
    };
  } catch (error) {
    warn('处理链接异常：%s → %s', url, error?.message ?? error);
    recent.set(url, Date.now());
    return {
      ok: false,
      error: String(error?.message ?? error),
      friendly: c.notifyFailure ? friendlyOf(error?.message) : ''
    };
  } finally {
    running.delete(url);
  }
}

// ── Pixiv 搜图（LLM 工具）─────────────────────────────────────────────────
//
// 和 media.download 的区别：那条路是**链接驱动**的确定性调度（有人贴链接我就下）；
// 「来张初音ミク的图」这种**要理解人话**的需求只能由模型判断，所以注册成工具。
// 实现上仍然交给下载工具：`vgrab --pixiv-search` 走公开检索接口 + pixiv.re 反代，
// **不需要代理**（pixiv.net 直连不通也能用）——这是这次专门补上的能力。

/** 搜图落盘目录（每个作品一个子目录） */
function searchDir(keyword, c = cfg()) {
  const root = outRoot(c);
  const safe = String(keyword || 'search').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'search';
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return path.join(root, `search_${safe}_${stamp}`);
}

/** 跑一次 `--pixiv-search`，返回工具输出的 JSON（数组或单个对象归一化成数组） */
function runPixivSearchToolCli(keyword, count, c = cfg()) {
  return new Promise((resolve) => {
    const toolRoot = toolRootOf(c);
    const cli = path.join(toolRoot, 'src', 'cli.js');
    if (!fs.existsSync(cli)) {
      resolve({ ok: false, error: `找不到下载工具的命令行入口：${cli}` });
      return;
    }
    const target = searchDir(keyword, c);
    try {
      fs.mkdirSync(target, { recursive: true });
    } catch (error) {
      resolve({ ok: false, error: `创建目录失败：${error.message}` });
      return;
    }
    // ⚠️ 用 --count 而不是 -n：那个工具里 -n 是 --name（输出文件名），
    // 写成 `-n 2` 会被当成"文件名 = 2"，搜出来的图全叫 2.png（踩过）。
    const args = [cli, '--pixiv-search', keyword, '--count', String(count), '-o', target, '--json', '--quiet'];
    if (c.pixivAllowR18 === true) args.push('--r18');
    const proxy = String(c.proxy || '').trim();
    if (proxy) args.push('--proxy', proxy);
    const cookies = findCookiesFile();
    if (cookies) args.push('--cookies', cookies);   // 反代取图不需要，但登录态能让部分受限作品可用
    args.push(...splitArgs(c.extraArgs));

    const { bin } = nodeRuntime();
    const timeoutMs = Math.max(60, Number(c.timeoutSec) || 300) * 1000;
    vlog('搜图开始：%s（最多 %d 个作品）', keyword, count);
    let child;
    try {
      child = spawn(bin, args, { cwd: toolRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: toolChildEnv(toolRoot, c) });
    } catch (error) {
      resolve({ ok: false, error: `启动下载工具失败：${error.message}` });
      return;
    }
    children.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = 512 * 1024;
    child.stdout?.on('data', (d) => {
      if (stdout.length < cap) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d) => {
      if (stderr.length < cap) stderr += d.toString('utf8');
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const finish = (payload) => {
      clearTimeout(timer);
      children.delete(child);
      resolve(payload);
    };
    child.once('error', (error) => finish({ ok: false, error: `下载工具无法启动：${error.message}` }));
    child.once('close', (code) => {
      if (timedOut) {
        finish({ ok: false, error: `搜图超时（超过 ${Math.round(timeoutMs / 1000)} 秒）` });
        return;
      }
      const results = asResultList(parseToolJson(stdout)).filter((r) => r && (r.ok !== undefined || r.error));
      if (results.length) {
        finish({ ok: true, results, dir: target });
        return;
      }
      // 解析不出 JSON 时**不能直接当失败**：图片很可能已经下好了（实际踩过：
      // 工具打印数组、解析器只认对象 → 报"搜图失败"，但目录里躺着两个作品）。
      // 这里退回"看目录里有没有东西"，有就照常发出去。
      const artifacts = collectArtifacts(target, cfg(), { recursive: true });
      const found = artifacts.images.length + (artifacts.video ? 1 : 0);
      if (found) {
        vwarn('搜图输出解析失败，但目录里有 %d 个文件，按已下载处理（退出码 %s）', found, code);
        finish({
          ok: true,
          parseFailed: true,
          results: [
            {
              ok: true,
              pid: '',
              title: path.basename(target),
              author: '',
              dir: target,
              files: artifacts.images.length,
              bytes: artifacts.images.reduce((sum, f) => {
                try {
                  return sum + fs.statSync(f).size;
                } catch {
                  return sum;
                }
              }, 0)
            }
          ],
          dir: target
        });
        return;
      }
      const tail = stdout.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ').slice(0, 200);
      const errLine = stderr.split(/\r?\n/).find((l) => l.trim());
      finish({
        ok: false,
        error: (errLine || tail || `搜图工具退出码 ${code}，且没有产出任何文件`).trim(),
        dir: target
      });
    });
  });
}

/**
 * 搜图结果怎么处理（`searchSendMode` 设置）→ 明确的执行计划。
 *
 * 抽成纯函数是为了让 `qqagent-plugin/verify.mjs --search` 能脱网、确定性地测三种模式
 * （真跑一遍搜图要联网，分支判断本身不该依赖网络）。
 *
 *   download（默认）= **只下载**：图留在本机，群里一个字都不发（连图也不发），
 *                     情况写进日志与工具返回值，并让模型也不要发言；
 *   images          = **只发图**：图（超出上限照旧打包成 zip）发出去，但不发任何文字说明；
 *   send            = **图 + 两句固定话**：收到指令先发「开始搜图了」，图片发完再发
 *                     「搜图结束了」（不再发"前 N 张发在上面了…"那种说明文字）。
 */
function searchPlan(mode) {
  const m = String(mode ?? 'download').toLowerCase();
  if (m === 'send') {
    return { mode: 'send', chat: true, quiet: true, silentModel: false, startText: '开始搜图了', endText: '搜图结束了' };
  }
  if (m === 'images') {
    return { mode: 'images', chat: true, quiet: true, silentModel: false, startText: '', endText: '' };
  }
  return { mode: 'download', chat: false, quiet: true, silentModel: true, startText: '', endText: '' };
}

/**
 * 搜图并下载（CLI + 产物收集）。**只负责"下下来"**，发不发由调用方按 searchSendMode 决定。
 *
 * 抽出来是因为现在有两条入口：① 模型调用 `pixiv_search` 工具；② 「我要 xxx 的图」这类
 * 确定性指令（`message.image-request`，0 token）。两条路必须下同样的东西，
 * 否则"指令下的图"和"工具下的图"迟早会长成两套行为。
 */
async function searchOnce({ keyword, count, c, log = () => {} }) {
  const res = await withSlot(() => runPixivSearchToolCli(keyword, count, c));
  if (!res.ok) return { ok: false, error: res.error, dir: res.dir };

  const okWorks = (res.results || []).filter((r) => r.ok);
  const failed = (res.results || []).filter((r) => !r.ok);
  if (!okWorks.length) {
    return { ok: false, error: failed[0]?.error || '没有搜到作品', dir: res.dir, failed };
  }

  const artifacts = collectArtifacts(res.dir, c, { recursive: true });
  const imageCount = artifacts.images.length;
  const bytes = artifacts.images.reduce((sum, f) => {
    try {
      return sum + fs.statSync(f).size;
    } catch {
      return sum;
    }
  }, 0);
  const list = okWorks
    .map((w, i) => `${i + 1}. 「${w.title || '(无题)'}」${w.author ? ` — ${w.author}` : ''}（pid ${w.pid}）`)
    .join('\n');
  const failNote = failed.length ? `（${failed.length} 个作品取图失败，已跳过：${failed[0]?.error || ''}）` : '';

  if (!imageCount && !artifacts.video) {
    return { ok: false, error: `产物目录里没有可用的图片（${res.dir}）`, dir: res.dir, okWorks, failed, list, failNote };
  }
  return { ok: true, dir: res.dir, artifacts, okWorks, failed, imageCount, bytes, list, failNote };
}

/**
 * 一次完整的搜图请求：下载 → 按计划发或不发 → 返回一句人话。
 * 返回 `{ ok, message, result }`；`result` 里有张数/体积/清单，供调用方拼自己的答复。
 *
 * `send` 模式下的两句固定话（「开始搜图了」/「搜图结束了」）也在这里发：
 * 开始那句在**下载之前**发（收到指令就吱一声），结束那句在**图片发完之后**发。
 * 发提示语失败只记日志，绝不影响搜图本身。
 */
async function performSearchRequest({ keyword, count, c, plan, sender, chatKey, log = () => {}, source = '工具' }) {
  /**
   * 发一句固定话（`send` 模式用）。
   *
   * **由插件自己直接发**：走核心的 `sender.sendTextBatch`（限频 / 去重 / 留档都在里面），
   * **不经过模型** —— 固定句式那条路上模型压根不会被叫醒（钩子 veto）；
   * 模型即使从别的路径调了搜图工具，这两句也不是它写的，返回值里会明确要求它别复述。
   */
  const say = async (text) => {
    if (!plan.chat || !text || !sender || !chatKey) return;
    try {
      await sender.sendTextBatch(chatKey, [text]);
      log('[%s] 已直接发出固定话「%s」（不经模型）', source, text);
    } catch (error) {
      log('[%s] 发「%s」失败（不影响搜图）：%s', source, text, error?.message ?? error);
    }
  };

  await say(plan.startText);   // send 模式：收到指令先吱一声

  const r = await searchOnce({ keyword, count, c, log });
  if (!r.ok) {
    // 失败就不发"搜图结束了"（那句只在图片真的发出去之后发）
    log('[%s] 搜图失败：%s → %s', source, keyword, r.error);
    return { ok: false, message: `搜图失败：${r.error}`, result: r };
  }

  // ① 只下载：群里一个字都不发（图也不发），情况只进日志与返回值
  if (!plan.chat) {
    log('[%s] 搜图完成（只下载，未发消息）：%s → %d 张 %s，在 %s', source, keyword, r.imageCount, humanSize(r.bytes), r.dir);
    return {
      ok: true,
      result: r,
      message: `已下载「${keyword}」的图 ${r.imageCount} 张（${humanSize(r.bytes)}），保存在：${r.dir}`
    };
  }

  if (!sender || !chatKey) {
    log('[%s] 搜图完成但当前会话不可用，只下载：%s → %s', source, keyword, r.dir);
    return { ok: true, result: r, message: `图已下好在 ${r.dir}，但当前会话不可用，发不出去。` };
  }

  const delivered = await deliver({
    sender,
    chatKey,
    artifacts: r.artifacts,
    url: `pixiv-search:${keyword}`,
    title: `${keyword} 的图`,
    c,
    log,
    quiet: plan.quiet
  });
  await say(plan.endText);   // send 模式：图发出去了再说一声
  log('[%s] 搜图完成：%s → %s', source, keyword, delivered);
  return { ok: true, result: r, message: `已把「${keyword}」的图发到本会话：${delivered}` };
}

/** 搜图工具的 execute：搜图 → 下载 → 按 searchSendMode 决定"发不发、发什么" */
async function runPixivSearchTool(ctx, args) {
  const c = cfg();
  if (c.enabled === false) return { content: '这个功能被管理员关掉了。', isError: true };
  if (c.searchEnabled === false) return { content: '搜图功能被管理员关掉了（只保留链接自动转发）。', isError: true };

  const keyword = String(args?.keyword ?? '').trim();
  if (!keyword) return { content: '错误：keyword 不能为空（比如「初音ミク」）。', isError: true };
  const count = Math.max(1, Math.min(5, Number(args?.count) || Number(c.searchCount) || 2));
  const plan = searchPlan(c.searchSendMode);
  const log = (...a) => vlog(...a);

  let out;
  try {
    out = await performSearchRequest({
      keyword,
      count,
      c,
      plan,
      sender: ctx?.sender,
      chatKey: String(ctx?.chatKey || ''),
      log,
      source: '工具'
    });
  } catch (error) {
    log('搜图发送失败：%s', error?.message ?? error);
    return { content: `图下下来了但没发出去：${error?.message ?? error}`, isError: true };
  }
  if (!out.ok) return { content: out.message, isError: true };

  const r = out.result;
  const body = `${out.message}\n${r.list || ''}${r.failNote ? `\n${r.failNote}` : ''}`;
  if (!plan.chat) {
    return {
      content: `${body}\n本次**不要往群里发任何消息**：不要调用任何发送/回复类工具，也不要贴这些图片或路径。静静收下这份结果就行。`
    };
  }
  try {
    ctx?.session?.sent?.push({ type: 'image', text: `[Pixiv:${keyword}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
    ctx?.emit?.('session-update', ctx?.session?.id);
  } catch {
    /* 留档失败不影响结果 */
  }
  const tail = plan.mode === 'send'
    ? '「开始搜图了」「搜图结束了」这两句**插件已经自己直接发出去了**（不经模型），你不要再重复、也不用复述图片内容。'
    : '不要再复述图片内容，也不用汇报"已发送"。';
  return { content: `${body}\n${tail}` };
}

/**
 * 「我要 xxx 的图」这类**确定性搜图指令**的识别模块。
 *
 * 用**动态** import 是有意的：这个模块由 deploy.cmd 一起复制进插件目录，万一漏了，
 * 静态 import 会让整个插件（连 media.download 链接转发）加载失败 —— 代价太大。
 * 这里失败只是"确定性指令不生效"，消息照旧走模型。
 */
let matcher = null;
let matcherTried = false;
async function loadSearchMatcher() {
  if (!matcherTried) {
    matcherTried = true;
    try {
      matcher = await import('./search-command.mjs');
    } catch (error) {
      matcher = null;
      vwarn('搜图指令模块（search-command.mjs）加载失败，确定性指令不生效：%s', error?.message ?? error);
    }
  }
  return matcher;
}

// ── 运行时钩子：每条入站消息的必经点（Orchestrator.onIncoming）─────────────────
//
// 为什么**不改核心文件**：`orchestrator.onIncoming` 是每条入站消息（已过白名单/屏蔽名单）
// 的必经点，本项目里已有两个插件（punch-card 的打卡测试指令、netease-voice-song 的点歌）
// 用同样的方式挂"0 token 确定性功能"。约定是：前置函数返回 `'veto'` 就**不调用原方法**
// —— 不排会话、不叫醒模型，这正是"0 token"的落点。
//
// 这样做的三个好处：① 插件热重载即生效，**不用重启**；② 不用改核心文件（升级不会冲掉）；
// ③ 与其它插件的钩子互不干扰（各自的 Symbol 键，天然可链式共存）。
// `message.image-request` 能力（配合 image-request/apply.mjs 的核心补丁）保留做备用：
// 两条路不会重复执行 —— 核心补丁会在调 onIncoming 之前就 return，根本轮不到这个钩子。
const ORCH_HOOK_KEY = Symbol.for('qq-agent.video-downloader.orch.onIncoming');
/**
 * "当前该用哪份实现"放在全局符号上，而不是让每个链环闭包捕获自己那一份。
 *
 * 为什么：热重载时旧实例的链环可能还留在 prototype 上（dispose 顺序、重复加载都会留下），
 * 新实例 install 时若"复用旧记录"，调用就会走**旧闭包** —— 旧代码、旧日志路由。
 * 实测踩过：功能明明生效了（图下下来了、没叫模型），日志里却一行都看不到，
 * 因为跑的是 20:56 那份没有 logger 的旧实现。链环统一读这个全局指针就永远不会串味。
 */
const IMPL_KEY = Symbol.for('qq-agent.video-downloader.orch.onIncoming.impl');
let hookedProto = null;

// ── 日志：要能出现在 QQ Agent 的日志文件里 ─────────────────────────────────
//
// `api.log` 只进控制台，**不进** data/logs/qq-agent-<日期>.log —— 出问题时你只能靠猜。
// （上一次用户说"似乎没生效"，我翻遍日志文件都找不到这个插件的一行记录，就是这么回事。）
// 所以关键日志再走一遍核心的 logger（其它插件用的就是这个）；用**动态** import + 兜底，
// 核心改版拿不到 logger.js 时退回 api.log，绝不影响功能。
let coreLogger = null;
let loggerTried = false;
async function loadCoreLogger() {
  if (loggerTried) return coreLogger;
  loggerTried = true;
  try {
    coreLogger = (await import('../../src/logger.js'))?.logger || null;
  } catch {
    coreLogger = null;
  }
  return coreLogger;
}
const PLUGIN_ID = 'video-downloader';
const apiLog = (...args) => { try { API.log?.(...args); } catch { /* ignore */ } };
const apiWarn = (...args) => { try { API.warn?.(...args); } catch { /* ignore */ } };
function vlog(...args) {
  apiLog(...args);
  try { coreLogger?.info?.(PLUGIN_ID, ...args); } catch { /* ignore */ }
}
function vwarn(...args) {
  apiWarn(...args);
  try { coreLogger?.warn?.(PLUGIN_ID, ...args); } catch { /* ignore */ }
}

async function installOrchestratorHook() {
  if (hookedProto) return true;
  await loadCoreLogger();
  await loadSearchMatcher();   // 先备好识别模块，钩子里才能同步判断
  let proto = null;
  try {
    const core = await import('../../src/orchestrator.js');
    proto = core?.Orchestrator?.prototype || null;
  } catch (error) {
    vwarn('拿不到核心的 Orchestrator（%s）—— 确定性搜图指令只剩"核心补丁"那条路可用', error?.message ?? error);
    return false;
  }
  if (!proto || typeof proto.onIncoming !== 'function') {
    vwarn('Orchestrator.prototype.onIncoming 不可用，确定性搜图指令没挂上（应用版本可能变了）');
    return false;
  }
  let rec = proto[ORCH_HOOK_KEY];
  // 链环统一从全局指针取实现：不管这个环是哪次加载留下的，跑的都是最新那份逻辑
  globalThis[IMPL_KEY] = handleIncomingHook;
  if (!rec) {
    const original = proto.onIncoming;
    const wrapped = function onIncoming(chatKey, entry = null) {
      const impl = globalThis[IMPL_KEY];
      if (typeof impl === 'function') {
        try {
          // 命中就 veto：不排会话、不叫醒模型（消息已存档，聊天记录里看得见）
          if (impl(this, chatKey, entry) === 'veto') return undefined;
        } catch (error) {
          vwarn('搜图指令钩子出错（不影响原流程）：%s', error?.message ?? error);
        }
      }
      return original.apply(this, arguments);
    };
    rec = { original, wrapped };
    proto[ORCH_HOOK_KEY] = rec;
    proto.onIncoming = wrapped;
  }
  hookedProto = proto;
  vlog('已挂载 onIncoming 钩子（「我要 xxx 的图」这类句式直接搜图，0 token，不用重启）');
  return true;
}

function uninstallOrchestratorHook() {
  // 只在自己还是"当前实现"时摘掉指针，避免把后来实例的注册清掉
  if (globalThis[IMPL_KEY] === handleIncomingHook) delete globalThis[IMPL_KEY];
  const proto = hookedProto;
  hookedProto = null;
  const rec = proto?.[ORCH_HOOK_KEY];
  if (!proto || !rec) return;
  if (proto.onIncoming === rec.wrapped) proto.onIncoming = rec.original;
  delete proto[ORCH_HOOK_KEY];
}

/**
 * 钩子主体：命中句式 → **先标已读** → 后台搜图 → 返回 'veto'。
 *
 * 顺序很讲究：**标已读失败就什么都不做**（把消息交回模型）。标不上却 veto 的话，
 * 这条消息会一直挂着未读，兜底定时器迟早还是把模型叫起来 —— 那就白省 token，
 * 而且我们还会多下一次图（第一次踩的坑正是"静默没标上"：白烧 6.7 万 prompt token）。
 */
function handleIncomingHook(orch, chatKey, entry) {
  const c = cfg();
  if (c.enabled === false || c.searchEnabled === false || c.searchCommand === false) return '';
  if (!entry || entry.self === true) return '';
  const text = String(entry.text || '').trim();
  if (!text) return '';
  if (!matcher) return '';   // 识别模块没就绪：这条交给模型（下次就绪了照常）

  const atNames = Array.isArray(entry.atNames) ? entry.atNames : [];
  // 有 @ 段但没 @ 机器人 = @ 了别人，那是在跟别的群友说话，不认领
  const atOthers = atNames.length > 0 && entry.atMe !== true;

  let hit = null;
  try {
    hit = matcher.matchSearchCommand(text, {
      atOthers,
      atNames,
      maxLength: Number(c.searchCommandMaxLen) || 40
    });
  } catch (error) {
    vwarn('搜图指令识别出错（按不认领处理）：%s', error?.message ?? error);
    return '';
  }
  if (!hit) return '';

  // ① 先标已读（标不上就当没认领，避免"未读挂着 → 兜底定时器又叫模型"）
  let marked = false;
  try {
    marked = orch?.store?.markEntryRead(String(chatKey), entry.id) === true;
  } catch (error) {
    vwarn('标已读出错，这条交给模型：%s', error?.message ?? error);
  }
  if (!marked) {
    vwarn('搜图指令没能标成已读，这条交给模型处理：%s', text.slice(0, 30));
    return '';
  }

  // ② 后台搜图（钩子必须立刻返回：它是每条消息的必经点，不能等下载）
  const count = Math.max(1, Math.min(5, hit.count || Number(c.searchCount) || 2));
  const plan = searchPlan(c.searchSendMode);
  const log = (...a) => vlog(...a);
  log('收到搜图指令（0 token，不经模型）：「%s」→ 关键词「%s」，%d 个作品（%s）', text.slice(0, 40), hit.keyword, count, plan.mode);
  void (async () => {
    try {
      const out = await performSearchRequest({
        keyword: hit.keyword,
        count,
        c,
        plan,
        sender: orch?.sender,
        chatKey: String(chatKey),
        log,
        source: '指令'
      });
      if (out.ok) log('[指令] %s\n%s', out.message, out.result?.list || '');
    } catch (error) {
      log('[指令] 搜图指令执行失败：%s', error?.message ?? error);
    }
  })();

  // ③ veto：不让这条消息进编排器（不排会话 = 0 token）
  return 'veto';
}

/**
 * `message.image-request` 提供者：确定性搜图指令的**备用路径**。
 *
 * 正路是上面的运行时钩子（`Orchestrator.onIncoming` 里 veto），它不需要改核心文件、
 * 也不用重启。只有在钩子挂不上（核心大改、拿不到 Orchestrator）时，才轮到这条：
 * 那时如果核心打了 `image-request/apply.mjs` 补丁，就会在入库前问到这里。
 *
 * 契约（和 media.download 一样由核心直接调，不经过模型）：
 *   认领   → `{ handled: true }` —— 核心会把消息标成已读、**不叫醒模型**；
 *   不认领 → `{ skip: true }`   —— 消息照旧走编排器（钩子会接住）。
 *
 * ⚠️ **必须立刻返回**：核心是在消息入库前 await 它的，这里绝不能等下载（几十秒到几分钟）。
 * 所以认领之后就 `handled: true` 返回，真正的下载丢到后台跑。
 */
async function handleImageRequest(args = {}) {
  const c = cfg();
  if (c.enabled === false || c.searchEnabled === false) return { skip: true };
  if (c.searchCommand === false) return { skip: true };
  // 钩子已经在管这件事了 → 这里**故意不认领**。两边都认领会重复下一遍图；更要紧的是
  // 核心补丁那条路是在 appendIncoming **之前**被问的，它标已读要靠核心版本里的写法
  // （早期补丁单参数标不上 → 消息一直挂着未读 → 兜底定时器又把模型叫起来，
  // 表现就是"补丁看着生效了、token 却照样烧"）。统一交给钩子，只有一条路。
  if (hookedProto) return { skip: true };

  const cm = await loadSearchMatcher();
  if (!cm) return { skip: true };

  let hit = null;
  try {
    hit = cm.matchSearchCommand(args?.text, {
      atOthers: args?.atOthers === true,
      atNames: Array.isArray(args?.atNames) ? args.atNames : [],
      maxLength: Number(c.searchCommandMaxLen) || 40
    });
  } catch (error) {
    vwarn('搜图指令识别出错（按不认领处理）：%s', error?.message ?? error);
    return { skip: true };
  }
  if (!hit) return { skip: true };

  const count = Math.max(1, Math.min(5, hit.count || Number(c.searchCount) || 2));
  const plan = searchPlan(c.searchSendMode);
  const sender = args?.sender;
  const chatKey = String(args?.chatKey || `${args?.kind || 'group'}:${args?.chatId || ''}`);
  const log = (...a) => vlog(...a);
  const source = '指令';
  log(
    '收到搜图指令（0 token，不经模型）：「%s」→ 关键词「%s」，%d 个作品（%s）',
    String(args?.text || '').slice(0, 40),
    hit.keyword,
    count,
    plan.mode
  );

  // 后台跑：核心的热路径不能被下载卡住
  void (async () => {
    try {
      const out = await performSearchRequest({ keyword: hit.keyword, count, c, plan, sender, chatKey, log, source });
      if (out.ok) log('[%s] %s\n%s', source, out.message, out.result?.list || '');
    } catch (error) {
      log('[%s] 搜图指令执行失败：%s', source, error?.message ?? error);
    }
  })();

  return { handled: true, keyword: hit.keyword, count };
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

/** 加载时调用（loader 支持 setup(api) / register(api)） */
export async function setup(api) {
  API = api;
  // 先把"能进日志文件"的那条通道备好：coreLogger 是动态 import 的，
  // 不先 await 的话，下面那句"已就绪"只会进控制台、不进日志文件（排查时看不到用了哪份工具）。
  await loadCoreLogger();
  const c = cfg();
  try {
    fs.mkdirSync(outRoot(c), { recursive: true });
  } catch (error) {
    api.warn('创建产物目录失败：%s', error?.message ?? error);
  }
  // 搜图工具：链接自动转发（media.download）之外的"人话入口"
  try {
    api.registerTool({
      id: 'pixiv_search',
      name: 'Pixiv 搜图（免代理）',
      description:
        '按关键词/角色名搜 Pixiv 插画并**下载到本机**。**不需要代理**（走公开检索接口 + pixiv.re 反代），' +
        '所以 pixiv.net 直连不通的环境也能用。\n' +
        '图要不要发到当前会话由管理员的插件设置「搜图结果怎么处理」决定（默认**只下载**：群里一个字都不发，' +
        '你也不用替它汇报）。**每次调用的返回值里会写明这次该不该发言，照它说的做**。\n' +
        '什么时候用：群友**明确要图**时 —— 「来张初音ミク的图」「搜点猫娘的图」「有没有 XX 的图」。' +
        '不要求图就别主动搜。\n' +
        '设置成「图 + 两句固定话」时，「开始搜图了」「搜图结束了」由**插件自己直接发**（不经模型），' +
        '你既不用等它、也不要重复它。\n' +
        '默认只出全年龄作品（成人向需要管理员在插件设置里显式打开）。',
      category: 'media',
      icon: '🖼️',      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '关键词或角色名，如「初音ミク」「猫娘」「风景」' },
          count: { type: 'number', description: '下载几个作品，1~5，默认 2；对方要"多来几张"时可以调大' }
        },
        required: ['keyword']
      },
      execute: (ctx, args) => runPixivSearchTool(ctx, args)
    });
  } catch (error) {
    api.warn('注册搜图工具失败：%s', error?.message ?? error);
  }
  const effectiveRoot = toolRootOf(c);
  const bundled = path.resolve(effectiveRoot) === path.resolve(BUNDLED_TOOL_DIR);
  // 走 vlog 而不是 api.log：这样"当前用的是内置还是外部工具"会进 QQ Agent 的日志文件，
  // 排查"到底跑的哪份工具"时不用猜。
  vlog(
    '已就绪：提供 %s + 工具 pixiv_search（保存目录 %s，工具目录 %s%s，yt-dlp/ffmpeg 在 %s）',
    CAPABILITY,
    outRoot(c),
    effectiveRoot,
    bundled ? '（插件内置）' : '（外部目录）',
    toolWorkDir(c)
  );
  // 确定性搜图指令（「我要 xxx 的图」…）：运行时挂 onIncoming 钩子，命中即 veto（0 token）。
  // 不 await —— 挂不上也不该影响插件的其它功能，钩子里会自己写日志。
  installOrchestratorHook().catch((error) => {
    api.warn('挂载搜图指令钩子失败：%s', error?.message ?? error);
  });
}

/** 卸载 / 热重载时调用：把还在跑的子进程收干净，不留幽灵进程 */
export function dispose() {
  disposed = true;
  uninstallOrchestratorHook();   // 热重载前把自己的钩子摘掉，避免链上留死引用
  for (const child of children) killTree(child);
  children.clear();
  waiting.length = 0;
}

/** 能力提供者注册（loader 直接读这个导出） */
export const providers = {
  [CAPABILITY]: (args) => handleDownload(args),
  // 备用路径：核心若打了 image-request 补丁，会在消息入库前问一句，命中就不叫醒模型 ——
  // 一个 token 都不花。没打补丁时这个提供者只是闲在那里（插件用运行时钩子实现同样的效果，
  // 不需要改核心文件、也不用重启）。
  'message.image-request': (args) => handleImageRequest(args)
};

/**
 * 以下仅供 qqagent-plugin/verify.mjs 自检用（加载器不消费：
 * 它只读 setup/register/providers/hooks/activate/dispose）。
 * 这样"图片超 9 张 → 打包成压缩包"这类分支可以脱网、确定性地测。
 */
export {
  deliver,
  collectArtifacts,
  makeZip,
  shouldClaim,
  platformOf,
  parseToolJson,
  asResultList,
  searchPlan,
  runPixivSearchTool,
  handleImageRequest,
  handleIncomingHook,
  installOrchestratorHook,
  uninstallOrchestratorHook,
  searchOnce
};
