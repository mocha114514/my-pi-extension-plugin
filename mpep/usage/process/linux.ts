import { readFile } from "node:fs/promises";
import { errorCode } from "../storage.ts";
import type { IdentityResult } from "./query.ts";

export function linuxStart(stat: string, boot: string): string {
	const suffix = stat
		.slice(stat.lastIndexOf(")") + 2)
		.trim()
		.split(/\s+/);
	const ticks = suffix[19];
	if (!/^\d+$/.test(ticks ?? "") || !/^[a-f\d-]+$/i.test(boot.trim()))
		throw new Error("Invalid Linux process identity");
	return `${boot.trim()}:${ticks}`;
}

export async function queryLinux(pid: number): Promise<IdentityResult> {
	try {
		const value = await readFile(`/proc/${pid}/stat`, "utf8");
		const boot = await readFile("/proc/sys/kernel/random/boot_id", "utf8");
		return { state: "found", start: linuxStart(value, boot) };
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			try {
				await readFile(`/proc/${pid}/stat`, "utf8");
			} catch (e) {
				if (errorCode(e) === "ENOENT") return { state: "gone" };
			}
		}
		return { state: "unknown" };
	}
}
