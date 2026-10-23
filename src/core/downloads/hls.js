'use strict';

/**
 * HLS(m3u8) 解析与下载。
 *
 * 支持：
 *  - 主播放列表（多码率）自动选流：best / worst / 指定高度(1080) / audio
 *  - 媒体分片并发下载、失败重试、有序落盘
 *  - AES-128 分片解密（node:crypto）
 *  - EXT-X-BYTERANGE 子范围请求
 *  - fMP4(EXT-X-MAP) 直接输出 .mp4；TS 分片可用 ffmpeg 无损转封装为 .mp4
 *  - VOD 断点续传（sidecar 记录已完成分片）
 *  - 直播流（无 EXT-X-ENDLIST）持续录制直到取消
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { fetchText, fetchBuffer, request } = require('../http');
const { ProgressMeter } = require('../progress');
const { ensureDir, fileSize, uniquePath, sleep, formatBytes } = require('../util');

// ---------------------------------------------------------------- 解析

function parseAttributes(input) {
  const out = {};
  const re = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(input))) {
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[m[1].toUpperCase()] = v;
  }
  return out;
}

function resolveUrl(base, rel) {
  try {
    return new URL(rel, base).toString();
  } catch {
    return rel;
  }
}

function parseResolution(value) {
  if (!value) return null;
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(String(value).trim());
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

function parseByteRange(value) {
  const m = /^(\d+)(?:@(\d+))?$/.exec(String(value).trim());
  if (!m) return null;
  return { length: Number(m[1]), offset: m[2] != null ? Number(m[2]) : null };
}

/** 找到下一行非注释内容（作为 URI） */
function nextUriLine(lines, from) {
  for (let i = from; i < lines.length; i += 1) {
    const l = lines[i];
    if (!l) continue;
    if (l.startsWith('#')) continue;
    return { value: l, index: i };
  }
  return null;
}

/**
 * 解析 m3u8 文本。
 * @returns {object} 播放列表结构
 */
function parseM3U8(text, baseUrl) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim());
  const pl = {
    isMaster: false,
    variants: [],
    renditions: [],
    segments: [],
    targetDuration: 6,
    mediaSequence: 0,
    hasEndList: false,
    mapUri: '',
    playlistType: '',
    version: 0,
    totalDuration: 0,
    encryption: null,
  };

  let currentKey = null;
  let currentMap = null;
  let pendingInfDuration = null;
  let pendingByteRange = null;
  let pendingDiscontinuity = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      const uri = nextUriLine(lines, i + 1);
      if (uri) {
        pl.variants.push({
          url: resolveUrl(baseUrl, uri.value),
          bandwidth: Number(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH'] || 0),
          averageBandwidth: Number(attrs['AVERAGE-BANDWIDTH'] || 0),
          resolution: parseResolution(attrs.RESOLUTION),
          codecs: attrs.CODECS || '',
          frameRate: Number(attrs['FRAME-RATE'] || 0),
          name: attrs.NAME || '',
          audioGroup: attrs.AUDIO || '',
          subtitleGroup: attrs.SUBTITLES || '',
      });
        pl.isMaster = true;
        i = uri.index;
      }
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      pl.renditions.push({
        type: attrs.TYPE || '',
        groupId: attrs['GROUP-ID'] || '',
        name: attrs.NAME || '',
        language: attrs.LANGUAGE || '',
        isDefault: String(attrs.DEFAULT || '').toUpperCase() === 'YES',
        channels: attrs.CHANNELS || '',
        url: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : '',
      });
      continue;
    }

    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      pl.targetDuration = Number(line.split(':')[1]) || pl.targetDuration;
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      pl.mediaSequence = Number(line.split(':')[1]) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-VERSION:')) {
      pl.version = Number(line.split(':')[1]) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      pl.playlistType = line.split(':')[1] || '';
      continue;
    }
    if (line.startsWith('#EXT-X-ENDLIST')) {
      pl.hasEndList = true;
      continue;
    }
    if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      pendingDiscontinuity = true;
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      const method = String(attrs.METHOD || 'NONE').toUpperCase();
      if (method === 'NONE') {
        currentKey = null;
      } else {
        currentKey = {
          method,
          uri: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : '',
          iv: attrs.IV || '',
          keyFormat: attrs.KEYFORMAT || 'identity',
        };
        if (method !== 'AES-128' && method !== 'NONE') pl.encryption = method;
      }
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      currentMap = attrs.URI ? resolveUrl(baseUrl, attrs.URI) : '';
      if (!pl.mapUri) pl.mapUri = currentMap;
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByteRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length));
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      const val = line.slice('#EXTINF:'.length).split(',')[0];
      pendingInfDuration = Number(val) || 0;
      continue;
    }
    if (line.startsWith('#')) continue;

    // 媒体分片行
    pl.segments.push({
      index: pl.segments.length,
      seq: pl.mediaSequence + pl.segments.length,
      url: resolveUrl(baseUrl, line),
      duration: pendingInfDuration || 0,
      byteRange: pendingByteRange,
      key: currentKey,
      mapUri: currentMap,
      discontinuity: pendingDiscontinuity,
    });
    pl.totalDuration += pendingInfDuration || 0;
    pendingInfDuration = null;
    pendingByteRange = null;
    pendingDiscontinuity = false;
  }

  return pl;
}

/** 按清晰度要求挑选码率分支 */
function selectVariant(playlist, quality = 'best') {
  const variants = playlist.variants.slice();
  if (!variants.length) return null;
  const heightOf = (v) => (v.resolution ? v.resolution.height : 0);
  const sortQuality = (v) => heightOf(v) * 1e6 + v.bandwidth;

  if (quality === 'audio') {
    // 优先取纯音频分支（无分辨率）
    const audioOnly = variants.filter((v) => !v.resolution);
    const pool = audioOnly.length ? audioOnly : variants;
    return pool.sort((a, b) => a.bandwidth - b.bandwidth)[0];
  }
  if (quality === 'worst') return variants.sort((a, b) => sortQuality(a) - sortQuality(b))[0];
  if (quality === 'best') return variants.sort((a, b) => sortQuality(b) - sortQuality(a))[0];

  const want = Number(String(quality).replace(/[^\d]/g, ''));
  if (!want) return variants.sort((a, b) => sortQuality(b) - sortQuality(a))[0];
  const under = variants.filter((v) => heightOf(v) > 0 && heightOf(v) <= want).sort((a, b) => sortQuality(b) - sortQuality(a));
  if (under.length) return under[0];
  return variants.sort((a, b) => sortQuality(a) - sortQuality(b))[0];
}

/** 取某个 AUDIO 组里最合适的音轨（主分支无内嵌音轨时使用） */
function selectAudioRendition(playlist, groupId) {
  const list = playlist.renditions.filter((r) => r.type === 'AUDIO' && r.url && (!groupId || r.groupId === groupId));
  if (!list.length) return null;
  const def = list.find((r) => r.isDefault) || list[0];
  return def;
}

// ---------------------------------------------------------------- 抓取辅助

function ivFromKey(key, sequence) {
  if (key && key.iv) {
    const hex = key.iv.replace(/^0x/i, '');
    if (/^[0-9a-f]+$/i.test(hex)) return Buffer.from(hex.padStart(32, '0').slice(-32), 'hex');
  }
  const buf = Buffer.alloc(16);
  buf.writeUInt32BE(sequence >>> 0, 12);
  return buf;
}

/** 创建分片解密器（AES-128-CBC + PKCS7） */
function makeDecryptor(keyBuffer, key, sequence) {
  const iv = ivFromKey(key, sequence);
  return crypto.createDecipheriv('aes-128-cbc', keyBuffer, iv);
}

// ---------------------------------------------------------------- 下载

async function fetchPlaylist(url, opts) {
  const text = await fetchText(url, {
    ...opts,
    timeout: opts.timeout || 30000,
    retries: opts.retries ?? 4,
    headers: { ...(opts.headers || {}), Accept: '*/*' },
  });
  const firstLine = text.trimStart().slice(0, 7).toUpperCase();
  if (!firstLine.startsWith('#EXTM3U')) {
    throw new Error(`不是有效的 m3u8 播放列表：${url}`);
  }
  return parseM3U8(text, url);
}

/**
 * 解析出最终可下载的媒体播放列表（自动穿透主列表）。
 * @returns {{playlist:object, playlistUrl:string, variant:object|null, audio:object|null}}
 */
async function resolveMediaPlaylist(url, opts = {}) {
  const quality = opts.quality || 'best';
  let currentUrl = url;
  let playlist = await fetchPlaylist(currentUrl, opts);
  let variant = null;

  // 仅音频：优先用主列表里独立的 AUDIO 轨，其次用无分辨率的纯音频分支
  if (quality === 'audio' && !playlist.variants.some((v) => !v.resolution)) {
    const rendition = playlist.renditions.find((r) => r.type === 'AUDIO' && r.url);
    if (rendition) {
      variant = { ...rendition, bandwidth: 0, resolution: null, audioGroup: '' };
      currentUrl = rendition.url;
      playlist = await fetchPlaylist(currentUrl, opts);
    }
  }

  for (let depth = 0; depth < 4 && playlist.isMaster; depth += 1) {
    const picked = selectVariant(playlist, quality);
    if (!picked) throw new Error('主播放列表中没有可用的码率分支');
    variant = picked;
    currentUrl = picked.url;
    playlist = await fetchPlaylist(currentUrl, opts);
  }

  let audio = null;
  if (variant && variant.audioGroup && quality !== 'audio') {
    const rendition = selectAudioRendition(playlist, variant.audioGroup);
    if (rendition && rendition.url) {
      const audioPlaylist = await fetchPlaylist(rendition.url, opts);
      audio = { rendition, url: rendition.url, playlist: audioPlaylist };
    }
  }
  return { playlist, playlistUrl: currentUrl, variant, audio };
}

/** 并发 + 有序落盘地下载一个媒体播放列表 */
async function downloadSegments(opts) {
  const {
    playlist,
    playlistUrl,
    outPath,
    concurrency = 8,
    onProgress,
    logger = () => {},
    signal,
    meter,
    label = '',
    limitSegments = 0,
    resume = true,
    segmentsOverride = null,
    appendMode = false,
    gracefulStop = false,
  } = opts;

  ensureDir(path.dirname(outPath));
  const partPath = `${outPath}.part`;
  const sidecarPath = `${partPath}.json`;

  const keyCache = new Map();
  const getKey = async (key) => {
    if (!key || !key.uri) throw new Error('分片声明了加密但没有提供密钥地址');
    if (keyCache.has(key.uri)) return keyCache.get(key.uri);
    const { buffer } = await fetchBuffer(key.uri, { ...opts, timeout: 30000, retries: 4 });
    if (!buffer || buffer.length !== 16) throw new Error(`AES-128 密钥长度异常：${buffer ? buffer.length : 0}`);
    keyCache.set(key.uri, buffer);
    return buffer;
  };

  const fetchSegment = async (seg, attempt = 0) => {
    try {
      const headers = { ...(opts.headers || {}) };
      if (seg.byteRange) {
        const offset = seg.byteRange.offset != null ? seg.byteRange.offset : 0;
        headers.Range = `bytes=${offset}-${offset + seg.byteRange.length - 1}`;
      }
      const res = await request(seg.url, {
        method: 'GET',
        headers,
        referer: opts.referer,
        userAgent: opts.userAgent,
        cookies: opts.cookies,
        cookieHeader: opts.cookieHeader,
        timeout: opts.segmentTimeout || 45000,
        retries: 0,
        wantBody: true,
        maxBodyBytes: opts.maxSegmentBytes || 256 * 1024 * 1024,
        signal,
      });
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      let buf = res.body || Buffer.alloc(0);
      if (seg.key && String(seg.key.method).toUpperCase() === 'AES-128') {
        const keyBuf = await getKey(seg.key);
        const decipher = makeDecryptor(keyBuf, seg.key, seg.seq);
        buf = Buffer.concat([decipher.update(buf), decipher.final()]);
      } else if (seg.key && String(seg.key.method).toUpperCase() !== 'NONE') {
        throw new Error(`暂不支持的分片加密方式：${seg.key.method}（请改用 yt-dlp：--engine ytdlp）`);
      }
      return buf;
    } catch (err) {
      if (signal?.aborted) throw new Error('已取消');
      if (attempt < 3) {
        await sleep(400 * (attempt + 1));
        return fetchSegment(seg, attempt + 1);
      }
      throw new Error(`分片 ${seg.index} 下载失败：${err.message}`);
    }
  };

  // 断点续传：读取 sidecar（直播追加模式下不使用）
  let startIndex = 0;
  let append = Boolean(appendMode);
  if (!appendMode && resume && fs.existsSync(partPath) && fs.existsSync(sidecarPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
      if (meta.playlistUrl === playlistUrl && meta.done > 0 && meta.done < playlist.segments.length) {
        const truncateTo = fileSize(partPath);
        if (meta.byteSize > 0 && truncateTo >= meta.byteSize) {
          fs.truncateSync(partPath, meta.byteSize);
          startIndex = meta.done;
          append = true;
          logger(`续传：跳过前 ${startIndex} 个已下载分片`);
        }
      }
    } catch {
      /* sidecar 损坏则重新开始 */
    }
  }

  const segments = segmentsOverride || (limitSegments > 0 ? playlist.segments.slice(0, limitSegments) : playlist.segments);
  if (!segments.length) throw new Error('播放列表中没有分片');

  const out = fs.createWriteStream(partPath, { flags: append ? 'a' : 'w' });
  let writtenBytes = append ? fileSize(partPath) : 0;
  let bytesSinceSidecar = 0;

  const writeChunk = (buf) =>
    new Promise((resolve, reject) => {
      if (out.write(buf)) return resolve();
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

  const saveSidecar = (done) => {
    try {
      fs.writeFileSync(sidecarPath, JSON.stringify({ playlistUrl, done, byteSize: writtenBytes, at: Date.now() }));
      bytesSinceSidecar = 0;
    } catch {
      /* ignore */
    }
  };

  // 写入 init 段（fMP4）
  if (!append && playlist.mapUri) {
    const init = await fetchSegment({ url: playlist.mapUri, index: -1, seq: 0, key: null, byteRange: null }, 0);
    await writeChunk(init);
    writtenBytes += init.length;
  }

  const windowSize = Math.max(1, Math.min(concurrency, 16));
  const pending = new Map();
  let nextFetch = startIndex;
  let nextWrite = startIndex;
  let completed = startIndex;

  const fill = () => {
    while (nextFetch < segments.length && nextFetch - nextWrite < windowSize) {
      const seg = segments[nextFetch];
      const idx = nextFetch;
      nextFetch += 1;
      pending.set(
        idx,
        fetchSegment(seg).then(
          (buf) => ({ buf }),
          (error) => ({ error }),
        ),
      );
    }
  };

  let stoppedEarly = false;
  try {
    fill();
    while (nextWrite < segments.length) {
      if (signal?.aborted) {
        if (gracefulStop) {
          stoppedEarly = true;
          break;
        }
        throw new Error('已取消');
      }
      const task = pending.get(nextWrite);
      if (!task) {
        fill();
        if (!pending.has(nextWrite)) break;
        continue;
      }
      const result = await task;
      pending.delete(nextWrite);
      if (result.error) throw result.error;
      await writeChunk(result.buf);
      writtenBytes += result.buf.length;
      bytesSinceSidecar += result.buf.length;
      completed += 1;
      nextWrite += 1;
      if (meter) {
        meter.add(result.buf.length);
        // 分片大小未知时，用已下载平均值估算总量，让进度条有意义
        if (meter.total <= 0 && completed > startIndex + 1) {
          meter.setTotal(Math.round((writtenBytes / (completed - startIndex)) * segments.length));
        }
        if (meter.emit(null) && onProgress) onProgress(meter.snapshot({ label, segments: `${completed}/${segments.length}` }));
      }
      if (bytesSinceSidecar > 4 * 1024 * 1024 && !appendMode) saveSidecar(completed);
      fill();
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    const aborted = Boolean(signal?.aborted);
    if (aborted && gracefulStop) {
      // 直播「结束录制」：把已经写下的分片落盘并正常收尾，而不是丢弃
      stoppedEarly = true;
      await new Promise((resolve) => out.end(() => resolve()));
    } else {
      if (!appendMode) saveSidecar(completed);
      out.destroy();
      meter?.emit(null, true);
      if (onProgress) onProgress(meter.snapshot({ label, error: err.message }));
      throw err;
    }
  }

  try {
    fs.unlinkSync(sidecarPath);
  } catch {
    /* ignore */
  }
  return { partPath, bytes: writtenBytes, segments: completed, stopped: stoppedEarly };
}

/**
 * 持续录制直播流：按 targetDuration 轮询播放列表，追加新分片，直到
 * 收到 EXT-X-ENDLIST、达到 maxLiveSeconds 或任务被取消。
 */
async function downloadLivePlaylist(opts) {
  const {
    url,
    targetPath,
    onProgress,
    logger = () => {},
    signal,
    meter,
    label = '',
    livePollInterval,
    maxLiveSeconds = 0,
  } = opts;

  const seen = new Set();
  let playlist = await fetchPlaylist(url, opts);
  let first = true;
  let totalBytes = 0;
  let recordedSeconds = 0;
  let stopped = false;
  const startedAt = Date.now();

  for (;;) {
    if (signal?.aborted) {
      stopped = true;
      break;
    }
    const fresh = playlist.segments.filter((s) => !seen.has(s.seq));
    if (fresh.length) {
      const res = await downloadSegments({
        ...opts,
        playlist,
        playlistUrl: url,
        outPath: targetPath,
        segmentsOverride: fresh,
        appendMode: !first,
        resume: false,
        limitSegments: 0,
        gracefulStop: true,
        meter,
        onProgress,
        logger,
        signal,
        label,
      });
      totalBytes = res.bytes;
      first = false;
      // 只把真正写完的分片记为已完成（被中断时最后一批可能只写了一部分）
      const doneNow = Math.min(res.segments, fresh.length);
      for (let i = 0; i < doneNow; i += 1) {
        seen.add(fresh[i].seq);
        recordedSeconds += fresh[i].duration || 0;
      }
      logger(`已录制 ${seen.size} 个分片（${formatBytes(totalBytes)}）`);
      if (res.stopped) {
        stopped = true;
        break;
      }
    }
    if (playlist.hasEndList) {
      logger('直播已结束（收到 EXT-X-ENDLIST）');
      break;
    }
    if (maxLiveSeconds > 0 && (Date.now() - startedAt) / 1000 >= maxLiveSeconds) {
      logger(`已达到录制时长上限（${maxLiveSeconds}s），停止录制`);
      stopped = true;
      break;
    }
    await sleep(Math.max(200, livePollInterval || (playlist.targetDuration || 6) * 1000));
    try {
      playlist = await fetchPlaylist(url, opts);
    } catch (err) {
      if (signal?.aborted) {
        stopped = true;
        break;
      }
      logger(`刷新播放列表失败，将重试：${err.message}`);
    }
  }
  return { partPath: `${targetPath}.part`, bytes: totalBytes, segments: seen.size, stopped, recordedSeconds };
}

/**
 * 用 ffmpeg 看一眼这个文件**解不解得动**：返回 true = 视频编码未知/没有视频轨。
 *
 * 专治"抖音直播录下来是 HEVC 的 FLV"：内置 ffmpeg 的 FLV demuxer 不认 enhanced-RTMP
 * 的 codec id 12，`ffmpeg -i` 只会打印 `Video: none ([12]…): unknown codec`，
 * 转封装则报 `dimensions not set` 并留下 0 字节的 .mp4。
 * 只在"转封装已经失败"之后调用，多一次 ffmpeg 调用的成本可以忽略。
 */
function detectUnknownVideoCodec(ffmpegPath, input) {
  return new Promise((resolve) => {
    if (!ffmpegPath) {
      resolve(false);
      return;
    }
    let err = '';
    let child;
    try {
      child = spawn(ffmpegPath, ['-hide_banner', '-i', input], { windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    if (!child || !child.stderr) {
      resolve(false);
      return;
    }
    if (child.stdout) child.stdout.resume();
    child.stderr.on('data', (d) => {
      if (err.length < 64000) err += d.toString();
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, 20000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(
        /Video:\s*(?:none|unknown)\b/i.test(err) ||
          /unknown codec/i.test(err) ||
          /Video codec .*is not implemented/i.test(err),
      );
    });
  });
}

/** 用 ffmpeg 无损转封装（-copyts -start_at_zero 可把直播的绝对时间轴归一到 0） */
function remuxWithFfmpeg(ffmpegPath, input, output, { signal, logger = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      input,
      '-c',
      'copy',
      '-copyts',
      '-start_at_zero',
      '-avoid_negative_ts',
      'make_zero',
      '-bsf:a',
      'aac_adtstoasc',
      output,
    ];
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    const onAbort = () => child.kill();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 转封装失败（退出码 ${code}）：${stderr.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

/** 用 ffmpeg 合并视频轨与音频轨 */
function muxWithFfmpeg(ffmpegPath, video, audio, output, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', video, '-i', audio, '-c', 'copy', '-map', '0:v:0?', '-map', '1:a:0?', output];
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    const onAbort = () => child.kill();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 合并音视频失败（退出码 ${code}）：${stderr.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

/**
 * 下载 HLS 流。
 * @param {object} opts
 * @param {string} opts.url m3u8 地址
 * @param {string} opts.outPath 目标文件（含扩展名，建议 .mp4）
 * @param {string} [opts.quality='best'] best|worst|1080|720|audio
 * @param {number} [opts.concurrency=8]
 * @param {string} [opts.ffmpegPath] 有则可转封装 / 合并音轨
 * @param {boolean} [opts.remux=true] TS 是否转封装为 mp4
 * @param {number} [opts.limitSegments] 仅下载前 N 个分片（调试/试看用）
 * @param {number} [opts.maxLiveSeconds] 直播最长录制秒数，0 表示不限
 */
async function downloadHls(opts) {
  const {
    url,
    outPath,
    quality = 'best',
    concurrency = 8,
    onProgress,
    logger = () => {},
    signal,
    ffmpegPath = null,
    remux = true,
    limitSegments = 0,
    maxLiveSeconds = 0,
    livePollInterval,
  } = opts;

  const resolved = await resolveMediaPlaylist(url, { ...opts, quality });
  const { playlist, playlistUrl, variant, audio } = resolved;

  if (!playlist.segments.length) throw new Error('播放列表中没有可用的媒体分片');
  if (playlist.encryption && playlist.encryption !== 'AES-128') {
    throw new Error(`不支持的加密方式 ${playlist.encryption}，请改用 yt-dlp 引擎`);
  }

  const isFmp4 = Boolean(playlist.mapUri);
  const live = !playlist.hasEndList;
  const recordLive = live && Boolean(opts.live);

  logger(
    `已解析播放列表：${variant && variant.resolution ? `${variant.resolution.width}x${variant.resolution.height} ` : ''}` +
      `${playlist.segments.length} 个分片${playlist.totalDuration ? `，约 ${Math.round(playlist.totalDuration)} 秒` : ''}` +
      `${isFmp4 ? '，fMP4' : '，TS'}`,
  );
  if (live && !recordLive) {
    logger(
      `这是直播流（没有 EXT-X-ENDLIST）：本次只保存当前已发布的 ${playlist.segments.length} 个分片，` +
        '如需持续录制请加 --live（或勾选界面上的直播录制选项）',
      { notice: true },
    );
  }
  if (recordLive) {
    logger(
      `已开始录制直播：可随时结束（命令行按 Ctrl+C，界面点任务上的「结束录制」），` +
        '已录制的部分会自动保存成可播放文件',
      { notice: true },
    );
  }

  const audioOnly = quality === 'audio';
  const canRemux = Boolean(remux && ffmpegPath);

  // 目标扩展名：fMP4 直接是 mp4；TS 有 ffmpeg 就转封装成 mp4，否则原样保留 .ts
  let targetPath = outPath;
  const ext = path.extname(outPath).toLowerCase();
  const desiredExt = audioOnly ? (canRemux ? '.m4a' : '.aac') : isFmp4 || canRemux ? '.mp4' : '.ts';
  if (ext !== desiredExt) {
    targetPath = outPath.replace(/\.[^.]*$/, '') + desiredExt;
  }

  const totalDuration = playlist.totalDuration;
  const meter = new ProgressMeter({ total: 0 });
  meter.extra = { label: path.basename(targetPath), duration: totalDuration, live: recordLive };

  const videoResult = recordLive
    ? await downloadLivePlaylist({
        ...opts,
        url: playlistUrl,
        targetPath,
        meter,
        onProgress,
        logger,
        signal,
        label: path.basename(targetPath),
      })
    : await downloadSegments({
        ...opts,
        playlist,
        playlistUrl,
        outPath: targetPath,
        concurrency,
        onProgress,
        logger,
        signal,
        meter,
        label: path.basename(targetPath),
        limitSegments,
        resume: opts.resume !== false,
      });

  let bytes = videoResult.bytes;
  let filePath = targetPath;
  const stopped = Boolean(videoResult.stopped);
  const recordingDone = !live || stopped || playlist.hasEndList;
  // 结束录制时 signal 已处于 aborted，转封装/合并要用「干净」的信号，否则子进程会被立刻杀掉
  const finalizeSignal = signal?.aborted ? undefined : signal;

  // 音轨分离时：先下音频，再合并
  if (audio && ffmpegPath && !limitSegments && !live) {
    logger(`检测到独立音轨（${audio.rendition.name || audio.rendition.language || 'audio'}），下载后合并`);
    const audioTmp = `${targetPath}.audio${path.extname(audio.url) === '.m4s' ? '.m4a' : '.aac'}`;
    try {
      const audioResult = await downloadSegments({
        ...opts,
        playlist: audio.playlist,
        playlistUrl: audio.url,
        outPath: audioTmp,
        concurrency,
        onProgress,
        logger,
        signal,
        meter,
        label: `${path.basename(targetPath)}（音轨）`,
        limitSegments: 0,
        resume: false,
      });
      await muxWithFfmpeg(ffmpegPath, videoResult.partPath, audioResult.partPath, filePath, { signal: finalizeSignal });
      bytes += audioResult.bytes;
      cleanup(videoResult.partPath);
      cleanup(audioResult.partPath);
    } catch (err) {
      logger(`音轨合并失败，保留无声视频：${err.message}`);
      cleanup(audioTmp);
      filePath = finalizePart(videoResult.partPath, targetPath);
    }
  } else {
    if (audio && !ffmpegPath) logger('该流音视频分离，但缺少 ffmpeg，输出可能没有声音（可运行 vgrab --fetch-ffmpeg）');
    else if (audio && live) logger('直播流音视频分离：当前只录制了画面（可用 --engine ytdlp 尝试完整录制）');
    // TS + ffmpeg → 转封装 mp4（录制结束/停止时同样适用）
    if (!isFmp4 && remux && ffmpegPath && recordingDone) {
      const mp4Path = uniquePath(targetPath.replace(/\.[^.]*$/, '') + '.mp4');
      try {
        await remuxWithFfmpeg(ffmpegPath, videoResult.partPath, mp4Path, { signal: finalizeSignal, logger });
        cleanup(videoResult.partPath);
        filePath = mp4Path;
        logger('已用 ffmpeg 无损转封装为 MP4');
      } catch (err) {
        logger(`转封装失败，保留 TS：${err.message}`);
        filePath = finalizePart(videoResult.partPath, targetPath.replace(/\.[^.]*$/, '') + '.ts');
      }
    } else if (isFmp4 && live && remux && ffmpegPath && !limitSegments && recordingDone) {
      // 直播 fMP4 直接拼接会保留直播的绝对时间轴（时长会显示成几小时），重新封装把它归一到 0
      const mp4Path = uniquePath(targetPath);
      try {
        await remuxWithFfmpeg(ffmpegPath, videoResult.partPath, mp4Path, { signal: finalizeSignal, logger });
        cleanup(videoResult.partPath);
        filePath = mp4Path;
        logger('已归一化直播时间轴');
      } catch (err) {
        logger(`时间轴归一化失败，保留原始录制文件：${err.message}`);
        filePath = finalizePart(videoResult.partPath, targetPath);
      }
    } else {
      filePath = finalizePart(videoResult.partPath, targetPath);
    }
  }

  if (stopped) {
    logger(`录制已结束，已保存 ${formatBytes(fileSize(filePath) || bytes)}`, { notice: true });
  }
  if (onProgress) {
    onProgress(meter.snapshot({ done: true, label: path.basename(filePath), stopped }));
  }
  return {
    filePath,
    bytes: fileSize(filePath) || bytes,
    segments: videoResult.segments,
    // 直播报告「实际录制时长」，点播报告播放列表时长
    duration: live && videoResult.recordedSeconds ? Math.round(videoResult.recordedSeconds) : totalDuration,
    live,
    stopped,
  };
}

function cleanup(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

/** 把 .part 文件落到最终路径（处理重名） */
function finalizePart(partPath, desiredPath) {
  const finalPath = fs.existsSync(desiredPath) ? uniquePath(desiredPath) : desiredPath;
  fs.renameSync(partPath, finalPath);
  return finalPath;
}

module.exports = {
  parseM3U8,
  selectVariant,
  selectAudioRendition,
  resolveMediaPlaylist,
  downloadHls,
  downloadSegments,
  downloadLivePlaylist,
  muxWithFfmpeg,
  remuxWithFfmpeg,
  detectUnknownVideoCodec,
  parseAttributes,
  parseResolution,
};
