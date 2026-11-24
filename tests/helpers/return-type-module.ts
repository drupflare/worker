/** the methods the module below has to have typed, and the files that carry them */
export const UNTYPED_METHODS = 7;
export const UNTYPED_FILES = 5;

/** the data type classes of the module, by file name under `src/Plugin/DataType` */
export const DATA_TYPE_CLASSES = [
	'ValuesViaJmesPath',
	'EntitiesViaJmesPath',
	'ValuesFromJson',
	'KeysFromJson',
	'ValuesFromFlavorJson'
] as const;

/**
 * A small module whose five data type classes override `ItemList` and `Map` the way code written
 * before core typed those methods did: untyped `offsetExists()`, `getIterator()` and `count()`.
 * Each class fatals on load against core 11.4 as it stands.
 */
export function untypedModule(
	name: string,
	root = `modules/custom/${name}`
): Record<string, string> {
	const ns = `Drupal\\${name}\\Plugin\\DataType`;
	const head = (extra = '') =>
		`<?php\n\nnamespace ${ns};\n\nuse Drupal\\Core\\TypedData\\Plugin\\DataType\\ItemList;\nuse Drupal\\Core\\TypedData\\Plugin\\DataType\\Map;\n${extra}\n`;
	const file = (cls: string, body: string) =>
		[`${root}/src/Plugin/DataType/${cls}.php`, body] as const;
	return Object.fromEntries([
		[`${root}/${name}.info.yml`, `name: Probe\ntype: module\ncore_version_requirement: ^11\n`],
		file(
			'ValuesViaJmesPath',
			`${head()}class ValuesViaJmesPath extends ItemList {\n  public function offsetExists($offset) { return isset($this->list[$offset]); }\n  public function getIterator() { return new \\ArrayIterator($this->list); }\n  public function count() { return count($this->list); }\n}\n`
		),
		file(
			'EntitiesViaJmesPath',
			`${head()}class EntitiesViaJmesPath extends ValuesViaJmesPath {\n  public function offsetExists($offset) { return parent::offsetExists($offset); }\n}\n`
		),
		file(
			'ValuesFromJson',
			`${head()}class ValuesFromJson extends ItemList {\n  public function offsetExists($offset) { return true; }\n}\n`
		),
		file(
			'KeysFromJson',
			`${head()}class KeysFromJson extends ItemList {\n  public function offsetExists($offset) { return false; }\n}\n`
		),
		file(
			'ValuesFromFlavorJson',
			`${head()}class ValuesFromFlavorJson extends Map {\n  public function getIterator() { return new \\ArrayIterator([]); }\n}\n`
		)
	]);
}

/** a class whose `count()` returns null, which the type would reject, so the rewrite names it */
export function inconsistentClass(name: string, root = `modules/custom/${name}`): [string, string] {
	return [
		`${root}/src/Plugin/DataType/NullCount.php`,
		`<?php\n\nnamespace Drupal\\${name}\\Plugin\\DataType;\n\nuse Drupal\\Core\\TypedData\\Plugin\\DataType\\ItemList;\n\nclass NullCount extends ItemList {\n  public function count() { return null; }\n}\n`
	];
}
