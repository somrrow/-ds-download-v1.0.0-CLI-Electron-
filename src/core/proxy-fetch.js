'use strict';

/**
 * 让内置 HTTP 层走代理（HTTP/HTTPS 代理，CONNECT 隧道）。
 *
 * 为什么要自己实现：Node 自带的 fetch 只在进程启动时设了 NODE_USE_ENV_PROXY=1 才会读代理环境变量，
 * 而且完全不认「系统代理」与界面里填的代理地址。Electron 的 session.fetch 虽然会自动走系统代理，
 * 但 Chromium 会拦掉 Referer / Origin 这类请求头（pixiv 图片没有 Referer 直接 403），
 * 所以这里在 Node 层自己做 CONNECT 隧道，请求头原样透传。
 *
 * 返回的对象与 fetch 的 Response 保持最小兼容：status / headers.get / url / arrayBuffer / response.body。
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const { Readable } = require('stream');

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** 解析代理地址（允许省略协议，默认 http://） */
function parseProxyUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // 代理地址都是 ASCII：含中文/全角字符基本都是填错了（不然会被当成域名解析出一个怪地址）
  if (/[^\x20-\x7e]/.test(s)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  const protocol = u.protocol.replace(':', '').toLowerCase();
  if (!['http', 'https', 'socks', 'socks4', 'socks5', 'socks5h'].includes(protocol)) return null;
  // 主机名必须是常见形式（含中文/空格之类基本是填错了，早点报错比发请求失败更好）
  if (!/^[a-z0-9._-]+$/i.test(u.hostname)) return null;
  const defaultPort = protocol === 'https' ? 443 : protocol.startsWith('socks') ? 1080 : 80;
  return {
    protocol,
    host: u.hostname,
    port: Number(u.port || defaultPort),
    auth: u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}` : '',
    socks: protocol.startsWith('socks'),
  };
}

/** 大小写不敏感的响应头容器（只实现内置下载器用到的几个方法） */
class HeaderBag {
  constructor(raw = {}) {
    this.map = new Map();
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined || v === null) continue;
      this.map.set(String(k).toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v));
    }
  }

  get(name) {
    return this.map.has(String(name).toLowerCase()) ? this.map.get(String(name).toLowerCase()) : null;
  }

  has(name) {
    return this.map.has(String(name).toLowerCase());
  }

  forEach(cb) {
    for (const [k, v] of this.map) cb(v, k);
  }

  entries() {
    return this.map.entries();
  }

  raw() {
    return Object.fromEntries(this.map);
  }
}

/** 把 fetch 风格的 headers 统一成普通对象 */
function normalizeHeaders(input) {
  const out = {};
  if (!input) return out;
  if (typeof input.forEach === 'function' && typeof input.get === 'function') {
    input.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(input)) {
    for (const pair of input) {
      if (Array.isArray(pair) && pair.length === 2) out[pair[0]] = pair[1];
    }
    return out;
  }
  return { ...input };
}

/** 建立到目标站点的 CONNECT 隧道（http 代理） */
function openTunnel(proxy, host, port, signal, timeout) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${host}:${port}` };
    if (proxy.auth) headers['Proxy-Authorization'] = `Basic ${Buffer.from(proxy.auth).toString('base64')}`;
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      setHost: false,
      timeout,
    });
    const onAbort = () => {
      req.destroy(new Error(signal?.reason?.message || '已取消'));
    };
    if (signal) {
      if (signal.aborted) return reject(new Error(signal.reason?.message || '已取消'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.once('connect', (res, socket) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理服务器拒绝建立隧道（HTTP ${res.statusCode}）`));
        return;
      }
      resolve(socket);
    });
    req.once('timeout', () => req.destroy(new Error('请求超时（连接代理超时）')));
    req.once('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    req.end();
  });
}

/** 发起一次请求（不处理重定向），返回 {status, statusText, headers, stream, url} */
function rawRequest({ target, method, headers, body, signal, proxy, timeout }) {
  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === 'https:';
    const port = Number(target.port || (isHttps ? 443 : 80));
    const path = `${target.pathname}${target.search}`;
    const finalHeaders = { ...headers };
    if (!Object.keys(finalHeaders).some((k) => k.toLowerCase() === 'host')) {
      finalHeaders.Host = target.host;
    }

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const onResponse = (res) => {
      settled = true;
      const stream = res;
      resolve({
        status: res.statusCode || 0,
        statusText: res.statusMessage || '',
        headers: new HeaderBag(res.headers),
        stream,
        url: target.toString(),
      });
    };

    const wire = async () => {
      try {
        if (isHttps) {
          const socket = await openTunnel(proxy, target.hostname, port, signal, timeout);
          const tlsSocket = tls.connect({ socket, servername: target.hostname });
          const req = https.request(
            { method, path, headers: finalHeaders, createConnection: () => tlsSocket, timeout },
            onResponse,
          );
          attach(req);
          if (body !== undefined && body !== null) req.write(body);
          req.end();
        } else {
          // 普通 HTTP：直接把绝对地址交给代理
          const req = http.request(
            { host: proxy.host, port: proxy.port, method, path: target.toString(), headers: finalHeaders, timeout, setHost: false },
            onResponse,
          );
          attach(req);
          if (body !== undefined && body !== null) req.write(body);
          req.end();
        }
      } catch (err) {
        fail(err);
      }
    };

    function attach(req) {
      if (signal) {
        const onAbort = () => req.destroy(new Error(signal.reason?.message || '已取消'));
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        req.once('close', () => signal.removeEventListener('abort', onAbort));
      }
      req.once('timeout', () => req.destroy(new Error(`请求超时（${timeout}ms）`)));
      req.once('error', fail);
    }

    wire();
  });
}

/** 把 Node 流收集成 Buffer */
function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
}

/** 组装成 fetch 风格的 Response（只覆盖内置下载器用到的那部分） */
function toFetchResponse(res) {
  let buffered = null;
  // 必须是真正的 web ReadableStream：内置下载器会用它做 Readable.fromWeb 流式下载，
  // 也会用它做 body.cancel() 及时释放连接（空转的假对象会让流式下载直接报错）
  const body = Readable.toWeb(res.stream);
  return {
    status: res.status,
    statusText: res.statusText,
    ok: res.status >= 200 && res.status < 300,
    url: res.url,
    headers: res.headers,
    body,
    response: { body },
    async arrayBuffer() {
      if (!buffered) buffered = await collect(res.stream);
      return buffered;
    },
    async text() {
      if (!buffered) buffered = await collect(res.stream);
      return buffered.toString('utf8');
    },
  };
}

/** 本机 / 内网地址不走代理（系统代理设置里通常也带 <local> 例外，这里保持一致） */
function isLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '[::1]') return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

/**
 * 创建一个走代理的 fetch 实现（可直接交给 http.js 的 setFetchImpl）
 * @param {string} proxyUrl 形如 http://127.0.0.1:7890
 */
function createProxyFetch(proxyUrl, opts = {}) {
  const parsedProxy = parseProxyUrl(proxyUrl);
  if (!parsedProxy) throw new Error(`代理地址无法解析：${proxyUrl}（示例：http://127.0.0.1:7890）`);
  if (parsedProxy.socks) {
    throw new Error('暂不支持 SOCKS 代理，请填 HTTP 代理地址（Clash/V2Ray 一般都同时提供 HTTP 端口）');
  }
  // force：连本机地址也走代理（自动化测试用；正常使用时会绕过本机/内网地址）
  const proxy = { ...parsedProxy, force: Boolean(opts.force) };
  const timeout = opts.timeout || 60000;

  const run = async (urlStr, init = {}, redirects) => {
    const target = new URL(urlStr);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error(`不支持的协议：${target.protocol}`);
    }
    // 本机/内网地址直连：代理软件通常也放行这些地址，绕一圈反而可能被拦
    if (isLocalHost(target.hostname) && !proxy.force) {
      return fetch(target.toString(), init);
    }
    const method = String(init.method || 'GET').toUpperCase();
    const headers = normalizeHeaders(init.headers);
    if (proxy.auth && !Object.keys(headers).some((k) => k.toLowerCase() === 'proxy-authorization')) {
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(proxy.auth).toString('base64')}`;
    }
    const res = await rawRequest({
      target,
      method,
      headers,
      body: init.body,
      signal: init.signal,
      proxy,
      timeout,
    });

    const location = res.headers.get('location');
    if (location && REDIRECT_STATUS.has(res.status) && redirects < MAX_REDIRECTS) {
      res.stream.destroy();
      const nextUrl = new URL(location, urlStr).toString();
      const switchToGet = res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST');
      const nextHeaders = { ...headers };
      // 换域后不要继续带上原来的鉴权头
      if (new URL(nextUrl).host !== target.host) {
        for (const key of Object.keys(nextHeaders)) {
          if (/^authorization$/i.test(key)) delete nextHeaders[key];
        }
      }
      return run(
        nextUrl,
        { ...init, method: switchToGet ? 'GET' : method, body: switchToGet ? undefined : init.body, headers: nextHeaders },
        redirects + 1,
      );
    }
    return toFetchResponse(res);
  };

  return (input, init) => {
    const urlStr = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
    return run(urlStr, init || {}, 0);
  };
}

module.exports = { createProxyFetch, parseProxyUrl, HeaderBag };
