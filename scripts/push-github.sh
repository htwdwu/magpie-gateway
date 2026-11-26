#!/bin/sh
# 一条命令建仓库 + 推代码 + 出 Release（附带插件 zip）。
#
# 用法：
#   GITHUB_TOKEN=ghp_xxx sh scripts/push-github.sh [仓库名]
#   GITHUB_TOKEN=ghp_xxx DRY_RUN=1 sh scripts/push-github.sh      # 只打印要做什么
#
# token 权限：classic 勾 repo（建仓库 + 推代码 + 发 Release 都够）；
#             fine-grained 至少给 Administration:write、Contents:write。
set -eu

TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
NAME="${1:-magpie-gateway}"
PRIVATE="${PRIVATE:-false}"
DRY="${DRY_RUN:-0}"
API="https://api.github.com"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "× $*" >&2; exit 2; }

[ -n "$TOKEN" ] || die "缺 GITHUB_TOKEN（classic 勾 repo；fine-grained 给 Administration:write + Contents:write）"

# --- 1. 是谁 ---
if [ "$DRY" = "1" ]; then
  LOGIN="yourname"
  say "· [dry-run] 会用 token 查 /user 拿到登录名"
else
  BODY=$(curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$API/user" 2>/dev/null || true)
  LOGIN=$(printf '%s' "$BODY" | python3 -c 'import sys,json
try:
    print(json.load(sys.stdin).get("login",""))
except Exception:
    print("")' 2>/dev/null)
  [ -n "$LOGIN" ] || die "token 无效或没网（GET /user 返回：$(printf '%s' "$BODY" | head -c 120)）"
fi
REPO_URL="https://github.com/$LOGIN/$NAME"
say "· 账号：$LOGIN"
say "· 仓库：$REPO_URL"

# --- 2. 建仓库（已存在就复用） ---
if [ "$DRY" = "1" ]; then
  say "· [dry-run] POST $API/user/repos {\"name\":\"$NAME\",\"private\":$PRIVATE}"
else
  PAYLOAD=$(printf '{"name":"%s","private":%s,"description":"Nox plugin: installs magpie and runs its local gateway with a native panel."}' "$NAME" "$PRIVATE")
  CODE=$(curl -s -o /tmp/gh-create.json -w '%{http_code}' -X POST \
      -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
      -H "Content-Type: application/json" --data "$PAYLOAD" "$API/user/repos")
  case "$CODE" in
    201) say "· 已新建私有/公开仓库（HTTP 201）" ;;
    422) say "· 仓库已存在，直接复用（HTTP 422）" ;;
    401|403) die "token 权限不足（HTTP $CODE）：classic 要勾 repo，fine-grained 要 Administration:write" ;;
    *) die "建仓库失败（HTTP $CODE）：$(head -c 200 /tmp/gh-create.json)" ;;
  esac
fi

# --- 3. 提交并推送 ---
if [ ! -d .git ]; then
  [ "$DRY" = "1" ] || git init -q -b main
  say "· 初始化 git 仓库"
fi
cat > .gitignore <<'IGNORE'
out/logs/
out/publish/
node_modules/
*.zip
IGNORE
[ "$DRY" = "1" ] || {
  git config user.name "$LOGIN"
  git config user.email "$LOGIN@users.noreply.github.com"
  git add -A
  git commit -q -m "magpie gateway: Nox plugin" 2>/dev/null || say "· 没有改动可提交"
}

say "· 打包（校验 + zip）"
[ "$DRY" = "1" ] || node scripts/pack.mjs >/dev/null

ZIP=$(ls out/magpie.gateway_*.zip 2>/dev/null | tail -1 || true)
[ -n "$ZIP" ] || die "没有找到 zip，先跑 node scripts/pack.mjs"
VERSION=$(python3 -c 'import json;print(json.load(open("nox/magpie-gateway/plugin.json"))["version"])')

if [ "$DRY" = "1" ]; then
  say "· [dry-run] 把清单 repository 改成 $REPO_URL 并重新打包"
  say "· [dry-run] git push https://x-access-token:***@github.com/$LOGIN/$NAME.git main"
  say "· [dry-run] 建 Release v$VERSION 并上传 $(basename "$ZIP")"
  say "· [dry-run] node scripts/publish.mjs --repo $REPO_URL"
  exit 0
fi

node scripts/publish.mjs --repo "$REPO_URL" >/dev/null
ZIP="out/publish/packages/$(basename "$ZIP")"
[ -f "$ZIP" ] || ZIP=$(ls out/magpie.gateway_*.zip | tail -1)

git add -A
git commit -q -m "magpie gateway $VERSION" 2>/dev/null || true
git remote remove origin 2>/dev/null || true
git remote add origin "$REPO_URL.git"
say "· 推送 main"
# git over HTTPS 要 Basic 认证：用 x-access-token 拼 URL 最稳；推完立刻把 remote 换回干净地址
git push -q "https://x-access-token:$TOKEN@github.com/$LOGIN/$NAME.git" "HEAD:main"
git remote set-url origin "$REPO_URL.git"
git fetch -q origin main && git branch -q --set-upstream-to=origin/main main || true

# --- 4. Release + 资产（商店也能按 Release 资产取包） ---
say "· 建 Release v$VERSION"
RELEASE_ID=$(curl -fsSL -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" \
  -d "{\"tag_name\":\"v$VERSION\",\"name\":\"v$VERSION\",\"body\":\"magpie gateway $VERSION\"}" \
  "$API/repos/$LOGIN/$NAME/releases" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("id",""))' 2>/dev/null || true)

if [ -n "${RELEASE_ID:-}" ]; then
  curl -fsSL -X POST -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/zip" --data-binary "@$ZIP" \
    "https://uploads.github.com/repos/$LOGIN/$NAME/releases/$RELEASE_ID/assets?name=$(basename "$ZIP")" >/dev/null \
    && say "· 已上传 $(basename "$ZIP") 到 Release" \
    || say "! Release 资产上传失败，可稍后手动传"
else
  say "! 建 Release 失败（可能已存在 v$VERSION），跳过资产上传"
fi

say ""
say "完成：$REPO_URL"
say "插件包：$(basename "$ZIP")"
say ""
say "下一步（进 Nox 商店，二选一）："
say "  A. App → 插件页顶栏上传图标 → 选 $ZIP"
say "  B. 把 $ZIP 与 out/publish/index-entry.json 提 PR 到 xzyy03/Nox-Plugins-Store"
