'use strict';

/**
 * 通过 **CDP（Chrome DevTools Protocol）驱动用户自己的浏览器**（2026-11-09）。
 *
 * 为什么需要：抖音从 2026-10 起用 ArgusSecurityPlugin 挡请求 —— yt-dlp 拿不到数据、
 * 直接调接口 403、内置 Electron（冷会话 + 新指纹）几乎必出「验证码中间页」。
 * 唯一稳定的绕过方式是：**用用户平时在用的那个浏览器**（登录态、指纹、`uifid` 都是现成的），
 * 打开页面让它自己播一遍，再从网络事件/`performance` 里捞那条**已签名**的播放地址。
 * 这正是 ytdl-forward 插件借 `bsk.exe` 做的事；我们不需要 bsk，直接连 CDP 就行。
 *
 * 用之前只要把浏览器带调试端口启动一次：
 *   `start msedge --remote-debugging-port=9222`
 *   `start chrome --remote-debugging-port=9222`
 * 之后工具会自动探测 9222（可用 `--cdp-port` 或 `VIDEOGRAB_CDP_PORT` 改）。
 *
 * 说明：
 *   · 只支持 HTTP/WS 的 CDP（`/json/version`、`/json/new`、`/json/close`）；
 *   · WebSocket 自己实现（Node 24 有全局 WebSocket，但插件常常用 Electron 里那个
 *     Node 运行，它**没有** WebSocket，所以这里不依赖全局对象）；
 *   · 一切失败都抛错，调用方退回内置浏览器，不会更差。
 */

const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const DEFAULT_PORTS = [9222, 9223, 9224];
const CDP_HOST = '127.0.0.1';

function httpJson(port, pathname, method = 'GET', timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: CDP_HOST, port, path: pathname, method, timeout: timeoutMs, headers: { Host: `${CDP_HOST}:${port}` } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}：${body.slice(0, 120)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(body);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('CDP 端口探测超时')));
    req.once('error', reject);
    req.end();
  });
}

/** 探测一个带调试端口的浏览器：返回 { port, browser, webSocketDebuggerUrl } 或 null */
async function probeCdpPort(port, timeoutMs = 1500) {
  try {
    const info = await httpJson(port, '/json/version', 'GET', timeoutMs);
    if (info && info.webSocketDebuggerUrl) return { port, browser: String(info.Browser || ''), webSocketDebuggerUrl: info.webSocketDebuggerUrl };
  } catch {
    /* 这个端口没有浏览器 */
  }
  return null;
}

/**
 * 找一个可用的 CDP 端口。
 * @param {{ ports?: number[], port?: number }} opts
 */
async function findCdpBrowser(opts = {}) {
  const envPort = Number(process.env.VIDEOGRAB_CDP_PORT) || 0;
  const ports = [];
  const add = (p) => {
    const n = Number(p);
    if (Number.isInteger(n) && n > 0 && n < 65536 && !ports.includes(n)) ports.push(n);
  };
  add(opts.port);
  add(envPort);
  // 显式给了端口就只探它（省 3 秒）；没给才挨个试默认端口
  if (!ports.length) for (const p of opts.ports || DEFAULT_PORTS) add(p);
  for (const port of ports) {
    const found = await probeCdpPort(port, opts.timeoutMs || 1500);
    if (found) return found;
  }
  return null;
}
// ── 最小 WebSocket 客户端（文本帧，够 CDP 用） ─────────────────────────────

function encodeClientFrame(text) {
  const payload = Buffer.from(String(text), 'utf8');
  const len = payload.length;
  let header;
  const mask = crypto.randomBytes(4);
  if (len < 126) {
    header = Buffer.alloc(2 + 4);
    header[0] = 0x81;
    header[1] = 0x80 | len;
    mask.copy(header, 2);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i += 1) masked[i] = payload[i] ^ mask[i % 4];
    return Buffer.concat([header, masked]);
  }
  if (len < 65536) {
    header = Buffer.alloc(4 + 4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    mask.copy(header, 4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i += 1) masked[i] = payload[i] ^ mask[i % 4];
    return Buffer.concat([header, masked]);
  }
  header = Buffer.alloc(10 + 4);
  header[0] = 0x81;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt(len), 2);
  mask.copy(header, 10);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, masked]);
}

/**
 * 连一个 CDP WebSocket。
 * @returns {Promise<{ send:(obj:object)=>void, close:()=>void, onMessage:(cb:(obj:any)=>void)=>void }>}
 */
function connectCdpWs(wsUrl, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(wsUrl);
    } catch (e) {
      reject(new Error(`CDP WebSocket 地址不合法：${wsUrl}`));
      return;
    }
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: parsed.hostname,
      port: Number(parsed.port) || 80,
      path: parsed.pathname + (parsed.search || ''),
      method: 'GET',
      headers: {
        Host: `${parsed.hostname}:${parsed.port}`,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
      timeout: timeoutMs,
    });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      reject(err);
    };
    req.on('upgrade', (res, socket) => {
      if (settled) return;
      settled = true;
      socket.setNoDelay(true);
      let buffer = Buffer.alloc(0);
      const messageCbs = [];
      const onFrame = (packet) => {
        // 服务端→客户端：不掩码
        const fin = (packet[0] & 0x80) !== 0;
        const opcode = packet[0] & 0x0f;
        let offset = 2;
        let len = packet[1] & 0x7f;
        if (len === 126) {
          len = packet.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          len = Number(packet.readBigUInt64BE(2));
          offset = 10;
        }
        const payload = packet.slice(offset, offset + len);
        if (opcode === 0x8) {
          try {
            socket.end();
          } catch {
            /* ignore */
          }
          return { text: '', close: true };
        }
        if (opcode === 0x9) {
          // ping → 回 pong（客户端帧要掩码，简单拼一个 0x8a 空帧）
          try {
            socket.write(Buffer.from([0x8a, 0x80, 0, 0, 0, 0]));
          } catch {
            /* ignore */
          }
          return { text: '' };
        }
        if (opcode === 0x1 || opcode === 0x0) {
          return { text: payload.toString('utf8'), fin };
        }
        return { text: '' };
      };
      const pump = () => {
        while (buffer.length >= 2) {
          let len = buffer[1] & 0x7f;
          let headerLen = 2;
          if (len === 126) {
            if (buffer.length < 4) return;
            len = buffer.readUInt16BE(2);
            headerLen = 4;
          } else if (len === 127) {
            if (buffer.length < 10) return;
            len = Number(buffer.readBigUInt64BE(2));
            headerLen = 10;
          }
          if (buffer.length < headerLen + len) return;
          const packet = buffer.slice(0, headerLen + len);
          buffer = buffer.slice(headerLen + len);
          const { text } = onFrame(packet);
          if (!text) continue;
          let obj;
          try {
            obj = JSON.parse(text);
          } catch {
            continue;
          }
          for (const cb of messageCbs) {
            try {
              cb(obj);
            } catch {
              /* ignore */
            }
          }
        }
      };
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        pump();
      });
      socket.on('close', () => {
        for (const cb of messageCbs) {
          try {
            cb({ __closed: true });
          } catch {
            /* ignore */
          }
        }
      });
      socket.on('error', () => {
        /* 连接断了：让调用方的超时去收尾 */
      });
      resolve({
        send: (obj) => {
          try {
            socket.write(encodeClientFrame(JSON.stringify(obj)));
          } catch {
            /* ignore */
          }
        },
        close: () => {
          try {
            socket.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0]));
            socket.end();
          } catch {
            /* ignore */
          }
        },
        onMessage: (cb) => {
          messageCbs.push(cb);
        },
      });
    });
    req.on('timeout', () => fail(new Error('CDP WebSocket 握手超时')));
    req.on('response', (res) => fail(new Error(`CDP WebSocket 握手失败（HTTP ${res.statusCode}）`)));
    req.once('error', fail);
    req.end();
  });
}

/** 发一条 CDP 命令并等它的结果 */
function cdpCall(ws, method, params = {}, { timeoutMs = 15000 } = {}) {
  const id = cdpCall.seq = (cdpCall.seq || 0) + 1;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP 命令超时：${method}`)), timeoutMs);
    const onMessage = (msg) => {
      if (msg && msg.id === id) {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`CDP ${method} 失败：${msg.error.message || JSON.stringify(msg.error)}`));
        else resolve(msg.result || {});
      }
    };
    ws.onMessage(onMessage);
    ws.send({ id, method, params });
  });
}

const MEDIA_URL_RE = /(?:douyinvod\.com|xhscdn\.com|\.mp4|mime_type=video|m3u8)/i;

/** 明显是**页面静态资源**、不是视频的地址（抖音的 UI 动画 .mp4、图标、脚本） */
function isStaticAsset(url) {
  const u = String(url || '');
  if (/douyinstatic\.com|douyinpic\.com|\/obj\//i.test(u)) return true;
  if (/uuu_\d+\.mp4|\.(?:js|css|png|jpe?g|webp|gif|svg|woff2?)(?:\?|$)/i.test(u)) return true;
  return false;
}

/** 给候选地址打分：真·播放地址 > 通用 mp4 > 其它 */
function scoreMediaUrl(url) {
  const u = String(url || '');
  let s = 0;
  if (/douyinvod\.com/i.test(u)) s += 100;
  if (/\/video\/tos\//i.test(u)) s += 40;
  if (/bytecdn|byteimg/i.test(u)) s += 20;
  if (/\.mp4(?:\?|$)/i.test(u)) s += 10;
  if (/m3u8/i.test(u)) s += 5;
  if (isStaticAsset(u)) s -= 1000;
  return s;
}

/**
 * 用用户的浏览器打开页面，捞**真实播放地址**（YouTube/抖音这类"签名地址"都适用）。
 *
 * @param {object} opts
 * @param {string} opts.url              要打开的页面
 * @param {number} [opts.port]           调试端口（默认自动探测 9222/9223/9224）
 * @param {number} [opts.waitSec]        打开后等多久（默认 12 秒；抖音播放器起播要几秒）
 * @param {RegExp} [opts.match]          只收匹配的地址（默认视频类）
 * @param {(msg:string)=>void} [opts.onLog]
 * @returns {Promise<{ videoUrl:string, html5:boolean, title:string, bodyText:string, candidates:string[], browser:string, port:number }>}
 */
async function harvestViaCdp(opts = {}) {
  const onLog = opts.onLog || (() => {});
  const target = String(opts.url || '').trim();
  if (!target) throw new Error('CDP：页面地址为空');
  const browser = await findCdpBrowser({ port: opts.port, timeoutMs: 2000 });
  if (!browser) {
    throw new Error('没有找到带调试端口的浏览器（用 `start msedge --remote-debugging-port=9222` 启动一个）');
  }
  onLog(`CDP：连上 ${browser.browser || '浏览器'}（端口 ${browser.port}）`);
  /**
   * 开标签页 **不能在后台窗口上"弹出来"**（2026-11-09 用户报：每次下载，最小化的窗口都会跳到前台）。
   *
   * 实测对比（同一个最小化窗口，用 `Browser.getWindowBounds` 看状态）：
   *   `PUT /json/new?url=…`            → windowState 变 `normal`（窗口被拉到前台）❌
   *   `Target.createTarget({background:true})` → 仍然是 `minimized` ✅
   *
   * 所以这里改成走浏览器级 WS 的 `Target.createTarget(background: true)`，
   * 再用 `/json/list` 找到这个 target 的 page WS；用 `Target.closeTarget` 收尾。
   * 实在不支持（老版本）才退回 `/json/new`。
   */
  const browserWs = await connectCdpWs(browser.webSocketDebuggerUrl, { timeoutMs: 6000 });
  let targetId = '';
  let wsUrl = '';
  try {
    const created = await cdpCall(browserWs, 'Target.createTarget', { url: 'about:blank', background: true }, { timeoutMs: 8000 });
    targetId = String(created.targetId || '');
    if (targetId) {
      const list = await httpJson(browser.port, '/json/list', 'GET', 4000).catch(() => []);
      const found = (Array.isArray(list) ? list : []).find((t) => String(t.id) === targetId);
      wsUrl = found && found.webSocketDebuggerUrl;
    }
  } catch {
    /* 老版本没有 background 参数：下面退回 /json/new */
  }
  if (!targetId || !wsUrl) {
    const page = await httpJson(browser.port, `/json/new?${encodeURIComponent(target)}`, 'PUT', 5000).catch(async () => {
      // 某些版本要求 GET
      return httpJson(browser.port, `/json/new?${encodeURIComponent(target)}`, 'GET', 5000);
    });
    targetId = String((page && (page.id || page.targetId)) || '');
    wsUrl = page && page.webSocketDebuggerUrl;
    if (targetId) {
      // 兜底路径：把窗口状态恢复成最小化（用户那边看到的是"闪一下又回去"，比一直挂着好）
      try {
        const win = await cdpCall(browserWs, 'Browser.getWindowForTarget', { targetId }, { timeoutMs: 3000 });
        if (win && win.windowId) {
          await cdpCall(browserWs, 'Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'minimized' } }, { timeoutMs: 3000 });
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (!wsUrl) throw new Error('CDP：新标签页没有 webSocketDebuggerUrl');
  const ws = await connectCdpWs(wsUrl, { timeoutMs: 6000 });
  const candidates = [];
  let title = '';
  let bodyText = '';
  try {
    await cdpCall(ws, 'Page.enable', {}, { timeoutMs: 8000 }).catch(() => {});
    await cdpCall(ws, 'Runtime.enable', {}, { timeoutMs: 8000 }).catch(() => {});
    await cdpCall(ws, 'Network.enable', {}, { timeoutMs: 8000 }).catch(() => {});
    /**
     * 后台标签页会被浏览器节流：页面能打开、但不渲染播放器、也不发媒体请求
     * （实测：只 createTarget(background) + navigate，标题都还是空的）。
     * 这两条命令让后台标签"以为自己是前台、且没被冻结" —— 实测能正常出播放地址，
     * 而窗口始终留在最小化状态（2026-11-09 用户报"每次下载窗口都会弹出来"）。
     */
    await cdpCall(ws, 'Emulation.setFocusEmulationEnabled', { enabled: true }, { timeoutMs: 4000 }).catch(() => {});
    await cdpCall(ws, 'Page.setWebLifecycleState', { state: 'active' }, { timeoutMs: 4000 }).catch(() => {});
    ws.onMessage((msg) => {
      if (msg && msg.__closed) return;
      if (msg.method === 'Network.requestWillBeSent' && msg.params && msg.params.request) {
        const u = String(msg.params.request.url || '');
        const re = opts.match || MEDIA_URL_RE;
        if (re.test(u) && !candidates.includes(u)) candidates.push(u);
      }
    });
    await cdpCall(ws, 'Page.navigate', { url: target }, { timeoutMs: 12000 }).catch(() => {});
    // 催一下播放器（抖音/小红书都要滚一下、或手动 play 才会去拉流）
    await new Promise((r) => setTimeout(r, 1500));
    await cdpCall(
      ws,
      'Runtime.evaluate',
      { expression: "(function(){try{window.scrollTo(0,300);var v=document.querySelector('video');if(v){v.muted=true;var p=v.play();if(p&&p.catch)p.catch(function(){});}}catch(e){}return true;})()" },
      { timeoutMs: 5000 },
    ).catch(() => {});
    const waitMs = Math.max(2, Number(opts.waitSec) || 12) * 1000;
    const startedAt = Date.now();
    let lastCount = 0;
    let goodAt = 0;
    while (Date.now() - startedAt < waitMs) {
      await new Promise((r) => setTimeout(r, 700));
      const good = candidates.some((u) => scoreMediaUrl(u) >= 100); // douyinvod 那种真地址
      if (good && !goodAt) goodAt = Date.now();
      if (goodAt && Date.now() - goodAt > 2500) break; // 抓到真地址后再等 2.5 秒收工
      const hasNew = candidates.length > lastCount;
      lastCount = candidates.length;
      if (candidates.length && !hasNew && !goodAt && Date.now() - startedAt > 6000) break;
    }
    const evaluated = await cdpCall(
      ws,
      'Runtime.evaluate',
      {
        expression:
          `JSON.stringify({ title: document.title || '', bodyText: String((document.body && document.body.innerText) || '').slice(0, 800), perf: performance.getEntriesByType('resource').map(function (e) { return e.name; }).filter(function (u) { return /douyinvod|xhscdn|\\.mp4|m3u8/.test(u); }) })`,
        returnByValue: true,
      },
      { timeoutMs: 8000 },
    ).catch(() => null);
    if (evaluated && evaluated.result && typeof evaluated.result.value === 'string') {
      try {
        const data = JSON.parse(evaluated.result.value);
        title = String(data.title || '');
        bodyText = String(data.bodyText || '');
        for (const u of data.perf || []) {
          const re = opts.match || MEDIA_URL_RE;
          if (re.test(u) && !candidates.includes(u)) candidates.push(u);
        }
      } catch {
        /* ignore */
      }
    }
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    // 关标签页用 Target.closeTarget（不会像 /json/close 那样可能激活窗口）
    if (targetId) {
      try {
        await cdpCall(browserWs, 'Target.closeTarget', { targetId }, { timeoutMs: 3000 });
      } catch {
        httpJson(browser.port, `/json/close/${targetId}`, 'GET', 2000).catch(() => {});
      }
    }
    try {
      browserWs.close();
    } catch {
      /* ignore */
    }
  }
  // 过滤掉 UI 静态资源，再按"像不像真播放地址"排序
  const usable = candidates.filter((u) => !isStaticAsset(u));
  usable.sort((a, b) => scoreMediaUrl(b) - scoreMediaUrl(a));
  const videoUrl = usable[0] || '';
  if (videoUrl) onLog(`CDP：抓到播放地址（${usable.length} 个候选，首选 ${scoreMediaUrl(videoUrl)} 分）`);
  return {
    videoUrl,
    title,
    bodyText,
    candidates: usable,
    browser: browser.browser,
    port: browser.port,
  };
}

module.exports = {
  DEFAULT_PORTS,
  findCdpBrowser,
  probeCdpPort,
  connectCdpWs,
  cdpCall,
  harvestViaCdp,
  isStaticAsset,
  scoreMediaUrl,
  MEDIA_URL_RE,
};
