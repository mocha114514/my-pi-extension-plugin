import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const execute = promisify(execFile);
export interface IdentityResult {
	state: "found" | "gone" | "unknown";
	start?: string;
}
export const commandOptions = {
	timeout: 10000,
	windowsHide: true,
	maxBuffer: 65536,
	encoding: "utf8" as const,
};
