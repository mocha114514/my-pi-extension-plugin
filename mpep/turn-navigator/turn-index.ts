export interface TurnAnchor {
	readonly key: number;
	readonly row: number;
	readonly text: string;
}

export function navigationBand(viewportHeight: number): { top: number; height: number } {
	const available = Math.max(0, Math.floor(viewportHeight));
	const height = Math.min(available, Math.max(3, Math.round(available * 0.5)));
	return { top: Math.min(Math.floor(available * 0.3), available - height), height };
}

export function activeTurn(anchors: readonly TurnAnchor[], scrollTop: number): number {
	if (anchors.length === 0) return -1;
	let low = 0;
	let high = anchors.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (anchors[middle].row <= scrollTop) low = middle + 1;
		else high = middle;
	}
	return Math.max(0, low - 1);
}

export function markerRows(count: number, height: number, start = 0): Map<number, number> {
	const slots = Math.max(0, height - 2);
	const visible = Math.min(count, slots);
	const first = Math.max(0, Math.min(start, count - visible));
	const result = new Map<number, number>();
	for (let index = 0; index < visible; index++) {
		const row = visible === 1 ? 1 + Math.floor((slots - 1) / 2) : 1 + Math.round((index * (slots - 1)) / (visible - 1));
		result.set(row, first + index);
	}
	return result;
}

export function sameAnchors(left: readonly TurnAnchor[], right: readonly TurnAnchor[]): boolean {
	return (
		left.length === right.length &&
		left.every((item, index) => {
			const other = right[index];
			return item.key === other.key && item.row === other.row && item.text === other.text;
		})
	);
}
