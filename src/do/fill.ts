import { getFile, putFile } from '../db/file-store';
import { drupalOp, renderPage, type RenderRequest } from '../drupal/site-php';
import { substituteAggregates } from '../ops/aggregates';
import { crossingsSince, emptyCrossings, snapshotCrossings } from '../ops/crossings';
import { isIdempotent } from '../ops/deferred-post';
import { tagChecksum } from '../ops/fragment-index';
import { parseTransformPath } from '../ops/image-transform';
import { queuePageMirror } from '../ops/page-mirror';
import {
	derivativeUri,
	type DeriveTransport,
	eagerDerivativesEnabled,
	laneTransport
} from '../ops/render-lane';
import { recordArrival } from '../ops/thermal';
import type { SitePhpDurableObject } from '../site-do';
import { errorMessage } from '../util/errors';
import { firstRow } from '../util/sql';
import { pageTagList, passThroughHeaders } from './helpers';
import { httpDrainEnabled } from './levers';
import { FILL_BINS } from './limits';
import type { FillOutcome, Payload, Row } from './types';

/**
 * Counts a failure against the queue head when the fill threw rather than reported.
 *
 * A throw skips `fillOne()`'s three-strikes rule and the alarm re-arms in 1 ms (a spin).
 *
 * @returns the attempts now recorded, or undefined when the queue was empty
 */
export function strikeFillHead(site: SitePhpDurableObject, error: string): number | undefined {
	site.ensureServeTables();
	const head = firstRow(
		site.sql.exec<Row<{ path: string; attempts: number }>>(
			'SELECT path, attempts FROM cfw_fill_queue ORDER BY priority, queued_at LIMIT 1'
		)
	);
	if (!head) return undefined;
	const attempts = Number(head.attempts ?? 0) + 1;
	if (attempts >= 3) {
		site.sql.exec('DELETE FROM cfw_fill_queue WHERE path = ?', String(head.path));
	} else {
		site.sql.exec(
			'UPDATE cfw_fill_queue SET attempts = ?, last_error = ? WHERE path = ?',
			attempts,
			error.slice(0, 400),
			String(head.path)
		);
	}
	return attempts;
}

/**
 * Fills one path: from the alarm chain, or inline for the visitor who missed.
 *
 * @param targetPath renders this instead of the FIFO queue head (the inline miss needs it)
 * @param bins passed to renderPage(); the default empties both, `['page']` reassembles
 * @param destruct false reproduces the pre-fix lifecycle; see renderPage()
 */
export async function fillOne(
	site: SitePhpDurableObject,
	targetPath?: string,
	bins: string[] = FILL_BINS,
	destruct: boolean | string = false,
	// the inbound method and body, so a form submission reaches Drupal as one (absent means GET)
	request: RenderRequest = {}
): Promise<FillOutcome> {
	site.ensureServeTables();
	const startedAt = Date.now();
	// whether this fill also boots the interpreter (a boot-inclusive time must not become the warm
	// estimate)
	const bootedBeforeFill = site.php !== undefined;
	let path: string;
	let attempts: number;
	if (targetPath === undefined) {
		const next = firstRow(
			site.sql.exec<Row<{ path: string; attempts: number }>>(
				'SELECT path, attempts FROM cfw_fill_queue ORDER BY priority, queued_at LIMIT 1'
			)
		);
		if (!next) return { filled: null, remaining: 0 };
		path = String(next.path);
		attempts = Number(next.attempts ?? 0);
	} else {
		path = String(targetPath);
		attempts = Number(
			firstRow(
				site.sql.exec<Row<{ attempts: number }>>(
					'SELECT attempts FROM cfw_fill_queue WHERE path = ?',
					path
				)
			)?.attempts ?? 0
		);
	}
	// default here: the alarm chain has no request to read an origin from, and a `localhost` copy
	// would differ from an inline one
	const origin = request.origin ?? site.canonicalOrigin();
	// bracket the render so boot crossings are not charged to it
	const crossingsBefore = site.crossings ? snapshotCrossings(site.crossings) : emptyCrossings();
	site.deferredInRender = 0;
	// a render is the arrival a warm object would have saved 1,398 ms on
	site.arrivals = recordArrival(site.arrivals ?? [], { at: site.nowMs(), rendered: true });
	// the counter survives a hibernation (the ring alone does not)
	site.rendersSinceFlush = (site.rendersSinceFlush ?? 0) + 1;
	site.countActivity('renders');
	const attempt = site.pendingAttempt;
	site.pendingAttempt = undefined;
	// before the render's first statement, so none of its writes can be durable without it
	if (attempt) site.markAttempt(attempt);
	let result = await site.runJsonMaybeParked(
		renderPage(path, bins, destruct, { ...request, origin })
	);
	// the render met a URL the fetch cache lacked; drain and render once more (idempotent requests
	// only, a replayed POST changes the outcome)
	const deferred = site.deferredInRender ?? 0;
	if (deferred > 0 && isIdempotent(request.method ?? 'GET') && httpDrainEnabled(site.env)) {
		try {
			const drained = await site.drainHttpQueue(Math.min(deferred, 6));
			const landed = (drained?.drained ?? []).some(
				(d) => typeof d === 'object' && 'status' in d
			);
			if (landed) {
				site.deferredInRender = 0;
				site.countActivity('renders');
				result = await site.runJson(
					renderPage(path, bins, destruct, { ...request, origin })
				);
				site.lastRedrive = {
					path,
					deferred,
					drained: drained?.drained?.length ?? 0,
					deferredAgain: site.deferredInRender ?? 0,
					at: site.nowMs(),
					seq: (site.lastRedrive?.seq ?? 0) + 1
				};
			}
		} catch {
			// a re-drive that fails leaves the first render's answer, which is what would have
			// been returned anyway
		}
	}
	if (site.crossings) {
		site.lastRenderCrossings = crossingsSince(crossingsBefore, site.crossings);
	}
	// the clock is frozen across synchronous PHP, so a 0 delta means unmeasurable, not free
	const observedMs = Date.now() - startedAt;
	// a non-zero delta can be I/O time alone (117 ms for a 1,398 ms cold fill); keep it as the warm
	// estimate only if PHP was already up
	if (observedMs > 0 && bootedBeforeFill) {
		site.lastRenderMs = observedMs;
	} else if (observedMs <= 0) {
		site.renderClockUnmeasurable = true;
	} else {
		// booted during this fill: the number is real wall time but measures the wrong thing
		site.renderClockUnmeasurable = true;
		site.lastBootInclusiveMs = observedMs;
	}

	// an installer redirect means the database is not ready; retry rather than store it
	// read before the aggregate substitution rewrites it, so the saving is measured
	const html0 = typeof result.html === 'string' ? result.html.length : 0;
	site.lastRenderBytes = html0;
	const installerRedirect = String(result.location ?? '').includes('/core/install.php');
	if (result.error || typeof result.html !== 'string' || installerRedirect) {
		const error = installerRedirect
			? 'the site is not installed yet; Drupal redirected to the installer'
			: String(result.error ?? 'render produced no html').slice(0, 400);
		// three strikes, then drop it, so one poisoned path cannot own the alarm
		if (attempts + 1 >= 3) {
			site.sql.exec('DELETE FROM cfw_fill_queue WHERE path = ?', path);
		} else {
			site.sql.exec(
				'UPDATE cfw_fill_queue SET attempts = ?, last_error = ? WHERE path = ?',
				attempts + 1,
				error,
				path
			);
		}
		return {
			filled: null,
			failed: path,
			error,
			// where it threw and what PHP printed instead of its result; logged, never answered,
			// since both hold paths
			...(typeof result.at === 'string' ||
			(typeof result.raw === 'string' && result.raw !== '')
				? { raw: [result.at, result.raw].filter(Boolean).join(' ').slice(0, 600) }
				: {}),
			// an uninstalled site is not a render fault; the serve path answers 503, not 500
			...(installerRedirect ? { notReady: true } : {}),
			attempts: attempts + 1,
			remaining: site.queueDepth()
		};
	}

	// `cfw_page` is keyed by path alone: store no POST, cookie, set-cookie, 5xx or 3xx (no
	// `location` column)
	// `uid` is the render's own answer to who it was for; a cookie check alone missed uid 1
	const setCookie = Array.isArray(result.setCookie) ? (result.setCookie as string[]) : [];
	const status = Number(result.status ?? 200);
	const renderedFor = result.uid === null || result.uid === undefined ? 0 : Number(result.uid);
	const roles = Array.isArray(result.roles)
		? (result.roles as unknown[]).map((r) => String(r)).sort()
		: undefined;
	// an active session is a warming signal the anonymous rate estimate cannot see (uid from
	// Drupal, not the cookie)
	if (renderedFor > 0) site.lastAuthenticatedAt = site.nowMs();
	// honour what Drupal asked for (`page_cache_kill_switch` and other opt-outs)
	const refused = /(^|,)\s*(no-store|private)\s*(,|$)/i.test(String(result.cacheControl ?? ''));
	const cacheable =
		(request.method ?? 'GET').toUpperCase() === 'GET' &&
		!request.cookie &&
		setCookie.length === 0 &&
		renderedFor === 0 &&
		!refused &&
		status < 500 &&
		!(status >= 300 && status < 400);
	// aggregates applied at store time, so the saving lands in the row (needs `ASSET_AGGREGATES=1`
	// and `bun run assets:agg`)
	if (cacheable && typeof result.html === 'string' && site.env?.ASSET_AGGREGATES === '1') {
		const index = await site.aggregateIndex();
		if (index !== undefined) {
			const out = substituteAggregates(result.html, index);
			if (out.replaced.length > 0) {
				result.html = out.html;
				site.lastAggregation = {
					path,
					libraries: out.replaced.length,
					tagsRemoved: out.tagsRemoved,
					bytesSaved: out.tagsRemoved > 0 ? html0 - out.html.length : 0
				};
			}
		}
	}

	// never elided for an unchanged body: a stale `rendered_at` would age the page out and
	// re-render it every alarm
	if (cacheable) {
		const pageTags = Array.isArray(result.cacheTags)
			? result.cacheTags.map((t) => String(t))
			: [];
		site.sql.exec(
			`INSERT INTO cfw_page (path, status, content_type, html, rendered_at, render_ms, tags, tag_checksum)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         status = excluded.status,
         content_type = excluded.content_type,
         html = excluded.html,
         rendered_at = excluded.rendered_at,
         render_ms = excluded.render_ms,
         tags = excluded.tags,
         tag_checksum = excluded.tag_checksum,
         stale_at = NULL`,
			path,
			status,
			String(result.contentType ?? 'text/html; charset=utf-8'),
			result.html,
			site.nowMs(),
			Number(result.renderMs ?? 0),
			// same statement, not a second update (a separate write cost a row per fill, 9 to 10)
			pageTagList(pageTags),
			// null for no tags: a zero sum would read as never stale
			pageTags.length === 0 ? null : tagChecksum(site.sql, pageTags)
		);
	}
	// record unstorable paths, or the serve path re-queues the same page on every request
	site.noteStorable(path, cacheable, refused, renderedFor === 0);
	site.sql.exec('DELETE FROM cfw_fill_queue WHERE path = ?', path);
	// something is cacheable again, so the next tag invalidation has work to do
	site.bumpCoalesced = false;

	// queue on fill, not request, and only for a stored page (the drain re-reads `cfw_page`)
	// gated on a public origin: a mirror only helps a hostname not routed to the Worker, and costs
	// a row per fill
	if (cacheable && site.mirrorBucket() && site.publicFilesOrigin() !== '') {
		queuePageMirror(site.sql, path, site.generation(), site.nowMs());
	}

	return {
		filled: path,
		bytes: result.bytes,
		renderMs: result.renderMs,
		pageCache: result.pageCache,
		dynamicCache: result.dynamicCache,
		roles,
		// what this fill paid for, not what the caller predicted
		bootedInFill: !bootedBeforeFill,
		remaining: site.queueDepth(),
		...(cacheable
			? {}
			: {
					page: {
						status,
						contentType: String(result.contentType ?? 'text/html; charset=utf-8'),
						html: result.html,
						renderMs: Number(result.renderMs ?? 0),
						setCookie,
						location: result.location == null ? undefined : String(result.location),
						// only on the uncacheable branch, where every ajax response lands
						passHeaders: passThroughHeaders(result.passHeaders)
					}
				})
	};
}

/**
 * Opens a warm window: one boot, then one fill per WebSocket message (each message resets the CPU
 * budget).
 *
 * Uses `server.accept()`, never `ctx.acceptWebSocket()`: hibernation would discard the interpreter.
 * A non-hibernatable object bills duration, so the window is scoped to one drain.
 */
export async function openFillWindow(site: SitePhpDurableObject): Promise<Response> {
	const pair = new WebSocketPair();
	// a pair is exactly two sockets, which is what `Object.values` cannot say on its own
	const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
	server.accept();

	site.windowFills = 0;

	// `void (async ...)()` avoids workerd's "event handler returned a promise" warning (the body
	// answers on the socket)
	server.addEventListener('message', (event) => {
		void (async () => {
			// one fill per message (each has its own CPU budget; batching would spend one on many)
			let payload: Payload;
			try {
				payload = JSON.parse(String(event.data ?? '{}'));
			} catch {
				payload = {};
			}

			if (payload.op === 'close') {
				server.close(1000, 'drained');
				return;
			}

			try {
				const hold = site.backgroundHold();
				if (hold !== undefined) {
					server.send(JSON.stringify({ ok: true, drained: true, held: hold }));
					return;
				}
				const outcome = await site.gate.run(() => site.fillOne(), 'window');
				site.windowFills = (site.windowFills ?? 0) + 1;
				server.send(
					JSON.stringify({
						ok: true,
						fills: site.windowFills,
						booted: !!site.php,
						...outcome
					})
				);
				// nothing left to do; tell the driver rather than making it guess
				if (outcome?.filled === null || (outcome?.remaining ?? 0) === 0) {
					server.send(
						JSON.stringify({ ok: true, drained: true, fills: site.windowFills })
					);
				}
			} catch (e) {
				server.send(JSON.stringify({ ok: false, error: errorMessage(e) }));
			}
		})();
	});

	return new Response(null, { status: 101, webSocket: client });
}

/**
 * Renders every style of one queued upload on the rendering lanes and stores the results.
 *
 * Style URLs come from Drupal, so each derivative matches the identity the page emits; a style the
 * delivery path cannot express is skipped.
 */
export async function deriveStep(
	site: SitePhpDurableObject,
	transport?: DeriveTransport
): Promise<void> {
	if (!eagerDerivativesEnabled(site.env as never) || !site.hasTable('cfw_derive_queue')) return;
	const row = firstRow(
		site.sql.exec('SELECT uri FROM cfw_derive_queue ORDER BY queued_at LIMIT 1')
	) as { uri?: string } | undefined;
	if (row?.uri === undefined) return;
	const uri = String(row.uri);
	site.sql.exec('DELETE FROM cfw_derive_queue WHERE uri = ?', uri);
	const source = getFile(site.sql, uri);
	if (source === undefined) {
		site.lastDerive = { uri, skipped: 'the file is gone' };
		return;
	}
	const listed = (await site.runJson(
		drupalOp(`$out['urls'] = [];
foreach (\\Drupal\\image\\Entity\\ImageStyle::loadMultiple() as $style) {
  $out['urls'][] = $style->buildUrl(json_decode(${JSON.stringify(JSON.stringify(uri))}));
}`)
	)) as { urls?: unknown[]; error?: string };
	const styles = (Array.isArray(listed.urls) ? listed.urls : [])
		.map((u) => {
			const parsed = new URL(String(u), 'https://derive.local');
			return parseTransformPath(parsed.pathname, parsed.search);
		})
		.filter((p): p is NonNullable<typeof p> => p !== null && p.uri === uri);
	if (styles.length === 0) {
		site.lastDerive = { uri, styles: 0, error: listed.error ?? null };
		return;
	}
	const t0 = Date.now();
	const rendered = await (
		transport ?? laneTransport(site.env.RENDER_LANES as DurableObjectNamespace)
	)(
		source,
		styles.map((s) => s.transform)
	);
	styles.forEach((style, i) => {
		const bytes = rendered.bytes[i];
		if (!bytes) return;
		const format = style.transform.format ?? 'webp';
		putFile(site.sql, derivativeUri(style.id), bytes, {
			nowMs: site.nowMs(),
			mime: `image/${format === 'jpg' ? 'jpeg' : format}`
		});
	});
	site.lastDerive = {
		uri,
		styles: styles.length,
		ms: Date.now() - t0,
		requests: rendered.requests,
		lanes: rendered.lanes
	};
}
