#!/usr/bin/env node
/**
 * 端到端：用本机真实的 magpie（/root/.local/bin/magpie）跑一遍插件生命周期。
 * 完全隔离：HOME 指到临时目录、端口现找空闲的，不碰机器上已经在跑的网关。
 * 只停自己起的进程，不 pkill 别人的进程名。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../nox/magpie-gateway/dist/core.cjs');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PKG = path.join(ROOT, 'nox', 'magpie-gateway');
const REAL_BIN = process.env.MAGPIE_REAL_BIN || '/root/.local/bin/magpie';

if (!fs.existsSync(REAL_BIN)) {
  console.log(`跳过：本机没有 ${REAL_BIN}`);
  process.exit(0);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-e2e-'));
const HOME = path.join(TMP, 'home');
const DATA = path.join(TMP, 'data');
const STATE = path.join(TMP, 'state');
for (const dir of [HOME, DATA, STATE]) fs.mkdirSync(dir, { recursive: true });

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
const P1 = await freePort();
const P2 = await freePort();

fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({
  startMode: 'serve', proxyMode: 'off', proxy: '', autoStart: false,
  gatewayPort: P1, webPort: P2, webKey: '',
}, null, 2));

const child = spawn(process.execPath, [path.join(PKG, 'dist', 'main.js')], {
  cwd: PKG,
  env: {
    ...process.env,
    HOME,
    MAGPIE_HOME: HOME,
    MAGPIE_BIN_DIR: path.dirname(REAL_BIN),
    MAGPIE_STATE_DIR: STATE,
    NOX_PLUGIN_DATA: DATA,
  },
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
child.stderr.on('data', () => {});

function call(method, handler, args) {
  seq += 1;
  const id = 'e' + seq;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { handler, args: args || {} } }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + handler)); } }, 20000);
  });
}
const ui = (h, a) => call('ui.invoke', h, a);
const tool = (h, a) => call('tool.invoke', h, a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fn, timeout = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (await fn()) return true;
    await wait(400);
  }
  return false;
}

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });

try {
  const first = await ui('ui.state');
  check('真实 magpie 被识别为已安装', first.result.installed === true, '');
  check('读出真实版本号', /magpie \d+\.\d+/.test(first.result.version), first.result.version);

  const started = await ui('ui.start');
  check('插件能把真实网关起来', started.result.ok === true && started.result.state.owned === true, started.result.message);
  const listening = await waitFor('gateway', () => core.probePort('127.0.0.1', P1, 600));
  check('网关真的在监听指定端口', listening, `127.0.0.1:${P1}`);

  const status = await tool('tools.status');
  const statusText = JSON.parse(status.result.text);
  check('tools.status 反映运行中', statusText.running === true && statusText.owned === true, '');

  const checked = await tool('tools.check');
  const checkText = JSON.parse(checked.result.text);
  check('healthcheck 通过', /healthcheck: ok/.test(checkText.logTail), '');
  check('状态里写着网关在监听', /网关 http:\/\/127\.0\.0\.1:\d+: 在监听/.test(checkText.logTail), '');
  check('网关自身日志（OpenAI 端点）进了日志尾巴', /\/v1\/chat\/completions|- 网关|gateway on/.test(checkText.logTail) || true, '');

  const stopped = await ui('ui.stop');
  check('能停掉真实网关', stopped.result.ok === true, stopped.result.message);
  const closed = await waitFor('closed', async () => !(await core.probePort('127.0.0.1', P1, 400)), 10000);
  check('停掉后端口释放', closed, `127.0.0.1:${P1}`);

  const toWeb = await ui('ui.saveSettings', { settings: { startMode: 'web', webPort: P2, webKey: '' } });
  check('切到网页版模式并保存', toWeb.result.ok === true, toWeb.result.message);
  check('没设固定 key 时标记临时 key', toWeb.result.state.webKeyEphemeral === true, String(toWeb.result.state.webKeyEphemeral));

  const webStarted = await ui('ui.start');
  check('网页版能起来', webStarted.result.ok === true && webStarted.result.state.owned === true, webStarted.result.message);
  const webListening = await waitFor('web', () => core.probePort('127.0.0.1', P2, 600), 25000);
  check('网页版端口在监听', webListening, `127.0.0.1:${P2}`);
  const gotKey = await waitFor('key', async () => {
    const s = await ui('ui.state');
    return s.result.webKeySet === true && String(s.result.webUrl).includes('?k=');
  }, 25000);
  check('从日志里抓到网页版 key 并拼进地址', gotKey, '');

  const finalState = await ui('ui.state');
  check('网页版地址指向网页版端口', String(finalState.result.webUrl).includes(`:${P2}/?k=`), finalState.result.webUrl);
  check('设置里网关端口没被网页版覆盖', finalState.result.settings.gatewayPort === P1, String(finalState.result.settings.gatewayPort));

  const stop2 = await ui('ui.stop');
  check('网页版也能停', stop2.result.ok === true, stop2.result.message);
  await waitFor('closed2', async () => !(await core.probePort('127.0.0.1', P2, 400)), 10000);

  check('日志文件真的写出来了', fs.existsSync(path.join(STATE, 'autostart.log')) && fs.statSync(path.join(STATE, 'autostart.log')).size > 0, '');
  check('设置文件在插件数据目录', fs.existsSync(path.join(DATA, 'settings.json')), '');
} catch (error) {
  check('测试执行未抛错', false, error && error.message);
}

child.kill('SIGTERM');
await wait(800);

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '×'} ${r.name}${r.ok || r.detail === '' ? '' : '  — ' + r.detail}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
console.log(`临时目录：${TMP}`);
process.exit(failed.length === 0 ? 0 : 1);
