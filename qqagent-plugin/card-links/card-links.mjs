// QQ 卡片 → 链接（给 QQ Agent 用）
//
// ── 为什么是「核心补丁 + 插件模块」这种组合 ─────────────────────────────────
// QQ 用户发的分享卡片在 OneBot 事件里是 `json` / `xml` / `share` 段，而 QQ Agent 核心的
// `segmentsToText()`（src/onebot.js）对它们只有一个占位符：
//     case 'json': out.push('[卡片消息]'); break;
// 也就是说卡片的 URL **根本没进消息文本**，而链接转发那条链路（src/media-links.js）只从
// 文本里抽链接 —— 于是卡片永远走不到 media.download。这不是本插件能绕开的：
//   · 能力表里没有任何"消息进入"的扩展点（能把段交给插件的只有 media.transcribe 和
//     message.inline-at-normalize，前者只拿语音、后者只处理 @ 段）；
//   · hooks 有 runHook() 但核心一处都没调用；
//   · 工具是"模型按需调用"，做不到"自动"。
// 所以：**转译逻辑放在这里（插件目录，应用更新不会动它）**，核心只打三行补丁去调它
// （`cardSegmentToText`），补丁可以随时用 apply.mjs --revert 撤掉。
//
// ── 转译出来的东西长什么样 ────────────────────────────────────────────────
//   [卡片消息] 【新宿决战】五条悟猫VS宿傩猫 https://b23.tv/AvOCzlr
// 保留 `[卡片消息]` 标记（模型和旧提示词都认得），后面补上标题与链接 —— 这样：
//   ① 链接转发（media.download）能认领它、自动下载转发；
//   ② 模型也能看见这条卡片指向哪里，不用再瞎猜。

/** 内网/壳/追踪类地址：它们不是"内容"，挖出来只会污染链接转发 */
const IGNORE_PATTERNS = [
  /^https?:\/\/m\.q\.qq\.com\//i, // 小程序壳（真实内容在 qqdocurl 里，但那个是壳本身）
  /^https?:\/\/qun\.qq\.com\//i,
  /^https?:\/\/[^/]*\.qq\.com\/q\//i,
  /^https?:\/\/url\.cn\//i,
  /^https?:\/\/[^/]*tieba\.baidu\.com\/p\//i,
  /^https?:\/\/[^/]*\.gtimg\.(com|cn)\//i, // 腾讯静态资源（缩略图等）
  /^https?:\/\/[^/]*\.qpic\.cn\//i,
  /^https?:\/\/[^/]*\.qq\.com\/[^/]*\/cgi-bin\//i,
];

/** 优先当"目标链接"看的键（卡片把它们放在 meta 里） */
const URL_KEYS = ['qqdocurl', 'jumpUrl', 'jump_url', 'url', 'musicUrl', 'music_url', 'targetUrl', 'detailUrl', 'appUrl', 'scheme'];

/** 包一层：非 http(s) 的 scheme（weixin:// mqqapi:// qqmusic:// …）一律丢掉 */
function normalizeUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  // 卡片里的 URL 常被转义成 \u002F（JSON）或 &amp;（XML/HTML）
  s = s.replace(/\u002F/g, '/').replace(/\\\//g, '/').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"');
  if (!/^https?:\/\//i.test(s)) return '';
  if (IGNORE_PATTERNS.some((re) => re.test(s))) return '';
  // 去掉明显的追踪参数尾巴会破坏签名链接，这里只裁掉末尾的标点
  return s.replace(/[)\]}>,.;]+$/, '');
}

function stripHtml(text) {
  return String(text ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 深度遍历：按 URL_KEYS 的优先级找链接，同时顺手记下看起来像标题的字段 */
function scanJson(node, found, meta, depth = 0) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) scanJson(item, found, meta, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') {
      if (URL_KEYS.includes(key)) {
        const u = normalizeUrl(value);
        if (u) found.push({ url: u, weight: key === 'qqdocurl' || key === 'jumpUrl' ? 0 : 1 });
      }
      if (!meta.title && (key === 'title' || key === 'desc') && value.trim()) meta.title = stripHtml(value).slice(0, 80);
      if (!meta.app && key === 'app' ) meta.app = String(value).trim();
    } else if (value && typeof value === 'object') {
      scanJson(value, found, meta, depth + 1);
    }
  }
}

/** json 卡片：`{app, view, prompt, meta:{...}}` */
function fromJsonSegment(payload) {
  let raw = payload;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      // 有些实现把 json 段塞成一个"看起来像 JSON"的字符串，退化成直接挖 URL
      return { urls: [...String(payload).matchAll(/https?:\/\/[^\s"'\\<>]+/gi)].map((m) => normalizeUrl(m[0])).filter(Boolean), title: '' };
    }
  }
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { urls: [], title: '' };
    }
  }
  const found = [];
  const meta = { title: '', app: '' };
  scanJson(raw, found, meta);
  if (!meta.title && typeof raw?.prompt === 'string') meta.title = stripHtml(raw.prompt.replace(/^\[[^\]]*\]/, '')).slice(0, 80);
  return { urls: found.map((f) => f.url), title: meta.title, app: meta.app };
}

/** xml 卡片：`<url>…</url>` / `url="…"` / `<brief>` */
function fromXmlSegment(payload) {
  const text = typeof payload === 'string' ? payload : String(payload ?? '');
  const decoded = text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  const urls = [];
  for (const m of decoded.matchAll(/<url>\s*<!\[CDATA\[(.*?)\]\]>\s*<\/url>/gis)) urls.push(normalizeUrl(m[1]));
  for (const m of decoded.matchAll(/<url>\s*([^<]+?)\s*<\/url>/gis)) urls.push(normalizeUrl(m[1]));
  for (const m of decoded.matchAll(/\burl\s*=\s*["']([^"']+)["']/gi)) urls.push(normalizeUrl(m[1]));
  const titleMatch = /<title>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*<\/title>/is.exec(decoded);
  const briefMatch = /<brief>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*<\/brief>/is.exec(decoded);
  const title = stripHtml(titleMatch?.[1] || briefMatch?.[1] || '').slice(0, 80);
  return { urls: urls.filter(Boolean), title };
}

/** 退化兜底：整个载荷里直接抠 http(s) 链接 */
function looseUrls(payload) {
  const text = String(payload ?? '');
  const urls = [];
  for (const m of text.matchAll(/https?:(?:\\?\/){2}[^\s"'\\<>]+/gi)) {
    const u = normalizeUrl(m[0].replace(/\\\//g, '/'));
    if (u) urls.push(u);
  }
  return urls;
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const url of list) {
    const key = url.replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

/**
 * 从一个卡片段里挖出链接与标题。
 * 支持 OneBot 的 `json` / `xml` / `share` 三种段形态（QQ 的分享卡片基本都是 json）。
 * @returns {{urls:string[], title:string, app:string}}
 */
export function extractCardLinks(seg) {
  const type = String(seg?.type ?? '').toLowerCase();
  const data = seg?.data ?? {};
  if (type === 'json') {
    const r = fromJsonSegment(data.data ?? data.json ?? data);
    if (!r.urls.length) r.urls = looseUrls(data.data ?? data);
    return { urls: dedupe(r.urls), title: r.title || '', app: r.app || '' };
  }
  if (type === 'xml') {
    const r = fromXmlSegment(data.data ?? data.xml ?? data);
    if (!r.urls.length) r.urls = looseUrls(data.data ?? data);
    return { urls: dedupe(r.urls), title: r.title || '', app: '' };
  }
  if (type === 'share') {
    // OneBot 标准的分享段：url / title / content
    const urls = [normalizeUrl(data.url), ...looseUrls(data.content)].filter(Boolean);
    return { urls: dedupe(urls), title: stripHtml(data.title).slice(0, 80), app: '' };
  }
  return { urls: [], title: '', app: '' };
}

/**
 * 段 → 文本（核心补丁调用的入口）。
 * 没有链接时退回原来的占位符，行为与打补丁前一致。
 */
export async function cardSegmentToText(seg) {
  const type = String(seg?.type ?? '').toLowerCase();
  const placeholder = type === 'json' ? '[卡片消息]' : `[${type || '未知'}]`;
  try {
    const { urls, title } = extractCardLinks(seg);
    const parts = [placeholder];
    if (title) parts.push(title);
    parts.push(...urls.slice(0, 3));
    return parts.join(' ');
  } catch {
    return placeholder;
  }
}

// ── 自测：node card-links.mjs ──────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('card-links.mjs')) {
  const cases = [
    {
      name: 'B 站分享卡片（qqdocurl + news.jumpUrl）',
      seg: {
        type: 'json',
        data: {
          data: JSON.stringify({
            app: 'com.tencent.structmsg',
            view: 'news',
            prompt: '[QQ小程序]哔哩哔哩',
            meta: {
              news: { title: '【新宿决战】五条悟猫VS宿傩猫', jumpUrl: 'https://b23.tv/AvOCzlr' },
              detail_1: { title: '【新宿决战】五条悟猫VS宿傩猫', qqdocurl: 'https://b23.tv/AvOCzlr', preview: 'https://p3-pc-sign.douyinpic.com/x.jpg' },
            },
          }),
        },
      },
      expectUrl: 'https://b23.tv/AvOCzlr',
      expectTitle: '【新宿决战】五条悟猫VS宿傩猫',
    },
    {
      name: '抖音分享卡片（转义斜杠）',
      seg: {
        type: 'json',
        data: {
          data: '{"app":"com.tencent.structmsg","meta":{"news":{"title":"假如熊大熊二闹掰了","jumpUrl":"https:\\/\\/v.douyin.com\\/Q17Q43LSOR4\\/"}}}',
        },
      },
      expectUrl: 'https://v.douyin.com/Q17Q43LSOR4/',
      expectTitle: '假如熊大熊二闹掰了',
    },
    {
      name: '网易云音乐卡片（musicUrl 优先）',
      seg: {
        type: 'json',
        data: {
          data: JSON.stringify({
            app: 'com.tencent.structmsg',
            view: 'music',
            meta: { music: { title: '晴天', desc: '周杰伦', musicUrl: 'https://music.163.com/song?id=186016', jumpUrl: 'https://y.music.163.com/m/song?id=186016' } },
          }),
        },
      },
      expectUrl: 'https://music.163.com/song?id=186016',
    },
    {
      name: '小程序壳卡片（应被过滤掉 qq 壳地址）',
      seg: {
        type: 'json',
        data: { data: JSON.stringify({ app: 'com.tencent.miniapp_01', meta: { detail_1: { title: '某小程序', qqdocurl: 'https://m.q.qq.com/a/s/abc123' } } }) },
      },
      expectUrl: null,
      expectTitle: '某小程序',
    },
    {
      name: 'XML 卡片',
      seg: { type: 'xml', data: { data: '<?xml version="1.0"?><msg serviceID="1"><item><title>视频标题</title><url>https://v.douyin.com/abcd/</url></item></msg>' } },
      expectUrl: 'https://v.douyin.com/abcd/',
      expectTitle: '视频标题',
    },
    {
      name: 'OneBot share 段',
      seg: { type: 'share', data: { url: 'https://b23.tv/xyz789', title: '一个视频' } },
      expectUrl: 'https://b23.tv/xyz789',
      expectTitle: '一个视频',
    },
  ];

  let bad = 0;
  for (const c of cases) {
    const r = extractCardLinks(c.seg);
    const text = await cardSegmentToText(c.seg);
    const urlOk = c.expectUrl ? r.urls.includes(c.expectUrl) : r.urls.length === 0;
    const titleOk = c.expectTitle ? r.title.includes(c.expectTitle) : true;
    if (!urlOk || !titleOk) bad += 1;
    console.log(`${urlOk && titleOk ? '✓' : '✗'} ${c.name}`);
    console.log(`    文本: ${text}`);
    console.log(`    链接: ${JSON.stringify(r.urls)}  标题: ${JSON.stringify(r.title)}`);
  }
  console.log(bad === 0 ? '\nPASS 卡片转译自测通过' : `\nFAIL ${bad} 项不符合预期`);
  process.exitCode = bad === 0 ? 0 : 1;
}
