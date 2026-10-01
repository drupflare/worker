import type { SourceFile } from './source-text';
import { joinSources } from './source-text';

export { bodyOf, joinSources } from './source-text';
export type { SourceFile };

const siteDo = import.meta.glob(['../../src/site-do.ts', '../../src/do/**/*.ts'], {
	query: '?raw',
	import: 'default',
	eager: true
});

const front = import.meta.glob(['../../src/site.ts', '../../src/site/**/*.ts'], {
	query: '?raw',
	import: 'default',
	eager: true
});

function gather(globbed: Record<string, string>, entry: string): SourceFile[] {
	const all = Object.entries(globbed).map(([key, text]) => ({
		file: key.replace('../../', ''),
		text
	}));
	return [
		...all.filter((f) => f.file === entry),
		...all.filter((f) => f.file !== entry).sort((a, b) => (a.file < b.file ? -1 : 1))
	];
}

/** `src/site-do.ts` and every module under `src/do`, which is where the object's code lives */
export const siteDoFiles = (): SourceFile[] => gather(siteDo, 'src/site-do.ts');

/** `src/site.ts` and every module under `src/site` */
export const frontFiles = (): SourceFile[] => gather(front, 'src/site.ts');

export const siteDoText = (): string => joinSources(siteDoFiles());

export const frontText = (): string => joinSources(frontFiles());

/** one file by repo-relative path, for an assertion about a specific declaration */
export function sourceOf(file: string): string {
	const found = [...siteDoFiles(), ...frontFiles()].find((f) => f.file === file);
	if (!found) throw new Error(`${file} is not under src/do or src/site`);
	return found.text;
}
