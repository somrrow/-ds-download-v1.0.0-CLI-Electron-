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
const zipOnly = process.argv.includes('--zip') || process.argv.includes('--parse') || process.argv.includes('--cards') || process.argv.includes('--search') || process.argv.includes('--search-live') || process.argv.includes('--cmd') || process.argv.includes('--cmd-live');
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
  try {
    fs.rmSync(box, { recursive: true, force: true });
    if (zipExists) fs.rmSync(zipPath, { force: true });
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

// ── 本地确定性测试：搜图结果怎么处理（只下载 / 只发图 / 图+说明）──────────────
if (process.argv.includes('--search')) {
  console.log('\n=== 搜图结果怎么处理（searchSendMode）===');
  const srcRoot = path.dirname(fileURLToPath(import.meta.url));

  // ① 三种模式的执行计划
  const plans = [
    ['download（默认）', mod.searchPlan('download'), { chat: false, quiet: true, silentModel: true, startText: '', endText: '' }],
    ['images', mod.searchPlan('images'), { chat: true, quiet: true, silentModel: false, startText: '', endText: '' }],
    ['send', mod.searchPlan('send'), { chat: true, quiet: true, silentModel: false, startText: '开始搜图了', endText: '搜图结束了' }],
    ['空值兜底', mod.searchPlan(''), { chat: false, quiet: true, silentModel: true, startText: '', endText: '' }],
    ['乱七八糟的值兜底', mod.searchPlan('PDF'), { chat: false, quiet: true, silentModel: true, startText: '', endText: '' }]
  ];
  for (const [label, got, want] of plans) {
    const ok =
      got.chat === want.chat && got.quiet === want.quiet && got.silentModel === want.silentModel &&
      (got.startText ?? '') === want.startText && (got.endText ?? '') === want.endText;
    if (!ok) bad += 1;
    console.log(
      `  ${ok ? '✓' : '✗'} ${label}: chat=${got.chat} quiet=${got.quiet} silentModel=${got.silentModel}` +
        ` 提示语=${got.startText || '—'}/${got.endText || '—'}`
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
    ['@小鲸鱼(QQ:1) 我要猫娘的图', '猫娘', 0]
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
  const marked = proto?.[Symbol.for('qq-agent.video-downloader.orch.onIncoming')];
  const okHook = hookInstalled === true && hasHook;
  if (!okHook) bad += 1;
  console.log(
    `  ${okHook ? '✓' : '✗'} 运行时钩子已挂上 onIncoming` +
      (marked ? `（原方法已备份：${typeof marked.original === 'function' ? '是' : '否'}）` : '')
  );

  if (okHook) {
    // 用一个探针当"原方法"，验证：命中的消息被 veto（探针**不该**被调用）、不命中的照常转交
    mod.uninstallOrchestratorHook();
    const savedOnIncoming = proto.onIncoming;
    let probeCalls = 0;
    proto.onIncoming = function probeOnIncoming() { probeCalls += 1; return 'probe'; };
    await mod.installOrchestratorHook();

    // 假编排器：只要 store.markEntryRead / sender 两个东西
    const read = new Set();
    const fakeOrch = {
      store: {
        markEntryRead(chatKey, id) {
          const k = `${chatKey}#${id}`;
          if (read.has(k)) return false;
          read.add(k);
          return true;
        }
      },
      sender: { async sendMedia() { return { message_id: 1 }; }, async sendTextBatch() {} },
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
      `process.stdout.write(JSON.stringify([{ok:true,pid:'123456',title:kw,author:'测试作者',files:[path.join(dir,'001.png'),path.join(dir,'002.png')],bytes:8192,dir}])+'\\n');\n`,
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

  // ⑥ send 模式：收到指令先发「开始搜图了」，图片发完再发「搜图结束了」，中间没有别的文字
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
  for (let i = 0; i < 40 && !order.some((x) => x.startsWith('text:搜图结束了')); i += 1) await sleep(250);
  const okSend =
    rSend?.handled === true &&
    order.length === 3 &&
    order[0] === 'text:开始搜图了' &&
    order[1].startsWith('media:image') &&
    order[2] === 'text:搜图结束了';
  if (!okSend) bad += 1;
  console.log(`  ${okSend ? '✓' : '✗'} send 模式顺序：${order.join(' → ') || '(什么都没发)'}`);
  // 这两句必须是**插件自己通过发送管道直接发**（不经过模型）：上面用的就是 sender 探针，
  // 能收到 text 说明走的是 ctx.sender.sendTextBatch；而固定句式那条路模型根本不会被叫醒（veto）。
  const directOk = order.filter((x) => x.startsWith('text:')).length === 2;
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
