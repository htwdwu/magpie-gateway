# 发布记录

- 源码仓库：https://github.com/htwdwu/magpie-gateway
- Release：https://github.com/htwdwu/magpie-gateway/releases/tag/v1.4.0
  （资产 `magpie.gateway_1.4.0.zip`）
- 商店 PR：https://github.com/xzyy03/Nox-Plugins-Store/pull/3
  - 改动：`index.json` 加一条 `magpie.gateway` + `packages/magpie.gateway_1.4.0.zip`
  - CI：`Validate plugin index` 已触发，状态 `action_required`（首次贡献者需要维护者点一下批准）
- 仓内附带：`scripts/push-github.sh`（建仓/推送/发版）、`scripts/pr-store.mjs`（fork + 提 PR）

## 后续发新版本

```sh
# 1) 改 out 里清单的 version
# 2) 重新出包并推仓库 + Release
GITHUB_TOKEN=xxx sh scripts/push-github.sh magpie-gateway
# 3) 更新商店索引（把同 id 那条的 version 改掉，包换掉）
GITHUB_TOKEN=xxx node scripts/pr-store.mjs --repo https://github.com/htwdwu/magpie-gateway
```
