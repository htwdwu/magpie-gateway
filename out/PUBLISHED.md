# 发布记录 · magpie.gateway 1.5.0

| 项目 | 地址 / 状态 |
|---|---|
| 源码仓库 | https://github.com/htwdwu/magpie-gateway |
| Release | https://github.com/htwdwu/magpie-gateway/releases/tag/v1.5.0 |
| Release 资产 | `magpie.gateway_1.5.0.zip`，45272 字节，sha256 `21ebc764de416fd3f4def51b4dcd94123ea12a5f5c8c70d3aade7b2e4d8aeaa9` |
| 商店 PR | https://github.com/xzyy03/Nox-Plugins-Store/pull/3 （已更新到 1.5.0，删掉 1.4.0 的包） |
| 界面证据 | `out/ui-evidence/`（390×844、360×740 两档 + 设备卡特写） |

1.5.0 的改动是界面重做（按 oil-ui skill 的轻路径）：状态先行、地址可一键带走、
设置分三组、日志独立成块、深浅色与动效适配。功能、清单、运行时协议均未改动。

发新版本：

```sh
GITHUB_TOKEN=<classic token> sh scripts/push-github.sh magpie-gateway
GITHUB_TOKEN=<classic token> node scripts/pr-store.mjs --repo https://github.com/htwdwu/magpie-gateway
```
