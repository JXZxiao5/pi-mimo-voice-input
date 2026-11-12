# 录音与麦克风排查

[返回 README](../README.md)

## Ubuntu 常驻录音（默认）

Linux 默认 `recordingMode: "daemon"`：第一次打开交互式 Pi 时启动一份用户级
`pi-mimo-voice.service`，多个 Pi 会话共用它。关闭 Pi 不停止采集；桌面注销或关机时停止，
不设置登录自启、不需要 root。手动启动新的 Pi 会再次确保服务启动。

需要用户级 systemd、`/usr/bin/python3`、`libpulse0` 和 `pulseaudio-utils`：

```bash
sudo apt install python3 libpulse0 pulseaudio-utils
```

服务通过 libpulse 连接 PulseAudio 或 PipeWire 的 PulseAudio 兼容层，持续采集
16 kHz / 单声道 / 16-bit PCM。空闲时只保留约 3 秒内存缓冲，旧音频覆盖，不写磁盘、不上传。
只有初次连接和设备恢复需要预热；就绪后按 F8 即标记开始，再按 F8 标记结束。
使用 Linux 单调时钟及 PulseAudio 报告的采集延迟定位采样边界，不额外加入按键前音频；
精度仍受音频服务/硬件的时间戳精度影响，不承诺物理零延迟。停止时等待尾部音频到齐再裁剪。
仅圈定片段生成 WAV，交给原有本地检查、VAD 和上传流程；服务不持有 API Key。

- `/voice-daemon status`：查看就绪与占用状态，不自动启动服务。
- `/voice-daemon stop`：停止共享后台及麦克风采集，影响所有会话。
- `/voice-daemon restart`：按磁盘上的配置重启共享后台，取消所有未完成录音。
- `systemctl --user status pi-mimo-voice.service`、`journalctl --user -u pi-mimo-voice.service`：排查启动错误。

录音归发起会话所有；其他会话只能得到占用提示，不能停止或抢占它。所有者退出或连接断开，
丢弃未完成片段。设备异常、休眠后的时间轴跳变会取消当前录音并重新预热，状态栏显示未就绪。
后台自动重试音频连接；失败不自动退回旧模式。语音输入最长 3 分钟，自检最长 10 秒。

麦克风、处理方式、后端及预热配置由后台统一持有，配置不一致的会话拒绝连接。
修改这些配置或升级后台代码后，显式执行 `/voice-daemon restart`；其他会话必要时 `/reload`。
默认设备在连接时选定；修改系统默认输入后也请重启后台。

要恢复每次启动录音的行为，设置 `recordingMode: "legacy"` 后 `/reload`，并手动
`/voice-daemon stop` 关闭原后台。macOS 默认仍是 legacy，不受影响。
纯 ALSA 或无用户级 systemd 的环境请手动选择 legacy。

## 旧模式后端和录音就绪（legacy）

Linux 优先使用 `parecord`，缺少可执行文件时依次回退到 `arecord`、`sox`；
自检回听依次使用 `paplay`、`aplay`、`ffplay`。macOS 使用 sox 录音、系统 afplay 回听。
若 parecord 存在但无法连接音频服务，会明确报错，不会静默切换到另一设备。

按下快捷键后，状态栏立即显示静止的白色横线 `──────`，右侧快捷键保持原位。只有真实预热完成后，才切换为红色实心圆 `●` 和录音计时。
默认确认 WAV 音频数据区已经累计写入 **1 秒音频**后，才显示“● 0:00 · F8”（自检时为 `/voice-test`），此时可以说话。
预热用于设备唤醒和音频处理适应，期间保持同一个录音进程，不重启麦克风。高级用户可通过 [`recordingWarmupMs`](configuration.md) 调整等待及裁剪时长；省略时仍为 1 秒，默认配置不包含此项。
停止后会先去掉预热段，再进行质量检测、自检回放或语音识别；预热段不会上传。
录音时长从预热完成后开始计算；正常进度不再重复弹出通知。
静音数据也计入预热，不需要先说话；只有 WAV 头或元数据不算。

录音进程启动后 5 秒仍未收到音频数据会报错并清理本次资源，不上传音频。
启动中重复操作不会启动第二个录音进程，也不会重复弹出进度提示。
自检 10 秒和语音输入 3 分钟的时限从就绪后开始计算，不包含等待设备启动的时间。

## 本地自检

1. 运行 `/voice-test`，等待状态栏出现“● 0:00 · /voice-test”，再正常说话。
2. 再次运行 `/voice-test`，查看电平、削波和 DC 偏移，并回听有无杂音或漏字。
3. 用 `/voice-status` 查看实际输入端口、Capture/Mic Boost 和最近检测结果。
4. 浏览器正常而原始录音异常时，尝试 WebRTC；浏览器和处理后录音都异常时，再排查设备和增益。

自检不执行 VAD；常驻模式仅取标记区间，旧模式去掉配置的预热段（默认 1 秒）。不调用 API、不需要 Key、不改动草稿或系统音量；回放结束后删除音频。
严重削波、严重直流偏移、接近静音或不足 0.25 秒的录音不会上传，也不会自动回放异常信号。
电平稍低仅提示，不拒绝；电平检测不是 VAD，也不保证人声清楚。
空转写错误会附带录音指标和 `finish_reason`，不直接归因于麦克风。

## 本地 VAD 与静音裁剪

默认启用 Silero v5 ONNX + CPU WebAssembly。模型随 npm 依赖安装，运行时完全离线，
无需 Python、FFmpeg、CUDA 或额外原生库。

- 没有有效人声：提示“未检测到有效人声，未上传”，不调用 MiMo、不改动草稿，删除临时录音并恢复就绪状态。
- 有人声：裁去头尾静音；句内短暂停顿保留，连续静音达到约 `900ms` 才切段。
- 每段前后保留 `200ms` 缓冲，段间补 `120ms` 静音，再合并成完整 WAV，一次上传，不拆成多个 ASR 请求。
- 至少累计 `128ms` 超过阈值的人声帧才接受一段，避免瞬时噪声被缓冲放大。
- 极短、轻声的“好/嗯”仍可能漏检；可调整 `vadThreshold`，必要时关闭 VAD 对比。
- `/voice-status` 显示最近检测的段数、上传时长和裁剪时长。初始化或推理失败会停止上传，不悄悄回退到原始录音。

VAD 不是说话人识别或降噪器，背景人声也可能通过。它可以和 WebRTC 同时启用：前者判断/裁剪语音区间，后者改善录音信号。

## Ubuntu WebRTC 处理

浏览器录音正常而命令行原始录音有噪声、直流偏移或失真，不代表麦克风损坏。
浏览器 `getUserMedia` 通常包含 WebRTC 回声消除、降噪和自动增益，与直接用 parecord 录音不同。

设置 `"recordingProcessing": "webrtc"`，然后常驻模式执行 `/voice-daemon restart`（旧模式 `/reload`），再 `/voice-test` 回听 → `/voice` 测试。
扩展通过 PulseAudio 的 `module-echo-cancel` / WebRTC 引擎建立私有虚拟输入，启用高通、降噪和数字增益。
这与浏览器处理同类，但不保证和 Chrome 的完整链路完全一致，仍需实际说话验证。

- 关闭硬件模拟 AGC 和主设备音量共享，不修改默认输入/输出、系统麦克风音量或硬件 Capture/Boost。
- 常驻模式保留处理源至后台停止；旧模式在录音结束或会话关闭时卸载。只清理扩展自己的模块。
- 需要 Linux parecord、pactl、`module-echo-cancel` 和 `libwebrtc_audio_processing`。
- PipeWire 的兼容层未必支持该模块；不支持时明确报错，不静默回退。可手动改为 `"recordingProcessing": "none"`。

## 输入设备排查

```bash
pactl info
pactl list short sources
# 默认输入应是实际麦克风，而不是以 .monitor 结尾的系统声音源
pactl set-default-source <麦克风source名>
pactl set-source-mute @DEFAULT_SOURCE@ 0
```

在 Ubuntu 声音设置的“输入”中检查设备和音量。以上修改系统配置的命令由用户按需手动执行，扩展不会自动执行。
纯 ALSA 环境使用 `recordingMode: "legacy"`，可指定 `recordingBackend: "arecord"`、合适的 `recordingDevice` 和 `recordingProcessing: "none"`。

## 状态栏

只在状态栏显示当前阶段，使用小符号、主题色和简短文案，不加背景色块或闪烁：

- `○ 语音 · F8`：等待开始录音，整体弱化；快捷键跟随 `sttShortcut` 配置。
- `○ 关闭 · F8`：语音输入禁用，仍可本地自检。
- 白色横线 `────── · F8`：正在启动及预热，只有真实就绪才出现红点和计时，此前请等待。
- `● 0:12 · F8`：录音中，可以说话（常驻模式不重复预热）；每秒更新时长，再按 F8 停止。
- `● 0:05 · /voice-test`：本地自检录音，不上传音频，再运行 `/voice-test` 停止。
- `◜ 识别 · F8`：校验、VAD 或识别录音。
- `◜ 整理 · F8`：等待文本模型整理全文；失败或超时保留原文。
- `▷ 回放 · /voice-test`：本地自检回听，再运行 `/voice-test` 停止。

默认 F8 状态栏仅占 11 列，没有尾部占位；两字标签与 `M:SS` 计时等宽，空闲、预热、录音和处理阶段的快捷键位置保持一致。预热使用静止的标准 ANSI 白色横线，录音使用主题红色实心圆，形状和计时共同区分阶段，不依赖真彩色渐变。启动阶段不再播放移动动画，不改变录音等待时间。识别和整理继续使用轻量转圈动画。
正常进度、成功的 VAD 裁剪详情和转写预览不再出现在聊天框上方；识别结果直接追加到编辑器，仍不会自动发送。
未检出人声、失败、异常录音和主动自检结果仍显示通知，完整设备/VAD/整理诊断通过 `/voice-status` 查看。
启用口语整理后，发送前请复核；需要时可用 `/voice-raw` 恢复原文。
