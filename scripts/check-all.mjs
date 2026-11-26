#!/usr/bin/env node
/**
 * 一次跑完全部检查：清单 / 协议 / 生命周期 / 页面逻辑 / 打包。
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const steps = [
  ['清单与文件校验', 'validate.mjs'],
  ['JSON-RPC 协议', 'protocol-test.mjs'],
  ['启动 / 停止生命周期', 'startstop-test.mjs'],
  ['页面逻辑', 'page-test.mjs'],
  ['下载器（重定向 / 证书降级 / 代理）', 'net-test.mjs'],
  ['纯 Node 安装路径（真实下载默认跳过）', 'install-test.mjs'],
  ['真实 magpie 端到端（没有二进制自动跳过）', 'e2e-test.mjs'],
  ['打包', 'pack.mjs'],
];

let bad = 0;
for (const [label, file] of steps) {
  console.log(`\n===== ${label} (${file}) =====`);
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', file)], { stdio: 'inherit' });
  } catch (error) {
    bad += 1;
    console.log(`× ${label} 未通过`);
  }
}
console.log(`\n${steps.length - bad}/${steps.length} 步通过`);
process.exit(bad === 0 ? 0 : 1);
