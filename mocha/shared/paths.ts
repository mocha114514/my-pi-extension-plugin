import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

/** User state stays outside the installed package so updates can replace it. */
export function getMochaDir(): string {
	return join(getAgentDir(), "mocha-cache");
}
