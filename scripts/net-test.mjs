#!/usr/bin/env node
/**
 * 下载器测试：重定向跟随、证书校验失败后的降级、代理地址解析。
 * 用本机临时自签证书起一个 https 服务，模拟"容器里没有 CA 包"的环境。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const netlib = require('../nox/magpie-gateway/dist/net.cjs');

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-net-'));

let httpsServer = null;
let httpServer = null;

try {
  // ---------- 自签证书 https ----------
  const key = path.join(TMP, 'key.pem');
  const cert = path.join(TMP, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });

  httpsServer = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise((r) => httpsServer.listen(0, '127.0.0.1', r));
  const httpsPort = httpsServer.address().port;
  const httpsUrl = `https://127.0.0.1:${httpsPort}/feed`;

  let strictError = null;
  try {
    await netlib.get(httpsUrl, { timeoutMs: 8000 });
  } catch (error) {
    strictError = error;
  }
  check('严格校验时自签证书被拒', Boolean(strictError), strictError && (strictError.code || strictError.message));
  check('被拒原因被识别为证书错误', netlib.isCertError(strictError), strictError && strictError.code);

  const smart = await netlib.getSmart(httpsUrl, { timeoutMs: 8000 });
  check('证书错误后自动降级下载成功', smart.status === 200 && JSON.parse(smart.body.toString()).ok === true, '');
  check('降级结果带 insecureTls 标记', smart.insecureTls === true, String(smart.insecureTls));
  check('降级结果里保留了原始证书错误', /CERT|SELF_SIGNED|UNABLE|DEPTH/i.test(String(smart.certError)), String(smart.certError));

  // ---------- 重定向 ----------
  httpServer = http.createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/final' });
      res.end();
      return;
    }
    if (req.url === '/final') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('arrived');
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const httpPort = httpServer.address().port;

  const redirected = await netlib.get(`http://127.0.0.1:${httpPort}/start`, { timeoutMs: 8000 });
  check('跟随 302 重定向', redirected.body.toString() === 'arrived' && /\/final$/.test(redirected.finalUrl), redirected.finalUrl);

  let notFound = null;
  try {
    await netlib.get(`http://127.0.0.1:${httpPort}/missing`, { timeoutMs: 8000 });
  } catch (error) {
    notFound = error;
  }
  check('404 抛错并带状态码', notFound && notFound.status === 404, notFound && notFound.status);

  const sizeLimited = netlib.get(`http://127.0.0.1:${httpPort}/final`, { timeoutMs: 8000, maxBytes: 2 })
    .then(() => 'no-error').catch((error) => String(error.message));
  check('超过字节上限会被掐断', /上限/.test(await sizeLimited), await sizeLimited);

  // ---------- 代理解析 ----------
  const cases = [
    ['http://127.0.0.1:8080', { type: 'http', host: '127.0.0.1', port: 8080 }],
    ['https://u:p@proxy.local', { type: 'https', host: 'proxy.local', port: 443 }],
    ['socks5://127.0.0.1', { type: 'socks5', host: '127.0.0.1', port: 1080 }],
    ['socks5h://u:p@10.0.0.2:1081', { type: 'socks5', host: '10.0.0.2', port: 1081 }],
  ];
  for (const [input, expected] of cases) {
    const parsed = netlib.parseProxy(input);
    check(`代理解析 ${input}`, parsed && parsed.type === expected.type && parsed.host === expected.host && parsed.port === expected.port,
      JSON.stringify(parsed));
  }
  check('认不出的代理地址返回 null', netlib.parseProxy('ftp://x') === null && netlib.parseProxy('') === null, '');

  // ---------- sha256 ----------
  check('sha256 与 openssl 一致',
    netlib.sha256(Buffer.from('magpie')) === execFileSync('openssl', ['dgst', '-sha256'], { input: 'magpie' }).toString().trim().split('= ')[1],
    netlib.sha256(Buffer.from('magpie')).slice(0, 16));
} catch (error) {
  check('测试执行未抛错', false, error && error.message);
} finally {
  if (httpsServer) httpsServer.close();
  if (httpServer) httpServer.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '×'} ${r.name}${r.ok || r.detail === '' ? '' : '  — ' + r.detail}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
