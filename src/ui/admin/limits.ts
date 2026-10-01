import { type PlanEnv, type ResolvedPlan } from '../../ops/plan';
import {
	projectImageTransforms,
	thresholdReport,
	type ImagePlan,
	type MeterReading
} from '../../ops/thresholds';
import {
	ADMIN_LIMITS_HTML,
	ADMIN_LIMITS_IMAGES_HINT_HTML,
	ADMIN_LIMITS_IMAGES_HTML,
	ADMIN_LIMITS_PLAN_HTML,
	ADMIN_LIMITS_ROW_HTML
} from '../../site/generated/assets';
import { escapeHtml, fill, pill } from './shell';

/** the per-plan thresholds with costs and failure modes (a billed limit versus a hard stop) */
export function renderThresholds(
	used: Partial<Record<string, number>>,
	imagePlan: ImagePlan | undefined,
	env?: PlanEnv,
	resolved?: ResolvedPlan
): string {
	const report = thresholdReport(used, env);
	const rows = report.readings.map((r: MeterReading) => {
		const limit =
			r.limit === null
				? 'not metered'
				: `${r.limit.toLocaleString()} / ${r.threshold.period}`;
		const failure =
			r.threshold.failure === 'hard-cap'
				? '<span class="over">stops working</span>'
				: r.threshold.failure === 'billed'
					? '<span class="warn">costs money</span>'
					: '<span class="dim">refused, site stays up</span>';
		return fill(ADMIN_LIMITS_ROW_HTML, {
			LABEL: escapeHtml(r.threshold.label),
			SPENT_BY: escapeHtml(r.threshold.spentBy),
			LIMIT: escapeHtml(limit),
			FAILURE: failure,
			STATUS: pill(r.status),
			MESSAGE: escapeHtml(r.message)
		});
	});

	let images = '';
	if (imagePlan) {
		const p = projectImageTransforms(imagePlan, env);
		const cls = p.status === 'over' ? 'card bad' : p.status === 'warn' ? 'card warn' : 'card';
		const remedies = p.remedies.length
			? `<ul>${p.remedies.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`
			: '';
		images = fill(ADMIN_LIMITS_IMAGES_HTML, {
			IMAGES: escapeHtml(imagePlan.images.toLocaleString()),
			STYLES: escapeHtml(String(imagePlan.styles)),
			CLASS: cls,
			STATUS: pill(p.status),
			MESSAGE: escapeHtml(p.message),
			REMEDIES: remedies
		});
	} else {
		images = ADMIN_LIMITS_IMAGES_HINT_HTML.trimEnd();
	}

	return fill(ADMIN_LIMITS_HTML, {
		PLAN: resolved
			? fill(ADMIN_LIMITS_PLAN_HTML, {
					PLAN: escapeHtml(resolved.plan),
					SOURCE: escapeHtml(
						resolved.source === 'kv'
							? 'the CONFIG_KV override'
							: resolved.source === 'var'
								? 'the deployed PLAN var'
								: 'nothing set, so the free default'
					)
				})
			: '',
		HARD_CAPS: escapeHtml(String(report.hardCapCount)),
		ROWS: rows.join(''),
		IMAGES: images
	});
}
