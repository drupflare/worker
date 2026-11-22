import { describe, expect, it } from 'vitest';
// @ts-expect-error php-wasm ships OutputBuffer without a declaration file
import { OutputBuffer } from 'php-wasm/OutputBuffer';
import { packOutput } from '../../../src/ops/packed-output';

/**
 * PACKED_OUTPUT: stdout and stderr keep php-wasm's event boundaries, with chunked storage behind them.
 *
 * The stock `OutputBuffer` is the reference. Each case feeds the same bytes to a stock buffer and a
 * packed one and compares the event payloads, so a boundary change shows up as a plain diff.
 */

const encoder = new TextEncoder();

type Hook = (event: Event) => unknown;

function pair(maxLength: number, hook?: Hook) {
	const stockTarget = Object.assign(new EventTarget(), { onoutput: hook });
	const packedTarget = Object.assign(new EventTarget(), { onoutput: hook });
	const stock = new OutputBuffer(stockTarget, 'output', maxLength);
	const packed = new OutputBuffer(packedTarget, 'output', maxLength);
	const stockEvents: unknown[] = [];
	const packedEvents: unknown[] = [];
	stockTarget.addEventListener('output', (e) => stockEvents.push((e as CustomEvent).detail));
	packedTarget.addEventListener('output', (e) => packedEvents.push((e as CustomEvent).detail));
	const stderr = new OutputBuffer(new EventTarget(), 'error', -1);
	return { stock, packed, stderr, stockEvents, packedEvents };
}

function feed(buffer: { push: (byte: number) => void; flush: () => void }, text: string) {
	for (const byte of encoder.encode(text)) buffer.push(byte);
	buffer.flush();
}

const LONG = [
	'first line\n',
	'x'.repeat(700),
	'\n',
	'é'.repeat(300),
	'\n',
	'a tail with no newline'
].join('');

describe('PACKED_OUTPUT', () => {
	it('emits the same events as the stock buffer for newline-flushed output', () => {
		const { stock, packed, stderr, stockEvents, packedEvents } = pair(-1);
		packOutput({ PACKED_OUTPUT: '1' }, { stdout: packed, stderr });
		feed(stock, LONG);
		feed(packed, LONG);
		expect(stockEvents.length).toBeGreaterThan(2);
		expect(packedEvents).toEqual(stockEvents);
	});

	it('emits the same events as the stock buffer when a byte limit flushes it', () => {
		const { stock, packed, stderr, stockEvents, packedEvents } = pair(10);
		packOutput({ PACKED_OUTPUT: '1' }, { stdout: packed, stderr });
		feed(stock, LONG);
		feed(packed, LONG);
		expect(packedEvents).toEqual(stockEvents);
	});

	it('keeps the bytes a refusing hook returned false on, as the stock buffer does', () => {
		let calls = 0;
		const { stock, packed, stderr, stockEvents, packedEvents } = pair(-1, () =>
			++calls === 1 ? false : undefined
		);
		packOutput({ PACKED_OUTPUT: '1' }, { stdout: packed, stderr });
		feed(stock, 'one\ntwo\n');
		calls = 0;
		feed(packed, 'one\ntwo\n');
		expect(stockEvents.length).toBeGreaterThan(0);
		expect(packedEvents).toEqual(stockEvents);
	});

	it('leaves the stock buffers alone when the flag is unset', () => {
		const { packed, stderr } = pair(-1);
		packOutput({}, { stdout: packed, stderr });
		expect(Object.hasOwn(packed, 'push')).toBe(false);
		expect(Object.hasOwn(stderr, 'flush')).toBe(false);
	});
});
