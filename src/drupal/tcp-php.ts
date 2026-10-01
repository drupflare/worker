import { TCP_LIVE_PHP } from '../site/generated/assets';
import { phpRender } from '../util/php';
import { HOST_HELPERS } from './site-php';

/** what one `tcpLive()` run is asked to do */
export interface TcpLiveOptions {
	protocol: 'redis' | 'syslog';
	/** redis: the command and its arguments */
	args?: string[];
	/** syslog: the record text */
	message?: string;
}

/**
 * Drives the TCP tier through `CfwTcp`, so a run exercises the module's own caller rather than
 * `Host::call()`. No kernel (`Host` needs only the autoloader); it runs three times per round trip.
 */
export function tcpLive(options: TcpLiveOptions): string {
	const payload = JSON.stringify({
		protocol: options.protocol,
		args: options.args ?? [],
		message: options.message ?? ''
	});
	return phpRender(TCP_LIVE_PHP, {
		HOST_HELPERS,
		PAYLOAD: JSON.stringify(payload)
	});
}
