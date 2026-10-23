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

const { request, fetchText, directFetch } = require('./http');
const { DEFAULT_UA } = require('./util');
const { toTraditional } = require('./zh');

/**
 * 搜索结果**磁盘缓存** + 原生搜索**熔断**（2026-10-19 加）。
 *
 * 背景：群里搜图常常是"同一个标签反复点"（今天光「烏啾」就搜了三四次），
 * 而 pixiv 原生搜索偶发 ECONNRESET（实测 13:37 / 15:10 / 16:44 / 16:49 / 16:50 / 17:13 各挂一次，
 * 同一时刻重试又常常 200ms 内成功）。每失败一次就要白等 ~30 秒、群友还得干等。
 *
 * 两条对策：
 *   ① **缓存**：同一关键词+参数，30 分钟内直接复用上次结果（落盘，另一个进程也能命中）；
 *   ② **熔断**：原生搜索连续失败 2 次就停 5 分钟，期间直接跳过它、快速给"暂时连不上"的结论，
 *      而不是每次都硬等 30 秒。成功一次就清零。
 */
const CACHE_TTL_MS = 30 * 60 * 1000;
const NATIVE_BREAKER_MS = 5 * 60 * 1000;
const NATIVE_BREAKER_COUNT = 2;

function cacheFilePath() {
  const base = process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || require('node:os').tmpdir();
  return require('node:path').join(base, 'vgrab', 'pixiv-search-cache.json');
}

/** 上次哪个图床成功了（"记住好用的路"，2026-10-22） */
const IMAGE_HOST_FILE = (() => {
  const base = process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || require('node:os').tmpdir();
  return require('node:path').join(base, 'vgrab', 'image-host.txt');
})();

function readDiskCache() {
  try {
    const raw = JSON.parse(require('node:fs').readFileSync(cacheFilePath(), 'utf8'));
    return {
      entries: raw && raw.entries && typeof raw.entries === 'object' ? raw.entries : {},
      native: raw?.native || { count: 0, at: 0 }
    };
  } catch {
    return { entries: {}, native: { count: 0, at: 0 } };
  }
}

function writeDiskCache(data) {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    fs.mkdirSync(path.dirname(cacheFilePath()), { recursive: true });
    // 只留最近 40 条，别让缓存文件无限长
    const entries = Object.entries(data.entries || {})
      .sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0))
      .slice(0, 40);
    fs.writeFileSync(
      cacheFilePath(),
      JSON.stringify({ entries: Object.fromEntries(entries), native: data.native || { count: 0, at: 0 } }),
      'utf8'
    );
  } catch {
    /* 缓存写失败不影响搜索 */
  }
}

function searchCacheKey(kw, opts, want) {
  return `${kw}||${opts.mode || 'auto'}||${opts.allowR18 ? 'r18' : 'all'}||${want}`;
}
/**
 * 写缓存 / 记账熔断状态（2026-10-19 加；2026-10-20 重新放回 —— 之前替换 searchPixiv 时
 * 连同它一起被删掉了，导致搜索一走到"写缓存"就报 saveSearchCache is not defined）。
 * @param {object|null} cache 调用方读到的缓存对象（null 表示没读，现读现写）
 * @param {string} key
 * @param {Array|null} items 命中结果；null 表示这次没搜到
 * @param {{resetBreaker?:boolean, bumpBreaker?:boolean}} flags
 */
function saveSearchCache(cache, key, items, flags = {}) {
  const data = cache || readDiskCache();
  if (Array.isArray(items) && items.length) {
    data.entries[key] = { at: Date.now(), items };
  }
  if (flags.resetBreaker) data.native = { count: 0, at: 0 };
  if (flags.bumpBreaker) {
    const prev = data.native || { count: 0, at: 0 };
    data.native = { count: (prev.count || 0) + 1, at: Date.now() };
  }
  writeDiskCache(data);
}

/** 公开检索接口（不需要代理） */
const LOLICON_API = 'https://api.lolicon.app/setu/v2';
/** 图片反代（不需要代理） */
const MIRROR_BASE = 'https://pixiv.re';
/** 逐页探测的上限：正常作品不会超过这个页数，防止死循环 */
const MAX_MIRROR_PAGES = 60;
/**
 * Pixiv **原生**搜索接口（需要能连上 pixiv.net：代理或登录态）。
 *
 * 为什么要有（2026-10-18 用户要求）：内置的公开检索接口（lolicon）是个二手聚合，
 * 冷门标签、新作品、日文原名经常"搜不到"；而 pixiv 自己的搜索一定搜得到。
 * 所以默认策略是：**先用免代理接口，没结果再自动改用原生搜索**。
 * 原生搜索只负责"找出 pid"，取图仍然走 pixiv.re 反代（不需要代理），
 * 所以只有"搜索"这一步需要联网 pixiv.net。
 */
const NATIVE_SEARCH_BASE = 'https://www.pixiv.net/ajax/search/artworks/';
const NATIVE_REFERER = 'https://www.pixiv.net/';

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

/**
 * 把 pixiv 的**缩略图**地址反推成反代上的**原图**地址。
 *
 * 原生搜索（ajax）只返回一张 250×250 的小图，形如：
 *   https://i.pximg.net/c/250x250_80_a2/img-master/img/2023/01/02/03/04/05/150578777_p0_square1200.jpg
 * 其中 `img/2023/01/02/03/04/05/150578777_p0` 这段正好是原图的路径+页码；
 * 换成反代主机、去掉 `/c/...` 与 `_square1200` 之后就是直连可下的原图：
 *   https://i.pixiv.re/img-original/img/2023/01/02/03/04/05/150578777_p0.png
 * 解析不出来返回空串（调用方退回"按 pid 逐页猜"那条老路）。
 */
function originalUrlFromThumb(thumb) {
  const s = String(thumb || '').trim();
  if (!s) return '';
  const m = s.match(/\/img-master\/(img\/[^?#]+?)_p(\d+)(?:_[^/?#]*)?\.(?:jpg|jpeg|png|gif|webp)$/i);
  if (!m) return '';
  return `https://i.pixiv.re/img-original/${m[1]}_p${m[2]}.png`;
}

/**
 * 是否是 **pixiv 官方**图床（i.pximg.net / pximg.net）。
 * 官方图床在国内直连不通，必须走代理；反代（pixiv.re / i.pixiv.re 等）相反，直连最快。
 */
function isPixivOfficialHost(rawUrl) {
  try {
    const host = new URL(String(rawUrl)).hostname.toLowerCase();
    return host === 'i.pximg.net' || host.endsWith('.pximg.net');
  } catch {
    return false;
  }
}

/** 探测一个地址是否是可用的图片（只取 1 字节，失败不抛）。
 *  ⚠️ 反代图床（pixiv.re / i.pixiv.re）**直连**：代理开着时走代理只会更慢，
 *  代理挂掉时还会把"反代没问题"误判成"反代 500/404"。 */
async function probeImage(url, opts = {}) {
  try {
    const res = await request(url, {
      method: 'GET',
      range: 'bytes=0-0',
      timeout: opts.timeout || 15000,
      retries: opts.retries ?? 1,
      signal: opts.signal,
      fetch: opts.fetch || directFetch,
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
  /**
   * 数量**没有硬上限**（2026-10-20 用户要求）：只按调用方要多少就凑多少，
   * 这里最多给一个"防跑飞"的天花板（500），不再像以前那样卡 20。
   */
  const want = Math.max(1, Math.min(Number(opts.maxItems) || 500, Number(opts.limit) || 3));
  const allowR18 = opts.allowR18 === true;
  const modes = opts.mode ? [opts.mode] : ['tag', 'keyword'];
  const errors = [];

  /**
   * 关键词变体（2026-10-19 现场）：
   * 群友说「我要高松灯的图」，公开接口 **简体「高松灯」两条路都是 0 条**，
   * 换成 **繁体「高松燈」立刻 2 条** —— pixiv 的标签几乎都是繁体/日文写法，
   * 简体中文名在那边根本不存在。所以两种写法都要试。
   */
  const variants = [kw];
  const trad = toTraditional(kw);
  if (trad && trad !== kw) variants.push(trad);

  // ① 先看缓存（30 分钟内的同一关键词 + 同一参数直接复用，省掉一次网络往返）
  const useDiskCache = opts.cache !== false && typeof opts.fetchText !== 'function';
  const cacheKey = searchCacheKey(kw, opts, want);
  /**
   * 缓存里的条目也要先剔掉"已经发过的 pid"（2026-10-20）：
   * 否则第二次搜同一个标签会从缓存里把上次发过的作品又拿回来，等于白记。
   */
  const excludeSet = new Set((Array.isArray(opts.excludePids) ? opts.excludePids : []).map((x) => String(x || '')).filter(Boolean));
  const usable = (arr) => (Array.isArray(arr) ? arr.filter((it) => !excludeSet.has(String(it?.pid || ''))) : []);
  let cache = null;
  if (useDiskCache) {
    cache = readDiskCache();
    const hit = cache.entries[cacheKey];
    const fresh = hit ? usable(hit.items) : [];
    if (hit && fresh.length >= want && Date.now() - (hit.at || 0) < CACHE_TTL_MS) {
      const mins = Math.max(1, Math.round((Date.now() - hit.at) / 60000));
      return { items: fresh.slice(0, want), backend: `缓存（${mins} 分钟前搜过）`, errors: [] };
    }
  }

  /**
   * ── 搜索顺序（2026-10-20 用户要求，简体输入为例）────────────────────
   *   ① 第三方接口搜「简体」
   *   ② 第三方接口搜「繁体」
   *   ③ 原生搜索搜「简体」
   *   ④ 原生搜索搜「繁体」
   * 每一步都会**累积**结果（按 pid 去重）；数量够了就停，不够就继续下一步，直到取完。
   * 也就是说：以前是"谁先搜到就用谁"，现在是"不够就补齐"。
   */
  const collected = [];
  const seen = new Set(excludeSet);
  const usedBackends = [];
  const take = (items, label) => {
    let added = 0;
    for (const it of Array.isArray(items) ? items : []) {
      const pid = String(it?.pid || '').trim();
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      collected.push(it);
      added += 1;
      if (collected.length >= want) break;
    }
    if (added && label && !usedBackends.includes(label)) usedBackends.push(label);
    return added;
  };
  const enough = () => collected.length >= want;
  const variantLabel = (variant) => (variant === kw ? '' : `（繁体「${variant}」）`);

  // ② 第三方（lolicon）：简体 → 繁体，每种各试 tag / keyword
  for (const variant of variants) {
    if (enough()) break;
    for (const mode of modes) {
      if (enough()) break;
      const url = new URL(base);
      url.searchParams.set(mode, variant);
      url.searchParams.set('num', String(Math.max(want - collected.length, 5)));
      url.searchParams.set('r18', allowR18 ? '2' : '0');
      if (opts.excludeAI) url.searchParams.set('excludeAI', 'true');
      try {
        const text = await (opts.fetchText || fetchText)(url.toString(), {
          timeout: opts.timeout || 20000,
          retries: opts.retries ?? 1,
          signal: opts.signal,
          // 公开检索接口**直连**（2026-10-19 用户要求）：代理开着时不走代理，见 http.js 的 directFetch
          fetch: directFetch,
          headers: { 'User-Agent': opts.userAgent || DEFAULT_UA, Accept: 'application/json' },
        });
        const json = JSON.parse(text);
        let items = mapSearchItems(json);
        if (!allowR18) items = items.filter((it) => ratingOf(it) === 0);
        if (!items.length) {
          errors.push(`内置接口（${mode}${variantLabel(variant)}）没有结果`);
          continue;
        }
        take(items, `lolicon/${mode}${variantLabel(variant)}`);
      } catch (err) {
        errors.push(`内置接口（${mode}${variantLabel(variant)}）失败：${err.message}`);
      }
    }
  }

  // ③ 原生搜索：简体 → 繁体，接着补
  if (!enough() && opts.nativeFallback !== false) {
    // 熔断：连续失败 2 次就停 5 分钟（失败通常意味着代理这条隧道对 pixiv 不通）
    const breaker = useDiskCache ? cache?.native || { count: 0, at: 0 } : { count: 0, at: 0 };
    const broke = breaker.count >= NATIVE_BREAKER_COUNT && Date.now() - (breaker.at || 0) < NATIVE_BREAKER_MS;
    if (broke) {
      const mins = Math.max(1, Math.ceil((NATIVE_BREAKER_MS - (Date.now() - breaker.at)) / 60000));
      errors.push(`Pixiv 原生搜索临时跳过（最近连续被重置，约 ${mins} 分钟后再试）`);
    } else {
      for (const variant of variants) {
        if (enough()) break;
        try {
          const native = await searchPixivNative(variant, { ...opts, limit: Math.max(1, want - collected.length) });
          if (!native.items.length) {
            errors.push(`Pixiv 原生搜索${variantLabel(variant)}也没有结果`);
            if (useDiskCache) saveSearchCache(cache, cacheKey, null, { resetBreaker: true });
            continue;
          }
          take(native.items, `pixiv-native${variantLabel(variant)}`);
          if (useDiskCache) saveSearchCache(cache, cacheKey, null, { resetBreaker: true });
        } catch (err) {
          errors.push(`Pixiv 原生搜索${variantLabel(variant)}失败：${err.message}`);
          if (useDiskCache) saveSearchCache(cache, cacheKey, null, { bumpBreaker: true });
          // 原生搜索出网络问题就别再试第二个写法了（同一台代理，多试一次只是多等）
          if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|连接被重置|连接超时|请求超时|超时|timeout|网络/i.test(String(err?.message || ''))) break;
        }
      }
    }
  }

  if (!collected.length) return { items: [], backend: 'none', errors };

  const backend = usedBackends.join('+');
  if (useDiskCache) saveSearchCache(cache, cacheKey, collected.slice(0, want));
  return { items: collected.slice(0, want), backend, errors };
}

/**
 * Pixiv **原生**搜索：直接打官方 ajax 接口，按标签/关键词搜作品（需要能连上 pixiv.net）。
 *
 * 返回形状与 `searchPixiv` 一致（`{items, backend, errors}`）：条目里只有 pid/标题/作者/标签，
 * **不带图片地址** —— 取图仍然交给 `enumeratePixivMirror()`（pixiv.re 反代，不需要代理），
 * 所以只有"搜索"这一步需要联网 pixiv.net。
 *
 * 注意：
 *   · R18 作品需要登录态（`PHPSESSID`）；没登录时官方只返回全年龄，这正好是默认行为。
 *   · 新老结构不同：`body.illustManga.data` / `body.illust.data` 都兜一下。
 */
async function searchPixivNative(keyword, opts = {}) {
  const kw = String(keyword ?? '').trim();
  if (!kw) throw new Error('搜索关键词为空');
  // 2026-10-20：原来最多 20 个，跟「每次搜图没有硬上限」冲突 —— 放到 500
  const want = Math.max(1, Math.min(500, Number(opts.limit) || 3));
  const url = new URL(`${NATIVE_SEARCH_BASE}${encodeURIComponent(kw)}`);
  url.searchParams.set('word', kw);
  url.searchParams.set('order', 'date_d');
  url.searchParams.set('mode', 'all');
  url.searchParams.set('p', '1');
  url.searchParams.set('s_mode', 's_tag_full');
  url.searchParams.set('type', 'all');
  url.searchParams.set('lang', 'zh');
  const headers = {
    'User-Agent': opts.userAgent || DEFAULT_UA,
    Accept: 'application/json',
    Referer: NATIVE_REFERER,
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  if (opts.cookie) headers.Cookie = String(opts.cookie);
  /**
   * ⚠️ 原生搜索**必须走代理**（2026-10-19 用户要求）：www.pixiv.net 国内直连不通。
   * 这里刻意**不传** `fetch: directFetch` —— 用全局实现（setHttpProxy 注入的那个，
   * 没配代理时就是 Node 内置直连，那时原生搜索本来也连不上，属于预期）。
   *
   * 重试（2026-10-19 加）：代理节点偶尔会瞬间把连接重置（ECONNRESET），一两秒后再打就好。
   * 实测同一种请求：12:40 失败（ECONNRESET）、12:47 直接 200 —— 典型的"节点抽风"。
   * 所以这里对**连接类**错误再多试两次（600ms / 1500ms 退避），其它错误（403/404/JSON 坏）不重试。
   */
  const callNative = () => (opts.fetchText || fetchText)(url.toString(), {
    // 单次尝试要**短**：重试交给下面的外层循环（3 次 × 9s ≈ 最坏 30s 就放弃）。
    // 之前是 12s × 内层 retries:1 × 外层 3 次 ≈ 最坏 75s，群里要干等一分多钟才看到失败。
    timeout: opts.nativeTimeout || 6000,
    retries: 0,
    signal: opts.signal,
    fetch: opts.nativeFetch || undefined,
    headers,
  });
  const retryable = (msg) => /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|连接被重置|连接超时|网络请求失败/i.test(String(msg || ''));
  let text;
  {
    let lastError = null;
    const delays = [0, 700];
    for (let i = 0; i < delays.length; i += 1) {
      if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
      try {
        text = await callNative();
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (!retryable(err?.message) || opts.signal?.aborted) break;
      }
    }
    if (lastError) throw lastError;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('原生搜索返回的不是 JSON（可能被风控页拦了）');
  }
  if (json && json.error) throw new Error(`原生搜索报错：${json.message || '未知'}`);
  const list = json?.body?.illustManga?.data || json?.body?.illust?.data || json?.body?.manga?.data || [];
  const allowR18 = opts.allowR18 === true;
  const items = [];
  for (const it of Array.isArray(list) ? list : []) {
    const pid = String(it?.id ?? it?.illustId ?? '').trim();
    if (!/^\d+$/.test(pid)) continue;
    const tags = Array.isArray(it?.tags) ? it.tags.map((t) => String(t)) : [];
    const entry = {
      pid,
      title: String(it?.title ?? '').trim() || '（无题）',
      author: String(it?.userName ?? it?.author ?? '').trim() || '（未知作者）',
      userId: String(it?.userId ?? '').trim(),
      tags,
      xRestrict: Number(it?.xRestrict) > 0 ? Number(it.xRestrict) : 0,
      /**
       * 从**缩略图地址**反推原图地址（2026-10-19 加）。
       *
       * 原生搜索只给 pid 和一张小图，取图还得靠反代；而反代的**简写**
       * （`pixiv.re/<pid>.png`）经常 500，没有完整路径就整个作品取不到
       * （真实现场：「拜託讓烏啾滿潛」搜到了、图却下不来）。
       * 缩略图里其实带着日期目录和页码：
       *   i.pximg.net/c/250x250_80_a2/img-master/img/2023/01/02/03/04/05/150578777_p0_square1200.jpg
       *   → i.pixiv.re/img-original/img/2023/01/02/03/04/05/150578777_p0.png
       * 换成反代主机后**直连就能下**，多图作品还能靠 `_p0→_p1…` 继续探页。
       */
      url: originalUrlFromThumb(it?.url),
      pageCount: 0,
    };
    if (!allowR18 && ratingOf(entry) !== 0) continue;
    items.push(entry);
    if (items.length >= want) break;
  }
  return { items, backend: 'pixiv-native', errors: [] };
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
  let firstUrl = String(opts.knownUrl || '').trim();
  let meta = null;
  if (opts.lookup !== false) {
    // 有 PID 时反查一次标题/作者：接口支持 `pid=` 过滤吗？不支持也没关系（失败就跳过）
    try {
      const res = await searchPixivByPid(id, opts);
      if (res) {
        meta = res;
        if (!firstUrl) firstUrl = res.url || '';
      }
    } catch (err) {
      onLog(`反查作品信息失败（不影响取图）：${err.message}`);
    }
  }

  /**
   * 取图顺序（2026-10-18 修）：
   *   ① **已知的完整原图地址**（检索接口给的 `urls.original`，形如
   *      `https://i.pixiv.re/img-original/img/2023/11/12/20/00/03/<pid>_p0.png`）；
   *   ② 反代**简写**逐页枚举（`pixiv.re/<pid>.png`）；
   *   ③ 简写挂了时，用 ① 的地址**按 `_p0` → `_p1` → …** 自己探页。
   *
   * 为什么必须这么改：`pixiv.re/<pid>.png` 这种简写现在经常直接 **HTTP 500**，
   * 而同一张图的完整路径（`i.pixiv.re/img-original/…_p0.png`）是 **200/206 正常的**。
   * 原来的代码无条件 await 简写枚举，它一抛错整条路就废了 ——
   * 表现就是群里那句"搜到了，但 pixiv 反代这会儿取不到图"。
   */
  const urls = [];
  /**
   * ⚠️ 两条路**互斥**，别都跑：简写枚举和完整路径指向的是**同一张图**（只是 URL 不同），
   * 都跑会让"1 页的作品下出 2 张一样的图"（实测踩到过）。所以：
   *   · 完整路径探得通 → 只用它探页（`_p0` → `_p1`…）；
   *   · 否则才退回简写枚举。
   *
   * 另外：**扩展名要试**（2026-10-19 现场）。反代上的原图可能是 png，也可能是 jpg ——
   * 从缩略图反推出的地址默认写 `.png`，遇到 jpg 作品就 404（实测 pid 150578777 是 jpg）。
   * 所以这里按 png → jpg → gif 依次探一次，探通哪个用哪个。
   */
  if (firstUrl) {
    let resolved = '';
    for (const cand of extVariants(firstUrl)) {
      const probe = await probeImage(cand, opts);
      if (probe.ok) {
        resolved = cand;
        if (cand !== firstUrl) onLog(`原图扩展名是 ${cand.split('.').pop()}（不是 png），按它继续`);
        break;
      }
    }
    if (resolved) {
      if (/_p0\.[a-z]+$/i.test(resolved)) {
        const derived = await enumerateFromOriginal(resolved, { ...opts, onLog });
        for (const u of derived) if (!urls.includes(u)) urls.push(u);
        if (derived.length > 1) onLog(`从完整原图路径探到 ${derived.length} 页`);
      } else {
        urls.push(resolved);
      }
    } else {
      onLog(`已知原图地址不可用（png/jpg/gif 都试过了），改用反代简写枚举`);
    }
  }

  if (!urls.length) {
    try {
      const enumerated = await enumeratePixivMirror(id, opts);
      for (const u of enumerated.urls) if (!urls.includes(u)) urls.push(u);
    } catch (err) {
      onLog(`反代简写枚举失败：${err.message}`);
    }
  }

  if (!urls.length) {
    throw new Error(`图片反代上没有这个作品（${id}）：简写和完整路径都取不到，可能已被作者删除或反代抽风`);
  }

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

/**
 * 同一个原图地址的**扩展名候选**（png → jpg → gif）：反代上的原图可能是 png 也可能是 jpg，
 * 猜错了就 404，所以调用方按这个顺序逐个探。
 */
function extVariants(url) {
  const s = String(url || '');
  const m = s.match(/^(.*_p\d+)\.(png|jpg|jpeg|gif|webp)$/i);
  if (!m) return [s];
  return ['png', 'jpg', 'gif', 'jpeg', 'webp'].map((ext) => `${m[1]}.${ext}`);
}
/**
 * 从"完整原图地址"里探页：把 `_p0.png` 换成 `_p1.png` / `_p2.png`… 直到 404。
 * 只用于「反代简写挂了」时的兜底，页数一般不多（<= 10）。
 */
async function enumerateFromOriginal(originalUrl, opts = {}) {
  const out = [originalUrl];
  const max = Math.max(1, Math.min(20, Number(opts.maxPages) || 12));
  for (let page = 1; page < max; page += 1) {
    const url = originalUrl.replace(/_p0(\.[a-z]+)$/i, `_p${page}$1`);
    if (url === originalUrl) break;
    const info = await probeImage(url, opts);
    if (!info.ok) break;
    out.push(url);
  }
  return out;
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
      fetch: directFetch,          // 公开检索接口：直连，不走代理
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
  // 数量**不再卡 20**（2026-10-20 用户要求：每次搜图没有硬上限），只留一个防跑飞的天花板
  const count = Math.max(1, Math.min(Number(opts.maxItems) || 500, Number(opts.count) || 3));
  const outDir = opts.outDir || process.cwd();
  const onLog = opts.onLog || (() => {});
  const onProgress = opts.onProgress || (() => {});

  /**
   * 先把输入分类（2026-10-20）：
   *   pid / uid / 作者名 → 走官方 ajax 精确取；
   *   普通关键词        → 走「lolicon 简 → lolicon 繁 → 原生简 → 原生繁」的补齐式搜索。
   */
  const parsed = parsePixivQuery(keyword);
  const searchOpts = {
    // 多要几个候选：检索接口里混着"已被作者删除/限制访问"的作品，反代上直接 404。
    // 只按 count 取候选的话，一个 404 就让整次搜图少一个（count=1 时就是"什么都没搜到"），
    // 所以这里按 count + 备胎 取，凑够 count 个**下成功的**就停。
    limit: count + Math.min(10, count),
    allowR18: opts.allowR18 === true,
    apiBase: opts.apiBase,
    excludeAI: opts.excludeAI,
    userAgent: opts.userAgent,
    timeout: opts.timeout,
    signal: opts.signal,
    // 免代理接口没搜到就自动改用 Pixiv 原生搜索（需要能连上 pixiv.net）
    nativeFallback: opts.nativeFallback,
    // 节点自救（默认关）：原生搜索被重置时，切到能连 pixiv 的节点再试一次
    pixivNodeFailover: opts.pixivNodeFailover,
    cookie: opts.cookie,
    fetchText: opts.fetchText,
    // 已经发过的作品不要再出现（插件从"发过的 pid"传进来）
    excludePids: Array.isArray(opts.excludePids) ? opts.excludePids : [],
  };

  let found;
  if (parsed.kind === 'pid') {
    onLog(`按 pid 取作品：${parsed.value}`);
    found = await searchPixivByPidWork(parsed.value, searchOpts);
  } else if (parsed.kind === 'uid') {
    onLog(`按画师 uid 取作品：${parsed.value}（最多 ${count} 个）`);
    found = await searchPixivByUid(parsed.value, searchOpts);
  } else if (parsed.kind === 'author') {
    onLog(`按作者名搜：${parsed.value}（最多 ${count} 个）`);
    found = await searchPixivByAuthor(parsed.value, searchOpts);
  } else {
    found = await searchPixiv(parsed.value || keyword, searchOpts);
  }

  const results = [];
  if (!found.items.length) {
    return { keyword, backend: found.backend, items: [], results, errors: found.errors };
  }
  if (opts.listOnly) {
    return {
      keyword,
      backend: found.backend,
      items: found.items,
      results: found.items.map((it) => ({ ...listEntryOf(it), backend: found.backend })),
      errors: found.errors,
    };
  }

  let okCount = 0;
  for (const [index, it] of found.items.entries()) {
    if (okCount >= count) break;   // 已经凑够要的数量，剩下的候选不用再动
    onProgress({ stage: 'download', percent: -1, message: `第 ${index + 1} 个作品（目标 ${count} 个）：${it.title}` });
    let r = await downloadWorkOnce(it, opts);
    /**
     * 反代抽风（HTTP 500/404、某页取不到）是**瞬时**的，重试一次往往就成 ——
     * 2026-10-18 现场：`奶蛙` 明明搜到了 1 个作品，第 1 页取不到（HTTP 500）→
     * 整次搜图 0 张，群里只收到失败提示；同一秒手动重跑一次就正常下到了。
     */
    if (!r.ok && /反代|HTTP 5\d\d|HTTP 404|取不到/.test(String(r.error || ''))) {
      onProgress({ stage: 'download', percent: -1, message: '反代抽风，重试一次…' });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      r = await downloadWorkOnce(it, opts);
    }
    if (r.ok) okCount += 1;
    // 带上"这次是哪个后端搜出来的"，让上层（插件/界面）能说明
    // "内置接口没搜到，已自动改用 Pixiv 原生搜索"
    results.push({ ...r, backend: found.backend });
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
      // ⚠️ 把检索接口给的完整原图地址带进去：反代简写（pixiv.re/<pid>.png）经常 500，
      // 而完整路径通常是好的（2026-10-18 现场），不带它就只剩那条会 500 的路。
      knownUrl: it.url,
      mirrorBase: opts.mirrorBase,
      apiBase: opts.apiBase,
      userAgent: opts.userAgent,
      timeout: opts.timeout,
      onLog,
    });
    const folder = workFolderName(it);
    /**
     * 图床**多路兜底**（2026-10-22 用户报"洛茜搜图超时 360 秒"）：
     * 现场实测：`i.pixiv.re` 直连 15 秒超时、`i.pximg.net` 经代理被重置、其它反代 500/10 秒失败 ——
     * 旧代码只认一条路，一条路挂了就一路干等到 360 秒超时，一张图都发不出来。
     * 现在：把同一张图的**路径**套到多个图床上逐个试（首选上次成功的、超时 8 秒），
     * 谁先通就用谁，并记住它；全部不通就立刻失败并说清楚，不再傻等。
     */
    const HOSTS = ['https://i.pixiv.re', 'https://i.pixiv.cat', 'https://i.pixiv.nl', 'https://i.pximg.net'];
    const paths = (illust.urls || []).map((u) => {
      try { return new URL(u).pathname; } catch { return ''; }
    }).filter(Boolean);
    let preferred = '';
    try { preferred = String(require('node:fs').readFileSync(IMAGE_HOST_FILE, 'utf8') || '').trim(); } catch { /* 还没记过 */ }
    const order = [...new Set([preferred, ...HOSTS].filter(Boolean))];
    let lastError = '';
    /**
     * 先**并行探一下每个图床的真实吞吐**（Range 取 64KB，8 秒截止），按速度排序：
     * 2026-10-22 现场：pixiv.re 拿满一个 4.5MB 图要 184 秒、下一个 PNG 拖到 490 秒，
     * 而同一时刻 pximg 走代理 735ms 就回了 64KB。不测速就会一直撞最慢的那条路。
     */
    const probeHost = async (host) => {
      const url = host + paths[0];
      const official = isPixivOfficialHost(host);
      const t0 = Date.now();
      try {
        const r = await request(url, {
          timeout: 8000,
          retries: 0,
          wantBody: true,
          signal: AbortSignal.timeout(8000),
          fetch: official ? undefined : directFetch,
          headers: {
            'User-Agent': opts.userAgent || DEFAULT_UA,
            Referer: official ? 'https://www.pixiv.net/' : '',
            Range: 'bytes=0-65535',
          },
        });
        const bytes = (r.body || Buffer.alloc(0)).length;
        const ms = Math.max(1, Date.now() - t0);
        if (r.status >= 400 || bytes < 1024) return { host, ok: false, rate: 0, ms, size: 0 };
        // content-range: bytes 0-65535/4512345 → 总大小（用来估算这条图床要下多久）
        const cr = String(r.headers?.get?.('content-range') || '');
        const total = Number((cr.split('/')[1] || '0').trim()) || 0;
        return { host, ok: true, rate: bytes / ms, ms, size: total };
      } catch (err) {
        return { host, ok: false, rate: 0, ms: Date.now() - t0, err: err.message };
      }
    };
    const probes = await Promise.all(order.map(probeHost));
    probes.sort((a, b) => (b.ok - a.ok) || (b.rate - a.rate));
    const usable = probes.filter((x) => x.ok);
    if (usable.length) {
      onLog('图床测速：' + usable.map((x) => `${x.host.replace('https://', '')} ${Math.round(x.rate)}KB/s`).join('，'));
    }
    /**
     * 全都慢到没法用（< 40KB/s，按 4.5MB 算要两分钟以上）→ 直接说清楚，别拖到超时。
     * 这是"快失败"：群里立刻知道是图床慢，而不是等 6 分钟收到一句"超时了"。
     */
    const best = usable[0];
    /**
     * 估算这批图最快要多久：抢跑会让两条路**平分带宽**，大图抢跑反而两条都超时
     * （2026-10-22 现场：4.2MB 的 PNG 抢跑后两条各 45KB/s，双双撞 45 秒截止）。
     * 所以：小图抢跑（快），大图只走最快的一条并给足时间（稳）。
     */
    const totalBytes = Math.max(1, (best?.size || 0) || 4 * 1024 * 1024) * Math.max(1, paths.length);
    const estSec = best ? totalBytes / (best.rate * 1000) : 999;
    const useRace = estSec <= 20 && usable.length > 1;
    const hostDeadlineMs = Math.min(180000, Math.max(30000, Math.round(estSec * 2000)));
    if (best && estSec > 240) {
      return withPreviewUrls({
        ...entry,
        ok: false,
        files: [],
        bytes: 0,
        error: `图床太慢（最高 ${Math.round(best.rate)}KB/s），过一会儿再试`,
      }, it);
    }
    const order2 = [...usable.map((x) => x.host), ...order.filter((h) => !usable.some((x) => x.host === h))];
    /**
     * **并行抢跑**（2026-10-22）：先让最快的两个图床同时下同一张图，谁先下完用谁。
     * 现场单条路只有 60~150KB/s，一个 4MB 的作品要 60 秒以上；串行试 4 个图床就是 4 分钟。
     * 抢跑之后最坏情况≈"最慢那条路的时间"，而且慢的那条会被 abort 掉、不占带宽。
     */
    const attempt = async (host, outerSignal) => {
      // 用按大小估出来的截止（大图给足时间），调用方显式传的优先
      const deadlineMs = Number(opts.hostDeadlineMs) || hostDeadlineMs;
      const ac = new AbortController();
      const timer = setTimeout(() => { try { ac.abort(new Error('超过 ' + Math.round(deadlineMs / 1000) + ' 秒')); } catch { /* ignore */ } }, deadlineMs);
      try {
        const res = await downloadImages({
          items: paths.map((p) => host + p).map((url) => ({
            url,
            fetch: isPixivOfficialHost(url) ? undefined : directFetch,
          })),
          outDir: path.join(outDir, folder),
          baseName: folder,
          referer: isPixivOfficialHost(host) ? 'https://www.pixiv.net/' : '',
          userAgent: opts.userAgent,
          headers: opts.headers,
          // 三个信号任一触发都停：调用方的、单条路的硬截止、被别的图床抢先后的取消
          signal: AbortSignal.any([opts.signal, ac.signal, outerSignal].filter(Boolean)),
          verifySizes: false,
          concurrency: opts.concurrency,
          timeout: opts.imageTimeout || 9000,
          logger: onLog,
          onProgress: (p) => onProgress({ stage: 'download', ...p }),
        });
        const files = res.files || [];
        if (!files.length) throw new Error(res.failed?.[0]?.error || '没有下载到图片');
        return { host, files, dir: res.dir, bytes: res.bytes };
      } finally {
        clearTimeout(timer);
      }
    };
    const aborts = new Map();
    const racer = (host) => {
      const ac = new AbortController();
      aborts.set(host, ac);
      return attempt(host, ac.signal);
    };
    let won = null;
    const head = useRace ? order2.slice(0, 2) : order2.slice(0, 1);
    if (head.length) {
      try {
        won = await Promise.any(head.map(racer));
      } catch {
        won = null;
      }
      for (const [host, ac] of aborts) if (!won || host !== won.host) ac.abort();
    }
    if (!won) {
      for (const host of order2.slice(head.length)) {
        try {
          won = await attempt(host);
          break;
        } catch (err) {
          lastError = err.message;
          onLog('图床 ' + host.replace('https://', '') + ' 不通（' + String(lastError).slice(0, 30) + '）');
        }
      }
    }
    if (won) {
      try { require('node:fs').writeFileSync(IMAGE_HOST_FILE, won.host, 'utf8'); } catch { /* 记不住也不影响 */ }
      onLog('图床用 ' + won.host.replace('https://', '') + '（' + won.files.length + ' 张）');
      return withPreviewUrls({
        ...entry,
        ok: true,
        filePath: won.files.length === 1 ? won.files[0] : won.dir,
        dir: won.dir,
        files: won.files,
        bytes: won.bytes,
        pages: illust.urls.length,
        error: ''
      }, it);
    }
    return withPreviewUrls({ ...entry, ok: false, files: [], bytes: 0, error: lastError || '所有图床都连不上' }, it);
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

/**
 * ── 按 pid / uid / 作者名搜索（2026-10-20 用户要求）────────────────────
 *
 * 三种入口都走 pixiv **官方 ajax**（要能连 pixiv.net，也就是需要代理）：
 *   · pid   ：`/ajax/illust/<pid>`            → 单个作品详情
 *   · uid   ：`/ajax/user/<uid>/profile/all`   → 该画师全部作品 id，再逐个取详情
 *   · 作者名：`/search_user.php?nick=<名字>`   → 用户搜索结果 HTML 里抠 userId
 *
 * 自动识别（`parsePixivQuery`）：
 *   `pixiv.net/artworks/123` / `pixiv.net/i/123` / 纯数字 123 → pid
 *   `pixiv.net/users/456` / `uid:456` / `画师:456`            → uid
 *   `author:名字` / `作者:名字` / `画师:名字`                  → 作者名
 *   其它                                                       → 普通关键词
 */

/** 调一次 pixiv 官方 ajax（走代理），返回 JSON；失败抛错 */
async function pixivAjax(pathname, opts = {}) {
  const url = `https://www.pixiv.net${pathname}`;
  const text = await (opts.fetchText || fetchText)(url, {
    timeout: opts.nativeTimeout || 8000,
    retries: 0,
    signal: opts.signal,
    fetch: opts.nativeFetch || undefined,
    headers: {
      'User-Agent': opts.userAgent || DEFAULT_UA,
      Accept: 'application/json',
      Referer: 'https://www.pixiv.net/',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  });
  const json = JSON.parse(text);
  if (json && json.error) throw new Error(`pixiv 接口报错：${json.message || '未知'}`);
  return json;
}

/** 把 `i.pximg.net/img-original/...` 换成反代主机，得到**直连可下**的原图地址 */
function mirrorUrlOf(originalUrl) {
  const s = String(originalUrl || '').trim();
  if (!s) return '';
  if (/^https?:\/\/i\.pximg\.net\//i.test(s)) return s.replace(/^https?:\/\/i\.pximg\.net\//i, 'https://i.pixiv.re/');
  if (/^https?:\/\//i.test(s)) return '';
  return '';
}

/** 单个作品详情 → 统一的 item 形状 */
async function fetchIllustDetail(pid, opts = {}) {
  const json = await pixivAjax(`/ajax/illust/${encodeURIComponent(pid)}`, opts);
  const b = json?.body || {};
  const tags = Array.isArray(b.tags?.tags) ? b.tags.tags.map((t) => String(t?.tag ?? t)) : [];
  const url = mirrorUrlOf(b.urls?.original) || originalUrlFromThumb(b.urls?.thumb);
  return {
    pid: String(b.illustId || pid),
    title: String(b.illustTitle || '').trim() || '（无题）',
    author: String(b.userName || '').trim() || '（未知作者）',
    userId: String(b.userId || '').trim(),
    tags,
    xRestrict: Number(b.xRestrict) > 0 ? Number(b.xRestrict) : 0,
    url,
    pageCount: Number(b.pageCount) || 0,
  };
}

/** 按 pid 取一个作品 */
async function searchPixivByPidWork(pid, opts = {}) {
  const id = String(pid || '').trim();
  if (!/^\d+$/.test(id)) throw new Error(`pid 不合法：${pid}`);
  const item = await fetchIllustDetail(id, opts);
  if (opts.allowR18 !== true && ratingOf(item) !== 0) {
    return { items: [], backend: 'pixiv-pid', errors: ['这个作品是成人向的，按设置跳过'] };
  }
  return { items: [item], backend: 'pixiv-pid', errors: [] };
}

/** 按 uid 取该画师的作品（新的在前） */
async function searchPixivByUid(uid, opts = {}) {
  const id = String(uid || '').trim();
  if (!/^\d+$/.test(id)) throw new Error(`uid 不合法：${uid}`);
  const want = Math.max(1, Math.min(Number(opts.maxItems) || 500, Number(opts.limit) || 3));
  const errors = [];
  const profile = await pixivAjax(`/ajax/user/${encodeURIComponent(id)}/profile/all`, opts);
  const pids = Object.keys(profile?.body?.illusts || {})
    .map(String)
    .sort((a, b) => Number(b) - Number(a));      // 作品 id 越大越新
  if (!pids.length) return { items: [], backend: 'pixiv-uid', errors: ['这个画师没有公开作品（或被限制）'] };
  const items = [];
  for (const pid of pids.slice(0, Math.min(pids.length, want + 3))) {
    if (items.length >= want) break;
    try {
      const it = await fetchIllustDetail(pid, opts);
      if (opts.allowR18 !== true && ratingOf(it) !== 0) continue;
      items.push(it);
    } catch (err) {
      errors.push(`${pid}：${err.message}`);
    }
  }
  return { items: items.slice(0, want), backend: 'pixiv-uid', errors };
}

/**
 * 按作者名搜（2026-10-20）。
 *
 * 走过的弯路，都写下来免得再踩：
 *   · `/ajax/search/users` 对**未登录**请求一律 400 —— 官方用户搜索用不了；
 *   · `search_user.php` 的 HTML 里 `/users/N` 链接全是页头推荐位（抓 author:MyT 时拿到别人 uid）；
 *   · 把作者名当 tag 搜，返回的是**同 tag 的别人的作品**（米山舞 → wangdada/Box!…），
 *     按作者名过滤等于 0 条。
 * 现在用**两段式**：
 *   ① 用 Bing 搜 `site:pixiv.net/users <名字>`，从结果里捞 `pixiv.net/users/<uid>`（Bing 国内直连可用）；
 *   ② 逐个 uid 列作品，再用「作者名核对」确认是本人（名字对不上就换下一个）。
 * 找不到就明确提示改用 `uid:` 或贴主页链接。
 */
async function searchPixivByAuthor(name, opts = {}) {
  const q = String(name || '').trim();
  if (!q) throw new Error('作者名为空');
  const want = Math.max(1, Math.min(Number(opts.maxItems) || 500, Number(opts.limit) || 3));
  const errors = [];
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
  const target = norm(q);

  /**
   * 作者名的两条路（2026-10-20 实测）：
   *   ① **有登录态**（`--cookies` / Edge 里的 pixiv cookie）→ `/ajax/search/users` 能用，直接拿 uid；
   *   ② **没登录** → 官方用户搜索一律 400，`search_user.php` 的 HTML 里全是推荐位、
   *      Bing/Baidu 的 `site:` 结果里也没有 pixiv 用户页（都实测过）→ 只能明确告诉用户改用 uid。
   */
  let uids = [];
  if (opts.cookie) {
    try {
      const word = encodeURIComponent(q);
      const json = await pixivAjax(`/ajax/search/users?word=${word}&order=date_d&mode=all&p=1&s_mode=s_username`, opts);
      const users = Array.isArray(json?.body?.users) ? json.body.users : [];
      for (const u of users) {
        const uid = String(u?.userId || '').trim();
        const name2 = String(u?.userName || '');
        if (!uid) continue;
        // 名字能对上就优先，对不上也先收着（下面会再用作品作者名核对）
        uids.push(uid);
        if (norm(name2).includes(target) && uids.length > 1) break;
      }
    } catch (err) {
      errors.push(`用登录态搜作者失败：${err.message}`);
    }
  }
  if (!uids.length) {
    errors.push(
      `没搜到作者「${q}」的 uid：pixiv 的 /ajax/search/users 接口**现在连登录态下都返回 400**（实测），搜索引擎那边也没有 pixiv 用户页。` +
        '可以直接贴画师主页链接，或者用 `uid:123456`；配好 pixiv 登录 cookie 后我就能按名字搜。'
    );
    return { items: [], backend: 'none', errors };
  }

  const matched = [];
  for (const uid of uids) {
    if (matched.length >= want) break;
    try {
      const r = await searchPixivByUid(uid, { ...opts, limit: want - matched.length + 5 });
      for (const it of r.items) {
        if (matched.length >= want) break;
        const a = norm(it.author);
        if (!a) continue;
        if (!a.includes(target) && !target.includes(a)) continue;
        if (!matched.some((x) => x.pid === it.pid)) matched.push(it);
      }
      if (!r.items.length && r.errors?.length) errors.push(`uid ${uid}：${r.errors[0]}`);
    } catch (err) {
      errors.push(`uid ${uid}：${err.message}`);
    }
  }
  if (!matched.length) errors.push(`按名字找到 ${uids.length} 个候选画师，但作者名都对不上「${q}」——建议改用 \`uid:${uids[0]}\``);
  return { items: matched, backend: matched.length ? 'pixiv-author' : 'none', errors };
}

/**
 * 判断用户输入是什么：pid / uid / 作者名 / 普通关键词。
 * @returns {{kind:'pid'|'uid'|'author'|'keyword', value:string}}
 */
function parsePixivQuery(input) {
  const raw = String(input || '').trim();
  if (!raw) return { kind: 'keyword', value: '' };
  let m = raw.match(/pixiv\.net\/(?:artworks|i|illust_id\.php\?illust_id=)\/?(\d+)/i) || raw.match(/^artworks?[/:](\d+)$/i);
  if (m) return { kind: 'pid', value: m[1] };
  m = raw.match(/pixiv\.net\/users\/(\d+)/i) || raw.match(/^(?:uid|user|画师|作者)[:：]\s*(\d+)$/i);
  if (m) return { kind: 'uid', value: m[1] };
  m = raw.match(/^(?:author|artist|作者|画师|作家)[:：]\s*(.+)$/i);
  if (m) return { kind: 'author', value: m[1].trim() };
  if (/^\d{5,}$/.test(raw)) return { kind: 'pid', value: raw };
  return { kind: 'keyword', value: raw };
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
  searchPixivNative,
  searchPixivByPid,
  mapSearchItems,
  ratingOf,
  searchAndDownloadPixiv,
  workFolderName,
  fetchPixivViaMirror,
  previewUrlOf,
  downloadPixivWorks,
  // pid / uid / 作者名 搜索（2026-10-20）
  parsePixivQuery,
  searchPixivByPidWork,
  searchPixivByUid,
  searchPixivByAuthor,
};
