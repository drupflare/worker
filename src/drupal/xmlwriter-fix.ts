/**
 * A pure-PHP `XMLWriter`, because the build has no `ext-xmlwriter` and one contrib module SUBCLASSES
 * the class rather than calling functions.
 *
 * WHY A CLASS AND NOT A SHIM SET. `simple_sitemap`'s `SitemapWriter extends \XMLWriter`, so a set of
 * `xmlwriter_*()` functions could not satisfy it -- the parent class has to exist at the moment the
 * subclass is compiled. That is also why this is declared as early as `MB_FIX`.
 *
 * THE SURFACE IS TEN METHODS, COUNTED RATHER THAN GUESSED. Inventoried against simple_sitemap 4.2.1:
 * `openMemory`, `setIndent`, `startDocument`, `writePI`, `writeComment`, `startElement`,
 * `writeAttribute`, `writeElement`, `endElement`, `endDocument`, `outputMemory`. `text()` is public
 * as well because it is the standard name for what `writeElement` does internally and costs nothing.
 * Nothing in the module calls `writeRaw`, `writeCdata`, `openUri`, `flush`, `startAttribute`,
 * `writeDtd` or the namespace variants, so none is here -- an unused surface is the
 * tested-but-never-called failure, and a partial one that LOOKS complete is worse.
 *
 * `if (!class_exists(...))` rather than `eval()`, the `zlib-fix` pattern: a conditional class
 * declaration binds at runtime, so this compiles clean on a build that HAS the extension and the
 * branch simply never runs. That is what lets `tests/node/php-fragments.spec.ts` lint the body,
 * which an `eval`'d string defeats.
 */
export const XMLWRITER_FIX = String.raw`
if (!class_exists('XMLWriter', false)) {
	/**
	 * Enough of libxml's writer to generate a sitemap, and no more.
	 *
	 * Not final: it exists so a contrib class can extend it.
	 */
	class XMLWriter {
		/** the document built so far */
		private $cfwBuf = '';

		/** open elements, innermost last, each carrying what it has already been given */
		private $cfwStack = [];

		/** whether the innermost start tag is still open and can still take attributes */
		private $cfwOpen = false;

		/** whether to pretty-print, and with what */
		private $cfwIndent = false;
		private $cfwIndentString = ' ';

		public function openMemory(): bool {
			$this->cfwBuf = '';
			$this->cfwStack = [];
			$this->cfwOpen = false;
			return true;
		}

		public function setIndent(bool $enable): bool {
			$this->cfwIndent = $enable;
			return true;
		}

		public function setIndentString(string $indent): bool {
			$this->cfwIndentString = $indent;
			return true;
		}

		public function startDocument(
			?string $version = '1.0',
			?string $encoding = null,
			?string $standalone = null
		): bool {
			$decl = '<?xml version="' . ($version ?? '1.0') . '"';
			if ($encoding !== null && $encoding !== '') {
				$decl .= ' encoding="' . $encoding . '"';
			}
			if ($standalone !== null && $standalone !== '') {
				$decl .= ' standalone="' . $standalone . '"';
			}
			// the newline is UNCONDITIONAL, measured against libxml: it is part of the declaration
			// rather than part of indenting, and appears with setIndent(false) too
			$this->cfwBuf .= $decl . '?>' . "\n";
			return true;
		}

		public function writePI(string $target, string $content): bool {
			$this->cfwCloseStart();
			$this->cfwNewline();
			$this->cfwBuf .= '<?' . $target . ' ' . $content . '?>';
			return true;
		}

		public function writeComment(string $content): bool {
			$this->cfwCloseStart();
			$this->cfwNewline();
			$this->cfwBuf .= '<!--' . $content . '-->';
			return true;
		}

		public function startElement(string $name): bool {
			$this->cfwCloseStart();
			// the PARENT now has an element child, which is what decides whether its own end tag
			// goes on a fresh line; libxml keeps a text-only element on one line
			$depth = count($this->cfwStack);
			if ($depth > 0) {
				$this->cfwStack[$depth - 1]['children'] = true;
			}
			$this->cfwNewline();
			$this->cfwBuf .= '<' . $name;
			$this->cfwStack[] = ['name' => $name, 'children' => false, 'text' => false];
			$this->cfwOpen = true;
			return true;
		}

		public function writeAttribute(string $name, string $value): bool {
			// silently dropping it would produce a sitemap missing its namespace, which validates
			// as XML and is rejected by every consumer
			if (!$this->cfwOpen) {
				return false;
			}
			$this->cfwBuf .= ' ' . $name . '="' . $this->cfwEscape($value) . '"';
			return true;
		}

		public function text(string $content): bool {
			$this->cfwCloseStart();
			$depth = count($this->cfwStack);
			if ($depth > 0) {
				$this->cfwStack[$depth - 1]['text'] = true;
			}
			$this->cfwBuf .= $this->cfwEscape($content);
			return true;
		}

		public function writeElement(string $name, ?string $content = null): bool {
			$this->startElement($name);
			// NULL and '' differ, and libxml distinguishes them: <x/> against <x></x>
			if ($content !== null) {
				$this->text($content);
			}
			return $this->endElement();
		}

		public function endElement(): bool {
			if ($this->cfwStack === []) {
				return false;
			}
			$frame = array_pop($this->cfwStack);
			if ($this->cfwOpen) {
				// nothing was ever written into it, so it collapses
				$this->cfwBuf .= '/>';
				$this->cfwOpen = false;
				return true;
			}
			if ($frame['children'] && !$frame['text']) {
				$this->cfwNewline();
			}
			$this->cfwBuf .= '</' . $frame['name'] . '>';
			// returning to the top level ends a line, measured: libxml emits it even with no
			// endDocument() at all, so it belongs to the element rather than to the document
			if ($this->cfwIndent && $this->cfwStack === []) {
				$this->cfwBuf .= "\n";
			}
			return true;
		}

		public function endDocument(): bool {
			while ($this->cfwStack !== []) {
				$this->endElement();
			}
			$this->cfwCloseStart();
			// unconditional, but never doubled: with indent on, endElement() has already ended the
			// line and libxml does not add a second
			if ($this->cfwBuf !== '' && substr($this->cfwBuf, -1) !== "\n") {
				$this->cfwBuf .= "\n";
			}
			return true;
		}

		public function outputMemory(bool $flush = true): string {
			$out = $this->cfwBuf;
			if ($flush) {
				$this->cfwBuf = '';
				$this->cfwStack = [];
				$this->cfwOpen = false;
			}
			return $out;
		}

		public function flush(bool $empty = true): string {
			return $this->outputMemory($empty);
		}

		/** finishes an open start tag, which is what makes attributes order-sensitive */
		private function cfwCloseStart(): void {
			if ($this->cfwOpen) {
				$this->cfwBuf .= '>';
				$this->cfwOpen = false;
			}
		}

		/**
		 * A newline plus one indent per open element, never before the very first node, and never
		 * doubled after the declaration -- which already ends its own line.
		 */
		private function cfwNewline(): void {
			if (!$this->cfwIndent || $this->cfwBuf === '') {
				return;
			}
			if (substr($this->cfwBuf, -1) !== "\n") {
				$this->cfwBuf .= "\n";
			}
			$this->cfwBuf .= str_repeat($this->cfwIndentString, count($this->cfwStack));
		}

		/**
		 * ONE escaper for both text and attributes, which is what libxml does.
		 *
		 * The obvious split -- ampersand and angle brackets in text, plus the double quote only in
		 * attributes -- is wrong, measured: libxml escapes a double quote in TEXT content as well,
		 * and leaves a single quote alone in both. Guessing produced exactly that split and the
		 * oracle rejected it. No backticks in this block: it is inside a String.raw template.
		 */
		private function cfwEscape(string $s): string {
			return str_replace(
				['&', '<', '>', '"'],
				['&amp;', '&lt;', '&gt;', '&quot;'],
				$s
			);
		}
	}
}
`;
