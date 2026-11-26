#!/usr/bin/env node
/**
 * 协议测试：真的把 dist/main.js 起起来，按 docs/plugin-dev.md 3.2 的方式发 JSON-RPC，
 * 检查 tool.invoke / ui.invoke / hook.invoke 三条通道、错误码、settings 落盘与状态机。
 * 不会真的装 magpie：bin 目录指到临时目录，autoStart 关掉。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PKG = path.join(ROOT, 'nox', 'magpie-gateway');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-proto-'));
const DATA = path.join(TMP, 'data');
const STATE = path.join(TMP, 'state');
const BIN = path.join(TMP, 'bin');
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({
  startMode: 'serve', proxyMode: 'off', proxy: '', autoStart: false,
  gatewayPort: 3425, webPort: 3430, webKey: '',
}, null, 2));

const child = spawn(process.execPath, [path.join(PKG, 'dist', 'main.js')], {
  cwd: PKG,
  env: { ...process.env, NOX_PLUGIN_DATA: DATA, MAGPIE_STATE_DIR: STATE, MAGPIE_BIN_DIR: BIN, MAGPIE_HOME: TMP },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const pending = new Map();
let seq = 0;
const events = [];

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  events.push(message);
  const waiter = pending.get(message.id);
  if (waiter) {
    pending.delete(message.id);
    waiter(message);
  }
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });

function call(method, params) {
  seq += 1;
  const id = 't' + seq;
  const payload = { jsonrpc: '2.0', id, method, params };
  child.stdin.write(JSON.stringify(payload) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout: ' + method + ' ' + JSON.stringify(params))); } }, 15000);
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
}

function parseText(reply) {
  if (!reply.result || typeof reply.result.text !== 'string') return null;
  try { return JSON.parse(reply.result.text); } catch { return null; }
}

try {
  const status = await call('tool.invoke', { handler: 'tools.status', args: {} });
  const state = parseText(status);
  check('tool.invoke → tools.status 返回状态', state && state.installed === false, JSON.stringify({ installed: state && state.installed, shellOk: state && state.shellOk }));
  check('状态里有网关地址与供应商入口', state && state.gatewayUrl === 'http://127.0.0.1:3425' && state.providerBaseUrl === 'http://127.0.0.1:3425/v1', state && state.gatewayUrl);

  const wrongStyle = await call('tools.status', {});
  check('把 handler 名当 method → METHOD_UNKNOWN', wrongStyle.error && wrongStyle.error.code === 'METHOD_UNKNOWN', JSON.stringify(wrongStyle.error));

  const unknown = await call('tool.invoke', { handler: 'tools.nope', args: {} });
  check('未知 handler → HANDLER_NOT_FOUND', unknown.error && unknown.error.code === 'HANDLER_NOT_FOUND', JSON.stringify(unknown.error));

  const uiState = await call('ui.invoke', { handler: 'ui.state', args: {} });
  check('ui.invoke → ui.state 返回快照', uiState.result && uiState.result.settings && uiState.result.settings.gatewayPort === 3425, JSON.stringify(uiState.result && uiState.result.settings));

  const plan = await call('ui.invoke', { handler: 'ui.plan', args: { name: 'install' } });
  const installCmds = plan.result && plan.result.plan ? plan.result.plan.commands : [];
  check('ui.plan(install) 给出 4 条终端命令', installCmds.length === 4, installCmds.join(' | '));
  check('安装命令含官方安装脚本', installCmds.some((c) => c.includes('usemagpie.ai/install.sh')), '');

  const startPlan = await call('ui.invoke', { handler: 'ui.plan', args: { name: 'web' } });
  const webCmd = startPlan.result.plan.commands[0] || '';
  check('ui.plan(web) 带上端口与 key 环境变量', webCmd.includes('web --addr 127.0.0.1:3430') && webCmd.includes('MAGPIE_ADDR=127.0.0.1:3425'), webCmd);

  const saved = await call('ui.invoke', {
    handler: 'ui.saveSettings',
    args: { settings: { startMode: 'web', gatewayPort: 3426, webPort: 3431, webKey: 'abcdefghijklmnop1234', autoStart: false, proxyMode: 'off', proxy: '' } },
  });
  check('ui.saveSettings 接受合法设置', saved.result && saved.result.ok === true, JSON.stringify(saved.result && saved.result.message));
  check('保存后端口写进状态', saved.result.state.settings.gatewayPort === 3426 && saved.result.state.settings.webPort === 3431, '');
  check('保存后网页版地址带固定 key', String(saved.result.state.webUrl).includes('?k=abcdefghijklmnop1234'), saved.result.state.webUrl);

  const onDisk = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8'));
  check('设置真的落盘到插件数据目录', onDisk.gatewayPort === 3426 && onDisk.startMode === 'web', JSON.stringify(onDisk));

  const badPort = await call('ui.invoke', { handler: 'ui.saveSettings', args: { settings: { gatewayPort: 70000 } } });
  check('非法端口被拒并给中文原因', badPort.result && badPort.result.ok === false && /端口/.test(badPort.result.message), badPort.result && badPort.result.message);

  const samePort = await call('ui.invoke', { handler: 'ui.saveSettings', args: { settings: { gatewayPort: 3432, webPort: 3432 } } });
  check('两个端口相同被拒', samePort.result && samePort.result.ok === false, samePort.result && samePort.result.message);

  const badKey = await call('ui.invoke', { handler: 'ui.saveSettings', args: { settings: { webKey: 'short' } } });
  check('过短的 web key 被拒', badKey.result && badKey.result.ok === false && /key/.test(badKey.result.message), badKey.result && badKey.result.message);

  const settingsRead = await call('tool.invoke', { handler: 'tools.settings', args: {} });
  const settingsText = parseText(settingsRead);
  check('tools.settings 能读回当前设置', settingsText && settingsText.settings.gatewayPort === 3426, JSON.stringify(settingsText && settingsText.settings));

  const check1 = await call('tool.invoke', { handler: 'tools.check', args: {} });
  const checkState = parseText(check1);
  check('tools.check 把诊断写进日志', checkState && /查看状态/.test(checkState.logTail), '');
  check('未安装时日志说明没装', checkState && /未安装/.test(checkState.logTail), '');

  const logs = await call('tool.invoke', { handler: 'tools.logs', args: { lines: 5 } });
  check('tools.logs 返回日志文本', logs.result && typeof logs.result.text === 'string' && logs.result.text.length > 0, (logs.result && logs.result.text || '').slice(0, 80));

  const diag = await call('ui.invoke', { handler: 'ui.diag', args: {} });
  const diagText = diag.result && diag.result.text ? diag.result.text : '';
  check('ui.diag 给出人可读的自检文本', /平台 linux\//.test(diagText) && /网络 /.test(diagText), diagText.split('\n')[0]);
  check('ui.diag 带结构化 env', diag.result && diag.result.env && diag.result.env.assets && diag.result.env.tools, '');
  const diagTool = await call('tool.invoke', { handler: 'tools.diag', args: {} });
  const diagEnv = parseText(diagTool);
  check('tools.diag 返回结构化环境', diagEnv && diagEnv.platform && diagEnv.tools && diagEnv.net, JSON.stringify(diagEnv && diagEnv.assets));

  const provider = await call('ui.invoke', { handler: 'ui.provider', args: {} });
  check('ui.provider 跟随网关端口', provider.result && provider.result.provider.baseUrl === 'http://127.0.0.1:3426/v1', JSON.stringify(provider.result && provider.result.provider));
  check('端口不是 3425 时标记供应商不匹配', provider.result && provider.result.provider.match === false, '');

  const report = await call('ui.invoke', { handler: 'ui.report', args: { action: 'install', ok: true, detail: 'ok' } });
  check('ui.report 把终端执行结果写进日志', report.result && report.result.ok === true && /\[终端\]/.test(report.result.state.logTail), '');

  const started = await call('hook.invoke', { handler: 'hooks.appStarted', args: {} });
  check('hook.app.started 在 autoStart 关时什么都不做', started.result && typeof started.result === 'object' && Object.keys(started.result).length === 0, JSON.stringify(started.result));

  const stop = await call('ui.invoke', { handler: 'ui.stop', args: {} });
  check('没在运行时停止给出人话提示', stop.result && /没有由本插件启动/.test(stop.result.message), stop.result && stop.result.message);

  const startNoBin = await call('ui.invoke', { handler: 'ui.start', args: {} });
  check('没装时启动被挡下', startNoBin.result && startNoBin.result.ok === false && /先安装/.test(startNoBin.result.message), startNoBin.result && startNoBin.result.message);

  check('进程仍然活着（resident）', child.exitCode === null, String(child.exitCode));
  check('没有未捕获异常', !/uncaught|unhandled rejection/.test(stderr), stderr.slice(0, 200));
} catch (error) {
  check('测试执行未抛错', false, error && error.message);
}

child.kill('SIGTERM');
await new Promise((resolve) => setTimeout(resolve, 300));

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '×'} ${r.name}${r.ok || r.detail === '' ? '' : '  — ' + r.detail}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
