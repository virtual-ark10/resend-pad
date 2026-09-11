#!/usr/bin/env python3
"""Extract the inline <script> block from pad/index.html and syntax-check it.

index.html is hand-edited, and a typo inside its inline script is invisible to
every other check (nothing lints HTML), so this pulls the block out and runs
node --check on it. Usage: python3 tools/check-inline-js.py [path/to/index.html]
"""
import re
import subprocess
import sys
import tempfile
import pathlib

path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "index.html")
html = path.read_text(encoding="utf-8")

blocks = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", html, re.S)
if not blocks:
    print("no inline <script> block found")
    sys.exit(1)

src = max(blocks, key=len)
tmp = pathlib.Path(tempfile.mkdtemp()) / "inline.js"
tmp.write_text(src, encoding="utf-8")
res = subprocess.run(["node", "--check", str(tmp)], capture_output=True, text=True)
print(f"{path}: inline script {len(src)} chars -> {'OK' if res.returncode == 0 else 'SYNTAX ERROR'}")
if res.returncode != 0:
    print(res.stderr.strip())
sys.exit(res.returncode)
