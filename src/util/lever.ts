/** a non-negative lever value floored to a whole number, or undefined when absent or unusable */
export function leverInt(raw: unknown): number | undefined {
	const n = Number(raw);
	if (raw !== undefined && raw !== null && String(raw) !== '' && Number.isFinite(n) && n >= 0) {
		return Math.floor(n);
	}
	return undefined;
}
