# 发布记录 · magpie.gateway 1.4.0

## 已完成的

| 项目 | 地址 / 状态 |
|---|---|
| 源码仓库 | https://github.com/htwdwu/magpie-gateway （public，3 次提交） |
| Release | https://github.com/htwdwu/magpie-gateway/releases/tag/v1.4.0 |
| Release 资产 | `magpie.gateway_1.4.0.zip`，40241 字节，sha256 `1c59f2f958706e50a788eb79add7b4704a3d906af0b28e52bfbcf04a92f78c2a` |
| 商店 PR | https://github.com/xzyy03/Nox-Plugins-Store/pull/3 （open，mergeable，2 文件） |
| 商店 CI | `Validate plugin index` 已触发，状态 `action_required` —— 首次贡献者需要维护者点一次「Approve and run」 |
| 商店 fork | https://github.com/htwdwu/Nox-Plugins-Store （`index.json` + 包已提交） |

包与本地可复现构建一致：`scripts/pack.mjs` 固定 zip 时间戳，同样内容永远同一个 sha256。

## 商店那边还需要什么

PR 只会被维护者合并；合并前商店不会收录这个插件。合并后可选的收尾：

- 商店侧通常会把 `package_url` 指向商店自己的 `packages/`，届时索引里的地址会被改写，不用你改
- 用户侧：商店页下拉刷新才能看到新条目

## 用户侧现在就能装

不必等商店：App → 设置 → 插件 → 右上角 `+` → 选 `out/magpie.gateway_1.4.0.zip`（或从 Release 下载同一个包）。

## 发新版本

```sh
# 1) 改 nox/magpie-gateway/plugin.json 的 version
# 2) 推仓库 + 新 Release
GITHUB_TOKEN=<classic token> sh scripts/push-github.sh magpie-gateway
# 3) 更新商店索引（同 id 换 version 与包）
GITHUB_TOKEN=<classic token> node scripts/pr-store.mjs --repo https://github.com/htwdwu/magpie-gateway
```
