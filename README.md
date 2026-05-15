# IINA Realtime Speech Translator

一个用于 macOS 版 [IINA](https://iina.io/) 的实时语音翻译插件。它不依赖现成字幕文件，而是按播放时间切出短音频片段，先做语音转写，再把转写结果翻译并叠加显示在视频底部。

## 功能

- 实时读取当前播放位置附近的音频片段。
- 使用本机 `ffmpeg` 抽取短音频，使用 `curl` 上传到语音转写接口。
- 支持 OpenAI 兼容的 speech-to-text 和 chat completions 接口。
- 支持自定义 API URL、API Key、转写模型、翻译模型、源语言和目标语言。
- 支持显示识别出的原文加译文，或只显示译文。
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

安装后进入：

```text
Settings > Plugins > Realtime Speech Translator > Preferences
```

填写以下配置：

- `API key`：你的接口密钥
- `ffmpeg path`：可留空自动检测；找不到时填 `/opt/homebrew/bin/ffmpeg` 或 `/usr/local/bin/ffmpeg`
- `Speech transcription URL`：例如 `https://api.openai.com/v1/audio/transcriptions`
- `Speech transcription model`：例如 `gpt-4o-mini-transcribe`
- `Chat translation URL`：例如 `https://api.openai.com/v1/chat/completions`
- `Chat translation model`：例如 `gpt-4o-mini`
- `Target language`：例如 `Simplified Chinese`
- `Source language`：默认 `auto`，也可以填 `en`、`ja`、`ko` 等语言代码

## 打包

在项目根目录运行：

```sh
./package.sh
```

注意压缩包根目录必须直接包含 `Info.json`，不能再套一层文件夹。

## 工作原理

IINA 插件 API 不能直接拿到播放器内部的实时 PCM 音频流，所以插件采用外部工具方案：

1. 定时读取 IINA/mpv 当前播放时间。
2. 调用 `ffmpeg` 从当前媒体中抽取刚播放过的几秒音频。
3. 调用 speech-to-text 接口得到转写文本。
4. 调用 chat completions 接口翻译转写文本。
5. 使用 IINA overlay 把译文显示在视频上。

## 限制

- 这是近实时方案，延迟主要取决于音频片段长度、转写速度和翻译速度。
- 需要本机安装 `ffmpeg` 和 `curl`。
- 对 DRM、部分流媒体、IINA/mpv 无法直接交给 `ffmpeg` 读取的输入源可能不可用。
- 转写和翻译请求会发送到你配置的第三方 API，请自行确认音视频内容的隐私和服务条款风险。

## License

MIT
