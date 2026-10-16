# pi-mimo-voice-input

简体中文 | [English](README.en.md)

为 [Pi coding agent](https://github.com/earendil-works/pi) 打造的**轻量级中文语音输入扩展**，基于小米 MiMo，支持 Ubuntu/Linux 和 macOS，安装后直接在 Pi 中使用。

**基本开箱即用：安装扩展和本机录音工具后，只需填入一个 MiMo API Key，其他配置保持默认即可。**

- **轻量集成**：无需 Python、GPU 或自建语音识别服务；本地人声检测模型随依赖安装，无需手动下载。
- **默认就能用**：按 `F8` 开始录音，再按一次完成转写，文字自动追加到 Pi 编辑器，不会自动发送。
- **功能按需开启**：默认启用本地 Silero VAD，内置录音自检；口语整理和 PulseAudio WebRTC 录音处理均为可选功能。

仅提供语音输入，不包含 AI 回复语音播放。

## 1. 为什么选择 MiMo？

- **成本低，适合日常高频使用**：语音输入通常是短句、多次调用；MiMo 较低的模型调用成本，以及 Flash 处理短文本的低开销，适合把语音作为日常输入方式。
- **语音识别和文本模型配套**：MiMo 既有语音识别模型，也有 Flash 文本模型，使用同一个普通 API Key 就能串起“录音 → 转写 → 口语清洗”，无需再接入另一家模型服务。
- **Flash 足够快，可以直接做口语清洗**：默认整理模型 `mimo-v2.6-flash` 可直接处理语气词、重复表达、标点断句和明确的自我纠正，适合在转写后紧接着整理文本，再写入编辑器草稿。

实际费用以 [MiMo 官方定价](https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go) 为准，耗时会随网络、文本长度和服务负载变化。
口语整理默认关闭，按需开启；结果仍需人工复核。

## 2. 安装

需要 [Pi](https://github.com/earendil-works/pi) 和 Node.js ≥ 22.19。先安装本机录音工具：

```bash
# Ubuntu / Debian
sudo apt install pulseaudio-utils alsa-utils
# macOS
brew install sox
```

推荐直接通过 npm 安装，无需克隆仓库或手动编译（[npm 包](https://www.npmjs.com/package/pi-mimo-voice-input)）：

```bash
pi install npm:pi-mimo-voice-input
```

本地安装 / 开发（普通使用可跳过）：

```bash
git clone https://github.com/JXZxiao5/pi-mimo-voice-input.git
cd pi-mimo-voice-input
npm ci --ignore-scripts --legacy-peer-deps
pi install "$PWD"
```

不要同时加载本地版本与 npm 版本；切换前用 `pi remove <原安装来源>` 移除旧声明（旧包为 `npm:pi-mimo-voice-zh`）。

## 3. 配置：只需 API Key

从 [MiMo 控制台](https://platform.xiaomimimo.com) 获取普通 API Key（不支持 Token Plan），
创建或编辑 `~/.pi/mimo-voice-zh.json`（沿用旧文件名以兼容已有配置）。**只需填写 `apiKey`，无需复制完整配置：**

```json
{
  "apiKey": "YOUR_MIMO_API_KEY"
}
```

运行 `chmod 600 ~/.pi/mimo-voice-zh.json` 保护凭据，然后在 Pi 中执行 `/reload`，按 `F8` 即可开始语音输入。
不要将真实配置提交到 Git。

以下设置均为可选，不配置也可正常使用：

- `sttShortcut`：录音快捷键，默认 `f8`。
- `textCleanupEnabled`：启用口语整理，默认关闭；设为 `true` 后增加一次 MiMo 文本请求，失败或超时保留原文。
- 其他选项使用默认值，完整配置见 [配置示例](examples/mimo-voice-input.example.json)。

## 4. 使用

- **`F8` 或 `/voice`**：开始录音，再次操作则停止并识别。等待“可以说话了”提示后再说话；部分键盘需按 `Fn+F8`。
- **`/voice-test`**：本地录音自检，再次运行停止并回听，最多录制 10 秒；回放中再次运行可停止回放。
- **`/voice-status`**：查看设备、录音检测和口语整理状态。
- **`/voice-raw`**：恢复最近一次整理前的原文；草稿已修改或发送时不覆盖，退出或重载后不可恢复。
- **`/reload`**：重新加载代码和配置。

识别结果追加到编辑器，保留已有草稿，**不会自动发送**。启用口语整理后允许改写，发送前请人工复核。
录音发送给 MiMo；启用整理时还会发送转写文本。自检完全本地，不调用 API。

更多说明：[录音与排查](docs/audio.md) · [口语整理](docs/text-cleanup.md) · [开发与发布](docs/development.md) · [更新日志](CHANGELOG.md) · [MIT](LICENSE)
