# LocalScribe

> 完全离线的录音转文字桌面应用 · 可选 LLM 字级校对与整篇排版 · MIT License
> **出品方:涌智星河(SwarmPath) · 寒三修** — 隐私友好、本地可控、AI 增强的内容创作工具家族

[![Version](https://img.shields.io/badge/version-1.0.0-success)]()
[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-blue)]()
[![Tauri](https://img.shields.io/badge/Tauri-2.10-orange)]()
[![Whisper](https://img.shields.io/badge/Whisper-large--v3--turbo-purple)]()
[![DMG](https://img.shields.io/badge/dmg-1.8%20GB-lightgrey)]()

录音文件拖进去,几分钟后得到结构化的文字稿、字幕(SRT)、整篇排版文章。
**音频不上传任何服务器**;只有在你显式启用 LLM 校对时,转录后的文字才会发送到你配置的 LLM API。

---

## 🎉 v1.0.0 · 首个正式版

| 类别 | 改进 |
|---|---|
| 🚀 **可分发** | 自包含 .dmg(~1.8 GB · 内置 Python 3.12 + 模型 + ffmpeg)— 双击装到 Applications,**用户什么都不用装** |
| 🎯 **不丢段** | VAD 引导转录:silero-vad 先切说话区间再逐段送 Whisper,解决长 chunk 漏段 bug |
| ⚡ **更快校对** | 默认并发 5 → **15**,批大小 20 → **30**,综合 4-5x 加速;**急速模式**再快 30% |
| 📁 **数据规范** | 用户数据搬到 `~/Library/Application Support/LocalScribe/`,卸载/升级不丢 |
| 🛡️ **首启引导** | 模型缺失时显示三步引导页(下载 → 放指定目录 → 重新检测) |
| 🏗️ **构建系统** | 新 `build-bundle.sh` + `build-app.sh`,一行命令出可分发 .dmg |

老用户升级:settings 自动迁移到新默认值 — 启动时检测旧 5/20 默认 → 自动改 15/30 并写回。

---

## ✨ 特性

- **快**:Apple Silicon 经 mlx-whisper 加速,1 小时音频约 1-2 分钟
- **不丢段**:VAD 引导转录,silero-vad 先切说话区间再逐段送 Whisper,避开 Whisper 长 chunk 漏段 bug
- **准**:四层防御消除 Whisper 已知的"感谢观看 / Fro Fro" 等中文幻觉
- **离线**:转录环节零网络。LLM 校对可选,默认关闭
- **省**:DeepSeek-v4-flash 校对 1 小时音频 ~0.5 元
- **专业**:VSCode 风格界面 · **15 路并发校对**(默认)· 急速模式开关 · 暂停/继续/取消 · 支持 384K token 输出
- **历史库**:自动持久化所有转录到 `transcripts/<文件名>/`,以后随时载入查看
- **CLI 友好**:全部功能可通过命令行 + JSON 协议给 AI 编码工具(Claude Code / Hermes)调用
- **开箱即用**:提供自包含 `.dmg`(~1.8 GB · 内置 Python + 模型 + ffmpeg),双击装到 Applications 即用

---

## 📥 安装

### 路线 A · 直接装 .dmg(推荐普通用户)

如果作者/朋友给了你 `LocalScribe_1.0.0_aarch64.dmg`(~1.8 GB):

```
1. 双击 LocalScribe_1.0.0_aarch64.dmg
2. 拖 LocalScribe 图标到 Applications 文件夹
3. 启动台 / Finder 找到 LocalScribe → 右键打开(首次会问"未验证开发者")
4. 直接用 — Python / Whisper 模型 / ffmpeg 全部内置,**不用装任何东西**
```

DMG 包含:
- **可重定位 Python 3.12** + mlx-whisper / silero-vad / openai 等所有依赖
- **Whisper large-v3-turbo** 权重(1.5 GB)
- **ffmpeg / ffprobe** 静态二进制(arm64)

用户数据(转录、文章库、设置)自动放到 `~/Library/Application Support/LocalScribe/`,卸载/升级不丢。

### 路线 B · 源码自构建(开发者)

```bash
git clone <仓库地址> LocalScribe
cd LocalScribe
./install.sh           # 自动:装 ffmpeg/uv/pnpm/Rust → 装 Python 依赖 → 下模型 → 构建 dev .app
```

**国内网络加速**:
```bash
HF_MIRROR=1 ./install.sh    # 用 hf-mirror.com + 清华源 + npmmirror
```

**仅装依赖,不构建 .app**:
```bash
SKIP_BUILD=1 ./install.sh   # 用源码 dev 模式跑:pnpm tauri dev
```

dev .app 出在 `src-tauri/target/release/bundle/macos/LocalScribe.app`(依赖项目源码,不便分发)。

### 路线 C · 自己出可分发 .dmg

```bash
./install.sh                       # 先把 .venv + 模型准备好
./build-app.sh                     # 自动:下 python-build-standalone + ffmpeg → 注入 .app → 出 .dmg
# 产物: src-tauri/target/release/bundle/dmg/LocalScribe_1.0.0_aarch64.dmg (~1.8 GB)
```

`build-app.sh` 做的事:
1. `build-bundle.sh` 准备 staging:可重定位 Python + 装依赖 + ffmpeg + 模型
2. `pnpm tauri build` 出基础 .app
3. `tar` 管道把 staging 注入 `.app/Contents/Resources/`(剥离 `com.apple.provenance` xattr,绕开 macOS Tahoe 的 .app 写保护)
4. `hdiutil` 重新生成 UDZO 压缩 .dmg

### 配置 DeepSeek API Key(可选,启用 LLM 校对/排版)

1. 申请 Key:https://platform.deepseek.com(注册送额度,够测试)
2. 启动 LocalScribe → ⚙ 设置 → 校对
3. 启用 LLM 校对 → 弹隐私确认 → 粘贴 Key → 保存

**Key 存放在 macOS 系统钥匙串,不会上传任何地方。**

### 首次启动 macOS 提示"无法验证开发者"

我们的 `.app` 未做苹果开发者签名。绕过:
```bash
xattr -cr /Applications/LocalScribe.app
```
或:系统设置 → 隐私与安全性 → 滚到底 → 点"仍要打开"。

### Intel Mac / Linux / Windows

当前 `install.sh` 只针对 Apple Silicon 调试过。其他平台:
- 模型路径切到 `deepdml/faster-whisper-large-v3-turbo-ct2`(CT2 格式)
- 后端 `--backend=ct2`(faster-whisper)
- 速度慢约 5-10 倍(无 GPU)

跨平台分发版仍在 roadmap,见下文。

---

## 🎯 使用

### 在 GUI 里

1. 拖入音频/视频文件到左侧 DropZone(支持 m4a / mp3 / wav / mp4 / mov 等)
2. 自动转录,任务卡显示进度
3. 切到 **校对** tab → 点 **开始校对** 或 **校对+排版(一键)**
4. 切到 **文章** tab 看完整排版稿
5. 任意 tab 都能 **复制 / 导出 .txt / .srt / .md / .json**

### CLI(供 AI 工具调用)

```bash
# 一句话搞定整条流水线
./bin/localscribe pipeline /path/to/audio.m4a --json

# 仅转录
./bin/localscribe transcribe audio.m4a --json

# 列出历史库
./bin/localscribe ls --json
```

详见 [CLI.md](./CLI.md)。

### 链到 PATH

```bash
ln -s "$(pwd)/bin/localscribe" /usr/local/bin/localscribe
localscribe --help
```

---

## 🛠 从源码构建

适合开发者 / 想自己改的人。当前只构建 macOS Apple Silicon。

### 依赖

| 工具 | 用途 | 版本 |
|---|---|---|
| Rust + Cargo | Tauri 后端 | 1.77+ |
| Node + pnpm | React 前端 | Node 20+, pnpm 9+ |
| uv | Python 依赖管理 | 0.4+ |
| Python | 转录 sidecar | 3.10+ |
| ffmpeg | 音频解码 | 任意现代版本 |

### 安装步骤

```bash
git clone <repo-url> LocalScribe
cd LocalScribe

# 1. 前端依赖
pnpm install

# 2. Python venv + sidecar
uv venv
uv pip install --python .venv/bin/python -e scribe-py
uv pip install --python .venv/bin/python silero-vad

# 3. 模型(1.5 GB · Apple Silicon 首选 MLX 版)
#    ⚠️ 默认下到项目内 ./models/whisper-large-v3-turbo/,这样整个 LocalScribe 文件夹可以直接拷给别人
HF_ENDPOINT=https://hf-mirror.com .venv/bin/python3 -c "
from huggingface_hub import snapshot_download
snapshot_download(repo_id='mlx-community/whisper-large-v3-turbo',
                  local_dir='./models/whisper-large-v3-turbo',
                  local_dir_use_symlinks=False)
"
# 或者把别人发给你的 weights.safetensors / config.json 直接放到:
#   LocalScribe/models/whisper-large-v3-turbo/
# 也可通过环境变量指向其他位置:
#   export LOCALSCRIBE_MODEL_DIR=/path/to/whisper-large-v3-turbo

# 4. 配置 API key(可选,用于 LLM 校对)
echo '{"keys": {"deepseek": "sk-..."}}' > .dev-secrets.json
chmod 600 .dev-secrets.json

# 5. 开发模式(热重载)
pnpm tauri dev

# 6. 生产构建
pnpm tauri build
# 产物:src-tauri/target/release/bundle/macos/LocalScribe.app
#       src-tauri/target/release/bundle/dmg/LocalScribe_1.0.0_aarch64.dmg
```

### 注意事项

- `pnpm tauri build` 出的是 **dev 版 .app** — 依赖 `<repo>/.venv/bin/python3` 绝对路径,只能你这台机器运行
- 想给别人用:跑 `./build-app.sh` 出**自包含 .dmg**(~1.8 GB,内置 Python + 模型 + ffmpeg)

---

## 📁 项目结构

```
LocalScribe/
├── README.md                    本文档
├── CLI.md                       AI 工具调用 CLI 接口
├── PROJECT_BRIEF.md             项目需求文档
├── install.sh                   开发环境一键安装 · 装依赖 + 下模型 + dev build
├── build-bundle.sh              准备 staging:可重定位 Python + 装依赖 + ffmpeg + 模型
├── build-app.sh                 出自包含 .dmg(staging 注入 .app + 重打 dmg)
├── package.json                 前端依赖
├── tailwind.config.cjs          VSCode dark+ 配色
├── index.html                   Vite 入口
│
├── bin/
│   └── localscribe              shell wrapper(可链到 PATH)
│
├── src/                         React 前端(TypeScript + Tailwind)
│   ├── App.tsx                  主页面 · TitleBar / Sidebar / StatusBar
│   ├── components/              组件(VSCode 风格)
│   ├── stores/                  Zustand 状态管理
│   ├── hooks/                   usePipeline / 暂停取消
│   └── lib/ipc.ts               Tauri 命令类型化封装
│
├── src-tauri/                   Tauri 2 后端(Rust)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs / lib.rs     Tauri 入口
│       ├── commands.rs          18 个 #[tauri::command]
│       ├── sidecar.rs           Python sidecar 进程管理 + IPC
│       ├── library.rs           transcripts/ 持久化
│       └── secrets.rs           keychain 封装
│
├── scribe-py/                   Python sidecar(转录核心)
│   ├── pyproject.toml
│   └── src/scribe_py/
│       ├── __main__.py          CLI 入口(8 个子命令)
│       ├── ipc.py               JSON-RPC over stdio
│       ├── core/
│       │   ├── transcriber_mlx.py    MLX 实现 + 4 层幻觉防御
│       │   ├── transcriber_ct2.py    faster-whisper 跨平台
│       │   └── audio.py              ffprobe
│       ├── correctors/
│       │   ├── openai_compatible.py  并发校对 + 术语表
│       │   └── prompts.py            light/medium/heavy 三档
│       └── polishers/
│           └── article_polisher.py   整篇排版
│
├── models/                     Whisper 权重(gitignored,1.5 GB · install.sh 自动下载)
│   └── whisper-large-v3-turbo/
│       ├── weights.safetensors
│       └── config.json
│
├── src-tauri/bundle-staging/   .dmg 打包暂存区(gitignored,~3 GB)
│   ├── python/                 python-build-standalone + 装好的 site-packages
│   ├── scribe-py/              我们的 Python 包(打包模式用 site-packages 副本)
│   ├── models/                 模型副本
│   └── bin/ffmpeg + ffprobe    静态二进制
│
└── transcripts/                自动保存的转录结果(每个音频一个子目录)
    ├── <stem1>/
    │   ├── <stem1>.txt / .srt / .json     转录原文
    │   ├── <stem1>_corrected.txt / ...     LLM 校对后
    │   ├── <stem1>_diff.txt                修改对比
    │   └── <stem1>_完整版.txt              整篇排版稿
    └── <stem2>-20260501-1610/              旧版本归档

# 装到 .app 后,用户数据搬到这里(macOS 标准位置):
~/Library/Application Support/LocalScribe/
    ├── transcripts/
    └── articles/
```

---

## 🔒 隐私模型

| 数据 | 是否离开本机 |
|---|---|
| 音频文件 | **永不上传**(转录全程本地 GPU) |
| 转录文字(关 LLM 时) | 只在本机 |
| 转录文字(开 LLM 时) | 发送到你配置的 LLM 提供商进行校对/排版 |
| API Key | 存 macOS 钥匙串,从不离开本机 |
| 历史库 | `transcripts/` 文件夹,纯本地 |

启用 LLM 校对时会弹出隐私提示,需用户明确确认。

---

## 🧠 技术亮点

### 转录幻觉防御(4 层架构)

Whisper 在静音段会"幻觉"出训练集高频短语(感谢观看 / 请订阅 / Fro Fro)。我们做了:

1. **VAD 输入清理**:silero-vad 检测说话区间,非语音段直接丢弃
2. **解码硬化**:`condition_on_previous_text=False` 切自反馈循环 + 收紧 `no_speech` / `compression_ratio` / `logprob` 阈值
3. **置信度自校**:模型自报的 `avg_logprob < -1.0` 段直接丢弃
4. **统计后处理**:重复检测 / 字符密度异常 / 段间相似度 / 已知幻觉短语黑名单

详见 `scribe-py/src/scribe_py/core/transcriber_mlx.py`。

### LLM 校对优化

- **B 两阶段**:Pass 1 扫全文提取专有名词术语表 → Pass 2 每批校对带词表保持跨段一致性
- **15 路并发**(默认 · 可调):`ThreadPoolExecutor` + DeepSeek API,3 小时音频 ~6 分钟 → ~1.5 分钟
- **急速模式**:跳过 Pass 1 术语提取,通用内容再快约 30%(设置 → 校对 → 急速模式)
- **暂停/继续/取消**:reader 线程 + worker 池架构,校对中也能实时响应控制命令
- **失败隔离**:某批失败保留原文,不让一个错误拖垮整篇

### VAD 引导转录(解决 Whisper 漏段)

Whisper 处理 30 秒以上连续片段时,内部 chunk 决策有时会**整窗丢段** — 同一段音频
单独切出来送给 Whisper 能识别,放在长音频里又会被跳过。修复方式:

1. `silero-vad` 先扫整段音频 → 输出说话区间时间戳
2. 合并间隔 < 0.6 秒的相邻区间(避免短片段上下文不足)
3. 拆开 > 25 秒的(避开 Whisper chunk 边界)
4. 每个区间单独 ffmpeg 切片 + mlx-whisper 转录,最后按全局时间拼接

实测:之前会丢的"经文 1-3 节"现在完整出现。代价 RTF 约 0.04 → 0.06(仍远低于实时)。
默认开启,环境变量 `LOCALSCRIBE_VAD_GUIDED=0` 可关。

### 截断检测

LLM 输出有 token 限制,超长内容会被截断。我们:
- 默认 `max_tokens=384000`(DeepSeek 上限)
- 检测 `finish_reason=="length"`,在文章页显示醒目警告
- 引导用户提高 max_tokens 重跑

---

## 🚧 路线图

- [x] MLX + faster-whisper 双后端
- [x] LLM 校对 + 排版
- [x] 历史库 + 重复检测
- [x] 4 层幻觉防御
- [x] CLI + JSON 协议
- [x] **15 路并发**校对 + 暂停/取消 + 急速模式
- [x] **VAD 引导转录** — 解决 Whisper 长 chunk 漏段
- [x] **可分发 .dmg**(~1.8 GB · 内置 Python + 模型 + ffmpeg)— 双击装到 Applications 即用
- [x] **模型缺失引导页** — 启动时若没找到权重,UI 引导用户放入正确目录
- [ ] **代码签名 + 公证**(Apple Dev ID · 消除"未验证开发者"提示)
- [ ] **首启 wizard**(语言 / 模型大小 / 镜像三步引导)
- [ ] **Windows / Linux 构建**
- [ ] **Live recording**(直接调系统麦克风)
- [ ] **说话人分离**(diarization · `pyannote.audio`)

---

## 🌌 关于涌智星河 / SwarmPath

LocalScribe 由 **涌智星河(SwarmPath) · 寒三修** 出品,是其旗下的开源产品之一。
涌智星河致力于打造一系列**隐私友好、本地可控、AI 增强**的工具,帮助个人与小团队
完成从录音 → 文字 → 知识 → 决策的完整闭环。

| 产品 | 定位 |
|---|---|
| **LocalScribe**(本仓库) | 离线录音转文字 · 可选 LLM 校对 · 文章库 · CLI 友好 |
| 其他兄弟项目 | 持续构建中 — 关注 SwarmPath 后续发布 |

所有代码以 **MIT 协议**开源,商业与非商业使用皆免费。问题反馈 / 贡献欢迎提 Issue / PR。

---

## 🙏 致谢

LocalScribe 站在以下开源项目肩膀上:

- **[Whisper](https://github.com/openai/whisper)** © OpenAI · MIT License
  Radford et al., "Robust Speech Recognition via Large-Scale Weak Supervision", 2022
  https://arxiv.org/abs/2212.04356
- **[mlx-whisper](https://github.com/ml-explore/mlx-examples)** © Apple ML Research · MIT License
- **[faster-whisper](https://github.com/SYSTRAN/faster-whisper)** © SYSTRAN · MIT License
- **[silero-vad](https://github.com/snakers4/silero-vad)** © Silero Team · MIT License
- **[Tauri](https://tauri.app)** · **[React](https://react.dev)** · **[DeepSeek API](https://api-docs.deepseek.com)**

模型权重:[`mlx-community/whisper-large-v3-turbo`](https://huggingface.co/mlx-community/whisper-large-v3-turbo)

---

## 📜 License

MIT License — 见 [LICENSE](./LICENSE)

```
@article{radford2022whisper,
  title={Robust Speech Recognition via Large-Scale Weak Supervision},
  author={Radford, Alec and Kim, Jong Wook and Xu, Tao and Brockman, Greg and McLeavey, Christine and Sutskever, Ilya},
  journal={arXiv preprint arXiv:2212.04356},
  year={2022}
}
```
