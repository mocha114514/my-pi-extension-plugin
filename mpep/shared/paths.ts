import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

/** User state stays outside the installed package so updates can replace it. */
export function getCacheDir(): string {
	return join(getAgentDir(), "mpep-cache");
}
