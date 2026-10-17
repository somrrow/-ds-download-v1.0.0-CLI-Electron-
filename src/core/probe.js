'use strict';

/**
 * 链接探测：判断一个 URL 属于哪一类资源，并给出可直接下载的候选地址。
 *
 * 类型：
 *  - direct : 直链媒体文件（mp4/webm/mp3/... ），可断点续传
 *  - hls    : m3u8 播放列表，内置下载器处理
 *  - dash   : mpd，交给 yt-dlp（需 ffmpeg 合并音视频）
 *  - page   : 网页，尝试从 HTML 中提取媒体地址；失败则交给 yt-dlp
 */

const { fetchText, request } = require('./http');
const {
  extFromUrl,
  extFromMime,
  filenameFromDisposition,
  basenameFromUrl,
  sanitizeFilename,
  decodeHtmlEntities,
  DEFAULT_UA,
} = require('./util');

const MEDIA_EXT = new Set([
  '.mp4', '.m4v', '.webm', '.mkv', '.mov', '.avi', '.flv', '.f4v', '.wmv', '.mpg', '.mpeg', '.3gp', '.ogv', '.ts',
  '.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus',
]);

/**
 * 这些站点一律直接交给 yt-dlp：预探测没有意义（本来就是网页、要靠 yt-dlp 解析），
 * 而且国内直连常被重置——先请求一次只会白白失败，还会掩盖 yt-dlp 的真实提示。
 */
const YTDLP_PLATFORM_HOSTS = [
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'facebook.com',
  'fb.watch',
  'tiktok.com',
  'vimeo.com',
  'dailymotion.com',
  'soundcloud.com',
  'reddit.com',
  'twitch.tv',
  'nicovideo.jp',
  'bilibili.com',
  'douyin.com',
  'weibo.com',
  'weibo.cn',
];

/** 该链接是否属于「直接交给 yt-dlp」的站点 */
function isYtDlpPlatform(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return YTDLP_PLATFORM_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** 补齐协议、去掉包裹的引号与空白 */
function normalizeUrl(input) {
  let s = String(input == null ? '' : input).trim();
  s = s.replace(/^[<"'\s]+|[>"'\s]+$/g, '');
  if (!s) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return s;
  if (/^(www\.|[a-z0-9-]+\.[a-z]{2,}\/)/i.test(s)) return `https://${s}`;
  return s;
}

/** 是否是 http(s) 链接 */
function isHttpUrl(u) {
  return /^https?:\/\//i.test(String(u || ''));
}

function typeFromUrl(u) {
  const ext = extFromUrl(u);
  if (ext === '.m3u8') return 'hls';
  if (ext === '.mpd') return 'dash';
  if (MEDIA_EXT.has(ext)) return 'direct';
  return null;
}

function typeFromContentType(ct) {
  const c = String(ct || '').toLowerCase();
  if (!c) return null;
  if (c.includes('mpegurl')) return 'hls';
  if (c.includes('dash+xml')) return 'dash';
  if (c.startsWith('video/') || c.startsWith('audio/')) return 'direct';
  if (c.includes('text/html') || c.includes('application/xhtml')) return 'page';
  if (c.includes('json')) return 'api';
  return null;
}

/**
 * 探测单个 URL。
 * @returns {Promise<{url:string, finalUrl:string, type:string, contentType:string, contentLength:number,
 *   filename:string, title:string, candidates:Array, headers:object, status:number}>}
 */
async function probe(rawUrl, opts = {}) {
  const url = normalizeUrl(rawUrl);
  if (!isHttpUrl(url)) throw new Error(`不是有效的 http(s) 链接：${rawUrl}`);

  const hint = typeFromUrl(url);
  let status = 0;
  let finalUrl = url;
  let headers = null;
  let contentType = '';
  let contentLength = 0;
  let filename = '';

  try {
    const res = await request(url, {
      method: 'GET',
      headers: hint === 'page' ? undefined : { Range: 'bytes=0-0' },
      timeout: opts.timeout || 25000,
      retries: opts.retries ?? 2,
      signal: opts.signal,
      userAgent: opts.userAgent,
      referer: opts.referer,
      cookies: opts.cookies,
      cookieHeader: opts.cookieHeader,
    });
    status = res.status;
    finalUrl = res.url;
    headers = res.headers;
    contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    filename = sanitizeFilename(filenameFromDisposition(res.headers.get('content-disposition')), '');
    const len = Number(res.headers.get('content-length'));
    const rangeTotal = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
    contentLength = rangeTotal ? Number(rangeTotal[1]) : isFinite(len) ? len : 0;
  } catch (err) {
    if (!opts.allowFail) throw err;
    return {
      url,
      finalUrl: url,
      type: hint || 'unknown',
      contentType: '',
      contentLength: 0,
      filename: '',
      title: basenameFromUrl(url),
      candidates: [],
      headers: null,
      status: 0,
      error: err.message,
    };
  }

  let type = typeFromContentType(contentType) || hint || 'unknown';
  // 有些站点直链返回 application/octet-stream，靠扩展名兜底
  if (type === 'unknown' && hint) type = hint;

  const result = {
    url,
    finalUrl,
    type,
    contentType,
    contentLength,
    filename,
    title: '',
    candidates: [],
    headers,
    status,
  };

  if (type === 'page') {
    const html = await safeFetchHtml(finalUrl, opts);
    if (html) {
      result.title = extractTitle(html, finalUrl);
      const candidates = extractMediaFromHtml(html, finalUrl);
      result.candidates = candidates;
      if (!result.filename && candidates.length) {
        result.filename = sanitizeFilename(basenameFromUrl(candidates[0].url), '') + mediaExtFor(candidates[0].url, candidates[0].type);
      }
      // 网页里只有唯一一个可直接下载的媒体时，记下它，供下载器免 yt-dlp 直接抓取
      const usable = candidates.filter((c) => c.type === 'direct' || c.type === 'hls');
      if (usable.length === 1) {
        result.resolved = { url: usable[0].url, type: usable[0].type, source: usable[0].source };
      }
    }
  }

  if (!result.title) {
    result.title = result.filename
      ? result.filename.replace(/\.[a-z0-9]{2,5}$/i, '')
      : basenameFromUrl(finalUrl);
  }
  if (!result.filename) {
    result.filename = sanitizeFilename(result.title) + mediaExtFor(finalUrl, result.type, contentType);
  }
  return result;
}

/**
 * 决定输出扩展名：链接自带扩展名优先；播放列表（m3u8/mpd）统一落成 .mp4，
 * 再由下载器按容器实际类型调整（例如缺少 ffmpeg 时保留 .ts）。
 */
function mediaExtFor(url, type, contentType = '') {
  const urlExt = extFromUrl(url);
  const playable = /^\.[a-z0-9]{2,5}$/.test(urlExt) && !['.m3u8', '.mpd'].includes(urlExt) ? urlExt : '';
  if (playable) return playable;
  if (type === 'hls' || type === 'dash') return '.mp4';
  return extFromMime(contentType, '.mp4');
}

async function safeFetchHtml(url, opts) {
  try {
    return await fetchText(url, {
      timeout: opts.timeout || 25000,
      retries: 1,
      signal: opts.signal,
      userAgent: opts.userAgent || DEFAULT_UA,
      referer: opts.referer,
      headers: { Accept: 'text/html,application/xhtml+xml' },
      maxBodyBytes: opts.maxHtmlBytes || 4 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

/** 提取网页标题 */
function extractTitle(html, baseUrl) {
  const patterns = [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
    /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m && m[1] && m[1].trim()) return sanitizeFilename(decodeHtmlEntities(m[1].trim()), basenameFromUrl(baseUrl));
  }
  return basenameFromUrl(baseUrl);
}

/**
 * 从 HTML 中提取可能的媒体地址（按可信度排序、去重）。
 * 覆盖 og:video、twitter:player:stream、<video>/<source>、JSON-LD 与裸链接。
 */
function extractMediaFromHtml(html, baseUrl) {
  const found = [];
  const push = (rawUrl, source, extra = {}) => {
    if (!rawUrl) return;
    const cleaned = decodeHtmlEntities(String(rawUrl).trim())
      .replace(/\\\//g, '/')
      .replace(/\\u0026/gi, '&');
    if (!cleaned || /^data:/i.test(cleaned) || /^blob:/i.test(cleaned)) return;
    let absolute;
    try {
      absolute = new URL(cleaned, baseUrl).toString();
    } catch {
      return;
    }
    if (!isHttpUrl(absolute)) return;
    const t = typeFromUrl(absolute) || (extra.typeHint || 'unknown');
    found.push({
      url: absolute,
      type: t,
      source,
      quality: extra.quality || '',
      label: extra.label || '',
    });
  };

  const metaPatterns = [
    [/<meta[^>]+(?:property|name)=["'](?:og:video:secure_url|og:video:url|og:video)["'][^>]+content=["']([^"']+)["']/gi, 'og:video'],
    [/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:video:secure_url|og:video:url|og:video)["']/gi, 'og:video'],
    [/<meta[^>]+name=["']twitter:player:stream["'][^>]+content=["']([^"']+)["']/gi, 'twitter:player'],
    [/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:player:stream["']/gi, 'twitter:player'],
  ];
  for (const [re, source] of metaPatterns) {
    let m;
    while ((m = re.exec(html))) push(m[1], source);
  }

  // <video src> / <source src>
  const tagRe = /<(video|source)\b([^>]*)>/gi;
  let tag;
  while ((tag = tagRe.exec(html))) {
    const attrs = tag[2];
    const src = /\bsrc=["']([^"']+)["']/i.exec(attrs);
    const typeAttr = /\btype=["']([^"']+)["']/i.exec(attrs);
    const label = /\b(?:label|data-quality|res|title)=["']([^"']+)["']/i.exec(attrs);
    const size = /\bsize=["']?(\d{3,4})/i.exec(attrs);
    if (src) {
      const hint = typeAttr && /mpegurl/i.test(typeAttr[1]) ? 'hls' : typeAttr && /dash/i.test(typeAttr[1]) ? 'dash' : null;
      push(src[1], `<${tag[1].toLowerCase()}>`, {
        typeHint: hint || undefined,
        label: label ? label[1] : '',
        quality: size ? `${size[1]}p` : label ? label[1] : '',
      });
    }
  }

  // JSON-LD / 内联脚本里的 contentUrl、playAddr 等
  const jsonKeys = /"(?:contentUrl|contentURL|playAddr|playUrl|videoUrl|video_url|file|source|src|url)"\s*:\s*"(https?:\/\/[^"]+\.(?:mp4|m3u8|webm|mov|m4v|flv|mpd|mp3|m4a)(?:\?[^"]*)?)"/gi;
  let jm;
  while ((jm = jsonKeys.exec(html))) push(jm[1], 'json');

  // 裸链接兜底
  const bareRe = /https?:\/\/[^\s"'<>\\)]+?\.(?:mp4|m3u8|webm|mov|m4v|flv|mpd|mp3|m4a|ts)(?:\?[^\s"'<>\\)]*)?/gi;
  let bm;
  while ((bm = bareRe.exec(html))) push(bm[0], 'inline');

  // 去重（保留首次出现，即可信度最高者）
  const seen = new Set();
  const out = [];
  for (const item of found) {
    const key = item.url.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  // 直链/HLS 优先，其次 dash
  const rank = { hls: 0, direct: 1, dash: 2, unknown: 3 };
  out.sort((a, b) => (rank[a.type] ?? 9) - (rank[b.type] ?? 9));
  return out.slice(0, 40);
}

/** 生成安全的输出文件名（不含目录），必要时补扩展名 */
function buildFilename({ title, filename, type, ext }) {
  let name = sanitizeFilename(filename || title || 'video', 'video');
  const hasExt = /\.[a-z0-9]{2,5}$/i.test(name);
  if (!hasExt) {
    const fallbackExt = ext || (type === 'hls' ? '.mp4' : type === 'direct' ? '.mp4' : '.mp4');
    name += fallbackExt;
  }
  return name.replace(/^\.+/, '') || 'video.mp4';
}

module.exports = {
  probe,
  normalizeUrl,
  isHttpUrl,
  isYtDlpPlatform,
  YTDLP_PLATFORM_HOSTS,
  typeFromUrl,
  typeFromContentType,
  extractMediaFromHtml,
  extractTitle,
  buildFilename,
  mediaExtFor,
  MEDIA_EXT,
};
