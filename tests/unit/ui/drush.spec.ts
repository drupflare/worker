import { describe, expect, it } from 'vitest';
import { parseDrush } from '../../../src/ui/admin.js';

describe('the Drush-shaped command field', () => {
	it('routes a bare operation to the registry', () => {
		expect(parseDrush('cr')).toEqual({ kind: 'run', route: '/__ops', params: { op: 'cr' } });
	});

	it('routes an enable to the route that installs modules, not to the registry', () => {
		// `/__ops` takes a name and nothing else, so `en webform` reached it as an operation called
		// "en webform" and came back unknown
		expect(parseDrush('en webform')).toEqual({
			kind: 'run',
			route: '/__enable',
			params: { module: 'webform' }
		});
	});

	// the spellings are `CommandLine::DRUSH_ALIASES`, not a guess: `pm-install` is not one of them,
	// and asserting it was how this test first found the table it should have been reading
	it.each(['en', 'pm:enable', 'pm-enable', 'pm:install', 'theme:enable'])(
		'accepts %s as a spelling of enable',
		(alias) => {
			const out = parseDrush(`${alias} pathauto`);
			expect(out).toMatchObject({ kind: 'run', route: '/__enable' });
		}
	);

	it.each([
		['cache:rebuild', 'cr'],
		['cache-rebuild', 'cr'],
		['cc', 'cr'],
		['core:status', 'status'],
		['st', 'status'],
		['sql:dump', 'sql-dump']
	])('canonicalises %s to %s, which the registry looks up by exact name', (typed, canonical) => {
		expect(parseDrush(typed)).toEqual({
			kind: 'run',
			route: '/__ops',
			params: { op: canonical }
		});
	});

	it('carries --dry through as the dry-run flag', () => {
		expect(parseDrush('en webform --dry')).toEqual({
			kind: 'run',
			route: '/__enable',
			params: { module: 'webform', dry: '1' }
		});
	});

	it('refuses an enable with no module rather than running one', () => {
		const out = parseDrush('en');
		expect(out).toMatchObject({ kind: 'error' });
		expect((out as { message: string }).message).toContain('needs a module name');
	});

	it('refuses more than one module, because the route takes one', () => {
		const out = parseDrush('en webform pathauto');
		expect(out).toMatchObject({ kind: 'error' });
		expect((out as { message: string }).message).toContain('one module at a time');
	});

	it('refuses arguments to an operation that takes none, rather than dropping them', () => {
		const out = parseDrush('status --verbose extra');
		expect(out).toMatchObject({ kind: 'error' });
		expect((out as { message: string }).message).toContain('extra');
	});

	it('reads nothing as nothing', () => {
		expect(parseDrush(null)).toBeNull();
		expect(parseDrush('')).toBeNull();
		expect(parseDrush('   ')).toBeNull();
	});

	it('tolerates the spacing a person actually types', () => {
		expect(parseDrush('  en   webform  ')).toEqual({
			kind: 'run',
			route: '/__enable',
			params: { module: 'webform' }
		});
	});
});
