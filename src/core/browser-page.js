'use strict';

/**
 * 用内置浏览器（Electron/Chromium）渲染页面并抽取媒体信息。
 *
 * 为什么需要它：抖音等站点对非浏览器请求返回反爬验证页，而且 yt-dlp 的抖音提取器
 * 目前还没实现签名（源码里是 TODO），加了 Cookie 也拿不到数据。用真正的浏览器渲染后，
 * 可以直接从页面的结构化数据（_ROUTER_DATA / __pace_f 等）里取到视频直链。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { ensureDir, electronChildEnv } = require('./util');
const { findElectron } = require('./browser-login');
const { guardWebContents } = require('./browser-guard');
const { pickPostImages, extractImagesFromRouter, IMAGE_HOSTS } = require('./images');

/**
 * 在页面里执行的抽取脚本（返回结构化结果）。
 *
 * cfg.scroll：长文章/图集的图片是**懒加载**的（只有滚到附近才会真正出现在 DOM 里），
 * 所以抓图前要先从顶部滚到底部，把整页图片都触发出来 —— 否则只能抓到开头那几张。
 */
function buildExtractScript(cfg = {}) {
  const config = { scroll: Boolean(cfg.scroll), scrollStepMs: Number(cfg.scrollStepMs || 220), maxScrollMs: Number(cfg.maxScrollMs || 20000) };
  return `(async () => {
  const CFG = ${JSON.stringify(config)};
  const out = { title: document.title, href: location.href, router: null, videoSrcs: [], domUrls: [], images: [], scrolled: 0, bodyText: '' };
  try {
    // 页面正文开头（用于识别「人机验证 / 访问异常」这类风控页，标题常常还是正常的）
    out.bodyText = String((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').slice(0, 1500);
  } catch (e) { /* ignore */ }
  try {
    if (window._ROUTER_DATA) out.router = JSON.stringify(window._ROUTER_DATA);
  } catch (e) { /* ignore */ }
  try {
    document.querySelectorAll('video').forEach((v) => {
      if (v.src) out.videoSrcs.push(v.src);
      if (v.currentSrc) out.videoSrcs.push(v.currentSrc);
      v.querySelectorAll('source').forEach((s) => { if (s.src) out.videoSrcs.push(s.src); });
    });
  } catch (e) { /* ignore */ }
  try {
    const html = document.documentElement ? document.documentElement.innerHTML : '';
    const re = /https?:\\\\?\\/\\\\?\\/[^\\s"'\\\\<>]*(?:douyinvod|douyincdn|bytecdn|ixigua|aweme|video\\/tos)[^\\s"'\\\\<>]*/g;
    let m;
    let n = 0;
    while ((m = re.exec(html)) && n < 400) {
      out.domUrls.push(m[0].replace(/\\\\u002F/g, '/').replace(/\\\\\\//g, '/'));
      n += 1;
    }
  } catch (e) { /* ignore */ }

  // 长文章/图集：先滚一遍触发懒加载，图片才会真正进入 DOM
  if (CFG.scroll) {
    try {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const deadline = Date.now() + CFG.maxScrollMs;
      let lastHeight = 0;
      let stable = 0;
      let y = 0;
      const startY = window.scrollY || 0;
      while (Date.now() < deadline) {
        const height = Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement ? document.documentElement.scrollHeight : 0);
        const view = window.innerHeight || 900;
        y = Math.min(height, y + Math.round(view * 0.9));
        window.scrollTo(0, y);
        out.scrolled = y;
        if (height === lastHeight && y >= height - view) {
          stable += 1;
          if (stable >= 3) break; // 到底且不再长高，说明加载完了
        } else {
          stable = 0;
        }
        lastHeight = height;
        await sleep(CFG.scrollStepMs);
      }
      window.scrollTo(0, startY);
      await sleep(200);
    } catch (e) { /* ignore */ }
  }

  // 图文帖：收集正文大图（跳过小图标/头像，尺寸靠 naturalWidth/Height 判断，懒加载图看 data-src）
  // 顺便带上祖先链，便于排查「抓到的是正文图还是推荐流里的图」
  try {
    const chainOf = (el) => {
      const parts = [];
      let n = el;
      let d = 0;
      while (n && n !== document.body && d < 6) {
        const tag = n.tagName ? n.tagName.toLowerCase() : '?';
        const e2e = n.getAttribute ? n.getAttribute('data-e2e') : '';
        const cls = typeof n.className === 'string' ? n.className.split(/\\s+/).slice(0, 2).join('.') : '';
        parts.push(tag + (e2e ? '[' + e2e + ']' : '') + (cls ? '.' + cls : ''));
        n = n.parentElement;
        d += 1;
      }
      return parts.join('<');
    };
    // 所有祖先上的 data-e2e（抖音用这个标记语义节点，比混淆后的 class 稳定）
    const e2ePathOf = (el) => {
      const marks = [];
      let n = el;
      let d = 0;
      while (n && n !== document.body && d < 14) {
        const e2e = n.getAttribute ? n.getAttribute('data-e2e') : '';
        if (e2e) marks.push(e2e);
        n = n.parentElement;
        d += 1;
      }
      return marks.join('>');
    };
    // 图片来源区域：正文（note-detail）/ 评论区 / 私信 / 其它
    const scopeOf = (e2e) => {
      if (/comment-item|comment-list|conversation-item|live-avatar/.test(e2e)) return 'junk';
      if (/note-detail/.test(e2e)) return 'note';
      return e2e ? 'other' : 'plain';
    };
    document.querySelectorAll('img').forEach((img) => {
      const src = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-original') || '';
      if (!src || /^data:|^blob:/i.test(src)) return;
      const w = img.naturalWidth || Number(img.getAttribute('width')) || 0;
      const h = img.naturalHeight || Number(img.getAttribute('height')) || 0;
      if (w && h && (w < 500 || h < 500)) return; // 小图基本是头像/图标
      const e2e = e2ePathOf(img);
      out.images.push({ url: src, width: w, height: h, chain: chainOf(img), e2e, scope: scopeOf(e2e) });
    });
  } catch (e) { /* ignore */ }

  // 图文帖：正文图是「图片播放器」的轮播，同一时刻 DOM 里只有当前这一张，
  // 而且页面右侧还挂着推荐流/作者其它作品的封面。逐张翻页收集这篇帖子自己的图最准。
  try {
    const detail = document.querySelector('[data-e2e="note-detail"]');
    const nextBtn = () => document.querySelector('[data-e2e="video-switch-next-arrow"]');
    const currentSlide = () => {
      const imgs = [...detail.querySelectorAll('img')];
      const big = imgs.find((i) => /aweme-images|aweme_images/i.test(i.currentSrc || i.src || ''));
      return big ? (big.currentSrc || big.src) : '';
    };
    if (detail && nextBtn()) {
      const slides = [];
      const deadline = Date.now() + 15000;
      let stale = 0;
      while (Date.now() < deadline && slides.length < 60) {
        const url = currentSlide();
        if (url && !slides.includes(url)) {
          slides.push(url);
          stale = 0;
        } else {
          stale += 1;
        }
        const btn = nextBtn();
        const disabled = !btn || /disabled/.test(String(btn.className || ''));
        if (disabled) {
          if (stale >= 4) break;
        } else {
          btn.click();
        }
        await new Promise((r) => setTimeout(r, 700));
      }
      out.slides = slides.map((url) => ({ url, scope: 'slide' }));
    }
  } catch (e) { /* ignore */ }
  return out;
})()`;
}

/** 默认（不滚动）的抽取脚本，供调试模式使用 */
const PAGE_EXTRACT_SCRIPT = buildExtractScript();

/** 递归查找形如 { url_list: [...] } 的播放地址，并带上清晰度信息 */
function collectUrlLists(node, out, hint = {}, depth = 0) {
  if (!node || depth > 12 || out.length > 200) return;
  if (Array.isArray(node)) {
    for (const item of node) collectUrlLists(item, out, hint, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  const gear = node.gear_name || node.quality_type || node.bit_rate || hint.gear;
  if (Array.isArray(node.url_list) && node.url_list.length) {
    for (const u of node.url_list) {
      if (typeof u === 'string' && /^https?:/.test(u)) out.push({ url: u, gear: gear ? String(gear) : '', bytes: node.data_size || 0 });
    }
  }
  if (Array.isArray(node.urlList) && node.urlList.length) {
    for (const u of node.urlList) {
      if (typeof u === 'string' && /^https?:/.test(u)) out.push({ url: u, gear: gear ? String(gear) : '', bytes: 0 });
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') collectUrlLists(v, out, { gear: gear || hint.gear }, depth + 1);
  }
}

/** 从浏览器返回的页面数据里解析出可下载的视频候选（按清晰度优先） */
function extractMediaFromPageData(data) {
  const found = [];
  for (const u of data.networkUrls || []) found.push({ url: u, gear: '网络请求', bytes: 0 });
  if (data.router) {
    try {
      const json = JSON.parse(data.router);
      collectUrlLists(json, found);
    } catch {
      /* ignore */
    }
  }
  for (const u of data.videoSrcs || []) found.push({ url: u, gear: 'video元素', bytes: 0 });
  for (const u of data.domUrls || []) found.push({ url: u, gear: '', bytes: 0 });

  const seen = new Set();
  const out = [];
  for (const item of found) {
    let key = item.url.split('&')[0];
    try {
      const u = new URL(item.url);
      key = `${u.host}${u.pathname}`;
    } catch {
      /* ignore */
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  // 视频（含 .mp4 / mime_type=video）优先，其次按清晰度关键词排序
  const score = (i) => {
    let s = 0;
    const gear = String(i.gear || '').toLowerCase();
    const url = i.url.toLowerCase();
    if (/video_mp4|\.mp4|mime_type=video/.test(url) || /mp4/.test(url)) s += 100;
    const m = /(\d{3,4})p/.exec(gear);
    if (m) s += Number(m[1]);
    if (/1080|hd/.test(gear)) s += 50;
    if (/audio|music/.test(url)) s -= 200;
    if (i.bytes) s += 1;
    return s;
  };
  out.sort((a, b) => score(b) - score(a));
  return out;
}

/** 给一个 Promise 加超时，避免页面卡住导致辅助进程一直不退出 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label || '操作'}超时（${Math.round(ms / 1000)} 秒）`)), ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** 判断一个网络请求地址是否可能是视频媒体流 */
function isMediaUrl(u) {
  const url = String(u || '');
  if (!/^https?:/i.test(url)) return false;
  if (/\.(jpe?g|png|webp|gif|svg|ico|css|js|json|woff2?|ttf)(\?|$)/i.test(url)) return false;
  if (/mime_type=(video|audio)|\.mp4(\?|$)|\.m4s(\?|$)|\.m4a(\?|$)|\.flv(\?|$)|douyinvod|douyincdn|bytecdn|video\/tos|aweme\/v1\/play/i.test(url)) {
    return true;
  }
  return false;
}

/** 判断一个网络请求地址是否可能是正文图片（图文帖用） */
function isImageUrl(u) {
  const url = String(u || '');
  if (!/^https?:/i.test(url)) return false;
  // 图片 CDN 上同样挂着 js/css/json 等前端资源（B 站的 s1.hdslb.com 尤其多），别当成图片
  if (/\.(js|mjs|css|json|html?|woff2?|ttf|wasm|map|xml|txt)(\?|$)/i.test(url)) return false;
  if (/\.(jpe?g|png|webp|gif|avif|bmp)(\?|$)/i.test(url)) return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return IMAGE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** 是否为音轨（抖音等站点的音视频是分开的两条流） */
function isAudioMediaUrl(u) {
  const url = String(u || '');
  if (/mime_type=audio|media-audio|\/audio\/|audio_mp4|\.m4a(\?|$)|\.mp3(\?|$)/i.test(url)) return true;
  if (/mime_type=video|\.mp4(\?|$)|\.m4s(\?|$)|video\/tos/i.test(url)) return false;
  return false;
}

/** 在 Electron 里渲染页面并抽取（供主进程直接调用） */
async function extractPageMediaInProcess(
  { BrowserWindow, session },
  {
    url,
    waitSec = 8,
    partition = 'persist:vgrab-cookies',
    userAgent,
    onLog = () => {},
    maxWaitSec = 30,
    loadTimeoutMs = 25000,
    loadImages = false,
    scroll = false,
  },
) {
  const ses = session.fromPartition(partition);
  // 图文帖要真正加载图片，轮播里的 <img> 才会从占位图换成真实地址
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { session: ses, images: loadImages } });
  // 默认 UA 里带 "Electron/38" 这种字样，B 站等站点会据此判定为自动化访问（弹验证码），去掉更接近普通 Chrome
  const cleanUa = String(userAgent || win.webContents.getUserAgent()).replace(/\sElectron\/[\d.]+/i, '').trim();
  try {
    win.webContents.setUserAgent(cleanUa);
  } catch {
    /* ignore */
  }
  // 拦掉 bytedance:// 等深链，否则渲染抖音页面时会弹出系统的「选择打开方式」对话框
  guardWebContents(win.webContents, { onBlock: onLog });
  // 诊断信息：页面崩了/卡了要能看见，否则只会表现为「没抓到东西」
  win.webContents.on('render-process-gone', (_e, details) => onLog(`渲染进程异常退出：${JSON.stringify(details)}`));
  win.webContents.on('unresponsive', () => onLog('页面暂时无响应（继续等待）'));
  win.webContents.on('did-fail-load', (_e, code, desc, failedUrl) => {
    if (code !== -3) onLog(`页面加载失败：${code} ${desc} ${String(failedUrl || '').slice(0, 90)}`);
  });
  const networkUrls = [];
  const networkImages = [];
  const listener = (details, callback) => {
    try {
      if (isMediaUrl(details.url)) networkUrls.push(details.url);
      else if (isImageUrl(details.url)) networkImages.push(details.url);
    } catch {
      /* ignore */
    }
    callback({});
  };
  try {
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, listener);
  } catch {
    /* ignore */
  }
  try {
    onLog(`正在用内置浏览器打开 ${url}（等待页面渲染与播放器加载）...`);
    // 直播页面常常一直处于「加载中」，不能死等 did-finish-load；
    // 三个条件先到先得：加载完成 / 已经抓到视频请求 / 等待超时
    let loadNote = '';
    const loadPromise = win.loadURL(url).catch((err) => {
      loadNote = `页面加载报错：${err.message}`;
    });
    const mediaSeen = new Promise((resolve) => {
      const timer = setInterval(() => {
        if (networkUrls.some((u) => !isAudioMediaUrl(u))) {
          clearInterval(timer);
          resolve('media');
        }
      }, 500);
      setTimeout(() => {
        clearInterval(timer);
        resolve('timeout');
      }, loadTimeoutMs);
    });
    const first = await Promise.race([loadPromise.then(() => 'loaded'), mediaSeen]);
    if (first === 'media') onLog('页面还在加载，但已经抓到视频请求，提前进入提取');
    else if (first === 'timeout') loadNote = loadNote || `页面加载超过 ${Math.round(loadTimeoutMs / 1000)} 秒，继续尝试提取`;
    if (loadNote) onLog(loadNote);
    await new Promise((r) => setTimeout(r, waitSec * 1000));

    // 页面里的 <video> 常是懒加载，滚动 + 尝试播放，促使播放器去拉流
    try {
      await withTimeout(
        win.webContents.executeJavaScript(`(() => {
          window.scrollTo(0, 400);
          const v = document.querySelector('video');
          if (v) { v.muted = true; const p = v.play(); if (p && p.catch) p.catch(() => {}); }
          return true;
        })()`),
        6000,
        '触发播放',
      );
    } catch (err) {
      onLog(`触发播放失败（忽略）：${err.message}`);
    }
    // 等媒体请求出现（音视频分开时要等两条；拿到第一条后再等几秒补齐音轨即可）
    const deadline = Date.now() + maxWaitSec * 1000;
    const hasVideo = () => networkUrls.some((u) => !isAudioMediaUrl(u));
    const hasAudio = () => networkUrls.some((u) => isAudioMediaUrl(u));
    let firstSeenAt = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (networkUrls.length && !firstSeenAt) firstSeenAt = Date.now();
      if (hasVideo() && hasAudio()) break;
      if (firstSeenAt && Date.now() - firstSeenAt > 6000) break; // 已经抓到流了，再补等 6 秒
    }
    if (networkUrls.length) await new Promise((r) => setTimeout(r, 1500));

    // 页面太忙时 executeJavaScript 可能长时间不返回，加超时兜底，避免整个辅助进程卡死
    let data;
    try {
      // 图文帖模式下抽取脚本还要滚动整页 + 逐张翻轮播，超时要比普通视频页面宽松
      const extractTimeout = scroll ? 90000 : loadImages ? 45000 : 15000;
      if (scroll) onLog('正在滚动页面以加载全部图片...');
      data = await withTimeout(win.webContents.executeJavaScript(
        scroll || loadImages ? buildExtractScript({ scroll }) : PAGE_EXTRACT_SCRIPT,
      ), extractTimeout, '读取页面数据');
      if (scroll && data && typeof data.scrolled === 'number') onLog(`已滚动到 ${data.scrolled} 像素处收集图片`);
    } catch (err) {
      if (!networkUrls.length) throw err;
      onLog(`读取页面数据超时，改用已抓到的网络请求：${err.message}`);
      data = { title: '', href: win.webContents.getURL(), router: '', videoSrcs: [], domUrls: [], images: [] };
    }
    const media = extractMediaFromPageData({ ...data, networkUrls });
    // 图文帖：正文图片来自「轮播翻页 + 结构化数据 + 网络请求 + 页面里的 <img>」，轮播最准
    const slideCandidates = [];
    for (const item of data.slides || []) {
      slideCandidates.push(item);
      const slideUrl = typeof item === 'string' ? item : item && item.url;
      // 抖音同一张图同时有 webp / jpeg 两种编码：补一个 jpeg 变体（兼容性更好，取不到会被自动丢掉）
      if (slideUrl && /\.webp(\?|$)/i.test(slideUrl)) {
        slideCandidates.push({ url: slideUrl.replace(/\.webp(\?|$)/i, '.jpeg$1'), scope: 'slide' });
      }
    }
    const routerImages = [];
    if (data.router) {
      try {
        routerImages.push(...extractImagesFromRouter(JSON.parse(data.router)));
      } catch {
        /* ignore */
      }
    }
    const rawImages = [
      ...slideCandidates,
      ...routerImages,
      ...(data.images || []),
      ...networkImages.map((url) => ({ url })),
    ];
    // 排查「该下的图被过滤掉了」时用：把原始候选写出来（VIDEOGRAB_DUMP_IMAGES=路径）
    if (process.env.VIDEOGRAB_DUMP_IMAGES) {
      try {
        fs.writeFileSync(process.env.VIDEOGRAB_DUMP_IMAGES, JSON.stringify(rawImages, null, 1), 'utf8');
      } catch {
        /* ignore */
      }
    }
    const images = pickPostImages(rawImages);
    return {
      title: data.title || '',
      finalUrl: data.href || win.webContents.getURL(),
      media,
      images,
      slides: (data.slides || []).map((x) => (typeof x === 'string' ? x : x.url)),
      scrolled: Number(data.scrolled || 0),
      bodyText: String(data.bodyText || '').slice(0, 600),
      networkCount: networkUrls.length,
      rawLength: (data.router || '').length,
    };
  } finally {
    try {
      ses.webRequest.onBeforeRequest(null);
    } catch {
      /* ignore */
    }
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 在页面上下文里发起一次请求（同一个浏览器会话），返回响应文本。
 *
 * 为什么需要它：pixiv 前面挂着 Cloudflare，会按 TLS/HTTP 指纹把 Node 的请求一律 403
 * （`server: cloudflare` + 553 字节的 403 页面，换任何请求头都没用），只有真正的浏览器能过。
 * 这里直接借内置 Chromium 的指纹与 Cookie 去请求，代理也自动跟着走。
 */
async function fetchTextInBrowserInProcess(
  { BrowserWindow, session },
  { url, pageUrl, partition = 'persist:vgrab-cookies', onLog = () => {}, waitSec = 6, loadTimeoutMs = 25000 },
) {
  const ses = session.fromPartition(partition);
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: { session: ses, images: false },
  });
  // 同页面抽取：去掉 UA 里的 Electron 标识，避免被站点当成自动化访问
  try {
    win.webContents.setUserAgent(String(win.webContents.getUserAgent()).replace(/\sElectron\/[\d.]+/i, '').trim());
  } catch {
    /* ignore */
  }
  guardWebContents(win.webContents, { onBlock: onLog });
  try {
    onLog(`用内置浏览器打开 ${pageUrl} 后请求接口...`);
    await Promise.race([
      win.loadURL(pageUrl).catch((err) => onLog(`页面加载报错（继续）：${err.message}`)),
      new Promise((r) => setTimeout(r, loadTimeoutMs)),
    ]);
    await new Promise((r) => setTimeout(r, Math.max(0, waitSec) * 1000));
    const raw = await withTimeout(
      win.webContents.executeJavaScript(`(async () => {
        try {
          const res = await fetch(${JSON.stringify(url)}, { credentials: 'include', headers: { Accept: 'application/json, text/plain, */*' } });
          return JSON.stringify({ ok: true, status: res.status, text: await res.text() });
        } catch (err) {
          return JSON.stringify({ ok: false, error: String(err && err.message || err) });
        }
      })()`),
      30000,
      '浏览器内请求接口',
    );
    const parsed = JSON.parse(raw);
    if (!parsed.ok) throw new Error(`浏览器内请求失败：${parsed.error}`);
    if (parsed.status >= 400) throw new Error(`接口返回 HTTP ${parsed.status}`);
    return { status: parsed.status, text: parsed.text };
  } finally {
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
  }
}

/** 通过拉起 Electron 来做「浏览器内请求」（供命令行使用） */
function fetchTextViaElectron({ appRoot, url, pageUrl, onLog = () => {}, signal, electronPath }) {
  return new Promise((resolve, reject) => {
    const bin = electronPath || findElectron(appRoot);
    if (!bin) {
      reject(new Error('找不到内置浏览器（Electron），无法用浏览器方式请求'));
      return;
    }
    const outFile = path.join(os.tmpdir(), `vgrab-fetch-${Date.now()}-${process.pid}.json`);
    const child = spawn(bin, [appRoot, '--user-data-dir', path.join(os.tmpdir(), 'vgrab-browser-profile')], {
      windowsHide: true,
      env: electronChildEnv({
        VIDEOGRAB_FETCH_URL: url,
        VIDEOGRAB_FETCH_PAGE: pageUrl,
        VIDEOGRAB_FETCH_OUT: outFile,
      }),
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error('浏览器内请求超时'));
    }, 120000);
    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`启动内置浏览器失败：${err.message}`));
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(new Error('已取消'));
        return;
      }
      try {
        const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        try {
          fs.unlinkSync(outFile);
        } catch {
          /* ignore */
        }
        if (!data.ok) throw new Error(data.error || '浏览器内请求失败');
        resolve({ status: data.status, text: data.text });
      } catch (err) {
        reject(new Error(`浏览器内请求没有返回结果：${err.message}`));
      }
    });
  });
}

/**
 * 从候选里挑出一条视频 + 一条音轨（音视频分离的站点需要分别下载再合并）。
 * @returns {{video: object|null, audio: object|null}}
 */
function pickMediaPair(media) {
  const list = (media || []).filter((m) => {
    const u = String(m.url || '');
    if (!/^https?:/i.test(u)) return false;
    if (/(douyinpic\.com|douyinstatic\.com\/obj\/tos-aweme-im-pc|\.dmg|\.exe|\.zip)(\?|$)/i.test(u)) return false;
    return /douyinvod|douyincdn|bytecdn|mime_type=(video|audio)|\.mp4(\?|$)|\.m4s(\?|$)|\.m4a(\?|$)|video\/tos|aweme\/v1\/play/i.test(u);
  });
  const score = (m) => {
    const u = String(m.url).toLowerCase();
    let s = 0;
    if (u.includes('mime_type=video') || u.includes('.mp4')) s += 200;
    if (u.includes('douyinvod') || u.includes('douyincdn')) s += 150;
    if (m.gear === '网络请求') s += 60;
    if (/1080|hd/.test(String(m.gear || '').toLowerCase())) s += 40;
    return s;
  };
  const audios = list.filter((m) => isAudioMediaUrl(m.url)).sort((a, b) => score(b) - score(a));
  const videos = list.filter((m) => !isAudioMediaUrl(m.url)).sort((a, b) => score(b) - score(a));
  return { video: videos[0] || null, audio: audios[0] || null };
}

/** 挑选最像正片视频的候选（过滤头像、安装包、静态资源等噪声） */
function selectBestMedia(media) {
  return pickMediaPair(media).video;
}

/** 把抽取结果写成调试文件（便于排查站点改版） */
function dumpPageData(dir, name, payload) {
  try {
    ensureDir(dir);
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return file;
  } catch {
    return '';
  }
}

/**
 * 通过拉起 Electron（应用目录为入口，用环境变量传参）来渲染页面并抽取媒体直链。
 * 供命令行使用；GUI 内部可直接调用 extractPageMediaInProcess。
 */
function extractPageMediaViaElectron({ appRoot, url, waitSec = 8, onLog = () => {}, signal, electronPath, loadImages = false, scroll = false }) {
  return new Promise((resolve, reject) => {
    const bin = electronPath || findElectron(appRoot);
    if (!bin) {
      reject(new Error('找不到内置浏览器（Electron），无法使用浏览器渲染方式'));
      return;
    }
    const outFile = path.join(os.tmpdir(), `vgrab-page-${Date.now()}-${process.pid}.json`);
    onLog('正在启动内置浏览器渲染页面...');
    const child = spawn(bin, [appRoot, '--user-data-dir', path.join(os.tmpdir(), 'vgrab-browser-profile')], {
      windowsHide: true,
      env: electronChildEnv({
        VIDEOGRAB_PAGE_URL: url,
        VIDEOGRAB_PAGE_OUT: outFile,
        VIDEOGRAB_PAGE_WAIT: String(waitSec),
        VIDEOGRAB_PAGE_IMAGES: loadImages ? '1' : '',
        VIDEOGRAB_PAGE_SCROLL: scroll ? '1' : '',
      }),
    });
    let out = '';
    const timer = setTimeout(
      () => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        reject(new Error('内置浏览器渲染页面超时'));
      },
      Math.max(120000, (waitSec + 120) * 1000),
    );
    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d) => {
      out += d.toString();
    });
    child.stderr?.on('data', (d) => {
      out += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`启动内置浏览器失败：${err.message}`));
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(new Error('已取消'));
        return;
      }
      try {
        const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        try {
          fs.unlinkSync(outFile);
        } catch {
          /* ignore */
        }
        resolve(data);
      } catch {
        reject(new Error(`内置浏览器没有返回页面数据${out ? `：${out.trim().slice(-200)}` : ''}`));
      }
    });
  });
}

module.exports = {
  extractPageMediaInProcess,
  extractPageMediaViaElectron,
  fetchTextInBrowserInProcess,
  fetchTextViaElectron,
  extractMediaFromPageData,
  collectUrlLists,
  selectBestMedia,
  pickMediaPair,
  isMediaUrl,
  isAudioMediaUrl,
  findElectron,
  PAGE_EXTRACT_SCRIPT,
  dumpPageData,
};
