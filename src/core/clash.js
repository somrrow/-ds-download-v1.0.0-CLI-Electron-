'use strict';

/**
 * Clash / mihomo 控制接口封装（**只用于 pixiv 原生搜索的节点自救**，2026-10-19）。
 *
 * 背景：pixiv 原生搜索（ajax）走代理时，**同一个 URL、同一时刻**会出现
 * "mihomo 自带探测全通（200/218–444ms），但经代理端口的请求被 ECONNRESET" 的现象，
 * 而且节点选择还会自己变（实测 19:40 是香港02、21:13 变成日本01）。
 * 也就是说：代码没错，是**当前选中的那个节点对 pixiv 不友好**。
 *
 * 这里提供一个"换节点再试一次"的能力：
 *   ① 从 Clash Verge 的配置里拿到控制接口（命名管道或 HTTP）与 secret；
 *   ② 对候选节点逐个 `delay` 探测（目标是 pixiv 的 ajax 接口）；
 *   ③ 把订阅里的代理组（默认 `✈️Final`）切到第一个能通的节点。
 *
 * ⚠️ 只在调用方**显式开启**时才会真的切换（默认关），因为它改的是用户全局的代理选择：
 *    这份订阅最后一条规则是 `MATCH,✈️Final`，换组选择等于所有"需要代理"的流量一起换节点。
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

/** Clash Verge 的配置目录（Windows 默认位置，可用环境变量覆盖） */
function vergeDir() {
  const override = String(process.env.CLASH_VERGE_DIR || '').trim();
  if (override) return override;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'io.github.clash-verge-rev.clash-verge-rev');
}

/** 从 Clash Verge 的 `config.yaml` 里读出控制接口信息（读不到返回 null） */
function readApiInfo() {
  const candidates = [path.join(vergeDir(), 'config.yaml'), path.join(vergeDir(), 'clash-verge.yaml')];
  for (const file of candidates) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const pipe = /^external-controller-pipe:\s*(.+)$/m.exec(text);
    const ctl = /^external-controller:\s*['"]?([^'"\s]+)['"]?$/m.exec(text);
    const secret = /^secret:\s*['"]?([^'"\s]*)['"]?$/m.exec(text);
    const info = {
      pipe: pipe ? pipe[1].trim().replace(/^['"]|['"]$/g, '') : '',
      ctl: ctl ? ctl[1].trim() : '',
      secret: secret ? secret[1].trim() : '',
      file
    };
    if (info.pipe || info.ctl) return info;
  }
  return null;
}

/** 调一次 mihomo 的 REST 接口（自动区分"命名管道"与"TCP 端口"两种形态） */
function clashApi(info, method, apiPath, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const opts = {
      method,
      path: apiPath,
      headers: {
        Host: 'localhost',
        ...(info.secret ? { Authorization: `Bearer ${info.secret}` } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    if (info.pipe) {
      opts.socketPath = info.pipe.startsWith('\\\\.\\pipe\\') ? info.pipe : `\\\\.\\pipe\\${info.pipe}`;
    } else {
      const [host, port] = String(info.ctl).split(':');
      opts.host = host || '127.0.0.1';
      opts.port = Number(port) || 9097;
    }
    const req = http.request(opts, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
      });
      res.on('end', () => {
        let json = null;
        try {
          json = buf ? JSON.parse(buf) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode || 0, json, raw: buf.slice(0, 300) });
      });
    });
    req.on('error', (error) => resolve({ status: 0, json: null, error: String(error?.message ?? error) }));
    req.setTimeout(8000, () => {
      req.destroy(new Error('clash 控制接口超时'));
    });
    if (data) req.write(data);
    req.end();
  });
}

/** 这些名字不是真节点（订阅里的信息节点 / 内置策略） */
function isRealNode(name, groupAll) {
  const s = String(name || '');
  if (!s) return false;
  if (['DIRECT', 'REJECT', 'PASS', 'REJECT-DROP', 'COMPATIBLE'].includes(s)) return false;
  if (/剩余流量|到期|官网|客服|套餐|请|订阅|刷新|备用|重置/i.test(s)) return false;
  if (Array.isArray(groupAll) && groupAll.includes(s) && new Set(groupAll).size === groupAll.length) {
    // 组名出现在 all 里说明是嵌套策略组，跳过（真节点的类型由 delay 探测兜底）
  }
  return true;
}

/**
 * 探测某个节点到 pixiv ajax 的连通性。
 * @returns {Promise<{node:string, ok:boolean, delay?:number, error?:string}>}
 */
async function probeNode(info, node, probeUrl, timeoutMs = 3000) {
  const q = `/proxies/${encodeURIComponent(node)}/delay?url=${encodeURIComponent(probeUrl)}&timeout=${timeoutMs}`;
  const r = await clashApi(info, 'GET', q);
  if (r.status === 200 && r.json && Number(r.json.delay) > 0) return { node, ok: true, delay: Number(r.json.delay) };
  return { node, ok: false, error: r.json?.message || r.error || `HTTP ${r.status}` };
}

/**
 * 找一个"到 pixiv 能通"的节点，并把组切过去。
 *
 * @param {object} opts
 * @param {string} [opts.group]      要切换的代理组（默认 `✈️Final`）
 * @param {string} [opts.probeUrl]   探测目标（默认 pixiv ajax 的 `test` 查询）
 * @param {number} [opts.maxNodes]   最多探测几个候选（默认 6）
 * @param {number} [opts.timeoutMs]  单节点探测超时（默认 3000）
 * @param {function} [opts.onLog]
 * @returns {Promise<{ok:boolean, from?:string, to?:string, delay?:number, tried?:Array, error?:string, skipped?:string}>}
 */
async function failoverPixivNode(opts = {}) {
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const group = String(opts.group || process.env.CLASH_PIXIV_GROUP || '✈️Final').trim();
  const probeUrl = String(
    opts.probeUrl ||
      'https://www.pixiv.net/ajax/search/artworks/test?word=test&order=date_d&mode=all&p=1&s_mode=s_tag_full&type=all&lang=zh'
  );
  const maxNodes = Math.max(1, Math.min(12, Number(opts.maxNodes) || 6));
  const timeoutMs = Math.max(1500, Math.min(10000, Number(opts.timeoutMs) || 3000));

  const info = readApiInfo();
  if (!info) return { ok: false, skipped: '读不到 Clash Verge 的控制接口（config.yaml 里没有 external-controller*）' };

  const prox = await clashApi(info, 'GET', '/proxies');
  if (prox.status !== 200 || !prox.json?.proxies) return { ok: false, skipped: `控制接口不可用：${prox.error || `HTTP ${prox.status}`}` };

  const g = prox.json.proxies[group];
  if (!g) return { ok: false, skipped: `找不到代理组「${group}」` };
  if (!Array.isArray(g.all) || !g.all.length) return { ok: false, skipped: `代理组「${group}」没有候选节点` };

  const from = String(g.now || g.all[g.all.length - 1]);
  const candidates = g.all.filter((n) => isRealNode(n) && n !== from);
  if (!candidates.length) return { ok: false, skipped: '没有可切换的候选节点', from };

  // 先测"当前节点"是否真的对 pixiv 不通（避免误伤：有时只是搜索本身没结果）
  const cur = await probeNode(info, from, probeUrl, timeoutMs);
  if (cur.ok) return { ok: false, skipped: `当前节点「${from}」探测是通过的（${cur.delay}ms），不必切换`, from };

  const tried = [{ node: from, ok: false, error: cur.error }];
  for (const node of candidates.slice(0, maxNodes)) {
    const r = await probeNode(info, node, probeUrl, timeoutMs);
    tried.push(r);
    if (!r.ok) continue;
    const put = await clashApi(info, 'PUT', `/proxies/${encodeURIComponent(group)}`, { name: node });
    if (put.status !== 204 && put.status !== 200) {
      onLog(`切到「${node}」失败：HTTP ${put.status}`);
      continue;
    }
    onLog(`已把「${group}」从「${from}」切到「${node}」（pixiv 探测 ${r.delay}ms）`);
    return { ok: true, from, to: node, delay: r.delay, tried };
  }
  return { ok: false, error: `试了 ${tried.length} 个节点，没有一个能连上 pixiv`, from, tried };
}

module.exports = { readApiInfo, clashApi, probeNode, failoverPixivNode };
