#!/usr/bin/env node
'use strict';

/**
 * 命令行入口：vgrab / video-dl
 *
 *   vgrab <链接...>                 下载视频（自动识别直链 / m3u8 / 网页）
 *   vgrab --formats <链接>          列出站点可用清晰度（需要 yt-dlp）
 *   vgrab --info <链接>             只探测，不下载
 *   vgrab --batch urls.txt          批量下载（每行一个链接）
 *   vgrab --doctor                  环境自检
 *   vgrab --update-ytdlp            重新获取 yt-dlp
 *   vgrab --fetch-ffmpeg            获取 ffmpeg（可选，用于合并音视频）
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const pkg = require('../package.json');
const { VideoDownloader } = require('./core/downloader');
const { toolsDir, defaultDownloadDir, loginCookiesFile, hasLoginCookies } = require('./core/config');
const { clearHistory, historyFile } = require('./core/history');
const { extractUrls } = require('./core/extract-urls');
const {
  formatBytes,
  formatSpeed,
  formatDuration,
  envProxyUrl,
  systemProxyUrl,
  sanitizeFilename,
  fileSize,
} = require('./core/util');

/**
 * 让内置 HTTP 层也走代理。
 * 代理来源优先级：--proxy 参数 → 环境变量（HTTPS_PROXY 等）→ Windows 系统代理。
 * 系统代理这一项很关键：浏览器能打开 pixiv 靠的就是它，Node 自带的 fetch 完全不认。
 */
/**
 * 当前**实际生效**的代理（命令参数 > 环境变量 > 系统代理），没配就返回空。
 * 给失败文案用：让群友一眼看出"是代理没配"还是"代理配了但不通"。
 */
function currentProxyLabel() {
  try {
    const flagIndex = process.argv.indexOf('--proxy');
    const flagProxy = flagIndex >= 0 && flagIndex + 1 < process.argv.length ? process.argv[flagIndex + 1] : '';
    const explicit = String(flagProxy || '').trim();
    if (explicit) return explicit;
    const fromEnv = String(envProxyUrl() || '').trim();
    if (fromEnv) return `${fromEnv}（环境变量）`;
    const fromSystem = String(systemProxyUrl() || '').trim();
    if (fromSystem) return `${fromSystem}（系统代理）`;
  } catch {
    /* 探测失败就当没有 */
  }
  return '无';
}

function ensureProxySupport() {
  const flagIndex = process.argv.indexOf('--proxy');
  const flagProxy = flagIndex >= 0 && flagIndex + 1 < process.argv.length ? process.argv[flagIndex + 1] : '';
  const explicit = String(flagProxy || '').trim();
  const fromEnv = String(envProxyUrl() || '').trim();
  let proxy = explicit || fromEnv;
  let source = explicit ? '命令参数' : fromEnv ? '环境变量' : '';
  let fromSystem = '';
  if (!proxy) {
    fromSystem = String(systemProxyUrl() || '').trim();
    if (fromSystem) {
      proxy = fromSystem;
      source = '系统代理';
    }
  }
  if (!proxy) return false;
  try {
    const { setHttpProxy } = require('./core/http');
    setHttpProxy(proxy);
    if (source === '系统代理') {
      console.log(`ⓘ 检测到${source} ${proxy}，内置下载引擎将走它（浏览器能打开的站点，这里也能打开）`);
    }
    return true;
  } catch (err) {
    console.error(`✖ 代理不可用：${err.message}`);
    return false;
  }
}

const HELP = `
肥鱼当劳（ds-download）v${pkg.version} — 支持直链 / HLS(m3u8) / 各类视频站点

用法：
  dsdl <链接...> [选项]        （dsdl / ds-download / vgrab / video-dl 都是同一个命令）

常用选项：
  -o, --out <目录>          保存目录（默认：${defaultDownloadDir()}）
  -q, --quality <档位>      清晰度：best(默认) | 2160 | 1080 | 720 | 480 | worst | audio
      --codec <编码>        编码偏好：h264(默认，兼容性最好) | hevc | av1 | best(画质优先)
  -n, --name <文件名>       指定输出文件名（不含扩展名）
  -e, --engine <引擎>       auto(默认) | builtin | ytdlp
  -c, --concurrency <n>     分片并发数（HLS，默认 8）
      --cookies <文件>      Netscape 格式 cookies.txt
      --cookies-from-browser <浏览器>  从浏览器读取 cookie（chrome/edge/firefox...）
      --proxy <地址>        代理，如 http://127.0.0.1:7890
      --referer <地址>      自定义 Referer
      --ua <字符串>         自定义 User-Agent
      --header <K:V>        追加请求头（可重复）
      --overwrite           允许覆盖同名文件（默认自动改名）
      --live                直播流持续录制（不加则只保存当前已发布的分片）
      --live-seconds <n>    直播最长录制秒数，到时自动结束并保存（默认为 0＝一直录到手动结束）
      --limit-segments <n>  仅下载前 n 个分片（试看 / 调试用）
      --parallel <n>        同时下载多个链接（默认 1）

信息与工具：
      --info                只解析链接信息，不下载
      --formats             列出可选清晰度/格式（需要 yt-dlp）
      --doctor              检查 yt-dlp / ffmpeg / 网络环境
      --check-proxy         代理自检：分别用直连与代理探测几个站点，给出明确结论
      --pixiv-search <关键词> 搜 Pixiv 插画并下载（用公开检索接口 + pixiv.re 反代，**不需要代理**）
                             ⚠️ 配了代理时：公开接口和反代**仍然直连**（不受代理影响），
                             只有下面那个「原生搜索」兜底会走代理
                             没搜到会自动改用 Pixiv 原生搜索（那一步需要能连上 pixiv.net）
      --no-pixiv-native      关掉上面的原生搜索兜底
      --pixiv-node-failover  原生搜索被代理重置时，自动切到「能连 pixiv」的节点再试一次
                             （会改 Clash 代理组的选择，默认关）
      --count <数量>         搜索时下载几个作品（默认 3，**没有硬上限**；不是 -n，-n 是 --name）
      --exclude-pids <pids>  已经发过的作品 pid（逗号分隔），搜图时跳过（插件自动传）
      --r18                 搜索时允许成人向作品（默认只出全年龄；群聊里别开）
      --list-only           只列出搜索结果，不下载
      --pixiv-source <来源>  Pixiv 取图来源：auto（默认，先官方接口再自动退回反代）/ api / mirror
      --login [站点|网址]   用内置浏览器登录任意站点：bilibili / douyin / youtube / x /
                            instagram / zhihu / youku …，也可以直接给网址或域名
                            （如 vgrab --login example.com）；可逐个登录多个站点，
                            登录状态一直保留并自动按域名带上；不带参数时列出全部内置站点
      --logout              删除保存的登录状态
      --history [条数]      查看下载历史（默认最近 20 条，可指定条数/在界面里设置）
      --history-clear       清空下载历史
      --update-ytdlp        重新下载 yt-dlp
      --fetch-ffmpeg        下载 ffmpeg（约 30MB，可选）
      --tools-dir <目录>    指定 yt-dlp/ffmpeg 存放目录
      --no-auto-ytdlp       禁用「缺少 yt-dlp 时自动下载」
      --no-auto-ffmpeg      禁用「需要合并音视频时自动获取 ffmpeg」
      --no-browser-assist   禁用「解析不了时用内置浏览器渲染页面抓视频」

输出控制：
      --json                以 JSON 输出结果（便于脚本处理）
  -v, --verbose             打印详细日志
      --quiet               只输出错误
  -h, --help                显示帮助
  -V, --version             显示版本

示例：
  vgrab "https://example.com/video.mp4"
  vgrab "https://example.com/master.m3u8" -q 1080 -o D:\\影片
  vgrab "https://www.bilibili.com/video/BVxxxx" -q 720
  vgrab --login bilibili            # 先登录，之后下 1080P+/大会员内容
  vgrab --batch urls.txt --parallel 2
`;

function parseArgs(argv) {
  const opts = {
    urls: [],
    headers: {},
    quality: 'best',
    engine: 'auto',
    concurrency: 8,
    parallel: 1,
    overwrite: false,
    live: false,
    json: false,
    verbose: false,
    quiet: false,
  };
  const need = (i, name) => {
    if (i + 1 >= argv.length) throw new Error(`选项 ${name} 缺少参数`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-V':
      case '--version':
        opts.version = true;
        break;
      case '-o':
      case '--out':
        opts.outDir = need(i, a);
        i += 1;
        break;
      case '-q':
      case '--quality':
        opts.quality = need(i, a);
        i += 1;
        break;
      case '-n':
      case '--name':
        opts.name = need(i, a);
        i += 1;
        break;
      case '-e':
      case '--engine':
        opts.engine = need(i, a);
        i += 1;
        break;
      case '-c':
      case '--concurrency':
        opts.concurrency = Math.max(1, Number(need(i, a)) || 8);
        i += 1;
        break;
      case '--parallel':
        opts.parallel = Math.max(1, Number(need(i, a)) || 1);
        i += 1;
        break;
      case '--cookies':
        opts.cookiesFile = path.resolve(need(i, a));
        i += 1;
        break;
      case '--cookies-from-browser':
        opts.cookiesFromBrowser = need(i, a);
        i += 1;
        break;
      case '--proxy':
        opts.proxy = need(i, a);
        i += 1;
        break;
      case '--referer':
        opts.referer = need(i, a);
        i += 1;
        break;
      case '--ua':
      case '--user-agent':
        opts.userAgent = need(i, a);
        i += 1;
        break;
      case '--header': {
        const [k, ...rest] = need(i, a).split(':');
        if (k && rest.length) opts.headers[k.trim()] = rest.join(':').trim();
        i += 1;
        break;
      }
      case '--overwrite':
        opts.overwrite = true;
        break;
      case '--live':
        opts.live = true;
        break;
      case '--live-seconds':
        opts.liveSeconds = Math.max(1, Number(need(i, a)) || 0);
        i += 1;
        break;
      case '--json':
        opts.json = true;
        break;
      case '-v':
      case '--verbose':
        opts.verbose = true;
        break;
      case '--quiet':
        opts.quiet = true;
        break;
      case '--info':
        opts.infoOnly = true;
        break;
      case '--formats':
      case '--list-formats':
        opts.listFormats = true;
        break;
      case '--doctor':
        opts.doctor = true;
        break;
      case '--check-proxy':
        opts.checkProxy = true;
        break;
      case '--pixiv-search': {
        opts.pixivSearch = need(i, a);
        break;
      }
      case '--pixiv-source':
        opts.pixivSource = need(i, a);
        break;
      case '--pixiv-node-failover':
        // 原生搜索被代理重置时，自动把 Clash 代理组切到一个「能连 pixiv」的节点，然后重试一次。
        // 会改 Clash 的组选择（MATCH,✈️Final 影响所有走代理的流量），所以默认关、要显式开。
        opts.pixivNodeFailover = true;
        break;
      case '--exclude-pids':
        // 已经发过的作品 pid（逗号分隔）：搜图时跳过，避免同一张图发第二遍（2026-10-20）
        opts.excludePids = String(need(i, a) || '')
          .split(',')
          .map((x) => x.trim())
          .filter((x) => /^\d+$/.test(x));
        break;
      case '--no-pixiv-native':
        // 关掉「没搜到就改用 Pixiv 原生搜索」的兜底（原生搜索那一步要能连上 pixiv.net）
        opts.nativeFallback = false;
        break;
      case '--count': {
        // ⚠️ 注意：`-n` 在这个工具里早就是 `--name`（输出文件名）的短选项，
        // 所以条数只能用长选项 `--count`，别再给 `-n` 加第二种含义（踩过：
        // `-n 2` 被当成文件名"2"，搜出来的图全叫 2.png / 2 (1).png）。
        // 2026-10-20：数量**不再卡 20**（用户要求：每次搜图没有硬上限），只留 500 的天窗。
        opts.count = Math.max(1, Math.min(500, Number(need(i, a)) || 1));
        break;
      }
      case '--r18':
        opts.allowR18 = true;
        break;
      case '--list-only':
        opts.listOnly = true;
        break;
      case '--proxy-timeout':
        opts.proxyTimeout = need(i, a);
        break;
      case '--login':
        opts.login = true;
        if (argv[i + 1] && !String(argv[i + 1]).startsWith('-')) {
          opts.loginSite = argv[i + 1];
          i += 1;
        }
        break;
      case '--logout':
        opts.logout = true;
        break;
      case '--history':
        opts.history = true;
        if (argv[i + 1] && /^\d+$/.test(String(argv[i + 1]))) {
          opts.historyLimit = Math.max(1, Number(argv[i + 1]));
          i += 1;
        }
        break;
      case '--history-clear':
        opts.historyClear = true;
        break;
      case '--update-ytdlp':
        opts.updateYtDlp = true;
        break;
      case '--fetch-ffmpeg':
        opts.fetchFfmpeg = true;
        break;
      case '--no-auto-ytdlp':
        opts.autoDownloadYtDlp = false;
        break;
      case '--no-auto-ffmpeg':
        opts.autoFetchFfmpeg = false;
        break;
      case '--no-browser-assist':
        opts.browserAssist = false;
        break;
      case '--codec':
        opts.codec = need(i, a);
        i += 1;
        break;
      case '--tools-dir':
        opts.toolsDir = path.resolve(need(i, a));
        i += 1;
        break;
      case '--batch':
        opts.batchFile = path.resolve(need(i, a));
        i += 1;
        break;
      case '--limit-segments':
        opts.limitSegments = Math.max(1, Number(need(i, a)) || 0);
        i += 1;
        break;
      case '--playlist':
        opts.playlist = true;
        break;
      default:
        if (a.startsWith('-') && a !== '-') throw new Error(`未知选项：${a}`);
        opts.urls.push(a);
        break;
    }
  }
  return opts;
}

// ---------------------------------------------------------------- 进度条

function createProgressRenderer({ quiet, verbose, json }) {
  const isTty = process.stdout.isTTY && !json;
  let lastLine = 0;
  let currentTask = 0;
  let totalTasks = 1;

  return {
    setTasks(done, total) {
      currentTask = done;
      totalTasks = total;
    },
    render(payload) {
      if (quiet || json) return;
      if (payload.stage === 'setup') {
        const pct = payload.percent >= 0 ? ` ${payload.percent.toFixed(1)}%` : '';
        process.stdout.write(`\r准备组件 ${payload.label || ''}${pct} ${formatBytes(payload.bytes || 0)}   `);
        return;
      }
      if (payload.stage !== 'download') return;
      const now = Date.now();
      if (now - lastLine < 120 && !payload.done) return;
      lastLine = now;
      const pct = payload.percent >= 0 ? payload.percent : 0;
      const barWidth = 24;
      const filled = Math.max(0, Math.min(barWidth, Math.round((pct / 100) * barWidth)));
      const bar = `${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}`;
      const prefix = totalTasks > 1 ? `[${currentTask}/${totalTasks}] ` : '';
      const eta = payload.eta > 0 ? formatDuration(payload.eta) : '--:--';
      const line =
        `${prefix}${bar} ${pct.toFixed(1).padStart(5)}%  ` +
        `${formatBytes(payload.bytes || 0)}${payload.total ? `/${formatBytes(payload.total)}` : ''}  ` +
        `${formatSpeed(payload.speed || 0)}  剩余 ${eta}`;
      if (isTty) process.stdout.write(`\r${line.slice(0, (process.stdout.columns || 100) - 1)}`);
      else if (payload.done) process.stdout.write(`${line}\n`);
    },
    clear() {
      if (isTty) process.stdout.write('\r' + ' '.repeat((process.stdout.columns || 100) - 1) + '\r');
    },
    log(message) {
      if (quiet) return;
      if (!verbose) return;
      this.clear();
      process.stdout.write(`  · ${message}\n`);
    },
  };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.version) {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  if (opts.help ||
    (!opts.urls.length &&
      !opts.batchFile &&
      !opts.doctor &&
      !opts.checkProxy &&
      !opts.pixivSearch &&
      !opts.updateYtDlp &&
      !opts.fetchFfmpeg &&
      !opts.login &&
      !opts.logout &&
      !opts.history &&
      !opts.historyClear)
  ) {
    process.stdout.write(HELP);
    return 0;
  }

  // ---- 下载历史
  if (opts.historyClear) {
    await clearHistory();
    process.stdout.write(`已清空下载历史（${historyFile()}）\n`);
    return 0;
  }
  if (opts.history) {
    const { loadHistory, currentLimit } = require('./core/history');
    const limit = opts.historyLimit || currentLimit();
    const records = loadHistory(limit);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
      return 0;
    }
    if (!records.length) {
      process.stdout.write('还没有下载记录。\n');
      return 0;
    }
    process.stdout.write(`\n最近 ${records.length} 条下载记录（设置上限 ${limit} 条，可用 --history <条数> 或界面里调整）：\n\n`);
    records.forEach((r, i) => {
      const time = new Date(r.at).toLocaleString('zh-CN', { hour12: false });
      const status = r.ok ? (r.stopped ? '已结束录制' : '成功') : r.cancelled ? '已取消' : '失败';
      const size = formatBytes(r.bytes || 0);
      const name = r.fileName || r.title || r.url;
      process.stdout.write(
        `${String(i + 1).padStart(2)}. [${time}] ${status}  ${size.padStart(9)}  ${(r.engine || '-').padEnd(8)} ${name}\n`,
      );
      if (r.filePath) process.stdout.write(`    ${r.filePath}\n`);
      if (!r.ok && r.error) process.stdout.write(`    错误：${String(r.error).split('\n')[0]}\n`);
    });
    process.stdout.write('\n');
    return 0;
  }

  // ---- 登录 / 退出登录
  if (opts.logout) {
    const file = loginCookiesFile();
    try {
      fs.unlinkSync(file);
      process.stdout.write(`已删除登录状态文件：${file}\n`);
    } catch {
      process.stdout.write(`当前没有保存登录状态（${file} 不存在）\n`);
    }
    return 0;
  }
  if (opts.login) {
    const { openLoginWindowViaElectron, LOGIN_SITES } = require('./core/browser-login');
    // 不带站点参数时列出可用站点并说明「任意网址」用法，避免以为只能登录 B 站
    if (!opts.loginSite) {
      process.stdout.write(
        '\n登录任意站点：vgrab --login <站点或网址>\n\n' +
          `  常用站点：${Object.entries(LOGIN_SITES)
            .map(([k, v]) => `${k}(${v.name})`)
            .join(' / ')}\n` +
          '  任意网站：vgrab --login https://www.example.com/\n' +
          '            vgrab --login example.com\n\n' +
          '登录窗口里扫码或输入账号，登录完成后关闭那个窗口即可；\n' +
          '可以逐个登录多个站点，已登录的站点会一直保留，下载时按域名自动带上。\n\n',
      );
      return 1;
    }
    const outFile = loginCookiesFile();
    try {
      const res = await openLoginWindowViaElectron({
        appRoot: path.resolve(__dirname, '..'),
        site: opts.loginSite,
        outFile,
        electronPath: process.env.VIDEOGRAB_ELECTRON,
        onLog: (m) => process.stdout.write(`  · ${m}\n`),
      });
      process.stdout.write(
        `\n✔ 登录状态已保存（${res.count} 个 Cookie，来自 ${(res.domains || []).length} 个域名）\n` +
          `  文件：${res.outFile}\n` +
          '  之后直接执行 vgrab <链接> 即可，会自动带上登录状态下载高画质。\n',
      );
      return 0;
    } catch (err) {
      process.stderr.write(`登录未完成：${err.message}\n`);
      return 1;
    }
  }

  const out = createProgressRenderer(opts);
  const useLoginCookies = !opts.cookiesFile && hasLoginCookies();
  const downloader = new VideoDownloader({
    outDir: opts.outDir ? path.resolve(opts.outDir) : defaultDownloadDir(),
    quality: opts.quality,
    engine: opts.engine,
    concurrency: opts.concurrency,
    overwrite: opts.overwrite,
    live: opts.live,
    toolsDir: opts.toolsDir || toolsDir(),
    autoDownloadYtDlp: opts.autoDownloadYtDlp !== false,
    autoFetchFfmpeg: opts.autoFetchFfmpeg !== false,
    browserAssist: opts.browserAssist !== false,
    appRoot: path.resolve(__dirname, '..'),
    codec: opts.codec || 'h264',
    cookiesFile: opts.cookiesFile || (useLoginCookies ? loginCookiesFile() : ''),
    cookiesFromBrowser: opts.cookiesFromBrowser,
    proxy: opts.proxy,
    pixivSource: opts.pixivSource,
    referer: opts.referer,
    userAgent: opts.userAgent,
    headers: opts.headers,
    limitSegments: opts.limitSegments,
    maxLiveSeconds: opts.liveSeconds || 0,
    playlist: opts.playlist,
  });
  if (useLoginCookies) {
    process.stdout.write(`  ⓘ 已使用内置浏览器登录状态（${loginCookiesFile()}），可下载高画质内容\n`);
  }

  downloader.on('log', ({ message, notice }) => {
    if (notice) {
      out.clear();
      process.stdout.write(`  ⓘ ${message}\n`);
      return;
    }
    out.log(message);
  });
  downloader.on('progress', (p) => out.render(p));

  // Ctrl+C：第一次表示「结束录制 / 收尾保存」，第二次才强制退出
  const controllers = new Set();
  let interrupts = 0;
  const onSigint = () => {
    interrupts += 1;
    if (interrupts === 1) {
      out.clear();
      process.stderr.write('\n⏹ 收到中断：正在结束并保存已下载/已录制的部分（再按一次 Ctrl+C 可强制退出）\n');
      for (const c of controllers) c.abort();
    } else {
      process.stderr.write('\n已强制退出\n');
      process.exit(130);
    }
  };
  process.on('SIGINT', onSigint);

  // ---- 维护类子命令
  if (opts.checkProxy) return runProxyCheck(opts);
  if (opts.pixivSearch) return runPixivSearch(downloader, opts);
  if (opts.doctor) return runDoctor(downloader, opts);
  if (opts.updateYtDlp) {
    try {
      const p = await downloader.updateYtDlp({ toolsDir: downloader.options.toolsDir });
      process.stdout.write(`\ryt-dlp 已更新：${p}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`更新失败：${err.message}\n`);
      return 1;
    }
  }
  if (opts.fetchFfmpeg) {
    try {
      const p = await downloader.setupFfmpeg({ toolsDir: downloader.options.toolsDir });
      process.stdout.write(`\rffmpeg 就绪：${p}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`获取 ffmpeg 失败：${err.message}\n`);
      return 1;
    }
  }

  // ---- 收集链接（支持直接粘贴整段分享文案：自动挑出里面的链接）
  const fromText = (value) => {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return [];
    const found = extractUrls(raw);
    if (!found.length) return [raw]; // 没识别到就原样交给后面报错，方便看出输入了什么
    if (found.length > 1 || found[0] !== raw) {
      for (const u of found) process.stdout.write(`  ⓘ 从文本中识别到链接：${u}\n`);
    }
    return found;
  };

  let urls = opts.urls.flatMap(fromText);
  if (opts.batchFile) {
    const text = fs.readFileSync(opts.batchFile, 'utf8');
    urls = urls.concat(
      text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .flatMap(fromText),
    );
  }
  urls = [...new Set(urls)];
  if (!urls.length) {
    process.stderr.write('没有提供任何链接。用法：vgrab <链接> [选项]\n');
    return 1;
  }

  // ---- 仅解析
  if (opts.infoOnly || opts.listFormats) {
    let failures = 0;
    for (const url of urls) {
      try {
        if (opts.listFormats) {
          const info = await downloader.formats(url, { signal: undefined });
          if (opts.json) {
            process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
          } else {
            process.stdout.write(`\n${info.title || url}\n`);
            if (info.uploader) process.stdout.write(`  作者：${info.uploader}\n`);
            if (info.duration) process.stdout.write(`  时长：${formatDuration(info.duration)}\n`);
            process.stdout.write(`  引擎：${info.engine}${info.ffmpeg ? '' : '（未安装 ffmpeg，高清可能需要）'}\n`);
            if (info.formats?.length) {
              process.stdout.write('  可用格式（前 30 条）：\n');
              for (const f of info.formats.slice(0, 30)) {
                process.stdout.write(
                  `    ${String(f.formatId).padEnd(12)} ${String(f.ext).padEnd(6)} ${String(f.resolution || '-').padEnd(12)}` +
                    ` ${String(f.vcodec === 'none' ? '仅音频' : f.vcodec || '').padEnd(12)} ${f.filesize ? formatBytes(f.filesize) : ''} ${f.note}\n`,
                );
              }
            } else if (info.message) {
              process.stdout.write(`  ${info.message}\n`);
            }
          }
        } else {
          const info = await downloader.inspect(url);
          if (opts.json) {
            process.stdout.write(
              `${JSON.stringify(
                {
                  url: info.url,
                  finalUrl: info.finalUrl,
                  type: info.type,
                  title: info.title,
                  filename: info.filename,
                  contentType: info.contentType,
                  contentLength: info.contentLength,
                  candidates: info.candidates?.slice(0, 10) || [],
                },
                null,
                2,
              )}\n`,
            );
          } else {
            process.stdout.write(
              `\n链接：${info.finalUrl}\n  类型：${info.type}\n  标题：${info.title}\n` +
                `  文件名：${info.filename}\n  内容类型：${info.contentType || '-'}\n` +
                `  大小：${info.contentLength ? formatBytes(info.contentLength) : '未知'}\n`,
            );
            if (info.candidates?.length) {
              process.stdout.write('  网页中发现的媒体：\n');
              for (const c of info.candidates.slice(0, 10)) {
                process.stdout.write(`    [${c.type}] ${c.source} ${c.url.slice(0, 120)}\n`);
              }
            }
          }
        }
      } catch (err) {
        failures += 1;
        process.stderr.write(`解析失败 ${url}：${err.message}\n`);
      }
    }
    return failures ? 1 : 0;
  }

  // ---- 下载
  const results = [];
  let done = 0;
  const total = urls.length;
  const parallel = Math.min(opts.parallel, 4);

  const worker = async () => {
    for (;;) {
      if (interrupts > 0) return; // 用户已请求停止，不再开始新任务
      const url = urls.shift();
      if (!url) return;
      out.setTasks(done + 1, total);
      if (!opts.quiet && !opts.json) {
        out.clear();
        process.stdout.write(`\n▶ ${url}\n`);
      }
      const controller = new AbortController();
      controllers.add(controller);
      let result;
      try {
        result = await downloader.download(url, { signal: controller.signal });
      } finally {
        controllers.delete(controller);
      }
      done += 1;
      results.push(result);
      out.clear();
      if (result.ok) {
        if (!opts.json) {
          if (result.stopped) {
            process.stdout.write(
              `⏹ 已结束录制：${result.filePath}\n  已保存 ${formatBytes(result.bytes)}（${formatDuration(result.durationSec || 0)}）· 引擎 ${result.engine}\n`,
            );
          } else {
            process.stdout.write(
              `✔ 完成：${result.filePath}\n  大小 ${formatBytes(result.bytes)} · 耗时 ${formatDuration(result.durationMs / 1000)} · 引擎 ${result.engine}\n`,
            );
          }
        }
      } else if (!opts.json) {
        if (result.cancelled) process.stdout.write(`✖ 已取消：${url}\n`);
        else process.stderr.write(`✖ 失败：${url}\n  ${result.error}\n`);
      }
    }
  };

  await Promise.all(Array.from({ length: parallel }, worker));
  process.removeListener('SIGINT', onSigint);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(results.length === 1 ? results[0] : results, null, 2)}\n`);
  } else {
    const ok = results.filter((r) => r.ok).length;
    const failed = results.length - ok;
    out.clear();
    process.stdout.write(`\n共 ${results.length} 个任务：成功 ${ok} 个${failed ? `，失败 ${failed} 个` : ''}\n`);
    const dir = downloader.options.outDir;
    process.stdout.write(`保存目录：${dir}\n`);
  }
  return results.every((r) => r.ok) ? 0 : 1;
}

// ---------------------------------------------------------------- 自检

async function runDoctor(downloader, opts) {
  const status = downloader.status();
  const lines = [];
  lines.push(`Node.js        : ${process.version}`);
  lines.push(`工作目录       : ${__dirname}`);
  lines.push(`保存目录       : ${status.outDir}${fs.existsSync(status.outDir) ? '' : '（不存在，将自动创建）'}`);
  lines.push(`工具目录       : ${status.toolsDir}`);
  lines.push(`yt-dlp         : ${status.ytDlp ? `${status.ytDlp}（${formatBytes(fileSize(status.ytDlp))}）` : '未安装'}`);
  lines.push(`ffmpeg         : ${status.ffmpeg ? status.ffmpeg : '未安装（可选，用于合并音视频/转封装）'}`);
  const envProxy = envProxyUrl();
  const sysProxy = systemProxyUrl();
  const proxy = envProxy || sysProxy;
  lines.push(
    `代理           : ${proxy ? `${proxy}（${envProxy ? '来自环境变量' : '来自 Windows 系统代理'}，内置下载引擎已启用）` : '未设置（需要时可用 --proxy http://127.0.0.1:7890）'}`,
  );
  lines.push(`测速/连通性    : 检测中...`);
  if (!opts.json) process.stdout.write(`${lines.join('\n')}\n`);

  let reach = '失败';
  try {
    const res = await downloader.inspect('https://www.w3schools.com/html/mov_bbb.mp4');
    reach = `正常（识别为 ${res.type}）`;
  } catch (err) {
    reach = `失败：${err.message}`;
  }
  const result = {
    node: process.version,
    outDir: status.outDir,
    toolsDir: status.toolsDir,
    ytDlp: status.ytDlp,
    ffmpeg: status.ffmpeg,
    proxy: proxy || null,
    connectivity: reach,
  };
  if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else
    process.stdout.write(
      `连通性         : ${reach}\n\n建议：缺少 yt-dlp 时执行 vgrab --update-ytdlp；需要合并 1080P 音视频时执行 vgrab --fetch-ffmpeg；代理不通时执行 vgrab --check-proxy 做代理自检\n`,
    );
  return 0;
}

/**
 * 代理自检：分别以「直连」和「经代理」探测几个代表性站点，给出明确结论。
 * 结论只看「连接是否建立」，4xx 也算连上了（pixiv/YouTube 会按指纹拦 Node 请求，那属于站点侧限制）。
 */
async function runProxyCheck(opts = {}) {
  const { checkProxy } = require('./core/proxy-check');
  const result = await checkProxy({ proxy: opts.proxy || '', timeoutMs: Number(opts.proxyTimeout || 7000) });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }

  const lines = [];
  lines.push(`代理地址   : ${result.proxy || '未设置（可用 --proxy http://127.0.0.1:7890 指定）'}`);
  if (result.proxy) lines.push(`代理来源   : ${result.source}`);
  lines.push('');
  for (const item of result.results) {
    const via = item.via === 'proxy' ? '经代理' : '直连  ';
    const mark = item.ok ? '✓' : '✗';
    lines.push(`  ${mark} [${via}] ${String(item.name).padEnd(8)} ${String(item.status || '-').padStart(3)}  ${String(item.ms).padStart(5)}ms  ${item.note}`);
  }
  lines.push('');
  lines.push(`${result.ok ? '✔' : '✖'} ${result.verdict}`);
  lines.push('提示：结论为「代理可用」时，界面里填这个地址会立即生效（无需重启）。');
  process.stdout.write(`${lines.join('\n')}\n`);
  return result.ok ? 0 : 1;
}

/**
 * Pixiv 搜图：用公开检索接口（api.lolicon.app）按标签/关键词找作品，再用 pixiv.re 反代取原图。
 * 整条链路**不需要代理**（这是它存在的意义：pixiv.net 直连不通时也能用）。
 *
 * 每个作品下到自己的子目录（`<标题> by <作者>`），多图作品会把每一页都补齐
 * （反代 `-N` 后缀逐页探测，见 src/core/pixiv.js 的实测结论）。
 */
async function runPixivSearch(downloader, opts = {}) {
  const { searchAndDownloadPixiv } = require('./core/pixiv');
  const { formatBytes } = require('./core/util');

  const keyword = String(opts.pixivSearch || '').trim();
  // 2026-10-20：数量不再卡 20（用户要求没有硬上限），只留 500 的天窗
  const count = Math.max(1, Math.min(500, Number(opts.count) || 3));
  const outDir = opts.outDir || downloader.options.outDir;

  process.stdout.write(
    `ⓘ 搜索 Pixiv：${keyword}（最多 ${count} 个作品${opts.allowR18 ? '，含成人向' : '，只要全年龄'}；` +
      `公开接口 + 反代，没搜到会自动改用 Pixiv 原生搜索${opts.nativeFallback === false ? '（已用 --no-pixiv-native 关掉）' : ''}）\n`,
  );

  // 命令行与桌面界面共用同一个实现（src/core/pixiv.js 的 searchAndDownloadPixiv）
  const out = await searchAndDownloadPixiv(keyword, {
    count,
    // 免代理接口没搜到 → 自动改用 Pixiv 原生搜索（需要能连上 pixiv.net）；
    // `--no-pixiv-native` 可以关掉这条兜底
    nativeFallback: opts.nativeFallback !== false,
    // 节点自救（默认关）：`--pixiv-node-failover` 或 VIDEOGRAB_PIXIV_FAILOVER=1
    pixivNodeFailover: Boolean(opts.pixivNodeFailover),
    // 已经发过的 pid：搜图时直接跳过（2026-10-20，插件会传进来）
    excludePids: Array.isArray(opts.excludePids) ? opts.excludePids : [],
    allowR18: Boolean(opts.allowR18),
    listOnly: Boolean(opts.listOnly),
    outDir,
    signal: opts.signal,
    userAgent: opts.userAgent,
    headers: opts.headers,
    concurrency: opts.concurrency,
    onLog: (m) => process.stdout.write(`   ${m}\n`),
    onProgress: () => {},
  });

  if (!out.items.length) {
    /**
     * 失败文案要能**直接指导下一步**（2026-10-19 现场）：
     * 群里回了一句"代理可能没生效"，可当时**根本没配代理** —— 真正的原因是
     * 「高松灯」这个简体写法在 pixiv 上没有对应标签（换成繁体「高松燈」立刻就有）。
     * 所以这里把"当前代理有没有"写进错误里，插件据此给不同的话，不再一律怪代理。
     */
    const proxy = currentProxyLabel();
    process.stderr.write(`✖ 没有搜到作品${out.errors.length ? `（${out.errors.join('；')}）` : ''}｜当前代理：${proxy}\n`);
    return 1;
  }
  process.stdout.write(`ⓘ 命中 ${out.items.length} 个（来源 ${out.backend}）\n`);
  for (const [i, it] of out.items.entries()) {
    process.stdout.write(
      `   ${i + 1}. ${it.title}${it.author ? ` — ${it.author}` : ''}  [pid ${it.pid}]${it.rating ? ' ⚠️成人向' : ''}\n`,
    );
  }

  if (opts.listOnly) {
    if (opts.json) process.stdout.write(`${JSON.stringify(out.results, null, 2)}\n`);
    else process.stdout.write('\n（--list-only：只列出来，没有下载）\n');
    return 0;
  }

  for (const r of out.results) {
    const label = `「${r.title}」${r.author ? ` by ${r.author}` : ''}`;
    if (r.ok) {
      process.stdout.write(`✔ ${label}：${r.files.length} 张，${formatBytes(r.bytes)} → ${r.dir}${r.pages > 1 ? `（${r.pages} 页）` : ''}\n`);
    } else {
      process.stderr.write(`✖ ${label} 失败：${r.error}\n`);
    }
  }

  if (opts.json) process.stdout.write(`${JSON.stringify(out.results.length === 1 ? out.results[0] : out.results, null, 2)}\n`);
  const okCount = out.results.filter((r) => r.ok).length;
  if (!opts.json) process.stdout.write(`\n共 ${out.results.length} 个作品：成功 ${okCount} 个\n保存目录：${outDir}\n`);
  return okCount > 0 ? 0 : 1;
}

// ---------------------------------------------------------------- 启动
if (require.main === module) {
  ensureProxySupport();

  /**
   * "静默退出"兜底（2026-10-18 真实现场）：
   *
   * 如果某个 await 永远不会返回（代理隧道半死、底层 fetch 不理会 abort），
   * 定时器烧完之后事件循环里就没有 handle 了 —— Node 会**直接以退出码 0 结束**，
   * 一行错误都不打。上层只能看到"搜图工具退出码 0，且没有产出任何文件"，
   * 根本查不出原因（搜图"只打了两行横幅就没下文"就是这么来的）。
   *
   * `beforeExit` 在"事件循环空了但还没退"时触发：这里一旦发现 main() 没结算，
   * 就明确报错并置 1，绝不让它伪装成成功。
   */
  let settled = false;
  process.on('beforeExit', () => {
    if (settled) return;
    process.stderr.write('运行没有正常结束：有请求始终没有返回（多半是代理隧道卡住），已按失败处理\n');
    process.exitCode = 1;
  });

  main()
    .then((code) => {
      settled = true;
      process.exitCode = code;
    })
    .catch((err) => {
      settled = true;
      process.stderr.write(`运行出错：${err && err.stack ? err.stack : err}\n`);
      process.exitCode = 1;
    });
}

module.exports = { parseArgs, main };
