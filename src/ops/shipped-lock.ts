import lockText from '../../composer.lock' with { type: 'text' };
import { shippedLock } from './lock-map';

const shipped = shippedLock(JSON.parse(lockText));

/** name -> version for every package the root `composer.lock` pins */
export const SHIPPED_LOCK_VERSIONS: Record<string, string> = shipped.versions;

/** virtual packages the locked ones provide or replace, which a requirement is met by without a fetch */
export const SHIPPED_PROVIDES: Record<string, string> = shipped.provides;

/** the Drupal core version these packages were locked against */
export const SHIPPED_CORE_VERSION: string = shipped.core;
