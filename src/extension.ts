/** MiMo 中文语音输入，支持 Ubuntu/Linux 和 macOS。 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
	rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_RECORDING_MS, playbackCommand, recordingCommand,
	startAudioProcess, stopAudioProcess, waitForRecordingReady,
	type AudioProcess, type RecordingBackend,
} from "./audio.ts";
import { callASR, errorMessage } from "./mimo.ts";
import { alsaCapture, audioIssues, inspectWav, pulseInput, qualitySummary } from "./diagnostics.ts";
import { prepareWebrtcInput, type ProcessedInput } from "./webrtc.ts";
import { prepareSpeech, speechSummary, validateVadThreshold } from "./vad.ts";
import { cleanupTranscript, DEFAULT_CLEANUP_SETTINGS, type CleanupSettings } from "./cleanup.ts";

interface VoiceSettings extends CleanupSettings {
	sttEnabled: boolean;
	apiKey: string;
	sttShortcut: string;
	recordingBackend: RecordingBackend;
	recordingDevice: string;
	recordingProcessing: "none" | "webrtc";
	vadEnabled: boolean;
	vadThreshold: number;
	textCleanupEnabled: boolean;
}

// 包已更名为 pi-mimo-voice-input，配置路径保留旧文件名以兼容已有用户。
const CONFIG_PATH = join(homedir(), ".pi", "mimo-voice-zh.json");
const TMP_PREFIX = "pi-mimo-voice-input-";
const DEFAULT_SETTINGS: VoiceSettings = {
	...DEFAULT_CLEANUP_SETTINGS, textCleanupEnabled: false,
	apiKey: "", sttEnabled: true, sttShortcut: "f8",
	recordingBackend: "auto", recordingDevice: "", recordingProcessing: "none",
	vadEnabled: true, vadThreshold: 0.5,
};

function loadSettings(): VoiceSettings {
	try {
		if (existsSync(CONFIG_PATH)) {
			return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) };
		}
	} catch { /* 配置错误时保留默认值，语音操作会提示缺少 Key。 */ }
	return { ...DEFAULT_SETTINGS };
}

function saveSettings(cfg: VoiceSettings): void {
	mkdirSync(join(homedir(), ".pi"), { recursive: true });
	const existing = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) : {};
	writeFileSync(CONFIG_PATH, JSON.stringify({ ...existing, ...cfg }, null, 2), {
		encoding: "utf-8", mode: 0o600,
	});
}

function removeFile(path: string): void {
	try { unlinkSync(path); } catch { /* 文件可能已由退出清理删除。 */ }
}

function cleanupOldTmpDirs(): void {
	try {
		for (const entry of readdirSync(tmpdir())) {
			if (!entry.startsWith(TMP_PREFIX) && !entry.startsWith("pi-mimo-voice-zh-")) continue;
			const path = join(tmpdir(), entry);
			try {
				if (Date.now() - statSync(path).mtimeMs > 3600_000) {
					rmSync(path, { recursive: true, force: true });
				}
			} catch { /* 不影响当前会话。 */ }
		}
	} catch { /* 不影响当前会话。 */ }
}

interface Recording {
	process: AudioProcess;
	path: string;
	ready: boolean;
	stopping: boolean;
	test: boolean;
	input?: ProcessedInput;
	timer?: ReturnType<typeof setTimeout>;
}

export default function mimoVoiceInput(pi: ExtensionAPI) {
	let settings = loadSettings();
	let tmpDir: string | undefined;
	let active = false;
	let sessionGen = 0;
	let requests = new AbortController();
	let replayGen = 0;
	let currentPlayer: AudioProcess | null = null;
	let replaying = false;
	let recording: Recording | null = null;
	let recognizing = false;
	let starting = false;
	let cleaning: Promise<string> | undefined;
	let lastVoiceInput: { raw: string; prefix: string; editorAfter: string } | undefined;
	let lastDiagnostic = "尚未检测录音";
	let fileId = 0;
	const processedInputs = new Set<ProcessedInput>();

	async function releaseInput(input?: ProcessedInput, ctx?: ExtensionContext): Promise<void> {
		if (!input) return;
		try {
			await input.dispose();
			processedInputs.delete(input);
		} catch (error) {
			if (active && ctx) ctx.ui.notify(`WebRTC 临时资源清理失败: ${errorMessage(error, settings.apiKey)}`, "warning");
			// 保留引用，在会话关闭时重试；不卸载用户的其他音频模块。
		}
	}

	function audioPath(prefix: string): string {
		if (!tmpDir || !existsSync(tmpDir)) {
			tmpDir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
		}
		return join(tmpDir, `${prefix}-${++fileId}.wav`);
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("mimo-voice", starting ? "⏳ 麦克风启动中"
			: recording?.ready && !recording.stopping ? `🔴 正在录音${recording.test ? "（本地自检）" : ""}`
			: replaying ? "🔊 麦克风录音回放"
			: cleaning ? "✍️ 口语清洗中"
			: recognizing ? "🎤 录音处理中"
			: settings.sttEnabled ? "🎤 语音输入就绪" : "🎤 ASR 已关闭");
	}

	function stopReplay(): void {
		replayGen++;
		currentPlayer?.child.kill("SIGTERM");
		currentPlayer = null;
		replaying = false;
	}

	async function replayRecording(path: string, ctx: ExtensionContext): Promise<void> {
		stopReplay();
		const gen = replayGen;
		replaying = true;
		updateStatus(ctx);
		try {
			const player = startAudioProcess(playbackCommand(path));
			currentPlayer = player;
			const result = await player.closed;
			if (gen === replayGen && (result.error || result.code !== 0)) {
				throw result.error ?? new Error(result.stderr || "录音回放失败");
			}
		} finally {
			if (gen === replayGen) {
				currentPlayer = null;
				replaying = false;
				if (active) updateStatus(ctx);
			}
		}
	}

	async function sttHandler(ctx: ExtensionContext, test = false): Promise<void> {
		if (!ctx.hasUI || !active) return;
		if (test && currentPlayer) {
			stopReplay();
			ctx.ui.notify("录音回放已停止", "info");
			updateStatus(ctx);
			return;
		}
		if (starting) {
			ctx.ui.notify("麦克风正在启动，请等待“可以说话”提示", "warning");
			return;
		}
		if (recognizing || recording?.stopping) {
			ctx.ui.notify("正在识别，请稍候", "warning");
			return;
		}
		if (recording && recording.test !== test) {
			ctx.ui.notify(`正在${recording.test ? "本地自检" : "语音输入"}，请用 ${recording.test ? "/voice-test" : "/voice"} 停止`, "warning");
			return;
		}
		if (!test && !settings.sttEnabled) {
			ctx.ui.notify("ASR 已关闭", "warning");
			return;
		}
		if (!test && !settings.apiKey) {
			ctx.ui.notify("请先设置 API Key（~/.pi/mimo-voice-zh.json）", "error");
			return;
		}

		if (recording) {
			const current = recording;
			const session = sessionGen;
			const signal = requests.signal;
			let summary = "";
			let speechPath: string | undefined;
			current.stopping = true;
			clearTimeout(current.timer);
			recognizing = true;
			updateStatus(ctx);
			ctx.ui.notify(test ? "本地自检，不上传音频..." : "检查录音并识别...", "info");
			try {
				await stopAudioProcess(current.process);
				await releaseInput(current.input, ctx);
				if (!active || session !== sessionGen) return;
				recording = null;
				const quality = inspectWav(current.path);
				summary = qualitySummary(quality);
				const issues = audioIssues(quality);
				lastDiagnostic = [summary, `录音处理: ${current.input ? "WebRTC 降噪 / 高通 / 数字增益" : "原始录音"}`,
					...issues.map((issue) => issue.message)].join("\n");
				if (test) {
					ctx.ui.notify(lastDiagnostic, issues.length ? "warning" : "info");
					if (issues.some((issue) => issue.blocking)) {
						ctx.ui.notify("本地自检发现静音/失真或过短录音；未上传，也不自动回放异常音频", "warning");
						return;
					}
					ctx.ui.notify("回听是否清楚、有无杂音/漏字；电平正常不代表人声一定清楚", "info");
					await replayRecording(current.path, ctx);
					return;
				}
				const blocking = issues.filter((issue) => issue.blocking);
				if (blocking.length) {
					throw new Error(`本地录音检查未通过，未上传：${blocking.map((issue) => issue.message).join("；")}`);
				}
				for (const issue of issues) ctx.ui.notify(issue.message, "warning");
				let uploadPath = current.path;
				if (settings.vadEnabled) {
					speechPath = audioPath("speech");
					const speech = await prepareSpeech(current.path, speechPath, settings.vadThreshold, signal).catch((error) => {
						if (active && session === sessionGen) lastDiagnostic += "\nVAD: 检测失败，未上传";
						throw new Error(`本地 VAD 失败，未上传：${errorMessage(error, settings.apiKey)}`);
					});
					if (!active || session !== sessionGen) return;
					const vadSummary = speechSummary(speech);
					lastDiagnostic += `\n${vadSummary}`;
					ctx.ui.notify(vadSummary, "info");
					if (!speech.segments.length) return;
					uploadPath = speechPath;
				} else {
					lastDiagnostic += "\nVAD: 已关闭，上传原始录音";
				}
				const raw = await callASR(uploadPath, settings.apiKey, signal);
				if (!active || session !== sessionGen) return;
				let text = raw;
				if (settings.textCleanupEnabled) {
					ctx.ui.notify(`使用 MiMo API (${settings.cleanupModel}，已关闭思考) 整理口语，允许改写，请在发送前复核...`, "info");
					const cleanupStarted = Date.now();
					const pending = cleanupTranscript(raw, settings.apiKey, settings, signal);
					cleaning = pending;
					updateStatus(ctx);
					try {
						text = await pending;
						if (active && session === sessionGen) lastDiagnostic += `\n文本清洗: ${text === raw ? "无需调整" : "已整理，待人工复核"}（${((Date.now() - cleanupStarted) / 1000).toFixed(2)} 秒）`;
					} catch (error) {
						if (!active || session !== sessionGen) return;
						const reason = errorMessage(error, settings.apiKey);
						lastDiagnostic += `\n文本清洗: 已保留原文（${((Date.now() - cleanupStarted) / 1000).toFixed(2)} 秒）；原因：${reason}`;
						ctx.ui.notify(`口语清洗未应用：${reason}`, "warning");
					} finally {
						if (cleaning === pending) cleaning = undefined;
					}
				}
				if (!active || session !== sessionGen) return;
				// 清洗期间输入的新草稿也保留；不自动发送，原文只在会话内存中保存。
				const draft = ctx.ui.getEditorText();
				const prefix = draft ? `${draft.trimEnd()}\n` : "";
				const editorAfter = prefix + text;
				ctx.ui.setEditorText(editorAfter);
				lastVoiceInput = text !== raw ? { raw, prefix, editorAfter } : undefined;
				ctx.ui.notify(`识别: ${text.slice(0, 40)}${text !== raw ? "（已清洗，/voice-raw 可恢复）" : ""}`, "info");
			} catch (error) {
				if (active && session === sessionGen) {
					ctx.ui.notify(`${test ? "麦克风自检" : "语音识别"}失败: ${errorMessage(error, settings.apiKey)}${summary ? `\n${summary}` : ""}`, "error");
				}
			} finally {
				await releaseInput(current.input, ctx);
				removeFile(current.path);
				if (speechPath) removeFile(speechPath);
				if (session === sessionGen) {
					recording = null;
					recognizing = false;
					if (active) updateStatus(ctx);
				}
			}
			return;
		}

		let path: string | undefined;
		let input: ProcessedInput | undefined;
		let pendingRecording: Recording | undefined;
		let ready = false;
		const session = sessionGen;
		const signal = requests.signal;
		starting = true;
		updateStatus(ctx);
		ctx.ui.notify("⏳ 麦克风启动中，请等待“可以说话”提示", "info");
		try {
			const backend = recordingCommand("", settings.recordingBackend, settings.recordingDevice);
			if (!test) {
				if (typeof settings.textCleanupEnabled !== "boolean") throw new Error("textCleanupEnabled 必须是 true 或 false");
				if (typeof settings.vadEnabled !== "boolean") throw new Error("vadEnabled 必须是 true 或 false");
				if (settings.vadEnabled) validateVadThreshold(settings.vadThreshold);
			}
			if (!["none", "webrtc"].includes(settings.recordingProcessing)) {
				throw new Error("recordingProcessing 只支持 none / webrtc");
			}
			if (settings.recordingProcessing === "webrtc" && backend.command !== "parecord") {
				throw new Error("WebRTC 录音处理需要 Linux parecord 后端；其他后端请设置 recordingProcessing: \"none\"");
			}
			if (backend.command === "parecord") {
				const input = await pulseInput(settings.recordingDevice).catch(() => undefined);
				if (!active || session !== sessionGen) return;
				if (input?.monitor) throw new Error("输入设备是系统声音回环 (.monitor)，请在系统中选择实际麦克风");
				if (input?.muted) throw new Error(`麦克风 ${input.description || input.name} 已静音`);
			}
			if (settings.recordingProcessing === "webrtc") {
				input = await prepareWebrtcInput(settings.recordingDevice);
				processedInputs.add(input);
				if (!active || session !== sessionGen) return;
			}
			stopReplay();
			path = audioPath("stt");
			const command = recordingCommand(path, settings.recordingBackend, input?.source || settings.recordingDevice);
			const current: Recording = {
				process: startAudioProcess(command), path, ready: false, stopping: false, test, input,
			};
			pendingRecording = current;
			recording = current;
			void current.process.closed.then(async (result) => {
				// 启动中的退出交给就绪等待处理，避免重复报错或提前显示红灯。
				if (!current.ready || recording !== current || current.stopping) return;
				clearTimeout(current.timer);
				recording = null;
				await releaseInput(current.input, ctx);
				removeFile(current.path);
				if (!active || session !== sessionGen) return;
				updateStatus(ctx);
				ctx.ui.notify(`录音失败 (${command.command}): ${errorMessage(
					result.error ?? new Error(result.stderr || `录音进程意外退出：${result.code ?? result.signal}`),
					settings.apiKey,
				)}`, "error");
			});
			await waitForRecordingReady(current.process, path, signal);
			if (!active || session !== sessionGen || recording !== current) return;
			current.ready = true;
			ready = true;
			starting = false;
			// 录音时限从真正就绪开始，不占用用户等待设备启动的时间。
			current.timer = setTimeout(() => {
				if (recording !== current || current.stopping) return;
				ctx.ui.notify(test ? "10 秒自检结束，自动停止" : "已达到 3 分钟录音上限，自动停止并识别", "warning");
				void sttHandler(ctx, test);
			}, test ? 10_000 : MAX_RECORDING_MS);
			updateStatus(ctx);
			ctx.ui.notify(`🔴 ${test ? "本地自检" : "录音中"}，可以说话了；${test ? "再次运行 /voice-test 停止（不会上传）" : `再次按 ${settings.sttShortcut} 或运行 /voice 停止`}`, "info");
		} catch (error) {
			if (active && session === sessionGen) {
				ctx.ui.notify(`录音失败: ${errorMessage(error, settings.apiKey)}`, "error");
			}
		} finally {
			if (!ready) {
				if (pendingRecording) {
					pendingRecording.stopping = true;
					await stopAudioProcess(pendingRecording.process).catch(() => {});
					if (recording === pendingRecording) recording = null;
				}
				await releaseInput(input);
				if (path) removeFile(path);
			}
			if (session === sessionGen) {
				starting = false;
				if (active) updateStatus(ctx);
			}
		}
	}

	async function cleanupSession(): Promise<void> {
		active = false;
		sessionGen++;
		requests.abort();
		const pendingCleanup = cleaning;
		cleaning = undefined;
		lastVoiceInput = undefined;
		const player = currentPlayer;
		stopReplay();
		const current = recording;
		recording = null;
		recognizing = false;
		starting = false;
		if (current) {
			current.stopping = true;
			clearTimeout(current.timer);
		}
		await Promise.all([
			pendingCleanup?.catch(() => {}),
			current ? stopAudioProcess(current.process).catch(() => {}) : undefined,
			player ? stopAudioProcess(player, "SIGTERM").catch(() => {}) : undefined,
		]);
		await Promise.all([...processedInputs].map((input) => releaseInput(input)));
		if (tmpDir) {
			try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 尽力清理。 */ }
			tmpDir = undefined;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await cleanupSession();
		settings = loadSettings();
		requests = new AbortController();
		active = true;
		cleanupOldTmpDirs();
		if (!existsSync(CONFIG_PATH)) {
			try { saveSettings(settings); } catch (error) {
				ctx.ui.notify(`配置保存失败: ${errorMessage(error, settings.apiKey)}`, "error");
			}
		}
		updateStatus(ctx);
	});

	pi.registerShortcut(settings.sttShortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
		description: "MiMo 语音输入（也可使用 /voice）", handler: sttHandler,
	});
	pi.registerCommand("voice", {
		description: "MiMo 语音输入：开始录音 / 停止并识别", handler: async (_args, ctx) => sttHandler(ctx),
	});
	pi.registerCommand("voice-test", {
		description: "本地麦克风自检：录音/停止、检测并回听，回放中可再次停止；不调用 API（最多 10 秒）",
		handler: async (_args, ctx) => sttHandler(ctx, true),
	});
	pi.registerCommand("voice-raw", {
		description: "恢复最近一次清洗前的原始转写；草稿已改动时不覆盖",
		handler: async (_args, ctx) => {
			if (!active || !ctx.hasUI) return;
			if (!lastVoiceInput) { ctx.ui.notify("没有可恢复的清洗原文", "info"); return; }
			if (ctx.ui.getEditorText() !== lastVoiceInput.editorAfter) {
				ctx.ui.notify("草稿已修改或发送，未覆盖；原文仅保留在当前会话内存中", "warning");
				return;
			}
			ctx.ui.setEditorText(lastVoiceInput.prefix + lastVoiceInput.raw);
			lastVoiceInput = undefined;
			ctx.ui.notify("已恢复原始转写，未自动发送", "info");
		},
	});
	pi.registerCommand("voice-status", {
		description: "检查 MiMo 语音配置和本机录音/播放后端（不显示 Key）",
		handler: async (_args, ctx) => {
			const describe = (resolve: () => { command: string }) => {
				try { return resolve().command; } catch (error) { return errorMessage(error, settings.apiKey); }
			};
			const backend = describe(() => recordingCommand("", settings.recordingBackend, settings.recordingDevice));
			let inputDescription = settings.recordingDevice || "系统默认麦克风";
			if (backend === "parecord") {
				try {
					const input = await pulseInput(settings.recordingDevice);
					if (input) {
						const gains = await alsaCapture(input).catch(() => []);
						inputDescription = `${input.description} (${input.name})\n`
							+ `活动端口: ${input.port}；静音: ${input.muted ? "是" : "否"}；系统声音回环: ${input.monitor ? "是" : "否"}\n`
							+ `输入音量: ${input.volume}${gains.length ? `\n硬件采集增益: ${gains.join("\n")}` : ""}`;
					}
				} catch (error) { inputDescription += `；音频服务诊断失败: ${errorMessage(error, settings.apiKey)}`; }
			}
			ctx.ui.notify([
				`平台: ${process.platform}；API Key: ${settings.apiKey ? "已配置" : "未配置"}`,
				`录音: ${backend}；处理: ${settings.recordingProcessing === "webrtc" ? "WebRTC（不改默认设备/硬件增益）" : "原始录音"}`,
				`输入设备: ${inputDescription}`,
				`VAD: ${settings.vadEnabled ? `Silero v5 本地检测（阈值 ${settings.vadThreshold}）` : "已关闭"}；自检保留原始录音`,
				`口语清洗: ${settings.textCleanupEnabled ? `MiMo API / ${settings.cleanupModel}；思考已关闭；超时 ${settings.cleanupTimeoutMs / 1000} 秒；自然整理，允许改写，请复核` : "已关闭"}`,
				`自检回放: ${describe(() => playbackCommand(""))}`,
				`最近录音检测: ${lastDiagnostic}`,
				`语音输入: /voice 或 ${settings.sttShortcut}；本地回听: /voice-test`,
			].join("\n"), "info");
		},
	});

	pi.on("session_shutdown", cleanupSession);
}
