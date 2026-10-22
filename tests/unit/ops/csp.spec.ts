import { beforeEach, describe, expect, it } from 'vitest';
import {
	CSP_BASELINE,
	CSP_MODES,
	CSP_REPORT_GLOBAL_LIMIT,
	CSP_REPORT_IP_LIMIT,
	CSP_REPORT_MAX_ENTRIES,
	CSP_REPORT_WINDOW_MS,
	cspBaselineHeader,
	cspReportAllowed,
	parseCspReport,
	resetCspReportBudget
} from '../../../src/ops/csp';
import { cspMode, LEVER_DOMAINS, leverRefusal, OWNER_ONLY_LEVERS } from '../../../src/ops/plan';

describe('the CSP mode follows the lever, then the plan', () => {
	it('is off on free and report-only on paid when nothing is set', () => {
		expect(cspMode({})).toBe('off');
		expect(cspMode({ PLAN: 'free' })).toBe('off');
		expect(cspMode({ PLAN: 'paid' })).toBe('report-only');
		expect(cspMode(undefined)).toBe('off');
	});

	it.each(CSP_MODES)('honours an explicit %s on either plan', (mode) => {
		expect(cspMode({ PLAN: 'free', CSP_MODE: mode })).toBe(mode);
		expect(cspMode({ PLAN: 'paid', CSP_MODE: mode })).toBe(mode);
	});

	it('reads the value case-insensitively and trimmed', () => {
		expect(cspMode({ CSP_MODE: ' Enforce ' })).toBe('enforce');
	});

	it.each(['', 'on', 'report', 'ENFORCED', 1])(
		'falls back to the plan default for %j, so a typo does not switch a paid site off',
		(value) => {
			expect(cspMode({ PLAN: 'paid', CSP_MODE: value })).toBe('report-only');
			expect(cspMode({ PLAN: 'free', CSP_MODE: value })).toBe('off');
		}
	);

	it('agrees with the settings surface about which values exist', () => {
		expect(LEVER_DOMAINS.CSP_MODE).toEqual({ kind: 'enum', values: CSP_MODES });
		expect(leverRefusal('CSP_MODE', 'report-only')).toBeUndefined();
		expect(leverRefusal('CSP_MODE', '')).toBeUndefined();
		expect(leverRefusal('CSP_MODE', 'strict')).toMatch(
			/must be one of off, report-only, enforce/
		);
	});

	it('is owner-only, which keeps it out of the form Drupal renders', () => {
		expect(OWNER_ONLY_LEVERS.has('CSP_MODE')).toBe(true);
	});
});

describe('the header each mode sends', () => {
	it('sends nothing for off', () => {
		expect(cspBaselineHeader('off')).toBeUndefined();
	});

	it('sends the report-only header for report-only and the enforcing one for enforce', () => {
		expect(cspBaselineHeader('report-only')).toEqual({
			name: 'content-security-policy-report-only',
			value: CSP_BASELINE
		});
		expect(cspBaselineHeader('enforce')).toEqual({
			name: 'content-security-policy',
			value: CSP_BASELINE
		});
	});

	it('names the four directives and sets no source list, so core inline script keeps working', () => {
		expect(CSP_BASELINE).toBe(
			"object-src 'none'; base-uri 'self'; frame-ancestors 'self'; report-uri /csp-report"
		);
		for (const directive of ['default-src', 'script-src', 'style-src', 'form-action']) {
			expect(CSP_BASELINE).not.toContain(directive);
		}
	});
});

describe('reading a violation report', () => {
	it('reads the legacy report-uri body', () => {
		const body = JSON.stringify({
			'csp-report': {
				'document-uri': 'https://site.test/node/1?token=secret#frag',
				'blocked-uri': 'https://evil.test/x.js?k=v',
				'violated-directive': "object-src 'none'",
				'script-sample': 'a'.repeat(300)
			}
		});
		const [entry, ...rest] = parseCspReport(body);
		expect(rest).toEqual([]);
		expect(entry).toEqual({
			blockedUri: 'https://evil.test/x.js',
			violatedDirective: "object-src 'none'",
			documentPath: '/node/1',
			sample: 'a'.repeat(80)
		});
	});

	it('reads the Reporting API body, and skips entries that are not CSP violations', () => {
		const body = JSON.stringify([
			{ type: 'deprecation', body: { id: 'x' } },
			{
				type: 'csp-violation',
				url: 'https://site.test/',
				body: {
					documentURL: 'https://site.test/user/login?destination=%2F',
					blockedURL: 'inline',
					effectiveDirective: 'base-uri',
					sample: 'x'
				}
			}
		]);
		expect(parseCspReport(body)).toEqual([
			{
				blockedUri: 'inline',
				violatedDirective: 'base-uri',
				documentPath: '/user/login',
				sample: 'x'
			}
		]);
	});

	it('keeps no more entries than the cap from one request', () => {
		const item = { type: 'csp-violation', body: { blockedURL: 'eval' } };
		const body = JSON.stringify(Array.from({ length: 50 }, () => item));
		expect(parseCspReport(body)).toHaveLength(CSP_REPORT_MAX_ENTRIES);
	});

	it.each(['', 'not json', '42', 'null', '{"other":1}', '[1,2]', '{"csp-report":"x"}'])(
		'reads %j as no report',
		(body) => {
			expect(parseCspReport(body)).toEqual([]);
		}
	);

	it('removes a line break from a field so one report is one log line', () => {
		const body = JSON.stringify({
			'csp-report': { 'violated-directive': 'a\nb', 'script-sample': 'c\r\nd' }
		});
		const [entry] = parseCspReport(body);
		expect(entry?.violatedDirective).toBe('a b');
		expect(entry?.sample).toBe('c  d');
	});
});

describe('the report budget', () => {
	beforeEach(() => resetCspReportBudget());

	it('lets one address send its limit and answers the rest without a log', () => {
		const answers = Array.from({ length: CSP_REPORT_IP_LIMIT + 3 }, () =>
			cspReportAllowed('1.2.3.4', 1000)
		);
		expect(answers.filter(Boolean)).toHaveLength(CSP_REPORT_IP_LIMIT);
		expect(answers.slice(-3)).toEqual([false, false, false]);
	});

	it('counts each address on its own', () => {
		for (let i = 0; i < CSP_REPORT_IP_LIMIT; i++) cspReportAllowed('1.1.1.1', 0);
		expect(cspReportAllowed('1.1.1.1', 0)).toBe(false);
		expect(cspReportAllowed('2.2.2.2', 0)).toBe(true);
	});

	it('starts a new window after the window passes', () => {
		for (let i = 0; i <= CSP_REPORT_IP_LIMIT; i++) cspReportAllowed('1.1.1.1', 0);
		expect(cspReportAllowed('1.1.1.1', CSP_REPORT_WINDOW_MS - 1)).toBe(false);
		expect(cspReportAllowed('1.1.1.1', CSP_REPORT_WINDOW_MS)).toBe(true);
	});

	it('caps every address together, so rotating addresses cannot raise the total', () => {
		let allowed = 0;
		for (let i = 0; i < CSP_REPORT_GLOBAL_LIMIT + 50; i++) {
			if (cspReportAllowed(`10.0.${Math.floor(i / 250)}.${i % 250}`, 0)) allowed++;
		}
		expect(allowed).toBe(CSP_REPORT_GLOBAL_LIMIT);
	});
});
