// 生成应用图标（PNG + ICO），零依赖：自己画像素 + 自己写 PNG/ICO 容器。
//
//   node build/make-icon.mjs          生成 build/icon.png 与 build/icon.ico
//
// 为什么自己画：这个项目一个第三方依赖都不想引（打包脚本也一样），
// 而图标只有三种形状（圆角底、箭头、托盘横条），手写比找图省事，也永远可复现。
// ICO 用「PNG 内嵌」格式（Vista 起 Windows 就认，快捷方式/窗口图标都吃这个）。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_PNG = path.join(here, 'icon.png');
const OUT_ICO = path.join(here, 'icon.ico');

const SIZE = 256;
const SS = 2;                 // 2x 超采样，边缘不至于锯齿
const W = SIZE * SS;

/** 画一张 RGBA 图（返回 {data:Buffer, width, height}，行序自上而下） */
function render() {
  const buf = Buffer.alloc(W * W * 4);
  const put = (x, y, r, g, b, a) => {
    const i = (y * W + x) * 4;
    const sa = a / 255;
    const da = buf[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    buf[i] = Math.round((r * sa + buf[i] * da * (1 - sa)) / oa);
    buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / oa);
    buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / oa);
    buf[i + 3] = Math.round(oa * 255);
  };
  const inRoundRect = (x, y, rx0, ry0, rx1, ry1, radius) => {
    if (x < rx0 || x > rx1 || y < ry0 || y > ry1) return false;
    const cx = Math.min(Math.max(x, rx0 + radius), rx1 - radius);
    const cy = Math.min(Math.max(y, ry0 + radius), ry1 - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  const pad = 10 * SS;
  const radius = 46 * SS;
  for (let y = 0; y < W; y += 1) {
    for (let x = 0; x < W; x += 1) {
      // 圆角底：竖向渐变（蓝 → 青紫），模仿"下载"这类工具的常见观感
      if (inRoundRect(x, y, pad, pad, W - 1 - pad, W - 1 - pad, radius)) {
        const t = (y - pad) / (W - 1 - 2 * pad);
        const r = Math.round(38 + t * 90);
        const g = Math.round(92 + t * 40);
        const b = Math.round(238 - t * 20);
        put(x, y, r, g, b, 255);
      }
    }
  }

  // 白色前景：向下箭头 + 托盘横条（"下载到本地"）
  const white = [245, 249, 255];
  const cx = W / 2;
  const barTop = 74 * SS;
  const barBottom = 138 * SS;
  const barHalf = 13 * SS;
  const headTop = barBottom - 6 * SS;
  const headBottom = 176 * SS;
  const headHalf = 42 * SS;
  for (let y = 0; y < W; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const dx = x - cx;
      let on = false;
      if (y >= barTop && y <= barBottom && Math.abs(dx) <= barHalf) on = true;
      if (!on && y >= headTop && y <= headBottom) {
        const t = (y - headTop) / (headBottom - headTop);
        if (Math.abs(dx) <= headHalf * (1 - t)) on = true;
      }
      if (!on && y >= 196 * SS && y <= 210 * SS && Math.abs(dx) <= 66 * SS) on = true;
      if (on) put(x, y, white[0], white[1], white[2], 255);
    }
  }

  // 2x 降采样成目标尺寸
  const out = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let dy = 0; dy < SS; dy += 1) {
        for (let dx = 0; dx < SS; dx += 1) {
          const i = ((y * SS + dy) * W + (x * SS + dx)) * 4;
          const sa = buf[i + 3] / 255;
          r += buf[i] * sa; g += buf[i + 1] * sa; b += buf[i + 2] * sa; a += buf[i + 3];
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const i = (y * SIZE + x) * 4;
      const norm = alpha > 0 ? alpha / 255 : 1;
      out[i] = Math.min(255, Math.round(r / n / norm));
      out[i + 1] = Math.min(255, Math.round(g / n / norm));
      out[i + 2] = Math.min(255, Math.round(b / n / norm));
      out[i + 3] = Math.round(alpha);
    }
  }
  return { data: out, width: SIZE, height: SIZE };
}

// ── PNG 编码（真彩 + alpha，filter 0）────────────────────────────────────────
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

function encodePng({ data, width, height }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  ihdr[10] = 0;   // deflate
  ihdr[11] = 0;   // filter
  ihdr[12] = 0;   // no interlace
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;   // filter type 0
    data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO 容器：内嵌一张 PNG（Vista+ 通用，256x256） */
function encodeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type = icon
  header.writeUInt16LE(1, 4);   // 图片数量
  const entry = Buffer.alloc(16);
  entry[0] = 0;                 // 宽 256 记作 0
  entry[1] = 0;                 // 高 256 记作 0
  entry[2] = 0;                 // 调色板
  entry[3] = 0;                 // reserved
  entry.writeUInt16LE(1, 4);    // color planes
  entry.writeUInt16LE(32, 6);   // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12);
  return Buffer.concat([header, entry, png]);
}

const img = render();
const png = encodePng(img);
const sourceNote = (() => {
  try {
    const p = path.join(here, 'icon-source.txt');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
  } catch {
    return '';
  }
})();
if (sourceNote) {
  console.log(`⚠️ build/icon.png 目前来自你自己的图（${sourceNote}）。`);
  console.log('   本脚本是"没图时画一个默认图标"的兜底，跑它会把那张图覆盖成默认图案。');
  console.log('   想保留你的图请 Ctrl+C；想重新从那张图生成：npm run icon:from -- "源图路径"');
}
fs.writeFileSync(OUT_PNG, png);
fs.writeFileSync(OUT_ICO, encodeIco(png));
console.log(`✓ ${path.relative(process.cwd(), OUT_PNG)}（${png.length} B）`);
console.log(`✓ ${path.relative(process.cwd(), OUT_ICO)}（${fs.statSync(OUT_ICO).size} B）`);
