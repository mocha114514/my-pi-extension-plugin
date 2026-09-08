import type { IdentityResult } from "./query.ts";
import { commandOptions, execute } from "./query.ts";

export async function queryWindows(pid: number): Promise<IdentityResult> {
	const script = `$ErrorActionPreference='Stop';try{$p=[System.Diagnostics.Process]::GetProcessById(${pid});$t=$p.StartTime.ToUniversalTime().Ticks;$p.Dispose();[Console]::Write($t.ToString([Globalization.CultureInfo]::InvariantCulture))}catch [System.ArgumentException]{[Console]::Write('gone')}catch{[Console]::Write('unknown')}`;
	try {
		const { stdout } = await execute(
			"powershell.exe",
			["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
			commandOptions,
		);
		const token = stdout.trim();
		if (token === "gone") return { state: "gone" };
		return /^\d{15,20}$/.test(token)
			? { state: "found", start: token }
			: { state: "unknown" };
	} catch {
		return { state: "unknown" };
	}
}
