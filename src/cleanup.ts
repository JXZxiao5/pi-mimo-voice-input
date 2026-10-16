/** 直接调用 MiMo 文本 API，不启动 CLI、共享服务或工具。 */
import { BASE_URL } from "./mimo.ts";
import { CLEANUP_PROMPT } from "./cleanup-prompt.ts";

export interface CleanupSettings {
	cleanupModel: string;
	cleanupTimeoutMs: number;
}
export const DEFAULT_CLEANUP_SETTINGS: CleanupSettings = {
	cleanupModel: "mimo-v2.6-flash", cleanupTimeoutMs: 5_000,
};

export interface CleanupUsage {
	inputTokens: number;
	cachedTokens: number;
	outputTokens: number;
	reasoningTokens: number;
}
export interface CleanupResult {
	text: string;
	elapsedMs: number;
	usage?: CleanupUsage;
}

export function validateCleanupSettings(settings: CleanupSettings): void {
	if (!settings || !["mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed"].includes(settings.cleanupModel)
		|| !Number.isInteger(settings.cleanupTimeoutMs) || settings.cleanupTimeoutMs < 100 || settings.cleanupTimeoutMs > 30_000) {
		throw new Error("MiMo 清洗配置无效，请检查 cleanupModel / cleanupTimeoutMs；保留原文");
	}
}

function readUsage(value: any): CleanupUsage | undefined {
	if (!value || !Number.isSafeInteger(value.prompt_tokens) || value.prompt_tokens < 0
		|| !Number.isSafeInteger(value.completion_tokens) || value.completion_tokens < 0) return undefined;
	const cached = value.prompt_tokens_details?.cached_tokens ?? 0;
	const reasoning = value.completion_tokens_details?.reasoning_tokens ?? 0;
	if (!Number.isSafeInteger(cached) || cached < 0 || cached > value.prompt_tokens
		|| !Number.isSafeInteger(reasoning) || reasoning < 0 || reasoning > value.completion_tokens) return undefined;
	return { inputTokens: value.prompt_tokens, cachedTokens: cached, outputTokens: value.completion_tokens, reasoningTokens: reasoning };
}

/** 总超时覆盖 HTTP 请求和响应体读取；异常消息不携带服务端正文、转写或 Key。 */
export async function cleanupTranscriptWithMetrics(
	raw: string, apiKey: string, settings: CleanupSettings = DEFAULT_CLEANUP_SETTINGS, signal?: AbortSignal,
): Promise<CleanupResult> {
	signal?.throwIfAborted();
	validateCleanupSettings(settings);
	if (typeof raw !== "string" || !raw.trim() || raw.length > 16000) {
		throw new Error("转写长度不适合自动清洗，保留原文");
	}
	if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("请先设置 MiMo API Key，保留原文");
	const started = performance.now();
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), settings.cleanupTimeoutMs);
	const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
	try {
		let response: Response;
		let data: any;
		try {
			response = await fetch(`${BASE_URL}/chat/completions`, {
				method: "POST", redirect: "error",
				headers: { "api-key": apiKey, "Content-Type": "application/json" },
				body: JSON.stringify({
					model: settings.cleanupModel,
					messages: [
						{ role: "system", content: CLEANUP_PROMPT },
						{ role: "user", content: JSON.stringify({ transcript: raw }) },
					],
					thinking: { type: "disabled" }, response_format: { type: "text" },
					temperature: 0, stream: false,
					// 返回全文而非编辑列表，按原文长度预留输出空间，避免长转写被截断。
					max_completion_tokens: Math.min(16_384, Math.max(1024, raw.length * 2)),
				}),
				signal: requestSignal,
			});
		} catch {
			throw new Error("MiMo 清洗网络请求失败，保留原文");
		}
		requestSignal.throwIfAborted();
		if (!response.ok) {
			// 不回显服务端错误正文，其中可能含凭据或转写；不重试、不调用第二个模型。
			void response.body?.cancel().catch(() => {});
			throw new Error(`MiMo 清洗 HTTP ${response.status}，请检查网络、API Key 或额度；保留原文`);
		}
		try { data = await response.json(); } catch { throw new Error("MiMo 清洗响应不是有效 JSON，保留原文"); }
		requestSignal.throwIfAborted();
		if (!Array.isArray(data?.choices) || data.choices.length !== 1) throw new Error("MiMo 清洗响应无效，保留原文");
		const choice = data.choices[0];
		if (choice?.finish_reason !== "stop" || choice.message?.role !== "assistant"
			|| (choice.message.tool_calls != null && (!Array.isArray(choice.message.tool_calls) || choice.message.tool_calls.length))
			|| typeof choice.message?.content !== "string" || !choice.message.content.trim()) {
			throw new Error("MiMo 清洗输出不完整、被拦截或含工具调用，保留原文");
		}
		// 接受模型的全文整理，不再检查逐字替换、语义等价、词表或纠正范围。
		// 内容是否准确由用户在编辑器中复核；这里仅检查 API 响应完整、非空且没有工具调用。
		const text = choice.message.content.trim();
		requestSignal.throwIfAborted();
		return { text, elapsedMs: performance.now() - started, usage: readUsage(data.usage) };
	} catch (error) {
		if (signal?.aborted) throw new Error("MiMo 口语清洗已取消，保留原文");
		if (deadline.signal.aborted) throw new Error(`MiMo 口语清洗超时（${settings.cleanupTimeoutMs}ms），保留原文`);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

export async function cleanupTranscript(
	raw: string, apiKey: string, settings: CleanupSettings = DEFAULT_CLEANUP_SETTINGS, signal?: AbortSignal,
): Promise<string> {
	return (await cleanupTranscriptWithMetrics(raw, apiKey, settings, signal)).text;
}
