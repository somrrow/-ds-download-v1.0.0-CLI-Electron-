// 把「肥鱼当劳（ds-download）」的**基础功能**内置进 QQ Agent 插件，之后插件不再依赖外部工具目录。
//
// 用法：
//   node qqagent-plugin/bundle-tool.mjs                 内置：CLI + 核心引擎 + yt-dlp/ffmpeg
//   node qqagent-plugin/bundle-tool.mjs --no-tools      不带 yt-dlp/ffmpeg（首次用时工具自己下载）
//   node qqagent-plugin/bundle-tool.mjs --skip-existing 二进制已存在就不重复复制（deploy 时用）
//   node qqagent-plugin/bundle-tool.mjs --with-electron  连"渲染引擎"（Electron 运行时）一起内置
//   node qqagent-plugin/bundle-tool.mjs --app "D:\别的路径\resources\app"
//
// 只保留**基础功能**，明确不带走这些东西：
//   · src/gui/        桌面界面（Electron 窗口、渲染层、logo）—— 插件在 QQ Agent 里跑，要界面干嘛
//   · build/ dist/    打包脚本与打包产物
//   · *.ico / *.png   图标、界面 logo
//   · tests/          测试夹具（30 万行模拟服务器那种）
//   · tools/history.json、tools/login-cookies.txt —— **本机用户数据，绝不外发**
//
// 目标结构：
//   plugins/video-downloader/
//     index.js / plugin.json / card-links.mjs / search-command.mjs
//     tool/                     ← 内置的工具（插件用 QQ Agent 自带的 Electron 当 Node 跑它）
//       src/cli.js  src/core/**  package.json  README.txt
//       tools/yt-dlp.exe  tools/ffmpeg.exe
//
// 为什么只带源码、不带 Electron：QQ Agent 自己就是 Electron，子进程用
// `process.execPath + ELECTRON_RUN_AS_NODE=1` 就是现成的 Node 运行时 —— 再塞一份 250MB 的
// Electron 毫无意义。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

function argValue(name, fallback = '') {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const APP_DIR = argValue('--app', process.env.QQ_AGENT_APP || 'D:\\qqagent\\QQ Agent\\resources\\app');
const PLUGIN_DIR = argValue('--plugin-dir', path.join(APP_DIR, 'plugins', 'video-downloader'));
const TOOL_DIR = path.join(PLUGIN_DIR, 'tool');
const withTools = !has('--no-tools');
const skipExisting = has('--skip-existing');

const stat = (p) => { try { return fs.statSync(p); } catch { return null; } };
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyDir(src, dst, filter = () => true) {
  const st = stat(src);
  if (!st || !st.isDirectory()) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (!filter(from, entry)) continue;
    if (entry.isDirectory()) n += copyDir(from, to, filter);
    else if (entry.isFile()) { copyFile(from, to); n += 1; }
  }
  return n;
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const s = stat(p); if (s) total += s.size; }
    }
  };
  walk(dir);
  return total;
}

console.log(`把工具的基础功能内置进插件：${TOOL_DIR}`);

if (!stat(path.join(PLUGIN_DIR, 'plugin.json'))) {
  console.error(`✗ 插件目录不对（没有 plugin.json）：${PLUGIN_DIR}`);
  process.exit(1);
}
if (!stat(path.join(ROOT, 'src', 'cli.js'))) {
  console.error(`✗ 工程目录不对（没有 src/cli.js）：${ROOT}`);
  process.exit(1);
}

// ── 1) 清干净再放（改名/删文件时不留幽灵文件）──────────────────────────────
// tools/ 留着，免得每次部署都重复搬 96MB；--no-tools 时把二进制一并清掉。
fs.rmSync(path.join(TOOL_DIR, 'src'), { recursive: true, force: true });
fs.rmSync(path.join(TOOL_DIR, 'build'), { recursive: true, force: true });
fs.rmSync(path.join(TOOL_DIR, 'dist'), { recursive: true, force: true });
fs.rmSync(path.join(TOOL_DIR, 'tests'), { recursive: true, force: true });
fs.rmSync(path.join(TOOL_DIR, 'README.md'), { force: true });
fs.rmSync(path.join(TOOL_DIR, 'README.txt'), { force: true });
if (!withTools) fs.rmSync(path.join(TOOL_DIR, 'tools'), { recursive: true, force: true });
fs.mkdirSync(TOOL_DIR, { recursive: true });

// ── 2) 基础功能：CLI + 核心引擎（界面只留"无界面浏览器助手"那一层）──────────
// src/gui/main.js / preload.js **要留**：抖音这类站点必须用内置浏览器渲染，
// 工具是拿 Electron（`electron.exe <工具目录>`）跑这两个文件里的"页面抽取 / 浏览器内请求 /
// 登录"三个无界面模式。真正属于"界面"的是 renderer/（HTML/CSS/JS + logo），那部分不带。
const GUI_KEEP = new Set(['main.js', 'preload.js']);
const srcCount = copyDir(
  path.join(ROOT, 'src'),
  path.join(TOOL_DIR, 'src'),
  (from, entry) => {
    const base = path.basename(from);
    if (base === 'gui' && entry?.isDirectory()) return true;   // 目录本身放行，文件在下面逐个筛
    if (path.basename(path.dirname(from)) === 'gui' && entry?.isFile()) return GUI_KEEP.has(entry.name);
    if (path.basename(path.dirname(from)) === 'gui' && entry?.isDirectory()) return false; // renderer/ 不要
    return true;
  },
);
const rendererLeft = stat(path.join(TOOL_DIR, 'src', 'gui', 'renderer'));
const helperLeft = stat(path.join(TOOL_DIR, 'src', 'gui', 'main.js'));
console.log(
  `  ✓ src/：${srcCount} 个文件，${mb(dirSize(path.join(TOOL_DIR, 'src')))}` +
    `（界面渲染层 ${rendererLeft ? '✗ 还在' : '✓ 已排除'}，无界面浏览器助手 ${helperLeft ? '✓ 在' : '✗ 缺了'}）`
);
if (rendererLeft || !helperLeft) {
  console.error('✗ src/gui 的处理不对：renderer 必须排除，main.js/preload.js 必须保留（浏览器兜底要用）');
  process.exit(1);
}

// package.json：去掉 devDependencies；main 指向"无界面浏览器助手"（浏览器兜底子进程的入口）
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const shipped = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  description: `${pkg.description}（内置到 QQ Agent 插件的基础版：命令行 + 下载引擎，不含桌面界面）`,
  main: pkg.main,
  bin: pkg.bin,
  engines: pkg.engines,
};
fs.writeFileSync(path.join(TOOL_DIR, 'package.json'), `${JSON.stringify(shipped, null, 2)}\n`, 'utf8');

const readme = `这是「肥鱼当劳（ds-download）」内置到 QQ Agent 插件里的**基础版**。
包含命令行（src/cli.js）、下载引擎（src/core/**），以及**无界面**的浏览器助手
（src/gui/main.js + preload.js —— 抖音这类站点要靠它渲染页面；它不会开窗口、也没有界面文件）。

- 谁在跑它：plugins/video-downloader/index.js，用 QQ Agent 自带的 Electron 当 Node
  （ELECTRON_RUN_AS_NODE=1）拉起 src/cli.js，不需要系统装 Node；
  需要渲染页面时，工具会再拿同一个 Electron 二进制起一个**隐藏窗口**（VIDEOGRAB_ELECTRON 指过去）。
- 数据在哪：设置/历史/Cookie 在 QQ Agent 的 data/video-downloader，yt-dlp/ffmpeg 用本目录 tools/ 里那份。
  登录 Cookie 会自动复用桌面版导出的那份（插件会显式 --cookies 传进来）。
- 想单独用命令行：cd 到本目录，然后
    set ELECTRON_RUN_AS_NODE=1
    "D:\\qqagent\\QQ Agent\\QQ Agent.exe" src\\cli.js --help
- 怎么重新内置：在工程根目录跑 node qqagent-plugin/bundle-tool.mjs

（本文件由 bundle-tool.mjs 生成，别手改。）
`;
fs.writeFileSync(path.join(TOOL_DIR, 'README.txt'), readme, 'utf8');
console.log(`  ✓ package.json（${pkg.name} v${pkg.version}，无 devDependencies；main 指向无界面浏览器助手）+ README.txt`);

// ── 3) yt-dlp / ffmpeg（可选，带上才叫"开箱即用"）──────────────────────────
const TOOL_BINARIES = process.platform === 'win32' ? ['yt-dlp.exe', 'ffmpeg.exe'] : ['yt-dlp', 'ffmpeg'];
const copiedBins = [];
if (withTools) {
  for (const name of TOOL_BINARIES) {
    const from = path.join(ROOT, 'tools', name);
    const to = path.join(TOOL_DIR, 'tools', name);
    const s = stat(from);
    if (!s) continue;
    const t = stat(to);
    if (skipExisting && t && t.size === s.size) continue;
    copyFile(from, to);
    copiedBins.push(`${name}（${mb(s.size)}）`);
  }
  if (copiedBins.length) console.log(`  ✓ tools/：${copiedBins.join('、')}`);
  else console.log('  · tools/：本机 tools/ 里没有 yt-dlp/ffmpeg（或已是最新），跳过');
} else {
  console.log('  · --no-tools：不带 yt-dlp/ffmpeg（首次使用时工具会自己下载）');
}

// ── 3.5) 渲染引擎（可选，--with-electron）────────────────────────────────
// 抖音这类站点的签名是 JS 算的，工具得用 Chromium 起一个**隐藏窗口**渲染页面。
// 那需要一个**未打包的** Electron 二进制（打包过的 exe 不认传入的 app 目录，实测无效）。
// 不带也能跑：插件会去源码工程的 node_modules 里找一份用（见 index.js 的 findBrowserRuntime），
// 找不到就只是"需要渲染的站点失败"。要彻底不依赖外部目录，就用这个开关把它一起带上。
let electronNote = '';
if (has('--with-electron')) {
  const src = path.join(ROOT, 'node_modules', 'electron', 'dist');
  const dst = path.join(TOOL_DIR, 'electron');
  const srcExe = path.join(src, process.platform === 'win32' ? 'electron.exe' : 'electron');
  const dstExe = path.join(dst, process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (!stat(srcExe)) {
    console.log('  · --with-electron：本机没装 Electron（node_modules/electron/dist 不存在），跳过');
  } else if (skipExisting && stat(dstExe) && stat(dstExe).size === stat(srcExe).size) {
    console.log(`  ✓ 渲染引擎已在位（${mb(dirSize(dst))}），跳过重复复制`);
  } else {
    fs.rmSync(dst, { recursive: true, force: true });
    const n = copyDir(src, dst);
    electronNote = `  ✓ 渲染引擎：Electron 运行时 ${n} 个文件，${mb(dirSize(dst))}（tool/electron/）`;
    console.log(electronNote);
  }
} else {
  console.log('  · 没带渲染引擎（抖音这类要渲染的站点会用源码工程里的 Electron；彻底免外部依赖就加 --with-electron，+210MB）');
}

// ── 4) 用户数据 / 界面残留绝不进包 ────────────────────────────────────────
// 目标目录里可能残留上一次运行写下的 history.json（工具默认把历史写在 tools 目录，
// 插件现在用 VIDEOGRAB_HISTORY_FILE 把它指到数据目录去了）。这类文件直接清掉，
// 而不是让整次部署失败 —— 它们不是从源码复制来的。
for (const f of ['history.json', 'login-cookies.txt']) {
  const p = path.join(TOOL_DIR, 'tools', f);
  if (stat(p)) {
    fs.rmSync(p, { force: true });
    console.log(`  · 清掉了目标目录里残留的 ${f}（本机用户数据，不应随插件分发）`);
  }
}
fs.rmSync(path.join(TOOL_DIR, 'tools', 'ffmpeg-tmp'), { recursive: true, force: true });

const leaks = ['history.json', 'login-cookies.txt', 'ffmpeg-tmp']
  .filter((f) => stat(path.join(TOOL_DIR, 'tools', f)))
  .concat(['renderer'].filter((f) => stat(path.join(TOOL_DIR, 'src', 'gui', f))));
const strayIcons = [];
const walkForIcons = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walkForIcons(p);
    else if (/\.(ico|icns)$/i.test(e.name)) strayIcons.push(path.relative(TOOL_DIR, p));
  }
};
walkForIcons(TOOL_DIR);
if (leaks.length || strayIcons.length) {
  console.error(`✗ 包里混进了不该有的东西：${[...leaks, ...strayIcons].join('、')}`);
  process.exit(1);
}
console.log('  ✓ 没有界面/图标/本机用户数据');

// ── 5) 自检：内置的这份 CLI 真的能跑 ──────────────────────────────────────
const cli = path.join(TOOL_DIR, 'src', 'cli.js');
const sandbox = path.join(TOOL_DIR, '.selftest');
fs.rmSync(sandbox, { recursive: true, force: true });
const r = spawnSync(process.execPath, [cli, '--help'], {
  cwd: TOOL_DIR,
  encoding: 'utf8',
  windowsHide: true,
  env: { ...process.env, VIDEOGRAB_TOOLS_DIR: path.join(sandbox, 'tools'), VIDEOGRAB_CONFIG_DIR: sandbox },
});
fs.rmSync(sandbox, { recursive: true, force: true });
if (r.status === 0 && /肥鱼当劳|ds-download/.test(String(r.stdout || ''))) {
  console.log('  ✓ 内置的 CLI 自检通过（--help 正常输出）');
} else {
  console.error(`✗ 内置 CLI 跑不起来：${String(r.stderr || r.stdout || '').slice(0, 300)}`);
  process.exit(1);
}

const total = dirSize(TOOL_DIR);
console.log('');
console.log(`完成：内置 ${mb(total)}（${path.relative(PLUGIN_DIR, TOOL_DIR) || 'tool'}）`);
console.log('插件会优先用这份内置工具；设置里的「工具目录」留空即可（填了才走外部目录）。');
