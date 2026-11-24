import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { proxyStub } from '../../src/ops/proxy-stub';

const ROOT = join(import.meta.dirname, '..', '..');
const AUTOLOAD = join(ROOT, 'drupal-src', 'autoload.php');
const PATH = 'modules/contrib/strawberryfield/src/ProxyClass/StrawberryfieldMimeService.php';

/** the shape of the file strawberryfield ships, generated against Drupal 10 */
const OLD_PROXY = `<?php
// @codingStandardsIgnoreFile

/**
 * This file was generated via php core/scripts/generate-proxy-class.php 'Drupal\\strawberryfield\\StrawberryfieldMimeService' "web/modules/contrib/strawberryfield/src".
 */

namespace Drupal\\strawberryfield\\ProxyClass {

  use Drupal\\Core\\File\\MimeType\\ExtensionMimeTypeGuesser;

  class StrawberryfieldMimeService extends ExtensionMimeTypeGuesser {
    public function setMapping(array $mapping = NULL)
    {
      return $this->lazyLoadItself()->setMapping($mapping);
    }
  }

}
`;

/** runs the real class, then a proxy, in one process, and answers what PHP printed */
function load(proxy: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'proxy-load-'));
	try {
		writeFileSync(join(dir, 'proxy.php'), proxy);
		writeFileSync(
			join(dir, 'run.php'),
			`<?php
require '${AUTOLOAD}';
namespace_define();
function namespace_define() {
	eval('namespace Drupal\\strawberryfield { class StrawberryfieldMimeService extends \\Drupal\\Core\\File\\MimeType\\ExtensionMimeTypeGuesser {} }');
}
require __DIR__ . '/proxy.php';
echo class_exists('Drupal\\strawberryfield\\ProxyClass\\StrawberryfieldMimeService') ? 'loaded' : 'missing';
`
		);
		const run = spawnSync('php', ['-d', 'display_errors=1', join(dir, 'run.php')], {
			encoding: 'utf8',
			timeout: 60_000
		});
		return run.stdout + run.stderr;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe('a generated proxy class in a delivered module', () => {
	it('becomes a stub that builds the proxy from the service class', () => {
		const stub = proxyStub(PATH, OLD_PROXY);
		expect(stub).toContain("build('Drupal\\strawberryfield\\\\StrawberryfieldMimeService')");
		expect(stub).not.toContain('setMapping');
		const dir = mkdtempSync(join(tmpdir(), 'proxy-stub-'));
		try {
			writeFileSync(join(dir, 'stub.php'), stub);
			const lint = spawnSync('php', ['-l', join(dir, 'stub.php')], { encoding: 'utf8' });
			expect(lint.status, lint.stdout + lint.stderr).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('leaves other files alone, a stub already written included', () => {
		expect(proxyStub('modules/x/src/Foo.php', OLD_PROXY)).toBe(OLD_PROXY);
		expect(proxyStub(PATH, '<?php class NotGenerated {}')).toBe('<?php class NotGenerated {}');
		const stub = proxyStub(PATH, OLD_PROXY);
		expect(proxyStub(PATH, stub)).toBe(stub);
	});

	it.skipIf(!existsSync(AUTOLOAD))(
		'loads against a core whose method gained a return type, which the checked-in file does not',
		() => {
			expect(load(OLD_PROXY)).toMatch(/must be compatible with/);
			expect(load(proxyStub(PATH, OLD_PROXY))).toBe('loaded');
		}
	);
});
