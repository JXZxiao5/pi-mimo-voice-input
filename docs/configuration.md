# 配置速查

编辑 `~/.pi/mimo-voice-zh.json`，参考 [简版 JSON 示例](../examples/mimo-voice-input.example.json)。复制示例后只需填写 `apiKey`；示例已开启口语整理并指定 `mimo-v2.6-flash`。未填写的字段自动使用默认值（若省略 `textCleanupEnabled`，则默认不启用整理）。JSON 不支持注释，以下说明不要复制进配置。

## 常用设置（括号内为默认值）

- `apiKey`（`""`）：MiMo 普通 API Key，用于语音识别及 MiMo 整理；不支持 Token Plan。
- `sttShortcut`（`"f8"`）：Pi 支持的快捷键字符串，例如 `"f8"`、`"f12"`、`"ctrl+shift+v"`；避免与其他快捷键冲突。
- `textCleanupEnabled`（`false`）：`true` / `false`，是否增加一次文本模型请求整理口语；失败保留原文，发送前请复核。

## 高级选项（通常无需填写）

以下选项不放入示例。默认值适合一般使用，仅在排查音频问题或有明确需求时调整。

- `sttEnabled`（`true`）：`true` / `false`，启用/关闭语音输入；关闭后仍可本地自检。
- `recordingBackend`（`"auto"`）：`"auto"` / `"parecord"` / `"arecord"` / `"sox"`；通常自动选择即可。
- `recordingDevice`（`""`）：空字符串使用默认输入；也可填对应后端的设备名，见 [音频说明](audio.md)。
- `recordingProcessing`（`"none"`）：`"none"` 原始采集，或 `"webrtc"` 音频处理；后者仅支持 Linux `parecord`，需音频服务支持。
- `vadEnabled`（`true`）：`true` / `false`，是否本地检测并裁剪人声；关闭后跳过 VAD，自检不受此项影响。
- `vadThreshold`（`0.5`）：大于 `0`、小于 `1` 的数字；越低越容易判为人声。
- `cleanupModel`（`"mimo-v2.6-flash"`）：可选 `"mimo-v2.6-flash"`、`"mimo-v2.6-pro"`、`"mimo-v2.6-pro-ultraspeed"`。
- `cleanupTimeoutMs`（`5000`）：整理超时，整数 `100`–`30000`，单位毫秒。

## 怎么设置

- **只用 MiMo 识别**：只填 `apiKey`，其余省略即可。
- **增加 MiMo 整理**：再设 `textCleanupEnabled: true`，默认整理模型即可。

修改文件后执行 `/reload`；如果修改环境变量，重启 Pi。不要提交真实 Key，可用 `chmod 600 ~/.pi/mimo-voice-zh.json` 限制读取权限。

升级时无需用示例覆盖旧配置：缺失字段自动使用默认值，已有文件不会自动补写新字段。只合并需要调整的字段即可。
