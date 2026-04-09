"""Local snapshot store for framework config files (before SSH writes)."""

from __future__ import annotations

import asyncio
import os
import re
from datetime import datetime, timezone
from pathlib import Path

BACKUP_DIR = Path(os.environ.get("DATA_DIR", "/data")) / "config_backups"

_MAX_PER_MACHINE = 20
_SANITIZE_CONFIG_NAME = re.compile(r"[^a-zA-Z0-9_\-.]")


def _sanitize_config_filename(config_path: str) -> str:
    base = Path(config_path or "").name
    return _SANITIZE_CONFIG_NAME.sub("", base) or "config"


def _validate_backup_id(bid: str) -> None:
    if not bid or "/" in bid or "\\" in bid or ".." in bid:
        raise ValueError("invalid backup id")


def _iso_from_unix_ms(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).isoformat()


def _backup_record(path: Path, machine_id: int) -> dict:
    stat = path.stat()
    stem = path.stem
    ms: int | None = None
    if "_" in stem:
        prefix = stem.split("_", 1)[0]
        if prefix.isdigit():
            ms = int(prefix)
    created_at = _iso_from_unix_ms(ms) if ms is not None else datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
    return {
        "id": stem,
        "path": str(path.resolve()),
        "machine_id": machine_id,
        "created_at": created_at,
        "size_bytes": int(stat.st_size),
    }


def _save_backup_sync(machine_id: int, config_path: str, content: str) -> dict:
    safe_name = _sanitize_config_filename(config_path)
    ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    filename = f"{ms}_{safe_name}"
    dir_path = BACKUP_DIR / str(machine_id)
    dir_path.mkdir(parents=True, exist_ok=True)
    out_path = dir_path / filename
    out_path.write_text(content, encoding="utf-8")

    files = [p for p in dir_path.iterdir() if p.is_file()]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for old in files[_MAX_PER_MACHINE:]:
        try:
            old.unlink()
        except OSError:
            pass

    return _backup_record(out_path, machine_id)


async def save_backup(machine_id: int, machine_name: str, config_path: str, content: str) -> dict:
    _ = machine_name
    return await asyncio.to_thread(_save_backup_sync, machine_id, config_path, content)


def _list_backups_sync(machine_id: int) -> list[dict]:
    dir_path = BACKUP_DIR / str(machine_id)
    if not dir_path.is_dir():
        return []
    files = [p for p in dir_path.iterdir() if p.is_file()]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return [_backup_record(p, machine_id) for p in files]


async def list_backups(machine_id: int) -> list[dict]:
    return await asyncio.to_thread(_list_backups_sync, machine_id)


def _read_backup_sync(machine_id: int, backup_id: str) -> str:
    _validate_backup_id(backup_id)
    dir_path = BACKUP_DIR / str(machine_id)
    if not dir_path.is_dir():
        raise FileNotFoundError(backup_id)
    for p in dir_path.iterdir():
        if not p.is_file():
            continue
        if p.stem == backup_id:
            return p.read_text(encoding="utf-8")
    raise FileNotFoundError(backup_id)


async def read_backup(machine_id: int, backup_id: str) -> str:
    return await asyncio.to_thread(_read_backup_sync, machine_id, backup_id)
