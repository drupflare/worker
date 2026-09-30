/**
 * The deployment's own environment, as PHP sees it.
 *
 * A migrated Drupal project reads `getenv()` and `$config` overrides that its old host supplied.
 * Two prefixed names carry them across without exposing anything else on the Worker's `env`:
 *
 * - `DRUPAL_ENV_<NAME>` becomes `getenv('<NAME>')`, `$_ENV['<NAME>']` and `$_SERVER['<NAME>']`.
 * - `DRUPAL_CONFIG` is a JSON object merged over `$config` with `array_replace_recursive`.
 *
 * An unprefixed name is never read. The owner token, `PW_DIAGNOSTICS`, mail credentials and API
 * tokens sit on the same `env`, and PHP code (a module, a settings file a customer edits) must not
 * be able to read them.
 */

export const ENV_PREFIX = 'DRUPAL_ENV_';
export const CONFIG_NAME = 'DRUPAL_CONFIG';

const MAX_VARS = 100;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_CONFIG_BYTES = 512 * 1024;
const NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type DeploymentEnv = {
	vars: Record<string, string>;
	config: Record<string, unknown> | null;
	/** what was ignored and why; names only, never a value */
	problems: string[];
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** reads the two prefixed names off a Worker `env`; anything malformed is ignored and reported */
export function deploymentEnv(env: object | null | undefined): DeploymentEnv {
	const out: DeploymentEnv = { vars: {}, config: null, problems: [] };
	if (!env) return out;
	const bag = env as Record<string, unknown>;
	for (const key of Object.keys(bag).sort()) {
		if (!key.startsWith(ENV_PREFIX)) continue;
		const name = key.slice(ENV_PREFIX.length);
		const value = bag[key];
		if (!NAME_SHAPE.test(name)) {
			out.problems.push(`${key}: the name after the prefix is not a valid variable name`);
		} else if (Object.keys(out.vars).length >= MAX_VARS) {
			out.problems.push(`${key}: more than ${MAX_VARS} variables, ignored`);
		} else if (
			typeof value !== 'string' &&
			typeof value !== 'number' &&
			typeof value !== 'boolean'
		) {
			out.problems.push(`${key}: not a string, ignored`);
		} else if (String(value).includes('\0')) {
			out.problems.push(`${key}: contains a NUL byte, ignored`);
		} else if (new TextEncoder().encode(String(value)).length > MAX_VALUE_BYTES) {
			out.problems.push(`${key}: longer than ${MAX_VALUE_BYTES} bytes, ignored`);
		} else out.vars[name] = String(value);
	}
	const raw = bag[CONFIG_NAME];
	if (raw !== undefined && raw !== null && raw !== '') {
		if (isPlainObject(raw)) out.config = raw;
		else if (typeof raw !== 'string')
			out.problems.push(`${CONFIG_NAME}: not a JSON string, ignored`);
		else if (new TextEncoder().encode(raw).length > MAX_CONFIG_BYTES)
			out.problems.push(`${CONFIG_NAME}: longer than ${MAX_CONFIG_BYTES} bytes, ignored`);
		else {
			try {
				const parsed: unknown = JSON.parse(raw);
				if (isPlainObject(parsed)) out.config = parsed;
				else out.problems.push(`${CONFIG_NAME}: not a JSON object, ignored`);
			} catch {
				out.problems.push(`${CONFIG_NAME}: not valid JSON, ignored`);
			}
		}
	}
	return out;
}

/** whether the deployment carries anything for PHP; a heap image would freeze the old answer */
export const hasDeploymentEnv = (env: object | null | undefined): boolean => {
	const d = deploymentEnv(env);
	return Object.keys(d.vars).length > 0 || d.config !== null;
};

/** a PHP single-quoted string literal; only `\` and `'` are special inside one */
export const phpQuote = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** the settings.php fragment that hands the deployment's names to PHP; empty when there are none */
export function deploymentEnvPhp(d: DeploymentEnv): string {
	const lines: string[] = [];
	const names = Object.keys(d.vars);
	if (names.length > 0) {
		lines.push(
			`foreach ([${names.map((n) => `${phpQuote(n)} => ${phpQuote(d.vars[n]!)}`).join(', ')}] as $cfw_k => $cfw_v) {`,
			'  putenv($cfw_k . "=" . $cfw_v);',
			'  $_ENV[$cfw_k] = $cfw_v;',
			'  $_SERVER[$cfw_k] = $cfw_v;',
			'}'
		);
	}
	if (d.config !== null) {
		lines.push(
			`$cfw_cfg = json_decode(${phpQuote(JSON.stringify(d.config))}, true);`,
			'if (is_array($cfw_cfg)) {',
			'  $config = array_replace_recursive(isset($config) && is_array($config) ? $config : [], $cfw_cfg);',
			'}'
		);
	}
	return lines.join('\n');
}
