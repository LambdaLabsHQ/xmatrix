#!/usr/bin/env python3
"""Build the credential-free portal upload from an explicit file allowlist."""
import json
from pathlib import Path
import sys
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parent.parent
source = root / "deploy/chatgpt-plugin"
manifest = json.loads((source / "plugin.json").read_text())
destination = Path(sys.argv[1] if len(sys.argv) > 1 else f"/tmp/xmatrix-chatgpt-{manifest['version']}.zip")
files = {
    ".codex-plugin/plugin.json": source / "plugin.json",
    ".mcp.json": source / "mcp.json",
    "assets/xmatrix-icon.png": root / "apps/web/public/brand/xmatrix-icon.png",
    "LICENSE": root / "LICENSE",
}
destination.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(destination, "w") as archive:
    for name, path in files.items():
        entry = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        entry.compress_type = ZIP_DEFLATED
        entry.external_attr = 0o100644 << 16
        archive.writestr(entry, path.read_bytes())
print(destination)
