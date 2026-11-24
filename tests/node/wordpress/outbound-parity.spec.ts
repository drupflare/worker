import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { refuseOutbound } from '../../../src/ops/outbound-guard';

/**
 * The address policy the WordPress host plugin applies before it spends a request must refuse what
 * the worker's guard refuses. Both read one list of URLs, and the plugin's own function runs in a
 * real PHP process, so a change to either side that the other lacks fails here.
 */

const SIBLING = process.env.DRUPFLARE_SRC ?? resolve(import.meta.dirname, '../../../../drupflare');
const PHP = process.env.PHP ?? 'php';
const cases = JSON.parse(
	readFileSync(join(SIBLING, 'tests/wp/fixtures/outbound-urls.json'), 'utf8')
) as { url: string; refused: boolean }[];

const php = (urls: string[]): (string | null)[] => {
	const script = [
		`require ${JSON.stringify(join(SIBLING, 'src/Wp/mu/drupflare-host/shims.php'))};`,
		`require ${JSON.stringify(join(SIBLING, 'src/Wp/mu/drupflare-host/http.php'))};`,
		'$urls = json_decode(stream_get_contents(STDIN), true);',
		'echo json_encode(array_map("drupflare_http_refusal", $urls));'
	].join('\n');
	const out = execFileSync(PHP, ['-d', 'display_errors=1', '-r', script], {
		input: JSON.stringify(urls),
		env: { ...process.env, DRUPFLARE_HOST_LIB: join(SIBLING, 'src') }
	});
	return JSON.parse(out.toString()) as (string | null)[];
};

describe('the host plugin and the worker agree on which URLs leave', () => {
	const fromPhp = php(cases.map((c) => c.url));

	it.each(cases.map((c, i) => [c.url, c.refused, i] as const))(
		'%s is refused: %s',
		(url, refused, i) => {
			expect(refuseOutbound(url) !== undefined, `worker, ${url}`).toBe(refused);
			expect(fromPhp[i] !== null, `plugin, ${url}`).toBe(refused);
		}
	);
});
