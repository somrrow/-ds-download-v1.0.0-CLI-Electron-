// 抓流浏览器用的 preload：**把 HEVC(H.265) 从"浏览器能播"里摘掉**。
//
// 为什么需要它（2026-10-17 真实现场）：
// 抖音直播会给"支持 HEVC 的浏览器"发 HEVC 的 FLV（enhanced-RTMP，codec id 12）。
// 内置 ffmpeg（6.1.1）的 FLV demuxer **不认这种编码** —— 录下来的文件
// `ffmpeg -i` 只会报 `Video: none ([12]…): unknown codec`，转封装直接失败
// （报 "dimensions not set"，留下 0 字节的 .mp4），最后发给群里的是一坨
// QQ 根本播不了的 .flv，表现就是"下载视频出错"。
//
// 而 Chromium/Electron 是能播 HEVC 的，所以站点会一直选 HEVC。这里在页面脚本
// 运行**之前**把 `MediaSource.isTypeSupported()` / `canPlayType()` 里带
// hvc1/hev1/h265 的都判死 —— 播放器于是退回 H.264 流，录下来就是普通 AVC，
// 转封装、QQ 播放全部正常（实测：同样 1920x1080 60fps，只是编码变成 h264）。
//
// ⚠️ 只有在 `contextIsolation: false` 的窗口里才有效（preload 与页面同一个世界），
// 见 browser-page.js 里创建窗口的地方。
(() => {
  try {
    const isHevc = (type) => /hvc1|hev1|hvc3|hvc2|h265|hevc/i.test(String(type || ''));

    const MS = window.MediaSource;
    const origIsTypeSupported = MS && MS.isTypeSupported;
    if (typeof origIsTypeSupported === 'function') {
      MS.isTypeSupported = function isTypeSupported(type) {
        if (isHevc(type)) return false;
        return origIsTypeSupported.call(this, type);
      };
    }

    const proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
    const origCanPlayType = proto && proto.canPlayType;
    if (typeof origCanPlayType === 'function') {
      proto.canPlayType = function canPlayType(type) {
        if (isHevc(type)) return '';
        return origCanPlayType.call(this, type);
      };
    }
  } catch {
    /* 页面环境变了也不该影响抓流：补丁失败就按原样跑（顶多是 HEVC 老问题） */
  }
})();
