import { describe, expect, it } from 'vitest';
import { SERVICES_YAML, settingsOverride } from '../../../src/do/settings';

const values = {
	origin: JSON.stringify('https://x.dev'),
	argon2: true,
	memoryBins: "['dynamic_page_cache']",
	memoryItems: 500,
	lane: 3,
	lanes: 8,
	packageAutoload: "$class_loader->addPsr4('Pkg\\\\', $app_root . '/libraries/pkg/src/');",
	deploymentEnv: "$settings['DRUPAL_ENV_X'] = 'a';"
};

describe('settingsOverride', () => {
	const out = settingsOverride(values);

	it('fills every value into the PHP the site appends to settings.php', () => {
		expect(out).toContain("'lane' => 3,");
		expect(out).toContain("'lanes' => 8,");
		expect(out).toContain('parse_url("https://x.dev", PHP_URL_HOST)');
		expect(out).toContain("$settings['drupflare.argon2'] = true;");
		expect(out).toContain(
			"$settings['drupflare']['memory_cache_bins'] = ['dynamic_page_cache'];"
		);
		expect(out).toContain("$settings['drupflare']['memory_cache_max_items'] = 500;");
		expect(out).toContain(values.packageAutoload);
		expect(out).toContain(values.deploymentEnv);
		expect(out).not.toContain('__CFW_');
	});

	it('starts on a fresh line, so it cannot join the last line of the file it is appended to', () => {
		expect(out.startsWith('\n\n// --- appended')).toBe(true);
	});

	it('keeps each namespace separator doubled, which a single-quoted PHP string reads as one', () => {
		expect(out).toContain(
			"'namespace' => 'Drupal\\\\cfw_do_sqlite\\\\Driver\\\\Database\\\\cfw_do_sqlite'"
		);
	});

	it('treats replacement patterns in a value as text', () => {
		const tricky = settingsOverride({ ...values, origin: '"https://x/$&$1"' });
		expect(tricky).toContain('parse_url("https://x/$&$1", PHP_URL_HOST)');
	});

	it('writes false for argon2 when it is off', () => {
		expect(settingsOverride({ ...values, argon2: false })).toContain(
			"$settings['drupflare.argon2'] = false;"
		);
	});
});

describe('SERVICES_YAML', () => {
	it('names the null page cache and both stream wrappers with single backslashes', () => {
		expect(SERVICES_YAML).toContain('class: Drupal\\Core\\Cache\\NullBackendFactory');
		expect(SERVICES_YAML).toContain(
			'class: Drupal\\drupflare\\StreamWrapper\\CfwFileStreamWrapper'
		);
		expect(SERVICES_YAML.startsWith('services:\n')).toBe(true);
	});
});
