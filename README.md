# LocalScribe

> 完全离线的录音转文字桌面应用 · 可选 LLM 字级校对与整篇排版 · MIT License
> **出品方:涌智星河(SwarmPath) · 寒三修** — 隐私友好、本地可控、AI 增强的内容创作工具家族

[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-blue)]()
[![Tauri](https://img.shields.io/badge/Tauri-2.10-orange)]()
[![Whisper](https://img.shields.io/badge/Whisper-large--v3--turbo-purple)]()

录音文件拖进去,几分钟后得到结构化的文字稿、字幕(SRT)、整篇排版文章。
**音频不上传任何服务器**;只有在你显式启用 LLM 校对时,转录后的文字才会发送到你配置的 LLM API。

---

## ✨ 特性

- **快**:Apple Silicon 经 mlx-whisper 加速,1 小时音频约 1-2 分钟
- **准**:四层防御消除 Whisper 已知的"感谢观看 / Fro Fro" 等中文幻觉
- **离线**:转录环节零网络。LLM 校对可选,默认关闭
- **省**:DeepSeek-v4-flash 校对 1 小时音频 ~0.5 元
- **专业**:VSCode 风格界面 · 5 路并发校对 · 暂停/继续/取消 · 支持 384K token 输出
- **历史库**:自动持久化所有转录到 `transcripts/<文件名>/`,以后随时载入查看
- **CLI 友好**:全部功能可通过命令行 + JSON 协议给 AI 编码工具(Claude Code / Hermes)调用

---

## 📥 安装

### 推荐:一键脚本(macOS Apple Silicon)

```bash
git clone <仓库地址> LocalScribe
cd LocalScribe
./install.sh           # 自动:装 ffmpeg/uv/pnpm/Rust → 装 Python 依赖 → 下模型(1.5 GB)→ 构建 .app
```

**国内网络加速**:
```bash
HF_MIRROR=1 ./install.sh    # 用 hf-mirror.com + 清华源 + npmmirror
```

**仅装依赖,不构建 .app**:
```bash
SKIP_BUILD=1 ./install.sh   # 用源码 dev 模式跑:pnpm tauri dev
```

完成后 `.app` 在 `src-tauri/target/release/bundle/macos/LocalScribe.app`,可拖到 `/Applications/`。

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
#       src-tauri/target/release/bundle/dmg/LocalScribe_0.1.0_aarch64.dmg
```

### 注意事项

- 当前 build 是**个人本机版**:.app 依赖 `<repo>/.venv/bin/python3` 绝对路径,不能直接分发给别人
- 真要做可分发版需要 PyInstaller 把 sidecar 打成单 binary(见路线图)

---

## 📁 项目结构

```
LocalScribe/
├── README.md                    本文档
├── CLI.md                       AI 工具调用 CLI 接口
├── PROJECT_BRIEF.md             项目需求文档
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
└── transcripts/                 自动保存的转录结果(每个音频一个子目录)
    ├── <stem1>/
    │   ├── <stem1>.txt / .srt / .json     转录原文
    │   ├── <stem1>_corrected.txt / ...     LLM 校对后
    │   ├── <stem1>_diff.txt                修改对比
    │   └── <stem1>_完整版.txt              整篇排版稿
    └── <stem2>-20260501-1610/              旧版本归档
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
- **5 路并发**:`ThreadPoolExecutor` 5 倍速,3 小时音频 ~10 分钟 → ~2 分钟
- **暂停/继续/取消**:reader 线程 + worker 池架构,校对中也能实时响应控制命令
- **失败隔离**:某批失败保留原文,不让一个错误拖垮整篇

### 截断检测

LLM 输出有 token 限制,超长内容会被截断。我们:
- 默认 `max_tokens=384000`(DeepSeek 上限)
- 检测 `finish_reason=="length"`,在文章页显示醒目警告
- 引导用户提高 max_tokens 重跑

---

## 🚧 路线图

- [x] MLX + faster-whisper 双后端
- [x] LLM 校对 + 排版
- [x] 5 路并发 + 暂停/取消
- [x] 历史库 + 重复检测
- [x] 4 层幻觉防御
- [x] CLI + JSON 协议
- [ ] **可分发版**(PyInstaller 打 sidecar)— 让别人不需要 .venv 也能用
- [ ] **首启 wizard**(模型下载 + ffmpeg 检测引导)
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
