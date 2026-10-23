// 给 QQ Agent 核心打「卡片 → 链接」补丁（可撤销、可校验、幂等）
//
// 用法：
//   node qqagent-plugin/card-links/apply.mjs --check     只检查当前状态（不写盘）
//   node qqagent-plugin/card-links/apply.mjs             打补丁（会先备份 + 自动校验）
//   node qqagent-plugin/card-links/apply.mjs --revert    从备份还原
//   node qqagent-plugin/card-links/apply.mjs --app "D:\别的路径\resources\app"
//
// 补的是什么（src/onebot.js 的 segmentsToText）：
//   原来：case 'json': out.push('[卡片消息]'); break;   ← 卡片里的链接被整个丢掉
//   之后：json / xml / share 三种段都交给插件里的 card-links.mjs 转译成
//         `[卡片消息] 标题 https://…`，链接于是进了消息文本，
//         src/media-links.js 的链接转发就能认领它（自动下载转发），模型也看得见。
//
// ⚠️ 两点必须知道：
//   1. 改的是**核心文件**，所以要**重启 QQ Agent** 才生效（插件是热重载的，核心不是）；
//   2. QQ Agent 升级会覆盖 resources/app → 补丁没了（表现是"卡片又只剩 [卡片消息]"）。
//      升级后重跑一次本脚本即可；转译逻辑在插件目录里，不受升级影响。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MARK = '/* card-links patch */';
const DEFAULT_APP = 'D:\\qqagent\\QQ Agent\\resources\\app';

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const APP_DIR = argValue('--app', process.env.QQ_AGENT_APP || DEFAULT_APP);
const ONEBOT = path.join(APP_DIR, 'src', 'onebot.js');
const BACKUP = path.join(APP_DIR, 'src', 'onebot.js.bak-cardlinks');
const PLUGIN_MODULE_REL = '../plugins/video-downloader/card-links.mjs';

const mode = process.argv.includes('--revert') ? 'revert' : process.argv.includes('--check') ? 'check' : 'apply';

function fail(message) {
  console.log(`✗ ${message}`);
  process.exitCode = 1;
}

// 校验失败时自动还原，绝不把坏掉的核心留在磁盘上（核心坏了 QQ Agent 起不来）
function autoRestore(reason) {
  if (!fs.existsSync(BACKUP)) {
    console.log(`  ⚠️ ${reason}，但找不到备份，请手动还原：${BACKUP}`);
    return;
  }
  fs.copyFileSync(BACKUP, ONEBOT);
  console.log(`  ↩ 已自动还原 src/onebot.js（原因：${reason}），QQ Agent 保持可用状态`);
}

if (!fs.existsSync(ONEBOT)) {
  fail(`找不到核心文件：${ONEBOT}\n  （用 --app 指定 QQ Agent 的 resources/app 目录）`);
  process.exit(1);
}

const source = fs.readFileSync(ONEBOT, 'utf8');
const patched = source.includes(MARK);

console.log(`核心文件：${ONEBOT}`);
console.log(`当前状态：${patched ? '已打补丁' : '未打补丁'}`);
console.log(`转译模块：${path.join(APP_DIR, 'plugins', 'video-downloader', 'card-links.mjs')}（相对路径 ${PLUGIN_MODULE_REL}）`);

// ── 撤回 ─────────────────────────────────────────────────────────────────
if (mode === 'revert') {
  if (!fs.existsSync(BACKUP)) {
    fail(`没有备份可还原（${BACKUP}）`);
    process.exit(1);
  }
  fs.copyFileSync(BACKUP, ONEBOT);
  console.log('✓ 已从备份还原 src/onebot.js（记得重启 QQ Agent 生效）');
  process.exit(0);
}

// ── 检查 ─────────────────────────────────────────────────────────────────
if (mode === 'check') {
  const modulePath = path.join(APP_DIR, 'plugins', 'video-downloader', 'card-links.mjs');
  console.log(`模块是否存在：${fs.existsSync(modulePath) ? '是' : '否（缺它补丁会退回占位符）'}`);
  console.log(patched ? '结论：已打补丁（卡片会被转译成链接）' : '结论：未打补丁（卡片只剩 [卡片消息]）');
  process.exit(0);
}

// ── 打补丁 ───────────────────────────────────────────────────────────────
if (patched) {
  console.log('✓ 已经打过补丁了，不需要重复打（幂等）');
  process.exit(0);
}

const caseRe = /^([ \t]*)case 'json': out\.push\('\[卡片消息\]'\); break;[ \t]*$/m;
if (!caseRe.test(source)) {
  fail('没找到预期的 `case \'json\': out.push(\'[卡片消息]\'); break;` —— 核心版本可能变了，请人工确认后改脚本');
  process.exit(1);
}

if (!fs.existsSync(BACKUP)) {
  fs.copyFileSync(ONEBOT, BACKUP);
  console.log(`✓ 已备份原文件 → ${path.basename(BACKUP)}`);
}

const newCases = [
  `$1// card-links patch：卡片（json/xml/share）里的链接交给插件转译，链接转发与模型才看得见`,
  `$1case 'json':`,
  `$1case 'xml':`,
  `$1case 'share':`,
  `$1  out.push(await cardSegmentText(seg));`,
  `$1  break;`,
].join('\n');

let next = source.replace(caseRe, newCases);

const helper = `
${MARK}
/**
 * 卡片段 → 文本。真正的解析在插件里（plugins/video-downloader/card-links.mjs），
 * 这样核心升级覆盖后只要重新插回这几行；模块缺失/报错时退回原来的占位符，绝不因此报错。
 */
async function cardSegmentText(seg) {
  const type = String(seg?.type ?? '').toLowerCase();
  const placeholder = type === 'json' ? '[卡片消息]' : \`[\${type || '未知'}]\`;
  try {
    // ⚠️ 带 cache-bust：模块 URL 不带查询串时，ESM 注册表会一直返回进程**最早**加载的那份，
    // 改了 card-links.mjs 也不会生效（只能重启 QQ Agent）—— 同一类"静默跑旧代码"的坑。
    // 用「分钟」做桶：刷新最多延迟一分钟，又不会每条卡片消息都新建一个模块实例。
    const url = new URL('${PLUGIN_MODULE_REL}', import.meta.url);
    url.searchParams.set('v', String(Math.floor(Date.now() / 60000)));
    const mod = await import(url.href);
    return await mod.cardSegmentToText(seg);
  } catch (error) {
    console.error('[card-links] 卡片转译失败，退回占位符：', error?.message ?? error);
    return placeholder;
  }
}

`;
const anchor = 'export async function segmentsToText(';
if (!next.includes(anchor)) {
  fail(`没找到插入锚点 ${anchor} —— 核心版本可能变了`);
  process.exit(1);
}
next = next.replace(anchor, `${helper}${anchor}`);

fs.writeFileSync(ONEBOT, next, 'utf8');
console.log('✓ 补丁已写入 src/onebot.js');

// ── 校验：真的 import 一次改完的核心，把样例卡片喂进去 ─────────────────────
const samples = [
  {
    label: 'json 卡片（B站）',
    seg: {
      type: 'json',
      data: {
        data: JSON.stringify({
          app: 'com.tencent.structmsg',
          meta: { news: { title: '测试视频标题', jumpUrl: 'https://b23.tv/AvOCzlr' } },
        }),
      },
    },
    expect: 'https://b23.tv/AvOCzlr',
  },
  {
    label: 'xml 卡片',
    seg: { type: 'xml', data: { data: '<msg><item><title>标题</title><url>https://v.douyin.com/abcd/</url></item></msg>' } },
    expect: 'https://v.douyin.com/abcd/',
  },
  { label: 'share 段', seg: { type: 'share', data: { url: 'https://b23.tv/xyz789', title: '一个视频' } }, expect: 'https://b23.tv/xyz789' },
  { label: '普通文本不受影响', seg: { type: 'text', data: { text: '大家好啊' } }, expect: '大家好啊' },
];

try {
  const mod = await import(`${pathToFileURL(ONEBOT).href}?t=${Date.now()}`);
  let bad = 0;
  for (const s of samples) {
    const text = await mod.segmentsToText([s.seg]);
    const ok = text.includes(s.expect);
    if (!ok) bad += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${s.label}: ${text.slice(0, 90)}`);
  }
  console.log(bad === 0 ? '✓ 校验通过：卡片链接已进入消息文本' : `✗ 校验失败（${bad} 项）—— 可用 --revert 还原`);
  if (bad !== 0) {
    process.exitCode = 1;
    autoRestore('校验不通过');
  }
} catch (error) {
  fail(`校验时无法加载改后的核心：${error?.message ?? error}`);
  autoRestore('改后的核心无法加载');
}

console.log('\n⚠️ 核心文件改动需要**重启 QQ Agent** 才生效（插件是热重载，核心不是）。');
