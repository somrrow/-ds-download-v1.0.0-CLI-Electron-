'use strict';
// 用本地测试页验证「图文帖轮播逐张翻页」的抽取逻辑（需要 Electron）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { extractPageMediaViaElectron } = require('../src/core/browser-page');

const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'note-player.html'), 'utf8');

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/note`;
  try {
    const data = await extractPageMediaViaElectron({
      appRoot: path.resolve(__dirname, '..'),
      url,
      waitSec: 2,
      loadImages: true,
      onLog: (m) => console.log('[log]', m),
    });
    const slides = (data.slides || []).map((x) => (String(x.url || x).match(/slide(\d)/) || [])[1]);
    console.log('slides:', JSON.stringify(slides));
    console.log('images:', JSON.stringify((data.images || []).map((x) => ({ scope: x.scope, name: (x.url.match(/slide(\d)/) || [])[1] || 'other' }))));
    const ok = slides.join(',') === '1,2,3';
    console.log(ok ? 'PASS 轮播逐张翻页顺序正确' : 'FAIL 轮播翻页结果不符合预期');
    process.exitCode = ok ? 0 : 1;
  } catch (err) {
    console.log('ERROR', err.message);
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();
