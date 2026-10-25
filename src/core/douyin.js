'use strict';

/**
 * ⚠️ 现状（2026-10-24 实测）：**这条接口通道目前被抖音挡住了**，主流程没有接入。
 *
 *   GET www.douyin.com/aweme/v1/web/aweme/detail/（带 ttwid）
 *     → 403 "Blocked by ArgusSecurityPlugin Uifid Not Found"
 *
 *   Argus 现在要的是 `uifid`（浏览器指纹哈希）+ `msToken` + `a_bogus`（JS 签名），
 *   全是浏览器现场生成的，HTTP 层拿不到；iesdouyin 的分享页也只剩 32KB 空壳
 *   （`_ROUTER_DATA` 里没有 videoInfoRes），iteminfo v2 / snssdk 两个老接口都返回空。
 *
 * 所以本文件**保留但未启用**：等 Argus 放松、或找到新的无签名接口时，
 * 直接接回 `downloader.js` 即可（`probeDouyin()` 的返回结构已经对齐）。
 * 现在抖音下载只能走浏览器通道（`browser-page.js`），风控页会被快速识别并给出提示。
 *
 * ── 以下为原始说明 ────────────────────────────────────────────────────────
 *
 * 抖音（Douyin）**接口通道**：不启动浏览器、不碰验证码，直接拿无水印直链。
 * 为什么需要（2026-10-24 用户报「本插件下载抖音经常跳人机验证」）：
 *   本工具原来的顺序是 yt-dlp → 内置浏览器渲染 `www.douyin.com/video/<id>`。
 *   2026-10 起抖音上了 ArgusSecurityPlugin：yt-dlp 打 detail 接口拿到的是**空响应**
 *   （报 "Fresh cookies are needed" 是借口），于是每次都落到浏览器兜底；
 *   而浏览器是**冷会话**（没有 ttwid、指纹是新的）→ 直接给「验证码中间页」。
 *
 * 这条路的原理（同行插件 media-download 的实测记录，本文件独立实现）：
 *   ① `www.douyin.com/aweme/v1/web/aweme/detail/` 带上 **ttwid** 就能返回完整 JSON
 *      （约 60KB，含 desc / author / video.download_addr / images / music）；
 *   ② ttwid 不需要登录、也不需要签名，请求 `https://www.iesdouyin.com/share/video/<id>/`
 *      的 Set-Cookie 里就带（有效期约 2 年）；
 *   ③ `video.download_addr.url_list[]` 本身就是**无水印**的 MP4（含音轨），
 *      不需要 ffmpeg 合流、也不需要转封装。
 *
 * 失败时抛错，调用方（downloader）会退回原来的 yt-dlp / 浏览器通道 —— 不会更差。
 */

const fs = require('node:fs');
const path = require('node:path');
const { request, directFetch } = require('./http');

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// iesdouyin 的分享页对**移动端**才会下发 ttwid（桌面 UA 只给 __ac_nonce）
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const IE_HOST = 'https://www.iesdouyin.com';
const WEB_HOST = 'https://www.douyin.com';
const TTWID_TTL_MS = 30 * 24 * 3600 * 1000;

function ttwidFile() {
  const base = process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || require('node:os').tmpdir();
  return path.join(base, 'vgrab', 'douyin-ttwid.json');
}

/** 这个链接是不是抖音（含短链域名） */
function isDouyinUrl(rawUrl) {
  try {
    const host = new URL(String(rawUrl)).hostname.toLowerCase();
    return /(^|\.)(douyin\.com|iesdouyin\.com|douyin\.ie)$/.test(host);
  } catch {
    return false;
  }
}

/** 从各种形态里抠作品 id：/video/123、/note/123、modal_id=123、aweme_id=123、/share/video/123 */
function extractAwemeId(rawUrl) {
  const s = String(rawUrl || '');
  const m =
    s.match(/\/video\/(\d{8,25})/) ||
    s.match(/\/note\/(\d{8,25})/) ||
    s.match(/[?&](?:modal_id|aweme_id|item_id)=(\d{8,25})/) ||
    s.match(/\/share\/(?:video|note)\/(\d{8,25})/);
  return m ? m[1] : '';
}

/** 跟随短链（v.douyin.com/xxx）拿到真正的落地页；需要拿到 id 但链接里没有时用 */
async function resolveAwemeUrl(rawUrl, opts = {}) {
  const url = String(rawUrl || '').trim();
  if (!url) throw new Error('抖音链接为空');
  const id = extractAwemeId(url);
  if (id) return { input: url, finalUrl: url, awemeId: id };
  const res = await request(url, {
    timeout: opts.timeout || 15000,
    retries: 0,
    wantBody: false,
    signal: opts.signal,
    fetch: directFetch,
    headers: { 'User-Agent': MOBILE_UA, Accept: 'text/html,application/xhtml+xml' },
  });
  const finalUrl = String(res.url || url);
  const got = extractAwemeId(finalUrl);
  if (!got) throw new Error(`短链没能解析出作品号：${finalUrl.slice(0, 120)}`);
  return { input: url, finalUrl, awemeId: got };
}

/** 读磁盘缓存的 ttwid（30 天） */
function readCachedTtwid() {
  try {
    const j = JSON.parse(fs.readFileSync(ttwidFile(), 'utf8'));
    if (j && j.value && Date.now() - Number(j.at || 0) < TTWID_TTL_MS) return String(j.value);
  } catch {
    /* 没缓存 */
  }
  return '';
}

function writeCachedTtwid(value) {
  try {
    const file = ttwidFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ value, at: Date.now() }), 'utf8');
  } catch {
    /* 记不住也不影响本次 */
  }
}

/** 从 set-cookie 里抠 ttwid（不同实现给的 header 形态不一样，统一按正则捞） */
function pickTtwid(res) {
  try {
    const headers = res && res.headers;
    const raw =
      (headers && typeof headers.getSetCookie === 'function' && headers.getSetCookie().join('; ')) ||
      (headers && typeof headers.get === 'function' && headers.get('set-cookie')) ||
      '';
    const m = String(raw).match(/ttwid=([^;,\s]+)/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/**
 * 取 ttwid：优先磁盘缓存 → `iesdouyin` 分享页 Set-Cookie。
 * @returns {Promise<string>} 拿不到就返回空串（调用方会报"需要 ttwid"的错）
 */
async function getTtwid(opts = {}) {
  if (opts.force) {
    /* 强制刷新 */
  } else {
    const cached = readCachedTtwid();
    if (cached) return cached;
  }
  const awemeId = String(opts.awemeId || '').trim();
  const paths = awemeId
    ? [`${IE_HOST}/share/video/${awemeId}/`, `${IE_HOST}/share/note/${awemeId}/`, `${WEB_HOST}/`]
    : [`${WEB_HOST}/`, `${IE_HOST}/`];
  for (const url of paths) {
    try {
      const res = await request(url, {
        timeout: opts.timeout || 12000,
        retries: 0,
        wantBody: false,
        signal: opts.signal,
        fetch: directFetch,
        headers: {
          'User-Agent': /iesdouyin/.test(url) ? MOBILE_UA : DESKTOP_UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
      });
      const ttwid = pickTtwid(res);
      if (ttwid) {
        writeCachedTtwid(ttwid);
        return ttwid;
      }
    } catch {
      /* 换下一个入口 */
    }
  }
  return '';
}

/** detail 接口的查询串（参数与顺序沿用实测可用的那套；缺参数会退回空体） */
function detailQuery(awemeId) {
  const q = new URLSearchParams();
  q.set('device_platform', 'webapp');
  q.set('aid', '6383');
  q.set('channel', 'channel_pc_web');
  q.set('aweme_id', String(awemeId));
  q.set('pc_client_type', '1');
  q.set('version_code', '170400');
  q.set('version_name', '17.4.0');
  q.set('cookie_enabled', 'true');
  q.set('screen_width', '1920');
  q.set('screen_height', '1080');
  q.set('browser_language', 'zh-CN');
  q.set('browser_platform', 'Win32');
  q.set('browser_name', 'Chrome');
  q.set('browser_version', '120.0.0.0');
  return q.toString();
}

/** 拉一次 detail，返回 aweme_detail；空体/风控会抛错并带上可读原因 */
async function fetchAwemeDetail(awemeId, opts = {}) {
  const ttwid = opts.ttwid || (await getTtwid({ ...opts, awemeId }));
  if (!ttwid) throw new Error('拿不到抖音 ttwid（iesdouyin 也没给），接口通道不可用');
  const url = `${WEB_HOST}/aweme/v1/web/aweme/detail/?${detailQuery(awemeId)}`;
  const res = await request(url, {
    timeout: opts.timeout || 15000,
    retries: 0,
    wantBody: true,
    signal: opts.signal,
    fetch: directFetch,
    headers: {
      'User-Agent': DESKTOP_UA,
      Accept: 'application/json, text/plain, */*',
      Referer: `${WEB_HOST}/`,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Cookie: `ttwid=${ttwid}`,
    },
  });
  const text = (res.body || Buffer.alloc(0)).toString('utf8');
  if (!text.trim()) {
    throw new Error('抖音 detail 接口返回空体（ttwid 可能失效了）');
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`抖音 detail 接口返回的不是 JSON（HTTP ${res.status}）`);
  }
  const d = json && json.aweme_detail;
  if (!d) {
    const msg = json && (json.status_msg || json.message);
    throw new Error(`抖音 detail 接口没有返回作品（${msg || `HTTP ${res.status}`}）`);
  }
  return { detail: d, ttwid };
}

/** 播放地址：download_addr（无水印）优先，其次 play_addr / bit_rate */
function pickVideoUrl(detail) {
  const v = detail && detail.video;
  if (!v) return '';
  const lists = [
    v.download_addr && v.download_addr.url_list,
    v.play_addr && v.play_addr.url_list,
    ...(Array.isArray(v.bit_rate) ? v.bit_rate.map((b) => b && b.play_addr && b.play_addr.url_list) : []),
  ];
  for (const list of lists) {
    if (Array.isArray(list) && list.length) {
      const usable = list.find((u) => /^https?:\/\//i.test(String(u || '')));
      if (usable) return String(usable).replace(/playwm/g, 'play');
    }
  }
  return '';
}

function pickImages(detail) {
  const images = Array.isArray(detail && detail.images) ? detail.images : [];
  return images
    .map((img) => {
      const list = Array.isArray(img && img.url_list) ? img.url_list : [];
      const url = list.find((u) => /^https?:\/\//i.test(String(u || ''))) || '';
      const animList = (img && img.video && img.video.play_addr && img.video.play_addr.url_list) || [];
      const videoUrl = Array.isArray(animList) ? animList.find((u) => /^https?:\/\//i.test(String(u || ''))) || '' : '';
      return { url: String(url), videoUrl: String(videoUrl) };
    })
    .filter((x) => x.url);
}

function pickMusic(detail) {
  const m = detail && detail.music;
  const list = (m && m.play_url && m.play_url.url_list) || [];
  return Array.isArray(list) ? String(list.find((u) => /^https?:\/\//i.test(String(u || ''))) || '') : '';
}

/**
 * 抖音接口通道的入口：链接 → 作品信息（不下载）。
 *
 * @returns {Promise<{kind:'video'|'images', awemeId:string, videoUrl:string,
 *   images:Array<{url:string,videoUrl:string}>, musicUrl:string, desc:string,
 *   author:string, durationSec:number, coverUrl:string, ttwid:string, finalUrl:string}>}
 */
async function probeDouyin(rawUrl, opts = {}) {
  const { finalUrl, awemeId } = await resolveAwemeUrl(rawUrl, opts);
  const { detail, ttwid } = await fetchAwemeDetail(awemeId, opts);
  const images = pickImages(detail);
  const videoUrl = pickVideoUrl(detail);
  const kind = images.length && !videoUrl ? 'images' : videoUrl ? 'video' : images.length ? 'images' : '';
  if (!kind) throw new Error('抖音接口没有给出可下载的地址（可能是私密/已删作品）');
  const coverList = (detail.video && detail.video.cover && detail.video.cover.url_list) || [];
  return {
    kind,
    awemeId,
    finalUrl,
    videoUrl,
    images,
    musicUrl: pickMusic(detail),
    desc: String((detail && detail.desc) || '').trim(),
    author: String((detail.author && (detail.author.nickname || detail.author.unique_id)) || '').trim(),
    durationSec: Number(detail.duration || 0) / 1000,
    coverUrl: Array.isArray(coverList) ? String(coverList.find((u) => /^https?:\/\//i.test(String(u || ''))) || '') : '',
    ttwid,
  };
}

module.exports = {
  isDouyinUrl,
  extractAwemeId,
  resolveAwemeUrl,
  getTtwid,
  fetchAwemeDetail,
  probeDouyin,
  pickVideoUrl,
  pickImages,
  pickMusic,
  MOBILE_UA,
  DESKTOP_UA,
};
