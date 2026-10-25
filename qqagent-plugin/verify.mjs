// 验证插件的「图片帖」链路：真实调用本机下载工具，检查是否把图片段发出去。
// 用法（工作目录无所谓）：
//   node qqagent-plugin/verify.mjs          真实链接端到端
//   node qqagent-plugin/verify.mjs --zip    只跑「图片超上限 → 打包压缩包」的本地确定性测试
//   node qqagent-plugin/verify.mjs --cards  只跑「QQ 卡片 → 链接」转译 + 核心补丁状态检查
//   node qqagent-plugin/verify.mjs --search 只跑「搜图结果怎么处理」（只下载 / 只发图 / 图+说明）
//   node qqagent-plugin/verify.mjs --search-live  真实联网跑一遍搜图工具（MODE=download|images|send）
//   node qqagent-plugin/verify.mjs --cmd    只跑「我要 xxx 的图」确定性指令（识别 + 核心补丁 + 脱网端到端）
//   node qqagent-plugin/verify.mjs --cmd-live     真实联网跑一遍确定性指令（不发任何消息）
// 可用环境变量：
//   APP_DIR   QQ Agent 的 resources/app 目录（默认 D:\qqagent\QQ Agent\resources\app）
//   ONLY      只跑名字里含该子串的用例
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const APP_DIR = process.env.APP_DIR || 'D:\\qqagent\\QQ Agent\\resources\\app';
const pluginFile = path.join(APP_DIR, 'plugins', 'video-downloader', 'index.js');
const mod = await import(pathToFileURL(pluginFile).href);

const settings = {
  enabled: true,
  // 留空 = 用**插件内置**的那份工具（plugins/video-downloader/tool）——自检就走这条生产路径；
  // 要测"外部工具目录"时才在用例里显式改 toolRoot（--cmd 里那个假 CLI 就是这么测的）。
  toolRoot: '',
  outDir: path.join(APP_DIR, 'data', 'video-downloader'),
  keepDays: 0,
  acceptLinks: 'known+direct',
  allowLive: false,
  liveSeconds: 30,
  quality: '720',
  maxImages: 9,
  videoAsFileMb: 100,
  concurrency: 1,
  timeoutSec: 300,
  notifyFailure: true,
  notifySuccess: false,
  extraArgs: ''
};

const sent = [];
const capturedLogs = [];   // 自检要断言"日志里说了什么"（如"只下载，未发消息"）
mod.setup({
  log: (...a) => {
    capturedLogs.push(a.map((x) => String(x)).join(' '));
    console.log('[log]', ...a);
  },
  warn: (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
  config: () => settings,
  // 自检不需要真的注册工具（没有核心的注册表），给个空实现免得刷一行 warn
  registerTool: () => {}
});

const sender = {
  async sendMedia(chatKey, segments) {
    sent.push({ chatKey, segments });
    const kinds = segments.map((s) => s.type).join('+');
    const first = String(segments[0]?.data?.file || '');
    console.log(`    → 发送 ${segments.length} 段 [${kinds}]，首个=${first.slice(0, 96)}`);
    for (const s of segments) {
      if (!String(s?.data?.file || '').startsWith('file://')) console.log('      ⚠️ 不是 file:// 形态');
    }
    return { message_id: 1 };
  },
  async sendTextBatch(chatKey, msgs) {
    sent.push({ chatKey, msgs });
    console.log('    → 发送文字:', msgs.join(' '));
  },
  async sendImage(chatKey, img) {
    sent.push({ chatKey, img });
    console.log('    → 发送单张图片:', JSON.stringify(img).slice(0, 100));
  }
};

const cases = [
  ['Pixiv 插画（5 张原图）', 'https://www.pixiv.net/artworks/150727863'],
  ['抖音图文（1 张）', 'https://www.douyin.com/note/7693365550072862451'],
  ['B站专栏（正文图）', 'https://www.bilibili.com/read/cv10525639/']
];

const only = process.env.ONLY || '';
const zipOnly = process.argv.includes('--zip') || process.argv.includes('--parse') || process.argv.includes('--cards') || process.argv.includes('--search') || process.argv.includes('--search-live') || process.argv.includes('--cmd') || process.argv.includes('--cmd-live') || process.argv.includes('--live') || process.argv.includes('--edge') || process.argv.includes('--queue');
let bad = 0;
for (const [label, url] of (zipOnly ? [] : cases)) {
  if (only && !label.includes(only)) continue;
  console.log(`\n=== ${label}\n    ${url}`);
  const before = sent.length;
  const t0 = Date.now();
  const r = await mod.providers['media.download']({ url, sender, kind: 'group', chatId: '10001', text: url });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`    返回：${JSON.stringify(r)}（${secs}s，发送 ${sent.length - before} 条）`);
  const okDelivered = sent.slice(before).some((x) => (x.segments || []).some((s) => s.type === 'image'));
  if (r?.skip) {
    console.log('    ✗ 没被认领（图片帖应该被认领）');
    bad += 1;
  } else if (r?.ok && !okDelivered) {
    console.log('    ✗ 说成功了但没有发出图片段');
    bad += 1;
  } else if (!r?.ok) {
    console.log('    ⚠️ 下载/发送失败（可能是站点风控或链接失效，见上面日志）');
  } else {
    console.log('    ✓ 已发出图片');
  }
}
if (!zipOnly) {
  console.log(bad === 0 ? '\n链路检查完成（失败项见上方 ⚠️）' : `\nFAIL ${bad} 项不符合预期`);
  process.exitCode = bad === 0 ? 0 : 1;
}

// ── 本地确定性测试：工具输出的 JSON 解析（单个对象 / 多个结果的数组）──────────
if (process.argv.includes('--parse')) {
  console.log('\n=== JSON 解析（踩过的坑：多结果时工具打印的是缩进的数组）===');
  const single = 'ⓘ 识别为 xxx\n✔ 完成：D:\\a\\b.mp4\n{\n  "ok": true,\n  "filePath": "D:\\\\a\\\\b.mp4",\n  "bytes": 123\n}\n';
  const multi =
    'ⓘ 搜索 Pixiv：重音テト\n✔ 「でかテト」 by kAte：1 张，12.3 MB → D:\\x\n\n' +
    '[\n  {\n    "ok": true,\n    "pid": "1",\n    "title": "でかテト",\n    "files": ["a.jpg"]\n  },\n' +
    '  {\n    "ok": true,\n    "pid": "2",\n    "title": "重音テト",\n    "files": ["b.jpg"]\n  }\n]\n';
  const arr = mod.parseToolJson(multi);
  const obj = mod.parseToolJson(single);
  console.log('  单个对象:', obj && obj.ok === true && obj.bytes === 123 ? '✓ 解析正确' : `✗ ${JSON.stringify(obj)}`);
  console.log('  结果数组:', Array.isArray(arr) && arr.length === 2 ? '✓ 解析正确（2 条）' : `✗ ${JSON.stringify(arr)}`);
  console.log('  标题带花括号也不受影响:', (() => {
    const t = 'x\n[\n  {\n    "ok": true,\n    "title": "{ABC} 测试"\n  }\n]\n';
    const r = mod.parseToolJson(t);
    return Array.isArray(r) && r[0] && r[0].title === '{ABC} 测试' ? '✓' : '✗';
  })());
  console.log('  纯噪音返回 null:', mod.parseToolJson('没有任何 JSON') === null ? '✓' : '✗');
  console.log('  asResultList 拍平:', mod.asResultList({ ok: true }).length === 1 && mod.asResultList([{ ok: true }, { ok: true }]).length === 2 ? '✓' : '✗');
  const okParse = Array.isArray(arr) && arr.length === 2 && obj && obj.ok === true;
  console.log(okParse ? '\nPASS JSON 解析检查通过' : '\nFAIL JSON 解析检查未通过');
  process.exitCode = okParse ? 0 : 1;
}

// ── 本地确定性测试：图片超上限 → 前 N 张直接发，其余打包成 zip ──────────────
if (process.argv.includes('--zip')) {
  console.log('\n=== 本地测试：15 张图 + maxImages=9 → 9 张直发 + 6 张打包 ===');
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'vgrab-zip-test-'));
  for (let i = 1; i <= 15; i += 1) {
    fs.writeFileSync(path.join(box, `${String(i).padStart(3, '0')}.jpg`), Buffer.alloc(2048, i));
  }
  const sentZip = [];
  const zipSender = {
    async sendMedia(chatKey, segments) {
      sentZip.push(segments);
      console.log(`    → 发送 ${segments.length} 段 [${segments.map((s) => s.type).join('+')}]`);
      return { message_id: 1 };
    },
    async sendTextBatch(chatKey, msgs) {
      sentZip.push(msgs);
      console.log('    → 发送文字:', msgs.join(' '));
    }
  };
  const artifacts = mod.collectArtifacts(box);
  console.log(`    collectArtifacts 收集到 ${artifacts.images.length} 张图（应全部收集，不截断）`);
  const desc = await mod.deliver({
    sender: zipSender,
    chatKey: 'group:10001',
    artifacts,
    url: 'https://example.com/opus/1',
    title: '测试图集标题',
    c: { ...settings, maxImages: 9, imageOverflow: 'rest', zipMaxMb: 200 },
    log: (...a) => console.log('    [log]', ...a)
  });
  console.log('    deliver 返回:', desc);

  const imageSegs = sentZip.filter(Array.isArray).flat().filter((s) => s?.type === 'image');
  const fileSegs = sentZip.filter(Array.isArray).flat().filter((s) => s?.type === 'file');
  const zipSeg = fileSegs[0];
  const zipUri = String(zipSeg?.data?.file || '');
  let zipPath = '';
  try {
    zipPath = zipUri ? fileURLToPath(zipUri) : '';
  } catch {
    zipPath = zipUri.replace(/^file:\/\/\//i, '').replace(/^\//, '');
  }
  const zipExists = zipPath ? fs.existsSync(zipPath) : false;
  // 用 tar 列出压缩包内容，确认里面确实是剩下那 6 张
  let inside = [];
  if (zipExists) {
    const out = spawnSync('tar.exe', ['-tf', zipPath], { encoding: 'utf8', windowsHide: true });
    inside = String(out.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  console.log(`    图片段 ${imageSegs.length} 个；文件段 ${fileSegs.length} 个；zip 存在=${zipExists}；zip 内 ${inside.length} 个文件`);
  console.log(`    zip 文件名: ${zipSeg ? path.basename(zipPath) : '(无)'}；内容: ${inside.join(', ')}`);

  const okZip =
    imageSegs.length === 9 &&
    fileSegs.length === 1 &&
    zipExists &&
    inside.length === 6 &&
    /测试图集标题\.zip$/.test(zipPath);
  console.log(okZip ? '    ✓ 9 张直发 + 6 张打包，压缩包名取自帖子标题' : '    ✗ 与预期不符');
  bad += okZip ? 0 : 1;

  // ── 图文帖里混着视频：视频和配图必须**都**发出去 ──────────────────────────
  // 2026-10-17 用户要求「抖音图文贴里会混着视频，请确保视频也下载」。
  // 工具会把「一个视频 + 若干配图」放进同一目录并把目录交上来，这里验发送端不会漏。
  console.log('\n=== 视频 + 配图同时存在 → 两样都发 ===');
  const mixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgrab-mix-test-'));
  fs.writeFileSync(path.join(mixDir, '帖子标题.mp4'), Buffer.alloc(4096, 3));
  const mixSub = path.join(mixDir, '帖子标题（配图）');
  fs.mkdirSync(mixSub, { recursive: true });
  for (let i = 1; i <= 3; i += 1) {
    fs.writeFileSync(path.join(mixSub, `00${i}.jpg`), Buffer.alloc(1024, i));
  }
  const mixArtifacts = mod.collectArtifacts(mixDir, settings, { recursive: true });
  const sentMix = [];
  const mixSender = {
    async sendMedia(chatKey, segments) {
      sentMix.push(segments);
      console.log(`    → 发送 ${segments.length} 段 [${segments.map((s) => s.type).join('+')}]`);
      return { message_id: 1 };
    },
    async sendTextBatch(chatKey, msgs) {
      sentMix.push(msgs);
      console.log('    → 发送文字:', msgs.join(' '));
    }
  };
  const mixDesc = await mod.deliver({
    sender: mixSender,
    chatKey: 'group:10002',
    artifacts: mixArtifacts,
    url: 'https://www.douyin.com/note/1',
    title: '帖子标题',
    c: { ...settings, maxImages: 9, imageOverflow: 'rest', zipMaxMb: 200 },
    log: (...a) => console.log('    [log]', ...a)
  });
  const mixFlat = sentMix.filter(Array.isArray).flat();
  const mixVideo = mixFlat.filter((s) => s?.type === 'video').length;
  const mixImages = mixFlat.filter((s) => s?.type === 'image').length;
  const okMix = mixVideo === 1 && mixImages === 3 && /视频/.test(mixDesc) && /图片/.test(mixDesc);
  console.log(`    collectArtifacts: 视频 ${mixArtifacts.video ? 1 : 0} 个、图片 ${mixArtifacts.images.length} 张（应 1 / 3）`);
  console.log(`    发送结果：视频段 ${mixVideo}、图片段 ${mixImages}；返回「${mixDesc}」`);
  console.log(okMix ? '    ✓ 视频和配图都发出去了' : '    ✗ 有东西被漏掉');
  bad += okMix ? 0 : 1;

  try {
    fs.rmSync(box, { recursive: true, force: true });
    if (zipExists) fs.rmSync(zipPath, { force: true });
    fs.rmSync(mixDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  console.log(bad === 0 ? '\nPASS 全部检查通过' : `\nFAIL ${bad} 项`);
  process.exitCode = bad === 0 ? 0 : 1;
}

// ── 本地确定性测试：QQ 卡片 → 链接（转译模块 + 核心补丁）──────────────────────
if (process.argv.includes('--cards')) {
  console.log('\n=== 卡片 → 链接 ===');
  const srcRoot = path.dirname(fileURLToPath(import.meta.url));
  const srcCard = path.join(srcRoot, 'card-links', 'card-links.mjs');
  const dstCard = path.join(APP_DIR, 'plugins', 'video-downloader', 'card-links.mjs');
  const onebotFile = path.join(APP_DIR, 'src', 'onebot.js');

  const card = await import(pathToFileURL(srcCard).href);
  const cards = [
    [
      'B站 json 卡片',
      {
        type: 'json',
        data: {
          data: JSON.stringify({
            app: 'com.tencent.structmsg',
            meta: {
              news: { title: '【新宿决战】五条悟猫VS宿傩猫', jumpUrl: 'https://b23.tv/AvOCzlr' },
              detail_1: { qqdocurl: 'https://b23.tv/AvOCzlr', preview: 'https://p3-pc-sign.douyinpic.com/x.jpg' }
            }
          })
        }
      },
      'https://b23.tv/AvOCzlr'
    ],
    [
      '抖音 json 卡片（斜杠被转义）',
      { type: 'json', data: { data: '{"meta":{"news":{"title":"假如熊大熊二闹掰了","jumpUrl":"https:\\/\\/v.douyin.com\\/Q17Q43LSOR4\\/"}}}' } },
      'https://v.douyin.com/Q17Q43LSOR4/'
    ],
    ['xml 卡片', { type: 'xml', data: { data: '<msg><item><title>视频标题</title><url>https://v.douyin.com/abcd/</url></item></msg>' } }, 'https://v.douyin.com/abcd/'],
    ['share 段', { type: 'share', data: { url: 'https://b23.tv/xyz789', title: '一个视频' } }, 'https://b23.tv/xyz789'],
    ['小程序壳地址被过滤', { type: 'json', data: { data: JSON.stringify({ meta: { detail_1: { title: '某小程序', qqdocurl: 'https://m.q.qq.com/a/s/abc123' } } }) } }, null]
  ];

  for (const [label, seg, expect] of cards) {
    const text = await card.cardSegmentToText(seg);
    const ok = expect ? text.includes(expect) : !/https?:\/\//.test(text);
    if (!ok) bad += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${label}: ${text}`);
  }
  console.log(`  普通文本不受影响: ${card.extractCardLinks({ type: 'text', data: { text: '大家好啊' } }).urls.length === 0 ? '✓' : '✗'}`);

  // 部署副本是否与源码一致（不一致说明 deploy.cmd 跑过一半或忘了复制）
  const same = fs.existsSync(dstCard) && fs.readFileSync(srcCard, 'utf8') === fs.readFileSync(dstCard, 'utf8');
  console.log(`  部署副本与源码一致: ${same ? '✓' : `✗（跑一次 deploy.cmd；缺的是 ${dstCard}）`}`);
  if (!same) bad += 1;

  // 核心补丁：转译逻辑必须由核心调起来，否则卡片里根本没有链接进文本
  const core = fs.existsSync(onebotFile) ? fs.readFileSync(onebotFile, 'utf8') : '';
  const patched = core.includes('/* card-links patch */');
  console.log(`  核心已打补丁: ${patched ? '✓' : '✗（跑 node qqagent-plugin/card-links/apply.mjs）'}`);
  if (!patched) {
    bad += 1;
  } else {
    const coreMod = await import(`${pathToFileURL(onebotFile).href}?t=${Date.now()}`);
    const e2e = [
      ['json 卡片进了消息文本', [cards[0][1]], 'https://b23.tv/AvOCzlr'],
      ['xml 卡片进了消息文本', [cards[2][1]], 'https://v.douyin.com/abcd/'],
      ['share 段进了消息文本', [cards[3][1]], 'https://b23.tv/xyz789'],
      ['普通文本原样输出', [{ type: 'text', data: { text: '大家好啊' } }], '大家好啊']
    ];
    for (const [label, segs, expect] of e2e) {
      const text = await coreMod.segmentsToText(segs);
      const ok = text.includes(expect);
      if (!ok) bad += 1;
      console.log(`  ${ok ? '✓' : '✗'} ${label}: ${text}`);
    }
    console.log('  ⚠️ 核心补丁改动要**重启 QQ Agent** 才生效（插件热重载，核心不重载）');
  }
  console.log(bad === 0 ? '\nPASS 卡片转译检查通过' : `\nFAIL ${bad} 项`);
  process.exitCode = bad === 0 ? 0 : 1;
}

// ── 本地确定性测试：图片"换指纹"（QQ 的 fast-upload 命中会让整条消息被静默丢弃）──
if (process.argv.includes('--uniq')) {
  console.log('\n=== 图片换指纹（uniqueImageForUpload）===');
  const os2 = await import('node:os');
  const crypto2 = await import('node:crypto');
  const tmp = fs.mkdtempSync(path.join(os2.tmpdir(), 'vgrab-uniq-'));
  const md5 = (f) => crypto2.createHash('md5').update(fs.readFileSync(f)).digest('hex');

  // 造一张最小 JPEG（SOI + APP0 + DQT + EOI，ffmpeg 能认）
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array(64).fill(0x10), 0xff, 0xd9
  ]);
  const p = path.join(tmp, 'a.jpg');
  fs.writeFileSync(p, jpeg);

  const a = mod.uniqueImageForUpload(p, () => {});
  const b = mod.uniqueImageForUpload(p, () => {});
  const ok1 = Boolean(a) && Boolean(b) && md5(a) !== md5(p) && md5(b) !== md5(p) && md5(a) !== md5(b);
  console.log(
    `  ${ok1 ? '✓' : '✗'} 每次发送 md5 都不同（原=${md5(p).slice(0, 8)} a=${a ? md5(a).slice(0, 8) : '-'} b=${b ? md5(b).slice(0, 8) : '-'}）`
  );
  if (!ok1) bad += 1;

  const head = a ? fs.readFileSync(a) : Buffer.alloc(0);
  const headOk = head[0] === 0xff && head[1] === 0xd8 && head.length > jpeg.length;
  console.log(`  ${headOk ? '✓' : '✗'} 仍是合法 JPEG 头（SOI 保留、只在中间插了 COM 段）`);
  if (!headOk) bad += 1;

  const com = a ? head.indexOf(Buffer.from([0xff, 0xfe])) : -1;
  console.log(`  ${com === 2 ? '✓' : '✗'} COM 段位置在第 3 字节（紧跟 SOI）`);
  if (com !== 2) bad += 1;

  if (a) fs.unlinkSync(a);
  if (b) fs.unlinkSync(b);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(bad === 0 ? '\nPASS 图片换指纹检查通过' : `\nFAIL ${bad} 项`);
  process.exitCode = bad === 0 ? 0 : 1;
}

// ── 本地确定性测试：搜图结果怎么处理（只下载 / 只发图 / 图+说明）──────────────
if (process.argv.includes('--search')) {
  console.log('\n=== 搜图结果怎么处理（searchSendMode）===');
  const srcRoot = path.dirname(fileURLToPath(import.meta.url));

  // ① 三种模式的执行计划
  const plans = [
    ['download（默认）', mod.searchPlan('download'), { chat: false, quiet: true, silentModel: true, startText: '', hintText: '' }],
    ['images', mod.searchPlan('images'), { chat: true, quiet: true, silentModel: false, startText: '', hintText: '' }],
    ['send', mod.searchPlan('send'), { chat: true, quiet: true, silentModel: false, startText: '开始搜图了', hintText: '图片正在发送' }],
    ['空值兜底', mod.searchPlan(''), { chat: false, quiet: true, silentModel: true, startText: '', hintText: '' }],
    ['乱七八糟的值兜底', mod.searchPlan('PDF'), { chat: false, quiet: true, silentModel: true, startText: '', hintText: '' }]
  ];
  for (const [label, got, want] of plans) {
    const ok =
      got.chat === want.chat && got.quiet === want.quiet && got.silentModel === want.silentModel &&
      (got.startText ?? '') === want.startText && (got.hintText ?? '') === want.hintText;
    if (!ok) bad += 1;
    console.log(
      `  ${ok ? '✓' : '✗'} ${label}: chat=${got.chat} quiet=${got.quiet} silentModel=${got.silentModel}` +
        ` 提示语=${got.startText || '—'}/${got.hintText || '—'}`
    );
  }

  // ② 清单里的设置项与代码默认值必须一致（少一处界面上就选不到）
  const manifest = JSON.parse(fs.readFileSync(path.join(srcRoot, 'video-downloader', 'plugin.json'), 'utf8'));
  const values = manifest.configSchema?.searchSendMode?.values || [];
  const fallback = manifest.settings?.searchSendMode;
  const valsOk = ['download', 'images', 'send'].every((v) => values.includes(v));
  const defOk = fallback === 'download';
  if (!valsOk || !defOk) bad += 1;
  console.log(`  ${valsOk ? '✓' : '✗'} 清单 configSchema 三个取值齐全: ${JSON.stringify(values)}`);
  console.log(`  ${defOk ? '✓' : '✗'} 清单默认值 = download（实际 ${JSON.stringify(fallback)}）`);

  // ③ quiet 真的能压住说明文字：同样的 15 张图，quiet 模式下不该出现任何文字消息
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'vgrab-search-test-'));
  for (let i = 1; i <= 15; i += 1) {
    fs.writeFileSync(path.join(box, `${String(i).padStart(3, '0')}.jpg`), Buffer.alloc(2048, i));
  }
  const artifacts = mod.collectArtifacts(box);
  const c15 = { ...settings, maxImages: 9, imageOverflow: 'rest', zipMaxMb: 200 };

  const runDeliver = async (quiet) => {
    const got = { media: 0, images: 0, files: 0, texts: 0 };
    const spy = {
      async sendMedia(chatKey, segments) {
        got.media += 1;
        for (const s of segments) {
          if (s.type === 'image') got.images += 1;
          if (s.type === 'file') got.files += 1;
        }
        return { message_id: 1 };
      },
      async sendTextBatch() {
        got.texts += 1;
      }
    };
    const desc = await mod.deliver({
      sender: spy,
      chatKey: 'group:10001',
      artifacts,
      url: 'pixiv-search:测试',
      title: '测试图集标题',
      c: c15,
      log: () => {},
      quiet
    });
    return { got, desc };
  };

  const quietRun = await runDeliver(true);
  const loudRun = await runDeliver(false);
  const quietOk = quietRun.got.images === 9 && quietRun.got.files === 1 && quietRun.got.texts === 0;
  const loudOk = loudRun.got.images === 9 && loudRun.got.files === 1 && loudRun.got.texts >= 1;
  if (!quietOk) bad += 1;
  if (!loudOk) bad += 1;
  console.log(`  ${quietOk ? '✓' : '✗'} quiet：9 张图 + 1 个 zip，文字 ${quietRun.got.texts} 条（应为 0）→ ${quietRun.desc}`);
  console.log(`  ${loudOk ? '✓' : '✗'} 非 quiet：9 张图 + 1 个 zip，文字 ${loudRun.got.texts} 条（应 ≥1）→ ${loudRun.desc}`);

  try {
    fs.rmSync(box, { recursive: true, force: true });   // box 里的 zip 跟着一起删
  } catch {
    /* ignore */
  }

  // ④ 搜图失败**必须在群里反馈**（2026-10-18 用户报"pixiv 搜图失败没有在群内反馈"）
  //    指令那条路消息被钩子 veto、模型不会出场 —— 失败时插件自己得说话。
  //    这里用"必定失败的假工具"跑一遍，断言真的发了一句失败提示。
  const failBox = fs.mkdtempSync(path.join(os.tmpdir(), 'vgrab-search-fail-'));
  const failTool = path.join(failBox, 'tool');
  fs.mkdirSync(path.join(failTool, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(failTool, 'src', 'cli.js'),
    "process.stderr.write('ECONNRESET: pixiv 反代连接被重置\\n');\nprocess.exit(1);\n",
    'utf8'
  );
  const failTexts = [];
  const failSender = {
    async sendMedia() {
      return { message_id: 1 };
    },
    async sendTextBatch(chatKey, lines) {
      failTexts.push(...lines);
    }
  };
  const failSettings = { ...settings, toolRoot: failTool, searchEnabled: true, notifyFailure: true };
  const failOut = await mod.performSearchRequest({
    keyword: '测试关键词',
    count: 1,
    c: failSettings,
    plan: mod.searchPlan('download'),   // 最苛刻：只下载模式（平时群里一个字都不发）
    sender: failSender,
    chatKey: 'group:10001',
    log: () => {},
    source: '指令',
    forceFailureNotice: true
  });
  const failOk = failOut.ok === false && failTexts.length === 1 && /连不上 Pixiv|抓|ECONNRESET|失败/i.test(failTexts[0] || '');
  if (!failOk) bad += 1;
  console.log(`  ${failOk ? '✓' : '✗'} 搜图失败会反馈：ok=${failOut.ok}，群里收到 ${failTexts.length} 句「${failTexts[0] || '—'}」`);

  // ⑤ 设置里关掉失败提示（notifyFailure=false）→ 不再打扰群里
  failTexts.length = 0;
  await mod.performSearchRequest({
    keyword: '测试关键词',
    count: 1,
    c: { ...failSettings, notifyFailure: false },
    plan: mod.searchPlan('download'),
    sender: failSender,
    chatKey: 'group:10001',
    log: () => {},
    source: '指令',
    forceFailureNotice: true
  });
  const muteOk = failTexts.length === 0;
  if (!muteOk) bad += 1;
  console.log(`  ${muteOk ? '✓' : '✗'} notifyFailure=false 时不发失败提示（收到 ${failTexts.length} 句）`);

  try {
    fs.rmSync(failBox, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  // ⑥ 免代理接口没搜到 → **自动改用 Pixiv 原生搜索**（工具侧，fixture 驱动，不联网）
  const pixivCorePath = path.join(srcRoot, '..', 'src', 'core', 'pixiv.js');
  if (fs.existsSync(pixivCorePath)) {
    const px = (await import(pathToFileURL(pixivCorePath).href)).default || {};
    const fixture = JSON.stringify({
      error: false,
      body: { illustManga: { data: [{ id: '123456', title: '原生命中', userName: '画师', xRestrict: 0, tags: ['初音ミク'] }] } }
    });
    let nativeCalls = 0;
    const fakeFetch = async (u) => {
      if (String(u).includes('pixiv.net/ajax/search')) {
        nativeCalls += 1;
        return fixture;
      }
      return JSON.stringify({ error: 'none', data: [] });   // 公开接口：空
    };
    const r = await px.searchPixiv('冷门关键词', { limit: 2, fetchText: fakeFetch, nativeFallback: true });
    // 2026-10-20：原生搜索现在按「简体 → 繁体」逐个补，所以调用次数可能是 1~2 次（假数据只有 1 条）
    const okNative = String(r.backend).includes('pixiv-native') && r.items.length >= 1 && nativeCalls >= 1;
    if (!okNative) bad += 1;
    console.log(`  ${okNative ? '✓' : '✗'} 公开接口没搜到 → 自动改用 Pixiv 原生搜索（backend=${r.backend}，${r.items.length} 条，原生调用 ${nativeCalls} 次）`);

    const beforeOff = nativeCalls;
    const off = await px.searchPixiv('冷门关键词', { limit: 2, fetchText: fakeFetch, nativeFallback: false });
    const okOff = off.backend === 'none' && off.items.length === 0 && nativeCalls === beforeOff;
    if (!okOff) bad += 1;
    console.log(`  ${okOff ? '✓' : '✗'} nativeFallback=false 时不碰原生搜索（backend=${off.backend}，原生调用累计 ${nativeCalls} 次）`);
  } else {
    bad += 1;
    console.log(`  ✗ 找不到工具源码 ${pixivCorePath}`);
  }

  // ⑥.5 排除 AI 生成的作品（2026-10-25，参照 pixiv-illust 插件的同名设置）
  {
    const px = (await import(pathToFileURL(pixivCorePath).href)).default || {};
    const aiCases = [
      [{ tags: ['AI'] }, true],
      [{ tags: ['AI生成'] }, true],
      [{ tags: ['aiイラスト'] }, true],
      [{ tags: ['Stable Diffusion'] }, true],
      [{ tags: ['NovelAI'] }, true],
      [{ tags: ['初音ミク', '女の子'] }, false],
      [{ title: 'AI 时代的少女', tags: ['オリジナル'] }, false]
    ];
    const wrong = aiCases.filter(([item, want]) => px.isAiWork?.(item) !== want);
    const okAi = wrong.length === 0;
    if (!okAi) bad += 1;
    console.log(`  ${okAi ? '✓' : '✗'} AI 作品判定（${aiCases.length - wrong.length}/${aiCases.length} 条判定正确）`);
  }

  // ⑦ 失败原因必须**分得清**：不能把"Pixiv 上真的没这个标签"说成"要挂代理"
  //    （2026-10-18 真实误诊：代理开着、原生搜索也跑通了，只是没有这个标签，
  //      旧规则却回了"先挂上代理再让我试"）
  const failTextCases = [
    ['Pixiv 上真的没结果', '没有搜到作品（内置接口（tag）没有结果；内置接口（keyword）没有结果；Pixiv 原生搜索也没有结果）', /Pixiv 上也没搜到/],
    ['原生搜索连不上', '没有搜到作品（内置接口（tag）没有结果；Pixiv 原生搜索失败：网络错误：连接被拒绝（ECONNREFUSED））', /代理/],
    ['原生搜索被风控', '没有搜到作品（内置接口（tag）没有结果；Pixiv 原生搜索失败：HTTP 403：https://x）', /风控/],
    ['公开接口自己就超时', '内置接口（tag）失败：请求超时（20000ms）', /超时|代理/],
    // 2026-10-18 误诊：工具的**横幅**里带"系统代理"四个字，老规则一看"代理"就判"连不上"，
    // 可用户代理开着、请求也确实走了代理。含"代理"但没有任何连接类证据时不许怪代理。
    ['横幅里有"代理"两个字（不是故障）', 'ⓘ 检测到系统代理 http://127.0.0.1:7897，内置下载引擎将走它 | ⓘ 搜索 Pixiv：奶蛙（最多 2 个作品）', /^(?!.*要挂代理).*/],
    ['反代 500 取不到图', '✖ 「奶蛙」 by Hood 失败：图片反代上没取到任何图片（113355109）', /反代/]
  ];
  for (const [label, raw, want] of failTextCases) {
    const got = mod.searchFailureText(raw);
    const ok = want.test(got);
    if (!ok) bad += 1;
    console.log(`  ${ok ? '✓' : '✗'} 失败分类（${label}）：${got}`);
  }

  console.log(bad === 0 ? '\nPASS 搜图处理方式检查通过' : `\nFAIL ${bad} 项`);
  process.exitCode = bad === 0 ? 0 : 1;
}



// ── 真实网络：跑一遍搜图工具，验证"当前模式下到底往群里发了什么" ─────────────
// 用法：node qqagent-plugin/verify.mjs --search-live
//   MODE=download|images|send（默认 download）  KW=关键词（默认 初音ミク）
if (process.argv.includes('--search-live')) {
  const mode = process.env.MODE || 'download';
  const kw = process.env.KW || '初音ミク';
  console.log(`\n=== 真实搜图（searchSendMode=${mode}，关键词「${kw}」）===`);
  Object.assign(settings, { searchSendMode: mode, searchCount: 1, maxImages: 3 });

  const calls = [];
  const liveSender = {
    async sendMedia(chatKey, segments) {
      calls.push({ kind: 'media', n: segments.length, types: segments.map((s) => s.type).join('+') });
      console.log(`    → 媒体 ${segments.length} 段 [${segments.map((s) => s.type).join('+')}]`);
      return { message_id: 1 };
    },
    async sendTextBatch(chatKey, msgs) {
      calls.push({ kind: 'text', n: msgs.length });
      console.log(`    → 文字：${msgs.join(' ').slice(0, 120)}`);
    }
  };
  const ctx = { sender: liveSender, chatKey: 'group:10001', session: { sent: [] }, emit: () => {} };
  const r = await mod.runPixivSearchTool(ctx, { keyword: kw, count: 1 });
  console.log(`    返回（${r?.isError ? '错误' : '成功'}）：${String(r?.content || '').split('\n').slice(0, 3).join(' / ').slice(0, 300)}`);

  const wantsChat = mode !== 'download';
  const textCalls = calls.filter((x) => x.kind === 'text').length;
  let ok;
  if (wantsChat) {
    ok = !r?.isError && calls.some((x) => x.kind === 'media') && (mode === 'send' ? textCalls >= 0 : textCalls === 0);
  } else {
    ok = !r?.isError && calls.length === 0 && ctx.session.sent.length === 0 && /不要往群里发任何消息/.test(String(r?.content || ''));
  }
  console.log(`  ${ok ? '✓' : '✗'} ${mode} 模式下的行为符合预期（发送调用 ${calls.length} 次，文字 ${textCalls} 次）`);
  console.log(ok ? '\nPASS 真实搜图检查通过' : '\nFAIL 真实搜图检查未通过');
  process.exitCode = ok ? 0 : 1;
}

// ── 真实网络：直播录制（达到上限就收尾发送，不能无限录到超时）──────────────────
//
// 2026-10-17 真实现场：群友发 `https://b23.tv/8FCCLtv`（短链，302 之后才是
// `live.bilibili.com`），插件靠 `looksLive(url)` 判断 → 判 false → **既没传 `--live`
// 也没传 `--live-seconds`** → 工具进了内置录制引擎却"录到手动结束"，一路录到插件自己的
// timeoutSec 被杀，留下 213MB 的 `.flv.part`，群里只收到一句"下载超时"。
// 这条用例守着"短链也必须带上录制上限、而且到点就收尾成可播放文件再发出去"。
if (process.argv.includes('--live')) {
  const LIVE_URL = process.env.LIVE_URL || 'https://b23.tv/8FCCLtv';
  const SECS = Math.max(5, Number(process.env.LIVE_SECS) || 15);
  console.log(`\n=== 真实直播录制（上限 ${SECS} 秒，${LIVE_URL}）===`);
  Object.assign(settings, { allowLive: true, liveSeconds: SECS, timeoutSec: 60 });
  const before = sent.length;
  const t0 = Date.now();
  const r = await mod.providers['media.download']({
    url: LIVE_URL, sender, kind: 'group', chatId: '10001', text: LIVE_URL
  });
  const secs = (Date.now() - t0) / 1000;
  const newSends = sent.slice(before);
  const videoSeg = newSends
    .flatMap((x) => x.segments || [])
    .find((s) => s.type === 'video' || s.type === 'file');
  const filePath = (() => {
    const uri = String(videoSeg?.data?.file || '');
    try {
      return uri.startsWith('file://') ? decodeURIComponent(uri.replace(/^file:\/\/\//, '')) : uri;
    } catch {
      return uri;
    }
  })();
  const fileOk = filePath ? fs.existsSync(filePath) && fs.statSync(filePath).size > 0 : false;
  const logsAll = capturedLogs.join('\n');
  const sawLive = /直播|录制/.test(logsAll);
  const sawCap = new RegExp(`录制时长上限`).test(logsAll);

  // 判定：① 认领并成功；② 用时明显短于 timeoutSec（说明是"到点收尾"而不是被超时杀掉）；
  //       ③ 真的发出了媒体段且文件在磁盘上；④ 日志里出现过录制上限那句话。
  const ok =
    !r?.skip && r?.ok !== false && secs < 55 && Boolean(videoSeg) && fileOk && sawLive;
  if (!ok) bad += 1;
  console.log(
    `  ${ok ? '✓' : '✗'} 录制 ${SECS}s 后收尾发送：用时 ${secs.toFixed(1)}s（应 < 55s），` +
      `返回 ${JSON.stringify({ ok: r?.ok, error: r?.error })}，媒体段 ${videoSeg ? videoSeg.type : '无'}，` +
      `文件存在 ${fileOk}，日志提到直播 ${sawLive}${sawCap ? '／上限' : ''}`
  );
  console.log(ok ? '\nPASS 直播录制检查通过' : '\nFAIL 直播录制检查未通过');
  process.exitCode = ok ? 0 : 1;
}

// ── Edge cookie（登录态继承）：解密/格式/真实读取 ─────────────────────────────
//
// 2026-10-17 新增功能：以前登录态只能靠"桌面版内置浏览器登录后导出文件"，而大家平时是在
// Edge 里登录 B 站的。`edge-cookies.mjs` 直接把 Edge 的 cookie 库读出来（DPAPI 解密钥 +
// AES-256-GCM 解密），转成 Netscape 文件给工具用。
// 这条用例：① 造一条 v10 cookie 验解密对不对；② 验 v20 会被如实跳过；③ 验 Netscape 格式；
// ④ 真去读一次本机 Edge（读不到/被锁/全是 v20 都只报告不判失败 —— 那是环境问题不是代码问题）。
if (process.argv.includes('--edge')) {
  console.log('\n=== Edge cookie（登录态继承）===');
  const modPath = path.join(APP_DIR, 'plugins', 'video-downloader', 'edge-cookies.mjs');
  const srcModPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'video-downloader', 'edge-cookies.mjs');
  const sameMod = fs.existsSync(modPath) && fs.existsSync(srcModPath)
    && fs.readFileSync(modPath, 'utf8') === fs.readFileSync(srcModPath, 'utf8');
  if (!sameMod) bad += 1;
  console.log(`  ${sameMod ? '✓' : '✗'} 部署副本与源码一致（edge-cookies.mjs）${sameMod ? '' : '（跑一次 deploy.cmd）'}`);

  const m = await import(pathToFileURL(srcModPath).href);
  const crypto = await import('node:crypto');

  // ① v10 = nonce(12) + 密文 + tag(16)，AES-256-GCM
  const key = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const plain = Buffer.from('SESSDATA=fake-session-value; path=/', 'utf8');
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const blob = Buffer.concat([Buffer.from('v10', 'latin1'), nonce, ct, cipher.getAuthTag()]);
  const dec = m.decryptChromiumCookie(blob, key);
  const ok1 = dec.ok === true && dec.value === plain.toString('utf8');
  if (!ok1) bad += 1;
  console.log(`  ${ok1 ? '✓' : '✗'} v10（AES-256-GCM）解密：${ok1 ? '明文一致' : JSON.stringify(dec)}`);

  // ② v20（Edge 127+ app-bound）必须**如实跳过**，不能假装解出来
  const v20 = Buffer.concat([Buffer.from('v20', 'latin1'), crypto.randomBytes(40)]);
  const r20 = m.decryptChromiumCookie(v20, key);
  const ok2 = r20.ok === false && r20.reason === 'v20';
  if (!ok2) bad += 1;
  console.log(`  ${ok2 ? '✓' : '✗'} v20（app-bound 加密）如实标记为解不开：${JSON.stringify(r20)}`);

  // ③ Netscape 格式：带点域名 / #HttpOnly_ 前缀 / 1601 微秒时间戳换算
  const rows = [
    { host_key: '.bilibili.com', name: 'SESSDATA', value: 'abc123', path: '/', is_secure: 1, is_httponly: 1, expires_utc: 13300000000000000 },
    { host_key: 'api.bilibili.com', name: 'buvid3', value: 'xyz', path: '/', is_secure: 0, is_httponly: 0, expires_utc: 0 }
  ];
  const netscape = m.toNetscape(rows, { now: 1700000000000 });
  const lines = netscape.split('\n').filter((l) => l && !l.startsWith('# '));
  const first = lines[0] || '';
  const second = lines[1] || '';
  const ok3 = netscape.startsWith('# Netscape HTTP Cookie File')
    && first.startsWith('#HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t')
    && first.includes('\tSESSDATA\tabc123')
    && second.startsWith('.api.bilibili.com\tFALSE\t/\tFALSE\t')
    && second.includes('\tbuvid3\txyz');
  if (!ok3) bad += 1;
  console.log(`  ${ok3 ? '✓' : '✗'} Netscape 格式（首行 ${JSON.stringify(first.slice(0, 46))}…）`);

  // ④ 域名过滤
  const ok4 = m.hostMatches('.bilibili.com', m.DEFAULT_HOSTS)
    && m.hostMatches('api.bilibili.com', m.DEFAULT_HOSTS)
    && !m.hostMatches('evil-bilibili.com.example', m.DEFAULT_HOSTS)
    && !m.hostMatches('.google.com', m.DEFAULT_HOSTS);
  if (!ok4) bad += 1;
  console.log(`  ${ok4 ? '✓' : '✗'} 域名后缀匹配（bilibili.com 命中、相似域名不误伤）`);

  // ⑤ 真读一次本机 Edge（只报告，不判失败：Edge 可能开着/没装/没登录/全是 v20）
  const outFile = path.join(os.tmpdir(), `vgrab-edge-verify-${Date.now()}.txt`);
  const real = await m.exportEdgeCookies({ outFile, hosts: m.DEFAULT_HOSTS, log: () => {} });
  let realNote;
  if (real.ok) {
    const size = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
    realNote = `导出 ${real.exported} 条（配置 ${real.profile}，文件 ${size} 字节，v20 跳过 ${real.skippedV20 || 0} 条）`;
    try { fs.unlinkSync(outFile); } catch { /* ignore */ }
  } else {
    realNote = real.locked ? 'Edge 正在运行（cookie 库被独占，属正常现象）' : String(real.error || '未知原因');
  }
  console.log(`  · 本机 Edge 实测：${realNote}`);

  const allOk = ok1 && ok2 && ok3 && ok4 && sameMod;
  if (!allOk) bad += 1;
  console.log(allOk ? '\nPASS Edge cookie 检查通过' : '\nFAIL Edge cookie 检查未通过');
  process.exitCode = allOk ? 0 : 1;
}

// ── 本地确定性测试：下载队列（多条链接同时进来不能丢）──────────────────────────
//
// 2026-10-17 用户报「同时收到两个视频链接只会下载一条」。根因是两处状态挂在模块作用域：
//   · 第二条链接在 `waiting` 里排队，热重载 `dispose()` 里的 `waiting.length = 0`
//     把那个 Promise 直接丢掉 —— 永不 resolve，视频人间蒸发；
//   · `recent/running` 每个实例一份，换实例后同一链接可能被重下。
// 现在状态挂在全局符号上、dispose 不再清队列。这条用例用"睡一会儿就返回假 JSON"的假工具，
// 把三种情形都压一遍（不需要网络）。
if (process.argv.includes('--queue')) {
  console.log('\n=== 下载队列（多条链接、热重载中也不能丢任务）===');
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'vgrab-queue-test-'));
  const fakeTool = path.join(box, 'tool');
  const fakeOut = path.join(box, 'out');
  fs.mkdirSync(path.join(fakeTool, 'src'), { recursive: true });
  fs.mkdirSync(fakeOut, { recursive: true });
  fs.writeFileSync(
    path.join(fakeTool, 'src', 'cli.js'),
    [
      "const fs=require('fs'),path=require('path');",
      'const argv=process.argv.slice(2);',
      'const out=argv[argv.indexOf("-o")+1];',
      'const ticks=Number(process.env.FAKE_TICKS||8);',
      'new Promise((r)=>{let i=0;const t=setInterval(()=>{i++;if(i>=ticks){clearInterval(t);r();}},100);}).then(()=>{',
      // ⚠️ 每个 URL 产出**不同文件名 + 不同字节数**：否则"同一个视频不重复发"那道兜底
      // 会把测试里两个不同视频当成同一个，用例就会假失败（踩过一次）。
      '  const url=String(argv[0]||"x");',
      '  let h=0; for (const ch of url) h=((h*31)+ch.charCodeAt(0))>>>0;',
      '  const size=1024+(h%512);',
      '  const f=path.join(out,"clip-"+h.toString(16)+".mp4");',
      '  fs.writeFileSync(f, Buffer.alloc(size, 7));',
      '  process.stdout.write(JSON.stringify([{ok:true,filePath:f,bytes:size,title:"fake",engine:"fake"}])+"\\n");',
      '});'
    ].join('\n'),
    'utf8'
  );
  const keep = { toolRoot: settings.toolRoot, outDir: settings.outDir, concurrency: settings.concurrency, notifySuccess: settings.notifySuccess };
  Object.assign(settings, { toolRoot: fakeTool, outDir: fakeOut, concurrency: 1, notifySuccess: false, notifyFailure: true });
  process.env.FAKE_TICKS = '8';   // 每个任务约 0.8 秒

  const mediaCalls = [];
  const queueSender = {
    async sendMedia(chatKey, segments) { mediaCalls.push(segments.length); return { message_id: 1 }; },
    async sendTextBatch() {},
    async sendImage() {}
  };
  const callUrl = (url, chatId = '10001') => mod.providers['media.download']({ url, sender: queueSender, kind: 'group', chatId, text: url });
  const settle = (p, ms, label) => Promise.race([p, new Promise((r) => setTimeout(() => r({ timeout: label }), ms))]);

  // ① 两条链接并发（不重载）
  let before = mediaCalls.length;
  const r1 = await Promise.all([
    settle(callUrl('https://b23.tv/QUEUEAAA1'), 20000, 'A1'),
    settle(callUrl('https://b23.tv/QUEUEBBB2'), 20000, 'B2')
  ]);
  const ok1 = r1.every((x) => x && x.ok === true) && mediaCalls.length - before === 2;
  if (!ok1) bad += 1;
  console.log(`  ${ok1 ? '✓' : '✗'} 两条链接并发：${r1.map((x) => (x && x.ok ? 'ok' : JSON.stringify(x))).join(' / ')}，媒体发送 ${mediaCalls.length - before} 次（应 2）`);

  // ② **不同群**贴同一条链接 → 两个群各要一份，都得下
  //    （2026-10-17 用户报"不同群的同一条链接只识别了其中一个下载"：去重键原来只有 url，
  //      A 群下了之后 B 群被判成"刚处理过"直接跳过。现在键是 `会话::链接`。）
  before = mediaCalls.length;
  const sameUrl = 'https://b23.tv/QUEUESHARE';
  const g1 = await callUrl(sameUrl, '20001');
  const g2 = await callUrl(sameUrl, '20002');
  const ok2 = g1 && g1.ok === true && g2 && g2.ok === true && mediaCalls.length - before === 2;
  if (!ok2) bad += 1;
  console.log(`  ${ok2 ? '✓' : '✗'} 不同群同一条链接各下一份：群A ${JSON.stringify(g1?.ok ?? g1)}，群B ${JSON.stringify(g2?.ok ?? g2)}，媒体发送 ${mediaCalls.length - before} 次（应 2）`);

  // ③ 同一个群里同一条链接短时间重复 → 只处理一次（必须在 ④ 之前：④ 会 dispose 这个实例，
  //    dispose 之后它按设计不再认领新链接，那正是它该有的行为）
  before = mediaCalls.length;
  const dupUrl = 'https://b23.tv/QUEUEEEE5';
  const first = await callUrl(dupUrl);
  const dup = await callUrl(dupUrl);
  const ok3 = first && first.ok === true && dup && dup.skip === true && mediaCalls.length - before === 1;
  if (!ok3) bad += 1;
  console.log(`  ${ok3 ? '✓' : '✗'} 同群同链接 10 分钟内只处理一次（第一次 ${JSON.stringify(first)}，第二次 ${JSON.stringify(dup)}，媒体发送 ${mediaCalls.length - before} 次）`);

  // ③b 同一条链接的**不同写法**（带分享参数 / 不带）也必须只下一次、只发一次
  //     （2026-10-17 一天两次"同一个视频发了两遍"：一条消息里同时有
  //       `https://b23.tv/X?share_medium=…&ts=…` 和 `https://b23.tv/X`）
  const keyA = mod.canonicalUrlKey('https://b23.tv/EkiPKno?share_medium=android&share_source=qq&bbid=ABCDEF&ts=1792234427801');
  const keyB = mod.canonicalUrlKey('https://b23.tv/EkiPKno');
  const keyC = mod.canonicalUrlKey('https://www.bilibili.com/video/BV1xx411c7mD/?p=2&spm_id_from=333.999&vd_source=abc');
  const keyD = mod.canonicalUrlKey('https://www.bilibili.com/video/BV1xx411c7mD/?p=3&spm_id_from=333.999');
  const keyOk = keyA === keyB && keyC !== keyD && keyC.includes('p=2') && !keyC.includes('spm_id_from');
  if (!keyOk) bad += 1;
  console.log(`  ${keyOk ? '✓' : '✗'} 链接归一化：分享参数不影响去重（${keyA}），分 P 仍然区分（${keyC} ≠ ${keyD}）`);

  before = mediaCalls.length;
  const a1 = await callUrl('https://b23.tv/QUEUEFORM1?share_medium=android&share_source=qq&bbid=XYZ&ts=1792234427801', '30001');
  const a2 = await callUrl('https://b23.tv/QUEUEFORM1', '30001');
  const ok3b = a1 && a1.ok === true && a2 && a2.skip === true && mediaCalls.length - before === 1;
  if (!ok3b) bad += 1;
  console.log(`  ${ok3b ? '✓' : '✗'} 同群"带分享参数 / 干净短链"只下一次（第一次 ${JSON.stringify(a1?.ok ?? a1)}，第二次 ${JSON.stringify(a2)}，媒体发送 ${mediaCalls.length - before} 次）`);

  // ③c 同一个视频即使被**不同链接**触发，发送端也只发一次（按 会话+文件名+字节数 兜底）
  before = mediaCalls.length;
  const sameVideo = { dir: box, video: path.join(box, 'clip.mp4'), audio: '', images: [], other: '' };
  const fakeSender = {
    async sendMedia() {
      mediaCalls.push(1);
      return { message_id: 1 };
    },
    async sendTextBatch() {},
    async sendImage() {}
  };
  if (!fs.existsSync(sameVideo.video)) fs.writeFileSync(sameVideo.video, Buffer.alloc(4096, 5));
  const d1 = await mod.deliver({ sender: fakeSender, chatKey: 'group:30002', artifacts: sameVideo, url: 'x1', title: 't', c: settings, log: () => {} });
  const d2 = await mod.deliver({ sender: fakeSender, chatKey: 'group:30002', artifacts: sameVideo, url: 'x2', title: 't', c: settings, log: () => {} });
  const ok3c = /已发送视频/.test(String(d1)) && /已跳过/.test(String(d2)) && mediaCalls.length - before === 1;
  if (!ok3c) bad += 1;
  console.log(`  ${ok3c ? '✓' : '✗'} 同一个视频第二次不再发（${JSON.stringify(d1)} → ${JSON.stringify(d2)}，媒体发送 ${mediaCalls.length - before} 次）`);

  // ④ 第二条还在排队时热重载（dispose）—— 绝不能丢任务。**必须放最后**：dispose 不可逆
  before = mediaCalls.length;
  const p2a = callUrl('https://b23.tv/QUEUECCC3');
  const p2b = callUrl('https://b23.tv/QUEUEDDD4');
  await new Promise((r) => setTimeout(r, 150));   // 让第一条占住 slot，第二条进队列
  mod.dispose();
  const r2 = await Promise.all([settle(p2a, 20000, 'C3'), settle(p2b, 20000, 'D4')]);
  const ok4 = r2.every((x) => x && x.ok === true) && mediaCalls.length - before === 2;
  if (!ok4) bad += 1;
  console.log(`  ${ok4 ? '✓' : '✗'} 排队期间热重载：${r2.map((x) => (x && x.ok ? 'ok' : JSON.stringify(x))).join(' / ')}，媒体发送 ${mediaCalls.length - before} 次（应 2；dispose 清空队列会变成 1 且卡住不返回）`);

  const allQueueOk = ok1 && ok2 && ok3 && ok4;
  delete process.env.FAKE_TICKS;
  Object.assign(settings, keep);
  try {
    fs.rmSync(box, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  console.log(allQueueOk ? '\nPASS 下载队列检查通过' : '\nFAIL 下载队列检查未通过');
  process.exitCode = allQueueOk ? 0 : 1;
}

// ── 本地确定性测试：确定性搜图指令（「我要 xxx 的图」→ 0 token 直接搜图）──────
if (process.argv.includes('--cmd')) {
  console.log('\n=== 确定性搜图指令（0 token）===');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const srcRoot = path.dirname(fileURLToPath(import.meta.url));
  const srcCmd = path.join(srcRoot, 'image-request', 'search-command.mjs');
  const dstCmd = path.join(APP_DIR, 'plugins', 'video-downloader', 'search-command.mjs');
  const appJs = path.join(APP_DIR, 'src', 'app.js');

  // ① 识别：句式命中与「不该命中」都要对（这些用例是踩过误报之后定下来的）
  const same = fs.existsSync(dstCmd) && fs.readFileSync(srcCmd, 'utf8') === fs.readFileSync(dstCmd, 'utf8');
  if (!same) bad += 1;
  console.log(`  ${same ? '✓' : '✗'} 部署副本与源码一致${same ? '' : `（跑一次 deploy.cmd；缺的是 ${dstCmd}）`}`);
  // 刚刚就被这个坑过一次：改了源码忘了 deploy，测的其实是旧副本（结果白排查半天）
  for (const f of ['index.js', 'plugin.json']) {
    const a = path.join(srcRoot, 'video-downloader', f);
    const b = path.join(APP_DIR, 'plugins', 'video-downloader', f);
    const eq = fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a, 'utf8') === fs.readFileSync(b, 'utf8');
    if (!eq) bad += 1;
    console.log(`  ${eq ? '✓' : '✗'} 部署副本与源码一致（${f}）${eq ? '' : '（跑一次 deploy.cmd）'}`);
  }

  const matcher = await import(pathToFileURL(srcCmd).href);
  const hitCases = [
    ['我要初音ミク的图', '初音ミク', 0],
    ['我要看初音ミク的图', '初音ミク', 0],
    ['来点猫娘的图', '猫娘', 0],
    ['来张猫娘的图', '猫娘', 0],
    ['有没有猫娘的图', '猫娘', 0],
    ['来3张猫娘的图', '猫娘', 3],
    ['@小鲸鱼(QQ:1) 我要猫娘的图', '猫娘', 0],
    // 2026-10-18 现场：「来点レイジ的图」被判"句式不匹配" —— 关键词校验只认汉字/拉丁，
    // 假名（还有韩文/俄文）全被当成"没内容"。pixiv 的标签绝大多数是日文，这条必须过。
    ['来点レイジ的图', 'レイジ', 0],
    ['@陈千语 来点レイジ的图', 'レイジ', 0],
    ['来点ゆかり的图', 'ゆかり', 0]
  ];
  for (const [text, kw, count] of hitCases) {
    const r = matcher.matchSearchCommand(text);
    const ok = !!(r && r.keyword === kw && r.count === count);
    if (!ok) bad += 1;
    console.log(`  ${ok ? '✓' : '✗'} 命中 ${JSON.stringify(text)} → ${r ? `「${r.keyword}」×${r.count}` : 'null'}`);
  }
  for (const text of ['刚刚那张图', '我要这张图的出处', '有没有什么好看的图', '来点图', '今天天气不错']) {
    const r = matcher.matchSearchCommand(text);
    const ok = r === null;
    if (!ok) bad += 1;
    console.log(`  ${ok ? '✓' : '✗'} 不命中 ${JSON.stringify(text)} → ${r ? `「${r.keyword}」` : 'null'}`);
  }
  const atOther = matcher.matchSearchCommand('@张三 我要猫娘的图', { atOthers: true });
  if (atOther !== null) bad += 1;
  console.log(`  ${atOther === null ? '✓' : '✗'} @ 了别人时不认领`);

  // ② 运行时钩子：装在核心**每条消息的必经点**（Orchestrator.onIncoming）上。
  //    这是现在的正路（不用改核心文件、不用重启）；核心补丁那条路只是备用。
  const orchUrl = pathToFileURL(path.join(APP_DIR, 'src', 'orchestrator.js')).href;
  let proto = null;
  try {
    const core = await import(orchUrl);
    proto = core?.Orchestrator?.prototype || null;
  } catch (error) {
    console.log(`  ✗ 无法加载核心 orchestrator.js：${error?.message ?? error}`);
  }
  const hookInstalled = await mod.installOrchestratorHook();
  const hasHook = typeof proto?.onIncoming === 'function';
  const okHook = hookInstalled === true && hasHook;
  if (!okHook) bad += 1;
  console.log(`  ${okHook ? '✓' : '✗'} 运行时钩子已挂上 onIncoming`);

  if (okHook) {
    // 用一个探针当"原方法"，验证：命中的消息被 veto（探针**不该**被调用）、不命中的照常转交
    mod.uninstallOrchestratorHook();
    const savedOnIncoming = proto.onIncoming;
    let probeCalls = 0;
    const probeOnIncoming = function probeOnIncoming() { probeCalls += 1; return 'probe'; };
    proto.onIncoming = probeOnIncoming;
    await mod.installOrchestratorHook();
    // install 时那次"链上还调得到我吗"的探测会落到这个假原方法上一次（链上还没有壳），
    // 那是安装动作不是消息，归零后再数消息。
    probeCalls = 0;

    // 假编排器：只要 store.markEntryRead / sender 两个东西
    const read = new Set();
    const notices = [];        // 插件"自己发出去的话"（失败提示等）
    const fakeOrch = {
      store: {
        markEntryRead(chatKey, id) {
          const k = `${chatKey}#${id}`;
          if (read.has(k)) return false;
          read.add(k);
          return true;
        }
      },
      sender: {
        async sendMedia() { return { message_id: 1 }; },
        async sendTextBatch(chatKey, lines) { notices.push({ chatKey, lines: Array.isArray(lines) ? lines : [lines] }); }
      },
      onebot: { selfId: '1' }
    };
    Object.assign(settings, { toolRoot: path.join(os.tmpdir(), 'vgrab-nonexistent-toolroot'), searchCommand: true, searchSendMode: 'download' });

    const hitEntry = { id: 7, self: false, text: '我要猫娘的图', atNames: [], atMe: false, senderId: '1', senderName: '测试' };
    proto.onIncoming.call(fakeOrch, 'group:10001', hitEntry);
    const missEntry = { id: 8, self: false, text: '今天天气不错', atNames: [], atMe: false, senderId: '1', senderName: '测试' };
    proto.onIncoming.call(fakeOrch, 'group:10001', missEntry);
    const vetoOk = probeCalls === 1 && read.has('group:10001#7') && !read.has('group:10001#8');
    if (!vetoOk) bad += 1;
    console.log(
      `  ${vetoOk ? '✓' : '✗'} 命中句式被 veto：原方法只被调了 ${probeCalls} 次（应 1，即只有不命中那条），` +
        `命中那条已标已读=${read.has('group:10001#7')}，不命中那条未被标=${!read.has('group:10001#8')}`
    );

    // 已读标记失败时**不能** veto（否则未读挂着，兜底定时器照样叫模型）
    read.add('group:10001#9');
    const blockedEntry = { id: 9, self: false, text: '来张猫娘的图', atNames: [], atMe: false, senderId: '1', senderName: '测试' };
    proto.onIncoming.call(fakeOrch, 'group:10001', blockedEntry);
    const fallbackOk = probeCalls === 2;
    if (!fallbackOk) bad += 1;
    console.log(`  ${fallbackOk ? '✓' : '✗'} 标已读失败时不 veto（原方法被调用，交给模型）`);

    // 搜图失败必须回话（2026-10-18 用户报"pixiv 搜图失败没有在群内反馈"）：
    // 命中后消息被 veto、模型不会出场，工具又是不存在的目录 → 必定失败。
    // 这时插件必须自己往群里发一句失败原因，否则用户只看到"发了指令没人理"。
    await sleep(1200);
    const noticeLines = notices.flatMap((n) => n.lines || []);
    const failNoticeOk = noticeLines.some((l) => /搜图|下载工具|失败|Pixiv/.test(String(l)));
    if (!failNoticeOk) bad += 1;
    console.log(
      `  ${failNoticeOk ? '✓' : '✗'} 指令失败会回话：${noticeLines.length ? JSON.stringify(noticeLines.slice(0, 2)) : '（什么都没发）'}`
    );
    notices.length = 0;

    mod.uninstallOrchestratorHook();
    proto.onIncoming = savedOnIncoming;
    await mod.installOrchestratorHook();   // 探针撤掉后把真钩子装回来，后面的检查按"钩子在位"走

    // 热重载不串味：链上的环必须**在调用时**去读"当前实现"，而不是用自己闭包里那份旧代码
    // （踩过：功能生效了但日志一行没有 —— 跑的是旧实例那份没有 logger 的实现）
    const IMPL_KEY = Symbol.for('qq-agent.video-downloader.orch.onIncoming.impl');
    const savedImpl = globalThis[IMPL_KEY];
    let spyCalls = 0;
    globalThis[IMPL_KEY] = () => { spyCalls += 1; return 'veto'; };
    const spyEntry = { id: 11, self: false, text: '随便什么话', atNames: [], atMe: false, senderId: '1', senderName: 't' };
    proto.onIncoming.call(fakeOrch, 'group:10001', spyEntry);
    const implIndirectOk = spyCalls === 1 && probeCalls === 2;
    if (!implIndirectOk) bad += 1;
    console.log(`  ${implIndirectOk ? '✓' : '✗'} 链环走"当前实现"指针（换成第三份实现也立刻生效，原方法未被调用）`);
    globalThis[IMPL_KEY] = savedImpl;

    // 热重载自愈（2026-10-17 真实现场）：**dispose 不许摘壳**。
    // 当时的表现是"指令发出去没日志、没图、没反应"：新旧实例的 install / dispose 在同
    // 一秒里交错，旧实例 dispose 读到的是新实例刚写下的记录，把新实例的壳当成自己的
    // 还原掉 —— 链上只剩原方法，连"未认领"都打不出来，根本没法查。
    const shellBefore = proto.onIncoming;
    mod.uninstallOrchestratorHook();
    const shellKept = proto.onIncoming === shellBefore;
    if (!shellKept) bad += 1;
    console.log(`  ${shellKept ? '✓' : '✗'} dispose 不摘壳（壳留着无害，摘了就会静默失效）`);

    // 万一壳真的不在了（旧版本留下的、或别的插件还原错），install 必须自己挂回来
    proto.onIncoming = probeOnIncoming;               // 模拟"链上只剩原方法"
    const healed = await mod.installOrchestratorHook();
    probeCalls = 0;                                   // 同上：install 里那次探测不算消息
    const healEntry = { id: 21, self: false, text: '我要猫娘的图', atNames: [], atMe: false, senderId: '1', senderName: '测试' };
    proto.onIncoming.call(fakeOrch, 'group:10001', healEntry);
    const healOk = healed === true && read.has('group:10001#21') && probeCalls === 0;
    if (!healOk) bad += 1;
    console.log(
      `  ${healOk ? '✓' : '✗'} 壳被摘掉后 install 自愈重挂（命中照旧 veto，原方法被调 ${probeCalls} 次，应 0）`
    );
  }

  // ③ 备用路径：核心若打了 image-request 补丁就报个状态（没打是正常的，不影响上面那条）
  const core = fs.existsSync(appJs) ? fs.readFileSync(appJs, 'utf8') : '';
  const corePatched = core.includes('/* image-request patch */');
  console.log(
    `  · 核心补丁（可选备用路径）：${corePatched ? '已打（会先于钩子认领，两条路不会重复跑）' : '未打（现在走运行时钩子，不需要它）'}`
  );
  if (corePatched) {
    const okTwoArg = /store\.markEntryRead\(\s*`\$\{kind\}:\$\{id\}`\s*,\s*entry\.id\s*\)/.test(core);
    if (!okTwoArg) bad += 1;
    console.log(`  ${okTwoArg ? '✓' : '✗'} 核心补丁里标已读用的是 (chatKey, id) 两个参数`);
  }

  // ③ 备用路径（核心打了补丁时才会被调）：钩子在位时**必须不认领**，否则两边都下、重复发
  const hookOnSkip = await mod.handleImageRequest({
    text: '我要猫娘的图', kind: 'group', chatId: '10001', chatKey: 'group:10001', atNames: [], atOthers: false
  });
  const skipOk = hookOnSkip?.skip === true;
  if (!skipOk) bad += 1;
  console.log(`  ${skipOk ? '✓' : '✗'} 钩子在位时备用路径不认领（${JSON.stringify(hookOnSkip)}）`);

  // ④ 标已读的语义：这一步真的踩过坑 —— markEntryRead 要 **(chatKey, id) 两个参数**，
  //    第一次打补丁只传了 id，不报错、静默无效，于是消息仍是未读，兜底定时器随后
  //    又把模型叫起来看它（白烧 6.7 万 prompt token，表现就是"补丁没生效"）。
  //    这里把核心的 store.js 复制到临时目录（配一个改过 DATA_DIR 的 config），
  //    用真实代码验一遍两种调用方式的差别，绝不碰用户的真实消息存档。
  const storeSrc = path.join(APP_DIR, 'src', 'store.js');
  if (fs.existsSync(storeSrc)) {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'vgrab-store-test-'));
    try {
      fs.writeFileSync(
        path.join(box, 'config.mjs'),
        `export const DATA_DIR = ${JSON.stringify(path.join(box, 'data'))};\nexport const ROOT = ${JSON.stringify(box)};\n`,
        'utf8'
      );
      const src = fs.readFileSync(storeSrc, 'utf8').replace("from './config.js'", "from './config.mjs'");
      fs.writeFileSync(path.join(box, 'store.mjs'), src, 'utf8');
      const { ChatStore } = await import(pathToFileURL(path.join(box, 'store.mjs')).href);
      const st = new ChatStore();
      const ck = 'group:999999999';
      const entry = st.appendIncoming(ck, { mid: 1, ts: Date.now(), senderId: '1', senderName: '测试', text: '我要猫娘的图', media: [] });
      const before = st.unreadCount(ck);
      const oneArg = st.markEntryRead(entry.id);                 // 旧补丁的写法
      const mid = st.unreadCount(ck);
      const twoArg = st.markEntryRead(ck, entry.id);             // 正确写法
      const after = st.unreadCount(ck);
      const peek = st.peekUnread(ck, 5).length;
      const okStore = before === 1 && oneArg === false && mid === 1 && twoArg === true && after === 0 && peek === 0;
      if (!okStore) bad += 1;
      console.log(
        `  ${okStore ? '✓' : '✗'} 标已读语义：单参数返回 ${oneArg}（应 false，未读仍 ${mid}），` +
          `双参数返回 ${twoArg}（应 true，未读变 ${after}）；未读列表剩 ${peek} 条`
      );
    } catch (error) {
      bad += 1;
      console.log(`  ✗ 标已读语义检查出错：${error?.message ?? error}`);
    } finally {
      try {
        fs.rmSync(box, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  // ⑤ 脱网端到端：假的工具目录 + 假的 cli.js，验证"认领 → 后台搜图 → 不发消息"。
  //    这条走的是**备用路径**（能力提供者），所以先把运行时钩子摘掉，测完再装回去。
  mod.uninstallOrchestratorHook();
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vgrab-cmd-test-'));
  const fakeOut = path.join(fakeRoot, 'out');
  fs.mkdirSync(path.join(fakeRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(fakeRoot, 'src', 'cli.js'),
    `const fs=require('fs'),path=require('path');\n` +
      `const argv=process.argv.slice(2);\n` +
      `const out=argv[argv.indexOf('-o')+1]||'.';\n` +
      `const kw=argv[argv.indexOf('--pixiv-search')+1]||'kw';\n` +
      `const dir=path.join(out,kw+' by 测试作者');\n` +
      `fs.mkdirSync(dir,{recursive:true});\n` +
      `fs.writeFileSync(path.join(dir,'001.png'),Buffer.alloc(4096,1));\n` +
      `fs.writeFileSync(path.join(dir,'002.png'),Buffer.alloc(4096,2));\n` +
      `process.stdout.write(JSON.stringify([{ok:true,pid:'123456',title:kw,author:'测试作者',files:[path.join(dir,'001.png'),path.join(dir,'002.png')],bytes:8192,dir,backend:'lolicon/tag'}])+'\\n');\n`,
    'utf8'
  );

  const cmdSends = [];
  const cmdSender = {
    async sendMedia(chatKey, segments) { cmdSends.push({ kind: 'media', n: segments.length }); return { message_id: 1 }; },
    async sendTextBatch(chatKey, msgs) { cmdSends.push({ kind: 'text', msgs }); }
  };
  const keep = { toolRoot: settings.toolRoot, outDir: settings.outDir, searchSendMode: settings.searchSendMode, searchCommand: settings.searchCommand };
  Object.assign(settings, { toolRoot: fakeRoot, outDir: fakeOut, searchSendMode: 'download', searchCommand: true });

  const logStart = capturedLogs.length;
  const r1 = await mod.handleImageRequest({
    text: '我要猫娘的图', kind: 'group', chatId: '10001', chatKey: 'group:10001',
    sender: cmdSender, atNames: [], atOthers: false
  });
  const claimed = r1?.handled === true && r1?.keyword === '猫娘';
  if (!claimed) bad += 1;
  console.log(`  ${claimed ? '✓' : '✗'} 命中句式被认领：${JSON.stringify(r1)}`);

  // 认领必须**立刻**返回（核心在消息入库前 await 它）：这里量一下
  const t0 = Date.now();
  await mod.handleImageRequest({ text: '来张猫娘的图', kind: 'group', chatId: '10001', chatKey: 'group:10001', sender: cmdSender });
  const elapsed = Date.now() - t0;
  const fast = elapsed < 1500;
  if (!fast) bad += 1;
  console.log(`  ${fast ? '✓' : '✗'} 提供者立刻返回（${elapsed}ms，下载在后台跑）`);

  // 等后台那两次下载跑完（假 cli 只写两个小文件，很快）
  for (let i = 0; i < 40 && !capturedLogs.slice(logStart).some((l) => /搜图完成（只下载，未发消息）/.test(l)); i += 1) {
    await sleep(250);
  }
  const downloaded = capturedLogs.slice(logStart).filter((l) => /搜图完成（只下载，未发消息）/.test(l)).length;
  const quietOk = cmdSends.length === 0 && downloaded >= 1;
  if (!quietOk) bad += 1;
  console.log(`  ${quietOk ? '✓' : '✗'} 下载在后台完成 ${downloaded} 次，往群里发了 ${cmdSends.length} 条（应为 0）`);

  const files = fs.existsSync(fakeOut)
    ? fs.readdirSync(fakeOut, { withFileTypes: true }).filter((e) => e.isDirectory()).length
    : 0;
  const filesOk = files >= 1;
  if (!filesOk) bad += 1;
  console.log(`  ${filesOk ? '✓' : '✗'} 图确实落到磁盘（${files} 个作品子目录）`);

  // 不命中的句子 / @ 别人 / 开关关掉 → 一律不认领（消息照旧走模型）
  const skips = [
    ['不命中的句子', { text: '今天天气不错' }, {}],
    ['@ 了别人', { text: '@张三 我要猫娘的图', atOthers: true }, {}],
    ['开关被关掉', { text: '我要猫娘的图' }, { searchCommand: false }]
  ];
  for (const [label, payload, patchCfg] of skips) {
    Object.assign(settings, { searchCommand: true }, patchCfg);
    const r = await mod.handleImageRequest({ kind: 'group', chatId: '10001', chatKey: 'group:10001', sender: cmdSender, ...payload });
    const ok = r?.skip === true;
    if (!ok) bad += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${label} → ${JSON.stringify(r)}（应为 skip）`);
  }

  // ⑥ send 模式：收到指令先发「开始搜图了」，图下好后、发图**之前**发「图片正在发送」
  //    （2026-10-19 用户要求：这句是"图马上来"的预告，必须在图片前面；图后不再收尾）
  Object.assign(settings, { searchCommand: true, searchSendMode: 'send', toolRoot: fakeRoot, outDir: fakeOut });
  const order = [];
  const sendSender = {
    async sendMedia(chatKey, segments) {
      order.push(`media:${segments.map((s) => s.type).join('+')}`);
      return { message_id: 1 };
    },
    async sendTextBatch(chatKey, msgs) {
      order.push(`text:${msgs.join('')}`);
    }
  };
  const rSend = await mod.handleImageRequest({    text: '来张猫娘的图', kind: 'group', chatId: '10001', chatKey: 'group:10001', sender: sendSender, atNames: [], atOthers: false
  });
  // 等到图片发出来再断言（图片是一张一条，来源说明在它们之后，单独用单元断言验证）
  for (let i = 0; i < 40 && !order.some((x) => x.startsWith('media:image')); i += 1) await sleep(250);
  // 2026-10-18 起图片是**一张一条消息**发（一批多图会让整条消息被 QQ 丢掉，见 README），
  // 所以这里断言的是"顺序"：开始 → 正在发送 → 每张图各一条（后面不再有文字）。
  // 2026-10-19 起两句固定话都带关键词（`开始搜图了：猫娘`），避免被发送管道的 8 秒去重吃掉。
  const mediaCount = order.filter((x) => x.startsWith('media:image')).length;
  // 顺序断言：开始 → 图片正在发送 → 每张图各一条。
  // 「来源说明」那句单独用**单元断言**（backendNoteText）验证 —— 它依赖工具 JSON 里的 backend，
  // 而这里的假工具不保证字段齐全，放进顺序断言会变成"测假数据"而不是测行为。
  const okSend =
    rSend?.handled === true &&
    order.length >= 3 &&
    order[0].startsWith('text:开始搜图了') &&
    order[0].includes('猫娘') &&
    order[1].startsWith('text:图片正在发送') &&
    order[1].includes('猫娘') &&
    mediaCount >= 1 &&
    order.slice(2).every((x) => x.startsWith('media:image'));
  if (!okSend) bad += 1;
  // 来源说明的三档文案（2026-10-19 用户要求：图发完后自动说一句走的是哪条搜索路）
  const noteCases = [
    ['pixiv-native', 'Pixiv 官方搜索'],
    ['lolicon/tag', '第三方聚合接口'],
    ['缓存（3 分钟前搜过）', '缓存']
  ];
  for (const [backend, want] of noteCases) {
    const got = mod.backendNoteText(backend, '猫娘');
    const ok = got.includes(want) && got.includes('猫娘');
    if (!ok) bad += 1;
    console.log(`  ${ok ? '✓' : '✗'} 来源说明（${backend}）→ ${got}`);
  }
  console.log(`  ${okSend ? '✓' : '✗'} send 模式顺序：${order.join(' → ') || '(什么都没发)'}`);
  // 两句固定话必须是**插件自己通过发送管道直接发**（不经过模型）：上面用的就是 sender 探针，
  // 能收到 text 说明走的是 ctx.sender.sendTextBatch；而固定句式那条路模型根本不会被叫醒（veto）。
  const directOk = order.filter((x) => x.startsWith('text:')).length >= 2;
  if (!directOk) bad += 1;
  console.log(`  ${directOk ? '✓' : '✗'} 两句固定话由插件直接发出（sender.sendTextBatch，不经模型）`);

  Object.assign(settings, keep);
  try {
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  await mod.installOrchestratorHook();   // 把钩子装回去（后面 --cmd-live 等要用）
  console.log(bad === 0 ? '\nPASS 确定性搜图指令检查通过' : `\nFAIL ${bad} 项`);
  process.exitCode = bad === 0 ? 0 : 1;
}

// ── 真实网络：确定性搜图指令跑一遍（真的搜 Pixiv、真的落盘，但一条消息都不发）──
// 用法：node qqagent-plugin/verify.mjs --cmd-live      （CMD=「我要初音ミク的图」可改）
if (process.argv.includes('--cmd-live')) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = process.env.CMD || '我要初音ミク的图';
  console.log(`\n=== 真实网络：确定性搜图指令「${text}」（searchSendMode=download）===`);
  Object.assign(settings, { searchCommand: true, searchSendMode: 'download', searchCount: 1 });

  const sends = [];
  const spy = {
    async sendMedia() { sends.push('media'); return { message_id: 1 }; },
    async sendTextBatch() { sends.push('text'); }
  };
  // 走**真实生产路径**：核心每条消息的必经点（onIncoming 钩子）→ 命中 → veto
  await mod.installOrchestratorHook();
  const read = new Set();
  const fakeOrch = {
    store: { markEntryRead(chatKey, id) { const k = `${chatKey}#${id}`; if (read.has(k)) return false; read.add(k); return true; } },
    sender: spy,
    onebot: { selfId: '1' }
  };
  const entry = { id: 1, self: false, text, atNames: [], atMe: false, senderId: '1', senderName: '测试' };
  const before = capturedLogs.length;
  const t0 = Date.now();
  const verdict = mod.handleIncomingHook(fakeOrch, 'group:10001', entry);
  const claimMs = Date.now() - t0;
  const vetoed = verdict === 'veto' && read.has('group:10001#1');
  console.log(`  钩子判定：${JSON.stringify(verdict)}（${claimMs}ms 返回，条目已标已读=${read.has('group:10001#1')}）—— 下载在后台`);

  for (let i = 0; i < 120; i += 1) {
    if (capturedLogs.slice(before).some((l) => /搜图完成（只下载，未发消息）|搜图失败/.test(l))) break;
    await sleep(500);
  }
  const lines = capturedLogs.slice(before).filter((l) => /搜图完成（只下载，未发消息）|搜图失败/.test(l));
  for (const l of lines) console.log(`    ${l}`);

  const ok = vetoed && sends.length === 0 && lines.some((l) => /搜图完成（只下载，未发消息）/.test(l));
  console.log(`  ${ok ? '✓' : '✗'} veto（不排会话）→ 后台下载完成 → 一条消息都没发（发送 ${sends.length} 次）`);
  console.log(ok ? '\nPASS 真实指令检查通过' : '\nFAIL 真实指令检查未通过');
  process.exitCode = ok ? 0 : 1;
}
