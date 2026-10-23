/** 紧凑的语音状态栏；计时和动画只刷新展示，不参与录音生命周期。 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type VoiceStatus =
	| { kind: "idle"; enabled: boolean; shortcut: string }
	| { kind: "starting"; progress?: number; test?: boolean; shortcut?: string }
	| { kind: "recording"; test: boolean; startedAt: number; shortcut: string }
	| { kind: "recognizing" }
	| { kind: "cleaning" }
	| { kind: "replaying" };

const SPINNER_FRAMES = ["◜", "◝", "◞", "◟"];

function shortcutLabel(shortcut: string): string {
	return shortcut.replace(/\bf\d+\b/gi, (key) => key.toUpperCase());
}

function elapsedTime(startedAt: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export class VoiceStatusBar {
	private timer?: ReturnType<typeof setTimeout>;
	private lastText?: string;
	private kind?: VoiceStatus["kind"];
	private frame = 0;
	private startupAt = 0;
	private shortcut = "F8";
	private test = false;

	update(ctx: ExtensionContext, state: VoiceStatus): void {
		clearTimeout(this.timer);
		if (!ctx.hasUI) return;
		if (state.kind !== this.kind) {
			this.frame = 0;
			if (state.kind === "starting") this.startupAt = Date.now();
		}
		this.kind = state.kind;
		if (state.kind === "idle" || state.kind === "recording" || state.kind === "starting") {
			this.shortcut = shortcutLabel(state.shortcut ?? "f8");
			this.test = state.kind !== "idle" && !!state.test;
		}
		const refresh = () => {
			const theme = ctx.ui.theme;
			const hint = (text: string) => theme.fg("dim", text);
			// 圆点+空格+两字标签（或 M:SS）共六列，快捷键固定且无尾部占位。
			const lane = 6;
			const shortcut = this.test ? "/voice-test" : this.shortcut;
			const suffix = hint(` · ${shortcut}`);
			let text: string;
			switch (state.kind) {
				case "idle":
					text = hint(`${state.enabled ? "○ 语音" : "○ 关闭"} · ${shortcut}`);
					break;
				case "starting": {
					// 展示可预估推进，但永远留最后一格，只有真实就绪才允许圆点落位。
					// 从按键时刻计时，避免录音后端成块写入 WAV 时动画长时间静止。
					const elapsed = Math.max(0, Date.now() - this.startupAt);
					const progress = state.progress === 1 ? 1 : Math.min(0.9, elapsed / 1000);
					const position = Math.ceil((lane - 1) * (1 - progress));
					// 预热始终用强调色空心圆；只有进入录音状态才显示红色实心圆和计时。
					const dot = theme.fg("accent", "○");
					text = " ".repeat(position) + dot + " ".repeat(lane - position - 1) + suffix;
					break;
				}
				case "recording":
					text = `${theme.fg("error", "●")} ${elapsedTime(state.startedAt)}` + suffix;
					break;
				case "recognizing":
				case "cleaning": {
					const label = state.kind === "recognizing" ? "识别" : "整理";
					text = `${theme.fg("accent", SPINNER_FRAMES[this.frame++ % SPINNER_FRAMES.length])} ${label}` + suffix;
					break;
				}
				case "replaying":
					text = `${theme.fg("accent", "▷")} 回放` + suffix;
					break;
			}
			// Pi footer 会折叠普通空格并 trim；不换行空格保留列宽，ANSI 边界保护首尾留白。
			// 不改变终端光标，只输出宿主本来就支持的 SGR reset。
			text = `\x1b[0m${text.replace(/ {2,}/g, spaces => "\u00a0".repeat(spaces.length))}\x1b[0m`;
			if (text !== this.lastText) {
				ctx.ui.setStatus("mimo-voice", text);
				this.lastText = text;
			}
			if (ctx.mode === "tui") {
				this.timer = setTimeout(refresh, state.kind === "starting" ? 50
					: state.kind === "recognizing" || state.kind === "cleaning" ? 120 : 1000);
				this.timer.unref();
			}
		};
		refresh();
	}

	stop(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.lastText = undefined;
		this.kind = undefined;
	}
}
