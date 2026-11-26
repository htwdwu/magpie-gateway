#!/usr/bin/env node
/**
 * 用一段脚本把插件提 PR 到 Nox 插件商店：
 *   1. fork xzyy03/Nox-Plugins-Store（已有就复用）
 *   2. 在 fork 的 main 上加 packages/<id>_<version>.zip
 *   3. 往 index.json 的 plugins 里补一条（已存在同 id 就跳过）
 *   4. 开 PR
 *
 * 用法：GITHUB_TOKEN=... node scripts/pr-store.mjs [--repo https://github.com/<你>/magpie-gateway]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const UPSTREAM = 'xzyy03/Nox-Plugins-Store';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const API = 'https://api.github.com';

if (!TOKEN) {
  console.error('缺 GITHUB_TOKEN');
  process.exit(2);
}

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? fallback : process.argv[i + 1];
}

async function api(method, url, body, accept) {
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: accept || 'application/vnd.github+json',
      'User-Agent': 'magpie-publish',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const detail = json && json.message ? json.message : text.slice(0, 200);
    const error = new Error(`${method} ${url} → ${res.status} ${detail}`);
    error.status = res.status;
    error.body = json;
    throw error;
  }
  return json;
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'nox/magpie-gateway/plugin.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/package-meta.json'), 'utf8'));
const zipPath = path.join(ROOT, 'out', meta.file);
const repoUrl = String(arg('repo', manifest.repository)).replace(/\/$/, '');

if (!fs.existsSync(zipPath)) {
  console.error('没有 ' + meta.file + '，先跑 node scripts/pack.mjs');
  process.exit(2);
}

const me = (await api('GET', '/user')).login;
console.log('· 账号：' + me);

// 1) fork
let fork = null;
try {
  fork = await api('POST', `/repos/${UPSTREAM}/forks`, {});
  console.log('· 已 fork（' + (fork.full_name || '') + '）');
} catch (error) {
  console.log('· fork 返回：' + error.message);
}
const forkName = `${me}/Nox-Plugins-Store`;
for (let i = 0; i < 20; i += 1) {
  try {
    const info = await api('GET', `/repos/${forkName}`);
    if (info && info.full_name) break;
  } catch (error) {
    // 还没准备好
  }
  await new Promise((r) => setTimeout(r, 3000));
}
console.log('· fork 仓库：https://github.com/' + forkName);

// 2) 读上游 index.json（用 fork 的，保证 sha 一致）
const indexFile = await api('GET', `/repos/${forkName}/contents/index.json`);
const indexText = Buffer.from(indexFile.content, 'base64').toString('utf8');
const index = JSON.parse(indexText);
const plugins = Array.isArray(index.plugins) ? index.plugins : [];

const entry = {
  id: manifest.id,
  name: manifest.name,
  description: manifest.description,
  author: manifest.publisher,
  repository: repoUrl,
  license: manifest.license || 'MIT',
  tags: ['tool', 'ui', 'provider'],
  version: manifest.version,
};
if (/^[a-z][a-z0-9-]{0,31}$/.test(String(manifest.icon || ''))) entry.icon = manifest.icon;

const existing = plugins.findIndex((p) => p && p.id === manifest.id);
if (existing >= 0) {
  plugins[existing] = entry;
  console.log('· 索引里已有 ' + manifest.id + '，按新版本覆盖');
} else {
  plugins.push(entry);
  console.log('· 索引新增 ' + manifest.id);
}
index.plugins = plugins;
const nextIndex = JSON.stringify(index, null, 2) + '\n';

await api('PUT', `/repos/${forkName}/contents/index.json`, {
  message: `${existing >= 0 ? 'update' : 'add'} ${manifest.id} ${manifest.version}`,
  content: Buffer.from(nextIndex, 'utf8').toString('base64'),
  sha: indexFile.sha,
  branch: 'main',
});
console.log('· index.json 已提交');

// 3) 清掉同 id 的旧版本包（商店同 id 只保留一个版本）
try {
  const listing = await api('GET', `/repos/${forkName}/contents/packages?ref=main`);
  const stale = (Array.isArray(listing) ? listing : []).filter(
    (item) => item && item.name && item.name.startsWith(manifest.id + '_') && item.name !== meta.file,
  );
  for (const item of stale) {
    await api('DELETE', `/repos/${forkName}/contents/packages/${item.name}`, {
      message: `remove old ${item.name}`,
      sha: item.sha,
      branch: 'main',
    });
    console.log('· 删掉旧包 ' + item.name);
  }
} catch (error) {
  console.log('· 旧包清理跳过：' + error.message);
}

// 4) 包放进 packages/
const pkgPath = `packages/${meta.file}`;
let shaExist = null;
try {
  const found = await api('GET', `/repos/${forkName}/contents/${pkgPath}`);
  shaExist = found.sha;
} catch (error) {
  // 不存在
}
await api('PUT', `/repos/${forkName}/contents/${pkgPath}`, {
  message: `add ${meta.file}`,
  content: fs.readFileSync(zipPath).toString('base64'),
  ...(shaExist ? { sha: shaExist } : {}),
  branch: 'main',
});
console.log('· 包已提交：' + pkgPath);

// 5) PR
let pr = null;
try {
  pr = await api('POST', `/repos/${UPSTREAM}/pulls`, {
    title: `add ${manifest.id} ${manifest.version}`,
    head: `${me}:main`,
    base: 'main',
    body: [
      `新增插件 **${manifest.id}**（${manifest.version}）：${manifest.name['zh-CN'] || manifest.name.default}`,
      '',
      '- 仓库：' + repoUrl,
      '- 包：`' + pkgPath + '`（' + (meta.bytes / 1024).toFixed(1) + ' KiB，sha256 `' + meta.sha256 + '`）',
      '- 清单：`manifestVersion: 1` + `engines.pluginApi: ^1.0.0`，8 个工具 / 1 个 hook / 1 个 provider / 2 个 uiEntries / 1 个工作区工具 / 配置页',
      '- 本地已过：App 解析器规则、商店 `audit_plugin.py`、`schema/index.schema.json`',
      '',
      '包只做一件事：在本机 Linux 环境装 magpie（直连下载 + sha256 校验，缺 CA 时降级），托管它的本地网关，并给 App 一个状态/启停/设置面板。',
    ].join('\n'),
  });
  console.log('· PR：' + pr.html_url);
} catch (error) {
  if (error.status === 422) {
    console.log('· PR 已存在（422）：https://github.com/' + UPSTREAM + '/pulls');
  } else {
    console.log('× 开 PR 失败：' + error.message);
  }
}

console.log('\n完成。仓库：' + repoUrl);
