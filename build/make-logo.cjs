// 把一张图做成界面左上角的那个小 logo。
//
// 用法（**必须用 Electron 跑**，纯 node 解不了 webp/jpg）：
//   node_modules\electron\dist\electron.exe build\make-logo.cjs "D:\某张图.webp"
//   或 npm run logo:from -- "D:\某张图.webp"
//
// 做三件事：
//   1. 自动裁掉四周的纯色留白（原图往往是一大片白边，直接缩到 40px 会小得看不清）；
//   2. 裁成正方形（不拉变形）；
//   3. 缩到 192（界面上按 40px 显示，留够高 DPI 的余量）写 src/gui/renderer/logo.png。
// 源图路径记到 build/logo-source.txt，以后重新生成不用再翻文件夹。

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { app, nativeImage } = require('electron');
const { loadImage } = require('./img-decode.cjs');
const { roundCorners } = require('./round-corners.cjs');

const BUILD_DIR = __dirname;
const ROOT = path.resolve(BUILD_DIR, '..');
const OUT_PNG = path.join(ROOT, 'src', 'gui', 'renderer', 'logo.png');
const OUT_SRC = path.join(BUILD_DIR, 'logo-source.txt');
const OUT_SIZE = 192;
/** 圆角半径占比例：跟应用图标一致（0.22），界面上看起来是一套的 */
const RADIUS_RATIO = 0.22;

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
/** 重新编码成最朴素的 RGBA8 PNG（不引第三方库） */
function encodePng(bmp, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const s = (y * width + x) * 4;
      const d = rowStart + 1 + x * 4;
      raw[d] = bmp[s + 2];
      raw[d + 1] = bmp[s + 1];
      raw[d + 2] = bmp[s];
      raw[d + 3] = bmp[s + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 找出「不是背景」的那块区域：以四角像素为背景色，容差内都算背景 */
function contentBox(bmp, width, height) {
  const corners = [0, (width - 1) * 4, (height - 1) * width * 4, ((height - 1) * width + width - 1) * 4];
  let br = 0;
  let bg = 0;
  let bb = 0;
  for (const c of corners) {
    br += bmp[c + 2];
    bg += bmp[c + 1];
    bb += bmp[c];
  }
  br /= corners.length;
  bg /= corners.length;
  bb /= corners.length;
  const tol = 26;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const a = bmp[i + 3];
      const near =
        a < 8 ||
        (Math.abs(bmp[i + 2] - br) <= tol && Math.abs(bmp[i + 1] - bg) <= tol && Math.abs(bmp[i] - bb) <= tol);
      if (near) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0 || maxY < 0) return { x: 0, y: 0, size: Math.min(width, height) };
  // 变成正方形（以中心为准），再留 4% 边距
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const side = Math.max(maxX - minX, maxY - minY) * 1.08;
  const size = Math.min(Math.min(width, height), Math.round(side));
  const x = Math.max(0, Math.min(width - size, Math.round(cx - size / 2)));
  const y = Math.max(0, Math.min(height - size, Math.round(cy - size / 2)));
  return { x, y, size };
}

app.whenReady().then(() => {
  try {
    const src = argValue('--from', process.argv.find((a) => /\.(png|jpe?g|webp|bmp|gif|avif)$/i.test(a)) || '')
      || (fs.existsSync(OUT_SRC) ? fs.readFileSync(OUT_SRC, 'utf8').trim() : '');
    if (!src || !fs.existsSync(src)) {
      console.error(`✗ 找不到源图片：${src || '(没给 --from)'}`);
      app.exit(1);
      return;
    }
    const { img, note } = loadImage(src);
    if (!img) {
      console.error(`✗ 这张图解不开：${src}${note}`);
      app.exit(1);
      return;
    }
    const { width, height } = img.getSize();
    const bmp = img.toBitmap();
    const box = contentBox(bmp, width, height);
    console.log(`源图：${src}（${width}x${height}）${note} → 有效区域 ${box.size}x${box.size} @ ${box.x},${box.y}`);

    const crop = Buffer.alloc(box.size * box.size * 4);
    for (let y = 0; y < box.size; y += 1) {
      const srcRow = ((y + box.y) * width + box.x) * 4;
      bmp.copy(crop, y * box.size * 4, srcRow, srcRow + box.size * 4);
    }
    const square = nativeImage.createFromBitmap(crop, { width: box.size, height: box.size });
    const small = square.resize({ width: OUT_SIZE, height: OUT_SIZE, quality: 'best' });
    // 界面里那个位置是圆角方块，图本身也抠成圆角：深色顶栏上直接就是"圆角头像"，
    // 不再靠 CSS border-radius 去裁（省得两处半径不一致、边缘发毛）。
    const roundedBmp = roundCorners(small.toBitmap(), OUT_SIZE, OUT_SIZE, RADIUS_RATIO);
    const { width: w, height: h } = { width: OUT_SIZE, height: OUT_SIZE };
    const png = encodePng(roundedBmp, w, h);
    fs.mkdirSync(path.dirname(OUT_PNG), { recursive: true });
    fs.writeFileSync(OUT_PNG, png);
    console.log(`✓ ${path.relative(ROOT, OUT_PNG)}（${w}x${h}，${png.length} B）`);
    fs.writeFileSync(OUT_SRC, `${src}\n`, 'utf8');
    console.log(`✓ 记住源图路径 → ${path.relative(ROOT, OUT_SRC)}`);
    app.exit(0);
  } catch (err) {
    console.error(`✗ 生成 logo 失败：${err.message}`);
    app.exit(1);
  }
});
