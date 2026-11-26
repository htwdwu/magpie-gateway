'use strict';
// 设置模型：端口冲突回退、代理地址与网页版 key 的规则都在这里。
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const DEFAULT_SETTINGS = Object.freeze({
  startMode: 'web',
  proxyMode: 'off',
  proxy: '',
  autoStart: true,
  gatewayPort: 3425,
  webPort: 3430,
  webKey: '',
});

const START_MODES = new Set(['serve', 'web']);
const PROXY_MODES = new Set(['off', 'fallback', 'always']);
const PROXY_RE = /^(?:https?|socks5h?):\/\/[^\s/]+/i;
const WEB_KEY_RE = /^[A-Za-z0-9._~-]{16,}$/;

function normalizeProxy(value) {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  if (text === '') return '';
  if (text.length > 200 || !PROXY_RE.test(text) || /\s/.test(text)) {
    throw new TypeError('代理地址要以 http://、https:// 或 socks5:// 开头');
  }
  return text;
}

function normalizePort(value, fallback) {
  const number = typeof value === 'number' ? value : Number(String(value === undefined || value === null ? '' : value).trim());
  if (!Number.isInteger(number) || number < 1 || number > 65535) return fallback;
  return number;
}

function normalizeWebKey(value) {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  if (text === '') return '';
  return WEB_KEY_RE.test(text) ? text : '';
}

function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const startMode = START_MODES.has(source.startMode) ? source.startMode : DEFAULT_SETTINGS.startMode;
  const proxyMode = PROXY_MODES.has(source.proxyMode) ? source.proxyMode : DEFAULT_SETTINGS.proxyMode;
  let proxy = DEFAULT_SETTINGS.proxy;
  try {
    proxy = normalizeProxy(source.proxy === undefined ? DEFAULT_SETTINGS.proxy : source.proxy);
  } catch (e) {
    proxy = DEFAULT_SETTINGS.proxy;
  }
  const autoStart = typeof source.autoStart === 'boolean' ? source.autoStart : DEFAULT_SETTINGS.autoStart;
  const gatewayPort = normalizePort(source.gatewayPort, DEFAULT_SETTINGS.gatewayPort);
  let webPort = normalizePort(source.webPort, DEFAULT_SETTINGS.webPort);
  if (webPort === gatewayPort) webPort = gatewayPort === DEFAULT_SETTINGS.webPort ? 3431 : DEFAULT_SETTINGS.webPort;
  const webKey = normalizeWebKey(source.webKey);
  return { startMode, proxyMode, proxy, autoStart, gatewayPort, webPort, webKey };
}

function validateSettings(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const gatewayPort = normalizePort(source.gatewayPort, NaN);
  const webPort = normalizePort(source.webPort, NaN);
  if (!Number.isInteger(gatewayPort)) throw new TypeError('网关端口要是 1–65535 的整数');
  if (!Number.isInteger(webPort)) throw new TypeError('网页版端口要是 1–65535 的整数');
  if (gatewayPort === webPort) throw new TypeError('网关端口和网页版端口不能相同');
  const proxy = normalizeProxy(source.proxy);
  if (source.proxyMode !== 'off' && proxy === '') throw new TypeError('选了代理却没填代理地址');
  const rawKey = String(source.webKey === undefined || source.webKey === null ? '' : source.webKey).trim();
  if (rawKey !== '' && !WEB_KEY_RE.test(rawKey)) throw new TypeError('网页版 key 至少 16 个字母、数字或 - . _ ~');
  return normalizeSettings(Object.assign({}, source, { proxy: proxy, webKey: rawKey }));
}

function loadSettings(file, logger) {
  try {
    return normalizeSettings(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    if (err && err.code !== 'ENOENT' && typeof logger === 'function') logger('读取设置失败，使用默认值: ' + (err.message || err));
    return normalizeSettings({});
  }
}

function saveSettings(file, settings) {
  const normalized = normalizeSettings(settings);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  return normalized;
}

module.exports = {
  DEFAULT_SETTINGS: DEFAULT_SETTINGS,
  START_MODES: START_MODES,
  PROXY_MODES: PROXY_MODES,
  normalizeProxy: normalizeProxy,
  normalizePort: normalizePort,
  normalizeWebKey: normalizeWebKey,
  normalizeSettings: normalizeSettings,
  validateSettings: validateSettings,
  loadSettings: loadSettings,
  saveSettings: saveSettings,
};
