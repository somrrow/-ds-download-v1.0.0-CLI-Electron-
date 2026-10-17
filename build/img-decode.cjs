// 统一的「读一张图」：PNG/JPEG 直接读，其它格式（webp / avif / bmp…）先用 ffmpeg 转一张 PNG。
//
// 为什么需要它：Electron 的 `nativeImage.createFromPath()` **只认 PNG 与 JPEG**，
// 拿 .webp 去读会静默返回空图（isEmpty() === true），表现就是"图明明在那儿却说解不开"。
// 而本工具自带 tools/ffmpeg.exe（能解 webp/avif），所以转一手最省事。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { nativeImage } = require('electron');

const ROOT = path.resolve(__dirname, '..');

function ffmpegCandidates() {
  return [
    process.env.VIDEOGRAB_FFMPEG,
    process.env.VIDEOGRAB_TOOLS_DIR ? path.join(process.env.VIDEOGRAB_TOOLS_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : '',
    path.join(ROOT, 'tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    'ffmpeg',
  ].filter(Boolean);
}

/**
 * @returns {{img: Electron.NativeImage|null, note: string}}
 */
function loadImage(file) {
  const direct = nativeImage.createFromPath(file);
  if (!direct.isEmpty()) return { img: direct, note: '' };

  if (!/\.(png|jpe?g)$/i.test(file)) {
    for (const bin of ffmpegCandidates()) {
      const tmp = path.join(os.tmpdir(), `vgrab-img-${process.pid}-${Date.now()}.png`);
      const r = spawnSync(bin, ['-y', '-loglevel', 'error', '-i', file, tmp], { windowsHide: true, encoding: 'utf8' });
      if (r.status === 0 && fs.existsSync(tmp)) {
        const conv = nativeImage.createFromPath(tmp);
        if (!conv.isEmpty()) {
          return { img: conv, note: `（${path.extname(file).replace('.', '')} → ffmpeg 转 PNG 后读取）` };
        }
      }
      // 换下一个候选（可能是 PATH 里的 ffmpeg）
    }
    return { img: null, note: ' nativeImage 只认 PNG/JPEG，且没找到可用的 ffmpeg 来转格式' };
  }
  return { img: null, note: '' };
}

module.exports = { loadImage, ffmpegCandidates };
