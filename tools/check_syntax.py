#!/usr/bin/env python3
"""Parse-check every <script> block in the shell, and sw.js.

index.html is a ~1.5 MB single file with the whole application inlined, and a
push to main is a live release. A syntax error would ship a blank screen to
every installed device, so the one thing worth spending CI time on is proving
the document still parses.

Requires node on PATH (GitHub's runners have it preinstalled).

    python3 tools/check_syntax.py
"""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT_BLOCK = re.compile(r"<script\b[^>]*>(.*?)</script>", re.S)


def node_check(source: str, label: str, tmpdir: Path) -> bool:
    path = tmpdir / f"{label.replace('/', '_')}.js"
    path.write_text(source, encoding="utf-8")
    result = subprocess.run(
        ["node", "--check", str(path)], capture_output=True, text=True
    )
    if result.returncode == 0:
        print(f"  OK    {label} ({len(source):,} chars)")
        return True
    print(f"  FAIL  {label}", file=sys.stderr)
    print(result.stderr.rstrip(), file=sys.stderr)
    return False


def main() -> int:
    if subprocess.run(["node", "--version"], capture_output=True).returncode != 0:
        print("node is not on PATH -- cannot parse-check", file=sys.stderr)
        return 1

    index = ROOT / "index.html"
    if not index.exists():
        print("index.html: missing", file=sys.stderr)
        return 1

    blocks = SCRIPT_BLOCK.findall(index.read_text(encoding="utf-8"))
    if not blocks:
        # Silent success on zero blocks would make this check meaningless the
        # day the regex stops matching.
        print("index.html: found no <script> blocks -- the check is not looking "
              "at anything", file=sys.stderr)
        return 1

    ok = True
    with tempfile.TemporaryDirectory() as td:
        tmpdir = Path(td)
        for i, block in enumerate(blocks):
            ok &= node_check(block, f"index.html script[{i}]", tmpdir)

        sw = ROOT / "sw.js"
        if sw.exists():
            ok &= node_check(sw.read_text(encoding="utf-8"), "sw.js", tmpdir)

    print("\nOK -- everything parses." if ok else "\nFAIL -- see above.",
          file=sys.stdout if ok else sys.stderr)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
