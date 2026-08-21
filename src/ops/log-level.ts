/**
 * How much of PHP's log reaches `console.log`, and therefore `wrangler tail`.
 *
 * `CfwLogger` ships every Drupal log entry across the host bridge, and the DO mirrors all of it to
 * `console.log` so it survives the isolate that produced it. Unmirrored, that is the right default
 * for a ring buffer and the wrong one for a terminal: a single page render emits several
 * severity-7 deprecation notices with full stack traces, which is what a `wrangler dev` session
 * mostly prints.
 *
 * The ceiling is RFC 5424, so it is the same scale `CfwLogger` already sends in `severity` and the
 * same one Drupal's own `watchdog` uses. Lower is more severe.
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
 *
 * An unrecognised value is the default rather than an error: a typo in a var must not silence the
 * log, and it must not take the object down either.
 *
 * @param level - the configured name, case-insensitive; `off` silences the mirror entirely
 * @returns a severity ceiling, `-1` when nothing may pass
 */
export function phpLogCeiling(level?: string | null): number {
	const name = String(level ?? '')
		.trim()
		.toLowerCase();
	return CEILINGS[name] ?? CEILINGS[DEFAULT_PHP_LOG_LEVEL]!;
}

/**
 * Whether one log entry passes the ceiling.
 *
 * The severity is read from the entry when it carries one and derived from `level` when it does not
 * -- `CfwLogger::installFatalHandler()` ships `level: "error"` with no severity, and a fatal is the
 * one entry that must never be dropped by a missing field.
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
