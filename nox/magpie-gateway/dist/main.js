#!/usr/bin/env node
'use strict';
/**
 * Nox 插件运行时入口（JSON-RPC over stdin/stdout）。
 * 协议要点（docs/plugin-dev.md 3.2）：宿主发来的 method 只有 tool.invoke / hook.invoke / ui.invoke，
 * 真正的 handler 名在 params.handler，参数在 params.args。
 */
const readline = require('node:readline');
const path = require('node:path');
const settingsLib = require('./settings.cjs');
const core = require('./core.cjs');

const PLUGIN_ID = 'magpie.gateway';
// 设置放哪儿：宿主给了插件数据目录就用它；否则放 magpie 的 state 目录（HOME 下，可写、
// 且不随插件升级被替换——包目录在覆盖安装时会被整个换掉）。
const os = require('node:os');
const STATE_HOME = process.env.MAGPIE_STATE_DIR || path.join(os.homedir() || '/root', '.local/state/magpie');
const SETTINGS_FILE = process.env.NOX_PLUGIN_DATA
  ? path.join(process.env.NOX_PLUGIN_DATA, 'settings.json')
  : path.join(STATE_HOME, 'settings.json');

const initial = settingsLib.loadSettings(SETTINGS_FILE, function (msg) { process.stderr.write('[magpie] ' + msg + '\n'); });

const controller = core.createController({
  settings: initial,
  settingsFile: SETTINGS_FILE,
  resetLog: true,
});

let lastLogLine = 0;

function state() {
  const snap = controller.snapshot();
  snap.pluginId = PLUGIN_ID;
  snap.providerBaseUrl = 'http://127.0.0.1:' + snap.settings.gatewayPort + '/v1';
  return snap;
}

/** 网页版没设固定 key 时，每次启动都会换一把：提示里要说清楚要去重新复制地址。 */
function withKeyHint(message) {
  const snap = controller.snapshot();
  if (snap.webKeyEphemeral && snap.running) return message + '，这次是新的 key，请重新复制网页版地址';
  return message;
}

function textOf(result) {
  return { text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) };
}

const handlers = {
  'tools.status': async function () {
    await controller.refresh();
    return textOf(state());
  },
  'tools.install': async function (args) {
    const ok = await controller.ensureInstalled({ force: Boolean(args && args.force) });
    await controller.refresh();
    return textOf({ ok: ok, message: ok ? 'magpie 已就绪' : state().lastError || '安装未完成', state: state() });
  },
  'tools.start': async function (args) {
    if (!controller.snapshot().installed) {
      const installed = await controller.ensureInstalled({});
      if (!installed) return textOf({ ok: false, message: 'magpie 还没装好，先安装', state: state() });
    }
    const result = await controller.startWhenFree({ mode: args && args.mode });
    await controller.refresh();
    return textOf({ ok: result.ok, message: withKeyHint(result.message), state: state() });
  },
  'tools.stop': async function () {
    const result = controller.stop();
    await controller.refresh();
    return textOf({ ok: result.ok, message: result.message, state: state() });
  },
  'tools.settings': async function (args) {
    const input = args || {};
    if (input.settings && typeof input.settings === 'object') {
      let next;
      try {
        next = settingsLib.validateSettings(Object.assign({}, controller.settings, input.settings));
      } catch (err) {
        return textOf({ ok: false, message: String(err && err.message ? err.message : err) });
      }
      const saved = controller.setSettings(next);
      await controller.refresh();
      return textOf({ ok: true, settings: saved.settings, restarted: saved.restarted, state: state() });
    }
    return textOf({ ok: true, settings: controller.settings, state: state() });
  },
  'tools.logs': async function (args) {
    const limit = Math.max(1, Math.min(400, Number(args && args.lines) || 120));
    const tail = String(state().logTail || '').split('\n').slice(-limit).join('\n');
    return { text: tail === '' ? '（暂无日志）' : tail };
  },
  'tools.diag': async function () {
    const env = await controller.diag();
    return textOf(env);
  },
  'tools.check': async function () {
    controller.checkStatus();
    await controller.refresh();
    return textOf(state());
  },

  'ui.state': async function () {
    await controller.refresh();
    return state();
  },
  'ui.saveSettings': async function (args) {
    const input = (args && args.settings) || {};
    let next;
    try {
      next = settingsLib.validateSettings(Object.assign({}, controller.settings, input));
    } catch (err) {
      return { ok: false, message: String(err && err.message ? err.message : err) };
    }
    const saved = controller.setSettings(next);
    await controller.refresh();
    return { ok: true, restarted: saved.restarted, message: saved.restarted ? '已保存，网关已重启' : '设置已保存', state: state() };
  },
  'ui.install': async function (args) {
    if (state().installing) return { ok: false, message: '正在安装，请稍候', state: state() };
    const force = Boolean(args && args.force);
    controller.ensureInstalled({ force: force }).catch(function (err) {
      controller.log('安装失败: ' + (err && err.message ? err.message : String(err)));
    });
    return { ok: true, message: force ? '开始重装 magpie' : '开始安装 magpie', state: state() };
  },
  'ui.start': async function (args) {
    const snap = state();
    if (!snap.installed) return { ok: false, message: '还没装好，先安装', state: snap };
    const result = await controller.startWhenFree({ mode: args && args.mode });
    return { ok: result.ok, message: withKeyHint(result.message), state: state() };
  },
  'ui.stop': async function () {
    const result = controller.stop();
    return { ok: result.ok, message: result.message, state: state() };
  },
  'ui.diag': async function () {
    const env = await controller.diag();
    const lines = [
      '平台 ' + env.platform + '/' + env.arch + ' · node ' + env.node,
      'HOME ' + env.home,
      'bin ' + env.bin + (env.binExists ? '（在，' + (env.binVersion || '版本未知') + '）' : '（不在）'),
      'shell ' + (env.shell.ok ? '可用' : '不可用：' + env.shell.reason),
      '工具 ' + Object.keys(env.tools).map(function (k) { return k + (env.tools[k] ? '✓' : '✗'); }).join(' '),
      'CA 包 ' + (env.ca && env.ca.found ? env.ca.found : '缺失（curl 会报 77）'),
      '证书环境 ' + (env.ca ? Object.keys(env.ca.env).filter(function (k) { return env.ca.env[k]; })
        .map(function (k) { return k + '=' + env.ca.env[k]; }).join(' ') || '未额外设置' : '未知'),
      '到更新源的 TLS ' + (env.tls === 'ok' ? '正常' : '失败：' + env.tls),
      '产物候选 ' + env.assets.join(' / '),
      '网络 ' + Object.keys(env.net).map(function (k) { return k + (env.net[k] ? ' 通' : ' 不通'); }).join(' · '),
      '代理 ' + (env.proxy || '未用'),
      '最近错误 ' + (env.lastError || '无'),
    ];
    return { ok: true, text: lines.join('\n'), env: env };
  },
  'ui.check': async function () {
    controller.checkStatus();
    await controller.refresh();
    return { ok: true, message: '状态已写入日志', state: state() };
  },
  'ui.plan': async function (args) {
    const name = String((args && args.name) || 'start');
    return { ok: true, plan: controller.plan(name), state: state() };
  },
  'ui.report': async function (args) {
    const input = args || {};
    const label = String(input.action || 'shell');
    controller.log('[终端] ' + label + '：' + String(input.detail || (input.ok ? '完成' : '失败')).slice(0, 300));
    await controller.refresh();
    return { ok: true, state: state() };
  },
  'ui.provider': async function () {
    const snap = state();
    return {
      ok: true,
      provider: { baseUrl: snap.providerBaseUrl, match: snap.settings.gatewayPort === 3425 },
      state: snap,
    };
  },

  'hooks.appStarted': async function () {
    controller.log('App 已启动');
    if (!controller.settings.autoStart) return {};
    if (!state().shellOk) {
      controller.log('插件进程没有 shell，自动启动交给面板');
      return {};
    }
    try {
      if (!(await controller.ensureInstalled({}))) return {};
      if (!controller.snapshot().running) await controller.startWhenFree();
    } catch (err) {
      controller.log('自动启动失败: ' + (err && err.message ? err.message : String(err)));
    }
    return {};
  },
};

const CALL_METHODS = ['tool.invoke', 'hook.invoke', 'ui.invoke'];

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id: id, result: result === undefined ? null : result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id: id, error: { code: code, message: message } });
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', function (line) {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch (err) {
    return;
  }
  if (request.id === undefined) return; // 单向通知，不用回
  const method = request.method;
  const params = request.params || {};
  if (CALL_METHODS.indexOf(method) < 0) {
    return fail(request.id, 'METHOD_UNKNOWN', String(method));
  }
  const handlerName = params.handler;
  const handler = handlers[handlerName];
  if (typeof handler !== 'function') {
    return fail(request.id, 'HANDLER_NOT_FOUND', String(handlerName));
  }
  Promise.resolve()
    .then(function () { return handler(params.args || {}); })
    .then(function (result) { reply(request.id, result); })
    .catch(function (error) {
      fail(request.id, 'PLUGIN_ERROR', String((error && error.message) || error));
    });
});

// 订阅控制器状态，把变化写进日志尾巴之外，也让 UI 轮询拿到的值足够新。
controller.subscribe(function () {
  const now = Date.now();
  if (now - lastLogLine < 1000) return;
  lastLogLine = now;
});

// 启动即接管：与上游 ctx.effect 里的 autoStart 等价。
setTimeout(async function () {
  if (!controller.settings.autoStart) return;
  const snap = controller.snapshot();
  if (!snap.shellOk) {
    controller.log('插件进程没有可用的 shell：安装和启动请从面板走终端');
    return;
  }
  try {
    const ok = await controller.ensureInstalled({});
    if (!ok) return;
    await controller.refresh();
    const snap2 = controller.snapshot();
    if (!snap2.running && snap2.canStart) await controller.startWhenFree();
  } catch (err) {
    controller.log('自动启动失败: ' + (err && err.message ? err.message : String(err)));
  }
}, 200);

process.on('uncaughtException', function (e) {
  process.stderr.write('uncaught: ' + (e && e.stack ? e.stack : e) + '\n');
});
process.on('unhandledRejection', function (e) {
  process.stderr.write('unhandled rejection: ' + e + '\n');
});
process.on('SIGTERM', function () {
  controller.dispose();
  process.exit(0);
});
process.on('SIGINT', function () {
  controller.dispose();
  process.exit(0);
});
