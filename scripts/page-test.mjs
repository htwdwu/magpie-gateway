#!/usr/bin/env node
/**
 * 页面逻辑测试：不开浏览器，用一个最小 DOM 影子跑 pages/ui.js。
 * 元素 id / data-act / data-when 直接从真实的 panel.html 里读，避免测试和页面各写一份。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PKG = path.join(ROOT, 'nox', 'magpie-gateway');
const html = fs.readFileSync(path.join(PKG, 'pages', 'panel.html'), 'utf8');
const uiCode = fs.readFileSync(path.join(PKG, 'pages', 'ui.js'), 'utf8');

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });

// ---------- 最小 DOM ----------
function makeElement(id) {
  return {
    id,
    textContent: '',
    value: '',
    checked: false,
    className: '',
    disabled: false,
    style: { display: '' },
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 200,
    attrs: {},
    listeners: {},
    getAttribute(name) { return this.attrs[name] === undefined ? null : this.attrs[name]; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    dispatch(type, event) { (this.listeners[type] || []).forEach((fn) => fn(event || { target: this, preventDefault() {} })); },
  };
}

const elements = new Map();
for (const m of html.matchAll(/<(\w+)([^>]*\bid="([A-Za-z0-9_-]+)"[^>]*)>/g)) {
  const node = makeElement(m[3]);
  for (const a of m[2].matchAll(/([a-z-]+)="([^"]*)"/g)) node.attrs[a[1]] = a[2];
  // 真实 DOM 里 class 会落到 className 上，影子也要照做
  if (node.attrs.class) node.className = node.attrs.class;
  if (m[1] === 'select') node.value = (html.match(new RegExp(`<select[^>]*id="${m[3]}"[\\s\\S]*?</select>`)) || [''])[0].match(/value="([^"]+)"/)?.[1] || '';
  elements.set(m[3], node);
}

const buttons = [];
for (const m of html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)) {
  // 按钮里可能嵌着 svg 图标，取文本时把标签剥掉
  const label = m[2].replace(/<[^>]+>/g, '').trim();
  const node = makeElement('btn-' + (label || m[1].match(/data-act="([a-z-]+)"/)?.[1] || ''));
  node.label = label;
  for (const a of m[1].matchAll(/([a-z-]+)="([^"]*)"/g)) node.attrs[a[1]] = a[2];
  buttons.push(node);
}
// 有的动作挂在整行（div[data-act]）上，不只按钮；两类都收进来，按动作去重
for (const m of html.matchAll(/<(\w+)([^>]*\bdata-act="([a-z-]+)"[^>]*)>/g)) {
  if (m[1] === 'button') continue;
  if (buttons.some((b) => b.attrs['data-act'] === m[3])) continue;
  const node = makeElement('row-' + m[3]);
  for (const a of m[2].matchAll(/([a-z-]+)="([^"]*)"/g)) node.attrs[a[1]] = a[2];
  buttons.push(node);
}

const whenNodes = ['web', 'proxy'].map((k) => {
  const node = makeElement('when-' + k);
  node.attrs['data-when'] = k;
  return node;
});

let clickListener = null;
const document = {
  getElementById(id) { return elements.get(id) || null; },
  querySelectorAll(selector) {
    const attr = selector.replace(/^\[|\]$/g, '');
    const [name, rawValue] = attr.split('=');
    const wanted = rawValue ? rawValue.replace(/^"|"$/g, '') : null;
    const pool = [
      ...buttons,
      ...whenNodes,
      ...[...elements.values()].filter((node) => node.attrs && Object.keys(node.attrs).length),
    ];
    return pool.filter((node) => node.attrs && node.attrs[name] !== undefined && (wanted === null || node.attrs[name] === wanted));
  },
  querySelector(selector) { return document.querySelectorAll(selector)[0] || null; },
  addEventListener(type, fn) { if (type === 'click') clickListener = fn; },
};

const calls = [];
const clipboard = [];
const bashCalls = [];
const toasts = [];
const opened = [];
const inApp = [];

const stateBase = {
  platformOk: true, shellOk: true, installed: true, version: 'magpie 0.1.4841', running: false, owned: false,
  mode: 'web', gatewayPort: 3425, webPort: 3430, webKeySet: true, webKeyEphemeral: false,
  canStart: true, canStop: false, gatewayUrl: 'http://127.0.0.1:3425', webUrl: 'http://127.0.0.1:3430/?k=abcdefghijklmnop1234',
  installing: false, needsRestart: false, lastError: '', logTail: 'line-1\nline-2',
  settings: { startMode: 'web', proxyMode: 'off', proxy: '', autoStart: true, gatewayPort: 3425, webPort: 3430, webKey: '' },
};

let nextState = { ...stateBase };

const api = {
  invoke(handler, args) {
    calls.push({ handler, args });
    const reply = (value) => Promise.resolve(value);
    if (handler === 'ui.state') return reply({ ...nextState });
    if (handler === 'ui.saveSettings') {
      nextState = { ...nextState, settings: { ...nextState.settings, ...args.settings } };
      return reply({ ok: true, message: '设置已保存', state: { ...nextState } });
    }
    if (handler === 'ui.plan') return reply({ ok: true, plan: { commands: ['cmd-a', 'cmd-b'] }, state: { ...nextState } });
    if (handler === 'ui.report') return reply({ ok: true, state: { ...nextState } });
    if (handler === 'ui.start') return reply({ ok: true, message: '已启动网关和网页版', state: { ...nextState, running: true, owned: true } });
    if (handler === 'ui.stop') return reply({ ok: true, message: '已停止', state: { ...nextState, running: false, owned: false } });
    if (handler === 'ui.check') return reply({ ok: true, message: '状态已写入日志', state: { ...nextState } });
    if (handler === 'ui.install') return reply({ ok: true, message: '开始重装 magpie', state: { ...nextState } });
    if (handler === 'ui.diag') {
      return reply({
        ok: true,
        text: '平台 linux/arm64\nshell 可用\n网络 usemagpie.ai:443 不通',
        env: { logTail: 'diag-tail' },
      });
    }
    return reply({ ok: true, state: { ...nextState } });
  },
  toast(text) { toasts.push(String(text)); },
  clipboard: { write(text) { clipboard.push(String(text)); return Promise.resolve(); } },
  bash(cmd) { bashCalls.push(String(cmd)); return Promise.resolve('ok'); },
  ui: { openUrl(url) { opened.push(String(url)); return Promise.resolve(); } },
  webview: { login(params) { inApp.push(params); return Promise.resolve({ finalUrl: params.url, cookies: {} }); } },
};

// 桥的全局名从真实页面里取（/__<name>/<name>.js），换名字也不用改测试。
const bridgeName = (html.match(/src="\/__([A-Za-z]+)\/\1\.js"/) || [])[1] || 'Nox';

const sandbox = {
  document,
  window: {},
  console,
  setInterval: () => 1,
  clearInterval: () => {},
  Promise,
  JSON,
  String,
  Number,
  Boolean,
  Error,
  Array,
  Object,
};
sandbox[bridgeName] = api;
sandbox.window.document = document;
sandbox.window[bridgeName] = api;
vm.createContext(sandbox);
vm.runInContext(uiCode, sandbox);

const UI = sandbox.window.MagpieUI;

function clickAct(act) {
  const node = buttons.find((b) => b.attrs['data-act'] === act);
  if (!node) throw new Error('页面上没有 data-act=' + act);
  clickListener({ target: node, preventDefault() {} });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  check('ui.js 挂出 MagpieUI', UI && typeof UI.mount === 'function', '');

  await UI.mount();
  await wait(20);

  check('状态文案来自状态机', elements.get('status').textContent === '已安装，未运行', elements.get('status').textContent);
  check('版本与地址渲染出来', elements.get('version').textContent === 'magpie 0.1.4841' && elements.get('gatewayUrl').textContent === '127.0.0.1:3425', '');
  check('日志灌进 pre', elements.get('log').textContent.includes('line-1'), elements.get('log').textContent);
  check('网页版行在有 key 时显示', elements.get('webRow').style.display === '', elements.get('webRow').style.display);
  check('表单填上当前设置', elements.get('startMode').value === 'web' && elements.get('gatewayPort').value === '3425', '');
  check('web 模式下网页版端口可见', whenNodes[0].style.display === '', whenNodes[0].style.display);
  check('代理关时隐藏代理地址', whenNodes[1].style.display === 'none', whenNodes[1].style.display);
  check('没在跑时圆点是灰的', elements.get('dot').className === 'dot', elements.get('dot').className);
  check('刚打开时保存按钮是禁用的', document.querySelector('[data-act="act-save"]').disabled === true, String(document.querySelector('[data-act="act-save"]').disabled));

  nextState = { ...stateBase, running: true, owned: true, canStart: false, canStop: true };
  await UI.poll();
  await wait(20);
  check('运行中状态翻成「本插件启动」', elements.get('status').textContent === '运行中（本插件启动）', elements.get('status').textContent);
  check('运行中圆点变绿', elements.get('dot').className === 'dot on', elements.get('dot').className);

  nextState = { ...nextState, webUrl: '' };
  await UI.poll();
  await wait(20);
  check('不是网页版时隐藏网页版行', elements.get('webRow').style.display === 'none', elements.get('webRow').style.display);
  nextState = { ...nextState, webUrl: stateBase.webUrl };
  await UI.poll();
  await wait(20);

  clickAct('act-copy-gateway');
  await wait(20);
  check('复制网关地址走 clipboard', clipboard.includes('http://127.0.0.1:3425'), clipboard.join(','));
  check('复制后给提示', toasts.some((t) => /已复制/.test(t)), toasts.join(','));

  clickAct('act-copy-web');
  await wait(20);
  check('复制网页版地址带 key', clipboard.some((c) => c.includes('?k=abcdefghijklmnop1234')), clipboard.join(','));

  clickAct('act-open-gateway');
  await wait(20);
  check('打开网关走 App 内置浏览器', inApp.length > 0 && inApp[inApp.length - 1].url === 'http://127.0.0.1:3425', JSON.stringify(inApp[inApp.length - 1] || null));
  check('内置浏览器带关闭按钮与标题', inApp.length > 0 && inApp[inApp.length - 1].showClose === true && inApp[inApp.length - 1].title === 'Magpie 网关', '');
  check('没有跳外部浏览器', !opened.includes('http://127.0.0.1:3425'), opened.join(','));
  clickAct('act-open-web');
  await wait(20);
  check('打开网页版也走内置浏览器且带 key', inApp.some((c) => String(c.url).includes('?k=')), '');

  elements.get('proxyMode').value = 'always';
  elements.get('proxyMode').dispatch('change');
  check('切到代理后代理地址显出来', whenNodes[1].style.display === '', whenNodes[1].style.display);
  elements.get('proxyMode').value = 'off';
  elements.get('proxyMode').dispatch('change');

  elements.get('startMode').value = 'serve';
  elements.get('startMode').dispatch('change');
  check('切到 serve 后藏起网页版字段', whenNodes[0].style.display === 'none', whenNodes[0].style.display);
  elements.get('startMode').value = 'web';
  elements.get('startMode').dispatch('change');

  elements.get('gatewayPort').value = '3999';
  elements.get('gatewayPort').dispatch('input');
  check('改了输入后保存按钮可用', document.querySelector('[data-act="act-save"]').disabled === false, '');
  elements.get('webPort').value = '3998';
  elements.get('autoStart').value = '0';
  calls.length = 0;
  clickAct('act-save');
  await wait(40);
  const saveCall = calls.find((c) => c.handler === 'ui.saveSettings');
  check('保存把表单值送出去', saveCall && saveCall.args.settings.gatewayPort === 3999 && saveCall.args.settings.webPort === 3998, JSON.stringify(saveCall && saveCall.args.settings));
  check('autoStart 下拉读成布尔', saveCall && saveCall.args.settings.autoStart === false, String(saveCall && saveCall.args.settings.autoStart));
  check('保存后有提示', toasts.some((t) => /设置已保存|已重启|已保存/.test(t)), toasts.join(','));

  clickAct('act-start');
  await wait(40);
  check('启动按钮打 ui.start', calls.some((c) => c.handler === 'ui.start'), calls.map((c) => c.handler).join(','));
  clickAct('act-stop');
  await wait(40);
  check('停止按钮打 ui.stop', calls.some((c) => c.handler === 'ui.stop'), '');
  clickAct('act-install');
  await wait(40);
  const installCall = calls.find((c) => c.handler === 'ui.install');
  check('安装按钮带 force', installCall && installCall.args.force === true, '');

  // 环境自检 / 看日志 / 复制日志
  calls.length = 0;
  clickAct('act-diag');
  await wait(60);
  check('自检按钮打 ui.diag', calls.some((c) => c.handler === 'ui.diag'), calls.map((c) => c.handler).join(','));
  check('自检结果写进日志区', /环境自检/.test(elements.get('log').textContent) && /usemagpie/.test(elements.get('log').textContent),
    elements.get('log').textContent.slice(0, 60));
  clipboard.length = 0;
  const logBox = elements.get('log');
  check('日志默认收起', String(logBox.className).includes('collapsed'), logBox.className);
  clickAct('act-toggle-log');
  await wait(20);
  check('点展开后日志不再收起', !String(logBox.className).includes('collapsed'), logBox.className);
  check('展开按钮文案变化', elements.get('logToggle').textContent === '收起', elements.get('logToggle').textContent);
  clickAct('act-toggle-log');
  await wait(20);
  check('再点一次收回去', String(logBox.className).includes('collapsed'), logBox.className);

  clickAct('act-copy-log');
  await wait(40);
  check('复制日志拿到自检文本', clipboard.some((c) => c.includes('平台 linux/arm64')), clipboard.join('|').slice(0, 40));
  clickAct('act-log');
  await wait(40);
  check('看日志切回实时日志', /line-1/.test(elements.get('log').textContent), elements.get('log').textContent.slice(0, 40));

  // 老宿主没有内置浏览器时要退回外部打开，并给一句提示
  {
    const keep = api.webview;
    delete api.webview;
    opened.length = 0;
    const via = await UI.openInApp('http://127.0.0.1:3425', 'Magpie 网关');
    check('没有内置浏览器时退回外部打开', via === 'external' && opened.includes('http://127.0.0.1:3425'), via);
    check('退外部时提示一次', toasts.some((t) => /没有内置浏览器/.test(t)), toasts.join(','));
    api.webview = keep;
  }

  nextState = { ...stateBase, shellOk: false };
  await UI.poll();
  await wait(20);
  check('没有 shell 时露出终端兜底', elements.get('shellHint').style.display === '', elements.get('shellHint').style.display);
  check('没有 shell 时提示走终端', /没有 shell/.test(elements.get('notice').textContent), elements.get('notice').textContent);

  bashCalls.length = 0;
  calls.length = 0;
  clickAct('act-term-install');
  await wait(60);
  check('终端兜底先问 plan 再逐条 bash', bashCalls.join(',') === 'cmd-a,cmd-b', bashCalls.join(','));
  check('终端执行完回报 ui.report', calls.some((c) => c.handler === 'ui.report' && c.args.ok === true), calls.map((c) => c.handler).join(','));

  nextState = { ...stateBase, lastError: 'magpie 安装失败，检查网络或代理设置', needsRestart: true, webKeyEphemeral: true };
  await UI.poll();
  await wait(20);
  const notice = elements.get('notice').textContent;
  check('错误 / 待重启 / 临时 key 都进提示', /安装失败/.test(notice) && /重启网关后生效/.test(notice) && /重新复制网页版地址/.test(notice), notice);
  nextState = { ...nextState, settings: { ...nextState.settings, gatewayPort: 4000 } };
  await UI.poll();
  await wait(20);
  check('改了网关端口会提醒供应商入口对不上', /供应商/.test(elements.get('notice').textContent), elements.get('notice').textContent);
} catch (error) {
  check('测试执行未抛错', false, error && error.stack ? error.stack.split('\n')[0] : error.message);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '×'} ${r.name}${r.ok || r.detail === '' ? '' : '  — ' + r.detail}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
