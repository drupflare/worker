import { gzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
	asksForBranch,
	autoloadPhp,
	branchArchive,
	classmapOf,
	commonPrefix,
	composerVersion,
	declaredClasses,
	devMetadataUrl,
	distOf,
	DROP,
	expandMinified,
	fallbackMetadataUrl,
	isMetapackage,
	KEEP,
	metadataUrl,
	mountFor,
	packageRequirements,
	parseAutoloadDeclaration,
	pickVersion,
	portFibers,
	RECORD_CAP,
	unpackTar,
	unpackZip
} from '../../../src/ops/package-install';
import { freshSite, inObject } from '../../helpers/serve-do';

/**
 * The installer P18's `composer require` and P40's git delivery share.
 *
 * The fixtures here are the SHAPES both repositories actually return, taken from live responses on
 * 2026-08-23 rather than invented: `packages.drupal.org` answers a `dist.url` pointing at
 * `ftp.drupal.org`, packagist answers one pointing at `api.github.com/.../zipball/<sha>`.
 */

const bytes = (s: string) => new TextEncoder().encode(s);

/** a minimal ustar archive, so the tar case does not need a fixture file on disk */
function tarOf(entries: readonly (readonly [string, Uint8Array])[]): Uint8Array {
	const blocks: Uint8Array[] = [];
	for (const [name, body] of entries) {
		const header = new Uint8Array(512);
		const put = (offset: number, text: string) => {
			for (let i = 0; i < text.length; i++) header[offset + i] = text.charCodeAt(i);
		};
		put(0, name);
		put(100, '0000644\0');
		put(124, body.length.toString(8).padStart(11, '0') + '\0');
		put(156, '0');
		put(257, 'ustar\0' + '00');
		// the checksum is computed with the field itself read as spaces, which is the one part of
		// the format a hand-written fixture always gets wrong
		for (let i = 148; i < 156; i++) header[i] = 32;
		let sum = 0;
		for (const b of header) sum += b;
		put(148, sum.toString(8).padStart(6, '0') + '\0 ');
		blocks.push(header);
		const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
		padded.set(body);
		blocks.push(padded);
	}
	blocks.push(new Uint8Array(1024));
	const total = blocks.reduce((n, b) => n + b.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const b of blocks) {
		out.set(b, at);
		at += b.length;
	}
	return out;
}

describe('resolving a name to a repository', () => {
	it('sends drupal/* to packages.drupal.org and everything else to packagist', () => {
		// NOT interchangeable: `repo.packagist.org/p2/drupal/token.json` answers
		// "404 not found, no packages here", which reads as a typo rather than as a wrong registry
		expect(metadataUrl('composer', 'drupal/token')).toBe(
			'https://packages.drupal.org/files/packages/8/p2/drupal/token.json'
		);
		expect(metadataUrl('composer', 'psr/log')).toBe(
			'https://repo.packagist.org/p2/psr/log.json'
		);
		expect(metadataUrl('npm', 'lodash')).toBe('https://registry.npmjs.org/lodash');
		expect(metadataUrl('npm', '@scope/pkg')).toBe('https://registry.npmjs.org/@scope/pkg');
	});

	it('reads branches from the ~dev file, and only for a constraint that names one', () => {
		expect(devMetadataUrl('https://repo.packagist.org/p2/a/b.json')).toBe(
			'https://repo.packagist.org/p2/a/b~dev.json'
		);
		expect(asksForBranch('dev-main')).toBe(true);
		expect(asksForBranch('2.x-dev')).toBe(true);
		expect(asksForBranch('^1.0@dev')).toBe(true);
		expect(asksForBranch('^1.0')).toBe(false);
		expect(asksForBranch(null)).toBe(false);
	});

	it('points a delivered file at the Fiber shim, qualified and aliased, and leaves the rest', () => {
		const source = [
			'<?php',
			'namespace Revolt\\EventLoop;',
			'use Fiber;',
			'final class A {',
			'  private ?\\Fiber $f = null;',
			'  function go() { $this->f = new \\Fiber(fn() => \\Fiber::suspend(1)); throw new \\FiberError(); }',
			'  function plain() { return new Fiber(fn() => 1); }',
			'}'
		].join('\n');
		const out = portFibers('vendor/revolt/event-loop/src/A.php', source);
		expect(out).toContain('use PhpWasmSyncFiber as Fiber;');
		expect(out).toContain('private ?\\PhpWasmSyncFiber $f');
		expect(out).toContain('new \\PhpWasmSyncFiber(fn() => \\PhpWasmSyncFiber::suspend(1))');
		// FiberError exists natively and is not a Fiber
		expect(out).toContain('new \\FiberError()');
		// unqualified, it follows the alias
		expect(out).toContain('return new Fiber(fn() => 1)');
		expect(portFibers('README.md', 'new \\Fiber(')).toBe('new \\Fiber(');
		expect(portFibers('a.php', '<?php echo 1;')).toBe('<?php echo 1;');
	});

	it("rewrites Canvas's fiber loop to answer its suspensions inline", () => {
		// the loop as canvas ships it, in CanvasPageVariant::renderComponentTree()
		const canvas = [
			'<?php',
			'    $fiber = new \\Fiber(fn() => $component_tree->toRenderable($entity, $is_preview));',
			'    $component_instance = $fiber->start();',
			'    while ($fiber->isSuspended()) {',
			'      $component_instance = match (TRUE) {',
			'        $component_instance instanceof Marker => $fiber->resume($main_content),',
			'        default => $fiber->resume(),',
			'      };',
			'    }',
			'    \\assert($fiber->isTerminated());',
			'    return $fiber->getReturn();'
		].join('\n');
		const out = portFibers(
			'modules/contrib/canvas/src/Plugin/DisplayVariant/CanvasPageVariant.php',
			canvas
		);
		expect(out).not.toContain('isSuspended');
		expect(out).toContain('\\PhpWasmSyncFiber::$handler = function ($instance)');
		expect(out).toContain('return $instance instanceof Marker ? $main_content : NULL;');
		// only canvas's variant is rewritten
		expect(portFibers('modules/contrib/other/src/A.php', canvas)).toContain('isSuspended');
	});

	it('falls back to packagist for a drupal/* library drupal.org does not carry', () => {
		expect(fallbackMetadataUrl('composer', 'drupal/rat')).toBe(
			'https://repo.packagist.org/p2/drupal/rat.json'
		);
		expect(fallbackMetadataUrl('composer', 'psr/log')).toBeNull();
		expect(fallbackMetadataUrl('npm', 'drupal/rat')).toBeNull();
	});

	it("mounts by composer's own type rather than by guessing from the name", () => {
		expect(mountFor('drupal/token', 'drupal-module')).toBe('modules/contrib/token');
		expect(mountFor('drupal/olivero_sub', 'drupal-theme')).toBe('themes/contrib/olivero_sub');
		expect(mountFor('drupal/chosen_lib', 'drupal-library')).toBe('libraries/chosen_lib');
		expect(mountFor('ycloudyusa/yusaopeny', 'drupal-profile')).toBe(
			'profiles/contrib/yusaopeny'
		);
		// a plain PHP package goes where the autoloader already has a root
		expect(mountFor('psr/log', 'library')).toBe('vendor/psr/log');
		expect(mountFor('psr/log')).toBe('vendor/psr/log');
	});
});

describe('picking a version', () => {
	const doc = {
		packages: {
			'drupal/token': [
				{ version: '2.0.0-beta1', dist: { url: 'b', type: 'zip' } },
				{ version: '1.17.0', dist: { url: 'https://ftp.drupal.org/x.zip', type: 'zip' } },
				{ version: '1.16.0', dist: { url: 'c', type: 'zip' } }
			]
		}
	};

	it('takes the newest STABLE when no constraint is given', () => {
		// the beta is listed first and must not win: an operator typing `composer require drupal/token`
		// on a real site gets 1.17.0, and getting a beta here would be a difference nobody asked for
		expect(pickVersion(doc, 'drupal/token')?.version).toBe('1.17.0');
	});

	it('matches an exact version, including a pre-release asked for by name', () => {
		expect(pickVersion(doc, 'drupal/token', '1.16.0')?.version).toBe('1.16.0');
		expect(pickVersion(doc, 'drupal/token', '2.0.0-beta1')?.version).toBe('2.0.0-beta1');
	});

	it('takes the newest stable version a range admits, as composer does', () => {
		expect(pickVersion(doc, 'drupal/token', '^1.16')?.version).toBe('1.17.0');
		expect(pickVersion(doc, 'drupal/token', '~1.16.0')?.version).toBe('1.16.0');
		// the comma AND an info file writes, which the prefix match read as a version and refused
		expect(pickVersion(doc, 'drupal/token', '>=1.16.0,<1.17')?.version).toBe('1.16.0');
		expect(pickVersion(doc, 'drupal/token', '^1.0 || ^2.0')?.version).toBe('1.17.0');
	});

	it('skips a release that requires a core the site does not run', () => {
		const ctx = {
			packages: {
				'drupal/context': [
					{ version: '5.0.0-rc2', require: { 'drupal/core': '^10.3 || ^11' } },
					{ version: '4.1.0', require: { 'drupal/core': '^8.8 || ^9' } }
				],
				'drupal/old': [{ version: '1.0.0', require: { 'drupal/core': '^9' } }],
				'drupal/tool': [{ version: '2.0.0' }]
			}
		};
		expect(pickVersion(ctx, 'drupal/context', null, '11.4.7')?.version).toBe('5.0.0-rc2');
		expect(pickVersion(ctx, 'drupal/context', null, '9.5.0')?.version).toBe('4.1.0');
		expect(pickVersion(ctx, 'drupal/context')?.version).toBe('5.0.0-rc2');
		expect(pickVersion(ctx, 'drupal/old', null, '11.4.7')?.version).toBe('1.0.0');
		expect(pickVersion(ctx, 'drupal/tool', null, '11.4.7')?.version).toBe('2.0.0');
	});

	it('reads a stability flag the way composer does, for that package only', () => {
		const alpha = {
			packages: {
				'drupal/openid_connect': [
					{ version: '3.0.0-alpha7', dist: { url: 'a', type: 'zip' } },
					{ version: '2.2.0', dist: { url: 'b', type: 'zip' } }
				]
			}
		};
		expect(pickVersion(alpha, 'drupal/openid_connect', '^3.0@alpha')?.version).toBe(
			'3.0.0-alpha7'
		);
		expect(pickVersion(alpha, 'drupal/openid_connect', '^3.0')).toBeNull();
		expect(pickVersion(alpha, 'drupal/openid_connect')?.version).toBe('2.2.0');
	});

	it('reads a flag per OR branch, and installs an inline alias as its left side', () => {
		const clone = {
			packages: {
				'drupal/entity_clone': [
					{ version: '2.2.0-beta1', dist: { url: 'a', type: 'zip' } },
					{ version: '1.0.0', dist: { url: 'b', type: 'zip' } }
				]
			}
		};
		// y_lb asks for it this way; the flag sat mid-string and the whole constraint read as unknown
		expect(pickVersion(clone, 'drupal/entity_clone', '^2.0@alpha || ^2')?.version).toBe(
			'2.2.0-beta1'
		);
		expect(pickVersion(clone, 'drupal/entity_clone', '^2 || ^1')?.version).toBe('1.0.0');
		const ief = {
			packages: {
				'drupal/inline_entity_form': [
					{ version: '3.0.0', dist: { url: 'a', type: 'zip' } },
					{ version: '3.0.0-rc21', dist: { url: 'b', type: 'zip' } }
				]
			}
		};
		expect(
			pickVersion(ief, 'drupal/inline_entity_form', '3.0.0-rc21 as 2.0.0-rc10')?.version
		).toBe('3.0.0-rc21');
	});

	it('takes a pre-release only when the project allows one and no stable release fits', () => {
		const clone = {
			packages: {
				'drupal/entity_clone': [
					{ version: '2.2.0-beta1', dist: { url: 'a', type: 'zip' } },
					{ version: '1.0.0', dist: { url: 'b', type: 'zip' } }
				]
			}
		};
		const range = '>=2.0.0-beta5 || ^2';
		expect(pickVersion(clone, 'drupal/entity_clone', range)).toBeNull();
		expect(pickVersion(clone, 'drupal/entity_clone', range, undefined, 'dev')?.version).toBe(
			'2.2.0-beta1'
		);
		// a branch counts as the top of the version its alias names, which is how composer met ^2.4
		const crop = {
			packages: {
				'drupal/image_widget_crop': [
					{
						version: 'dev-3.0.x',
						extra: { 'branch-alias': { 'dev-3.0.x': '3.0.x-dev' } },
						dist: { url: 'a', type: 'zip' }
					},
					{
						version: 'dev-2.x',
						extra: { 'branch-alias': { 'dev-2.x': '2.x-dev' } },
						dist: { url: 'b', type: 'zip' }
					}
				]
			}
		};
		expect(pickVersion(crop, 'drupal/image_widget_crop', '^2.4')).toBeNull();
		expect(
			pickVersion(crop, 'drupal/image_widget_crop', '^2.4', undefined, 'dev')?.version
		).toBe('dev-2.x');
		// prefer-stable: a stable release in range still wins at a dev floor
		expect(
			pickVersion(clone, 'drupal/entity_clone', '^1 || ^2', undefined, 'dev')?.version
		).toBe('1.0.0');
	});

	it('REFUSES a constraint it cannot match rather than installing something else', () => {
		// a caret range needs a real semver solver; answering one wrongly installs a version the
		// site cannot run, which is worse than reporting that the constraint was not understood
		expect(pickVersion(doc, 'drupal/token', '9.9')).toBeNull();
	});

	it('answers null for a package the document does not carry', () => {
		expect(pickVersion(doc, 'drupal/absent')).toBeNull();
		expect(pickVersion(null, 'drupal/token')).toBeNull();
		expect(
			pickVersion({ packages: { 'drupal/token': 'not a list' } }, 'drupal/token')
		).toBeNull();
	});
});

describe('reading the archive location', () => {
	it('reads the composer shape packages.drupal.org returns', () => {
		const out = distOf(
			{
				version: '1.17.0',
				type: 'drupal-module',
				dist: {
					type: 'zip',
					url: 'https://ftp.drupal.org/files/projects/token-8.x-1.17.zip',
					shasum: '21d11adf0be16f1aa95b6348b4ceadbe9a625824'
				}
			},
			'drupal/token'
		);
		expect(out?.url).toContain('ftp.drupal.org');
		expect(out?.type).toBe('zip');
		expect(out?.mount).toBe('modules/contrib/token');
		expect(out?.shasum).toHaveLength(40);
	});

	it("reads packagist's github zipball shape, whose shasum is empty", () => {
		const out = distOf(
			{
				version: '3.0.2',
				dist: {
					url: 'https://api.github.com/repos/php-fig/log/zipball/f16e',
					type: 'zip',
					shasum: ''
				}
			},
			'psr/log'
		);
		expect(out?.url).toContain('api.github.com');
		// an empty shasum is absent rather than a digest of nothing
		expect(out?.shasum).toBeUndefined();
	});

	it('reads the npm shape, which is a tarball', () => {
		const out = distOf(
			{
				version: '4.17.21',
				dist: { tarball: 'https://registry.npmjs.org/l/-/l-4.tgz', shasum: 'ab' }
			},
			'lodash'
		);
		expect(out?.type).toBe('tar');
		expect(out?.mount).toBe('libraries/lodash');
	});

	it('answers null when there is no archive at all', () => {
		expect(distOf({ version: '1.0.0' }, 'x/y')).toBeNull();
	});
});

describe('unpacking', () => {
	it('strips the single leading directory every dist archive wraps its files in', () => {
		// keeping it would mount every file one level too deep, where extension discovery never looks
		expect(commonPrefix(['token-8.x-1.17/token.info.yml', 'token-8.x-1.17/src/A.php'])).toBe(
			'token-8.x-1.17/'
		);
		expect(commonPrefix(['a/x.php', 'b/y.php'])).toBe('');
		expect(commonPrefix(['x.php'])).toBe('');
	});

	it('keeps what a mounted tree can use and reports what it dropped', () => {
		const archive = zipSync({
			'token-1.0/token.info.yml': bytes('name: Token'),
			'token-1.0/src/Tree.php': bytes('<?php class Tree {}'),
			'token-1.0/token.module': bytes('<?php'),
			'token-1.0/js/token.js': bytes('// js'),
			'token-1.0/tests/src/Kernel/TokenTest.php': bytes('<?php'),
			'token-1.0/.gitignore': bytes('vendor'),
			'token-1.0/README.txt': bytes('hello')
		});

		const out = unpackZip(archive, 'modules/contrib/token');
		const kept = out.files.map((f) => f.path).sort();
		expect(kept).toEqual([
			'modules/contrib/token/js/token.js',
			'modules/contrib/token/src/Tree.php',
			'modules/contrib/token/token.info.yml',
			'modules/contrib/token/token.module'
		]);

		// A THIN INSTALL HAS TO BE EXPLAINABLE. Silently keeping four of seven files is how a module
		// that half works becomes a mystery
		const why = Object.fromEntries(out.skipped.map((s) => [s.path, s.why]));
		expect(why['tests/src/Kernel/TokenTest.php']).toContain('mountable');
		expect(why['.gitignore']).toContain('mountable');
		expect(why['README.txt']).toContain('extension');
		expect(out.totalBytes).toBeGreaterThan(0);
	});

	it('refuses a file above the record cap rather than truncating it', () => {
		const archive = zipSync({ 'p-1/big.php': new Uint8Array(RECORD_CAP + 1) });
		const out = unpackZip(archive, 'modules/contrib/p');
		expect(out.files).toEqual([]);
		expect(out.skipped[0]?.why).toContain('record cap');
	});

	it('reads a gzipped tarball, which is what npm serves', () => {
		// `@drupflare/untarl` is a sibling package and already a dependency, so the tar path is not
		// a gap. `tarEntryTree(entries, 1)` strips npm's `package/` wrapper the same way
		// `commonPrefix()` strips a zip's
		const inner = zipSync({ 'package/index.js': bytes('// entry') });
		expect(inner.length).toBeGreaterThan(0);
		const tarball = gzipSync(
			tarOf([
				['package/index.js', bytes('// entry')],
				['package/test/a.js', bytes('// test')],
				['package/README.md', bytes('hi')]
			])
		);
		const out = unpackTar(tarball, 'libraries/lodash');
		expect(out.files.map((f) => f.path)).toEqual(['libraries/lodash/index.js']);
		const why = Object.fromEntries(out.skipped.map((s) => [s.path, s.why]));
		expect(why['test/a.js']).toContain('mountable');
		expect(why['README.md']).toContain('extension');
	});

	it('keeps a json file a module reads at runtime', () => {
		const out = unpackTar(
			tarOf([['package/jquery_ui.libraries.data.json', bytes('{"jquery_ui":{}}')]]),
			'modules/contrib/jquery_ui'
		);
		expect(out.files.map((f) => f.path)).toEqual([
			'modules/contrib/jquery_ui/jquery_ui.libraries.data.json'
		]);
	});

	it('has no allow-list entry that the drop list would also match', () => {
		// a pattern in both lists is a rule nobody can predict the outcome of
		for (const keep of KEEP) {
			expect(DROP.some((d) => d.source === keep.source)).toBe(false);
		}
	});
});

describe('reading what a package needs to load', () => {
	it('undoes composer 2 minification, so an unchanged require is not lost', () => {
		const list = expandMinified([
			{
				version: '2.0.0',
				require: { 'psr/log': '^3' },
				autoload: { 'psr-4': { 'A\\': 'src/' } }
			},
			{ version: '1.9.0' },
			{ version: '1.8.0', require: '__unset' }
		]);
		expect(list[1]).toMatchObject({ version: '1.9.0', require: { 'psr/log': '^3' } });
		expect(list[2]?.['require']).toBeUndefined();
		expect(list[2]?.['autoload']).toEqual({ 'psr-4': { 'A\\': 'src/' } });
	});

	it('keeps package requirements and drops the platform ones', () => {
		expect(
			packageRequirements({
				require: {
					php: '>=8.1',
					'ext-curl': '*',
					'composer-plugin-api': '^2',
					'psr/cache': '^3'
				}
			})
		).toEqual({ 'psr/cache': '^3' });
	});

	it('writes the registrations composer would have, files last', () => {
		const php = autoloadPhp([
			{
				mount: 'vendor/stripe/stripe-php',
				autoload: { 'psr-4': { 'Stripe\\': 'lib/' }, files: ['init.php'] },
				classmap: { Legacy_Thing: 'legacy/Thing.php' }
			},
			{ mount: 'vendor/google/auth', autoload: { 'psr-4': { 'Google\\Auth\\': 'src' } } }
		]);
		expect(php).toContain(
			"$class_loader->addPsr4('Stripe\\\\', [$app_root . '/vendor/stripe/stripe-php/lib']);"
		);
		expect(php).toContain(
			"$class_loader->addClassMap(['Legacy_Thing' => $app_root . '/vendor/stripe/stripe-php/legacy/Thing.php']);"
		);
		expect(php.trim().split('\n').at(-1)).toBe(
			"require_once $app_root . '/vendor/stripe/stripe-php/init.php';"
		);
	});

	it('registers each named package with InstalledVersions before any files entry runs', () => {
		const php = autoloadPhp([
			{
				name: 'drush/drush',
				version: 'v13.8.0',
				mount: 'vendor/drush/drush',
				autoload: { 'psr-4': { 'Drush\\': 'src' }, files: ['includes/a.php'] }
			},
			{ mount: 'vendor/x/unnamed', autoload: {} }
		]);
		expect(php).toContain(
			"$cfw_iv['versions']['drush/drush'] = ['pretty_version' => 'v13.8.0', 'version' => '13.8.0.0'"
		);
		expect(php).not.toContain("x/unnamed'] =");
		expect(php.indexOf('InstalledVersions::reload')).toBeLessThan(php.indexOf('require_once'));
	});

	it('normalizes a release the way composer does', () => {
		expect(composerVersion('v2.3.1')).toBe('2.3.1.0');
		expect(composerVersion('1.0.0-beta5')).toBe('1.0.0.0-beta5');
		expect(composerVersion('3.4')).toBe('3.4.0.0');
		expect(composerVersion('dev-main')).toBe('dev-main');
	});

	it('finds the classes a classmap file declares, under its namespace', () => {
		expect(
			declaredClasses(
				'<?php\nnamespace Acme\\Lib;\nfinal class One {}\ninterface Two {}\nenum Three {}\n'
			)
		).toEqual(['Acme\\Lib\\One', 'Acme\\Lib\\Two', 'Acme\\Lib\\Three']);
	});
});

describe('installing a package with what it requires', () => {
	const realFetch = globalThis.fetch;
	const zip = (files: Record<string, string>) =>
		zipSync(
			Object.fromEntries(
				Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)])
			)
		);
	const archives: Record<string, Uint8Array> = {
		'https://dist.test/app.zip': zip({
			'app-1/src/App.php': '<?php namespace Acme\\App; class App {}'
		}),
		'https://dist.test/lib.zip': zip({
			'lib-1/src/Lib.php': '<?php namespace Acme\\Lib; class Lib {}',
			'lib-1/legacy/Old.php': '<?php class Acme_Old {}',
			'lib-1/functions.php': '<?php function acme_lib() {}'
		})
	};
	const meta: Record<string, unknown> = {
		'acme/app': {
			packages: {
				'acme/app': [
					{
						version: '1.2.0',
						dist: { url: 'https://dist.test/app.zip', type: 'zip' },
						require: {
							php: '>=8.1',
							'acme/lib': '^1.0',
							'guzzlehttp/guzzle': '^7',
							'psr/log-implementation': '^1.0 || ^2.0 || ^3.0'
						},
						autoload: { 'psr-4': { 'Acme\\App\\': 'src/' } }
					}
				]
			}
		},
		'acme/lib': {
			packages: {
				'acme/lib': [
					{
						version: '1.0.3',
						dist: { url: 'https://dist.test/lib.zip', type: 'zip' },
						autoload: {
							'psr-4': { 'Acme\\Lib\\': 'src/' },
							classmap: ['legacy/'],
							files: ['functions.php']
						}
					}
				]
			}
		}
	};

	it('installs the transitive requirement, skips what the pack ships, and records each autoload map', async () => {
		const asked: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			asked.push(url);
			const name = /p2\/(.+)\.json$/.exec(url)?.[1];
			if (name && meta[name]) return Response.json(meta[name]);
			if (archives[url]) return new Response(archives[url]);
			return new Response('not found', { status: 404 });
		}) as typeof fetch;
		try {
			const seen = await inObject(freshSite(), async (site) => {
				const tree = site as unknown as {
					ensureServeTables(): void;
					installTree(r: 'composer', n: string): Promise<Record<string, unknown>[]>;
					packageAutoloads(): { mount: string; classmap: Record<string, string> }[];
				};
				tree.ensureServeTables();
				const installed = await tree.installTree('composer', 'acme/app');
				return { installed, autoloads: tree.packageAutoloads() };
			});
			expect(seen.installed.map((i) => [i['name'], i['ok']])).toEqual([
				['acme/app', true],
				['acme/lib', true]
			]);
			// shipped by the pack, so never fetched
			expect(asked.some((u) => u.includes('guzzlehttp'))).toBe(false);
			// a virtual package the lock's symfony/console provides is met, not fetched
			expect(asked.some((u) => u.includes('log-implementation'))).toBe(false);
			const lib = seen.autoloads.find((a) => a.mount === 'vendor/acme/lib');
			expect(lib?.classmap).toEqual({ Acme_Old: 'legacy/Old.php' });
			expect(autoloadPhp(seen.autoloads as never)).toContain(
				"require_once $app_root . '/vendor/acme/lib/functions.php';"
			);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it('installs a package asked for by name even when a dependency walk already put one there', async () => {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			const name = /p2\/(.+)\.json$/.exec(url)?.[1];
			if (name && meta[name]) return Response.json(meta[name]);
			if (archives[url]) return new Response(archives[url]);
			return new Response('not found', { status: 404 });
		}) as typeof fetch;
		try {
			const seen = await inObject(freshSite(), async (site) => {
				const tree = site as unknown as {
					ensureServeTables(): void;
					installTree(
						r: 'composer',
						n: string,
						c?: string | null
					): Promise<Record<string, unknown>[]>;
				};
				tree.ensureServeTables();
				await tree.installTree('composer', 'acme/app');
				return {
					pinned: await tree.installTree('composer', 'acme/lib', '1.0.3'),
					bare: await tree.installTree('composer', 'acme/lib')
				};
			});
			expect(seen.pinned.map((r) => [r['name'], r['ok']])).toEqual([['acme/lib', true]]);
			// without a version there is nothing to correct, so the installed copy stands
			expect(seen.bare).toEqual([]);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it('names what the cap stopped, with its constraint, so the install can resume', async () => {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			const name = /p2\/(.+)\.json$/.exec(url)?.[1];
			if (name && meta[name]) return Response.json(meta[name]);
			if (archives[url]) return new Response(archives[url]);
			return new Response('not found', { status: 404 });
		}) as typeof fetch;
		try {
			const installed = await inObject(freshSite(), async (site) => {
				const tree = site as unknown as {
					ensureServeTables(): void;
					installTree(
						r: 'composer',
						n: string,
						c: null,
						b: { left: number }
					): Promise<Record<string, unknown>[]>;
				};
				tree.ensureServeTables();
				return tree.installTree('composer', 'acme/app', null, { left: 1 });
			});
			expect(installed[1]).toMatchObject({ ok: false, name: 'acme/lib', constraint: '^1.0' });
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it('remembers what an earlier install replaced, so a resumed install skips it', async () => {
		const graph: Record<string, unknown> = {
			'acme/distro': {
				version: '11.3.1',
				type: 'metapackage',
				replace: { 'acme/legacy': '*' }
			},
			'acme/content': {
				version: '2.6.0',
				type: 'metapackage',
				require: { 'acme/legacy': '*' }
			},
			'acme/legacy': { version: '9.2.11', type: 'metapackage' }
		};
		const asked: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			asked.push(url);
			const name = /p2\/(.+)\.json$/.exec(url)?.[1];
			const entry = name ? graph[name] : undefined;
			return entry
				? Response.json({ packages: { [name!]: [entry] } })
				: new Response('not found', { status: 404 });
		}) as typeof fetch;
		try {
			await inObject(freshSite(), async (site) => {
				const tree = site as unknown as {
					ensureServeTables(): void;
					installTree(r: 'composer', n: string): Promise<Record<string, unknown>[]>;
				};
				tree.ensureServeTables();
				await tree.installTree('composer', 'acme/distro');
				return tree.installTree('composer', 'acme/content');
			});
			expect(asked.some((u) => u.includes('acme/legacy'))).toBe(false);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it('skips a composer plugin, which only composer ever loads, and does not walk its requirements', async () => {
		const graph: Record<string, unknown> = {
			'acme/cards': {
				version: '3.0.3',
				type: 'metapackage',
				require: { 'cweagans/composer-configurable-plugin': '^2' }
			},
			'cweagans/composer-configurable-plugin': {
				version: '2.0.0',
				type: 'composer-plugin',
				dist: { type: 'zip', url: 'https://example.invalid/plugin.zip' },
				require: { 'composer-plugin-api': '^2', 'acme/never': '*' }
			}
		};
		const asked: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			asked.push(url);
			const name = /p2\/(.+)\.json$/.exec(url)?.[1];
			const entry = name ? graph[name] : undefined;
			return entry
				? Response.json({ packages: { [name!]: [entry] } })
				: new Response('not found', { status: 404 });
		}) as typeof fetch;
		try {
			const installed = await inObject(freshSite(), async (site) => {
				const tree = site as unknown as {
					ensureServeTables(): void;
					installTree(r: 'composer', n: string): Promise<Record<string, unknown>[]>;
				};
				tree.ensureServeTables();
				return tree.installTree('composer', 'acme/cards');
			});
			expect(installed.every((one) => one['ok'] === true)).toBe(true);
			expect(installed[1]).toMatchObject({ skipped: expect.stringContaining('build time') });
			expect(asked.some((u) => u.includes('plugin.zip') || u.includes('acme/never'))).toBe(
				false
			);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it('never fetches a name a package already in the tree replaces', async () => {
		const pkg = (version: string, extra: Record<string, unknown>) => ({
			version,
			type: 'metapackage',
			...extra
		});
		const graph: Record<string, unknown> = {
			'acme/suite': pkg('5.2.0', { require: { 'acme/content': '*', 'acme/distro': '*' } }),
			'acme/content': pkg('2.6.0', { require: { 'acme/legacy': '*' } }),
			'acme/distro': pkg('11.3.1', { replace: { 'acme/legacy': '*' } }),
			'acme/legacy': pkg('9.2.11', { require: { 'drupal/address': '^1.8' } })
		};
		const asked: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			asked.push(url);
			const name = /p2\/(.+)\.json$/.exec(url)?.[1];
			const entry = name ? graph[name] : undefined;
			return entry
				? Response.json({ packages: { [name!]: [entry] } })
				: new Response('not found', { status: 404 });
		}) as typeof fetch;
		try {
			const installed = await inObject(freshSite(), async (site) => {
				const tree = site as unknown as {
					ensureServeTables(): void;
					installTree(r: 'composer', n: string): Promise<Record<string, unknown>[]>;
				};
				tree.ensureServeTables();
				return tree.installTree('composer', 'acme/suite');
			});
			expect(installed.map((i) => i['name'])).toEqual([
				'acme/suite',
				'acme/content',
				'acme/distro'
			]);
			expect(asked.some((u) => u.includes('acme/legacy'))).toBe(false);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe('a branch with no dist', () => {
	it('is fetched as the host archive of its ref', () => {
		expect(
			branchArchive({
				source: {
					url: 'https://git.drupalcode.org/project/image_widget_crop.git',
					reference: 'abc123'
				}
			})
		).toBe(
			'https://git.drupalcode.org/project/image_widget_crop/-/archive/abc123/image_widget_crop-abc123.zip'
		);
		expect(
			branchArchive({ source: { url: 'https://github.com/acme/lib.git', reference: 'main' } })
		).toBe('https://codeload.github.com/acme/lib/zip/main');
		expect(
			branchArchive({ source: { url: 'https://git.unl.edu/x/y.git', reference: 'a' } })
		).toBeNull();
		expect(branchArchive({})).toBeNull();
	});
});

describe('a drupal.org submodule', () => {
	it('is a metapackage with no archive, which the parent archive already carries', () => {
		const sub = {
			version: '2.6.0',
			type: 'metapackage',
			require: { 'drupal/flowdrop': '^2', 'drupal/core': '^11.3' }
		};
		expect(isMetapackage(sub)).toBe(true);
		expect(distOf(sub, 'drupal/flowdrop_ui_components')).toBeNull();
		expect(Object.keys(packageRequirements(sub))).toEqual(['drupal/flowdrop', 'drupal/core']);
	});

	it('is not a package that carries an archive, or a module without a type', () => {
		expect(
			isMetapackage({ type: 'metapackage', dist: { url: 'https://x/y.zip', type: 'zip' } })
		).toBe(false);
		expect(isMetapackage({ type: 'drupal-module' })).toBe(false);
		expect(isMetapackage({})).toBe(false);
	});

	it('installs as a no-op on the object and still reports its requirements', async () => {
		const realFetch = globalThis.fetch;
		const meta = {
			packages: {
				'drupal/flowdrop_ui_components': [
					{
						name: 'drupal/flowdrop_ui_components',
						version: '2.6.0',
						type: 'metapackage',
						require: { 'drupal/flowdrop': '^2', 'drupal/core': '^11.3' }
					}
				]
			}
		};
		const asked: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			asked.push(url);
			return url.endsWith('/drupal/flowdrop_ui_components.json')
				? Response.json(meta)
				: new Response('not found', { status: 404 });
		}) as typeof fetch;
		try {
			const out = await inObject(freshSite(), async (site) =>
				(
					site as unknown as {
						installPackage(r: 'composer', n: string): Promise<Record<string, unknown>>;
					}
				).installPackage('composer', 'drupal/flowdrop_ui_components')
			);
			expect(out).toMatchObject({ ok: true, metapackage: true, files: 0, mount: null });
			expect(Object.keys(out['requires'] as object)).toEqual([
				'drupal/flowdrop',
				'drupal/core'
			]);
			// nothing but the metadata was fetched: there is no archive to ask for
			expect(asked).toHaveLength(1);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe('the autoload a build delivers with a vendor package', () => {
	const declared = {
		name: 'acme/widget',
		version: '1.4.0',
		mount: 'vendor/acme/widget',
		autoload: { 'psr-4': { 'Acme\\Widget\\': 'src/' }, files: ['boot.php'] }
	};

	it('is read into the shape autoloadPhp registers', () => {
		const read = parseAutoloadDeclaration(declared);
		expect(read).toMatchObject({ name: 'acme/widget', mount: 'vendor/acme/widget' });
		expect(read).not.toBe('invalid');
		expect(autoloadPhp([read as never])).toContain(
			"$class_loader->addPsr4('Acme\\\\Widget\\\\', [$app_root . '/vendor/acme/widget/src']);"
		);
	});

	it('is none when none was sent', () => {
		expect(parseAutoloadDeclaration(undefined)).toBeNull();
		expect(parseAutoloadDeclaration(null)).toBeNull();
	});

	it('refuses a mount outside vendor and libraries, a climbing path and a bad name', () => {
		for (const bad of [
			{ ...declared, mount: 'core/lib' },
			{ ...declared, mount: 'vendor/../core' },
			{ ...declared, name: 'Acme Widget' },
			{ ...declared, autoload: { files: ['../../settings.php'] } },
			{ ...declared, autoload: { 'psr-4': { 'A\\': 7 } } },
			'acme/widget',
			[declared]
		]) {
			expect(parseAutoloadDeclaration(bad)).toBe('invalid');
		}
	});

	it('computes the classmap from files already read', () => {
		expect(
			classmapOf('vendor/acme/lib', { classmap: ['legacy/'] }, [
				{ path: 'vendor/acme/lib/legacy/Old.php', source: '<?php class Acme_Old {}' },
				{ path: 'vendor/acme/lib/src/New.php', source: '<?php class Acme_New {}' }
			])
		).toEqual({ Acme_Old: 'legacy/Old.php' });
	});
});
