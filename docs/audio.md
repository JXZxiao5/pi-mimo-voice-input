# 录音与麦克风排查

[返回 README](../README.md)

## 后端和录音就绪

Linux 优先使用 `parecord`，缺少可执行文件时依次回退到 `arecord`、`sox`；
自检回听依次使用 `paplay`、`aplay`、`ffplay`。macOS 使用 sox 录音、系统 afplay 回听。
若 parecord 存在但无法连接音频服务，会明确报错，不会静默切换到另一设备。

启动时先显示“⏳ 麦克风启动中”，完成输入设备检查和可选 WebRTC 初始化。
确认 WAV 音频数据区已经写入完整 PCM 帧后，才显示“🔴 正在录音”并提示“可以说话了”。
静音数据也能触发就绪，不需要先说话；只有 WAV 头或元数据不算就绪。

录音进程启动后 5 秒仍未收到音频数据会报错并清理本次资源，不上传音频。
启动中重复操作只提示等待，不会启动第二个录音进程。
自检 10 秒和语音输入 3 分钟的时限从就绪后开始计算，不包含等待设备启动的时间。

## 本地自检

1. 运行 `/voice-test`，等待“可以说话了”，再正常说话。
2. 再次运行 `/voice-test`，查看电平、削波和 DC 偏移，并回听有无杂音或漏字。
3. 用 `/voice-status` 查看实际输入端口、Capture/Mic Boost 和最近检测结果。
4. 浏览器正常而原始录音异常时，尝试 WebRTC；浏览器和处理后录音都异常时，再排查设备和增益。

自检不执行 VAD、不裁剪录音、不调用 API、不需要 Key、不改动草稿或系统音量；回放结束后删除音频。
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

设置 `"recordingProcessing": "webrtc"`，然后 `/reload` → `/voice-test` 回听 → `/voice` 测试。
扩展通过 PulseAudio 的 `module-echo-cancel` / WebRTC 引擎建立本次录音私有的虚拟输入，启用高通、降噪和数字增益。
这与浏览器处理同类，但不保证和 Chrome 的完整链路完全一致，仍需实际说话验证。

- 关闭硬件模拟 AGC 和主设备音量共享，不修改默认输入/输出、系统麦克风音量或硬件 Capture/Boost。
- 正常停止、异常退出或会话关闭时，只卸载本次临时源，不影响用户已有模块。
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
纯 ALSA 环境可指定 `recordingBackend: "arecord"`、合适的 `recordingDevice` 和 `recordingProcessing: "none"`。

## 状态栏

- 🎤 语音输入就绪：等待开始录音。
- 🎤 ASR 已关闭：语音输入禁用，仍可本地自检。
- ⏳ 麦克风启动中：检查设备/初始化，尚未确认收到音频数据。
- 🔴 正在录音：已收到音频数据，可以说话；也用于本地自检。
- 🎤 录音处理中：校验、VAD 或识别录音。
- ✍️ 口语清洗中：等待 MiMo 整理全文；失败或超时保留原文。
- 🔊 麦克风录音回放：本地自检回听，可再次 `/voice-test` 停止。
