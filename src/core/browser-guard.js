'use strict';

/**
 * 内置浏览器（Chromium）窗口的导航守卫。
 *
 * 为什么需要：抖音等站点的页面里带着 `bytedance://`、`snssdk1128://`、`douyin://`
 * 这类「打开 App」的深链，Chromium 遇到不认识的协议会交给操作系统处理，
 * 于是 Windows 就会弹出「获取打开此链接的应用」对话框。
 * 隐藏窗口在渲染页面时被触发的话，用户会莫名看到这个弹窗，所以这里统一拦掉。
 */

/** 允许的协议：其余一律拦截 */
const SAFE_PROTOCOL = /^(https?|file|about|blob|data|chrome|chrome-extension|devtools|ws|wss):/i;

function isSafeUrl(url) {
  return SAFE_PROTOCOL.test(String(url || ''));
}

/**
 * 给一个 webContents 装上防护：
 *  - 拦截非 http(s) 的跳转（含 iframe 内的跳转）→ 不再弹系统的「选择应用」对话框
 *  - 默认拒绝所有新窗口；需要时可用 allowHttpPopups 放开 https 弹窗（登录场景）
 *
 * @param {object} contents Electron webContents
 * @param {object} [opts]
 * @param {boolean} [opts.allowHttpPopups=false]
 * @param {(msg:string)=>void} [opts.onBlock]
 */
function guardWebContents(contents, opts = {}) {
  const { allowHttpPopups = false, onBlock = () => {} } = opts;
  if (!contents || typeof contents.setWindowOpenHandler !== 'function') return contents;

  const note = (msg) => {
    try {
      onBlock(msg);
    } catch {
      /* 日志失败不影响拦截 */
    }
  };

  contents.setWindowOpenHandler(({ url }) => {
    const target = String(url || '');
    if (allowHttpPopups && /^https?:/i.test(target)) return { action: 'allow' };
    note(`已拦截新窗口：${target.slice(0, 110)}`);
    return { action: 'deny' };
  });

  const block = (event, url, kind) => {
    const target = String(url || '');
    if (isSafeUrl(target)) return;
    try {
      event.preventDefault();
    } catch {
      /* ignore */
    }
    note(`已拦截${kind}：${target.slice(0, 110)}（避免系统弹出「选择打开方式」对话框）`);
  };

  contents.on('will-navigate', (event, url) => block(event, url, '自定义协议跳转'));
  contents.on('will-redirect', (event, url) => block(event, url, '自定义协议跳转'));
  try {
    // Electron 27+：包含 iframe 内的跳转，抖音的深链多在 iframe / 脚本里触发
    contents.on('will-frame-navigate', (event) => {
      if (!event) return;
      block(event, event.url, '子框架自定义协议跳转');
    });
  } catch {
    /* 旧版本 Electron 没有该事件 */
  }
  return contents;
}

module.exports = { guardWebContents, isSafeUrl, SAFE_PROTOCOL };
