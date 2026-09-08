export interface Totals {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface Bucket extends Totals {
	date: string;
	kind: string;
	provider: string;
	model: string;
}

export interface Owner {
	platform: string;
	host: string;
	pid: number;
	start: string | null;
}

export type OwnerState = "alive" | "gone" | "unknown";
export type Probe = (owner: Owner) => Promise<OwnerState>;

export interface PriceEndpoint {
	port: number;
	token: string;
	config: string;
}

export interface SourceHeader {
	type: "header";
	version: 1;
	id: string;
	owner: Owner;
	notify?: PriceEndpoint;
}

export interface UsageRow extends Omit<Bucket, "date"> {
	type: "usage";
	timestamp: number;
}

export interface SourceSnapshot {
	id: string;
	owner: Owner;
	endOffset: number;
	totals: Bucket[];
	invalid?: string;
}

export interface Ledger {
	version: 1;
	timeZone: string;
	lastLogId: number;
	lastSweepAt: number | null;
	daily: Bucket[];
}

export interface Journal {
	version: 1;
	id: number;
	previous: number;
	timestamp: number;
	delta: Bucket[];
	files: SourceSnapshot[];
}

export interface Pending {
	id: string;
	logId: number;
	endOffset: number;
	invalid?: string;
	reason?: string;
}

export interface Progress {
	phase: "recover" | "scan" | "clean" | "sweep" | "done";
	scanned: number;
	removed: number;
	swept: boolean;
	warnings: string[];
	ledger?: Ledger;
}

export const fields = [
	"calls",
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"cost",
] as const;
export const sourceIdPattern = /^[a-zA-Z0-9_-]{1,120}$/;
