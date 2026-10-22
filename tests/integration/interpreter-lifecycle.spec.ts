import { describe, expect, it } from 'vitest';
import { freshSite, inObject } from '../helpers/serve-do';

/**
 * What the PHP2Shell analysis in `docs/security.md` rests on, read off the shipping interpreter.
 *
 * Both advisories need a per-request startup and shutdown cycle and an allocator that bails out
 * on `memory_limit`. If a rebuild changes either, these fail and the analysis has to be redone.
 */

const FACTS = `<?php echo json_encode([
	'sapi' => php_sapi_name(),
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
