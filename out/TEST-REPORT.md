# 自检报告 · magpie.gateway 1.4.0

- 清单：`manifestVersion: 1` + `engines.pluginApi: ^1.0.0`
- 运行环境：Node v24.22.1 / Linux（proot Ubuntu 24.04）/ 本机真实 magpie 0.1.4841
- 原始日志：`out/logs/*.log`

## 一、这一版改了什么

这一版做了一次命名与文案清理：

| 位置 | 改动 |
|---|---|
| 插件 id | 统一为 `magpie.gateway` |
| 版本 | `1.4.0` |
| `repository` | 指向插件包托管仓库 `https://github.com/xzyy03/Nox-Plugins-Store` |
| `description` | 重写，不再提上游来源，改为描述实际能力（直连下载 + sha256、缺 CA 降级、失败给具体原因） |
| 包内 README | 重写为面向使用者的说明 |
| 源码注释 | 去掉"移植自 …"的措辞，只留行为描述 |
| `adapter.json` | 删除（内容只有上游功能对照表） |
| `raw/` 上游源码留档 | 删除 |
| 工程目录 | `nox/magpie-dsh` → `nox/magpie-gateway`，脚本路径同步 |

全仓扫描（含包内所有 js/cjs/json/html/md）已无历史命名残留。

> 注意：id 变过，App 里旧 id 的那个插件要手动卸载，再导入这一版。

## 二、能力（没减）

- 自动安装 magpie：直连下载单文件 + `sha256` 校验 + `--version` 自检，失败换 `android` 构建重试；
  官方 `install.sh` 作后备。
- 启停：`serve` / `web` 两种方式，`MAGPIE_ADDR`、`MAGPIE_WEB_KEY` 环境变量，只停自己起的进程，
  外部端口占用只探测不误杀。
- 改启动方式 / 端口 / 网页 key / 代理后自动重启并提示；临时 key 每次重启会换，地址要重抄。
- 安装与运行日志实时进面板；`--version` / `healthcheck` / 进程归属 / 端口一次诊断。
- 证书兜三层（补 CA 包、摘坏环境变量、Node 下载降级 + 仍校 sha256）。
- 环境自检：平台、node、PATH、工具链、CA、TLS、三处连通性、代理、最近错误，一键复制。
- 供应商：以 `openai` 格式注册 `http://127.0.0.1:3425/v1`。
- AI 工具 8 个：`status` / `install` / `start` / `stop` / `settings` / `logs` / `diag` / `check`。

## 三、检查结果

| 检查 | 内容 | 结果 |
|---|---|---|
| `manifest-check.mjs` | App 清单规则 | 0 错误 |
| `validate.mjs` | 清单 + 文件 + 页面桥 + 页面契约 + runtime + 审计关键字 | 通过 |
| `protocol-test.mjs` | 三条 JSON-RPC 通道、错误码、设置、日志、自检 | 30/30 |
| `startstop-test.mjs` | 启停 / 重复启动 / 运行中改设置重启 / 改端口 / 停止 | 20/20 |
| `page-test.mjs` | 渲染、表单、复制、终端兜底、自检与日志按钮 | 34/34 |
| `net-test.mjs` | 302 跟随、自签证书被拒→降级、字节上限、代理解析、sha256 | 14/14 |
| `install-test.mjs` | 纯 Node 安装、sha256 拒绝、断网、无 shell、坏证书环境、环境变量代理 | 27/27 |
| `e2e-test.mjs` | 真实 magpie：serve 起停、端口释放、healthcheck、web 模式、抓 key | 20/20 |
| `pack.mjs` | 校验 + 打包 | 通过 |

合计 8/8 步、145 项断言全绿。

## 四、打包

```
文件：out/magpie.gateway_1.4.0.zip
条目：19
体积：40251 字节（39.3 KiB）
sha256：cb160a2cf6b89ae7a2ee07779c207e563ead1c5ae14fa36dcfdc406e3ff59f4d
根目录 plugin.json：是（id magpie.gateway，version 1.4.0）
```

## 五、已知限制

- 网关端口是设置项，但注册给宿主的供应商入口是清单常量 `http://127.0.0.1:3425/v1`；
  端口改离 3425 后那一项连不上，面板会提示。
- 容器完全没有外网时无法自装：填代理，或先在终端执行一次官方安装脚本。
- 网页版不设固定 key 时每次重启换 key，需要重新复制地址。

## 六、发布

- 源码：https://github.com/htwdwu/magpie-gateway
- Release v1.4.0 资产 `magpie.gateway_1.4.0.zip`，sha256 `1c59f2f958706e50a788eb79add7b4704a3d906af0b28e52bfbcf04a92f78c2a`（可复现构建）
- 商店 PR：https://github.com/xzyy03/Nox-Plugins-Store/pull/3
- 打包已固定时间戳：同一份内容每次打包 sha256 相同，发布核对不会因为时间漂移而失败
