# NEU-142: versao = hash curto do proprio codigo (mesmo algoritmo de data_broker/code_version.js).
# CRLF -> LF para o checkout no Windows e o build no Docker darem o mesmo hash.
import hashlib
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
