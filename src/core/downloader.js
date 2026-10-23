'use strict';

/**
 * 编排层：把「探测 → 选择引擎 → 下载 → 收尾」串起来，并对外抛出统一事件。
 * CLI 与 Electron GUI 都直接使用这个类。
 *
 * 事件：
 *   'log'      (payload) 文本日志
 *   'progress' (payload) 进度快照
 *   'done'     (payload) 单个任务成功
 *   'error'    (payload) 单个任务失败
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { probe, buildFilename, normalizeUrl, isYtDlpPlatform } = require('./probe');
const { downloadDirect } = require('./downloads/direct');
const { downloadHls, resolveMediaPlaylist, muxWithFfmpeg, remuxWithFfmpeg, detectUnknownVideoCodec } = require('./downloads/hls');
const {
  ensureYtDlp,
  findYtDlp,
  findFfmpeg,
  listFormats,
  getStreamInfo,
  downloadWithYtDlp,
  downloadYtDlp,
  downloadFfmpeg,
} = require('./ytdlp');
const { loadCookiesFile } = require('./http');
const { appendHistory } = require('./history');
const { extractPageMediaViaElectron, fetchTextViaElectron, pickMediaPair } = require('./browser-page');
const { detectImagePost, resolveImagePost, pickPostImages, fetchPixivIllust, fetchPixivIllustViaMirror, downloadImages } = require('./images');
const {
  ensureDir,
  uniquePath,
  sanitizeFilename,
  fileSize,
  formatBytes,
  formatSpeed,
  formatDuration,
  randomId,
} = require('./util');
const { toolsDir, defaultDownloadDir, DEFAULTS } = require('./config');

class VideoDownloader extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      ...DEFAULTS,
      outDir: defaultDownloadDir(),
      toolsDir: toolsDir(),
      ...options,
    };
    this.tasks = new Map();
    /** 上一次浏览器兜底被风控/验证码挡住的原因（用于给出有用的报错，而不是 yt-dlp 的连接重置） */
    this.lastBlockedReason = '';
  }

  updateOptions(patch = {}) {
    this.options = { ...this.options, ...patch };
    return this.options;
  }

  log(message, taskId = null, opts = {}) {
    this.emit('log', { taskId, message: String(message), notice: Boolean(opts && opts.notice), time: Date.now() });
  }

  /** 解析链接信息（不下载） */
  async inspect(url, options = {}) {
    const opts = { ...this.options, ...options };
    const target = normalizeUrl(url);
    const cookies = this.#cookies(opts);
    const info = await probe(target, { ...opts, cookies });
    return info;
  }

  /** 用 yt-dlp 列出可选格式（站点支持的清晰度） */
  async formats(url, options = {}) {
    const opts = { ...this.options, ...options };
    const ytDlpPath = await ensureYtDlp({
      toolsDir: opts.toolsDir,
      explicitPath: opts.ytDlpPath,
      autoDownload: opts.autoDownloadYtDlp,
      onProgress: (p) => this.emit('progress', { taskId: null, stage: 'setup', ...p }),
      signal: opts.signal,
      logger: (m) => this.log(m),
    });
    if (!ytDlpPath) return { engine: 'builtin', formats: [], message: '未安装 yt-dlp，请使用内置引擎或先获取 yt-dlp' };
    const ffmpegPath = findFfmpeg({ toolsDir: opts.toolsDir, explicitPath: opts.ffmpegPath });
    return {
      engine: 'ytdlp',
      ffmpeg: ffmpegPath || null,
      ...(await listFormats(url, { ...opts, ytDlpPath, ffmpegPath })),
    };
  }

  /** 首次使用：准备 yt-dlp（GUI 与 CLI 都可调用） */
  async setupYtDlp(options = {}) {
    const opts = { ...this.options, ...options };
    return ensureYtDlp({
      toolsDir: opts.toolsDir,
      explicitPath: opts.ytDlpPath,
      autoDownload: true,
      onProgress: (p) => this.emit('progress', { taskId: null, stage: 'setup', label: 'yt-dlp', ...p }),
      signal: opts.signal,
      logger: (m) => this.log(m),
    });
  }

  /** 强制重新获取 yt-dlp */
  async updateYtDlp(options = {}) {
    const opts = { ...this.options, ...options };
    return downloadYtDlp({
      toolsDir: opts.toolsDir,
      onProgress: (p) => this.emit('progress', { taskId: null, stage: 'setup', label: 'yt-dlp', ...p }),
      signal: opts.signal,
      logger: (m) => this.log(m),
    });
  }

  /** 获取 ffmpeg（可选组件） */
  async setupFfmpeg(options = {}) {
    const opts = { ...this.options, ...options };
    return downloadFfmpeg({
      toolsDir: opts.toolsDir,
      onProgress: (p) => this.emit('progress', { taskId: null, stage: 'setup', label: 'ffmpeg', ...p }),
      signal: opts.signal,
      logger: (m) => this.log(m),
    });
  }

  status() {
    const opts = this.options;
    const ytDlp = findYtDlp({ toolsDir: opts.toolsDir, explicitPath: opts.ytDlpPath });
    const ffmpeg = findFfmpeg({ toolsDir: opts.toolsDir, explicitPath: opts.ffmpegPath });
    return {
      toolsDir: opts.toolsDir,
      outDir: this.options.outDir || defaultDownloadDir(),
      ytDlp: ytDlp || null,
      ffmpeg: ffmpeg || null,
    };
  }

  #cookies(opts) {
    if (opts.cookies && Array.isArray(opts.cookies)) return opts.cookies;
    if (opts.cookiesFile) {
      try {
        return loadCookiesFile(opts.cookiesFile);
      } catch (err) {
        this.log(`读取 cookies 文件失败：${err.message}`);
      }
    }
    return [];
  }

  /**
   * 下载一个链接。
   * @param {string} url
   * @param {object} options
   * @returns {Promise<object>} 结果对象（不会抛出，失败时 ok=false）
   */
  async download(url, options = {}) {
    const opts = { ...this.options, ...options };
    const taskId = opts.taskId || randomId('task');
    this.lastBlockedReason = '';
    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const signal = controller.signal;
    const startedAt = Date.now();
    const task = { id: taskId, url, controller, state: 'running', startedAt };
    const targetUrl = normalizeUrl(url) || url;
    this.tasks.set(taskId, task);

    const emitProgress = (payload) => {
      this.emit('progress', {
        taskId,
        url,
        engine: task.engine || null,
        title: task.title || '',
        ...payload,
      });
    };
    const log = (message, opts) => this.log(message, taskId, opts);

    try {
      const cookies = this.#cookies(opts);
      log(`解析链接：${url}`);
      emitProgress({ stage: 'probe', percent: -1, message: '解析链接' });

      const outDir = opts.outDir || defaultDownloadDir();
      ensureDir(outDir);

      // 图片帖（Pixiv 插画 / 抖音图文）走图片通道，不再找视频流。
      //
      // ⚠️ 这一段**必须在预探测之前**：pixiv.net 在大陆直连不通（没配代理时），
      // 而 pixiv 的图片帖判定根本不需要访问 pixiv.net（认链接就够），
      // 放在探测之后会出现"预探测先超时失败 → 任务直接失败 → 免代理取图那条路根本没机会跑"。
      // 抖音 App 里复制出来的是分享短链（v.douyin.com/xxx），要先跟随跳转才知道是不是图文。
      const imagePost = await resolveImagePost(targetUrl, {
        userAgent: opts.userAgent,
        cookies,
        headers: opts.headers,
        signal,
        onLog: log,
      });
      if (imagePost && opts.engine !== 'ytdlp') {
        task.engine = 'image';
        log(
          `识别为${imagePost.kind === 'pixiv' ? 'Pixiv 插画' : '抖音图文'}，将下载页面里的图片`,
          { notice: true },
        );
        emitProgress({ stage: 'probe', percent: -1, message: '获取图片地址' });
        return await this.#downloadImages(imagePost, {
          ...opts,
          outDir,
          baseName: opts.name || '',
          cookies,
          signal,
          task,
          emitProgress,
          log,
          startedAt,
        });
      }

      // 已知站点（YouTube / B站 / 抖音…）直接交给 yt-dlp：预探测没有意义，
      // 而且国内直连这些域名常被重置，先去请求只会失败并掩盖 yt-dlp 的真实提示。
      const knownYtDlpPath = findYtDlp({ toolsDir: opts.toolsDir, explicitPath: opts.ytDlpPath });
      const mayUseYtDlp = Boolean(knownYtDlpPath) || opts.autoDownloadYtDlp !== false;
      let info;
      if (opts.engine !== 'builtin' && mayUseYtDlp && isYtDlpPlatform(url)) {
        log('该站点由 yt-dlp 直接解析（跳过预探测）', { notice: true });
        info = {
          url,
          finalUrl: url,
          type: 'page',
          contentType: '',
          contentLength: 0,
          filename: '',
          title: '',
          candidates: [],
          skippedProbe: true,
        };
      } else {
        info = await probe(url, { ...opts, cookies, signal });
      }
      task.info = info;
      task.title = info.title || '';
      log(`识别为 ${describeType(info.type)}${info.contentLength ? `，大小约 ${formatBytes(info.contentLength)}` : ''}`);

      const ytDlpPath = findYtDlp({ toolsDir: opts.toolsDir, explicitPath: opts.ytDlpPath });
      const ffmpegPath = findFfmpeg({ toolsDir: opts.toolsDir, explicitPath: opts.ffmpegPath });
      const builtinCandidate =
        info.resolved || (info.candidates || []).find((c) => c.type === 'hls' || c.type === 'direct');
      // 选流策略：直链/HLS 用内置引擎；网页若已装 yt-dlp 交给它（清晰度更全），否则抓网页内嵌地址；
      // dash/api/未知类型只能靠 yt-dlp。
      const wantsYtDlp =
        opts.engine === 'ytdlp' ||
        (opts.engine === 'auto' &&
          (info.type === 'dash' ||
            info.type === 'api' ||
            info.type === 'unknown' ||
            (info.type === 'page' && (Boolean(ytDlpPath) || !builtinCandidate))));
      if (opts.engine === 'builtin' && !builtinCandidate && !['direct', 'hls'].includes(info.type)) {
        throw new Error('已强制使用内置引擎，但该链接无法直接解析（网页中没有可下载的媒体地址）');
      }

      const baseName = sanitizeFilename(opts.name || info.filename?.replace(/\.[a-z0-9]{2,5}$/i, '') || info.title || 'video', 'video');

      // ---- yt-dlp 通道
      if (wantsYtDlp) {
        let bin = ytDlpPath;
        if (!bin && opts.autoDownloadYtDlp) {
          log('未检测到 yt-dlp，正在自动获取...');
          bin = await ensureYtDlp({
            toolsDir: opts.toolsDir,
            autoDownload: true,
            onProgress: (p) => emitProgress({ stage: 'setup', label: 'yt-dlp', ...p }),
            signal,
            logger: log,
          });
        }
        if (bin) {
          task.engine = 'ytdlp';
          emitProgress({ stage: 'download', percent: 0, message: 'yt-dlp 下载中' });
          /**
           * 抖音**短链**（`v.douyin.com/xxxxx`）先走内置浏览器。
           *
           * 为什么（2026-10-17 真实现场）：yt-dlp 不认这种短码，会退化成 generic 提取器，
           * 拿普通 UA 去 GET 那个短链 —— 抖音直接把连接重置（10054），
           * 报出来的是一大串 "Unable to download webpage / ConnectionResetError"，
           * 群友看到的是一句"这个视频没下下来"。而内置浏览器跟一个 302 就到了
           * `www.douyin.com/video|note/<id>`，视频/图文/直播三种都能处理。
           * 所以这类链接**先给浏览器**，它不行再退回 yt-dlp。
           */
          const shortPage = info.finalUrl || url;
          if (!looksLikeLiveUrl(shortPage) && isDouyinShortLink(shortPage) && opts.browserAssist !== false) {
            log('这是抖音短链，先用内置浏览器打开（yt-dlp 不认这种短码）', { notice: true });
            try {
              const early = await this.#tryBrowserAssist(shortPage, info, {
                ...opts,
                outDir,
                baseName,
                cookies,
                signal,
                ffmpegPath,
                task,
                emitProgress,
                log,
                startedAt,
              });
              if (early) return early;
            } catch (err) {
              if (signal.aborted) throw err;
              log(`内置浏览器这条路没走通（${String(err.message).split('\n')[0]}），改试 yt-dlp`, { notice: true });
            }
          }
          // 直播页面（如 live.bilibili.com）交给内置录制引擎，才能随时结束并保存成可播放文件
          let liveDetected = false;
          if (looksLikeLiveUrl(info.finalUrl || url) || opts.live) {
            try {
              const streamInfo = await getStreamInfo(info.finalUrl || url, {
                ...opts,
                ytDlpPath: bin,
                ffmpegPath,
                cookies,
                signal,
                logger: log,
              });
              if (streamInfo.isLive) {
                liveDetected = true;
                const recorded = await this.#recordLiveStream(info.finalUrl || url, info, streamInfo, {
                  ...opts,
                  outDir,
                  baseName,
                  cookies,
                  signal,
                  ffmpegPath,
                  task,
                  emitProgress,
                  log,
                  startedAt,
                });
                if (recorded) return recorded;
              }
            } catch (err) {
              if (signal.aborted) throw err;
              log(`直播信息查询失败，按普通方式处理：${String(err.message).split('\n')[0]}`);
            }
          }
          // 已经确认是直播、而且调用方给了录制上限（`--live-seconds`）时，**绝不**再退回 yt-dlp：
          // yt-dlp 对直播是一路录到流结束，没有任何时长概念 —— 调用方只能等到超时被杀，
          // 留下一坨 `.part`（真实现场：213MB 的 `.flv.part`，群里只收到"下载超时"）。
          // 宁可明确报错，也不让用户干等十分钟。
          if (liveDetected && Number(opts.maxLiveSeconds) > 0) {
            throw new Error(
              `直播录制失败：内置录制引擎没能拉到该流（已放弃，避免退化成无限录制）。可稍后重试，或把「直播最长录制秒数」调大`,
            );
          }
          try {
            const result = await downloadWithYtDlp({
              ...opts,
              url: info.finalUrl || url,
              outDir,
              outName: opts.name ? baseName : undefined,
              ytDlpPath: bin,
              ffmpegPath,
              cookies,
              signal,
              playlist: opts.playlist,
              onProgress: (p) => emitProgress({ stage: 'download', ...patchProgress(p) }),
              onSetupProgress: (p) => emitProgress({ stage: 'setup', label: 'ffmpeg', ...p }),
              onLine: (line) => this.emit('ytdlp:line', { taskId, line }),
              logger: log,
            });
            return this.#finish(taskId, {
              filePath: result.filePath,
              bytes: result.bytes,
              engine: 'ytdlp',
              title: info.title,
              startedAt,
            });
          } catch (err) {
            if (signal.aborted) throw err;
            log(`yt-dlp 没能解析这个链接：${String(err.message).split('\n')[0]}`);
            // 兜底：用内置浏览器渲染页面，直接抓播放器请求的视频地址
            const rescued = await this.#tryBrowserAssist(info.finalUrl || url, info, {
              ...opts,
              outDir,
              baseName,
              cookies,
              signal,
              ffmpegPath,
              task,
              emitProgress,
              log,
              startedAt,
            });
            if (rescued) return rescued;
            // 浏览器被风控挡住时，报"要人机验证"比报 yt-dlp 那串连接重置有用得多
            if (this.lastBlockedReason) throw new Error(this.lastBlockedReason);
            throw err;
          }
        }
        // 没有 yt-dlp 时退回内置引擎
        if (builtinCandidate) {
          log('yt-dlp 不可用，改用网页内嵌的媒体地址');
          return await this.#downloadBuiltin(info, builtinCandidate, {
            ...opts,
            outDir,
            baseName,
            cookies,
            signal,
            referer: info.finalUrl || url,
            ffmpegPath,
            task,
            emitProgress,
            log,
            startedAt,
          });
        }
        throw new Error(
          info.type === 'page' || info.type === 'api'
            ? '该链接需要 yt-dlp 解析（网页中没有可直接下载的媒体地址）。请允许自动获取 yt-dlp，或手动执行 vgrab --update-ytdlp'
            : `暂不支持的类型：${info.type}`,
        );
      }

      // ---- 内置引擎通道
      if (info.type === 'direct') {
        task.engine = 'direct';
        return await this.#downloadBuiltin(info, { url: info.finalUrl || url, type: 'direct' }, {
          ...opts,
          outDir,
          baseName,
          cookies,
          signal,
          ffmpegPath,
          task,
          emitProgress,
          log,
          startedAt,
        });
      }
      if (info.type === 'hls') {
        task.engine = 'hls';
        return await this.#downloadBuiltin(info, { url: info.finalUrl || url, type: 'hls' }, {
          ...opts,
          outDir,
          baseName,
          cookies,
          signal,
          ffmpegPath,
          task,
          emitProgress,
          log,
          startedAt,
        });
      }
      if (builtinCandidate) {
        task.engine = builtinCandidate.type === 'hls' ? 'hls' : 'direct';
        return await this.#downloadBuiltin(info, builtinCandidate, {
          ...opts,
          outDir,
          baseName,
          cookies,
          signal,
          referer: info.finalUrl || url,
          ffmpegPath,
          task,
          emitProgress,
          log,
          startedAt,
        });
      }
      throw new Error(`没有可用的下载方式（类型：${info.type}）`);
    } catch (err) {
      const message = signal.aborted ? '已取消' : err.message || String(err);
      task.state = signal.aborted ? 'cancelled' : 'failed';
      this.tasks.delete(taskId);
      const payload = {
        taskId,
        url,
        ok: false,
        error: message,
        cancelled: signal.aborted,
        engine: task.engine || null,
        title: task.title || '',
        durationMs: Date.now() - startedAt,
      };
      // 没有监听者时不要抛出未处理的 'error' 事件（调用方以返回值判断即可）
      if (this.listenerCount('error') > 0) this.emit('error', payload);
      this.#recordHistory({
        id: taskId,
        url: task.url || url,
        title: task.title || '',
        ok: false,
        error: message,
        cancelled: signal.aborted,
        engine: task.engine || '',
        elapsedMs: payload.durationMs,
        at: Date.now(),
      });
      return payload;
    }
  }

  /** 写入下载历史（失败不影响主流程），并通知界面刷新 */
  #recordHistory(record) {
    if (this.options.recordHistory === false) return;
    try {
      const limit = this.options.historyLimit;
      appendHistory(
        {
          ...record,
          outDir: this.options.outDir,
          quality: this.options.quality,
        },
        limit,
      )
        .then((records) => this.emit('history', { record, count: Array.isArray(records) ? records.length : 0 }))
        .catch(() => {});
    } catch {
      /* 历史写不进去不影响下载 */
    }
  }

  /**
   * 给"不是普通链接下载"的流程也记一笔历史（比如界面里的 Pixiv 搜图 / 挑图下载）。
   *
   * Pixiv 那条路不走 `download()`，原来信息只在日志里 —— 「下载记录」栏里看不到它。
   * 这里把同样的"写历史 + 通知界面刷新"暴露出来，行为与普通下载一致
   * （照样受 `recordHistory` / `historyLimit` 两个选项约束）。
   */
  recordHistory(record = {}) {
    this.#recordHistory({ engine: 'pixiv', ok: true, ...record });
  }

  /** 构造「用内置浏览器渲染页面」的执行器（GUI 用进程内，CLI 用拉起 Electron） */
  #makePageRunner(opts, signal) {
    if (typeof opts.extractPageMedia === 'function') {
      // 把「是否要真正加载图片」（图文帖需要）也透传给上层实现
      return (u, onLog) => opts.extractPageMedia(u, onLog, { loadImages: Boolean(opts.loadImages) });
    }
    const appRoot = opts.appRoot;
    if (!appRoot) return null;
    return (u, onLog) =>
      extractPageMediaViaElectron({
        appRoot,
        url: u,
        waitSec: opts.browserWaitSec || 8,
        onLog,
        signal,
        electronPath: opts.electronPath,
        loadImages: Boolean(opts.loadImages),
        scroll: Boolean(opts.scroll),
        // 登录态一起带进抓流浏览器：不然抖音这类站点会给个「验证码中间页」
        cookies: opts.cookies,
      });
  }

  /**
   * 生成「用内置浏览器请求接口」的执行器（pixiv 前面有 Cloudflare，Node 直接请求会被 403）。
   * GUI 里直接复用同一个 Chromium；命令行则拉起 Electron 辅助进程。
   */
  #makeBrowserFetchRunner(opts, signal) {
    if (typeof opts.fetchViaBrowser === 'function') {
      return (url, pageUrl) => opts.fetchViaBrowser(url, pageUrl);
    }
    const appRoot = opts.appRoot;
    if (!appRoot) return null;
    return (url, pageUrl) =>
      fetchTextViaElectron({ appRoot, url, pageUrl, onLog: () => {}, signal, electronPath: opts.electronPath });
  }

  /** 下载图片帖（Pixiv 插画 / 抖音图文）：图片存到以标题命名的子目录，按 001、002 编号 */
  async #downloadImages(imagePost, ctx) {
    const { outDir, baseName, cookies, cookieHeader, signal, task, emitProgress, log, startedAt } = ctx;
    const opts = ctx;
    // 动图要转 GIF，得知道 ffmpeg 在哪（调用方没传就自己找一份）
    const ffmpegPath = ctx.ffmpegPath || findFfmpeg({ toolsDir: opts.toolsDir, explicitPath: opts.ffmpegPath });

    let title = baseName;
    let items = [];
    // 动图（图文帖里那几张）：每项 {url: 动画 mp4, still: 静态首帧, durationSec, ...}
    let animations = [];
    let referer = '';
    // Pixiv 分级（0 全年龄 / 1 成人向）。反代那条路拿不到分级时按 0 处理并在日志里说明，
    // 供 QQ Agent 插件那种"群里不该出现成人向"的场景做二次判断。
    let pixivRating = 0;

    if (imagePost.kind === 'pixiv') {
      log(`识别为 Pixiv 插画（id=${imagePost.id}），获取原图地址...`, { notice: true });
      const source = String(opts.pixivSource || 'auto');
      const viaOfficial = async () => {
        const browserFetch = this.#makeBrowserFetchRunner(opts, signal);
        return fetchPixivIllust(imagePost.id, {
          cookies,
          cookieHeader,
          signal,
          headers: opts.headers,
          userAgent: opts.userAgent,
          retries: opts.retries,
          browserFetch,
          apiBase: opts.pixivApiBase,
          onLog: log,
        });
      };
      const viaMirror = async () =>
        fetchPixivIllustViaMirror(imagePost.id, {
          signal,
          userAgent: opts.userAgent,
          onLog: log,
          mirrorBase: opts.pixivMirrorBase,
          apiBase: opts.pixivApiBase,
        });

      let info;
      if (source === 'api') {
        info = await viaOfficial();
      } else if (source === 'mirror') {
        log('按设置只用「反代」取图');
        info = await viaMirror();
      } else {
        // auto（默认）：**先反代**。它不需要代理、响应快、给的就是原图；
        // 官方那条路只在反代拿不到时兜底（比如作品不在反代索引里、或反代临时挂了）。
        try {
          info = await viaMirror();
        } catch (err) {
          log(`反代取图失败（${err.message}），改用官方接口（需要代理/登录）...`, { notice: true });
          info = await viaOfficial();
        }
      }
      title = sanitizeFilename(opts.name || info.title || `pixiv-${imagePost.id}`, `pixiv-${imagePost.id}`);
      items = info.urls.map((url) => ({ url }));
      // 反代不需要 Referer（实测带不带都 200），官方 pximg 需要
      referer = info.source === 'mirror' ? '' : 'https://www.pixiv.net/';
      pixivRating = Number(info.xRestrict) > 0 ? 1 : 0;
      log(
        `作品「${info.title || imagePost.id}」${info.author ? ` by ${info.author}` : ''}：共 ${items.length} 张` +
          `${info.source === 'mirror' ? '（经反代，无需代理）' : ''}` +
          `${info.illustType === 2 ? '（动图 ugoira，将保存为图片帧）' : ''}` +
          `${pixivRating ? ' ⚠️成人向' : ''}`,
        { notice: true },
      );
    } else {
      // 抖音图文：靠内置浏览器渲染后收集正文图片
      // 轮播图是懒加载的：要等久一点、并且真正加载图片，才能拿到正文图而不是低清预览图
      const runner = this.#makePageRunner(
        { ...opts, browserWaitSec: Math.max(Number(opts.browserWaitSec) || 8, 12), loadImages: true },
        signal,
      );
      if (!runner) throw new Error('抖音图文需要内置浏览器，但当前环境没有可用的浏览器');
      log('识别为抖音图文帖，正在用内置浏览器渲染页面收集图片...', { notice: true });
      emitProgress({ stage: 'probe', percent: -1, message: '渲染图文页面' });
      const data = await runner(imagePost.url, log);
      const images = pickPostImages((data && data.images) || []);
      // 动图：结构化数据里带 videoUrl 的那几张（url_list 只是静态首帧）
      animations = Array.isArray(data && data.animations) ? data.animations : [];
      if (!images.length && !animations.length) throw new Error('页面里没有找到可下载的图片');
      title = sanitizeFilename(
        String(opts.name || (data && data.title) || imagePost.id)
          .replace(/\s*[-—|]\s*(抖音|小红书|TikTok|快手)\s*$/u, '')
          .replace(/\s*[-—|]\s*抖音直播\s*$/u, '')
          .slice(0, 120),
        imagePost.id,
      );
      items = images;
      referer = (data && data.finalUrl) || imagePost.url;
      log(
        `图文帖「${(data && data.title) || imagePost.id}」：共 ${items.length} 张图片` +
          `${animations.length ? `、${animations.length} 张动图` : ''}`,
        { notice: true },
      );
    }

    if (!items.length && !animations.length) throw new Error('没有找到可下载的图片');

    const targetDir = outDir;
    const result = items.length
      ? await downloadImages({
          items,
          outDir: targetDir,
          baseName: title,
          referer,
          cookies,
          cookieHeader,
          userAgent: opts.userAgent,
          headers: opts.headers,
          signal,
          concurrency: Math.max(1, Math.min(4, opts.concurrency || 3)),
          logger: log,
          // Pixiv 接口给的是原图地址，不需要探大小；页面抓来的要过滤掉表情/图标
          verifySizes: imagePost.kind !== 'pixiv',
          minImageBytes: opts.minImageBytes,
          onProgress: (p) => emitProgress({ stage: 'download', ...patchProgress(p) }),
        })
      : { files: [], failed: [], bytes: 0, total: 0, dir: targetDir };

    if (items.length) {
      log(`图片下载完成：${result.files.length}/${result.total} 张，共 ${formatBytes(result.bytes)}`, { notice: true });
      if (result.failed.length) {
        log(`有 ${result.failed.length} 张失败（例如：${result.failed[0].error}）`);
      }
    }

    // 动图：下那段 mp4 → 转 GIF（QQ 里才会动）。失败保留 mp4，当视频发
    let animFiles = [];
    let animBytes = 0;
    if (animations.length) {
      const got = await this.#downloadAnimations(animations, {
        outDir: result.files.length > 1 ? result.dir : targetDir,
        baseName: title,
        referer,
        cookies,
        cookieHeader,
        userAgent: opts.userAgent,
        headers: opts.headers,
        ffmpegPath,
        signal,
        log,
        emitProgress,
      });
      animFiles = got.files;
      animBytes = got.bytes;
    }

    // 全部失败时不能算成功
    if (!result.files.length && !animFiles.length) {
      throw new Error(`没有下载到任何图片：${result.failed.length ? result.failed[0].error : '没有可下载的图片'}`);
    }
    const allFiles = [...result.files, ...animFiles];
    const finalPath = allFiles.length === 1 ? allFiles[0] : result.dir || targetDir;
    return this.#finish(task.id, {
      filePath: finalPath,
      bytes: result.bytes,
      engine: 'image',
      title,
      // 供插件/脚本判断（如"群里不要发成人向"）：0 全年龄 / 1 成人向
      pixivRating: imagePost.kind === 'pixiv' ? pixivRating : 0,
      pixivSource: imagePost.kind === 'pixiv' ? (referer ? 'api' : 'mirror') : '',
      startedAt,
    });
  }

  /**
   * 兜底方案：用内置浏览器（Chromium）渲染页面，监听播放器发出的视频请求，
   * 拿到真正的视频地址后用内置下载器下载。
   * 适用于抖音这类「yt-dlp 尚未支持签名」或强反爬的站点。
   */
  async #tryBrowserAssist(pageUrl, info, ctx) {
    const { outDir, baseName, signal, task, emitProgress, log, startedAt } = ctx;
    const opts = { ...ctx };
    if (opts.browserAssist === false) return null;

    // 图集/长文类页面（B 站专栏、opus 文章等）：图片是懒加载的，必须真正加载图片并把整页滚一遍，
    // 否则只能抓到开头那几张。这类页面本来也没有视频流，直接按图文模式渲染即可。
    const articleLike = isArticleLikeUrl(pageUrl);
    if (articleLike) {
      opts.loadImages = true;
      opts.scroll = true;
      opts.browserWaitSec = Math.max(Number(opts.browserWaitSec) || 8, 10);
      log('这看起来是图文/专栏页，将加载图片并滚动整页以收集全部配图');
    }

    const runner = this.#makePageRunner(opts, signal);
    if (!runner) {
      log('（当前环境没有可用的内置浏览器，跳过渲染兜底）');
      return null;
    }

    log('改用内置浏览器渲染页面，抓取播放器请求的视频地址...');
    emitProgress({ stage: 'probe', percent: -1, message: '用内置浏览器渲染页面' });
    let data;
    try {
      data = await runner(pageUrl, log);
    } catch (err) {
      if (signal.aborted) throw new Error('已取消');
      log(`内置浏览器渲染失败：${err.message}`);
      return null;
    }
    // 直播页面上往往同时有「直播连续流」和几秒钟的「预览 mp4」，直播场景要优先前者
    const liveIntent = Boolean(opts.live) || Number(opts.maxLiveSeconds) > 0 || looksLikeLiveUrl(pageUrl);
    const pair = pickMediaPair(data && data.media, { preferLive: liveIntent });
    /**
     * 这条页面是不是**图文帖**？它是"要不要去抓页面里的图片"的总开关，必须在任何使用点之前算好
     * （2026-10-17 踩过：声明写在下面的分支里，结果 B 站专栏一进来就 `Cannot access 'isNotePost'
     *  before initialization` —— TDZ 报错，而且是"所有没有视频流的页面"全挂）。
     * 判定来源：① 页面里的结构化数据 `notePost`（抖音 aweme detail）；② URL 本身是 note 页。
     */
    const isNotePost = Boolean(data && data.notePost === true) || Boolean(detectImagePost(pageUrl));
    // 站点风控/人机验证页：不要把它当成正常页面（否则会把验证码图片当成正文图存下来）
    const pageTitle = String((data && data.title) || '');
    const pageText = String((data && data.bodyText) || '');
    if (/验证码|安全验证|人机验证|滑动验证|访问异常|环境异常|captcha|just a moment|attention required|access denied|verify you are human|bot detection/i.test(`${pageTitle} ${pageText}`)) {
      /**
       * 风控页要**明确报出来**，不能让上层退回 yt-dlp 再抛一串 "ConnectionResetError" ——
       * 那样群里只会看到"这个视频没下下来"，用户完全不知道该怎么办（2026-10-17 真实现场）。
       */
      const hint =
        `站点要求人机验证（标题：${pageTitle || '验证码页'}）：这台机器上用桌面版工具的内置浏览器` +
        '打开一次该站点、把验证过掉（需要登录的顺手登录），之后就会带着这份 cookie 正常下载';
      this.lastBlockedReason = hint;
      log(hint, { notice: true });
      return null;
    }
    if (!pair.video || (data && data.notePost === true)) {
      // 没有视频流时，看看是不是图文帖（抖音图文等）
      // ⚠️ 只有"确认是图文帖/专栏页"才去抓页面图片：普通视频页里没抓到视频时，
      // 页面上那些图全是头像/封面/推荐流缩略图，抓下来就成了"下载了无关图"（2026-10-17 现场）。
      const images = isNotePost || articleLike ? pickPostImages((data && data.images) || []) : [];
      // 图文帖里的**动图**：结构化数据里带 videoUrl 的那几张（见 browser-page.js）
      const animations = Array.isArray(data && data.animations) ? data.animations : [];
      if (images.length || animations.length) {
        log(
          `页面里没有视频流，但发现 ${images.length} 张图片${animations.length ? `、${animations.length} 张动图` : ''}，按图文帖下载`,
          { notice: true },
        );
        const imageTitle = sanitizeFilename(
          String(data.title || info.title || baseName || pageUrl)
            .replace(/\s*[-—|]\s*(抖音|小红书|TikTok)\s*$/u, '')
            .slice(0, 120),
          baseName || 'images',
        );
        const result = await downloadImages({
          items: images,
          outDir,
          baseName: imageTitle,
          referer: data.finalUrl || pageUrl,
          cookies: ctx.cookies,
          cookieHeader: opts.cookieHeader,
          userAgent: opts.userAgent,
          headers: opts.headers,
          signal,
          concurrency: Math.max(1, Math.min(4, opts.concurrency || 3)),
          logger: log,
          // 页面里混着头像/图标/表情等小图（B 站专栏尤其多），先探一下大小再下
          verifySizes: true,
          minImageBytes: opts.minImageBytes,
          onProgress: (p) => emitProgress({ stage: 'download', ...patchProgress(p) }),
        }).catch((err) => {
          if (animations.length) {
            log(`静态图没下成（继续下动图）：${err.message}`);
            return { files: [], failed: [], bytes: 0, total: 0, dir: outDir };
          }
          throw err;
        });
        if (images.length) {
          log(`图片下载完成：${result.files.length}/${result.total} 张，共 ${formatBytes(result.bytes)}`, { notice: true });
        }
        // 一张都没下下来就别报「完成」——那会让人以为存了东西
        if (!result.files.length && !animations.length) {
          const why = result.failed && result.failed.length ? result.failed[0].error : '没有可下载的图片';
          throw new Error(`没有下载到任何图片：${why}`);
        }

        // 动图：下的是那段 mp4，转成 GIF 才能"动"（QQ 里 webp 动图显示不稳，gif 最保险）
        let animFiles = [];
        let animBytes = 0;
        if (animations.length) {
          const animDir = result.files.length > 1 ? result.dir : outDir;
          const got = await this.#downloadAnimations(animations, {
            outDir: animDir,
            baseName: imageTitle,
            referer: data.finalUrl || pageUrl,
            cookies: ctx.cookies,
            cookieHeader: opts.cookieHeader,
            userAgent: opts.userAgent,
            headers: opts.headers,
            ffmpegPath: ctx.ffmpegPath,
            signal,
            log,
            emitProgress,
          });
          animFiles = got.files;
          animBytes = got.bytes;
        }

        const allFiles = [...result.files, ...animFiles];
        const finalPath = allFiles.length === 1 ? allFiles[0] : animFiles.length && !result.files.length ? animFiles[0] : result.dir || outDir;
        return this.#finish(task.id, {
          filePath: finalPath,
          bytes: result.bytes + animBytes,
          engine: 'image',
          title: imageTitle,
          startedAt,
        });
      }
      log('页面里没有发现可下载的视频或图片地址');
      return null;
    }
    log(`抓到视频地址：${pair.video.url.slice(0, 90)}...`);
    if (pair.audio) log('同时抓到独立音轨，将合并为完整视频');

    const rawTitle = String(data.title || info.title || baseName || 'video')
      .replace(/\s*[-—|]\s*抖音\s*$/u, '')
      .slice(0, 120);
    const title = sanitizeFilename(rawTitle, baseName || 'video');
    const outPath = this.#resolveOutPath(outDir, title, '.mp4', opts.overwrite);
    const tmpSuffix = `${Date.now()}`;

    /**
     * 抖音的「图文帖」里**经常混着视频**（一条帖子几张图 + 一段视频）。
     *
     * 原来的逻辑是"有视频就只下视频"，于是那几张配图被整个忽略（用户 2026-10-17 报）。
     * 现在：视频照旧下，若正文区域还收着配图，就把它们下到同一个目录，并把**目录**
     * 交给上层（插件那边会把视频和图片一起发出去）。
     *
     * ⚠️ 但**只有确认是图文帖**才附带配图（`notePost` 来自结构化数据，或 URL 本身就是
     * note 页）。否则普通视频页里的"图片"全是头像/封面/推荐流缩略图 ——
     * 2026-10-17 第二条报障：一条抖音视频下完之后，文件夹里多出 14 张毫不相干的图。
     *
     * （`isNotePost` 在上面统一算好了，这里直接复用 —— 别再就地声明，会踩 TDZ。）
     */
    const postImages = isNotePost ? pickPostImages((data && data.images) || []) : [];
    const finalizeVideo = async (videoPath, meta = {}) => {
      const baseBytes = Number(meta.bytes) || fileSize(videoPath) || 0;
      if (!postImages.length) return this.#finish(task.id, { ...meta, filePath: videoPath, bytes: baseBytes });
      const dir = path.dirname(videoPath);
      try {
        emitProgress({ stage: 'download', percent: -1, message: '下载图文里的配图' });
        const r = await downloadImages({
          items: postImages,
          outDir: dir,
          baseName: `${title}（配图）`,
          referer: data.finalUrl || pageUrl,
          cookies: ctx.cookies,
          cookieHeader: opts.cookieHeader,
          userAgent: opts.userAgent,
          headers: opts.headers,
          signal,
          concurrency: Math.max(1, Math.min(4, opts.concurrency || 3)),
          logger: log,
          verifySizes: true,
          minImageBytes: opts.minImageBytes,
          onProgress: (p) => emitProgress({ stage: 'download', ...patchProgress(p) }),
        });
        log(`这条帖子除了视频还有 ${r.files.length} 张配图，已一起存到 ${dir}`, { notice: true });
        return this.#finish(task.id, { ...meta, filePath: dir, bytes: baseBytes + (r.bytes || 0) });
      } catch (err) {
        log(`配图下载失败（视频照发）：${err.message}`);
        return this.#finish(task.id, { ...meta, filePath: videoPath, bytes: baseBytes });
      }
    };

    // 页面里抓到的是播放列表 → 交给 HLS 引擎（点播照常下载，直播则持续录制）
    const captured = pair.video.url;
    const looksHls = /\.m3u8/i.test(captured) || /m3u8/i.test(captured);
    const looksFlv = /\.flv(\?|$)/i.test(captured) || /\/flv\//i.test(captured) || /[?&]flv/i.test(captured);
    if (looksHls) {
      const hlsPath = this.#resolveOutPath(outDir, title, '.mp4', opts.overwrite);
      log('抓到的是 m3u8 播放列表，改用 HLS 引擎处理（直播会持续录制）');
      const result = await downloadHls({
        ...opts,
        url: captured,
        outPath: hlsPath,
        quality: opts.quality || 'best',
        ffmpegPath: ctx.ffmpegPath,
        signal,
        cookies: ctx.cookies,
        referer: data.finalUrl || pageUrl,
        live: true,
        concurrency: opts.concurrency,
        onProgress: (p) => emitProgress({ stage: 'download', ...patchProgress(p) }),
        logger: log,
      });
      return finalizeVideo(result.filePath, {
        bytes: result.bytes,
        engine: 'hls',
        title,
        startedAt,
        live: result.live,
        stopped: result.stopped,
        durationSec: result.duration,
      });
    }

    // FLV 等连续流（抖音直播常见）：边收边写，结束录制时收尾保存
    if (looksFlv) {
      const flvPath = this.#resolveOutPath(outDir, title, '.flv', opts.overwrite);
      log('抓到的是连续流（FLV），按直播录制处理：可随时结束并保存', { notice: true });
      const result = await downloadDirect({
        ...opts,
        url: captured,
        outPath: flvPath,
        live: true,
        gracefulStop: true,
        resume: false,
        referer: data.finalUrl || pageUrl,
        signal,
        onProgress: (p) => emitProgress({ stage: 'download', ...patchProgress(p) }),
        logger: log,
      });
      let filePath = result.filePath;
      if (ctx.ffmpegPath) {
        const mp4Path = uniquePath(flvPath.replace(/\.[^.]*$/, '') + '.mp4');
        try {
          await remuxWithFfmpeg(ctx.ffmpegPath, result.filePath, mp4Path, {
            signal: signal?.aborted ? undefined : signal,
            logger: log,
          });
          cleanupFile(result.filePath);
          filePath = mp4Path;
        } catch (err) {
          // 转封装失败最常见的原因是源流是 HEVC(H.265) 的 FLV（enhanced-RTMP）：
          // 内置 ffmpeg 的 FLV demuxer 不认 codec id 12，转出来是 "dimensions not set"。
          // 这种情况下**绝不能**把 .flv 当成品返回（QQ 播不了，群友只会看到"下载出错"）。
          const hevc = await detectUnknownVideoCodec(ctx.ffmpegPath, result.filePath);
          cleanupFile(mp4Path);
          if (hevc) {
            cleanupFile(result.filePath);
            throw new Error(
              '这个直播是 HEVC(H.265) 编码的 FLV，内置 ffmpeg 解不开（enhanced-RTMP 未支持），' +
                '已放弃以免发出播不了的文件。稍后重试通常会自动改抓 H.264 流',
            );
          }
          log(`转封装失败，保留 FLV：${err.message}`);
        }
      }
      return finalizeVideo(filePath, {
        engine: 'stream',
        title,
        startedAt,
        live: true,
        stopped: result.stopped,
        durationSec: result.recordedSeconds || 0,
      });
    }

    // 视频轨：先落到临时文件（可能需要和音轨合并）
    const videoTmp = path.join(outDir, `.vgrab-video-${tmpSuffix}.mp4`);
    const videoResult = await downloadDirect({
      ...opts,
      url: pair.video.url,
      outPath: videoTmp,
      referer: data.finalUrl || pageUrl,
      signal,
      onProgress: (p) => emitProgress({ stage: 'download', ...patchProgress(p) }),
      logger: log,
    });

    let filePath = videoResult.filePath;
    const audioTmp = path.join(outDir, `.vgrab-audio-${tmpSuffix}.m4a`);

    if (pair.audio && ctx.ffmpegPath) {
      try {
        emitProgress({ stage: 'probe', percent: -1, message: '下载音轨' });
        await downloadDirect({
          ...opts,
          url: pair.audio.url,
          outPath: audioTmp,
          referer: data.finalUrl || pageUrl,
          signal,
          onProgress: (p) => emitProgress({ stage: 'download', ...patchProgress(p) }),
          logger: log,
        });
        await muxWithFfmpeg(ctx.ffmpegPath, videoResult.filePath, audioTmp, outPath, { signal });
        cleanupFile(videoResult.filePath);
        cleanupFile(audioTmp);
        filePath = outPath;
        log('已用 ffmpeg 合并音视频');
      } catch (err) {
        log(`音轨合并失败（保留无声视频）：${err.message}`);
        cleanupFile(audioTmp);
        const renamed = uniquePath(outPath);
        fs.renameSync(videoResult.filePath, renamed);
        filePath = renamed;
      }
    } else {
      if (pair.audio && !ctx.ffmpegPath) {
        log('注意：该视频音视频分离，但本机没有 ffmpeg，结果可能没有声音（vgrab --fetch-ffmpeg 可自动获取）');
      }
      const renamed = uniquePath(outPath);
      fs.renameSync(videoResult.filePath, renamed);
      filePath = renamed;
    }

    log('已通过内置浏览器方式完成下载');
    return finalizeVideo(filePath, {
      engine: 'browser',
      title,
      startedAt,
    });
  }

  /**
   * 下载图文帖里的**动图**。
   *
   * 抖音图文帖的"动图"在结构化数据里是一段 2~3 秒的 **mp4**（`images[i].video`），
   * 而 `url_list` 里那串 `~tplv-dy-aweme-images:q75.webp` 只是**静态首帧** ——
   * 以前我们只下首帧，于是动图都变成了普通图片（2026-10-17 用户报）。
   *
   * 这里把 mp4 下下来，再用 ffmpeg 转成 **GIF**（QQ 里 gif 一定动；webp 动图显示不稳）。
   * 没有 ffmpeg 或转换失败就保留 mp4，上层会当视频发出去 —— 总比丢掉强。
   */
  async #downloadAnimations(list, ctx) {
    const { outDir, baseName, referer, cookies, cookieHeader, userAgent, headers, ffmpegPath, signal, log, emitProgress } = ctx;
    const items = (list || []).filter((x) => x && x.url);
    if (!items.length) return { files: [], bytes: 0 };
    const dir = items.length > 1 ? path.join(outDir, `${sanitizeFilename(baseName || 'post', 'post')}（动图）`) : outDir;
    ensureDir(dir);
    const files = [];
    let bytes = 0;
    for (let i = 0; i < items.length; i += 1) {
      if (signal?.aborted) break;
      const stem = String(i + 1).padStart(3, '0');
      const mp4 = path.join(dir, `${stem}.mp4`);
      try {
        emitProgress({ stage: 'download', percent: -1, message: `下载动图 ${i + 1}/${items.length}` });
        const got = await downloadDirect({
          url: items[i].url,
          outPath: mp4,
          resume: false,
          referer,
          cookies,
          cookieHeader,
          userAgent,
          headers,
          signal,
          timeout: 60000,
          onProgress: (p) => emitProgress({ stage: 'download', ...patchProgress(p) }),
          logger: log,
        });
        bytes += fileSize(got.filePath) || 0;
        if (ffmpegPath) {
          const gif = path.join(dir, `${stem}.gif`);
          try {
            await toGif(ffmpegPath, got.filePath, gif, { signal, log });
            cleanupFile(got.filePath);
            files.push(gif);
            continue;
          } catch (err) {
            log(`动图 ${i + 1} 转 GIF 失败（保留 mp4 当视频发）：${String(err.message).split('\n')[0]}`);
          }
        } else {
          log('没有 ffmpeg，动图只能按 mp4 保存', { notice: true });
        }
        files.push(got.filePath);
      } catch (err) {
        log(`动图 ${i + 1} 下载失败：${String(err.message).split('\n')[0]}`);
      }
    }
    if (files.length) log(`动图下载完成：${files.length}/${items.length} 张`, { notice: true });
    return { files, bytes };
  }

  /**
   * 直播录制：yt-dlp 已解析出直播信息，改由内置引擎拉流，从而支持「随时结束并保存」。
   * 优先 HLS（m3u8，可直接转封装 MP4），其次 FLV 等连续流。
   */
  async #recordLiveStream(pageUrl, info, streamInfo, ctx) {
    const { signal, log } = ctx;
    const opts = ctx;
    const title = sanitizeFilename(opts.name || streamInfo.title || info.title || ctx.baseName || 'live', 'live');

    // 按清晰度等级从高到低尝试（原画失败就退蓝光/超清，避免个别流被 CDN 或权限挡住就整体失败）
    const ranked = rankLiveFormats(streamInfo.formats || [], opts.quality).slice(0, 4);
    if (!ranked.length) {
      log('该直播没有可直接拉取的流地址（仍交给 yt-dlp 录制，取消时可能留下不完整文件）', { notice: true });
      return null;
    }

    let lastError = null;
    for (const picked of ranked) {
      if (signal.aborted) throw new Error('已取消');
      const isHls = /m3u8/i.test(picked.protocol) || /\.m3u8/i.test(picked.url);
      const qualityLabel = picked.note || picked.formatId || '';
      log(
        `识别为直播流「${(streamInfo.title || '').slice(0, 40)}」，已切换到内置录制引擎（${isHls ? 'HLS' : 'FLV'}${qualityLabel ? ` · ${qualityLabel}` : ''}），` +
          '可随时结束并保存成可播放文件',
        { notice: true },
      );
      try {
        return await this.#recordWithFormat(picked, ctx, { pageUrl, title, isHls });
      } catch (err) {
        if (signal.aborted) throw err;
        lastError = err;
        log(`「${qualityLabel || '该流'}」拉取失败（${String(err.message).split('\n')[0]}），尝试下一档清晰度...`, { notice: true });
      }
    }
    log(`所有直播流都拉取失败：${lastError ? String(lastError.message).split('\n')[0] : '未知原因'}`, { notice: true });
    return null;
  }

  /** 用指定的一条流录制直播 */
  async #recordWithFormat(picked, ctx, { pageUrl, title, isHls }) {
    const { outDir, cookies, signal, ffmpegPath, task, emitProgress, log, startedAt } = ctx;
    const opts = ctx;

    if (isHls) {
      const outPath = this.#resolveOutPath(outDir, title, '.mp4', opts.overwrite);
      const result = await downloadHls({
        ...opts,
        url: picked.url,
        outPath,
        quality: opts.quality || 'best',
        ffmpegPath,
        signal,
        cookies,
        referer: pageUrl,
        live: true,
        concurrency: opts.concurrency,
        onProgress: (p) => emitProgress({ stage: 'download', ...patchProgress(p) }),
        logger: log,
      });
      return this.#finish(task.id, {
        filePath: result.filePath,
        bytes: result.bytes,
        engine: 'hls',
        title,
        startedAt,
        live: true,
        stopped: result.stopped,
        durationSec: result.duration,
      });
    }

    // FLV 等连续流：直接边收边写，结束录制时收尾保存
    const isFlv = /flv/i.test(picked.ext) || /\.flv/i.test(picked.url) || /flv/i.test(picked.protocol);
    const ext = isFlv ? '.flv' : '.ts';
    const outPath = this.#resolveOutPath(outDir, title, ext, opts.overwrite);
    const result = await downloadDirect({
      ...opts,
      url: picked.url,
      outPath,
      live: true,
      gracefulStop: true,
      resume: false,
      referer: pageUrl,
      cookies,
      signal,
      onProgress: (p) => emitProgress({ stage: 'download', ...patchProgress(p) }),
      logger: log,
    });

    let filePath = result.filePath;
    if (ffmpegPath) {
      // 有 ffmpeg 就顺手转成 MP4，播放器兼容性更好
      const mp4Path = uniquePath(outPath.replace(/\.[^.]*$/, '') + '.mp4');
      try {
        const finalizeSignal = signal?.aborted ? undefined : signal;
        await remuxWithFfmpeg(ffmpegPath, result.filePath, mp4Path, { signal: finalizeSignal, logger: log });
        cleanupFile(result.filePath);
        filePath = mp4Path;
        log('已用 ffmpeg 转封装为 MP4');
      } catch (err) {
        log(`转封装失败，保留原始 ${ext} 文件：${err.message}`);
      }
    }

    return this.#finish(task.id, {
      filePath,
      bytes: fileSize(filePath),
      engine: 'stream',
      title,
      startedAt,
      live: true,
      stopped: result.stopped,
      durationSec: result.recordedSeconds || 0,
    });
  }

  async #downloadBuiltin(info, target, ctx) {
    const { outDir, baseName, cookies, signal, ffmpegPath, task, emitProgress, log, startedAt, referer } = ctx;
    const opts = ctx;
    const quality = opts.quality || 'best';

    if (target.type === 'hls') {
      // 预览播放列表，决定扩展名与真实标题
      const resolved = await resolveMediaPlaylist(target.url, {
        ...opts,
        cookies,
        signal,
        referer: referer || info.finalUrl,
        quality,
      });
      const pl = resolved.playlist;
      const isFmp4 = Boolean(pl.mapUri);
      const audioOnly = quality === 'audio';
      const isLive = !pl.hasEndList;
      if (isLive) {
        // 直播流的容器与标题按录制场景处理
        log(isLive && opts.live ? '检测到直播流，开始持续录制' : '检测到直播流', { notice: true });
      }
      let ext = audioOnly ? (isFmp4 ? '.m4a' : '.aac') : isFmp4 || ffmpegPath ? '.mp4' : '.ts';
      if (pl.segments.length && pl.hasEndList) log(`分片数 ${pl.segments.length}，时长约 ${formatDuration(pl.totalDuration)}`);
      const outPath = this.#resolveOutPath(outDir, baseName, ext, opts.overwrite);
      const result = await downloadHls({
        ...opts,
        url: target.url,
        outPath,
        quality,
        ffmpegPath,
        signal,
        cookies,
        referer: referer || info.finalUrl,
        live: opts.live,
        limitSegments: opts.limitSegments,
        concurrency: opts.concurrency,
        onProgress: (p) => emitProgress({ stage: 'download', ...patchProgress(p) }),
        logger: log,
      });
      return this.#finish(task.id, {
        filePath: result.filePath,
        bytes: result.bytes,
        engine: 'hls',
        title: info.title,
        startedAt,
        live: result.live,
        stopped: result.stopped,
        durationSec: result.duration,
      });
    }

    // 直链
    const ext = path.extname(baseName) || extFromInfo(info);
    const cleanBase = sanitizeFilename(baseName.replace(/\.[a-z0-9]{2,5}$/i, ''), 'video');
    const outPath = this.#resolveOutPath(outDir, cleanBase, ext || '.mp4', opts.overwrite);
    const result = await downloadDirect({
      ...opts,
      url: target.url,
      outPath,
      cookies,
      referer: referer || undefined,
      signal,
      concurrency: opts.concurrency,
      onProgress: (p) => emitProgress({ stage: 'download', ...patchProgress(p) }),
      logger: log,
    });
    return this.#finish(task.id, {
      filePath: result.filePath,
      bytes: result.bytes,
      engine: 'direct',
      title: info.title,
      startedAt,
    });
  }

  #resolveOutPath(outDir, baseName, ext, overwrite) {
    const name = sanitizeFilename(baseName, 'video');
    const fileName = /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}${ext}`;
    const desired = path.join(outDir, fileName);
    return overwrite ? desired : uniquePath(desired);
  }

  #finish(taskId, { filePath, bytes, engine, title, startedAt, live, stopped, durationSec, pixivRating, pixivSource }) {
    const task = this.tasks.get(taskId);
    if (task) task.state = 'done';
    this.tasks.delete(taskId);
    const payload = {
      taskId,
      ok: true,
      filePath,
      fileName: path.basename(filePath),
      bytes: bytes || fileSize(filePath),
      engine,
      title: title || path.basename(filePath),
      durationMs: Date.now() - startedAt,
      live: Boolean(live),
      stopped: Boolean(stopped),
      durationSec: durationSec || 0,
      // Pixiv 专用：分级（0 全年龄 / 1 成人向）与取图来源（mirror/api）。
      // 给 QQ Agent 插件这类"群里不该出现成人向"的场景做二次判断用。
      ...(pixivRating === undefined ? {} : { pixivRating }),
      ...(pixivSource ? { pixivSource } : {}),
    };
    this.emit('done', payload);
    this.#recordHistory({
      id: taskId,
      url: (task && task.url) || '',
      title: payload.title,
      fileName: payload.fileName,
      filePath,
      engine,
      bytes: payload.bytes,
      durationSec: payload.durationSec,
      elapsedMs: payload.durationMs,
      live: payload.live,
      stopped: payload.stopped,
      ok: true,
      at: Date.now(),
    });
    return payload;
  }

  /** 取消任务 */
  cancel(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    task.state = 'cancelling';
    task.controller.abort();
    return true;
  }

  cancelAll() {
    for (const id of [...this.tasks.keys()]) this.cancel(id);
  }
}

// ---------------------------------------------------------------- 辅助

/** 删除临时文件（失败时忽略） */
function cleanupFile(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

/**
 * 把一段短视频（图文帖里的"动图"其实是 2~3 秒的 mp4）转成 GIF。
 *
 * 为什么是 GIF 而不是保留 webp/mp4：QQ 里 gif 一定会动，动图 webp 显示不稳；
 * mp4 则会被当成"视频"发，和"动图"的观感差别太大。
 *
 * ⚠️ 体积必须管住：一开始按 540px/12fps 转，一个 3 秒动图就 7MB+（实测），
 * 群里发图既慢又浪费。所以这里按「480px/10fps → 360px/8fps → 240px/6fps」逐档降，
 * 直到文件 ≤ maxBytes（默认 2.5MB）为止 —— 动图本来就不需要高清。
 */
async function toGif(ffmpegPath, input, output, { signal, log = () => {}, maxBytes = 2.5 * 1024 * 1024 } = {}) {
  const attempts = [
    { maxSide: 480, fps: 10, bayer: 5 },
    { maxSide: 360, fps: 8, bayer: 6 },
    { maxSide: 240, fps: 6, bayer: 6 },
  ];
  for (let i = 0; i < attempts.length; i += 1) {
    const a = attempts[i];
    const vf =
      `fps=${a.fps},scale='min(${a.maxSide},iw)':'min(${a.maxSide},ih)':force_original_aspect_ratio=decrease:flags=lanczos,` +
      `split[x][y];[x]palettegen=stats_mode=diff[p];[y][p]paletteuse=dither=bayer:bayer_scale=${a.bayer}`;
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-t', '10', '-i', input, '-vf', vf, '-loop', '0', output];
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(ffmpegPath, args, { windowsHide: true });
      } catch (err) {
        reject(err);
        return;
      }
      let stderr = '';
      child.stderr?.on('data', (d) => {
        if (stderr.length < 4000) stderr += d.toString();
      });
      const onAbort = () => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      child.once('error', (err) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(err);
      });
      child.once('close', (code) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (code === 0 && fileSize(output) > 0) resolve();
        else {
          cleanupFile(output);
          reject(new Error(`ffmpeg 转 GIF 失败（退出码 ${code}）：${stderr.trim().split('\n').slice(-2).join(' | ')}`));
        }
      });
    });
    const size = fileSize(output);
    if (size <= maxBytes || i === attempts.length - 1) {
      log(`动图已转成 GIF（${a.maxSide}px/${a.fps}fps，${formatBytes(size)}）`);
      return output;
    }
  }
  return output;
}

/** URL 看起来像直播页面（用于决定是否值得先花一次 yt-dlp 解析去确认直播状态） */
function looksLikeLiveUrl(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    if (/^live\./.test(host)) return true;
    if (/live\.(bilibili|douyin|kuaishou|huya|douyu|qq)\.com$/.test(host)) return true;
    if (/\/(live|lives|liveroom|live_room)(\/|$)/.test(path)) return true;
    if (/twitch\.tv$/.test(host)) return true;
    if (/youtube\.com$/.test(host) && /\/live/.test(path)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * 抖音**短链**（`v.douyin.com/<短码>`）：yt-dlp 不认这种码，会退化成 generic 提取器，
 * 然后被抖音重置连接（10054，报一大串 ConnectionResetError）。这类链接先交给内置浏览器 ——
 * 它跟着 302 就到了 `www.douyin.com/video|note/<id>`，视频/图文/直播都能处理。
 */
function isDouyinShortLink(u) {
  try {
    const host = new URL(u).hostname.toLowerCase();
    return host === 'v.douyin.com' || host === 'v.iesdouyin.com' || /^v[-a-z0-9]*\.douyin\.com$/.test(host);
  } catch {
    return false;
  }
}

/**
 * URL 看起来像「图文 / 长文 / 图集」页面（B 站专栏 cv、opus，小红书笔记，微博头条等）。
 * 这类页面的图片几乎都是懒加载的，需要真正加载图片 + 滚动整页才能抓全。
 */
function isArticleLikeUrl(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    // B 站专栏是 /read/cv123456（后面直接跟数字，所以用 \b 而不是 /）
    if (/\/read\b/.test(path)) return true;
    if (/\/(opus|article|articles|note|notes|post|posts|status|detail|discovery)\b/.test(path)) return true;
    if (/^mp\.weixin\.qq\.com$/.test(host)) return true;
    if (/zhuanlan\.zhihu\.com$/.test(host)) return true;
    if (/xiaohongshu\.com$/.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * 直播清晰度等级（B 站等站点的直播格式常常拿不到宽高/码率，
 * 只能用 yt-dlp 的 format_note / format_id 判断，例如「原画 / 蓝光 / 超清 / 高清」）。
 * 数值参考 B 站直播的 qn：原画 10000、蓝光 400、超清 250、高清 150、流畅 80。
 */
const LIVE_QUALITY_RULES = [
  [/杜比|dolby/i, 30000],
  [/4k|2160/i, 20000],
  [/原画|source|original/i, 10000],
  [/蓝光|blue[_-]?ray/i, 400],
  [/超清|ultra[_-]?high/i, 250],
  [/高清|high[_-]?res|\bhd\b/i, 150],
  [/流畅|low[_-]?res|smooth/i, 80],
];

function liveQualityRank(f) {
  const text = `${f.formatId || ''} ${f.note || ''}`;
  for (const [re, rank] of LIVE_QUALITY_RULES) {
    if (re.test(text)) return rank;
  }
  return 0;
}

/** 按清晰度等级从高到低排序（原画 > 4K > 杜比 > 蓝光 > 超清 > 高清 > 流畅） */
function rankLiveFormats(formats, quality) {
  const list = (formats || []).filter((f) => f && f.url);
  let pool = list;
  // 用户指定了具体高度（如 -q 720）且这些流带分辨率信息时，按其上限过滤
  const want = Number(String(quality || '').replace(/[^\d]/g, ''));
  if (want > 0) {
    const withHeight = list.filter((f) => f.height > 0);
    if (withHeight.length) {
      const under = withHeight.filter((f) => f.height <= want);
      if (under.length) pool = under;
    }
  }
  return pool.slice().sort((a, b) => liveFormatScore(b) - liveFormatScore(a));
}

function liveFormatScore(f) {
  const isHls = /m3u8/i.test(f.protocol) || /\.m3u8/i.test(f.url);
  let s = liveQualityRank(f) * 10000; // 清晰度等级优先，避免「超清」压过「原画」
  s += (f.height || 0) * 10;
  s += Math.min(f.tbr || 0, 20000) / 100;
  if (isHls) s += 500; // 同级里 HLS 能边录边转封装，结束录制更干净
  if (/^(avc|h264)/i.test(f.vcodec)) s += 50; // 兼容性最好
  return s;
}

/** 在直播的多个格式里挑一条最适合录制的流：优先最高清晰度等级，同级优先 HLS、H.264 */
function pickLiveFormat(formats) {
  return rankLiveFormats(formats)[0] || null;
}

function describeType(type) {
  return (
    {
      direct: '直链媒体文件',
      hls: 'HLS(m3u8) 流',
      dash: 'DASH(mpd) 流',
      page: '网页',
      api: '接口响应',
      unknown: '未知资源',
    }[type] || type
  );
}

function hasUsableCandidate(info) {
  return Boolean(info.candidates && info.candidates.some((c) => (c.type === 'hls' || c.type === 'direct') && c.url));
}

function extFromInfo(info) {
  const map = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a' };
  return map[info.contentType] || '.mp4';
}

/** 把内部进度快照整理成对外事件字段 */
function patchProgress(p = {}) {
  return {
    percent: typeof p.percent === 'number' ? p.percent : -1,
    bytes: p.bytes || 0,
    total: p.total || 0,
    speed: p.speed || 0,
    eta: p.eta || -1,
    segments: p.segments,
    label: p.label,
    live: Boolean(p.live),
    stopped: Boolean(p.stopped),
    done: Boolean(p.done),
    message: p.done
      ? p.stopped
        ? '录制已结束'
        : '完成'
      : `${formatBytes(p.bytes || 0)}${p.total ? ` / ${formatBytes(p.total)}` : ''}${p.speed ? ` · ${formatSpeed(p.speed)}` : ''}${
          p.eta > 0 ? ` · 剩余 ${formatDuration(p.eta)}` : ''
        }`,
  };
}

module.exports = { VideoDownloader, describeType, hasUsableCandidate, looksLikeLiveUrl, pickLiveFormat, rankLiveFormats };
