/** `{ ok: false, error, ...extra }` with the given status; `extra` keys follow `error`. */
export function jsonError(
	error: string,
	status: number,
	extra?: Record<string, unknown>
): Response {
	return Response.json({ ok: false, error, ...extra }, { status });
}
