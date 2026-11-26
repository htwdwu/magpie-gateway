#!/usr/bin/env node
/**
 * 生命周期测试：用假的 magpie 可执行文件跑一遍 安装检测 → 启动 → 重复启动 → 改端口自动重启 → 停止。
 * 不联网、不装东西，只验证 core.cjs 的状态机与 dist/main.js 的接线。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import net from 'node:net';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PKG = path.join(ROOT, 'nox', 'magpie-gateway');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-life-'));
const DATA = path.join(TMP, 'data');
const STATE = path.join(TMP, 'state');
const BIN = path.join(TMP, 'bin');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(BIN, { recursive: true });
// 端口一律现找空闲的：本机可能已经有 magpie 或别的服务占着默认端口，那会被判成「别处启动」。
function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
const P = [await freePort(), await freePort(), await freePort(), await freePort()];

fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({
  startMode: 'serve', proxyMode: 'off', proxy: '', autoStart: false,
  gatewayPort: P[0], webPort: P[1], webKey: '',
}, null, 2));

const fake = path.join(BIN, 'magpie');
fs.writeFileSync(fake, [
  '#!/usr/bin/env sh',
  'case "$1" in',
  '  --version) echo "magpie 0.1.4841-fake"; exit 0 ;;',
  '  healthcheck) echo "ok"; exit 0 ;;',
  '  serve|web) echo "listening ${MAGPIE_ADDR}"; exec sleep 60 ;;',
  '  *) echo "unknown command"; exit 2 ;;',
  'esac',
].join('\n') + '\n');
fs.chmodSync(fake, 0o755);

const child = spawn(process.execPath, [path.join(PKG, 'dist', 'main.js')], {
  cwd: PKG,
  env: { ...process.env, NOX_PLUGIN_DATA: DATA, MAGPIE_STATE_DIR: STATE, MAGPIE_BIN_DIR: BIN, MAGPIE_HOME: TMP },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const pending = new Map();
let seq = 0;
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const waiter = pending.get(message.id);
  if (waiter) { pending.delete(message.id); waiter(message); }
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });

function call(method, handler, args) {
  seq += 1;
  const id = 's' + seq;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { handler, args: args || {} } }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + handler)); } }, 15000);
  });
}
const ui = (h, a) => call('ui.invoke', h, a);
const tool = (h, a) => call('tool.invoke', h, a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });

try {
  const first = await ui('ui.state');
  check('装了 magpie 时状态为已安装', first.result.installed === true, '');
  check('refresh 读出 --version', /magpie 0\.1\.4841-fake/.test(first.result.version), first.result.version);
  check('没在跑时状态是已安装未运行', first.result.running === false && first.result.canStart === true, JSON.stringify({ running: first.result.running, canStart: first.result.canStart }));

  const started = await ui('ui.start');
  check('ui.start 起得来', started.result.ok === true && started.result.state.owned === true, started.result.message);
  check('起来后 canStop 为真', started.result.state.canStop === true, '');
  check('启动方式跟随设置（serve）', started.result.state.mode === 'serve', started.result.state.mode);

  const again = await ui('ui.start');
  check('重复启动不重复起进程', /已经在跑/.test(again.result.message) || again.result.state.owned === true, again.result.message);

  const checked = await tool('tools.check');
  const checkText = JSON.parse(checked.result.text);
  check('检查日志里有 --version', /magpie --version: magpie 0\.1\.4841-fake/.test(checkText.logTail), '');
  check('检查日志里有 healthcheck ok', /healthcheck: ok/.test(checkText.logTail), '');
  check('检查日志里进程归属是本插件', /本插件启动，pid \d+/.test(checkText.logTail), '');

  const switched = await ui('ui.saveSettings', { settings: { startMode: 'web', webPort: P[1] } });
  check('运行中改启动方式会重启', switched.result.ok === true && switched.result.restarted === true, JSON.stringify(switched.result));
  await wait(1400);
  const afterRestart = await ui('ui.state');
  check('重启后仍由本插件持有进程', afterRestart.result.owned === true, '');
  check('重启后进入 web 模式', afterRestart.result.mode === 'web', afterRestart.result.mode);

  const moved = await ui('ui.saveSettings', { settings: { gatewayPort: P[2], webPort: P[3] } });
  await wait(1400);
  const afterMove = await ui('ui.state');
  check('改端口后网关地址跟着变', moved.result.ok === true && afterMove.result.gatewayUrl === `http://127.0.0.1:${P[2]}`, afterMove.result.gatewayUrl);
  check('改端口后网页版地址跟着变', String(afterMove.result.webUrl).includes(`:${P[3]}`), afterMove.result.webUrl);
  check('不需要重启标记已清掉', afterMove.result.needsRestart === false, String(afterMove.result.needsRestart));

  const stopped = await ui('ui.stop');
  await wait(600);
  const afterStop = await ui('ui.state');
  check('ui.stop 停得掉', stopped.result.ok === true && afterStop.result.owned === false, stopped.result.message);
  check('停止后可再次启动', afterStop.result.canStart === true, JSON.stringify({ running: afterStop.result.running, canStart: afterStop.result.canStart }));

  const plan = await ui('ui.plan', { name: 'stop' });
  check('停止计划用 pkill 且不误伤别的进程名', plan.result.plan.commands.every((c) => c.includes('pkill -f "magpie')), plan.result.plan.commands.join(' | '));

  check('没有未捕获异常', !/uncaught|unhandled rejection/.test(stderr), stderr.slice(0, 200));
} catch (error) {
  check('测试执行未抛错', false, error && error.message);
}

child.kill('SIGTERM');
await wait(400);

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '×'} ${r.name}${r.ok || r.detail === '' ? '' : '  — ' + r.detail}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
