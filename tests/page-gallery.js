'use strict';
// 用本地「懒加载长图集」测试页验证：滚动整页 + 不设数量上限后能把有效图片全部收下来
// （需要 Electron 内置浏览器；本地页面，不依赖外网）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { extractPageMediaViaElectron } = require('../src/core/browser-page');

const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'lazy-gallery.html'), 'utf8');
const EXPECTED = 130;

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/opus/123`;
  try {
    const data = await extractPageMediaViaElectron({
      appRoot: path.resolve(__dirname, '..'),
      url,
      waitSec: 2,
      loadImages: true,
      scroll: true,
      onLog: (m) => console.log('[log]', m),
    });
    const images = data.images || [];
    const bad = images.filter((x) => /bfs\/face|bfs\/garb|jinkela|\.js|\.css|\.json|@128w/i.test(x.url));
    const unique = new Set(images.map((x) => x.url)).size;
    console.log(`收集到 ${images.length} 张（去重后 ${unique}），滚动到 ${data.scrolled} 像素`);
    console.log(`干扰项残留：${bad.length}`);
    const ok = images.length === EXPECTED && unique === EXPECTED && bad.length === 0;
    if (!ok) {
      console.log('前 5 条：');
      images.slice(0, 5).forEach((x) => console.log('   ', x.url));
    }
    console.log(ok ? `PASS 有效图片全部保存（${EXPECTED} 张，无干扰项）` : `FAIL 期望 ${EXPECTED} 张正文图且无干扰项，实际 ${images.length} 张`);
    process.exitCode = ok ? 0 : 1;
  } catch (err) {
    console.log('ERROR', err.message);
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();
