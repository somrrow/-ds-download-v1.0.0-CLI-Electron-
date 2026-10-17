'use strict';

/** 统一下载进度统计：速度用滑动窗口平均，避免抖动 */
class ProgressMeter {
  constructor(options = {}) {
    this.startTime = Date.now();
    this.lastTime = this.startTime;
    this.lastBytes = 0;
    this.bytes = 0;
    this.total = options.total || 0;
    this.speed = 0;
    this.samples = [];
    this.lastEmit = 0;
    this.minEmitInterval = options.minEmitInterval ?? 200;
    this.extra = { ...(options.extra || {}) };
    this.smoothed = 0;
  }

  setTotal(total) {
    if (isFinite(total) && total > 0) this.total = total;
  }

  add(bytes) {
    if (bytes > 0) this.bytes += bytes;
  }

  setBytes(bytes) {
    this.bytes = bytes;
  }

  /** 计算瞬时速度（字节/秒） */
  #sample() {
    const now = Date.now();
    const dt = (now - this.lastTime) / 1000;
    if (dt < 0.25) return this.speed;
    const db = this.bytes - this.lastBytes;
    this.lastTime = now;
    this.lastBytes = this.bytes;
    const inst = db / dt;
    this.smoothed = this.smoothed ? this.smoothed * 0.6 + inst * 0.4 : inst;
    return this.smoothed;
  }

  snapshot(extra = {}) {
    const speed = this.#sample();
    const elapsed = (Date.now() - this.startTime) / 1000;
    const remaining = this.total > 0 ? Math.max(0, this.total - this.bytes) : -1;
    return {
      bytes: this.bytes,
      total: this.total,
      percent: this.total > 0 ? Math.min(100, (this.bytes / this.total) * 100) : -1,
      speed,
      elapsed,
      remaining,
      eta: remaining >= 0 && speed > 0 ? remaining / speed : -1,
      ...this.extra,
      ...extra,
    };
  }

  /** 节流后的进度回调，返回是否真的触发了回调 */
  emit(extra, force = false) {
    const now = Date.now();
    if (!force && now - this.lastEmit < this.minEmitInterval) return false;
    this.lastEmit = now;
    return true;
  }
}

module.exports = { ProgressMeter };
