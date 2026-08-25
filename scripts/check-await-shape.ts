import { Glob } from 'bun';

/**
 * Finds exported functions that are `await`ed at a call site but cannot return a promise.
 *
 * `await` on a non-thenable is legal and does nothing except cost a microtask, so nothing fails and
 * nothing warns. What it costs is READING: every caller of `await resolveThing()` now believes
 * `resolveThing` does I/O, and the next person to touch it preserves an asynchrony that was never
 * there. The reverse case -- a function that genuinely returns a promise -- is fine unmarked, since
 * `function f(): Promise<T>` is a legitimate way to write one, so only the no-op await is reported.
 *
 *   bun scripts/check-await-shape.ts          # report
 *   bun scripts/check-await-shape.ts --quiet  # exit code only
 *
 * Deterministic by construction: same tree in, same list out. It reads declarations rather than
 * types, so a function whose return type is inferred is reported as `unknown` and skipped rather
 * than guessed at -- an unknown is not a finding.
 */

const roots = ['src', 'scripts', 'tests'];
const quiet = process.argv.includes('--quiet');

/** a declaration that can produce a thenable, so awaiting it is meaningful */
const THENABLE = /^\s*(Promise|PromiseLike|Thenable)\s*</;

type Decl = { name: string; file: string; line: number; async: boolean; returns: string | null };

const declarations = new Map<string, Decl>();
const files: string[] = [];
for (const root of roots) {
	for await (const file of new Glob('**/*.ts').scan({ cwd: root, absolute: true })) {
		files.push(file);
	}
}

// `export [async] function name(...)` with an optional return annotation; the annotation is read
// only when it is on the same line as the closing paren, which is how this repo writes them
const DECL = /^export\s+(async\s+)?function\s+([A-Za-z0-9_$]+)\s*(?:<[^>]*>)?\s*\(/;

for (const file of files) {
	const text = await Bun.file(file).text();
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		const m = DECL.exec(line);
		if (!m) continue;
		const name = m[2] as string;
		// the return annotation sits after the parameter list, which may span lines
		let tail = '';
		for (let j = i; j < Math.min(lines.length, i + 40); j++) {
			tail += lines[j];
			if (/\)\s*:\s*[^=]/.test(lines[j] as string) || /\)\s*\{/.test(lines[j] as string))
				break;
		}
		const ret = /\)\s*:\s*([^{]+?)\s*\{/.exec(tail);
		declarations.set(name, {
			name,
			file,
			line: i + 1,
			async: Boolean(m[1]),
			returns: ret ? (ret[1] as string).trim() : null
		});
	}
}

/**
 * Whether the call opening at `open` is followed by a member access, i.e. `f(...)` in `f(...).g()`.
 *
 * @param open index of the call's `(`
 */
function chained(line: string, open: number): boolean {
	let depth = 0;
	for (let i = open; i < line.length; i++) {
		const ch = line[i];
		if (ch === '(') depth++;
		else if (ch === ')') {
			depth--;
			if (depth === 0)
				return line
					.slice(i + 1)
					.trimStart()
					.startsWith('.');
		}
	}
	// the call spans lines, so the chain cannot be decided from this line alone; not a finding
	return true;
}

type Finding = { callee: string; at: string; declaredAt: string; returns: string };
const findings: Finding[] = [];

for (const file of files) {
	const text = await Bun.file(file).text();
	const lines = text.split('\n');
	// a same-file declaration shadows the exported one of that name; the map is keyed by name alone,
	// so without this an unrelated export elsewhere resolves the call and reports a correct line
	const localFns = new Set(
		[...text.matchAll(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)].map(
			(d) => d[1] as string
		)
	);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		for (const m of line.matchAll(/\bawait\s+([A-Za-z0-9_$]+)\s*\(/g)) {
			const callee = m[1] as string;
			// `await f(x).g()` awaits `g()`, not `f()`. Taking the first identifier after `await`
			// reported three correct call sites of a synchronous factory whose METHOD is async --
			// and a checker that reports a correct line is worse than no checker, because the fix
			// someone applies is to break it
			if (chained(line, (m.index ?? 0) + m[0].length - 1)) continue;
			const decl = declarations.get(callee);
			if (!decl || decl.async) continue;
			if (decl.file !== file && localFns.has(callee)) continue;
			// no annotation means the return type is inferred; unknown is not a finding
			if (decl.returns === null) continue;
			if (THENABLE.test(decl.returns)) continue;
			findings.push({
				callee,
				at: `${file.replace(`${process.cwd()}/`, '')}:${i + 1}`,
				declaredAt: `${decl.file.replace(`${process.cwd()}/`, '')}:${decl.line}`,
				returns: decl.returns
			});
		}
	}
}

if (!quiet) {
	console.log(`scanned ${files.length} files, ${declarations.size} exported functions`);
	if (findings.length === 0) {
		console.log('no awaited non-thenable exports');
	} else {
		for (const f of findings) {
			console.log(`${f.at}  await ${f.callee}()  -> ${f.returns}   declared ${f.declaredAt}`);
		}
	}
}
process.exit(findings.length === 0 ? 0 : 1);
