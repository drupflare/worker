import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `system.mail` must never name a plugin the site does not have.
 *
 * settings.php assigned `system.mail:interface.default = cfw_mail` on every site. The reasoning was
 * sound -- `php_mail` cannot run here, so the mailer is a platform substitution rather than a
 * preference, and a config import must not revert a site into a mailer that drops everything -- and
 * the assignment was still a 500 on every site.
 *
 * `cfw_mail` is a plugin of the `drupflare` MODULE, an assignment in `settings.php` cannot know
 * whether that module is installed, and `MailManager` throws `PluginNotFoundException` for an
 * interface it cannot resolve. So
 * `/user/password` answered 500 rather than failing to send. Measured on a provisioned site: "The
 * cfw_mail plugin does not exist. Valid plugin IDs for Drupal\\Core\\Mail\\MailManager are:
 * php_mail, symfony_mailer, test_mail_collector".
 *
 * A CONFIG OVERRIDE SERVICE CANNOT MAKE THAT MISTAKE. It is registered by the module, so it exists
 * exactly when the plugin does; it still beats a config import, which is what the settings override
 * was for; and it needs no install hook to have fired, which a site enabled through the host route
 * cannot rely on. Verified both ways on a dev worker: a migrated site with no drupflare reports
 * `php_mail`, the same build with drupflare installed reports `cfw_mail`, and a password reset then
 * reached a real SMTP server carrying its reset link.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');
const SIBLING = process.env.DRUPFLARE_SRC ?? '../drupflare';
const MODULE = resolve(ROOT, SIBLING);

describe('the settings override', () => {
	const source = readFileSync(resolve(ROOT, 'src', 'site-do.ts'), 'utf8');

	it('no longer forces the mail interface', () => {
		expect(source).not.toContain("$config['system.mail']['interface']['default']");
	});

	it('leaves the mailer for the module to claim through a config override', () => {
		// the assertion above pins the ABSENCE, which has a real failure mode: an assignment naming
		// a plugin of a module the site may not have answers 500 on /user/password. What used to sit
		// here pinned a COMMENT string, which is prose enforcement rather than repository policy
		const services = readFileSync(resolve(MODULE, 'drupflare.services.yml'), 'utf8');
		expect(services).toContain('MailInterfaceOverride');
	});
});

describe('the module claims it instead', () => {
	it('registers a config override service', () => {
		const services = readFileSync(resolve(MODULE, 'drupflare.services.yml'), 'utf8');
		expect(services).toContain('drupflare.mail_interface_override');
		expect(services).toContain('config.factory.override');
	});

	it('overrides exactly one key of exactly one config object', () => {
		const php = readFileSync(
			resolve(MODULE, 'src', 'Config', 'MailInterfaceOverride.php'),
			'utf8'
		);
		// a broad override is a way to change a site's configuration by accident
		expect(php).toContain("in_array('system.mail'");
		expect(php).toContain("'interface' => ['default' => self::PLUGIN]");
	});

	it('names the plugin it provides rather than a literal', () => {
		const php = readFileSync(
			resolve(MODULE, 'src', 'Config', 'MailInterfaceOverride.php'),
			'utf8'
		);
		expect(php).toContain("public const PLUGIN = 'cfw_mail'");
	});

	it('does not do it from an install hook, which a host-route enable cannot rely on', () => {
		const install = readFileSync(resolve(MODULE, 'drupflare.install'), 'utf8');
		expect(install).not.toContain('system.mail');
	});
});
