'use strict';

/**
 * 登录支持：用应用内置的 Chromium 打开站点登录页（扫码/账号登录都行），
 * 登录状态保存在持久化的会话里，并导出成 Netscape cookies.txt 供 yt-dlp 与内置下载引擎使用。
 *
 * 好处：不需要装导出插件、不需要关闭正在用的浏览器（它们的 Cookie 库被独占锁定读不了）、
 * 登录一次之后一直有效（高画质 / 大会员 / 需要登录的内容都能下）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { ensureDir, electronChildEnv } = require('./util');
const { guardWebContents } = require('./browser-guard');

/** 会话分区名：与内置浏览器抓流、取 Cookie 共用，登录后抓流也是登录态 */
const LOGIN_PARTITION = 'persist:vgrab-cookies';

/** 常用站点（key 供命令行 --login 使用）；不在这里的站点直接传网址即可 */
const LOGIN_SITES = {
  bilibili: { name: '哔哩哔哩', url: 'https://www.bilibili.com/' },
  douyin: { name: '抖音', url: 'https://www.douyin.com/' },
  youtube: { name: 'YouTube', url: 'https://www.youtube.com/' },
  kuaishou: { name: '快手', url: 'https://www.kuaishou.com/' },
  weibo: { name: '微博', url: 'https://weibo.com/' },
  xiaohongshu: { name: '小红书', url: 'https://www.xiaohongshu.com/' },
  twitter: { name: 'X / Twitter', url: 'https://x.com/' },
  instagram: { name: 'Instagram', url: 'https://www.instagram.com/' },
  tiktok: { name: 'TikTok', url: 'https://www.tiktok.com/' },
  zhihu: { name: '知乎', url: 'https://www.zhihu.com/' },
  youku: { name: '优酷', url: 'https://www.youku.com/' },
  iqiyi: { name: '爱奇艺', url: 'https://www.iqiyi.com/' },
  tencentvideo: { name: '腾讯视频', url: 'https://v.qq.com/' },
  twitch: { name: 'Twitch', url: 'https://www.twitch.tv/' },
};

/** 把 Electron cookies.get() 的结果写成 Netscape cookies.txt */
function writeNetscapeCookies(cookies, file) {
  const lines = ['# Netscape HTTP Cookie File', '# 由肥鱼当劳（ds-download）的内置浏览器导出（登录状态）', ''];
  let count = 0;
  for (const c of cookies || []) {
    if (!c || !c.name || c.value == null) continue;
    const domain = c.domain || '';
    if (!domain) continue;
    lines.push(
      [
        domain,
        domain.startsWith('.') ? 'TRUE' : 'FALSE',
        c.path || '/',
        c.secure ? 'TRUE' : 'FALSE',
        Math.floor(c.expirationDate || 0),
        c.name,
        c.value,
      ].join('\t'),
    );
    count += 1;
  }
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return count;
}

/** 解析站点参数：支持内置站点名或任意网址 */
function resolveLoginTarget(siteOrUrl) {
  const raw = String(siteOrUrl || '').trim();
  if (!raw) return { name: '哔哩哔哩', url: LOGIN_SITES.bilibili.url };
  const key = raw.toLowerCase();
  if (LOGIN_SITES[key]) return { name: LOGIN_SITES[key].name, url: LOGIN_SITES[key].url };
  if (/^https?:\/\//i.test(raw)) return { name: raw.replace(/^https?:\/\//, '').split('/')[0], url: raw };
  if (/^[\w-]+(\.[\w-]+)+/.test(raw)) return { name: raw.split('/')[0], url: `https://${raw}` };
  return { name: LOGIN_SITES.bilibili.name, url: LOGIN_SITES.bilibili.url };
}

/**
 * 在 Electron 主进程里打开登录窗口（可见），用户登录完成后关闭窗口即完成。
 * @param {object} electron { BrowserWindow, session }
 */
async function openLoginWindowInProcess(electron, opts = {}) {
  const { BrowserWindow, session } = electron;
  const target = resolveLoginTarget(opts.site || opts.url);
  const outFile = opts.outFile;
  const autoCloseSec = Number(opts.autoCloseSec || 0);
  const onLog = opts.onLog || (() => {});
  const userAgent = opts.userAgent;

  const ses = session.fromPartition(opts.partition || LOGIN_PARTITION);
  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    title: `登录 ${target.name} — 登录完成后关闭本窗口即可`,
    autoHideMenuBar: true,
    webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false },
  });
  // 登录页里也常有「用 App 打开」深链；拦掉自定义协议，允许 https 弹窗（部分站点用弹窗走 OAuth）
  guardWebContents(win.webContents, { allowHttpPopups: true, onBlock: onLog });

  let closed = false;
  const closedPromise = new Promise((resolve) => {
    win.once('closed', () => {
      closed = true;
      resolve();
    });
  });

  onLog(`已打开 ${target.name} 登录窗口，请扫码或输入账号登录；登录完成后直接关闭这个窗口`);
  try {
    await win.loadURL(target.url, userAgent ? { userAgent } : undefined);
  } catch (err) {
    onLog(`页面加载提示：${err.message}`);
  }

  if (autoCloseSec > 0) {
    setTimeout(() => {
      if (!closed) {
        try {
          win.close();
        } catch {
          /* ignore */
        }
      }
    }, autoCloseSec * 1000);
  }

  await closedPromise;

  const cookies = await ses.cookies.get({});
  const count = outFile ? writeNetscapeCookies(cookies, outFile) : 0;
  const domains = [...new Set(cookies.map((c) => String(c.domain || '').replace(/^\./, '')))].filter(Boolean);
  onLog(`登录状态已保存：${count} 个 Cookie（来自 ${domains.length} 个域名）`);
  return { count, outFile, domains, site: target.name, url: target.url };
}

/** 找到可用的 Electron 可执行文件 */
function findElectron(appRoot) {
  const candidates = [];
  if (process.env.VIDEOGRAB_ELECTRON) candidates.push(process.env.VIDEOGRAB_ELECTRON);
  // 打包版（resources/app + 改名后的 exe）里没有 node_modules，但**当前进程自己就是**
  // 那个 Electron 二进制：命令行是用 `ELECTRON_RUN_AS_NODE=1 ds-download.exe cli.js` 跑的，
  // 这时 process.execPath 就是要找的可执行文件（辅助进程用得着它）。
  if (process.versions && process.versions.electron && process.execPath) {
    candidates.push(process.execPath);
  }
  if (appRoot) {
    candidates.push(path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe'));
    candidates.push(path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron'));
    // 便携包：exe 就在 resources/app 往上两级（改名前的旧名字也认，省得旧包失效）
    for (const name of ['ds-download.exe', '肥鱼当劳.exe', '视频下载工具.exe', 'videograb.exe']) {
      candidates.push(path.join(appRoot, '..', '..', name));
    }
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'ds-download', 'ds-download.exe'));
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'videograb', 'videograb.exe'));
  }
  for (const c of candidates) {
    try {
      if (c && fs.statSync(c).isFile()) return c;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

/** 命令行场景：拉起 Electron 打开登录窗口，用户关闭窗口后返回导出的 Cookie */
function openLoginWindowViaElectron({ appRoot, site, url, outFile, onLog = () => {}, signal, electronPath, autoCloseSec = 0 }) {
  const autoClose = autoCloseSec || Number(process.env.VIDEOGRAB_LOGIN_AUTOCLOSE || 0);
  return new Promise((resolve, reject) => {
    const bin = electronPath || findElectron(appRoot);
    if (!bin) {
      reject(new Error('找不到内置浏览器（Electron），无法打开登录窗口'));
      return;
    }
    const reportFile = `${outFile}.json`;
    onLog('正在启动内置浏览器登录窗口...');
    const child = spawn(bin, [appRoot, '--user-data-dir', path.join(os.tmpdir(), 'vgrab-browser-profile')], {
      windowsHide: false,
      env: electronChildEnv({
        VIDEOGRAB_LOGIN_SITE: site || '',
        VIDEOGRAB_LOGIN_URL: url || '',
        VIDEOGRAB_LOGIN_OUT: outFile,
        VIDEOGRAB_LOGIN_AUTOCLOSE: String(autoClose || 0),
      }),
    });
    let output = '';
    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d) => {
      output += d.toString();
    });
    child.stderr?.on('data', (d) => {
      output += d.toString();
    });
    child.on('error', (err) => reject(new Error(`启动登录窗口失败：${err.message}`)));
    child.on('close', () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(new Error('已取消'));
        return;
      }
      try {
        const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
        if (report && report.count > 0) {
          resolve(report);
          return;
        }
        reject(new Error(report && report.error ? report.error : '没有拿到任何 Cookie（可能没登录成功）'));
      } catch {
        reject(new Error(`登录窗口异常结束${output ? `：${output.trim().slice(-200)}` : ''}`));
      }
    });
  });
}

/** 清空登录状态（会话分区 + cookies 文件） */
async function clearLoginInProcess(electron, { partition = LOGIN_PARTITION, outFile } = {}) {
  const ses = electron.session.fromPartition(partition);
  const cookies = await ses.cookies.get({});
  for (const c of cookies) {
    try {
      const url = `${c.secure ? 'https' : 'http'}://${String(c.domain || '').replace(/^\./, '')}${c.path || '/'}`;
      await ses.cookies.remove(url, c.name);
    } catch {
      /* ignore */
    }
  }
  const cleared = cookies.length;
  try {
    await ses.clearStorageData();
  } catch {
    /* ignore */
  }
  if (outFile) {
    try {
      fs.unlinkSync(outFile);
    } catch {
      /* ignore */
    }
  }
  return { cleared };
}

/** 从当前会话重新导出 Cookie（应用启动时刷新一次，保持文件不过期） */
async function exportSessionCookiesInProcess(electron, { outFile, partition = LOGIN_PARTITION, minCookies = 3 } = {}) {
  const ses = electron.session.fromPartition(partition);
  const cookies = await ses.cookies.get({});
  if (!cookies.length || cookies.length < minCookies) return { count: 0, outFile };
  const count = writeNetscapeCookies(cookies, outFile);
  return { count, outFile };
}

module.exports = {
  LOGIN_PARTITION,
  LOGIN_SITES,
  resolveLoginTarget,
  writeNetscapeCookies,
  openLoginWindowInProcess,
  openLoginWindowViaElectron,
  clearLoginInProcess,
  exportSessionCookiesInProcess,
  findElectron,
};
