'use strict';

/**
 * 从任意文本里提取有效链接。
 *
 * 典型场景：抖音/小红书等 App 的「分享文案」里链接前后全是中文、话题标签和表情符号，例如
 *   3.02 07/15 :3pm GVl:/ i@c.an 假如熊大熊二闹掰了… # 熊出没 https://v.douyin.com/Q17Q43LSOR4/ 复制此链接，打开Dou音搜索
 * 这里负责把 https://v.douyin.com/Q17Q43LSOR4/ 挑出来（支持一条文本里多个链接、去重、保持出现顺序）。
 */

/** 无协议时也认为是链接的常见分享域名 */
const KNOWN_SHARE_HOSTS = new Set([
  'v.douyin.com',
  'www.douyin.com',
  'douyin.com',
  'v.kuaishou.com',
  'www.kuaishou.com',
  'b23.tv',
  'www.bilibili.com',
  'bilibili.com',
  'live.bilibili.com',
  'youtu.be',
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'xhslink.com',
  'www.xiaohongshu.com',
  'weibo.com',
  'weibo.cn',
  'm.weibo.cn',
  't.cn',
  'www.ixigua.com',
  'ixigua.com',
  'v.qq.com',
  'www.iqiyi.com',
  'www.youku.com',
  'x.com',
  'twitter.com',
  'www.instagram.com',
  'www.tiktok.com',
]);

/** 常见顶级域（用于判断裸域名是不是真的域名，避免把「i@c.an」这类噪声当链接） */
const COMMON_TLDS = new Set([
  'com', 'cn', 'net', 'org', 'tv', 'me', 'io', 'cc', 'co', 'xyz', 'top', 'site', 'live', 'link', 'be', 'fm', 'us',
  'info', 'app', 'vip', 'club', 'pro', 'online', 'store', 'art', 'fun', 'space', 'website', 'tech', 'studio', 'media',
  'news', 'dev', 'video', 'edu', 'gov', 'biz', 'name', 'mobi', 'wang', 'ren', 'group', 'work', 'ltd', 'plus', 'ink',
  'red', 'blue', 'pink', 'cool', 'love', 'wiki', 'zone', 'world', 'today', 'life', 'run', 'gold', 'host', 'press',
]);

/** URL 末尾常见的标点 / 括号，需要去掉 */
const TRAILING_NOISE = /[.,;:!?、，。；：！？…"'”’）)】》\]]+$/;

/** URL 里不可能出现的字符：空白、引号、各种括号、中文/日文/韩文与全角符号 */
const URL_STOP = '\\s<>"\'`（）()【】《》「」『』，。；：！？、…\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef';

function cleanCandidate(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^[<【（(「『《"']+/, '');
  s = s.replace(TRAILING_NOISE, '');
  return s;
}

/** 是否是 http(s) 链接 */
function isHttpUrl(u) {
  return /^https?:\/\/[^\s]+$/i.test(u);
}

/**
 * 提取文本中的链接。
 * @param {string} text
 * @returns {string[]} 去重后的链接（按在文本中出现的顺序）
 */
function extractUrls(text) {
  const input = String(text == null ? '' : text);
  if (!input.trim()) return [];
  const hits = [];

  // 1) 带协议的链接（最可靠）
  const schemeRe = new RegExp(`https?://[^${URL_STOP}]+`, 'gi');
  let m;
  while ((m = schemeRe.exec(input))) {
    const url = cleanCandidate(m[0]);
    if (isHttpUrl(url)) hits.push({ index: m.index, url });
  }

  // 2) 不带协议的裸域名（如 v.douyin.com/xxx、b23.tv/abc）
  const bareRe = new RegExp(
    `(?:^|[\\s,，。；;：:!！?？、"“”'‘’【】()（）<>《》])` +
      `((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,12}(?::\\d{2,5})?(?:/[^${URL_STOP}]*)?)`,
    'gi',
  );
  while ((m = bareRe.exec(input))) {
    const candidate = cleanCandidate(m[1]);
    if (!candidate) continue;
    const hostPart = candidate.split('/')[0].split(':')[0].toLowerCase();
    const tld = hostPart.split('.').pop();
    const hasPath = candidate.includes('/');
    const known = KNOWN_SHARE_HOSTS.has(hostPart);
    // 只有「已知分享域名」或「带路径/以 www. 开头的常见域名」才算，尽量不误伤普通文字
    if (!known && !(COMMON_TLDS.has(tld) && (hasPath || hostPart.startsWith('www.')))) continue;
    const index = m.index + m[0].indexOf(m[1]);
    hits.push({ index, url: `https://${candidate}` });
  }

  hits.sort((a, b) => a.index - b.index);
  const out = [];
  for (const h of hits) {
    if (!out.includes(h.url)) out.push(h.url);
  }
  return out;
}

/** 文本里是否包含链接 */
function hasUrl(text) {
  return extractUrls(text).length > 0;
}

/** 去掉链接与话题标签后的剩余文字（用于给任务起名等场景） */
function stripUrls(text) {
  let s = String(text == null ? '' : text);
  for (const url of extractUrls(s)) s = s.split(url).join(' ');
  return s.replace(/\s+/g, ' ').trim();
}

module.exports = { extractUrls, hasUrl, stripUrls, cleanCandidate, KNOWN_SHARE_HOSTS, COMMON_TLDS };
