'use strict';
/**
 * magpie 安装 / 启动 / 状态的核心逻辑。
 * 与宿主无关：一个控制器只管装、起、停、探端口、写日志；页面与 runtime 只在外层接线。
 * 额外补齐了 Nox 才需要的两件事：
 *   - detectShell()：插件进程有没有可用的 POSIX shell（没有就让页面走宿主终端兜底）
 *   - plan()：把安装 / 启动 / 停止翻译成一段 bash 命令，供页面直接丢给终端
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const settingsLib = require('./settings.cjs');
const netlib = require('./net.cjs');

const INSTALLER_URL = 'https://usemagpie.ai/install.sh';
const FEED_URL = 'https://usemagpie.ai/api/latest';
const DEFAULT_LINK_PATH = '/usr/local/bin/magpie';
const TAIL_LINES = 400;
const LOG_TAIL_CHARS = 6000;
const RELEVANT = ['startMode', 'gatewayPort', 'webPort', 'webKey'];
const STALE_LOCK_MS = 40 * 60 * 1000;

function parseAddr(raw, fallbackPort) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  const cut = text.lastIndexOf(':');
  if (cut < 0) {
    if (/^\d+$/.test(text)) return { host: '127.0.0.1', port: Number(text) || fallbackPort };
    return { host: text || '127.0.0.1', port: fallbackPort };
  }
  const port = Number(text.slice(cut + 1)) || fallbackPort;
  let host = text.slice(0, cut).replace(/^\[|\]$/g, '') || '127.0.0.1';
  if (host === '0.0.0.0' || host === '::' || host === '*') host = '127.0.0.1';
  return { host: host, port: port };
}

function proxyEndpoint(url) {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 1080);
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    return { host: host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host, port: port };
  } catch (e) {
    return { host: '127.0.0.1', port: 10808 };
  }
}

function probePort(host, port, timeout) {
  return new Promise(function (resolve) {
    const socket = net.createConnection({ host: host, port: port });
    const done = function (value) {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout === undefined ? 800 : timeout);
    socket.once('connect', function () { done(true); });
    socket.once('timeout', function () { done(false); });
    socket.once('error', function () { done(false); });
  });
}

function keyFromText(text) {
  const matches = String(text === undefined || text === null ? '' : text).match(/[?&]k=([A-Za-z0-9._~-]{16,})/g);
  if (!matches || matches.length === 0) return '';
  return matches[matches.length - 1].replace(/^[?&]k=/, '');
}

function splitLogChunk(text, max) {
  const limit = max === undefined ? 400 : max;
  const out = [];
  const parts = String(text === undefined || text === null ? '' : text).split(/\r?\n|\r/);
  for (let i = 0; i < parts.length; i += 1) {
    const line = parts[i].replace(/\s+$/, '').slice(0, limit);
    if (line !== '') out.push(line);
  }
  return out;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function isLockStale(raw, now, alive) {
  const at = now === undefined ? Date.now() : now;
  const check = alive === undefined ? pidAlive : alive;
  let payload;
  try {
    payload = JSON.parse(String(raw));
  } catch (e) {
    return true;
  }
  if (payload === null || typeof payload !== 'object') return true;
  if (Number.isInteger(payload.pid)) return !check(payload.pid);
  if (typeof payload.ts === 'number') return at - payload.ts > STALE_LOCK_MS;
  return true;
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/** 插件进程能不能起子进程跑 POSIX 命令。Android 容器里常常不行，那时页面走 Nox.bash。 */
function detectShell(runner) {
  const probe = runner || function (cmd, args) {
    const result = spawnSync(cmd, args, { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: !result.error && result.status === 0, error: result.error ? String(result.error.message || result.error) : '' };
  };
  const out = probe('uname', ['-s']);
  if (!out.ok) return { ok: false, reason: out.error || 'uname 不可用' };
  return { ok: true, reason: '' };
}

function createController(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const HOME = env.MAGPIE_HOME || os.homedir() || '/root';
  const BIN_DIR = opts.binDir || env.MAGPIE_BIN_DIR || path.join(HOME, '.local/bin');
  const BIN = path.join(BIN_DIR, 'magpie');
  const STATE_DIR = opts.stateDir || env.MAGPIE_STATE_DIR || path.join(HOME, '.local/state/magpie');
  const LOG_FILE = path.join(STATE_DIR, 'autostart.log');
  const LOCK_FILE = path.join(STATE_DIR, 'install.lock');
  const SETTINGS_FILE = opts.settingsFile || path.join(STATE_DIR, 'nox-settings.json');
  const LINK_PATH = opts.linkPath || env.MAGPIE_LINK_PATH || DEFAULT_LINK_PATH;
  const addr = parseAddr(env.MAGPIE_ADDR || '127.0.0.1:3425', 3425);
  const HOST = opts.host || addr.host;
  const platformOk = opts.platform === undefined ? process.platform !== 'win32' : opts.platform === 'linux';
  const injected = opts.deps || {};

  const deps = {
    run: injected.run || runSync,
    runAsync: injected.runAsync || runAsyncDefault,
    spawn: injected.spawn || spawn,
    probe: injected.probe || probePort,
    exit: injected.exit || function (child, cb) { child.once('exit', cb); },
    shellCheck: injected.shellCheck || detectShell,
    net: injected.net || netlib,
    readLog: injected.readLog || function () {
      try {
        return fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).slice(-200).join('\n');
      } catch (e) {
        return '';
      }
    },
  };

  let settings = settingsLib.normalizeSettings(opts.settings);
  let child = null;
  let childAlive = false;
  let disposed = false;
  let installing = false;
  let lastError = '';
  let version = null;
  let activeMode = null;
  let startedWith = null;
  let externalRunning = false;
  let restartTimer = null;
  let drainingProc = null;
  let installReasons = [];
  const tail = [];
  const listeners = new Set();

  const shell = deps.shellCheck();

  if (opts.resetLog !== false) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(LOG_FILE, '');
    } catch (e) {
      // 清不了就照常追加
    }
  }

  let publishTimer = null;
  function publish() {
    const state = snapshot();
    listeners.forEach(function (emit) {
      try {
        emit(state);
      } catch (e) {
        // 单个订阅者出错不影响别的
      }
    });
  }

  function schedulePublish() {
    if (publishTimer) return;
    publishTimer = setTimeout(function () {
      publishTimer = null;
      publish();
    }, 500);
    if (typeof publishTimer.unref === 'function') publishTimer.unref();
  }

  function log(message) {
    const line = new Date().toISOString() + ' [nox] ' + message;
    tail.push(line);
    if (tail.length > TAIL_LINES) tail.shift();
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.appendFileSync(LOG_FILE, line + '\n');
    } catch (e) {
      // 日志写不进去不影响主流程
    }
    process.stderr.write('[magpie] ' + message + '\n');
    schedulePublish();
  }

  function absorb(text) {
    const lines = splitLogChunk(text);
    for (let i = 0; i < lines.length; i += 1) tail.push(lines[i]);
    while (tail.length > TAIL_LINES) tail.shift();
    if (lines.length === 0) return;
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.appendFileSync(LOG_FILE, lines.map(function (line) { return line + '\n'; }).join(''));
    } catch (e) {
      // 同上
    }
    schedulePublish();
  }

  function redactArgs(args) {
    return args.map(function (arg) {
      const text = String(arg);
      if (/^[a-z][a-z0-9+.-]*:\/\/[^@\s/]+@/i.test(text)) return text.replace(/\/\/[^@/]*@/, '//');
      return text;
    });
  }

  function gatewayUrl() {
    return 'http://' + HOST + ':' + settings.gatewayPort;
  }

  function webKey() {
    return settings.webKey || keyFromText(deps.readLog());
  }

  function webUrl() {
    const key = webKey();
    return 'http://' + HOST + ':' + settings.webPort + (key ? '/?k=' + key : '');
  }

  function baseEnv(mode) {
    const out = Object.assign({}, env, {
      HOME: HOME,
      DEBIAN_FRONTEND: 'noninteractive',
      MAGPIE_ADDR: HOST + ':' + settings.gatewayPort,
      PATH: BIN_DIR + ':' + (env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'),
    });
    if (mode === 'web' && settings.webKey) out.MAGPIE_WEB_KEY = settings.webKey;
    // 有些容器把 SSL_CERT_FILE 指到一个不存在的文件，curl 会直接报
    // "error setting certificate file"（退出码 77）。指错就摘掉，让 curl 用默认路径。
    ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE'].forEach(function (key) {
      const value = out[key];
      if (typeof value === 'string' && value !== '' && !fs.existsSync(value)) delete out[key];
    });
    return out;
  }

  function runSync(cmd, args, runOpts) {
    const conf = runOpts || {};
    const result = spawnSync(cmd, args, {
      env: baseEnv(),
      timeout: conf.timeout === undefined ? 60000 : conf.timeout,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      ok: !result.error && result.status === 0,
      status: result.status,
      error: result.error ? String(result.error.message) : '',
      output: String(result.stdout || '') + String(result.stderr || ''),
    };
  }

  function runAsyncDefault(cmd, args, runOpts) {
    const conf = runOpts || {};
    const timeout = conf.timeout === undefined ? 600000 : conf.timeout;
    const stream = conf.stream === true;
    return new Promise(function (resolve) {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const startedAt = Date.now();
      const beat = stream
        ? setInterval(function () {
            log('仍在执行 ' + cmd + '…（' + Math.round((Date.now() - startedAt) / 1000) + 's）');
          }, 30000)
        : null;
      if (beat && typeof beat.unref === 'function') beat.unref();
      const finish = function (value) {
        if (settled) return;
        settled = true;
        if (beat) clearInterval(beat);
        resolve(value);
      };
      let proc;
      try {
        proc = spawn(cmd, args, { env: baseEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        finish({ ok: false, status: null, error: String(err.message || err), output: '' });
        return;
      }
      const timer = setTimeout(function () {
        proc.kill('SIGKILL');
        finish({ ok: false, status: null, error: '超时 ' + timeout + 'ms', output: (stdout + stderr).slice(-500) });
      }, timeout);
      proc.stdout.on('data', function (chunk) {
        stdout += chunk;
        if (stream) absorb(chunk);
      });
      proc.stderr.on('data', function (chunk) {
        stderr += chunk;
        if (stream) absorb(chunk);
      });
      proc.on('error', function (err) {
        clearTimeout(timer);
        finish({ ok: false, status: null, error: String(err.message || err), output: '' });
      });
      proc.on('close', function (code) {
        clearTimeout(timer);
        finish({ ok: code === 0, status: code, error: '', output: (stdout + stderr).trim().slice(-500) });
      });
    });
  }

  function magpieWorks() {
    if (!fs.existsSync(BIN)) return false;
    // 不用 shell.ok 兜底：spawn 是 execve，不经过 sh。真起不来会体现在 result 上。
    const result = deps.run(BIN, ['--version'], { timeout: 20000 });
    if (result.ok && !version) version = String(result.output).split(/\r?\n/)[0].trim() || 'magpie';
    return result.ok;
  }

  function ensureCliOnPath() {
    try {
      let info = null;
      try {
        info = fs.lstatSync(LINK_PATH);
      } catch (e) {
        // 还不存在
      }
      if (info) {
        if (!info.isSymbolicLink()) {
          log(LINK_PATH + ' 已存在且不是软链，保留原文件不动');
          return false;
        }
        let target = '';
        try {
          target = fs.readlinkSync(LINK_PATH);
        } catch (e) {
          // 读不到就重建
        }
        if (target === BIN) return true;
        try {
          fs.unlinkSync(LINK_PATH);
        } catch (e) {
          // 删不掉就让下面的 symlink 报错
        }
      }
      fs.mkdirSync(path.dirname(LINK_PATH), { recursive: true });
      fs.symlinkSync(BIN, LINK_PATH);
      log('已创建软链 ' + LINK_PATH + ' -> ' + BIN);
      return true;
    } catch (err) {
      log('创建软链 ' + LINK_PATH + ' 失败: ' + (err && err.message ? err.message : String(err)));
      return false;
    }
  }

  /** 容器里常常缺 CA 包：curl 会报 "error setting certificate file"（77）。能装就补上。 */
  async function ensureCaCerts() {
    const candidates = ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/cert.pem'];
    if (candidates.some(function (file) { return fs.existsSync(file); })) return true;
    log('系统 CA 包缺失（' + candidates[0] + ' 不存在），尝试 apt-get install ca-certificates');
    const install = await deps.runAsync('apt-get', ['install', '-y', 'ca-certificates'], { timeout: 300000, stream: true });
    if (!install.ok) {
      installReasons.push('CA 包装不上 ' + (install.error || ''));
      log('CA 包装不上：' + (install.error || install.output || '未知原因'));
      return false;
    }
    const done = candidates.some(function (file) { return fs.existsSync(file); });
    log(done ? 'CA 包已补上' : 'apt 说装完了，但证书文件仍然不在');
    return done;
  }

  async function ensurePrerequisites() {
    if (deps.run('curl', ['--version'], { timeout: 10000 }).ok) return true;
    log('curl 缺失：先直接 apt-get install（不先 update，省一轮索引下载）');
    log('$ apt-get install -y curl ca-certificates');
    let install = await deps.runAsync('apt-get', ['install', '-y', 'curl', 'ca-certificates'], { timeout: 300000, stream: true });
    if (!install.ok) {
      log('直接安装失败，执行 apt-get update 后重试: ' + (install.error || install.output));
      log('$ apt-get update');
      const update = await deps.runAsync('apt-get', ['update'], { timeout: 180000, stream: true });
      if (!update.ok) log('apt-get update 失败（继续尝试安装）: ' + (update.error || update.output));
      log('$ apt-get install -y curl ca-certificates');
      install = await deps.runAsync('apt-get', ['install', '-y', 'curl', 'ca-certificates'], { timeout: 300000, stream: true });
    }
    if (!install.ok) {
      log('apt-get 安装失败: ' + (install.error || install.output));
      return false;
    }
    return deps.run('curl', ['--version'], { timeout: 10000 }).ok;
  }

  async function runInstaller(useProxy) {
    let dir;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-install-'));
      const script = path.join(dir, 'install.sh');
      const curlArgs = ['-fsSL', '--retry', '2', '--connect-timeout', '20', '--max-time', '900'];
      if (useProxy) curlArgs.push('--proxy', settings.proxy);
      curlArgs.push('-o', script, INSTALLER_URL);

      log('下载安装脚本' + (useProxy ? '（经代理）' : '（直连）') + ': ' + INSTALLER_URL);
      log('$ curl ' + redactArgs(curlArgs).join(' '));
      const download = await deps.runAsync('curl', curlArgs, { timeout: 960000, stream: true });
      if (!download.ok) {
        const detail = String(download.error || download.output || '').trim();
        installReasons.push('curl 下载安装脚本失败 ' + detail.slice(-120));
        log('下载安装脚本失败: ' + detail);
        return false;
      }

      const shArgs = [script, '--tui'];
      if (useProxy) shArgs.push('--proxy', settings.proxy);
      log('$ sh ' + redactArgs(shArgs).join(' '));
      const install = await deps.runAsync('sh', shArgs, { timeout: 900000, stream: true });
      if (!install.ok) {
        log('安装脚本失败: ' + (install.error || install.output));
        return false;
      }
      return true;
    } catch (err) {
      log('安装异常: ' + (err && err.message ? err.message : String(err)));
      return false;
    } finally {
      if (dir) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch (e) {
          // 临时目录清理失败无关紧要
        }
      }
    }
  }

  function acquireLock() {
    const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(LOCK_FILE, payload, { flag: 'wx' });
      return true;
    } catch (e) {
      let stale = true;
      try {
        stale = isLockStale(fs.readFileSync(LOCK_FILE, 'utf8'));
      } catch (err) {
        stale = true;
      }
      if (!stale) return false;
      try {
        fs.unlinkSync(LOCK_FILE);
        fs.writeFileSync(LOCK_FILE, payload, { flag: 'wx' });
        log('安装锁是上次中断留下的，已接管');
        return true;
      } catch (err) {
        return false;
      }
    }
  }

  function releaseLock() {
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch (e) {
      // 锁本来就不存在
    }
  }

  /** 产物名：magpie-cli-<os>-<arch>；linux 上再退回 android 构建与完整版。 */
  function assetKeys() {
    const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? '386' : 'amd64';
    const keys = ['magpie-cli-' + os + '-' + arch];
    if (os === 'linux') {
      keys.push('magpie-cli-android-' + arch);
      keys.push('magpie-' + os + '-' + arch);
    }
    return keys;
  }

  /** 下载：优先用带证书降级的 getSmart；降级时把原因写进日志，不静默。 */
  async function netGet(url, options) {
    const client = deps.net;
    const runner = typeof client.getSmart === 'function' ? client.getSmart : client.get;
    const result = await runner.call(client, url, options);
    if (result && result.insecureTls) {
      log('证书校验失败（' + String(result.certError || '系统 CA 缺失') + '），改用不校验证书的方式下载；安装包仍按 sha256 校验');
    }
    return result;
  }

  /** 容器里常见的 https_proxy / ALL_PROXY 也认：面板没填代理时用它。 */
  function envProxy() {
    const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
    for (let i = 0; i < keys.length; i += 1) {
      const value = env[keys[i]];
      if (typeof value === 'string' && value.trim() !== '') return { from: keys[i], url: value.trim() };
    }
    return null;
  }

  function proxyForNode() {
    if (settings.proxyMode === 'off') return null;
    if (settings.proxy) return settings.proxy;
    const found = envProxy();
    if (found) {
      log('使用环境变量代理 ' + found.from + '=' + found.url);
      return found.url;
    }
    return null;
  }

  function writeBinary(buffer) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
    const temp = BIN + '.download';
    fs.writeFileSync(temp, buffer);
    fs.chmodSync(temp, 0o755);
    fs.renameSync(temp, BIN);
    fs.chmodSync(BIN, 0o755);
  }

  /**
   * 纯 Node 安装：只读一个 JSON 更新源 + 下一个单文件，不依赖 curl / sh / apt / tar。
   * 装完立刻 --version 自检，跑不起来就换下一个候选（比如 linux 构建在 proot 里不行就换 android 构建）。
   */
  async function nodeInstall() {
    const proxy = proxyForNode();
    log('读取更新源 ' + FEED_URL + (proxy ? '（经代理 ' + proxy + '）' : '（直连）'));
    let feed;
    try {
      const res = await netGet(FEED_URL, { proxy: proxy, timeoutMs: 30000, maxBytes: 2 * 1024 * 1024 });
      feed = JSON.parse(res.body.toString('utf8'));
    } catch (err) {
      const reason = (err && (err.code || err.message)) || String(err);
      installReasons.push('更新源读取失败 ' + reason);
      log('更新源读取失败：' + reason);
      return false;
    }
    const assets = feed && feed.assets ? feed.assets : null;
    if (!assets) {
      log('更新源里没有 assets 字段');
      return false;
    }
    log('更新源版本 ' + (feed.version || '未知'));

    const keys = assetKeys().filter(function (key) { return assets[key] && assets[key].sha256; });
    if (keys.length === 0) {
      log('更新源里没有适配本机的产物：' + assetKeys().join(' / '));
      return false;
    }

    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      const entry = assets[key];
      const urls = [entry.url, entry.github].filter(Boolean);
      for (let j = 0; j < urls.length; j += 1) {
        const url = urls[j];
        try {
          log('下载 ' + key + '：' + url);
          const res = await netGet(url, {
            proxy: proxy,
            timeoutMs: 900000,
            maxBytes: 400 * 1024 * 1024,
            headers: { Accept: 'application/octet-stream' },
          });
          const digest = deps.net.sha256(res.body);
          if (digest !== String(entry.sha256).toLowerCase()) {
            log('校验不一致（得到 ' + digest.slice(0, 16) + '…，应为 ' + String(entry.sha256).slice(0, 16) + '…），换下一个地址');
            continue;
          }
          log('校验通过（' + (res.body.length / 1024 / 1024).toFixed(1) + ' MiB）');
          writeBinary(res.body);
          log('已写入 ' + BIN);
          const probe = deps.run(BIN, ['--version'], { timeout: 20000 });
          if (probe.ok) {
            version = String(probe.output).split(/\r?\n/)[0].trim() || 'magpie';
            log('magpie ' + version + ' 安装完成');
            return true;
          }
          log('下载的 magpie 跑不起来：' + String(probe.error || probe.output || 'exit ' + probe.status).slice(0, 200));
          try {
            fs.unlinkSync(BIN);
          } catch (e) {
            // 删不掉就留着，下一次会覆盖
          }
        } catch (err) {
          const reason = (err && (err.code || err.message)) || String(err);
          installReasons.push(key + ' 下载失败 ' + reason);
          log('下载失败：' + reason);
        }
      }
    }
    return false;
  }

  async function ensureInstalled(installOpts) {
    const force = Boolean(installOpts && installOpts.force);
    if (!platformOk) {
      log('当前平台 ' + process.platform + ' 不是 Linux，跳过安装');
      return false;
    }
    if (!force && magpieWorks()) return true;

    if (!acquireLock()) {
      log('另一个实例正在安装 magpie，等待其完成');
      let got = false;
      for (let i = 0; i < 120; i += 1) {
        await delay(5000);
        if (magpieWorks()) return true;
        if (acquireLock()) { got = true; break; }
      }
      if (!got) {
        log('等待安装超时');
        return false;
      }
    }

    installing = true;
    lastError = '';
    installReasons = [];
    publish();
    try {
      if (!force && magpieWorks()) return true;
      log(force ? '按要求重装 magpie' : fs.existsSync(BIN) ? 'magpie 文件存在但无法运行，重新安装' : '未检测到 magpie，开始安装');

      // 1) 只用 Node：不依赖 curl / sh / apt / tar，容器里只要有 node 就能装
      let installed = await nodeInstall();
      if (!installed) log('精简安装没成功，改用官方安装脚本（需要 curl 与 sh）');

      // 2) 官方脚本：按直连 / 代理设置重试
      if (!installed) {
        if (!shell.ok) {
          const why = installReasons.length > 0 ? '（' + installReasons[installReasons.length - 1] + '）' : '';
          lastError = ('没有可用的 shell，也没能直接下载到 magpie' + why).slice(0, 120);
          log('安装中止: ' + lastError);
          return false;
        }
        await ensureCaCerts();
        if (!(await ensurePrerequisites())) {
          lastError = '前置依赖不可用（curl / ca-certificates）';
          log('安装中止: ' + lastError);
          return false;
        }
        const attempts = [];
        if (settings.proxyMode === 'always') {
          attempts.push(true);
        } else if (settings.proxyMode === 'off' || !settings.proxy) {
          attempts.push(false);
        } else {
          attempts.push(false);
          const endpoint = proxyEndpoint(settings.proxy);
          if (await deps.probe(endpoint.host, endpoint.port)) {
            attempts.push(true);
          } else {
            log('代理 ' + settings.proxy + ' 未在监听，只用直连');
          }
        }
        for (let i = 0; i < attempts.length && !installed; i += 1) {
          if (i > 0) log('直连安装失败，改用代理重试');
          installed = await runInstaller(attempts[i]);
        }
      }

      if (!installed) {
        // 两条路都失败：探一下到底是"没有外网"还是"下载到了但跑不起来"，让面板说人话。
        const reach = await Promise.all([
          deps.probe('usemagpie.ai', 443, 4000),
          deps.probe('github.com', 443, 4000),
        ]);
        if (!reach[0] && !reach[1]) {
          lastError = '容器连不上 usemagpie.ai 和 github.com：在设置里填代理，或先在终端装好 magpie';
        } else if (fs.existsSync(BIN)) {
          lastError = 'magpie 已下载但跑不起来（架构或 libc 不匹配），看环境自检';
        } else if (installReasons.length > 0) {
          lastError = String(installReasons[installReasons.length - 1]).slice(0, 120);
        } else {
          lastError = 'magpie 安装失败，检查网络或代理设置（环境自检里有具体探测结果）';
        }
        if (installReasons.length > 1) log('历次失败：' + installReasons.join(' / '));
        log(lastError);
        return false;
      }

      ensureCliOnPath();

      if (magpieWorks()) {
        log('magpie 安装完成');
        publish();
        return true;
      }
      lastError = 'magpie 已下载但无法运行（可能是架构或 libc 不匹配）';
      log(lastError);
      return false;
    } finally {
      installing = false;
      releaseLock();
      publish();
    }
  }

  /** 在 PATH 里找一个可执行文件，不 spawn。 */
  function which(name) {
    const dirs = String(env.PATH || '/usr/local/bin:/usr/bin:/bin').split(':');
    for (let i = 0; i < dirs.length; i += 1) {
      if (!dirs[i]) continue;
      const candidate = path.join(dirs[i], name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch (e) {
        // 继续找
      }
    }
    return '';
  }

  /** 环境自检：容器里到底有什么、能连到哪儿。装不上时先看这个。 */
  async function diag() {
    const tools = {};
    ['sh', 'bash', 'curl', 'wget', 'apt-get', 'tar', 'sha256sum', 'ln'].forEach(function (name) {
      tools[name] = which(name) || '';
    });
    const net = {};
    const probes = [['usemagpie.ai', 443], ['github.com', 443], ['api.github.com', 443]];
    for (let i = 0; i < probes.length; i += 1) {
      net[probes[i][0] + ':' + probes[i][1]] = await deps.probe(probes[i][0], probes[i][1], 3000);
    }
    const proxy = proxyForNode();
    const caPaths = ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/cert.pem'];
    const ca = {
      found: caPaths.find(function (file) { return fs.existsSync(file); }) || '',
      env: {
        SSL_CERT_FILE: env.SSL_CERT_FILE || '',
        SSL_CERT_DIR: env.SSL_CERT_DIR || '',
        NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS || '',
        CURL_CA_BUNDLE: env.CURL_CA_BUNDLE || '',
      },
    };
    let tls = 'ok';
    try {
      await deps.net.get(FEED_URL, { proxy: proxy, timeoutMs: 8000, maxBytes: 65536 });
    } catch (err) {
      tls = (err && (err.code || err.message)) ? String(err.code || err.message) : String(err);
    }
    return {
      platform: process.platform,
      ca: ca,
      tls: tls,
      arch: process.arch,
      node: process.version,
      home: HOME,
      path: env.PATH || '',
      shell: shell,
      tools: tools,
      binDir: BIN_DIR,
      bin: BIN,
      binExists: fs.existsSync(BIN),
      binVersion: fs.existsSync(BIN) && shell.ok ? (deps.run(BIN, ['--version'], { timeout: 5000 }).output || '').split(/\r?\n/)[0] : '',
      net: net,
      proxy: proxy,
      assets: assetKeys(),
      settings: Object.assign({}, settings),
      lastError: lastError,
      stateDir: STATE_DIR,
      logTail: tail.slice(-40).join('\n'),
    };
  }

  function webArgs() {
    return ['web', '--addr', HOST + ':' + settings.webPort, '--no-open'];
  }

  function start(startOpts) {
    if (startOpts && (startOpts.mode === 'serve' || startOpts.mode === 'web') && startOpts.mode !== settings.startMode) {
      settings = settingsLib.normalizeSettings(Object.assign({}, settings, { startMode: startOpts.mode }));
    }
    if (!platformOk) return { ok: false, message: '当前平台 ' + process.platform + ' 不是 Linux' };
    if (child && childAlive) return { ok: true, message: '网关已在运行' };
    if (!fs.existsSync(BIN)) return { ok: false, message: 'magpie 还没装好，先安装' };
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const fd = fs.openSync(LOG_FILE, 'a');
      const mode = settings.startMode === 'web' ? 'web' : 'serve';
      const args = mode === 'web' ? webArgs() : ['serve'];
      const proc = deps.spawn(BIN, args, { env: baseEnv(mode), stdio: ['ignore', fd, fd] });
      fs.closeSync(fd);
      child = proc;
      childAlive = true;
      activeMode = mode;
      startedWith = pickRelevant(settings);
      // 退出事件只清自己这一个进程：magpie 收到 SIGTERM 后可能还要排空几秒，
      // 那期间新起的进程不能被旧进程的退出事件连坐清掉（否则面板会以为没在跑）。
      proc.on('error', function (err) {
        if (child === proc) {
          childAlive = false;
          child = null;
          lastError = 'magpie 启动失败';
        }
        log('启动失败: ' + (err && err.message ? err.message : String(err)));
        publish();
      });
      deps.exit(proc, function (code) {
        const wasCurrent = child === proc;
        if (wasCurrent) {
          childAlive = false;
          child = null;
        }
        log('magpie 退出（code ' + (code === null || code === undefined ? 'null' : code) + '）' + (wasCurrent ? '' : '（已被新进程取代）'));
        publish();
      });
      log('已启动 magpie ' + mode + (mode === 'web' ? '（网页版 ' + webUrl() + '）' : '') + '，pid: ' + proc.pid);
      publish();
      return { ok: true, message: mode === 'web' ? '已启动网关和网页版' : '已启动网关', pid: proc.pid };
    } catch (err) {
      lastError = '启动失败: ' + (err && err.message ? err.message : String(err));
      log(lastError);
      return { ok: false, message: lastError };
    }
  }

  function stop() {
    if (!child || !childAlive) {
      return { ok: false, message: '没有由本插件启动的 magpie 在运行' };
    }
    const proc = child;
    child = null;
    childAlive = false;
    drainingProc = proc;
    try {
      proc.kill('SIGTERM');
      log('已停止 magpie');
      publish();
      return { ok: true, message: '已停止' };
    } catch (err) {
      return { ok: false, message: '停止失败: ' + (err && err.message ? err.message : String(err)) };
    }
  }

  /** 等某个进程真的退出（最多 ms 毫秒）；排空中的 magpie 会占着端口，不等就会抢不到。 */
  function waitExit(proc, ms) {
    return new Promise(function (resolve) {
      if (!proc || proc.exitCode !== null || proc.signalCode) {
        resolve(true);
        return;
      }
      let done = false;
      const finish = function () {
        if (done) return;
        done = true;
        resolve(true);
      };
      proc.once('exit', finish);
      setTimeout(finish, ms);
    });
  }

  /** 起进程前先等上一次的排空结束，避免端口还在旧进程手里。 */
  async function startWhenFree(startOpts) {
    if (drainingProc) {
      const old = drainingProc;
      drainingProc = null;
      const gone = await waitExit(old, 10000);
      if (!gone) log('上一个 magpie 还在退出，先按端口占用继续启动');
    }
    return start(startOpts);
  }

  function restartIfOwned() {
    if (!childAlive) return false;
    stop();
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(function () {
      restartTimer = null;
      if (!disposed) startWhenFree().catch(function () {});
    }, 700);
    if (typeof restartTimer.unref === 'function') restartTimer.unref();
    return true;
  }

  async function refresh() {
    if (!platformOk) return snapshot();
    if (fs.existsSync(BIN)) {
      if (!version && !installing && shell.ok) magpieWorks();
    } else {
      version = null;
    }
    if (!childAlive) {
      const probes = [deps.probe(HOST, settings.gatewayPort, 500)];
      if (settings.startMode === 'web') probes.push(deps.probe(HOST, settings.webPort, 500));
      const results = await Promise.all(probes);
      externalRunning = results.some(Boolean);
    } else {
      externalRunning = false;
    }
    return snapshot();
  }

  function isRunning() {
    return childAlive || externalRunning;
  }

  function needsRestart() {
    if (!childAlive || !startedWith) return false;
    const now = pickRelevant(settings);
    return RELEVANT.some(function (key) { return now[key] !== startedWith[key]; });
  }

  function checkStatus() {
    log('查看状态：');
    const installed = fs.existsSync(BIN);
    if (!installed) log('magpie: 未安装（' + BIN + ' 不存在）');
    else if (!shell.ok) log('magpie: 已安装，但插件进程没有 shell，无法执行 --version');
    else {
      const v = deps.run(BIN, ['--version'], { timeout: 2000 });
      log('magpie --version: ' + (v.ok ? (String(v.output).split(/\r?\n/)[0] || 'ok') : '失败（' + (v.error || 'exit ' + v.status) + '）'));
      const h = deps.run(BIN, ['healthcheck'], { timeout: 2500 });
      log('magpie healthcheck: ' + (h.ok ? 'ok' : '失败（' + (h.error || 'exit ' + h.status) + '）') + (h.output ? ' — ' + String(h.output).split(/\r?\n/)[0].slice(0, 160) : ''));
    }
    log('进程: ' + (childAlive ? '本插件启动，pid ' + (child && child.pid) : externalRunning ? '外部启动（不是本插件）' : '未运行'));
    log('网关 ' + gatewayUrl() + ': ' + (isRunning() ? '在监听' : '无响应'));
    if (settings.startMode === 'web') log('网页版 ' + (webUrl() || '（地址未生成）') + ': ' + (isRunning() ? '在监听' : '无响应'));
    log('启动方式 ' + settings.startMode + '；代理 ' + settings.proxyMode + (settings.proxy ? ' ' + settings.proxy : ''));
    return snapshot();
  }

  /** 给页面的终端兜底：插件进程没有 shell 时，这些命令由 Nox.bash 执行。 */
  function plan(name) {
    const LOG = LOG_FILE;
    const BINQ = '"' + BIN + '"';
    const proxyFlag = settings.proxy ? ' --proxy ' + settings.proxy : '';
    const install = [
      'apt-get install -y curl ca-certificates',
      'curl -fsSL --retry 2 --connect-timeout 20 --max-time 900 -o /tmp/magpie-install.sh ' + INSTALLER_URL,
      'sh /tmp/magpie-install.sh --tui' + proxyFlag,
      'ln -sf ' + BINQ + ' ' + LINK_PATH,
    ];
    const serve = 'MAGPIE_ADDR=' + HOST + ':' + settings.gatewayPort + ' nohup ' + BINQ + ' serve >> ' + LOG + ' 2>&1 &';
    const web = 'MAGPIE_ADDR=' + HOST + ':' + settings.gatewayPort
      + (settings.webKey ? ' MAGPIE_WEB_KEY=' + settings.webKey : '')
      + ' nohup ' + BINQ + ' web --addr ' + HOST + ':' + settings.webPort + ' --no-open >> ' + LOG + ' 2>&1 &';
    const planMap = {
      install: install,
      start: settings.startMode === 'web' ? [web] : [serve],
      serve: [serve],
      web: [web],
      stop: ['pkill -f "magpie serve" || true', 'pkill -f "magpie web" || true'],
      version: [BINQ + ' --version'],
      health: [BINQ + ' healthcheck'],
      port: ['(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ":' + settings.gatewayPort + '|:' + settings.webPort + '" || true'],
    };
    return {
      name: name,
      mode: settings.startMode,
      commands: planMap[name] || [],
      logFile: LOG,
      bin: BIN,
    };
  }

  function snapshot() {
    const showWeb = settings.startMode === 'web';
    const running = isRunning();
    return {
      platformOk: platformOk,
      shellOk: shell.ok,
      shellReason: shell.reason,
      installed: fs.existsSync(BIN),
      version: version || '',
      running: running,
      owned: Boolean(childAlive),
      mode: activeMode || (showWeb ? 'web' : 'serve'),
      gatewayPort: settings.gatewayPort,
      webPort: settings.webPort,
      webKeySet: webKey() !== '',
      webKeyEphemeral: showWeb && !settings.webKey,
      canStart: platformOk && !running && !installing && fs.existsSync(BIN),
      canStop: Boolean(childAlive),
      gatewayUrl: gatewayUrl(),
      webUrl: showWeb ? webUrl() : '',
      installing: installing,
      needsRestart: needsRestart(),
      lastError: lastError,
      stateDir: STATE_DIR,
      bin: BIN,
      logTail: tail.slice(-200).join('\n').slice(-LOG_TAIL_CHARS),
      settings: Object.assign({}, settings),
    };
  }

  function subscribe(emit) {
    listeners.add(emit);
    return function () { listeners.delete(emit); };
  }

  function setSettings(next) {
    settings = settingsLib.normalizeSettings(next);
    try {
      settingsLib.saveSettings(SETTINGS_FILE, settings);
    } catch (err) {
      log('设置写盘失败: ' + (err && err.message ? err.message : String(err)));
    }
    log('设置已更新：启动方式 ' + settings.startMode + '，网关端口 ' + settings.gatewayPort + '，网页版端口 ' + settings.webPort + '，代理 ' + settings.proxyMode + (settings.proxy ? ' ' + settings.proxy : ''));
    const restarted = restartIfOwned();
    publish();
    return { settings: Object.assign({}, settings), restarted: restarted };
  }

  function dispose() {
    disposed = true;
    listeners.clear();
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (publishTimer) {
      clearTimeout(publishTimer);
      publishTimer = null;
    }
    if (child && childAlive) {
      try {
        child.kill('SIGTERM');
      } catch (e) {
        // 已经退出
      }
    }
    child = null;
    childAlive = false;
    drainingProc = null;
  }

  function pickRelevant(source) {
    const out = {};
    RELEVANT.forEach(function (key) { out[key] = source[key]; });
    return out;
  }

  return {
    BIN: BIN,
    STATE_DIR: STATE_DIR,
    SETTINGS_FILE: SETTINGS_FILE,
    LINK_PATH: LINK_PATH,
    LOG_FILE: LOG_FILE,
    HOST: HOST,
    get settings() { return Object.assign({}, settings); },
    get disposed() { return disposed; },
    ensureInstalled: ensureInstalled,
    start: start,
    startWhenFree: startWhenFree,
    stop: stop,
    refresh: refresh,
    snapshot: snapshot,
    checkStatus: checkStatus,
    subscribe: subscribe,
    publish: publish,
    setSettings: setSettings,
    plan: plan,
    diag: diag,
    nodeInstall: nodeInstall,
    dispose: dispose,
    ensureCliOnPath: ensureCliOnPath,
    magpieWorks: magpieWorks,
    log: log,
  };
}

module.exports = {
  INSTALLER_URL: INSTALLER_URL,
  DEFAULT_LINK_PATH: DEFAULT_LINK_PATH,
  STALE_LOCK_MS: STALE_LOCK_MS,
  parseAddr: parseAddr,
  proxyEndpoint: proxyEndpoint,
  probePort: probePort,
  keyFromText: keyFromText,
  splitLogChunk: splitLogChunk,
  isLockStale: isLockStale,
  detectShell: detectShell,
  createController: createController,
};
