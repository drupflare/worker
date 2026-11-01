import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The InputRequired region of scripts/patch-drupal.mjs, run against a one-file fake root.
 *
 * The method text is copied from drupal-src (lines 77-91 of InputRequired.php) rather than read at
 * test time, so this runs on a clean checkout where drupal-src does not exist. The script is run as
 * a child process with the temp root as its only argument; it never sees the real tree.
 *
 * Node lane: it spawns node and writes under the OS temp directory.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/patch-drupal.mjs');
const FILE = 'core/modules/views/src/Plugin/views/exposed_form/InputRequired.php';

const METHOD =
	[
		'  protected function exposedFilterApplied() {',
		'    static $cache = NULL;',
		'    if (!isset($cache)) {',
		'      $view = $this->view;',
		'      if (is_array($view->filter) && count($view->filter)) {',
		'        foreach ($view->filter as $filter) {',
		'          if ($filter->isExposed()) {',
		"            $identifier = $filter->options['expose']['identifier'];",
		'            if (isset($view->getExposedInput()[$identifier])) {',
		'              $cache = TRUE;',
		'              return $cache;',
		'            }',
		'          }',
		'        }',
		'      }'
	].join('\n') + '\n';

const MOVED = ['  protected function exposedFilterApplied() {', '    return TRUE;', '  }', ''].join(
	'\n'
);

const scratches: string[] = [];

afterAll(() => {
	for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

function fakeRoot(body: string): string {
	const root = mkdtempSync(join(tmpdir(), 'drupflare-patch-drupal-'));
	scratches.push(root);
	mkdirSync(join(root, dirname(FILE)), { recursive: true });
	writeFileSync(join(root, FILE), body);
	return root;
}

function patch(root: string) {
	return spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
}

describe('scripts/patch-drupal.mjs on InputRequired::exposedFilterApplied()', () => {
	it('turns the function static into a per-call local and leaves the local in place', () => {
		const root = fakeRoot(METHOD);
		const result = patch(root);
		expect(result.status, result.stderr).toBe(0);
		const src = readFileSync(join(root, FILE), 'utf8');
		expect(src).not.toContain('static $cache = NULL;');
		expect(src).toMatch(/^ {4}\$cache = NULL;$/m);
	});

	it('leaves the file byte-identical when run a second time', () => {
		const root = fakeRoot(METHOD);
		patch(root);
		const once = readFileSync(join(root, FILE), 'utf8');
		const second = patch(root);
		expect(second.status, second.stderr).toBe(0);
		expect(second.stdout).toContain('static already removed');
		expect(readFileSync(join(root, FILE), 'utf8')).toBe(once);
	});

	it('exits nonzero with the moved message when neither form is present', () => {
		const result = patch(fakeRoot(MOVED));
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('exposedFilterApplied() moved');
	});
});
