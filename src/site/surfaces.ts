import { SURFACE_PREFIX } from '../ui/admin';
import { renderAdmin } from './admin';
import { deploymentRoute, settingsRoute } from './deployment';
import { runFillWindow } from './fill-window';
import type { FrontContext } from './types';

/** The warm window driver, answered in the Worker because an object cannot message itself. */
export async function fillWindowRoute(f: FrontContext): Promise<Response | undefined> {
	const { url, env, site } = f;
	// Worker-side: the driver must live outside the object (the CPU budget resets on an incoming
	// message and an object cannot send itself one)
	if (url.pathname === '/fillwindow') {
		return Response.json(
			await runFillWindow(env, site, {
				maxFills: url.searchParams.get('max')
					? Number(url.searchParams.get('max'))
					: undefined,
				wallBudgetMs: url.searchParams.get('wall')
					? Number(url.searchParams.get('wall'))
					: undefined
			})
		);
	}
	return undefined;
}

/** The product surfaces, settings and deployment documents and the fleet inventory. */
export async function surfaceRoute(f: FrontContext): Promise<Response | undefined> {
	const { request, url, env, ownerToken, stubOf } = f;
	// #region the product surfaces
	// `/fleet` and `/settings` have no `DO_ROUTE` entry: D1 and `CONFIG_KV` are front-worker
	// bindings (a hop would spend a request), and `/fleet` falls through to a 404 without its match
	if (url.pathname === '/settings') {
		return await settingsRoute(request, url, env);
	}
	if (url.pathname === '/deployment') {
		return await deploymentRoute(request, url, env);
	}

	if (url.pathname.startsWith(SURFACE_PREFIX) || url.pathname === '/fleet') {
		return await renderAdmin(request, url, env, stubOf(), ownerToken);
	}
	// #endregion
	return undefined;
}
