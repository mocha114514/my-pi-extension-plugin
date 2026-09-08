import { createHash } from "node:crypto";
import { hostname } from "node:os";
import type { Owner, OwnerState } from "../types.ts";
import { queryDarwin } from "./darwin.ts";
import { queryLinux } from "./linux.ts";
import type { IdentityResult } from "./query.ts";
import { queryWindows } from "./win32.ts";

const host = createHash("sha256")
	.update(`${process.platform}:${hostname()}`)
	.digest("hex");

export async function queryIdentity(pid: number): Promise<IdentityResult> {
	if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unknown" };
	if (process.platform === "linux") return queryLinux(pid);
	if (process.platform === "darwin") return queryDarwin(pid);
	if (process.platform === "win32") return queryWindows(pid);
	return { state: "unknown" };
}

export async function currentOwner(): Promise<Owner> {
	const identity = await queryIdentity(process.pid);
	return {
		platform: process.platform,
		host,
		pid: process.pid,
		start: identity.start ?? null,
	};
}

export async function probeOwner(owner: Owner): Promise<OwnerState> {
	if (
		owner.host !== host ||
		owner.platform !== process.platform ||
		!owner.start
	)
		return "unknown";
	const current = await queryIdentity(owner.pid);
	if (current.state === "gone") return "gone";
	if (current.state !== "found") return "unknown";
	return current.start === owner.start ? "alive" : "gone";
}
