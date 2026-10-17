// 给图标抠成圆角（透明圆角，不是画个白角）。
//
// 为什么单独抽出来：应用图标（PNG + 多尺寸 ICO，还要嵌进 exe）和界面左上角的 logo
// 都要同一个效果，两处各写一遍迟早不一致。
//
// 做法：输入是 nativeImage.toBitmap() 那种 BGRA 缓冲区，按"圆角矩形覆盖率"乘到 alpha 上。
// 覆盖率用 3×3 子采样算 —— 直接二值判断会让圆角有明显锯齿（这就是最容易被看出"糊"的地方）。

/**
 * @param {Buffer} bgra nativeImage 的 BGRA 缓冲（每像素 4 字节，行序自上而下）
 * @param {number} width
 * @param {number} height
 * @param {number} [ratio] 圆角半径占边长的比例，默认 0.22（约等于 Windows/iOS 图标的观感）
 * @returns {Buffer} 新的 BGRA 缓冲（原缓冲不动）
 */
function roundCorners(bgra, width, height, ratio = 0.22) {
  const out = Buffer.from(bgra);
  const size = Math.min(width, height);
  const radius = Math.max(1, Math.round(size * ratio));
  const SS = 3;                 // 每个像素 3x3 子采样
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let inside = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          // 到"内缩后的矩形 + 圆角圆心"的距离判定
          const cx = Math.min(Math.max(px, radius), width - radius);
          const cy = Math.min(Math.max(py, radius), height - radius);
          const dx = px - cx;
          const dy = py - cy;
          if (dx * dx + dy * dy <= radius * radius) inside += 1;
        }
      }
      const coverage = inside / (SS * SS);
      if (coverage >= 1) continue;
      const i = (y * width + x) * 4;
      out[i + 3] = Math.round(out[i + 3] * coverage);
      if (out[i + 3] === 0) {
        // 全透明像素把颜色也清掉，避免缩放时边缘泛白（预乘前的一层保护）
        out[i] = 0;
        out[i + 1] = 0;
        out[i + 2] = 0;
      }
    }
  }
  return out;
}

module.exports = { roundCorners };
