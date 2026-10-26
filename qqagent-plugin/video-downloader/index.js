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
import util from 'node:util';
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
/**
 * 老写死的工具目录：只当"内置工具缺失时的兜底"。工程已经搬到 `D:\ds-download-1.0.0-win-x64`
 * （现在那儿放的是**分发包**，只有 resources/app 里的代码），旧路径留作最后一级备用。
 */
const LEGACY_TOOL_ROOT = 'D:\\视频下载工具';
const DEFAULT_TOOL_ROOT = 'D:\\ds-download-1.0.0-win-x64';

/**
 * 工具跑在哪儿：
 *   1. 设置里填了「工具目录」→ 用填的那个（老用法，兼容）
 *   2. 否则 → **插件自带的 tool/**（`bundle-tool.mjs` 内置进来的那份）
 *   3. 再不行 → 新位置的分发包 / 老的 D:\视频下载工具（万一没内置又恰好有源码）
 * 这样插件不依赖外部目录：QQ Agent 装到哪、这份插件就在哪跑。
 */
function toolRootOf(c = cfg()) {
  const custom = String(c.toolRoot || '').trim();
  // 老配置里存着默认值（旧的 D:\视频下载工具）—— 那不算"用户指定"，别让它挡住内置的那份
  const isLegacyDefault = custom === '' || path.resolve(custom) === path.resolve(LEGACY_TOOL_ROOT);
  if (custom && !isLegacyDefault) return custom;
  const bundled = BUNDLED_TOOL_DIR;
  if (fs.existsSync(path.join(bundled, 'src', 'cli.js'))) return bundled;
  if (custom) return custom;
  return DEFAULT_TOOL_ROOT;
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
/** 正在跑的子进程，dispose 时要清理干净 */
const children = new Set();
let disposed = false;

/**
 * 下载队列与去重状态放在**全局**，不放在模块作用域里。
 *
 * 为什么（2026-10-17 真实现场，用户报「同时收到两条链接只下了一条」）：
 * 模块作用域的东西是"每个插件实例一份"。QQ Agent 热重载会换一个新实例，
 * 而热重载**随时可能发生**（内置工具的 Electron 运行时就住在 plugins/ 里，
 * 它读写自己的文件就会触发全量重扫）。于是：
 *   ① 旧实例里 `waiting` 排着第二条链接，`dispose()` 原来执行 `waiting.length = 0`
 *      —— 直接把这口干活的 Promise 丢了，**永远不 resolve**，第二条视频人间蒸发；
 *   ② 新实例的 `recent/running` 是空的，同一链接可能被再下一次。
 * 现在这些状态挂在全局符号上：跨实例共享、排队中的任务不会因为换实例而消失。
 */
const STATE_KEY = Symbol.for('qq-agent.video-downloader.downloadState');
function dlState() {
  let s = globalThis[STATE_KEY];
  if (!s) {
    s = {
      active: 0,                 // 正在跑的任务数
      waiting: [],               // 排队中的任务
      recent: new Map(),         // 会话::归一化链接 → 时间戳（10 分钟内不重复下）
      running: new Set(),        // 正在处理的 会话::归一化链接
      sentSigs: new Map()        // 会话::文件名::字节数 → 时间戳（同一个视频 10 分钟内不重复发）
    };
    globalThis[STATE_KEY] = s;
  }
  return s;
}

// ── 串行队列 ──────────────────────────────────────────────────────────────
// 下载吃带宽和磁盘，默认一次只做一个；同时进来的请求排队而不是并发打满。
function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const s = dlState();
    const run = () => {
      s.active += 1;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          s.active -= 1;
          const next = s.waiting.shift();
          if (next) next();
        });
    };
    const limit = Math.max(1, Math.min(4, Number(cfg().concurrency) || 1));
    if (s.active < limit) run();
    else s.waiting.push(run);
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
  // 登录态来源：auto = 先找现成文件，没有就从 Microsoft Edge 里读（见 resolveCookiesFile）
  cookiesSource: 'auto',
  edgeProfile: 'auto',
  edgeCookieHosts: '',
  edgeCookiesTtlMin: 360,
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
  // 允许成人向的会话名单（2026-10-26）：群:123 / 私聊:456 / 裸数字=不限类型
  pixivR18Chats: '',
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

/* ── 发过的作品：不再发第二遍（2026-10-20 用户要求）───────────────────────
 *
 * 记录的是**作品 pid**（不是图片 md5）：同一张图在不同关键词下会重复出现，
 * 按 pid 记最稳；换关键词再搜也能避开。文件放在产物目录下，跟其它状态放一起。
 * 只保留最近 90 天 / 最多 2000 条，避免无限增长。
 */
function sentPixivFile(c = cfg()) {
  return path.join(outRoot(c), 'sent-pixiv.json');
}

function readSentPixiv(c = cfg()) {
  try {
    const j = JSON.parse(fs.readFileSync(sentPixivFile(c), 'utf8'));
    return j && typeof j.pids === 'object' && j.pids ? j : { pids: {} };
  } catch {
    return { pids: {} };
  }
}

/** 取最近发过的 pid（给工具 `--exclude-pids` 用，最多 150 个，别把命令行撑爆） */
function sentPixivList(c = cfg(), limit = 150) {
  const j = readSentPixiv(c);
  return Object.entries(j.pids)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, limit)
    .map(([pid]) => pid);
}

/** 记下这次真的发出去的作品（pid 数组） */
function markSentPixiv(pids, c = cfg()) {
  const list = (Array.isArray(pids) ? pids : []).map((x) => String(x || '').trim()).filter((x) => /^\d+$/.test(x));
  if (!list.length) return;
  const j = readSentPixiv(c);
  const now = Date.now();
  for (const pid of list) j.pids[pid] = now;
  const cutoff = now - 90 * 24 * 3600 * 1000;
  for (const [pid, ts] of Object.entries(j.pids)) if (Number(ts) < cutoff) delete j.pids[pid];
  const keys = Object.keys(j.pids);
  if (keys.length > 2000) {
    keys.sort((a, b) => Number(j.pids[a]) - Number(j.pids[b])).slice(0, keys.length - 2000).forEach((k) => delete j.pids[k]);
  }
  try {
    fs.mkdirSync(path.dirname(sentPixivFile(c)), { recursive: true });
    fs.writeFileSync(sentPixivFile(c), JSON.stringify(j), 'utf8');
  } catch {
    /* 记不上不影响发送 */
  }
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

/**
 * URL 看起来像不像直播。
 *
 * ⚠️ 只能当**提示**用，不能拿来决定要不要传 `--live-seconds`：
 * `https://b23.tv/8FCCLtv` 这种短链这里判 false，但 302 之后就是 `live.bilibili.com/…`。
 * （踩过：靠它决定 → 直播时长上限没传 → 无限录制 → 插件超时杀掉任务。）
 * 现在它只用在「认不认这条链接」上（allowLive=false 时不去认领明显的直播链接）。
 */
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

/** 取一段输出的最后 n 行非空内容（拼成一行，用于错误信息） */
function tailLines(text, n = 3) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(-Math.max(1, n)).join(' ⏎ ').slice(0, 300);
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
  /**
   * ⚠️ `pixiv.net/users/<uid>` **不是作品链接**，是"这个画师的主页"（2026-10-20 用户报的 bug）。
   * 以前它被当成媒体链接塞给下载器，下载器只能把它解析成**同一个 pid**（甚至解析错），
   * 用户看到的就是"users 链接和 uid: 都导向同一个作品"。
   * 现在：不认领主页链接，让它走**按 uid 搜这个画师的作品**那条路（见 handleIncomingHook 的兜底）。
   */
  if (/^https?:\/\/(?:www\.)?pixiv\.net\/users\/\d+/i.test(String(url))) return false;
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
 * 找一份可用的登录 Cookie（Netscape 格式）。**只找磁盘上现成的文件**。
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
function findCookieFileOnDisk() {
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

// ── Edge 的 cookie（浏览器里登录过就够了，不用再单独导出文件）─────────────────
//
// 为什么做这个：登录态原来只能靠"桌面版内置浏览器登录后导出文件"，而大家平时是在
// **Edge 里**登录 B 站的 —— 浏览器里有 cookie，插件却等于没登录。现在直接把 Edge 的
// cookie 读出来转成 Netscape 文件（实现见 edge-cookies.mjs，含 DPAPI + AES-GCM 解密）。
//
// 两个必须处理的现实：
//   · Edge **正在运行**时 Cookies 文件被独占，读不出来（Windows 文件锁）—— 那就退回文件
//     那份，并且 15 分钟内不再重试（否则每次下载都去撞一次锁、刷一屏失败日志）；
//   · 我们自己的导出文件是有时效的：默认 6 小时刷新一次，避免拿到早就过期的登录态。
const EDGE_EXPORT_NAME = 'edge-cookies.txt';
let edgeCookieState = { at: 0, failedAt: 0, reason: '', loggedLocked: false };

/** 解析该用哪份 cookie 文件（可能触发一次 Edge 导出） */
async function resolveCookiesFile(c = cfg()) {
  const mode = String(c.cookiesSource || 'auto');
  if (mode === 'off') return '';
  const diskFile = findCookieFileOnDisk();
  if (mode === 'file') return diskFile;
  if (mode === 'auto' && diskFile) return diskFile;

  const edgeFile = await ensureEdgeCookies(c);
  if (mode === 'edge') return edgeFile || diskFile;   // 指定 Edge 但读不到 → 别把登录态直接丢掉
  return diskFile || edgeFile;
}

/** 按需从 Edge 导出 cookie；失败/锁定都在这里收口，绝不抛给下载主流程 */
async function ensureEdgeCookies(c = cfg()) {
  const target = path.join(DATA_DIR, 'video-downloader', EDGE_EXPORT_NAME);
  const ttlMs = Math.max(5, Number(c.edgeCookiesTtlMin) || 360) * 60 * 1000;
  const now = Date.now();
  try {
    const st = fs.statSync(target);
    if (st.size > 0 && now - st.mtimeMs < ttlMs) return target;
  } catch {
    /* 还没导出过 */
  }
  // 刚失败过（比如 Edge 正开着）→ 15 分钟内别再撞
  if (edgeCookieState.failedAt && now - edgeCookieState.failedAt < 15 * 60 * 1000) return '';

  try {
    const url = new URL('./edge-cookies.mjs', import.meta.url);
    url.searchParams.set('v', String(Date.now()));   // 同 ESM 缓存坑：不带查询串会一直用旧模块
    const mod = await import(url.href);
    const hosts = String(c.edgeCookieHosts || '').trim();
    const list = hosts
      ? hosts.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
      : mod.DEFAULT_HOSTS;
    const out = await mod.exportEdgeCookies({
      outFile: target,
      hosts: list,
      profile: String(c.edgeProfile || 'auto'),
      log: (...a) => vlog(...a)
    });
    if (out.ok) {
      edgeCookieState = { at: now, failedAt: 0, reason: '', loggedLocked: false };
      vlog(
        '登录态：已从 Edge（%s）导出 %d 条 cookie（v20 解不开 %d 条）→ 之后下载会带上它',
        out.profile || '默认配置',
        out.exported,
        out.skippedV20 || 0
      );
      return target;
    }
    edgeCookieState = { at: 0, failedAt: now, reason: out.error || '未知原因' };
    if (out.locked && !edgeCookieState.loggedLocked) {
      edgeCookieState.loggedLocked = true;
      vlog('登录态：Edge 正在运行，读不到它的 cookie（会独占这个文件）；想要登录态就先完全退出 Edge，我会自动再导一次');
    } else {
      vlog('登录态：从 Edge 取 cookie 没成功（%s）', edgeCookieState.reason);
    }
    return '';
  } catch (error) {
    edgeCookieState = { at: 0, failedAt: now, reason: String(error?.message ?? error) };
    vlog('登录态：读 Edge cookie 出错（%s）', edgeCookieState.reason);
    return '';
  }
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
 * 命令行入口：**优先跑数据目录里的那份副本**，而不是插件目录里的原件。
 *
 * 为什么非得这样（2026-10-17 真实现场，血泪）：
 * QQ Agent 的热重载用 `fs.watch(plugins/, { recursive: true })` 盯着整个插件目录。
 * 内置工具就住在 `plugins/video-downloader/tool/` 里，于是**只要工具读一下自己的
 * `src/*.js`，Windows 就会报一次"文件变化"**（NTFS 的最后访问时间被更新；纯读就能触发，
 * 实测复现）→ QQ Agent 全量重扫插件 → `dispose()` → 把我们正在跑的子进程杀掉。
 * 表现出来就是：`开始搜图了` 发出去了，然后**再也没有下文**（`搜图结束了` 和图片都不来），
 * 日志里连错误都没有 —— 因为子进程是被"自己人"杀的，Promise 根本不会 settle。
 *
 * 副本放在 `data/video-downloader/tool-src/`（不在监听的目录里），只有 `src/` + `package.json`
 * （工具没有任何第三方依赖，二进制由 `VIDEOGRAB_TOOLS_DIR` 指到数据目录）。
 * 复制失败就退回原件 —— 宁可偶尔被重启，也不能让功能直接不可用。
 */
function cliScript(toolRoot) {
  const bundledSrc = path.join(toolRoot, 'src');
  const bundledCli = path.join(bundledSrc, 'cli.js');
  if (!fs.existsSync(bundledCli)) return bundledCli;   // 让调用方照常报"找不到入口"
  // 只有"工具就住在被监听的插件目录里"才需要搬出去；用户自己填的外部工具目录不受影响
  const insidePlugin = path.resolve(toolRoot).startsWith(path.resolve(PLUGIN_DIR) + path.sep);
  if (!insidePlugin) return bundledCli;
  const mirror = path.join(DATA_DIR, 'video-downloader', 'tool-src');
  const stampFile = `${mirror}.stamp`;
  const mirrorCli = path.join(mirror, 'src', 'cli.js');
  try {
    /**
     * 新鲜度按**整棵 src 的指纹**判断，不是只看 cli.js。
     * （只看 cli.js 会漏：这次只改了 `core/downloader.js`，cli.js 没变 →
     *   副本被判"还是新的" → 跑的还是旧逻辑。踩一次就够了。）
     */
    const signature = dirSignature(bundledSrc);
    let stamp = '';
    try {
      stamp = fs.readFileSync(stampFile, 'utf8').trim();
    } catch {
      stamp = '';
    }
    if (signature !== stamp || !fs.existsSync(mirrorCli)) {
      fs.rmSync(mirror, { recursive: true, force: true });
      fs.mkdirSync(mirror, { recursive: true });
      fs.cpSync(bundledSrc, path.join(mirror, 'src'), { recursive: true });
      // cli.js 会 require('../package.json')，所以清单也得带上
      const pkg = path.join(toolRoot, 'package.json');
      if (fs.existsSync(pkg)) fs.copyFileSync(pkg, path.join(mirror, 'package.json'));
      fs.writeFileSync(stampFile, signature, 'utf8');
      vlog('已把工具的 src 复制到数据目录（避开热重载监听）：%s', mirror);
    }
    return mirrorCli;
  } catch (error) {
    vwarn('复制工具 src 到数据目录失败（退回原件，功能可用但可能被热重载打断）：%s', error?.message ?? error);
    return bundledCli;
  }
}

/** 目录指纹：文件数 + 总字节 + 最新 mtime（几十个文件，逐次 stat 也就毫秒级） */
function dirSignature(dir) {
  let count = 0;
  let total = 0;
  let newest = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const st = fs.statSync(full);
      count += 1;
      total += st.size;
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
  };
  walk(dir);
  return `${count}:${total}:${Math.round(newest)}`;
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
function runTool(url, c = cfg(), cookiesFile = '') {
  return new Promise((resolve) => {
    const toolRoot = toolRootOf(c);
    const cli = cliScript(toolRoot);
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
    // 登录态：优先用**事先解析好**的那份（可能来自 Edge，见 resolveCookiesFile），
    // 没传就退回磁盘上的现成文件。这样 B 站会员清晰度、需要登录的站点在群里照样能下。
    const cookies = cookiesFile || findCookieFileOnDisk();
    if (cookies) args.push('--cookies', cookies);
    // 显式代理：工具的 HTTP 层、yt-dlp、内置浏览器都会用它。
    // 不填的话工具自己会跟随 Windows 系统代理 —— 但"系统代理开没开"这件事很容易在
    // 换节点/切模式时被关掉，表现就是 pixiv 这类站点突然全失败且报的是"直连超时"。
    // 所以留一个明确开关：填了就一定走它。
    const proxy = String(c.proxy || '').trim();
    if (proxy) args.push('--proxy', proxy);
    /**
     * 直播录制参数。
     *
     * 踩过的坑（2026-10-17 真实现场）：原来是 `c.allowLive && looksLive(url)` 决定**两件事**
     * —— 要不要 `--live`、以及要不要 `--live-seconds`。群友发的是 `https://b23.tv/8FCCLtv`
     * 这种短链（没有 `/live/` 路径、host 也不是 `live.`），`looksLive()` 判 false，于是
     * **时长上限也没传**。工具自己 probe 后跟着 302 认出是直播，走进内置录制引擎 ——
     * 但上限 0 的含义是"录到手动结束"，于是一路录到插件自己的 `timeoutSec`（600 秒）被杀，
     * 留下 213MB 的 `.flv.part`，群里只等到一句"下载超时"。（`00:59` 那次 74MB 的 `.mp4.part` 同理。）
     *
     * 所以拆开：
     *   · `--live-seconds` **无条件传**（开了直播录制就传）。它的语义只是"如果是直播，最多录 N 秒"，
     *     对普通视频完全没有副作用，也不会多花任何探测开销 —— 实测短链只靠它就
     *     20 秒准时收尾并转封装成可播放的 mp4。
     *   · `--live` 仍按 URL 提示传：它会强制工具多做一次 `getStreamInfo`（yt-dlp dump-json），
     *     普通视频白等几秒、还会多打一次 B 站 API（更容易触发风控限流）。直播站点的
     *     `live.bilibili.com` / `live.douyin.com` 这类地址本身就能被工具识别，用不着它兜底。
     */
    let liveCapSeconds = 0;
    if (c.allowLive !== false) {
      const secs = Math.round(Number(c.liveSeconds) || 0);
      // 0 = 不限时长，那只有桌面版"手动结束录制"才说得通；群里必须给一个上限，
      // 否则唯一的下场就是等到超时被杀（所以这里兜底成 60 秒）。
      liveCapSeconds = secs > 0 ? secs : 60;
      args.push('--live-seconds', String(liveCapSeconds));
      if (looksLive(url)) args.push('--live');
    }
    args.push(...splitArgs(c.extraArgs));

    const { bin, env } = nodeRuntime();
    const startedAt = Date.now();
    // 直播要留出"录制上限 + 收尾（转封装/发文件）"的时间，否则配置里把 timeoutSec 调小
    // 之后又会变成"到点就被杀"。普通下载照旧用 timeoutSec。
    const baseTimeoutMs = Math.max(30, Number(c.timeoutSec) || 300) * 1000;
    const timeoutMs = liveCapSeconds
      ? Math.max(baseTimeoutMs, (liveCapSeconds + 180) * 1000)
      : baseTimeoutMs;
    vlog(
      '开始下载 %s（%s）%s',
      url,
      path.basename(target),
      liveCapSeconds ? `；直播最长录制 ${liveCapSeconds} 秒` : ''
    );

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
        // 带上工具最后几行输出：光一句"下载超时"什么也解释不了。
        // （2026-10-17 这次就是靠它才看清 —— 工具其实在"已开始录制直播…录到手动结束"。
        //   少了这几行，只能看到"超时"，看不出是被无限录制拖死的。）
        const tail = tailLines(`${stdout}\n${stderr}`, 3);
        finish({
          ok: false,
          error: `下载超时（超过 ${Math.round(timeoutMs / 1000)} 秒），已结束子进程${tail ? `；工具最后输出：${tail}` : ''}`
        });
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
/**
 * 这个错误是不是"发送超时"。
 *
 * 关键区别（2026-10-17 用户实测确认）：协议端发**大文件**时，core 的 90 秒 HTTP 超时先到，
 * 但腾讯侧的上传其实还在继续、最后**文件真的收到了**。所以超时 ≠ 失败：
 *   · 不能重试（再发一遍就是两份，133MB 传两次）；
 *   · 不能报"下载失败"（用户明明收到了，机器人却在道歉）。
 */
function isSendTimeout(error) {
  return /超时|timeout|timed out|aborted|AbortError/i.test(String(error?.message ?? error ?? ''));
}

/**
 * 大文件兜底：走协议端的专用上传接口（`upload_group_file` / `upload_private_file`），
 * 自己给足超时。
 *
 * 只在**明确失败**（路径读不到、格式被拒…）时用；发送超时**绝不能**走这里（会重复发送）。
 *
 * ⚠️ 代价：这条不走 SendQueue（没有限频/去重/留档）。仅用于"正常发送已明确失败"的兜底，
 * 而且会写一行日志，出问题查得到。
 */
async function uploadBigFile(onebot, chatKey, filePath, name, log = () => {}) {
  const [kind, id] = String(chatKey).split(':');
  const action = kind === 'group' ? 'upload_group_file' : 'upload_private_file';
  const params =
    kind === 'group'
      ? { group_id: Number(id), file: filePath, name, folder: '' }
      : { user_id: Number(id), file: filePath, name };
  log('改用协议端的大文件上传接口（%s，最长等 10 分钟）', action);
  return onebot.call(action, params, 10 * 60 * 1000);
}

/**
 * file:// URI → 真实磁盘路径（回退发送用）。
 *
 * ⚠️ 必须 `decodeURIComponent`（2026-10-17 真实现场）：原来只是把 `file:///` 前缀削掉，
 * 交出去的还是 `D:\qqagent\QQ%20Agent\...\%E3%80%90...mp4`，协议端 `realpath` 直接
 * ENOENT（retcode=100）—— 一场"文件明明在本地却报找不到"的乌龙。
 */
function plainPathFromUri(input) {
  const raw = String(input || '').trim();
  if (!/^file:\/\//i.test(raw)) return raw;
  let body = raw.replace(/^file:\/\/[^/]*/i, '');   // 去掉 file:// 以及可能的空主机段
  try {
    body = decodeURIComponent(body);
  } catch {
    /* 解不开就按原样试 */
  }
  // Windows 盘符：/D:/xxx → D:/xxx，再统一成反斜杠
  if (/^\/[A-Za-z]:/.test(body)) body = body.slice(1);
  return body.replace(/\//g, '\\');
}

/**
 * 发消息段：主路径走 file://（协议端自己读磁盘），失败回退成**真正解码后的**绝对路径
 * （个别实现对 URI 支持不全）。
 */
async function sendSegments(sender, chatKey, segments, options, log) {
  try {
    return await sender.sendMedia(chatKey, segments, options);
  } catch (error) {
    // 超时：协议端很可能**已经把文件传上去了**（用户 2026-10-17 实测确认），
    // 这时候重试就是发两遍。原样抛出去，由上层按"不确定"处理。
    if (isSendTimeout(error)) throw error;
    const plain = segments.map((s) => ({
      ...s,
      data: { ...s.data, file: plainPathFromUri(s.data?.file) }
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
 * QQ 单张图片的体积上限（保守取 3.5MB）。
 *
 * 为什么要有（2026-10-18 真实现场）：搜 pixiv 拿到一张 **4.5MB 的 PNG**，5 张图打进
 * 一条消息发出去 —— 协议端日志显示 5 张全部上传成功、`发送：[图片]×5`、还回了 message_id，
 * 但 QQ **没有把消息回推给自己**（对比同一天 3 张小图的一批是有回推的），群里就是空的。
 * 也就是说：**超限图片会让整条消息在服务端被丢掉，而且 API 照样返回成功**。
 * 所以发送前必须把单张压到线下 —— 比"等用户说没收到"可靠得多。
 */
const QQ_IMAGE_MAX_BYTES = 3.5 * 1024 * 1024;

/**
 * 给图片塞一段**不影响画面**的注释，让每次发送的 md5 都不一样。
 *
 * ── 为什么必须这么做（2026-10-19 真实现场，代价很大）──────────────────────
 * pixiv 原图的字节常常**已经在 QQ 的 CDN 上**（别人传过同一张图），协议端上传时会走
 * **fast-upload**（`[Highway] image fast-upload hit (server already had bytes)`）：
 * 不上传字节、直接复用服务端资源。结果 QQ **把整条消息静默丢掉** ——
 * `send_group_msg` 返回 `status:ok` + 一个 message_id，群里什么都没有，也**没有自身回显**。
 *
 * 实测对照（同一个群、同一张 1.9MB 原图）：
 *   · 原图（md5 6ECEA97E…，CDN 已有）           → 返回 ok，**群里不出现**、历史里也没有
 *   · 本地重编码（md5 A0AE9797…，CDN 没有）     → 返回 ok，**正常出现**
 *   · 再把重编码那张原样发一遍（现在 CDN 有了） → 返回 ok，**又不出现**
 * 结论：**只要命中 fast-upload，这条消息就会丢**。所以每次发送都必须给一个"新 md5"。
 *
 * ── 为什么不用重编码 ──────────────────────────────────────────────────
 * 重编码有损、还慢（1.9MB 也要几百毫秒）；而 JPEG 的 COM 段、PNG 的 tEXt 块、GIF 的
 * 注释扩展都是**规范允许且解码器直接忽略**的，塞一串 nonce 就能换 md5，像素一个不差。
 *
 * 失败（格式不认识 / 写不出临时文件）时返回空串，调用方按原文件发 —— 不阻断发送。
 */
function uniqueImageForUpload(file, log = () => {}) {
  try {
    const ext = path.extname(file).toLowerCase();
    const buf = fs.readFileSync(file);
    const nonce = `qq-upload ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    let out = null;
    if ((ext === '.jpg' || ext === '.jpeg') && buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      // JPEG：在 SOI 之后插一个 COM(0xFFFE) 段
      const payload = Buffer.from(nonce, 'ascii');
      const seg = Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), payload]);
      seg.writeUInt16BE(payload.length + 2, 2);
      out = Buffer.concat([buf.slice(0, 2), seg, buf.slice(2)]);
    } else if (ext === '.png' && buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      // PNG：在 IEND 之前插一个 tEXt 块（需要 CRC32）
      const body = Buffer.concat([Buffer.from('qq-upload\0', 'latin1'), Buffer.from(nonce, 'latin1')]);
      const type = Buffer.from('tEXt', 'latin1');
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length, 0);
      const crcBuf = Buffer.concat([type, body]);
      let crc = 0xffffffff;
      for (const byte of crcBuf) {
        crc ^= byte;
        for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
      }
      const crcOut = Buffer.alloc(4);
      crcOut.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
      const chunk = Buffer.concat([len, type, body, crcOut]);
      const iend = buf.lastIndexOf(Buffer.from('IEND', 'latin1'));
      if (iend < 4) return '';
      const iendStart = iend - 4;   // 长度字段起点
      out = Buffer.concat([buf.slice(0, iendStart), chunk, buf.slice(iendStart)]);
    } else if (ext === '.gif' && buf.length > 6 && buf.slice(0, 3).toString('latin1') === 'GIF') {
      // GIF：在 trailer(0x3B) 之前插一个注释扩展块
      const trailer = buf[buf.length - 1] === 0x3b ? buf.length - 1 : buf.length;
      const payload = Buffer.from(nonce, 'latin1');
      const block = Buffer.concat([Buffer.from([0x21, 0xfe]), Buffer.from([payload.length]), payload, Buffer.from([0x00])]);
      out = Buffer.concat([buf.slice(0, trailer), block, buf.slice(trailer)]);
    }
    if (!out || out.length <= buf.length) return '';
    const tmp = path.join(
      c_tmpDir(),
      `qquniq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext}`
    );
    fs.writeFileSync(tmp, out);
    return tmp;
  } catch (error) {
    log('给图片换新指纹失败（按原文件发）：%s', error?.message ?? error);
    return '';
  }
}

/** 临时目录（沿用其它临时文件的落地位置，失败退回系统 temp）。 */
function c_tmpDir() {
  const dir = path.join(DATA_DIR, 'video-downloader', 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 把过大的图片压到 QQ 能收的体积（必要时缩边长），返回新路径；失败返回空串。 */
function shrinkImageForQQ(file, c = cfg(), log = () => {}) {
  return new Promise((resolve) => {
    const attempts = [
      { maxSide: 2048, q: 3 },
      { maxSide: 1600, q: 5 },
      { maxSide: 1280, q: 7 }
    ];
    const bin = ffmpegBin(c);
    const runOne = (i) => {
      if (i >= attempts.length) return resolve('');
      const a = attempts[i];
      const out = `${file.replace(/\.[^./\\]+$/, '')}.qq${i + 1}.jpg`;
      const child = spawn(
        bin,
        ['-y', '-loglevel', 'error', '-i', file, '-frames:v', '1',
          '-vf', `scale='min(${a.maxSide},iw)':-2`, '-q:v', String(a.q), out],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
      );
      let err = '';
      child.stderr?.on('data', (d) => {
        if (err.length < 1200) err += d.toString('utf8');
      });
      child.once('error', () => resolve(''));
      child.once('close', (code) => {
        let size = 0;
        try {
          size = code === 0 ? fs.statSync(out).size : 0;
        } catch {
          size = 0;
        }
        if (!size) {
          log('压缩图片失败（%s）：%s', path.basename(file), err.trim().slice(0, 100) || `退出码 ${code}`);
          return runOne(i + 1);
        }
        if (size <= QQ_IMAGE_MAX_BYTES) {
          log('图片 %s 压到 %s（长边上限 %d，q=%d）', path.basename(file), humanSize(size), a.maxSide, a.q);
          return resolve(out);
        }
        try {
          fs.unlinkSync(out);
        } catch {
          /* ignore */
        }
        return runOne(i + 1);
      });
    };
    runOne(0);
  });
}

/**
 * 把要直接发到群里的图片过一遍格式归一化。
 * convertImages 设置：risky（默认，只转不安全格式）/ all（全转 jpg）/ off（不动）
 * 另外：**任何超过 QQ_IMAGE_MAX_BYTES 的图都会被压小**（不压就会让整条消息被服务端丢掉）。
 */
async function ensureSendableImages(files, c = cfg(), log = () => {}) {
  const mode = String(c.convertImages || 'risky');
  if (mode === 'off') return files;
  const out = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    const safe = SAFE_IMAGE_EXT.has(ext);
    // 体积超限：先压（GIF 只取首帧会丢动效，所以 GIF 交给下面的原样分支）
    if (ext !== '.gif') {
      let size = 0;
      try {
        size = fs.statSync(f).size;
      } catch {
        size = 0;
      }
      if (size > QQ_IMAGE_MAX_BYTES) {
        const shrunk = await shrinkImageForQQ(f, c, log);
        if (shrunk) {
          out.push(uniqueImageForUpload(shrunk, log) || shrunk);
          continue;
        }
        log('图片 %s（%s）压不下来，仍然尝试原样发送', path.basename(f), humanSize(size));
      }
    }
    if (safe && mode !== 'all') {
      // 关键：即使格式安全、体积也小，也要**换一个新指纹** —— 否则命中 CDN 的
      // fast-upload 时 QQ 会静默丢消息（见 uniqueImageForUpload 的注释与实测）
      out.push(uniqueImageForUpload(f, log) || f);
      continue;
    }
    if (ext === '.gif') {
      out.push(uniqueImageForUpload(f, log) || f); // 动图转成 jpg 就只剩一帧了，按原样试
      continue;
    }
    const converted = await convertToJpg(f, log, c);
    out.push(uniqueImageForUpload(converted || f, log) || converted || f);
  }
  return out;
}

/**
 * QQ 能当"视频"直接播的容器。其它（.flv / .ts / .mkv / .avi）发出去只会让人看到
 * "视频加载失败"，或者干脆发不出去。
 *
 * 踩过的坑（2026-10-17 真实现场）：抖音直播录下来的是 `.flv`（转封装还因为 HEVC 失败了），
 * 插件照着把 `.flv` 当 video 段发出去 → 群里显示"下载视频出错"。
 */
const SENDABLE_VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov']);

/** 转封装成 mp4（无损，`-c copy`；转不了返回空串） */
function remuxToMp4(file, log = () => {}, c = cfg()) {
  return new Promise((resolve) => {
    const out = `${file.replace(/\.[^./\\]+$/, '')}.mp4`;
    try {
      if (fs.existsSync(out) && fs.statSync(out).size > 0) return resolve(out);
    } catch {
      /* ignore */
    }
    const bin = ffmpegBin(c);
    const child = spawn(
      bin,
      ['-y', '-loglevel', 'error', '-i', file, '-c', 'copy', '-copyts', '-start_at_zero',
        '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', out],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let err = '';
    child.stderr?.on('data', (d) => {
      if (err.length < 4000) err += d.toString('utf8');
    });
    child.once('error', () => resolve(''));
    child.once('close', (code) => {
      if (code === 0) return resolve(out);
      log('转封装成 mp4 失败（%s）：%s', path.basename(file), err.trim().split('\n').slice(-1)[0] || `退出码 ${code}`);
      try {
        if (fs.existsSync(out) && fs.statSync(out).size === 0) fs.unlinkSync(out);
      } catch {
        /* ignore */
      }
      resolve('');
    });
  });
}

/** 用 ffmpeg 读一下时长（秒）。读不到返回 0 —— 只用来决定"值不值得压缩"，失败了不阻塞流程。 */
function probeDurationSec(file, c = cfg()) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpegBin(c), ['-hide_banner', '-i', file], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      resolve(0);
      return;
    }
    let err = '';
    child.stderr?.on('data', (d) => {
      if (err.length < 8000) err += d.toString('utf8');
    });
    child.once('error', () => resolve(0));
    child.once('close', () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
      resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0);
    });
  });
}

/**
 * 视频太大（超过「超过多少 MB 就改发群文件」那道线）时，先试着**压到线以下**。
 *
 * 为什么不再傻乎乎直接传原文件（2026-10-17 真实现场）：133.5MB 的视频发群文件，
 * 协议端读盘 + 上传腾讯走不完 core 里 90 秒的发送超时（`SEND_TIMEOUT_MS`），
 * 客户端只看到"发送超时"，重试裸路径又因为路径没解码直接 ENOENT —— 最后群里是
 * "这个视频没下下来"，其实文件好好躺在本地。
 *
 * ⚠️ 压缩**只对短片有意义**：37 分钟的 1080p（平均才 420kb/s，本来就很省）重编码
 * 要十几分钟 CPU，而且 CRF 26 出来可能更大。所以先读时长，超过 `maxDurationSec`
 * 直接放弃（交给"大文件上传"那条路）。
 *
 * 逐档降：crf 26 → 30 → 34（长边 1280 → 960），压到线以下就发成**正常视频消息**。
 */
function shrinkVideoToFit(file, maxBytes, c = cfg(), log = () => {}, { maxDurationSec = 600 } = {}) {
  return new Promise(async (resolve) => {
    const durationSec = await probeDurationSec(file, c);
    if (durationSec > maxDurationSec) {
      log('视频时长 %d 分 %d 秒，重编码太久且未必更小，不压了（直接按群文件发）', Math.floor(durationSec / 60), Math.round(durationSec % 60));
      resolve('');
      return;
    }
    const bin = ffmpegBin(c);
    const attempts = [
      { crf: 26, maxSide: 1280 },
      { crf: 30, maxSide: 1280 },
      { crf: 34, maxSide: 960 }
    ];
    const runOne = (i) => {
      if (i >= attempts.length) return resolve('');
      const a = attempts[i];
      const out = `${file.replace(/\.[^./\\]+$/, '')}（压缩${i + 1}）.mp4`;
      const child = spawn(
        bin,
        ['-y', '-loglevel', 'error', '-i', file,
          '-vf', `scale='min(${a.maxSide},iw)':-2`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(a.crf),
          '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
      );
      let err = '';
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        log('压缩尝试 %d 超时（%d 分），换大文件上传', i + 1, Math.round(maxDurationSec / 60 / 3));
      }, Math.max(120000, Math.round((durationSec / 3) * 1000)));
      child.stderr?.on('data', (d) => {
        if (err.length < 2000) err += d.toString('utf8');
      });
      child.once('error', () => {
        clearTimeout(timer);
        resolve('');
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        let size = 0;
        try {
          size = code === 0 ? fs.statSync(out).size : 0;
        } catch {
          size = 0;
        }
        if (!size) {
          log('压缩尝试 %d 失败（%s）', i + 1, err.trim().split('\n').slice(-1)[0] || `退出码 ${code}`);
          return runOne(i + 1);
        }
        if (size <= maxBytes) {
          log('视频压到 %s（crf %d，长边 %d），可以按正常视频发了', humanSize(size), a.crf, a.maxSide);
          return resolve(out);
        }
        log('压缩尝试 %d 后仍有 %s（线是 %s），再降一档', i + 1, humanSize(size), humanSize(maxBytes));
        try {
          fs.unlinkSync(out);
        } catch {
          /* ignore */
        }
        return runOne(i + 1);
      });
    };
    runOne(0);
  });
}

/**
 * 发送前保证视频是 QQ 认的容器：不是 mp4/mov 就先无损转封装。
 * 转不了就返回原文件，由调用方改按「群文件」发（至少能下下来播，不会显示"视频出错"）。
 */
async function ensureSendableVideo(file, c = cfg(), log = () => {}) {
  const ext = path.extname(file).toLowerCase();
  if (SENDABLE_VIDEO_EXT.has(ext)) return { path: file, converted: false };
  const converted = await remuxToMp4(file, log, c);
  if (converted) {
    log('已把 %s 转封装成 mp4（无损）', path.basename(file));
    return { path: converted, converted: true };
  }
  log('%s 不是 QQ 能直接播的格式，且转封装失败 → 改按群文件发送', path.basename(file));
  return { path: file, converted: false };
}

/**
 * 发送下载结果；返回一句话描述（用于日志/返回值）。
 *
 * `quiet = true`：**只发媒体，不发任何文字**（搜图那条链路用得上 —— 只发图/只下载的
 * 模式下群里不该冒出"前 9 张发在上面了…"这类话）。注意它只压制说明文字，
 * 不改变发什么媒体；返回的字符串照旧带着情况，交给日志与工具返回值。
 */
async function deliver({ sender, chatKey, artifacts, url, title = '', c = cfg(), log = () => {}, quiet = false, onebot = null }) {
  const maxSendMb = Math.max(1, Number(c.videoAsFileMb) || 100);
  const maxBytes = maxSendMb * 1024 * 1024;

  // ── 视频 + 配图可以同时存在 ────────────────────────────────────────────────
  // 抖音「图文帖里混着视频」的产物就是一个视频 + 若干配图（工具会把它们放在同一目录，
  // 并把目录交给这里）。原来视频分支直接 `return`，配图永远发不出去；现在两段都发。
  const parts = [];
  let sentMedia = false;

  if (artifacts.video) {
    // QQ 只认 mp4/mov 这类容器：.flv/.ts/.mkv 先无损转封装，转不了就按群文件发
    const sendable = await ensureSendableVideo(artifacts.video, c, log);
    let videoPath = sendable.path;
    const asVideoSegment = SENDABLE_VIDEO_EXT.has(path.extname(videoPath).toLowerCase());
    let size = 0;
    try {
      size = fs.statSync(videoPath).size;
    } catch {
      size = 0;
    }
    // 超过「改发群文件」那道线时，先压一档试试（133MB 直接传会撞 core 的 90 秒发送超时）
    if (asVideoSegment && size > maxBytes) {
      log('视频 %s（%s）超过 %dMB，先试着压到线以下', path.basename(videoPath), humanSize(size), maxSendMb);
      const shrunk = await shrinkVideoToFit(videoPath, maxBytes, c, log);
      if (shrunk) {
        videoPath = shrunk;
        try {
          size = fs.statSync(shrunk).size;
        } catch {
          /* 保持原值 */
        }
      }
    }
    const name = path.basename(videoPath);
    /**
     * 最后一道保险：**同一个视频在本会话刚发过就别再发一遍**。
     *
     * 去重键归一化能挡住"同一条链接两种写法"，但挡不住"短链 vs 完整 URL"这种
     * 归一化后也不同源的情况（比如 `b23.tv/xxx` 和 `www.bilibili.com/video/BVxxx`）。
     * 这里按「会话 + 文件名 + 字节数」记 10 分钟：同一个视频即使走不同链接进来，
     * 第二次也不会再发（2026-10-17 用户报"有概率发两次"，这是兜底）。
     */
    const videoSig = `video::${chatKey}::${name}::${size}`;
    const sentSigs = dlState().sentSigs || (dlState().sentSigs = new Map());
    const nowSig = Date.now();
    for (const [k, ts] of sentSigs) if (nowSig - ts > RECENT_TTL_MS) sentSigs.delete(k);
    if (sentSigs.has(videoSig)) {
      log('这个视频刚在本会话发过（%s，%s），跳过重复发送', name, humanSize(size));
      parts.push(`（同一个视频刚发过，已跳过：${name}）`);
      sentMedia = true;
    } else if (!asVideoSegment || (size && size > maxBytes)) {
      log('视频 %s（%s）%s，改发群文件', name, humanSize(size), asVideoSegment ? `超过 ${maxSendMb}MB` : '格式不便直接播放');
      try {
        await sendSegments(
          sender,
          chatKey,
          [{ type: 'file', data: { file: fileUri(videoPath), name } }],
          { label: `[文件]${name}`, dedupeKey: videoPath },
          log
        );
        parts.push(`已发送文件 ${name}（${humanSize(size)}）`);
        sentSigs.set(videoSig, Date.now());
      } catch (error) {
        // 大文件：core 的 90 秒发送超时几乎必然先到，但**文件通常已经传上去了**
        // （用户 2026-10-17 实测确认）。所以超时不当失败、也不重试，只是如实记一笔。
        if (isSendTimeout(error)) {
          log('文件发送超时（%s）：协议端可能还在传，实测这种情况下文件一般能收到；为免发两遍，不重试', error?.message ?? error);
          parts.push(`文件 ${name}（${humanSize(size)}）发送超时，可能仍在传输`);
        } else if (onebot) {
          log('常规方式发文件失败（%s），换成大文件上传接口再试', error?.message ?? error);
          await uploadBigFile(onebot, chatKey, videoPath, name, log);
          parts.push(`已上传文件 ${name}（${humanSize(size)}）`);
        } else {
          throw error;
        }
      }
    } else {
      try {
        await sendSegments(
          sender,
          chatKey,
          [{ type: 'video', data: { file: fileUri(videoPath) } }],
          { label: `[视频]${name}`, dedupeKey: videoPath },
          log
        );
        parts.push(`已发送视频 ${name}${size ? `（${humanSize(size)}）` : ''}`);
        sentSigs.set(videoSig, Date.now());
      } catch (error) {
        // 视频段同样可能撞 90 秒发送超时；超时按"可能已发出"处理，绝不重试
        if (isSendTimeout(error)) {
          log('视频消息发送超时（%s）：可能已发出，为免发两遍不重试', error?.message ?? error);
          parts.push(`视频 ${name}${size ? `（${humanSize(size)}）` : ''}发送超时，可能仍在传输`);
          sentSigs.set(videoSig, Date.now());   // 超时也记一笔：它大概率已经发出去了
        } else if (onebot) {
          log('视频消息发送失败（%s），改走大文件上传接口', error?.message ?? error);
          await uploadBigFile(onebot, chatKey, videoPath, name, log);
          parts.push(`已上传文件 ${name}（${humanSize(size)}）`);
          sentSigs.set(videoSig, Date.now());
        } else {
          throw error;
        }
      }
    }
    sentMedia = true;
  }

  if (artifacts.images.length) {
    const maxImages = Math.max(0, Number(c.maxImages) || 0);
    const overflowMode = String(c.imageOverflow || 'rest');
    const head = maxImages > 0 ? artifacts.images.slice(0, maxImages) : [];
    const rest = maxImages > 0 ? artifacts.images.slice(maxImages) : artifacts.images;

    let sentHead = 0;
    if (head.length) {
      // avif 这类 QQ 不认的格式先转成 jpg 再发（压缩包里仍保留原图）；
      // 超过 QQ 单图体积上限的也会在这一步被压小
      const sendable = await ensureSendableImages(head, c, log);
      /**
       * **一张一条消息**，不要 5 张塞一条。
       *
       * 2026-10-18 真实现场：5 张图（其中一张 4.5MB PNG）打成一条 `send_group_msg`，
       * 协议端 5 张全部上传成功、API 也回了 message_id，但 QQ 没有把这条消息回推给自己
       * （同一天 3 张小图的一批是**有**回推的）→ 群里一片空白，插件却记成"已发送 5 张"。
       * 单张发送的代价只是多几个气泡，好处是：一张被拒不会连累另外四张，
       * 而且失败时能定位到具体是哪一张。
       */
      for (const [i, f] of sendable.entries()) {
        try {
          await sendSegments(
            sender,
            chatKey,
            [{ type: 'image', data: { file: fileUri(f) } }],
            { label: `[图片]${path.basename(f)}`, dedupeKey: f },
            log
          );
          sentHead += 1;
          sentMedia = true;
        } catch (error) {
          // 单张失败不再整批放弃：记下来，继续发剩下的
          log('第 %d/%d 张图没发出去（%s）：%s', i + 1, sendable.length, path.basename(f), error?.message ?? error);
        }
        if (i < sendable.length - 1) await new Promise((r) => setTimeout(r, 400));
      }
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
          parts.push(`已发送 ${sentHead} 张图片；其余打包过大未发送（${humanSize(size)}）`);
          sentMedia = true;
        } else {
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
          parts.push(`已发送 ${sentHead} 张图片 + 压缩包 ${name}（${zipSource}，${humanSize(size)}）`);
          sentMedia = true;
        }
      } catch (error) {
        log('打包失败：%s', error?.message ?? error);
        if (!quiet) {
          await sender.sendTextBatch(chatKey, [
            `图一共 ${artifacts.images.length} 张，前 ${sentHead} 张发在上面了；其余打包失败，存在本机：${artifacts.dir || zipPath}`
          ]);
        }
        parts.push(`已发送 ${sentHead} 张图片；其余打包失败（${error?.message ?? error}）`);
        sentMedia = true;
      }
    } else if (!sentHead && !sentMedia) {
      // maxImages=0 且不允许打包 → 明说，避免"下完了却什么都没发"
      throw new Error(`图片有 ${artifacts.images.length} 张，但设置里既不发图也不打包（图文帖最多发几张 = 0，且打包方式 = 关闭）`);
    } else if (sentHead) {
      parts.push(`已发送 ${sentHead} 张图片`);
    }
  }

  if (parts.length) return parts.join('；');

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

/**
 * 把一条链接归一化成**去重键**：同一个视频的不同写法必须落到同一个 key 上。
 *
 * 为什么（2026-10-17 真实现场，一天两次）：群友转发 B 站视频时，消息里往往同时有
 * 两种写法 —— 带一堆分享参数的完整链接和干净短链：
 *
 *   18:54:06  https://b23.tv/EkiPKno?share_medium=android&share_source=qq&bbid=…&ts=…
 *   18:54:19  https://b23.tv/EkiPKno          ← 同一个视频发了第二遍
 *
 * `extractCandidateUrls` 只去掉句末标点和尾部斜杠，查询串原样保留，于是"同一条视频"
 * 变成两个不同的 URL、两个不同的去重键 → 各下各发。现在按下面的规则归一：
 *   · 短链域名（b23.tv / v.douyin.com …）**整段查询串都丢掉**（它们只是分享参数）；
 *   · 其它站点只保留可能影响内容的参数（p/list/index/v/page/…），把
 *     share_medium / share_source / bbid / ts / spm_id_from / vd_source 这类跟踪参数去掉；
 *   · 顺手统一：协议、www. 前缀、末尾斜杠、大小写（主机名）。
 */
const SHORT_LINK_HOSTS = new Set([
  'b23.tv',
  'v.douyin.com',
  'v.iesdouyin.com',
  'v.kuaishou.com',
  'xhslink.com',
  't.cn',
  'url.cn'
]);
/** 这些查询参数会改变"下到的是哪一条内容"，必须保留 */
const KEEP_QUERY_KEYS = new Set(['p', 'list', 'index', 'page', 'v', 'vid', 'aid', 'bvid', 'mid', 'id', 't']);

function canonicalUrlKey(raw) {
  const text = String(raw || '').trim();
  let u;
  try {
    u = new URL(text);
  } catch {
    return text.toLowerCase();
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '');
  let search = '';
  if (!SHORT_LINK_HOSTS.has(host)) {
    const keep = [...u.searchParams.entries()]
      .filter(([k]) => KEEP_QUERY_KEYS.has(String(k).toLowerCase()))
      .sort(([a], [b]) => a.localeCompare(b));
    search = keep.length ? `?${keep.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
  }
  return `${host}${path}${search}`;
}

/** 失败时给群里的一句人话（尽量短） */
function friendlyOf(error) {
  const text = String(error || '');
  // 风控/验证码（抖音最常见）：别再说"没下下来"，直接告诉用户该怎么办
  if (/验证码|人机验证|安全验证|风控|访问异常|captcha/i.test(text)) {
    return '抖音弹人机验证了：在这台机器的桌面版工具里用内置浏览器打开一次抖音、把验证过掉（需要登录的顺手登录），之后我再试就成了';
  }
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

  // 重复 / 并发保护：**同一条链接在同一个会话里** 10 分钟内只处理一次
  // （状态跨实例共享，见 dlState）。
  //
  // ⚠️ 去重键必须带会话，不能只用 url（2026-10-17 用户报"不同群的同一条链接只下了一个"）：
  // 两个群各自贴同一条链接，是两个互不相干的"观众各要一份"，按 url 去重就会把后一个群
  // 当成"刚处理过"直接跳过 —— 那个群什么都收不到。所以要 `会话::链接`。
  //
  // ⚠️ 而且"链接"要**归一化**（2026-10-17 一天两次"同一个视频发了两遍"）：
  // 同一条消息里常常同时有 `https://b23.tv/EkiPKno?share_medium=…&ts=…` 和干净的
  // `https://b23.tv/EkiPKno` 两种写法，URL 不同 → 两个去重键 → 各下一次、各发一遍。
  const dedupeKey = `${chatKey}::${canonicalUrlKey(url)}`;
  const st = dlState();
  const now = Date.now();
  for (const [key, ts] of st.recent) if (now - ts > RECENT_TTL_MS) st.recent.delete(key);
  if (st.recent.has(dedupeKey) || st.running.has(dedupeKey)) {
    vlog('这条链接在本会话刚处理过或正在处理，跳过：%s（归一化键 %s）', url, dedupeKey.slice(chatKey.length + 2));
    return { skip: true };
  }
  st.running.add(dedupeKey);

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

    // 登录态在这一步解析（可能要读 Edge 的 cookie），**放到队列外**做：
    // 排队时干等一会儿无所谓，但绝不能因为读 cookie 把下载槽位占住。
    const cookiesFile = await resolveCookiesFile(c);
    const result = await withSlot(() => runTool(url, c, cookiesFile));
    let delivered = '';
    if (result.ok) {
      // 成人向作品默认**不发到群里**（link 这条路上也可能贴到 R18 作品）。
      // 工具会在反代取图时顺带反查分级，放进 JSON 的 pixivRating 里。
      // 只能发到「全局开关打开」或「这个会话在名单里」的地方（2026-10-26）。
      if (result.pixivRating > 0 && !chatAllowsR18(c, { kind, chatId, chatKey })) {
        warn('作品是成人向，按设置没有发出来：%s', url);
        return {
          ok: false,
          error: '成人向作品（插件设置里「允许成人向」未打开，且本会话不在成人向名单里）',
          friendly: '这个是成人向作品，按当前设置就不发出来了'
        };
      }
      // recursive：抖音「图文帖里混着视频」的产物是「一个视频 + 一个配图子目录」，
      // 不往里走一层就会把配图整个漏掉（2026-10-17）。
      const artifacts = collectArtifacts(result.filePath, c, { recursive: true });
      delivered = await deliver({ sender, chatKey, artifacts, url, title: result.title, c, log, onebot: args.onebot });
      dlState().recent.set(dedupeKey, Date.now());
      const pruned = pruneOld(c);
      if (pruned) log('顺手清理了 %d 个过期产物', pruned);
      log('转发完成：%s → %s（%s）', url, delivered, result.engine || '?');
      return { ok: true, platform, title: result.title || delivered };
    }

    warn('下载失败：%s → %s', url, result.error);
    dlState().recent.set(dedupeKey, Date.now());   // 失败也记一笔，免得同一条坏链接被反复重试
    return {
      ok: false,
      error: result.error,
      friendly: c.notifyFailure ? friendlyOf(result.error) : ''
    };
  } catch (error) {
    warn('处理链接异常：%s → %s', url, error?.message ?? error);
    dlState().recent.set(dedupeKey, Date.now());
    return {
      ok: false,
      error: String(error?.message ?? error),
      friendly: c.notifyFailure ? friendlyOf(error?.message) : ''
    };
  } finally {
    dlState().running.delete(dedupeKey);
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
async function runPixivSearchToolCli(keyword, count, c = cfg(), opts = {}) {
  // 反代取图本身不需要登录态，但带上它能让部分受限作品可用（和链接下载用同一份来源）
  const cookiesFile = await resolveCookiesFile(c);
  return new Promise((resolve) => {
    const toolRoot = toolRootOf(c);
    const cli = cliScript(toolRoot);
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
    // 成人向：全局开关 or 当前会话在名单里（2026-10-26）
    if (opts.r18 === true || c.pixivAllowR18 === true) args.push('--r18');
    // 排除 AI 生成的作品（2026-10-25；参照 pixiv-illust 插件的同名设置）
    if (c.pixivExcludeAI === true) args.push('--exclude-ai');
    /**
     * 节点自救（2026-10-19，插件设置里**默认关**）。
     * 打开后：原生搜索被代理重置时，工具会通过 Clash 的控制接口把代理组切到一个
     * 「对 pixiv 探测通过」的节点，然后重试一次。副作用是会改用户的全局代理选择
     * （这份订阅最后一条规则是 `MATCH,✈️Final`），所以只在你明确开启时生效。
     */
    if (c.pixivNodeFailover === true) args.push('--pixiv-node-failover');
    /**
     * 发过的作品不要再出现（2026-10-20 用户要求）。
     * 把最近发过的 pid 传给工具，让它搜的时候就跳过 —— 不是"发之前过滤"，
     * 而是**根本不下载**，省流量也省时间。
     */
    if (c.skipSentPixiv !== false) {
      const exclude = sentPixivList(c);
      if (exclude.length) args.push('--exclude-pids', exclude.join(','));
    }
    const proxy = String(c.proxy || '').trim();
    if (proxy) args.push('--proxy', proxy);
    const cookies = cookiesFile || findCookieFileOnDisk();
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
      /**
       * 失败原因提取（2026-10-18 修）：
       *   · 只取**有信息量**的行 —— 工具开头那几行 `ⓘ 检测到系统代理 …` / `ⓘ 搜索 Pixiv：…`
       *     是横幅，不是错误；之前把它们当成 error 回给上层，结果 `searchFailureText()`
       *     看见"代理"两个字就判成"连不上 Pixiv（要挂代理）"，用户明明开着代理。
       *   · 优先 stderr（工具的错误都写那里），再退到 stdout 里**不含 ⓘ 横幅**的尾部；
       *   · 顺带把原始尾部写进日志，下次排查不用再猜。
       */
      const cleanTail = (s, n) =>
        String(s || '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !/^ⓘ/.test(l))     // 横幅行不算错误
          .slice(-n);
      const errLines = cleanTail(stderr, 2);
      const outLines = cleanTail(stdout, 3);
      const detail = (errLines.length ? errLines : outLines).join(' | ').slice(0, 220);
      // 诊断信息要够查问题：命令、工作目录、退出码/信号、两路输出各多少字节
      vlog(
        '搜图工具失败：code=%s signal=%s out=%dB err=%dB cwd=%s',
        String(code),
        String(child.signalCode),
        Buffer.byteLength(stdout || ''),
        Buffer.byteLength(stderr || ''),
        toolRoot
      );
      vlog('搜图工具失败：stderr=%s', errLines.join(' | ').slice(0, 160) || '(空)');
      vlog('搜图工具失败：stdout 尾部=%s', outLines.join(' | ').slice(0, 200) || '(空)');
      finish({
        ok: false,
        error: detail || `搜图工具退出码 ${code}，且没有产出任何文件`,
        dir: target
      });
    });
  });
}

/**
 * 搜图失败时给群里的一句人话。
 *
 * 为什么必须有（2026-10-18 用户报「pixiv 搜图失败没有在群内反馈」）：
 * 「我要 xxx 的图」是**确定性指令**，钩子会 veto 掉这条消息、模型根本不会被叫醒 ——
 * 于是搜图失败时没有任何人说话：日志里有一行，群里一片安静，用户以为机器人没理他。
 * 所以失败必须在**插件自己这边**回一句（原因要具体，别只说"失败了"）。
 */
function searchFailureText(error) {
  const text = String(error || '').trim();
  /**
   * ⚠️ 这里必须**按"是哪一条路失败、为什么失败"分开说**，不能一句"要挂代理"糊过去。
   *
   * 2026-10-18 真实误诊：用户搜「雷其儿」，工具返回的是
   *   `内置接口（tag）没有结果；内置接口（keyword）没有结果；Pixiv 原生搜索也没有结果`
   * —— 代理是通的、原生搜索**成功执行**了，只是 Pixiv 上确实没有这个标签。
   * 旧规则 `if (/没有结果/ && /原生搜索/)` 把它当成"原生搜索连不上"，群里回了
   * "先挂上代理再让我试" —— 完全瞎指挥（人家代理开着呢）。
   */
  if (/原生搜索也没有结果/.test(text)) {
    return 'Pixiv 上也没搜到这个标签（换个写法更好使：日文原名 / 作者名 / 更常见的标签）';
  }
  /**
   * 熔断（2026-10-19）：原生搜索连续失败 2 次后工具会自己停 5 分钟，这期间**不再尝试**、
   * 也不再让群里干等 30 秒。这时候要明确说"我停了一会儿"，别让群友以为是新的一次失败。
   */
  if (/原生搜索临时跳过/.test(text)) {
    return 'Pixiv 那边刚刚连续断过，我先把手上的原生搜索停了 5 分钟——过几分钟再让我试，或者换个写法（日文原名 / 作者名）';
  }
  if (/原生搜索失败/.test(text)) {
    if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|连接被拒绝|连接超时|超时|timeout|网络|ECONNRESET/i.test(text)) {
      /**
       * 分清"**没配代理**"和"**配了但不通**"（2026-10-19 现场：群里被告知"检查下代理"，
       * 可真正的毛病是关键词用了简体写法，工具现在会把 `当前代理：无` 写进错误里）。
       */
      if (/当前代理：无/.test(text)) {
        return '公开接口也没这个标签；Pixiv 原生搜索得先配个代理才能用（现在没配代理），换个写法或挂上代理再让我试';
      }
      /**
       * 代理在、但这一下被掐断（ECONNRESET / 超时）——2026-10-19 实测过一次 15 分钟的"节点抽风"
       * （12:40 起连续失败、12:56 自己恢复，同一台代理 8/8 全过）。工具里已经自动重试 3 次
       * （每次 9 秒），所以这里直接说清"重试过也没成、多半是节点的事"，别让用户去怀疑关键词。
       */
      if (/ECONNRESET|连接被重置|EPIPE|socket hang up/i.test(text)) {
        return 'Pixiv 原生搜索被代理**重置**了（连了 3 次都断，多半是节点不稳或被限流）——等一两分钟再试，或者在 Clash 里换个节点';
      }
      return '公开接口没搜到；Pixiv 原生搜索走网络也失败了（代理可能没生效或不稳），检查下代理再让我试';
    }
    if (/403|401|forbidden|风控|access denied/i.test(text)) {
      return '公开接口没搜到，Pixiv 原生搜索被风控拒了（过一会儿再试，或先登录一次 Pixiv）';
    }
    return `公开接口没搜到，Pixiv 原生搜索也失败了：${String(text).slice(-90)}`;
  }
  if (/超时|timeout/i.test(text)) return '搜图超时了（Pixiv 那边太慢），等下再让我试试';
  /**
   * ⚠️ 只认"**连接类**"证据，不能因为文本里出现"代理"两个字就怪代理。
   * 2026-10-18 误诊：工具的错误串里带着横幅 `ⓘ 检测到系统代理 http://127.0.0.1:7897`，
   * 老规则的 `/代理|proxy/` 直接命中 → 群里回"连不上 Pixiv（要挂代理）"，
   * 可用户的代理明明开着、请求也确实走了代理。
   */
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|连接被拒绝|连接超时|网络错误|网络请求失败|不可达/i.test(text)) {
    return '连不上 Pixiv（网络/代理不通），检查一下代理是不是还开着';
  }
  if (/403|401|forbidden|风控|access denied/i.test(text)) return 'Pixiv 拒了这次访问（风控），过一会儿再试';
  /**
   * 搜到了、但取图这步失败：反代（pixiv.re）抽风返回 500/404。
   * 2026-10-18 现场：`奶蛙` 命中 1 个作品，第 1 页取不到（HTTP 500）→ 0 张图。
   * 这类是**瞬时**的，工具侧已经会自动重试一次；还失败就如实说"搜到了但图没取到"。
   */
  if (/图片反代|反代上没取到|HTTP 5\d\d|HTTP 404/i.test(text)) {
    return '搜到了，但 pixiv 反代这会儿取不到图（它自己 500/404 了），过一会儿再让我试';
  }
  if (/R18|成人|全年龄/i.test(text)) return '这个词只搜到成人向作品，当前设置不允许';
  if (/没有搜到|没搜到|no results|0 个|未找到|not found/i.test(text)) {
    return '没搜到这个词的作品（换个写法：日文原名 / 作者名 / 更常见的标签）';
  }
  if (/找不到下载工具|下载工具无法启动|命令行入口/i.test(text)) return '下载工具没装好（找不到命令行入口），找管理员看一下';
  // 兜底：把工具输出的符号/hanner 去掉再展示；如果剩下的只是"检测到系统代理…"这种横幅，
  // 说明我们根本没拿到真正原因 —— 别把横幅当原因贴进群里。
  const cleaned = text.replace(/^[ⓘ✔✖·\s]+/g, '').trim();
  if (!cleaned || /检测到系统代理|搜索 Pixiv：/.test(cleaned)) {
    return '搜图没成功（工具没给出具体原因），再让我试一次？';
  }
  return `搜图失败了：${cleaned.slice(0, 80)}`;
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
 *   send            = **图 + 两句固定话**：收到指令先发「开始搜图了」；图下好后、
 *                     发图**之前**再发一句「图片正在发送」（2026-10-19 用户要求：
 *                     这句是"图马上来"的预告，所以必须排在图片前面；图片后面不再收尾）。
 */

/**
 * 图发完之后那句「这次走的是哪条搜索路」的说明（2026-10-19 用户要求）。
 *
 * 后端标签来自核心（`pixiv.js`）：
 *   `pixiv-native`                 → Pixiv 官方搜索
 *   `lolicon/tag` / `lolicon/keyword`（可能带「繁体「X」」后缀）→ 第三方聚合接口
 *   `缓存（N 分钟前搜过）`         → 上次的结果直接复用
 * 认不出来就照原样报出来 —— 宁可丑一点，也别让群友猜。
 */
function backendNoteText(backend, keyword) {
  const b = String(backend || '').trim();
  const kw = String(keyword || '').trim().slice(0, 30);
  // 没结果 / 认不出来时不啰嗦（`none` 是核心表示"哪个后端都没给出结果"）
  if (!b || /^none$/i.test(b)) return '';
  const tail = kw ? `（关键词：${kw}）` : '';
  if (/pixiv-native/i.test(b)) {
    return `ⓘ 这次走的是 Pixiv 官方搜索（第三方聚合接口没有这个标签）${tail}`;
  }
  if (/^缓存/.test(b)) {
    return `ⓘ 这次直接用了上次的结果 —— ${b}${tail}`;
  }
  if (/lolicon/i.test(b)) {
    const mode = /keyword/i.test(b) ? '关键词' : '标签';
    const trad = /繁体「(.+?)」/.exec(b);
    const extra = trad ? `，用的繁体写法「${trad[1]}」` : '';
    return `ⓘ 这次走的是第三方聚合接口（lolicon，按${mode}搜）${extra}${tail}`;
  }
  return `ⓘ 这次的结果来源：${b}${tail}`;
}

/**
 * 「哪些群聊 / 私聊允许成人向」（2026-10-26 用户要求）。
 *
 * 名单写法（逗号、空格、换行、分号都能当分隔符）：
 *   `群:1027015568` / `group:1027015568` → 只对这个群开
 *   `私聊:123456789` / `private:123456789` / `好友:123456789` → 只对这个人的私聊开
 *   `123456789`（裸数字）→ 群聊或私聊都算（省事；要精确就用上面两种）
 * 总开关 `pixivAllowR18` 打开时对**所有**会话生效（名单就不用填了）。
 */
function parseR18ChatToken(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  const scoped = /^(群聊?|group|groupchat|私聊|好友|private|user|qq)\s*[:：]\s*(\d+)$/i.exec(t);
  if (scoped) {
    const isPrivate = /^(私聊|好友|private|user|qq)$/i.test(scoped[1]);
    return { scope: isPrivate ? 'private' : 'group', id: scoped[2] };
  }
  if (/^\d+$/.test(t)) return { scope: 'any', id: t };
  return null;
}

/** 当前会话是否允许成人向（全局开关 or 名单命中） */
function chatAllowsR18(c = cfg(), { kind = '', chatId = '', chatKey = '' } = {}) {
  if (c.pixivAllowR18 === true) return true;
  const tokens = String(c.pixivR18Chats || '')
    .split(/[\s,，;；、]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!tokens.length) return false;
  const key = String(chatKey || (kind && chatId !== undefined ? `${kind}:${chatId}` : '')).toLowerCase();
  const id = String(chatId !== undefined && chatId !== null && chatId !== '' ? chatId : key.split(':').pop() || '').trim();
  if (!id) return false;
  const chatKind = /^(group|群)/.test(key) || /group/.test(String(kind)) ? 'group' : 'private';
  return tokens.some((token) => {
    const parsed = parseR18ChatToken(token);
    if (!parsed || parsed.id !== id) return false;
    return parsed.scope === 'any' || parsed.scope === chatKind;
  });
}

function searchPlan(mode) {
  const m = String(mode ?? 'download').toLowerCase();
  if (m === 'send') {
    return { mode: 'send', chat: true, quiet: true, silentModel: false, startText: '开始搜图了', hintText: '图片正在发送' };
  }
  if (m === 'images') {
    return { mode: 'images', chat: true, quiet: true, silentModel: false, startText: '', hintText: '' };
  }
  return { mode: 'download', chat: false, quiet: true, silentModel: true, startText: '', hintText: '' };
}

/**
 * 搜图并下载（CLI + 产物收集）。**只负责"下下来"**，发不发由调用方按 searchSendMode 决定。
 *
 * 抽出来是因为现在有两条入口：① 模型调用 `pixiv_search` 工具；② 「我要 xxx 的图」这类
 * 确定性指令（`message.image-request`，0 token）。两条路必须下同样的东西，
 * 否则"指令下的图"和"工具下的图"迟早会长成两套行为。
 */
async function searchOnce({ keyword, count, c, log = () => {}, r18 = false }) {
  const res = await withSlot(() => runPixivSearchToolCli(keyword, count, c, { r18 }));
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
  /**
   * 这次是哪个后端搜出来的（工具在每条结果里带 `backend`）：
   *   `lolicon/tag|keyword` = 免代理的公开检索接口；
   *   `pixiv-native`        = 公开接口没搜到，**自动改用 Pixiv 原生搜索**（2026-10-18 用户要求）。
   * 带上去让群里知道"为什么这次能搜到"，不然用户只会以为接口时好时坏。
   */
  const backend = String(okWorks.find((w) => w && w.backend)?.backend || '');
  const backendNote = backend === 'pixiv-native' ? '（公开接口没搜到，已自动改用 Pixiv 原生搜索）' : '';

  if (!imageCount && !artifacts.video) {
    return { ok: false, error: `产物目录里没有可用的图片（${res.dir}）`, dir: res.dir, okWorks, failed, list, failNote, backend, backendNote };
  }
  return { ok: true, dir: res.dir, artifacts, okWorks, failed, imageCount, bytes, list, failNote, backend, backendNote };
}

/**
 * 一次完整的搜图请求：下载 → 按计划发或不发 → 返回一句人话。
 * 返回 `{ ok, message, result }`；`result` 里有张数/体积/清单，供调用方拼自己的答复。
 *
 * `send` 模式下的两句固定话（「开始搜图了」/「图片正在发送」）也在这里发：
 * 开始那句在**下载之前**发（收到指令就吱一声），结束那句在**图片发完之后**发。
 * 发提示语失败只记日志，绝不影响搜图本身。
 */
async function performSearchRequest({ keyword, count, c, plan, sender, chatKey, log = () => {}, source = '工具', forceFailureNotice = false }) {
  /**
   * 发一句固定话（`send` 模式用）。
   *
   * **由插件自己直接发**：走核心的 `sender.sendTextBatch`（限频 / 去重 / 留档都在里面），
   * **不经过模型** —— 固定句式那条路上模型压根不会被叫醒（钩子 veto）；
   * 模型即使从别的路径调了搜图工具，这两句也不是它写的，返回值里会明确要求它别复述。
   */
  const say = async (text, { force = false } = {}) => {
    if (!text || !sender || !chatKey) return false;
    // download 模式（群里一个字都不发）默认不发；但**失败提示**可以 force 绕过
    if (!plan.chat && !force) return false;
    try {
      await sender.sendTextBatch(chatKey, [text]);
      log('[%s] 已直接发出固定话「%s」（不经模型）', source, text);
      return true;
    } catch (error) {
      log('[%s] 发「%s」失败（不影响搜图）：%s', source, text, error?.message ?? error);
      return false;
    }
  };

  /**
   * 失败反馈：**下载/只发图模式下也要说话**（force）。
   * 用户明确下了指令，失败却一声不吭 = 最差的体验（2026-10-18 用户报的问题）。
   * 尊重 `notifyFailure`（设置里能关掉失败提示）。
   */
  const sayFailure = async (reason) => {
    const text = searchFailureText(reason);
    log('[%s] 搜图失败，向群里反馈：%s（原始原因：%s）', source, text, String(reason || '').slice(0, 160));
    if (c.notifyFailure === false) {
      log('[%s] 失败提示被 notifyFailure 关掉了，不发', source);
      return;
    }
    await say(text, { force: true });
  };

  /**
   * 固定话带上关键词（2026-10-19 用户要求）。
   *
   * 为什么：核心发送管道有 **8 秒文本去重**（同一会话里完全相同的文字只发一次）。
   * 连续两次搜图如果都只说「开始搜图了」「图片正在发送」，第二句就会被静默吃掉，
   * 群里看着像"没反应"。带上关键词（以及张数）之后每条都不同，去重不会误伤，
   * 顺带也让群里知道这次在搜什么。
   */
  const kwLabel = String(keyword || '').trim().slice(0, 30);
  const withKw = (text, extra = '') => {
    const base = String(text || '');
    if (!base) return '';
    return kwLabel ? `${base}：${kwLabel}${extra}` : base;
  };

  const startLine = withKw(plan.startText);
  if (startLine) await say(startLine);   // send 模式：收到指令先吱一声

  // 成人向：全局开关 or「这个群/这个人」在名单里（2026-10-26）
  const allowR18 = chatAllowsR18(c, { chatKey });
  if (allowR18 && c.pixivAllowR18 !== true) log('[%s] 本会话在成人向名单里，这次允许 R18', source);
  const r = await searchOnce({ keyword, count, c, log, r18: allowR18 });
  if (!r.ok) {
    // 失败就不发"图片正在发送"（那句只在图下好、真要发图之前发），但**必须回一句失败原因**
    await sayFailure(r.error);
    return { ok: false, message: `搜图失败：${searchFailureText(r.error)}`, result: r };
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

  /**
   * 「图片正在发送」——**发图之前**说（2026-10-19 用户要求）。
   * 这句的作用是预告"图马上来"，所以必须排在图片前面；图片发完之后不再补话。
   * 只在确实有图要发的时候说（避免"零张图 + 一句正在发送"）。
   * 带上关键词和张数：既避开 8 秒文本去重，也让群里知道这次即将收到几张。
   */
  const imageCount = Array.isArray(r.artifacts?.images) ? r.artifacts.images.length : 0;
  const hintLine = plan.hintText && imageCount > 0
    ? withKw(plan.hintText, imageCount > 1 ? `（${imageCount} 张）` : '')
    : '';
  if (hintLine) await say(hintLine);

  let delivered;
  try {
    delivered = await deliver({
      sender,
      chatKey,
      artifacts: r.artifacts,
      url: `pixiv-search:${keyword}`,
      title: `${keyword} 的图`,
      c,
      log,
      quiet: plan.quiet
    });
  } catch (error) {
    // 图下下来了但发不出去（常见：格式被拒、体积超限、协议端超时）——也要回一句
    await sayFailure(error?.message ?? error);
    log('[%s] 搜图产物发送失败：%s', source, error?.message ?? error);
    return { ok: false, message: `图下来了但没发出去：${searchFailureText(error?.message)}`, result: r };
  }
  // 图发完之后**不再补话**（2026-10-19 用户要求：那句「图片正在发送」已经挪到发图之前）
  const backendLabel = String(r.backend || r.source || '未知');
  if (String(backendLabel).includes('pixiv-native')) {
    // 换后端这件事要留痕：日志 + 群里那两句（send 模式）已经说过，这里只加日志
    log('[%s] 本次结果来自 Pixiv 原生搜索（公开接口没搜到）：%s', source, keyword);
  }
  /**
   * 图发完之后补一句**来源说明**（2026-10-19 用户要求）：
   * 让人一眼看出这次是"Pixiv 原生搜索"还是"第三方聚合接口（lolicon）/缓存"。
   * 只在会说话的两种模式（send / images）发；`download` 模式本来就不发任何消息。
   * 文案带上关键词：避开发送管道的 8 秒文本去重。
   */
  if (plan.chat && c.searchBackendNote !== false) {
    const note = backendNoteText(backendLabel, keyword);
    if (note) {
      try {
        await say(note);
      } catch (error) {
        log('[%s] 来源说明没发出去（不影响图片）：%s', source, error?.message ?? error);
      }
    }
  }
  /**
   * 成功日志里带上**来源**（2026-10-19 加）。
   * 原因：用户问"原生搜索真的在运作吗"时，日志里只有"搜图完成"、看不出走的是哪条路，
   * 只能靠翻 SnowLuma 的请求记录反推。现在一行就能看到 `来源=pixiv-native/lolicon/缓存`。
   */
  log('[%s] 搜图完成：%s → %s（来源=%s）', source, keyword, delivered, backendLabel);
  /**
   * 记下这次**真的发出去**的作品 pid（2026-10-20）：
   * 下次搜同一个标签时工具会带着 `--exclude-pids`，这些作品就不会再出现。
   */
  if (c.skipSentPixiv !== false) {
    const pids = (r.okWorks || []).map((w) => w && w.pid).filter(Boolean);
    markSentPixiv(pids, c);
    if (pids.length) log('[%s] 已记下 %d 个已发作品（下次搜图跳过）', source, pids.length);
  }
  return { ok: true, result: r, message: `已把「${keyword}」的图发到本会话：${delivered}${r.backendNote || ''}` };
}

/** 搜图工具的 execute：搜图 → 下载 → 按 searchSendMode 决定"发不发、发什么" */
async function runPixivSearchTool(ctx, args) {
  const c = cfg();
  if (c.enabled === false) return { content: '这个功能被管理员关掉了。', isError: true };
  if (c.searchEnabled === false) return { content: '搜图功能被管理员关掉了（只保留链接自动转发）。', isError: true };

  const keyword = String(args?.keyword ?? '').trim();
  if (!keyword) return { content: '错误：keyword 不能为空（比如「初音ミク」）。', isError: true };
  // 2026-10-20：数量不再卡 5 个（用户要求没有硬上限），只留 500 的天窗
  const count = Math.max(1, Math.min(500, Number(args?.count) || Number(c.searchCount) || 2));
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
      source: '工具',
      // 工具这条路模型还在场：失败提示由模型转述更自然，但它必须知道**确切原因**
      forceFailureNotice: false
    });
  } catch (error) {
    log('搜图发送失败：%s', error?.message ?? error);
    return { content: `图下下来了但没发出去：${error?.message ?? error}`, isError: true };
  }
  if (!out.ok) {
    // 明确要求模型**把原因说出去**：工具返回 isError 时模型经常会一言不发，
    // 群里就什么反馈都没有（2026-10-18 用户报的问题）。
    return {
      content: `${out.message}\n请**直接用一句话把上面这个失败原因告诉对方**（别自己编图片、别说"已发送"）。`,
      isError: true
    };
  }

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
    ? '「开始搜图了」「图片正在发送」这两句**插件已经自己直接发出去了**（不经模型），你不要再重复、也不用复述图片内容。'
    : '不要再复述图片内容，也不用汇报"已发送"。';
  return { content: `${body}\n${tail}` };
}

/**
 * 「我要 xxx 的图」这类**确定性搜图指令**的识别模块。
 *
 * 用**动态** import 是有意的：这个模块由 deploy.cmd 一起复制进插件目录，万一漏了，
 * 静态 import 会让整个插件（连 media.download 链接转发）加载失败 —— 代价太大。
 * 这里失败只是"确定性指令不生效"，消息照旧走模型。
 *
 * ⚠️ **一定要带 cache-bust 的查询串**（2026-10-17 真实现场）：
 * 插件热重载会用 `?t=…` 重新 import `index.js`，但它内部 `import('./search-command.mjs')`
 * 的 URL 没有查询串，于是 ESM 注册表**一直返回进程最早加载的那份**——
 * 改了 `search-command.mjs`（比如加「再来点…的图」这类真实说法）热重载十次也不会生效，
 * 只有重启 QQ Agent 才会。表现就是："明明代码里 supports，线上就是不认领"，
 * 而且日志里只有一句干干净净的「句式不匹配」，根本看不出跑的是旧模块。
 * 加上 `?v=` 之后，每次热重载都拿到磁盘上最新的那份。
 */
let matcher = null;
let matcherTried = false;
async function loadSearchMatcher() {
  if (!matcherTried) {
    matcherTried = true;
    try {
      const url = new URL('./search-command.mjs', import.meta.url);
      url.searchParams.set('v', String(Date.now()));
      matcher = await import(url.href);
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
/**
 * "当前该用哪份实现"放在全局符号上，而不是让每个链环闭包捕获自己那一份。
 *
 * 为什么：热重载时旧实例的链环可能还留在 prototype 上（dispose 顺序、重复加载都会留下），
 * 新实例 install 时若"复用旧记录"，调用就会走**旧闭包** —— 旧代码、旧日志路由。
 * 实测踩过：功能明明生效了（图下下来了、没叫模型），日志里却一行都看不到，
 * 因为跑的是 20:56 那份没有 logger 的旧实现。链环统一读这个全局指针就永远不会串味。
 */
const IMPL_KEY = Symbol.for('qq-agent.video-downloader.orch.onIncoming.impl');
/**
 * 自愈探针标记。
 *
 * 为什么需要它：`onIncoming` 是**多个插件共用的链表**，每个插件都在自己 dispose 时
 * "把壳摘掉"。热重载时新旧实例的 install / dispose 会交错（同一秒里能连挂两次），
 * 旧实例 dispose 读到的是**新实例刚写下的记录**，于是把新实例的壳当成自己的摘掉，
 * 链上就一层壳都不剩 —— 功能彻底静默：没日志、没图、没反应，连"未认领"都没得看。
 * 探针就是用来事后确认"链上还调不调得到我"，调不到就重挂一层（见 ensureHook）。
 */
const PROBE_KEY = Symbol.for('qq-agent.video-downloader.orch.onIncoming.probe');
let hookedProto = null;
let watchdog = null;

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
/**
 * 把 `log('格式 %s', 值)` 变成成品字符串再交给核心 logger。
 *
 * 为什么必须自己格式化（2026-10-18 现场）：核心的 `logger.info(id, ...args)` **不做**
 * printf 替换，它只是把参数拼在消息后面 —— 于是日志里全是
 * `[指令] %s（已向群里反馈失败原因） 搜图失败：…` 这种带 `%s` 的原始形态，
 * 排查时极难读（用户直接把这种行贴过来了）。本插件所有日志都是 `util.format` 风格，
 * 所以在这里统一 format 一次；`api.log`（插件 API）本来就吃 printf，保持原样传。
 */
const fmtArgs = (...args) => {
  try {
    return args.length > 1 ? util.format(...args) : String(args[0] ?? '');
  } catch {
    return args.map((a) => String(a)).join(' ');
  }
};
function vlog(...args) {
  const text = fmtArgs(...args);
  try { API.log?.(text); } catch { /* ignore */ }
  try { coreLogger?.info?.(PLUGIN_ID, text); } catch { /* ignore */ }
}
function vwarn(...args) {
  const text = fmtArgs(...args);
  try { API.warn?.(text); } catch { /* ignore */ }
  try { coreLogger?.warn?.(PLUGIN_ID, text); } catch { /* ignore */ }
}

/**
 * 探针：链上还调得到本插件吗？
 *
 * 调用时 `this` 传 `{ paused: true }` —— 万一这条探针一路落到了核心原方法，
 * 原方法第一行 `if (this.paused || this.aborted) return;` 就退出了，
 * 既不会排会话、也不会叫醒模型，更不会碰别的插件的判定。绝对安全。
 */
function chainReachesUs() {
  const proto = hookedProto;
  if (!proto || typeof proto.onIncoming !== 'function') return false;
  globalThis[PROBE_KEY] = 0;
  try {
    proto.onIncoming.call({ paused: true, aborted: false }, '__hook_probe__', {
      __probe: PROBE_KEY,
      id: -1,
      text: '',
      self: false,
      atMe: false,
      atNames: []
    });
  } catch {
    /* 链上有别人的壳抛错也无所谓 —— 结论只看标记 */
  }
  return globalThis[PROBE_KEY] === 1;
}

/**
 * 保证链上有一层能到我们的壳；调不到就**重新挂一层**。
 *
 * 幂等：能到就什么都不做（每次都重挂会越叠越厚，一条消息被处理好几遍）。
 *
 * @param {'install' | 'heal'} reason install = 首次挂载，heal = 发现链断了在自救
 *   （分开只为日志别吓人：进程刚起来时链上本来就没有我们的壳，那不是"断了"）
 */
function ensureHook(reason = 'install') {
  const proto = hookedProto;
  if (!proto || disposed) return false;
  // 认领"当前该用哪份实现"：链上任何一层壳都会读这个指针
  globalThis[IMPL_KEY] = handleIncomingHook;
  if (chainReachesUs()) return true;

  const downstream = proto.onIncoming;
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
    return downstream.apply(this, arguments);
  };
  proto.onIncoming = wrapped;
  const ok = chainReachesUs();
  if (reason === 'heal') {
    vlog(
      '[钩子自愈] 链上调不到本插件（热重载互相摘壳），已重挂分发器：%s',
      ok ? '生效' : '仍未生效，需要重启 QQ Agent'
    );
  } else if (!ok) {
    vwarn('分发器挂上了但探测仍到不了本插件 —— 确定性搜图指令可能不生效');
  }
  return ok;
}

async function installOrchestratorHook() {
  if (hookedProto) return ensureHook('heal');
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
  hookedProto = proto;
  const ok = ensureHook('install');
  startHookWatchdog();
  if (ok) vlog('已挂载 onIncoming 钩子（「我要 xxx 的图」这类句式直接搜图，0 token，不用重启）');
  return ok;
}

/**
 * 看门狗：热重载的交错发生在我们看不见的时机，装完就撒手等于把可用性交给运气。
 * 每 30 秒探一次，探不到就重挂；探到了什么都不做（一次函数调用，零成本）。
 */
function startHookWatchdog() {
  if (watchdog) return;
  watchdog = setInterval(() => {
    try {
      if (disposed) return;
      if (chainReachesUs()) return;
      vwarn('[钩子自愈] 探测到链上又调不到本插件，重挂中');
      ensureHook('heal');
    } catch {
      /* 看门狗自己不能把进程搞崩 */
    }
  }, 30_000);
  watchdog.unref?.();
}

function uninstallOrchestratorHook() {
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
  // ⚠️ **只放弃身份、绝不摘壳**。壳留着是无害的（没有实现就把消息原样交回下游），
  // 而"摘壳"正是踩过的坑：热重载时新旧实例交错，旧实例 dispose 读到的是新实例刚写的
  // 记录，把新实例的壳当成自己的摘掉/还原，链上于是只剩原方法 —— 表现就是
  // 「指令发出去，没日志、没图、没反应」，查都没处查。
  if (globalThis[IMPL_KEY] === handleIncomingHook) delete globalThis[IMPL_KEY];
  hookedProto = null;
}

/**
 * 钩子主体：命中句式 → **先标已读** → 后台搜图 → 返回 'veto'。
 *
 * 顺序很讲究：**标已读失败就什么都不做**（把消息交回模型）。标不上却 veto 的话，
 * 这条消息会一直挂着未读，兜底定时器迟早还是把模型叫起来 —— 那就白省 token，
 * 而且我们还会多下一次图（第一次踩的坑正是"静默没标上"：白烧 6.7 万 prompt token）。
 */
function handleIncomingHook(orch, chatKey, entry) {
  // 自愈探针：只回答"我在"，不读配置、不碰消息（见 chainReachesUs）
  if (entry && entry.__probe === PROBE_KEY) {
    globalThis[PROBE_KEY] = 1;
    return 'veto';
  }
  // 本实例已被热重载卸载：壳可以留着，但必须什么都不做，把消息交回下游
  if (disposed) return '';
  const c = cfg();
  const text = String(entry?.text || '').trim();
  /**
   * 「明明像点图、却什么都没发生」必须能查清是哪一步把它放过的。
   * 只对含「图」的消息打日志 —— 其余消息太多，打出来会把日志刷爆。
   */
  const trace = (why) => {
    if (/图/.test(text)) {
      vlog(
        '[指令] 未认领（%s）：text=%s atMe=%s atNames=%s matcher=%s',
        why,
        text.slice(0, 40),
        String(entry?.atMe),
        JSON.stringify(Array.isArray(entry?.atNames) ? entry.atNames : []),
        matcher ? 'ok' : 'null'
      );
    }
    return '';
  };

  if (c.enabled === false || c.searchEnabled === false || c.searchCommand === false) return trace('开关关闭');
  if (!entry || entry.self === true) return trace('自己发的');
  if (!text) return '';
  if (!matcher) return trace('识别模块未加载');

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
  /**
   * 兜底（2026-10-20）：**整条消息就是一个画师主页链接 / `uid:123`** 时，也当成搜图指令。
   * 这样「https://www.pixiv.net/users/27977322」和「uid:27977322」会走**同一条路**
   * （都按 uid 列这个画师的作品），不会一个被当作品下载、一个被当搜索。
   */
  if (!hit) {
    const bare = text.replace(/^@\S+\s*/, '').trim();
    if (/^https?:\/\/(?:www\.)?pixiv\.net\/users\/\d+\/?$/i.test(bare)) {
      hit = { keyword: bare, count: Number(c.searchCount) || 2 };
    } else if (/^uid[:：]\s*\d+$/i.test(bare)) {
      hit = { keyword: bare, count: Number(c.searchCount) || 2 };
    }
  }
  if (!hit) return trace(atOthers ? '@ 了别人' : '句式不匹配');

  // ① 先标已读（标不上就当没认领，避免"未读挂着 → 兜底定时器又叫模型"）
  let marked = false;
  try {
    marked = orch?.store?.markEntryRead(String(chatKey), entry.id) === true;
  } catch (error) {
    vwarn('标已读出错，这条交给模型：%s', error?.message ?? error);
  }
  if (!marked) {
    vwarn('搜图指令没能标成已读（entry.id=%s），这条交给模型处理：%s', entry?.id, text.slice(0, 30));
    return '';
  }

  // ② 后台搜图（钩子必须立刻返回：它是每条消息的必经点，不能等下载）
  // 2026-10-20：这里原来卡 5 个，和「没有硬上限」冲突；现在跟工具侧一致（天窗 500）
  const count = Math.max(1, Math.min(500, hit.count || Number(c.searchCount) || 2));
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
        source: '指令',
        // 钩子把这条消息 veto 掉了，模型**不会出场** —— 搜图失败时必须由插件自己回一句，
        // 否则群里一片安静（2026-10-18 用户报"pixiv 搜图失败没有在群内反馈"）
        forceFailureNotice: true
      });
      if (out.ok) log('[指令] %s\n%s', out.message, out.result?.list || '');
      else log('[指令] %s（已向群里反馈失败原因）', out.message);
    } catch (error) {
      log('[指令] 搜图指令执行失败：%s', error?.message ?? error);
      try {
        const sender = orch?.sender;
        if (c.notifyFailure !== false && sender && chatKey) {
          await sender.sendTextBatch(String(chatKey), [searchFailureText(error?.message ?? error)]);
          log('[指令] 已补发失败提示');
        }
      } catch {
        /* 发不出去就算了，日志里有 */
      }
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

  // 2026-10-20：这里也是旧的「最多 5 个」卡点（handleImageRequest 这条入口），一起放开
  const count = Math.max(1, Math.min(500, hit.count || Number(c.searchCount) || 2));
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
      const out = await performSearchRequest({
        keyword: hit.keyword,
        count,
        c,
        plan,
        sender,
        chatKey,
        log,
        source,
        // 指令这条路上**模型不会出场**（消息被 veto 了）→ 失败必须由插件自己回一句，
        // 否则就是"发了指令，群里一点反应都没有"（2026-10-18 用户报的问题）
        forceFailureNotice: true
      });
      if (out.ok) log('[%s] %s\n%s', source, out.message, out.result?.list || '');
      else log('[%s] %s（已向群里反馈失败原因）', source, out.message);
    } catch (error) {
      log('[%s] 搜图指令执行失败：%s', source, error?.message ?? error);
      // 连 performSearchRequest 都抛了（理论上不该发生）——也要兜一句，别让群里静默
      try {
        if (c.notifyFailure !== false && sender && chatKey) {
          await sender.sendTextBatch(chatKey, [searchFailureText(error?.message ?? error)]);
          log('[%s] 已补发失败提示', source);
        }
      } catch {
        /* 发不出去就算了，日志里有 */
      }
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
        '设置成「图 + 两句固定话」时，「开始搜图了」（收到指令）与「图片正在发送」（图下好、发图之前）由**插件自己直接发**（不经模型），' +
        '你既不用等它、也不要重复它。\n' +
        '默认只出全年龄作品（成人向需要管理员在插件设置里显式打开）。',
      category: 'media',
      icon: '🖼️',      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '关键词或角色名，如「初音ミク」「猫娘」「风景」' },
          count: { type: 'number', description: '下载几个作品，默认 2，**没有硬上限**（最多 500）；对方要"多来几张"时可以直接调大' }
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

  // 顺手把 Edge 的登录态导一次（非阻塞，失败只写一行日志）：
  // QQ Agent 启动时 Edge 往往是关着的，这时就能把新鲜 cookie 抓到；
  // 开着会失败（文件被独占），下载时再试 —— 别让用户为了这个专门去关浏览器等一会儿。
  if (String(cfg().cookiesSource || 'auto') !== 'off') {
    void ensureEdgeCookies(cfg()).catch(() => {});
  }
}

/**
 * 卸载 / 热重载时调用。
 *
 * ⚠️ **不立刻杀子进程**（2026-10-17 真实现场）：热重载是"重扫整个插件目录"触发的，
 * 而它随时可能发生 —— 包括**我们自己的下载/搜图正在跑的时候**（工具住在 plugins/ 里，
 * 读一下自己的 `src/*.js` 就能把 NTFS 的"最后访问时间"更新掉，QQ Agent 就当成"文件变了"）。
 * 以前这里直接 `killTree`，于是那次搜图在 `开始搜图了` 之后**彻底没有下文**：
 * 子进程被自己人杀掉，`close` 事件带来的 Promise 永远不 settle，连错误日志都没有。
 *
 * 现在：让在跑的任务**跑完**（几十秒到几分钟，工具自己有超时），
 * 只给一个 10 分钟的兜底，避免真挂住的进程变成幽灵。
 * 已经跑完的子进程照旧立刻收掉，不留残留。
 */
export function dispose() {
  disposed = true;
  uninstallOrchestratorHook();   // 摘掉"当前实现"这个身份（壳留着，见其注释）
  for (const child of children) {
    if (child.exitCode !== null || child.killed) {
      children.delete(child);
      continue;
    }
    const cap = setTimeout(() => {
      try {
        killTree(child);
      } catch { /* ignore */ }
      children.delete(child);
    }, 10 * 60 * 1000);
    cap.unref?.();
    vlog('热重载：让还在跑的子进程（pid %s）跑完再退，10 分钟后仍不退则强制收掉', child.pid);
  }
  /**
   * ⚠️ **绝对不要清空排队中的任务**（`waiting.length = 0` 曾经害死过一条视频）。
   *
   * 2026-10-17 现场：两条链接同时进来，第一条在下载、第二条排队；这期间热重载把本实例
   * dispose 了（工具的 Electron 运行时就住在 plugins/ 里，它读写文件就会触发全量重扫，
   * 一秒能重载好几次）。旧代码把 `waiting` 清空 → 第二条那个 Promise **永不 resolve**
   * → 群里只有一条视频，另一条人间蒸发，而且核心那边一直挂着、10 分钟内重发同一条还会被
   * 判成"正在处理"直接跳过。
   * 现在队列在全局（见 `dlState`），换实例也不影响：让它继续跑完就好。
   */
  const queued = dlState().waiting.length;
  if (queued) vlog('热重载：队列里还有 %d 条下载，交给它自己跑完（不丢任务）', queued);
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
  searchOnce,
  performSearchRequest,
  searchFailureText,
  canonicalUrlKey,
  // 换图片指纹（避免 QQ 的 fast-upload 命中导致消息被静默丢弃）；导出是为了自测
  uniqueImageForUpload,
  backendNoteText,
  // 按会话判断谁允许成人向（2026-10-26；导出给自测）
  chatAllowsR18,
  parseR18ChatToken
};
