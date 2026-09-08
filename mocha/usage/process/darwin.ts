import { createHash, randomUUID } from "node:crypto";
import {
	access,
	chmod,
	mkdir,
	readFile,
	rename,
	unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IdentityResult } from "./query.ts";
import { commandOptions, execute } from "./query.ts";

let helper: Promise<string> | undefined;

async function prepare(): Promise<string> {
	const source = fileURLToPath(new URL("./darwin.c", import.meta.url));
	const hash = createHash("sha256")
		.update(await readFile(source))
		.digest("hex")
		.slice(0, 16);
	const directory = join(tmpdir(), `pi-usage-${process.getuid?.() ?? "user"}`);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const binary = join(directory, `identity-${process.arch}-${hash}`);
	try {
		await access(binary);
		return binary;
	} catch {
		/* Build once for this source and architecture. */
	}
	const temporary = `${binary}.${randomUUID()}`;
	try {
		await execute("/usr/bin/cc", ["-O2", source, "-o", temporary, "-lproc"], {
			...commandOptions,
			timeout: 30000,
		});
		await chmod(temporary, 0o700);
		await rename(temporary, binary);
	} finally {
		await unlink(temporary).catch(() => {});
	}
	return binary;
}

export async function queryDarwin(pid: number): Promise<IdentityResult> {
	try {
		helper ??= prepare();
		const binary = await helper;
		const { stdout } = await execute(binary, [String(pid)], commandOptions);
		const token = stdout.trim();
		if (token === "gone") return { state: "gone" };
		return /^\d+:\d+$/.test(token)
			? { state: "found", start: token }
			: { state: "unknown" };
	} catch {
		return { state: "unknown" };
	}
}
