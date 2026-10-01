import { type BackendEnv, selectBackend } from '../../db/backend';
import { backendExec } from '../../db/pg-exec';
import {
	CAPABILITY_CHECK,
	DRIVER_LIVE_SUITE,
	drupalRequest,
	MB_CHECK,
	PROBE_RUNTIME
} from '../../drupal/site-php';
import { tcpLive } from '../../drupal/tcp-php';
import { aiEnabled, aiQueueUrl, allowedModels, neuronCost } from '../../ops/ai';
import { deferredKey } from '../../ops/deferred-post';
import type { SitePhpDurableObject } from '../../site-do';
import { DIAG_EXTENSIONS_PHP, DIAG_NATIVE_FETCH_PHP } from '../../site/generated/assets';
import { errorMessage } from '../../util/errors';
import { phpRender, phpScript } from '../../util/php';
import { jsonError } from '../../util/reply';
import { firstRow } from '../../util/sql';
import type { Row } from '../types';

/** probes the Hyperdrive backend with `SELECT 1`, whether or not `DB_BACKEND` selected it */
export async function backend(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	// probed whether or not `DB_BACKEND` selected it
	const env = site.env as unknown as BackendEnv;
	const configured = selectBackend(env);
	const probe = selectBackend({
		DB_BACKEND: 'hyperdrive',
		HYPERDRIVE: env?.HYPERDRIVE
	});
	const selected = { name: configured.name, available: configured.available };
	if (!probe.available) {
		return Response.json({ ok: false, selected, why: probe.why }, { status: 503 });
	}
	const t0 = Date.now();
	try {
		const out = await backendExec(probe, 'SELECT 1 AS one');
		return Response.json({
			ok: true,
			selected,
			dialect: probe.dialect,
			rows: out.rows,
			ms: Date.now() - t0
		});
	} catch (e) {
		return Response.json(
			{ ok: false, selected, dialect: probe.dialect, error: String(e) },
			{ status: 502 }
		);
	}
}

/** reports the PHP version, loaded extensions and boot diagnostics */
export async function php(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const out = await site.runJson(phpScript(DIAG_EXTENSIONS_PHP));
	return Response.json({
		version: String(out.v ?? '').trim(),
		extensions: Array.isArray(out.e) ? out.e : [],
		bootMs: site.bootMs ?? null,
		mount: site.mountInfo ?? null,
		diag: site.bootDiag
	});
}

/** runs the runtime probe fragment and reports it with the boot time */
export async function probe(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	return Response.json({
		bootMs: site.bootMs ?? null,
		probe: await site.runJson(PROBE_RUNTIME)
	});
}

/**
 * Runs the capability plugins for the first time.
 *
 * Prefetches the check's URL before entering PHP; a synchronous `cfwFetch` can only read
 * what JS already awaited.
 */
export async function capability(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const testUrl = url.searchParams.get('url') ?? 'https://example.com/';
	site.queueHttp(testUrl);
	const drained = await site.drainHttpQueue(3);
	site.logs = [];
	site.mails = [];
	const php = await site.runJson(CAPABILITY_CHECK);
	// the logger's evidence is host-side: the entries arrived
	const marks = php?.markers ?? {};
	const sawDirect = (site.logs ?? []).some((l) =>
		String(l?.message ?? '').includes(String(marks.direct ?? '\0'))
	);
	const sawChannel = (site.logs ?? []).some((l) =>
		String(l?.message ?? '').includes(String(marks.channel ?? '\0'))
	);
	return Response.json({
		...php,
		prefetch: drained,
		hostSideEvidence: {
			logEntriesReceived: (site.logs ?? []).length,
			directLogArrived: sawDirect,
			channelLogArrived: sawChannel,
			levels: [...new Set((site.logs ?? []).map((l) => l?.level))],
			channels: [...new Set((site.logs ?? []).map((l) => l?.channel))],
			mailAttempts: site.mails ?? [],
			httpQueueRemaining: Number(
				firstRow(
					site.sql.exec<Row<{ c: number }>>('SELECT COUNT(*) AS c FROM cfw_http_queue')
				)?.c ?? 0
			)
		}
	});
}

/**
 * Destructive: reads a URL through the native https wrapper with no capability wrapper
 * registered.
 *
 * The wasm import throws `ReferenceError: Asyncify is not defined`, which neither `@` nor
 * PHP's `catch (\Throwable)` sees, so the invocation dies with the interpreter parked
 * mid-call.
 */
export async function nativefetch(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const target = url.searchParams.get('url') ?? 'https://example.com/native-probe';
	try {
		const raw = await site.run(
			phpRender(DIAG_NATIVE_FETCH_PHP, { TARGET: JSON.stringify(target) })
		);
		return Response.json({ survived: true, raw: raw.slice(0, 400) });
	} catch (e) {
		return Response.json({
			survived: false,
			jsError: errorMessage(e),
			note: 'a JS exception out of the wasm import; PHP cannot catch it and the interpreter is left parked'
		});
	}
}

/** asks, drains, asks again: one ask can only show the refusal (the tier is cached-or-deferred) */
export async function tcp(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const protocol = url.searchParams.get('protocol') === 'syslog' ? 'syslog' : 'redis';
	const args = (url.searchParams.get('args') ?? '').split(',').filter((a) => a !== '');
	const message = url.searchParams.get('message') ?? '';
	const fragment = tcpLive({ protocol, args, message });
	const first = await site.runJson(fragment);
	// drain until empty; the exchange shares `cfw_http_queue` with deferred fetches, so a fixed
	// budget can leave it queued
	const drained: Awaited<ReturnType<typeof site.drainHttpQueue>>[] = [];
	for (let i = 0; i < 8; i++) {
		const round = await site.drainHttpQueue(5);
		drained.push(round);
		if (Number(round.remaining ?? 0) === 0) break;
	}
	const second = protocol === 'redis' ? await site.runJson(fragment) : null;
	return Response.json({ first, drained, second });
}

/**
 * One queued inference, driven the way PHP drives it: queue, drain, read.
 *
 * The answer is only readable on an invocation after the one that asked. The neuron figure
 * is projected from the published rate, not metered.
 */
export async function ai(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const model = url.searchParams.get('model') ?? (allowedModels(site.env)[0] as string);
	const prompt = url.searchParams.get('prompt') ?? 'Say hello in five words.';
	const input = url.searchParams.get('text')
		? { text: [url.searchParams.get('text') as string] }
		: { prompt };
	const body = JSON.stringify(input);
	const queueUrl = aiQueueUrl(model);
	site.queueHttp(queueUrl, 'POST', body, {});
	const drained = await site.drainHttpQueue(3);
	const row = firstRow(
		site.sql.exec<Row<{ status: number; body: string }>>(
			'SELECT status, body FROM cfw_http_cache WHERE key = ?',
			deferredKey('POST', queueUrl, body, {})
		)
	);
	// rough token count (four characters per token) as the projection input
	const inputTokens = Math.ceil(body.length / 4);
	return Response.json({
		enabled: aiEnabled(site.env),
		model,
		allowed: allowedModels(site.env),
		drained,
		status: row?.status ?? null,
		answer: row?.body ?? null,
		neurons: {
			projected: neuronCost(model, inputTokens, 500) ?? null,
			basis: 'published rate x approx 4 chars/token, 500 output tokens'
		}
	});
}

/** drains what PHP deferred; the fetch runs in JS, where awaiting is legal */
export async function httpdrain(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	return Response.json(await site.drainHttpQueue(Number(url.searchParams.get('limit') ?? 5)));
}

/** the mb_* wrappers, exercised where the polyfill is real */
export async function mb(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	return Response.json(await site.runJson(MB_CHECK));
}

/**
 * Raw SQL against `ctx.storage.sql` with no PHP, so a limit found here is the platform's.
 *
 * `params` is a JSON array; `repeat` binds one value N times to probe the parameter ceiling.
 */
export async function sql(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const text = url.searchParams.get('q');
	if (!text) return jsonError('no q', 400);
	let params: unknown[] = [];
	try {
		const raw = url.searchParams.get('params');
		if (raw) params = JSON.parse(raw);
	} catch (e: any) {
		return jsonError(`bad params: ${e?.message}`, 400);
	}
	const repeat = Number(url.searchParams.get('repeat') ?? 0);
	if (Number.isFinite(repeat) && repeat > 0) {
		const fill = params.length ? params[0] : 1;
		params = new Array(repeat).fill(fill);
	}
	try {
		const cursor = site.sql.exec(text, ...params);
		const rows = cursor.toArray();
		return Response.json({
			ok: true,
			params: params.length,
			rows: rows.slice(0, 50),
			rowCount: rows.length,
			rowsRead: cursor.rowsRead,
			rowsWritten: cursor.rowsWritten
		});
	} catch (e) {
		// 400 so a status-only caller can tell a rejected statement from an empty result
		return Response.json(
			{
				ok: false,
				params: params.length,
				error: errorMessage(e)
			},
			{ status: 400 }
		);
	}
}

/** the driver's own assertions, against ctx.storage.sql rather than PDO */
export async function driver(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	return Response.json(await site.runJson(DRIVER_LIVE_SUITE));
}

/** renders a Drupal path with the Durable Object as its database and reports the cost */
export async function drupal(
	site: SitePhpDurableObject,
	request: Request,
	url: URL
): Promise<Response> {
	const before = site.queryCount;
	const t0 = Date.now();
	const php = await site.runJson(
		drupalRequest(
			url.searchParams.get('path') ?? '/',
			Number(url.searchParams.get('repeat') ?? 1),
			(url.searchParams.get('bins') ?? 'page,dynamic_page_cache')
				.split(',')
				.map((b) => b.trim())
				.filter(Boolean),
			url.searchParams.get('resetcid') !== '0'
		)
	);
	return Response.json({
		wallMs: Date.now() - t0,
		hostStatementsTotal: site.queryCount - before,
		bootMs: site.bootMs ?? null,
		php
	});
}
