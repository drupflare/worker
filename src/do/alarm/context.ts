import type { SitePhpDurableObject } from '../../site-do';
import type { Payload } from '../types';

/** what one alarm firing carries from phase to phase */
export type AlarmContext = {
	/** the object being fired */
	site: SitePhpDurableObject;
	/** the platform's retry facts for this firing */
	info?: AlarmInvocationInfo;
	/** what each page of the fill batch reported */
	outcomes: Array<Payload | undefined>;
	/** the fill batch's page cap */
	maxPages: number;
	/** end of the young-interpreter hold on background PHP, or undefined when none applies */
	hold?: number;
	/** whether background PHP waits this firing, so the re-arm lands on the end of the hold */
	held: boolean;
	/** whether reconciliation deferred a step for the hold instead of finishing it */
	reconcileHeld: boolean;
};

/** what a phase returns when it owns the rest of the firing */
export type AlarmEnd = {
	/** the value the alarm hands back */
	outcome: any;
};

/**
 * A phase that may end the firing.
 *
 * Undefined means the phase does not apply and costs no await; a promise that resolves to
 * undefined means it ran and the firing carries on.
 */
export type GatePhase = (ctx: AlarmContext) => Promise<AlarmEnd | undefined> | undefined;

/** a phase that never ends the firing; undefined means it had nothing to await */
export type WorkPhase = (ctx: AlarmContext) => Promise<void> | undefined;
