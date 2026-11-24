#!/bin/sh

set -eu

python3 << 'PY'
from pathlib import Path
import posixpath
import re

docs = Path("typedoc/php")

# the docs site publishes docs/drupflare.ico and drupflare_128.png at its root, one level up; the
# template sets a base element, and that is where the icon paths resolve from
for html in docs.rglob("*.html"):
    text = html.read_text()

    base = re.search(r'<base href="([^"]*)"', text)
    folder = html.parent.relative_to(docs).as_posix()
    start = posixpath.normpath(posixpath.join(folder, base.group(1))) if base else folder
    depth = 0 if start == "." else len(start.split("/"))
    prefix = "../" * (depth + 1)
    text = re.sub(
        r'^[ \t]*<link rel="(?:shortcut )?icon"[^>]*>\s*\n?',
        "",
        text,
        flags=re.MULTILINE,
    )

    text = re.sub(
        r'^[ \t]*<link rel="apple-touch-icon"[^>]*>\s*\n?',
        "",
        text,
        flags=re.MULTILINE,
    )

    icons = (
        f'\t\t<link rel="icon" type="image/png" href="{prefix}drupflare_128.png"/>\n'
        f'\t\t<link rel="shortcut icon" href="{prefix}drupflare.ico"/>\n'
        f'\t\t<link rel="apple-touch-icon" href="{prefix}drupflare_128.png"/>\n'
    )

    text = text.replace("</head>", f"{icons}\t</head>", 1)

    html.write_text(text)
PY
