#!/usr/bin/env bash
# =============================================================================
# LocalScribe · 自包含 .app 打包 — staging 准备脚本
# =============================================================================
# 产出 src-tauri/bundle-staging/ 含:
#   python/                  # python-build-standalone 3.12 (~50 MB)
#     bin/python3            # 可独立运行的 Python
#     lib/python3.12/site-packages/  # mlx-whisper, silero-vad, openai…
#   scribe-py/               # 我们的代码 (复制源码,site-packages 里同时装为 editable→无需,直接 copy 源)
#   models/                  # Whisper 权重 1.5 GB
#   bin/ffmpeg               # 静态 ffmpeg
#
# 然后 tauri.conf.json 的 bundle.resources 把 staging/ 整个映射进
# .app/Contents/Resources/, run() 启动时探测到这些路径就走打包模式。
#
# 用法:  ./build-bundle.sh [--skip-python] [--skip-ffmpeg] [--skip-model]
# =============================================================================
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

c_blue='\033[1;34m'; c_green='\033[1;32m'; c_yellow='\033[1;33m'; c_red='\033[1;31m'; c_reset='\033[0m'
step() { echo -e "${c_blue}▸ $*${c_reset}"; }
ok()   { echo -e "${c_green}✓ $*${c_reset}"; }
warn() { echo -e "${c_yellow}⚠ $*${c_reset}"; }
err()  { echo -e "${c_red}✕ $*${c_reset}"; }

if [[ "$(uname)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  err "本脚本只支持 macOS Apple Silicon"; exit 1
fi

STAGING="$REPO_ROOT/src-tauri/bundle-staging"
mkdir -p "$STAGING"

SKIP_PYTHON=0; SKIP_FFMPEG=0; SKIP_MODEL=0
for arg in "$@"; do
  case $arg in
    --skip-python) SKIP_PYTHON=1;;
    --skip-ffmpeg) SKIP_FFMPEG=1;;
    --skip-model)  SKIP_MODEL=1;;
  esac
done

# =============================================================================
# 1. python-build-standalone (可重定位 Python 3.12,无系统依赖)
# =============================================================================
PY_VER="3.12.7"
PY_RELEASE="20241016"
PY_TGZ_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PY_RELEASE}/cpython-${PY_VER}+${PY_RELEASE}-aarch64-apple-darwin-install_only.tar.gz"

if [[ $SKIP_PYTHON -eq 0 ]]; then
  step "1/4 准备 python-build-standalone (${PY_VER})"
  PY_DIR="$STAGING/python"
  if [[ -x "$PY_DIR/bin/python3" ]]; then
    ok "  Python 已存在,跳过 (使用 --skip-python 跳过)"
  else
    rm -rf "$PY_DIR"
    TMP="$STAGING/python.tar.gz"
    step "  下载 $PY_TGZ_URL"
    curl -L --fail -o "$TMP" "$PY_TGZ_URL"
    step "  解压"
    tar -xzf "$TMP" -C "$STAGING"   # 解压成 python/
    rm "$TMP"
    ok "  Python 就绪 → $PY_DIR/bin/python3"
  fi

  step "  装 sidecar 依赖到打包 Python"
  BUNDLED_PY="$PY_DIR/bin/python3"
  # 用我们仓库里 .venv 已验证的同一组依赖
  "$BUNDLED_PY" -m pip install --upgrade pip
  "$BUNDLED_PY" -m pip install \
    -e "$REPO_ROOT/scribe-py" \
    silero-vad
  ok "  依赖装好"

  # editable install 写的是绝对路径,打包后路径变了会找不到。
  # 把 scribe-py 源码改为直接 copy 进 Resources,然后用 PYTHONPATH 指向它。
  # 这里去掉 editable 链接,改为纯 site-packages 安装。
  "$BUNDLED_PY" -m pip uninstall -y scribe-py 2>/dev/null || true
  "$BUNDLED_PY" -m pip install "$REPO_ROOT/scribe-py"
  ok "  scribe-py 转为非 editable 安装(打包模式必需)"

  # 验证打包 Python 能 import 关键依赖
  step "  验证依赖"
  "$BUNDLED_PY" -c "import mlx_whisper, silero_vad, openai, scribe_py; print('OK')"
fi

# =============================================================================
# 2. scribe-py 源码 (运行时不一定用到,但留一份便于 debug)
# =============================================================================
step "2/4 复制 scribe-py 源码到 staging"
rsync -a --delete --exclude '__pycache__' --exclude '*.pyc' \
  "$REPO_ROOT/scribe-py/" "$STAGING/scribe-py/"
ok "  scribe-py 同步完成"

# =============================================================================
# 3. ffmpeg 静态二进制 (来自 evermeet.cx · arm64)
# =============================================================================
if [[ $SKIP_FFMPEG -eq 0 ]]; then
  step "3/4 准备 ffmpeg 静态二进制"
  FF_DIR="$STAGING/bin"
  mkdir -p "$FF_DIR"
  if [[ -x "$FF_DIR/ffmpeg" ]]; then
    ok "  ffmpeg 已存在,跳过"
  else
    TMP="$STAGING/ffmpeg.zip"
    step "  下载 https://evermeet.cx/ffmpeg/getrelease/zip"
    curl -L --fail -o "$TMP" "https://evermeet.cx/ffmpeg/getrelease/zip"
    step "  解压"
    unzip -o "$TMP" -d "$FF_DIR" >/dev/null
    rm "$TMP"
    chmod +x "$FF_DIR/ffmpeg"
    ok "  ffmpeg → $FF_DIR/ffmpeg"
  fi
  # ffprobe 也来一份(scribe-py 的 audio.py 用)
  if [[ ! -x "$FF_DIR/ffprobe" ]]; then
    TMP="$STAGING/ffprobe.zip"
    step "  下载 ffprobe"
    curl -L --fail -o "$TMP" "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip"
    unzip -o "$TMP" -d "$FF_DIR" >/dev/null
    rm "$TMP"
    chmod +x "$FF_DIR/ffprobe"
    ok "  ffprobe 就绪"
  fi
fi

# =============================================================================
# 4. Whisper 模型权重 (1.5 GB)
# =============================================================================
if [[ $SKIP_MODEL -eq 0 ]]; then
  step "4/4 复制 Whisper 模型到 staging"
  SRC="$REPO_ROOT/models/whisper-large-v3-turbo"
  DST="$STAGING/models/whisper-large-v3-turbo"
  if [[ ! -f "$SRC/weights.safetensors" ]]; then
    err "  $SRC/weights.safetensors 不存在 — 先跑 ./install.sh 下模型"
    exit 1
  fi
  mkdir -p "$DST"
  # APFS clonefile = 秒拷
  cp -c "$SRC/weights.safetensors" "$DST/" 2>/dev/null || cp "$SRC/weights.safetensors" "$DST/"
  cp "$SRC/config.json" "$DST/"
  [[ -f "$SRC/README.md" ]] && cp "$SRC/README.md" "$DST/"
  ok "  模型 → $DST"
fi

# =============================================================================
# 总结
# =============================================================================
echo
ok "Staging 完成 → $STAGING"
du -sh "$STAGING"/* 2>/dev/null
echo
echo "下一步:  pnpm tauri build"
echo "        (tauri.conf.json 的 bundle.resources 会把 staging/ 拷进 .app/Contents/Resources/)"
