import type { SitePhpDurableObject } from '../../site-do';
import { oidc, oidcsetup, ownercheck } from './auth';
import {
	ai,
	backend,
	capability,
	driver,
	drupal,
	httpdrain,
	mb,
	nativefetch,
	php,
	probe,
	sql,
	tcp
} from './diagnostics';
import { armfill, assembleRoute, bump, fill, invalidate, plan, shell, sweep } from './fill';
import { bootphase, heap, opcache } from './heap';
import {
	deployment,
	firstrun,
	health,
	migrate,
	ops,
	originRoute,
	reconcile,
	updb
} from './lifecycle';
import { cfoauth, mailonboard } from './mail';
import { exportRoute, pitr, restore } from './owner';
import {
	enable,
	filebytes,
	files,
	git,
	githook,
	install,
	installable,
	modify,
	moduleasset
} from './packages';
import { replica } from './replica';
import { queue, serve, serveStats } from './serve';
import { mirror, savenode, txnprobe, writes, writeworkload } from './writes';

/** a Durable Object route handler */
export type Route = (site: SitePhpDurableObject, request: Request, url: URL) => Promise<Response>;

/** the object's `/__` routes by path */
export const ROUTES: Record<string, Route> = {
	'/__backend': backend,
	'/__opcache': opcache,
	'/__php': php,
	'/__heap': heap,
	'/__bootphase': bootphase,
	'/__probe': probe,
	'/__origin': originRoute,
	'/__deployment': deployment,
	'/__health': health,
	'/__updb': updb,
	'/__reconcile': reconcile,
	'/__mailonboard': mailonboard,
	'/__oidc': oidc,
	'/__oidcsetup': oidcsetup,
	'/__cfoauth': cfoauth,
	'/__git': git,
	'/__modify': modify,
	'/__githook': githook,
	'/__ownercheck': ownercheck,
	'/__pitr': pitr,
	'/__restore': restore,
	'/__export': exportRoute,
	'/__installable': installable,
	'/__install': install,
	'/__replica': replica,
	'/__writes': writes,
	'/__mirror': mirror,
	'/__moduleasset': moduleasset,
	'/__filebytes': filebytes,
	'/__files': files,
	'/__enable': enable,
	'/__ops': ops,
	'/__firstrun': firstrun,
	'/__capability': capability,
	'/__nativefetch': nativefetch,
	'/__tcp': tcp,
	'/__ai': ai,
	'/__httpdrain': httpdrain,
	'/__mb': mb,
	'/__serve': serve,
	'/__savenode': savenode,
	'/__writeworkload': writeworkload,
	'/__invalidate': invalidate,
	'/__bump': bump,
	'/__fill': fill,
	'/__plan': plan,
	'/__assemble': assembleRoute,
	'/__shell': shell,
	'/__sweep': sweep,
	'/__queue': queue,
	'/__serve-stats': serveStats,
	'/__migrate': migrate,
	'/__armfill': armfill,
	'/__txnprobe': txnprobe,
	'/__sql': sql,
	'/__driver': driver,
	'/__drupal': drupal
};
