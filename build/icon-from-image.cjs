// 把任意图片转成应用图标（PNG + 多尺寸 ICO）。
//
// 用法（**必须用 Electron 跑**，纯 node 没有 nativeImage 解不了 jpg/webp）：
//   node_modules\electron\dist\electron.exe build\icon-from-image.cjs "D:\图片.jpg"
//   或 npm run icon:from -- "D:\图片.jpg"
//
// 做四件事：
//   1. 中心裁成正方形（图标必须是方的，不然会拉变形）；
//   2. 抠成**圆角**（透明圆角，观感对齐 Windows/iOS 的图标；见 build/round-corners.cjs）；
//   3. 缩到 256 写 build/icon.png（窗口/任务栏图标用）；
//   4. 写一份**多尺寸** build/icon.ico（256/128/64/48/32/16 —— 快捷方式、资源管理器、
//      任务栏各自挑合适的尺寸，只有一个 256 的话小图标位置会糊）。
// 源图路径会记到 build/icon-source.txt，以后重新生成不用再翻文件夹。

const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');
const { roundCorners } = require('./round-corners.cjs');

const BUILD_DIR = __dirname;
const ROOT = path.resolve(BUILD_DIR, '..');
const OUT_PNG = path.join(BUILD_DIR, 'icon.png');
const OUT_ICO = path.join(BUILD_DIR, 'icon.ico');
const OUT_SRC = path.join(BUILD_DIR, 'icon-source.txt');
const ICO_SIZES = [256, 128, 64, 48, 32, 16];
/** 圆角半径占边长的比例：0.22 接近 Windows/iOS 图标的观感（太小像没圆角，太大像药丸） */
const RADIUS_RATIO = 0.22;

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// ── ICO 容器（内嵌多张 PNG，Vista+ 通用）─────────────────────────────────────
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
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * 重编码 PNG：确保是「RGBA8 + filter 0」这种最朴素的形态。
 *
 * 为什么不直接写真·彩色索引：`nativeImage.toPNG()` 出来的 PNG 可能带交错/调色板等花样，
 * 不是所有 Windows 版本读 ICO 里的这类 PNG 都稳；自己按固定格式重编一遍最保险。
 */
function reencodePng(pngBuffer) {
  const img = nativeImage.createFromBuffer(pngBuffer);
  const { width, height } = img.getSize();
  const bmp = img.toBitmap();               // BGRA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;                      // filter 0
    for (let x = 0; x < width; x += 1) {
      const s = (y * width + x) * 4;
      const d = rowStart + 1 + x * 4;
      raw[d] = bmp[s + 2];                  // R
      raw[d + 1] = bmp[s + 1];              // G
      raw[d + 2] = bmp[s];                  // B
      raw[d + 3] = bmp[s + 3];              // A
    }
  }
  const zlib = require('zlib');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return {
    width,
    height,
    data: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  };
}

/**
 * ICO 条目用 **DIB（BITMAPINFOHEADER + BGRA + AND 掩码）**，不是 PNG。
 *
 * 踩过的坑：图标里塞 PNG（哪怕只有一个 256 项）在 Windows 资源管理器里显示正常，
 * 但 `System.Drawing.Icon`（GDI+，很多老程序/脚本用它读图标）会直接抛
 * "Requested range extends past the end of the array" —— 因为 GDI+ 不支持 PNG 型图标条目。
 * 全部走 DIB 最保险：文件大一点（6 个尺寸约 290KB），但哪个 Windows 组件都读得动。
 */
function encodeDibEntry(img, size) {
  const bmp = img.toBitmap();              // BGRA，行序自上而下
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const src = (size - 1 - y) * size * 4;   // DIB 是自下而上存的
    bmp.copy(xor, y * size * 4, src, src + size * 4);
  }
  const maskRow = Math.ceil(size / 32) * 4;              // 1bpp，按 4 字节对齐
  const andMask = Buffer.alloc(maskRow * size);          // 32 位带 alpha 时掩码可以全 0
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);        // 高度写两倍：XOR 图 + AND 掩码
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(xor.length + andMask.length, 20);
  return Buffer.concat([header, xor, andMask]);
}

function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dir = [];
  for (const e of entries) {
    const b = Buffer.alloc(16);
    b[0] = e.width >= 256 ? 0 : e.width;    // 256 记作 0
    b[1] = e.height >= 256 ? 0 : e.height;
    b[2] = 0;
    b[3] = 0;
    b.writeUInt16LE(1, 4);
    b.writeUInt16LE(32, 6);
    b.writeUInt32LE(e.data.length, 8);
    b.writeUInt32LE(offset, 12);
    offset += e.data.length;
    dir.push(b);
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.data)]);
}

/** 中心裁正方形 → 缩到目标尺寸 → **抠圆角** → 返回 nativeImage */
function squareImage(img, size) {
  const { width, height } = img.getSize();
  const side = Math.min(width, height);
  const bmp = img.toBitmap();
  const cropped = Buffer.alloc(side * side * 4);
  const offX = Math.floor((width - side) / 2);
  const offY = Math.floor((height - side) / 2);
  for (let y = 0; y < side; y += 1) {
    const srcRow = ((y + offY) * width + offX) * 4;
    bmp.copy(cropped, y * side * 4, srcRow, srcRow + side * 4);
  }
  const square = nativeImage.createFromBitmap(cropped, { width: side, height: side });
  const small = square.resize({ width: size, height: size, quality: 'best' });
  // 圆角要在**最终尺寸**上抠：先裁后缩会把圆角的抗锯齿重新揉糊
  const rounded = roundCorners(small.toBitmap(), size, size, RADIUS_RATIO);
  return nativeImage.createFromBitmap(rounded, { width: size, height: size });
}

/** 中心裁正方形 → 缩到目标尺寸 → 返回 8 位 RGBA 的 PNG Buffer（窗口图标用） */
function squarePng(img, size) {
  return squareImage(img, size).toPNG();
}

app.whenReady().then(() => {
  try {
    const src = argValue('--from', process.argv.find((a) => /\.(png|jpe?g|webp|bmp|gif)$/i.test(a)) || '');
    const useSrc = src || (fs.existsSync(OUT_SRC) ? fs.readFileSync(OUT_SRC, 'utf8').trim() : '');
    if (!useSrc || !fs.existsSync(useSrc)) {
      console.error(`✗ 找不到源图片：${useSrc || '(没给 --from)'}`);
      app.exit(1);
      return;
    }
    const img = nativeImage.createFromPath(useSrc);
    if (img.isEmpty()) {
      console.error(`✗ 这张图解不开（格式不支持？）：${useSrc}`);
      app.exit(1);
      return;
    }
    const { width, height } = img.getSize();
    console.log(`源图：${useSrc}（${width}x${height}）`);

    const mainPng = reencodePng(squarePng(img, 256));
    fs.writeFileSync(OUT_PNG, mainPng.data);
    console.log(`✓ ${path.relative(ROOT, OUT_PNG)}（${mainPng.width}x${mainPng.height}，${mainPng.data.length} B）`);

    const entries = ICO_SIZES.map((size) => ({ width: size, height: size, data: encodeDibEntry(squareImage(img, size), size) }));
    const ico = encodeIco(entries);
    fs.writeFileSync(OUT_ICO, ico);
    console.log(`✓ ${path.relative(ROOT, OUT_ICO)}（${ICO_SIZES.join('/')}，${ico.length} B）`);

    fs.writeFileSync(OUT_SRC, `${useSrc}\n`, 'utf8');
    console.log(`✓ 记住源图路径 → ${path.relative(ROOT, OUT_SRC)}`);
    app.exit(0);
  } catch (err) {
    console.error(`✗ 生成图标失败：${err.message}`);
    app.exit(1);
  }
});
