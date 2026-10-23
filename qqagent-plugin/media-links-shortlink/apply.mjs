#!/usr/bin/env node
// 核心补丁：`src/media-links.js` 的链接提取**只按短链域名剥掉查询串**。
//
// ── 为什么 ────────────────────────────────────────────────────────────────
// 群友转发 B 站视频时，消息里常常是这种卡片：
//
//   [卡片消息] 哔哩哔哩 https://b23.tv/EkiPKno?share_medium=android&share_source=qq&bbid=…&ts=…
//
// `extractCandidateUrls` 里有两条正则：一条截带协议的完整链接、一条专门兜"裸短链"
// （`b23.tv/xxx`）。于是**同一条消息抽出两个 URL**：一个带一堆分享参数、一个干净短链。
// 两者字符串不同 → 派发两次 → 插件各下一次、各发一遍（2026-10-17 一天两次"同一视频发两次"）。
//
// 补丁只做一件事：短链域名（b23.tv / v.douyin.com / …）的查询串整段丢掉 ——
// 那些参数纯粹是分享来源，跟"下到哪一条内容"无关。
// 插件端也做了同样的归一化（`canonicalUrlKey`），所以不打这个补丁功能也正常；
// 打了只是从**源头**少派发一次（省一次下载和一次日志噪音）。
//
// ── 用法 ──────────────────────────────────────────────────────────────────
//   node qqagent-plugin/media-links-shortlink/apply.mjs            # 打补丁 + 自检
//   node qqagent-plugin/media-links-shortlink/apply.mjs --check    # 只看状态（不改文件）
//   node qqagent-plugin/media-links-shortlink/apply.mjs --revert   # 还原
//   node qqagent-plugin/media-links-shortlink/apply.mjs --app "D:\别的路径\resources\app"
//
// ⚠️ 改的是**核心文件**，要**重启 QQ Agent** 才生效（插件热重载，核心不是）；
//    QQ Agent 升级会覆盖 resources/app → 补丁没了，重新跑一次即可。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_APP = 'D:\\qqagent\\QQ Agent\\resources\\app';
const MARK = '/* media-links shortlink patch */';

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const APP_DIR = argValue('--app', process.env.QQ_AGENT_APP || DEFAULT_APP);
const TARGET = path.join(APP_DIR, 'src', 'media-links.js');
const BACKUP = `${TARGET}.bak-shortlink`;

const mode = process.argv.includes('--revert')
  ? 'revert'
  : process.argv.includes('--check')
    ? 'check'
    : 'apply';

function fail(message) {
  console.log(`✗ ${message}`);
  process.exitCode = 1;
}

if (!fs.existsSync(TARGET)) {
  fail(`找不到核心文件：${TARGET}（用 --app 指定 resources/app）`);
  process.exit(1);
}

const source = fs.readFileSync(TARGET, 'utf8');
const patched = source.includes(MARK);

console.log(`核心文件：${TARGET}`);
console.log(`当前状态：${patched ? '已打补丁' : '未打补丁'}`);

// ── 撤回 ─────────────────────────────────────────────────────────────────
if (mode === 'revert') {
  if (!fs.existsSync(BACKUP)) {
    fail(`没有备份可还原（${BACKUP}）`);
    process.exit(1);
  }
  fs.copyFileSync(BACKUP, TARGET);
  console.log('✓ 已从备份还原（重启 QQ Agent 后生效）');
  process.exit(0);
}

// ── 补丁内容（插在 extractCandidateUrls 前面）─────────────────────────────
const HELPER = `
${MARK}
/**
 * 短链域名的查询串只是分享参数（share_medium / share_source / bbid / ts …），
 * 跟"下到哪一条内容"无关。剥掉它，同一条卡片消息里的"带参完整链接"和"裸短链"
 * 才会被当成同一条 —— 否则会被派发两次，导致同一个视频下两遍、发两遍。
 */
const SHORT_LINK_HOSTS = new Set([
  'b23.tv',
  'v.douyin.com',
  'v.iesdouyin.com',
  'v.kuaishou.com',
  'xhslink.com',
  't.cn',
  'url.cn'
]);

function normalizeCandidateUrl(u) {
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase().replace(/^www\\./, '');
    if (!SHORT_LINK_HOSTS.has(host)) return u;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\\/+$/, '');
  } catch {
    return u;
  }
}
`;

const ANCHOR = 'export function extractCandidateUrls(';
// 目标行：`const u = String(raw).replace(/[.,;:]+$/, '').replace(/\/+$/, '');`
const LINE_RE = /^([ \t]*)const u = String\(raw\)\.replace\([^\n]*$/m;

/** 用**打完补丁的真实模块**验证行为 */
async function verify() {
  const url = `${pathToFileURL(TARGET).href}?v=${Date.now()}`;
  const mod = await import(url);
  const card =
    '[卡片消息] 哔哩哔哩 https://b23.tv/EkiPKno?share_medium=android&share_source=qq&bbid=XX1&ts=1792234427801';
  const got = mod.extractCandidateUrls(card);
  const okSingle = got.length === 1 && got[0] === 'https://b23.tv/EkiPKno';

  const multi = mod.extractCandidateUrls('https://www.bilibili.com/video/BV1xx411c7mD/?p=2&spm_id_from=333');
  const okMulti = multi.length === 1 && multi[0].includes('p=2');

  const two = mod.extractCandidateUrls('看这个 https://b23.tv/AAA111 还有 https://b23.tv/BBB222');
  const okTwo = two.length === 2;

  console.log(`  ${okSingle ? '✓' : '✗'} 卡片消息只抽出 1 个 URL（实际 ${got.length} 个：${JSON.stringify(got)}）`);
  console.log(`  ${okMulti ? '✓' : '✗'} 分 P 的查询串保留（${JSON.stringify(multi)}）`);
  console.log(`  ${okTwo ? '✓' : '✗'} 两条不同短链仍然都保留（${two.length} 条）`);
  return okSingle && okMulti && okTwo;
}

if (mode === 'check') {
  if (!patched) {
    console.log('结论：未打补丁（同一条卡片消息会被派发两次；插件端归一化仍然兜得住）');
    process.exit(0);
  }
  const ok = await verify();
  console.log(ok ? '结论：已打补丁且行为正确' : '结论：已打补丁但行为不对，建议 --revert 后重新打');
  process.exit(ok ? 0 : 1);
}

if (patched) {
  const ok = await verify();
  console.log(ok ? '✓ 补丁已在位，行为正确（无需重复打）' : '✗ 补丁在但行为不对，请先 --revert');
  process.exit(ok ? 0 : 1);
}

if (!source.includes(ANCHOR)) {
  fail(`没找到插入锚点 ${ANCHOR} —— 核心版本可能变了`);
  process.exit(1);
}
const line = source.match(LINE_RE);
if (!line) {
  fail('没找到需要替换的归一化那一行（核心可能改过写法）');
  process.exit(1);
}

fs.copyFileSync(TARGET, BACKUP);

const newLine =
  `${line[1]}const u = normalizeCandidateUrl(String(raw).replace(/[.,;:]+$/, '').replace(/\\/+$/, ''));`;
let next = source.replace(ANCHOR, `${HELPER}${ANCHOR}`);
next = next.replace(line[0], newLine);
fs.writeFileSync(TARGET, next, 'utf8');
console.log(`✓ 补丁已写入（备份：${BACKUP}）`);

const ok = await verify();
if (!ok) {
  fs.copyFileSync(BACKUP, TARGET);
  fail('自检没过，已自动还原');
  process.exit(1);
}
console.log('✓ 自检通过 —— **重启 QQ Agent 后生效**');
console.log('  （插件端 video-downloader 的 canonicalUrlKey 也在做同样的归一化，重启前照样兜得住）');
