/** what is recorded when a RangeError (an invalid or refused buffer length) reaches a handler */
export type RangeReport = {
	at: number;
	where: string;
	method: string | null;
	path: string | null;
	message: string;
	stack: string[];
	linear: number;
	isolate: number;
	/** boots so far that instantiated into a dropped interpreter's memory */
	reused: number;
	bootMs: number | null;
	/** the last heap growth attempts, from the glue's `__cfwGrow` record */
	grow: unknown[];
	/** the last decode failures, from the glue's `__cfwSub` record */
	sub: unknown[];
};

/** whether an error looks like a typed-array or buffer length failure */
export const isLengthError = (e: unknown): boolean =>
	e instanceof RangeError ||
	/array buffer|typed array length|invalid.*length/i.test(String((e as Error)?.message));

/** splits a stack into pieces short enough that log truncation does not eat the tail */
export function chunkStack(stack: string, size = 400): string[] {
	const out: string[] = [];
	for (let i = 0; i < stack.length && out.length < 12; i += size)
		out.push(stack.slice(i, i + size));
	return out;
}

/** the report as flat fields, one per stack piece, for a structured console line */
export function flatFields(r: RangeReport): Record<string, unknown> {
	const { stack, grow, sub, ...rest } = r;
	const fields: Record<string, unknown> = {
		...rest,
		grow: JSON.stringify(grow).slice(0, 900),
		sub: JSON.stringify(r.sub).slice(0, 900)
	};
	stack.forEach((piece, i) => (fields[`stack${i}`] = piece));
	return fields;
}
