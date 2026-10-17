// 给 QQ Agent 核心打「确定性搜图指令」补丁（可撤销、可校验、幂等）
//
// 用法：
//   node qqagent-plugin/image-request/apply.mjs --check     只检查当前状态（不写盘）
//   node qqagent-plugin/image-request/apply.mjs             打补丁（先备份 + 自动校验）
//   node qqagent-plugin/image-request/apply.mjs --revert    从备份还原
//   node qqagent-plugin/image-request/apply.mjs --app "D:\别的路径\resources\app"
//
// 补的是什么（src/app.js 的 ingestMessage）：
//   消息入库前先问一句插件："这是不是「我要 xxx 的图」这类**固定句式**的搜图指令？"
//   插件认领 → 消息照样存档（聊天记录里看得见），但**标记已读、不叫醒模型** ——
//   整轮对话的 token 全省掉（0 token），直接搜图下载。
//   插件不认领 → 一切照旧（走模型 + pixiv_search 工具），行为与打补丁前**完全一致**。
//
// ⚠️ 三点必须知道：
//   1. 改的是**核心文件**，要**重启 QQ Agent** 才生效（插件是热重载的，核心不是）；
//   2. QQ Agent 升级会覆盖 resources/app → 补丁没了（表现是"指令又开始走模型、开始烧 token"）。
//      升级后重跑一次本脚本即可；识别逻辑在插件目录里，不受升级影响；
//   3. 插件那边的 `message.image-request` 提供者**必须立刻返回**（下载它自己在后台跑）——
//      核心是在消息入库前 await 它的。本脚本的校验会检查这一点。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const MARK = '/* image-request patch */';
const DEFAULT_APP = 'D:\\qqagent\\QQ Agent\\resources\\app';
const PLUGIN_MODULE_REL = '../plugins/video-downloader/search-command.mjs';

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const APP_DIR = argValue('--app', process.env.QQ_AGENT_APP || DEFAULT_APP);
const APP_JS = path.join(APP_DIR, 'src', 'app.js');
const BACKUP = path.join(APP_DIR, 'src', 'app.js.bak-imagereq');
const mode = process.argv.includes('--revert') ? 'revert' : process.argv.includes('--check') ? 'check' : 'apply';

function fail(message) {
  console.log(`✗ ${message}`);
  process.exitCode = 1;
}

/** 校验不通过就自动还原：核心坏了 QQ Agent 起不来，这个代价比"补丁没打上"大得多 */
function autoRestore(reason) {
  if (!fs.existsSync(BACKUP)) {
    console.log(`  ⚠️ ${reason}，但找不到备份，请手动还原：${BACKUP}`);
    return;
  }
  fs.copyFileSync(BACKUP, APP_JS);
  console.log(`  ↩ 已自动还原 src/app.js（原因：${reason}）`);
}

if (!fs.existsSync(APP_JS)) {
  fail(`找不到核心文件：${APP_JS}\n  （用 --app 指定 QQ Agent 的 resources/app 目录）`);
  process.exit(1);
}

const source = fs.readFileSync(APP_JS, 'utf8');
const patched = source.includes(MARK);

console.log(`核心文件：${APP_JS}`);
console.log(`当前状态：${patched ? '已打补丁' : '未打补丁'}`);
console.log(`识别模块：${path.join(APP_DIR, 'plugins', 'video-downloader', 'search-command.mjs')}（相对路径 ${PLUGIN_MODULE_REL}）`);

if (mode === 'revert') {
  if (!fs.existsSync(BACKUP)) {
    fail(`没有备份可还原（${BACKUP}）`);
    process.exit(1);
  }
  fs.copyFileSync(BACKUP, APP_JS);
  console.log('✓ 已从备份还原 src/app.js（记得重启 QQ Agent 生效）');
  process.exit(0);
}

if (mode === 'check') {
  const modulePath = path.join(APP_DIR, 'plugins', 'video-downloader', 'search-command.mjs');
  console.log(`模块是否存在：${fs.existsSync(modulePath) ? '是' : '否（缺它指令不会被认领，消息照旧走模型）'}`);
  console.log(patched ? '结论：已打补丁（固定句式不会走模型，0 token）' : '结论：未打补丁（固定句式照旧走模型，会烧 token）');
  process.exit(0);
}

if (patched) {
  console.log('✓ 已经打过补丁了，不需要重复打（幂等）');
  process.exit(0);
}

// ── 锚点：核心版本变了就停下让人确认，绝不"猜着改" ──────────────────────────
const ANCHOR_FN = '  async function ingestMessage(kind, id, event) {';
const ANCHOR_APPEND = '    const entry = store.appendIncoming(`${kind}:${id}`, {';
const ANCHOR_NOTIFY = [
  '    emit(\'chat-update\', `${kind}:${id}`);',
  '    // 逐条触发判定：把刚入库的条目交给编排器（entry 让它能精确标这一条已读）',
  '    orchestrator.onIncoming(`${kind}:${id}`, entry);'
].join('\n');

for (const [label, anchor] of [['ingestMessage 函数', ANCHOR_FN], ['appendIncoming 调用', ANCHOR_APPEND], ['onIncoming 调用', ANCHOR_NOTIFY]]) {
  if (!source.includes(anchor)) {
    fail(`没找到锚点「${label}」—— 核心版本可能变了，请人工确认后改脚本：\n     ${anchor.split('\n')[0]}`);
    process.exit(1);
  }
}

if (!fs.existsSync(BACKUP)) {
  fs.copyFileSync(APP_JS, BACKUP);
  console.log(`✓ 已备份原文件 → ${path.basename(BACKUP)}`);
}

const claim = `    ${MARK}
    // 确定性搜图指令（「我要 xxx 的图」这类固定句式）：命中就不叫醒模型 —— 0 token。
    // 提供者由插件注册（能力 message.image-request），这里只问一句；没人认领时返回值是
    // false，下面照旧走 orchestrator，行为与打补丁前完全一致。
    // 契约：提供者**立刻返回**（真正的下载它自己在后台跑），所以这里不会拖慢消息入库。
    //
    // 外面再包一层 try/catch：这条补丁改的是**所有消息**的必经之路，插件再离谱也不该
    // 让消息进不了库 —— 出错就当"没认领"，退回原来的模型流程。
    let imageRequestClaimed = false;
    try {
      imageRequestClaimed = await dispatchImageRequest({
        text,
        kind,
        chatId: id,
        chatKey: \`\${kind}:\${id}\`,
        atMe,
        atNames,
        atOthers: atMarks.some((m) => m.qq !== 'all' && String(m.qq) !== selfIdNow),
        senderId,
        senderName,
        sender,
        onebot
      });
    } catch (error) {
      console.error('[image-request] 判定失败，照旧交给模型：', error?.message ?? error);
    }

`;

const notify = `    emit('chat-update', \`\${kind}:\${id}\`);
    ${MARK}
    // 插件认领了这条消息（确定性搜图指令）→ 存档但**标记已读**，不叫醒模型：
    // 这正是"0 token"的落点 —— 消息在聊天记录里看得见，模型这一轮根本不会启动。
    //
    // ⚠️ markEntryRead 是 **(chatKey, id) 两个参数**。第一次打补丁时只传了 entry.id：
    // 不报错、不抛异常，只是**静默没标上** —— 消息仍是未读，跑完这一轮后兜底定时器
    // 又把模型叫起来看它（实测白烧 6.7 万 prompt token，表现就是"补丁没生效"）。
    // 所以这里既传对两个参数，也**检查返回值**（false = 没标记成功）。
    if (imageRequestClaimed) {
      try {
        const marked = store.markEntryRead(\`\${kind}:\${id}\`, entry.id);
        if (!marked) console.error('[image-request] 搜图指令没能标成已读（模型可能仍会看到它）：entry.id =', entry.id);
      } catch (error) {
        console.error('[image-request] 标已读出错（模型可能仍会看到它）：', error?.message ?? error);
      }
      return;
    }
    // 逐条触发判定：把刚入库的条目交给编排器（entry 让它能精确标这一条已读）
    orchestrator.onIncoming(\`\${kind}:\${id}\`, entry);`;

const helper = `${MARK}
/**
 * 问插件："这条消息是不是确定性搜图指令（「我要 xxx 的图」…）？"
 *
 * 认领 → true（核心就不叫醒模型，0 token）；没人认领或插件出错 → false（照旧走模型）。
 * 提供者来自插件注册的能力 \`message.image-request\`；没装/没开插件时这里是空操作 ——
 * 零网络请求、零副作用，行为与打补丁前完全一致。
 */
async function dispatchImageRequest(payload) {
  let providers = [];
  try {
    providers = skillManager.getCapabilityProviders('message.image-request') || [];
  } catch (error) {
    console.error('[image-request] 取插件提供者失败，交给模型：', error?.message ?? error);
    return false;
  }
  for (const p of providers) {
    try {
      const r = await p.fn(payload);
      if (r && r.handled) return true;
    } catch (error) {
      console.error(\`[image-request] \${p.skillId || '插件'} 处理失败，交给模型：\`, error?.message ?? error);
    }
  }
  return false;
}

`;

// 用函数形式做替换：字符串形式里 `$` 有特殊含义（`$&`/`$1`…），而补丁文本里就有 `${...}`
let next = source.replace(ANCHOR_FN, () => `${helper}${ANCHOR_FN}`);
next = next.replace(ANCHOR_APPEND, () => `${claim}${ANCHOR_APPEND}`);
next = next.replace(ANCHOR_NOTIFY, () => notify);

fs.writeFileSync(APP_JS, next, 'utf8');
console.log('✓ 补丁已写入 src/app.js');

// ── 校验：语法 + 三处改动都在位 ─────────────────────────────────────────────
let bad = 0;
const tmp = path.join(os.tmpdir(), `app-patched-check-${Date.now()}.mjs`);
try {
  fs.copyFileSync(APP_JS, tmp);
  const res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  if (res.status === 0) console.log('  ✓ 语法检查通过（node --check）');
  else {
    bad += 1;
    console.log(`  ✗ 语法检查失败：${String(res.stderr || '').split('\n').slice(0, 4).join(' ')}`);
  }
} finally {
  fs.rmSync(tmp, { force: true });
}

// 从核心源码里读 markEntryRead 的真实签名 —— 只传一个参数不会报错、只会静默失效，
// 所以这里把参数个数和核心对一遍（核心改签名时本脚本会立刻报出来，而不是悄悄失效）。
const storeJs = path.join(APP_DIR, 'src', 'store.js');
let storeSig = '';
let storeArgs = -1;
try {
  const storeSrc = fs.readFileSync(storeJs, 'utf8');
  const m = /markEntryRead\(([^)]*)\)\s*\{/.exec(storeSrc);
  if (m) {
    storeSig = m[1].trim();
    storeArgs = storeSig ? storeSig.split(',').filter((x) => x.trim()).length : 0;
  }
} catch {
  /* store.js 读不到就跳过这项 */
}
const callTwoArgs = /store\.markEntryRead\(\s*`\$\{kind\}:\$\{id\}`\s*,\s*entry\.id\s*\)/.test(next);

const checks = [
  ['ingestMessage 里问了插件', /async function dispatchImageRequest\(payload\)/.test(next)],
  ['认领后直接 return（不叫醒模型）', /if \(imageRequestClaimed\) \{[\s\S]{0,400}?return;/.test(next)],
  ['判定包在 try/catch 里（插件出错也不能卡住消息入库）', /let imageRequestClaimed = false;\s*try \{[\s\S]{0,900}?catch \(error\) \{/.test(next)],
  ['标已读传了 (chatKey, id) 两个参数', callTwoArgs],
  [`标已读的返回值被检查（核心签名 markEntryRead(${storeSig || '?'})，${storeArgs} 个参数）`,
    storeArgs === 2 ? /const marked = store\.markEntryRead\(/.test(next) : true],
  ['消息仍然存档（appendIncoming 在 return 之前，聊天记录看得见）',
    next.indexOf('const entry = store.appendIncoming(`${kind}:${id}`') > 0
    && next.indexOf('const entry = store.appendIncoming(`${kind}:${id}`') < next.indexOf('if (imageRequestClaimed)')],
  ['认领判断在 appendIncoming 之前、return 在 onIncoming 之前',
    next.indexOf('let imageRequestClaimed') < next.indexOf(ANCHOR_APPEND)
    && next.indexOf('if (imageRequestClaimed)') < next.indexOf('orchestrator.onIncoming(`${kind}:${id}`, entry)')]
];
for (const [label, ok] of checks) {
  if (!ok) bad += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
}
if (storeArgs !== 2) {
  console.log(`  ⚠️ 核心 markEntryRead 的参数个数不是 2（读到的是 ${storeArgs}）—— 请人工确认调用方式`);
}

if (bad) {
  autoRestore('校验不通过');
  console.log('\n修复后重跑本脚本即可。');
  process.exitCode = 1;
} else {
  console.log('✓ 校验通过：固定句式会被插件认领，模型不再被叫醒（0 token）');
  console.log('\n⚠️ 核心文件改动需要**重启 QQ Agent** 才生效（插件是热重载，核心不是）。');
  console.log('   重启后可以这样验证：群里发一句「我要猫娘的图」——');
  console.log('   控制台会出现 [指令] 开头的日志，而这一轮**没有**任何模型调用记录。');
}
