import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Tensor } from "onnxruntime-web";
import { readWav } from "./audio.ts";

const require = createRequire(import.meta.url);
const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 512;
const CONTEXT_SAMPLES = 64;
const MIN_SPEECH_SAMPLES = SAMPLE_RATE * 0.128;
const MIN_SILENCE_SAMPLES = SAMPLE_RATE * 0.9;
const PAD_SAMPLES = SAMPLE_RATE * 0.2;
const GAP_SAMPLES = SAMPLE_RATE * 0.12;

/** 起止位置为原始 PCM 的采样点，end 不包含在区间中。 */
export interface SpeechSegment {
	start: number;
	end: number;
}
export interface SpeechPreparation {
	segments: SpeechSegment[];
	originalDuration: number;
	duration: number;
	removedDuration: number;
}

export function validateVadThreshold(threshold: number): void {
	if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
		throw new Error("vadThreshold 必须是大于 0、小于 1 的数字");
	}
}

/** 滞回检测保留短暂停顿；只在连续静音达到 900ms 后切段。 */
export function speechSegments(
	probabilities: number[], samples: number, threshold = 0.5,
): SpeechSegment[] {
	validateVadThreshold(threshold);
	if (!Number.isInteger(samples) || samples < 0
		|| probabilities.length !== Math.ceil(samples / FRAME_SAMPLES)
		|| probabilities.some((p) => !Number.isFinite(p) || p < 0 || p > 1)) {
		throw new Error("VAD 返回了无效的语音概率或采样长度");
	}
	const negativeThreshold = Math.max(threshold / 2, threshold - 0.15);
	const raw: SpeechSegment[] = [];
	let start = -1, silenceStart = -1, speechSamples = 0;
	const finish = (end: number) => {
		// 不让瞬时噪声因尾部静音或 padding 而变成有效语音。
		if (start >= 0 && speechSamples >= MIN_SPEECH_SAMPLES) raw.push({ start, end });
		start = -1;
		silenceStart = -1;
		speechSamples = 0;
	};
	for (let i = 0; i < probabilities.length; i++) {
		const position = i * FRAME_SAMPLES;
		const end = Math.min(samples, position + FRAME_SAMPLES);
		const probability = probabilities[i];
		if (probability >= threshold) {
			if (start < 0) start = position;
			speechSamples += end - position;
			silenceStart = -1;
		} else if (start >= 0 && probability >= negativeThreshold) {
			silenceStart = -1;
		} else if (start >= 0) {
			if (silenceStart < 0) silenceStart = position;
			if (end - silenceStart >= MIN_SILENCE_SAMPLES) finish(silenceStart);
		}
	}
	if (start >= 0) finish(silenceStart >= 0 ? silenceStart : samples);

	const segments: SpeechSegment[] = [];
	for (const speech of raw) {
		const padded = {
			start: Math.max(0, speech.start - PAD_SAMPLES),
			end: Math.min(samples, speech.end + PAD_SAMPLES),
		};
		const previous = segments.at(-1);
		if (previous && padded.start <= previous.end) previous.end = Math.max(previous.end, padded.end);
		else segments.push(padded);
	}
	return segments;
}

/** 保留原始 PCM，不重新量化；分段之间插入 120ms 静音并重建完整 WAV 头。 */
export function speechWav(pcm: Buffer, segments: SpeechSegment[]): Buffer {
	const chunks: Buffer[] = [];
	for (const segment of segments) {
		if (chunks.length) chunks.push(Buffer.alloc(GAP_SAMPLES * 2));
		chunks.push(pcm.subarray(segment.start * 2, segment.end * 2));
	}
	const data = Buffer.concat(chunks);
	const wav = Buffer.alloc(44 + data.length);
	wav.write("RIFF");
	wav.writeUInt32LE(wav.length - 8, 4);
	wav.write("WAVEfmt ", 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(SAMPLE_RATE, 24);
	wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write("data", 36);
	wav.writeUInt32LE(data.length, 40);
	data.copy(wav, 44);
	return wav;
}

/** Silero v5 / CPU WASM；模型随 npm 依赖安装，运行时不下载、不调用远端。 */
async function speechProbabilities(pcm: Buffer, signal?: AbortSignal): Promise<number[]> {
	signal?.throwIfAborted();
	const ort = await import("onnxruntime-web");
	signal?.throwIfAborted();
	// 单线程避免额外 worker，同时兼容 Linux/macOS，不需要原生库、Python 或 GPU。
	ort.env.wasm.numThreads = 1;
	const model = readFileSync(require.resolve("@ricky0123/vad-web/dist/silero_vad_v5.onnx"));
	const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
	let state: Tensor = new ort.Tensor("float32", new Float32Array(256), [2, 1, 128]);
	const sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);
	let context = new Float32Array(CONTEXT_SAMPLES);
	const probabilities: number[] = [];
	try {
		signal?.throwIfAborted();
		for (let start = 0; start < pcm.length / 2; start += FRAME_SAMPLES) {
			// 长录音处理时让出事件循环，允许退出/reload 及时取消。
			if (probabilities.length % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
			signal?.throwIfAborted();
			const frame = new Float32Array(CONTEXT_SAMPLES + FRAME_SAMPLES);
			frame.set(context);
			const length = Math.min(FRAME_SAMPLES, pcm.length / 2 - start);
			for (let i = 0; i < length; i++) frame[CONTEXT_SAMPLES + i] = pcm.readInt16LE((start + i) * 2) / 32768;
			context = frame.slice(-CONTEXT_SAMPLES);
			const input = new ort.Tensor("float32", frame, [1, frame.length]);
			try {
				const output = await session.run({ input, state, sr });
				try {
					if (!output.stateN || !output.output) throw new Error("VAD 模型未返回状态或语音概率");
					const probability = Number(output.output.data[0]);
					if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
						throw new Error("VAD 模型返回了无效的语音概率");
					}
					state.dispose();
					state = output.stateN;
					probabilities.push(probability);
				} finally {
					for (const tensor of Object.values(output)) if (tensor !== state) tensor.dispose();
				}
			} finally {
				input.dispose();
			}
		}
		signal?.throwIfAborted();
		return probabilities;
	} finally {
		state.dispose();
		sr.dispose();
		await session.release();
	}
}

export async function prepareSpeech(
	source: string, destination: string, threshold = 0.5, signal?: AbortSignal,
): Promise<SpeechPreparation> {
	validateVadThreshold(threshold);
	signal?.throwIfAborted();
	const { pcm, format } = readWav(source);
	if (format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1
		|| format.readUInt32LE(4) !== SAMPLE_RATE || format.readUInt16LE(14) !== 16
		|| pcm.length % 2) {
		throw new Error("VAD 需要 16kHz / 单声道 / 16-bit PCM WAV");
	}
	const probabilities = await speechProbabilities(pcm, signal);
	const segments = speechSegments(probabilities, pcm.length / 2, threshold);
	const originalDuration = pcm.length / (SAMPLE_RATE * 2);
	const wav = segments.length ? speechWav(pcm, segments) : undefined;
	const duration = wav ? (wav.length - 44) / (SAMPLE_RATE * 2) : 0;
	signal?.throwIfAborted();
	if (wav) writeFileSync(destination, wav, { mode: 0o600 });
	return { segments, originalDuration, duration, removedDuration: originalDuration - duration };
}

export function speechSummary(result: SpeechPreparation): string {
	return result.segments.length
		? `VAD: ${result.segments.length} 段人声；上传 ${result.duration.toFixed(2)}s；裁去 ${result.removedDuration.toFixed(2)}s 静音`
		: "VAD: 未检测到有效人声，未上传";
}
