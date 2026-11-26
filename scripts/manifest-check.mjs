#!/usr/bin/env node
/**
 * 按 Nox App 的真实清单解析器（app/.../domain/PluginManifestParser.kt + 内置技能 nox-plugin-dev）
 * 校验 plugin.json。这里只做静态结构校验，不读包内其它文件、不执行代码。
 *
 * 和商店 docs/plugin-dev.md 的差异：App 用的是 manifestVersion + engines.pluginApi，
 * 不认 schema_version / api_version / min_app_version / homepage。以 App 为准。
 */
import fs from 'node:fs';
import path from 'node:path';

const TOP_LEVEL_KEYS = new Set([
  'manifestVersion', 'id', 'name', 'version', 'publisher', 'repository',
  'description', 'license', 'engines', 'runtime', 'contributes', 'configPage', 'icon',
]);
const ENGINE_KEYS = new Set(['pluginApi']);
const RUNTIME_KEYS = new Set(['type', 'entry', 'command', 'dependencies', 'resident']);
const DEP_KEYS = new Set(['tool', 'file']);
const CONTRIBUTION_KEYS = new Set(['id', 'file']);
const TOOL_KEYS = new Set(['id', 'title', 'description', 'inputSchema', 'handler']);
const HOOK_KEYS = new Set(['id', 'event', 'handler', 'mode']);
const UI_ENTRY_KEYS = new Set(['id', 'slot', 'title', 'page', 'handler', 'confirm', 'icon']);
const SCREEN_KEYS = new Set(['id', 'title', 'target', 'icon', 'file', 'handler']);
const WORKSPACE_TOOL_KEYS = new Set(['id', 'title', 'description', 'icon', 'category', 'pageFile']);
const PROVIDER_KEYS = new Set(['id', 'name', 'description', 'format', 'baseUrl']);
const CONTRIB_KEYS = new Set([
  'skills', 'agents', 'workspaceTools', 'uiEntries', 'screens', 'styleTokens', 'tools', 'hooks',
  'mcp', 'providers', 'shizuku', 'overlay', 'backup', 'modelAccess', 'configPage',
]);
const RUNTIME_TYPES = new Set(['javascript', 'python']);
const UI_SLOTS = new Set([
  'settings.general', 'settings.ai', 'settings.environment', 'settings.permissions', 'settings.data',
  'settings.help', 'drawer.footer', 'chat.header.menu', 'chat.welcome', 'chat.session.menu',
  'files.tree.menu', 'editor.selection.menu', 'backup.data',
]);
const ACTION_ONLY_SLOTS = new Set(['files.tree.menu', 'editor.selection.menu']);
const DATA_ONLY_SLOTS = new Set(['backup.data']);
const HOOK_EVENTS = new Set([
  'app.started', 'agent.run.started', 'agent.run.finished', 'agent.request.started', 'agent.request.finished',
  'agent.tool.started', 'agent.tool.finished', 'agent.compaction', 'agent.tool.before', 'agent.tool.after',
  'agent.http.before', 'agent.permission.review', 'plugin.installed', 'plugin.uninstalled',
  'plugin.enabled', 'plugin.disabled', 'backup.export.before', 'backup.import.finished',
]);
const TRANSFORM_EVENTS = new Set(['agent.tool.before', 'agent.tool.after', 'agent.http.before']);
const REVIEW_EVENTS = new Set(['agent.permission.review']);
const HOOK_MODES = new Set(['observe', 'transform', 'review']);
const PROVIDER_FORMATS = new Set(['openai']);

const MAX_NAME = 80;
const MAX_DESCRIPTION = 600;
const MAX_LICENSE = 100;
const MAX_REPOSITORY = 300;
const MAX_LOCALES = 16;
const MAX_IDS_PER_TYPE = 64;
const MAX_UI_ENTRIES = 2;
const MAX_PATH_LENGTH = 200;
const MAX_PATH_DEPTH = 8;
const MAX_PROVIDER_URL = 2048;
const MAX_WORKSPACE_ICON = 32;
const MAX_WORKSPACE_CATEGORY = 32;

const PLUGIN_ID = /^[\p{L}][\p{L}\p{N}_-]{0,31}\.[\p{L}][\p{L}\p{N}_-]{0,31}$/u;
const PUBLISHER = /^[\p{L}][\p{L}\p{N}_-]{0,31}$/u;
const LOCAL_ID = /^[\p{L}][\p{L}\p{N}_-]{0,63}$/u;
const HANDLER_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const BUILTIN_ICON = /^[a-z][a-z0-9-]{0,31}$/;
const LANGUAGE_TAG = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RANGE = /^\^?\d+(\.\d+)?(\.\d+)?$/;

const errors = [];
function err(code, detail) { errors.push({ code, detail }); }

const hasControl = (text, allowNewlines = false) =>
  [...text].some((ch) => {
    const code = ch.codePointAt(0);
    if (allowNewlines && ch === '\n') return false;
    return code < 0x20 || code === 0x7f;
  });

function safePath(value) {
  if (typeof value !== 'string' || value === '' || value.length > MAX_PATH_LENGTH) return false;
  if (value.startsWith('/') || value.includes('\\') || hasControl(value)) return false;
  const segments = value.split('/');
  if (segments.length > MAX_PATH_DEPTH) return false;
  return segments.every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function localized(value, where, maxLength, allowNewlines = false) {
  if (typeof value === 'string') {
    if (value.trim() === '' || value.length > maxLength || hasControl(value, allowNewlines)) {
      err('FIELD_INVALID', where);
      return null;
    }
    return true;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    err('FIELD_INVALID', where);
    return null;
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > MAX_LOCALES) {
    err('FIELD_INVALID', where);
    return null;
  }
  const seen = new Set();
  for (const tag of keys) {
    const normalized = tag.toLowerCase().replace('_', '-');
    const okTag = normalized === 'default' || LANGUAGE_TAG.test(normalized);
    const text = value[tag];
    if (!okTag || typeof text !== 'string' || text.trim() === '' || text.length > maxLength ||
        hasControl(text, allowNewlines) || seen.has(normalized)) {
      err('FIELD_INVALID', `${where}.${tag}`);
      return null;
    }
    seen.add(normalized);
  }
  return true;
}

function keysOf(obj, allowed, where) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) err('UNSUPPORTED_FIELD', `${where}${where ? '.' : ''}${key}`);
  }
}

export function checkManifest(manifest, pkgDir) {
  if (!manifest || typeof manifest !== 'object') {
    err('MANIFEST_NOT_JSON', 'root');
    return errors;
  }
  keysOf(manifest, TOP_LEVEL_KEYS, '');

  if (manifest.manifestVersion === undefined) err('FIELD_MISSING', 'manifestVersion');
  else if (typeof manifest.manifestVersion !== 'number' || manifest.manifestVersion !== 1) {
    err('FIELD_INVALID', 'manifestVersion');
  }

  const id = manifest.id;
  if (id === undefined) err('FIELD_MISSING', 'id');
  else if (typeof id !== 'string' || !PLUGIN_ID.test(id)) err('FIELD_INVALID', 'id');

  for (const [key, max, nl] of [['name', MAX_NAME, false], ['description', MAX_DESCRIPTION, true]]) {
    if (manifest[key] === undefined) err('FIELD_MISSING', key);
    else localized(manifest[key], key, max, nl);
  }

  if (manifest.version === undefined) err('FIELD_MISSING', 'version');
  else if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) err('FIELD_INVALID', 'version');

  if (manifest.publisher === undefined) err('FIELD_MISSING', 'publisher');
  else if (typeof manifest.publisher !== 'string' || !PUBLISHER.test(manifest.publisher)) err('FIELD_INVALID', 'publisher');
  else if (typeof id === 'string' && id.includes('.') && id.split('.')[0] !== manifest.publisher) {
    err('FIELD_INVALID', 'publisher');
  }

  if (manifest.repository === undefined) err('FIELD_MISSING', 'repository');
  else {
    let ok = false;
    try {
      const url = new URL(manifest.repository);
      ok = url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.search && !url.hash &&
        url.pathname.replace(/^\/+|\/+$/g, '') !== '' && String(manifest.repository).length <= MAX_REPOSITORY;
    } catch { ok = false; }
    if (!ok) err('FIELD_INVALID', 'repository');
  }

  if (manifest.license === undefined) err('FIELD_MISSING', 'license');
  else if (typeof manifest.license !== 'string' || manifest.license.trim() === '' ||
    manifest.license.length > MAX_LICENSE || hasControl(manifest.license)) err('FIELD_INVALID', 'license');

  // engines
  if (manifest.engines === undefined) err('FIELD_MISSING', 'engines');
  else if (!manifest.engines || typeof manifest.engines !== 'object') err('FIELD_INVALID', 'engines');
  else {
    keysOf(manifest.engines, ENGINE_KEYS, 'engines');
    const range = manifest.engines.pluginApi;
    if (range === undefined) err('FIELD_MISSING', 'engines.pluginApi');
    else if (typeof range !== 'string' || !RANGE.test(range.trim())) err('FIELD_INVALID', 'engines.pluginApi');
    else {
      // 只处理 ^1.0.0 / 1.x 这类常见写法：宿主 API 是 1.0.0
      const major = Number(range.replace(/^\^/, '').split('.')[0]);
      if (major !== 1) err('API_INCOMPATIBLE', range);
    }
  }

  // icon
  if (manifest.icon !== undefined) {
    const icon = manifest.icon;
    if (typeof icon !== 'string' || icon.trim() === '') err('FIELD_INVALID', 'icon');
    else if (/\.(png|webp)$/i.test(icon)) {
      if (!safePath(icon)) err('FIELD_INVALID', 'icon');
      else if (pkgDir && !fs.existsSync(path.join(pkgDir, icon))) err('FIELD_INVALID', `icon（包内没有 ${icon}）`);
    } else if (!BUILTIN_ICON.test(icon)) {
      err('FIELD_INVALID', `icon（只接受小写内置图标名或 .png/.webp 路径：${icon}）`);
    }
  }

  // runtime
  let runtime = null;
  if (manifest.runtime !== undefined) {
    const rt = manifest.runtime;
    if (!rt || typeof rt !== 'object' || Array.isArray(rt)) err('FIELD_INVALID', 'runtime');
    else {
      keysOf(rt, RUNTIME_KEYS, 'runtime');
      if (rt.type === undefined) err('FIELD_MISSING', 'runtime.type');
      else if (!RUNTIME_TYPES.has(rt.type)) err('UNSUPPORTED_CONTRIBUTION', 'runtime.type');
      if (rt.entry === undefined) err('FIELD_MISSING', 'runtime.entry');
      else if (!safePath(rt.entry)) err('FIELD_INVALID', 'runtime.entry');
      else if (rt.type === 'javascript' && !/\.(js|mjs|cjs)$/i.test(rt.entry)) err('FIELD_INVALID', 'runtime.entry');
      else if (rt.type === 'python' && !/\.py$/i.test(rt.entry)) err('FIELD_INVALID', 'runtime.entry');
      else if (pkgDir && !fs.existsSync(path.join(pkgDir, rt.entry))) err('FIELD_INVALID', `runtime.entry（包内没有 ${rt.entry}）`);
      if (rt.resident !== undefined && typeof rt.resident !== 'boolean') err('FIELD_INVALID', 'runtime.resident');
      if (rt.command !== undefined) {
        if (!Array.isArray(rt.command) || rt.command.length === 0 || rt.command.length > 16) err('FIELD_INVALID', 'runtime.command');
      }
      if (rt.dependencies !== undefined) {
        keysOf(rt.dependencies, DEP_KEYS, 'runtime.dependencies');
        if (!['npm', 'pip'].includes(rt.dependencies.tool)) err('UNSUPPORTED_CONTRIBUTION', 'runtime.dependencies.tool');
        if (!safePath(rt.dependencies.file || '')) err('FIELD_INVALID', 'runtime.dependencies.file');
      }
      runtime = rt;
    }
  }

  // contributes
  const contrib = manifest.contributes;
  if (contrib === undefined) err('FIELD_MISSING', 'contributes');
  else if (!contrib || typeof contrib !== 'object' || Array.isArray(contrib)) err('FIELD_INVALID', 'contributes');
  else {
    for (const key of Object.keys(contrib)) {
      if (!CONTRIB_KEYS.has(key)) err('UNSUPPORTED_CONTRIBUTION', key);
    }
    const list = (key) => {
      const value = contrib[key];
      if (value === undefined) return [];
      if (!Array.isArray(value)) { err('FIELD_INVALID', `contributes.${key}`); return []; }
      if (value.length > MAX_IDS_PER_TYPE) err('FIELD_INVALID', `contributes.${key}`);
      return value;
    };

    // tools
    const tools = list('tools');
    const toolIds = new Set();
    tools.forEach((tool, i) => {
      const at = `contributes.tools[${i}]`;
      if (!tool || typeof tool !== 'object') { err('FIELD_INVALID', at); return; }
      keysOf(tool, TOOL_KEYS, at);
      if (!LOCAL_ID.test(tool.id || '')) err('FIELD_INVALID', `${at}.id`);
      else if (toolIds.has(tool.id)) err('DUPLICATE_ID', tool.id);
      else toolIds.add(tool.id);
      if (tool.title === undefined) err('FIELD_MISSING', `${at}.title`);
      else localized(tool.title, `${at}.title`, MAX_NAME);
      if (tool.description !== undefined) localized(tool.description, `${at}.description`, MAX_DESCRIPTION);
      if (!safePath(tool.inputSchema || '') || !/\.json$/i.test(tool.inputSchema || '')) {
        err('FIELD_INVALID', `${at}.inputSchema`);
      } else if (pkgDir && !fs.existsSync(path.join(pkgDir, tool.inputSchema))) {
        err('FIELD_INVALID', `${at}.inputSchema（包内没有 ${tool.inputSchema}）`);
      }
      if (!HANDLER_NAME.test(tool.handler || '')) err('FIELD_INVALID', `${at}.handler`);
    });

    // hooks
    const hooks = list('hooks');
    const hookIds = new Set();
    hooks.forEach((hook, i) => {
      const at = `contributes.hooks[${i}]`;
      if (!hook || typeof hook !== 'object') { err('FIELD_INVALID', at); return; }
      keysOf(hook, HOOK_KEYS, at);
      if (!LOCAL_ID.test(hook.id || '')) err('FIELD_INVALID', `${at}.id`);
      else if (hookIds.has(hook.id)) err('DUPLICATE_ID', hook.id);
      else hookIds.add(hook.id);
      if (!HOOK_EVENTS.has(hook.event)) err('FIELD_INVALID', `${at}.event`);
      if (!HANDLER_NAME.test(hook.handler || '')) err('FIELD_INVALID', `${at}.handler`);
      const mode = hook.mode === undefined ? 'observe' : hook.mode;
      if (!HOOK_MODES.has(mode)) err('FIELD_INVALID', `${at}.mode`);
      const expected = TRANSFORM_EVENTS.has(hook.event) ? 'transform' : REVIEW_EVENTS.has(hook.event) ? 'review' : 'observe';
      if (HOOK_EVENTS.has(hook.event) && mode !== expected) err('FIELD_INVALID', `${at}.mode（${hook.event} 只能是 ${expected}）`);
    });

    // uiEntries
    const uiEntries = list('uiEntries');
    if (uiEntries.length > MAX_UI_ENTRIES) {
      err('FIELD_INVALID', `contributes.uiEntries（最多 ${MAX_UI_ENTRIES} 条，现在 ${uiEntries.length} 条）`);
    }
    const uiIds = new Set();
    uiEntries.forEach((entry, i) => {
      const at = `contributes.uiEntries[${i}]`;
      if (!entry || typeof entry !== 'object') { err('FIELD_INVALID', at); return; }
      keysOf(entry, UI_ENTRY_KEYS, at);
      if (!LOCAL_ID.test(entry.id || '')) err('FIELD_INVALID', `${at}.id`);
      else if (uiIds.has(entry.id)) err('DUPLICATE_ID', entry.id);
      else uiIds.add(entry.id);
      if (entry.title === undefined) err('FIELD_MISSING', `${at}.title`);
      else localized(entry.title, `${at}.title`, MAX_NAME);
      if (!UI_SLOTS.has(entry.slot)) err('FIELD_INVALID', `${at}.slot（${entry.slot}）`);
      if (entry.page !== undefined && (!safePath(entry.page) || !/\.html?$/i.test(entry.page))) {
        err('FIELD_INVALID', `${at}.page`);
      }
      if (entry.page !== undefined && pkgDir && !fs.existsSync(path.join(pkgDir, entry.page))) {
        err('FIELD_INVALID', `${at}.page（包内没有 ${entry.page}）`);
      }
      if (entry.handler !== undefined && !HANDLER_NAME.test(entry.handler)) err('FIELD_INVALID', `${at}.handler`);
      if ((entry.page === undefined) === (entry.handler === undefined)) err('FIELD_INVALID', `${at}（page 与 handler 只能二选一）`);
      if (entry.confirm !== undefined && typeof entry.confirm !== 'boolean') err('FIELD_INVALID', `${at}.confirm`);
      if (DATA_ONLY_SLOTS.has(entry.slot) && (entry.page !== undefined || entry.handler !== undefined)) {
        err('FIELD_INVALID', `${at}（backup.data 只接受数据选项）`);
      }
      if (ACTION_ONLY_SLOTS.has(entry.slot) && entry.page !== undefined) err('FIELD_INVALID', `${at}.page（该槽位只接受动作）`);
    });

    // workspaceTools
    const workspaceTools = list('workspaceTools');
    workspaceTools.forEach((tool, i) => {
      const at = `contributes.workspaceTools[${i}]`;
      if (!tool || typeof tool !== 'object') { err('FIELD_INVALID', at); return; }
      keysOf(tool, WORKSPACE_TOOL_KEYS, at);
      if (!LOCAL_ID.test(tool.id || '')) err('FIELD_INVALID', `${at}.id`);
      if (tool.title === undefined) err('FIELD_MISSING', `${at}.title`);
      else localized(tool.title, `${at}.title`, MAX_NAME);
      if (tool.description !== undefined) localized(tool.description, `${at}.description`, MAX_DESCRIPTION);
      for (const [key, max] of [['icon', MAX_WORKSPACE_ICON], ['category', MAX_WORKSPACE_CATEGORY]]) {
        if (tool[key] !== undefined && (typeof tool[key] !== 'string' || tool[key].trim() === '' ||
          tool[key].length > max || hasControl(tool[key]))) err('FIELD_INVALID', `${at}.${key}`);
      }
      if (!safePath(tool.pageFile || '') || !/\.html?$/i.test(tool.pageFile || '')) err('FIELD_INVALID', `${at}.pageFile`);
      else if (pkgDir && !fs.existsSync(path.join(pkgDir, tool.pageFile))) {
        err('FIELD_INVALID', `${at}.pageFile（包内没有 ${tool.pageFile}）`);
      }
    });

    // providers
    const providers = list('providers');
    const providerIds = new Set();
    providers.forEach((provider, i) => {
      const at = `contributes.providers[${i}]`;
      if (!provider || typeof provider !== 'object') { err('FIELD_INVALID', at); return; }
      keysOf(provider, PROVIDER_KEYS, at);
      if (!LOCAL_ID.test(provider.id || '')) err('FIELD_INVALID', `${at}.id`);
      else if (providerIds.has(provider.id)) err('DUPLICATE_ID', provider.id);
      else providerIds.add(provider.id);
      if (provider.name === undefined) err('FIELD_MISSING', `${at}.name`);
      else localized(provider.name, `${at}.name`, MAX_NAME);
      if (provider.description === undefined) err('FIELD_MISSING', `${at}.description`);
      else localized(provider.description, `${at}.description`, MAX_DESCRIPTION);
      if (!PROVIDER_FORMATS.has(provider.format)) err('FIELD_INVALID', `${at}.format`);
      let ok = false;
      try {
        const url = new URL(provider.baseUrl);
        ok = ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username &&
          !url.search && !url.hash && String(provider.baseUrl).length <= MAX_PROVIDER_URL;
      } catch { ok = false; }
      if (!ok) err('FIELD_INVALID', `${at}.baseUrl`);
    });

    // configPage
    const configPage = contrib.configPage === undefined ? manifest.configPage : contrib.configPage;
    if (configPage !== undefined) {
      if (typeof configPage !== 'string' || !safePath(configPage) || !/\.html?$/i.test(configPage)) {
        err('FIELD_INVALID', 'configPage（必须是包内 .html 路径字符串）');
      } else if (pkgDir && !fs.existsSync(path.join(pkgDir, configPage))) {
        err('FIELD_INVALID', `configPage（包内没有 ${configPage}）`);
      }
    }

    // 声明 tools/hooks 必须有 runtime
    const needsRuntime = tools.length > 0 || hooks.length > 0 ||
      uiEntries.some((entry) => entry && entry.handler !== undefined);
    if (needsRuntime && runtime === null) err('FIELD_MISSING', 'runtime');

    // takes 至少一项
    const anyContribution = ['skills', 'agents', 'workspaceTools', 'uiEntries', 'screens', 'tools', 'hooks',
      'mcp', 'providers'].some((key) => Array.isArray(contrib[key]) && contrib[key].length > 0) ||
      Boolean(contrib.styleTokens || contrib.shizuku || contrib.overlay || contrib.backup ||
        contrib.modelAccess || configPage);
    if (!anyContribution) err('FIELD_INVALID', 'contributes（至少要有一项真实贡献）');
  }

  return errors;
}

// 直接跑：node scripts/manifest-check.mjs [包目录]
if (process.argv[1] && process.argv[1].endsWith('manifest-check.mjs')) {
  const pkgDir = process.argv[2] || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'nox', 'magpie-gateway');
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'plugin.json'), 'utf8'));
  const found = checkManifest(manifest, pkgDir);
  if (found.length === 0) {
    console.log(`通过：${path.basename(pkgDir)}/plugin.json 符合 App 解析器（manifestVersion 1）`);
    process.exit(0);
  }
  for (const item of found) console.log(`× ${item.code} ${item.detail}`);
  console.log(`\n${found.length} 个错误`);
  process.exit(1);
}
