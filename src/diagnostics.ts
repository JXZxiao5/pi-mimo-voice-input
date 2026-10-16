import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commandExists, readWav } from "./audio.ts";

const execute = promisify(execFile);
const db = (value: number) => value > 0 ? 20 * Math.log10(value) : -Infinity;

export interface AudioQuality {
	duration: number;
	sampleRate: number;
	channels: number;
	acRmsDb: number;
	peakDb: number;
	maxFrameDb: number;
	clipRatio: number;
	dcOffset: number;
}
export interface AudioIssue {
	message: string;
	blocking: boolean;
}

/** 电平不等于语音质量或 VAD；这里只识别确定的静音/损坏信号。 */
export function inspectWav(path: string): AudioQuality {
	const { pcm, format } = readWav(path);
	const channels = format.readUInt16LE(2);
	const sampleRate = format.readUInt32LE(4);
	if (format.readUInt16LE(0) !== 1 || format.readUInt16LE(14) !== 16
		|| !sampleRate || channels < 1 || channels > 2 || pcm.length % (2 * channels)) {
		throw new Error("录音质量检测需要完整的 16-bit PCM 单/双声道 WAV");
	}
	const frames = pcm.length / (2 * channels);
	const window = Math.max(1, Math.round(sampleRate * 0.02));
	let peak = 0, clips = 0, maxFrame = 0, acSquared = 0, dcOffset = 0;
	for (let channel = 0; channel < channels; channel++) {
		let sum = 0, squared = 0;
		for (let start = 0; start < frames; start += window) {
			let frameSum = 0, frameSquared = 0;
			const end = Math.min(start + window, frames);
			for (let i = start; i < end; i++) {
				const value = pcm.readInt16LE((i * channels + channel) * 2) / 32768;
				peak = Math.max(peak, Math.abs(value));
				if (Math.abs(value) >= 32760 / 32768) clips++;
				frameSum += value;
				frameSquared += value * value;
			}
			const count = end - start;
			maxFrame = Math.max(maxFrame, Math.sqrt(Math.max(0,
				frameSquared / count - (frameSum / count) ** 2)));
			sum += frameSum;
			squared += frameSquared;
		}
		const mean = sum / frames;
		// 用最差声道的偏移，避免双声道 +/- DC 相互抵消。
		dcOffset = Math.max(dcOffset, Math.abs(mean));
		acSquared += Math.max(0, squared / frames - mean * mean);
	}
	return {
		duration: frames / sampleRate, sampleRate, channels,
		acRmsDb: db(Math.sqrt(acSquared / channels)), peakDb: db(peak),
		maxFrameDb: db(maxFrame), clipRatio: clips / (frames * channels), dcOffset,
	};
}

export function qualitySummary(quality: AudioQuality): string {
	const level = (value: number) => Number.isFinite(value) ? `${value.toFixed(1)} dBFS` : "静音";
	return `录音 ${quality.duration.toFixed(2)}s / ${quality.sampleRate}Hz / ${quality.channels}ch；`
		+ `交流电平 ${level(quality.acRmsDb)}；峰值 ${level(quality.peakDb)}；`
		+ `削波 ${(quality.clipRatio * 100).toFixed(1)}%；DC ${(quality.dcOffset * 100).toFixed(1)}%`;
}

export function audioIssues(quality: AudioQuality): AudioIssue[] {
	const issues: AudioIssue[] = [];
	if (quality.clipRatio > 0.05) {
		issues.push({ blocking: true, message: '当前录音链路严重削波；浏览器录音正常时先尝试 recordingProcessing: "webrtc"，否则检查采集增益和输入设备' });
	} else if (quality.clipRatio > 0.005) {
		issues.push({ blocking: false, message: "录音存在少量削波，先用 /voice-test 回听，必要时检查录音处理和采集增益" });
	}
	if (quality.dcOffset > 0.1) {
		issues.push({ blocking: true, message: "当前录音链路存在严重直流偏移；浏览器正常时先尝试 WebRTC 高通/降噪，再检查输入设置" });
	}
	if (quality.duration < 0.25) {
		issues.push({ blocking: true, message: "录音不足 0.25 秒，等设备开始采集后再说话，说完稍停再停止" });
	}
	if (quality.maxFrameDb < -75) {
		issues.push({ blocking: true, message: "录音接近静音，检查麦克风、默认输入设备或静音开关" });
	} else if (quality.maxFrameDb < -40) {
		issues.push({ blocking: false, message: "录音电平偏低，先用 /voice-test 回听；靠近麦克风或适度调高采集增益，不要直接拉满 Boost" });
	}
	return issues;
}

export interface PulseInput {
	name: string;
	description: string;
	port: string;
	muted: boolean;
	volume: string;
	monitor: boolean;
	card?: string;
}

/** 固定英文输出进行解析，兼容 Ubuntu 20.04 的 pactl（不要求 JSON 支持）。 */
export function parsePulseInput(info: string, sources: string, device = ""): PulseInput | undefined {
	const name = device || info.match(/^Default Source:\s*(.+)$/m)?.[1]?.trim();
	if (!name) return undefined;
	const block = sources.split(/(?=^Source #)/m).find((entry) =>
		entry.match(/^\s*Name:\s*(.+)$/m)?.[1]?.trim() === name
		|| entry.match(/^Source #(\d+)/m)?.[1] === name);
	if (!block) return undefined;
	const field = (label: string) => block.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, "m"))?.[1]?.trim() || "";
	return {
		name: field("Name"), description: field("Description"), port: field("Active Port"),
		muted: field("Mute") === "yes", volume: field("Volume"),
		monitor: /\.monitor$/.test(field("Name")) || /device\.class = "monitor"/.test(block),
		card: block.match(/alsa\.card = "(\d+)"/)?.[1],
	};
}

export function parseAlsaCapture(output: string, port: string): string[] {
	const boost = port.includes("headset") ? "Headset Mic Boost"
		: port.includes("headphone") ? "Headphone Mic Boost" : "";
	return output.split(/(?=^Simple mixer control )/m).flatMap((block) => {
		const match = block.match(/^Simple mixer control '(.+)',(\d+)/m);
		if (!match || !((match[1] === "Capture" && match[2] === "0") || match[1] === boost)) return [];
		const levels = block.split("\n").filter((line) => /\[-?[\d.]+dB\]/.test(line))
			.map((line) => line.trim());
		return levels.length ? [`${match[1]}: ${levels.join("；")}`] : [];
	});
}

export async function alsaCapture(input: PulseInput): Promise<string[]> {
	if (!input.card || !commandExists("amixer")) return [];
	const result = await execute("amixer", ["-c", input.card, "scontents"], {
		env: { ...process.env, LC_ALL: "C" }, timeout: 2000, maxBuffer: 1024 * 1024,
	});
	return parseAlsaCapture(result.stdout, input.port);
}

export async function pulseInput(device = ""): Promise<PulseInput | undefined> {
	if (process.platform !== "linux" || !commandExists("pactl")) return undefined;
	const options = { env: { ...process.env, LC_ALL: "C" }, timeout: 2000, maxBuffer: 1024 * 1024 };
	const [info, sources] = await Promise.all([
		execute("pactl", ["info"], options), execute("pactl", ["list", "sources"], options),
	]);
	return parsePulseInput(info.stdout, sources.stdout, device);
}
