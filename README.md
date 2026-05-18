# IINA Realtime Speech Translator

一个用于 macOS 版 [IINA](https://iina.io/) 的实时语音翻译插件。它不依赖现成字幕文件，而是按播放时间切出短音频片段，先做语音转写，再把转写结果翻译并叠加显示在视频底部。

## 功能

- 支持本地 Whisper helper：用 `ffmpeg` 连续读取音频流，并用 `faster-whisper` 做窗口式低延迟转写。
- 保留旧的 cloud-api 模式：切出短音频并上传到语音转写接口。
- 支持 OpenAI 兼容的 speech-to-text 和 chat completions 接口。
- 支持自定义 API URL、API Key、转写模型、翻译模型、源语言和目标语言。
- 支持显示识别出的原文加译文，或只显示译文。
- 处理中不会显示 `Listening`、`Translating` 等状态文字，只保留上一条译文直到新译文到达。
- 提供 IINA 插件菜单开关，快捷键 `Ctrl+Alt+t`。

## 安装

必须先确保本机有命令行版 `ffmpeg`。插件依赖它从当前视频/音频中抽取短音频片段：

```sh
brew install ffmpeg
```

Apple Silicon Mac 上 Homebrew 通常会安装到：

```text
/opt/homebrew/bin/ffmpeg
```

Intel Mac 上通常是：

```text
/usr/local/bin/ffmpeg
```

如果 IINA 插件提示找不到 `ffmpeg`，请在插件偏好设置里的 `ffmpeg path` 手动填写上面的完整路径。

下载或打包 `realtime-speech-translator.iinaplgz`，然后在 IINA 中打开：

```text
Settings > Plugins > Install Plugin
```

开发调试时，也可以把源码目录软链接到 IINA 插件目录：

```sh
ln -s /path/to/realtime-translator.iinaplugin "$HOME/Library/Application Support/com.colliderli.iina/plugins/realtime-translator.iinaplugin-dev"
```

## 配置

### 本地低延迟 ASR 模式

先安装 helper 依赖：

```sh
python3 -m pip install -r helper/requirements.txt
```

启动本地 ASR helper：

```sh
python3 helper/local_asr_helper.py
```

然后在插件偏好设置里使用：

- `ASR backend`：`local-helper`
- `Local helper URL`：`http://127.0.0.1:8765`
- `Local ASR model`：`base`，更低延迟可用 `tiny`，更高准确率可用 `small`
- `Local ASR window seconds`：默认 `2`
- `Local ASR stride seconds`：默认 `0.7`
- `Local ASR dedupe ratio`：默认 `0.86`，降低可减少重复字幕，提高会更敏感
- `Local ASR emit cooldown, ms`：默认 `700`，控制新识别文本最短发出间隔

如果希望从 IINA 菜单启动 helper，把 `Local helper script path` 设置为 `helper/local_asr_helper.py` 的绝对路径，然后使用插件菜单里的 `Start Local ASR Helper`。

### 翻译接口

安装后进入：

```text
Settings > Plugins > Realtime Speech Translator > Preferences
```

填写以下配置：

- `API key`：你的接口密钥
- `ASR backend`：默认 `local-helper`；如需旧的云端转写模式，改成 `cloud-api`
- `ffmpeg path`：可留空自动检测；找不到时填 `/opt/homebrew/bin/ffmpeg` 或 `/usr/local/bin/ffmpeg`
- `Speech transcription URL`：例如 `https://api.openai.com/v1/audio/transcriptions`
- `Speech transcription model`：例如 `gpt-4o-mini-transcribe`
- `Chat translation URL`：例如 `https://api.openai.com/v1/chat/completions`
- `Chat translation model`：例如 `gpt-4o-mini`
- `Target language`：例如 `Simplified Chinese`
- `Source language`：默认 `auto`，也可以填 `en`、`ja`、`ko` 等语言代码
- `Audio chunk seconds`：默认 `2`，越低延迟越低，但识别稳定性也会下降
- `Poll interval, ms`：默认 `650`

## 打包

在项目根目录运行：

```sh
./package.sh
```

注意压缩包根目录必须直接包含 `Info.json`，不能再套一层文件夹。

## 工作原理

IINA 插件 API 不能直接拿到播放器内部的实时 PCM 音频流，所以插件采用外部工具方案：

1. 本地 helper 用 `ffmpeg` 从当前媒体持续输出 16kHz mono PCM。
2. helper 用 `faster-whisper` 对滑动窗口进行本地转写。
3. helper 对滑动窗口结果做去重、最小长度过滤和发出冷却。
4. IINA 插件轮询 helper 的 `/latest` 获取最新识别文本。
5. 插件调用 chat completions 接口翻译文本。
6. 使用 IINA overlay 把译文显示在视频上。

## 限制

- 这是近实时方案，延迟主要取决于音频片段长度、转写速度和翻译速度。
- 需要本机安装 `ffmpeg` 和 `curl`。
- 对 DRM、部分流媒体、IINA/mpv 无法直接交给 `ffmpeg` 读取的输入源可能不可用。
- 转写和翻译请求会发送到你配置的第三方 API，请自行确认音视频内容的隐私和服务条款风险。

## 常见问题

### 画面提示 OpenAI quota exceeded

这表示当前 API Key 对应的 OpenAI 项目没有可用额度，或账单/限额设置不允许继续调用。请检查 OpenAI billing、项目额度和 API Key，或者在插件偏好设置里切换到另一个兼容服务。

插件会在这种错误后短暂停止重试，避免把整段 API 错误铺满视频画面。

## License

MIT
