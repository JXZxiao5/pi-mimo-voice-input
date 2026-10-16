import { wavBase64 } from "./audio.ts";

export const BASE_URL = "https://api.xiaomimimo.com/v1";
export const ASR_MODEL = "mimo-v2.5-asr";
const API_TIMEOUT_MS = 30_000;

export function errorMessage(error: unknown, apiKey = ""): string {
	const text = error instanceof Error ? error.message : String(error);
	return (apiKey ? text.replaceAll(apiKey, "[已隐藏 API Key]") : text).slice(0, 400);
}

async function completion(
	body: object,
	apiKey: string,
	signal?: AbortSignal,
): Promise<any> {
	if (!apiKey) throw new Error("请先设置 API Key（~/.pi/mimo-voice-zh.json）");
	const timeout = AbortSignal.timeout(API_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	try {
		requestSignal.throwIfAborted();
		let response: Response;
		try {
			response = await fetch(`${BASE_URL}/chat/completions`, {
				method: "POST", redirect: "error",
				headers: { "api-key": apiKey, "Content-Type": "application/json" },
				body: JSON.stringify(body), signal: requestSignal,
			});
		} catch { throw new Error("MiMo ASR 网络请求失败，请检查网络连接"); }
		requestSignal.throwIfAborted();
		if (!response.ok) {
			// 错误正文和底层网络异常可能含转写、代理地址或凭据，不读取或回显。
			void response.body?.cancel().catch(() => {});
			throw new Error(`MiMo HTTP ${response.status}，请检查网络、API Key 或额度`);
		}
		let data: unknown;
		try { data = await response.json(); } catch { throw new Error("MiMo ASR 响应不是有效 JSON"); }
		requestSignal.throwIfAborted();
		return data;
	} catch (error) {
		if (signal?.aborted) throw new Error("MiMo 语音识别已取消");
		if (timeout.aborted) throw new Error("MiMo 语音识别超时（30 秒）");
		throw error;
	}
}

export async function callASR(
	wavPath: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<string> {
	const data = await completion({
		model: ASR_MODEL,
		messages: [{
			role: "user",
			content: [{
				type: "input_audio",
				input_audio: { data: `data:audio/wav;base64,${wavBase64(wavPath)}` },
			}],
		}],
		asr_options: { language: "zh" },
	}, apiKey, signal);
	const choice = data?.choices?.[0];
	const content = choice?.message?.content;
	const text = typeof content === "string" ? content
		: Array.isArray(content) ? content.filter((part) => part?.type === "text" && typeof part.text === "string")
			.map((part) => part.text).join("") : "";
	if (!text.trim()) {
		const finish = ["stop", "length", "content_filter", "tool_calls"].includes(choice?.finish_reason)
			? choice.finish_reason : "unknown";
		throw new Error(`MiMo 返回空转写（未返回识别文字；finish_reason=${finish}）。先用 /voice-test 回听；清晰录音仍为空时需排查服务端，不能仅据此断定麦克风故障`);
	}
	return text.trim();
}
