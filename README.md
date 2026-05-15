# IINA Realtime Subtitle Translator

一个用于 macOS 版 [IINA](https://iina.io/) 的实时字幕翻译插件。它会监听当前播放中的文本字幕，把每一行字幕发送到 OpenAI 兼容的 Chat Completions 接口，并把翻译结果叠加显示在视频底部。

## 功能

- 实时监听 IINA/mpv 当前字幕文本。
- 支持 OpenAI 兼容的 `/v1/chat/completions` 接口。
- 支持自定义 API URL、API Key、模型、源语言和目标语言。
- 支持显示原字幕加译文，或只显示译文。
- 播放期间缓存已翻译字幕，减少重复请求。
- 提供 IINA 插件菜单开关，快捷键 `Ctrl+Alt+t`。

## 安装

下载或打包 `realtime-subtitle-translator.iinaplgz`，然后在 IINA 中打开：

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
Settings > Plugins > Realtime Subtitle Translator > Preferences
```

填写以下配置：

- `OpenAI-compatible chat completions URL`：例如 `https://api.openai.com/v1/chat/completions`
- `API key`：你的接口密钥
- `Model`：例如 `gpt-4o-mini`
- `Target language`：例如 `Simplified Chinese`
- `Source language`：默认 `auto`

## 打包

在项目根目录运行：

```sh
cd realtime-translator.iinaplugin
zip -r ../realtime-subtitle-translator.iinaplgz .
```

注意压缩包根目录必须直接包含 `Info.json`，不能再套一层文件夹。

## 限制

这个插件依赖 mpv 的 `sub-text` 属性，所以只能翻译文本字幕，例如 SRT、ASS、内嵌文本字幕。PGS、DVD bitmap subtitle 等位图字幕不能直接读取和翻译。

翻译请求会发送到你配置的第三方 API，请自行确认字幕内容的隐私和服务条款风险。

## License

MIT

