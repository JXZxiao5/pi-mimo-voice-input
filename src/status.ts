/** 紧凑的语音状态栏；计时和动画只刷新展示，不参与录音生命周期。 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type VoiceStatus =
	| { kind: "idle"; enabled: boolean; shortcut: string }
	| { kind: "starting" }
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
	return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export class VoiceStatusBar {
	private timer?: ReturnType<typeof setTimeout>;
	private lastText?: string;
	private kind?: VoiceStatus["kind"];
	private frame = 0;

	update(ctx: ExtensionContext, state: VoiceStatus): void {
		clearTimeout(this.timer);
		if (!ctx.hasUI) return;
		if (state.kind !== this.kind) this.frame = 0;
		this.kind = state.kind;
		const busy = state.kind === "starting" || state.kind === "recognizing" || state.kind === "cleaning";
		const refresh = () => {
			// 每次取当前主题；空闲时也检查主题变化，但不重复写入相同的状态。
			const theme = ctx.ui.theme;
			const hint = (text: string) => theme.fg("dim", text);
			const spinner = () => theme.fg("accent", SPINNER_FRAMES[this.frame++ % SPINNER_FRAMES.length]);
			let text: string;
			switch (state.kind) {
				case "idle":
					text = hint(state.enabled ? `○ 语音 · ${shortcutLabel(state.shortcut)}` : "○ 语音已关闭");
					break;
				case "starting":
					text = `${spinner()} 麦克风启动中`;
					break;
				case "recording":
					text = `${theme.fg("error", "●")} ${state.test ? "自检录音" : "录音"} ${elapsedTime(state.startedAt)}`
						+ hint(` · ${state.test ? "/voice-test" : shortcutLabel(state.shortcut)} 停止`);
					break;
				case "recognizing":
					text = `${spinner()} 识别中`;
					break;
				case "cleaning":
					text = `${spinner()} 整理中`;
					break;
				case "replaying":
					text = `${theme.fg("accent", "▷")} 自检回放` + hint(" · /voice-test 停止");
					break;
			}
			if (text !== this.lastText) {
				ctx.ui.setStatus("mimo-voice", text);
				this.lastText = text;
			}
			if (ctx.mode === "tui") {
				this.timer = setTimeout(refresh, busy ? 120 : 1000);
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
