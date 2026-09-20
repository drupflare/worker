import { describe, expect, it } from 'vitest';
import { firstDifference, longestFirst, loopbackOrigins, maskOrigins } from '../e2e/helpers/twice';

/**
 * The comparison helpers the e2e differentials decide a leak on.
 *
 * They had no gate test, and they are pure, so the only thing exercising them was a lane that needs
 * a docker rig and a live worker. That is how an ordering bug in `maskOrigins()`'s argument list
 * reached CI twice: the first fix masked the right origins in the wrong order and the run came back
 * five bytes apart.
 *
 * The strings below are the real ones, taken from run 35483193390.
 */

// what the two reads of the same page actually carried: one filled by the ALARM, which has no
// request to take an origin from, and one rendered live against the endpoint
const ALARM_FILLED = '<link rel="alternate" href="http://localhost:8801/rss.xml" /><p>body</p>';
const LIVE_RENDER = '<link rel="alternate" href="http://127.0.0.1:8787/rss.xml" /><p>body</p>';

describe('masking the origins two renders disagree on', () => {
	it('finds every loopback origin a document names, with its port', () => {
		expect(loopbackOrigins(ALARM_FILLED)).toEqual(['http://localhost:8801']);
		expect(loopbackOrigins(LIVE_RENDER)).toEqual(['http://127.0.0.1:8787']);
	});

	it('orders longest first, which is what makes the replacement safe', () => {
		const ordered = longestFirst(['http://localhost', 'http://localhost:8801']);
		expect(ordered[0]).toBe('http://localhost:8801');
	});

	/**
	 * THE BUG, PINNED. `maskOrigins` replaces in list order, so the bare host matches the prefix of
	 * the ported one and leaves `:8801` stranded -- `<origin>/rss.xml` against `<origin>:8801`.
	 */
	it('leaves a bare port behind when the shorter origin is masked first', () => {
		const bad = maskOrigins({ first: ALARM_FILLED, second: LIVE_RENDER }, [
			'http://localhost',
			'http://127.0.0.1:8787'
		]);
		expect(firstDifference(bad.first, bad.second)).not.toBeNull();
	});

	it('masks clean when the origins are scraped from the documents and ordered', () => {
		const origins = longestFirst([
			...loopbackOrigins(ALARM_FILLED),
			...loopbackOrigins(LIVE_RENDER)
		]);
		const good = maskOrigins({ first: ALARM_FILLED, second: LIVE_RENDER }, origins);
		expect(firstDifference(good.first, good.second)).toBeNull();
	});

	/**
	 * The control, and the reason this masking is allowed to exist at all. Masking an origin must
	 * not defang the assertion it sits inside: admin markup in an anonymous response still differs.
	 */
	it('still reports a real content difference through the mask', () => {
		const leaked = LIVE_RENDER.replace('body', 'admin toolbar');
		const origins = longestFirst([
			...loopbackOrigins(ALARM_FILLED),
			...loopbackOrigins(leaked)
		]);
		const masked = maskOrigins({ first: ALARM_FILLED, second: leaked }, origins);
		expect(firstDifference(masked.first, masked.second)).not.toBeNull();
	});
});
