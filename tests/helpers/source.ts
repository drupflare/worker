import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SourceFile } from './source-text';
import { joinSources } from './source-text';

export { bodyOf, joinSources } from './source-text';
export type { SourceFile };

const ROOT = resolve(import.meta.dirname, '../..');

function gather(entry: string, dir: string): SourceFile[] {
	const nested = readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
		.filter((name) => name.endsWith('.ts'))
		.sort()
		.map((name) => join(dir, name));
	return [entry, ...nested].map((file) => ({
		file,
		text: readFileSync(join(ROOT, file), 'utf8')
	}));
}

/** `src/site-do.ts` and every module under `src/do`, which is where the object's code lives */
export const siteDoFiles = (): SourceFile[] => gather('src/site-do.ts', 'src/do');

/** `src/site.ts` and every module under `src/site` */
export const frontFiles = (): SourceFile[] => gather('src/site.ts', 'src/site');

export const siteDoText = (): string => joinSources(siteDoFiles());

export const frontText = (): string => joinSources(frontFiles());

/** one file by repo-relative path, for an assertion about a specific declaration */
export function sourceOf(file: string): string {
	return readFileSync(join(ROOT, file), 'utf8');
}
