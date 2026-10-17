'use strict';

/**
 * 图片帖（图文/插画）下载支持。
 *
 * 覆盖两类：
 *  - Pixiv 插画：走官方 Ajax 接口拿到每一页的原图地址（需要 Referer，R-18 需要登录 Cookie）
 *  - 抖音图文（note）：页面是图片轮播，没有视频流，靠内置浏览器渲染后从 DOM / 网络请求里收集图片
 */

const fs = require('fs');
const path = require('path');
const { fetchText, request, openStream } = require('./http');
const { ensureDir, sanitizeFilename, uniquePath, fileSize, formatBytes } = require('./util');
const { ProgressMeter } = require('./progress');

/** 图片扩展名 → 保存时用的后缀 */
const IMAGE_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
};

const IMAGE_HOSTS = [
  'douyinpic.com',
  'byteimg.com',
  'pximg.net',
  'pixiv.net',
  'hdslb.com',
  'sinaimg.cn',
  'xhscdn.com',
  'twimg.com',
  'cdninstagram.com',
  'fbcdn.net',
];

/**
 * 明显不是正文配图的地址（头像、图标、表情、评论区贴纸、UI 静态资源等）。
 * 注意：抖音正文原图常是 `douyinpic.com/obj/tos-cn-i-xxx/<hash>` 这种无扩展名的地址，
 * 不能按「没有扩展名 / 带 obj」当成静态资源过滤掉。
 */
const JUNK_PATTERN = new RegExp(
  [
    'avatar',
    '100x100',
    '50x50',
    'icon',
    'logo',
    'qrcode',
    'qr_',
    'sprite',
    'emoji',
    'sticker',
    'badge',
    'placehold',
    'loading',
    'douyindefault',
    'aweme-client-static-resource',
    'client-static',
    '/static/',
    'aweme_comment', // 评论区图片
    '~tplv-p14lwwcsbr', // 评论区缩略图变体
    '/obj/tos-cn-i-tsj2vxp0zn/', // 评论区头像
    '/obj/tos-cn-o-0812/', // 评论贴纸
    'sc=thumb',
    '=thumb',
    'live_icon',
    'search_',
    '/tab_',
    '\\.svg(\\?|$)',
    '\\.js(\\?|$)',
    '\\.css(\\?|$)',
    '\\.json(\\?|$)',
    '\\.woff2?(\\?|$)',
    '\\.html(\\?|$)',
    // B 站：头像 / 用户装扮 / 图标资源 / 前端静态资源
    'bfs/face',
    'bfs/garb',
    'bfs/svg-next',
    'bfs/static',
    'bfs/emote',
    'jinkela',
  ].join('|'),
  'i',
);

/**
 * 正文内容的地址特征：命中就只认这些。
 * 例：B 站专栏的正文图都在 `i0.hdslb.com/bfs/article/` 下，而同一批候选里混着
 * `bfs/face`（头像）、`bfs/garb`（装扮）、`jinkela`/`bfs/static`（前端资源）
 * 以及正文图的 80w/128w 缩略变体 —— 宁可少抓，也不要把无关图片存下来。
 */
const CONTENT_PATTERNS = [/\/bfs\/article\//i];

/** 页面语义区域标记里，属于「评论/私信」的图片不算正文配图 */
const JUNK_SCOPE = /comment-item|comment-list|conversation-item|live-avatar/i;
/** 正文区域标记（抖音图文详情页） */
const NOTE_SCOPE = /note-detail/i;
/** 轮播里逐张翻出来的正文图（最可靠，优先只用这些） */
const SLIDE_SCOPE = /slide/i;

/**
 * 识别「图片帖」链接。
 * 支持：Pixiv 作品页、抖音图文页（www.douyin.com/note/<id>）、抖音分享页（iesdouyin.com/share/note/<id>）
 * @returns {{kind:'pixiv'|'douyin-note', id:string, url:string}|null}
 */
function detectImagePost(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);

  if (/(^|\.)pixiv\.net$/.test(host)) {
    const idx = parts.indexOf('artworks');
    if (idx >= 0 && /^\d+$/.test(parts[idx + 1] || '')) {
      return { kind: 'pixiv', id: parts[idx + 1], url: u.toString() };
    }
    if (parts[0] === 'i' && /^\d+$/.test(parts[1] || '')) {
      return { kind: 'pixiv', id: parts[1], url: u.toString() };
    }
    return null;
  }

  // 分享页（手机端）：iesdouyin.com/share/note/<id>；PC 页：douyin.com/note/<id>
  if (/(^|\.)douyin\.com$/.test(host) || /(^|\.)iesdouyin\.com$/.test(host)) {
    const idx = parts.indexOf('note');
    if (idx >= 0 && /^\d+$/.test(parts[idx + 1] || '')) {
      const id = parts[idx + 1];
      // 统一用 PC 版链接渲染：轮播结构固定，抽取逻辑只针对这一版
      return { kind: 'douyin-note', id, url: `https://www.douyin.com/note/${id}` };
    }
    return null;
  }

  return null;
}

/** 抖音分享短链（App 里「复制链接」拿到的就是这种，需要跟随跳转才知道是图文还是视频） */
const SHARE_LINK_HOSTS = ['v.douyin.com', 'v.iesdouyin.com'];

/** 是否是抖音分享短链 */
function isShareLink(rawUrl) {
  try {
    const host = new URL(String(rawUrl)).hostname.toLowerCase();
    return SHARE_LINK_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * 把分享短链还原成真实地址（跟随跳转）。拿不到就返回原地址。
 * @returns {Promise<string>}
 */
async function resolveShareLink(rawUrl, opts = {}) {
  const res = await request(rawUrl, {
    method: 'GET',
    userAgent: opts.userAgent,
    cookies: opts.cookies,
    cookieHeader: opts.cookieHeader,
    headers: opts.headers,
    timeout: opts.timeout || 20000,
    retries: 1,
    wantBody: false,
    keepBody: false,
    signal: opts.signal,
  });
  return res.url || rawUrl;
}

/**
 * 识别图片帖（含分享短链）：短链先跟随跳转拿真实地址，再从跳转后的页面里找图文 id，
 * 最后统一成 PC 版链接（轮播结构与抽取逻辑都只针对 PC 版）。
 * @returns {Promise<{kind:'pixiv'|'douyin-note', id:string, url:string}|null>}
 */
async function resolveImagePost(rawUrl, opts = {}) {
  const direct = detectImagePost(rawUrl);
  if (direct) return direct;
  if (!isShareLink(rawUrl)) return null;

  let res;
  try {
    res = await request(rawUrl, {
      method: 'GET',
      userAgent: opts.userAgent,
      cookies: opts.cookies,
      cookieHeader: opts.cookieHeader,
      headers: opts.headers,
      timeout: opts.timeout || 20000,
      retries: 1,
      wantBody: true,
      maxBodyBytes: 2 * 1024 * 1024,
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.onLog) opts.onLog(`分享链接跳转解析失败：${err.message}`);
    return null;
  }

  const finalUrl = res.url || rawUrl;
  const viaRedirect = detectImagePost(finalUrl);
  if (viaRedirect) return viaRedirect;

  // 有些分享页是用脚本跳转的（地址还在 v.douyin.com），从页面内容里找图文 id
  const html = res.body ? res.body.toString('utf8') : '';
  const text = html.replace(/\\\//g, '/').replace(/%2F/gi, '/');
  const m = /(?:douyin\.com|iesdouyin\.com)[^"'\s<>]{0,80}?\/note\/(\d{6,})/i.exec(text);
  if (m) {
    if (opts.onLog) opts.onLog(`分享链接指向图文帖：${m[1]}`);
    return { kind: 'douyin-note', id: m[1], url: `https://www.douyin.com/note/${m[1]}` };
  }
  return null;
}

/**
 * 计算「同一张图」的归一化键：抖音等站点会用 `~tplv-xxx:宽:高.webp` 后缀生成多个尺寸变体，
 * 去掉这部分后就是同一张原图，可以据此去重。
 */
function baseImageKey(url) {
  try {
    const u = new URL(url);
    // `~` 后面是 CDN 的变体后缀（~tplv-xxx:宽:高.webp、~noop.jpeg、~tplv-obj.jpeg…），整段去掉即为同一张原图
    // `@` 后面是 B 站的尺寸后缀（@1192w.webp、@128w_128h_1c、@80w_80h_1c），同样去掉
    const pathname = u.pathname.replace(/~[^/]*$/, '').replace(/@\d+w[^/]*$/i, '');
    return `${u.host.toLowerCase()}${pathname}`;
  } catch {
    return url.split('?')[0];
  }
}

/** 同一张图的多个变体里评分：越像「正文原图」分越高 */
function variantScore(url) {
  const s = String(url);
  let score = 0;
  // 抖音正文图的处理链（~tplv-dy-aweme-images / aweme-images）
  if (/~tplv-(?:dy-)?aweme-images/i.test(s)) score += 600;
  else if (/~tplv/i.test(s)) score += 120;
  if (/tos-cn-i-/i.test(s)) score += 250;
  if (/img-original/i.test(s)) score += 700; // Pixiv 原图
  else if (/img-master/i.test(s)) score += 200; // Pixiv 1200px 大图
  if (/\/c\/\d+x\d+\//i.test(s)) score -= 400; // Pixiv 缩略图路径 /c/240x480/...
  // 同一张图有多种格式时，优先兼容性更好的 jpg/png（Windows 自带看图、剪辑软件都能直接开）
  if (/\.(jpe?g|png)(\?|$)/i.test(s)) score += 40;
  else if (/\.webp(\?|$)/i.test(s)) score -= 20;
  if (!/~tplv/i.test(s)) score += 60; // 没有处理后缀，可能是原图
  // B 站的尺寸变体：@1192w 比 @128w 清楚得多，按宽度给分
  const bw = /@(\d+)w/i.exec(s);
  if (bw) score += Math.min(400, Number(bw[1]) / 4);
  // 带裁剪尺寸的：像素越多越优先
  const m = /:(\d+):(\d+)(?:\.\w+)?$/i.exec(s);
  if (m) score += Math.min(300, (Number(m[1]) * Number(m[2])) / 2000);
  return score;
}

/**
 * 从一堆候选地址里挑出正文图片：过滤头像/图标、按原图去重（保留最大变体）、限量。
 *
 * 候选如果带了 `scope`（页面里的语义区域），会优先只用正文区域里的图：
 * 抖音图文帖的页面同时挂着推荐流、评论区配图和私信头像，单靠地址很难分辨，
 * 但它们的祖先节点上有 `data-e2e="comment-item"` / `note-detail` 这类稳定标记。
 */
function pickPostImages(candidates, opts = {}) {
  // 默认不设上限：正文来源与体积两道过滤已经把干扰项挡掉了，图集就该把有效图片全部保存下来
  const raw = Number(opts.maxImages);
  const maxImages = Number.isFinite(raw) && raw > 0 ? raw : Infinity;
  const byKey = new Map();
  const kept = [];
  for (const item of candidates || []) {
    const raw = typeof item === 'string' ? item : item && item.url;
    if (!raw) continue;
    const url = String(raw).trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (/^data:|^blob:/i.test(url)) continue;
    if (JUNK_PATTERN.test(url)) continue;
    const scope = String((item && item.scope) || '');
    if (JUNK_SCOPE.test(scope)) continue; // 评论区/私信里的图不是正文
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    const looksImage =
      IMAGE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ||
      /\.(jpe?g|png|webp|gif|avif|bmp)(\?|$)/i.test(url) ||
      /image|img|photo|pic/i.test(host);
    if (!looksImage) continue;

    const key = baseImageKey(url);
    const width = (item && item.width) || 0;
    const height = (item && item.height) || 0;
    const order = kept.length;
    const score = variantScore(url) + Math.min(400, (width * height) / 10000);
    kept.push({ url, width, height, scope });
    const prev = byKey.get(key);
    if (!prev || score > prev.score) {
      byKey.set(key, { url, width, height, score, scope, order });
    }
  }

  // 正文图的来源按可靠程度依次收敛：
  //   1) 抖音图文轮播逐张翻出来的（最准，还带顺序）
  //   2) 抖音「正文区域」里的
  //   3) 命中正文地址特征的（如 B 站专栏的 /bfs/article/）
  // 只要有一路命中，就只认这一路，避免把头像、UI 资源、缩略变体当成正文图存下来。
  const slides = kept.filter((x) => SLIDE_SCOPE.test(x.scope));
  const inNote = kept.filter((x) => NOTE_SCOPE.test(x.scope));
  const byContent = kept.filter((x) => CONTENT_PATTERNS.some((re) => re.test(x.url)));
  const chosen = slides.length ? slides : inNote.length ? inNote : byContent;
  const pool = chosen.length ? new Set(chosen.map((x) => x.url)) : null;

  const rows = [...byKey.values()].filter((x) => !pool || pool.has(x.url));
  // 轮播图要按翻页顺序编号（001 是第一张），其余按「像原图」的分数排
  if (slides.length) rows.sort((a, b) => a.order - b.order);
  else rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, maxImages).map(({ url, width, height, scope }) => ({ url, width, height, scope }));
}

/**
 * 从页面结构化数据（抖音的 window._ROUTER_DATA）里取出图文帖正文图片。
 *
 * 比「渲染后翻 DOM / 嗅探网络请求」可靠得多：轮播图是懒加载的，抓得到几张全看渲染时机，
 * 而结构化数据里一定带着完整的 `images[].url_list`。
 */
function extractImagesFromRouter(json) {
  const out = [];
  const seen = new Set();
  const push = (node) => {
    const list = node && (node.url_list || node.urlList);
    if (!Array.isArray(list)) return;
    const width = Number(node.width || node.image_width || 0);
    const height = Number(node.height || node.image_height || 0);
    for (const url of list) {
      if (typeof url !== 'string' || !/^https?:/i.test(url) || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, width, height });
    }
  };
  const walk = (node, inImageList, depth) => {
    if (!node || depth > 14) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (inImageList) push(item);
        walk(item, inImageList, depth + 1);
      }
      return;
    }
    if (typeof node !== 'object') return;
    if (inImageList) push(node);
    for (const [key, value] of Object.entries(node)) {
      const next = inImageList || key === 'images' || key === 'image_list' || key === 'imageList';
      walk(value, next, depth + 1);
    }
  };
  walk(json, false, 0);
  return out;
}

/** 解析 Pixiv「作品页」接口返回，取每一页原图 */
function parsePixivPages(json) {
  const body = json && json.body;
  if (!Array.isArray(body)) return [];
  return body
    .map((p) => (p && p.urls && (p.urls.original || p.urls.regular)) || '')
    .filter(Boolean);
}

/** 解析 Pixiv 作品信息接口 */
function parsePixivInfo(json) {
  const body = (json && json.body) || {};
  return {
    title: String(body.illustTitle || body.title || '').trim(),
    author: String((body.userName || (body.userInfo && body.userInfo.userName) || '')).trim(),
    pageCount: Number(body.pageCount || 0) || 0,
    illustType: Number(body.illustType || 0), // 2 = ugoira（动图）
    xRestrict: Number(body.xRestrict || 0),
    tags: ((body.tags && body.tags.tags) || []).map((t) => t && t.tag).filter(Boolean),
  };
}

/**
 * 取一个 Pixiv 作品的全部原图地址。
 * @param {string} id
 * @param {object} opts
 * @param {string} [opts.apiBase='https://www.pixiv.net'] 便于测试替换
 * @param {function} [opts.browserFetch] 用内置浏览器请求（pixiv 前面有 Cloudflare，
 *   Node 的请求会被按 TLS 指纹一律 403，只有浏览器能过）；签名 (url, pageUrl) => Promise<{status,text}>
 */
async function fetchPixivIllust(id, opts = {}) {
  const base = String(opts.apiBase || 'https://www.pixiv.net').replace(/\/+$/, '');
  const headers = {
    Referer: `${base}/artworks/${id}`,
    Accept: 'application/json',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'x-user-id': '',
    ...(opts.headers || {}),
  };
  if (opts.pixivUserId) headers['x-user-id'] = String(opts.pixivUserId);
  const common = {
    headers,
    cookies: opts.cookies,
    cookieHeader: opts.cookieHeader,
    timeout: opts.timeout || 25000,
    retries: opts.retries ?? 2,
    signal: opts.signal,
  };
  const pageUrl = `${base}/artworks/${id}`;

  const getJson = async (url, label) => {
    let text;
    if (typeof opts.browserFetch === 'function') {
      // 优先用内置浏览器（Cloudflare 只放真浏览器过去）
      try {
        const res = await opts.browserFetch(url, pageUrl);
        text = res && res.text;
      } catch (err) {
        if (opts.onLog) opts.onLog(`浏览器方式请求${label}失败（改用普通请求）：${err.message}`);
      }
    }
    if (text === undefined || text === null) {
      text = await fetchText(url, { ...common, maxBodyBytes: 8 * 1024 * 1024 });
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Pixiv ${label}返回的不是 JSON（可能需要登录，或用 --login pixiv 登录后重试）`);
    }
  };

  const infoJson = await getJson(`${base}/ajax/illust/${id}`, '作品接口');
  if (infoJson.error) throw new Error(`Pixiv 接口报错：${infoJson.message || '未知错误'}`);
  const info = parsePixivInfo(infoJson);

  const pagesJson = await getJson(`${base}/ajax/illust/${id}/pages`, '分页接口');
  if (pagesJson.error) throw new Error(`Pixiv 分页接口报错：${pagesJson.message || '未知错误'}`);
  const urls = parsePixivPages(pagesJson);
  if (!urls.length) throw new Error('没有取到任何图片地址（作品可能已删除或需要登录）');

  return { ...info, urls, id };
}

/**
 * 不需要代理地取一个 Pixiv 作品的全部原图地址。
 *
 * 什么时候用：官方 ajax 那条路走不通（最常见的就是**用户没配代理**，表现为连 www.pixiv.net
 * 超时）。这时改用公开检索接口 + pixiv.re 反代（大陆实测可直连，字节数与官方原图一致）。
 *
 * @param {string} id 作品号，或任何含作品号的链接（内部会自己抠出来）
 */
async function fetchPixivIllustViaMirror(idOrUrl, opts = {}) {
  const { fetchPixivViaMirror, extractPixivId } = require('./pixiv');
  const pid = /^\d{5,12}$/.test(String(idOrUrl || '').trim()) ? String(idOrUrl).trim() : extractPixivId(idOrUrl);
  if (!pid) throw new Error(`认不出 Pixiv 作品号：${idOrUrl}`);
  const res = await fetchPixivViaMirror(pid, opts);
  if (opts.onLog) opts.onLog(`已通过反代拿到 ${res.urls.length} 张原图（不需要代理）`);
  return {
    id: pid,
    title: res.title,
    author: res.author,
    tags: res.tags,
    pageCount: res.urls.length,
    illustType: 0,
    xRestrict: Number(res.xRestrict) || 0,
    urls: res.urls,
    source: 'mirror',
  };
}

/** 根据 URL / Content-Type 猜图片后缀 */
function imageExtFor(url, contentType) {
  const byMime = IMAGE_EXT[String(contentType || '').split(';')[0].trim().toLowerCase()];
  if (byMime) return byMime;
  const m = /\.(jpe?g|png|webp|gif|avif|bmp)(?:\?|#|$)/i.exec(String(url));
  if (m) return `.${m[1].toLowerCase().replace('jpeg', 'jpg')}`;
  return '.jpg';
}

/** 从文件头判断真实图片格式：有些 CDN 会声明 webp/其它，实际返回的是 jpg 原图 */
function sniffImageExt(file) {
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
  } catch {
    return '';
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return '.jpg';
  if (head.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (head.slice(0, 4).toString('latin1') === 'GIF8') return '.gif';
  if (head.slice(0, 4).toString('latin1') === 'RIFF' && head.slice(8, 12).toString('latin1') === 'WEBP') return '.webp';
  if (/ftyp(avif|avis)/.test(head.slice(4, 12).toString('latin1'))) return '.avif';
  if (head.slice(0, 2).toString('latin1') === 'BM') return '.bmp';
  return '';
}

/** 轻量探测图片信息（只取 1 字节）：大小 + 内容类型，用于过滤表情/图标和无效地址 */
async function probeImageInfo(url, opts = {}) {
  try {
    const res = await request(url, {
      method: 'GET',
      headers: { ...(opts.headers || {}), Range: 'bytes=0-0' },
      referer: opts.referer,
      cookies: opts.cookies,
      cookieHeader: opts.cookieHeader,
      userAgent: opts.userAgent,
      timeout: opts.timeout || 20000,
      retries: 1,
      signal: opts.signal,
    });
    const contentType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const total = Number(/\/(\d+)\s*$/.exec(res.headers.get('content-range') || '')?.[1] || 0);
    const size = total || (res.status === 206 ? 0 : Number(res.headers.get('content-length') || 0));
    return { ok: res.status < 400, size, contentType };
  } catch (err) {
    return { ok: false, size: 0, contentType: '', error: err.message };
  }
}

/** 过滤掉页面里的小图标/表情、非图片和取不到的地址，至少保留最大的一张 */
async function filterTinyImages(items, opts = {}) {
  const minBytes = Number(opts.minImageBytes || 20 * 1024);
  const queue = items.slice();
  const infos = new Map();
  const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const info = await probeImageInfo(item.url, opts);
      infos.set(item, info);
      if (opts.onLog && info.size) opts.onLog(`图片大小：${(info.size / 1024).toFixed(0)} KB ${info.contentType}`);
    }
  });
  await Promise.all(workers);

  const usable = [];
  const tooSmall = [];
  for (const item of items) {
    const info = infos.get(item) || { ok: false, size: 0, contentType: '' };
    const isImage = !info.contentType || /^image\//.test(info.contentType) || /octet-stream/.test(info.contentType);
    if (!info.ok || !isImage) continue; // 取不到 / 不是图片：直接丢掉
    if (info.size && info.size < minBytes) {
      tooSmall.push({ item, size: info.size });
      continue;
    }
    usable.push({ item, size: info.size });
  }
  if (usable.length) return usable.map((x) => x.item);
  const largest = tooSmall.sort((a, b) => b.size - a.size)[0];
  return largest ? [largest.item] : items.slice(0, 1);
}

/**
 * 批量下载图片到 outDir（多张时放进以标题命名的子目录，文件名按 001、002 编号）。
 * @returns {Promise<{files:string[], bytes:number, dir:string, failed:Array}>}
 */
async function downloadImages(opts) {
  const {
    items,
    outDir,
    baseName = 'images',
    referer,
    cookies,
    cookieHeader,
    userAgent,
    headers: extraHeaders,
    concurrency = 3,
    onProgress,
    logger = () => {},
    signal,
    timeout = 60000,
    verifySizes = false,
    minImageBytes = 20 * 1024,
  } = opts;

  let list = (items || []).filter((it) => it && it.url);
  if (!list.length) throw new Error('没有可下载的图片');

  // 从页面里抓来的图片可能混着表情/图标，先探一下大小再下（Pixiv 接口给的原图不用探）
  if (verifySizes && list.length > 1) {
    const before = list.length;
    list = await filterTinyImages(list, {
      ...opts,
      minImageBytes,
      onLog: opts.logSizes ? logger : null,
    });
    if (list.length < before) logger(`已过滤掉 ${before - list.length} 张小图标/表情，保留 ${list.length} 张`);
  }

  const safeName = sanitizeFilename(baseName, 'images');
  const dir = list.length > 1 ? path.join(outDir, safeName) : outDir;
  ensureDir(dir);

  const meter = new ProgressMeter({ total: list.length });
  meter.extra = { label: safeName, images: `${list.length} 张` };
  const files = [];
  const failed = [];

  const downloadOne = async (item, index) => {
    const url = item.url;
    let outPath = '';
    try {
      const res = await openStream(url, {
        referer: referer || undefined,
        cookies,
        cookieHeader,
        userAgent,
        headers: { ...extraHeaders, ...(referer ? {} : {}) },
        timeout,
        retries: 2,
        signal,
      });
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      const contentType = res.headers.get('content-type') || '';
      if (contentType && !/^image\//i.test(contentType) && !/octet-stream/i.test(contentType)) {
        throw new Error(`返回的不是图片（${contentType}）`);
      }
      const ext = imageExtFor(url, contentType);
      const stem = list.length > 1 ? String(index + 1).padStart(3, '0') : safeName;
      const target = uniquePath(path.join(dir, `${stem}${ext}`));
      const stream = res.stream;
      if (!stream) throw new Error('服务器没有返回内容');
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(target);
        const onAbort = () => {
          stream.destroy?.(new Error('已取消'));
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        ws.on('error', reject);
        stream.on('error', reject);
        ws.on('finish', () => {
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve();
        });
        stream.pipe(ws);
      });
      let finalPath = target;
      // 有些 CDN（抖音的图片尤其）声明的类型和实际内容不一致，按文件头纠正扩展名
      const sniffed = sniffImageExt(target);
      if (sniffed && sniffed !== ext) {
        const renamed = uniquePath(path.join(dir, `${stem}${sniffed}`));
        try {
          fs.renameSync(target, renamed);
          finalPath = renamed;
        } catch {
          /* 改名失败就保留原名 */
        }
      }
      const size = fileSize(finalPath);
      if (!size) throw new Error('下载得到的文件为空');
      files.push(finalPath);
      meter.add(1);
      logger(`图片 ${index + 1}/${list.length} 完成：${path.basename(finalPath)}（${formatBytes(size)}）`);
    } catch (err) {
      failed.push({ url, error: err.message });
      meter.add(1);
      logger(`图片 ${index + 1}/${list.length} 失败：${err.message}`);
    }
    if (onProgress) onProgress(meter.snapshot());
  };

  // 小并发下载，失败不中断其余图片
  const queue = list.map((item, index) => ({ item, index }));
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    for (;;) {
      if (signal?.aborted) throw new Error('已取消');
      const job = queue.shift();
      if (!job) return;
      await downloadOne(job.item, job.index);
    }
  });
  await Promise.all(workers);

  files.sort();
  const bytes = files.reduce((sum, f) => sum + fileSize(f), 0);
  return { files, bytes, dir, failed, total: list.length };
}

module.exports = {
  detectImagePost,
  isShareLink,
  resolveShareLink,
  resolveImagePost,
  pickPostImages,
  extractImagesFromRouter,
  baseImageKey,
  variantScore,
  parsePixivPages,
  parsePixivInfo,
  fetchPixivIllust,
  fetchPixivIllustViaMirror,
  downloadImages,
  probeImageInfo,
  filterTinyImages,
  imageExtFor,
  sniffImageExt,
  IMAGE_HOSTS,
};
