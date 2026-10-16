/**
 * The deployment's own environment, as PHP sees it: `DRUPAL_ENV_<NAME>` becomes `getenv('<NAME>')`,
 * `$_ENV` and `$_SERVER`; `DRUPAL_CONFIG` is a JSON object merged over `$config` and
 * `DRUPAL_SETTINGS` one merged over `$settings`.
 *
 * An unprefixed name is never read: the owner token, `PW_DIAGNOSTICS`, mail credentials and API
 * tokens share the same `env`, and customer PHP must not reach them.
 * @module
 */

/** the Worker `env` prefix whose remainder becomes a PHP environment variable */
export const ENV_PREFIX = 'DRUPAL_ENV_';
/** the Worker `env` name holding the JSON `$config` overrides */
export const CONFIG_NAME = 'DRUPAL_CONFIG';
/** the Worker `env` name holding the JSON `$settings` overrides */
export const SETTINGS_NAME = 'DRUPAL_SETTINGS';

/**
 * `$settings` keys the Worker sets itself, which a deployment may not move: the host check, the
 * config directory, the service files and the three paths the pack mounts.
 */
export const PROTECTED_SETTINGS = new Set([
	'trusted_host_patterns',
	'config_sync_directory',
	'container_yamls',
	'file_public_path',
	'file_private_path',
	'file_temp_path'
]);

const MAX_VARS = 100;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_SETTINGS_BYTES = 64 * 1024;
const NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** the parsed deployment environment: PHP variables, `$config` and `$settings` overrides and what was ignored */
export type DeploymentEnv = {
	vars: Record<string, string>;
	config: Record<string, unknown> | null;
	settings: Record<string, unknown> | null;
	/** what was ignored and why; names only, never a value */
	problems: string[];
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** a JSON object given as an object or a string; anything else is ignored and reported by name */
function jsonObject(
	raw: unknown,
	name: string,
	maxBytes: number,
	problems: string[]
): Record<string, unknown> | null {
	if (raw === undefined || raw === null || raw === '') return null;
	if (isPlainObject(raw)) return { ...raw };
	if (typeof raw !== 'string') {
		problems.push(`${name}: not a JSON string, ignored`);
		return null;
	}
	if (new TextEncoder().encode(raw).length > maxBytes) {
		problems.push(`${name}: longer than ${maxBytes} bytes, ignored`);
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (isPlainObject(parsed)) return parsed;
		problems.push(`${name}: not a JSON object, ignored`);
	} catch {
		problems.push(`${name}: not valid JSON, ignored`);
	}
	return null;
}

/** reads the prefixed names and the two JSON overrides off a Worker `env`; anything malformed is ignored and reported */
export function deploymentEnv(env: object | undefined): DeploymentEnv {
	const out: DeploymentEnv = { vars: {}, config: null, settings: null, problems: [] };
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
	out.config = jsonObject(bag[CONFIG_NAME], CONFIG_NAME, MAX_CONFIG_BYTES, out.problems);
	const settings = jsonObject(
		bag[SETTINGS_NAME],
		SETTINGS_NAME,
		MAX_SETTINGS_BYTES,
		out.problems
	);
	if (settings !== null) {
		for (const key of Object.keys(settings)) {
			if (!PROTECTED_SETTINGS.has(key)) continue;
			out.problems.push(`${SETTINGS_NAME}: ${key} is set by the Worker, ignored`);
			delete settings[key];
		}
		out.settings = Object.keys(settings).length > 0 ? settings : null;
	}
	return out;
}

/** whether the deployment carries anything for PHP; a heap image would freeze the old answer */
export const hasDeploymentEnv = (env: object | undefined): boolean => {
	const d = deploymentEnv(env);
	return Object.keys(d.vars).length > 0 || d.config !== null || d.settings !== null;
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
	if (d.settings !== null) {
		lines.push(
			`$cfw_set = json_decode(${phpQuote(JSON.stringify(d.settings))}, true);`,
			'if (is_array($cfw_set)) {',
			'  $settings = array_replace_recursive(isset($settings) && is_array($settings) ? $settings : [], $cfw_set);',
			'}'
		);
	}
	return lines.join('\n');
}
