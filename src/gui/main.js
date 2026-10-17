'use strict';

/**
 * Electron 主进程：窗口、IPC、设置持久化，并把下载引擎的事件转发给渲染进程。
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session, clipboard, nativeImage } = require('electron');

// 打包后把 yt-dlp/ffmpeg 放到用户数据目录（安装目录通常只读）；
// 开发模式下直接复用项目里的 tools/，与命令行共用同一份 yt-dlp。
const USER_DATA = app.getPath('userData');
if (!process.env.VIDEOGRAB_TOOLS_DIR) {
  process.env.VIDEOGRAB_TOOLS_DIR = app.isPackaged
    ? path.join(USER_DATA, 'tools')
    : path.join(__dirname, '..', '..', 'tools');
}
if (!process.env.VIDEOGRAB_CONFIG_DIR) {
  process.env.VIDEOGRAB_CONFIG_DIR = USER_DATA;
}

/**
 * 从旧名字（videograb / 「视频下载工具」）的数据目录搬一次家。
 *
 * 改名后 Electron 给的 userData 变成 `%APPDATA%\ds-download`，而用户的设置、下载历史、
 * 登录 Cookie（在 `Partitions/` 里）、以及打包版自动下载的 yt-dlp/ffmpeg 全都还在老目录
 * `%APPDATA%\videograb` —— 不搬的话用户会以为"设置和历史全没了"（还会白下 96MB 工具）。
 * 只在**新目录里连 settings.json 都没有**时搬一次，绝不覆盖新数据。
 * 纯 Chromium 缓存（Cache / GPUCache …）不搬，那是垃圾。
 */
function migrateLegacyUserData() {
  try {
    const newDir = USER_DATA;
    const oldDir = path.join(path.dirname(newDir), 'videograb');
    if (path.basename(newDir).toLowerCase() === 'videograb') return;      // 已经是老目录
    if (!fs.existsSync(oldDir) || !fs.existsSync(newDir)) return;
    if (fs.existsSync(path.join(newDir, 'settings.json'))) return;        // 新目录已有数据，不动
    if (fs.existsSync(path.join(newDir, 'migrated-from-videograb'))) return;
    const skip = new Set([
      'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
      'ShaderCache', 'GrShaderCache', 'Crashpad', 'logs', 'blob_storage', 'Service Worker',
    ]);
    let files = 0;
    const walk = (from, to) => {
      fs.mkdirSync(to, { recursive: true });
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const src = path.join(from, entry.name);
        const dst = path.join(to, entry.name);
        if (entry.isDirectory()) walk(src, dst);
        else if (entry.isFile()) {
          try {
            fs.copyFileSync(src, dst);
            files += 1;
          } catch { /* 单个文件失败不阻断 */ }
        }
      }
    };
    walk(oldDir, newDir);
    fs.writeFileSync(path.join(newDir, 'migrated-from-videograb'), `${new Date().toISOString()}\n`, 'utf8');
    console.log(`[改名迁移] 已从 ${oldDir} 搬来 ${files} 个文件（设置 / 历史 / 登录态 / 工具）`);
  } catch (err) {
    console.warn(`[改名迁移] 跳过（不影响启动）：${err.message}`);
  }
}
migrateLegacyUserData();

/**
 * 首次启动：把随包附带的 yt-dlp / ffmpeg 复制到用户数据目录。
 *
 * 打包后工具目录固定在 `%APPDATA%\ds-download\tools`（安装目录一般只读），而包里那份
 * 种子放在 `resources/app/tools/`。不复制的话用户第一次下载就得联网现下 ~96MB ——
 * 分发包里既然带了，就不该白带。**只复制程序本体**：history.json / login-cookies.txt
 * 是本机用户数据，既不打包也不搬运。
 */
function seedBundledTools() {
  if (!app.isPackaged) return;
  const seedDir = path.join(__dirname, '..', '..', 'tools');
  const dstDir = process.env.VIDEOGRAB_TOOLS_DIR;
  if (!seedDir || !dstDir || path.resolve(seedDir) === path.resolve(dstDir)) return;
  const names = process.platform === 'win32' ? ['yt-dlp.exe', 'ffmpeg.exe'] : ['yt-dlp', 'ffmpeg'];
  for (const name of names) {
    try {
      const from = path.join(seedDir, name);
      const to = path.join(dstDir, name);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.mkdirSync(dstDir, { recursive: true });
      // 先写临时文件再改名：中途被打断也不会留下半个 exe 让后面的调用当成"已存在"
      const tmp = `${to}.seeding`;
      fs.copyFileSync(from, tmp);
      fs.renameSync(tmp, to);
      console.log(`[tools] 已从安装包复制 ${name} → ${to}`);
    } catch (err) {
      console.warn(`[tools] 复制 ${name} 失败（应用会自己下载）：${err.message}`);
    }
  }
}
seedBundledTools();

const { VideoDownloader } = require('../core/downloader');
const { randomId, formatBytes, ensureDir } = require('../core/util');
const { extractPageMediaInProcess, fetchTextInBrowserInProcess } = require('../core/browser-page');
const { loginCookiesFile, hasLoginCookies } = require('../core/config');
const {
  historyFile,
  loadHistory,
  appendHistory,
  setHistoryLimit,
  removeHistory,
  clearHistory,
  normalizeLimit: normalizeHistoryLimit,
  DEFAULT_LIMIT: HISTORY_DEFAULT_LIMIT,
} = require('../core/history');
const {
  LOGIN_SITES,
  resolveLoginTarget,
  openLoginWindowInProcess,
  clearLoginInProcess,
  exportSessionCookiesInProcess,
  LOGIN_PARTITION,
} = require('../core/browser-login');
const { guardWebContents } = require('../core/browser-guard');
const { setHttpProxy } = require('../core/http');
const { extractUrls } = require('../core/extract-urls');

/** 调试追踪（仅当设置了 VIDEOGRAB_TRACE 时写文件） */
function trace(message) {
  if (!process.env.VIDEOGRAB_TRACE) return;
  try {
    fs.appendFileSync(process.env.VIDEOGRAB_TRACE, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

trace(`main.js 载入 argv=${JSON.stringify(process.argv.slice(1))}`);

// 兜底：任何内置浏览器窗口都不允许跳转到 bytedance:// 之类的自定义协议，
// 否则 Chromium 会交给系统处理，Windows 会弹出「获取打开此链接的应用」对话框
app.on('web-contents-created', (_event, contents) => {
  guardWebContents(contents, { onBlock: (m) => trace(m) });
});

const SETTINGS_FILE = path.join(USER_DATA, 'settings.json');

const DEFAULT_SETTINGS = {
  outDir: app.getPath('downloads'),
  quality: 'best',
  engine: 'auto',
  concurrency: 8,
  overwrite: false,
  live: false,
  cookiesFile: '',
  cookiesFromBrowser: '',
  proxy: '',
  autoDownloadYtDlp: true,
  autoFetchFfmpeg: true,
  browserAssist: true,
  historyLimit: HISTORY_DEFAULT_LIMIT,
  parallel: 2,
};

function loadSettings() {
  try {
    // 有些编辑器/脚本写出来的 JSON 带 BOM，JSON.parse 会直接报错，这里先去掉
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettingsToDisk(settings) {
  try {
    ensureDir(path.dirname(SETTINGS_FILE));
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('保存设置失败：', err.message);
  }
}

let settings = loadSettings();
let mainWindow = null;
/** 命令行（vgrab）需要浏览器渲染/登录时，会用环境变量拉起本应用做一次辅助任务 */
const HELPER_MODE = Boolean(
  process.env.VIDEOGRAB_PAGE_URL ||
    process.env.VIDEOGRAB_FETCH_URL ||
    process.env.VIDEOGRAB_LOGIN_URL ||
    process.env.VIDEOGRAB_LOGIN_SITE,
);

const downloader = new VideoDownloader({
  ...settings,
  cookiesFile: settings.cookiesFile || (hasLoginCookies() ? loginCookiesFile() : ''),
  toolsDir: process.env.VIDEOGRAB_TOOLS_DIR,
  // GUI 本身就是 Chromium：解析不了的站点可以直接用内置浏览器渲染页面取视频地址
  extractPageMedia: (targetUrl, onLog, extra = {}) =>
    extractPageMediaInProcess(
      { BrowserWindow, session },
      {
        url: targetUrl,
        waitSec: extra.loadImages ? 12 : 9,
        loadImages: Boolean(extra.loadImages),
        scroll: Boolean(extra.scroll),
        onLog: (m) => {
          if (onLog) onLog(m);
        },
      },
    ),
  // pixiv 等站点前面挂着 Cloudflare，Node 的请求会被按 TLS 指纹一律 403，这里改用内置浏览器请求接口
  fetchViaBrowser: (targetUrl, pageUrl) =>
    fetchTextInBrowserInProcess(
      { BrowserWindow, session },
      { url: targetUrl, pageUrl: pageUrl || targetUrl, onLog: (m) => trace(m) },
    ).then((res) => ({ status: res.status, text: res.text })),
});

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

downloader.on('log', (p) => send('log', p));
downloader.on('progress', (p) => {
  if (p.taskId) send('task:progress', p);
  else send('setup:progress', p);
});
downloader.on('done', (p) => send('task:done', p));
downloader.on('error', (p) => send('task:error', p));
downloader.on('history', (p) => send('history:changed', p));
downloader.on('ytdlp:line', (p) => send('task:line', p));

/** 给界面推一条「重要提示」（渲染进程会高亮显示） */
function logNotice(message) {
  trace(`NOTICE: ${message}`);
  try {
    send('log', { taskId: null, message, notice: true, time: Date.now() });
  } catch {
    /* 窗口还没准备好时忽略 */
  }
}

/**
 * 把界面里填的「代理地址」应用到内置浏览器（登录/抓流窗口也会走代理）。
 * 同时把内置下载引擎（直链/HLS/图文/Pixiv 接口）的 HTTP 请求也切到同一个 session，
 * 否则会出现「浏览器代理后能打开 pixiv，但内置引擎还是连不上」这种割裂现象 ——
 * Node 自带的 fetch 不认界面里填的代理，只认进程启动时的代理环境变量。
 */
function applyProxyToSessions(proxy) {
  const raw = String(proxy || '').trim();
  const rules = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
  // 没填代理时不能强制直连：那样会把系统代理（Clash/v2rayN 等）一起屏蔽掉，
  // 于是出现「浏览器能开 pixiv，本工具却连不上」。留空 = 跟随系统代理。
  const patch = rules
    ? { proxyRules: `http=${rules};https=${rules}`, proxyBypassRules: '<local>' }
    : { mode: 'system' };
  const applying = [];
  for (const ses of [session.defaultSession, session.fromPartition(LOGIN_PARTITION)]) {
    try {
      const p = ses.setProxy(patch);
      if (p && typeof p.then === 'function') applying.push(p.catch(() => {}));
    } catch {
      /* ignore */
    }
  }
  trace(`内置浏览器代理已${rules ? `设为 ${rules}` : '关闭（跟随系统代理）'}`);
  // 内置下载引擎：优先用界面里填的代理，没填就跟着系统代理走
  const ready = Promise.all(applying).catch(() => {});
  if (rules) {
    applyProxyToHttp(raw);
  } else {
    // 必须等 setProxy 生效后再问系统代理，否则会问到旧的（直连）配置
    ready
      .then(() => detectSystemProxy())
      .then((sysProxy) => {
        if (sysProxy) {
          applyProxyToHttp(sysProxy);
          logNotice(`检测到系统代理 ${sysProxy}，内置下载引擎也会走它（浏览器能打开的站点，这里也能打开）`, {
            notice: true,
          });
        } else {
          applyProxyToHttp('');
        }
      })
      .catch(() => applyProxyToHttp(''));
  }
  return ready;
}

/** 取一个可用的 session（跟随内置浏览器用的那个） */
function ses0() {
  try {
    return session.fromPartition(LOGIN_PARTITION);
  } catch {
    return session.defaultSession;
  }
}

/**
 * 让内置下载引擎也走代理。
 *
 * 这里不再借道 Chromium 的 session.fetch：Chromium 会拦掉 Referer / Origin 这类请求头
 * （pixiv 图片没有 Referer 直接 403），所以改成在 Node 层用自带的 CONNECT 隧道客户端，
 * 请求头原样透传。
 *
 * 代理来源：界面里填的代理地址优先；没填就用系统代理（浏览器能打开的站点，这里也能打开）。
 */
function applyProxyToHttp(rules) {
  const target = String(rules || '').trim();
  try {
    setHttpProxy(target);
    if (target) trace(`内置下载引擎代理已设为 ${target}`);
    return target;
  } catch (err) {
    trace(`内置下载引擎代理设置失败：${err.message}`);
    setHttpProxy('');
    return '';
  }
}

/** 读系统代理（浏览器用的那个），拿不到返回空串 */
async function detectSystemProxy(attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const ses = ses0();
      const resolved = String((await ses.resolveProxy('https://www.pixiv.net/')) || '');
      trace(`resolveProxy 第 ${i + 1} 次：${resolved}`);
      const m = /(?:PROXY|HTTPS?|SOCKS5?)\s+([^\s;]+)/i.exec(resolved);
      if (m) {
        const [host, port] = m[1].split(':');
        if (host) return `http://${host}${port ? `:${port}` : ''}`;
      }
    } catch (err) {
      trace(`resolveProxy 失败：${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  trace('没有检测到系统代理，内置下载引擎直连');
  return '';
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开保存目录',
          click: () => shell.openPath(settings.outDir).catch(() => {}),
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * 应用图标：打包版放在 resources/app/icon.png，开发时用 build/icon.png（由 build/make-icon.mjs 生成）。
 * 找不到就算了 —— 图标缺了不该影响启动。
 */
function iconPath() {
  const candidates = [
    path.join(__dirname, '..', '..', 'icon.png'),
    path.join(__dirname, '..', '..', 'build', 'icon.png'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 下一个 */
    }
  }
  return undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: '#12141a',
    title: '肥鱼当劳',
    icon: iconPath(),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 外部链接一律用系统浏览器打开，禁止窗口内跳转
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Windows 任务栏/通知要按 AppUserModelID 认应用，不设的话任务栏图标会跟着 electron.exe 跑
  try {
    app.setAppUserModelId(app.isPackaged ? 'ds-download.downloader' : process.execPath);
  } catch {
    /* 设不上不影响使用 */
  }
  if (process.env.VIDEOGRAB_LOGIN_URL || process.env.VIDEOGRAB_LOGIN_SITE) {
    runLoginMode();
    return;
  }
  if (process.env.VIDEOGRAB_PAGE_URL) {
    runPageDumpMode();
    return;
  }
  if (process.env.VIDEOGRAB_FETCH_URL) {
    runBrowserFetchMode();
    return;
  }
  buildMenu();
  createWindow();
  applyProxyToSessions(settings.proxy);
  if (settings.proxy) {
    logNotice(`已启用代理 ${String(settings.proxy).trim()}（yt-dlp、内置浏览器、内置下载引擎都会走它）`, { notice: true });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  if (process.argv.includes('--selftest')) runSelfTest();
  // 启动时把内置浏览器的登录状态刷新到 cookies 文件（保持不过期）
  refreshLoginCookies().catch(() => {});
});

/** 登录模式（命令行 --login 触发）：打开登录窗口，用户关闭后导出 Cookie 并退出 */
async function runLoginMode() {
  const outFile = process.env.VIDEOGRAB_LOGIN_OUT || loginCookiesFile();
  let report;
  try {
    const res = await openLoginWindowInProcess(
      { BrowserWindow, session },
      {
        site: process.env.VIDEOGRAB_LOGIN_SITE || '',
        url: process.env.VIDEOGRAB_LOGIN_URL || '',
        outFile,
        autoCloseSec: Number(process.env.VIDEOGRAB_LOGIN_AUTOCLOSE || 0),
        onLog: (m) => {
          trace(m);
          console.log(m);
        },
      },
    );
    report = { ok: true, ...res };
  } catch (err) {
    trace(`登录失败：${err.message}`);
    report = { ok: false, count: 0, outFile, error: err.message };
  }
  try {
    fs.writeFileSync(`${outFile}.json`, JSON.stringify(report, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
  console.log('LOGIN ' + JSON.stringify(report));
  app.exit(report.ok && report.count > 0 ? 0 : 1);
}

/** 把当前会话里的 Cookie 重新导出（应用启动/登录后调用） */
async function refreshLoginCookies() {
  try {
    const res = await exportSessionCookiesInProcess({ BrowserWindow, session }, { outFile: loginCookiesFile(), partition: LOGIN_PARTITION });
    if (res.count > 0) {
      trace(`已刷新登录 Cookie 文件：${res.count} 个`);
      settings = { ...settings, cookiesFile: settings.cookiesFile || res.outFile };
      downloader.updateOptions({ ...settings });
    }
    return res;
  } catch (err) {
    trace(`刷新登录 Cookie 文件失败：${err.message}`);
    return { count: 0 };
  }
}

/** 浏览器内请求模式（VIDEOGRAB_FETCH_URL 触发）：用内置浏览器请求接口并把结果落盘 */
async function runBrowserFetchMode() {
  const url = process.env.VIDEOGRAB_FETCH_URL;
  const pageUrl = process.env.VIDEOGRAB_FETCH_PAGE || url;
  const out = process.env.VIDEOGRAB_FETCH_OUT || path.join(USER_DATA, 'fetch-result.json');
  const write = (payload) => {
    try {
      ensureDir(path.dirname(out));
      fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');
    } catch {
      /* ignore */
    }
  };
  const hardExit = setTimeout(() => {
    write({ ok: false, error: '浏览器内请求超时，已强制退出' });
    try {
      app.exit(1);
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(1), 3000);
  }, Number(process.env.VIDEOGRAB_FETCH_TIMEOUT || 90000));
  await applyProxyToSessions(settings.proxy);
  try {
    const res = await fetchTextInBrowserInProcess(
      { BrowserWindow, session },
      {
        url,
        pageUrl,
        onLog: (m) => {
          trace(m);
          console.log(m);
        },
      },
    );
    write({ ok: true, status: res.status, text: res.text });
  } catch (err) {
    write({ ok: false, error: err.message });
  }
  clearTimeout(hardExit);
  app.exit(0);
}

/** 页面抽取调试模式（VIDEOGRAB_PAGE_URL 触发）：把渲染后的媒体信息落盘 */
async function runPageDumpMode() {
  const url = process.env.VIDEOGRAB_PAGE_URL;
  const out = process.env.VIDEOGRAB_PAGE_OUT || path.join(USER_DATA, 'page-data.json');
  // 硬超时兜底：无论页面怎么卡，辅助进程都必须退出（避免留下后台进程）
  const hardExit = setTimeout(
    () => {
      try {
        fs.writeFileSync(`${out}.report.json`, JSON.stringify({ ok: false, error: '抓取超时，已强制退出' }, null, 2));
      } catch {
        /* ignore */
      }
      try {
        app.exit(1);
      } catch {
        /* ignore */
      }
      // app.exit 被卡住的渲染进程拖住时，再兜一层
      setTimeout(() => process.exit(1), 3000);
    },
    Number(process.env.VIDEOGRAB_PAGE_HARD_TIMEOUT || 120000),
  );
  let report;
  try {
    const res = await extractPageMediaInProcess(
      { BrowserWindow, session },
      {
        url,
        waitSec: Number(process.env.VIDEOGRAB_PAGE_WAIT || 10),
        loadImages: process.env.VIDEOGRAB_PAGE_IMAGES === '1',
        scroll: process.env.VIDEOGRAB_PAGE_SCROLL === '1',
        onLog: (m) => {
          trace(m);
          console.log(m);
        },
      },
    );
    report = { ok: true, mediaCount: res.media.length, title: res.title, finalUrl: res.finalUrl, rawLength: res.rawLength };
    try {
      fs.writeFileSync(out, JSON.stringify({ ...res, media: res.media.slice(0, 30) }, null, 2), 'utf8');
    } catch {
      /* ignore */
    }
  } catch (err) {
    report = { ok: false, error: err.message };
  }
  try {
    fs.writeFileSync(`${out}.report.json`, JSON.stringify(report, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
  clearTimeout(hardExit);
  console.log('PAGE_DUMP ' + JSON.stringify(report));
  app.exit(report.ok ? 0 : 1);
}

/**
 * 界面自检（开发用）：加载窗口 → 检查渲染进程 API 与 DOM 是否正常 → 退出。
 *   npx electron . --selftest
 */
function runSelfTest() {
  const problems = [];
  const reportFile = process.env.VIDEOGRAB_SELFTEST_OUT || path.join(USER_DATA, 'selftest.json');
  const emit = (payload) => {
    const text = JSON.stringify(payload, null, 2);
    try {
      ensureDir(path.dirname(reportFile));
      fs.writeFileSync(reportFile, text, 'utf8');
    } catch {
      /* 文件写不了就只打印 */
    }
    console.log('SELFTEST ' + text);
  };
  mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) problems.push(`[renderer ${level}] ${message} (${source}:${line})`);
  });
  mainWindow.webContents.once('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const report = await mainWindow.webContents.executeJavaScript(`(() => ({
        hasApi: typeof window.vgrab === 'object' && window.vgrab !== null,
        apiCount: window.vgrab ? Object.keys(window.vgrab).length : 0,
        title: document.title,
        header: (document.querySelector('.brand h1') || {}).textContent || '',
        ytdlp: (document.getElementById('ytdlp-value') || {}).textContent || '',
        ffmpeg: (document.getElementById('ffmpeg-value') || {}).textContent || '',
        outDir: (document.getElementById('out-dir') || {}).value || '',
        logLines: (document.getElementById('log') || { childElementCount: 0 }).childElementCount,
        logText: [...document.querySelectorAll('#log .line')].slice(-8).map((l) => l.textContent).join(' | ').slice(0, 500),
        hasDropzone: Boolean(document.getElementById('dropzone')),
        qualityOptions: document.querySelectorAll('#quality option').length,
        // 左上角 logo：确认图真的加载出来了（naturalWidth 为 0 = 图没找到/坏了）
        logo: (() => {
          const el = document.querySelector('.brand img.logo');
          if (!el) return { present: false, loaded: false, src: '', natural: '' };
          const w = el.naturalWidth || 0;
          const h = el.naturalHeight || 0;
          return {
            present: true,
            src: String(el.getAttribute('src') || ''),
            natural: w + 'x' + h,
            loaded: w > 0
          };
        })(),
      }))()`);

      // 可选：先保存一个代理设置，用于验证「内置下载引擎也走代理」
      // （测试结束会把设置改回来，绝不把测试用代理留在用户配置里）
      let proxySet = null;
      let proxyRestored = null;
      if (process.env.VIDEOGRAB_SELFTEST_PROXY) {
        const original = JSON.parse(
          fs.existsSync(SETTINGS_FILE) ? fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, '') : '{}',
        );
        proxySet = await mainWindow.webContents.executeJavaScript(
          `window.vgrab.saveSettings({ proxy: ${JSON.stringify(process.env.VIDEOGRAB_SELFTEST_PROXY)} })`,
        );
        await new Promise((r) => setTimeout(r, 1500));
        proxyRestored = { proxy: original.proxy || '' };
      }

      // 可选：驱动「解析链接」按钮，验证 IPC（探测 + yt-dlp 格式查询）真的能跑通
      let probe = null;
      const parseUrl = process.env.VIDEOGRAB_SELFTEST_PARSE;
      if (parseUrl) {
        await mainWindow.webContents.executeJavaScript(
          `(() => { document.getElementById('url-input').value = ${JSON.stringify(parseUrl)}; document.getElementById('btn-parse').click(); return true; })()`,
        );
        await new Promise((r) => setTimeout(r, Number(process.env.VIDEOGRAB_SELFTEST_PARSE_WAIT || 15000)));
        probe = await mainWindow.webContents.executeJavaScript(
          `(() => { const b = document.getElementById('probe-result'); return { hidden: b.hidden, text: (b.textContent || '').replace(/\\s+/g, ' ').slice(0, 300) }; })()`,
        );
      }

      // 可选：直播录制 → 点「结束录制」→ 检查是否保存成成品
      let live = null;
      const liveUrl = process.env.VIDEOGRAB_SELFTEST_LIVE;
      if (liveUrl) {
        const liveDir = process.env.VIDEOGRAB_SELFTEST_LIVE_DIR || path.join(USER_DATA, 'live-test');
        await mainWindow.webContents.executeJavaScript(`(() => {
          document.getElementById('out-dir').value = ${JSON.stringify(liveDir)};
          document.getElementById('live').checked = true;
          document.getElementById('url-input').value = ${JSON.stringify(liveUrl)};
          document.getElementById('btn-download').click();
          return true;
        })()`);
        let clickedAt = 0;
        const clickDeadline = Date.now() + 90000;
        while (Date.now() < clickDeadline && !clickedAt) {
          await new Promise((r) => setTimeout(r, 2000));
          const clicked = await mainWindow.webContents.executeJavaScript(`(() => {
            const btn = [...document.querySelectorAll('.task .act-cancel')].find((b) => !b.hidden && (b.textContent || '').includes('结束录制'));
            if (!btn) return false;
            btn.click();
            return true;
          })()`);
          if (clicked) clickedAt = Date.now();
        }
        let state = null;
        const doneDeadline = Date.now() + 150000;
        while (Date.now() < doneDeadline) {
          await new Promise((r) => setTimeout(r, 2000));
          state = await mainWindow.webContents.executeJavaScript(`(() => {
            const t = document.querySelector('.task');
            if (!t) return null;
            const q = (s) => { const e = t.querySelector(s); return e ? (e.textContent || '') : ''; };
            return { done: t.classList.contains('done'), badge: q('.badge'), title: q('.title'), note: q('.eta'), bytes: q('.bytes') };
          })()`);
          if (state && state.done) break;
        }
        live = { clicked: Boolean(clickedAt), stopped: state, dir: liveDir, file: null, files: [] };
        try {
          const files = fs.readdirSync(liveDir);
          live.files = files;
          live.file = files.find((f) => /\.(mp4|ts|m4a|aac|flv|mkv|webm)$/i.test(f)) || null;
        } catch {
          /* ignore */
        }
      }

      // 可选：登录流程 → 导出登录状态 → 检查界面状态（走新的「站点选择弹窗」入口）
      let login = null;
      const loginSite = process.env.VIDEOGRAB_SELFTEST_LOGIN;
      if (loginSite) {
        const js = (code) => mainWindow.webContents.executeJavaScript(code);
        // 点「登录」打开弹窗，检查站点列表
        const modal = await js(`(async () => {
          document.getElementById('btn-login').click();
          await new Promise((r) => setTimeout(r, 600));
          const m = document.getElementById('login-modal');
          const buttons = [...document.querySelectorAll('#login-site-grid button')];
          return {
            visible: !m.hidden,
            count: buttons.length,
            names: buttons.map((b) => b.textContent.trim()).slice(0, 20),
            hasCustomInput: Boolean(document.getElementById('login-custom')),
            hasOtherButton: buttons.some((b) => b.textContent.includes('其他网站')),
          };
        })()`);
        // 需要人工/截图确认时，让弹窗停留一会儿
        const holdModal = Number(process.env.VIDEOGRAB_SELFTEST_HOLD || 0);
        if (holdModal > 0) await new Promise((r) => setTimeout(r, holdModal * 1000));
        // 走「任意网址」入口发起登录（自检里用自定义输入框）
        const res = await js(`(async () => {
          const input = document.getElementById('login-custom');
          input.value = ${JSON.stringify(loginSite)};
          document.getElementById('btn-login-go').click();
          return true;
        })()`);
        await new Promise((r) => setTimeout(r, 1200));
        const modalClosed = await js(`document.getElementById('login-modal').hidden`);
        // 等登录窗口被自动关闭并导出 Cookie 后再看状态
        let status = null;
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          status = await js(
            `(() => ({ value: (document.getElementById('login-value') || {}).textContent || '', logoutVisible: !(document.getElementById('btn-logout') || {}).hidden, cookiesField: (document.getElementById('cookies-file') || {}).value || '' }))()`,
          );
          if (status && /已登录/.test(status.value)) break;
        }
        const info = await js(`window.vgrab.loginStatus()`);
        login = { modal, started: res, modalClosed, status, info };
      }

      // 可选：验证输入框右键菜单（复制 / 粘贴）
      let ctxMenu = null;
      if (process.env.VIDEOGRAB_SELFTEST_CONTEXTMENU) {
        const { clipboard } = require('electron');
        const js = (code) => mainWindow.webContents.executeJavaScript(code);
        clipboard.writeText('https://example.com/pasted-by-menu.mp4');
        const opened = await js(`(() => {
          const input = document.getElementById('url-input');
          input.value = '';
          input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 260 }));
          const m = document.getElementById('ctx-menu');
          const rect = m.getBoundingClientRect();
          return {
            visible: !m.hidden,
            items: [...m.querySelectorAll('button')].filter((b) => !b.hidden).map((b) => b.textContent),
            inViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
          };
        })()`);
        await js(`document.getElementById('ctx-paste').click()`);
        await new Promise((r) => setTimeout(r, 500));
        const afterPaste = await js(`document.getElementById('url-input').value`);
        const hiddenAfter = await js(`document.getElementById('ctx-menu').hidden`);
        // 选中前 19 个字符再复制
        await js(`(() => {
          const i = document.getElementById('url-input');
          i.focus();
          i.setSelectionRange(0, 19);
          i.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 260 }));
          return true;
        })()`);
        await js(`document.getElementById('ctx-copy').click()`);
        await new Promise((r) => setTimeout(r, 500));
        ctxMenu = { opened, afterPaste, hiddenAfter, copied: clipboard.readText() };
        // 需要人工/截图确认时，把菜单重新打开并停留一会儿
        const hold = Number(process.env.VIDEOGRAB_SELFTEST_HOLD || 0);
        if (hold > 0) {
          await js(`(() => {
            const input = document.getElementById('url-input');
            input.value = 'https://www.bilibili.com/video/BV1sbbD64EXf/' + String.fromCharCode(10) + 'https://live.douyin.com/792658201010';
            input.focus();
            input.setSelectionRange(0, 12);
            input.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 420, clientY: 300 }));
            return true;
          })()`);
          await new Promise((r) => setTimeout(r, hold * 1000));
        }
      }

      // 可选：验证「清空」按钮
      let clearInput = null;
      if (process.env.VIDEOGRAB_SELFTEST_CLEARINPUT) {
        clearInput = await mainWindow.webContents.executeJavaScript(`(async () => {
          const input = document.getElementById('url-input');
          const btn = document.getElementById('btn-clear-input');
          const probe = document.getElementById('probe-result');
          // 先归零状态（前面的用例可能往输入框写过内容）
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          const idleDisabled = btn.disabled;
          probe.hidden = false;
          probe.textContent = '测试用解析结果';
          input.value = 'https://www.bilibili.com/video/BV1sbbD64EXf/' + String.fromCharCode(10) + 'https://live.douyin.com/792658201010';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          const enabledWithText = !btn.disabled;
          const label = btn.textContent.trim();
          btn.click();
          await new Promise((r) => setTimeout(r, 150));
          return {
            label,
            idleDisabled,
            enabledWithText,
            valueAfter: input.value,
            disabledAfter: btn.disabled,
            probeHidden: probe.hidden,
            focused: document.activeElement === input,
          };
        })()`);
      }

      // 可选：验证下载历史（条数设置 / 列表渲染 / 清空）
      let history = null;
      if (process.env.VIDEOGRAB_SELFTEST_HISTORY) {
        const js = (code) => mainWindow.webContents.executeJavaScript(code);
        const countItems = () => js(`document.querySelectorAll('#history-list .history-item').length`);
        await js(`window.vgrab.historyClear()`);
        for (let i = 1; i <= 3; i += 1) {
          await js(
            `window.vgrab.historyAdd(${JSON.stringify({
              id: `selftest-${i}`,
              url: `https://example.com/v${i}.mp4`,
              fileName: `v${i}.mp4`,
              filePath: `D:\\tmp\\v${i}.mp4`,
              bytes: i * 1024 * 1024,
              engine: 'direct',
              ok: true,
              at: Date.now() - i * 60000,
            })})`,
          );
        }
        await js(`document.getElementById('btn-history-refresh').click()`);
        await new Promise((r) => setTimeout(r, 500));
        const afterAdd = await countItems();
        // 把条数改成 2，应立刻裁剪
        await js(`(() => {
          const input = document.getElementById('history-limit');
          input.value = '2';
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);
        await new Promise((r) => setTimeout(r, 700));
        const afterLimit = await countItems();
        const limitValue = await js(`document.getElementById('history-limit').value`);
        const counter = await js(`document.getElementById('history-counter').textContent`);
        const firstName = await js(`(document.querySelector('#history-list .hi-name') || {}).textContent || ''`);
        // 清空（绕过确认框）
        await js(`(() => { window.confirm = () => true; document.getElementById('btn-history-clear').click(); return true; })()`);
        await new Promise((r) => setTimeout(r, 600));
        const afterClear = await countItems();
        const remaining = await js(`window.vgrab.historyList()`);
        history = {
          afterAdd,
          afterLimit,
          limitValue,
          counter,
          firstName,
          afterClear,
          remaining: remaining && remaining.records ? remaining.records.length : -1,
          file: historyFile(),
        };
        // 需要人工/截图确认时：重新造几条记录、滚到历史卡片并停留
        const hold = Number(process.env.VIDEOGRAB_SELFTEST_HOLD || 0);
        if (hold > 0) {
          await js(`window.vgrab.historySetLimit(20)`);
          const demo = [
            { id: 'demo-1', url: 'https://www.bilibili.com/video/BV1xx411c7mD', fileName: '示例视频.mp4', filePath: 'D:\\videos\\示例视频.mp4', bytes: 3094528, durationSec: 94, engine: 'ytdlp', ok: true, at: Date.now() - 300000 },
            { id: 'demo-2', url: 'https://live.example.com/123456', fileName: '示例直播录制.mp4', filePath: 'D:\\videos\\示例直播录制.mp4', bytes: 9584640, durationSec: 12, engine: 'stream', ok: true, stopped: true, live: true, at: Date.now() - 1500000 },
            { id: 'demo-3', url: 'https://www.example.com/broken.mp4', fileName: 'broken.mp4', bytes: 0, engine: 'direct', ok: false, error: 'HTTP 404：文件不存在', at: Date.now() - 7200000 },
          ];
          for (const d of demo) await js(`window.vgrab.historyAdd(${JSON.stringify(d)})`);
          await js(`document.getElementById('btn-history-refresh').click()`);
          await new Promise((r) => setTimeout(r, 500));
          await js(`(() => { const c = document.querySelector('.history-card'); if (c) c.scrollIntoView({ block: 'center' }); return true; })()`);
          await new Promise((r) => setTimeout(r, hold * 1000));
        }
      }

      // 可选：验证「从分享文案里自动识别链接」（界面路径：粘贴整段文案 → 开始下载）
      let extract = null;
      if (process.env.VIDEOGRAB_SELFTEST_EXTRACT) {
        const share =
          '3.02 07/15 :3pm GVl:/ i@c.an 假如熊大熊二闹掰了，树洞应该判给谁？ # 熊出没 # 熊大 # 熊二 # 光头强 # 财产分割  ' +
          'https://v.douyin.com/Q17Q43LSOR4/ 复制此链接，打开Dou音搜索，直接观看视频！';
        extract = await mainWindow.webContents.executeJavaScript(`(async () => {
          const share = ${JSON.stringify(share)};
          const viaIpc = await window.vgrab.extractUrls(share);
          const input = document.getElementById('url-input');
          input.value = share;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          document.getElementById('btn-download').click();
          await new Promise((r) => setTimeout(r, 900));
          const cards = [...document.querySelectorAll('#tasks .task')];
          const cardUrl = cards[0] ? ((cards[0].querySelector('.url') || {}).textContent || '') : '';
          const hint = (document.getElementById('queue-hint') || {}).textContent || '';
          await window.vgrab.cancelAll();
          return { ipcUrls: viaIpc.urls, ipcNoisy: viaIpc.noisy, cards: cards.length, cardUrl, hint };
        })()`);
        await new Promise((r) => setTimeout(r, 2000));
      }

      // 可选：验证「抖音图文 / Pixiv 图片帖」下载（界面路径：粘贴图文链接 → 开始下载 → 检查产物）
      let images = null;
      const imageUrl = process.env.VIDEOGRAB_SELFTEST_IMAGES;
      if (imageUrl) {
        const imageDir = process.env.VIDEOGRAB_SELFTEST_IMAGES_DIR || path.join(USER_DATA, 'images-test');
        await mainWindow.webContents.executeJavaScript(`(() => {
          document.getElementById('out-dir').value = ${JSON.stringify(imageDir)};
          document.getElementById('url-input').value = ${JSON.stringify(imageUrl)};
          document.getElementById('url-input').dispatchEvent(new Event('input', { bubbles: true }));
          document.getElementById('btn-download').click();
          return true;
        })()`);
        const deadline = Date.now() + 180000;
        let state = '';
        while (Date.now() < deadline && !state) {
          await new Promise((r) => setTimeout(r, 1000));
          state = await mainWindow.webContents.executeJavaScript(`(() => {
            const node = document.querySelector('#tasks .task');
            if (!node) return '';
            if (node.classList.contains('done')) return 'done';
            if (node.classList.contains('error')) return 'error';
            return '';
          })()`);
        }
        const ui = await mainWindow.webContents.executeJavaScript(`(() => {
          const node = document.querySelector('#tasks .task');
          const pick = (sel) => (node && node.querySelector(sel) ? node.querySelector(sel).textContent : '');
          return {
            state: node ? node.className : '',
            badge: pick('.badge'),
            title: pick('.title'),
            pct: pick('.pct'),
            bytes: pick('.bytes'),
            log: [...document.querySelectorAll('#log .line')].slice(-6).map((l) => l.textContent).join(' | '),
          };
        })()`);
        const walk = (dir, depth = 0) => {
          if (depth > 2) return [];
          let entries = [];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return [];
          }
          const files = [];
          for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) files.push(...walk(full, depth + 1));
            else files.push({ name: entry.name, bytes: fs.statSync(full).size });
          }
          return files;
        };
        const files = walk(imageDir);
        // 落盘是否真的写完（防止「任务已完成但文件还在写」这类竞态）
        await new Promise((r) => setTimeout(r, 2000));
        const filesAfter = walk(imageDir);
        images = {
          state: ui.state || state,
          badge: ui.badge,
          title: ui.title,
          pct: ui.pct,
          bytes: ui.bytes,
          fileCount: files.length,
          names: files.map((f) => f.name),
          totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
          totalBytesAfter: filesAfter.reduce((sum, f) => sum + f.bytes, 0),
          minBytes: files.length ? Math.min(...files.map((f) => f.bytes)) : 0,
          dir: imageDir,
          log: ui.log.slice(0, 400),
        };
      }

      // 把自检期间改过的代理设置改回去
      if (proxyRestored) {
        try {
          await mainWindow.webContents.executeJavaScript(
            `window.vgrab.saveSettings({ proxy: ${JSON.stringify(proxyRestored.proxy)} })`,
          );
        } catch {
          /* ignore */
        }
      }

      // 可选：验证「测试代理」按钮（立即生效，无需重启）
      let proxyCheck = null;
      if (process.env.VIDEOGRAB_SELFTEST_PROXYCHECK) {
        const fieldProxy = process.env.VIDEOGRAB_SELFTEST_PROXYCHECK_VALUE || '';
        const originalProxy = settings.proxy;
        await mainWindow.webContents.executeJavaScript(`(() => {
          const input = document.getElementById('proxy');
          input.value = ${JSON.stringify(fieldProxy)};
          input.dispatchEvent(new Event('change', { bubbles: true }));
          document.getElementById('btn-proxy-test').click();
          return true;
        })()`);
        const deadline = Date.now() + 60000;
        let statusText = '';
        while (Date.now() < deadline && !statusText) {
          await new Promise((r) => setTimeout(r, 800));
          statusText = await mainWindow.webContents.executeJavaScript(
            `(document.getElementById('proxy-status') || {}).textContent || ''`,
          );
          if (statusText && !/正在测试/.test(statusText)) break;
          statusText = '';
        }
        proxyCheck = await mainWindow.webContents.executeJavaScript(`(() => ({
          text: (document.getElementById('proxy-status') || {}).textContent || '',
          className: (document.getElementById('proxy-status') || {}).className || '',
          hasButton: Boolean(document.getElementById('btn-proxy-test')),
        }))()`);
        proxyCheck.originalProxy = originalProxy;
        proxyCheck.effectiveSetting = settings.proxy;
        // 把自检期间改动的设置改回去
        settings = { ...settings, proxy: originalProxy };
        saveSettingsToDisk(settings);
        downloader.updateOptions({ ...settings });
        await applyProxyToSessions(originalProxy);
      }

      // 可选：列表挑图 → 勾选/全选 → 下载选中（VIDEOGRAB_SELFTEST_PIXIV_PICK=1）
      let pixivPick = null;
      if (process.env.VIDEOGRAB_SELFTEST_PIXIV_PICK === '1') {
        const keyword = process.env.VIDEOGRAB_SELFTEST_PIXIV_KEYWORD || '猫娘';
        const pickDir = process.env.VIDEOGRAB_SELFTEST_PIXIV_PICK_DIR || path.join(USER_DATA, 'pixiv-pick-test');
        pixivPick = await mainWindow.webContents.executeJavaScript(`(async () => {
          const kw = document.getElementById('pixiv-keyword');
          const count = document.getElementById('pixiv-count');
          const status = document.getElementById('pixiv-status');
          const results = document.getElementById('pixiv-results');
          const outDir = document.getElementById('out-dir');
          outDir.value = ${JSON.stringify(pickDir)};
          kw.value = ${JSON.stringify(keyword)};
          count.value = '3';
          document.getElementById('btn-pixiv-list').click();
          // 等：条目出现 + 缩略图铺出来（反代一张两三秒，并发 4 条）
          const t1 = Date.now() + 240000;
          let rows = 0;
          let previews = 0;
          while (Date.now() < t1) {
            await new Promise((r) => setTimeout(r, 800));
            rows = results.querySelectorAll('.ps-item').length;
            previews = results.querySelectorAll('.ps-thumb img').length;
            if (rows > 0 && previews > 0) break;
          }
          const picks = results.querySelectorAll('.ps-pick input');
          const hasSelectAll = [...results.querySelectorAll('.ps-actions .ps-open')].some((b) => b.textContent.includes('全选'));
          const hasDownloadSelected = [...results.querySelectorAll('.ps-actions .ps-open')].some((b) => /下载选中/.test(b.textContent));
          const perItemDownload = results.querySelectorAll('.ps-item .ps-open').length;
          // 先"全不选"再单独勾第 2 个 → 只下 1 个（顺便验证按条勾选）
          const noneBtn = [...results.querySelectorAll('.ps-actions .ps-open')].find((b) => b.textContent.includes('全不选'));
          noneBtn.click();
          await new Promise((r) => setTimeout(r, 200));
          const uncheckedAfterNone = [...results.querySelectorAll('.ps-pick input')].filter((c) => c.checked).length;
          const target = picks[1] || picks[0];
          if (target) {
            target.checked = true;
            target.dispatchEvent(new Event('change', { bubbles: true }));
          }
          await new Promise((r) => setTimeout(r, 200));
          const dlBtn = [...results.querySelectorAll('.ps-actions .ps-open')].find((b) => /下载选中/.test(b.textContent));
          const dlLabel = dlBtn ? dlBtn.textContent : '';
          if (dlBtn) dlBtn.click();
          // 等下载完成（状态里出现"下载完成"）+ 本地预览图
          const t2 = Date.now() + 240000;
          let doneText = '';
          let localThumbs = 0;
          while (Date.now() < t2) {
            await new Promise((r) => setTimeout(r, 1000));
            doneText = status.textContent || '';
            localThumbs = results.querySelectorAll('.ps-thumb img').length;
            if (/下载完成/.test(doneText) && localThumbs > 0) break;
          }
          let files = [];
          void files;
          return {
            rows, previews, picks: picks.length, hasSelectAll, hasDownloadSelected,
            perItemDownload, uncheckedAfterNone, dlLabel,
            status: doneText.slice(0, 160),
            localThumbs,
            dir: outDir.value,
            // 挑图下载同样要落到「下载任务」「下载记录」栏里
            pixivTaskCards: document.querySelectorAll('#tasks .task[data-id^="pixiv-"]').length,
            pixivTaskDone: document.querySelectorAll('#tasks .task[data-id^="pixiv-"].done, #tasks .task[data-id^="pixiv-"].error').length,
            pixivHistoryRows: [...document.querySelectorAll('#history-list .history-item')]
              .filter((n) => /pixiv/i.test(n.textContent || '')).length,
          };
        })()`);
        // 磁盘上确实落了图（界面说完成 ≠ 真的有文件）
        let diskFiles = [];
        try {
          const walk = (d) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
              const p = path.join(d, e.name);
              if (e.isDirectory()) walk(p);
              else diskFiles.push(p);
            }
          };
          walk(pickDir);
        } catch { /* 目录还不存在 */ }
        pixivPick.diskFiles = diskFiles.length;
        pixivPick.diskSample = diskFiles.slice(0, 2).map((f) => path.basename(f));
      }

      // 可选：验证「Pixiv 搜图」搜索框 + R18 开关（走反代，不需要代理）
      let pixivSearch = null;
      if (process.env.VIDEOGRAB_SELFTEST_PIXIV) {
        const keyword = process.env.VIDEOGRAB_SELFTEST_PIXIV_KEYWORD || '初音ミク';
        const r18 = process.env.VIDEOGRAB_SELFTEST_PIXIV_R18 === '1';
        pixivSearch = await mainWindow.webContents.executeJavaScript(`(async () => {
          const urlInput = document.getElementById('url-input');
          const kw = document.getElementById('pixiv-keyword');
          const count = document.getElementById('pixiv-count');
          const r18Box = document.getElementById('pixiv-r18');
          const listBtn = document.getElementById('btn-pixiv-list');
          const searchBtn = document.getElementById('btn-pixiv-search');
          const status = document.getElementById('pixiv-status');
          const results = document.getElementById('pixiv-results');
          const before = {
            hasKeywordInput: Boolean(kw),
            hasCountInput: Boolean(count),
            hasR18Toggle: Boolean(r18Box),
            hasSearchButton: Boolean(searchBtn),
            hasListButton: Boolean(listBtn),
            countDefault: count ? count.value : '',
            r18Default: r18Box ? r18Box.checked : null,
            statusEmpty: !status.textContent.trim(),
          };
          const emptyHint = await (async () => {
            kw.value = '';
            searchBtn.click();
            await new Promise((r) => setTimeout(r, 150));
            return status.textContent;
          })();
          kw.value = ${JSON.stringify(keyword)};
          ${r18 ? 'r18Box.checked = true; r18Box.dispatchEvent(new Event("change", { bubbles: true }));' : ''}
          count.value = '2';
          ${process.env.VIDEOGRAB_SELFTEST_PIXIV_LIST === '1' ? 'listBtn' : 'searchBtn'}.click();
          // 等"搜索+下载+预览图"全部到位再下结论：
          // 反代取图慢的时候两个作品要跑两三分钟，之前只等状态文字，结果状态还没出来
          // 就取数，白判成失败（预览图其实后来渲染出来了）。
          const listOnlyMode = ${process.env.VIDEOGRAB_SELFTEST_PIXIV_LIST === '1' ? 'true' : 'false'};
          const waitMs = Number(${JSON.stringify(process.env.VIDEOGRAB_SELFTEST_PIXIV_WAIT || '')}) || 300000;
          const deadline = Date.now() + waitMs;
          let text = '';
          let rows = 0;
          let thumbs = 0;
          let firstThumbSrc = '';
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 1000));
            text = status.textContent || '';
            rows = results ? results.querySelectorAll('.ps-item').length : 0;
            const imgs = results ? [...results.querySelectorAll('.ps-thumb img')] : [];
            thumbs = imgs.length;
            firstThumbSrc = imgs[0] ? String(imgs[0].getAttribute('src') || '') : '';
            const settled = Boolean(text) && !/正在搜索/.test(text);
            const rowOk = rows > 0 || /✖/.test(text);
            const previewOk = listOnlyMode || thumbs > 0;
            if (settled && rowOk && previewOk) break;
          }
          return {
            ...before,
            emptyHint: emptyHint.slice(0, 40),
            status: text.slice(0, 200),
            statusClass: status.className,
            resultsHidden: results ? results.hidden : null,
            rows,
            firstRow: (results && results.querySelector('.ps-item') ? results.querySelector('.ps-item').textContent.trim() : '').slice(0, 80),
            thumbs,
            firstThumbSrc: firstThumbSrc.slice(0, 40),
            hasThumbHolder: results ? results.querySelectorAll('.ps-thumbs').length : 0,
            // Pixiv 的活儿也要出现在「下载任务」和「下载记录」栏里（本轮新要求）
            pixivTaskCards: document.querySelectorAll('#tasks .task[data-id^="pixiv-"]').length,
            pixivTaskDone: document.querySelectorAll('#tasks .task[data-id^="pixiv-"].done, #tasks .task[data-id^="pixiv-"].error').length,
            pixivHistoryRows: [...document.querySelectorAll('#history-list .history-item')]
              .filter((n) => /pixiv/i.test(n.textContent || '')).length,
            historyRows: document.querySelectorAll('#history-list .history-item').length,
            logTail: [...document.querySelectorAll('#log .line')].slice(-4).map((l) => l.textContent).join(' | ').slice(0, 300),
          };
        })()`);
        await new Promise((r) => setTimeout(r, 1500));
      }

      // 这两组分支检查单独抽成常量：混在一个大布尔表达式里，括号一错就会**整段被短路掉**
      // —— 踩过一次：pick 的断言被嵌进了 pixivSearch 分支里，pick 模式不跑 pixivSearch 时
      // 那几条断言根本没被求值，报告里 ok 照样是 true。
      const pixivSearchOk =
        !pixivSearch ||
        (pixivSearch.hasKeywordInput &&
          pixivSearch.hasR18Toggle &&
          pixivSearch.hasSearchButton &&
          pixivSearch.r18Default === false &&
          /关键词/.test(pixivSearch.emptyHint) &&
          /✔/.test(pixivSearch.status) &&
          pixivSearch.rows >= 1 &&
          // 任务卡必须出现在「下载任务」栏（本轮要求）
          pixivSearch.pixivTaskCards >= 1 &&
          pixivSearch.pixivTaskDone >= 1 &&
          // 「搜图并下载」**不加载预览图**（thumbs 必须是 0）；「只列出」的预览由 pick 那条流程单独验
          (process.env.VIDEOGRAB_SELFTEST_PIXIV_LIST === '1' || pixivSearch.thumbs === 0) &&
          // 真下载的模式下，「下载记录」里必须出现 pixiv 的记录（只列出则不下载、不记录）
          (process.env.VIDEOGRAB_SELFTEST_PIXIV_LIST === '1' || pixivSearch.pixivHistoryRows >= 1));

      // 「只列出 → 勾选 → 下载选中」：预览图、勾选框、全选/下载按钮、按条勾选只下 1 个、真落盘
      const pixivPickOk =
        !pixivPick ||
        (pixivPick.rows >= 1 &&
          pixivPick.previews >= 1 &&
          pixivPick.picks === pixivPick.rows &&
          pixivPick.hasSelectAll &&
          pixivPick.hasDownloadSelected &&
          pixivPick.perItemDownload >= pixivPick.rows &&
          pixivPick.uncheckedAfterNone === 0 &&
          /下载选中（1）/.test(pixivPick.dlLabel) &&
          /下载完成/.test(pixivPick.status) &&
          pixivPick.localThumbs >= 1 &&
          pixivPick.diskFiles >= 1 &&
          // 挑图这条链路也要有任务卡与下载记录
          pixivPick.pixivTaskCards >= 1 &&
          pixivPick.pixivTaskDone >= 1 &&
          pixivPick.pixivHistoryRows >= 1);

      const ok = Boolean(
        report.hasApi &&
          report.apiCount > 15 &&
          report.logLines > 0 &&
          report.hasDropzone &&
          report.qualityOptions >= 9 &&
          // 左上角 logo 必须真的加载出来（图丢了/路径写错时这里会红）
          (report.logo && report.logo.loaded) &&
          problems.length === 0 &&
          (!probe || (!probe.hidden && probe.text.includes('标题') && !probe.text.includes('解析失败') && !probe.text.includes('查询失败'))) &&
          (!live || (live.clicked && live.stopped && live.stopped.done && /已结束录制/.test(live.stopped.badge) && live.file)) &&
          (!login ||
            (login.modal.visible &&
              login.modal.count >= 10 &&
              login.modal.hasCustomInput &&
              login.modal.hasOtherButton &&
              login.modalClosed === true &&
              login.status.logoutVisible &&
              /已登录/.test(login.status.value) &&
              login.info &&
              login.info.loggedIn &&
              login.info.count > 0)) &&
          (!ctxMenu ||
            (ctxMenu.opened.visible &&
              ctxMenu.opened.inViewport &&
              ctxMenu.opened.items.join(',') === '复制,粘贴' &&
              ctxMenu.afterPaste === 'https://example.com/pasted-by-menu.mp4' &&
              ctxMenu.hiddenAfter === true &&
              ctxMenu.copied === 'https://example.com')) &&
          (!clearInput ||
            (clearInput.label === '清空' &&
              clearInput.idleDisabled === true &&
              clearInput.enabledWithText === true &&
              clearInput.valueAfter === '' &&
              clearInput.disabledAfter === true &&
              clearInput.probeHidden === true)) &&
          (!history ||
            (history.afterAdd === 3 &&
              history.afterLimit === 2 &&
              history.limitValue === '2' &&
              history.counter === '2' &&
              history.firstName === 'v1.mp4' &&
              history.afterClear === 0 &&
              history.remaining === 0)) &&
          (!extract ||
            (extract.ipcUrls.length === 1 &&
              extract.ipcUrls[0] === 'https://v.douyin.com/Q17Q43LSOR4/' &&
              extract.ipcNoisy === true &&
              extract.cards === 1 &&
              extract.cardUrl === 'https://v.douyin.com/Q17Q43LSOR4/')) &&
          (!images ||
            (/\bdone\b/.test(images.state) &&
              /完成/.test(images.badge) &&
              images.fileCount > 0 &&
              images.minBytes > 0)) &&
          (!proxyCheck ||
            (proxyCheck.hasButton &&
              proxyCheck.text.length > 0 &&
              /已立即生效/.test(proxyCheck.text) &&
              (!process.env.VIDEOGRAB_SELFTEST_PROXYCHECK_EXPECT ||
                proxyCheck.text.includes(process.env.VIDEOGRAB_SELFTEST_PROXYCHECK_EXPECT)))) &&
          pixivSearchOk &&
          pixivPickOk,
      );
      emit({ ok, report, proxySet, proxyCheck, pixivSearch, pixivPick, probe, live, login, ctxMenu, clearInput, history, extract, images, problems });
      app.exit(ok ? 0 : 1);
    } catch (err) {
      emit({ ok: false, error: err.message });
      app.exit(2);
    }
  });
}

app.on('window-all-closed', () => {
  if (HELPER_MODE) return; // 助手模式由 app.exit 控制退出
  downloader.cancelAll();
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------- IPC

ipcMain.handle('settings:get', () => ({ ...settings, toolsDir: process.env.VIDEOGRAB_TOOLS_DIR, version: app.getVersion() }));

ipcMain.handle('settings:save', (_e, patch) => {
  settings = { ...settings, ...patch };
  saveSettingsToDisk(settings);
  downloader.updateOptions({ ...settings });
  applyProxyToSessions(settings.proxy);
  return { ...settings };
});

/**
 * 代理自检：
 *  1. 把界面里填的地址**立即**应用到内置浏览器与内置下载引擎（不用重启）
 *  2. 分别用「直连」和「经代理」各探一次几个代表站点，给出明确结论
 * 自检通过会把该地址保存下来，下次启动继续用。
 */
ipcMain.handle('proxy:check', async (_e, proxy) => {
  const target = String(proxy === undefined || proxy === null ? settings.proxy : proxy).trim();
  try {
    await applyProxyToSessions(target);
    downloader.updateOptions({ ...settings, proxy: target });
    if (target !== settings.proxy) {
      settings = { ...settings, proxy: target };
      saveSettingsToDisk(settings);
    }
    const { checkProxy } = require('../core/proxy-check');
    const result = await checkProxy({ proxy: target });
    trace(`代理自检：${result.verdict}`);
    return { ...result, applied: true };
  } catch (err) {
    trace(`代理自检失败：${err.message}`);
    return { proxy: target, source: '', ok: false, verdict: `自检失败：${err.message}`, results: [], applied: false };
  }
});

/**
 * Pixiv 搜图（界面里的搜索框）：走公开检索接口 + pixiv.re 反代，**不需要代理**。
 * 与命令行 `--pixiv-search` 共用同一个实现（src/core/pixiv.js 的 searchAndDownloadPixiv），
 * 免得两条路各写一份、行为漂移。
 */
/**
 * Pixiv 搜图结果 → 界面用的条目（含预览图地址，界面「只列出」时靠它铺缩略图）。
 */
function mapPixivItem(r) {
  return {
    ok: r.ok,
    pid: r.pid,
    title: r.title,
    author: r.author,
    rating: r.rating,
    url: r.url,
    files: r.files ? r.files.length : 0,
    // 完整文件路径给界面做预览图用（只传数量的话界面没法显示图）
    fileList: Array.isArray(r.files) ? r.files.slice(0, 200) : [],
    dir: r.dir || '',
    bytes: r.bytes || 0,
    filePath: r.filePath || '',
    error: r.error || '',
    originalUrl: r.originalUrl || '',
    previewUrl: r.previewUrl || '',
    previewUrlHd: r.previewUrlHd || '',
  };
}

/**
 * Pixiv 的活儿也走「下载任务」那一套：进度条 + 完成/失败 + 下载记录。
 *
 * 原来搜图/挑图只在日志里留痕，右侧任务列表和「下载记录」栏里什么都没有 —— 用户看不出
 * 它在干活、也翻不到下过什么。这里把边界收成两个小助手：
 *   · `pixivTask(taskId).progress/done/error`：往渲染进程发 task:* 事件（与普通下载同格式）
 *   · `recordPixivHistory(results)`：一个作品记一条（每个作品有自己的子目录，分开更好用）
 */
function pixivTaskSender(taskId) {
  const id = String(taskId || '').trim();
  return {
    enabled: Boolean(id),
    progress(payload = {}) {
      if (!id) return;
      send('task:progress', {
        taskId: id,
        stage: 'download',
        percent: -1,
        bytes: 0,
        total: 0,
        speed: 0,
        eta: 0,
        live: false,
        done: false,
        ...payload,
      });
    },
    done(payload = {}) {
      if (!id) return;
      send('task:done', { taskId: id, ok: true, live: false, stopped: false, durationSec: 0, ...payload });
    },
    error(payload = {}) {
      if (!id) return;
      send('task:error', { taskId: id, cancelled: false, ...payload });
    },
  };
}

/** 把成功的作品一条一条记进「下载记录」（失败的不记，避免记录栏全是噪音） */
function recordPixivHistory(results = [], fallbackUrl = '') {
  for (const r of results) {
    if (!r || !r.ok) continue;
    try {
      downloader.recordHistory({
        url: r.url || fallbackUrl,
        title: `${r.title || '(无题)'}${r.author ? ` — ${r.author}` : ''}`,
        fileName: `${r.title || '(无题)'}（${r.files ? r.files.length : 0} 张）`,
        filePath: r.dir || r.filePath || '',
        bytes: r.bytes || 0,
        engine: 'pixiv',
        ok: true,
      });
    } catch {
      /* 记录写不进去不影响下载 */
    }
  }
}

ipcMain.handle('pixiv:search', async (_e, payload = {}) => {
  const { searchAndDownloadPixiv } = require('../core/pixiv');
  const keyword = String(payload.keyword || '').trim();
  const count = Math.max(1, Math.min(20, Number(payload.count) || 3));
  const allowR18 = Boolean(payload.allowR18);
  const listOnly = Boolean(payload.listOnly);
  if (!keyword) return { ok: false, error: '请先填搜索关键词' };

  const task = pixivTaskSender(payload.taskId);
  const startedAt = Date.now();
  const outDir = payload.outDir || settings.outDir;
  task.progress({ stage: 'probe', label: `Pixiv 搜图：${keyword}` });
  logNotice(
    `Pixiv 搜图：${keyword}（最多 ${count} 个作品${allowR18 ? '，含成人向' : '，只要全年龄'}${listOnly ? '，只列出' : ''}）`,
  );
  try {
    const out = await searchAndDownloadPixiv(keyword, {
      count,
      allowR18,
      listOnly,
      outDir,
      onLog: (m) => logNotice(`  ${m}`),
      onProgress: (p) => {
        if (!p) return;
        if (p.message) {
          logNotice(`  ${p.message}`);
          task.progress({ label: String(p.message) });
        }
      },
    });
    const okCount = out.results.filter((r) => r.ok).length;
    logNotice(
      out.items.length
        ? `搜图完成：命中 ${out.items.length} 个，成功 ${okCount} 个${listOnly ? '（只列出）' : ''}`
        : `没搜到作品${out.errors.length ? `（${out.errors.join('；')}）` : ''}`,
      { notice: true },
    );

    if (!out.items.length) {
      task.error({ error: out.errors.length ? out.errors.join('；') : '没有搜到作品' });
    } else if (!listOnly) {
      recordPixivHistory(out.results, `pixiv-search:${keyword}`);
      const okResults = out.results.filter((r) => r.ok);
      const totalBytes = okResults.reduce((sum, r) => sum + (r.bytes || 0), 0);
      const totalFiles = okResults.reduce((sum, r) => sum + (r.files ? r.files.length : 0), 0);
      const firstFile = okResults.find((r) => r.filePath)?.filePath || '';
      const firstDir = okResults[0]?.dir || outDir;
      if (okCount > 0) {
        task.done({
          title: `Pixiv：${keyword}`,
          fileName: `Pixiv 搜图「${keyword}」（${okCount} 个作品，${totalFiles} 张）`,
          filePath: firstFile || firstDir,
          outDir,
          bytes: totalBytes,
          durationMs: Date.now() - startedAt,
          engine: 'pixiv',
        });
      } else {
        task.error({ error: out.results.find((r) => !r.ok)?.error || '所有作品都取图失败了' });
      }
    } else {
      // 只列出：没有真正下载，任务卡收尾成"完成（只列出）"，不写下载记录
      task.done({
        title: `Pixiv 只列出：${keyword}`,
        fileName: `Pixiv 检索「${keyword}」（${out.items.length} 个作品，未下载）`,
        filePath: outDir,
        outDir,
        bytes: 0,
        durationMs: Date.now() - startedAt,
        engine: 'pixiv 检索',
      });
    }

    return {
      ok: out.items.length > 0,
      keyword,
      backend: out.backend,
      errors: out.errors,
      dir: outDir,
      items: out.results.map((r) => mapPixivItem(r)),
    };
  } catch (err) {
    logNotice(`搜图失败：${err.message}`, { notice: true });
    task.error({ error: err.message });
    return { ok: false, error: err.message };
  }
});

/**
 * 缩略图缓存：key = 路径|修改时间|宽度 → data: URL。
 * 同一个关键词反复搜、或者窗口重绘都会重复要同一批图，不缓存就会反复解码几 MB 的原图。
 */
const THUMB_CACHE = new Map();
const THUMB_CACHE_MAX = 400;

/**
 * 把本地图片压成小预览图交给界面（搜图结束时展示用）。
 *
 * 为什么非要主进程做这两件事：
 *   ① 渲染进程的 CSP 是 `img-src 'self' data:`，`file://` 的本地图会被直接拦掉，只能走 `data:`；
 *   ② pixiv 原图动辄几 MB（16 万像素以上），不缩直接塞进 DOM，几十张就能把界面拖卡。
 * 所以统一缩到几百像素、编码成 JPEG（插画基本没有透明通道，肉眼看不出差别）。
 */
ipcMain.handle('pixiv:thumbs', async (_e, payload = {}) => {
  const files = (Array.isArray(payload.files) ? payload.files : [])
    .filter((f) => typeof f === 'string' && f.trim())
    .slice(0, 80);
  const width = Math.max(64, Math.min(512, Number(payload.width) || 220));
  const thumbs = [];
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      const key = `${file}|${Math.round(st.mtimeMs)}|${width}`;
      let dataUrl = THUMB_CACHE.get(key);
      if (!dataUrl) {
        const img = nativeImage.createFromPath(file);
        if (img.isEmpty()) continue;             // 不是图片 / 解不开
        const size = img.getSize();
        const small = size.width > width ? img.resize({ width, quality: 'good' }) : img;
        dataUrl = `data:image/jpeg;base64,${small.toJPEG(82).toString('base64')}`;
        THUMB_CACHE.set(key, dataUrl);
        if (THUMB_CACHE.size > THUMB_CACHE_MAX) {
          THUMB_CACHE.delete(THUMB_CACHE.keys().next().value);   // 先塞进来的先淘汰
        }
      }
      thumbs.push({ file, name: path.basename(file), bytes: st.size, dataUrl });
    } catch {
      /* 单张失败不影响其它图 */
    }
    // 解码是大图里最费时的一步：每张之间让一让事件循环，窗口不会卡住
    await new Promise((r) => setImmediate(r));
  }
  return { ok: true, width, thumbs };
});

/**
 * 远端预览图 → data: URL（「只列出」时用）。
 *
 * 走的是反代的**缩略图**（`/c/240x480/img-master/...`，实测 60KB 上下；原图动辄几 MB），
 * 所以"列个表"不会把原图拉下来。抓不到就退回原图那张（只对少数反代不认缩略图的作品发生），
 * 仍然失败就返回空的预览，界面显示"没有预览"，不影响挑图与下载。
 * 用核心的 fetchBuffer 抓：它认代理设置，且这些图**不需要 Referer**。
 */
ipcMain.handle('pixiv:previews', async (_e, payload = {}) => {
  const { fetchBuffer } = require('../core/http');
  const list = (Array.isArray(payload.items) ? payload.items : []).slice(0, 40);
  const width = Math.max(96, Math.min(512, Number(payload.width) || 260));
  const previews = [];

  const grab = async (url) => {
    if (!url) return '';
    const key = `${url}|${width}`;
    const hit = THUMB_CACHE.get(key);
    if (hit) return hit;
    const { buffer } = await fetchBuffer(url, { timeout: 25000, retries: 1 });
    const img = nativeImage.createFromBuffer(buffer);
    if (img.isEmpty()) return '';
    const size = img.getSize();
    const small = size.width > width ? img.resize({ width, quality: 'good' }) : img;
    const dataUrl = `data:image/jpeg;base64,${small.toJPEG(82).toString('base64')}`;
    THUMB_CACHE.set(key, dataUrl);
    if (THUMB_CACHE.size > THUMB_CACHE_MAX) THUMB_CACHE.delete(THUMB_CACHE.keys().next().value);
    return dataUrl;
  };

  // 反代一张要两三秒，串行铺十几张会让人以为卡死；并发 4 条既快又不至于把反代惹毛
  const queue = [...list];
  const workers = Array.from({ length: Math.min(4, queue.length || 1) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      const start = Date.now();
      let dataUrl = '';
      try {
        dataUrl = await grab(item.previewUrl);
        if (!dataUrl) dataUrl = await grab(item.originalUrl);   // 缩略图不认就退回原图
      } catch {
        dataUrl = '';
      }
      previews.push({
        pid: String(item.pid || ''),
        dataUrl,
        ms: Date.now() - start,
      });
    }
  });
  await Promise.all(workers);
  return { ok: true, width, previews };
});

/**
 * 下载**选中的**作品（界面「只列出」→ 勾选/全选 → 下载选中）。
 * 与搜图那条下载链路共用 src/core/pixiv.js 的实现，行为一致（每个作品一个子目录、
 * 多图作品逐页补齐）。
 */
ipcMain.handle('pixiv:download', async (_e, payload = {}) => {
  const { downloadPixivWorks } = require('../core/pixiv');
  const items = (Array.isArray(payload.items) ? payload.items : []).slice(0, 50);
  if (!items.length) return { ok: false, error: '没有选中任何作品' };
  const task = pixivTaskSender(payload.taskId);
  const startedAt = Date.now();
  const outDir = payload.outDir || settings.outDir;
  task.progress({ stage: 'probe', label: `下载选中的 ${items.length} 个作品` });
  logNotice(`Pixiv 下载选中：${items.length} 个作品 → ${outDir}`);
  try {
    const out = await downloadPixivWorks(items, {
      outDir,
      onLog: (m) => logNotice(`  ${m}`),
      onProgress: (p) => {
        if (!p) return;
        if (p.message) {
          logNotice(`  ${p.message}`);
          task.progress({ label: String(p.message) });
        }
      },
    });
    const okCount = out.results.filter((r) => r.ok).length;
    logNotice(`下载完成：成功 ${okCount}/${out.results.length} 个${okCount ? '' : '（见上面的日志）'}`, { notice: true });
    recordPixivHistory(out.results, `pixiv-pick:${items.length}`);
    const okResults = out.results.filter((r) => r.ok);
    const totalBytes = okResults.reduce((sum, r) => sum + (r.bytes || 0), 0);
    const totalFiles = okResults.reduce((sum, r) => sum + (r.files ? r.files.length : 0), 0);
    if (okCount > 0) {
      task.done({
        title: `Pixiv 下载选中（${okCount} 个）`,
        fileName: `Pixiv 下载选中：${okCount} 个作品，${totalFiles} 张`,
        filePath: okResults.find((r) => r.filePath)?.filePath || okResults[0]?.dir || outDir,
        outDir,
        bytes: totalBytes,
        durationMs: Date.now() - startedAt,
        engine: 'pixiv',
      });
    } else {
      task.error({ error: out.results.find((r) => !r.ok)?.error || '所有作品都取图失败了' });
    }
    return { ok: true, dir: outDir, items: out.results.map((r) => mapPixivItem(r)) };
  } catch (err) {
    logNotice(`下载选中失败：${err.message}`, { notice: true });
    task.error({ error: err.message });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('dialog:pickDir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择保存目录',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: settings.outDir,
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('dialog:pickCookies', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择 cookies.txt',
    properties: ['openFile'],
    filters: [{ name: 'Cookies', extensions: ['txt'] }, { name: '所有文件', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('probe', async (_e, url) => {
  try {
    const info = await downloader.inspect(url);
    return {
      ok: true,
      url: info.url,
      finalUrl: info.finalUrl,
      type: info.type,
      title: info.title,
      filename: info.filename,
      contentType: info.contentType,
      contentLength: info.contentLength,
      candidates: (info.candidates || []).slice(0, 8),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('formats', async (_e, url) => {
  try {
    return await downloader.formats(url);
  } catch (err) {
    return { error: err.message, formats: [] };
  }
});

ipcMain.handle('download:start', async (_e, { url, options = {} }) => {
  const taskId = randomId('ui');
  const merged = {
    ...settings,
    ...options,
    outDir: options.outDir || settings.outDir,
    overwrite: options.overwrite ?? settings.overwrite,
  };
  downloader.updateOptions(merged);
  downloader
    .download(url, { ...merged, taskId })
    .catch((err) => send('task:error', { taskId, url, error: err.message }));
  return { taskId, outDir: merged.outDir };
});

ipcMain.handle('download:cancel', (_e, taskId) => downloader.cancel(taskId));
ipcMain.handle('download:cancelAll', () => {
  downloader.cancelAll();
  return true;
});

ipcMain.handle('tools:status', () => {
  const s = downloader.status();
  return {
    ...s,
    ytDlpSize: s.ytDlp && fs.existsSync(s.ytDlp) ? fs.statSync(s.ytDlp).size : 0,
    ffmpegSize: s.ffmpeg && fs.existsSync(s.ffmpeg) ? fs.statSync(s.ffmpeg).size : 0,
  };
});

ipcMain.handle('tools:getYtDlp', async () => {
  try {
    const p = await downloader.setupYtDlp({ toolsDir: process.env.VIDEOGRAB_TOOLS_DIR });
    return { ok: true, path: p };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('tools:updateYtDlp', async () => {
  try {
    const p = await downloader.updateYtDlp({ toolsDir: process.env.VIDEOGRAB_TOOLS_DIR });
    return { ok: true, path: p };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('tools:getFfmpeg', async () => {
  try {
    const p = await downloader.setupFfmpeg({ toolsDir: process.env.VIDEOGRAB_TOOLS_DIR });
    return { ok: true, path: p };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('shell:openPath', async (_e, p) => {
  if (!p || !fs.existsSync(p)) return { ok: false, error: '文件不存在' };
  const err = await shell.openPath(p);
  return err ? { ok: false, error: err } : { ok: true };
});

ipcMain.handle('shell:showItem', (_e, p) => {
  if (!p || !fs.existsSync(p)) return { ok: false, error: '文件不存在' };
  shell.showItemInFolder(p);
  return { ok: true };
});

ipcMain.handle('shell:openFolder', async (_e, p) => {
  const target = p && fs.existsSync(p) ? p : settings.outDir;
  const err = await shell.openPath(target);
  return err ? { ok: false, error: err } : { ok: true };
});

// ---------------------------------------------------------------- 文本里提取链接

ipcMain.handle('urls:extract', (_e, text) => {
  const input = String(text == null ? '' : text);
  const urls = extractUrls(input);
  // 除了链接之外还有别的内容（例如抖音分享文案里的中文和话题标签）
  const rest = urls.reduce((acc, u) => acc.split(u).join(' '), input).replace(/https?:\/\/\S+/gi, ' ').trim();
  return { urls, noisy: rest.length > 0, textLength: input.trim().length };
});

// ---------------------------------------------------------------- 下载历史

ipcMain.handle('history:list', (_e, limit) => {
  const max = normalizeHistoryLimit(limit || settings.historyLimit);
  return { ok: true, limit: max, file: historyFile(), records: loadHistory(max) };
});

ipcMain.handle('history:setLimit', async (_e, limit) => {
  const max = normalizeHistoryLimit(limit);
  settings = { ...settings, historyLimit: max };
  saveSettingsToDisk(settings);
  downloader.updateOptions({ ...settings });
  const res = await setHistoryLimit(max);
  return { ok: true, limit: max, count: res.records.length };
});

ipcMain.handle('history:remove', async (_e, id) => {
  const records = await removeHistory(id);
  return { ok: true, count: records.length };
});

ipcMain.handle('history:clear', async () => {
  await clearHistory();
  return { ok: true };
});

ipcMain.handle('history:add', async (_e, record) => {
  // 供自检/外部调用：手动写一条记录
  const records = await appendHistory(record, settings.historyLimit);
  return { ok: true, count: records.length };
});

ipcMain.handle('history:file', () => historyFile());

// ---------------------------------------------------------------- 剪贴板（输入框右键菜单）

ipcMain.handle('clipboard:read', () => ({ ok: true, text: clipboard.readText() }));

ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(String(text == null ? '' : text));
  return { ok: true };
});

// ---------------------------------------------------------------- 登录

ipcMain.handle('login:sites', () => Object.entries(LOGIN_SITES).map(([key, v]) => ({ key, ...v })));

ipcMain.handle('login:status', () => {
  const file = loginCookiesFile();
  let count = 0;
  const domains = new Set();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const parts = line.split('\t');
      if (parts.length < 7) continue;
      count += 1;
      domains.add(String(parts[0]).replace(/^\./, '').toLowerCase());
    }
  } catch {
    /* 还没有登录文件 */
  }
  return {
    loggedIn: count > 0,
    file,
    count,
    domains: domains.size,
    domainList: [...domains].slice(0, 15),
    cookiesFile: settings.cookiesFile || '',
  };
});

ipcMain.handle('login:start', async (_e, site) => {
  const target = resolveLoginTarget(site);
  try {
    const res = await openLoginWindowInProcess(
      { BrowserWindow, session },
      {
        site,
        outFile: loginCookiesFile(),
        autoCloseSec: Number(process.env.VIDEOGRAB_LOGIN_AUTOCLOSE || 0),
        onLog: (m) => send('log', { taskId: null, message: m, notice: true, time: Date.now() }),
      },
    );
    // 登录后让所有下载默认使用这份 Cookie
    settings = { ...settings, cookiesFile: loginCookiesFile() };
    saveSettingsToDisk(settings);
    downloader.updateOptions({ ...settings });
    send('login:changed', {
      loggedIn: res.count > 0,
      count: res.count,
      file: loginCookiesFile(),
      domains: (res.domains || []).length,
    });
    logNotice(
      `已保存「${target.name}」的登录状态：${res.count} 项 Cookie、${(res.domains || []).length} 个域名。` +
        '可以继续点「登录」添加其它站点，已登录的站点会一直保留，下载时按域名自动带上。',
    );
    return {
      ok: res.count > 0,
      count: res.count,
      file: loginCookiesFile(),
      site: target.name,
      domains: (res.domains || []).slice(0, 12),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('login:clear', async () => {
  try {
    const res = await clearLoginInProcess({ BrowserWindow, session }, { outFile: loginCookiesFile(), partition: LOGIN_PARTITION });
    if ((settings.cookiesFile || '') === loginCookiesFile()) {
      settings = { ...settings, cookiesFile: '' };
      saveSettingsToDisk(settings);
      downloader.updateOptions({ ...settings });
    }
    send('login:changed', { loggedIn: false, count: 0, file: loginCookiesFile() });
    return { ok: true, cleared: res.cleared };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('app:info', () => ({  version: app.getVersion(),
  electron: process.versions.electron,
  node: process.versions.node,
  chrome: process.versions.chrome,
  userData: USER_DATA,
  toolsDir: process.env.VIDEOGRAB_TOOLS_DIR,
  outDir: settings.outDir,
  formatBytesSample: formatBytes(1024 * 1024),
}));
