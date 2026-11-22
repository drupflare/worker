const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const SHAPE =
	/^(daily|(?:sun|mon|tue|wed|thu|fri|sat)(?:-(?:sun|mon|tue|wed|thu|fri|sat))?) ([01]\d|2[0-3]):([0-5]\d)-(24:00|[01]\d:[0-5]\d|2[0-3]:[0-5]\d)(?: ([A-Za-z0-9_+\-/]{1,64}))?$/;

/** a parsed `WARM_WINDOW`: the days that count, minutes since midnight and the time zone */
export type WarmWindow = { days: readonly number[]; from: number; to: number; zone: string };

const minutes = (text: string): number => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));

/**
 * Reads `<days> HH:MM-HH:MM [zone]`, for example `mon-fri 06:00-22:00 America/New_York`.
 *
 * `days` is `daily`, one day, or a range that may wrap (`fri-mon`). The window does not cross
 * midnight, so `to` is later than `from` and may be `24:00`. The zone is an IANA name and defaults
 * to UTC. Anything else answers the reason it is refused.
 */
export function parseWarmWindow(text: string): WarmWindow | string {
	const m = SHAPE.exec(text.trim());
	if (m === null) {
		return 'WARM_WINDOW must look like "mon-fri 06:00-22:00 America/New_York"; got ' + text;
	}
	const [, span, hh, mm, to, zone = 'UTC'] = m as unknown as string[];
	const from = minutes(`${hh}:${mm}`);
	const end = minutes(to as string);
	if (end <= from) return 'WARM_WINDOW must end after it starts and not cross midnight';
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: zone });
	} catch {
		return `WARM_WINDOW names a time zone that is not known: ${zone}`;
	}
	let days: number[];
	if (span === 'daily') days = [0, 1, 2, 3, 4, 5, 6];
	else {
		const [first, last = first] = (span as string).split('-') as [string, string?];
		const start = DAYS.indexOf(first as (typeof DAYS)[number]);
		const stop = DAYS.indexOf(last as (typeof DAYS)[number]);
		days = [];
		for (let d = start; ; d = (d + 1) % 7) {
			days.push(d);
			if (d === stop) break;
		}
	}
	return { days, from, to: end, zone: zone as string };
}

/** whether `nowMs` falls inside the window; undefined when no window is set or it does not parse */
export function warmWindowOpen(text: unknown, nowMs: number): boolean | undefined {
	if (typeof text !== 'string' || text.trim() === '') return undefined;
	const window = parseWarmWindow(text);
	if (typeof window === 'string') return undefined;
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: window.zone,
		weekday: 'short',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	}).formatToParts(new Date(nowMs));
	const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
	const day = DAYS.indexOf(part('weekday').toLowerCase().slice(0, 3) as (typeof DAYS)[number]);
	const now = Number(part('hour')) * 60 + Number(part('minute'));
	return window.days.includes(day) && now >= window.from && now < window.to;
}
