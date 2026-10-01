import { siteStubOptions } from '../ops/site-id';

/**
 * The bindings a window needs: the namespace, plus its two optional bounds.
 * Narrower than the whole environment, so a caller that only has these can drive one.
 */
export interface FillWindowEnv {
	SITE: DurableObjectNamespace;
	WINDOW_MAX_FILLS?: string | number;
	WINDOW_WALL_MS?: string | number;
	/** carried so the window reaches the same object placement the serving path does */
	SITE_LOCATION_HINT?: string;
}

/**
 * One reply from the object, per message pumped.
 *
 * Every field but `ok` is conditional: `filled` is the path a fill produced (null when the queue
 * was empty), `booted` rides on fill replies only, and the trailing drained signal carries neither.
 */
export interface FillWindowReply {
	ok: boolean;
	filled?: string | null;
	fills?: number;
	/** an interpreter is up on the object */
	booted?: boolean;
	/** this fill paid for the boot; mostly false on a warm fill */
	bootedInFill?: boolean;
	drained?: boolean;
	closed?: boolean;
	remaining?: number;
	error?: string;
}

/** A window that ran. */
export interface FillWindowResult {
	ok: true;
	site: string;
	fills: number;
	drained: boolean;
	stopped: 'wall-budget' | 'error' | null;
	wallMs: number;
	outcomes: FillWindowReply[];
}

/** A window that never opened, so there are no outcomes to report at all. */
export interface FillWindowFailure {
	ok: false;
	error: string;
	fills: number;
}

/**
 * Drives one warm window: connect, pump one message per fill, close.
 *
 * The driver lives outside the Durable Object: the budget resets on an incoming message and an
 * object cannot send itself one. The Worker is a relay and its wall time is not charged.
 *
 * Three bounds: `maxFills` (DO requests and rows written, 100k/day each), `wallBudgetMs` (billed
 * duration; a held socket is non-hibernatable) and the platform's 15-minute connection maximum.
 *
 * @returns discriminated by `ok`; a window that could not open has no outcomes at all
 */
export async function runFillWindow(
	env: FillWindowEnv,
	site: string,
	opts: { maxFills?: number; wallBudgetMs?: number } = {}
): Promise<FillWindowResult | FillWindowFailure> {
	const maxFills = Number(opts.maxFills ?? env?.WINDOW_MAX_FILLS ?? 50);
	const wallBudgetMs = Number(opts.wallBudgetMs ?? env?.WINDOW_WALL_MS ?? 60_000);
	const startedAt = Date.now();

	const stub = env.SITE.get(env.SITE.idFromName(site), siteStubOptions(env));
	const res = await stub.fetch('https://do.local/__fillsocket', {
		headers: { Upgrade: 'websocket' }
	});
	const ws = res.webSocket;
	if (!ws) {
		return { ok: false, error: `no socket: ${res.status}`, fills: 0 };
	}
	ws.accept();

	const outcomes: FillWindowReply[] = [];
	let drained = false;
	let stopped: FillWindowResult['stopped'] = null;

	try {
		for (let i = 0; i < maxFills; i++) {
			if (Date.now() - startedAt >= wallBudgetMs) {
				stopped = 'wall-budget';
				break;
			}
			const reply = await new Promise<FillWindowReply>((resolve, reject) => {
				const onMessage = (e: MessageEvent) => {
					cleanup();
					try {
						resolve(JSON.parse(String(e.data ?? '{}')));
					} catch (err) {
						reject(err);
					}
				};
				const onClose = () => {
					cleanup();
					resolve({ ok: true, drained: true, closed: true });
				};
				// `ws!` because the `if (!ws)` return above is what proves it; a hoisted function
				// declaration does not carry that narrowing in
				function cleanup() {
					ws!.removeEventListener('message', onMessage);
					ws!.removeEventListener('close', onClose);
				}
				ws.addEventListener('message', onMessage);
				ws.addEventListener('close', onClose);
				ws.send(JSON.stringify({ op: 'fill' }));
			});

			outcomes.push(reply);
			if (reply.drained || reply.closed || reply.filled === null) {
				drained = true;
				break;
			}
			if (reply.ok === false) {
				stopped = 'error';
				break;
			}
		}
	} finally {
		try {
			ws.send(JSON.stringify({ op: 'close' }));
			ws.close(1000, 'done');
		} catch {
			// already closed by the object
		}
	}

	return {
		ok: true,
		site,
		fills: outcomes.filter((o) => o.ok && o.filled).length,
		drained,
		stopped,
		wallMs: Date.now() - startedAt,
		outcomes
	};
}
