import { decode, encode } from '@drupflare/durabledb/codec';
import {
	base64ToBytes,
	bytesToBase64,
	deleteFile,
	getFile,
	getFileChunk,
	listFiles,
	putFile,
	renameFile,
	statFile
} from '../db/file-store';
import { requestHeaders } from '../ops/deferred-post';
import { engineFeatures } from '../ops/image-runtime';
import {
	imageEngine,
	imagesDeliveryUrl,
	type ImageUrlRequest,
	readImageRequest,
	supportedExtensions,
	transformIsLarge,
	transformPath
} from '../ops/image-transform';
import { phpLogCeiling, phpLogPasses } from '../ops/log-level';
import {
	mailDrainEnabled,
	mailEnvFromSite,
	queueMail,
	resolveMailTransport,
	senderFor
} from '../ops/mail';
import { senderDomainVerdict } from '../ops/mail-onboard';
import { activeRevision, listRevisions } from '../ops/module-rev';
import { type ClaimsTicket, ticketRedeemable } from '../ops/oidc';
import {
	canWriteKv,
	KV_OVERRIDABLE,
	LEVER_DOMAINS,
	leverRefusal,
	type PlanKv,
	resetSettingsMemo,
	writeSettings
} from '../ops/plan';
import { recordFinding, type Rung, type Severity, SEVERITY } from '../ops/supervisor';
import {
	REDIS_REFUSED_COMMANDS,
	resolveTcpEndpoint,
	TCP_PROTOCOLS,
	tcpCachedReply,
	tcpMethod,
	type TcpProtocol,
	tcpQueueUrl
} from '../ops/tcp';
import type { SitePhpDurableObject } from '../site-do';
import { errorMessage } from '../util/errors';
import { trimMails } from './helpers';
import { MAIL_SENDING_DOMAIN_KEY, OIDC_TICKET_KEY, SITE_SMTP_KEY } from './keys';
import type { Payload, SiteBinary } from './types';

/**
 * The host half of the `drupflare` module, packed from `../drupflare` into `assets/driver.json`.
 *
 * Every capability is synchronous: `Host::call()` reads the reply immediately and PHP cannot
 * await. Network work is therefore split: `cfwQueueFetch` records a request, `cfwHttpCacheGet` and
 * `cfwFetch` answer from what a previous drain fetched, and `drainHttpQueue()` does the real
 * `fetch()` between PHP runs. A miss is reported as a miss.
 */
export function installCapabilities(site: SitePhpDurableObject, binary: SiteBinary): SiteBinary {
	const reply = (obj: unknown) => JSON.stringify(encode(obj));
	const parse = (json: string): Payload => {
		try {
			return (decode(JSON.parse(json)) as Payload) ?? {};
		} catch {
			return {};
		}
	};

	/** structured log out of the isolate, plus a ring buffer so tests can assert */
	binary.cfwLog = (json: string) => {
		const entry = parse(json);
		site.logs = site.logs ?? [];
		site.logs.push(entry);
		if (site.logs.length > 100) site.logs.shift();
		// the console mirror outlives the isolate; the ring is ungated because `/health` reads it
		if (phpLogPasses(entry, phpLogCeiling(site.env?.PHP_LOG_LEVEL))) {
			console.log(JSON.stringify({ cfw: 'php', ...entry }));
		}
		return reply({ ok: true });
	};

	/**
	 * The host end of the PHP health ledger (`HealthLedger::record()` drops findings without it).
	 * PHP sends the severity ordinal and the host keys `SEVERITY` by name; an unknown ordinal
	 * reads as `error` rather than being dropped.
	 */
	binary.cfwHealth = (json: string) => {
		const f = parse(json);
		const ordinal = Number(f.severity ?? SEVERITY.error);
		const severity =
			(Object.keys(SEVERITY) as Severity[]).find((k) => SEVERITY[k] === ordinal) ?? 'error';
		const code = String(f.code ?? '').trim();
		if (code === '') return reply({ ok: false, error: 'a finding needs a code' });
		site.ensureServeTables();
		recordFinding(
			site.sql,
			{
				code,
				severity,
				scope: String(f.scope ?? ''),
				context: String(f.context ?? '')
			},
			site.nowMs(),
			// the ladder rung, if PHP acted before reporting
			(String(f.action ?? '') || '') as Rung | '',
			String(f.outcome ?? ''),
			Number(f.attempt ?? 0) || 0
		);
		return reply({ ok: true });
	};

	// keyed `method + url + body`: two reCAPTCHA POSTs to one endpoint differ only in the body
	binary.cfwHttpCacheGet = (json: string) => {
		const req = parse(json);
		const row = site.httpCacheGet(
			String(req.url ?? ''),
			String(req.method ?? 'GET'),
			String(req.body ?? ''),
			requestHeaders(req)
		);
		return reply(
			row === undefined
				? { ok: false, error: 'not cached' }
				: { ok: true, status: row.status, headers: row.headers, body: row.body }
		);
	};

	// the stream wrapper's entry point; same cache, different caller
	binary.cfwFetch = (json: string) => {
		const req = parse(json);
		const url = String(req.url ?? '');
		const method = String(req.method ?? 'GET');
		const body = String(req.body ?? '');
		const headers = requestHeaders(req);
		const row = site.httpCacheGet(url, method, body, headers, { allowStale: true });
		if (row !== undefined) {
			// a stale answer queues its own refresh so the next caller gets a fresh one
			if (row.stale) site.queueHttp(url, method, body, headers);
			return reply({
				ok: true,
				status: row.status,
				headers: row.headers,
				body: row.body,
				stale: row.stale
			});
		}
		// queued so the next read succeeds; counted so the caller can drain and re-run instead of
		// answering a page built from the exception
		site.queueHttp(url, method, body, headers);
		site.deferredInRender = (site.deferredInRender ?? 0) + 1;
		return reply({
			ok: false,
			error: `${url} is not in the fetch cache; queued for the next drain. A Worker cannot fetch synchronously without JSPI, so this capability is cached-or-deferred by construction.`,
			queued: true
		});
	};

	// keep the body: a dropped one sends an empty POST (reCAPTCHA siteverify answers invalid-input)
	binary.cfwQueueFetch = (json: string) => {
		const req = parse(json);
		const url = String(req.url ?? '');
		if (url === '') return reply({ ok: false, error: 'no url' });
		site.queueHttp(
			url,
			String(req.method ?? 'GET'),
			String(req.body ?? ''),
			requestHeaders(req)
		);
		return reply({ ok: true, queued: url });
	};

	/**
	 * Redeems a claims ticket once. The awaiting happened at the callback route, so PHP gets a
	 * decided result. The row is deleted before the claims return, since a ticket rides in a
	 * redirect and lands in history and proxy logs.
	 */
	binary.cfwOidcClaims = (json: string) => {
		const req = parse(json);
		let stored: ClaimsTicket | null = null;
		try {
			stored = JSON.parse(site.metaGet(OIDC_TICKET_KEY) || 'null') as ClaimsTicket | null;
		} catch {
			stored = null;
		}
		// delete first so a later throw cannot leave a redeemable ticket
		site.metaSet(OIDC_TICKET_KEY, '');

		const verdict = ticketRedeemable(stored, String(req.ticket ?? ''), site.nowMs());
		if ('refusal' in verdict) return reply({ ok: false, error: verdict.refusal });
		return reply({
			ok: true,
			sub: stored!.sub,
			issuer: stored!.issuer,
			email: stored!.email,
			name: stored!.name
		});
	};

	/**
	 * What code has been delivered to this site, for the Modules tab. Read only on purpose:
	 * delivering code is an owner action on the front worker, and a Drupal administrator is not
	 * the Worker's operator.
	 */
	binary.cfwModules = (json: string) => {
		void json;
		if (!site.hasTable('cfw_module_rev')) return reply({ ok: true, packages: [] });
		const names = site.sql
			.exec(`SELECT DISTINCT package FROM cfw_module_rev ORDER BY package`)
			.toArray() as { package?: unknown }[];
		const packages = names.map((row) => {
			const pkg = String(row.package ?? '');
			const revisions = listRevisions(site.sql, pkg, 200);
			const active = activeRevision(site.sql, pkg);
			return {
				name: pkg,
				source: active?.kind ?? revisions[0]?.kind ?? '',
				revisions: revisions.length,
				active: active?.rev ?? ''
			};
		});
		return reply({ ok: true, packages });
	};

	/**
	 * The runtime levers, read and written from Drupal's admin UI. `get` answers from
	 * {@link adoptSettings}'s resolved env and reports each value's source. `set` cannot await a KV
	 * write: it validates in full, reports accepted and refused names, and writes under `waitUntil`
	 * (a failed put leaves the previous value in force). The allow-list is enforced here as well as
	 * in `writeSettings()`; `PLAN` stays on the owner-token `/settings` route.
	 */
	binary.cfwSettings = (json: string) => {
		const req = parse(json);
		const kv = (site.env as { CONFIG_KV?: PlanKv } | undefined)?.CONFIG_KV;
		if (!kv) return reply({ ok: false, error: 'no CONFIG_KV binding on this deployment' });

		const env = site.env as unknown as Record<string, string>;
		const levers = KV_OVERRIDABLE.map((name) => ({
			name,
			value: env[name] ?? null,
			source: site.kvLeverNames?.has(name) ? 'kv' : name in env ? 'var' : 'default',
			domain: LEVER_DOMAINS[name]
		}));
		if (String(req.action ?? 'get') === 'get') {
			return reply({ ok: true, levers, writable: canWriteKv(kv) });
		}

		if (!canWriteKv(kv))
			return reply({ ok: false, error: 'this CONFIG_KV binding is read-only' });
		const patch = req.patch;
		if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
			return reply({ ok: false, error: 'patch must be an object' });
		}
		const allowed = new Set<string>(KV_OVERRIDABLE);
		const accepted: Record<string, unknown> = {};
		const refused: string[] = [];
		const invalid: { name: string; reason: string }[] = [];
		for (const [name, value] of Object.entries(patch as Record<string, unknown>)) {
			// `PLAN` is not on `KV_OVERRIDABLE`, so this refuses it at every spelling
			if (!allowed.has(name)) {
				refused.push(name);
				continue;
			}
			// validated here too: the unawaited write's verdict never reaches the form
			const reason = leverRefusal(name as (typeof KV_OVERRIDABLE)[number], value);
			if (reason === undefined) accepted[name] = value;
			else invalid.push({ name, reason });
		}
		if (Object.keys(accepted).length > 0) {
			site.ctx.waitUntil(
				// scoped to this site; a deployment-wide write would reach every site
				writeSettings(kv, accepted, site.siteName())
					.then(() => {
						// else this object serves a stale copy for the memo window
						resetSettingsMemo();
					})
					.catch(() => {})
			);
		}
		return reply({ ok: true, accepted: Object.keys(accepted), refused, invalid });
	};

	/**
	 * The TCP tier: one declared exchange, run between invocations. PHP names a protocol and an
	 * operation; the endpoint and credentials come from the operator's env, so module code cannot
	 * target an arbitrary `host:port`. `redis` is cached-or-deferred like `cfwFetch`; `syslog` has
	 * no reply, so it queues and answers at once.
	 */
	binary.cfwTcp = (json: string) => {
		const req = parse(json);
		const protocol = String(req.protocol ?? '');
		if (!(TCP_PROTOCOLS as readonly string[]).includes(protocol)) {
			return reply({
				ok: false,
				error: `unknown TCP protocol ${protocol || '(none)'}; this host speaks ${TCP_PROTOCOLS.join(', ')}`
			});
		}
		const resolved = resolveTcpEndpoint(site.env ?? {}, protocol as TcpProtocol);
		if ('refusal' in resolved) return reply({ ok: false, error: resolved.refusal });

		const url = tcpQueueUrl(resolved.endpoint);
		if (protocol === 'syslog') {
			site.queueHttp(url, 'POST', JSON.stringify(req.record ?? {}), {});
			return reply({ ok: true, queued: url });
		}

		const args = Array.isArray(req.args) ? (req.args as unknown[]) : [];
		if (args.length === 0) return reply({ ok: false, error: 'a redis call needs args' });
		const command = String(args[0]).toUpperCase();
		if (REDIS_REFUSED_COMMANDS.has(command)) {
			return reply({
				ok: false,
				error: `${command} is not reachable from module code; it would change or erase state outside this site`
			});
		}
		const body = JSON.stringify(args);
		const method = tcpMethod('redis', command);
		const row = site.httpCacheGet(url, method, body, {});
		if (row !== undefined) {
			// a non-200 body is the server's own sentence and must arrive as `error`
			// (`runRedis()` answers an error reply with 502; `CfwTcp::redis()` reads `error`)
			return reply(tcpCachedReply(row.status, row.body));
		}
		site.queueHttp(url, method, body, {});
		return reply({
			ok: false,
			error: `${command} is not in the exchange cache; queued for the next drain. PHP cannot await, so this tier is cached-or-deferred by construction.`,
			queued: true
		});
	};

	/**
	 * Resolves a transport and commits the message; the send happens on the alarm. `ok: true`
	 * means a transport resolved and the row is durably committed (an SMTP 250), no more: PHP
	 * cannot await the network. A refusal names what is missing and `CfwMail` logs it.
	 */
	binary.cfwMail = (json: string) => {
		const msg = parse(json);
		site.mails = site.mails ?? [];
		const bytes = String(msg.text ?? '').length;
		const refuse = (refusal: string) => {
			site.mails!.push({
				to: msg.to,
				subject: msg.subject,
				bytes,
				transport: null,
				refusal
			});
			trimMails(site.mails!);
			return reply({ ok: false, error: refusal });
		};

		const message = {
			to: String(msg.to ?? ''),
			from: String(msg.from ?? ''),
			replyTo: String(msg.replyTo ?? ''),
			subject: String(msg.subject ?? ''),
			text: String(msg.text ?? ''),
			html: msg.html === undefined || msg.html === null ? null : String(msg.html),
			headers: (msg.headers ?? {}) as Record<string, string>
		};

		// `drupal/smtp` socket never runs here; persist its relay so the alarm resolves the same
		const fromSite = mailEnvFromSite(msg.smtp);
		if (Object.keys(fromSite).length > 0) {
			site.metaSet(SITE_SMTP_KEY, JSON.stringify(fromSite));
		}

		const plan = resolveMailTransport(site.mailEnv());
		if ('refusal' in plan) return refuse(plan.refusal);

		// check the from domain against the onboarded one; an SMTP relay decides its own sender
		if (plan.transport.kind !== 'smtp') {
			const verdict = senderDomainVerdict(
				senderFor(plan.transport, message),
				site.metaGet(MAIL_SENDING_DOMAIN_KEY) ?? ''
			);
			if (!verdict.ok) return refuse(verdict.reason);
		}

		const queued = queueMail(site.sql, message, plan.transport, site.nowMs());
		if ('refusal' in queued) return refuse(queued.refusal);

		site.mails.push({
			to: msg.to,
			subject: msg.subject,
			bytes,
			transport: plan.transport.kind
		});
		trimMails(site.mails);
		// wake the drain, or the message waits for the 240 s keep-warm tick
		if (mailDrainEnabled(site.env ?? {})) site.armFillAlarm();
		return reply({ ok: true, queued: queued.id, transport: plan.transport.kind });
	};

	// a style is a URL, not a file, whichever engine answers; PHP sends `{uri, transform}`
	binary.cfwImageUrl = (json: string) => {
		const { uri, transform } = readImageRequest(parse(json) as ImageUrlRequest);
		if (uri === '') return reply({ ok: false, url: null, error: 'no uri' });
		const engine = imageEngine(site.env);
		return reply({
			ok: true,
			engine,
			url:
				engine === 'images'
					? imagesDeliveryUrl(uri, transform)
					: transformPath(uri, transform),
			// lets a formatter defer a large transform rather than block a visitor
			large: transformIsLarge(transform),
			// what the engine encodes, so the toolkit does not infer it from the engine's name
			extensions: supportedExtensions(
				engine,
				engine === 'tinyimg' ? engineFeatures() : undefined
			)
		});
	};

	// #region durable files
	// fully synchronous: DO SQL needs no await, so a write reports a committed result in one call
	// bytes cross as base64 in a string field (the stream wrapper moves partial buffers)
	binary.cfwFileWrite = (json: string) => {
		const req = parse(json);
		try {
			const written = putFile(
				site.sql,
				String(req.uri ?? ''),
				base64ToBytes(String(req.b64 ?? '')),
				{
					nowMs: site.nowMs(),
					mime: req.mime === undefined || req.mime === null ? undefined : String(req.mime)
				}
			);
			site.queueDerivatives(written.uri);
			return reply({ ok: true, ...written });
		} catch (e) {
			return reply({ ok: false, error: errorMessage(e) });
		}
	};

	binary.cfwFileRead = (json: string) => {
		const req = parse(json);
		const uri = String(req.uri ?? '');
		// a chunk when `seq` is given, else the whole file (chunks divide a large read)
		if (req.seq !== undefined && req.seq !== null) {
			const chunk = getFileChunk(site.sql, uri, Number(req.seq));
			return reply(
				chunk === undefined
					? { ok: false, error: 'no such chunk' }
					: { ok: true, b64: bytesToBase64(chunk), bytes: chunk.length }
			);
		}
		const body = getFile(site.sql, uri);
		return reply(
			body === undefined
				? { ok: false, error: 'no such file' }
				: { ok: true, b64: bytesToBase64(body), bytes: body.length }
		);
	};

	// where a public file is served from, or '' when the Worker serves it; only a static asset or
	// an unrouted hostname (an R2 custom domain) costs zero Worker requests
	binary.cfwFilePublicBase = () => reply({ ok: true, base: site.publicFilesOrigin() });

	binary.cfwFileStat = (json: string) => {
		const stat = statFile(site.sql, String(parse(json).uri ?? ''));
		return reply(
			stat === undefined ? { ok: false, error: 'no such file' } : { ok: true, ...stat }
		);
	};

	binary.cfwFileDelete = (json: string) => {
		const removed = deleteFile(site.sql, String(parse(json).uri ?? ''), site.nowMs());
		// `ok` reports whether anything was there (`unlink()` on an absent path is a PHP false)
		return reply({ ok: removed });
	};

	binary.cfwFileRename = (json: string) => {
		const req = parse(json);
		return reply({
			ok: renameFile(site.sql, String(req.from ?? ''), String(req.to ?? ''), site.nowMs(), {
				overwrite: req.overwrite === true
			})
		});
	};

	binary.cfwFileList = (json: string) => {
		const req = parse(json);
		return reply({
			ok: true,
			files: listFiles(site.sql, String(req.prefix ?? ''), Number(req.limit ?? 1_000))
		});
	};
	// #endregion

	return binary;
}
