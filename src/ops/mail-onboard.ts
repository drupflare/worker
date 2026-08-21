/**
 * Onboards a sending domain, which is the whole gap between "mail refuses" and "mail works".
 *
 * `src/ops/mail.ts` picks a transport; every transport then fails the same way if the domain was
 * never onboarded with Cloudflare. That is a DNS and account-state problem rather than a code one,
 * and it is the last manual step in a one-click setup.
 *
 * ## What is automatable, measured against the live API rather than the docs
 *
 * A sending subdomain is **zone-scoped**: `/zones/{zone}/email/sending/subdomains`. The
 * account-scoped path answers `Unable to authenticate request`, so a design that reached for
 * `/accounts/{id}/...` would fail with an error that reads like a bad token.
 *
 * Its records are six: three MX on the return-path host, an SPF TXT beside them, a DKIM TXT at
 * `<selector>._domainkey`, and a DMARC TXT on the apex. `dnsPlan()` diffs them against the zone.
 *
 * ## The one step that stays manual, and why that is fine
 *
 * A destination address is verified by clicking a link Cloudflare emails. That cannot be automated
 * and should not be: it is the proof that whoever is configuring the site controls the inbox.
 * Drupal's own email flow already expects click-to-verify, so it fits the model rather than
 * fighting it.
 *
 * **It can be POLLED, which was an open question and is now answered.** A destination address
 * carries both `status: "verified" | "unverified"` and a `verified` timestamp that is null until it
 * happens -- read off the live account. So the setup page waits and lights up on its own instead of
 * telling the operator to come back.
 *
 * ## Permission
 *
 * This needs **zone DNS write**, far broader than anything else drupflare asks for. It is opt-in and
 * never required by a site that only serves pages, which is why it is a separate surface rather than
 * part of the first-run claim.
 */

const API = 'https://api.cloudflare.com/client/v4';

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

export type SendingSubdomain = {
	id: string;
	name: string;
	enabled: boolean;
	dkim_selector?: string;
	return_path_domain?: string;
};

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string };

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
		// the message is what an operator can act on; a bare status is not
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

export type RecordAction =
	| { verb: 'create'; record: DnsRecord }
	| { verb: 'update'; record: DnsRecord; id: string; from: string }
	| { verb: 'advise'; record: DnsRecord; id: string; from: string; why: string }
	| { verb: 'keep'; record: DnsRecord };

/**
 * Records drupflare owns outright, by name shape.
 *
 * The five on the return-path host and the DKIM selector exist BECAUSE of this feature, so writing
 * them is unambiguous. `_dmarc` is not one of them: it sits on the apex and states a policy for
 * every mail stream the domain has, most of which drupflare knows nothing about.
 */
export function ownedByOnboarding(record: DnsRecord): boolean {
	return !/^_dmarc\./i.test(record.name);
}

/**
 * Normalises a TXT value for comparison.
 *
 * The sending API returns TXT content WRAPPED IN QUOTES and the zone API returns it unwrapped, so a
 * naive string compare rewrites all three TXT records on every run -- which looks idempotent right
 * up until it burns a rate limit and rotates nothing.
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
	// MX is a SET: three records share a name and differ by target, so the target is part of the slot
	(a.type !== 'MX' || normaliseContent('MX', a.content) === normaliseContent('MX', b.content));

/**
 * What to create, what to update and what already agrees.
 *
 * IDEMPOTENT BY CONSTRUCTION, which the entry called for: a second run over an onboarded zone
 * returns all `keep` and writes nothing. Resumable for the same reason -- a run that died halfway
 * finds its own records on the next pass.
 *
 * An existing record whose content DIFFERS is an update rather than a second create. Creating a
 * second SPF TXT on one name is not a duplicate that gets ignored; it is two SPF records, which is a
 * permerror under RFC 7208 and fails mail delivery for the whole domain.
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

/** applies a plan; `keep` costs no request, which is what makes a re-run cheap as well as safe */
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
			// NEVER written. Surfaced to the operator with both values and left alone
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
 * Reads `status` first and falls back to the `verified` timestamp. Both are populated on the live
 * account -- `status: "verified"` alongside `verified: "2025-01-26T05:40:12Z"`, and
 * `status: "unverified"` alongside `verified: null` -- so either alone would do, and using one with
 * the other as a fallback survives whichever they stop sending.
 */
export function isVerified(address: DestinationAddress | undefined): boolean {
	if (!address) return false;
	if (typeof address.status === 'string') return address.status.toLowerCase() === 'verified';
	return typeof address.verified === 'string' && address.verified !== '';
}

export type OnboardStage =
	'no-zone' | 'needs-subdomain' | 'needs-dns' | 'awaiting-verification' | 'ready';

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
 * Turns the four observables into one stage, so the surface reports WHICH step it is waiting on.
 *
 * The entry asked for exactly this rather than a pass/fail: DNS propagation runs to 24 hours, and a
 * flow that answers "failed" during a normal wait is a flow an operator will run again and again.
 * `settled` is the only true/false here, and it means "re-running changes nothing" rather than
 * "finished" -- `awaiting-verification` is settled and not finished.
 */
export function onboardState(input: {
	zoneId: string | null;
	subdomain: SendingSubdomain | null;
	plan: RecordAction[];
	destination: DestinationAddress | undefined;
}): OnboardState {
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
	// an advisory is NOT pending work: nothing here will ever write it, so a flow that waited on one
	// would sit at needs-dns forever
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
			// the honest phrasing: nothing here is broken and nothing more can be done from this side
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
