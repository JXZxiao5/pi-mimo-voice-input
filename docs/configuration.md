# 配置速查

编辑 `~/.pi/mimo-voice-zh.json`，参考 [简版 JSON 示例](../examples/mimo-voice-input.example.json)。复制示例后只需填写 `apiKey`；示例已开启口语整理并指定 `mimo-v2.6-flash`。未填写的字段自动使用默认值（若省略 `textCleanupEnabled`，则默认不启用整理）。JSON 不支持注释，以下说明不要复制进配置。

## 常用设置（括号内为默认值）

- `apiKey`（`""`）：MiMo 普通 API Key，用于语音识别及 MiMo 整理；不支持 Token Plan。
- `sttShortcut`（`"f8"`）：Pi 支持的快捷键字符串，例如 `"f8"`、`"f12"`、`"ctrl+shift+v"`；避免与其他快捷键冲突。
- `textCleanupEnabled`（`false`）：`true` / `false`，是否增加一次文本模型请求整理口语；失败保留原文，发送前请复核。

## 高级选项（通常无需填写）

以下选项不放入示例。默认值适合一般使用，仅在排查音频问题或有明确需求时调整。

- `sttEnabled`（`true`）：`true` / `false`，启用/关闭语音输入；关闭后仍可本地自检。
- `recordingMode`（Linux `"daemon"`，macOS `"legacy"`）：共享常驻采集或旧的逐次启动方式；常驻模式需要 Ubuntu/Linux 用户级 systemd、Python 3 和 libpulse，失败不自动降级。详见 [音频说明](audio.md)。
- `recordingBackend`（`"auto"`）：常驻模式支持 `"auto"` / `"parecord"`，均通过 libpulse 采集；旧模式还支持 `"arecord"` / `"sox"`。
- `recordingDevice`（`""`）：空字符串使用默认输入；也可填对应后端的设备名，见 [音频说明](audio.md)。
- `recordingWarmupMs`（`1000`）：高级预热时长，整数 `0`–`3000`，单位毫秒；不写入默认配置。可手动添加 `"recordingWarmupMs": 300` 缩短等待。常驻模式仅在后台初次连接或设备恢复时预热，不影响每次按 F8。旧模式就绪前累计采集该时长，停止后裁掉相同长度的开头，语音输入和自检均适用；`0` 仍等待实际音频到达，但不裁剪启动段。缩短预热可能受到设备启动不稳定影响，请用 `/voice-test` 回听确认，等红灯后再说话。
- `recordingProcessing`（`"none"`）：`"none"` 原始采集，或 `"webrtc"` 音频处理；后者仅支持 Linux `parecord`，需音频服务支持。
- `vadEnabled`（`true`）：`true` / `false`，是否本地检测并裁剪人声；关闭后跳过 VAD，自检不受此项影响。
- `vadThreshold`（`0.5`）：大于 `0`、小于 `1` 的数字；越低越容易判为人声。
- `cleanupModel`（`"mimo-v2.6-flash"`）：可选 `"mimo-v2.6-flash"`、`"mimo-v2.6-pro"`、`"mimo-v2.6-pro-ultraspeed"`。
- `cleanupTimeoutMs`（`5000`）：整理超时，整数 `100`–`30000`，单位毫秒。

## 怎么设置

- **只用 MiMo 识别**：只填 `apiKey`，其余省略即可。
- **增加 MiMo 整理**：再设 `textCleanupEnabled: true`，默认整理模型即可。

修改文件后执行 `/reload`；常驻模式的设备、后端、音频处理、预热配置变更还需显式 `/voice-daemon restart`，其他会话不会偷偷改变后台配置。如果修改环境变量，重启 Pi。不要提交真实 Key，可用 `chmod 600 ~/.pi/mimo-voice-zh.json` 限制读取权限。

升级时无需用示例覆盖旧配置：缺失字段自动使用默认值，已有文件不会自动补写新字段。只合并需要调整的字段即可。
