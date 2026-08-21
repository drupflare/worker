import { describe, expect, it } from 'vitest';
import { DEFAULT_PHP_LOG_LEVEL, phpLogCeiling, phpLogPasses } from '../../../src/ops/log-level';

/**
 * The dial between "a terminal a human can read" and "everything PHP said".
 *
 * The default is the interesting case rather than the extremes: `debug` has to be OFF, because on
 * 8.5 a single render emits several severity-7 deprecation notices with full stack traces, and
 * everything a site owner would act on has to still be ON.
 */

const at = (severity: number) => ({ severity, level: 'whatever' });

describe('the ceiling', () => {
	it('reads every name CfwLogger can emit', () => {
		expect(phpLogCeiling('off')).toBe(-1);
		expect(phpLogCeiling('error')).toBe(3);
		expect(phpLogCeiling('warn')).toBe(4);
		expect(phpLogCeiling('log')).toBe(5);
		expect(phpLogCeiling('info')).toBe(6);
		expect(phpLogCeiling('debug')).toBe(7);
	});

	it('is case- and whitespace-insensitive, because a var is typed by hand', () => {
		expect(phpLogCeiling('  DeBuG ')).toBe(7);
	});

	// a typo in a var must not silence the log, and must not throw inside a log call either
	it('falls back to the default for an unset, empty or unknown value', () => {
		const fallback = phpLogCeiling(DEFAULT_PHP_LOG_LEVEL);
		expect(phpLogCeiling(undefined)).toBe(fallback);
		expect(phpLogCeiling(null)).toBe(fallback);
		expect(phpLogCeiling('')).toBe(fallback);
		expect(phpLogCeiling('verbose')).toBe(fallback);
	});

	it('defaults to letting everything except debug through', () => {
		expect(phpLogCeiling(DEFAULT_PHP_LOG_LEVEL)).toBe(6);
	});
});

describe('what passes it', () => {
	const dflt = phpLogCeiling(DEFAULT_PHP_LOG_LEVEL);

	it('drops debug and keeps the rest, on the default', () => {
		expect(phpLogPasses(at(7), dflt)).toBe(false);
		expect(phpLogPasses(at(6), dflt)).toBe(true);
		expect(phpLogPasses(at(5), dflt)).toBe(true);
		expect(phpLogPasses(at(4), dflt)).toBe(true);
		expect(phpLogPasses(at(0), dflt)).toBe(true);
	});

	it('lets debug through when it is asked for', () => {
		expect(phpLogPasses(at(7), phpLogCeiling('debug'))).toBe(true);
	});

	it('silences everything at off, including a severity 0', () => {
		const off = phpLogCeiling('off');
		expect(phpLogPasses(at(0), off)).toBe(false);
		expect(phpLogPasses(at(7), off)).toBe(false);
	});

	// the payload crosses the host bridge as JSON, and a numeric string is the shape that would
	// otherwise compare as NaN and drop a fatal
	it('accepts a severity that arrived as a string', () => {
		expect(phpLogPasses({ severity: '7' }, dflt)).toBe(false);
		expect(phpLogPasses({ severity: '3' }, dflt)).toBe(true);
	});

	/**
	 * `CfwLogger::installFatalHandler()` ships `level: "error"` and NO severity, so an entry with a
	 * missing number is exactly the one entry that must never be dropped.
	 */
	it('derives the severity from the name when the number is absent', () => {
		expect(phpLogPasses({ level: 'error' }, phpLogCeiling('error'))).toBe(true);
		expect(phpLogPasses({ level: 'debug' }, dflt)).toBe(false);
		expect(phpLogPasses({ level: 'warn' }, dflt)).toBe(true);
	});

	it('treats an entry with neither field as log, which is CfwLogger own fallback', () => {
		expect(phpLogPasses({}, dflt)).toBe(true);
		expect(phpLogPasses({}, phpLogCeiling('error'))).toBe(false);
	});
});
