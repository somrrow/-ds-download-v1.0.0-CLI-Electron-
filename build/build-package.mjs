// 把工程打成「可分发」的样子（Windows x64，离线可做，不依赖 electron-builder 下载）。
//
//   node build/build-package.mjs              生成 dist/ 下的便携版目录 + zip
//   node build/build-package.mjs --no-zip     只出目录（调试用）
//   node build/build-package.mjs --with-tools 连 yt-dlp/ffmpeg 一起带上（默认带，除非 --no-tools）
//   node build/build-package.mjs --no-tools   不带 yt-dlp/ffmpeg（首启动时由应用自己下载）
//   node build/build-package.mjs --shortcut   顺手在桌面放个快捷方式
//   node build/build-package.mjs --no-rcedit  不把图标/版本信息写进 exe（默认会写，需装 rcedit）
//
// 图标来源：build/icon.png + build/icon.ico。想换成自己的图：
//   npm run icon:from -- "D:\某张图.jpg"      （中心裁正方形，生成多尺寸 ico）
//
// 产物结构（这就是 Electron 认的"已打包"形态，app.isPackaged 为 true）：
//   dist/ds-download-<版本>-win-x64/
//     ds-download.exe         ← 双击即开（Electron 运行时改名而来）
//     *.dll / icudtl.dat / locales/ …        ← Electron 运行时
//     resources/app/          ← 应用本体（src/、package.json、tools/ 种子）
//     使用说明.txt
//     ds-download.cmd         ← 用打包进来的 exe 当 Node 跑 CLI（机器上没 Node 也能用）
//     vgrab.cmd               ← 同上，老名字留着的入口
//
// ⚠️ 刻意不打包的东西：node_modules（运行时用不到，纯垃圾）、tools/history.json、
//    tools/login-cookies.txt 之类**用户数据**（那是本机的，不能发出去）。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version || '0.0.0';
/** 中文名（给人看的：窗口标题、快捷方式、说明文件） */
const DISPLAY_NAME = '肥鱼当劳';
/** 英文名（给机器看的：exe / 目录 / zip / 批处理 —— 纯 ASCII，任何代码页都不会乱码） */
const APP_SLUG = 'ds-download';
const OUT_DIR = path.join(ROOT, 'dist');
const FOLDER = `${APP_SLUG}-${version}-win-x64`;
const STAGE = path.join(OUT_DIR, FOLDER);

const withTools = !has('--no-tools');
const makeZip = !has('--no-zip');

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

console.log(`打包 ${DISPLAY_NAME}（${APP_SLUG}）v${version}（win-x64）`);
console.log(`  工程目录：${ROOT}`);
console.log(`  目标目录：${STAGE}`);

// ── 0) 前置检查 ───────────────────────────────────────────────────────────
const electronDir = path.join(ROOT, 'node_modules', 'electron', 'dist');
if (!stat(path.join(electronDir, 'electron.exe'))) {
  console.error('✗ 找不到 Electron 运行时（node_modules/electron/dist/electron.exe）。先跑一次 npm install。');
  process.exit(1);
}
const electronVersion = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version; } catch { return '?'; }
})();

// ── 1) 干净目录 ───────────────────────────────────────────────────────────
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

// ── 2) Electron 运行时 → 包根目录，electron.exe 改名 ───────────────────────
let runtimeFiles = 0;
for (const entry of fs.readdirSync(electronDir, { withFileTypes: true })) {
  const from = path.join(electronDir, entry.name);
  if (entry.name === 'electron.exe') {
    copyFile(from, path.join(STAGE, `${APP_SLUG}.exe`));
    runtimeFiles += 1;
  } else if (entry.isDirectory()) {
    runtimeFiles += copyDir(from, path.join(STAGE, entry.name));
  } else {
    copyFile(from, path.join(STAGE, entry.name));
    runtimeFiles += 1;
  }
}
console.log(`  ✓ Electron ${electronVersion} 运行时：${runtimeFiles} 个文件，${APP_SLUG}.exe 就位`);

// ── 3) 应用本体 → resources/app（Electron 从这里读 package.json）──────────
const appDir = path.join(STAGE, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });

// package.json：去掉 devDependencies（运行时不需要 Electron 自身），保留 main/bin
const shippedPkg = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  description: pkg.description,
  main: pkg.main,
  bin: pkg.bin,
  engines: pkg.engines,
};
fs.writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify(shippedPkg, null, 2)}\n`, 'utf8');

copyDir(path.join(ROOT, 'src'), path.join(appDir, 'src'));
for (const f of ['README.md']) {
  if (stat(path.join(ROOT, f))) copyFile(path.join(ROOT, f), path.join(appDir, f));
}
// 图标：窗口图标由 main.js 从 resources/app/icon.png 取；.ico 给快捷方式/资源管理器用
const iconPng = path.join(ROOT, 'build', 'icon.png');
const iconIco = path.join(ROOT, 'build', 'icon.ico');
if (!stat(iconPng) || !stat(iconIco)) {
  console.log('  · 图标不存在，先生成（node build/make-icon.mjs）');
  const gen = spawnSync(process.execPath, [path.join(ROOT, 'build', 'make-icon.mjs')], { encoding: 'utf8', windowsHide: true });
  if (gen.status !== 0) console.error(`  ✗ 生成图标失败：${String(gen.stderr || '').slice(0, 200)}`);
}
if (stat(iconPng)) copyFile(iconPng, path.join(appDir, 'icon.png'));
if (stat(iconIco)) copyFile(iconIco, path.join(STAGE, `${APP_SLUG}.ico`));

// ── 3.5) 把图标与版本信息**嵌进 exe 自己**（资源管理器里看到的那个图标）────────
// 快捷方式/窗口图标走 .ico / icon.png 就够了，但 exe 文件本身在资源管理器里显示的图标
// 存在 PE 资源里，不改的话永远是个 Electron 默认图标。rcedit 是最省事的做法（devDependency，
// 不进分发包）；没装就跳过（`--no-rcedit` 可显式跳过，官方文档也会说明这一点）。
const rceditBin = path.join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
const wantRcedit = !has('--no-rcedit');
if (wantRcedit && stat(rceditBin) && stat(iconIco)) {
  const r = spawnSync(
    rceditBin,
    [
      path.join(STAGE, `${APP_SLUG}.exe`),
      '--set-icon', iconIco,
      '--set-version-string', 'ProductName', DISPLAY_NAME,
      '--set-version-string', 'FileDescription', `${DISPLAY_NAME}（${APP_SLUG}）— 本地视频下载工具`,
      '--set-version-string', 'OriginalFilename', `${APP_SLUG}.exe`,
      '--set-file-version', `${version}.0`,
      '--set-product-version', version,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (r.status === 0) console.log(`  ✓ 已把图标与版本信息写进 ${APP_SLUG}.exe（资源管理器里也是这张图）`);
  else console.log(`  · rcedit 打图标失败（不影响使用，exe 图标仍是默认的）：${String(r.stderr || '').slice(0, 160)}`);
} else if (wantRcedit) {
  console.log('  · 没装 rcedit，跳过「exe 内嵌图标」（npm i -D rcedit 之后重跑即可）');
}
const srcFiles = dirSize(path.join(appDir, 'src'));
console.log(`  ✓ 应用代码：src/ 共 ${mb(srcFiles)}`);

// ── 4) yt-dlp / ffmpeg 种子（可选）───────────────────────────────────────
// 打包后应用会把工具放到 userData/tools（安装目录一般只读），所以这里是"种子"：
// 首次启动由 main.js 复制过去。**不复制用户数据**（history.json / login-cookies.txt）。
const TOOL_SEED = ['yt-dlp.exe', 'ffmpeg.exe'];
let seeded = [];
if (withTools) {
  for (const name of TOOL_SEED) {
    const from = path.join(ROOT, 'tools', name);
    if (!stat(from)) continue;
    copyFile(from, path.join(appDir, 'tools', name));
    seeded.push(`${name}（${mb(stat(from).size)}）`);
  }
  if (seeded.length) console.log(`  ✓ 工具种子：${seeded.join('、')}`);
  else console.log('  · 本地 tools/ 里没有 yt-dlp/ffmpeg，跳过（首启动时应用会自己下载）');
}

// ── 5) 说明与命令行入口 ──────────────────────────────────────────────────
const readme = `${DISPLAY_NAME}（${APP_SLUG}）v${version} — Windows 64 位 · 免安装

一、怎么用
  1) 先把整个压缩包**解压**（别在压缩软件里直接双击 exe，那样每次都会重解一遍）；
  2) 进文件夹双击「${APP_SLUG}.exe」即可打开界面（不用装 Node、不用装任何东西）；
  3) 如果 Windows 弹出「已保护你的电脑」：点「更多信息」→「仍要运行」（exe 没有数字签名，
     从网上传过来的文件第一次打开都会这样，只需一次）。

二、第一次用要注意
  · 下载目录默认是「下载」文件夹，可在界面里改。
  · yt-dlp / ffmpeg ${seeded.length ? '已经随包带上，首次启动会自动复制到用户数据目录，不用再下载。' : '还没随包带上：第一次下载视频/图片时应用会自己下载（需要联网）。'}
  · 设置、下载历史、登录 Cookie 都存在 %APPDATA%\\${APP_SLUG} 下，不在这个文件夹里。
    （老版本叫 videograb，第一次启动会自动把老目录里的设置/历史/登录态搬过来。）

三、支持的链接
  B站（含 b23.tv 短链、专栏、图文、直播）、抖音（视频/图文/短链）、YouTube、Twitter/X、
  Instagram、TikTok、快手、小红书、微博、知乎、Pixiv、微信文章，以及任意直链
  （.mp4/.mkv/.webm/.m3u8/.mp3…）。图文帖会按图片保存，多图作品会连每一页一起下。

四、命令行（可选）
  本机没装 Node 也能用 —— ${APP_SLUG}.cmd / vgrab.cmd 会拿包里的 exe 当 Node 跑
  （两个名字内容一样，ds-download.cmd 是新的英文名，vgrab.cmd 留给老习惯）：
  ${APP_SLUG}.cmd --help
  ${APP_SLUG}.cmd "https://www.bilibili.com/video/BV1xx411c7mD" -o D:\\视频
  ${APP_SLUG}.cmd --pixiv-search "初音ミク" --count 3

五、常见问题
  · 界面打不开：先在任务管理器里结束残留的「${APP_SLUG}.exe」，再重开。
  · 站点要登录（会员清晰度）：界面里「登录」区点一下，用内置浏览器登录一次即可。
  · 下不动、报网络错误：多半是站点需要代理 —— 界面里填代理，或开系统代理后点「测试代理」。
  · Pixiv：本工具走公开检索接口 + 反代，**不需要代理**也能搜图和取图。

本工具只做个人学习与自用；下载内容请遵守各站点条款与当地法律。
`;

// 批处理只能放 ASCII：一旦写进中文（比如直接写 exe 名），在 `ascii` 编码下落盘会变成 `????.exe`，
// cmd 找不到可执行文件（踩过：命令行.cmd 报 "'??' 不是内部或外部命令"）。
// 所以用通配符把同目录里那个唯一的 exe 找出来，脚本内容全程 ASCII，任何代码页都不会乱。
const cmdShim = `@echo off
rem Run the bundled CLI without Node installed: uses the packaged Electron binary as Node.
rem Usage: ds-download.cmd --help   /   ds-download.cmd "URL" -o D:\\videos
setlocal
set "HERE=%~dp0"
set "HERE=%HERE:~0,-1%"
set "EXE="
for %%f in ("%HERE%\\*.exe") do set "EXE=%%~ff"
if not defined EXE (
  echo [ERROR] no .exe found next to this script
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE=1"
"%EXE%" "%HERE%\\resources\\app\\src\\cli.js" %*
exit /b %ERRORLEVEL%
`;

const toCrlf = (s) => s.replace(/\r?\n/g, '\r\n');
fs.writeFileSync(path.join(STAGE, '使用说明.txt'), toCrlf(readme), 'utf8');
fs.writeFileSync(path.join(STAGE, `${APP_SLUG}.cmd`), toCrlf(cmdShim), 'ascii');
// 老名字的入口也留一个（老习惯/老文档里都写的是 vgrab.cmd）
fs.writeFileSync(path.join(STAGE, 'vgrab.cmd'), toCrlf(cmdShim), 'ascii');
console.log(`  ✓ 使用说明.txt / ${APP_SLUG}.cmd / vgrab.cmd`);

// ── 6) 校验：关键文件都在 ────────────────────────────────────────────────
const must = [
  `${APP_SLUG}.exe`,
  `${APP_SLUG}.ico`,
  'resources/app/package.json',
  'resources/app/src/gui/main.js',
  'resources/app/src/cli.js',
  'resources/app/icon.png',
  '使用说明.txt',
  `${APP_SLUG}.cmd`,
  'vgrab.cmd',
];
let missing = must.filter((f) => !stat(path.join(STAGE, f)));
if (missing.length) {
  console.error(`✗ 缺文件：${missing.join('、')}`);
  process.exit(1);
}
console.log('  ✓ 关键文件齐全');

// 安装目录里绝不能出现用户数据
const leaks = ['resources/app/tools/history.json', 'resources/app/tools/login-cookies.txt', 'resources/app/node_modules'];
const foundLeaks = leaks.filter((f) => stat(path.join(STAGE, f)));
if (foundLeaks.length) {
  console.error(`✗ 包里混进了不该分发的东西：${foundLeaks.join('、')}`);
  process.exit(1);
}
console.log('  ✓ 没有混进 node_modules / 本机用户数据');

// ── 7) 打 zip（Windows 自带 tar 支持 -a 按扩展名选压缩格式）────────────────
const totalBytes = dirSize(STAGE);
let zipPath = '';
if (makeZip) {
  zipPath = path.join(OUT_DIR, `${FOLDER}.zip`);
  fs.rmSync(zipPath, { force: true });
  const r = spawnSync('tar.exe', ['-a', '-c', '-f', zipPath, '-C', OUT_DIR, FOLDER], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !stat(zipPath)) {
    console.error(`✗ 压缩失败：${String(r.stderr || r.stdout || '').slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`  ✓ 压缩包：${path.relative(ROOT, zipPath)}（${mb(stat(zipPath).size)}）`);
}

console.log('');
console.log(`完成：${path.relative(ROOT, STAGE)}（${mb(totalBytes)}）`);
console.log(`双击启动：${path.join(STAGE, `${APP_SLUG}.exe`)}`);
if (zipPath) console.log(`分发用：${path.relative(ROOT, zipPath)}`);

// ── 8) 可选：桌面快捷方式（--shortcut）────────────────────────────────────
if (has('--shortcut')) {
  const lnk = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      [
        '$ws = New-Object -ComObject WScript.Shell;',
        `$sc = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\\${DISPLAY_NAME}.lnk');`,
        `$sc.TargetPath = '${path.join(STAGE, `${APP_SLUG}.exe`).replace(/'/g, "''")}';`,
        `$sc.WorkingDirectory = '${STAGE.replace(/'/g, "''")}';`,
        `$sc.IconLocation = '${path.join(STAGE, `${APP_SLUG}.ico`).replace(/'/g, "''")}';`,
        `$sc.Description = '${DISPLAY_NAME} v${version}';`,
        '$sc.Save();',
      ].join(' '),
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (lnk.status === 0) console.log(`✓ 桌面快捷方式已创建：${DISPLAY_NAME}.lnk`);
  else console.log(`· 快捷方式创建失败（可手动拖一个）：${String(lnk.stderr || '').slice(0, 160)}`);
} else {
  console.log(`· 想放个桌面快捷方式：node build/build-package.mjs --shortcut`);
}
