# magpie-gateway —— Nox 插件

一个 Nox 插件：在本机 Linux 环境里安装 [magpie](https://usemagpie.ai)，托管它的本地网关
（`magpie serve`，OpenAI 兼容 `/v1`）或网关 + 网页控制台（`magpie web`），并在 App 里给出原生面板。

- 插件 id `magpie.gateway`，清单格式 `manifestVersion: 1` + `engines.pluginApi: ^1.0.0`
- 常驻进程（`resident: true`）：网关要在没人调用时也活着
- 零第三方依赖，只用 node 内置模块

产物：`nox/magpie-gateway/` → `out/magpie.gateway_1.4.0.zip`

## 目录

```
nox/magpie-gateway/   插件包本体（plugin.json + dist + pages + schemas）
out/                  打包产物：zip、商店 index 条目、文件清单、校验信息、测试日志
scripts/
  manifest-check.mjs  按 App 解析器（PluginManifestParser）复刻的清单规则检查器
  validate.mjs        清单 + 文件引用 + 页面桥 + 页面契约 + runtime + 审计关键字
  protocol-test.mjs   起 dist/main.js，跑 tool.invoke / ui.invoke / hook.invoke
  startstop-test.mjs  假 magpie：启动、重复启动、运行中改设置重启、改端口、停止
  page-test.mjs       最小 DOM 影子跑 pages/ui.js（渲染、表单、按钮、自检、终端兜底）
  net-test.mjs        下载器：重定向、自签证书被拒→降级、字节上限、代理解析、sha256
  install-test.mjs    纯 Node 安装：成功、sha256 拒绝、断网、无 shell、坏证书环境、环境变量代理
  e2e-test.mjs        真实 magpie 端到端：serve 起停、端口释放、healthcheck、web 模式、抓 key
  pack.mjs            校验 + 打包（自带 zip 实现，不依赖系统 zip）
  check-all.mjs       一次跑完上面全部
```

## 怎么跑

```bash
node scripts/check-all.mjs
```

`e2e-test.mjs` 找不到 `/root/.local/bin/magpie` 时自动跳过；`install-test.mjs` 默认不下载真实产物，
`MAGPIE_REAL_INSTALL=1` 时完整走一次（约 90MB）。

## 几个关键决定

**清单以 App 为准，不以商店文档为准。** App 的解析器只认 `manifestVersion` + `engines.pluginApi`，
且严格拒绝未知字段；`configPage` 是 `.html` 路径字符串；`icon` 只接受小写内置图标名或 `.png/.webp`；
`uiEntries` 每个插件最多 2 条。`scripts/manifest-check.mjs` 把这套规则复刻成了本地检查器。

**安装不依赖 curl / sh / apt。** 读 `https://usemagpie.ai/api/latest` 拿产物名与 `sha256`，
用 `dist/net.cjs`（node 内置 http/https/net/tls/crypto）下载单文件、校验、写 `~/.local/bin/magpie`、
`chmod`、`--version` 自检；跑不起来换 `android` 构建再试。官方 `install.sh` 只作后备。

**证书兜三层。** 容器常缺 CA 包（`curl: (77) error setting certificate file`）：先 `apt-get install
ca-certificates`，再摘掉指向不存在文件的 `SSL_CERT_FILE` / `SSL_CERT_DIR` / `CURL_CA_BUNDLE`，
最后让 Node 那条路在证书错误时降级重试一次（日志写明，安装包仍校 `sha256`）。

**失败要说清原因。** 连不上哪台主机、证书错误码、`sha256` 不一致、下载了跑不起来、bin 目录不可写——
直接写在面板的提示里；「环境自检」把平台、node、PATH、工具链、CA、TLS、连通性、代理一次列全。

**没有 shell 也能用。** `magpieWorks` / `start` / `canStart` 不再以 `uname` 可用为前提（spawn 走 execve，
不经过 sh）；确实没有 shell 时，面板会露出「用终端安装 / 启动 / 停止」，由宿主 `bash` 执行
`ui.plan` 给出的同一批命令。

**配置不进包目录。** `settings.json` 写在 `MAGPIE_STATE_DIR`（缺省 `~/.local/state/magpie/`），
宿主给了 `NOX_PLUGIN_DATA` 就写那里——覆盖安装会换掉整个包目录。

## 发布

已经发布过：仓库 <https://github.com/htwdwu/magpie-gateway>、Release `v1.4.0`、
商店 PR <https://github.com/xzyy03/Nox-Plugins-Store/pull/3>（详见 `out/PUBLISHED.md`）。

一条命令建仓 + 推送 + 发版：

```bash
GITHUB_TOKEN=<classic token，勾 repo> sh scripts/push-github.sh magpie-gateway
```

只提商店 PR：

```bash
GITHUB_TOKEN=<token> node scripts/pr-store.mjs --repo https://github.com/<你>/magpie-gateway
```

只生成本地发布物料（不改远端）：

```bash
node scripts/publish.mjs --repo https://github.com/<你>/magpie-gateway
```

会把清单里的 `repository` 改成你的仓库、重新打包，并在 `out/publish/` 生成：
`packages/<id>_<version>.zip`、`index-entry.json`（可过商店 schema）、`PR.md`（提 PR 步骤与
`index.json` 片段）、`upload-github.sh`（推仓库）、`build-workflow.yml`（打 tag 自动出包）。

商店两条路：App 插件页上传 zip（进暂存区自动审计上架），或直接把包与 `index.json` 改动提 PR。
包已用商店官方 `scripts/audit_plugin.py` 与 `schema/index.schema.json` 预检通过。

## 装 / 上架

1. `node scripts/pack.mjs` 得到 `out/magpie.gateway_1.4.0.zip`
2. App → 设置 → 插件 → `+` 选这个 zip
3. 上架：包丢进暂存区的 `incoming/`，或把 `out/index-entry.json` 并进商店 `index.json`、
   包放进 `packages/<id>_<version>.zip`
