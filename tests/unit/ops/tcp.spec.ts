import { type ConnectOptions, type CoreSocket } from 'edgeport/core';
import { describe, expect, it } from 'vitest';
import {
	isTcpUrl,
	REDIS_READ_COMMANDS,
	REDIS_REFUSED_COMMANDS,
	resolveTcpEndpoint,
	runTcpExchange,
	TCP_PROTOCOLS,
	tcpCachedReply,
	tcpMethod,
	tcpProtocolOf,
	tcpQueueUrl
} from '../../../src/ops/tcp';
import { mockConnection, redisServer } from '../../helpers/mock-socket';

/**
 * The TCP tier, driven over a scripted socket so edgeport's real codec runs inside the test.
 *
 * The property worth protecting hardest is the PRIVILEGE one: the endpoint comes from the
 * operator's env and the credentials never reach the queue row. Both are asserted rather than
 * assumed, because the failure mode is silent -- a password in the `url` column is readable from
 * `/health` and from a drain report, and nothing about it looks wrong.
 */

const REDIS_ENV = { REDIS_URL: 'redis://cache.test:6379/2' };

describe('resolveTcpEndpoint: the endpoint is configuration, not caller input', () => {
	it('refuses by naming the var an operator has to set', () => {
		const out = resolveTcpEndpoint({}, 'redis');
		expect('refusal' in out && out.refusal).toContain('REDIS_URL');
		const syslog = resolveTcpEndpoint({}, 'syslog');
		expect('refusal' in syslog && syslog.refusal).toContain('SYSLOG_URL');
	});

	it('reads host, port, credentials and database out of the URL', () => {
		const out = resolveTcpEndpoint(
			{ REDIS_URL: 'redis://u:p%40ss@cache.test:6380/3' },
			'redis'
		);
		expect('endpoint' in out && out.endpoint).toEqual({
			protocol: 'redis',
			hostname: 'cache.test',
			port: 6380,
			tls: 'off',
			username: 'u',
			// percent-decoded, or a password containing `@` or `/` could never be expressed
			password: 'p@ss',
			db: 3
		});
	});

	it('takes TLS from the scheme, since redis has no in-band upgrade', () => {
		const plain = resolveTcpEndpoint({ REDIS_URL: 'redis://cache.test' }, 'redis');
		expect('endpoint' in plain && plain.endpoint.tls).toBe('off');
		expect('endpoint' in plain && plain.endpoint.port).toBe(6379);

		const tls = resolveTcpEndpoint({ REDIS_URL: 'rediss://cache.test' }, 'redis');
		expect('endpoint' in tls && tls.endpoint.tls).toBe('implicit');
		expect('endpoint' in tls && tls.endpoint.port).toBe(6380);
	});

	it('defaults syslog to 514, and to 6514 for RFC 5425 TLS', () => {
		const plain = resolveTcpEndpoint({ SYSLOG_URL: 'syslog://logs.test' }, 'syslog');
		expect('endpoint' in plain && plain.endpoint.port).toBe(514);
		const tls = resolveTcpEndpoint({ SYSLOG_URL: 'syslogs://logs.test' }, 'syslog');
		expect('endpoint' in tls && tls.endpoint.port).toBe(6514);
	});

	it('refuses a URL whose scheme belongs to the other protocol', () => {
		const out = resolveTcpEndpoint({ SYSLOG_URL: 'redis://cache.test' }, 'syslog');
		expect('refusal' in out && out.refusal).toContain('not syslog');
	});

	it('refuses a scheme it does not speak, and a value that is not a URL at all', () => {
		expect('refusal' in resolveTcpEndpoint({ REDIS_URL: 'not a url' }, 'redis')).toBe(true);
		const scheme = resolveTcpEndpoint({ REDIS_URL: 'http://cache.test' }, 'redis');
		expect('refusal' in scheme && scheme.refusal).toContain('scheme must be');
	});

	// blocked outbound on Workers, so it is refused where the operator can act on it rather than
	// surfacing hours later as a connect timeout in a drain report
	it('refuses port 25 by naming the platform, not the endpoint', () => {
		const out = resolveTcpEndpoint({ SYSLOG_URL: 'syslog://logs.test:25' }, 'syslog');
		expect('refusal' in out && out.refusal).toContain('blocked outbound on Workers');
	});

	it('refuses a port that is not a port', () => {
		const out = resolveTcpEndpoint({ REDIS_URL: 'redis://cache.test:99999' }, 'redis');
		expect('refusal' in out).toBe(true);
	});
});

describe('the queue url', () => {
	it('names the endpoint and carries no credentials', () => {
		const out = resolveTcpEndpoint(
			{ REDIS_URL: 'redis://u:hunter2@cache.test:6379/1' },
			'redis'
		);
		if (!('endpoint' in out)) throw new Error('expected an endpoint');
		const url = tcpQueueUrl(out.endpoint);
		expect(url).toBe('tcp+redis://cache.test:6379/');
		// the row is echoed by /health and by every drain report, so this is the assertion that
		// keeps a password out of a diagnostic surface
		expect(url).not.toContain('hunter2');
		expect(url).not.toContain('u:');
	});

	it('round-trips through the drain dispatch', () => {
		for (const protocol of TCP_PROTOCOLS) {
			const url = `tcp+${protocol}://h:1/`;
			expect(isTcpUrl(url)).toBe(true);
			expect(tcpProtocolOf(url)).toBe(protocol);
		}
		expect(isTcpUrl('https://example.com/')).toBe(false);
		expect(tcpProtocolOf('https://example.com/')).toBeNull();
		expect(tcpProtocolOf('tcp+memcache://h:1/')).toBeNull();
	});
});

describe("tcpMethod: the deferred tier's budget, borrowed rather than reinvented", () => {
	it('gives a read the GET budget and everything else the POST one', () => {
		expect(tcpMethod('redis', 'get')).toBe('GET');
		expect(tcpMethod('redis', 'HGETALL')).toBe('GET');
		// not idempotent: a replayed INCR is a different outcome, not a slower success
		expect(tcpMethod('redis', 'INCR')).toBe('POST');
		expect(tcpMethod('redis', 'SET')).toBe('POST');
		expect(tcpMethod('syslog', 'anything')).toBe('POST');
	});

	it('keeps the read set and the refused set disjoint', () => {
		const both = [...REDIS_READ_COMMANDS].filter((c) => REDIS_REFUSED_COMMANDS.has(c));
		expect(both).toEqual([]);
	});
});

describe('runTcpExchange: the real client over a scripted socket', () => {
	it('runs a redis command and returns the reply as JSON', async () => {
		const { connect, script } = redisServer({ reply: '$5\r\nhello' });
		const out = await runTcpExchange(
			'tcp+redis://cache.test:6379/',
			JSON.stringify(['GET', 'greeting']),
			REDIS_ENV,
			{ connect }
		);
		expect(out.status).toBe(200);
		expect(JSON.parse(out.body)).toBe('hello');
		// the handshake ran and the command reached the server verbatim
		expect(script.commands.at(-1)).toEqual(['GET', 'greeting']);
		expect(script.dialled?.hostname).toBe('cache.test');
	});

	it('selects the database the URL names, so a shared server is not shared by accident', async () => {
		const { connect, script } = redisServer();
		await runTcpExchange('tcp+redis://cache.test:6379/', '["GET","k"]', REDIS_ENV, { connect });
		expect(script.commands.some((c) => c[0]?.toUpperCase() === 'SELECT' && c[1] === '2')).toBe(
			true
		);
	});

	// a RESP error is the SERVER answering, so it must not look like a transport failure the drain
	// would retry against a server that already made its decision
	it('reports a server error as 502 rather than throwing', async () => {
		const { connect } = redisServer({ reply: '-WRONGTYPE not a string' });
		const out = await runTcpExchange('tcp+redis://cache.test:6379/', '["GET","k"]', REDIS_ENV, {
			connect
		});
		expect(out.status).toBe(502);
		expect(out.body).toContain('WRONGTYPE');
	});

	it('refuses an administrative command before it dials anything', async () => {
		let dialled = 0;
		const connect = async (): Promise<CoreSocket> => {
			dialled++;
			throw new Error('should not dial');
		};
		const out = await runTcpExchange(
			'tcp+redis://cache.test:6379/',
			'["FLUSHALL"]',
			REDIS_ENV,
			{ connect }
		);
		expect(out.status).toBe(403);
		expect(dialled).toBe(0);
	});

	it('refuses when the protocol is not configured, naming the var', async () => {
		const out = await runTcpExchange(
			'tcp+redis://cache.test:6379/',
			'["GET","k"]',
			{},
			{
				connect: async () => {
					throw new Error('should not dial');
				}
			}
		);
		expect(out.status).toBe(503);
		expect(out.body).toContain('REDIS_URL');
	});

	it("refuses a url that is not this tier's, and a body that is not JSON", async () => {
		const deps = {
			connect: async (): Promise<CoreSocket> => {
				throw new Error('should not dial');
			}
		};
		expect((await runTcpExchange('https://example.com/', '[]', REDIS_ENV, deps)).status).toBe(
			400
		);
		expect(
			(await runTcpExchange('tcp+redis://cache.test:6379/', 'not json', REDIS_ENV, deps))
				.status
		).toBe(400);
		expect(
			(await runTcpExchange('tcp+redis://cache.test:6379/', '[]', REDIS_ENV, deps)).status
		).toBe(400);
	});

	it('ships a syslog record and answers 204, because the protocol never replies', async () => {
		const conn = mockConnection();
		let dialled: ConnectOptions | null = null;
		const connect = async (opts: ConnectOptions): Promise<CoreSocket> => {
			dialled = opts;
			return conn.socket;
		};
		const received = conn.server.readFrame();

		const out = await runTcpExchange(
			'tcp+syslog://logs.test:514/',
			JSON.stringify({ message: 'a node was saved', severity: 'info' }),
			{ SYSLOG_URL: 'syslog://logs.test:514', SYSLOG_APP_NAME: 'drupal' },
			{ connect }
		);
		expect(out.status).toBe(204);
		expect(out.body).toBe('');
		expect(dialled).not.toBeNull();

		// the real RFC 5424 record, read out of its RFC 6587 octet-counted frame
		const record = await received;
		expect(record).toContain('a node was saved');
		expect(record).toContain('drupal');
		// severity `info` (6) at the default facility `user` (1) is PRI 14
		expect(record.startsWith('<14>1 ')).toBe(true);
	});
});

/**
 * The seam between the exchange cache and PHP. Every mock in the gate answers 200, so this branch
 * had never run: a RESP error sits in the body of a 502 and `CfwTcp::redis()` reads `error`.
 */
describe('tcpCachedReply: the server sentence has to survive the cache', () => {
	it('passes a 200 body through with no error field', () => {
		expect(tcpCachedReply(200, '"OK"')).toEqual({ ok: true, status: 200, body: '"OK"' });
	});

	it('copies a refusal body into error, where CfwTcp reads it', () => {
		const message = 'ERR value is not an integer or out of range';
		expect(tcpCachedReply(502, message)).toEqual({
			ok: false,
			status: 502,
			body: message,
			error: message
		});
	});

	it('keeps the body as well, so a caller that reads either one is served', () => {
		const out = tcpCachedReply(503, 'no REDIS_URL is configured');
		expect(out.body).toBe(out.error);
	});

	// the control: answering `ok` for everything would pass the first case and say nothing
	it('treats every non-200 as a refusal, not just 502', () => {
		expect(tcpCachedReply(403, 'FLUSHALL is not reachable').ok).toBe(false);
		expect(tcpCachedReply(400, 'queued body is not JSON').error).toBe(
			'queued body is not JSON'
		);
	});
});
