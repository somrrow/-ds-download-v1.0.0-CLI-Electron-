'use strict';

/**
 * HTTP 层：统一 UA / 重试 / 超时 / 流式读取。
 * 基于 Node 内置 fetch（undici），无第三方依赖。
 */

const { Readable } = require('stream');
const { DEFAULT_UA, sleep, cookieHeaderFor, parseNetscapeCookies } = require('./util');
const fs = require('fs');

/** 需要重试的状态码 */
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 524]);

/**
 * 实际使用的 fetch 实现。
 *
 * 默认是 Node 内置 fetch（undici）—— 它**只在进程启动时设了 NODE_USE_ENV_PROXY=1 才会读代理环境变量**，
 * 而且界面里填的「代理地址」它完全不知道。桌面端因此可以注入 Electron 的 `session.fetch`
 * （走 Chromium 网络栈，天然遵守该 session 的代理设置），让内置下载引擎和内置浏览器用同一个代理。
 */
let fetchImpl = null;

/** 注入 fetch 实现（传 null 恢复成 Node 内置 fetch） */
function setFetchImpl(impl) {
  fetchImpl = typeof impl === 'function' ? impl : null;
}

/** 当前是否在用自定义 fetch（界面注入过就为 true） */
function hasFetchImpl() {
  return Boolean(fetchImpl);
}

/** 取出当前使用的 fetch 实现（供自检等场景临时替换/还原） */
function getFetchImpl() {
  return fetchImpl;
}

/**
 * 让内置 HTTP 层走代理（HTTP/HTTPS 代理）：
 * Node 自带的 fetch 不认系统代理、也不认界面里填的代理地址，这里换成自己实现的 CONNECT 隧道客户端，
 * 请求头（Referer / Cookie / Range…）原样透传，不会像 Chromium 那样被拦。
 * @param {string} proxyUrl 传空则恢复成 Node 内置 fetch
 */
function setHttpProxy(proxyUrl) {
  const raw = String(proxyUrl || '').trim();
  if (!raw) {
    setFetchImpl(null);
    return { proxy: '' };
  }
  const { createProxyFetch } = require('./proxy-fetch');
  const impl = createProxyFetch(raw);
  setFetchImpl(impl);
  return { proxy: raw };
}

function doFetch(url, init, override) {
  const impl = override || fetchImpl;
  return impl ? impl(url, init) : fetch(url, init);
}

/** 网络层错误码 → 人话（fetch 的 "fetch failed" 会把真正原因藏在 cause 里） */
const NETWORK_HINTS = {
  ECONNRESET: '连接被重置（ECONNRESET）—— 目标站点可能无法直连，请配代理后重试',
  ECONNREFUSED: '连接被拒绝（ECONNREFUSED）—— 站点不可达，或代理地址/端口不对',
  EPIPE: '连接被中断（EPIPE）',
  ETIMEDOUT: '连接超时（ETIMEDOUT）—— 网络太慢或被限制，可试代理',
  ENOTFOUND: '域名解析失败（ENOTFOUND）—— 检查网络 / DNS，或该域名被限制，需要代理',
  EAI_AGAIN: '域名解析暂时失败（EAI_AGAIN）—— 检查网络 / DNS，或需要代理',
  EHOSTUNREACH: '主机不可达（EHOSTUNREACH）',
  ENETUNREACH: '网络不可达（ENETUNREACH）',
  CERT_HAS_EXPIRED: '证书已过期',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书校验失败',
  ERR_TLS_CERT_ALTNAME_INVALID: '证书域名不匹配',
};

/**
 * 把 fetch 的底层错误整理成能看懂的一句话。
 * Node 的 fetch 失败时统一抛 `TypeError: fetch failed`，真正原因在 err.cause 里。
 */
function describeNetworkError(err, url) {
  const cause = err && err.cause ? err.cause : null;
  const rawCode = (cause && (cause.code || cause.errno)) || (err && err.code) || '';
  const code = String(rawCode || '').toUpperCase();
  const detail = (cause && cause.message) || (err && err.message) || '未知错误';
  const where = url ? `（${String(url).slice(0, 120)}）` : '';

  if (/请求超时|已取消|请求被中断/.test(detail)) return detail;

  // Electron（Chromium 网络栈）走代理失败时会给出 net::ERR_* 形式的错误
  const chromiumProxy = /ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_MANDATORY_PROXY_CONFIGURATION_FAILED|ERR_PROXY_AUTH_UNSUPPORTED|ERR_PROXY_AUTH_REQUESTED/.exec(
    detail,
  );
  if (chromiumProxy) {
    return `网络错误：连不上代理服务器${where} —— 检查「代理地址」是否填对、代理软件是否在运行（浏览器能开不代表本工具的进程能连到该端口）`;
  }
  if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/.test(detail)) {
    return `网络错误：域名解析失败${where} —— 检查网络 / DNS，或改用代理`;
  }
  if (/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_ABORTED/.test(detail)) {
    return `网络错误：连接被重置${where} —— 目标站点可能无法直连，请配代理后重试`;
  }
  if (/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT/.test(detail)) {
    return `网络错误：连接超时${where} —— 网络太慢或被限制，可试代理`;
  }

  for (const [key, hint] of Object.entries(NETWORK_HINTS)) {
    if (code === key || detail.includes(key)) return `网络错误：${hint}${where}`;
  }
  if (/abort/i.test(detail) || code === 'UND_ERR_ABORTED') return `请求被中断${where}`;
  if (/fetch failed/i.test(detail)) {
    return `网络请求失败${where}：${code ? `${code} —— ` : ''}目标站点可能无法直连（国内常见于 YouTube / pixiv / Google / Twitter），请设置代理后重试`;
  }
  return `网络请求失败${where}：${detail}`;
}

/**
 * 构造请求头。
 * @param {object} opts
 * @param {object} [opts.headers] 额外请求头
 * @param {string} [opts.referer] Referer
 * @param {string} [opts.userAgent] 自定义 UA
 * @param {Array}  [opts.cookies] 解析后的 cookie 数组
 * @param {string} [opts.cookieHeader] 直接给出的 Cookie 头
 */
function buildHeaders(url, opts = {}) {
  const headers = {
    'User-Agent': opts.userAgent || DEFAULT_UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...(opts.headers || {}),
  };
  if (opts.referer) headers.Referer = opts.referer;
  if (opts.origin) headers.Origin = opts.origin;
  if (opts.cookieHeader) headers.Cookie = opts.cookieHeader;
  else if (Array.isArray(opts.cookies) && opts.cookies.length) {
    const c = cookieHeaderFor(url, opts.cookies);
    if (c) headers.Cookie = c;
  }
  if (opts.range) headers.Range = opts.range;
  return headers;
}

/** 从 cookies.txt 文件读取 cookie（供内置下载器使用） */
function loadCookiesFile(file) {
  if (!file) return [];
  const text = fs.readFileSync(file, 'utf8');
  return parseNetscapeCookies(text);
}

/**
 * 发起请求（自动跟随重定向、自动重试）。
 * @returns {Promise<{status:number, headers:Headers, url:string, response:Response, body:Buffer|null}>}
 */
async function request(url, opts = {}) {
  const {
    method = 'GET',
    timeout = 30000,
    retries = 3,
    retryDelay = 700,
    signal,
    wantBody = false,
    maxBodyBytes = 32 * 1024 * 1024,
    onRetry,
    logger,
    // 单次请求指定 fetch 实现（代理自检用：直连/走代理各测一次，不改动全局状态）
    fetch: fetchOverride,
  } = opts;

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = timeout > 0 ? setTimeout(() => controller.abort(new Error(`请求超时（${timeout}ms）`)), timeout) : null;
    const onOuterAbort = () => controller.abort(new Error('已取消'));
    if (signal) {
      if (signal.aborted) {
        if (timer) clearTimeout(timer);
        throw new Error('已取消');
      }
      signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    try {
      const res = await doFetch(
        url,
        {
          method,
          headers: buildHeaders(url, opts),
          redirect: 'follow',
          signal: controller.signal,
          body: opts.body,
        },
        fetchOverride,
      );
      if (RETRY_STATUS.has(res.status) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : retryDelay * Math.pow(2, attempt);
        if (onRetry) onRetry({ attempt: attempt + 1, status: res.status, waitMs, url });
        res.body?.cancel?.().catch(() => {});
        await sleep(Math.min(waitMs, 15000));
        continue;
      }
      let body = null;
      if (wantBody && method !== 'HEAD') {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > maxBodyBytes) throw new Error(`响应体过大（${buf.length} 字节）`);
        body = buf;
      } else if (!wantBody && !opts.keepBody) {
        // 调用方只要响应头，及时释放连接
        res.body?.cancel?.().catch(() => {});
      }
      return { status: res.status, headers: res.headers, url: res.url || url, response: res, body };
    } catch (err) {
      lastError = err;
      const aborted = controller.signal.aborted && !signal?.aborted;
      const cancelled = signal?.aborted;
      if (cancelled) throw new Error('已取消');
      if (attempt >= retries) break;
      if (logger) logger(`请求失败，重试 ${attempt + 1}/${retries}：${describeNetworkError(err, url)}`);
      if (onRetry) onRetry({ attempt: attempt + 1, error: err, waitMs: retryDelay * Math.pow(2, attempt), url });
      await sleep(Math.min(retryDelay * Math.pow(2, attempt), 8000));
      if (aborted) lastError = new Error(`请求超时（${timeout}ms）`);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
  }
  throw new Error(describeNetworkError(lastError, url));
}

/** GET 文本（自动处理常见编码） */
async function fetchText(url, opts = {}) {
  const res = await request(url, { ...opts, wantBody: true, retries: opts.retries ?? 3 });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}：${url}`);
  const buf = res.body || Buffer.alloc(0);
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  const m = /charset=([\w-]+)/.exec(ctype);
  let charset = m ? m[1].toLowerCase() : 'utf-8';
  if (!m && /text\/html/.test(ctype)) {
    const head = buf.slice(0, 4096).toString('latin1');
    const m2 = /charset=["']?([\w-]+)/i.exec(head);
    if (m2) charset = m2[1].toLowerCase();
  }
  if (charset === 'gbk' || charset === 'gb2312' || charset === 'gb18030') {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      /* 回退 utf-8 */
    }
  }
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/** GET 二进制 */
async function fetchBuffer(url, opts = {}) {
  const res = await request(url, { ...opts, wantBody: true });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}：${url}`);
  return { buffer: res.body, headers: res.headers, status: res.status };
}

/**
 * 打开一个流式响应（用于大文件下载）。
 * 调用方负责消费 res.response.body 或 res.stream。
 */
async function openStream(url, opts = {}) {
  const res = await request(url, { ...opts, wantBody: false, keepBody: true, timeout: opts.timeout ?? 45000 });
  const stream = res.response.body ? Readable.fromWeb(res.response.body) : null;
  return { ...res, stream };
}

module.exports = {
  buildHeaders,
  request,
  fetchText,
  fetchBuffer,
  openStream,
  loadCookiesFile,
  describeNetworkError,
  setFetchImpl,
  hasFetchImpl,
  getFetchImpl,
  setHttpProxy,
  RETRY_STATUS,
};
