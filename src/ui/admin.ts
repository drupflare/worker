/**
 * The product surfaces, re-exported from `./admin/*`.
 *
 * Limits, Extend, Commands, Operate, Git and Access drive their routes. Deploy connects and
 * disconnects an account and renders the manifest a provisioner would need; no provisioning exists.
 *
 * These pages drive privileged machinery (Commands proxies to `/__ops`), so every one takes the
 * owner token, exchanged for an `HttpOnly` cookie by {@link renderLogin}. `PW_DIAGNOSTICS` is not
 * a way in.
 * @module
 */

export { OIDC_START_PATH, renderAccess, type OidcSetupRow } from './admin/access';
export {
	DRUSH_ALIASES,
	parseDrush,
	renderCommands,
	type DrushCommand,
	type OpsEntry
} from './admin/commands';
export {
	CFW_CALLBACK_PATH,
	PROVISION_STEPS,
	renderDeploy,
	type CfAccountStatus,
	type ProvisionStep
} from './admin/deploy';
export { renderExtend, type ExtendEntry } from './admin/extend';
export { renderGit, type RemoteRow } from './admin/git';
export { renderThresholds } from './admin/limits';
export { OPERATE_ACTIONS, renderOperate, type OperateAction } from './admin/operate';
export {
	ADMIN_PAGES,
	LOGIN_PATH,
	LOGOUT_PATH,
	SURFACE_PREFIX,
	escapeHtml,
	renderLogin,
	renderShell,
	type AdminPage
} from './admin/shell';
