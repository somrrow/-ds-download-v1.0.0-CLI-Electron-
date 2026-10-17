'use strict';

/**
 * 直链下载器：支持 Range 断点续传、进度回调、取消、失败保留 .part。
 */

const fs = require('fs');
const path = require('path');
const { openStream } = require('../http');
const { ProgressMeter } = require('../progress');
const { ensureDir, fileSize, formatBytes, uniquePath } = require('../util');

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.outPath 目标文件完整路径（调用方已处理重名）
 * @param {boolean} [opts.resume=true] 是否启用断点续传
 * @param {boolean} [opts.live=false] 是否为直播流录制（未知长度、持续接收）
 * @param {boolean} [opts.gracefulStop=false] 收到停止请求时收尾保存而不是丢弃
 * @param {(p:object)=>void} [opts.onProgress]
 * @param {(msg:string)=>void} [opts.logger]
 * @param {AbortSignal} [opts.signal]
 */
async function downloadDirect(opts) {
  const {
    url,
    outPath,
    resume = true,
    live = false,
    gracefulStop = false,
    maxLiveSeconds = 0,
    onProgress,
    logger = () => {},
    signal,
    timeout = 60000,
  } = opts;

  ensureDir(path.dirname(outPath));
  const partPath = `${outPath}.part`;
  let startAt = resume ? fileSize(partPath) : 0;
  if (!resume && fileSize(partPath) > 0) {
    try {
      fs.unlinkSync(partPath);
    } catch {
      /* ignore */
    }
    startAt = 0;
  }

  let res = await openStream(url, {
    ...opts,
    timeout,
    signal,
    range: startAt > 0 ? `bytes=${startAt}-` : undefined,
  });

  // 服务器不支持 Range 时返回 200，需要从头写
  if (startAt > 0 && res.status === 200) {
    logger('服务器不支持断点续传，改为重新下载');
    startAt = 0;
    try {
      fs.unlinkSync(partPath);
    } catch {
      /* ignore */
    }
    res.stream?.destroy?.();
    res = await openStream(url, { ...opts, timeout, signal });
  }

  if (res.status === 416 && startAt > 0) {
    // 已下载部分等于完整大小，说明上一轮其实已完成
    const total = Number(/\/(\d+)\s*$/.exec(res.headers.get('content-range') || '')?.[1] || 0);
    if (total && startAt >= total) {
      const finalPath = fs.existsSync(outPath) ? uniquePath(outPath) : outPath;
      fs.renameSync(partPath, finalPath);
      return { filePath: finalPath, bytes: startAt, total, resumed: true, alreadyDone: true };
    }
  }

  if (res.status >= 400) {
    throw new Error(`下载失败：HTTP ${res.status}（${url}）`);
  }
  if (!res.stream) throw new Error('服务器未返回响应体');

  const contentLength = Number(res.headers.get('content-length') || 0);
  const rangeTotal = Number(/\/(\d+)\s*$/.exec(res.headers.get('content-range') || '')?.[1] || 0);
  const total = rangeTotal || (contentLength ? contentLength + startAt : 0);

  const meter = new ProgressMeter({ total });
  meter.setBytes(startAt);
  if (live) meter.extra = { live: true };
  logger(
    live
      ? '开始录制流（可随时结束，已录部分会保存）'
      : `开始下载${startAt > 0 ? `（续传，已完成 ${formatBytes(startAt)}）` : ''}${total ? `，共 ${formatBytes(total)}` : ''}`,
    live ? { notice: true } : undefined,
  );

  const out = fs.createWriteStream(partPath, { flags: startAt > 0 ? 'a' : 'w' });

  const onAbort = () => {
    res.stream?.destroy?.(new Error('已取消'));
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  let stopped = false;
  const recordStartedAt = Date.now();
  const endFile = () => new Promise((resolve) => out.end(() => resolve()));
  try {
    for await (const chunk of res.stream) {
      if (signal?.aborted) {
        if (gracefulStop) {
          stopped = true;
          break;
        }
        throw new Error('已取消');
      }
      if (maxLiveSeconds > 0 && (Date.now() - recordStartedAt) / 1000 >= maxLiveSeconds) {
        logger(`已达到录制时长上限（${maxLiveSeconds}s），停止录制`, { notice: true });
        stopped = true;
        break;
      }
      meter.add(chunk.length);
      if (!out.write(chunk)) {
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            out.off('drain', onDrain);
            out.off('error', onError);
          };
          const onDrain = () => {
            cleanup();
            resolve();
          };
          const onError = (err) => {
            cleanup();
            reject(err);
          };
          out.once('drain', onDrain);
          out.once('error', onError);
        });
      }
      if (meter.emit() && onProgress) onProgress(meter.snapshot());
    }
    await endFile();
  } catch (err) {
    if (signal?.aborted && gracefulStop) {
      // 「结束录制」：不丢弃已录内容，落盘后正常收尾
      stopped = true;
      await endFile();
    } else {
      out.destroy();
      if (onProgress) onProgress(meter.snapshot({ error: err.message }));
      throw err;
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  const written = fileSize(partPath);
  if (!stopped && !live && total > 0 && written !== total) {
    throw new Error(`下载不完整：期望 ${total} 字节，实际 ${written} 字节（已保留 .part，可重试续传）`);
  }

  const finalPath = fs.existsSync(outPath) ? uniquePath(outPath) : outPath;
  fs.renameSync(partPath, finalPath);
  if (stopped) logger(`录制已结束，已保存 ${formatBytes(written)}`, { notice: true });
  if (onProgress) onProgress(meter.snapshot({ done: true, stopped }));
  return {
    filePath: finalPath,
    bytes: written,
    total: total || written,
    resumed: startAt > 0,
    stopped,
    live,
    recordedSeconds: live ? Math.max(0, Math.round((Date.now() - recordStartedAt) / 1000)) : 0,
  };
}

module.exports = { downloadDirect };
