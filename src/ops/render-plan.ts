/**
 * A compiled render plan and the VM that executes it outside PHP.
 *
 * A plan is a flat op list: constant bytes, and slots whose value is produced per request.
 * Executing one needs no Drupal, no interpreter and no render array.
 *
 * Slots are found by diffing two renders of the same page. A list of known-volatile markers
 * would pass on a value it has never seen; a diff fails on it.
 *
 * A slot with no generator refuses to serve. `fillSlots()` returns null and the caller answers
 * 409 rather than filling an unrecognised value with a correctly-sized random string.
 */

/** constant bytes, or a named hole */
export type PlanOp = ['t', string] | ['s', string];

/**
 * What a slot holds.
 *
 * `build_id` is Drupal's `form_build_id`, `'form-' . Crypt::randomBytesBase64()`: 32 CSPRNG
 * bytes in base64url. It appears twice on a form page, raw in the input's value and through
 * `Html::getId()` in its DOM id, so both occurrences share one value.
 */
export type PlanSlot =
	| { kind: 'build_id'; role: 'raw' }
	/** `Html::getId('form-' + token)` with its first `head` characters dropped, being the part
	 *  the two renders did not share */
	| { kind: 'build_id'; role: 'id'; head: number }
	/**
	 * A view's per-request DOM id: `hash('sha256', $id . $time . mt_rand())`, 64 lowercase hex.
	 *
	 * `head` is how many characters the surrounding constants already carry, since two hex values
	 * share a leading character one time in sixteen. Unvalidated on the way back in, and
	 * `hook_views_pre_view()` may set it to anything, so any 64 hex characters are a legal value.
	 */
	| { kind: 'view_dom_id'; head: number }
	| { kind: 'unknown'; bytes: number };

export type RenderPlan = {
	path: string;
	ops: PlanOp[];
	slots: Record<string, PlanSlot>;
	/** what the compiler saw in each slot on the first render */
	sample: Record<string, string>;
	/** and on the second, which is what makes the substitution proof possible */
	sampleB: Record<string, string>;
};

/** one 43-character base64url token from 32 CSPRNG bytes, the same shape PHP's Crypt produces */
export function randomBuildToken(): string {
	const raw = crypto.getRandomValues(new Uint8Array(32));
	let bin = '';
	for (const b of raw) bin += String.fromCharCode(b);
	return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * `Html::getId()`, which turns a build id into the element's DOM id.
 *
 * Underscores become hyphens and consecutive hyphens collapse, so the id is a different length
 * from the token about half the time.
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

/**
 * A varying region that is part of a view's dom id, or null.
 *
 * The region is not a whole id: the bracket around it ate whatever characters the two values
 * happened to share, and two random hex strings share a leading one AND a trailing one about one
 * time in sixteen each. Both borrowed pieces come back off the constants either side, so every
 * split of the missing count is tried rather than assuming it is all at the front.
 *
 * The marker check is what separates this from any other pair of differing hex runs. A region that
 * fails it stays opaque rather than being filled with a plausible value.
 */
function recogniseDomId(
	spanA: string,
	spanB: string,
	before: string,
	after: string
): { slot: PlanSlot; sample: string; sampleB: string; consumed: number } | null {
	if (spanA.length !== spanB.length || spanA === '' || spanA === spanB) return null;
	if (!/^[0-9a-f]+$/.test(spanA) || !/^[0-9a-f]+$/.test(spanB)) return null;
	const missing = 64 - spanA.length;
	if (missing < 0) return null;
	for (let head = missing; head >= 0; head--) {
		const consumed = missing - head;
		if (head > before.length || consumed > after.length) continue;
		const prefix = head === 0 ? '' : before.slice(before.length - head);
		const suffix = after.slice(0, consumed);
		if (!/^[0-9a-f]*$/.test(prefix) || !/^[0-9a-f]*$/.test(suffix)) continue;
		const marked = before.slice(0, before.length - head);
		if (!DOM_ID_MARKERS.some((m) => marked.endsWith(m))) continue;
		return {
			slot: { kind: 'view_dom_id', head },
			sample: spanA + suffix,
			sampleB: spanB + suffix,
			consumed
		};
	}
	return null;
}

/**
 * Splits one varying span into constants and named slots, or null when nothing recognises it.
 *
 * The span ends with the raw token, since `value="form-<token>"` is the last thing that varies
 * on a form page. Before it sits the tail of `Html::getId()` plus constant markup; how much of
 * the id the outer diff already consumed is derived from the common prefix of the two ids,
 * because hyphen collapsing makes them differ in length from each other and from the token.
 *
 * Whatever this returns is checked by `planExplainsBoth()` and `generatorAgrees()`.
 */
function recogniseSpan(
	spanA: string,
	spanB: string,
	tail: string
): {
	pieces: Array<{ text: string } | { slot: PlanSlot; sample: string; sampleB: string }>;
	/** bytes of the common suffix the token reclaimed, which the caller must not emit again */
	consumed: number;
} | null {
	// two base64url tokens share a last character about one time in 64, so the common suffix can
	// end mid-token; borrow the missing characters back from it
	const headA = BUILD_ID_TAIL.exec(spanA)?.[1];
	const headB = BUILD_ID_TAIL.exec(spanB)?.[1];
	if (headA === undefined || headB === undefined || headA.length !== headB.length) return null;
	const consumed = 43 - headA.length;
	if (consumed < 0 || consumed > tail.length) return null;
	if (!/^[A-Za-z0-9_-]*$/.test(tail.slice(0, consumed))) return null;
	const ta = headA + tail.slice(0, consumed);
	const tb = headB + tail.slice(0, consumed);
	spanA += tail.slice(0, consumed);
	spanB += tail.slice(0, consumed);
	// the same token in both renders is not a varying value at all
	if (ta === tb) return null;

	const idA = htmlId('form-' + ta);
	const idB = htmlId('form-' + tb);
	let head = 0;
	while (head < idA.length && head < idB.length && idA[head] === idB[head]) head++;
	if (!spanA.startsWith(idA.slice(head)) || !spanB.startsWith(idB.slice(head))) return null;

	const midA = spanA.slice(idA.length - head, spanA.length - ta.length);
	const midB = spanB.slice(idB.length - head, spanB.length - tb.length);
	if (midA !== midB) return null;

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
 * The longest line present exactly once in each render, or null.
 *
 * Uniqueness in BOTH is what makes it an alignment point. Every repeated `</div>` is a candidate
 * otherwise, and anchoring on one aligns two unrelated positions -- the census that first counted
 * varying bytes this way reported ~40 KB varying on pages that vary by 43.
 */
function anchorLine(a: string, b: string, minBytes: number): string | null {
	const once = (s: string) => {
		const m = new Map<string, number>();
		for (const line of s.split('\n')) m.set(line, (m.get(line) ?? 0) + 1);
		return m;
	};
	const ca = once(a);
	const cb = once(b);
	let best: string | null = null;
	for (const [line, n] of ca) {
		if (n !== 1 || line.length < minBytes) continue;
		if (cb.get(line) !== 1) continue;
		if (best === null || line.length > best.length) best = line;
	}
	return best;
}

/**
 * Splits one varying span into alternating constant and varying regions.
 *
 * Bracketing between the first and last difference produces ONE region, so a page with two dynamic
 * values hands the recognisers 4.6 KB of markup with a dom id at one end and a build id at the
 * other -- opaque, and every form page carrying a view has that shape.
 *
 * A failed split costs recognition, never correctness: the regions are cut at bytes both renders
 * share, so any partition still reproduces both. What a bad anchor loses is the chance for a
 * recogniser to name the piece, and the piece then stays a slot with no generator.
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
					if (anchor === null) return [{ a: midA, b: midB }];
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
 * A common prefix and suffix bracket everything that varies, and the span between them is split at
 * lines both renders share until each varying region holds one value. Each region goes to the
 * recognisers, which either name it or leave it opaque; an opaque region is a slot with no
 * generator and the plan refuses to serve.
 *
 * `chunkBytes` splits the constant runs so the op count can be swept without changing the
 * output, which is how the VM's cost is measured against a realistic op count.
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
	 * The recognisers find a value by DIFFING, so the characters the two samples happened to share
	 * sit in the constant in front of the slot rather than in the slot. A freshly generated value is
	 * under no obligation to start with them, and the page then carries an id whose first characters
	 * came from one render and whose tail came from the generator. Reclaiming them makes the slot own
	 * the whole value.
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

		const dom = recogniseDomId(region.a, region.b, before, after);
		const found = dom ? null : recogniseSpan(region.a, region.b, after);
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
			if ((slot.kind === 'build_id' && slot.role === 'id') || slot.kind === 'view_dom_id') {
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
 * Produces this request's slot values, or null when the plan holds a slot with no generator.
 *
 * Every `build_id` slot in one plan shares one token, because Drupal emits one `#build_id` per
 * form and renders it in both places.
 */
export function fillSlots(plan: RenderPlan): Record<string, string> | null {
	const values: Record<string, string> = {};
	let token: string | null = null;
	let domId: string | null = null;
	for (const [name, slot] of Object.entries(plan.slots)) {
		if (slot.kind === 'view_dom_id') {
			// ONE id for every occurrence, because Drupal computes it once per view and prints it in
			// the wrapper class and again in drupalSettings. A page carrying TWO views wants two, and
			// this would give both the same -- `generatorAgrees()` refuses that plan, because the
			// re-compile then finds one varying region where the samples held two
			domId ??= randomDomId();
			values[name] = domId.slice(slot.head);
			continue;
		}
		if (slot.kind !== 'build_id') return null;
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
 * The markup either side of each unnamed slot.
 *
 * A census over many routes gets one sample string per refusal and cannot say what the value IS.
 * `<span>4</span>` against `<span>7</span>` is a comment count or a cart total depending on what
 * precedes it, and grouping refusals by mechanism needs the mechanism, not the bytes.
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
 * The plan reproduces both renders it was compiled from.
 *
 * A round trip against the first alone passes for a compiler that emitted one constant and no
 * slot; requiring the second render back from the second render's values does not.
 */
export function planExplainsBoth(plan: RenderPlan, a: string, b: string): boolean {
	return runPlan(plan, plan.sample) === a && runPlan(plan, plan.sampleB) === b;
}

/**
 * Checks `fillSlots()`, which the two proofs above do not touch: both replay recorded samples,
 * so both pass while the generator produces bytes no render ever contained.
 *
 * Re-diffs rather than re-derives. The page built from generated values is compiled against the
 * page built from recorded ones and has to come out the same shape, so a generator emitting the
 * wrong bytes moves a constant and the re-compile refuses it.
 */
export function generatorAgrees(plan: RenderPlan): boolean {
	const values = fillSlots(plan);
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
