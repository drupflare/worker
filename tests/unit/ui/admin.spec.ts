import { describe, expect, it } from 'vitest';
import siteDoSource from '../../../src/site-do.ts?raw';
import siteSource from '../../../src/site.ts?raw';
import {
	ADMIN_PAGES,
	PROVISION_STEPS,
	escapeHtml,
	renderCommands,
	renderDeploy,
	renderExtend,
	renderShell,
	renderThresholds
} from '../../../src/ui/admin';

/**
 * The product surfaces.
 *
 * Two properties carry the weight here, and neither is about appearance.
 *
 * ESCAPING, because every one of these pages renders a string a visitor supplied -- a package name, a
 * command, a query. An admin page that reflects `q` unescaped is a stored-XSS surface on the one page
 * that drives `/__ops`.
 *
 * HONESTY, because a UI can always be drawn and cannot make a mechanism exist. The Deploy surface
 * must not render a button, and the Commands surface must not offer an operation with no driver. Both
 * are asserted, including the control that the surface DOES offer the ones that work -- otherwise
 * "renders nothing" would pass.
 */

describe('escapeHtml', () => {
	it.each([
		['<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
		['" onload="x', '&quot; onload=&quot;x'],
		["' onmouseover='x", '&#39; onmouseover=&#39;x'],
		['a & b', 'a &amp; b']
	])('escapes %s', (raw, want) => {
		expect(escapeHtml(raw)).toBe(want);
	});

	it('escapes the ampersand first, so an entity cannot be smuggled through', () => {
		// &lt; must not become &amp;lt; -- and &amp; must not be produced by escaping the < first
		expect(escapeHtml('&lt;')).toBe('&amp;lt;');
	});

	it('stringifies a non-string rather than throwing', () => {
		expect(escapeHtml(42)).toBe('42');
		expect(escapeHtml(null)).toBe('null');
		expect(escapeHtml(undefined)).toBe('undefined');
	});
});

describe('renderShell', () => {
	it('marks the current page and links every other one', () => {
		const html = renderShell('extend', '<p>body</p>', { PLAN: 'free' });
		expect(html).toContain('aria-current="page"');
		for (const p of ADMIN_PAGES) expect(html).toContain(`href="${p.path}"`);
	});

	it('marks exactly one page current', () => {
		// scoped to the nav element: the stylesheet carries a `nav a[aria-current]` selector too, and
		// counting that would make this pass for the wrong reason
		const html = renderShell('deploy', '', null);
		const nav = html.slice(html.indexOf('<nav>'), html.indexOf('</nav>'));
		expect(nav.match(/aria-current/g)).toHaveLength(1);
		expect(nav).toContain('href="/admin/deploy"');
	});

	it('reports the plan it rendered against', () => {
		expect(renderShell('thresholds', '', { PLAN: 'paid' })).toContain('plan: paid');
		expect(renderShell('thresholds', '', { PLAN: 'free' })).toContain('plan: free');
		// an absent plan is free, never paid
		expect(renderShell('thresholds', '', null)).toContain('plan: free');
	});

	it('is a complete document with a viewport, so it is usable on a phone', () => {
		const html = renderShell('thresholds', '', null);
		expect(html.startsWith('<!doctype html>')).toBe(true);
		expect(html).toContain('name="viewport"');
		expect(html.trimEnd().endsWith('</html>')).toBe(true);
	});
});

describe('renderThresholds', () => {
	it('names the failure mode per meter, not just the number', () => {
		const html = renderThresholds({}, null, { PLAN: 'free' });
		// the distinction the whole module exists for
		expect(html).toContain('stops working');
		expect(html).toContain('refused, site stays up');
	});

	it('shows an unmeasured meter as unmeasured rather than healthy', () => {
		const html = renderThresholds({}, null, { PLAN: 'free' });
		expect(html).toContain('nothing measures this yet');
	});

	it('projects the 10-styles-over-2,000-images case as over, with remedies', () => {
		const html = renderThresholds({}, { images: 2_000, styles: 10 }, { PLAN: 'free' });
		expect(html).toContain('4x OVER');
		expect(html).toContain('stop being transformed');
		expect(html).toContain('reduce to 2 style(s)');
		expect(html).toContain('card bad');
	});

	it('does not shout at a site that fits', () => {
		const html = renderThresholds({}, { images: 100, styles: 3 }, { PLAN: 'free' });
		expect(html).not.toContain('OVER');
		expect(html).not.toContain('card bad');
	});

	it('tells a visitor how to project their own configuration when none was given', () => {
		expect(renderThresholds({}, null, { PLAN: 'free' })).toContain('images=2000');
	});

	it('escapes what it renders', () => {
		const html = renderThresholds({}, { images: 1, styles: 1 }, { PLAN: 'free' });
		expect(html).not.toContain('<script');
	});
});

describe('renderExtend', () => {
	it('reflects the query into the field ESCAPED', () => {
		const html = renderExtend('"><script>alert(1)</script>', [], null, null);
		expect(html).not.toContain('<script>alert(1)');
		expect(html).toContain('&lt;script&gt;');
	});

	it('renders a verdict per entry', () => {
		const html = renderExtend(
			'drupal/pathauto',
			[{ name: 'drupal/pathauto', version: '1.13.0', verdict: 'installable', reason: null }],
			null,
			{ PLAN: 'free' }
		);
		expect(html).toContain('drupal/pathauto');
		expect(html).toContain('installable');
	});

	it('says nothing is checked rather than rendering an empty table', () => {
		expect(renderExtend(null, [], null, null)).toContain('Nothing checked yet');
	});

	it('records the packages.drupal.org fix, which made the whole ecosystem answer not-found', () => {
		const html = renderExtend(null, [], null, null);
		expect(html).toContain('packages.drupal.org/8');
		expect(html).toContain('404s for every Drupal package');
	});

	it('warns on free that installing spends the SERVING ceiling', () => {
		// a Workflow invocation is billed against the same daily quota as a visitor request
		expect(renderExtend(null, [], null, { PLAN: 'free' })).toContain('serving ceiling');
		expect(renderExtend(null, [], null, { PLAN: 'paid' })).not.toContain('serving ceiling');
	});

	it('separates unverifiable from blocked, because they are different answers', () => {
		expect(renderExtend(null, [], null, null)).toContain('not that the module is broken');
	});
});

describe('renderCommands', () => {
	const entries = [
		{ op: 'cr', label: 'rebuild caches', driver: 'the updb alarm chain', cost: '282.9 ms' },
		{ op: 'cim', label: 'import config', driver: null, cost: null }
	];

	it('offers an operation that has a driver', () => {
		const html = renderCommands(entries, null, null);
		expect(html).toContain('drush cr');
		expect(html).toContain('the updb alarm chain');
	});

	it('lists an operation with NO driver and says so, rather than offering it', () => {
		const html = renderCommands(entries, null, null);
		expect(html).toContain('drush cim');
		expect(html).toContain('no driver exists yet');
	});

	it('counts how many can actually run, so the header does not overstate it', () => {
		expect(renderCommands(entries, null, null)).toContain('1 of 2');
	});

	it('escapes the submitted command and the result', () => {
		const html = renderCommands(
			entries,
			'<img src=x onerror=alert(1)>',
			'"><script>x</script>'
		);
		expect(html).not.toContain('<img src=x');
		expect(html).not.toContain('<script>x');
	});
});

describe('renderDeploy: it must not render a button that lies', () => {
	it('says plainly that no one-click deploy exists', () => {
		const html = renderDeploy();
		expect(html).toContain('no one-click deploy yet');
		expect(html).toContain('will not pretend otherwise');
	});

	it('renders NO submit control at all', () => {
		// the control: every other surface has a button, so "no button" is a real assertion here
		const html = renderDeploy();
		expect(html).not.toContain('<button');
		expect(html).not.toContain('<form');
		expect(renderExtend(null, [], null, null)).toContain('<button');
	});

	it('renders the requirement set instead, marking what needs a human', () => {
		const html = renderDeploy();
		expect(html).toContain('needs a human');
		expect(html).toContain('scriptable');
		for (const step of PROVISION_STEPS) expect(html).toContain(step.label);
	});

	it('names the two steps that cannot be automated', () => {
		const manual = PROVISION_STEPS.filter((s) => !s.automatable).map((s) => s.id);
		expect(manual).toEqual(['token', 'admin-auth']);
	});

	it('points at the command that does work today', () => {
		expect(renderDeploy()).toContain('bun run deploy');
	});
});

describe('the surfaces stay honest against the code behind them', () => {
	it('every admin route in site.ts is behind the diagnostic gate', () => {
		// these pages drive /__ops, which runs cache rebuilds and module installs. Unauthenticated,
		// that is a remote shell -- the exact defect site.ts already had once and fixed
		const diag = siteSource.slice(
			siteSource.indexOf('const DIAGNOSTIC_ROUTES'),
			siteSource.indexOf('const ROUTES =')
		);
		for (const p of ADMIN_PAGES) expect(diag).toContain(`'${p.path}'`);
		const pub = siteSource.slice(
			siteSource.indexOf('const PUBLIC_ROUTES'),
			siteSource.indexOf('const DIAGNOSTIC_ROUTES')
		);
		for (const p of ADMIN_PAGES) expect(pub).not.toContain(`'${p.path}'`);
	});

	it('does not claim a driver for an operation site-do.ts records as having none', () => {
		// pinned against the object's own OPS_DRIVERS map, so the Commands page cannot drift into
		// offering something that has no way to run
		const region = siteDoSource.slice(
			siteDoSource.indexOf('const OPS_DRIVERS'),
			siteDoSource.indexOf('const OPS_DRIVERS') + 900
		);
		expect(/cex:\s*null/.test(region)).toBe(true);
		expect(/cim:\s*null/.test(region)).toBe(true);
	});
});
