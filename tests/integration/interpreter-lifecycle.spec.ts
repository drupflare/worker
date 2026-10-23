import { describe, expect, it } from 'vitest';
import { DISABLED } from '../../src/drupal/standin-fix';
import { freshSite, inObject } from '../helpers/serve-do';
import { closedProblems, runAttempts } from '../helpers/vrzno-bridge';

/**
 * What the PHP2Shell analysis in `docs/security.md` rests on, read off the shipping interpreter.
 *
 * Both advisories need a per-request startup and shutdown cycle and an allocator that bails out
 * on `memory_limit`. If a rebuild changes either, these fail and the analysis has to be redone.
 */

const FACTS = `<?php echo json_encode([
	'sapi' => php_sapi_name(),
	'version' => PHP_VERSION,
	'atFloor' => version_compare(PHP_VERSION, '8.5.12', '>='),
	'zendAlloc' => getenv('USE_ZEND_ALLOC'),
	'memoryLimit' => ini_get('memory_limit'),
	'opcache' => ini_get('opcache.enable'),
	'session' => extension_loaded('session'),
	'soap' => extension_loaded('soap'),
	'phar' => extension_loaded('phar'),
]);`;

describe('the interpreter the PHP2Shell analysis describes', () => {
	it('runs with the system allocator, so memory_limit is not enforced', async () => {
		const out = await inObject(freshSite(), async (site) => {
			const facts = await site.runJson(FACTS);
			const held = await site.runJson(
				`<?php ini_set('memory_limit', '8M'); $s = str_repeat('x', 40 * 1024 * 1024); echo json_encode(['held' => strlen($s)]);`
			);
			return { facts, held };
		});
		// the release that carries the PHP2Shell fixes; phasm's php-versions.lock names the same floor
		expect(out.facts['atFloor'], `PHP ${out.facts['version']} is below 8.5.12`).toBe(true);
		expect(out.facts['zendAlloc']).toBe('0');
		expect(out.facts['session']).toBe(true);
		expect(out.facts['soap']).toBe(false);
		expect(out.facts['phar']).toBe(false);
		// an 8M cap holding 40 MB means the memory_limit check, which lives in zend_mm, never runs
		expect(out.held['held']).toBe(40 * 1024 * 1024);
	});

	it('runs code in a retained request, with no shutdown between runs', async () => {
		const out = await inObject(freshSite(), async (site) => {
			const { php } = await site.ensurePhp();
			await php._run(
				`<?php $GLOBALS['__first_run_marker'] = 'kept'; trigger_error('first', E_USER_ERROR);`
			);
			return await site.runJson(
				`<?php echo json_encode(['marker' => $GLOBALS['__first_run_marker'] ?? null, 'last' => error_get_last()['message'] ?? null]);`
			);
		});
		// a request shutdown resets both; here a fatal in one run is still visible to the next
		expect(out['marker']).toBe('kept');
		expect(out['last']).toBe('first');
	});
});

// access is PHP's own bit mask: 1 user, 2 perdir, 4 system, 7 all. Measured on the 8.5.2 build:
// session.upload_progress.enabled is perdir and file_uploads, expose_php and allow_url_include
// are system, so none of the four can be changed by ini_set() and boot is the only place to set
// them; fatal_error_backtraces is user-changeable, so boot sets its default, not its ceiling
const BOOT_INI: Record<string, { value: string; access: number }> = {
	'session.upload_progress.enabled': { value: '0', access: 2 },
	fatal_error_backtraces: { value: '0', access: 7 },
	file_uploads: { value: '0', access: 4 },
	expose_php: { value: '0', access: 4 },
	allow_url_include: { value: '0', access: 4 }
};

describe('the ini the object boots the interpreter with', () => {
	it.each(Object.entries(BOOT_INI))(
		'reads %s back from the running interpreter at its boot value',
		async (name, want) => {
			const got = await inObject(freshSite(), async (site) =>
				site.runJson(
					`<?php $all = ini_get_all(null, true); echo json_encode([
						'value' => ini_get(${JSON.stringify(name)}),
						'global' => $all[${JSON.stringify(name)}]['global_value'] ?? null,
						'access' => $all[${JSON.stringify(name)}]['access'] ?? null,
					]);`
				)
			);
			expect(got['value']).toBe(want.value);
			expect(got['global'], 'the php.ini value, not a runtime override').toBe(want.value);
			expect(got['access'], 'the access level the reason in this file rests on').toBe(
				want.access
			);
		}
	);

	it('adds nothing to disable_functions beyond the names the stand-ins replace', async () => {
		const got = await inObject(freshSite(), async (site) =>
			site.runJson(
				`<?php echo json_encode(['fns' => array_filter(explode(',', ini_get('disable_functions')))]);`
			)
		);
		expect(got['fns']).toEqual([...DISABLED]);
	});
});

describe('the vrzno bridge userland PHP can reach', () => {
	it('answers closed to every attempt, and never reaches fetch or a WebSocket', async () => {
		const g = globalThis as Record<string, unknown>;
		const had = { fetch: g['fetch'], WebSocket: g['WebSocket'] };
		const calls: string[] = [];
		try {
			const out = await inObject(freshSite(), async (site) => {
				await site.ensurePhp();
				// installed after boot, so only what PHP does can reach them
				g['fetch'] = (url: unknown) => {
					calls.push(`fetch ${String(url)}`);
					return Promise.resolve(undefined);
				};
				g['WebSocket'] = class {
					constructor(url: unknown) {
						calls.push(`WebSocket ${String(url)}`);
						throw new Error('recorded');
					}
				};
				return await runAttempts(async (code) => {
					try {
						return { out: await site.run(code) };
					} catch (e) {
						return { out: '', error: e instanceof Error ? e.message : String(e) };
					}
				});
			});
			expect(calls, 'PHP reached fetch or a WebSocket').toEqual([]);
			expect(closedProblems(out)).toEqual([]);
		} finally {
			g['fetch'] = had.fetch;
			g['WebSocket'] = had.WebSocket;
		}
	}, 120_000);
});
