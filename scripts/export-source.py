"""Export application source without local identity, credentials, or git history."""
import json
import pathlib
import subprocess
import zipfile

root = pathlib.Path(__file__).resolve().parents[1]
paths = subprocess.check_output(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root
).decode().split("\0")
target = root / "public/source.zip"
excluded_dirs = {".git", ".openai", ".sites-runtime", ".agents", ".codex", ".wrangler", ".next", ".vinext", "node_modules", "dist", "out", "coverage", "outputs", "work", "__pycache__"}
with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for name in sorted(set(paths)):
        path = pathlib.PurePosixPath(name)
        if not name or name == "public/source.zip" or any(part in excluded_dirs for part in path.parts):
            continue
        if path.name.startswith((".env", ".dev.vars")) or path.suffix in {".tsbuildinfo", ".pem", ".key", ".sqlite", ".sqlite3", ".db", ".log", ".map", ".pyc"} or path.name in {".DS_Store", "AGENTS.md"}:
            continue
        source = root / path
        if not source.is_file() or source.is_symlink():
            continue
        # Fixed metadata avoids carrying local timestamps into the distribution.
        entry = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.external_attr = 0o644 << 16
        archive.writestr(entry, source.read_bytes())
print("Source bundle ready:", target.stat().st_size, "bytes")
