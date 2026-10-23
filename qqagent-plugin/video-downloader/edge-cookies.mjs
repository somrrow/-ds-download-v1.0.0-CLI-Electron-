// 从 **Microsoft Edge** 里读 cookie，给"需要登录态"的站点补上插件自己的登录身份。
//
// ── 为什么要它 ────────────────────────────────────────────────────────────
// 下载器对 B 站 1080P+、会员清晰度、需要登录的站点要用 `--cookies <Netscape 文件>`。
// 原来的登录态只能来自：插件自己的 login-cookies.txt，或桌面版「在内置浏览器里登录后
// 导出」的那份。可平时大家都是在 **Edge 里**登录 B 站的 —— 明明浏览器里有 cookie，
// 插件却相当于没登录。这个模块就是把 Edge 的 cookie 读出来、转成 Netscape 文件。
//
// ── Chromium(Edge) 的 cookie 是怎么存的 ───────────────────────────────────
//   · 库文件：<Edge User Data>/<Profile>/Network/Cookies（SQLite，表 cookies）
//   · 加密：encrypted_value = "v10"/"v20" + 12 字节 nonce + 密文 + 16 字节 tag（AES-256-GCM）
//     密钥 = DPAPI 解开 <Edge User Data>/Local State 里的 os_crypt.encrypted_key
//     （去掉前 5 字节 "DPAPI"，用当前用户的 DPAPI 解密）。所以**必须同一个 Windows 用户**。
//   · v20 是 Chrome/Edge 127+ 的「app-bound 加密」，密钥绑在浏览器自己的私钥上，
//     外部进程解不了 —— 这种只能跳过并如实报数量（别假装成功）。
//
// ── 两个现实约束（都在这里处理掉，调用方不用管）──────────────────────────
//   1. Edge **正在运行时** Cookies 文件被独占打开，连只读都读不出来（Windows 文件锁）。
//      所以先 try/catch 复制快照，失败就返回 { locked: true }，由调用方决定是否提示。
//   2. DPAPI 没法用纯 JS 调，走一次 PowerShell（本机是合法用户，等价于"以自己身份解密"）。
//
// 只依赖 Node 内置模块（node:sqlite / node:crypto + powershell.exe），不引第三方包。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

/** Edge 的 User Data 根目录（Local State 在根上，Cookies 在各 Profile 下） */
export function edgeUserDataDir() {
  const local = process.env.LOCALAPPDATA || '';
  return local ? path.join(local, 'Microsoft', 'Edge', 'User Data') : '';
}

/** 默认只导出这些域名的 cookie（别把整个浏览器的 cookie 都写成明文文件） */
export const DEFAULT_HOSTS = [
  'bilibili.com',
  'b23.tv',
  'douyin.com',
  'iesdouyin.com',
  'pixiv.net',
  'youtube.com',
  'kuaishou.com',
  'weibo.com',
  'x.com',
  'twitter.com',
  'tiktok.com',
  'xiaohongshu.com'
];

/** 列出可用的 Edge 配置（含 Cookies 文件的） */
export function edgeProfiles() {
  const root = edgeUserDataDir();
  if (!root || !fs.existsSync(root)) return [];
  let names = [];
  try {
    names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^(Default|Profile \d+)$/.test(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    for (const rel of [path.join('Network', 'Cookies'), 'Cookies']) {
      const file = path.join(root, name, rel);
      if (fs.existsSync(file)) {
        out.push({ name, file, localState: path.join(root, 'Local State') });
        break;
      }
    }
  }
  // Default 排前面：绝大多数人用的就是它
  return out.sort((a, b) => (a.name === 'Default' ? -1 : b.name === 'Default' ? 1 : a.name.localeCompare(b.name)));
}

/** 复制 SQLite 快照（Edge 开着时会被独占，复制不出来） */
function snapshotDb(srcFile, destFile) {
  // 连同 -wal/-shm 一起复制，否则快照可能读到"还没有 checkpoint 的旧数据"
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${srcFile}${suffix}`;
    const to = `${destFile}${suffix}`;
    if (!fs.existsSync(from)) continue;
    try {
      fs.copyFileSync(from, to);
    } catch (error) {
      if (!suffix) return { ok: false, code: error?.code || 'COPY_FAILED', message: String(error?.message || error) };
    }
  }
  return { ok: true };
}

/** DPAPI 解密（当前用户）—— 纯 JS 调不到 CryptUnprotectData，走一次 PowerShell */
function dpapiUnprotect(blob) {
  return new Promise((resolve, reject) => {
    const b64 = Buffer.from(blob).toString('base64');
    const script =
      '$ErrorActionPreference = "Stop";' +
      `$raw = [Convert]::FromBase64String('${b64}');` +
      'Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue;' +
      "$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($raw, $null, 'CurrentUser');" +
      '[Convert]::ToBase64String($plain)';
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      reject(error);
      return;
    }
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => {
      if (out.length < 8192) out += d.toString('utf8');
    });
    child.stderr?.on('data', (d) => {
      if (err.length < 8192) err += d.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) => {
      const text = out.trim();
      if (code !== 0 || !text) {
        reject(new Error(`DPAPI 解密失败（PowerShell 退出码 ${code}）：${err.trim().slice(0, 200) || '没有输出'}`));
        return;
      }
      try {
        resolve(Buffer.from(text.split(/\r?\n/).pop(), 'base64'));
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** 读 Local State 里的 os_crypt.encrypted_key 并解出 AES 密钥（按文件 mtime 缓存） */
let keyCache = { file: '', mtime: 0, key: null };
export async function osCryptKey(localStateFile) {
  if (!localStateFile || !fs.existsSync(localStateFile)) throw new Error('找不到 Edge 的 Local State');
  const st = fs.statSync(localStateFile);
  if (keyCache.key && keyCache.file === localStateFile && keyCache.mtime === st.mtimeMs) return keyCache.key;
  const json = JSON.parse(fs.readFileSync(localStateFile, 'utf8'));
  const encoded = json?.os_crypt?.encrypted_key;
  if (!encoded) throw new Error('Edge 的 Local State 里没有 os_crypt.encrypted_key（可能从未登录过）');
  let blob = Buffer.from(encoded, 'base64');
  if (blob.subarray(0, 5).toString('latin1') === 'DPAPI') blob = blob.subarray(5);
  const key = await dpapiUnprotect(blob);
  if (!key || key.length !== 32) throw new Error(`无法解析 Edge 的加密密钥（长度 ${key ? key.length : 0}）`);
  keyCache = { file: localStateFile, mtime: st.mtimeMs, key };
  return key;
}

/**
 * 解密一条 encrypted_value。
 * @returns {{ok:true, value:string}|{ok:false, reason:'v20'|'unknown'|'empty'}}
 */
export function decryptChromiumCookie(encrypted, key) {
  const buf = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted || []);
  if (!buf.length) return { ok: false, reason: 'empty' };
  const prefix = buf.length >= 3 ? buf.subarray(0, 3).toString('latin1') : '';
  // v20 = app-bound 加密（Chrome/Edge 127+），密钥绑在浏览器私钥上，外部解不了
  if (prefix === 'v20') return { ok: false, reason: 'v20' };
  if (!key) return { ok: false, reason: 'unknown' };
  const body = prefix === 'v10' || prefix === 'v11' ? buf.subarray(3) : buf;
  // 现代格式：nonce(12) + 密文 + tag(16)，AES-256-GCM
  if (body.length > 12 + 16) {
    try {
      const nonce = body.subarray(0, 12);
      const tag = body.subarray(body.length - 16);
      const ct = body.subarray(12, body.length - 16);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
      return { ok: true, value: plain.toString('utf8') };
    } catch {
      /* 落到老格式再试 */
    }
  }
  // 老格式（Chrome 80 之前）：AES-256-CBC，IV = 16 个空格
  try {
    const iv = Buffer.alloc(16, 0x20);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]);
    return { ok: true, value: plain.toString('utf8') };
  } catch {
    return { ok: false, reason: 'unknown' };
  }
}

/** host_key 是否命中 hosts 列表（后缀匹配，忽略前导点） */
export function hostMatches(hostKey, hosts) {
  const h = String(hostKey || '').replace(/^\./, '').toLowerCase();
  if (!h) return false;
  if (!hosts || !hosts.length) return true;
  return hosts.some((raw) => {
    const d = String(raw || '').trim().replace(/^\./, '').toLowerCase();
    return d && (h === d || h.endsWith(`.${d}`));
  });
}

/** Chromium 的 expires_utc（1601 微秒）→ Unix 秒；会话 cookie 给个远期时间（Netscape 里 0 容易被丢掉） */
export function chromiumExpiry(expiresUtc, now = Date.now()) {
  const n = Number(expiresUtc) || 0;
  if (n <= 0) return Math.floor(now / 1000) + 365 * 24 * 3600;
  return Math.max(0, Math.floor(n / 1e6 - 11644473600));
}

/** rows → Netscape cookies.txt 内容（yt-dlp / curl 都认这个格式） */
export function toNetscape(rows, { now = Date.now() } = {}) {
  const lines = ['# Netscape HTTP Cookie File', '# 由 肥鱼当劳 从 Microsoft Edge 导出，请勿外传', ''];
  for (const row of rows || []) {
    const host = String(row.host_key || '');
    if (!host) continue;
    const name = String(row.name || '');
    if (!name) continue;
    // 值里出现制表符/换行会破坏格式，直接跳过（正常 cookie 不会有）
    const value = String(row.value ?? '');
    if (/[\t\r\n]/.test(value) || /[\t\r\n]/.test(name)) continue;
    const domainField = host.startsWith('.') ? host : `.${host}`;
    const includeSub = host.startsWith('.') ? 'TRUE' : 'FALSE';
    const secure = row.is_secure ? 'TRUE' : 'FALSE';
    const expiry = chromiumExpiry(row.expires_utc, now);
    const cookiePath = String(row.path || '/') || '/';
    const prefix = row.is_httponly ? '#HttpOnly_' : '';
    lines.push([`${prefix}${domainField}`, includeSub, cookiePath, secure, String(expiry), name, value].join('\t'));
  }
  lines.push('');
  return lines.join('\n');
}

/** 用 node:sqlite 读 cookies 表（Electron 的 Node 22 / node.exe 24 都自带） */
async function readCookieRows(dbFile, hosts) {
  let DatabaseSync = null;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    throw new Error('当前 Node 运行时不带 node:sqlite，读不了 Edge 的 cookie 库');
  }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const rows = db
      .prepare('SELECT host_key, name, path, expires_utc, is_secure, is_httponly, is_persistent, value, encrypted_value FROM cookies')
      .all();
    return rows.filter((r) => hostMatches(r.host_key, hosts));
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 把 Edge 的 cookie 导出成 Netscape 文件。
 *
 * @param {object} opts
 * @param {string} opts.outFile 目标文件
 * @param {string[]} [opts.hosts] 只导出这些域（默认 DEFAULT_HOSTS；传 ['*'] 表示全导）
 * @param {string} [opts.profile] 'auto'（默认）或 'Default' / 'Profile 1'
 * @param {(…a:any[])=>void} [opts.log]
 * @returns {Promise<{ok:boolean, outFile?:string, total?:number, exported?:number, skippedV20?:number, skippedNoKey?:number, profile?:string, locked?:boolean, error?:string}>}
 */
export async function exportEdgeCookies({ outFile, hosts = DEFAULT_HOSTS, profile = 'auto', log = () => {} } = {}) {
  const list = !hosts || !hosts.length || (hosts.length === 1 && String(hosts[0]).trim() === '*') ? [] : hosts;
  const profiles = edgeProfiles();
  if (!profiles.length) return { ok: false, error: '这台机器上没有找到 Edge 的 cookie 库（没装 Edge / 没登录过）' };
  const picked =
    profile && profile !== 'auto' ? profiles.filter((p) => p.name === profile) : profiles;
  const use = (picked.length ? picked : profiles)[0];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgrab-edge-'));
  const snap = path.join(tmpDir, 'Cookies');
  try {
    const copied = snapshotDb(use.file, snap);
    if (!copied.ok) {
      return {
        ok: false,
        locked: copied.code === 'EBUSY' || copied.code === 'EPERM' || copied.code === 'EACCES',
        error: `读不到 Edge 的 cookie 库（${copied.code}）：Edge 正在运行时会独占这个文件，请完全退出 Edge 后再试`
      };
    }
    const rows = await readCookieRows(snap, list);
    let key = null;
    let keyError = '';
    try {
      key = await osCryptKey(use.localState);
    } catch (error) {
      keyError = String(error?.message || error);
    }
    const out = [];
    let skippedV20 = 0;
    let skippedNoKey = 0;
    for (const row of rows) {
      const enc = row.encrypted_value;
      const hasEnc = enc && (Buffer.isBuffer(enc) ? enc.length : Number(enc.length) > 0);
      let value = row.value == null ? '' : String(row.value);
      if (hasEnc) {
        const r = decryptChromiumCookie(enc, key);
        if (r.ok) value = r.value;
        else if (r.reason === 'v20') {
          skippedV20 += 1;
          continue;
        } else {
          skippedNoKey += 1;
          continue;
        }
      }
      if (!value) continue;
      out.push({ ...row, value });
    }
    if (!out.length) {
      const why = skippedV20
        ? `这 ${skippedV20} 条是 Edge 新版（v20 app-bound）加密的，外部进程解不开`
        : keyError
          ? `解不出 Edge 的密钥：${keyError}`
          : `Edge 里没有 ${list.length ? list.join('/') : '任何'} 相关的 cookie（先在 Edge 里登录一下）`;
      return { ok: false, error: `没有可导出的 cookie：${why}`, skippedV20, skippedNoKey };
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, toNetscape(out), 'utf8');
    log('已从 Edge（%s）导出 %d 条 cookie → %s', use.name, out.length, outFile);
    return {
      ok: true,
      outFile,
      total: rows.length,
      exported: out.length,
      skippedV20,
      skippedNoKey,
      profile: use.name
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export default { edgeProfiles, exportEdgeCookies, decryptChromiumCookie, toNetscape, hostMatches, DEFAULT_HOSTS };
