import { describe, expect, it } from 'vitest';
import {
	classifyState,
	replicaMayOriginate,
	replicaMayServe
} from '../../../src/ops/state-inventory';

/**
 * The classifier's asymmetry is the property under test.
 *
 * Guessing AUTHORITATIVE costs a failover to the primary. Guessing LOCAL or DERIVED lets a replica
 * originate state that must be globally shared, which is silent divergence. So patterns are allowed
 * in one direction and not the other, and the default is `UNKNOWN`.
 */

describe('a table is not an effect', () => {
	it('splits one key_value table by collection and name', () => {
		expect(classifyState('key_value', 'state', 'system.private_key')).toBe('AUTHORITATIVE');
		expect(classifyState('key_value', 'state', 'system.cron_key')).toBe('AUTHORITATIVE');
		expect(classifyState('key_value', 'state', 'system.theme.files')).toBe(
			'REPLICABLE_DERIVED'
		);
		expect(classifyState('key_value', 'update_fetch_task', 'drupal')).toBe(
			'REPLICABLE_DERIVED'
		);
		expect(classifyState('key_value', 'system.schema', 'node')).toBe('AUTHORITATIVE');
	});

	/** the same table, so a per-table verdict is wrong in whichever direction it is set */
	it('gives opposite verdicts inside one table', () => {
		const secret = classifyState('key_value', 'state', 'system.private_key');
		const queue = classifyState('key_value', 'update_fetch_task', 'drupal');
		expect(secret).not.toBe(queue);
		expect(replicaMayOriginate(secret)).toBe(false);
		expect(replicaMayOriginate(queue)).toBe(true);
	});

	it('refuses to judge a key_value row it cannot see the name of', () => {
		expect(classifyState('key_value', 'state')).toBe('UNKNOWN');
		expect(classifyState('key_value')).toBe('UNKNOWN');
		expect(classifyState('key_value', 'some_contrib_collection', 'x')).toBe('UNKNOWN');
	});
});

describe('the three values a replica may never originate', () => {
	/**
	 * All three are minted LAZILY on first use, which is what makes them dangerous rather than
	 * merely authoritative: a replica reaching the code path before replication delivered the value
	 * creates one, and nothing errors until the results meet.
	 */
	it('names the two secrets and the id generator', () => {
		expect(classifyState('key_value', 'state', 'system.private_key')).toBe('AUTHORITATIVE');
		expect(classifyState('key_value', 'state', 'system.cron_key')).toBe('AUTHORITATIVE');
		expect(classifyState('sequences')).toBe('AUTHORITATIVE');
		for (const status of [
			classifyState('key_value', 'state', 'system.private_key'),
			classifyState('key_value', 'state', 'system.cron_key'),
			classifyState('sequences')
		]) {
			expect(replicaMayOriginate(status)).toBe(false);
		}
	});
});

describe('patterns run in the safe direction only', () => {
	it('treats entity field and revision storage as authoritative without enumerating it', () => {
		for (const table of [
			'node__body',
			'media__field_media_image',
			'user__user_picture',
			'node_revision',
			'node_revision__body',
			'taxonomy_term_field_revision',
			'block_content_revision__body',
			// a contrib field nobody has listed
			'node__field_something_nobody_listed'
		]) {
			expect(classifyState(table), table).toBe('AUTHORITATIVE');
		}
	});

	it('has no pattern that can produce a local or derived verdict', () => {
		// an unlisted table that merely LOOKS cache-like is still unknown, and unknown routes to
		// the primary; only the `cache_` prefix earns a local verdict
		expect(classifyState('cache_render')).toBe('LOCAL_EPHEMERAL');
		expect(classifyState('my_module_cache')).toBe('UNKNOWN');
		expect(classifyState('something_temp')).toBe('UNKNOWN');
		expect(classifyState('')).toBe('UNKNOWN');
	});

	it('lets an explicit verdict beat a pattern', () => {
		// matches `_revision$` and is nonetheless listed; the explicit entry must win
		expect(classifyState('path_alias_revision')).toBe('AUTHORITATIVE');
		expect(classifyState('router')).toBe('REPLICABLE_DERIVED');
		expect(classifyState('menu_tree')).toBe('REPLICABLE_DERIVED');
	});
});

describe('what each status permits', () => {
	it('lets a replica serve everything except an unknown or an outbound effect', () => {
		expect(replicaMayServe('AUTHORITATIVE')).toBe(true);
		expect(replicaMayServe('REPLICABLE_DERIVED')).toBe(true);
		expect(replicaMayServe('LOCAL_EPHEMERAL')).toBe(true);
		expect(replicaMayServe('PRIMARY_ONLY_SIDE_EFFECT')).toBe(false);
		expect(replicaMayServe('UNKNOWN')).toBe(false);
	});

	it('lets a replica originate only what it can rebuild', () => {
		expect(replicaMayOriginate('LOCAL_EPHEMERAL')).toBe(true);
		expect(replicaMayOriginate('REPLICABLE_DERIVED')).toBe(true);
		expect(replicaMayOriginate('AUTHORITATIVE')).toBe(false);
		expect(replicaMayOriginate('PRIMARY_ONLY_SIDE_EFFECT')).toBe(false);
		expect(replicaMayOriginate('UNKNOWN')).toBe(false);
	});

	it('sends the outbound queues and the log to the primary', () => {
		for (const table of ['cfw_http_queue', 'cfw_mail_queue', 'watchdog']) {
			expect(classifyState(table), table).toBe('PRIMARY_ONLY_SIDE_EFFECT');
			expect(replicaMayServe(classifyState(table))).toBe(false);
		}
	});
});
