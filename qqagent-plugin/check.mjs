// 部署前自检：清单 JSON 必须能解析、list 里的字段必须齐全，模块必须是合法 ESM。
// 用法：node qqagent-plugin/check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, 'video-downloader');
const manifestPath = path.join(srcDir, 'plugin.json');
const indexPath = path.join(srcDir, 'index.js');

let bad = 0;
const fail = (msg) => {
  console.log(`  ✗ ${msg}`);
  bad += 1;
};
const ok = (msg) => console.log(`  ✓ ${msg}`);

// 1) 清单 JSON（用 JSON.parse，严格；PowerShell 的 ConvertFrom-Json 会漏掉一些错）
let manifest = null;
try {
  const text = fs.readFileSync(manifestPath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) fail('plugin.json 带 BOM（加载器会剥掉，但最好别带）');
  manifest = JSON.parse(text);
  ok(`plugin.json 解析通过（${Object.keys(manifest.configSchema).length} 个设置项）`);
} catch (error) {
  fail(`plugin.json 解析失败：${error.message}`);
}

// 2) 清单必备字段 + settings/configSchema 对齐
if (manifest) {
  for (const key of ['id', 'name', 'version', 'apiVersion', 'category', 'description', 'capabilities', 'settings', 'configSchema']) {
    if (manifest[key] === undefined) fail(`清单缺少字段 ${key}`);
  }
  if (!/^[a-z0-9-]+$/.test(String(manifest.id))) fail(`id 必须是短横线小写英文：${manifest.id}`);
  if (!Array.isArray(manifest.capabilities) || !manifest.capabilities.includes('media.download')) {
    fail('capabilities 必须包含 media.download（插件靠它被核心调用）');
  }
  const schemaKeys = new Set(Object.keys(manifest.configSchema));
  for (const key of Object.keys(manifest.settings)) {
    if (!schemaKeys.has(key)) fail(`settings.${key} 在 configSchema 里没有对应项（界面上改不了，用户会以为设置没生效）`);
  }
  for (const key of schemaKeys) {
    if (!(key in manifest.settings)) fail(`configSchema.${key} 在 settings 里没有默认值`);
    const item = manifest.configSchema[key];
    if (item.type === 'enum' && !Array.isArray(item.values)) fail(`configSchema.${key} 是 enum 但没有 values`);
    if (!item.label) fail(`configSchema.${key} 缺 label`);
  }
  if (!manifest.prompt?.sections?.length) console.log('  · 没有 prompt.sections（可选）');
  else ok(`prompt.sections：${manifest.prompt.sections.length} 段`);
}

// 3) 入口模块
const res = spawnSync(process.execPath, ['--check', indexPath], { encoding: 'utf8' });
// .js 在这里是 ESM（宿主 package.json type=module），node --check 会按 CJS 报错，所以拷贝成 .mjs 再查
const tmp = path.join(here, '.check-tmp.mjs');
fs.copyFileSync(indexPath, tmp);
const res2 = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
fs.rmSync(tmp, { force: true });
if (res2.status === 0) ok('index.js ESM 语法通过');
else fail(`index.js 语法错误：${(res2.stderr || '').split('\n').slice(0, 3).join(' ')}`);

// 4) 入口必须导出 providers['media.download'] 或 setup
const text = fs.readFileSync(indexPath, 'utf8');
if (!/export\s+const\s+providers/.test(text) && !/export\s+function\s+(setup|register)/.test(text)) {
  fail('index.js 既没有导出 providers，也没有 setup/register —— 加载器会判定入口无效');
} else {
  ok('index.js 导出了 providers / setup');
}
if (/^\s*import\s+.*from\s+['"]\.\.\/\.\.\/src\/(util|sender)\.js['"]/.test(text)) {
  console.log('  · 提示：从核心 src 里 import 内部工具（util/sender）有风险，核心改版会连累本插件');
}

console.log(bad === 0 ? '\n清单与入口检查通过，可以部署' : `\nFAIL ${bad} 项，先修再部署`);
process.exitCode = bad === 0 ? 0 : 1;
