/**
 * Onboards a sending domain: the gap between "mail refuses" and "mail works".
 *
 * A sending subdomain is zone-scoped (`/zones/{zone}/email/sending/subdomains`; the account path
 * answers `Unable to authenticate request`, which reads like a bad token). Its six records (three
 * MX, SPF, DKIM, DMARC) are diffed by `dnsPlan()`. Destination verification stays manual (a clicked
 * link proves inbox control) but can be polled via `status` or the `verified` timestamp. Needs zone
 * DNS write, so it is an opt-in surface, not part of the first-run claim.
 * @module
 */

const API = 'https://api.cloudflare.com/client/v4';

/** the `fetch` signature the API calls go through, injectable for tests */
export type Fetcher = typeof fetch;

/** a DNS record as both the sending API and the zone API describe one */
export type DnsRecord = {
	name: string;
	type: string;
	content: string;
	priority?: number;
	ttl?: number;
};

/** an existing zone record, which additionally has an id to PATCH */
export type ZoneRecord = DnsRecord & { id: string };

/** a sending subdomain as the zone API returns it */
export type SendingSubdomain = {
	id: string;
	name: string;
	enabled: boolean;
	dkim_selector?: string;
	return_path_domain?: string;
};

/** a call's value, or the error message an operator can act on */
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** one authenticated call to the Cloudflare API, with transport and API failures as `ApiResult` */
async function api<T>(
	fetcher: Fetcher,
	token: string,
	path: string,
	init?: RequestInit
): Promise<ApiResult<T>> {
	let res: Response;
	try {
		res = await fetcher(`${API}${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
				...(init?.headers ?? {})
			}
		});
	} catch (e) {
		return { ok: false, error: `unreachable: ${(e as Error)?.message ?? 'unknown'}` };
	}
	let body: { success?: boolean; result?: T; errors?: { message?: string }[] };
	try {
		body = (await res.json()) as typeof body;
	} catch {
		return { ok: false, error: `HTTP ${res.status} with an unreadable body` };
	}
	if (body.success !== true) {
		const first = body.errors?.[0]?.message;
		return { ok: false, error: first ?? `HTTP ${res.status}` };
	}
	return { ok: true, value: body.result as T };
}

/** the sending subdomains a zone already has; an empty list is a normal answer, not an error */
export function listSendingSubdomains(
	token: string,
	zoneId: string,
	fetcher: Fetcher = fetch
): Promise<ApiResult<SendingSubdomain[]>> {
	return api<SendingSubdomain[]>(fetcher, token, `/zones/${zoneId}/email/sending/subdomains`);
}

/** creates one; re-running against an onboarded zone is what `dnsPlan` makes safe */
export function createSendingSubdomain(
	token: string,
	zoneId: string,
	name: string,
	fetcher: Fetcher = fetch
): Promise<ApiResult<SendingSubdomain>> {
	return api<SendingSubdomain>(fetcher, token, `/zones/${zoneId}/email/sending/subdomains`, {
		method: 'POST',
		body: JSON.stringify({ name })
	});
}

/** the records Cloudflare wants for a sending subdomain */
export function requiredDns(
	token: string,
	zoneId: string,
	subdomainId: string,
	fetcher: Fetcher = fetch
): Promise<ApiResult<DnsRecord[]>> {
	return api<DnsRecord[]>(
		fetcher,
		token,
		`/zones/${zoneId}/email/sending/subdomains/${subdomainId}/dns`
	);
}

/** every record already on the zone, paged out */
export async function zoneRecords(
	token: string,
	zoneId: string,
	fetcher: Fetcher = fetch
): Promise<ApiResult<ZoneRecord[]>> {
	const out: ZoneRecord[] = [];
	for (let page = 1; page <= 20; page++) {
		const res = await api<ZoneRecord[]>(
			fetcher,
			token,
			`/zones/${zoneId}/dns_records?per_page=100&page=${page}`
		);
		if (!res.ok) return res;
		out.push(...res.value);
		if (res.value.length < 100) break;
	}
	return { ok: true, value: out };
}

/** what `dnsPlan` decided for one required record; `advise` is never written */
export type RecordAction =
	| { verb: 'create'; record: DnsRecord }
	| { verb: 'update'; record: DnsRecord; id: string; from: string }
	| { verb: 'advise'; record: DnsRecord; id: string; from: string; why: string }
	| { verb: 'keep'; record: DnsRecord };

/**
 * Records drupflare owns outright, by name shape: the return-path host and DKIM selector exist
 * because of this feature. `_dmarc` is not one; it sits on the apex and sets policy for every mail
 * stream the domain has.
 */
export function ownedByOnboarding(record: DnsRecord): boolean {
	return !/^_dmarc\./i.test(record.name);
}

/**
 * Normalises a TXT value for comparison.
 *
 * The sending API returns TXT content wrapped in quotes and the zone API unwrapped, so a naive
 * compare rewrites every TXT record on every run (until it hits a rate limit).
 */
export function normaliseContent(type: string, content: string): string {
	const trimmed = content.trim();
	if (type === 'TXT') return trimmed.replace(/^"|"$/g, '').replace(/"\s+"/g, '').trim();
	// an MX target is equal with or without its root dot
	if (type === 'MX') return trimmed.replace(/\.$/, '').toLowerCase();
	return trimmed;
}

/** whether two records address the same thing, ignoring content */
const sameSlot = (a: DnsRecord, b: DnsRecord) =>
	a.type === b.type &&
	a.name.toLowerCase() === b.name.toLowerCase() &&
	// MX is a set: three records share a name, so the target is part of the slot
	(a.type !== 'MX' || normaliseContent('MX', a.content) === normaliseContent('MX', b.content));

/**
 * What to create, what to update and what already agrees.
 *
 * Idempotent and resumable: a second run over an onboarded zone returns all `keep`, and a run that
 * died halfway finds its own records. An existing record with different content is an update, not
 * a second create: two SPF records are a permerror (RFC 7208) and fail delivery for the domain.
 */
export function dnsPlan(
	required: readonly DnsRecord[],
	existing: readonly ZoneRecord[]
): RecordAction[] {
	return required.map((want) => {
		const hit = existing.find((have) => sameSlot(have, want));
		if (!hit) return { verb: 'create', record: want };
		if (normaliseContent(want.type, want.content) === normaliseContent(hit.type, hit.content)) {
			return { verb: 'keep', record: want };
		}
		if (!ownedByOnboarding(want)) {
			return {
				verb: 'advise',
				record: want,
				id: hit.id,
				from: hit.content,
				why: "an existing DMARC policy governs every mail stream on this domain, so tightening it is the operator's call"
			};
		}
		return { verb: 'update', record: want, id: hit.id, from: hit.content };
	});
}

/** applies a plan; `keep` costs no request, so a re-run is cheap as well as safe */
export async function applyDnsPlan(
	token: string,
	zoneId: string,
	plan: readonly RecordAction[],
	fetcher: Fetcher = fetch
): Promise<{ created: number; updated: number; kept: number; advised: number; errors: string[] }> {
	let created = 0;
	let updated = 0;
	let kept = 0;
	let advised = 0;
	const errors: string[] = [];
	for (const action of plan) {
		if (action.verb === 'keep') {
			kept++;
			continue;
		}
		if (action.verb === 'advise') {
			// never written; surfaced to the operator with both values
			advised++;
			continue;
		}
		const body = JSON.stringify({
			type: action.record.type,
			name: action.record.name,
			content: action.record.content,
			...(action.record.priority !== undefined ? { priority: action.record.priority } : {}),
			ttl: action.record.ttl ?? 1
		});
		const res =
			action.verb === 'create'
				? await api(fetcher, token, `/zones/${zoneId}/dns_records`, {
						method: 'POST',
						body
					})
				: await api(fetcher, token, `/zones/${zoneId}/dns_records/${action.id}`, {
						method: 'PATCH',
						body
					});
		if (res.ok) action.verb === 'create' ? created++ : updated++;
		else errors.push(`${action.record.type} ${action.record.name}: ${res.error}`);
	}
	return { created, updated, kept, advised, errors };
}

/**
 * Whether a message's From address belongs to the domain this account onboarded for sending.
 *
 * A mismatch restricts delivery rather than failing: Cloudflare accepts a send from a domain with
 * no SPF or DKIM and delivers it only to verified destination addresses, so registration mail is
 * accepted by the API and never arrives. A subdomain of the sending domain passes.
 *
 * @param from the effective sender, which is `senderFor()`'s answer rather than `MAIL_FROM`
 * @param sending the onboarded sending domain, or '' when none; empty answers ok (a third-party
 *   relay has no Cloudflare sending domain)
 */
export function senderDomainVerdict(
	from: string,
	sending: string
): { ok: true } | { ok: false; reason: string } {
	const want = String(sending ?? '')
		.trim()
		.toLowerCase()
		.replace(/^\.+|\.+$/g, '');
	if (want === '') return { ok: true };
	// accept `Name <addr@host>` as well as a bare address (Drupal's default carries a display name)
	const raw = String(from ?? '').trim();
	const angled = raw.match(/<([^>]*)>\s*$/);
	const address = (angled?.[1] ?? raw).trim();
	const at = address.lastIndexOf('@');
	const domain =
		at === -1
			? ''
			: address
					.slice(at + 1)
					.trim()
					.toLowerCase()
					.replace(/\.+$/, '');
	if (domain === '') {
		return { ok: false, reason: `the sender ${from || '(empty)'} carries no domain` };
	}
	if (domain === want || domain.endsWith(`.${want}`)) return { ok: true };
	return {
		ok: false,
		reason:
			`the sender is ${domain} and this account onboarded ${want} for sending. Cloudflare ` +
			`accepts a send from an un-onboarded domain and then delivers it only to verified ` +
			`destination addresses, so this would look sent and not arrive. Set the site mail ` +
			`address or MAIL_FROM to an address at ${want}`
	};
}

/** an Email Routing destination address; `status` and `verified` both report verification */
export type DestinationAddress = {
	id: string;
	email: string;
	status?: string;
	verified?: string | null;
};

/** the account's destination addresses, which is where the verified flag lives */
export function listDestinations(
	token: string,
	accountId: string,
	fetcher: Fetcher = fetch
): Promise<ApiResult<DestinationAddress[]>> {
	return api<DestinationAddress[]>(
		fetcher,
		token,
		`/accounts/${accountId}/email/routing/addresses`
	);
}

/** adds one, which makes Cloudflare send the verification mail */
export function addDestination(
	token: string,
	accountId: string,
	email: string,
	fetcher: Fetcher = fetch
): Promise<ApiResult<DestinationAddress>> {
	return api<DestinationAddress>(
		fetcher,
		token,
		`/accounts/${accountId}/email/routing/addresses`,
		{
			method: 'POST',
			body: JSON.stringify({ email })
		}
	);
}

/**
 * Whether an address is verified.
 *
 * Reads `status` first and falls back to the `verified` timestamp; both are populated on the live
 * account, so using one as the fallback survives whichever the API stops sending.
 */
export function isVerified(address: DestinationAddress | undefined): boolean {
	if (!address) return false;
	if (typeof address.status === 'string') return address.status.toLowerCase() === 'verified';
	return typeof address.verified === 'string' && address.verified !== '';
}

/**
 * What the token is actually allowed to do, probed rather than assumed.
 *
 * A token that cannot read destinations must not look like an unverified one (the operator would be
 * told to click a link Cloudflare never sent). Each field is the verdict of a call the flow makes
 * anyway.
 */
export type TokenGrants = {
	/** can list sending subdomains on the zone; null when no zone has been chosen yet */
	zone: boolean | null;
	/** can list the account's destination addresses */
	destinations: boolean;
	/** what the API said when one was refused, for the operator rather than for a log */
	refusal?: string;
};

/** which step the onboarding flow is waiting on, in order */
export type OnboardStage =
	| 'no-token'
	| 'insufficient-grants'
	| 'no-zone'
	| 'needs-subdomain'
	| 'needs-dns'
	| 'awaiting-verification'
	| 'ready';

/** the stage plus what the operator is waiting on and whether a re-run would change anything */
export type OnboardState = {
	stage: OnboardStage;
	/** what the operator is waiting on, in their words rather than an API's */
	waitingOn: string;
	/** true when re-running would change nothing */
	settled: boolean;
	pending?: RecordAction[];
	/** records that differ and will NOT be written; the operator decides */
	advisories?: RecordAction[];
};

/**
 * Turns the four observables into one stage, so the surface reports which step it is waiting on.
 *
 * DNS propagation runs to 24 hours, so a normal wait must not read as failure. `settled` means
 * "re-running changes nothing", not "finished" (`awaiting-verification` is settled, not finished).
 */
export function onboardState(input: {
	zoneId: string | null;
	subdomain: SendingSubdomain | null;
	plan: RecordAction[];
	destination: DestinationAddress | undefined;
	/** omitted by a caller that has not probed; then the grant branches cannot fire */
	grants?: TokenGrants;
	/** false when no Cloudflare account is connected at all */
	hasToken?: boolean;
}): OnboardState {
	if (input.hasToken === false) {
		return {
			stage: 'no-token',
			waitingOn: 'connect a Cloudflare account on the Deploy page',
			settled: false
		};
	}
	// before every stage below: a token that cannot read is no evidence about the account (stops a
	// short permission reading as "click the link Cloudflare emailed you")
	const grants = input.grants;
	if (grants && (grants.zone === false || !grants.destinations)) {
		const missing = [
			grants.zone === false ? 'read the sending subdomains on that zone' : '',
			grants.destinations ? '' : 'read the account destination addresses'
		].filter((m) => m !== '');
		return {
			stage: 'insufficient-grants',
			waitingOn:
				`the connected token cannot ${missing.join(' or ')}. Reconnect with Email ` +
				`Routing and Zone DNS permissions` +
				(grants.refusal ? `; the API said: ${grants.refusal}` : ''),
			settled: false
		};
	}
	if (!input.zoneId) {
		return {
			stage: 'no-zone',
			waitingOn: 'pick the Cloudflare zone this site sends from',
			settled: false
		};
	}
	if (!input.subdomain) {
		return {
			stage: 'needs-subdomain',
			waitingOn: 'create the sending subdomain on that zone',
			settled: false
		};
	}
	// an advisory is not pending work (nothing writes it), or the flow would stall at needs-dns
	const advisories = input.plan.filter((a) => a.verb === 'advise');
	const pending = input.plan.filter((a) => a.verb !== 'keep' && a.verb !== 'advise');
	if (pending.length > 0) {
		return {
			stage: 'needs-dns',
			waitingOn: `write ${pending.length} DNS record${pending.length === 1 ? '' : 's'}`,
			settled: false,
			pending
		};
	}
	if (!isVerified(input.destination)) {
		return {
			stage: 'awaiting-verification',
			...(advisories.length > 0 ? { advisories } : {}),
			waitingOn: 'click the link Cloudflare emailed to the destination address',
			settled: true
		};
	}
	return {
		stage: 'ready',
		waitingOn: '',
		settled: true,
		...(advisories.length > 0 ? { advisories } : {})
	};
}
