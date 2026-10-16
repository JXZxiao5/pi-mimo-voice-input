# 开发与发布

[返回 README](../README.md)

## 仓库结构

```text
pi-mimo-voice-input/
├── index.ts                 # 稳定扩展入口，仅转发实现
├── src/
│   ├── extension.ts         # Pi 命令、配置、录音/识别生命周期
│   ├── audio.ts             # 录音/回放后端、进程管理、WAV 校验
│   ├── diagnostics.ts       # 电平与输入设备诊断
│   ├── webrtc.ts            # PulseAudio 私有 WebRTC 录音源
│   ├── vad.ts               # 本地 Silero VAD 与静音裁剪
│   ├── mimo.ts              # MiMo ASR 与脱敏错误
│   ├── cleanup.ts           # MiMo 口语整理请求、超时与用量
│   └── cleanup-prompt.ts    # 当前整理提示词
├── examples/                # 无凭据配置示例
├── docs/                    # 录音、文本整理及开发文档
├── scripts/                 # 显式在线验证脚本，不进入 npm 包
├── test/
│   ├── *.test.cjs           # 单元、集成和发布包测试
│   └── support/             # 假推理后端、WAV/进程辅助函数
├── README.md                # 中文安装与使用说明
├── README.en.md             # 英文安装与使用说明
├── CHANGELOG.md             # 版本变更记录
├── LICENSE
├── package.json
└── package-lock.json
```

Pi 通过 `package.json` 的 `pi.extensions` 加载根目录 `index.ts`，不需要构建步骤。
保留此入口可兼容本地目录安装和 `pi --extension ./index.ts`；实现代码统一放在 `src/`。
项目包名为 `pi-mimo-voice-input`；本地仓库目录不要求改名，安装时使用实际路径。
GitHub 仓库为 [JXZxiao5/pi-mimo-voice-input](https://github.com/JXZxiao5/pi-mimo-voice-input)，`repository.url` 已同步。
为兼容已有用户，配置路径仍为 `~/.pi/mimo-voice-zh.json`，无须迁移 Key 或偏好设置。

## 离线测试

```bash
npm ci --ignore-scripts --legacy-peer-deps
npm test
npm pack --dry-run
```

测试使用假录音/回放进程和 Mock API，不读取真实 Key，不录音，不产生 API 用量。
测试覆盖录音就绪/超时、平台后端、WAV/Base64、草稿保留、自检、设备诊断、WebRTC 竞态与资源清理，
以及 VAD 过滤/裁剪/失败关闭、MiMo 请求/取消/隐私、自然口语整理回退及原文恢复。
另有真实 Silero CPU/WASM 离线测试，验证静音和持续测试音不会被当作人声。
Mock 测试不能证明真实文本模型总能保持原意。

`test/package.test.cjs` 生成实际 tarball，校验发布白名单、示例中无 Key、清单与锁文件版本一致，
并在没有开发依赖的临时目录通过 Node.js 原生 TypeScript 加载包入口。
`npm pack` / `npm publish` 的 `prepack` 自动运行离线测试；包测试内部使用 `--ignore-scripts` 避免递归。

## 显式在线测试

以下命令需要真实 Key，会发送合成文本并产生少量费用；不属于 `npm test`：

```bash
npm run test:cleanup-live
npm run test:cleanup-live -- --limit 5
npm run test:cleanup-live -- --model mimo-v2.6-pro
npm run test:cleanup-live -- --timeout-ms 15000
```

脚本仅发送内置 12 条合成文本，可用 `--limit` 减少；不读录音或会话历史。
优先读取 `MIMO_API_KEY`，否则只取 `~/.pi/mimo-voice-zh.json` 的 `apiKey`，不打印凭据。
输出整理全文供人工复核，并报告样本关键内容断言、完整响应耗时、tokens、估算费用和小样本中位数/P95。
这些断言不是生产校验或语义等价证明，小样本 P95 也不是服务延迟保证。
断言失败、超时或异常时退出码非零；认证/额度/限流错误会停止后续请求。
超时或无 usage 的请求费用可能未计入估算。

## npm 发布流程

首版 [`pi-mimo-voice-input@0.1.0`](https://www.npmjs.com/package/pi-mimo-voice-input) 已发布。
`publishConfig` 已指定公共 registry `https://registry.npmjs.org/` 和公开访问；不需要向 Pi 主仓库提交扩展代码。
`pi-package` 关键词让包具备被 Pi Gallery 发现的资格，索引并非即时。

后续发布时，先更新版本号和锁文件，完成下方检查，再由维护者手动执行（已发布版本不能覆盖）：

```bash
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
# 仅预检，不上传；会通过 prepack 运行离线测试
npm publish --dry-run
# 确认账号、版本和包内容后，才真正发布
npm publish
```

用户通过 `pi install npm:pi-mimo-voice-input` 安装，固定首版可使用 `npm:pi-mimo-voice-input@0.1.0`。
已有本地版本或旧包时，先用 `pi remove <原来源>` 移除声明，避免重复加载。
发布成功并验证后，再按需创建 tag / GitHub Release；本仓库不会自动发布、推送或创建 tag。

npm 包不含 `.git`，发布 npm 不要求同时公开 Git 历史，但 npm 账号的维护者元数据可能公开邮箱。
建议使用独立、可收信的发布邮箱并开启双因素认证。Git 提交使用 GitHub 提供的 noreply 邮箱；
已有历史中的邮箱和内部地址不会因新提交或 npm 打包而消失，公开 Git 仓库前需单独处理。

## 发布检查

1. 复核 `CHANGELOG.md` 的本次版本条目，确认版本号和日期；同步 `package.json` 与锁文件版本。
2. 运行 `npm ci --ignore-scripts --legacy-peer-deps`、`npm test` 和 `npm pack --dry-run`。
3. 确认包内只有入口、`src/*.ts`、配置示例、中英文 README、文档、更新日志、许可证和清单；不包含测试、脚本、Git 元数据或本地配置。
4. 本地回归 `/voice-test`、`/voice`、F8、`/voice-status`，启用整理后验证 `/voice-raw`。真实设备与在线 API 需人工显式测试。
5. 使用凭据扫描器检查工作区和完整 Git 历史，检查所有 URL、内部域名、私有 IP、代理、网关及远端配置。可使用 Gitleaks：

   ```bash
   gitleaks dir . --redact=100
   gitleaks git . --log-opts=--all --redact=100
   ```

   扫描器日志也可能包含远端主机名，不要直接公开原始扫描输出。模式匹配不能证明绝对没有秘密，仍需人工复核。
6. 若历史存在内部地址或凭据，先决定是否重写历史或从干净历史发布；真实凭据泄漏时必须先撤销/轮换。
   仅删除当前文件不能清除 Git 历史。不要未经协作者确认强制推送。
7. 确认发布目标与 npm 账号，再按上方流程手动发布，验证成功后按需打标签；预检命令本身不会发布。

真实配置留在 `~/.pi/mimo-voice-zh.json`，权限设为 `0600`。仓库忽略本地配置、`.env`、`.npmrc`、认证文件、私钥和证书；
忽略规则不影响已经跟踪的文件，也不能清除历史。配置示例必须保持 `apiKey` 为空。
