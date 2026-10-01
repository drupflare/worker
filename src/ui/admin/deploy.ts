import {
	ADMIN_DEPLOY_CONNECT_JS,
	ADMIN_DEPLOY_CONNECTED_HTML,
	ADMIN_DEPLOY_DISCONNECT_JS,
	ADMIN_DEPLOY_HTML,
	ADMIN_DEPLOY_ROW_HTML
} from '../../site/generated/assets';
import { escapeHtml, fill, pill } from './shell';

/** what a provisioner would have to create; rendered as a checklist rather than executed */
export type ProvisionStep = { id: string; label: string; detail: string; automatable: boolean };

/** the steps a one-click deploy would perform, from what the shipped `wrangler.jsonc` binds */
export const PROVISION_STEPS: readonly ProvisionStep[] = [
	{
		id: 'worker',
		label: 'Upload the Worker',
		detail: 'the bundle plus the wasm interpreter, which must be a module-scope import because workerd blocks request-time wasm codegen',
		automatable: true
	},
	{
		id: 'do-namespace',
		label: 'Create the Durable Object namespace',
		detail: 'one SQLite-backed class; a fresh namespace needs ~60 s of propagation before stub.fetch() stops answering "Worker not found"',
		automatable: true
	},
	{
		id: 'assets',
		label: 'Upload the packed site',
		detail: 'the per-file pack and the trimmed database; the full assets tree does not upload in one go',
		automatable: true
	},
	{
		id: 'cron',
		label: 'Register the warm-window cron trigger',
		detail: 'the fill window is what amortises one boot across a queue drain, and it costs no visitor request',
		automatable: true
	},
	{
		id: 'token',
		label: 'Obtain an API token',
		detail: 'needs Workers Scripts:Edit and Durable Objects:Edit on the target account, which only the account owner can mint',
		automatable: false
	},
	{
		id: 'admin-auth',
		label: 'Record the owner token',
		detail: 'first run mints it once and it cannot be read back; it is what signs in to these pages and what /export takes',
		automatable: false
	}
];

/** shown so an operator can copy it into their OAuth client's redirect list */
export const CFW_CALLBACK_PATH = 'https://<your-site>/setup/cf/callback';

/** what `/setup/cf?action=status` reports, so the page can say whether an account is connected */
export interface CfAccountStatus {
	connected: boolean;
	accountId?: string;
	clientId?: string;
}

/** the Deploy surface: the provisioning checklist and account connection (no deploy button) */
export function renderDeploy(status?: CfAccountStatus, notice?: string): string {
	const rows = PROVISION_STEPS.map((s) =>
		fill(ADMIN_DEPLOY_ROW_HTML, {
			LABEL: escapeHtml(s.label),
			DETAIL: escapeHtml(s.detail),
			SCRIPTABLE: s.automatable ? `${pill('ok')} scriptable` : `${pill('warn')} needs a human`
		})
	).join('');

	// the status is what makes Disconnect reachable; without it the page read the same before and
	// after connecting an account
	const connected = status?.connected
		? fill(ADMIN_DEPLOY_CONNECTED_HTML, {
				ACCOUNT: status.accountId
					? `Account <code>${escapeHtml(status.accountId)}</code>.`
					: 'The account id was not reported.',
				SCRIPT: ADMIN_DEPLOY_DISCONNECT_JS.trimEnd()
			})
		: '';

	return fill(ADMIN_DEPLOY_HTML, {
		CALLBACK: escapeHtml(CFW_CALLBACK_PATH),
		CLIENT_ID: escapeHtml(status?.clientId ?? ''),
		NOTICE: escapeHtml(notice ?? ''),
		CONNECTED: connected,
		CONNECT_SCRIPT: ADMIN_DEPLOY_CONNECT_JS.trimEnd(),
		ROWS: rows
	});
}
