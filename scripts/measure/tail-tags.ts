/**
 * Turns a `wrangler tail --format json` capture into tagged cpuTime, with the contended samples
 * separated from the uncontended ones.
 *
 * WHY THIS AND NOT `read-tail-cpu.mjs`. That script groups a whole capture by execution model, which
 * is the right shape for "what did this worker cost". It is the wrong shape for a sweep: every
 * measured request carries a unique `&tag=`, and the join from an invocation back to what it
 * measured has to be exact.
 *
 * CONTENTION IS THE REASON THE SPLIT EXISTS. A Durable Object is single-threaded, so a request that
 * arrives while an alarm or another request is occupying the object reports the OTHER invocation's
 * wall time and its own small cpuTime. Two invocations overlap when their spans
 * `[eventTimestamp - wallTime, eventTimestamp]` intersect, and a figure that mixes the two
 * populations is not a measurement of either.
 *
 * `wrangler tail --format json` pretty-prints each event and concatenates them, so the stream is
 * neither one object nor one object per line; the split is by brace depth with string and escape
 * state tracked, the same way `read-tail-cpu.mjs` does it.
 */

import { readFile } from 'node:fs/promises';

export type TailEvent = {
	cpuTime: number;
	wallTime: number;
	eventTimestamp: number;
	executionModel: string;
	outcome: string;
	url: string;
	entrypoint: string | null;
};

/** Every complete top-level `{...}` in a concatenated, pretty-printed JSON stream. */
export function splitConcatenatedJson(text: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === '\\') escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === '{') {
			if (depth === 0) start = i;
			depth++;
		} else if (c === '}') {
			depth--;
			if (depth === 0 && start >= 0) {
				out.push(text.slice(start, i + 1));
				start = -1;
			}
		}
	}
	return out;
}

export function parseEvents(text: string): TailEvent[] {
	const out: TailEvent[] = [];
	for (const chunk of splitConcatenatedJson(text)) {
		let e: any;
		try {
			e = JSON.parse(chunk);
		} catch {
			continue;
		}
		if (typeof e?.cpuTime !== 'number') continue;
		out.push({
			cpuTime: e.cpuTime,
			wallTime: typeof e.wallTime === 'number' ? e.wallTime : 0,
			eventTimestamp: Number(e.eventTimestamp ?? 0),
			executionModel: String(e.executionModel ?? ''),
			outcome: String(e.outcome ?? ''),
			url: String(e.event?.request?.url ?? ''),
			entrypoint: e.entrypoint ?? null
		});
	}
	return out;
}

/** `?tag=` / `&tag=` off the event URL; the correlation key the drivers write. */
export function tagOf(url: string): string | null {
	const m = /[?&]tag=([^&]+)/.exec(url);
	return m ? decodeURIComponent(m[1] as string) : null;
}

export type Overlap = { event: TailEvent; overlaps: number; overlapMs: number };

/**
 * Which Durable Object an event belongs to, as the `?site=` the front Worker maps to `idFromName`.
 *
 * Contention is per OBJECT, not per worker: a Durable Object is single-threaded, two objects are
 * not. Scoping overlap by anything coarser marks every sample of a fan-out sweep contended, which
 * is the opposite of the mistake this file exists to avoid.
 */
export function objectKeyOf(url: string): string {
	const m = /[?&]site=([^&]+)/.exec(url);
	return m ? decodeURIComponent(m[1] as string) : '(no site)';
}

/**
 * How much of each event's span another invocation of the SAME execution model and SAME object was
 * also occupying.
 *
 * Only same-model events are compared: a Worker invocation and the Durable Object invocation it
 * dispatched overlap by construction and are not contending for anything, so counting them would
 * mark every DO sample contended.
 */
export function overlaps(events: TailEvent[]): Overlap[] {
	return events.map((e) => {
		const start = e.eventTimestamp - e.wallTime;
		const key = objectKeyOf(e.url);
		let count = 0;
		let ms = 0;
		for (const o of events) {
			if (o === e) continue;
			if (o.executionModel !== e.executionModel) continue;
			if (objectKeyOf(o.url) !== key) continue;
			const oStart = o.eventTimestamp - o.wallTime;
			const lo = Math.max(start, oStart);
			const hi = Math.min(e.eventTimestamp, o.eventTimestamp);
			if (hi > lo) {
				count++;
				ms += hi - lo;
			}
		}
		return { event: e, overlaps: count, overlapMs: ms };
	});
}

export function median(xs: number[]): number | null {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

async function main(): Promise<void> {
	const [file, ...rest] = process.argv.slice(2);
	if (!file) {
		console.error(
			'usage: tail-tags.ts <tail.json> [--model durableObject] [--tsv] [--url <sub>]'
		);
		process.exit(1);
	}
	const modelArg = rest.includes('--model') ? rest[rest.indexOf('--model') + 1] : 'durableObject';
	const urlSub = rest.includes('--url') ? rest[rest.indexOf('--url') + 1] : null;
	const tsv = rest.includes('--tsv');

	const all = parseEvents(await readFile(file, 'utf8'));
	const scored = overlaps(all).filter(
		(o) =>
			(modelArg === 'any' || o.event.executionModel === modelArg) &&
			(!urlSub || o.event.url.includes(urlSub))
	);

	if (tsv) {
		for (const o of scored) {
			const tag = tagOf(o.event.url);
			if (!tag) continue;
			console.log(`${tag}\t${o.event.cpuTime}`);
		}
		return;
	}

	const clean = scored.filter((o) => o.overlaps === 0);
	const contended = scored.filter((o) => o.overlaps > 0);
	const say = (label: string, rows: Overlap[]) => {
		const cpu = rows.map((r) => r.event.cpuTime);
		const wall = rows.map((r) => r.event.wallTime);
		console.log(
			`${label.padEnd(14)} n=${String(rows.length).padStart(4)}  cpu median ${median(cpu)}  ` +
				`min ${cpu.length ? Math.min(...cpu) : '-'}  max ${cpu.length ? Math.max(...cpu) : '-'}  ` +
				`wall median ${median(wall)}`
		);
	};
	say('uncontended', clean);
	say('contended', contended);
	const bad = scored.filter((o) => o.event.outcome !== 'ok');
	if (bad.length) {
		const counts = new Map<string, number>();
		for (const b of bad) counts.set(b.event.outcome, (counts.get(b.event.outcome) ?? 0) + 1);
		console.log(`non-ok outcomes: ${[...counts].map(([k, v]) => `${k}=${v}`).join(', ')}`);
	}
	const tagged = scored.filter((o) => tagOf(o.event.url) !== null);
	console.log(`tagged invocations: ${tagged.length} of ${scored.length}`);
}

if (import.meta.main) await main();
