#!/usr/bin/env bash
# =============================================================================
# LocalScribe · 自包含 .app + .dmg 完整打包
# =============================================================================
# 1. ./build-bundle.sh                  → src-tauri/bundle-staging/ 准备好资源
# 2. pnpm tauri build                   → 出基础 .app + .dmg (不含资源)
# 3. 手动 rsync staging/ → .app/Contents/Resources/  (保留 symlink + exec bit)
# 4. 重新生成 .dmg
#
# 用法:  ./build-app.sh [--skip-staging]
# =============================================================================
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

c_blue='\033[1;34m'; c_green='\033[1;32m'; c_yellow='\033[1;33m'; c_red='\033[1;31m'; c_reset='\033[0m'
step() { echo -e "${c_blue}▸ $*${c_reset}"; }
ok()   { echo -e "${c_green}✓ $*${c_reset}"; }
warn() { echo -e "${c_yellow}⚠ $*${c_reset}"; }
err()  { echo -e "${c_red}✕ $*${c_reset}"; }

SKIP_STAGING=0
for arg in "$@"; do
  case $arg in
    --skip-staging) SKIP_STAGING=1;;
  esac
done

STAGING="$REPO_ROOT/src-tauri/bundle-staging"

# =============================================================================
# 1. 准备 staging
# =============================================================================
if [[ $SKIP_STAGING -eq 0 ]]; then
  step "1/4 准备 staging (Python + 依赖 + ffmpeg + 模型)"
  ./build-bundle.sh
else
  step "1/4 跳过 staging (--skip-staging)"
  if [[ ! -x "$STAGING/python/bin/python3" ]]; then
    err "  staging 不完整 ($STAGING),不能跳过"
    exit 1
  fi
fi

# =============================================================================
# 2. tauri build (基础 .app,不含资源)
# =============================================================================
step "2/4 pnpm tauri build"
# 卸载已挂载的旧 DMG (打包流程会失败如果存在)
hdiutil info | grep -E "image-path.*LocalScribe" -B2 | grep "/dev/" | awk '{print $1}' | while read dev; do
  warn "  卸载旧 DMG: $dev"
  hdiutil detach "$dev" -force 2>/dev/null || true
done
rm -f "$REPO_ROOT/src-tauri/target/release/bundle/dmg/rw."*.dmg 2>/dev/null || true

pnpm tauri build

APP="$REPO_ROOT/src-tauri/target/release/bundle/macos/LocalScribe.app"
DMG_DIR="$REPO_ROOT/src-tauri/target/release/bundle/dmg"

if [[ ! -d "$APP" ]]; then
  err "tauri build 没产出 .app"; exit 1
fi
ok "  $APP"

# =============================================================================
# 3. 把 staging 内容塞进 .app/Contents/Resources/
# =============================================================================
step "3/4 注入 Python / scribe-py / models / ffmpeg"
RES_DIR="$APP/Contents/Resources"
mkdir -p "$RES_DIR"

# 先清空旧残留,再用 ditto(macOS 原生工具,完美保留 symlinks/xattrs/perms)
# rsync -a 在 .app 下会触发 utimensat 权限错误;cp -R 不保留 symlinks。
# ditto 是 Apple 推荐的 .app 内复制方式。
# 关键: macOS Tahoe 不让把带 com.apple.provenance xattr 的文件放进 .app
# (该 xattr 来自下载的 python-build-standalone tarball)
# ditto/rsync/cp 都会触发 "Operation not permitted"
# 解决: 先一次性剥光 staging 的 xattr,再用 tar 管道复制(symlinks 自动保留)
step "  剥离 staging 的 xattr (com.apple.*)"
xattr -drc com.apple.provenance "$STAGING" 2>/dev/null || true
xattr -drc com.apple.quarantine  "$STAGING" 2>/dev/null || true

for sub in python scribe-py models bin; do
  rm -rf "$RES_DIR/$sub"
  step "  tar-copy $sub"
  mkdir -p "$RES_DIR/$sub"
  ( cd "$STAGING/$sub" && tar -cf - . ) | ( cd "$RES_DIR/$sub" && tar -xpf - )
done

# 确保 ffmpeg / ffprobe / python3 是可执行的
chmod +x "$RES_DIR/bin/ffmpeg" "$RES_DIR/bin/ffprobe" 2>/dev/null || true
chmod +x "$RES_DIR/python/bin/python3" 2>/dev/null || true

# 验证打包 Python 可以 import 关键依赖
step "  验证打包 Python 能 import 依赖"
"$RES_DIR/python/bin/python3" -c "
import sys
sys.path.insert(0, r'$RES_DIR/scribe-py/src')
import mlx_whisper, silero_vad, openai
print('  ✓ mlx_whisper, silero_vad, openai 全部可 import')
"

APP_SIZE=$(du -sh "$APP" | cut -f1)
ok "  .app 注入完成,总大小 $APP_SIZE"

# 触发 macOS 重新签 quarantine 状态(去掉旧的)
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

# =============================================================================
# 4. 重新生成 .dmg
# =============================================================================
step "4/4 重新生成 .dmg"
DMG_PATH="$DMG_DIR/LocalScribe_1.0.0_aarch64.dmg"

# 删掉旧 dmg 让 tauri 重新生成 — 但只跑 dmg 步骤太麻烦,直接 hdiutil 简单做
rm -f "$DMG_PATH"

# 生成 DMG (压缩,容量自动)
TMP_DIR=$(mktemp -d)
mkdir -p "$TMP_DIR/dmg-source"
cp -R "$APP" "$TMP_DIR/dmg-source/"
ln -s /Applications "$TMP_DIR/dmg-source/Applications"

hdiutil create -volname "LocalScribe" \
  -srcfolder "$TMP_DIR/dmg-source" \
  -ov -format UDZO -fs HFS+ \
  "$DMG_PATH"
rm -rf "$TMP_DIR"

DMG_SIZE=$(du -sh "$DMG_PATH" | cut -f1)
ok "  .dmg 完成: $DMG_PATH ($DMG_SIZE)"

# =============================================================================
echo
echo -e "${c_green}═══════════════════════════════════════════════════════════${c_reset}"
echo -e "${c_green}  完成!${c_reset}"
echo -e "${c_green}═══════════════════════════════════════════════════════════${c_reset}"
echo
echo "  📦 .app:  $APP    ($APP_SIZE)"
echo "  💿 .dmg:  $DMG_PATH    ($DMG_SIZE)"
echo
echo "测试:"
echo "  open '$DMG_PATH'      # 打开 dmg → 拖到 /Applications → 启动"
echo
