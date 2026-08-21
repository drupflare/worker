import { describe, expect, it } from 'vitest';
import {
	assemble,
	decodeEntities,
	placeholderIds,
	shellDecision,
	shellSafety
} from '../../../src/ops/shell-assembly';

/**
 * Fragment assembly, and mostly the refusals.
 *
 * A wrong permit here serves one visitor's account menu to another. The cost of a wrong refusal is
 * one ordinary render. That asymmetry is why almost every test below asserts that something is NOT
 * allowed.
 */

const hole = (id: string) => `<span data-big-pipe-placeholder-id="${id}"></span>`;
const shell = (...ids: string[]) =>
	`<html><body><h1>Shared</h1>${ids.map(hole).join('')}</body></html>`;

describe('placeholderIds', () => {
	it('finds BigPipe holes in document order', () => {
		expect(placeholderIds(shell('a', 'b'))).toEqual(['a', 'b']);
	});

	it('finds none in a fully rendered page', () => {
		expect(placeholderIds('<html><body>no holes</body></html>')).toEqual([]);
	});

	/**
	 * A placeholder id is an ESCAPED callback signature.
	 *
	 * `BigPipeStrategy` runs it through `Html::escape()`, so a real id contains `&quot;` and `&amp;`.
	 * Comparing the raw attribute against an unescaped id matches nothing and every hole reads as
	 * unfilled -- which fails safe, but fails constantly.
	 */
	it('decodes the escaping core applies to the id', () => {
		const id = 'callback=user.toolbar_link_builder:renderDisplayName&amp;args[]=&quot;x&quot;';
		expect(placeholderIds(hole(id))).toEqual([
			'callback=user.toolbar_link_builder:renderDisplayName&args[]="x"'
		]);
	});

	it('reverses every entity Html::escape produces', () => {
		expect(decodeEntities('&lt;a&gt;&quot;b&quot;&#039;c&#39;&amp;d')).toBe('<a>"b"\'c\'&d');
	});

	/**
	 * `&amp;` LAST, or a double-decode corrupts the id.
	 *
	 * `&amp;quot;` is a literal `&quot;` in the source. Decoding `&amp;` first turns it into
	 * `&quot;` and the next pass turns that into `"`, producing an id the shell does not contain.
	 */
	it('does not double-decode an escaped ampersand', () => {
		expect(decodeEntities('&amp;quot;')).toBe('&quot;');
	});
});

describe('shellSafety', () => {
	it('permits a page whose personalisation is confined to holes', () => {
		const out = shellSafety(shell('user-menu', 'cart'));
		expect(out.safe).toBe(true);
		expect(out.placeholders).toEqual(['user-menu', 'cart']);
	});

	/**
	 * A PAGE WITH NO HOLES IS NOT A SHELL.
	 *
	 * It is a fully rendered page, and sharing it is what the ordinary page cache already does for
	 * anonymous traffic. Treating it as a shell would share an authenticated render with everyone.
	 */
	it('refuses a page with no placeholders', () => {
		const out = shellSafety('<html><body>fully rendered</body></html>');
		expect(out.safe).toBe(false);
		if (!out.safe) expect(out.reason).toContain('no placeholders');
	});

	it('refuses a page carrying an identity marker outside a hole', () => {
		for (const marker of ['user-logged-in', 'is-logged-in', '"uid":1']) {
			const out = shellSafety(`<html><body class="${marker}">${hole('x')}</body></html>`);
			expect(out.safe, marker).toBe(false);
		}
	});

	/**
	 * A marker INSIDE a hole is fine, which is the whole point of a hole.
	 *
	 * The scan runs against the page with placeholders removed. Without that, every real shell would
	 * be refused the moment a personalised region mentioned a uid -- which is always.
	 */
	it('ignores an identity marker inside a placeholder', () => {
		const inside = `<html><body><span data-big-pipe-placeholder-id="user-logged-in&quot;uid&quot;"></span></body></html>`;
		expect(shellSafety(inside).safe).toBe(true);
	});

	it('reports the placeholders it found even when it refuses', () => {
		const out = shellSafety(`<html><body class="user-logged-in">${hole('a')}</body></html>`);
		expect(out.placeholders).toEqual(['a']);
	});
});

describe('assemble', () => {
	it('fills every hole it has a fragment for', () => {
		const out = assemble(shell('a', 'b'), [
			{ id: 'a', html: '<nav>A</nav>' },
			{ id: 'b', html: '<nav>B</nav>' }
		]);
		expect(out.html).toContain('<nav>A</nav>');
		expect(out.html).toContain('<nav>B</nav>');
		expect(out.html).not.toContain('data-big-pipe-placeholder-id');
		expect(out.filled).toEqual(['a', 'b']);
		expect(out.unfilled).toEqual([]);
	});

	/**
	 * AN UNFILLED HOLE IS LEFT IN PLACE, never removed.
	 *
	 * Removing it drops a whole region silently -- a visitor sees their account menu simply absent
	 * and nothing reports it. Left as an empty span, BigPipe's own JavaScript can still fill it, and
	 * the caller gets the id back to log.
	 */
	it('leaves an unanswered hole alone and reports it', () => {
		const out = assemble(shell('a', 'b'), [{ id: 'a', html: '<nav>A</nav>' }]);
		expect(out.unfilled).toEqual(['b']);
		expect(out.html).toContain(hole('b'));
		expect(out.filled).toEqual(['a']);
	});

	it('reports a fragment the shell has no hole for, rather than dropping it silently', () => {
		const out = assemble(shell('a'), [
			{ id: 'a', html: 'A' },
			{ id: 'ghost', html: 'G' }
		]);
		expect(out.unmatched).toEqual(['ghost']);
		expect(out.html).not.toContain('G');
	});

	it('matches an escaped id against its decoded fragment key', () => {
		const escaped = 'callback=x&amp;args[]=&quot;y&quot;';
		const decoded = 'callback=x&args[]="y"';
		const out = assemble(hole(escaped), [{ id: decoded, html: 'FILLED' }]);
		expect(out.filled).toEqual([decoded]);
		expect(out.html).toBe('FILLED');
	});

	it('does not treat fragment markup as a placeholder to fill again', () => {
		// a fragment that itself contains a placeholder span must not be rescanned; String.replace
		// with a global regex does not revisit inserted text, and this pins that
		const out = assemble(shell('a'), [{ id: 'a', html: hole('a') }]);
		expect(out.filled).toEqual(['a']);
		expect(out.unfilled).toEqual([]);
	});

	it('returns the shell untouched when there is nothing to fill', () => {
		const s = '<html><body>plain</body></html>';
		expect(assemble(s, []).html).toBe(s);
	});
});

describe('shellDecision', () => {
	const safe = shellSafety(shell('a'));

	it('assembles for an authenticated GET with a safe shell and a fragment source', () => {
		const d = shellDecision({
			method: 'GET',
			authenticated: true,
			shell: safe,
			fragmentsAvailable: true
		});
		expect(d.assemble).toBe(true);
	});

	/**
	 * A SUBMISSION NEVER COMES FROM A SHARED ARTIFACT.
	 *
	 * Its response is for one submitter, which is the same rule `cfw_page` already follows and the
	 * same one the quota ladder's read-only rung enforces from the other side.
	 */
	it('refuses any non-GET', () => {
		for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
			const d = shellDecision({
				method,
				authenticated: true,
				shell: safe,
				fragmentsAvailable: true
			});
			expect(d.assemble, method).toBe(false);
		}
	});

	it('refuses anonymous traffic, which the page cache serves more cheaply', () => {
		const d = shellDecision({
			method: 'GET',
			authenticated: false,
			shell: safe,
			fragmentsAvailable: true
		});
		expect(d.assemble).toBe(false);
		expect(d.reason).toContain('page cache');
	});

	it('refuses when there is no shell, and says so rather than guessing', () => {
		const d = shellDecision({
			method: 'GET',
			authenticated: true,
			shell: null,
			fragmentsAvailable: true
		});
		expect(d.assemble).toBe(false);
		expect(d.reason).toContain('no shell');
	});

	it('carries the safety reason through, so a refusal is diagnosable', () => {
		const unsafe = shellSafety('<html><body class="user-logged-in">x</body></html>');
		const d = shellDecision({
			method: 'GET',
			authenticated: true,
			shell: unsafe,
			fragmentsAvailable: true
		});
		expect(d.assemble).toBe(false);
		expect(d.reason).toContain('no placeholders');
	});

	it('refuses with no fragment source, rather than serving holes to a logged-in visitor', () => {
		const d = shellDecision({
			method: 'GET',
			authenticated: true,
			shell: safe,
			fragmentsAvailable: false
		});
		expect(d.assemble).toBe(false);
	});
});
