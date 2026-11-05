"""Saving the company data safely: a file is written next to the old one, flushed to the disk and then put in its
place (a power cut or a full disk leaves the old file, never half of the new one), and dated copies are kept."""

from __future__ import annotations

import os
import shutil
from datetime import date, datetime
from pathlib import Path


def atomic_write_text(path: str | Path, text: str, encoding: str = "utf-8") -> None:
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding=encoding, newline="") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def backup_daily(path: str | Path, keep: int = 14, today: date | None = None) -> Path | None:
    """Copy the file to backups/<name>-YYYYMMDD<ext> once a day (the first save of the day), keeping `keep` copies."""
    path = Path(path)
    if not path.is_file() or path.stat().st_size == 0:
        return None
    folder = path.parent / "backups"
    folder.mkdir(exist_ok=True)
    day = (today or date.today()).strftime("%Y%m%d")
    target = folder / f"{path.stem}-{day}{path.suffix}"
    if not target.exists():
        shutil.copy2(path, target)
    copies = sorted(folder.glob(f"{path.stem}-*{path.suffix}"))
    for old in copies[:-keep] if keep > 0 else []:
        try:
            old.unlink()
        except OSError:
            pass
    return target


def backups(path: str | Path) -> list[Path]:
    """The copies of a file, newest first: <name>.bak, then the dated ones."""
    path = Path(path)
    out = [path.with_name(path.name + ".bak")] if path.with_name(path.name + ".bak").is_file() else []
    out += sorted((path.parent / "backups").glob(f"{path.stem}-*{path.suffix}"), reverse=True)
    return out


def set_aside(path: str | Path) -> Path:
    """Rename a file that cannot be read to <name>.corrupt-<time><ext> (kept for IT, never overwritten)."""
    path = Path(path)
    stamp = f"{datetime.now():%Y%m%d-%H%M%S}"
    target = path.with_name(f"{path.stem}.corrupt-{stamp}{path.suffix}")
    n = 1
    while target.exists():  # never over an earlier bad copy
        n += 1
        target = path.with_name(f"{path.stem}.corrupt-{stamp}-{n}{path.suffix}")
    os.replace(path, target)
    return target
