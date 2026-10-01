/**
 * How much of PHP's log reaches `console.log`, and therefore `wrangler tail`.
 *
 * One render emits several severity-7 deprecation notices, so the mirror takes a ceiling on the
 * RFC 5424 `severity` scale (lower is more severe).
 * @module
 */

/** the names `CfwLogger::LEVELS` maps severities onto, plus the two ends of the dial */
const CEILINGS: Record<string, number> = {
	off: -1,
	error: 3,
	warn: 4,
	warning: 4,
	log: 5,
	notice: 5,
	info: 6,
	debug: 7,
	all: 7
};

/** what a site gets without saying anything: everything except `debug` */
export const DEFAULT_PHP_LOG_LEVEL = 'info';

/**
 * The highest RFC 5424 severity that may reach `console.log`.
 * An unrecognised value falls back to the default, so a typo in a var neither silences the log nor
 * throws.
 *
 * @param level - the configured name, case-insensitive; `off` silences the mirror entirely
 * @returns a severity ceiling, `-1` when nothing may pass
 */
export function phpLogCeiling(level?: string): number {
	const name = String(level ?? '')
		.trim()
		.toLowerCase();
	return CEILINGS[name] ?? CEILINGS[DEFAULT_PHP_LOG_LEVEL]!;
}

/**
 * Whether one log entry passes the ceiling.
 * Severity comes from the entry, or from `level` when absent (`CfwLogger::installFatalHandler()`
 * sends a fatal as `level: "error"` with no severity, and it must never be dropped).
 *
 * @param entry - the decoded payload `cfwLog` received
 * @param ceiling - from {@link phpLogCeiling}
 */
export function phpLogPasses(
	entry: { severity?: unknown; level?: unknown },
	ceiling: number
): boolean {
	const raw = entry.severity;
	const severity =
		typeof raw === 'number' && Number.isFinite(raw)
			? raw
			: typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))
				? Number(raw)
				: fromName(entry.level);
	return severity <= ceiling;
}

/** the reverse of `CfwLogger::LEVELS`, for an entry that carries a name and no number */
function fromName(level: unknown): number {
	const name = String(level ?? '')
		.trim()
		.toLowerCase();
	// an unknown name is treated as `log`, which is what CfwLogger falls back to on its own side
	return CEILINGS[name] ?? 5;
}
