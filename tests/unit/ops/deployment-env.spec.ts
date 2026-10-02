import { describe, expect, it } from 'vitest';
import {
	CONFIG_NAME,
	deploymentEnv,
	deploymentEnvPhp,
	ENV_PREFIX,
	hasDeploymentEnv,
	phpQuote
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
		expect(deploymentEnv(undefined)).toEqual({ vars: {}, config: null, problems: [] });
		expect(deploymentEnv({ [CONFIG_NAME]: '' }).config).toBeNull();
		expect(deploymentEnv({ [CONFIG_NAME]: null }).problems).toEqual([]);
	});

	it('hasDeploymentEnv is true for a variable or a config and false otherwise', () => {
		expect(hasDeploymentEnv(undefined)).toBe(false);
		expect(hasDeploymentEnv({ OTHER: 'x' })).toBe(false);
		expect(hasDeploymentEnv({ [`${ENV_PREFIX}A`]: '1' })).toBe(true);
		expect(hasDeploymentEnv({ [CONFIG_NAME]: '{"a":1}' })).toBe(true);
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
});
