/* Magpie 网关页面公用逻辑：读状态、渲染、保存设置、终端兜底。
   桥是宿主注入的全局对象，用绝对路径引入；这里只做壳，不碰任何网络。 */
(function () {
  // 桥有两种挂法：历史上游的全局名，以及 window.nox；两个都试，避免页面能开但调用不通。
  var api = null;
  try {
    if (typeof aicode !== 'undefined' && aicode) api = aicode;
    else if (typeof window !== 'undefined' && window.nox) api = window.nox;
  } catch (e) {
    api = null;
  }

  var STATUS_ZH = {
    notInstalled: '未安装',
    installing: '正在安装…',
    runningOwned: '运行中（本插件启动）',
    runningExternal: '运行中（别处启动）',
    installedStopped: '已安装，未运行',
    noPlatform: '当前平台不支持',
    noShell: '已安装（插件进程无 shell）',
  };

  function invoke(handler, args) {
    if (!api || typeof api.invoke !== 'function') {
      return Promise.reject(new Error('页面桥没有加载'));
    }
    return api.invoke(handler, args || {});
  }

  function toast(text) {
    if (!text) return;
    if (api && typeof api.toast === 'function') api.toast(String(text));
  }

  function copy(text) {
    if (!text || !api) return Promise.resolve(false);
    var value = String(text);
    if (api.clipboard && typeof api.clipboard.write === 'function') {
      return Promise.resolve(api.clipboard.write(value)).then(function () { return true; }).catch(function () { return false; });
    }
    if (typeof api.call === 'function') {
      return Promise.resolve(api.call('clipboard.write', { text: value }))
        .then(function () { return true; })
        .catch(function () { return false; });
    }
    return Promise.resolve(false);
  }

  function openUrl(url) {
    if (!url || !api) return Promise.resolve();
    if (api.ui && typeof api.ui.openUrl === 'function') return Promise.resolve(api.ui.openUrl(String(url)));
    if (typeof api.call === 'function') return Promise.resolve(api.call('ui.openUrl', { url: String(url) })).catch(function () {});
    return Promise.resolve();
  }

  function statusLabel(state) {
    if (!state) return '—';
    if (!state.platformOk) return STATUS_ZH.noPlatform;
    if (!state.installed) return STATUS_ZH.notInstalled;
    if (state.installing) return STATUS_ZH.installing;
    if (state.running) return state.owned ? STATUS_ZH.runningOwned : STATUS_ZH.runningExternal;
    if (!state.shellOk) return STATUS_ZH.noShell;
    return STATUS_ZH.installedStopped;
  }

  function modeLabel(mode) {
    return mode === 'web' ? '网关 + 网页（magpie web）' : '仅网关（magpie serve）';
  }

  function notice(state) {
    var out = [];
    if (!state) return '';
    if (!state.shellOk) out.push('插件进程没有 shell：安装和启动请用下面的「用终端执行」按钮');
    if (state.lastError) out.push(state.lastError);
    if (state.needsRestart) out.push('启动方式或端口改过了，重启网关后生效');
    if (state.webKeyEphemeral) out.push('网页版没设固定 key：每次重启都会生成新 key，重启后请重新复制网页版地址');
    if (state.settings && state.settings.gatewayPort !== 3425) out.push('网关端口不是 3425，模型供应商入口（127.0.0.1:3425）会连不上，需要改回或自行改地址');
    return out.join('；');
  }

  function el(id) {
    return document.getElementById(id);
  }

  function setText(id, text) {
    var node = el(id);
    if (node) node.textContent = text === undefined || text === null || text === '' ? '—' : String(text);
  }

  function setBusy(busy) {
    var nodes = document.querySelectorAll('[data-busy]');
    for (var i = 0; i < nodes.length; i += 1) nodes[i].disabled = Boolean(busy);
  }

  /* ---------- 设置表单 ---------- */

  var draft = null;

  function fillForm(state) {
    if (!state || !state.settings) return;
    draft = state.settings;
    var s = state.settings;
    if (el('startMode')) el('startMode').value = s.startMode;
    if (el('proxyMode')) el('proxyMode').value = s.proxyMode;
    if (el('proxy')) el('proxy').value = s.proxy || '';
    if (el('autoStart')) el('autoStart').value = s.autoStart === false ? '0' : '1';
    if (el('gatewayPort')) el('gatewayPort').value = String(s.gatewayPort);
    if (el('webPort')) el('webPort').value = String(s.webPort);
    if (el('webKey')) el('webKey').value = s.webKey || '';
    applyVisibility();
  }

  function applyVisibility() {
    var webMode = el('startMode') && el('startMode').value === 'web';
    var useProxy = el('proxyMode') && el('proxyMode').value !== 'off';
    var webRows = document.querySelectorAll('[data-when="web"]');
    for (var i = 0; i < webRows.length; i += 1) webRows[i].style.display = webMode ? '' : 'none';
    var proxyRows = document.querySelectorAll('[data-when="proxy"]');
    for (var j = 0; j < proxyRows.length; j += 1) proxyRows[j].style.display = useProxy ? '' : 'none';
  }

  function readForm() {
    return {
      startMode: el('startMode') ? el('startMode').value : 'web',
      proxyMode: el('proxyMode') ? el('proxyMode').value : 'off',
      proxy: el('proxy') ? el('proxy').value.trim() : '',
      autoStart: el('autoStart') ? el('autoStart').value === '1' : true,
      gatewayPort: Number(el('gatewayPort') ? el('gatewayPort').value : 3425),
      webPort: Number(el('webPort') ? el('webPort').value : 3430),
      webKey: el('webKey') ? el('webKey').value.trim() : '',
    };
  }

  function save() {
    setBusy(true);
    return invoke('ui.saveSettings', { settings: readForm() }).then(function (result) {
      setBusy(false);
      toast(result && result.message ? result.message : '设置已保存');
      draft = null;
      if (result && result.state) render(result.state);
      return result;
    }).catch(function (err) {
      setBusy(false);
      toast(err && err.message ? err.message : '保存失败');
    });
  }

  /* ---------- 终端兜底 ---------- */

  function runInTerminal(name) {
    setBusy(true);
    return invoke('ui.plan', { name: name }).then(function (result) {
      var commands = result && result.plan ? result.plan.commands : [];
      if (!commands.length) throw new Error('没有可执行的命令');
      if (!api || typeof api.bash !== 'function') throw new Error('页面桥没有 bash');
      var chain = Promise.resolve('');
      commands.forEach(function (cmd) {
        chain = chain.then(function () { return api.bash(cmd); });
      });
      return chain.then(function (output) {
        toast('终端执行完成');
        return invoke('ui.report', {
          action: name,
          ok: true,
          detail: String(output || '').slice(-300),
        });
      });
    }).then(function (result) {
      setBusy(false);
      if (result && result.state) render(result.state);
    }).catch(function (err) {
      setBusy(false);
      toast(err && err.message ? String(err.message).slice(0, 40) : '终端执行失败');
      invoke('ui.report', { action: name, ok: false, detail: String(err && err.message ? err.message : err) }).catch(function () {});
    });
  }

  /* ---------- 动作 ---------- */

  function action(name, args) {
    setBusy(true);
    return invoke(name, args).then(function (result) {
      setBusy(false);
      if (result && result.message) toast(result.message);
      if (result && result.state) render(result.state);
      return result;
    }).catch(function (err) {
      setBusy(false);
      toast(err && err.message ? String(err.message).slice(0, 40) : '操作失败');
    });
  }

  var handlers = {
    'act-start': function () { return action('ui.start', {}); },
    'act-stop': function () { return action('ui.stop', {}); },
    'act-check': function () { return action('ui.check', {}); },
    'act-install': function () { return action('ui.install', { force: true }); },
    'act-save': function () { return save(); },
    'act-copy-gateway': function (state) {
      return copy(state ? state.gatewayUrl : '').then(function (ok) {
        toast(ok ? '已复制网关地址' : '复制失败');
      });
    },
    'act-copy-web': function (state) {
      if (!state || !state.webUrl) return Promise.resolve(toast('当前不是网页版模式'));
      return copy(state.webUrl).then(function (ok) {
        toast(ok ? '已复制网页版地址' : '复制失败');
      });
    },
    'act-open-gateway': function (state) {
      return openUrl(state ? state.gatewayUrl : '');
    },
    'act-open-web': function (state) {
      if (!state || !state.webUrl) return Promise.resolve(toast('当前不是网页版模式'));
      return openUrl(state.webUrl);
    },
    'act-term-install': function () { return runInTerminal('install'); },
    'act-term-start': function () { return runInTerminal('start'); },
    'act-term-stop': function () { return runInTerminal('stop'); },
    'act-log': function () {
      viewMode = 'log';
      if (lastState) render(lastState);
      return Promise.resolve();
    },
    'act-diag': function () {
      setBusy(true);
      return invoke('ui.diag').then(function (result) {
        setBusy(false);
        diagText = result && result.text ? String(result.text) : JSON.stringify(result, null, 2);
        viewMode = 'diag';
        showText('环境自检\n' + diagText + (result && result.env && result.env.logTail ? '\n\n最近日志\n' + result.env.logTail : ''));
        toast('自检完成');
      }).catch(function (err) {
        setBusy(false);
        toast(err && err.message ? String(err.message).slice(0, 40) : '自检失败');
      });
    },
    'act-copy-log': function () {
      var text = diagText && viewMode === 'diag' ? diagText : (lastState ? String(lastState.logTail || '') : '');
      if (!text) return Promise.resolve(toast('还没有日志'));
      return copy(text).then(function (ok) { toast(ok ? '日志已复制' : '复制失败'); });
    },
  };

  function render(state) {
    if (!state) return;
    lastState = state;
    setText('status', statusLabel(state));
    setText('version', state.version || '—');
    setText('mode', modeLabel(state.mode || (state.settings && state.settings.startMode)));
    setText('gatewayUrl', state.gatewayUrl || '—');
    var webLine = el('webRow');
    if (webLine) webLine.style.display = state.webUrl ? '' : 'none';
    setText('webUrl', state.webUrl || '—');
    setText('notice', notice(state));
    var dot = el('dot');
    if (dot) {
      dot.className = 'dot' + (state.running ? ' on' : state.installed ? '' : ' warn');
    }
    var logNode = viewMode === 'log' ? el('log') : null;
    if (logNode) {
      var text = String(state.logTail || '').trim();
      var atBottom = logNode.scrollTop + logNode.clientHeight >= logNode.scrollHeight - 24;
      logNode.textContent = text === '' ? '（暂无日志）' : text;
      if (atBottom) logNode.scrollTop = logNode.scrollHeight;
    }
    var shellHint = el('shellHint');
    if (shellHint) shellHint.style.display = state.shellOk ? 'none' : '';
    if (el('installState')) el('installState').style.display = state.installing ? '' : 'none';
    if (draft === null) fillForm(state);
  }

  var lastState = null;
  var timer = null;
  var viewMode = 'log';   // 'log' 看实时日志，'diag' 看环境自检结果
  var diagText = '';

  function showText(text) {
    var node = el('log');
    if (!node) return;
    node.textContent = String(text || '').trim() === '' ? '（暂无内容）' : String(text);
    node.scrollTop = 0;
  }

  function poll() {
    return invoke('ui.state').then(render).catch(function () {});
  }

  function mount() {
    if (!api) {
      // 桥没加载时别装作没事：把原因写在页面上，用户能看到是路径写错了还是宿主没注入。
      var banner = el('bridgeWarn');
      if (banner) {
        banner.style.display = '';
        banner.textContent = '页面桥没加载：检查 <script src="/__…/….js"> 是不是绝对路径。';
      }
      return Promise.resolve();
    }
    document.addEventListener('click', function (event) {
      var node = event.target;
      while (node && node !== document) {
        var key = node.getAttribute ? node.getAttribute('data-act') : null;
        if (key && handlers[key]) {
          event.preventDefault();
          handlers[key](lastState);
          return;
        }
        node = node.parentNode;
      }
    });
    ['startMode', 'proxyMode'].forEach(function (id) {
      if (el(id)) el(id).addEventListener('change', applyVisibility);
    });
    return poll().then(function () {
      if (timer) clearInterval(timer);
      timer = setInterval(poll, 2000);
    });
  }

  window.MagpieUI = {
    mount: mount,
    poll: poll,
    render: render,
    save: save,
    invoke: invoke,
    toast: toast,
    copy: copy,
    statusLabel: statusLabel,
    modeLabel: modeLabel,
    notice: notice,
    state: function () { return lastState; },
  };
})();
