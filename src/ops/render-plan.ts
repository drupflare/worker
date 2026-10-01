/**
 * A compiled render plan (constant bytes plus per-request slots) and the VM that runs it.
 *
 * Slots are found by diffing two renders of one page; a marker list would pass on a value it has
 * never seen. A slot with no generator refuses to serve: `fillSlots()` returns undefined and the
 * caller answers 409 instead of filling it with a random string of the right size.
 *
 * @module
 */

/** constant bytes, or a named hole */
export type PlanOp = ['t', string] | ['s', string];

/**
 * What a slot holds.
 *
 * `build_id` is Drupal's `form_build_id` (32 random bytes, base64url); it prints twice on a form
 * page, raw and through `Html::getId()`, and both share one value.
 */
export type PlanSlot =
	| { kind: 'build_id'; role: 'raw' }
	/** `Html::getId('form-' + token)` with its first `head` characters dropped, being the part
	 *  the two renders did not share */
	| { kind: 'build_id'; role: 'id'; head: number }
	/**
	 * A view's per-request DOM id: `hash('sha256', $id . $time . mt_rand())`, 64 lowercase hex.
	 *
	 * `head` is how many characters the surrounding constants already carry (two hex values share a
	 * leading character one time in sixteen). Any 64 hex characters are legal, since
	 * `hook_views_pre_view()` may set it to anything.
	 */
	| { kind: 'view_dom_id'; head: number }
	/**
	 * Drupal's session CSRF token: 43 base64url characters, constant per session.
	 *
	 * Two sessions of one role set differ only in this value, which is why a shared plan could not
	 * compile an authenticated page. It cannot be generated, only substituted:
	 * {@link fillSlots} takes it from the caller and refuses without one.
	 */
	| { kind: 'csrf'; head: number }
	| { kind: 'unknown'; bytes: number };

/** what a slot cannot be generated from and must be supplied per request */
export type SlotValues = { csrf?: string };

/** the compiled plan for one path, with both samples it was compiled from */
export type RenderPlan = {
	path: string;
	ops: PlanOp[];
	slots: Record<string, PlanSlot>;
	/** what the compiler saw in each slot on the first render */
	sample: Record<string, string>;
	/** and on the second, which is what makes the substitution proof possible */
	sampleB: Record<string, string>;
};

/** one 43-character base64url token from 32 random bytes, the shape PHP's Crypt produces */
export function randomBuildToken(): string {
	const raw = crypto.getRandomValues(new Uint8Array(32));
	let bin = '';
	for (const b of raw) bin += String.fromCharCode(b);
	return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * `Html::getId()`: a build id to a DOM id. Hyphen collapsing makes it differ in length from the
 * token about half the time.
 */
export function htmlId(id: string): string {
	return id
		.toLowerCase()
		.replaceAll(' ', '-')
		.replaceAll('_', '-')
		.replaceAll('[', '-')
		.replaceAll(']', '')
		.replace(/[^a-z0-9\-_]/g, '')
		.replace(/-+/g, '-');
}

const BUILD_ID_TAIL = /form-([A-Za-z0-9_-]*)$/;

/** one 64-character lowercase hex value, the shape `hash('sha256', ...)` returns */
function randomDomId(): string {
	const raw = crypto.getRandomValues(new Uint8Array(32));
	let out = '';
	for (const b of raw) out += b.toString(16).padStart(2, '0');
	return out;
}

/** the two places Drupal core prints a view's dom id, minus the value itself */
const DOM_ID_MARKERS = ['js-view-dom-id-', 'view_dom_id":"'];

/** where core prints the session CSRF token (the logout link, on every authenticated page) */
const CSRF_MARKERS = ['user/logout?token='];

/** the fixed-width per-request values, each recognised the same way and only by its own marker */
const TOKEN_KINDS = [
	{ kind: 'view_dom_id' as const, width: 64, charset: /^[0-9a-f]*$/, markers: DOM_ID_MARKERS },
	{ kind: 'csrf' as const, width: 43, charset: /^[A-Za-z0-9_-]*$/, markers: CSRF_MARKERS }
];

/**
 * A varying region that is one of the fixed-width tokens above, or undefined.
 *
 * The diff bracket ate characters the samples shared at either end of the value, so every split
 * of the missing count is borrowed back from the constants either side. A region that fails the
 * marker check stays opaque.
 */
function recogniseToken(
	spanA: string,
	spanB: string,
	before: string,
	after: string
): { slot: PlanSlot; sample: string; sampleB: string; consumed: number } | undefined {
	if (spanA.length !== spanB.length || spanA === '' || spanA === spanB) return undefined;
	for (const { kind, width, charset, markers } of TOKEN_KINDS) {
		if (!charset.test(spanA) || !charset.test(spanB)) continue;
		const missing = width - spanA.length;
		if (missing < 0) continue;
		for (let head = missing; head >= 0; head--) {
			const consumed = missing - head;
			if (head > before.length || consumed > after.length) continue;
			const prefix = head === 0 ? '' : before.slice(before.length - head);
			const suffix = after.slice(0, consumed);
			if (!charset.test(prefix) || !charset.test(suffix)) continue;
			const marked = before.slice(0, before.length - head);
			if (!markers.some((m) => marked.endsWith(m))) continue;
			return {
				slot: { kind, head },
				sample: spanA + suffix,
				sampleB: spanB + suffix,
				consumed
			};
		}
	}
	return undefined;
}

/** one 43-character base64url run, the shape `Crypt::hmacBase64()` returns */
const CSRF_VALUE = /user\/logout\?token=([A-Za-z0-9_-]{43})/;

/**
 * The session CSRF token in one render, or undefined.
 *
 * Read from the render, not the request: a client cannot present a token, it is told its own.
 */
export function sessionCsrf(html: string): string | undefined {
	return CSRF_VALUE.exec(html)?.[1];
}

/**
 * Splits one varying span into constants and named slots, or undefined when nothing recognises it.
 *
 * The span ends with the raw token (`value="form-<token>"`), preceded by the tail of
 * `Html::getId()`; how much of the id the outer diff consumed comes from the common prefix of the
 * two ids, since hyphen collapsing makes their lengths differ. The result is checked by
 * `planExplainsBoth()` and `generatorAgrees()`.
 */
function recogniseSpan(
	spanA: string,
	spanB: string,
	tail: string
):
	| {
			pieces: Array<{ text: string } | { slot: PlanSlot; sample: string; sampleB: string }>;
			/** suffix bytes the token reclaimed; the caller must not emit them again */
			consumed: number;
	  }
	| undefined {
	// two base64url tokens share a last character about one time in 64, so the common suffix can
	// end mid-token; borrow the missing characters back from it
	const headA = BUILD_ID_TAIL.exec(spanA)?.[1];
	const headB = BUILD_ID_TAIL.exec(spanB)?.[1];
	if (headA === undefined || headB === undefined || headA.length !== headB.length) {
		return undefined;
	}
	const consumed = 43 - headA.length;
	if (consumed < 0 || consumed > tail.length) return undefined;
	if (!/^[A-Za-z0-9_-]*$/.test(tail.slice(0, consumed))) return undefined;
	const ta = headA + tail.slice(0, consumed);
	const tb = headB + tail.slice(0, consumed);
	spanA += tail.slice(0, consumed);
	spanB += tail.slice(0, consumed);
	// the same token in both renders is not a varying value at all
	if (ta === tb) return undefined;

	const idA = htmlId('form-' + ta);
	const idB = htmlId('form-' + tb);
	let head = 0;
	while (head < idA.length && head < idB.length && idA[head] === idB[head]) head++;
	if (!spanA.startsWith(idA.slice(head)) || !spanB.startsWith(idB.slice(head))) return undefined;

	const midA = spanA.slice(idA.length - head, spanA.length - ta.length);
	const midB = spanB.slice(idB.length - head, spanB.length - tb.length);
	if (midA !== midB) return undefined;

	return {
		pieces: [
			{
				slot: { kind: 'build_id', role: 'id', head },
				sample: idA.slice(head),
				sampleB: idB.slice(head)
			},
			{ text: midA },
			{ slot: { kind: 'build_id', role: 'raw' }, sample: ta, sampleB: tb }
		],
		consumed
	};
}

/** one region of the page: bytes both renders share, or bytes they do not */
type Region = { text: string } | { a: string; b: string };

/**
 * The longest line present exactly once in each render, or undefined.
 *
 * Uniqueness in both is what makes it an alignment point; a repeated `</div>` would align two
 * unrelated positions.
 */
function anchorLine(a: string, b: string, minBytes: number): string | undefined {
	const once = (s: string) => {
		const m = new Map<string, number>();
		for (const line of s.split('\n')) m.set(line, (m.get(line) ?? 0) + 1);
		return m;
	};
	const ca = once(a);
	const cb = once(b);
	let best: string | undefined;
	for (const [line, n] of ca) {
		if (n !== 1 || line.length < minBytes) continue;
		if (cb.get(line) !== 1) continue;
		if (best === undefined || line.length > best.length) best = line;
	}
	return best;
}

/**
 * Splits one varying span into alternating constant and varying regions.
 *
 * Bracketing first to last difference yields one opaque region when a page has two dynamic
 * values (a view's dom id and a form's build id). A failed split costs recognition, never
 * correctness: regions are cut at bytes both renders share, so any partition reproduces both.
 */
function splitSpan(a: string, b: string, minAnchor: number, depth: number): Region[] {
	if (a === '' && b === '') return [];
	if (a === b) return [{ text: a }];
	const min = Math.min(a.length, b.length);
	let p = 0;
	while (p < min && a[p] === b[p]) p++;
	let s = 0;
	while (s < min - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
	const pre = a.slice(0, p);
	const post = a.slice(a.length - s);
	const midA = a.slice(p, a.length - s);
	const midB = b.slice(p, b.length - s);

	const inner: Region[] =
		depth <= 0
			? [{ a: midA, b: midB }]
			: (() => {
					const anchor = anchorLine(midA, midB, minAnchor);
					if (anchor === undefined) return [{ a: midA, b: midB }];
					const ia = midA.indexOf(anchor);
					const ib = midB.indexOf(anchor);
					return [
						...splitSpan(midA.slice(0, ia), midB.slice(0, ib), minAnchor, depth - 1),
						{ text: anchor },
						...splitSpan(
							midA.slice(ia + anchor.length),
							midB.slice(ib + anchor.length),
							minAnchor,
							depth - 1
						)
					];
				})();

	const out: Region[] = [];
	if (pre !== '') out.push({ text: pre });
	out.push(...inner);
	if (post !== '') out.push({ text: post });
	return out;
}

/** adjacent constants become one, so a varying region is always followed by the whole constant */
function mergeText(regions: Region[]): Region[] {
	const out: Region[] = [];
	for (const r of regions) {
		const last = out[out.length - 1];
		if ('text' in r && last && 'text' in last)
			out[out.length - 1] = { text: last.text + r.text };
		else if (!('text' in r) && r.a === '' && r.b === '') continue;
		else out.push(r);
	}
	return out;
}

/**
 * Compiles two renders of one page into a plan.
 *
 * The span between the common prefix and suffix is split at shared lines until each region holds
 * one value; the recognisers name each region or leave it opaque (a slot with no generator).
 * `chunkBytes` splits constant runs so the op count can be swept without changing the output.
 */
export function compilePlan(a: string, b: string, path = '/', chunkBytes = 0): RenderPlan {
	const ops: PlanOp[] = [];
	const slots: Record<string, PlanSlot> = {};
	const sample: Record<string, string> = {};
	const sampleB: Record<string, string> = {};

	const push = (text: string) => {
		if (text === '') return;
		if (chunkBytes <= 0) {
			ops.push(['t', text]);
			return;
		}
		for (let i = 0; i < text.length; i += chunkBytes)
			ops.push(['t', text.slice(i, i + chunkBytes)]);
	};

	/**
	 * Takes `n` bytes back off the end of the constants already emitted.
	 *
	 * Diffing leaves the characters the two samples shared in the constant before the slot, but a
	 * generated value need not start with them; reclaiming makes the slot own the whole value.
	 */
	const reclaim = (n: number): string => {
		let want = n;
		let taken = '';
		while (want > 0 && ops.length > 0) {
			const last = ops[ops.length - 1]!;
			if (last[0] !== 't') break;
			const cut = Math.min(want, last[1].length);
			taken = last[1].slice(last[1].length - cut) + taken;
			const kept = last[1].slice(0, last[1].length - cut);
			if (kept === '') ops.pop();
			else ops[ops.length - 1] = ['t', kept];
			want -= cut;
		}
		return taken;
	};

	// 24 bytes is well past the repeated closing tags and well under any real markup line; 8 levels
	// bounds the recursion on a page whose whole body differs
	const regions = mergeText(splitSpan(a, b, 24, 8));

	let n = 0;
	for (let i = 0; i < regions.length; i++) {
		const region = regions[i]!;
		if ('text' in region) {
			push(region.text);
			continue;
		}
		// the constant in front supplies a value's shared leading characters, the one behind its
		// shared trailing ones; both recognisers borrow from their side and say how much
		const before =
			i > 0 && 'text' in regions[i - 1]! ? (regions[i - 1] as { text: string }).text : '';
		const after =
			i + 1 < regions.length && 'text' in regions[i + 1]!
				? (regions[i + 1] as { text: string }).text
				: '';

		const dom = recogniseToken(region.a, region.b, before, after);
		const found = dom ? undefined : recogniseSpan(region.a, region.b, after);
		if (dom && dom.consumed > 0) {
			regions[i + 1] = { text: after.slice(dom.consumed) };
		}
		// the token reclaimed part of the constant behind it, so it must not be emitted twice
		if (found && found.consumed > 0) {
			regions[i + 1] = { text: after.slice(found.consumed) };
		}
		const pieces = dom
			? [dom]
			: (found?.pieces ?? [
					{
						slot: { kind: 'unknown', bytes: region.a.length } as PlanSlot,
						sample: region.a,
						sampleB: region.b
					}
				]);
		for (const piece of pieces) {
			if ('text' in piece) {
				push(piece.text);
				continue;
			}
			const name = `slot${n++}`;
			let slot = piece.slot;
			let head = '';
			if (
				(slot.kind === 'build_id' && slot.role === 'id') ||
				slot.kind === 'view_dom_id' ||
				slot.kind === 'csrf'
			) {
				head = reclaim(slot.head);
				if (head.length === slot.head) slot = { ...slot, head: 0 };
				else {
					push(head);
					head = '';
				}
			}
			ops.push(['s', name]);
			slots[name] = slot;
			sample[name] = head + piece.sample;
			sampleB[name] = head + piece.sampleB;
		}
	}

	return { path, ops, slots, sample, sampleB };
}

/**
 * Produces this request's slot values, or undefined when a slot has no generator.
 *
 * Every `build_id` slot in a plan shares one token (Drupal emits one `#build_id` per form).
 */
export function fillSlots(
	plan: RenderPlan,
	supplied: SlotValues = {}
): Record<string, string> | undefined {
	const values: Record<string, string> = {};
	let token: string | undefined;
	let domId: string | undefined;
	for (const [name, slot] of Object.entries(plan.slots)) {
		if (slot.kind === 'csrf') {
			// belongs to the visitor being served and cannot be minted here, so no value means no
			// page: the caller falls through to the object rather than shipping a token that fails
			const csrf = supplied.csrf;
			if (typeof csrf !== 'string' || csrf.length !== 43) return undefined;
			values[name] = csrf.slice(slot.head);
			continue;
		}
		if (slot.kind === 'view_dom_id') {
			// one id per plan (a view prints it twice); generatorAgrees() refuses two-view pages
			domId ??= randomDomId();
			values[name] = domId.slice(slot.head);
			continue;
		}
		if (slot.kind !== 'build_id') return undefined;
		token ??= randomBuildToken();
		values[name] = slot.role === 'raw' ? token : htmlId('form-' + token).slice(slot.head);
	}
	return values;
}

/** slot names the plan cannot produce a value for */
export function unservableSlots(plan: RenderPlan): string[] {
	return Object.entries(plan.slots)
		.filter(([, slot]) => slot.kind === 'unknown')
		.map(([name]) => name);
}

/**
 * The markup either side of each unnamed slot, so a census can group refusals by what the value
 * is (a comment count, a cart total).
 */
export function unknownContext(
	plan: RenderPlan,
	span = 80
): Record<string, { before: string; after: string }> {
	const out: Record<string, { before: string; after: string }> = {};
	for (let i = 0; i < plan.ops.length; i++) {
		const op = plan.ops[i]!;
		if (op[0] !== 's' || plan.slots[op[1]]?.kind !== 'unknown') continue;
		const prev = plan.ops[i - 1];
		const next = plan.ops[i + 1];
		out[op[1]] = {
			before: prev?.[0] === 't' ? prev[1].slice(-span) : '',
			after: next?.[0] === 't' ? next[1].slice(0, span) : ''
		};
	}
	return out;
}

/** executes the plan; an unknown slot emits nothing rather than the string "undefined" */
export function runPlan(plan: RenderPlan, values: Record<string, string>): string {
	let out = '';
	for (const op of plan.ops) out += op[0] === 't' ? op[1] : (values[op[1]] ?? '');
	return out;
}

/** the plan filled with what the compiler saw has to reproduce the render it was compiled from */
export function planRoundTrips(plan: RenderPlan, original: string): boolean {
	return runPlan(plan, plan.sample) === original;
}

/**
 * The plan reproduces both renders it was compiled from (the first alone would pass a compiler
 * that emitted one constant and no slot).
 */
export function planExplainsBoth(plan: RenderPlan, a: string, b: string): boolean {
	return runPlan(plan, plan.sample) === a && runPlan(plan, plan.sampleB) === b;
}

/**
 * Checks `fillSlots()`, which the two proofs above never run (they replay recorded samples).
 *
 * The page built from generated values is re-compiled against the recorded one and must come
 * out the same shape; a generator emitting wrong bytes moves a constant and is refused.
 */
export function generatorAgrees(plan: RenderPlan): boolean {
	// csrf is substituted, so supply a token and check it lands where the compiler said
	const values = fillSlots(plan, { csrf: randomBuildToken() });
	if (!values) return false;
	// a plan with no slots has no generator to disagree with; it serves fixed bytes
	if (Object.keys(plan.slots).length === 0) return true;
	const recorded = runPlan(plan, plan.sample);
	const generated = runPlan(plan, values);
	// identical output from a fresh token means the generator is not producing one
	if (recorded === generated) return false;
	const again = compilePlan(recorded, generated, plan.path);
	return (
		unservableSlots(again).length === 0 &&
		planExplainsBoth(again, recorded, generated) &&
		Object.keys(again.slots).length === Object.keys(plan.slots).length
	);
}
