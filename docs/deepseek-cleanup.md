# 使用 DeepSeek 整理口语

语音识别仍使用 MiMo；只将转写文本（不含录音或会话历史）发送给 DeepSeek。默认配置不变，需显式启用。

在启动 Pi 的终端设置 `DEEPSEEK_API_KEY`，然后在 `~/.pi/mimo-voice-zh.json` 中合并以下配置（保留现有 MiMo `apiKey`）：

```json
{
  "textCleanupEnabled": true,
  "cleanupModel": "deepseek-flash",
  "cleanupTimeoutMs": 5000
}
```

重启 Pi 以加载环境变量与配置。DeepSeek 不会复用 MiMo Key；缺少 Key 或请求失败时保留原文。也支持 `deepseek-v4-pro`。始终关闭思考、不使用工具、不自动重试；整理结果需要人工复核。

## 在线试验

```bash
npm run test:cleanup-live -- --model deepseek-flash --timeout-ms 10000 --limit 5
```

需要先设置 `DEEPSEEK_API_KEY`。此命令发送合成口语样本并产生 API 费用，输出清洗结果、关键内容断言、耗时和 token 用量；不读取录音或会话历史。DeepSeek 价格未硬编码，费用字段不提供估算，不能将汇总的零值视为免费。

实现依据：https://api-docs.deepseek.com/zh-cn/ 。使用 `https://api.deepseek.com/chat/completions`、Bearer 认证、`thinking: {"type":"disabled"}` 和 `max_tokens`。
