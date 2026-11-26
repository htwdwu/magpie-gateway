#!/usr/bin/env node
/**
 * 打包：先跑静态校验，再生成商店能直接吃的 zip（plugin.json 在根目录，不带外层文件夹）。
 * 输出 out/<id>_<version>.zip、out/index-entry.json、out/package-files.txt。
 * 不依赖系统 zip 命令，自己拼 zip（scripts/lib/zip.mjs）。
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildZip, walkFiles } from './lib/zip.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PKG = path.join(ROOT, 'nox', 'magpie-gateway');
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(OUT, { recursive: true });

execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'validate.mjs')], { stdio: 'inherit' });

const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'plugin.json'), 'utf8'));
const zipName = `${manifest.id}_${manifest.version}.zip`;
const zipPath = path.join(OUT, zipName);

const SKIP = [/^data\//, /^node_modules\//, /(^|\/)\.DS_Store$/, /(^|\/)\.git/];
const names = walkFiles(PKG).filter((name) => !SKIP.some((re) => re.test(name)));
const files = names.map((name) => ({ name, data: fs.readFileSync(path.join(PKG, name)) }));
const buffer = buildZip(files);
fs.writeFileSync(zipPath, buffer);
fs.writeFileSync(path.join(OUT, 'package-files.txt'), names.join('\n') + '\n');

const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
const hasRootManifest = names.includes('plugin.json');

// index.json 的 plugins[] 条目（字段见 Nox-Plugins-Store/README.md）
const entry = {
  id: manifest.id,
  name: manifest.name,
  description: manifest.description,
  author: manifest.publisher,
  repository: manifest.repository,
  homepage: manifest.repository,
  license: manifest.license,
  tags: ['tool', 'ui', 'provider'],
  version: manifest.version,
};
fs.writeFileSync(path.join(OUT, 'index-entry.json'), JSON.stringify(entry, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'package-meta.json'), JSON.stringify({
  id: manifest.id,
  version: manifest.version,
  file: zipName,
  bytes: buffer.length,
  sha256,
  entries: names.length,
  rootManifest: hasRootManifest,
}, null, 2) + '\n');

console.log(`\n包：out/${zipName}`);
console.log(`根目录有 plugin.json：${hasRootManifest ? '是' : '否'}`);
console.log(`条目数：${names.length}`);
console.log(`体积：${(buffer.length / 1024).toFixed(1)} KiB`);
console.log(`sha256：${sha256}`);
if (!hasRootManifest) {
  console.log('× plugin.json 不在包根目录');
  process.exit(1);
}
