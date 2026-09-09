import { describe, expect, it } from 'vitest';
import { freshSite, inObject, type ServeDo } from '../helpers/serve-do';

type Interp = ServeDo & { run: (code: string) => Promise<string> };

/** the methods each real subclass in `drupal-src/modules/contrib` calls on its parent */
const SUBCLASS_CALLS = {
	// modules/contrib/simple_sitemap/.../SitemapWriter.php
	simple_sitemap: ['startDocument', 'writeComment', 'writePI'],
	// modules/contrib/xmlsitemap/src/XmlSitemapWriter.php
	xmlsitemap: [
		'openUri',
		'setIndent',
		'startElement',
		'writeAttribute',
		'writeRaw',
		'writePI',
		'endElement',
		'flush'
	]
} as const;

const PROBE = `<?php
$absent = [];
foreach (['xmlwriter','xmlreader','zip','intl','bcmath','calendar','exif','phar','tidy','gd'] as $ext) {
  $absent[$ext] = !extension_loaded($ext);
}
$methods = class_exists('XMLWriter', false)
  ? array_map('strtolower', get_class_methods('XMLWriter'))
  : null;
echo json_encode([
  'absent' => $absent,
  'xmlwriterClass' => $methods,
  'xmlreaderClass' => class_exists('XMLReader', false),
  'zipClass' => class_exists('ZipArchive', false),
]);`;

describe('the inherited extensions, measured rather than inherited', () => {
	it('is absent for all ten, and the XMLWriter stand-in covers every method its subclasses call', async () => {
		const seen = await inObject(freshSite(), async (site: ServeDo) => {
			const text = await (site as Interp).run(PROBE);
			const at = text.indexOf('{');
			if (at < 0) throw new Error(`no JSON printed; PHP said: ${text.slice(0, 600)}`);
			return JSON.parse(text.slice(at)) as Record<string, unknown>;
		});
		console.log(`[inherited-ext] ${JSON.stringify(seen)}`);

		// the premise the call-site census rests on: every one of these is a real absence
		const absent = seen['absent'] as Record<string, boolean>;
		for (const [ext, gone] of Object.entries(absent)) {
			expect(gone, `${ext} is loaded, so the census scored a question that is settled`).toBe(
				true
			);
		}

		// `ext-xmlwriter` needs no build: the stand-in is the implementation, and the only thing
		// that decides whether it is correct is whether it answers what its real callers call
		const methods = seen['xmlwriterClass'] as unknown as string[] | null;
		expect(
			methods,
			'no XMLWriter at all, so both sitemap modules fatal on construction'
		).toBeTruthy();
		for (const [module, calls] of Object.entries(SUBCLASS_CALLS)) {
			for (const call of calls) {
				expect(
					methods,
					`${module} calls XMLWriter::${call}() and the stand-in does not define it`
				).toContain(call.toLowerCase());
			}
		}

		// the two still open, pinned so the answer is a reading rather than an assumption
		expect(seen['xmlreaderClass']).toBe(false);
		expect(seen['zipClass']).toBe(false);
	}, 900_000);
});
