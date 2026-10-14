# NEU-142: versao = hash curto do proprio codigo (mesmo algoritmo de data_broker/code_version.js).
# CRLF -> LF para o checkout no Windows e o build no Docker darem o mesmo hash.
import hashlib
import subprocess
from pathlib import Path


def hash_files(base_dir, rel_paths):
    h = hashlib.sha256()
    for rel in sorted(str(p).replace("\\", "/") for p in rel_paths):
        content = (Path(base_dir) / rel).read_bytes().decode("utf-8").replace("\r\n", "\n")
        h.update(f"{rel}\n{content}\n".encode("utf-8"))
    return h.hexdigest()[:7]


def code_version(base_dir=None):
    base = Path(base_dir) if base_dir else Path(__file__).resolve().parent
    return hash_files(base, [p.name for p in base.glob("*.py") if p.is_file()])


def git_info(base_dir=None, run=subprocess.run):
    """Branch e commit do checkout (o gesto roda fora do Docker). Sem git: None nos dois."""
    base = str(Path(base_dir) if base_dir else Path(__file__).resolve().parent)
    try:
        def git(*args):
            return run(["git", "-C", base, *args], capture_output=True, text=True, timeout=2, check=True).stdout.strip() or None
        return {"branch": git("rev-parse", "--abbrev-ref", "HEAD"), "commit": git("rev-parse", "--short", "HEAD")}
    except Exception:
        return {"branch": None, "commit": None}
