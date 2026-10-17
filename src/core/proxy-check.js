'use strict';

/**
 * 代理自检。
 *
 * 目标：让用户一眼看出「代理到底通不通、配上有没有用」，而不是等到下载失败才发现。
 * 做法是对几个代表性站点各发一次极小的请求（Range: bytes=0-0），分别记录
 * 「直连」与「经代理」的结果 —— 两者一对比就能说明代理是否真的生效。
 *
 * 注意：pixiv / YouTube 这类站点即使用代理也可能返回 403（Cloudflare 按 TLS 指纹拦 Node 请求），
 * 那说明「连接是通的」，只是被站点拒绝了，不算代理故障。
 */

const { request, describeNetworkError } = require('./http');
const { systemProxyUrl, envProxyUrl } = require('./util');

/** 默认探测目标：一个国内站点 + 两个通常需要代理的站点 */
const DEFAULT_TARGETS = [
  { name: '国内站点', url: 'https://www.bilibili.com/', needProxy: false },
  { name: 'pixiv', url: 'https://www.pixiv.net/', needProxy: true },
  { name: 'YouTube', url: 'https://www.youtube.com/', needProxy: true },
];

/** 把一次探测结果翻译成人话 */
function classifyProbe(result) {
  const { status, error, name } = result;
  if (error) {
    const text = String(error);
    if (/ECONNREFUSED|ERR_PROXY_CONNECTION_FAILED|连不上代理|代理服务器拒绝/.test(text)) {
      return `代理不可用：${text}`;
    }
    if (/ENOTFOUND|EAI_AGAIN|域名解析/.test(text)) return `域名解析失败：${text}`;
    if (/超时|ETIMEDOUT|ERR_TIMED_OUT/.test(text)) return `连接超时：${text}`;
    if (/ECONNRESET|重置/.test(text)) return `连接被重置：${text}`;
    return text;
  }
  if (status >= 200 && status < 400) return `${name} 连接正常（HTTP ${status}）`;
  if (status === 401 || status === 403) {
    return `${name} 已连上（HTTP ${status}，被站点的防火墙/登录要求拒绝，属正常）`;
  }
  if (status === 404 || status === 405) return `${name} 已连上（HTTP ${status}）`;
  if (status >= 500) return `${name} 已连上（HTTP ${status}，是站点侧的问题）`;
  return `${name} 返回 HTTP ${status}`;
}

/** 判断一次探测是否算「连上了」 */
function isReachable(result) {
  if (result.error) return false;
  return Number(result.status) > 0;
}

/**
 * 探测一次。fetchImpl 由调用方给出（直连用内置 fetch、经代理用 CONNECT 客户端），
 * 不改动全局状态，因此可以并发跑。
 */
async function probeOnce(target, { fetchImpl, via, timeoutMs, signal }) {
  const startedAt = Date.now();
  try {
    const res = await request(target.url, {
      method: 'GET',
      range: 'bytes=0-0',
      wantBody: false,
      timeout: timeoutMs,
      retries: 0,
      signal,
      // 单次请求指定 fetch：直连用内置 fetch、经代理用 CONNECT 客户端，避免改动全局状态
      fetch: fetchImpl,
    });
    const result = { name: target.name, url: target.url, via, status: res.status, ms: Date.now() - startedAt, error: '' };
    return { ...result, ok: isReachable(result), note: classifyProbe(result) };
  } catch (err) {
    const result = {
      name: target.name,
      url: target.url,
      via,
      status: 0,
      ms: Date.now() - startedAt,
      error:
        err && err.message && /网络错误|超时|已取消|代理/.test(err.message)
          ? err.message
          : describeNetworkError(err, target.url),
    };
    return { ...result, ok: false, note: classifyProbe(result) };
  }
}

/**
 * 跑一次代理自检。
 * @param {object} opts
 * @param {string} [opts.proxy] 要测试的代理；不传则用环境变量 / 系统代理
 * @param {Array}  [opts.targets] 自定义探测目标
 * @param {boolean}[opts.compare=true] 是否同时做一次直连对比（能说明「代理有没有起作用」）
 * @param {number} [opts.timeoutMs=7000]
 * @returns {Promise<{proxy:string, source:string, ok:boolean, verdict:string, results:Array}>}
 */
async function checkProxy(opts = {}) {
  const explicit = String(opts.proxy || '').trim();
  const fromEnv = String(envProxyUrl() || '').trim();
  const fromSystem = String(systemProxyUrl() || '').trim();
  const proxy = explicit || fromEnv || fromSystem;
  const source = explicit ? '界面/参数设置' : fromEnv ? '环境变量' : fromSystem ? 'Windows 系统代理' : '';
  const targets = Array.isArray(opts.targets) && opts.targets.length ? opts.targets : DEFAULT_TARGETS;
  const timeoutMs = Number(opts.timeoutMs || 7000);
  const compare = opts.compare !== false;
  let proxyFetch = null;

  if (proxy) {
    try {
      const { createProxyFetch, parseProxyUrl } = require('./proxy-fetch');
      if (!parseProxyUrl(proxy)) {
        return {
          proxy,
          source,
          ok: false,
          verdict: `代理地址无法解析：${proxy}（示例：http://127.0.0.1:7890）`,
          results: [],
        };
      }
      proxyFetch = createProxyFetch(proxy, { timeout: timeoutMs + 2000 });
    } catch (err) {
      return { proxy, source, ok: false, verdict: `代理不可用：${err.message}`, results: [] };
    }
  }

  // 所有探测并发跑（直连/经代理各一次），最慢也就一个超时的时间
  // 直连探测必须显式使用内置 fetch：否则会沿用「当前已配置的代理」，测出来的是假直连
  const plainFetch = opts.plainFetch || globalThis.fetch;
  const jobs = [];
  for (const target of targets) {
    if (compare && proxy && target.needProxy !== false) {
      jobs.push(probeOnce(target, { fetchImpl: plainFetch, via: 'direct', timeoutMs, signal: opts.signal }));
    }
    jobs.push(
      probeOnce(target, {
        fetchImpl: proxy ? proxyFetch : plainFetch,
        via: proxy ? 'proxy' : 'direct',
        timeoutMs,
        signal: opts.signal,
      }),
    );
  }
  const results = await Promise.all(jobs);

  const viaProxy = results.filter((r) => r.via === 'proxy');
  const direct = results.filter((r) => r.via === 'direct');
  const proxyWorks = viaProxy.some((r) => r.ok);

  let verdict;
  if (!proxy) {
    const reachable = direct.filter((r) => r.ok).length;
    verdict = reachable
      ? '未配置代理，直连可用（如果目标站点打不开，再考虑配代理）'
      : '未配置代理，且直连失败 —— 这类站点需要代理才能访问';
  } else if (!proxyWorks) {
    const first = viaProxy.find((r) => !r.ok);
    verdict = `代理不生效：${first ? first.note : '所有目标都连不上'}（检查代理软件是否运行、地址端口是否写对）`;
  } else {
    const improved = viaProxy.filter((r) => r.ok && direct.some((d) => d.name === r.name && !d.ok)).length;
    const blocked = viaProxy.filter((r) => r.ok && r.status >= 400).length;
    verdict =
      `代理可用（${proxy}）` +
      (improved ? `，已让 ${improved} 个直连失败的站点变得可访问` : '') +
      (blocked ? `；其中 ${blocked} 个站点返回 4xx 是它自己的防火墙（pixiv/YouTube 常见），下载会改用内置浏览器请求，不影响使用` : '');
  }

  return { proxy, source, ok: proxy ? proxyWorks : direct.some((r) => r.ok), verdict, results };
}

module.exports = { checkProxy, classifyProbe, isReachable, DEFAULT_TARGETS };
