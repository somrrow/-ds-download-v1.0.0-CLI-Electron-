'use strict';

/**
 * 本地离线测试：内置一个模拟视频服务器（直链 / Range / 加密 HLS / fMP4 / 网页），
 * 覆盖探测、直链下载、断点续传、HLS 解析与解密、编排层与 CLI 参数解析。
 *
 *   node tests/run.js
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { probe } = require('../src/core/probe');
const { downloadDirect } = require('../src/core/downloads/direct');
const { downloadHls, parseM3U8, selectVariant } = require('../src/core/downloads/hls');
const { VideoDownloader, looksLikeLiveUrl, pickLiveFormat, rankLiveFormats } = require('../src/core/downloader');
const { buildFormatSelector, buildFormatSort, needsFfmpeg, translateYtDlpError } = require('../src/core/ytdlp');
const { selectBestMedia, extractMediaFromPageData } = require('../src/core/browser-page');
const { writeNetscapeCookies, resolveLoginTarget, LOGIN_SITES } = require('../src/core/browser-login');
const { loginCookiesFile, hasLoginCookies } = require('../src/core/config');
const { parseArgs } = require('../src/cli');
const util = require('../src/core/util');

const TMP_ROOT = path.join(__dirname, '.tmp');
// 测试会真实调用下载器，把历史写到临时文件，避免污染用户的下载历史
process.env.VIDEOGRAB_HISTORY_FILE = path.join(TMP_ROOT, 'history.json');
const results = [];
let failures = 0;
let passCount = 0;

function test(name, fn) {
  return { name, fn };
}

async function run(tests) {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const server = await startServer();
  try {
    for (const t of tests) {
      const dir = path.join(TMP_ROOT, t.name.replace(/[^\w\u4e00-\u9fa5-]+/g, '_'));
      fs.mkdirSync(dir, { recursive: true });
      try {
        await t.fn({ server, dir });
        passCount += 1;
        results.push(`  \u2713 ${t.name}`);
      } catch (err) {
        failures += 1;
        results.push(`  \u2717 ${t.name}\n      ${err.message.split('\n').join('\n      ')}`);
      }
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
  process.stdout.write(`\n${results.join('\n')}\n\n`);
  process.stdout.write(`通过 ${passCount} 项，失败 ${failures} 项\n`);
  if (!failures) fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  else process.stdout.write(`（失败用例的临时文件保留在 ${TMP_ROOT}）\n`);
  process.exitCode = failures ? 1 : 0;
}

function assert(cond, message) {
  if (!cond) throw new Error(message || '断言失败');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || '值不相等'}：期望 ${expected}，实际 ${actual}`);
}

function assertBufferEqual(actual, expected, message) {
  if (actual.length !== expected.length) {
    throw new Error(`${message || '内容不一致'}：长度 ${actual.length} != ${expected.length}`);
  }
  if (!actual.equals(expected)) throw new Error(`${message || '内容不一致'}：字节不相同`);
}

// ---------------------------------------------------------------- 模拟服务器

const DIRECT_PAYLOAD = Buffer.alloc(3 * 1024 * 1024 + 12345);
for (let i = 0; i < DIRECT_PAYLOAD.length; i += 1) DIRECT_PAYLOAD[i] = (i * 31 + 7) & 0xff;

const SEGMENT_COUNT = 6;
const SEGMENT_SIZE = 96 * 1024;
const PLAIN_SEGMENTS = [];
for (let s = 0; s < SEGMENT_COUNT; s += 1) {
  const buf = Buffer.alloc(SEGMENT_SIZE);
  for (let i = 0; i < SEGMENT_SIZE; i += 1) buf[i] = (s * 17 + i * 13 + 5) & 0xff;
  PLAIN_SEGMENTS.push(buf);
}

const KEY = crypto.randomBytes(16);
const KEY2 = crypto.randomBytes(16);
const INIT_SEGMENT = Buffer.from('FAKE-INIT-SEGMENT-');
const FMP4_SEGMENTS = [Buffer.from('fmp4-seg-0'), Buffer.from('fmp4-seg-1'), Buffer.from('fmp4-seg-2')];

/** 模拟直播：每次请求播放列表时多“发布”一个分片，最后追加 ENDLIST */
const LIVE_SEGMENTS = [Buffer.from('live-seg-0'), Buffer.from('live-seg-1'), Buffer.from('live-seg-2'), Buffer.from('live-seg-3')];

/** 模拟「永不结束」的直播：分片持续增加，没有 ENDLIST（用于测试中途结束录制） */const LIVE3_SEGMENTS = Array.from({ length: 40 }, (_, i) => Buffer.from(`long-live-seg-${String(i).padStart(2, '0')}-` + 'x'.repeat(64)));

/** 模拟直播连续流（FLV）的数据块大小 */
const STREAM_CHUNK_SIZE = 4096;

function ivForSequence(seq) {
  const buf = Buffer.alloc(16);
  buf.writeUInt32BE(seq >>> 0, 12);
  return buf;
}

function encryptSegment(plain, key, iv) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

function sendBuffer(req, res, buf, { contentType = 'application/octet-stream', filename, acceptRanges = true, ignoreRange = false } = {}) {
  const headers = { 'Content-Type': contentType, 'Accept-Ranges': acceptRanges ? 'bytes' : 'none' };
  if (filename) {
    const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    headers['Content-Disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  }
  const range = req.headers.range;
  if (range && acceptRanges && !ignoreRange) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : buf.length - 1;
      if (start >= buf.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${buf.length}` });
        res.end();
        return;
      }
      const slice = buf.slice(start, end + 1);
      res.writeHead(206, {
        ...headers,
        'Content-Length': slice.length,
        'Content-Range': `bytes ${start}-${end}/${buf.length}`,
      });
      res.end(slice);
      return;
    }
  }
  res.writeHead(200, { ...headers, 'Content-Length': buf.length });
  res.end(buf);
}

const seenRangeRequests = [];

function startServer() {
  let livePolls = 0;
  let live3Polls = 0;
  const encryptedSegments = PLAIN_SEGMENTS.map((buf, i) => encryptSegment(buf, KEY, ivForSequence(i)));
  const encryptedSegmentsIvAttr = PLAIN_SEGMENTS.map((buf) =>
    encryptSegment(buf, KEY2, Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')),
  );

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (req.headers.range) seenRangeRequests.push({ path: p, range: req.headers.range });

    if (p === '/direct.mp4') {
      return sendBuffer(req, res, DIRECT_PAYLOAD, {
        contentType: 'video/mp4',
        filename: '示例视频.mp4',
      });
    }
    if (p === '/stream.flv') {
      // 模拟直播连续流：没有 Content-Length，持续推送数据块，永不结束
      res.writeHead(200, { 'Content-Type': 'video/x-flv', 'Cache-Control': 'no-cache' });
      let i = 0;
      const timer = setInterval(() => {
        if (res.writableEnded) {
          clearInterval(timer);
          return;
        }
        const chunk = Buffer.alloc(STREAM_CHUNK_SIZE, i & 0xff);
        chunk.write(`chunk-${String(i).padStart(4, '0')}`, 0, 'utf8');
        res.write(chunk);
        i += 1;
      }, 20);
      req.on('close', () => clearInterval(timer));
      return;
    }
    if (p === '/pixiv/ajax/illust/999') {
      return sendBuffer(
        req,
        res,
        Buffer.from(
          JSON.stringify({
            error: false,
            message: '',
            body: {
              illustTitle: '测试插画标题',
              userName: '测试画师',
              pageCount: 3,
              illustType: 0,
              xRestrict: 0,
              tags: { tags: [{ tag: '测试' }] },
            },
          }),
        ),
        { contentType: 'application/json' },
      );
    }
    if (p === '/pixiv/ajax/illust/999/pages') {
      const base = `http://127.0.0.1:${req.socket.localPort}`;
      return sendBuffer(
        req,
        res,
        Buffer.from(
          JSON.stringify({
            error: false,
            body: [
              { urls: { original: `${base}/pixiv/img/p0.jpg` } },
              { urls: { original: `${base}/pixiv/img/p1.jpg` } },
              { urls: { original: `${base}/pixiv/img/p2.png` } },
            ],
          }),
        ),
        { contentType: 'application/json' },
      );
    }
    if (/^\/pixiv\/img\/p(\d)\.(jpg|png)$/.test(p)) {
      const m = /^\/pixiv\/img\/p(\d)\.(jpg|png)$/.exec(p);
      const body = Buffer.alloc(2048, Number(m[1]) + 1);
      body.write(`pixiv-image-${m[1]}`, 0, 'utf8');
      return sendBuffer(req, res, body, { contentType: m[2] === 'png' ? 'image/png' : 'image/jpeg' });
    }
    // ── Pixiv「免代理」通道的模拟：检索接口 + 反代逐页取图 ──
    // /lolicon/setu/v2?tag=X&num=N&r18=0|2 → 返回 3 个作品（其中一个是 R18，用于验证本地分级过滤）
    if (p === '/lolicon/setu/v2') {
      const url = new URL(req.url, `http://127.0.0.1:${req.socket.localPort}`);
      const kw = url.searchParams.get('tag') || url.searchParams.get('keyword') || '';
      const num = Number(url.searchParams.get('num') || 3);
      const r18 = url.searchParams.get('r18');
      const base = `http://127.0.0.1:${req.socket.localPort}/mirror`;
      const all = [
        { pid: 111111, title: `测试图-${kw}`, author: '作者A', uid: 1, r18: false, tags: [kw, 'テスト'], urls: { original: `${base}/111111.png` } },
        { pid: 222222, title: '第二张', author: '作者B', uid: 2, r18: false, tags: ['测试'], urls: { original: `${base}/222222.png` } },
        { pid: 333333, title: '成人向', author: '作者C', uid: 3, r18: true, tags: ['R-18'], urls: { original: `${base}/333333.png` } },
      ];
      const data = (r18 === '0' ? all.filter((x) => !x.r18) : all).slice(0, Math.max(1, num));
      // 关键词含「补足」时，候选里塞一个**反代上没有**的作品（999999 不在下面的 pages 表里 → 404），
      // 用来验证"候选里有已删除作品时自动往后取、凑够要求的数量"。
      const withDead = kw.includes('补足')
        ? [{ pid: 999999, title: '已被作者删除', author: '作者D', uid: 4, r18: false, tags: [kw], urls: { original: `${base}/999999.png` } }, ...data]
        : data;
      // 标签搜不到时返回空，好让 searchPixiv 有机会退化到 keyword 模式
      const body = kw.includes('找不到') ? { error: '', data: [] } : { error: '', data: withDead };
      return sendBuffer(req, res, Buffer.from(JSON.stringify(body)), { contentType: 'application/json' });
    }
    // 反代：111111 有 3 页、222222 有 1 页、333333 有 1 页；超出页数一律 404（模拟 pixiv.re 的行为）
    if (/^\/mirror\/(\d{5,12})(?:-(\d+))?\.png$/.test(p)) {
      const m = /^\/mirror\/(\d{5,12})(?:-(\d+))?\.png$/.exec(p);
      const pid = m[1];
      const page = m[2] ? Number(m[2]) : 1;
      const pages = { 111111: 3, 222222: 1, 333333: 1 }[pid] || 0;
      if (page > pages) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        return res.end('<h1>404</h1>');
      }
      const body = Buffer.alloc(4096, page);
      body.write(`${pid}-p${page}`, 0, 'utf8');
      return sendBuffer(req, res, body, { contentType: 'image/png' });
    }
    // 图文帖用：大图 / 小图（表情级） / 不是图片
    if (p === '/img/big.png') {
      return sendBuffer(req, res, Buffer.alloc(40 * 1024, 7), { contentType: 'image/png' });
    }
    if (p === '/img/tiny.webp') {
      return sendBuffer(req, res, Buffer.alloc(4 * 1024, 3), { contentType: 'image/webp' });
    }
    if (p === '/img/big.txt') {
      return sendBuffer(req, res, Buffer.alloc(40 * 1024, 9), { contentType: 'text/plain' });
    }
    if (p === '/norange.mp4') {      return sendBuffer(req, res, DIRECT_PAYLOAD.slice(0, 512 * 1024), {
        contentType: 'video/mp4',
        acceptRanges: false,
        ignoreRange: true,
      });
    }
    if (p === '/page.html') {
      const html = `<!doctype html><html><head>
        <meta property="og:title" content="测试页面标题">
        <meta property="og:video" content="/direct.mp4">
        </head><body><h1>demo</h1>
        <video controls><source src="/direct.mp4" type="video/mp4"></video>
        </body></html>`;
      return sendBuffer(req, res, Buffer.from(html), { contentType: 'text/html; charset=utf-8' });
    }
    if (p === '/v/master.m3u8') {
      const text = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2"
480.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720.m3u8
`;
      return sendBuffer(req, res, Buffer.from(text), { contentType: 'application/vnd.apple.mpegurl' });
    }
    if (p === '/v/480.m3u8' || p === '/v/720.m3u8' || p === '/v/iv.m3u8') {
      const useIv = p === '/v/iv.m3u8';
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0'];
      lines.push(useIv ? '#EXT-X-KEY:METHOD=AES-128,URI="key2.bin",IV=0x000102030405060708090a0b0c0d0e0f' : '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"');
      for (let i = 0; i < SEGMENT_COUNT; i += 1) {
        lines.push('#EXTINF:4.000,');
        lines.push(useIv ? `ivseg${i}.ts` : `seg${i}.ts`);
      }
      lines.push('#EXT-X-ENDLIST', '');
      return sendBuffer(req, res, Buffer.from(lines.join('\n')), { contentType: 'application/vnd.apple.mpegurl' });
    }
    if (p === '/v/key.bin') return sendBuffer(req, res, KEY, { contentType: 'application/octet-stream' });
    if (p === '/v/key2.bin') return sendBuffer(req, res, KEY2, { contentType: 'application/octet-stream' });
    if (/^\/v\/seg(\d+)\.ts$/.test(p)) {
      const i = Number(/^\/v\/seg(\d+)\.ts$/.exec(p)[1]);
      return sendBuffer(req, res, encryptedSegments[i], { contentType: 'video/mp2t' });
    }
    if (/^\/v\/ivseg(\d+)\.ts$/.test(p)) {
      const i = Number(/^\/v\/ivseg(\d+)\.ts$/.exec(p)[1]);
      return sendBuffer(req, res, encryptedSegmentsIvAttr[i], { contentType: 'video/mp2t' });
    }
    if (p === '/f/master.m3u8') {
      const text = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="init.mp4"
${FMP4_SEGMENTS.map((_, i) => `#EXTINF:4.000,\nfseg${i}.m4s`).join('\n')}
#EXT-X-ENDLIST
`;
      return sendBuffer(req, res, Buffer.from(text), { contentType: 'application/vnd.apple.mpegurl' });
    }
    if (p === '/f/init.mp4') return sendBuffer(req, res, INIT_SEGMENT, { contentType: 'video/mp4' });
    if (/^\/f\/fseg(\d+)\.m4s$/.test(p)) {
      const i = Number(/^\/f\/fseg(\d+)\.m4s$/.exec(p)[1]);
      return sendBuffer(req, res, FMP4_SEGMENTS[i], { contentType: 'video/mp4' });
    }
    if (p === '/live/master.m3u8') {
      const text = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="/v/key.bin"
#EXTINF:4.000,
/v/seg0.ts
`;
      return sendBuffer(req, res, Buffer.from(text), { contentType: 'application/vnd.apple.mpegurl' });
    }
    if (p === '/live2/playlist.m3u8') {
      livePolls += 1;
      const count = Math.min(livePolls, LIVE_SEGMENTS.length);
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0'];
      for (let i = 0; i < count; i += 1) {
        lines.push('#EXTINF:4.000,');
        lines.push(`seg${i}.ts`);
      }
      if (livePolls > LIVE_SEGMENTS.length) lines.push('#EXT-X-ENDLIST');
      return sendBuffer(req, res, Buffer.from(`${lines.join('\n')}\n`), { contentType: 'application/vnd.apple.mpegurl' });
    }
    if (/^\/live2\/seg(\d+)\.ts$/.test(p)) {
      const i = Number(/^\/live2\/seg(\d+)\.ts$/.exec(p)[1]);
      return sendBuffer(req, res, LIVE_SEGMENTS[i], { contentType: 'video/mp2t' });
    }
    if (p === '/live3/playlist.m3u8') {
      // 永不结束：每次请求多发布一个分片，且始终没有 EXT-X-ENDLIST
      live3Polls += 1;
      const count = Math.min(live3Polls, LIVE3_SEGMENTS.length);
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:0'];
      for (let i = 0; i < count; i += 1) {
        lines.push('#EXTINF:1.000,');
        lines.push(`seg${i}.ts`);
      }
      return sendBuffer(req, res, Buffer.from(`${lines.join('\n')}\n`), { contentType: 'application/vnd.apple.mpegurl' });
    }
    if (/^\/live3\/seg(\d+)\.ts$/.test(p)) {
      const i = Number(/^\/live3\/seg(\d+)\.ts$/.exec(p)[1]);
      return sendBuffer(req, res, LIVE3_SEGMENTS[i], { contentType: 'video/mp2t' });
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.base = `http://127.0.0.1:${port}`;
      server.closeAsync = () => new Promise((r) => server.close(r));
      resolve(server);
    });
  });
}

// ---------------------------------------------------------------- 用例

const tests = [
  test('工具函数：文件名清洗 / 体积格式化 / Content-Disposition 解析', () => {
    assertEqual(util.sanitizeFilename('a/b:c*d?.mp4'), 'a_b_c_d_.mp4', '非法字符应被替换');
    assertEqual(util.sanitizeFilename('   '), 'video', '空名应回退');
    assertEqual(util.formatBytes(0), '0 B');
    assertEqual(util.formatBytes(1536), '1.5 KB');
    assertEqual(util.formatDuration(3725), '1:02:05');
    assertEqual(util.filenameFromDisposition('attachment; filename="片子.mp4"'), '片子.mp4');
    assertEqual(
      util.filenameFromDisposition("attachment; filename*=UTF-8''%E8%A7%86%E9%A2%91.mp4"),
      '视频.mp4',
    );
    assertEqual(util.extFromMime('video/mp4'), '.mp4');
    assertEqual(util.extFromUrl('https://x.com/a/b.MP4?token=1'), '.mp4');
  }),

  test('工具函数：cookies.txt 解析与域名匹配', () => {
    const text = ['# Netscape HTTP Cookie File', '.example.com\tTRUE\t/\tFALSE\t0\tsid\tabc123', 'other.com\tTRUE\t/\tFALSE\t0\tx\t1'].join('\n');
    const cookies = util.parseNetscapeCookies(text);
    assertEqual(cookies.length, 2, '应解析出两条 cookie');
    assertEqual(util.cookieHeaderFor('https://www.example.com/v.mp4', cookies), 'sid=abc123');
    assertEqual(util.cookieHeaderFor('https://nope.com/v.mp4', cookies), '');
  }),

  test('探测：直链 / m3u8 / 网页 三类链接识别', async ({ server }) => {
    const direct = await probe(`${server.base}/direct.mp4`);
    assertEqual(direct.type, 'direct', '直链类型');
    assertEqual(direct.contentType, 'video/mp4', '内容类型');
    assert(direct.contentLength === DIRECT_PAYLOAD.length, `应识别出文件大小，实际 ${direct.contentLength}`);
    assert(direct.filename.includes('示例视频'), `应使用 Content-Disposition 里的文件名，实际 ${direct.filename}`);

    const hls = await probe(`${server.base}/v/master.m3u8`);
    assertEqual(hls.type, 'hls', 'm3u8 类型');

    const page = await probe(`${server.base}/page.html`);
    assertEqual(page.type, 'page', '网页类型');
    assertEqual(page.title, '测试页面标题', '应取 og:title');
    assert(
      page.candidates.some((c) => c.url.endsWith('/direct.mp4')),
      '网页里应提取出内嵌视频地址',
    );
  }),

  test('直链下载：内容与原始字节一致', async ({ server, dir }) => {
    const outPath = path.join(dir, 'direct.mp4');
    const res = await downloadDirect({ url: `${server.base}/direct.mp4`, outPath });
    assertBufferEqual(fs.readFileSync(res.filePath), DIRECT_PAYLOAD, '下载内容');
    assert(!fs.existsSync(`${outPath}.part`), '.part 应被清理');
  }),

  test('直链下载：断点续传（服务端支持 Range）', async ({ server, dir }) => {
    const outPath = path.join(dir, 'resume.mp4');
    const head = DIRECT_PAYLOAD.slice(0, 500000);
    fs.writeFileSync(`${outPath}.part`, head);
    seenRangeRequests.length = 0;
    const res = await downloadDirect({ url: `${server.base}/direct.mp4`, outPath, resume: true });
    assert(seenRangeRequests.some((r) => r.path === '/direct.mp4' && r.range === `bytes=${head.length}-`), '应发出续传 Range 请求');
    assertBufferEqual(fs.readFileSync(res.filePath), DIRECT_PAYLOAD, '续传后内容');
    assert(res.resumed === true, 'resumed 标记应为 true');
  }),

  test('直链下载：服务端忽略 Range 时自动重下', async ({ server, dir }) => {
    const outPath = path.join(dir, 'norange.mp4');
    fs.writeFileSync(`${outPath}.part`, Buffer.from('garbage'));
    const res = await downloadDirect({ url: `${server.base}/norange.mp4`, outPath, resume: true });
    const expected = DIRECT_PAYLOAD.slice(0, 512 * 1024);
    assertBufferEqual(fs.readFileSync(res.filePath), expected, '应从头重下并得到完整内容');
  }),

  test('HLS 解析：主列表与码率选择', async ({ server }) => {
    const res = await fetch(`${server.base}/v/master.m3u8`);
    const text = await res.text();
    const pl = parseM3U8(text, `${server.base}/v/master.m3u8`);
    assert(pl.isMaster, '应识别为主播放列表');
    assertEqual(pl.variants.length, 2, '码率分支数量');
    assertEqual(selectVariant(pl, 'best').resolution.height, 720, 'best 应选 720p');
    assertEqual(selectVariant(pl, '480').resolution.height, 480, '480 档应选 480p');
    assertEqual(selectVariant(pl, 'worst').resolution.height, 480, 'worst 应选最低码率');
    assertEqual(selectVariant(pl, '2160').resolution.height, 720, '超出范围时应回退最高可用');
  }),

  test('HLS 下载：AES-128 解密 + 分片顺序正确', async ({ server, dir }) => {
    const outPath = path.join(dir, 'enc.ts');
    const res = await downloadHls({ url: `${server.base}/v/720.m3u8`, outPath, concurrency: 4, remux: false });
    const expected = Buffer.concat(PLAIN_SEGMENTS);
    assertBufferEqual(fs.readFileSync(res.filePath), expected, '解密后的分片拼接内容');
    assertEqual(res.segments, SEGMENT_COUNT, '分片数量');
  }),

  test('HLS 下载：显式 IV 解密', async ({ server, dir }) => {
    const outPath = path.join(dir, 'iv.ts');
    const res = await downloadHls({ url: `${server.base}/v/iv.m3u8`, outPath, concurrency: 3, remux: false });
    assertBufferEqual(fs.readFileSync(res.filePath), Buffer.concat(PLAIN_SEGMENTS), '显式 IV 解密结果');
  }),

  test('HLS 下载：主列表选流 + 限制分片数', async ({ server, dir }) => {
    const outPath = path.join(dir, 'limited.ts');
    const res = await downloadHls({
      url: `${server.base}/v/master.m3u8`,
      outPath,
      quality: '480',
      concurrency: 2,
      remux: false,
      limitSegments: 2,
    });
    assertBufferEqual(fs.readFileSync(res.filePath), Buffer.concat(PLAIN_SEGMENTS.slice(0, 2)), '仅应下载前 2 个分片');
    assertEqual(res.segments, 2, '分片计数');
  }),

  test('HLS 下载：fMP4（EXT-X-MAP）输出含 init 段', async ({ server, dir }) => {
    const outPath = path.join(dir, 'fmp4.mp4');
    const res = await downloadHls({ url: `${server.base}/f/master.m3u8`, outPath, remux: false });
    assertBufferEqual(
      fs.readFileSync(res.filePath),
      Buffer.concat([INIT_SEGMENT, ...FMP4_SEGMENTS]),
      'init + 分片内容',
    );
    assertEqual(path.extname(res.filePath), '.mp4', 'fMP4 应输出 .mp4');
  }),

  test('编排层：直链 / 网页 / HLS 三种链接端到端下载', async ({ server, dir }) => {
    const dl = new VideoDownloader({ outDir: dir, autoDownloadYtDlp: false, engine: 'builtin' });
    const logs = [];
    dl.on('log', (p) => logs.push(p.message));
    dl.on('error', () => {});

    const r1 = await dl.download(`${server.base}/direct.mp4`);
    assert(r1.ok, `直链任务失败：${r1.error}`);
    assertEqual(r1.engine, 'direct', '应使用直链引擎');
    assertBufferEqual(fs.readFileSync(r1.filePath), DIRECT_PAYLOAD, '直链内容');

    const r2 = await dl.download(`${server.base}/page.html`);
    assert(r2.ok, `网页任务失败：${r2.error}`);
    assertBufferEqual(fs.readFileSync(r2.filePath), DIRECT_PAYLOAD, '网页内嵌视频内容');

    const r3 = await dl.download(`${server.base}/v/720.m3u8`, { concurrency: 3, autoDownloadYtDlp: false });
    assert(r3.ok, `HLS 任务失败：${r3.error}`);
    assertEqual(r3.engine, 'hls', '应使用 HLS 引擎');
    assertBufferEqual(fs.readFileSync(r3.filePath), Buffer.concat(PLAIN_SEGMENTS), 'HLS 内容');
    assert(logs.length > 0, '应产生日志');
  }),

  test('编排层：任务可取消（直播流/长任务）', async ({ server, dir }) => {
    const dl = new VideoDownloader({ outDir: dir, autoDownloadYtDlp: false, concurrency: 1 });
    dl.on('error', () => {});
    const controller = new AbortController();
    const promise = dl.download(`${server.base}/direct.mp4`, { signal: controller.signal, taskId: 'cancel-1' });
    setTimeout(() => controller.abort(), 5);
    const res = await promise;
    assert(res.ok === false, '取消后不应成功');
    assert(res.cancelled === true, '应标记为 cancelled');
  }),

  test('yt-dlp 选流表达式与报错翻译', () => {
    // 没有 ffmpeg 时只能选“已合体”的格式，避免 Requested format is not available
    assertEqual(buildFormatSelector('best', { hasFfmpeg: false }), 'b[ext=mp4]/b');
    assertEqual(buildFormatSelector('best', { hasFfmpeg: true }), 'bv*+ba/b');
    assertEqual(buildFormatSelector('720', { hasFfmpeg: true }), 'bv*[height<=720]+ba/b[height<=720]/bv*+ba/b');
    assertEqual(buildFormatSelector('720', { hasFfmpeg: false }), 'b[height<=720][ext=mp4]/b[height<=720]/b[ext=mp4]/b');
    assertEqual(buildFormatSelector('audio', { hasFfmpeg: true }), 'bestaudio/best');

    // 编码偏好：默认兼容优先（H.264 + AAC），也可让 yt-dlp 自行决定
    assertEqual(buildFormatSort('h264'), 'res,fps,hdr:12,vcodec:h264,acodec:aac,br');
    assert(buildFormatSort('hevc').includes('vcodec:h265'), 'HEVC 应映射到 h265');
    assert(buildFormatSort('av1').includes('vcodec:av01'), 'AV1 应映射到 av01');
    assertEqual(buildFormatSort('best'), '', 'best 表示不干预排序');

    assert(needsFfmpeg('ERROR: [BiliBili] BV1x: Requested format is not available'), '该错误应触发自动获取 ffmpeg');
    assert(!needsFfmpeg('ERROR: Video unavailable'), '无关错误不应触发');
    const translated = translateYtDlpError('ERROR: [BiliBili] BV1x: Requested format is not available');
    assert(translated.includes('→'), '应附带中文建议');
    assert(translateYtDlpError('Sign in to confirm your age').includes('Cookie'), '登录类错误应提示 Cookie');
  }),

  test('浏览器兜底：从页面数据里挑出正片地址', () => {
    const media = [
      { url: 'https://p3-pc.douyinpic.com/aweme/100x100/aweme-avatar/x.jpeg?from=1', gear: '', bytes: 0 },
      { url: 'https://lf-impc.douyinstatic.com/obj/tos-aweme-im-pc/x/win32-x64/DouyinChat-x64-douyin', gear: '', bytes: 0 },
      { url: 'https://v11-weba.douyinvod.com/abc/video/tos/cn/xyz?mime_type=video_mp4&a=1', gear: '网络请求', bytes: 0 },
      { url: 'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=1', gear: '', bytes: 0 },
    ];
    const best = selectBestMedia(media);
    assert(best && best.url.includes('douyinvod'), `应挑出 CDN 视频地址，实际 ${best && best.url}`);
    assertEqual(selectBestMedia([]), null, '没有候选时应返回 null');
    assertEqual(selectBestMedia([{ url: 'https://p3-pc.douyinpic.com/a/avatar.jpeg' }]), null, '头像不应被选中');

    // 页面结构化数据（url_list / bit_rate）应被解析出来
    const data = extractMediaFromPageData({
      router: JSON.stringify({
        loaderData: {
          'video_(id)/page': {
            videoInfoRes: {
              item_list: [
                { video: { play_addr: { url_list: ['https://v3-weba.douyinvod.com/a/video/tos/cn/low?mime_type=video_mp4'] }, bit_rate: [{ gear_name: '1080p', play_addr: { url_list: ['https://v26-weba.douyinvod.com/b/video/tos/cn/hd?mime_type=video_mp4'] } }] } },
              ],
            },
          },
        },
      }),
      videoSrcs: [],
      domUrls: [],
    });
    assertEqual(data.length, 2, '应解析出 2 个地址');
    assert(selectBestMedia(data).url.includes('hd'), '应优先选择高清晰度地址');
  }),

  test('登录：Cookie 导出格式与站点解析', ({ dir }) => {
    const file = path.join(dir, 'login-cookies.txt');
    const count = writeNetscapeCookies(
      [
        { domain: '.bilibili.com', name: 'SESSDATA', value: 'abc%2Cdef', path: '/', secure: true, expirationDate: 1893456000 },
        { domain: '.douyin.com', name: 'ttwid', value: 'xyz', path: '/', secure: false, expirationDate: 0 },
        { name: 'noDomain', value: 'x' },
      ],
      file,
    );
    assertEqual(count, 2, '没有域名的 Cookie 应被跳过');
    const text = fs.readFileSync(file, 'utf8');
    assert(text.startsWith('# Netscape HTTP Cookie File'), '应是 Netscape 格式');
    assert(text.includes('.bilibili.com\tTRUE\t/\tTRUE\t1893456000\tSESSDATA\tabc%2Cdef'), `导出内容不对：${text}`);
    assert(text.includes('.douyin.com\tTRUE\t/\tFALSE\t0\tttwid\txyz'), '非 https Cookie 应标 FALSE');

    assertEqual(resolveLoginTarget('bilibili').url, LOGIN_SITES.bilibili.url, '内置站点名应解析成对应网址');
    assertEqual(resolveLoginTarget('douyin').name, LOGIN_SITES.douyin.name, '站点名称');
    assertEqual(resolveLoginTarget('youtube').url, LOGIN_SITES.youtube.url, 'YouTube 站点名应可用');
    assertEqual(resolveLoginTarget('zhihu').url, LOGIN_SITES.zhihu.url, '新增站点（知乎）应可用');
    assert(Object.keys(LOGIN_SITES).length >= 12, `内置站点应足够多，实际 ${Object.keys(LOGIN_SITES).length} 个`);
    assertEqual(resolveLoginTarget('https://example.com/x').url, 'https://example.com/x', '完整网址应原样使用');
    assertEqual(
      resolveLoginTarget('https://www.my-site.com/login?next=1').url,
      'https://www.my-site.com/login?next=1',
      '带路径/参数的网址应原样使用',
    );
    assertEqual(resolveLoginTarget('example.com').url, 'https://example.com', '裸域名应补上协议');
    assertEqual(resolveLoginTarget('example.com/path').url, 'https://example.com/path', '域名+路径也应可用');
    assertEqual(resolveLoginTarget('').url, LOGIN_SITES.bilibili.url, '留空时默认 B 站');
  }),

  test('登录：状态文件路径与自动启用', ({ dir }) => {
    const prev = process.env.VIDEOGRAB_TOOLS_DIR;
    const tools = path.join(dir, 'tools-login');
    fs.mkdirSync(tools, { recursive: true });
    process.env.VIDEOGRAB_TOOLS_DIR = tools;
    try {
      assertEqual(loginCookiesFile(), path.join(tools, 'login-cookies.txt'), '登录 Cookie 应放在工具目录');
      assertEqual(hasLoginCookies(), false, '还没有登录状态时应为 false');
      writeNetscapeCookies([{ domain: '.bilibili.com', name: 'SESSDATA', value: '1', path: '/', secure: true }], loginCookiesFile());
      assertEqual(hasLoginCookies(), true, '导出后应识别为已登录');
    } finally {
      if (prev === undefined) delete process.env.VIDEOGRAB_TOOLS_DIR;
      else process.env.VIDEOGRAB_TOOLS_DIR = prev;
    }
  }),

  test('内置浏览器守卫：拦截 bytedance:// 等深链、放行 https', () => {
    const { guardWebContents, isSafeUrl } = require('../src/core/browser-guard');
    const blocked = [];
    const handlers = {};
    guardWebContents(
      { setWindowOpenHandler: (h) => { handlers.open = h; }, on: (n, fn) => { handlers[n] = fn; } },
      { onBlock: (m) => blocked.push(m) },
    );

    assert(typeof handlers.open === 'function', '应注册新窗口处理器');
    assertEqual(handlers.open({ url: 'bytedance://router?x=1' }).action, 'deny', '自定义协议的新窗口请求应拒绝');
    assertEqual(handlers.open({ url: 'https://www.douyin.com/' }).action, 'deny', '抓流窗口连 https 弹窗也应拒绝');

    let prevented = false;
    const prevent = () => {
      prevented = true;
    };
    handlers['will-navigate']({ preventDefault: prevent }, 'bytedance://router?x=1');
    assert(prevented, 'bytedance:// 顶层跳转应被拦下（否则系统会弹「选择打开方式」）');

    prevented = false;
    handlers['will-navigate']({ preventDefault: prevent }, 'https://live.douyin.com/123');
    assert(!prevented, 'https 跳转不应被拦');

    prevented = false;
    handlers['will-frame-navigate']({ preventDefault: prevent, url: 'snssdk1128://webview?x=1' });
    assert(prevented, 'iframe 里的自定义协议跳转也应被拦下');

    prevented = false;
    handlers['will-redirect']({ preventDefault: prevent }, 'douyin://open?x=1');
    assert(prevented, '自定义协议的重定向也应被拦下');
    assert(blocked.length >= 2, `应记录拦截日志，实际 ${blocked.length} 条`);

    // 登录窗口：允许 https 弹窗（部分站点用弹窗走 OAuth），仍拒绝自定义协议
    const loginHandlers = {};
    guardWebContents({ setWindowOpenHandler: (h) => { loginHandlers.open = h; }, on: () => {} }, { allowHttpPopups: true });
    assertEqual(loginHandlers.open({ url: 'https://passport.bilibili.com/' }).action, 'allow', '登录窗口应允许 https 弹窗');
    assertEqual(loginHandlers.open({ url: 'douyin://x' }).action, 'deny', '登录窗口仍拒绝自定义协议');

    assert(isSafeUrl('https://a.com/v'), 'https 属于安全协议');
    assert(!isSafeUrl('bytedance://x'), 'bytedance:// 不属于安全协议');
  }),

  test('下载历史：追加 / 条数限制 / 删除 / 清空', async ({ dir }) => {
    const prev = process.env.VIDEOGRAB_HISTORY_FILE;
    const file = path.join(dir, 'history.json');
    process.env.VIDEOGRAB_HISTORY_FILE = file;
    try {
      const {
        appendHistory,
        loadHistory,
        setHistoryLimit,
        removeHistory,
        clearHistory,
        currentLimit,
        historyFile: hf,
        normalizeLimit,
      } = require('../src/core/history');

      assertEqual(hf(), file, '应使用环境变量指定的历史文件');
      assertEqual(loadHistory().length, 0, '初始应为空');

      // 默认保留 20 条：写 25 条，只应留下最新 20 条，且最新的在最前
      for (let i = 1; i <= 25; i += 1) {
        await appendHistory({ id: `r${i}`, url: `https://e.com/${i}.mp4`, fileName: `${i}.mp4`, ok: true, bytes: i, at: 1000 + i });
      }
      const all = loadHistory();
      assertEqual(all.length, 20, `默认应保留 20 条，实际 ${all.length}`);
      assertEqual(all[0].fileName, '25.mp4', '最新的记录应排在最前');
      assertEqual(all[19].fileName, '6.mp4', '最旧的 5 条应被裁掉');

      // 指定条数只影响返回条数，不影响已存内容
      assertEqual(loadHistory(3).length, 3, 'loadHistory(n) 应只取前 n 条');

      // 修改保留条数 → 立即裁剪已有记录
      const res = await setHistoryLimit(5);
      assertEqual(res.limit, 5, '条数设置应生效');
      assertEqual(loadHistory().length, 5, '应立刻裁剪到 5 条');
      assertEqual(currentLimit(), 5, '设置应写入文件');

      // 之后再追加时不传 limit，应沿用文件里的设置（CLI 场景）
      await appendHistory({ id: 'r100', url: 'https://e.com/100.mp4', fileName: '100.mp4', ok: true, at: Date.now() });
      const afterAppend = loadHistory();
      assertEqual(afterAppend.length, 5, '沿用设置后仍应保持 5 条');
      assertEqual(afterAppend[0].fileName, '100.mp4', '新记录在最前');

      // 删除单条
      await removeHistory('r100');
      assert(!loadHistory().some((r) => r.id === 'r100'), '删除后不应再出现该记录');
      assertEqual(loadHistory().length, 4, '删除后剩 4 条');

      // 失败记录也应保存，且字段被裁剪
      await appendHistory({ id: 'bad', url: `https://e.com/${'x'.repeat(1000)}`, ok: false, error: '失败原因', at: Date.now() });
      const failed = loadHistory()[0];
      assertEqual(failed.ok, false, '失败记录应标记 ok=false');
      assertEqual(failed.error, '失败原因', '应保留错误信息');
      assert(failed.url.length <= 801, `超长 URL 应被截断，实际 ${failed.url.length}`);
      assert(!('someUnknownField' in failed), '未声明的字段不应写入历史');

      // 清空
      await clearHistory();
      assertEqual(loadHistory().length, 0, '清空后应为空');
      assertEqual(currentLimit(), 5, '清空不应改变条数设置');

      // 条数规范化
      assertEqual(normalizeLimit(0), 20, '非法条数应回退默认 20');
      assertEqual(normalizeLimit(999999), 2000, '条数应有上限');
      assertEqual(normalizeLimit(7.6), 8, '条数应取整');
    } finally {
      if (prev === undefined) delete process.env.VIDEOGRAB_HISTORY_FILE;
      else process.env.VIDEOGRAB_HISTORY_FILE = prev;
    }
  }),

  test('网络错误提示与站点分流', () => {
    const { describeNetworkError } = require('../src/core/http');
    const { isYtDlpPlatform } = require('../src/core/probe');

    // fetch 的失败原因藏在 cause 里，要翻译成人话
    const reset = describeNetworkError(
      Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }),
      'https://www.youtube.com/watch?v=x',
    );
    assert(/连接被重置/.test(reset), `应识别 ECONNRESET，实际：${reset}`);
    assert(/代理/.test(reset), '应提示配代理');

    const dns = describeNetworkError(
      Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }),
      'https://nope.invalid/',
    );
    assert(/域名解析失败/.test(dns), `应识别 ENOTFOUND，实际：${dns}`);

    const bare = describeNetworkError(new TypeError('fetch failed'), 'https://x.com/a');
    assert(/无法直连|代理/.test(bare), `裸 fetch failed 也要给出可操作建议，实际：${bare}`);

    assertEqual(describeNetworkError(new Error('已取消')), '已取消', '取消信息应原样保留');
    assertEqual(describeNetworkError(new Error('请求超时（100ms）')), '请求超时（100ms）', '超时信息应原样保留');

    // 站点分流：这些站点直接交给 yt-dlp（跳过预探测）
    assert(isYtDlpPlatform('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ'), 'YouTube 应走 yt-dlp');
    assert(isYtDlpPlatform('https://youtu.be/abc'), 'youtu.be 应走 yt-dlp');
    assert(isYtDlpPlatform('https://live.bilibili.com/123'), 'B 站应走 yt-dlp');
    assert(isYtDlpPlatform('https://www.douyin.com/video/123'), '抖音应走 yt-dlp');
    assert(isYtDlpPlatform('https://twitter.com/u/status/1'), 'Twitter 应走 yt-dlp');
    assert(!isYtDlpPlatform('https://example.com/video.mp4'), '普通直链不应被分流');
    assert(!isYtDlpPlatform('https://cdn.example.com/a.m3u8'), '普通 HLS 不应被分流');
    assert(!isYtDlpPlatform('not a url'), '非法地址应安全返回 false');
  }),

  test('从分享文案里提取链接（中文/表情/话题混杂）', () => {
    const { extractUrls, hasUrl, stripUrls } = require('../src/core/extract-urls');

    // 用户实际遇到的两种情况（抖音分享文案）
    const case1 =
      '3.02 07/15 :3pm GVl:/ i@c.an 假如熊大熊二闹掰了，树洞应该判给谁？ # 熊出没 # 熊大 # 熊二 # 光头强 # 财产分割  https://v.douyin.com/Q17Q43LSOR4/ 复制此链接，打开Dou音搜索，直接观看视频！';
    assertEqual(extractUrls(case1).length, 1, `应只挑出 1 个链接，实际 ${JSON.stringify(extractUrls(case1))}`);
    assertEqual(extractUrls(case1)[0], 'https://v.douyin.com/Q17Q43LSOR4/', '应完整保留链接（末尾不带中文）');

    const case2 =
      '3.89 复制打开抖音，看看【Sylvia狄影的图文作品】回应我的心意吧，mega进化。上哪找又看宝可梦又打... https://v.douyin.com/0W1z9VO1w1Q/ 05/30 HVl:/ :6pm g@O.XM';
    assertEqual(extractUrls(case2)[0], 'https://v.douyin.com/0W1z9VO1w1Q/', '第二段文案也应正确提取');

    // 一段文本里的多个链接：按出现顺序、去重
    const multi = '看看这个 https://v.douyin.com/AAA/ 和这个 https://b23.tv/BBB ，还有重复的 https://v.douyin.com/AAA/ 结束';
    assertEqual(extractUrls(multi).length, 2, '应提取 2 个链接并去重');
    assertEqual(extractUrls(multi)[0], 'https://v.douyin.com/AAA/', '顺序应按出现先后');
    assertEqual(extractUrls(multi)[1], 'https://b23.tv/BBB', '第二个链接');

    // 无协议的裸域名（分享时被吞掉协议的情况）
    assertEqual(extractUrls('复制打开抖音 v.douyin.com/Q17Q43LSOR4/ 看视频')[0], 'https://v.douyin.com/Q17Q43LSOR4/', '裸分享域名应补上协议');
    assertEqual(extractUrls('www.bilibili.com/video/BV1sbbD64EXf/')[0], 'https://www.bilibili.com/video/BV1sbbD64EXf/', '带路径的裸域名应识别');

    // 纯噪声不应被误判成链接
    assertEqual(extractUrls('3.02 07/15 :3pm GVl:/ i@c.an 05/30 HVl:/ g@O.XM # 熊出没').length, 0, '噪声不应产生链接');
    assertEqual(extractUrls('').length, 0, '空文本应返回空数组');
    assertEqual(extractUrls('就是一段普通中文，没有链接').length, 0, '没有链接时应返回空数组');

    // 链接与中文之间没有空格也要能截断
    assertEqual(extractUrls('看这个https://v.douyin.com/Q17Q43LSOR4/复制此链接')[0], 'https://v.douyin.com/Q17Q43LSOR4/', '紧贴中文时应正确截断');

    // 保留查询参数
    const withQuery = extractUrls('https://www.bilibili.com/video/BV1x?p=1&t=2#reply')[0];
    assert(withQuery.includes('?p=1&t=2'), `应保留查询参数，实际 ${withQuery}`);

    assert(hasUrl(case1), 'hasUrl 应判断为真');
    assert(!hasUrl('没有链接'), 'hasUrl 应判断为假');
    assert(stripUrls(case1).includes('熊出没'), 'stripUrls 应保留中文文字');
    assert(!stripUrls(case1).includes('https://'), 'stripUrls 应去掉链接');
  }),

  test('产出文件探测：yt-dlp 报错但文件已下好时应算成功', ({ dir }) => {
    const { findRecentMediaFile } = require('../src/core/ytdlp');
    const box = path.join(dir, 'produced');
    fs.mkdirSync(box, { recursive: true });

    const old = path.join(box, 'old.mp4');
    fs.writeFileSync(old, Buffer.from('old'));
    const past = Date.now() - 3600 * 1000;
    fs.utimesSync(old, new Date(past), new Date(past));

    const fresh = path.join(box, 'fresh.mp4');
    fs.writeFileSync(fresh, Buffer.from('fresh'));
    fs.writeFileSync(path.join(box, 'partial.mp4.part'), Buffer.from('part'));
    fs.writeFileSync(path.join(box, 'note.txt'), Buffer.from('txt'));

    const since = Date.now() - 60000;
    const found = findRecentMediaFile(box, since);
    assertEqual(found, fresh, `应找到刚产出的媒体文件，实际 ${found}`);
    assert(!String(found).endsWith('.part'), '临时文件不应被当成成品');
    assertEqual(findRecentMediaFile(box, Date.now() + 5000), '', '没有新文件时应返回空字符串');
    assertEqual(findRecentMediaFile(path.join(box, 'not-exist'), since), '', '目录不存在时应安全返回空');
  }),

  test('图片帖：识别 Pixiv / 抖音图文链接并挑出正文图片', () => {
    const { detectImagePost, pickPostImages, parsePixivPages, parsePixivInfo } = require('../src/core/images');

    // 识别
    assertEqual(detectImagePost('https://www.pixiv.net/artworks/123456').kind, 'pixiv', 'Pixiv 作品页应识别');
    assertEqual(detectImagePost('https://www.pixiv.net/artworks/123456').id, '123456', '应取出作品 id');
    assertEqual(detectImagePost('https://www.pixiv.net/en/artworks/987654').id, '987654', '带语言前缀也应识别');
    assertEqual(detectImagePost('https://www.pixiv.net/i/555').id, '555', '旧版 /i/ 链接也应识别');
    assertEqual(detectImagePost('https://www.douyin.com/note/7693365550072862451').kind, 'douyin-note', '抖音图文应识别');
    assertEqual(
      detectImagePost('https://www.iesdouyin.com/share/note/7693365550072862451/?region=CN').url,
      'https://www.douyin.com/note/7693365550072862451',
      '手机分享页应识别并统一成 PC 版链接',
    );
    assertEqual(
      detectImagePost('https://www.douyin.com/note/7693365550072862451?modal_id=1').id,
      '7693365550072862451',
      '带查询参数的图文链接也应识别',
    );
    assertEqual(detectImagePost('https://v.douyin.com/4FXdawpmtVw/'), null, '分享短链本身不知道是不是图文');
    assertEqual(detectImagePost('https://www.douyin.com/video/123'), null, '抖音视频页不应按图文处理');
    assertEqual(detectImagePost('https://www.pixiv.net/users/123'), null, '画师主页不支持');
    assertEqual(detectImagePost('https://example.com/a.jpg'), null, '普通链接不识别');
    assertEqual(detectImagePost('不是链接'), null, '非法输入安全返回 null');

    // 正文图片筛选：丢掉头像/图标/小图，保留正文大图并去重
    const picked = pickPostImages([
      { url: 'https://p3-pc.douyinpic.com/aweme/100x100/aweme-avatar/abc.jpeg', width: 100, height: 100 },
      { url: 'https://p3-sign.douyinpic.com/tos-cn-i-xxx/photo1~tplv-dy.jpeg', width: 1080, height: 1440 },
      'https://p3-sign.douyinpic.com/tos-cn-i-xxx/photo1~tplv-dy.jpeg',
      { url: 'https://i.pximg.net/img-original/img/2024/01/01/00/00/00/123_p0.jpg', width: 1200, height: 1600 },
      { url: 'https://www.douyin.com/static/logo.svg' },
      'data:image/png;base64,AAAA',
      { url: 'https://example.com/page.html' },
    ]);
    assertEqual(picked.length, 2, `应挑出 2 张正文图片，实际 ${picked.length}`);
    assert(picked.some((x) => x.url.includes('photo1')), '应保留抖音正文图');
    assert(picked.some((x) => x.url.includes('pximg.net')), '应保留 Pixiv 原图');
    assert(picked[0].url.includes('pximg.net'), 'Pixiv 原图分数最高，应排在最前');

    // Pixiv 接口解析
    assertEqual(
      parsePixivPages({ body: [{ urls: { original: 'https://i.pximg.net/a.jpg' } }, { urls: { regular: 'https://i.pximg.net/b.jpg' } }] }).length,
      2,
      '应解析出两页图片（original 优先，退回 regular）',
    );
    const info = parsePixivInfo({ body: { illustTitle: '标题', userName: '画师', pageCount: 2, illustType: 2 } });
    assertEqual(info.title, '标题', '标题');
    assertEqual(info.author, '画师', '作者');
    assertEqual(info.illustType, 2, '动图标记');
  }),

  test('图片帖：变体去重与小图过滤', async ({ server }) => {
    const { baseImageKey, variantScore, pickPostImages, probeImageInfo, filterTinyImages } = require('../src/core/images');

    // 变体去重：抖音 `~tplv-xxx:宽:高.webp` 后缀属于同一张原图
    assertEqual(
      baseImageKey('https://p3-sign.douyinpic.com/tos-cn-i-0813/abc123~tplv-dy-aweme-images:1080:1440:q75.webp'),
      baseImageKey('https://p3-sign.douyinpic.com/tos-cn-i-0813/abc123~tplv-dy-aweme-images:720:960:q75.webp'),
      '同图不同尺寸应归一化成同一个键',
    );
    assertEqual(
      baseImageKey('https://p3-sign.douyinpic.com/tos-cn-i-0813/abc123~noop.jpeg'),
      baseImageKey('https://p3-sign.douyinpic.com/tos-cn-i-0813/abc123~tplv-obj.jpeg'),
      '~noop 与 ~tplv 后缀应视作同一张图',
    );
    assert(baseImageKey('https://a.com/1.jpg') !== baseImageKey('https://a.com/2.jpg'), '不同图片不应混为一谈');
    assertEqual(baseImageKey('不是网址'), '不是网址', '非法输入安全返回');

    // 变体评分：正文原图 > 处理后的小图
    assert(
      variantScore('https://p3-sign.douyinpic.com/tos-cn-i-0813/abc~tplv-dy-aweme-images:1080:1440.webp') >
        variantScore('https://p3-sign.douyinpic.com/tos-cn-i-0813/abc~tplv-dy-aweme-images:200:200.webp'),
      '同一变体链里尺寸大的应优先',
    );
    assert(
      variantScore('https://i.pximg.net/img-original/img/2024/01/01/00/00/00/123_p0.jpg') >
        variantScore('https://i.pximg.net/c/240x480/img-master/img/2024/01/01/00/00/00/123_p0_master1200.jpg'),
      'Pixiv 原图应优先于缩略图',
    );
    // 同一张图同时有 jpg / webp 时，优先 jpg（兼容性更好）
    assert(
      variantScore('https://p3-sign.douyinpic.com/tos-cn-i-0813/abc~tplv-dy-aweme-images-v2:3000:3000:q75.jpeg') >
        variantScore('https://p3-sign.douyinpic.com/tos-cn-i-0813/abc~tplv-dy-aweme-images-v2:3000:3000:q75.webp'),
      '同分辨率下应优先 jpg',
    );

    // 同图多变体时只留一张，且留下的是分高的那张
    const dedup = pickPostImages([
      { url: 'https://p3-sign.douyinpic.com/tos-cn-i-0813/abc~tplv-dy-aweme-images:200:200.webp', width: 200, height: 200 },
      { url: 'https://p3-sign.douyinpic.com/tos-cn-i-0813/abc~tplv-dy-aweme-images:1080:1440.webp', width: 1080, height: 1440 },
    ]);
    assertEqual(dedup.length, 1, `同一张图只应保留一张，实际 ${dedup.length}`);
    assert(dedup[0].url.includes('1080:1440'), '应保留分辨率更高的变体');
    assertEqual(pickPostImages(null).length, 0, '空输入安全返回空数组');

    // 头像 / 表情 / UI 静态资源要被丢掉
    assertEqual(
      pickPostImages([
        { url: 'https://p3-pc.douyinpic.com/aweme/100x100/aweme-avatar/abc.jpeg' },
        { url: 'https://p9-static.douyinpic.com/aweme-client-static-resource/emoji/x.png' },
        { url: 'https://p3-sign.douyinpic.com/tos-cn-i-0813/real.png', width: 1080, height: 1440 },
      ]).length,
      1,
      '头像与静态表情资源应被过滤',
    );

    // 探测图片信息（只取 1 字节，靠 Content-Range 拿总大小）
    const big = await probeImageInfo(`${server.base}/img/big.png`);
    assertEqual(big.ok, true, '大图应探测成功');
    assertEqual(big.contentType, 'image/png', '应拿到内容类型');
    assertEqual(big.size, 40 * 1024, `应拿到总大小，实际 ${big.size}`);
    const missing = await probeImageInfo(`${server.base}/img/not-exist.png`);
    assertEqual(missing.ok, false, '404 应算探测失败');

    // 小图过滤：表情级小图与非图片被丢掉
    const items = [
      { url: `${server.base}/img/big.png` },
      { url: `${server.base}/img/tiny.webp` },
      { url: `${server.base}/img/big.txt` },
    ];
    const kept = await filterTinyImages(items, { minImageBytes: 20 * 1024 });
    assertEqual(kept.length, 1, `只应留下 1 张正文图，实际 ${kept.length}`);
    assert(kept[0].url.endsWith('/img/big.png'), '留下的应是大图');

    // 全都很小时不能一张不剩：保留最大的一张兜底
    const keptFallback = await filterTinyImages([{ url: `${server.base}/img/tiny.webp` }], { minImageBytes: 20 * 1024 });
    assertEqual(keptFallback.length, 1, '全小图时应兜底保留一张');
  }),

  test('图片帖：按页面语义区域取正文图（跳过评论/推荐流）', () => {
    const { pickPostImages } = require('../src/core/images');
    const slide = (n) => ({
      url: `https://p3-sign.douyinpic.com/tos-cn-i-0813/s${n}~tplv-dy-aweme-images-v2:3000:3000:q75.jpeg?biz_tag=aweme_images`,
      scope: 'slide',
    });
    const cover = (name) => ({
      url: `https://p3-sign.douyinpic.com/tos-cn-i-0813/${name}~noop.jpeg?biz_tag=pcweb_cover`,
      scope: 'plain',
    });
    const comment = {
      url: 'https://p9-sign.douyinpic.com/tos-cn-i-p14lwwcsbr/abc~tplv-p14lwwcsbr-x2-q75-r:248:332:q75.image?biz_tag=aweme_comment',
      scope: 'comment-item>comment-list',
    };

    // 有轮播翻页结果时，只用轮播图：推荐流封面、评论区图片都不算
    const picked = pickPostImages([cover('otherNote'), comment, slide(1), slide(2)]);
    assertEqual(picked.length, 2, `只应保留 2 张轮播图，实际 ${picked.length}`);
    assert(picked[0].url.includes('s1'), '轮播图应保持翻页顺序（001 是第一张）');
    assert(picked[1].url.includes('s2'), '第二张是第二页');
    assert(!picked.some((x) => x.url.includes('pcweb_cover')), '推荐流封面不应混进来');

    // 评论区/私信区域直接丢掉，不管地址长什么样
    const withoutSlides = pickPostImages([comment, { url: comment.url, scope: 'conversation-item' }, cover('mine')]);
    assertEqual(withoutSlides.length, 1, `评论区图片应被丢掉，实际 ${withoutSlides.length}`);
    assert(withoutSlides[0].url.includes('mine'), '保留的是正文图');

    // 同一轮播图的不同尺寸变体只留一张
    const variants = pickPostImages([
      { url: 'https://p3-sign.douyinpic.com/tos-cn-i-0813/s1~tplv-dy-aweme-images-v2:3000:3000:q75.jpeg', scope: 'slide' },
      { url: 'https://p3-sign.douyinpic.com/tos-cn-i-0813/s1~tplv-dy-aweme-images-v2:1080:1440:q75.jpeg', scope: 'slide' },
    ]);
    assertEqual(variants.length, 1, '同一张图只留一个变体');
    assert(variants[0].url.includes('3000:3000'), '留分辨率更高的那个');
  }),

  test('图片帖：从页面结构化数据里取正文图片', () => {
    const { extractImagesFromRouter } = require('../src/core/images');
    // 抖音 _ROUTER_DATA 的典型结构：aweme_detail.images[].url_list
    const router = {
      loaderData: {
        'note_(id)/page': {
          videoInfoRes: {
            item_list: [
              {
                desc: '标题',
                images: [
                  {
                    width: 1080,
                    height: 1440,
                    url_list: ['https://p3-sign.douyinpic.com/tos-cn-i-0813/a~noop.jpeg', 'https://p3-sign.douyinpic.com/tos-cn-i-0813/a~tplv-dy-aweme-images:1080:1440.webp'],
                  },
                  { url_list: ['https://p3-sign.douyinpic.com/tos-cn-i-0813/b~noop.jpeg'] },
                ],
                author: { avatar_thumb: { url_list: ['https://p3-pc.douyinpic.com/aweme/100x100/aweme-avatar/me.jpeg'] } },
              },
            ],
          },
        },
      },
    };
    const found = extractImagesFromRouter(router);
    assertEqual(found.length, 3, `应取到 3 条图片地址，实际 ${found.length}`);
    assert(found[0].url.includes('a~noop'), '第一条应是第一张图');
    assertEqual(found[0].width, 1080, '应带上页面给的宽高');
    assert(!found.some((x) => x.url.includes('avatar')), '不应把作者头像当正文图');

    // 结构化数据同样要走一遍头像/小图过滤，且去重
    const { pickPostImages } = require('../src/core/images');
    const picked = pickPostImages([...found, { url: 'https://p3-pc.douyinpic.com/aweme/100x100/aweme-avatar/me.jpeg' }]);
    assertEqual(picked.length, 2, `两张正文图应各自保留一个变体，实际 ${picked.length}`);
    assert(picked.every((x) => !x.url.includes('avatar')), '头像应被过滤');

    assertEqual(extractImagesFromRouter(null).length, 0, '空输入安全返回空数组');
    assertEqual(extractImagesFromRouter({ a: 1 }).length, 0, '没有 images 字段时返回空数组');
  }),

  test('图片帖：Pixiv 全流程下载（本地模拟接口）', async ({ server, dir }) => {
    const { fetchPixivIllust, downloadImages } = require('../src/core/images');
    const outDir = path.join(dir, 'pixiv-out');
    fs.mkdirSync(outDir, { recursive: true });

    const illust = await fetchPixivIllust('999', { apiBase: `${server.base}/pixiv` });
    assertEqual(illust.title, '测试插画标题', '应取到标题');
    assertEqual(illust.author, '测试画师', '应取到作者');
    assertEqual(illust.urls.length, 3, `应取到 3 页原图，实际 ${illust.urls.length}`);

    const result = await downloadImages({
      items: illust.urls.map((url) => ({ url })),
      outDir,
      baseName: illust.title,
      referer: 'https://www.pixiv.net/',
    });
    assertEqual(result.files.length, 3, `应下载 3 张，实际 ${result.files.length}`);
    assertEqual(result.failed.length, 0, '不应有失败');
    assert(result.dir.endsWith('测试插画标题'), `多图应放进以标题命名的子目录，实际 ${result.dir}`);
    const names = result.files.map((f) => path.basename(f));
    assertEqual(names.join(','), '001.jpg,002.jpg,003.png', `应按序号命名并保留扩展名，实际 ${names.join(',')}`);
    const first = fs.readFileSync(result.files[0]);
    assertEqual(first.length, 2048, '第一张图片大小');
    assertEqual(first.slice(0, 13).toString(), 'pixiv-image-0', '第一张图片内容');
    assert(result.bytes >= 3 * 2048, '总字节数应等于各图片之和');
  }),

  test('代理：解析代理地址 + 经代理请求（请求头原样透传）', async ({ server }) => {
    const { parseProxyUrl, createProxyFetch } = require('../src/core/proxy-fetch');
    const { setFetchImpl } = require('../src/core/http');

    // 解析
    assertEqual(parseProxyUrl('http://127.0.0.1:7890').port, 7890, 'http 代理端口');
    assertEqual(parseProxyUrl('127.0.0.1:7890').host, '127.0.0.1', '省略协议时默认 http');
    assertEqual(parseProxyUrl('http://user:pass@127.0.0.1:7890').auth, 'user:pass', '带账号密码');
    assertEqual(parseProxyUrl('socks5://127.0.0.1:1080').socks, true, 'socks 应被识别出来');
    assertEqual(parseProxyUrl('随便写的'), null, '非法地址返回 null');
    assertEqual(parseProxyUrl(''), null, '空值返回 null');

    // 起一个会记录请求的本地代理，把目标指向测试服务器
    const seen = [];
    const proxyServer = http.createServer((req, res) => {
      seen.push({ url: req.url, headers: req.headers });
      // 普通 HTTP 代理：用绝对地址转发
      const target = new URL(req.url);
      const up = http.request(
        {
          host: target.hostname,
          port: target.port,
          path: target.pathname + target.search,
          method: req.method,
          headers: req.headers,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode, upRes.headers);
          upRes.pipe(res);
        },
      );
      up.on('error', () => res.writeHead(502).end('proxy error'));
      req.pipe(up);
    });
    await new Promise((r) => proxyServer.listen(0, '127.0.0.1', r));
    const proxyUrl = `http://127.0.0.1:${proxyServer.address().port}`;

    try {
      const proxyFetch = createProxyFetch(proxyUrl, { force: true });
      const res = await proxyFetch(`${server.base}/img/big.png`, {
        headers: {
          Referer: 'https://www.pixiv.net/',
          Cookie: 'a=b',
          'User-Agent': 'vgrab-proxy-test',
          Range: 'bytes=0-0',
        },
      });
      assertEqual(res.status, 206, `经代理应拿到 206（Range 生效），实际 ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      assertEqual(buf.length, 1, 'Range 只取 1 字节');

      assertEqual(seen.length >= 1, true, '代理应收到请求');
      const first = seen[0];
      assert(first.headers.referer === 'https://www.pixiv.net/', `Referer 必须原样透传（pixiv 图片没有它会被 403），实际 ${first.headers.referer}`);
      assertEqual(first.headers.cookie, 'a=b', 'Cookie 应原样透传');
      assertEqual(first.headers.range, 'bytes=0-0', 'Range 应原样透传');
      assertEqual(first.headers['user-agent'], 'vgrab-proxy-test', 'UA 应原样透传');
      assertEqual(first.headers.host, `127.0.0.1:${server.address().port}`, 'Host 应指向目标而不是代理');

      // 内置 HTTP 层接上代理后，普通 request 也要走代理
      const { request, setHttpProxy, openStream } = require('../src/core/http');
      seen.length = 0;
      setFetchImpl(proxyFetch);
      const res2 = await request(`${server.base}/direct.mp4`, { range: 'bytes=0-9', wantBody: true, retries: 0 });
      assertEqual(res2.status, 206, '内置 HTTP 层应经代理拿到 206');
      assertEqual(seen.length >= 1, true, '内置 HTTP 层的请求应出现在代理上');
      assertEqual(res2.body.length, 10, '数据应完整');

      // 流式下载（openStream）也必须能经代理工作：这里曾经因为 body 不是真正的 ReadableStream 而报错
      const streamed = await openStream(`${server.base}/direct.mp4`, { retries: 0 });
      const chunks = [];
      await new Promise((resolve, reject) => {
        streamed.stream.on('data', (c) => chunks.push(c));
        streamed.stream.on('end', resolve);
        streamed.stream.on('error', reject);
      });
      const total = Buffer.concat(chunks);
      assert(total.length > 1000, `经代理的流式下载应拿到数据，实际 ${total.length} 字节`);
      assertEqual(total.slice(0, 4).toString('hex'), DIRECT_PAYLOAD.slice(0, 4).toString('hex'), '流式下载内容应与源文件一致');

      setHttpProxy('');
      assertEqual(require('../src/core/http').hasFetchImpl(), false, '清空代理后应恢复成内置 fetch');
    } finally {
      setFetchImpl(null);
      await new Promise((r) => proxyServer.close(r));
    }
  }),

  test('代理自检：可用/不可用两种结论 + 分类文案', async ({ server }) => {
    const { checkProxy, classifyProbe, isReachable } = require('../src/core/proxy-check');

    // 纯函数：分类文案
    assertEqual(classifyProbe({ name: 'pixiv', status: 200 }), 'pixiv 连接正常（HTTP 200）', '2xx 算正常');
    assert(classifyProbe({ name: 'pixiv', status: 403 }).includes('已连上'), '403 说明连接通了（只是被站点拦）');
    assert(classifyProbe({ name: 'x', status: 0, error: '网络错误：连接被拒绝（ECONNREFUSED）' }).includes('代理不可用'), 'ECONNREFUSED 判定为代理不可用');
    assert(classifyProbe({ name: 'x', status: 0, error: '请求超时（7000ms）' }).includes('超时'), '超时文案');
    assertEqual(isReachable({ status: 403 }), true, '4xx 也算连上了');
    assertEqual(isReachable({ status: 0, error: 'boom' }), false, '有错误就不算连上');

    // 集成：探测目标指向本地测试服务器（能连上 → 结论为可用）
    const okResult = await checkProxy({
      targets: [{ name: '本地测试', url: `${server.base}/direct.mp4` }],
      compare: false,
      timeoutMs: 5000,
    });
    assertEqual(okResult.ok, true, `本地可达时应判定可用，实际：${okResult.verdict}`);
    assertEqual(okResult.results.length, 1, '应有一条探测结果');
    assertEqual(okResult.results[0].status, 206, 'Range 探测应拿到 206');

    // 代理地址写错时，必须明确说「代理不生效」而不是含糊其辞
    // （用外部域名做目标：本机地址会按规则绕过代理，测不出代理故障）
    const bad = await checkProxy({
      proxy: 'http://127.0.0.1:1',
      targets: [{ name: '外部站点', url: 'http://vgrab-proxy-check.invalid/' }],
      compare: false,
      timeoutMs: 4000,
    });
    assertEqual(bad.ok, false, '坏代理必须判定为不可用');
    assert(bad.verdict.includes('代理不生效'), `结论应指出代理不生效，实际：${bad.verdict}`);

    // 地址格式错误要早点说清楚
    const malformed = await checkProxy({ proxy: '这不是代理地址', targets: [{ name: 'x', url: `${server.base}/direct.mp4` }] });
    assertEqual(malformed.ok, false, '非法地址判定失败');
    assert(malformed.verdict.includes('无法解析'), `应提示地址无法解析，实际：${malformed.verdict}`);
  }),

  test('图片帖：B 站专栏只保留正文图（过滤头像/UI 资源/缩略变体）', () => {
    const { pickPostImages, baseImageKey, variantScore } = require('../src/core/images');
    const base = 'https://i0.hdslb.com';
    const candidates = [
      // 头像、用户装扮、前端静态资源、图标 json —— 都不该被当成正文图
      { url: `${base}/bfs/face/f028fa152b628afd3e92bdb37075c0538f00ddf4.jpg@120w_120` },
      { url: `${base}/bfs/garb/open/28bbc9b9ad59d3177c7db47221d9d4ffe7e2a1a5.png` },
      { url: 'https://s1.hdslb.com/bfs/static/jinkela/long/bmg/register/cmpt.js' },
      { url: 'https://s1.hdslb.com/bfs/seed/jinkela/short/bili-theme/map.css' },
      { url: `${base}/bfs/svg-next/BDC/emoji_circle_line/v1.json` },
      { url: `${base}/bfs/static/jinkela/video/asserts/22-coin-ani.png` },
      // 正文图：同一张图的 80w / 128w 缩略变体 + 1192w 大图
      { url: `${base}/bfs/article/c28032cc1c834fa0c0c96498a6847eb299b2c5e2.png@128w_128h_1c.webp` },
      { url: `${base}/bfs/article/c28032cc1c834fa0c0c96498a6847eb299b2c5e2.png@1192w.webp` },
      { url: `${base}/bfs/article/imiBuJgMa1lM.png@80w_80h_1c` },
      { url: `${base}/bfs/article/imiBuJgMa1lM.png@1192w.webp` },
      // 作者插入的横幅图（属于正文）
      { url: `${base}/bfs/article/banner/c97d0202ac2592927980e2a94d660b8fee6765ef.png` },
    ];

    const picked = pickPostImages(candidates);
    assertEqual(picked.length, 3, `应只剩 3 张正文图，实际 ${picked.length}：${picked.map((p) => p.url).join(' , ')}`);
    assert(picked.every((p) => p.url.includes('/bfs/article/')), '只应保留 /bfs/article/ 下的正文图');
    assert(!picked.some((p) => p.url.includes('bfs/face')), '头像不应被下载');
    assert(!picked.some((p) => /\.(js|css|json)(\?|$)/.test(p.url)), '前端资源不应被当成图片');
    assert(
      picked.filter((p) => p.url.includes('c28032cc')).every((p) => p.url.includes('@1192w')),
      '同一张图应只留最大的变体（@1192w 而不是 @128w）',
    );

    // 变体去重键与打分：B 站的 @尺寸 后缀属于同一张图
    assertEqual(
      baseImageKey(`${base}/bfs/article/abc.png@1192w.webp`),
      baseImageKey(`${base}/bfs/article/abc.png@128w_128h_1c.webp`),
      '同图不同尺寸应归一化成同一个键',
    );
    assert(
      variantScore(`${base}/bfs/article/abc.png@1192w.webp`) > variantScore(`${base}/bfs/article/abc.png@128w_128h_1c.webp`),
      '@1192w 应比 @128w 分高',
    );
  }),

  test('图片帖：不设数量上限，有效图片全部保留', () => {
    const { pickPostImages } = require('../src/core/images');
    const base = 'https://i0.hdslb.com/bfs/article/';
    // 130 张正文图（老版本会被 80 张的上限截断）
    const many = [];
    for (let i = 0; i < 130; i += 1) many.push({ url: `${base}p${i}.png@1192w.webp` });
    const picked = pickPostImages(many);
    assertEqual(picked.length, 130, `130 张正文图应全部保留，实际 ${picked.length}`);

    // 混入干扰项后仍然只剩正文图
    const mixed = many.concat([
      { url: 'https://i1.hdslb.com/bfs/face/abc.jpg@120w_120' },
      { url: 'https://s1.hdslb.com/bfs/static/jinkela/x.js' },
      { url: `${base}p0.png@128w_128h_1c.webp` },
    ]);
    assertEqual(pickPostImages(mixed).length, 130, '干扰项不应影响数量，也不该混进来');

    // 需要限制时仍可用 maxImages 显式指定
    assertEqual(pickPostImages(many, { maxImages: 20 }).length, 20, 'maxImages 应仍可显式限制');
  }),

  test('Pixiv 免代理通道：PID 识别 / 反代逐页探测 / 搜图与分级过滤', async ({ server }) => {
    const {
      extractPixivId,
      mirrorPageUrl,
      enumeratePixivMirror,
      searchPixiv,
      ratingOf,
    } = require('../src/core/pixiv');
    const { fetchPixivIllustViaMirror } = require('../src/core/images');

    // PID 识别（照抄自 QQ Agent 那个插件的实测经验：没代理时"搜图"可能不通，但"按 PID 取图"通）
    assertEqual(extractPixivId('https://www.pixiv.net/artworks/150727863'), '150727863', '标准作品页');
    assertEqual(extractPixivId('https://www.pixiv.net/en/artworks/150727863'), '150727863', '带语言前缀');
    assertEqual(extractPixivId('https://www.pixiv.net/i/150727863'), '150727863', '旧版 /i/');
    assertEqual(extractPixivId('https://www.pixiv.net/member_illust.php?illust_id=150727863'), '150727863', '旧版查询参数');
    assertEqual(extractPixivId('https://pixiv.re/150727863.png'), '150727863', '反代链接');
    assertEqual(extractPixivId('https://i.pximg.net/img-original/img/x/150727863_p0.jpg'), '150727863', 'pximg 直链');
    assertEqual(extractPixivId('150727863'), '150727863', '光给数字');
    assertEqual(extractPixivId('https://example.com/nothing'), '', '认不出就返回空');

    // 反代页码形态：第 0 页不带后缀，第 n 页是 -（n+1）
    assertEqual(mirrorPageUrl('123', 0, 'https://pixiv.re'), 'https://pixiv.re/123.png', '第 0 页');
    assertEqual(mirrorPageUrl('123', 2, 'https://pixiv.re'), 'https://pixiv.re/123-3.png', '第 2 页');

    // 逐页探测：111111 有 3 页 → 探测到第 4 页 404 才收手
    const enumerated = await enumeratePixivMirror('111111', { mirrorBase: `${server.base}/mirror`, timeout: 5000 });
    assertEqual(enumerated.pages, 3, `应探测出 3 页，实际 ${enumerated.pages}`);
    assert(enumerated.urls[0].endsWith('/111111.png'), '第 0 页地址形态');
    assert(enumerated.urls[2].endsWith('/111111-3.png'), '第 2 页地址形态');

    // 作品只有 1 页时也要正确停手
    const single = await enumeratePixivMirror('222222', { mirrorBase: `${server.base}/mirror`, timeout: 5000 });
    assertEqual(single.pages, 1, '单页作品');

    // 反代上不存在的作品要报清楚（而不是返回空数组）
    let threw = '';
    try {
      await enumeratePixivMirror('999999', { mirrorBase: `${server.base}/mirror`, timeout: 5000 });
    } catch (err) {
      threw = err.message;
    }
    assert(/已被作者删除|限制访问|没取到/.test(threw), `不存在的作品应明确报错，实际「${threw}」`);

    // 搜图：默认只出全年龄（R18 那条要被本地过滤掉）
    const found = await searchPixiv('测试', { apiBase: `${server.base}/lolicon/setu/v2`, limit: 5, allowR18: false });
    assertEqual(found.items.length, 2, `默认应过滤掉 R18，实际 ${found.items.length}`);
    assert(!found.items.some((it) => ratingOf(it) > 0), '不应混入成人向作品');
    assertEqual(found.items[0].title, '测试图-测试', '标题来自检索接口');
    assert(found.items[0].url.includes('/mirror/111111.png'), '原图地址来自接口的 urls.original');

    // 允许成人向时全部返回
    const mixed = await searchPixiv('测试', { apiBase: `${server.base}/lolicon/setu/v2`, limit: 5, allowR18: true });
    assertEqual(mixed.items.length, 3, `允许成人向时应返回 3 个，实际 ${mixed.items.length}`);

    // 分级判定：xRestrict + 标签（R-18G 标签要把档位升到 2）
    assertEqual(ratingOf({ xRestrict: 0, tags: [] }), 0, '全年龄');
    assertEqual(ratingOf({ xRestrict: 1, tags: ['R-18'] }), 1, 'R18');
    assertEqual(ratingOf({ xRestrict: 1, tags: ['R-18G'] }), 2, '标签能把 R18 升到 R18G');

    // 免代理取图：接口 + 反代拼起来，多页作品要补齐
    const illust = await fetchPixivIllustViaMirror('111111', {
      apiBase: `${server.base}/lolicon/setu/v2`,
      mirrorBase: `${server.base}/mirror`,
      timeout: 5000,
    });
    assertEqual(illust.urls.length, 3, `应取到 3 页，实际 ${illust.urls.length}`);
    assertEqual(illust.source, 'mirror', '来源标记为反代');
  }),

  test('Pixiv 取图：默认先走反代（不需要代理），反代失败才退回官方接口', async ({ server, dir }) => {
    const { VideoDownloader } = require('../src/core/downloader');

    // ① 默认顺序：反代优先 —— 官方接口地址是死的，也不该被用到
    const dlMirror = new VideoDownloader({
      outDir: path.join(dir, 'pixiv-mirror'),
      appRoot: path.resolve(__dirname, '..'),
      historyLimit: 1,
      recordHistory: false,
      pixivApiBase: `${server.base}/pixiv-dead`, // 官方这条路故意给个不存在的地址
      pixivMirrorBase: `${server.base}/mirror`,
      extractPageMedia: async () => {
        throw new Error('不该走到浏览器兜底');
      },
    });
    const mirrorLogs = [];
    dlMirror.on('log', (p) => mirrorLogs.push(p.message));
    const viaMirror = await dlMirror.download('https://www.pixiv.net/artworks/111111');
    assertEqual(viaMirror.ok, true, `反代优先应成功：${viaMirror.error || ''}`);
    assertEqual(viaMirror.engine, 'image', '应走图片通道');
    assertEqual(viaMirror.pixivSource, 'mirror', '来源标记应为反代');
    assert(!mirrorLogs.some((m) => /改用官方接口/.test(m)), '反代成功时不该去试官方接口');
    const mirrorFiles = fs
      .readdirSync(path.join(dir, 'pixiv-mirror'), { recursive: true })
      .filter((f) => /\.(png|jpe?g)$/i.test(String(f)));
    assertEqual(mirrorFiles.length, 3, `多页作品应下到 3 张，实际 ${mirrorFiles.length}`);

    // ② 反代拿不到时才退官方接口（这里把反代地址指到不存在的路径）
    const dlApi = new VideoDownloader({
      outDir: path.join(dir, 'pixiv-api'),
      appRoot: path.resolve(__dirname, '..'),
      historyLimit: 1,
      recordHistory: false,
      pixivApiBase: `${server.base}/pixiv`,
      pixivMirrorBase: `${server.base}/mirror-dead`,
      extractPageMedia: async () => {
        throw new Error('不该走到浏览器兜底');
      },
    });
    const apiLogs = [];
    dlApi.on('log', (p) => apiLogs.push(p.message));
    const viaApi = await dlApi.download('https://www.pixiv.net/artworks/999');
    assertEqual(viaApi.ok, true, `反代失败时应退回官方接口并成功：${viaApi.error || ''}`);
    assertEqual(viaApi.pixivSource, 'api', '来源标记应为官方接口');
    assert(apiLogs.some((m) => /改用官方接口/.test(m)), '日志里应说明换用了官方接口');
  }),

  test('Pixiv 搜图 + 下载（命令行与界面共用的实现）', async ({ server, dir }) => {
    const { searchAndDownloadPixiv } = require('../src/core/pixiv');
    const outDir = path.join(dir, 'pixiv-search');
    const logs = [];
    const res = await searchAndDownloadPixiv('测试', {
      count: 2,
      allowR18: false,
      outDir,
      apiBase: `${server.base}/lolicon/setu/v2`,
      mirrorBase: `${server.base}/mirror`,
      onLog: (m) => logs.push(m),
    });

    assertEqual(res.items.length, 2, `应命中 2 个全年龄作品，实际 ${res.items.length}`);
    assertEqual(res.results.length, 2, '每个作品应有一条结果');
    assert(res.results.every((r) => r.ok), '两个作品都应下载成功');
    assert(res.results.every((r) => r.rating === 0), '默认不该出现成人向');
    // 一个作品一个子目录（否则单图作品会互相撞名成 2.png / 2 (1).png）
    const dirs = fs.readdirSync(outDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    assertEqual(dirs.length, 2, `应生成 2 个作品子目录，实际 ${dirs.length}`);
    assert(dirs.every((e) => /by/.test(e.name)), `子目录名应形如「标题 by 作者」，实际 ${dirs.map((d) => d.name).join(' / ')}`);

    // 只列出时不下载
    const listed = await searchAndDownloadPixiv('测试', {
      count: 2,
      listOnly: true,
      outDir,
      apiBase: `${server.base}/lolicon/setu/v2`,
      mirrorBase: `${server.base}/mirror`,
    });
    assertEqual(listed.results.length, 2, '只列出时也要有结果条目');
    assert(listed.results.every((r) => r.files.length === 0), '只列出时不该下载文件');

    // 允许 R18 时能搜到成人向作品（本地分级标签判定）
    const r18 = await searchAndDownloadPixiv('测试', {
      count: 5,
      allowR18: true,
      listOnly: true,
      outDir,
      apiBase: `${server.base}/lolicon/setu/v2`,
      mirrorBase: `${server.base}/mirror`,
    });
    assert(r18.results.some((r) => r.rating > 0), '允许成人向时应能搜到 R18 作品');

    // 搜不到时要给出原因，而不是静默返回空
    const none = await searchAndDownloadPixiv('找不到', {
      count: 2,
      outDir,
      apiBase: `${server.base}/lolicon/setu/v2`,
      mirrorBase: `${server.base}/mirror`,
    });
    assertEqual(none.items.length, 0, '搜不到作品');
    assert(none.errors.length > 0, '搜不到时应带上原因');

    // 候选里混着「已被作者删除」的作品（反代 404）：要自动往后取，凑够要求的数量
    // （否则 count=1 时一个 404 就等于"什么都没搜到"）
    const holeyDir = path.join(dir, 'pixiv-search-gap');
    const holey = await searchAndDownloadPixiv('补足', {
      count: 2,
      allowR18: false,
      outDir: holeyDir,
      apiBase: `${server.base}/lolicon/setu/v2`,
      mirrorBase: `${server.base}/mirror`,
    });
    const holeyOk = holey.results.filter((r) => r.ok);
    assertEqual(holeyOk.length, 2, `第一个候选 404 时也应凑够 2 个，实际 ${holeyOk.length}`);
    assert(holey.results.some((r) => !r.ok), '失败的那个候选也要留一条记录（日志里要说明跳过了谁）');
    assert(holey.results[0] && holey.results[0].ok === false, '结果里应保留"先失败后成功"的顺序');
  }),

  test('Pixiv 预览图地址 + 「只列出」后按 pid 下载', async ({ server, dir }) => {
    const { previewUrlOf, downloadPixivWorks } = require('../src/core/pixiv');

    // ① 预览图地址：反代上缩略图（240x480）与 1200px 版的路径换算
    const orig = 'https://i.pixiv.re/img-original/img/2022/12/20/14/21/55/103753629_p0.jpg';
    assertEqual(
      previewUrlOf(orig),
      'https://i.pixiv.re/c/240x480/img-master/img/2022/12/20/14/21/55/103753629_p0_master1200.jpg',
      '缩略图地址不对',
    );
    assertEqual(
      previewUrlOf(orig, 'master'),
      'https://i.pixiv.re/img-master/img/2022/12/20/14/21/55/103753629_p0_master1200.jpg',
      '1200px 地址不对',
    );
    // 多图作品的第 N 页、以及 .png 原图（master 一律是 .jpg）
    assert(
      previewUrlOf('https://i.pixiv.re/img-original/img/2024/01/02/03/04/05/150727863_p3.png').endsWith('150727863_p3_master1200.jpg'),
      'png 原图也应换算出 jpg 的 master 地址',
    );
    // 不是反代那种路径就别硬转（宁可不给预览，也不能拼出个假地址）
    assertEqual(previewUrlOf('https://example.com/a.jpg'), '', '非反代地址应返回空串');
    assertEqual(previewUrlOf(''), '', '空输入应返回空串');

    // ② 下载指定作品（界面「只列出」挑完点下载走这条）：只下选中的，每个作品一个子目录
    const pickDir = path.join(dir, 'pixiv-pick');
    const out = await downloadPixivWorks(
      [
        { pid: '111111', title: '选中的第一个', author: '作者A' },
        { pid: '222222', title: '选中的第二个', author: '作者B' },
        { pid: 'abc', title: '坏作品号' },
      ],
      {
        outDir: pickDir,
        mirrorBase: `${server.base}/mirror`,
        apiBase: `${server.base}/lolicon/setu/v2`,
      },
    );
    assertEqual(out.results.length, 3, '每个传入的作品都要有结果');
    assert(out.results[0].ok && out.results[1].ok, '两个合法作品都应下载成功');
    assertEqual(out.results[0].files.length, 3, '111111 在模拟反代上有 3 页，应逐页下全');
    assert(out.results[2].ok === false && /作品号/.test(out.results[2].error), '非法作品号应报错而不是崩');
    const subDirs = fs.readdirSync(pickDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    assertEqual(subDirs.length, 2, `只应给两个合法作品建目录，实际 ${subDirs.length}`);
    assert(subDirs.every((e) => /by/.test(e.name)), '子目录名应为「标题 by 作者」');
  }),

  test('CLI 参数解析', () => {
    const parsed = parseArgs([
      'https://a.com/v.m3u8',
      '-q',
      '720',
      '-o',
      'D:\\out',
      '--concurrency',
      '12',
      '--cookies',
      'c.txt',
      '--header',
      'X-Test:1',
      '--overwrite',
      '-v',
    ]);
    assertEqual(parsed.urls.length, 1, '链接数量');
    assertEqual(parsed.quality, '720');
    assertEqual(parsed.concurrency, 12);
    assertEqual(parsed.headers['X-Test'], '1');
    assert(parsed.overwrite, 'overwrite 标志');
    assert(parsed.verbose, 'verbose 标志');
    assert(path.isAbsolute(parsed.outDir), '输出目录应转成绝对路径');

    // 登录相关参数
    const loginWithSite = parseArgs(['--login', 'douyin']);
    assertEqual(loginWithSite.login, true, '--login 应被识别');
    assertEqual(loginWithSite.loginSite, 'douyin', '应带上站点参数');
    const loginBare = parseArgs(['--login']);
    assertEqual(loginBare.login, true, '不跟参数也应识别');
    assertEqual(loginBare.loginSite, undefined, '不跟参数时没有站点');
    const loginThenUrl = parseArgs(['--login', 'https://a.com/v.mp4']);
    assertEqual(loginThenUrl.loginSite, 'https://a.com/v.mp4', '--login 后跟网址应作为站点');
    assertEqual(loginThenUrl.urls.length, 0, '该网址不应被当成待下载链接');
    assertEqual(parseArgs(['--logout']).logout, true, '--logout 应被识别');
    assertEqual(parseArgs(['--history']).history, true, '--history 应被识别');
    assertEqual(parseArgs(['--history', '50']).historyLimit, 50, '--history 可带条数');
    assertEqual(parseArgs(['--history-clear']).historyClear, true, '--history-clear 应被识别');

    let threw = false;
    try {
      parseArgs(['--nope']);
    } catch {
      threw = true;
    }
    assert(threw, '未知选项应报错');
  }),

  test('直播播放列表（无 ENDLIST）能被识别为直播', async ({ server }) => {
    const res = await fetch(`${server.base}/live/master.m3u8`);
    const pl = parseM3U8(await res.text(), `${server.base}/live/master.m3u8`);
    assertEqual(pl.hasEndList, false, '无 ENDLIST 应为直播');
    assertEqual(pl.segments.length, 1, '当前可用分片数');
  }),

  test('直播流（未开启录制）：只保存当前已发布的分片', async ({ server, dir }) => {
    const outPath = path.join(dir, 'live-once.ts');
    const res = await downloadHls({ url: `${server.base}/live/master.m3u8`, outPath, remux: false, live: false });
    assertBufferEqual(fs.readFileSync(res.filePath), PLAIN_SEGMENTS[0], '应只包含当前分片（且已解密）');
    assertEqual(res.live, true, '应被标记为直播流');
  }),

  test('直播流（开启录制）：持续拉取新分片直到 ENDLIST', async ({ server, dir }) => {
    const outPath = path.join(dir, 'live-record.ts');
    const res = await downloadHls({
      url: `${server.base}/live2/playlist.m3u8`,
      outPath,
      remux: false,
      live: true,
      livePollInterval: 200,
      concurrency: 2,
    });
    assertBufferEqual(fs.readFileSync(res.filePath), Buffer.concat(LIVE_SEGMENTS), '应录制到全部 4 个分片');
    assertEqual(res.segments, LIVE_SEGMENTS.length, '录制分片数');
    assertEqual(path.extname(res.filePath), '.ts', '直播 TS 应保持 .ts 容器');
  }),

  test('直播录制：随时结束并保存已录部分（不丢数据、不留 .part）', async ({ server, dir }) => {
    const outPath = path.join(dir, 'live-stopped.ts');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1300);
    const t0 = Date.now();
    // 不应抛错：结束录制属于正常收尾
    const res = await downloadHls({
      url: `${server.base}/live3/playlist.m3u8`,
      outPath,
      remux: false,
      live: true,
      livePollInterval: 200,
      concurrency: 3,
      signal: controller.signal,
    });
    const elapsed = (Date.now() - t0) / 1000;
    assert(res.stopped === true, '应标记为「已结束录制」');
    assert(res.segments >= 1, `应至少录到 1 个分片，实际 ${res.segments}`);
    assert(elapsed < 15, `应在中断后很快收尾，实际 ${elapsed.toFixed(1)}s`);
    const content = fs.readFileSync(res.filePath);
    assertBufferEqual(content, Buffer.concat(LIVE3_SEGMENTS.slice(0, res.segments)), '文件内容应为已录制分片的顺序拼接');
    assert(!fs.existsSync(`${outPath}.part`), '不应残留 .part 临时文件');
    assert(!fs.existsSync(`${outPath}.part.json`), '不应残留 sidecar');
  }),

  test('直播录制：设置时长上限则自动结束并保存', async ({ server, dir }) => {
    const outPath = path.join(dir, 'live-limited.mp4');
    const res = await downloadHls({
      url: `${server.base}/live3/playlist.m3u8`,
      outPath,
      remux: false,
      live: true,
      livePollInterval: 200,
      maxLiveSeconds: 1,
      concurrency: 2,
    });
    assert(res.stopped === true, '到达时长上限应标记为已结束');
    assert(res.segments >= 1, '应录到至少 1 个分片');
    assert(res.duration >= res.segments - 1, `应报告实际录制时长，duration=${res.duration} segments=${res.segments}`);
    assertBufferEqual(
      fs.readFileSync(res.filePath),
      Buffer.concat(LIVE3_SEGMENTS.slice(0, res.segments)),
      '内容应为已录制分片',
    );
    assert(!fs.existsSync(`${outPath}.part`), '不应残留 .part');
  }),

  test('CLI：录制中按 Ctrl+C 结束，自动保存成品并正常退出', async ({ server, dir }) => {    const { main } = require('../src/cli');
    const outDir = path.join(dir, 'cli-live');
    fs.mkdirSync(outDir, { recursive: true });

    const argv = process.argv;
    const chunks = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.argv = ['node', 'cli.js', `${server.base}/live3/playlist.m3u8`, '--live', '-o', outDir];
    process.stdout.write = (s) => {
      chunks.push(String(s));
      return true;
    };
    process.stderr.write = (s) => {
      chunks.push(String(s));
      return true;
    };

    const timer = setTimeout(() => process.emit('SIGINT'), 1500);
    let code;
    try {
      code = await main();
    } finally {
      clearTimeout(timer);
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      process.argv = argv;
    }

    const output = chunks.join('');
    assert(code === 0, `正常收尾应返回 0，实际 ${code}；输出：${output.slice(-300)}`);
    assert(/已结束录制/.test(output), `应提示「已结束录制」，实际输出：${output.slice(-300)}`);
    const files = fs.readdirSync(outDir);
    assert(!files.some((f) => f.endsWith('.part')), `不应残留 .part：${files.join(', ')}`);
    const media = files.filter((f) => /\.(ts|mp4|m4a|aac)$/i.test(f));
    assertEqual(media.length, 1, `应生成 1 个成品文件，实际 ${files.join(', ')}`);
    assert(fs.statSync(path.join(outDir, media[0])).size > 0, '成品文件不应为空');
  }),

  test('直播链接识别与选流（B站 / 抖音直播）', () => {
    assert(looksLikeLiveUrl('https://live.bilibili.com/23929781?live_from=82002'), 'B 站直播链接应识别为直播');
    assert(looksLikeLiveUrl('https://live.douyin.com/792658201010?anchor_id=1'), '抖音直播链接应识别为直播');
    assert(looksLikeLiveUrl('https://www.twitch.tv/someone'), 'Twitch 应识别为直播');
    assert(looksLikeLiveUrl('https://www.youtube.com/live/abcdef'), 'YouTube 直播页应识别为直播');
    assert(!looksLikeLiveUrl('https://www.bilibili.com/video/BV1sbbD64EXf/'), '普通视频不应误判为直播');
    assert(!looksLikeLiveUrl('https://www.example.com/deliver/movie.mp4'), '普通直链不应误判为直播');

    // 选流：优先 HLS（可边录边转封装），其次高分辨率与 H.264
    const picked = pickLiveFormat([
      { url: 'https://x/a.flv', protocol: 'https', ext: 'flv', vcodec: 'hevc', height: 1080, tbr: 4000 },
      { url: 'https://x/b.m3u8', protocol: 'm3u8_native', ext: 'mp4', vcodec: 'avc1', height: 1080, tbr: 4000 },
      { url: 'https://x/c.m3u8', protocol: 'm3u8_native', ext: 'mp4', vcodec: 'avc1', height: 720, tbr: 2000 },
    ]);
    assert(picked && picked.url.endsWith('b.m3u8'), `应优先选择 HLS 1080p，实际 ${picked && picked.url}`);
    assertEqual(pickLiveFormat([]), null, '没有可用格式时应返回 null');
  }),

  test('直播选流：按清晰度等级选（B站 原画 > 蓝光 > 超清）', () => {
    // B 站直播的格式往往没有宽高/码率，只能靠 format_note（原画/蓝光/超清）判断
    const bili = [
      { formatId: 'ultra_high_res-2', url: 'https://x/a.m3u8', protocol: 'm3u8_native', ext: 'fmp4', vcodec: 'avc', note: '超清' },
      { formatId: 'ultra_high_res-6', url: 'https://x/b.m3u8', protocol: 'm3u8_native', ext: 'fmp4', vcodec: 'hevc', note: '超清' },
      { formatId: 'blue_ray-2', url: 'https://x/c.m3u8', protocol: 'm3u8_native', ext: 'fmp4', vcodec: 'avc', note: '蓝光' },
      { formatId: 'source-4', url: 'https://x/d.flv', protocol: 'https', ext: 'flv', vcodec: 'avc', note: '原画' },
    ];
    assertEqual(pickLiveFormat(bili).formatId, 'source-4', '应选「原画」，而不是因为它是 FLV 就退到「超清」');

    // 同一等级里优先 HLS（录制结束能直接转封装）
    const sameTier = [
      { formatId: 'source-0', url: 'https://x/a.flv', protocol: 'https', ext: 'flv', vcodec: 'avc', note: '原画' },
      { formatId: 'source-2', url: 'https://x/b.m3u8', protocol: 'm3u8_native', ext: 'fmp4', vcodec: 'avc', note: '原画' },
    ];
    assertEqual(pickLiveFormat(sameTier).formatId, 'source-2', '同一清晰度等级应优先 HLS');

    // 有 4K / 杜比时优先更高等级
    const with4k = [
      { formatId: 'source-0', url: 'https://x/a.flv', protocol: 'https', note: '原画' },
      { formatId: '4k-0', url: 'https://x/b.m3u8', protocol: 'm3u8_native', note: '4K' },
    ];
    assertEqual(pickLiveFormat(with4k).formatId, '4k-0', '4K 应排在原画之前');

    // 没有清晰度标注的站点仍按分辨率/码率挑
    const generic = [
      { formatId: 'a', url: 'https://x/a.m3u8', protocol: 'm3u8_native', height: 720, tbr: 2000 },
      { formatId: 'b', url: 'https://x/b.m3u8', protocol: 'm3u8_native', height: 1080, tbr: 4000 },
    ];
    assertEqual(pickLiveFormat(generic).formatId, 'b', '没有清晰度标注时应按分辨率选');

    // 指定清晰度上限时（带分辨率信息的站点）应尊重 -q
    assertEqual(rankLiveFormats(generic, '720')[0].formatId, 'a', '-q 720 应限制到 720p 那一档');
    // B 站直播没有分辨率信息时不受影响，仍取最高等级
    assertEqual(rankLiveFormats(bili, '720')[0].formatId, 'source-4', '没有分辨率信息时应仍取原画');
  }),

  test('连续流（FLV 类直播）：结束录制后保存为可播放文件', async ({ server, dir }) => {
    const outPath = path.join(dir, 'live-stream.flv');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 900);
    const result = await downloadDirect({
      url: `${server.base}/stream.flv`,
      outPath,
      live: true,
      gracefulStop: true,
      resume: false,
      signal: controller.signal,
    });
    assert(result.stopped === true, '应标记为「录制已结束」');
    assert(result.bytes > 0, `应录到数据，实际 ${result.bytes} 字节`);
    assertEqual(result.bytes % STREAM_CHUNK_SIZE, 0, '写入的应是完整数据块（不会留半个块）');
    const content = fs.readFileSync(result.filePath);
    assertEqual(content.length, result.bytes, '文件大小应与报告一致');
    assertEqual(content.slice(0, 6).toString(), 'chunk-', '文件内容应为流数据');
    assert(!fs.existsSync(`${outPath}.part`), '不应残留 .part 文件');
  }),
];

run(tests);
