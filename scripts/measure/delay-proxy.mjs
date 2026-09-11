/**
 * A TCP proxy that adds a fixed one-way delay in each direction, so the VPS arm can be measured
 * with a real network between the client and the host.
 *
 * WHY NOT `tc netem`: it is not in the nginx image and it needs NET_ADMIN on the container. This
 * needs neither, and it delays real bytes on a real socket rather than adding a number to a result
 * afterwards. `--rtt` on `host-verdict.ts` does the arithmetic version, and the two answer different
 * questions: the arithmetic one says what the result WOULD be, this one lets the connection
 * actually pay it -- so TCP handshakes, TLS if any, and request pipelining all feel it, which is
 * where an arithmetic RTT understates.
 *
 * ONE-WAY, so the round trip is twice `--ms`. A request pays it on the way out and the response
 * pays it on the way back, which is what a round trip IS; adding the full RTT in each direction is
 * the classic doubling error and it would overstate the term by 2x.
 *
 * THE DELAY IS PER FLIGHT, not per chunk, and the first version got this wrong in a way that
 * INFLATED the result. It delayed every chunk and its docblock claimed that was "exactly as a real
 * path does". It is not: a real path PIPELINES segments, so a multi-segment response pays about one
 * round trip to first byte and then streams at the bandwidth. Delaying each chunk charges one RTT
 * per segment, so a large response pays N times over -- measured, `auth-admin` on the VPS arm went
 * 627 ms at a 40 ms injection to 1,454 ms at 82 ms, far more than the 42 ms difference can explain.
 *
 * So a chunk arriving within {@link FLIGHT_MS} of the previous one is forwarded without additional
 * delay: it is part of the same flight and a real network would already have it in transit. A chunk
 * after a gap starts a new flight and pays the latency, which is what a request/response turn is.
 *
 * usage: node delay-proxy.mjs --listen=8098 --target=127.0.0.1:8099 --ms=20
 */

import { connect, createServer } from 'node:net';

const arg = (name, fallback) => {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.split('=').slice(1).join('=') : fallback;
};

/**
 * How close two chunks must be to count as one flight, in milliseconds.
 *
 * 5 ms. Segments of one response leave the server back to back on a loopback socket, so they arrive
 * well under this; a genuinely new request/response turn is separated by at least the server's own
 * service time, which on either arm here is longer. It is a heuristic and it is the one term in
 * this instrument that is chosen rather than measured.
 */
const FLIGHT_MS = 5;

const LISTEN = Number(arg('listen', '8098'));
const [HOST, PORT] = arg('target', '127.0.0.1:8099').split(':');
const MS = Number(arg('ms', '20'));

if (!Number.isFinite(MS) || MS < 0) {
	console.error('--ms must be a non-negative number of milliseconds (one way)');
	process.exit(2);
}

/**
 * Forwards with a delay, preserving ORDER.
 *
 * A naive `setTimeout(() => dst.write(chunk), MS)` per chunk reorders under load, because two
 * timers armed in the same tick can fire in either order once the event loop is busy -- and a
 * reordered TCP stream is a corrupted HTTP response, which would read as a host defect. Each socket
 * pair keeps one promise chain, so chunk N+1 cannot be written before chunk N.
 */
function pipeDelayed(src, dst) {
	let chain = Promise.resolve();
	let lastSeen = 0;
	src.on('data', (chunk) => {
		const now = Date.now();
		// a chunk hard on the heels of the previous one is the same flight; a real network already
		// has it in transit and charging it another round trip is how a large response paid N times
		const wait = now - lastSeen <= FLIGHT_MS ? 0 : MS;
		lastSeen = now;
		chain = chain.then(
			() =>
				new Promise((resolve) => {
					if (wait === 0) {
						if (!dst.destroyed) dst.write(chunk);
						resolve();
						return;
					}
					setTimeout(() => {
						if (!dst.destroyed) dst.write(chunk);
						resolve();
					}, wait);
				})
		);
	});
	src.on('end', () => {
		chain = chain.then(() => {
			if (!dst.destroyed) dst.end();
		});
	});
	src.on('error', () => dst.destroy());
}

const server = createServer((client) => {
	const upstream = connect({ host: HOST, port: Number(PORT) });
	upstream.on('error', () => client.destroy());
	client.on('error', () => upstream.destroy());
	pipeDelayed(client, upstream);
	pipeDelayed(upstream, client);
});

server.listen(LISTEN, '127.0.0.1', () => {
	console.error(
		`[delay-proxy] 127.0.0.1:${LISTEN} -> ${HOST}:${PORT}, ${MS} ms each way ` +
			`(${MS * 2} ms round trip)`
	);
});
