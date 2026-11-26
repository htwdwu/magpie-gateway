'use strict';
/**
 * 只用 Node 内置模块的最小 HTTP(S) 客户端：跟随重定向、支持 http/https 代理（CONNECT 隧道）
 * 与 socks5（无认证或用户名密码），可限时、限量，返回 Buffer 与 sha256。
 *
 * 存在的理由：容器里不一定有 curl。magpie 的安装脚本靠 curl 下载，缺 curl 就整条路断掉；
 * 这里让"有 node 就能下"，把安装从「curl + sh + apt」降级成「只有 node」。
 */
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const UA = 'magpie-nox/1.0 (+node)';

/** 证书相关错误码：容器里没有 CA 包、或流量被中间人时会是这些。 */
const CERT_ERRORS = [
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT', 'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED',
];

function isCertError(error) {
  const code = String((error && error.code) || '');
  if (CERT_ERRORS.indexOf(code) >= 0) return true;
  return /certificate|self.signed|CERT_|issuer/i.test(String((error && error.message) || ''));
}

/** `http://h:8080`、`https://u:p@h`、`socks5://h:1080`、`socks5h://h:1080` */
function parseProxy(input) {
  if (!input) return null;
  let url;
  try {
    url = new URL(String(input));
  } catch (e) {
    return null;
  }
  const protocol = url.protocol.replace(':', '');
  const type = protocol === 'http' || protocol === 'https' ? protocol
    : protocol === 'socks5' || protocol === 'socks5h' ? 'socks5' : '';
  if (!type) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) return null;
  const port = Number(url.port) || (type === 'socks5' ? 1080 : type === 'https' ? 443 : 80);
  const auth = url.username
    ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password || '') }
    : null;
  return { type: type, host: host, port: port, auth: auth };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function socksConnect(proxy, host, port, timeout) {
  return new Promise(function (resolve, reject) {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    const fail = function (error) {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const timer = setTimeout(function () { fail(new Error('socks5 握手超时')); }, timeout);
    socket.setTimeout(timeout, function () { fail(new Error('socks5 握手超时')); });
    socket.once('error', fail);

    let step = 0;
    let buffer = Buffer.alloc(0);
    socket.on('connect', function () {
      const methods = proxy.auth ? [0x00, 0x02] : [0x00];
      socket.write(Buffer.from([0x05, methods.length].concat(methods)));
    });
    socket.on('data', function (chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (step === 0) {
        if (buffer.length < 2) return;
        const method = buffer[1];
        buffer = buffer.slice(2);
        if (method === 0xff) return fail(new Error('socks5 代理不接受我们的认证方式'));
        if (method === 0x02) {
          if (!proxy.auth) return fail(new Error('socks5 代理要求认证却没有凭据'));
          const user = Buffer.from(proxy.auth.user);
          const pass = Buffer.from(proxy.auth.pass);
          socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
          step = 1;
          return;
        }
        step = 2;
        sendConnect();
        return;
      }
      if (step === 1) {
        if (buffer.length < 2) return;
        if (buffer[1] !== 0x00) return fail(new Error('socks5 认证失败'));
        buffer = buffer.slice(2);
        step = 2;
        sendConnect();
        return;
      }
      if (step === 2) {
        if (buffer.length < 10) return;
        if (buffer[1] !== 0x00) return fail(new Error('socks5 连接被拒绝（code ' + buffer[1] + '）'));
        const atyp = buffer[3];
        let rest = 4;
        if (atyp === 0x01) rest += 4;
        else if (atyp === 0x04) rest += 16;
        else if (atyp === 0x03) rest += 1 + buffer[4];
        else return fail(new Error('socks5 应答格式不认识'));
        rest += 2;
        if (buffer.length < rest) return;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners('data');
        socket.removeAllListeners('error');
        socket.setTimeout(0);
        resolve(socket);
      }
    });

    function sendConnect() {
      const name = Buffer.from(host);
      socket.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
        name,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
      ]));
    }
  });
}

function httpConnect(proxy, host, port, timeout) {
  return new Promise(function (resolve, reject) {
    const headers = { Host: host + ':' + port };
    if (proxy.auth) {
      headers['Proxy-Authorization'] = 'Basic ' +
        Buffer.from(proxy.auth.user + ':' + proxy.auth.pass).toString('base64');
    }
    const request = (proxy.type === 'https' ? https : http).request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: host + ':' + port,
      headers: headers,
      timeout: timeout,
    });
    request.once('connect', function (response, socket) {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error('代理 CONNECT 失败：HTTP ' + response.statusCode));
        return;
      }
      resolve(socket);
    });
    request.once('timeout', function () { request.destroy(new Error('代理 CONNECT 超时')); });
    request.once('error', reject);
    request.end();
  });
}

/** 拿到一条通往 host:port 的 socket：直连、http(s) 代理隧道或 socks5。 */
async function connectThrough(proxy, host, port, timeout) {
  if (!proxy) return null;
  if (proxy.type === 'socks5') return socksConnect(proxy, host, port, timeout);
  return httpConnect(proxy, host, port, timeout);
}

/**
 * GET 一个地址，跟随重定向，返回 { status, headers, body, finalUrl }。
 * opts: { proxy, timeoutMs, maxBytes, redirects, headers }
 */
async function get(targetUrl, options) {
  const opts = options || {};
  const timeout = opts.timeoutMs === undefined ? 60000 : opts.timeoutMs;
  const maxBytes = opts.maxBytes === undefined ? 8 * 1024 * 1024 : opts.maxBytes;
  const redirects = opts.redirects === undefined ? 5 : opts.redirects;
  const proxy = typeof opts.proxy === 'string' ? parseProxy(opts.proxy) : opts.proxy || null;
  const insecureTls = opts.insecureTls === true;

  let url;
  try {
    url = new URL(targetUrl);
  } catch (e) {
    const error = new Error('地址不合法：' + targetUrl);
    error.code = 'BAD_URL';
    throw error;
  }
  const isHttps = url.protocol === 'https:';
  const port = Number(url.port) || (isHttps ? 443 : 80);
  const host = url.hostname.replace(/^\[|\]$/g, '');

  const result = await new Promise(function (resolve, reject) {
    let settled = false;
    const done = function (value) {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = function (error) {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const send = function (socketOrNull) {
      const base = isHttps
        ? {
          host: host,
          port: port,
          servername: net.isIP(host) ? undefined : host,
          path: url.pathname + url.search,
          headers: Object.assign({ Host: url.host, 'User-Agent': UA, Accept: '*/*' }, opts.headers || {}),
          agent: false,
          rejectUnauthorized: !insecureTls,
        }
        : {
          host: host,
          port: port,
          path: url.pathname + url.search,
          headers: Object.assign({ Host: url.host, 'User-Agent': UA, Accept: '*/*' }, opts.headers || {}),
        };
      if (socketOrNull) base.createConnection = function () { return socketOrNull; };
      const request = (isHttps ? https : http).request(base, function (response) {
        const status = response.statusCode || 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location && redirects > 0) {
          response.resume();
          done({ redirect: new URL(location, url).toString() });
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', function (chunk) {
          size += chunk.length;
          if (size > maxBytes) {
            fail(new Error('响应超过上限 ' + maxBytes + ' 字节'));
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', function () {
          done({
            status: status,
            headers: response.headers,
            body: Buffer.concat(chunks),
            finalUrl: url.toString(),
          });
        });
        response.on('error', fail);
      });
      request.setTimeout(timeout, function () { request.destroy(new Error('请求超时 ' + timeout + 'ms')); });
      request.once('error', fail);
      request.end();
    };

    // 走代理：https 目标要隧道，http 目标发绝对地址
    if (proxy && !isHttps) {
      const headers = Object.assign({ Host: url.host, 'User-Agent': UA, Accept: '*/*' }, opts.headers || {});
      if (proxy.auth) {
        headers['Proxy-Authorization'] = 'Basic ' +
          Buffer.from(proxy.auth.user + ':' + proxy.auth.pass).toString('base64');
      }
      const request = (proxy.type === 'https' ? https : http).request({
        host: proxy.host,
        port: proxy.port,
        method: 'GET',
        path: url.toString(),
        headers: headers,
      }, function (response) {
        const location = response.headers.location;
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && location && redirects > 0) {
          response.resume();
          done({ redirect: new URL(location, url).toString() });
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', function (chunk) {
          size += chunk.length;
          if (size > maxBytes) { fail(new Error('响应超过上限 ' + maxBytes + ' 字节')); request.destroy(); return; }
          chunks.push(chunk);
        });
        response.on('end', function () {
          done({ status: status, headers: response.headers, body: Buffer.concat(chunks), finalUrl: url.toString() });
        });
        response.on('error', fail);
      });
      request.setTimeout(timeout, function () { request.destroy(new Error('请求超时 ' + timeout + 'ms')); });
      request.once('error', fail);
      request.end();
      return;
    }

    if (proxy) {
      connectThrough(proxy, host, port, timeout).then(function (socket) {
        if (isHttps) {
          const secure = tls.connect({
            socket: socket,
            servername: net.isIP(host) ? undefined : host,
            rejectUnauthorized: !insecureTls,
          });
          secure.once('secureConnect', function () { send(secure); });
          secure.once('error', fail);
        } else {
          send(socket);
        }
      }).catch(fail);
      return;
    }

    send(null);
  });

  if (result.redirect) {
    if (redirects <= 0) throw new Error('重定向次数过多');
    return get(result.redirect, Object.assign({}, opts, { redirects: redirects - 1 }));
  }
  if (result.status >= 400) {
    const error = new Error('HTTP ' + result.status + ' ' + url.toString());
    error.status = result.status;
    error.body = result.body;
    throw error;
  }
  return result;
}

/**
 * 证书校验失败（容器缺 CA 包 / 被中间人）时自动再用不校验证书的方式取一次。
 * 下载的是安装包，真正的完整性由调用方对着更新源的 sha256 校验，所以这里放行是可以接受的；
 * 结果里的 insecureTls 让调用方把这件事写进日志，不静默降级。
 */
async function getSmart(targetUrl, options) {
  const opts = options || {};
  try {
    const result = await get(targetUrl, opts);
    result.insecureTls = false;
    return result;
  } catch (error) {
    if (!isCertError(error) || opts.insecureTls === true) throw error;
    const result = await get(targetUrl, Object.assign({}, opts, { insecureTls: true }));
    result.insecureTls = true;
    result.certError = String((error && error.code) || (error && error.message) || error);
    return result;
  }
}

module.exports = {
  get: get,
  getSmart: getSmart,
  isCertError: isCertError,
  parseProxy: parseProxy,
  sha256: sha256,
};
