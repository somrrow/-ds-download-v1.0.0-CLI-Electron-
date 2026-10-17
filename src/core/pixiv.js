'use strict';

/**
 * Pixiv「不需要代理」通道。
 *
 * 背景：pixiv.net 在大陆直连不通，本工具原有的做法是走内置浏览器 + 系统代理去请求官方 ajax 接口。
 * 用户没配代理时这条路必然失败（表现为 `www.pixiv.net:443 Connect Timeout`），而 pixiv 作品链接
 * 又很常见。这里补一条**完全不需要代理**的路，靠两个公开服务：
 *
 *   ① 搜索：api.lolicon.app/setu/v2 —— 按 Pixiv 标签/关键词检索的公开接口（大陆实测 HTTP 200）
 *   ② 取图：pixiv.re / i.pixiv.re 反代 —— 直接把原图回给我们
 *
 * 取图形态是**实测**出来的（pid 150727863 是 5 页作品，用 pximg 走代理下过一遍做对照）：
 *   https://pixiv.re/<pid>.png         → 第 1 页（535,736 B，与官方原图字节数一致）
 *   https://pixiv.re/<pid>-1.png       → 同上
 *   https://pixiv.re/<pid>-2.png       → 第 2 页 ✓
 *   https://pixiv.re/<pid>-5.png       → 第 5 页 ✓
 *   https://pixiv.re/<pid>-6.png       → HTTP 404（作品只有 5 页）→ 逐页递增探测的终止条件
 *   https://i.pixiv.re/<pid>.png       → HTTP 404 ✗（这个域名只认带日期的完整路径，别用简写）
 * 另外实测：**不需要 Referer**（带不带都是 200），所以这条路连防盗链都不用管。
 *
 * 已知局限（写清楚，免得被当成 bug）：
 *   · 反代只给「原图」，但不给标题/作者/页数 —— 页数靠逐页探测，标题只能退化成 `pixiv-<pid>`；
 *   · 少数作品在反代上是 404（作者已删/限制访问），这时本模块会明确报错；
 *   · 反代是可变更的第三方服务，地址都做成参数（`mirrorBase` / `apiBase`），坏了能换。
 */

const { request, fetchText } = require('./http');
const { DEFAULT_UA } = require('./util');

/** 公开检索接口（不需要代理） */
const LOLICON_API = 'https://api.lolicon.app/setu/v2';
/** 图片反代（不需要代理） */
const MIRROR_BASE = 'https://pixiv.re';
/** 逐页探测的上限：正常作品不会超过这个页数，防止死循环 */
const MAX_MIRROR_PAGES = 60;

/**
 * 从各种写法里抠出作品号（PID）。
 *
 * 这一段是照着 QQ Agent 那个「Pixiv 来张图」插件的 extractPid 抄的 ——
 * 它踩过的坑值得复用：没有代理时"搜图"是死的（pixiv.net 直连不通），
 * 但"按 PID 取图"是通的，所以**能识别出 PID 就等于能用**。
 *
 * 认得：作品页 / 旧版 /i/ / member_illust.php?illust_id= / pixiv.re 链接 / pximg 直链 / 纯数字。
 * @returns {string} 数字串；认不出来返回空串
 */
function extractPixivId(input) {
  const s = String(input ?? '').trim();
  if (!s) return '';
  if (/^\d{5,12}$/.test(s)) return s;
  const patterns = [
    /pixiv\.net\/(?:artworks|i|en\/artworks)\/(\d{5,12})/i,
    /[?&]illust_id=(\d{5,12})/i,
    /(?:i\.)?pixiv\.re\/(\d{5,12})/i,
    /(\d{5,12})_p\d+/i,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m) return m[1];
  }
  const all = s.match(/\d{5,12}/g) || [];
  return all.length === 1 ? all[0] : '';
}

/**
 * 反代上第 page 页（从 0 开始）的地址。
 * 注意 `-1` 与不带后缀是同一页，所以第 0 页不加后缀（少一次 302）。
 */
function mirrorPageUrl(pid, page, base = MIRROR_BASE) {
  const root = String(base || MIRROR_BASE).replace(/\/+$/, '');
  const n = Number(page) || 0;
  return n <= 0 ? `${root}/${pid}.png` : `${root}/${pid}-${n + 1}.png`;
}

/** 探测一个地址是否是可用的图片（只取 1 字节，失败不抛） */
async function probeImage(url, opts = {}) {
  try {
    const res = await request(url, {
      method: 'GET',
      range: 'bytes=0-0',
      timeout: opts.timeout || 15000,
      retries: opts.retries ?? 1,
      signal: opts.signal,
      headers: { ...(opts.headers || {}), 'User-Agent': opts.userAgent || DEFAULT_UA },
    });
    const contentType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const total = Number(/\/(\d+)\s*$/.exec(res.headers.get('content-range') || '')?.[1] || 0);
    const size = total || (res.status === 206 ? 0 : Number(res.headers.get('content-length') || 0));
    const isImage = /^image\//.test(contentType) || /octet-stream/.test(contentType);
    return { ok: res.status < 400 && isImage, status: res.status, size, contentType };
  } catch (err) {
    return { ok: false, status: 0, size: 0, contentType: '', error: err.message };
  }
}

/**
 * 逐页探测反代，拿到一个作品的**全部**图片地址（不需要代理）。
 *
 * 顺序探测而不是并发：页数是未知的，只有第 N 页 404 才知道到头了；
 * 并发探测会在"作品不存在"时打出一堆无意义请求。实测每页 0.3~1.5 秒，5 页的作品约 3 秒。
 *
 * @returns {Promise<{pid:string, urls:string[], pages:number, source:'mirror'}>}
 */
async function enumeratePixivMirror(pid, opts = {}) {
  const id = String(pid || '').trim();
  if (!/^\d{5,12}$/.test(id)) throw new Error(`不是合法的 Pixiv 作品号：${pid}`);
  const maxPages = Math.max(1, Math.min(MAX_MIRROR_PAGES, Number(opts.maxPages) || MAX_MIRROR_PAGES));
  const onLog = opts.onLog || (() => {});
  const urls = [];
  let emptyStreak = 0; // 中途偶发 404（反代抽风）时给一次机会，连续两页空才收手

  for (let page = 0; page < maxPages; page += 1) {
    const url = mirrorPageUrl(id, page, opts.mirrorBase);
    const info = await probeImage(url, opts);
    if (info.ok) {
      urls.push(url);
      emptyStreak = 0;
      if (opts.signal?.aborted) throw new Error('已取消');
      continue;
    }
    // 第 1 页就不行：可能是"不带后缀"这条不认（个别作品），退一格试 -1
    if (page === 0 && !urls.length && opts.retryFirst !== false && info.status === 404) {
      const alt = mirrorPageUrl(id, 1, opts.mirrorBase);
      const altInfo = await probeImage(alt, opts);
      if (altInfo.ok) {
        onLog(`反代上 ${id}.png 是 404，但 ${id}-1.png 正常，按后者继续`);
        urls.push(alt);
        continue;
      }
      throw new Error(
        `图片反代上没有这个作品（${id}）：它可能已被作者删除或限制访问` +
          `（HTTP ${info.status || info.error || '?'}）`,
      );
    }
    emptyStreak += 1;
    if (emptyStreak >= 2) break;
    onLog(`第 ${page + 1} 页取不到（HTTP ${info.status || info.error || '?'}），再试一页确认是否到底`);
  }

  if (!urls.length) throw new Error(`图片反代上没取到任何图片（${id}）`);
  return { pid: id, urls, pages: urls.length, source: 'mirror' };
}

/**
 * 用公开接口按关键词/标签搜作品（不需要代理）。
 *
 * 接口口径（照抄「Pixiv 来张图」插件的实测结论）：
 *   · `tag=` 按标签搜（角色名走这个），搜不到再退化 `keyword=` 模糊搜；
 *   · `r18=0` 只出全年龄 / `2` 混合（它只有一个布尔 r18，分不出 R18 与 R18G，所以本机再按标签精筛）；
 *   · `urls.original` 是 i.pixiv.re 的**完整原图路径**（带日期与页码），比按 PID 拼模板更准。
 *
 * @returns {Promise<{items:Array, backend:string, errors:string[]}>}
 */
async function searchPixiv(keyword, opts = {}) {
  const base = String(opts.apiBase || LOLICON_API);
  const kw = String(keyword ?? '').trim();
  if (!kw) throw new Error('搜索关键词为空');
  const want = Math.max(1, Math.min(20, Number(opts.limit) || 3));
  const allowR18 = opts.allowR18 === true;
  const modes = opts.mode ? [opts.mode] : ['tag', 'keyword'];
  const errors = [];

  for (const mode of modes) {
    const url = new URL(base);
    url.searchParams.set(mode, kw);
    url.searchParams.set('num', String(Math.max(want, 5)));
    url.searchParams.set('r18', allowR18 ? '2' : '0');
    if (opts.excludeAI) url.searchParams.set('excludeAI', 'true');
    try {
      const text = await fetchText(url.toString(), {
        timeout: opts.timeout || 20000,
        retries: opts.retries ?? 1,
        signal: opts.signal,
        headers: { 'User-Agent': opts.userAgent || DEFAULT_UA, Accept: 'application/json' },
      });
      const json = JSON.parse(text);
      let items = mapSearchItems(json);
      if (!allowR18) items = items.filter((it) => ratingOf(it) === 0);
      if (items.length) return { items: items.slice(0, want), backend: `lolicon/${mode}`, errors };
      errors.push(`内置接口（${mode}）没有结果`);
    } catch (err) {
      errors.push(`内置接口（${mode}）失败：${err.message}`);
    }
  }
  return { items: [], backend: 'none', errors };
}

/** 把检索接口的返回映射成内部条目（形状与 pixiv 官方那条路保持一致） */
function mapSearchItems(raw) {
  const list = Array.isArray(raw?.data) ? raw.data : [];
  const out = [];
  for (const it of list) {
    const pid = String(it?.pid ?? '').trim();
    if (!/^\d+$/.test(pid)) continue;
    out.push({
      pid,
      title: String(it?.title ?? '').trim() || '（无题）',
      author: String(it?.author ?? '').trim() || '（未知作者）',
      userId: String(it?.uid ?? '').trim(),
      tags: Array.isArray(it?.tags) ? it.tags.map((t) => String(t)) : [],
      xRestrict: it?.r18 === true ? 1 : 0,
      url: String(it?.urls?.original ?? '').trim(),
      pageCount: 0,
    });
  }
  return out;
}

/**
 * 分级：0 全年龄 / 1 R18 / 2 R18G。
 * 内置接口只给一个布尔 r18，分不出 R18 与 R18G，所以再看标签（作品标签通常写着 R-18 / R-18G）。
 */
function ratingOf(item) {
  if (!item) return 0;
  const x = Number(item.xRestrict);
  let r = Number.isFinite(x) && x > 0 ? (x >= 2 ? 2 : 1) : 0;
  for (const tag of item.tags || []) {
    const s = String(tag).trim();
    if (/^(r-?18g|guro|リョナ|グロ|猎奇|猟奇)/i.test(s)) {
      r = Math.max(r, 2);
      continue;
    }
    if (/^(r-?18|成人向?|エロ)/i.test(s)) r = Math.max(r, 1);
  }
  return r;
}

/**
 * 「不需要代理」地拿一个作品的全部图片地址：先用检索接口能给的完整原图（第 1 页），
 * 再用反代逐页补齐后面的页。任一环节失败都退回纯反代枚举。
 */
async function fetchPixivViaMirror(pid, opts = {}) {
  const id = String(pid || '').trim();
  const onLog = opts.onLog || (() => {});
  let firstUrl = '';
  let meta = null;
  if (opts.lookup !== false) {
    // 有 PID 时反查一次标题/作者：接口支持 `pid=` 过滤吗？不支持也没关系（失败就跳过）
    try {
      const res = await searchPixivByPid(id, opts);
      if (res) {
        meta = res;
        firstUrl = res.url || '';
      }
    } catch (err) {
      onLog(`反查作品信息失败（不影响取图）：${err.message}`);
    }
  }
  const enumerated = await enumeratePixivMirror(id, opts);
  const urls = [...enumerated.urls];
  if (firstUrl && !urls.includes(firstUrl)) urls.unshift(firstUrl);
  return {
    id,
    pid: id,
    title: meta?.title || `pixiv-${id}`,
    author: meta?.author || '',
    tags: meta?.tags || [],
    illustType: 0,
    // 分级：反查拿到就用它的，拿不到按全年龄（调用方如需严格判断应显式检查 meta===null）
    xRestrict: Number(meta?.xRestrict) || 0,
    urls,
    pages: urls.length,
    source: 'mirror',
  };
}

/** 用检索接口的 `pid` 过滤反查单个作品（接口不认这个参数时返回 null，不抛错） */
async function searchPixivByPid(pid, opts = {}) {
  const base = String(opts.apiBase || LOLICON_API);
  const url = new URL(base);
  url.searchParams.set('pid', String(pid));
  url.searchParams.set('num', '1');
  url.searchParams.set('r18', '2');
  try {
    const text = await fetchText(url.toString(), {
      timeout: opts.timeout || 15000,
      retries: 0,
      signal: opts.signal,
      headers: { 'User-Agent': opts.userAgent || DEFAULT_UA, Accept: 'application/json' },
    });
    const items = mapSearchItems(JSON.parse(text));
    return items.find((it) => it.pid === String(pid)) || null;
  } catch {
    return null;
  }
}

/** 目录名：`<标题> by <作者>`，去掉非法字符 */
function workFolderName(item) {
  const { sanitizeFilename } = require('./util');
  return sanitizeFilename(
    `${item?.title || 'pixiv'}${item?.author ? ` by ${item.author}` : ''}`,
    `pixiv-${item?.pid || 'unknown'}`,
  );
}

/**
 * 搜图 + 下载（命令行与桌面界面共用同一条实现，别再各写一份）。
 *
 * 每个作品下到自己的子目录 `<标题> by <作者>`（单图作品只下一个文件时，
 * 如果都丢进同一个目录，几个作品就会变成 `2.png` / `2 (1).png` 这种谁也认不出的名字）。
 *
 * @returns {Promise<{keyword:string, backend:string, items:Array, results:Array, errors:string[]}>}
 */
async function searchAndDownloadPixiv(keyword, opts = {}) {
  const { downloadImages } = require('./images');
  const path = require('path');
  const count = Math.max(1, Math.min(20, Number(opts.count) || 3));
  const outDir = opts.outDir || process.cwd();
  const onLog = opts.onLog || (() => {});
  const onProgress = opts.onProgress || (() => {});

  const found = await searchPixiv(keyword, {
    // 多要几个候选：检索接口里混着"已被作者删除/限制访问"的作品，反代上直接 404。
    // 只按 count 取候选的话，一个 404 就让整次搜图少一个（count=1 时就是"什么都没搜到"），
    // 所以这里按 count + 备胎 取，凑够 count 个**下成功的**就停。
    limit: Math.min(20, count + Math.min(5, count)),
    allowR18: opts.allowR18 === true,
    apiBase: opts.apiBase,
    excludeAI: opts.excludeAI,
    userAgent: opts.userAgent,
    timeout: opts.timeout,
    signal: opts.signal,
  });

  const results = [];
  if (!found.items.length) {
    return { keyword, backend: found.backend, items: [], results, errors: found.errors };
  }
  if (opts.listOnly) {
    return {
      keyword,
      backend: found.backend,
      items: found.items,
      results: found.items.map((it) => listEntryOf(it)),
      errors: found.errors,
    };
  }

  let okCount = 0;
  for (const [index, it] of found.items.entries()) {
    if (okCount >= count) break;   // 已经凑够要的数量，剩下的候选不用再动
    onProgress({ stage: 'download', percent: -1, message: `第 ${index + 1} 个作品（目标 ${count} 个）：${it.title}` });
    const r = await downloadWorkOnce(it, opts);
    if (r.ok) okCount += 1;
    results.push(r);
  }
  return { keyword, backend: found.backend, items: found.items, results, errors: found.errors };
}

/**
 * 「只列出」时的一条结果：**不下原图**，但带上反代上的缩略图地址，
 * 界面可以先把小图铺出来让人挑（挑完再走 downloadPixivWorks 下原图）。
 */
function listEntryOf(it) {
  return {
    ok: true,
    pid: it.pid,
    title: it.title,
    author: it.author,
    rating: ratingOf(it),
    url: `https://www.pixiv.net/artworks/${it.pid}`,
    originalUrl: String(it.url || ''),
    previewUrl: previewUrlOf(it.url),
    previewUrlHd: previewUrlOf(it.url, 'master'),
    files: [],
    bytes: 0,
  };
}

/** 下载的作品条目也带上这两个地址（界面对已下载的图同样能显示预览/重试） */
function withPreviewUrls(entry, it) {
  return {
    ...entry,
    originalUrl: String(it?.url || ''),
    previewUrl: previewUrlOf(it?.url),
    previewUrlHd: previewUrlOf(it?.url, 'master'),
  };
}

/**
 * 下载**一个**作品（反代逐页取原图 → 落到自己的子目录）。
 * 搜图那条路和「只列出挑完再下」那条路共用它，免得两处行为漂移。
 */
async function downloadWorkOnce(it, opts = {}) {
  const { downloadImages } = require('./images');
  const path = require('path');
  const outDir = opts.outDir || process.cwd();
  const onLog = opts.onLog || (() => {});
  const onProgress = opts.onProgress || (() => {});
  const entry = { pid: it.pid, title: it.title, author: it.author, rating: ratingOf(it), url: `https://www.pixiv.net/artworks/${it.pid}` };
  try {
    // 搜图/挑图这两条路上标题作者都已经从检索接口拿到了，不必再反查（省一次请求，也避免反查拿错元信息）
    const illust = await fetchPixivViaMirror(it.pid, {
      signal: opts.signal,
      lookup: false,
      mirrorBase: opts.mirrorBase,
      apiBase: opts.apiBase,
      userAgent: opts.userAgent,
      timeout: opts.timeout,
      onLog,
    });
    const folder = workFolderName(it);
    const res = await downloadImages({
      items: illust.urls.map((url) => ({ url })),
      outDir: path.join(outDir, folder),
      baseName: folder,
      referer: '',
      userAgent: opts.userAgent,
      headers: opts.headers,
      signal: opts.signal,
      verifySizes: false,
      concurrency: opts.concurrency,
      logger: onLog,
      onProgress: (p) => onProgress({ stage: 'download', ...p }),
    });
    const files = res.files || [];
    return withPreviewUrls({
      ...entry,
      ok: files.length > 0,
      filePath: files.length === 1 ? files[0] : res.dir,
      dir: res.dir,
      files,
      bytes: res.bytes,
      pages: illust.urls.length,
      error: files.length ? '' : res.failed?.[0]?.error || '没有下载到图片',
    }, it);
  } catch (err) {
    onLog(`「${it.title}」取图失败：${err.message}`);
    return withPreviewUrls({ ...entry, ok: false, files: [], bytes: 0, error: err.message }, it);
  }
}

/**
 * 下载**指定的一批作品**（界面「只列出」挑完点下载走这条）。
 * @param {Array<{pid:string,title?:string,author?:string,rating?:number,tags?:string[],url?:string}>} items
 */
async function downloadPixivWorks(items = [], opts = {}) {
  const onLog = opts.onLog || (() => {});
  const onProgress = opts.onProgress || (() => {});
  const list = Array.isArray(items) ? items : [];
  const results = [];
  for (const [index, raw] of list.entries()) {
    const pid = String(raw?.pid ?? '').trim();
    if (!/^\d{5,12}$/.test(pid)) {
      results.push({ ok: false, pid, title: raw?.title || '', author: raw?.author || '', files: [], bytes: 0, error: `不是合法的作品号：${pid || '(空)'}` });
      continue;
    }
    onProgress({ stage: 'download', percent: -1, message: `第 ${index + 1}/${list.length} 个作品：${raw.title || pid}` });
    const it = {
      pid,
      title: String(raw.title || '（无题）'),
      author: String(raw.author || '（未知作者）'),
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      xRestrict: raw.rating ? 1 : 0,
      url: String(raw.originalUrl || raw.url || ''),
    };
    results.push(await downloadWorkOnce(it, opts));
  }
  return { results, dir: opts.outDir || process.cwd() };
}

/**
 * 反代上的**预览图**地址（不下载原图就能看）。
 *
 * pixiv 的图在 CDN 上除了 `img-original`（原图），还有 `img-master`（长边 1200）和
 * `/c/240x480/` 前缀的缩略图。实测反代（i.pixiv.re）把这些路径**都**代理了：
 *
 *   .../img-original/img/2022/12/20/14/21/55/103753629_p0.jpg              原图（几百 KB~几 MB）
 *   .../c/240x480/img-master/img/.../103753629_p0_master1200.jpg           63 KB / 240x383
 *   .../img-master/img/.../103753629_p0_master1200.jpg                     569 KB / 752x1200
 *   （`/c/540x540/` 那个尺寸反代不认，会 403）
 *
 * 「只列出」时先铺缩略图让人挑，挑完再下原图 —— 不然"列个表"就要把几 MB 的原图全拉下来。
 * 转不出来（不是反代那种路径）就返回空串，调用方按"没有预览"处理。
 *
 * @param {string} originalUrl urls.original（形如 https://i.pixiv.re/img-original/img/.../<pid>_pN.jpg）
 * @param {'thumb'|'master'} [size]
 */
function previewUrlOf(originalUrl, size = 'thumb') {
  const url = String(originalUrl || '');
  const m = /^(https?:\/\/[^/]+)\/img-original(\/img\/[^?#]+?_p\d+)\.[A-Za-z0-9]+$/i.exec(url);
  if (!m) return '';
  const [, base, middle] = m;
  const slash = middle.lastIndexOf('/');
  const dir = middle.slice(0, slash + 1);
  const name = `${middle.slice(slash + 1)}_master1200.jpg`;
  return size === 'master'
    ? `${base}/img-master${dir}${name}`
    : `${base}/c/240x480/img-master${dir}${name}`;
}

module.exports = {
  LOLICON_API,
  MIRROR_BASE,
  MAX_MIRROR_PAGES,
  extractPixivId,
  mirrorPageUrl,
  enumeratePixivMirror,
  probeImage,
  searchPixiv,
  searchPixivByPid,
  mapSearchItems,
  ratingOf,
  searchAndDownloadPixiv,
  workFolderName,
  fetchPixivViaMirror,
  previewUrlOf,
  downloadPixivWorks,
};
