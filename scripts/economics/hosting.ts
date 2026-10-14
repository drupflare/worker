import { readFileSync } from 'node:fs';
import { num } from './args';

/** one sourced fact in the catalog */
interface Sourced {
	source: string;
	quote: string;
}

/** a rentable server size, at the provider's list price */
export interface Plan extends Sourced {
	plan: string;
	vcpu: number;
	memoryGiB: number;
	/** zero where the provider bills the disk separately */
	storageGB: number;
	transferTB: number;
	monthlyUSD: number;
	/** the provider's backup price for this plan, where it is priced per plan */
	backupUSDMonth?: number;
}

/** a provider, with only the fields its own pages state */
export interface Provider {
	name: string;
	plans: Plan[];
	freeEgressGB?: number;
	egressUSDPerGB?: Sourced & { value: number };
	diskUSDPerGBMonth?: Sourced & { value: number };
	ipv4USDMonthPerBox?: Sourced & { value: number };
	backups?: Sourced & { fractionOfPlan?: number; flatUSDPerBox?: number; usdPerGBMonth?: number };
	loadBalancerUSDMonth?: Sourced & { regional: number; global: number };
}

interface Catalog {
	accessed: string;
	providers: Record<string, Provider>;
}

/** every provider the model prices, with the page each figure was read from */
export const CATALOG: Catalog = JSON.parse(
	readFileSync(new URL('./hosting-catalog.json', import.meta.url), 'utf8')
);

/** seconds in an average month */
export const SECONDS_MONTH = 2_629_800.0;

/** measured on the shipped nginx and PHP-FPM stack: 67 renders a second on 1.2 cores */
export const RENDER_S_PER_CPU = num('render-s-per-cpu', 56.0);
/** every view is charged to the origin as a render; a cached hit would only lower it */
export const ORIGIN_RENDER_FRAC = num('origin-render-frac', 1.0);
/** the peak arrival rate over the monthly average */
export const PEAK_RATIO = num('peak', 5.0);

/**
 * How tightly a box is sized. A viable box survives: the p95 response stays under the 60 second
 * default timeout of nginx and Apache, so no client or proxy gives up. A matched box keeps the p95
 * under the 0.8 second first-byte bound web.dev calls good, which is the speed drupflare answers at.
 * The utilisation caps are modelled.
 */
export type Sizing = 'viable' | 'matched';
const SIZING: Record<Sizing, { p95S: number; maxUtil: number }> = {
	viable: { p95S: num('viable-p95-s', 60), maxUtil: num('viable-max-util', 0.95) },
	matched: { p95S: num('matched-p95-s', 0.8), maxUtil: num('matched-max-util', 0.8) }
};

/** one vCPU is the smallest box sold */
const MIN_VCPU = 1;
/** Canonical's minimum for an Ubuntu 24.04 cloud image */
const OS_GIB = num('os-gib', 1);
/** measured: nginx and PHP-FPM with 32 children held 172 MB under the render load */
const STACK_GIB = num('stack-gib', 0.172);
/** MariaDB's default innodb_buffer_pool_size */
const DB_GIB = num('db-gib', 0.128);
/** what every box needs before it serves a request; memory does not grow with traffic here */
export const MEMORY_PER_BOX_GIB = OS_GIB + STACK_GIB + DB_GIB;
/** operating system, the 167 MB Drupal tree and the 5.8 MB database; modelled */
export const USED_DISK_GB = num('used-disk-gb', 10);
/** the first load of a stock page, measured: 66 requests, about 166 KB over the wire */
export const BYTES_PER_VIEW = num('bytes-per-view', 166_000);

/** what a conventional origin needs to serve `views` a month */
export interface Need {
	/** arrivals a second at peak */
	lambdaS: number;
	/** cores of offered load */
	cores: number;
	vcpu: number;
	storageGB: number;
	egressGB: number;
}

/** the share of arrivals that wait longer than `t` in an M/M/c queue with a = lambda / mu (Erlang C) */
function waitTail(a: number, c: number, t: number, mu: number): number {
	if (a >= c) return 1;
	let b = 1;
	for (let k = 1; k <= c; k += 1) b = (a * b) / (k + a * b);
	const wait = b / (1 - (a / c) * (1 - b));
	return wait * Math.exp(-(c * mu - a * mu) * t);
}

/** the fewest whole cores that keep the p95 response inside the sizing's bound at this arrival rate */
export function coresFor(lambda: number, sizing: Sizing, serviceS = 1 / RENDER_S_PER_CPU): number {
	const { p95S, maxUtil } = SIZING[sizing];
	const mu = 1 / serviceS;
	const a = lambda / mu;
	for (let c = 1; ; c += 1) {
		if (a / c > maxUtil) continue;
		const spare = p95S - serviceS;
		if (spare > 0 && waitTail(a, c, spare, mu) <= 0.05) return c;
	}
}

/** what a conventional origin needs to serve `views` a month, sized for the peak */
export function needFor(views: number, sizing: Sizing = 'matched'): Need {
	const lambda = ((views * ORIGIN_RENDER_FRAC) / SECONDS_MONTH) * PEAK_RATIO;
	return {
		lambdaS: lambda,
		cores: lambda / RENDER_S_PER_CPU,
		vcpu: Math.max(MIN_VCPU, coresFor(lambda, sizing)),
		storageGB: USED_DISK_GB,
		egressGB: (views * BYTES_PER_VIEW) / 1e9
	};
}

/** a priced choice of plan and box count */
export interface Quote {
	provider: string;
	plan: string;
	boxes: number;
	usd: number;
	planUSD: number;
	backupsUSD: number;
	otherUSD: number;
}

/**
 * The cheapest whole number of one plan that meets the need, with backups and bandwidth overage.
 * A provider is priced only when every part of the bill is sourced for it, so a missing backup or
 * overage price removes the plan and never reads as free.
 */
export function quote(key: string, need: Need): Quote | undefined {
	const p = CATALOG.providers[key];
	if (!p) throw new Error(`no provider ${key} in the catalog`);
	let best: Quote | undefined;
	for (const plan of p.plans) {
		if (!p.backups && plan.backupUSDMonth === undefined) continue;
		if (plan.memoryGiB < MEMORY_PER_BOX_GIB) continue;
		const separateDisk = plan.storageGB === 0;
		if (separateDisk && !p.diskUSDPerGBMonth) continue;
		const boxes = Math.max(
			Math.ceil(need.vcpu / plan.vcpu),
			separateDisk ? 1 : Math.ceil(need.storageGB / plan.storageGB)
		);
		const included = boxes * plan.transferTB * 1000 + (p.freeEgressGB ?? 0);
		const over = Math.max(0, need.egressGB - included);
		if (over > 0 && !p.egressUSDPerGB) continue;
		const b = p.backups;
		const backups =
			boxes *
			(plan.backupUSDMonth ??
				plan.monthlyUSD * (b?.fractionOfPlan ?? 0) +
					(b?.flatUSDPerBox ?? 0) +
					need.storageGB * (b?.usdPerGBMonth ?? 0));
		const disk = separateDisk ? boxes * need.storageGB * p.diskUSDPerGBMonth!.value : 0;
		const ip = boxes * (p.ipv4USDMonthPerBox?.value ?? 0);
		const usd =
			boxes * plan.monthlyUSD + disk + ip + backups + over * (p.egressUSDPerGB?.value ?? 0);
		if (!best || usd < best.usd)
			best = {
				provider: key,
				plan: plan.plan,
				boxes,
				usd,
				planUSD: boxes * plan.monthlyUSD,
				backupsUSD: backups,
				otherUSD: disk + ip + over * (p.egressUSDPerGB?.value ?? 0)
			};
	}
	return best;
}

/** the providers priced in full, cheapest first */
export function ranked(need: Need): Quote[] {
	return Object.keys(CATALOG.providers)
		.map((k) => quote(k, need))
		.filter((q): q is Quote => q !== undefined)
		.sort((a, b) => a.usd - b.usd);
}

/** the three regions of a latency-matched origin: US East, Europe and Asia Pacific */
export const MATCHED_REGIONS = num('regions', 3);
/** the provider whose global load balancer price is sourced */
const MATCHED_PROVIDER = 'digitalocean';
/** the most-used specialist VPS provider and the most-used cloud, from the 2025 developer survey */
export const POPULAR_VPS = 'digitalocean';
export const POPULAR_CLOUD = 'lightsail';

/** the lowest bill that survives the traffic, at any provider priced */
export const cheapestViableUsdMonth = (views: number) => ranked(needFor(views, 'viable'))[0]!.usd;
/** the lowest bill that keeps the p95 under the first-byte bound, at any provider priced */
export const cheapestUsdMonth = (views: number) => ranked(needFor(views))[0]!.usd;
/** the matched bill at the most-used specialist VPS provider */
export const popularVpsUsdMonth = (views: number) => quote(POPULAR_VPS, needFor(views))!.usd;
/** the matched bill at the most-used cloud; it throws where no bundle includes the transfer */
export const popularCloudUsdMonth = (views: number) => quote(POPULAR_CLOUD, needFor(views))!.usd;

/**
 * One origin in each region behind a global load balancer. The database replica, file replication
 * and cross-region transfer are not priced, so this is a floor.
 */
export function matchedUsdMonth(views: number): number {
	const each = quote(MATCHED_PROVIDER, needFor(views / MATCHED_REGIONS))!.usd;
	const lb = CATALOG.providers[MATCHED_PROVIDER]!.loadBalancerUSDMonth!.global;
	return MATCHED_REGIONS * each + lb;
}
