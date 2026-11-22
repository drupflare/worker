/** the slice of php-wasm's OutputBuffer that packing reads and replaces */
export type PhpOutputBuffer = {
	push: (byte: number) => void;
	flush: () => void;
	maxLength: number;
	decoder: TextDecoder;
	eventType: string;
	target: EventTarget & Record<string, unknown>;
};

const CHUNK_BYTES = 65_536;
const FIRST_CHUNK_BYTES = 256;

/** packs the stdout and stderr buffers when PACKED_OUTPUT is 1; the events they emit do not change */
export function packOutput(
	env: { PACKED_OUTPUT?: string },
	buffers: { stdout: PhpOutputBuffer; stderr: PhpOutputBuffer }
): void {
	if (env.PACKED_OUTPUT !== '1') return;
	pack(buffers.stdout);
	pack(buffers.stderr);
}

function pack(buffer: PhpOutputBuffer): void {
	const chunks: Uint8Array[] = [];
	// the first chunk of the last flush, reused so a steady stream does not allocate per line
	let spare: Uint8Array | undefined;
	let used = 0;
	let length = 0;
	const flush = () => {
		if (!length) return;
		const flat = new Uint8Array(length);
		let at = 0;
		for (let i = 0; i < chunks.length; i++) {
			const bytes = i === chunks.length - 1 ? chunks[i]!.subarray(0, used) : chunks[i]!;
			flat.set(bytes, at);
			at += bytes.length;
		}
		const detail = [buffer.decoder.decode(flat)];
		const event = new CustomEvent(buffer.eventType, { detail });
		const handler = buffer.target['on' + buffer.eventType];
		if (typeof handler === 'function' && handler(event) === false) return;
		if (!buffer.target.dispatchEvent(event)) return;
		spare = chunks[0];
		chunks.length = 0;
		used = 0;
		length = 0;
	};
	buffer.push = (byte: number) => {
		const last = chunks[chunks.length - 1];
		if (!last || used === last.length) {
			const size = last
				? Math.min(CHUNK_BYTES, last.length * 2)
				: Math.min(CHUNK_BYTES, FIRST_CHUNK_BYTES);
			chunks.push(!last && spare ? spare : new Uint8Array(size));
			spare = undefined;
			used = 0;
		}
		chunks[chunks.length - 1]![used++] = byte;
		length++;
		const lineEnd = buffer.maxLength === -1 && byte === 10;
		const full = buffer.maxLength >= 0 && length >= buffer.maxLength;
		if (lineEnd || full) flush();
	};
	buffer.flush = flush;
}
