import { describe, expect, it } from 'vitest';
import { renderPage } from '../../src/drupal/site-php';
import {
	deploymentEnv,
	deploymentEnvPhp,
	hasDeploymentEnv,
	phpQuote
} from '../../src/ops/deployment-env';
import { heapSnapshotEnabled } from '../../src/site-do';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

/**
 * The names a migrated project reads from its old host: `DRUPAL_ENV_<NAME>` as environment
 * variables and `DRUPAL_CONFIG` as a `$config` overlay. Nothing without the prefix reaches PHP.
 */

const OWNER = 'owner-token-that-php-must-never-see';

describe('reading the deployment env', () => {
	it('takes only prefixed names and strips the prefix', () => {
		const d = deploymentEnv({
			DRUPAL_ENV_SMTP_HOST: 'mail.example.org',
			DRUPAL_ENV_N: 7,
			SMTP_HOST: 'unprefixed',
			PW_DIAGNOSTICS: '1'
		});
		expect(d.vars).toEqual({ SMTP_HOST: 'mail.example.org', N: '7' });
		expect(d.problems).toEqual([]);
	});

	it('parses DRUPAL_CONFIG from a JSON string, and from an object', () => {
		expect(deploymentEnv({ DRUPAL_CONFIG: '{"system.site":{"name":"A"}}' }).config).toEqual({
			'system.site': { name: 'A' }
		});
		expect(deploymentEnv({ DRUPAL_CONFIG: { a: 1 } }).config).toEqual({ a: 1 });
	});

	it('ignores and reports what is malformed, naming the variable and never the value', () => {
		const d = deploymentEnv({
			DRUPAL_ENV_1BAD: 'x',
			'DRUPAL_ENV_A-B': 'x',
			DRUPAL_ENV_NUL: 'a\0b',
			DRUPAL_ENV_OBJ: { a: 1 },
			DRUPAL_CONFIG: '{not json secret-value'
		});
		expect(d.vars).toEqual({});
		expect(d.config).toBeNull();
		expect(d.problems).toHaveLength(5);
		expect(d.problems.join('\n')).not.toContain('secret-value');
		expect(deploymentEnv({ DRUPAL_CONFIG: '[1,2]' }).problems).toEqual([
			'DRUPAL_CONFIG: not a JSON object, ignored'
		]);
	});

	it('quotes every value for PHP, whatever it contains', () => {
		expect(phpQuote("a'b\\c$d")).toBe("'a\\'b\\\\c$d'");
		const php = deploymentEnvPhp(
			deploymentEnv({ DRUPAL_ENV_K: "it's \\ $x", DRUPAL_CONFIG: '{"a":"it\'s"}' })
		);
		expect(php).toContain("'K' => 'it\\'s \\\\ $x'");
		expect(php).toContain('array_replace_recursive');
		expect(deploymentEnvPhp(deploymentEnv({}))).toBe('');
	});

	it('refuses a heap image while the deployment carries any of it', () => {
		expect(heapSnapshotEnabled({} as never)).toBe(true);
		expect(heapSnapshotEnabled({ DRUPAL_ENV_A: 'x' } as never)).toBe(false);
		expect(heapSnapshotEnabled({ DRUPAL_CONFIG: '{"a":1}' } as never)).toBe(false);
		expect(hasDeploymentEnv({ DRUPAL_CONFIG: '{bad' })).toBe(false);
	});
});

describe('what PHP sees after a boot', () => {
	async function probe(vars: Record<string, string>): Promise<Record<string, unknown>> {
		return inObject(freshSite(), async (site: ServeDo) => {
			Object.assign(site.env, vars);
			await site.fetch(new Request('https://do.local/__migrate?all=1&prefill=0'));
			await site.runJson(renderPage('/', []));
			return (await site.runJson(`<?php
echo json_encode([
  'getenv' => getenv('GREETING'),
  'env' => $_ENV['GREETING'] ?? null,
  'server' => $_SERVER['GREETING'] ?? null,
  'name' => \\Drupal::config('system.site')->get('name'),
  'mail' => \\Drupal::config('system.site')->get('mail'),
  'leaks' => array_values(array_filter(['OWNER_TOKEN', 'PW_DIAGNOSTICS', 'CF_EMAIL_TOKEN', 'SMTP_PASS'],
    fn ($n) => getenv($n) !== false || isset($_ENV[$n]) || isset($_SERVER[$n]))),
  'settings' => str_contains(file_get_contents('/drupal/sites/default/settings.php'), ${JSON.stringify(OWNER)}),
]);`)) as Record<string, unknown>;
		});
	}

	// the interpreter is shared by every site in the isolate, so the arm that sets nothing runs first
	it('leaves everything alone when neither is set', async () => {
		const seen = await probe({ OWNER_TOKEN: OWNER });
		expect(seen['getenv']).toBe(false);
		expect(seen['name']).not.toBe('From Env');
		expect(seen['leaks']).toEqual([]);
	}, 900_000);

	it('exposes DRUPAL_ENV_* and overlays DRUPAL_CONFIG, and nothing unprefixed', async () => {
		const seen = await probe({
			DRUPAL_ENV_GREETING: "it's a $HOME \\ test",
			DRUPAL_CONFIG: JSON.stringify({ 'system.site': { name: 'From Env' } }),
			OWNER_TOKEN: OWNER,
			CF_EMAIL_TOKEN: 'cf-token',
			SMTP_PASS: 'smtp-pass'
		});
		expect(seen['getenv']).toBe("it's a $HOME \\ test");
		expect(seen['env']).toBe("it's a $HOME \\ test");
		expect(seen['server']).toBe("it's a $HOME \\ test");
		expect(seen['name']).toBe('From Env');
		expect(seen['leaks']).toEqual([]);
		expect(seen['settings']).toBe(false);
	}, 900_000);

	it('ignores a malformed DRUPAL_CONFIG and still boots', async () => {
		const seen = await probe({ DRUPAL_CONFIG: '{oops', DRUPAL_ENV_GREETING: 'hi' });
		expect(seen['getenv']).toBe('hi');
	}, 900_000);
});
