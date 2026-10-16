import { describe, expect, it } from 'vitest';
import {
	CONFIG_NAME,
	deploymentEnv,
	deploymentEnvPhp,
	ENV_PREFIX,
	hasDeploymentEnv,
	phpQuote,
	PROTECTED_SETTINGS,
	SETTINGS_NAME
} from '../../../src/ops/deployment-env';

describe('reading the deployment environment', () => {
	it('takes only prefixed names and never an unprefixed secret', () => {
		const parsed = deploymentEnv({
			[`${ENV_PREFIX}REDIS_HOST`]: 'r.example',
			[`${ENV_PREFIX}PORT`]: 6379,
			[`${ENV_PREFIX}FLAG`]: true,
			OWNER_TOKEN: 'secret'
		});
		expect(parsed.vars).toEqual({ REDIS_HOST: 'r.example', PORT: '6379', FLAG: 'true' });
		expect(parsed.problems).toEqual([]);
	});

	it('reports and skips a bad name, a non-scalar and a NUL byte, naming the key only', () => {
		const parsed = deploymentEnv({
			[`${ENV_PREFIX}1BAD`]: 'x',
			[`${ENV_PREFIX}OBJ`]: { a: 1 },
			[`${ENV_PREFIX}NUL`]: 'a\0b'
		});
		expect(parsed.vars).toEqual({});
		expect(parsed.problems).toHaveLength(3);
		expect(parsed.problems.join(' ')).not.toContain('secret');
	});

	it('refuses an oversized value and anything past the variable cap', () => {
		const big = deploymentEnv({ [`${ENV_PREFIX}BIG`]: 'x'.repeat(64 * 1024 + 1) });
		expect(big.vars).toEqual({});
		expect(big.problems[0]).toContain('longer than');

		const many: Record<string, string> = {};
		for (let i = 0; i < 101; i++) many[`${ENV_PREFIX}V${String(i).padStart(3, '0')}`] = 'v';
		const capped = deploymentEnv(many);
		expect(Object.keys(capped.vars)).toHaveLength(100);
		expect(capped.problems).toEqual([expect.stringContaining('more than 100 variables')]);
	});

	it('accepts the config as an object or as a JSON string and refuses the rest', () => {
		expect(deploymentEnv({ [CONFIG_NAME]: { a: { b: 1 } } }).config).toEqual({ a: { b: 1 } });
		expect(deploymentEnv({ [CONFIG_NAME]: '{"a":1}' }).config).toEqual({ a: 1 });
		for (const bad of ['[1]', 'nope', 42, 'x'.repeat(512 * 1024 + 1)]) {
			const parsed = deploymentEnv({ [CONFIG_NAME]: bad });
			expect(parsed.config).toBeNull();
			expect(parsed.problems).toHaveLength(1);
		}
	});

	it('treats an absent env, null and an empty string as nothing', () => {
		expect(deploymentEnv(undefined)).toEqual({
			vars: {},
			config: null,
			settings: null,
			problems: []
		});
		expect(deploymentEnv({ [CONFIG_NAME]: '' }).config).toBeNull();
		expect(deploymentEnv({ [CONFIG_NAME]: null }).problems).toEqual([]);
	});

	it('reads $settings overrides the way it reads $config, and keeps the keys it sets itself', () => {
		expect(
			deploymentEnv({ [SETTINGS_NAME]: '{"mantle2.cloud_endpoint":"https://cloud.example"}' })
				.settings
		).toEqual({ 'mantle2.cloud_endpoint': 'https://cloud.example' });
		const parsed = deploymentEnv({
			[SETTINGS_NAME]: { a: 1, trusted_host_patterns: ['.*'], container_yamls: [] }
		});
		expect(parsed.settings).toEqual({ a: 1 });
		expect(parsed.problems).toEqual([
			`${SETTINGS_NAME}: trusted_host_patterns is set by the Worker, ignored`,
			`${SETTINGS_NAME}: container_yamls is set by the Worker, ignored`
		]);
		expect([...PROTECTED_SETTINGS]).toContain('config_sync_directory');
		for (const bad of ['[1]', 'nope', 42, 'x'.repeat(64 * 1024 + 1)]) {
			const refused = deploymentEnv({ [SETTINGS_NAME]: bad });
			expect(refused.settings).toBeNull();
			expect(refused.problems).toHaveLength(1);
		}
		expect(
			deploymentEnv({ [SETTINGS_NAME]: { trusted_host_patterns: [] } }).settings
		).toBeNull();
	});

	it('hasDeploymentEnv is true for a variable, a config or settings and false otherwise', () => {
		expect(hasDeploymentEnv(undefined)).toBe(false);
		expect(hasDeploymentEnv({ OTHER: 'x' })).toBe(false);
		expect(hasDeploymentEnv({ [`${ENV_PREFIX}A`]: '1' })).toBe(true);
		expect(hasDeploymentEnv({ [CONFIG_NAME]: '{"a":1}' })).toBe(true);
		expect(hasDeploymentEnv({ [SETTINGS_NAME]: '{"a":1}' })).toBe(true);
	});
});

describe('the settings fragment', () => {
	it('quotes backslashes and single quotes for a PHP string', () => {
		expect(phpQuote(String.raw`a\b'c`)).toBe(String.raw`'a\\b\'c'`);
	});

	it('is empty when there is nothing to hand over', () => {
		expect(deploymentEnvPhp(deploymentEnv(undefined))).toBe('');
	});

	it('exports each variable and merges the config over $config', () => {
		const php = deploymentEnvPhp(
			deploymentEnv({ [`${ENV_PREFIX}A`]: "it's", [CONFIG_NAME]: '{"x":{"y":1}}' })
		);
		expect(php).toContain(`['A' => 'it\\'s'] as $cfw_k => $cfw_v`);
		expect(php).toContain('putenv($cfw_k . "=" . $cfw_v);');
		expect(php).toContain(`json_decode('{"x":{"y":1}}', true)`);
		expect(php).toContain('array_replace_recursive');
	});

	it('merges $settings over $settings, and leaves it alone with none', () => {
		const php = deploymentEnvPhp(
			deploymentEnv({
				[SETTINGS_NAME]: '{"mantle2.cloud_endpoint":"https://c.example/it\'s"}'
			})
		);
		expect(php).toContain(
			`json_decode('{"mantle2.cloud_endpoint":"https://c.example/it\\'s"}', true)`
		);
		expect(php).toContain('$settings = array_replace_recursive(');
		expect(php).not.toContain('$config =');
		expect(deploymentEnvPhp(deploymentEnv({ [CONFIG_NAME]: '{"a":1}' }))).not.toContain(
			'$settings'
		);
	});
});
