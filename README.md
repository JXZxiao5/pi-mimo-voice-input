# pi-mimo-voice-zh

小米 MiMo 中文语音输入扩展，支持 Ubuntu/Linux 和 macOS。
基于 [mlosun/pi-mimo-voice-zh](https://github.com/mlosun/pi-mimo-voice-zh) 修改；此本地版本仅提供语音输入和录音自检，不自动播放 AI 回复。
目前使用 MiMo API Key，不支持 Token Plan。

## 使用

在 Pi 聊天输入框操作：

- `/voice`：开始录音；再次运行则停止并识别。
- `F8`：与 `/voice` 相同，按一次开始录音，再按一次停止并识别；可通过配置修改。
- `/voice-test`：本地录音自检；再次运行则停止、显示电平并回听。录音最多 10 秒，回放中再次运行可停止回放。
- `/voice-status`：查看录音后端、处理方式、实际输入设备、端口、静音、硬件增益和最近录音质量，不显示 Key。
- `/reload`：加载代码或配置变更。

识别结果追加到编辑器，不覆盖已有草稿，也不会自动发送。
### 快捷键兼容性

默认使用 `F8`：多数终端可以直接发送该功能键，传统终端编码也可识别，不依赖特定终端、物理修饰键映射或增强键盘协议；Pi 默认快捷键也未占用它。
部分笔记本/macOS 键盘需要按 `Fn+F8`，以免触发系统媒体功能。若终端、IDE 或其他扩展占用了 F8，可自定义 `sttShortcut`，也可始终使用 `/voice`。
不建议使用 `Ctrl+Shift+V`：很多终端将其拦截为粘贴，传统终端还可能无法区分 Ctrl 与 Ctrl+Shift。
经终端代理或 tmux 时，仍需保证它能转发 F8。

已有配置中的 `sttShortcut` 会保留，不会自动覆盖。要改用新默认值，在 `~/.pi/mimo-voice-zh.json` 中设为 `"sttShortcut": "f8"`（或删除该字段），然后运行 `/reload`。
若曾配置终端专用的右 Alt 映射，可将该映射删除；本包不需要修改终端或系统键盘配置。

## 安装本地版本

此版本尚未发布到上游 npm/GitHub 包，需安装本地仓库目录；不要同时加载上游原版。

```bash
# Ubuntu / Debian：已有工具时可跳过
sudo apt install pulseaudio-utils alsa-utils
# macOS：
brew install sox

# 移除原有上游声明（如已安装），改为本地目录
pi remove npm:pi-mimo-voice-zh
pi install /absolute/path/to/pi-mimo-voice-zh
```

已有 `~/.pi/mimo-voice-zh.json` 时保留配置。首次使用可复制 `mimo-voice-zh.example.json`，将 `apiKey` 设为自己的 MiMo API Key，并限制文件权限为 `0600`。
获取 Key：[MiMo 控制台](https://platform.xiaomimimo.com)。

启动 Pi 后，在聊天输入框运行 `/reload`。状态栏显示“🎤 语音输入就绪”表示已加载。
本地安装直接加载仓库文件，不会复制代码；保留该目录，也不会被上游包更新覆盖。

## 配置

`~/.pi/mimo-voice-zh.json`：

```json
{
  "apiKey": "sk-...",
  "sttEnabled": true,
  "sttShortcut": "f8",
  "recordingBackend": "auto",
  "recordingDevice": "",
  "recordingProcessing": "none"
}
```

- `apiKey`：MiMo API Key。
- `sttEnabled`：语音输入开关；关闭后仍可进行本地录音自检。
- `sttShortcut`：开始/停止语音输入的快捷键，默认 `f8`。
- `recordingBackend`：`auto`、`parecord`、`arecord` 或 `sox`；macOS 仅支持 sox。
- `recordingDevice`：空字符串使用默认麦克风；parecord 可填 PulseAudio source 名，arecord 可填 ALSA PCM 名。
- `recordingProcessing`：`none`（兼容默认值）或 `webrtc`；后者需要 Linux PulseAudio + parecord。

## 录音和本地回听

Linux 优先使用 `parecord` 录音；缺少可执行文件时回退到 `arecord` 或 `sox`。
自检回听使用 `paplay`，缺少时回退到 `aplay` 或 `ffplay`。
macOS 使用 sox 录音、系统 afplay 回听。Windows 暂不支持。

录音/音频服务在运行 Pi 的宿主机上使用，不要放到没有声卡和桌面音频服务的 Docker 容器中。
SSH 场景录制的是运行 Pi 那台主机的麦克风，不是 SSH 客户端的麦克风。

## Ubuntu WebRTC 处理

如果浏览器录音正常，而命令行原始录音存在直流偏移、噪声或失真，不要直接断定麦克风损坏。
浏览器的 `getUserMedia` 通常包含 WebRTC 处理，例如 webcammictest 默认开启回声消除、降噪和自动增益，和直接用 parecord 录音不是同一条处理链路。

在配置中设为 `"recordingProcessing": "webrtc"`，然后 `/reload` → `/voice-test` 回听 → `/voice` 测试识别。

扩展通过 PulseAudio 的 `module-echo-cancel` / WebRTC 引擎建立本次录音私有的虚拟输入，启用高通、降噪和数字增益，再生成上传的 PCM WAV。
这是与浏览器同类的处理方式，不保证与 Chrome 的完整链路完全一致；仍需实际说话确认准确率。

- 关闭硬件模拟 AGC 和主设备音量共享，不修改默认输入/输出、系统麦克风音量或硬件 Capture/Boost。
- 正常停止、异常退出和会话关闭时卸载本次虚拟源，不卸载用户已有的其他音频模块。
- 需要 `pactl`、`module-echo-cancel` 和 `libwebrtc_audio_processing`；当前 Ubuntu 机器已有这些组件。
- PipeWire 的兼容层未必支持这个模块；不支持时明确报错，不悄悄回退，可手动改为 `"recordingProcessing": "none"`。

## 麦克风排查

```bash
pactl info
pactl list short sources
# 默认输入应是实际麦克风，不是以 .monitor 结尾的系统声音源
pactl set-default-source <麦克风source名>
pactl set-source-mute @DEFAULT_SOURCE@ 0
```

在 Ubuntu 声音设置的“输入”中检查设备和输入音量。
若 parecord 存在但无法连接音频服务，会报告 stderr，不会静默切换到另一设备。
纯 ALSA 环境可指定 `recordingBackend: "arecord"`、合适的 `recordingDevice` 和 `recordingProcessing: "none"`。

空转写或识别不准时：

1. `/voice-test` 开始录音，等约半秒让设备开始采集，再正常说话。
2. 再次 `/voice-test` 停止，查看电平、削波和 DC 偏移，并回听是否清楚、有无杂音或漏字。
3. `/voice-status` 查看实际输入端口、Capture/Mic Boost 和最近检测结果。
4. 浏览器正常而原始录音异常时，先尝试 WebRTC 处理；浏览器和处理后的录音都异常时，再排查输入设备和增益。

自检完全在本地，不调用 MiMo、不需要 Key、不修改编辑器或系统音量；音频结束后删除。
严重削波、严重直流偏移、接近静音或不足 0.25 秒的录音不会上传，也不会自动回放异常信号。
电平稍低仅提示，不拒绝；电平检测不是语音活动检测，也不保证人声清楚。
空转写错误会附带录音指标和 `finish_reason`，不直接归因于麦克风。

## API 和隐私

根据 [MiMo 语音识别文档](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/Speech-Recognition)：
使用 `mimo-v2.5-asr`、`/v1/chat/completions`，将 WAV 以 `data:audio/wav;base64,...` 传入 `input_audio.data`，并指定 `asr_options.language: "zh"`。

- 录音为 16 kHz / 单声道 / 16-bit PCM WAV；停止时等待录音进程完成文件写入。
- Base64 编码后最大 10 MB，上传前检查；语音输入最多 3 分钟，到时自动停止识别。
- 音频发送到 MiMo API，费用以 [MiMo 定价](https://mimo.mi.com/#/docs/pricing) 为准。
- 临时录音在识别完成、失败或会话关闭后删除；Key 不出现在诊断或错误信息中。
- API 请求有 30 秒超时，退出/reload 时取消请求并停止录音和本地回听。
- 中英混合和专有名词仍可能误写，不添加官方文档未确认的“热词”参数。

## 状态栏

- 🎤 语音输入就绪：等待开始录音。
- 🎤 ASR 已关闭：语音输入禁用，仍可本地自检。
- 🔴 正在录音：语音输入或本地自检采集中。
- 🎤 录音处理中：校验/识别录音。
- 🔊 麦克风录音回放：本地自检回听，可再次 `/voice-test` 停止。

## 开发验证

```bash
npm install --ignore-scripts --legacy-peer-deps
npm test
npm pack --dry-run
```

测试使用假录音/回听进程和 Mock API，不读取真实 Key、不录制实际麦克风、不产生 API 用量。
覆盖 ASR 请求与取消、平台后端、WAV/Base64 校验、电平/削波/DC、本地自检不上传、回听打断与退出清理、输入设备诊断、WebRTC 私有源与初始化竞态、重复操作和草稿保留、默认 F8 与自定义快捷键。
