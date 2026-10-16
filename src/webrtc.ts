import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { commandExists } from "./audio.ts";

const execute = promisify(execFile);
export type PulseCommand = (args: string[]) => Promise<string>;
export interface ProcessedInput {
	source: string;
	master: string;
	moduleId: string;
	dispose(): Promise<void>;
}

async function pulseCommand(args: string[]): Promise<string> {
	const result = await execute("pactl", args, {
		env: { ...process.env, LC_ALL: "C" }, timeout: 5000, maxBuffer: 256 * 1024,
	});
	return result.stdout.trim();
}

// pactl 不经过 shell，但 PulseAudio 的模块参数本身仍需要转义。
const parameter = (key: string, value: string) => `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** 只创建本次录音私有的虚拟源；不设置默认设备，也不启用硬件模拟 AGC。 */
export async function prepareWebrtcInput(
	device = "",
	run: PulseCommand = pulseCommand,
	name = `pi_mimo_${process.pid}_${randomBytes(6).toString("hex")}`,
): Promise<ProcessedInput> {
	if (run === pulseCommand && !commandExists("pactl")) {
		throw new Error("WebRTC 录音处理需要 pactl，请安装 pulseaudio-utils");
	}
	const info = await run(["info"]);
	const master = device || info.match(/^Default Source:\s*(.+)$/m)?.[1]?.trim();
	const sink = info.match(/^Default Sink:\s*(.+)$/m)?.[1]?.trim();
	if (!master || !sink) throw new Error("无法确定 PulseAudio 默认输入/输出，不能建立 WebRTC 录音源");
	if (master.endsWith(".monitor")) throw new Error("WebRTC 录音处理需要实际麦克风，不能使用系统声音回环");
	if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error("无效的临时 WebRTC 录音源名称");

	let moduleId: string;
	try {
		moduleId = (await run([
			"load-module", "module-echo-cancel",
			parameter("source_master", master), parameter("sink_master", sink),
			parameter("source_name", name), parameter("sink_name", `${name}_sink`),
			"aec_method=webrtc", "rate=48000", "channels=1", "use_volume_sharing=0",
			parameter("aec_args", "analog_gain_control=0 digital_gain_control=1 noise_suppression=1 high_pass_filter=1"),
		])).trim();
	} catch {
		// 如果 pactl 超时但服务端已经加载，按唯一名称收回本次资源，绝不卸载其他模块。
		try {
			const modules = await run(["list", "short", "modules"]);
			for (const line of modules.split("\n")) {
				if (line.includes(`source_name="${name}"`) || line.includes(`source_name=${name} `)) {
					const id = line.split(/\s+/)[0];
					if (/^\d+$/.test(id)) await run(["unload-module", id]);
				}
			}
		} catch { /* 音频服务可能已关闭；未修改系统配置。 */ }
		throw new Error("无法加载 PulseAudio WebRTC 处理模块；检查 module-echo-cancel / libwebrtc_audio_processing。PipeWire 未必支持此模块，可设置 recordingProcessing: \"none\" 使用原始录音");
	}
	if (!/^\d+$/.test(moduleId)) throw new Error("PulseAudio 未返回有效 WebRTC 模块 ID");
	let disposed = false;
	let pending: Promise<void> | undefined;
	return {
		source: name, master, moduleId,
		dispose() {
			if (disposed) return Promise.resolve();
			pending ??= run(["unload-module", moduleId]).then(() => { disposed = true; })
				.finally(() => { pending = undefined; });
			return pending;
		},
	};
}
