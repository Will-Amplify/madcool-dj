"""Filesystem jail helpers for engine commands.

Allowed roots (resolved):
- MUSIC_ROOT (env) or ~/Music
- Repo fixtures/ (clips + kits)
- ~/.cache/madcool-dj/ (uploads, analysis adjacent)
- ~/Music/dj-library/ (generated MiniMax + kits)

Browse may walk parents within an allowed root; parents outside return None.
"""

from __future__ import annotations

import os
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]


def allowed_roots() -> list[Path]:
    roots: list[Path] = []
    music = Path(os.environ.get("MUSIC_ROOT") or (Path.home() / "Music")).expanduser()
    roots.append(music)
    roots.append(_REPO_ROOT / "fixtures")
    roots.append(Path.home() / ".cache" / "madcool-dj")
    roots.append(Path.home() / "Music" / "dj-library")
    # Tests / operators can extend the jail (colon-separated absolute paths).
    extra = os.environ.get("MADCOOL_DJ_EXTRA_ROOTS", "")
    for part in extra.split(":"):
        part = part.strip()
        if part:
            roots.append(Path(part).expanduser())
    # Dedupe while preserving order
    seen: set[str] = set()
    out: list[Path] = []
    for r in roots:
        try:
            key = str(r.resolve())
        except OSError:
            key = str(r)
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def resolve_under_allowlist(path: str | Path, *, must_exist: bool = False) -> Path:
    """Resolve `path` and require it under an allowed root.

    Raises PermissionError with a stable code if the path escapes the jail.
    """
    raw = Path(path).expanduser()
    try:
        resolved = raw.resolve(strict=must_exist)
    except FileNotFoundError:
        # resolve(strict=False) still works; prefer non-strict for load targets
        resolved = raw.resolve(strict=False)
    except OSError as exc:
        raise PermissionError(f"path_unresolvable: {path}") from exc

    for root in allowed_roots():
        try:
            root_r = root.resolve()
        except OSError:
            continue
        try:
            if resolved == root_r or resolved.is_relative_to(root_r):
                return resolved
        except AttributeError:
            # Python <3.9 fallback (we require 3.12+, but keep belt)
            if str(resolved).startswith(str(root_r) + os.sep) or resolved == root_r:
                return resolved
    raise PermissionError(f"path_outside_allowlist: {resolved}")


def browse_parent(path: Path) -> str | None:
    """Parent path if still inside the allowlist; else None (stop climbing)."""
    parent = path.parent
    if parent == path:
        return None
    try:
        resolve_under_allowlist(parent)
        return str(parent)
    except PermissionError:
        return None
