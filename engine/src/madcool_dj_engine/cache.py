import hashlib
import json
from pathlib import Path
from typing import Any, Optional
from madcool_dj_engine import ANALYZER_VERSION


def cache_dir() -> Path:
    p = Path.home() / ".cache" / "madcool-dj" / "analysis"
    p.mkdir(parents=True, exist_ok=True)
    return p


def cache_key(path: Path) -> str:
    path = path.resolve()
    st = path.stat()
    raw = f"{path}|{st.st_mtime_ns}|{st.st_size}|{ANALYZER_VERSION}"
    return hashlib.sha1(raw.encode()).hexdigest()


def load_analysis(path: Path) -> Optional[dict[str, Any]]:
    fp = cache_dir() / f"{cache_key(path)}.json"
    if not fp.exists():
        return None
    return json.loads(fp.read_text())


def save_analysis(path: Path, data: dict[str, Any]) -> Path:
    fp = cache_dir() / f"{cache_key(path)}.json"
    payload = {**data, "analyzer_version": ANALYZER_VERSION, "path": str(path.resolve())}
    cache_dir().mkdir(parents=True, exist_ok=True)
    fp.write_text(json.dumps(payload))
    return fp
