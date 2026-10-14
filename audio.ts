import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
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

export function wavBase64(wavPath: string): string {
	return readWav(wavPath).wav.toString("base64");
}
