import { describe, expect, it } from 'vitest';
import {
	isSecretMetaRow,
	SECRET_META_KEYS,
	SECRET_META_PREFIXES
} from '../../../src/db/export-sql';

/**
 * Which `cfw_meta` keys a dump withholds.
 *
 * `/export` is the "a customer can leave" path, so its output reaches migration tooling, support
 * and backup storage. The withholding list was an ENUMERATION written when four credentials
 * existed, and three later ones could never have matched it: the SMTP password sits inside
 * `site_smtp_settings` as plaintext JSON, and the git provider token and webhook signing secret are
 * keyed by remote id, so their names are computed and no fixed string can name them.
 */

/** the row shape the dumper reads: `hex(k)` under `h<i>`, with `k` at index 0 */
function metaRow(key: string): Record<string, unknown> {
	const hex = [...new TextEncoder().encode(key)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
		.toUpperCase();
	return { h0: hex, t0: 'text' };
}

const withheld = (key: string) => isSecretMetaRow('cfw_meta', ['k', 'v'], metaRow(key));

describe('a dump withholds every live credential', () => {
	it('withholds the four it always did', () => {
		for (const key of ['owner_token', 'cf_oauth_token', 'cf_oauth_client_id', 'hash_salt']) {
			expect(withheld(key), `${key} left in the dump`).toBe(true);
		}
	});

	it('withholds the SMTP password, which travels inside a settings blob', () => {
		// `mailEnvFromSite()` serialises SMTP_PASS in the clear, so the whole row is the credential
		expect(withheld('site_smtp_settings')).toBe(true);
	});

	it('withholds a git token however the remote is named', () => {
		// keyed by remote id, so an exact list can never cover it; `pending` is the pre-validation
		// key and is written before the remote is confirmed
		expect(withheld('git_token_pending')).toBe(true);
		expect(withheld('git_token_a1b2c3')).toBe(true);
		expect(withheld('git_token_')).toBe(true);
	});

	it('withholds a webhook signing secret however the remote is named', () => {
		expect(withheld('git_hooksecret_pending')).toBe(true);
		expect(withheld('git_hooksecret_a1b2c3')).toBe(true);
	});

	it('keeps ordinary rows, so a dump is still a dump', () => {
		// the control: a prefix rule that withheld everything would pass every case above
		for (const key of ['generation', 'lanes_provisioned', 'driver_digest', 'git_remotes']) {
			expect(withheld(key), `${key} was withheld and should not be`).toBe(false);
		}
	});

	it('reads the key column and not some other column', () => {
		// an earlier version compared against `t<i>`, the TYPE name, which matches 'text' on every
		// row; the row here has the secret in the VALUE column and must not be withheld for it
		const row = { h0: metaRow('generation').h0, h1: metaRow('owner_token').h0 };
		expect(isSecretMetaRow('cfw_meta', ['k', 'v'], row)).toBe(false);
	});

	it('withholds nothing in another table', () => {
		expect(isSecretMetaRow('users', ['k'], metaRow('owner_token'))).toBe(false);
	});

	it('states both halves of the rule, so a reader can audit it', () => {
		expect(SECRET_META_KEYS.has('site_smtp_settings')).toBe(true);
		expect([...SECRET_META_PREFIXES]).toEqual(['git_token_', 'git_hooksecret_']);
	});
});
