#!/usr/bin/env node
/**
 * 插件包静态校验（以 Nox App 的真实解析器为准）：
 *   1) 清单：走 scripts/manifest-check.mjs（对标 PluginManifestParser.kt + 内置技能 nox-plugin-dev）
 *   2) 文件：清单引用到的页面 / schema / 入口真的在包内
 *   3) 页面桥：HTML 用绝对路径 /__<桥>/<桥>.js 引入，且用到的元素 id / data-act 在 ui.js 里对得上
 *   4) runtime：handler 都在 main.js 注册、method 只认三类、挂了未捕获异常兜底
 *   5) 审计：商店会拦的关键字（eval / new Function / /bin/sh / sh -c / pm install …）
 * 只读，不改文件；有「错误」退出码 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkManifest } from './manifest-check.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PKG = path.join(ROOT, 'nox', 'magpie-gateway');

const errors = [];
const warns = [];
const notes = [];
const err = (msg) => errors.push(msg);
const warn = (msg) => warns.push(msg);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

// ---------- 1. 清单 ----------
const manifestPath = path.join(PKG, 'plugin.json');
if (!fs.existsSync(manifestPath)) {
  console.log('× plugin.json 不存在');
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
for (const item of checkManifest(manifest, PKG)) err(`清单 ${item.code} ${item.detail}`);

notes.push(`清单：manifestVersion ${manifest.manifestVersion} · id ${manifest.id} · version ${manifest.version} · pluginApi ${manifest.engines?.pluginApi} · resident ${manifest.runtime?.resident === true}`);

const contrib = manifest.contributes || {};
const count = (key) => (Array.isArray(contrib[key]) ? contrib[key].length : 0);
notes.push(`贡献：tools ${count('tools')} · hooks ${count('hooks')} · providers ${count('providers')} · uiEntries ${count('uiEntries')} · workspaceTools ${count('workspaceTools')} · configPage ${contrib.configPage || '（无）'}`);

if (contrib.providers && contrib.providers.length > 0 && manifest.runtime?.resident !== true) {
  err('声明了 providers 必须 runtime.resident: true，否则空闲回收后本地服务就没了');
}

// ---------- 2. 文件引用 ----------
const referenced = new Set();
for (const tool of contrib.tools || []) {
  if (tool.inputSchema) referenced.add(tool.inputSchema);
  if (tool.inputSchema && !/^schemas\//.test(tool.inputSchema)) warn(`tools.${tool.id} 的 inputSchema 不在 schemas/ 下：${tool.inputSchema}`);
}
for (const entry of contrib.uiEntries || []) if (entry.page) referenced.add(entry.page);
for (const tool of contrib.workspaceTools || []) if (tool.pageFile) referenced.add(tool.pageFile);
if (contrib.configPage) referenced.add(contrib.configPage);
if (manifest.runtime?.entry) referenced.add(manifest.runtime.entry);
if (manifest.icon && /\.(png|webp)$/i.test(manifest.icon)) referenced.add(manifest.icon);
for (const file of referenced) {
  if (!fs.existsSync(path.join(PKG, file))) err(`清单引用的文件不在包里：${file}`);
}

// ---------- 3. 页面桥 ----------
for (const page of [...new Set([...referenced].filter((f) => /\.html?$/i.test(f)))]) {
  const abs = path.join(PKG, page);
  if (!fs.existsSync(abs)) continue;
  const html = fs.readFileSync(abs, 'utf8');
  const bridge = html.match(/src="\/__([A-Za-z]+)\/([A-Za-z]+)\.js"/);
  if (!bridge) err(`${page} 没有用绝对路径引入页面桥 /__<桥>/<桥>.js`);
  else if (bridge[1] !== bridge[2]) err(`${page} 的桥路径两段不一致：/__${bridge[1]}/${bridge[2]}.js`);
  const scripts = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
  for (const src of scripts) {
    if (src.startsWith('/__')) continue;
    if (!fs.existsSync(path.join(PKG, path.dirname(page), src))) err(`${page} 引用了包内不存在的脚本：${src}`);
  }
}

// ---------- 4. 页面契约 ----------
const uiJs = path.join(PKG, 'pages', 'ui.js');
if (fs.existsSync(uiJs)) {
  const ui = fs.readFileSync(uiJs, 'utf8');
  const usedIds = new Set([
    ...[...ui.matchAll(/el\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]),
    ...[...ui.matchAll(/setText\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]),
  ]);
  const usedActs = new Set([...ui.matchAll(/'(act-[a-z-]+)':/g)].map((m) => m[1]));
  const shared = new Set(['status', 'gatewayUrl', 'webUrl', 'webRow', 'notice', 'bridgeWarn', 'log', 'startMode', 'proxyMode',
    'proxy', 'autoStart', 'gatewayPort', 'webPort', 'webKey']);
  const pages = [
    ['pages/panel.html', usedIds],
    ['pages/config.html', shared],
  ];
  for (const [page, required] of pages) {
    const abs = path.join(PKG, page);
    if (!fs.existsSync(abs)) continue;
    const html = fs.readFileSync(abs, 'utf8');
    const ids = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
    const acts = new Set([...html.matchAll(/data-act="([a-z-]+)"/g)].map((m) => m[1]));
    for (const id of required) if (!ids.has(id)) err(`${page} 缺少 ui.js 要用的元素 id=${id}`);
    for (const act of acts) if (!usedActs.has(act)) err(`${page} 的 data-act="${act}" 在 ui.js 里没有处理函数`);
  }
}

// ---------- 5. runtime ----------
const entry = manifest.runtime?.entry;
if (entry) {
  const main = fs.readFileSync(path.join(PKG, entry), 'utf8');
  const handlers = new Set([...main.matchAll(/^\s*'([a-zA-Z]+\.[a-zA-Z0-9_]+)'\s*:/gm)].map((m) => m[1]));
  for (const tool of contrib.tools || []) {
    if (tool.handler && !handlers.has(tool.handler)) err(`tools.${tool.id} 的 handler 没在 runtime 注册：${tool.handler}`);
  }
  for (const hook of contrib.hooks || []) {
    if (hook.handler && !handlers.has(hook.handler)) err(`hooks.${hook.id} 的 handler 没在 runtime 注册：${hook.handler}`);
  }
  for (const item of contrib.uiEntries || []) {
    if (item.handler && !handlers.has(item.handler)) err(`uiEntries.${item.id} 的 handler 没在 runtime 注册：${item.handler}`);
  }
  if (!/uncaughtException/.test(main)) err('runtime 没挂 uncaughtException（宿主把 stdout 关闭当作插件死亡）');
  if (!/unhandledRejection/.test(main)) err('runtime 没挂 unhandledRejection');
  if (!/params\.handler/.test(main)) err('runtime 没按 params.handler 取 handler 名');
  if (!/tool\.invoke/.test(main)) err('runtime 没处理 tool.invoke');
  if (!/ui\.invoke/.test(main)) err('runtime 没处理 ui.invoke');
  notes.push(`runtime 注册的 handler：${[...handlers].sort().join(', ')}`);
}

// ---------- 6. 审计关键字 ----------
const BANNED = [
  [/\beval\s*\(/, 'eval('],
  [/new\s+Function\s*\(/, 'new Function('],
  [/Runtime\.getRuntime/, 'Runtime.getRuntime'],
  [/\bpm\s+(install|grant)\b/, 'pm install/grant'],
  [/\/bin\/sh/, '/bin/sh'],
  [/\bsh\s+-c\b/, 'sh -c'],
  [/(^|[^a-zA-Z._-])su\s+-?[a-z]/, 'su 提权'],
  [/\.\.\//, '路径越界 ../'],
];
const BINARY = /\.(so|dex|apk|jar|wasm|class|png|webp|jpg|jpeg|gif|zip|woff2?|ttf)$/i;
const textFiles = walk(PKG).filter((f) => !BINARY.test(f));
let totalBytes = 0;
for (const file of textFiles) {
  const rel = path.relative(PKG, file);
  const text = fs.readFileSync(file, 'utf8');
  totalBytes += Buffer.byteLength(text);
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) err(`${rel} 超过 2MB`);
  for (const [re, label] of BANNED) {
    if (re.test(text)) {
      if (rel === 'adapter.json' || rel === 'README.md') warn(`${rel} 提到「${label}」，商店审计时可能被误判`);
      else err(`${rel} 命中审计关键字：${label}`);
    }
  }
}
notes.push(`包内文本 ${textFiles.length} 个文件，约 ${(totalBytes / 1024).toFixed(1)} KiB`);

// ---------- 结果 ----------
for (const line of notes) console.log('· ' + line);
for (const line of warns) console.log('! ' + line);
if (errors.length === 0) {
  console.log(`\n通过：${path.basename(PKG)} 符合 Nox App 的清单解析器（0 错误，${warns.length} 提示）`);
  process.exit(0);
}
for (const line of errors) console.log('× ' + line);
console.log(`\n失败：${errors.length} 个错误，${warns.length} 个提示`);
process.exit(1);
