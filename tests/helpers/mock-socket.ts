import {
	StreamFramedReader,
	StreamFramedWriter,
	type ConnectOptions,
	type CoreSocket,
	type FramedReader,
	type FramedWriter
} from 'edgeport/core';

/**
 * A `CoreSocket` backed by two in-memory streams, plus the server end a spec scripts against it.
 *
 * The SMTP transport is the one lane whose correctness lives in a wire protocol rather than in a
 * request body, and `cloudflare:sockets` cannot be opened from the gate. Replacing the SOCKET rather
 * than the sender keeps every line of edgeport's client -- greeting, EHLO, STARTTLS, AUTH, MAIL
 * FROM/RCPT TO/DATA, dot-stuffing -- and every line of `sendViaSmtp()` in the test, which is the
 * difference between proving a transport and proving a stub.
 *
 * Modelled on `test/mock-socket.ts` in the `edgeport` checkout, using the framing classes the
 * package publishes rather than a copy of them.
 *
 * Not a `.spec.ts`, so vitest does not collect it, and `tests/**` is excluded from coverage.
 */

/** the server half of a mock connection, driven by the spec */
export type MockServerEnd = {
	readLine(timeoutMs?: number): Promise<string>;
	writeLine(line: string): Promise<void>;
	close(): Promise<void>;
};

export type MockConnection = {
	socket: CoreSocket;
	server: MockServerEnd;
	/** how many times the client asked for a TLS upgrade; the STARTTLS assertion reads this */
	startTlsCount(): number;
};

class MockCoreSocket implements CoreSocket {
	reader: FramedReader;
	writer: FramedWriter;
	tlsCount = 0;
	readonly closed: Promise<void>;
	#closed = false;
	readonly #onClose: () => void;

	constructor(
		reader: FramedReader,
		writer: FramedWriter,
		closed: Promise<void>,
		onClose: () => void
	) {
		this.reader = reader;
		this.writer = writer;
		this.closed = closed;
		this.#onClose = onClose;
	}

	// the same in-memory channel keeps flowing; there is no real TLS to negotiate here
	startTls(): CoreSocket {
		this.tlsCount++;
		return this;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#onClose();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}
}

/** one connected mock socket and the server end that talks to it */
export function mockConnection(): MockConnection {
	// a generous buffer so `server.writeLine()` resolves before the client reads; the default
	// highWaterMark of 0 deadlocks a write-then-read script
	const strategy = { highWaterMark: 1 << 20 };
	const clientToServer = new TransformStream<Uint8Array, Uint8Array>(
		undefined,
		strategy,
		strategy
	);
	const serverToClient = new TransformStream<Uint8Array, Uint8Array>(
		undefined,
		strategy,
		strategy
	);

	let resolveClosed!: () => void;
	const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

	const socket = new MockCoreSocket(
		new StreamFramedReader(serverToClient.readable),
		new StreamFramedWriter(clientToServer.writable),
		closed,
		resolveClosed
	);

	const serverReader = new StreamFramedReader(clientToServer.readable);
	const serverWriter = new StreamFramedWriter(serverToClient.writable);

	return {
		socket,
		server: {
			readLine: (timeoutMs) => serverReader.readLine(timeoutMs),
			writeLine: (line) => serverWriter.writeLine(line),
			close: () => serverWriter.close()
		},
		startTlsCount: () => socket.tlsCount
	};
}

/** what one scripted exchange recorded off the wire */
export type SmtpScript = {
	/** every command line the client sent, in order */
	commands: string[];
	/** the DATA payload, decoded, without its terminating dot */
	body: string;
	/** the `connect()` options the transport dialled with */
	dialled: ConnectOptions | null;
	/** how many STARTTLS upgrades the client performed */
	upgrades: number;
};

/**
 * A minimal SMTP submission server, and the `connect` a spec passes as the transport dependency.
 *
 * Scripted rather than exhaustive: it answers the codes a successful submission needs, so the client
 * runs its real state machine against it. `failOn` makes one command answer 5xx, which is how the
 * failure branch is reached without a network.
 */
export function smtpServer(
	options: { failOn?: string; greeting?: string; noStartTls?: boolean } = {}
): { connect: (opts: ConnectOptions) => Promise<CoreSocket>; script: SmtpScript } {
	const script: SmtpScript = { commands: [], body: '', dialled: null, upgrades: 0 };

	const connect = async (opts: ConnectOptions): Promise<CoreSocket> => {
		script.dialled = opts;
		const conn = mockConnection();
		void (async () => {
			try {
				await conn.server.writeLine(options.greeting ?? '220 mock.test ESMTP');
				for (;;) {
					const line = await conn.server.readLine();
					script.commands.push(line);
					// read after each command, so the count is current by the time the spec looks
					script.upgrades = conn.startTlsCount();
					const verb = line.split(/[\s:]/)[0]?.toUpperCase() ?? '';

					if (
						options.failOn &&
						line.toUpperCase().startsWith(options.failOn.toUpperCase())
					) {
						await conn.server.writeLine('550 mock refused it');
						continue;
					}

					if (verb === 'EHLO') {
						await conn.server.writeLine('250-mock.test');
						if (!options.noStartTls) await conn.server.writeLine('250-STARTTLS');
						await conn.server.writeLine('250-AUTH PLAIN LOGIN');
						await conn.server.writeLine('250 SIZE 10485760');
					} else if (verb === 'STARTTLS') {
						await conn.server.writeLine('220 go ahead');
					} else if (verb === 'AUTH') {
						await conn.server.writeLine('235 authenticated');
					} else if (verb === 'MAIL' || verb === 'RCPT') {
						await conn.server.writeLine('250 ok');
					} else if (verb === 'DATA') {
						await conn.server.writeLine('354 send it');
						const lines: string[] = [];
						for (;;) {
							const dataLine = await conn.server.readLine();
							if (dataLine === '.') break;
							lines.push(dataLine);
						}
						script.body = lines.join('\n');
						await conn.server.writeLine('250 queued as mock-1');
					} else if (verb === 'QUIT') {
						await conn.server.writeLine('221 bye');
						return;
					} else {
						await conn.server.writeLine('500 unknown');
					}
				}
			} catch {
				// the client closed mid-script, which is how a QUIT-less teardown ends
			}
		})();
		return conn.socket;
	};

	return { connect, script };
}
