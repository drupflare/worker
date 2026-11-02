import { renderTemplate } from '../../util/template';
import { EXTENSIONS_FIX_PHP } from '../generated/assets';
import { EXTENSION_CATALOG, EXTENSION_TABLE } from './extension-table';

const phpList = (names: readonly string[]): string => `[${names.map((n) => `'${n}'`).join(', ')}]`;

/** the PHP that fills the table the stand-ins answer from */
export function extensionTablePhp(table: Readonly<Record<string, string[]>> = EXTENSION_TABLE) {
	const rows = Object.entries(table).map(([name, funcs]) => `'${name}' => ${phpList(funcs)}`);
	return (
		`$GLOBALS['__cfw_ext_shims'] = [${rows.join(', ')}];\n` +
		`\t$GLOBALS['__cfw_ext_catalog'] = ${phpList(EXTENSION_CATALOG)};`
	);
}

/** `extension_loaded()`, `get_loaded_extensions()` and `get_extension_funcs()` over the table */
export const EXTENSIONS_FIX = renderTemplate(EXTENSIONS_FIX_PHP, {
	EXTENSION_TABLE: extensionTablePhp()
});
