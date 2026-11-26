#!/usr/bin/env node
/**
 * 安装路径测试：
 *   1) 纯 Node 安装（注入假更新源 + 假二进制）——校验写入、权限、自检、版本识别
 *   2) sha256 不匹配时必须拒绝并清掉半成品
 *   3) 网络全挂时要给出可读原因，而不是只写"安装失败"
 *   4) MAGPIE_REAL_INSTALL=1 时用真实更新源装一次（约 90MB，默认跳过）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../nox/magpie-gateway/dist/core.cjs');

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });

function tempDirs() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-inst-'));
  const dirs = {
    home: path.join(tmp, 'home'),
    bin: path.join(tmp, 'bin'),
    state: path.join(tmp, 'state'),
    data: path.join(tmp, 'data'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return { tmp, dirs };
}

// 假二进制：--version / healthcheck / serve 都能应答
const FAKE_BIN = Buffer.from([
  '#!/bin/sh',
  'case "$1" in',
  '  --version) echo "magpie 9.9.9-fake"; exit 0 ;;',
  '  healthcheck) echo ok; exit 0 ;;',
  '  *) exec sleep 5 ;;',
  'esac',
  '',
].join('\n'));

const crypto = await import('node:crypto');
const digest = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function fakeNet({ feed, files, failAll }) {
  return {
    get: async (url) => {
      if (failAll) throw new Error('连不上 ' + url);
      if (url.includes('/api/latest')) return { status: 200, body: Buffer.from(JSON.stringify(feed)), headers: {} };
      if (files[url]) return { status: 200, body: files[url], headers: {} };
      throw new Error('HTTP 404 ' + url);
    },
    sha256: digest,
  };
}

function makeController(dirs, deps) {
  return core.createController({
    env: { HOME: dirs.home, PATH: process.env.PATH },
    binDir: dirs.bin,
    stateDir: dirs.state,
    settingsFile: path.join(dirs.data, 'settings.json'),
    resetLog: true,
    settings: { startMode: 'serve', proxyMode: 'off', proxy: '', autoStart: false, gatewayPort: 3911, webPort: 3912, webKey: '' },
    deps: deps,
  });
}

try {
  // 1) 正常安装
  {
    const { tmp, dirs } = tempDirs();
    const url = 'https://usemagpie.ai/files/v1.2.3/magpie-cli-linux-arm64';
    const feed = { version: '1.2.3', assets: { 'magpie-cli-linux-arm64': { url: url, sha256: digest(FAKE_BIN) } } };
    const ctl = makeController(dirs, { net: fakeNet({ feed: feed, files: { [url]: FAKE_BIN } }), probe: async () => false });
    const ok = await ctl.nodeInstall();
    const bin = path.join(dirs.bin, 'magpie');
    check('纯 Node 安装成功', ok === true, '');
    check('二进制写进了 bin 目录', fs.existsSync(bin), bin);
    check('权限是可执行', (fs.statSync(bin).mode & 0o111) !== 0, (fs.statSync(bin).mode & 0o777).toString(8));
    check('装完自检出版本号', /^magpie 9\.9\.9-fake/.test(ctl.snapshot().version), ctl.snapshot().version);
    check('状态显示已安装', ctl.snapshot().installed === true, '');
    check('没有留下 .download 半成品', !fs.existsSync(bin + '.download'), '');
    ctl.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 2) 校验不一致
  {
    const { tmp, dirs } = tempDirs();
    const url = 'https://usemagpie.ai/files/v1.2.3/magpie-cli-linux-arm64';
    const feed = { version: '1.2.3', assets: { 'magpie-cli-linux-arm64': { url: url, sha256: 'deadbeef' } } };
    const ctl = makeController(dirs, { net: fakeNet({ feed: feed, files: { [url]: FAKE_BIN } }), probe: async () => false });
    const ok = await ctl.nodeInstall();
    check('校验不一致时拒绝安装', ok === false, '');
    check('校验失败时不留二进制', !fs.existsSync(path.join(dirs.bin, 'magpie')), '');
    check('日志里写明校验不一致', /校验不一致/.test(ctl.snapshot().logTail), '');
    ctl.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 3) 网络全挂
  {
    const { tmp, dirs } = tempDirs();
    const ctl = makeController(dirs, { net: fakeNet({ failAll: true }), probe: async () => false });
    const ok = await ctl.nodeInstall();
    check('网络不通时返回失败', ok === false, '');
    check('日志里给出具体原因', /更新源读取失败：连不上/.test(ctl.snapshot().logTail), ctl.snapshot().logTail.split('\n').pop());
    ctl.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 4) 环境自检字段齐全
  {
    const { tmp, dirs } = tempDirs();
    const ctl = makeController(dirs, { probe: async () => true });
    const env = await ctl.diag();
    check('自检给了平台与架构', env.platform && env.arch, `${env.platform}/${env.arch}`);
    check('自检给了产物候选', Array.isArray(env.assets) && env.assets.length > 0, env.assets.join(','));
    check('自检给了网络探测结果', env.net && Object.keys(env.net).length >= 3, JSON.stringify(env.net));
    check('自检给了工具链清单', env.tools && 'curl' in env.tools && 'sh' in env.tools, Object.keys(env.tools).join(','));
    ctl.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 5) 容器里没有 sh/uname，但 node 还能 spawn：装得上也起得来
  {
    const { tmp, dirs } = tempDirs();
    const url = 'https://usemagpie.ai/files/v1.2.3/magpie-cli-linux-arm64';
    const feed = { version: '1.2.3', assets: { 'magpie-cli-linux-arm64': { url: url, sha256: digest(FAKE_BIN) } } };
    const ctl = makeController(dirs, {
      net: fakeNet({ feed: feed, files: { [url]: FAKE_BIN } }),
      probe: async () => false,
      shellCheck: () => ({ ok: false, reason: 'uname 不可用' }),
    });
    const ok = await ctl.nodeInstall();
    const snap = ctl.snapshot();
    check('没有 shell 也能装（纯 Node 路径）', ok === true, '');
    check('没有 shell 时状态仍是已安装', snap.installed === true && snap.shellOk === false, JSON.stringify({ installed: snap.installed, shellOk: snap.shellOk }));
    check('没有 shell 也能启动（spawn 不经过 sh）', snap.canStart === true, '');
    const started = ctl.start();
    check('start 不再被 shell 挡住', started.ok === true, started.message);
    await new Promise((r) => setTimeout(r, 300));
    ctl.stop();
    ctl.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 6) 坏掉的证书环境变量会被摘掉（curl 因此常报 77）
  {
    const { tmp, dirs } = tempDirs();
    fs.writeFileSync(path.join(dirs.bin, 'magpie'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    let seenEnv = null;
    const ctl = core.createController({
      env: { HOME: dirs.home, PATH: process.env.PATH, SSL_CERT_FILE: '/nope/ca.pem', CURL_CA_BUNDLE: '/nope/ca.pem' },
      binDir: dirs.bin,
      stateDir: dirs.state,
      settingsFile: path.join(dirs.data, 'settings.json'),
      resetLog: true,
      settings: { startMode: 'serve', proxyMode: 'off', proxy: '', autoStart: false, gatewayPort: 3921, webPort: 3922, webKey: '' },
      deps: {
        probe: async () => false,
        shellCheck: () => ({ ok: true, reason: '' }),
        spawn: (cmd, args, options) => { seenEnv = options.env; return { pid: 4242, on() {} }; },
        exit: () => {},
      },
    });
    ctl.start();
    check('启动时摘掉指向不存在文件的 SSL_CERT_FILE', seenEnv && seenEnv.SSL_CERT_FILE === undefined, String(seenEnv && seenEnv.SSL_CERT_FILE));
    check('启动时摘掉坏掉的 CURL_CA_BUNDLE', seenEnv && seenEnv.CURL_CA_BUNDLE === undefined, String(seenEnv && seenEnv.CURL_CA_BUNDLE));
    check('MAGPIE_ADDR 仍然写好', /^127\.0\.0\.1:3921$/.test(String(seenEnv && seenEnv.MAGPIE_ADDR)), String(seenEnv && seenEnv.MAGPIE_ADDR));
    ctl.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 7) 装不上时 lastError 给出具体原因，而不是"检查网络"
  {
    const { tmp, dirs } = tempDirs();
    const ctl = core.createController({
      env: { HOME: dirs.home, PATH: process.env.PATH },
      binDir: dirs.bin,
      stateDir: dirs.state,
      settingsFile: path.join(dirs.data, 'settings.json'),
      resetLog: true,
      settings: { startMode: 'serve', proxyMode: 'off', proxy: '', autoStart: false, gatewayPort: 3931, webPort: 3932, webKey: '' },
      deps: {
        net: {
          get: async () => { const error = new Error('证书校验失败'); error.code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'; throw error; },
          getSmart: async () => { const error = new Error('证书校验失败'); error.code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'; throw error; },
          sha256: digest,
        },
        probe: async () => true,
        shellCheck: () => ({ ok: false, reason: 'uname 不可用' }),
      },
    });
    const ok = await ctl.ensureInstalled({});
    check('安装失败时返回 false', ok === false, '');
    check('lastError 说的是真实原因', /更新源读取失败|UNABLE_TO_VERIFY/.test(ctl.snapshot().lastError), ctl.snapshot().lastError);
    check('日志里写了证书错误', /更新源读取失败/.test(ctl.snapshot().logTail), '');
    ctl.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 8) 面板没填代理时认环境变量代理
  {
    const { tmp, dirs } = tempDirs();
    const ctl = core.createController({
      env: { HOME: dirs.home, PATH: process.env.PATH, HTTPS_PROXY: 'http://127.0.0.1:18080' },
      binDir: dirs.bin,
      stateDir: dirs.state,
      settingsFile: path.join(dirs.data, 'settings.json'),
      resetLog: true,
      settings: { startMode: 'serve', proxyMode: 'fallback', proxy: '', autoStart: false, gatewayPort: 3941, webPort: 3942, webKey: '' },
      deps: { probe: async () => false, shellCheck: () => ({ ok: true, reason: '' }) },
    });
    const env2 = await ctl.diag();
    check('面板没填代理时认环境变量代理', env2.proxy === 'http://127.0.0.1:18080', String(env2.proxy));
    ctl.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 9) 真实安装（可选）
  if (process.env.MAGPIE_REAL_INSTALL === '1') {
    const { tmp, dirs } = tempDirs();
    const ctl = makeController(dirs, { probe: async () => true });
    const ok = await ctl.nodeInstall();
    check('真实更新源装得上', ok === true, ctl.snapshot().logTail.split('\n').slice(-2).join(' | '));
    check('真实二进制能 --version', /^magpie \d+\.\d+/.test(ctl.snapshot().version), ctl.snapshot().version);
    ctl.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    check('真实安装默认跳过（MAGPIE_REAL_INSTALL=1 打开）', true, '');
  }
} catch (error) {
  check('测试执行未抛错', false, error && error.stack ? error.stack.split('\n')[0] : error.message);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '×'} ${r.name}${r.ok || r.detail === '' ? '' : '  — ' + r.detail}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
