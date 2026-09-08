import { createHash, randomBytes } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import {
	createConnection,
	createServer,
	type Server,
	type Socket,
} from "node:net";
import { join, resolve } from "node:path";
import { isObject } from "./data.ts";
import { probeOwner } from "./process/index.ts";
import { validOwner } from "./storage.ts";
import {
	type PriceEndpoint,
	type Probe,
	type SourceHeader,
	sourceIdPattern,
} from "./types.ts";

const limit = 4096;
const timeout = 2500;

function validEndpoint(value: unknown): value is PriceEndpoint {
	return (
		isObject(value) &&
		Number.isInteger(value.port) &&
		Number(value.port) > 0 &&
		Number(value.port) <= 65535 &&
		typeof value.token === "string" &&
		/^[a-f0-9]{64}$/.test(value.token) &&
		typeof value.config === "string" &&
		/^[a-f0-9]{64}$/.test(value.config)
	);
}

export async function notificationHeader(
	root: string,
	id: string,
): Promise<SourceHeader | undefined> {
	if (!sourceIdPattern.test(id)) return undefined;
	const handle = await open(join(root, "now", `${id}.jsonl`), "r");
	try {
		const buffer = Buffer.alloc(limit);
		const { bytesRead } = await handle.read(buffer, 0, limit, 0);
		const end = buffer.subarray(0, bytesRead).indexOf(10);
		if (end < 0) return undefined;
		const header: unknown = JSON.parse(
			buffer.subarray(0, end).toString("utf8"),
		);
		if (
			!isObject(header) ||
			header.type !== "header" ||
			header.version !== 1 ||
			header.id !== id ||
			!validOwner(header.owner)
		)
			return undefined;
		if (!validEndpoint(header.notify)) return undefined;
		return header as unknown as SourceHeader;
	} finally {
		await handle.close();
	}
}

export function sendPriceRefresh(endpoint: PriceEndpoint): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port: endpoint.port });
		let response = "";
		let finished = false;
		const finish = (ok: boolean) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(ok);
		};
		const timer = setTimeout(() => finish(false), timeout);
		socket.on("error", () => finish(false));
		socket.on("close", () => finish(false));
		socket.on("connect", () =>
			socket.write(
				`${JSON.stringify({ version: 1, type: "models_changed", token: endpoint.token, config: endpoint.config })}\n`,
			),
		);
		socket.on("data", (data: Buffer) => {
			response += data.toString("utf8");
			if (response.length > limit) finish(false);
			else if (response.includes("\n")) finish(response === "OK\n");
		});
	});
}

export class PriceSync {
	private readonly root: string;
	private readonly config: string;
	private readonly refresh: () => Promise<void>;
	private readonly probe: Probe;
	private readonly sockets = new Set<Socket>();
	private server: Server | undefined;
	private queue = Promise.resolve();
	private broadcast = Promise.resolve();
	private stopped = false;
	endpoint: PriceEndpoint | undefined;

	constructor(
		root: string,
		config: string,
		refresh: () => Promise<void>,
		probe: Probe = probeOwner,
	) {
		this.root = root;
		const path = resolve(config);
		this.config = createHash("sha256")
			.update(process.platform === "win32" ? path.toLowerCase() : path)
			.digest("hex");
		this.refresh = refresh;
		this.probe = probe;
	}

	async start(): Promise<PriceEndpoint> {
		const token = randomBytes(32).toString("hex");
		const server = createServer((socket) => {
			this.sockets.add(socket);
			socket.unref();
			const timer = setTimeout(() => socket.destroy(), timeout);
			socket.on("close", () => {
				clearTimeout(timer);
				this.sockets.delete(socket);
			});
			socket.on("error", () => socket.destroy());
			let message = "";
			let received = false;
			socket.on("data", (data: Buffer) => {
				if (received) return;
				message += data.toString("utf8");
				if (message.length > limit) {
					socket.destroy();
					return;
				}
				if (!message.includes("\n")) return;
				received = true;
				let value: unknown;
				try {
					value = JSON.parse(message);
				} catch {
					socket.destroy();
					return;
				}
				if (
					!isObject(value) ||
					value.version !== 1 ||
					value.type !== "models_changed" ||
					value.token !== token ||
					value.config !== this.config ||
					this.stopped
				) {
					socket.destroy();
					return;
				}
				void this.refreshLocal().then(
					() => socket.end("OK\n"),
					() => socket.end("ERROR\n"),
				);
			});
		});
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		server.on("error", () => {});
		server.unref();
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Price receiver did not start");
		this.endpoint = { port: address.port, token, config: this.config };
		return this.endpoint;
	}

	refreshLocal(): Promise<void> {
		const task = this.queue.then(async () => {
			if (!this.stopped) await this.refresh();
		});
		this.queue = task.catch(() => {});
		return task;
	}

	notifyPeers(onFailure: (count: number) => void): void {
		this.broadcast = this.broadcast
			.then(async () => {
				const files = await readdir(join(this.root, "now"));
				const seen = new Set<string>();
				const owners = new Map<string, ReturnType<Probe>>();
				let failed = 0;
				for (const file of files) {
					if (this.stopped) break;
					if (!file.endsWith(".jsonl")) continue;
					const header = await notificationHeader(
						this.root,
						file.slice(0, -6),
					).catch(() => undefined);
					const endpoint = header?.notify;
					if (
						!header ||
						!endpoint ||
						endpoint.config !== this.config ||
						endpoint.token === this.endpoint?.token
					)
						continue;
					const key = `${endpoint.port}:${endpoint.token}`;
					if (seen.has(key)) continue;
					seen.add(key);
					const owner = JSON.stringify(header.owner);
					if (!owners.has(owner))
						owners.set(
							owner,
							this.probe(header.owner).catch(() => "unknown"),
						);
					if ((await owners.get(owner)) !== "alive") continue;
					if (
						!(await sendPriceRefresh(endpoint)) &&
						!(await sendPriceRefresh(endpoint))
					)
						failed++;
				}
				if (failed && !this.stopped) onFailure(failed);
			})
			.catch(() => {
				if (!this.stopped) onFailure(1);
			});
	}

	async flush(): Promise<void> {
		await this.broadcast;
		await this.queue;
	}

	async close(): Promise<void> {
		this.stopped = true;
		for (const socket of this.sockets) socket.destroy();
		if (this.server?.listening)
			await new Promise<void>((resolve) => this.server?.close(() => resolve()));
		await this.flush();
	}
}
