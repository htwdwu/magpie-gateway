# Magpie 网关（Nox 插件）

在本机的 Linux 环境里装 magpie，托管它的本地网关（或网关 + 网页控制台），并给 App 一个原生面板：
看状态、启停、改启动方式 / 端口 / 网页 key / 安装代理、看安装日志、跑环境自检。

- 插件 id：`magpie.gateway`
- 版本：`1.6.0`
- 清单：`manifestVersion: 1` + `engines.pluginApi: "^1.0.0"`（App 现役格式，未知字段会被拒）
- 常驻：是（`runtime.resident = true`，网关要一直活着）
- 依赖：无第三方 npm 包，只用 node 内置模块

## 装

```bash
cd nox/magpie-gateway && zip -r /tmp/magpie.gateway-1.4.0.zip . -x '*.DS_Store'
```

App → 设置 → 插件 → 右上角 `+` 选这个 zip。开发时把目录放进 `~/.nox/plugin-dev/`，
用 `plugin` 工具 `install(source=dev)` / `reload` 迭代。

## 在哪看

| 入口 | 位置 |
|---|---|
| 网关面板 | 设置 → AI 分区末尾「Magpie 网关」、对话右上角菜单「Magpie 网关」、右侧项目工具抽屉「Magpie 网关」 |
| 设置页 | 插件详情页「配置」 |
| AI 工具 | `status` / `install` / `start` / `stop` / `settings` / `logs` / `diag` / `check` |
| 模型供应商 | 设置 → AI 供应商里的「Magpie 网关（本地）」，`http://127.0.0.1:3425/v1` |

`uiEntries` 每个插件最多 2 条，所以这里只占「设置 → AI」与「对话右上角菜单」两个位置，
两处都指向同一个面板页。

## 界面

按「设备控制台」的方向重做了一版：状态先行，地址可一键带走，设置拆成三组，日志单独成块。

- 页头一行：标题 + 状态徽标（灰点未装、绿点运行中）。首屏不放说明段落。
- 设备卡：一句大字结论（"网关与网页控制台在跑"）+ 版本；两行地址省掉 `http://`，
  网页版地址把 key 收成小标签，默认掩码（`?k=bg…rn`），点眼睛看全文。
- 动作：一个实心主动作随状态切换（启动 / 停止）；「检查」在右；下面一行文字按钮摆全
  「打开网关 / 打开网页版 / 安装·重装 / 环境自检」——功能都看得见，不靠隐形手势。
  复制网关、显隐 key、复制网页版地址是地址行右侧的小按钮（各带 aria-label）。
- 状态胶囊按状态着色（运行绿、待处理橙、出错红），日志默认收起三行可展开，
  表单没改动时「保存设置」是禁用的，改一个字段才亮。
- 设置：启动方式、端口与访问、安装三组，用间距分组不用线；输入框 16px、44px 触控高；
  保存栏吸底，键盘弹起也够得着。
- 日志：等宽块，标题栏里切「实时 / 自检 / 复制」。
- 深浅色跟随系统，动效尊重 `prefers-reduced-motion`。

## 在内置浏览器里打开

「打开网关 / 打开网页版」走宿主自带的受控全屏 WebView（`webview.login` 这条通道），
在 Nox 里直接看，不跳到外部浏览器；带标题、「关闭」按钮与关闭手势。
宿主没有这个能力（老版本）时才退回系统浏览器，并明确提示「这个 App 版本没有内置浏览器」。

## 面板做什么

- 状态：装了没、版本、谁起的进程、网关地址、网页版地址（含 key）
- 按钮：启动 / 停止 / 检查（`--version` + `healthcheck` + 端口）/ 安装或重装 / 环境自检 / 看日志 / 复制日志
- 复制与打开：网关地址、网页版地址
- 设置：启动方式（serve / web）、网关端口、网页版端口、网页版 key、代理用法（off / fallback / always）、
  安装代理、随 App 自动启动
- 日志：安装输出、启动命令、退出码、健康检查，2 秒刷新，自动跟到底部
- 环境自检：平台与架构、node 版本、HOME 与 magpie 路径、sh/bash/curl/apt/tar 是否存在、CA 包、到更新源的
  TLS、候选产物名、三处连通性、当前代理、最近一次安装错误——一键复制

启动方式或端口改过会提示重启；本插件启动的网关会自动重启。

## 安装怎么走

1. **纯 Node 直装（默认）**：读 `https://usemagpie.ai/api/latest`，按平台取产物名
   （`magpie-cli-linux-arm64` 之类），下载单文件 → 校验 `sha256` → 写进 `$HOME/.local/bin/magpie`
   → `chmod 755` → `--version` 自检；跑不起来就换 `android` 构建再试。**不需要 curl / sh / apt / tar。**
2. **官方安装脚本（后备）**：`curl usemagpie.ai/install.sh` + `sh` 执行，直连失败按设置走代理重试。

代理：设置里填的代理两条路都生效（`http://`、`https://`、`socks5://`、`socks5h://`）；
面板没填时会认容器里的 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`。

证书：容器经常缺 CA 包（`curl: (77) error setting certificate file`）。这里三层兜：先
`apt-get install -y ca-certificates`；再把指向不存在文件的 `SSL_CERT_FILE` / `SSL_CERT_DIR` /
`CURL_CA_BUNDLE` 从子进程环境摘掉；纯 Node 那条路遇到证书错误会自动重试一次「不校验证书」，
日志写明，安装包仍按 `sha256` 校验。

装不上时面板写的是真实原因：连不上哪台主机、证书错误码、校验不一致、下载了跑不起来、bin 目录不可写。

## 配置存在哪

`settings.json` 在 `MAGPIE_STATE_DIR`（缺省 `~/.local/state/magpie/`）；宿主给了 `NOX_PLUGIN_DATA`
就写那里。不写包目录——覆盖安装会把包目录整个换掉。

## 协议

宿主发来的 `method` 只有 `tool.invoke` / `hook.invoke` / `ui.invoke`，handler 名在 `params.handler`，
参数在 `params.args`；其它 `method` 回 `METHOD_UNKNOWN`。`handlers` 的键名与清单里的 `handler` 字段逐字一致。

## 目录

```
plugin.json          清单：8 个工具、1 个 hook、1 个供应商、2 个界面入口、1 个工作区工具、配置页
dist/main.js         JSON-RPC 运行时（handler 注册 + 自起）
dist/core.cjs        安装 / 启停 / 端口探测 / 日志 / 环境自检
dist/settings.cjs    设置模型与校验
dist/net.cjs         只用 node 内置模块的 HTTP(S) 客户端（重定向 / 代理 / socks5 / 证书降级 / sha256）
pages/panel.html     网关面板
pages/config.html    设置页（含安装日志与环境自检）
pages/ui.js          两页共用逻辑（渲染、表单、终端兜底、2 秒轮询）
schemas/*.json       8 个工具的输入 schema
```

## 自检

```bash
node scripts/manifest-check.mjs   # 按 App 解析器校验清单
node scripts/validate.mjs         # 清单 + 文件 + 页面契约 + runtime + 审计关键字
node scripts/check-all.mjs        # 全部检查 + 打包
```
