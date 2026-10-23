import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, closeSync, constants, fstatSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

export type RecordingBackend = "auto" | "parecord" | "arecord" | "sox";
export interface AudioCommand {
	command: string;
	args: string[];
}
export interface ProcessResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
	error?: Error;
}
export interface AudioProcess {
	child: ChildProcess;
	closed: Promise<ProcessResult>;
	exited: boolean;
}

export const MAX_BASE64_BYTES = 10_000_000;
export const MAX_RECORDING_MS = 180_000;
export const RECORDING_START_TIMEOUT_MS = 5000;
export const RECORDING_WARMUP_MS = 1000;

export function commandExists(command: string): boolean {
	return (process.env.PATH ?? "").split(delimiter).some((dir) => {
		try {
			const path = join(dir, command);
			accessSync(path, constants.X_OK);
			return statSync(path).isFile();
		} catch {
			return false;
		}
	});
}

export function recordingCommand(
	wavPath: string,
	backend: RecordingBackend = "auto",
	device = "",
	platform = process.platform,
	available = commandExists,
): AudioCommand {
	if (platform !== "linux" && platform !== "darwin") {
		throw new Error(`暂不支持 ${platform} 的录音`);
	}
	const candidates = platform === "linux" ? ["parecord", "arecord", "sox"] : ["sox"];
	if (backend !== "auto" && !candidates.includes(backend)) {
		throw new Error(`此平台不支持录音后端 ${backend}`);
	}
	const command = (backend === "auto" ? candidates : [backend]).find(available);
	if (!command) {
		throw new Error(platform === "linux"
			? "找不到录音工具，请安装：sudo apt install pulseaudio-utils alsa-utils"
			: "找不到 sox，请安装：brew install sox");
	}
	if (command === "parecord") {
		return { command, args: [
			"--file-format=wav", "--format=s16le", "--rate=16000", "--channels=1",
			// PulseAudio 默认缓冲较大，短录音可能只有 WAV 头。
			"--latency-msec=50", ...(device ? [`--device=${device}`] : []), wavPath,
		] };
	}
	if (command === "arecord") {
		return { command, args: [
			"-q", "-D", device || "default", "-f", "S16_LE", "-r", "16000",
			"-c", "1", "-t", "wav", wavPath,
		] };
	}
	return { command, args: [
		...(device ? [device] : ["-d"]), "-r", "16000", "-c", "1", "-b", "16", wavPath,
	] };
}

export function playbackCommand(
	wavPath: string,
	platform = process.platform,
	available = commandExists,
): AudioCommand {
	const candidates = platform === "darwin" ? ["afplay"]
		: platform === "linux" ? ["paplay", "aplay", "ffplay"] : [];
	const command = candidates.find(available);
	if (!command) {
		throw new Error(platform === "linux"
			? "找不到播放工具，请安装：sudo apt install pulseaudio-utils alsa-utils"
			: `找不到 ${platform} 的播放工具`);
	}
	return { command, args: command === "aplay" ? ["-q", wavPath]
		: command === "ffplay" ? ["-nodisp", "-autoexit", "-loglevel", "error", wavPath]
		: [wavPath] };
}

/** 在发信号前注册 close/error 监听；stderr 有界保存，不污染 pi TUI。 */
export function startAudioProcess(command: AudioCommand): AudioProcess {
	const child = spawn(command.command, command.args, { stdio: ["ignore", "ignore", "pipe"] });
	const state: AudioProcess = { child, exited: false, closed: undefined! };
	state.closed = new Promise((resolve) => {
		let stderr = "";
		let error: Error | undefined;
		child.stderr?.on("data", (data: Buffer) => {
			stderr = (stderr + data.toString()).slice(-2000);
		});
		child.on("error", (err: Error) => { error = err; });
		child.once("close", (code, signal) => {
			state.exited = true;
			resolve({ code, signal, stderr: stderr.trim(), error });
		});
	});
	return state;
}

/** 录音中的 WAV 长度字段可能尚未补全，只检查 data 块实际写入的完整 PCM 帧。 */
function hasRecordedAudio(path: string, warmupMs: number, onProgress?: (progress: number) => void): boolean {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	try {
		const size = fstatSync(fd).size;
		const header = Buffer.alloc(16);
		if (readSync(fd, header, 0, 12, 0) !== 12
			|| header.toString("ascii", 0, 4) !== "RIFF"
			|| header.toString("ascii", 8, 12) !== "WAVE") return false;
		let frameBytes = 0;
		let requiredBytes = 0;
		for (let offset = 12; offset + 8 <= size;) {
			if (readSync(fd, header, 0, 8, offset) !== 8) return false;
			const id = header.toString("ascii", 0, 4);
			const chunkSize = header.readUInt32LE(4);
			if (id === "data") {
				if (!frameBytes) return false;
				const bytes = Math.floor((size - offset - 8) / frameBytes) * frameBytes;
				if (bytes > 0) onProgress?.(Math.min(1, bytes / requiredBytes));
				return bytes >= requiredBytes;
			}
			if (offset + 8 + chunkSize > size) return false;
			if (id === "fmt ") {
				if (chunkSize < 16 || readSync(fd, header, 0, 16, offset + 8) !== 16) return false;
				const channels = header.readUInt16LE(2);
				if (header.readUInt16LE(0) !== 1 || header.readUInt16LE(14) !== 16
					|| !channels || header.readUInt16LE(12) !== channels * 2) return false;
				frameBytes = channels * 2;
				requiredBytes = Math.max(1, Math.ceil(header.readUInt32LE(4) * warmupMs / 1000)) * frameBytes;
			}
			offset += 8 + chunkSize + (chunkSize % 2);
		}
		return false;
	} finally {
		closeSync(fd);
	}
}

/** 累计收到指定时长的音频（包括静音）才就绪；默认只要求一帧，不等待人声。 */
export function waitForRecordingReady(
	state: AudioProcess,
	wavPath: string,
	signal?: AbortSignal,
	timeoutMs = RECORDING_START_TIMEOUT_MS,
	warmupMs = 0,
	onProgress?: (progress: number) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let pollTimer: ReturnType<typeof setTimeout> | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(pollTimer);
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve();
		};
		const abort = () => finish(new Error("麦克风启动已取消"));
		if (signal?.aborted) { abort(); return; }
		signal?.addEventListener("abort", abort, { once: true });
		void state.closed.then((result) => finish(result.error ?? new Error(result.stderr
			|| `录音进程在开始采集前退出：${result.code ?? result.signal}`)));
		const poll = () => {
			if (settled || state.exited) return;
			try {
				if (hasRecordedAudio(wavPath, warmupMs, onProgress)) { finish(); return; }
			} catch (error) {
				finish(error as Error);
				return;
			}
			pollTimer = setTimeout(poll, 25);
		};
		timeout = setTimeout(() => finish(new Error("麦克风启动超时，未收到音频数据或预热数据不足；请检查输入设备和音频服务后重试")), timeoutMs);
		poll();
	});
}

/** SIGINT 让录音工具补全 WAV 头；必须等 close 后才能读取或删除文件。 */
export async function stopAudioProcess(
	state: AudioProcess,
	signal: NodeJS.Signals = "SIGINT",
): Promise<ProcessResult> {
	if (!state.exited) state.child.kill(signal);
	let forced = false;
	const timer = setTimeout(() => {
		forced = true;
		state.child.kill("SIGKILL");
	}, 3000);
	try {
		const result = await state.closed;
		if (forced) throw new Error("音频进程未正常退出，已强制结束，请重试");
		if (result.error) throw result.error;
		return result;
	} finally {
		clearTimeout(timer);
	}
}

/** MiMo 限制的是 Base64 大小；同时拒绝空录音和未补全的 WAV。 */
export function readWav(wavPath: string): { wav: Buffer; pcm: Buffer; format: Buffer } {
	if (4 * Math.ceil(statSync(wavPath).size / 3) > MAX_BASE64_BYTES) {
		throw new Error("录音超过 MiMo 的 10 MB Base64 限制，请缩短录音");
	}
	const wav = readFileSync(wavPath);
	if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF"
		|| wav.toString("ascii", 8, 12) !== "WAVE"
		|| wav.readUInt32LE(4) + 8 > wav.length) {
		throw new Error("录音不是完整的 WAV 文件，请重试");
	}
	let pcm: Buffer | undefined;
	let format: Buffer | undefined;
	for (let offset = 12; offset + 8 <= wav.length;) {
		const size = wav.readUInt32LE(offset + 4);
		if (offset + 8 + size > wav.length) {
			throw new Error("录音 WAV 尚未写入完整，请重试");
		}
		const id = wav.toString("ascii", offset, offset + 4);
		if (id === "fmt ") format = wav.subarray(offset + 8, offset + 8 + size);
		if (id === "data") {
			if (!size) throw new Error("录音为空，请检查麦克风并说话后再停止");
			pcm = wav.subarray(offset + 8, offset + 8 + size);
		}
		offset += 8 + size + (size % 2);
	}
	if (!pcm) throw new Error("录音为空或 WAV 缺少音频数据，请检查麦克风");
	if (!format || format.length < 16) throw new Error("WAV 缺少有效格式信息，请重试");
	return { wav, pcm, format };
}

/** 进程关闭、WAV 完整后去掉预热段；不重启采集，保留其他 WAV 块。 */
export function trimRecordingWarmup(wavPath: string, warmupMs = RECORDING_WARMUP_MS): void {
	const { wav, pcm, format } = readWav(wavPath);
	const frameBytes = format.readUInt16LE(12);
	if (format.readUInt16LE(0) !== 1 || format.readUInt16LE(14) !== 16
		|| frameBytes !== format.readUInt16LE(2) * 2 || !frameBytes) {
		throw new Error("预热裁剪需要 16-bit PCM WAV");
	}
	const bytes = Math.floor(format.readUInt32LE(4) * warmupMs / 1000) * frameBytes;
	if (pcm.length <= bytes) throw new Error("预热后录音为空，请等录音提示后说话再停止");
	const start = pcm.byteOffset - wav.byteOffset;
	const trimmed = Buffer.concat([wav.subarray(0, start), wav.subarray(start + bytes)]);
	trimmed.writeUInt32LE(pcm.length - bytes, start - 4);
	trimmed.writeUInt32LE(trimmed.length - 8, 4);
	writeFileSync(wavPath, trimmed);
}

export function wavBase64(wavPath: string): string {
	return readWav(wavPath).wav.toString("base64");
}
