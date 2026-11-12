import { execFile } from "node:child_process";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const UNIT = "pi-mimo-voice.service";
export interface CaptureConfig {
	recordingDevice: string;
	recordingProcessing: string;
	recordingBackend: string;
	recordingWarmupMs?: number;
}
export interface CaptureStatus { ready: boolean; error: string; busy: boolean; owned: boolean }
export const captureTime = () => Number(process.hrtime.bigint()) / 1e9;

export async function controlDaemon(action: "stop" | "restart", config: CaptureConfig): Promise<void> {
	try {
		await execute("systemctl", ["--user", "stop", UNIT], { timeout: 5000 });
	} catch (error) {
		// Transient units disappear after stop; restart must also work from that state.
		const { stdout } = await execute("systemctl", ["--user", "show", UNIT, "--property=LoadState", "--value"], { timeout: 5000 });
		if (stdout.trim() !== "not-found") throw error;
	}
	if (action === "restart") {
		const client = await CaptureClient.open(config);
		client.close();
	}
}

export class CaptureClient {
	private sequence = 0;
	private buffer = "";
	private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
	private socket: Socket;
	private constructor(socket: Socket) {
		this.socket = socket;
		socket.setEncoding("utf8");
		socket.on("data", (data: string) => {
			this.buffer += data;
			if (this.buffer.length > 10_000_000) { this.close(); return; }
			let newline: number;
			while ((newline = this.buffer.indexOf("\n")) >= 0) {
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				try {
					const reply = JSON.parse(line);
					const pending = this.pending.get(reply.id);
					if (!pending) continue;
					this.pending.delete(reply.id);
					clearTimeout(pending.timer);
					if (reply.error) pending.reject(new Error(reply.error));
					else pending.resolve(reply.result);
				} catch { this.close(); return; }
			}
		});
		socket.on("error", () => this.close());
		socket.on("close", () => {
			for (const pending of this.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error("语音后台连接断开；未完成录音已取消"));
			}
			this.pending.clear();
		});
	}

	static async open(config: CaptureConfig, start = true): Promise<CaptureClient> {
		if (process.platform !== "linux" || !process.env.XDG_RUNTIME_DIR) {
			throw new Error("常驻录音需要 Ubuntu/Linux 用户会话与 XDG_RUNTIME_DIR；可手动设置 recordingMode: legacy");
		}
		const path = join(process.env.XDG_RUNTIME_DIR, "pi-mimo-voice", "capture.sock");
		const dial = () => new Promise<CaptureClient>((resolve, reject) => {
			const socket = connect(path);
			const timer = setTimeout(() => socket.destroy(new Error("连接语音后台超时")), 1000);
			socket.once("error", reject);
			socket.once("close", () => clearTimeout(timer));
			socket.once("connect", () => {
				clearTimeout(timer);
				socket.removeListener("error", reject);
				resolve(new CaptureClient(socket));
			});
		});
		let client: CaptureClient;
		try { client = await dial(); }
		catch (error) {
			if (!start) throw error;
			// A transient user unit provides a single instance without login autostart.
			// Concurrent starts may report "unit already exists"; all clients then dial it.
			let launchError: unknown;
			try {
				await execute("systemd-run", ["--user", `--unit=${UNIT}`, "--collect",
					"--property=Restart=on-failure", "--property=RestartSec=2",
					"--property=UMask=0077", "--property=KillMode=control-group", "--property=PartOf=graphical-session.target",
					"--", "/usr/bin/python3", fileURLToPath(new URL("./voice-daemon.py", import.meta.url))], { timeout: 5000 });
			} catch (cause) { launchError = cause; }
			let connected: CaptureClient | undefined;
			for (let attempt = 0; attempt < 30; attempt++) {
				try { connected = await dial(); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
			}
			if (!connected) throw new Error(`无法启动语音后台，请检查 systemctl --user status ${UNIT}；${String(launchError ?? "连接超时")}`);
			client = connected;
		}
		try {
			await client.request("hello", { protocol: 1, config: {
				recordingDevice: config.recordingDevice, recordingProcessing: config.recordingProcessing,
				recordingBackend: config.recordingBackend, recordingWarmupMs: config.recordingWarmupMs ?? 1000,
			} });
			return client;
		} catch (error) { client.close(); throw error; }
	}

	request(op: string, args: Record<string, unknown> = {}): Promise<any> {
		if (this.socket.destroyed) return Promise.reject(new Error("语音后台未连接，请 /voice-daemon restart"));
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.close(); }, 5000);
			this.pending.set(id, { resolve, reject, timer });
			this.socket.write(JSON.stringify({ id, op, ...args }) + "\n");
		});
	}
	status(): Promise<CaptureStatus> { return this.request("status"); }
	async start(at: number): Promise<void> { await this.request("start", { at }); }
	async stop(at: number): Promise<Buffer> {
		const result = await this.request("stop", { at });
		return Buffer.from(result.wav, "base64");
	}
	async cancel(): Promise<void> { await this.request("cancel"); }
	close(): void { this.socket.destroy(); }
}
