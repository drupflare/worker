import { describe, expect, it } from 'vitest';
import { jsonError } from '../../../src/util/reply';

describe('jsonError', () => {
	it('answers ok:false with the error and the status', async () => {
		const res = jsonError('nope', 400);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ ok: false, error: 'nope' });
	});

	it('is JSON', () => {
		expect(jsonError('x', 500).headers.get('content-type')).toContain('application/json');
	});

	it('puts ok first, error second, then the extra keys in their order', async () => {
		const res = jsonError('nope', 409, { b: 1, a: 2 });
		expect(await res.text()).toBe('{"ok":false,"error":"nope","b":1,"a":2}');
	});

	it('matches the Response.json call it replaces', async () => {
		const extra = { reason: 'r', n: 3 };
		const old = Response.json({ ok: false, error: 'e', ...extra }, { status: 403 });
		const now = jsonError('e', 403, extra);
		expect(now.status).toBe(old.status);
		expect(await now.text()).toBe(await old.text());
	});

	it('takes no extra by default', async () => {
		expect(await jsonError('e', 404).text()).toBe('{"ok":false,"error":"e"}');
	});
});
