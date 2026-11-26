#!/usr/bin/env node
/**
 * 发布准备：
 *   node scripts/publish.mjs --repo https://github.com/<你>/magpie-gateway [--tags tool,ui,provider]
 *
 * 做的事：
 *   1. 把清单里的 repository 改成你的仓库（商店索引要求必须指向 GitHub 仓库根）
 *   2. 重新打包
 *   3. 生成 out/publish/：包（按 packages/<id>_<version>.zip 摆好）、index-entry.json、
 *      PR.md（贴进 index.json 的片段 + 提交步骤）、upload-github.sh（推仓库用）、
 *      以及一个可选的 GitHub Actions 工作流（打 tag 自动出包）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PKG = path.join(ROOT, 'nox', 'magpie-gateway');
const OUT = path.join(ROOT, 'out');
const PUB = path.join(OUT, 'publish');

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  if (index < 0) return fallback;
  return process.argv[index + 1] === undefined ? fallback : process.argv[index + 1];
}

const repo = String(arg('repo', '')).trim();
if (!repo) {
  console.error('用法：node scripts/publish.mjs --repo https://github.com/<你>/magpie-gateway');
  console.error('（商店索引要求 repository 指向 GitHub 仓库根，且与包内清单一致）');
  process.exit(2);
}
if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(repo)) {
  console.error('repository 必须是 https://github.com/<owner>/<repo> 形式：' + repo);
  process.exit(2);
}
const cleanRepo = repo.replace(/\/$/, '');
const tags = String(arg('tags', 'tool,ui,provider')).split(',').map((t) => t.trim()).filter(Boolean);
const TAGS = new Set(['provider', 'tool', 'skill', 'agent', 'mcp', 'ui', 'integration', 'other']);
for (const tag of tags) {
  if (!TAGS.has(tag)) {
    console.error('tags 只允许 provider/tool/skill/agent/mcp/ui/integration/other，收到：' + tag);
    process.exit(2);
  }
}

// 1) 清单里的 repository 对齐
const manifestPath = path.join(PKG, 'plugin.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.repository = cleanRepo;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// 2) 重新打包（内部会先跑清单校验）
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'pack.mjs')], { stdio: 'inherit' });
const zipName = `${manifest.id}_${manifest.version}.zip`;
const zipPath = path.join(OUT, zipName);
const meta = JSON.parse(fs.readFileSync(path.join(OUT, 'package-meta.json'), 'utf8'));

// 3) 发布目录
fs.rmSync(PUB, { recursive: true, force: true });
fs.mkdirSync(path.join(PUB, 'packages'), { recursive: true });
fs.copyFileSync(zipPath, path.join(PUB, 'packages', zipName));

const entry = {
  id: manifest.id,
  name: manifest.name,
  description: manifest.description,
  author: manifest.publisher,
  repository: cleanRepo,
  license: manifest.license || 'MIT',
  tags: tags.slice(0, 4),
  version: manifest.version,
  package_url: `https://raw.githubusercontent.com/xzyy03/Nox-Plugins-Store/main/packages/${zipName}`,
  icon: /^[a-z][a-z0-9-]{0,31}$/.test(String(manifest.icon || '')) ? manifest.icon : undefined,
};
if (entry.icon === undefined) delete entry.icon;
fs.writeFileSync(path.join(PUB, 'index-entry.json'), JSON.stringify(entry, null, 2) + '\n');

const owner = cleanRepo.split('/')[3];
const repoName = cleanRepo.split('/')[4];
const workflow = `name: build

on:
  push:
    tags: ['v*']
  workflow_dispatch:

jobs:
  package:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: node scripts/check-all.mjs
      - uses: actions/upload-artifact@v4
        with:
          name: plugin-zip
          path: out/*.zip
`;
fs.writeFileSync(path.join(PUB, 'build-workflow.yml'), workflow);

const pushScript = `#!/bin/sh
# 把工作区内容推到 ${cleanRepo}
set -e
cd "$(dirname "$0")/../.."
if [ ! -d .git ]; then
  git init -b main
fi
cat > .gitignore <<'IGNORE'
out/logs/
out/publish/
node_modules/
*.zip
IGNORE
git add -A
git commit -m "magpie gateway ${manifest.version}" || echo "没有改动可提交"
git remote remove origin 2>/dev/null || true
git remote add origin ${cleanRepo}.git
git push -u origin main
`;
fs.writeFileSync(path.join(PUB, 'upload-github.sh'), pushScript);
fs.chmodSync(path.join(PUB, 'upload-github.sh'), 0o755);

const pr = `# 发布到 Nox 插件商店

## 一、先把源码推到 GitHub

仓库：${cleanRepo}（public）

\`\`\`sh
sh out/publish/upload-github.sh
\`\`\`

等价的手工步骤：

\`\`\`sh
git init -b main
git add -A && git commit -m "magpie gateway ${manifest.version}"
git remote add origin ${cleanRepo}.git
git push -u origin main
\`\`\`

## 二、进商店：两条路，选一条

### A. App 内上传（最省事）

插件页顶栏的上传图标 → 选 \`out/publish/packages/${zipName}\` →
包会写进暂存区 \`yyds0399/Muse-Plugins-Inbox\` 的 \`incoming/\`，商店的 Actions 定时解包、审计、
复制进 \`packages/\` 并更新 \`index.json\`。之后在商店页下拉刷新即可看到。

### B. 自己提 PR 到 xzyy03/Nox-Plugins-Store

1. fork 并 clone \`https://github.com/xzyy03/Nox-Plugins-Store\`
2. 把 \`out/publish/packages/${zipName}\` 复制到仓库的 \`packages/\`
3. 打开 \`index.json\`，在 \`plugins\` 数组里加一条（其他插件不动）：

\`\`\`json
${JSON.stringify(entry, null, 2).split('\n').join('\n')}
\`\`\`

4. 本地校验（需 python3 + jsonschema）：

\`\`\`sh
python3 -m pip install jsonschema
python3 scripts/validate_index.py
\`\`\`

5. 提交 PR。CI 会校验索引格式、仓库可达、\`package_url\` 可下载，以及包内 \`plugin.json\` 的
   \`id\` / \`version\` / \`publisher\` 与索引一致。

> 同一个 \`id\` 商店只保留一个版本：发新版本时换掉 \`packages/\` 里的旧包并改 \`index.json\` 的 \`version\`。

## 三、清单与索引必须对得上

| 索引字段 | 必须等于 |
|---|---|
| \`id\` | 包内 \`plugin.json\` 的 \`id\`（${manifest.id}） |
| \`author\` | 包内 \`publisher\`（${manifest.publisher}） |
| \`version\` | 包内 \`version\`（${manifest.version}） |
| \`name\` / \`description\` | 包内同名字段（每种语言都要一致） |
| \`repository\` | ${cleanRepo} |

## 四、审计会拦什么

路径越界、可执行文件、\`eval\` / \`new Function\`、\`Runtime.getRuntime\`、\`su\` 提权、
\`pm install/grant\`、\`/bin/sh\` 或 \`sh -c\` 拼接。\`child_process\` / \`spawn\` / \`execSync\` 与常见
node 内置模块是放行的（插件本来就是 node 进程）。本地已经用 \`scripts/validate.mjs\` 扫过一遍。

## 五、发新版本

1. 改 \`nox/magpie-gateway/plugin.json\` 的 \`version\`（同版本重装只会被当作替换）
2. \`node scripts/publish.mjs --repo ${cleanRepo}\`
3. 重新上传新 zip，或按 B 覆盖 \`packages/\` 与 \`index.json\`

包信息：${zipName}，${meta.bytes} 字节，sha256 \`${meta.sha256}\`
`;
fs.writeFileSync(path.join(PUB, 'PR.md'), pr);

console.log(`\n发布目录：out/publish/`);
console.log(`  包：packages/${zipName}（${(meta.bytes / 1024).toFixed(1)} KiB，sha256 ${meta.sha256.slice(0, 16)}…）`);
console.log('  索引条目：index-entry.json');
console.log('  提交说明：PR.md');
console.log('  推仓库脚本：upload-github.sh');
console.log('  CI 工作流：build-workflow.yml');
console.log(`\n仓库地址：${cleanRepo}`);
