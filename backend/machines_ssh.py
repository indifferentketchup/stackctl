"""SSH helpers for stackctl GPU hosts (Windows sam-desktop + Linux gpu)."""

from __future__ import annotations

import asyncio
import base64
import os
import shlex
import uuid
from collections.abc import AsyncIterator
from typing import Any

import asyncssh
import aiosqlite

from db import DB_PATH


def _default_key_path() -> str:
    return (
        os.environ.get("STACKCTL_SSH_KEY")
        or os.environ.get("SAMDESKTOP_SSH_KEY")
        or os.environ.get("GPU_SSH_KEY")
        or "/opt/stackctl/ssh/id_ed25519"
    ).strip()


def sam_desktop_host() -> str:
    return (os.environ.get("SAMDESKTOP_HOST") or "").strip()


def sam_desktop_user() -> str:
    return (os.environ.get("SAMDESKTOP_USER") or "").strip()


def sam_desktop_key_path() -> str:
    return (os.environ.get("SAMDESKTOP_SSH_KEY") or _default_key_path()).strip()


def gpu_host() -> str:
    return (os.environ.get("GPU_HOST") or "").strip()


def gpu_user() -> str:
    return (os.environ.get("GPU_USER") or "").strip()


def gpu_key_path() -> str:
    return (os.environ.get("GPU_SSH_KEY") or _default_key_path()).strip()


def normalize_machine_id(machine_id: str | int) -> str:
    s = str(machine_id or "").strip().lower().replace("_", "-")
    if s in ("samdesktop", "sam-desktop"):
        return "sam-desktop"
    if s == "gpu":
        return "gpu"
    return s


async def machine_connection_params(machine_id: str | int) -> tuple[str, str, str]:
    mid_raw = str(machine_id or "").strip()
    mid_name = normalize_machine_id(machine_id)
    maybe_int: int | None = None
    try:
        maybe_int = int(mid_raw)
    except (TypeError, ValueError):
        maybe_int = None

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT ip, ssh_user, ssh_key_path FROM machines WHERE id = ? OR name = ? LIMIT 1",
            (maybe_int, mid_name),
        ) as cur:
            row = await cur.fetchone()

    if not row:
        raise ValueError(f"Unknown machine_id: {machine_id}")

    host = str(row["ip"] or "").strip()
    user = str(row["ssh_user"] or "").strip()
    key = str(row["ssh_key_path"] or "").strip()
    if not key or not os.path.isfile(key):
        key = _default_key_path()
    if not host or not user:
        raise ValueError(f"Host/user not configured for machine {machine_id}")
    return host, user, key


def powershell_single_quote(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def wrap_windows_command(command: str) -> str:
    enc = base64.b64encode(command.encode("utf-16-le")).decode("ascii")
    return f"powershell -NoProfile -EncodedCommand {enc}"


async def prepare_remote_command(machine_id: str | int, command: str) -> str:
    mid_raw = str(machine_id or "").strip()
    mid_name = normalize_machine_id(machine_id)
    maybe_int: int | None = None
    try:
        maybe_int = int(mid_raw)
    except (TypeError, ValueError):
        maybe_int = None

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT os FROM machines WHERE id = ? OR name = ? LIMIT 1",
            (maybe_int, mid_name),
        ) as cur:
            row = await cur.fetchone()

    if not row:
        raise ValueError(f"Unknown machine_id: {machine_id}")

    os_name = str(row["os"] or "ubuntu").strip().lower()
    if os_name == "windows":
        return wrap_windows_command(command)
    return f"bash -lc {shlex.quote(command)}"


async def connect_ssh(host: str, user: str, key_path: str) -> asyncssh.SSHClientConnection:
    h = (host or "").strip()
    u = (user or "").strip()
    kp = (key_path or "").strip()
    if not h or not u:
        raise OSError("SSH host and user are required")
    if not kp or not os.path.isfile(kp):
        raise OSError("SSH key is not available")
    try:
        conn = await asyncio.wait_for(
            asyncssh.connect(
                h,
                username=u,
                client_keys=[kp],
                known_hosts=None,
            ),
            timeout=15.0,
        )
    except (OSError, asyncssh.Error, asyncio.TimeoutError) as e:
        raise OSError("Could not connect over SSH") from e
    return conn


async def connect_for_machine(machine_id: str | int) -> asyncssh.SSHClientConnection:
    h, u, k = await machine_connection_params(machine_id)
    return await connect_ssh(h, u, k)


async def connect_sam_desktop() -> asyncssh.SSHClientConnection:
    return await connect_for_machine("sam-desktop")


async def remote_temp_linux_path(conn: asyncssh.SSHClientConnection, prefix: str) -> str:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in prefix)[:48] or "mf"
    r = await conn.run(f"mktemp -t stackctl_{safe}_XXXXXX.txt", check=True, encoding="utf-8")
    out = (r.stdout or "").strip().splitlines()
    if not out:
        raise RuntimeError("Could not create temp path over SSH")
    return out[-1].strip()


async def remote_temp_modelfile_path(conn: asyncssh.SSHClientConnection, fname: str) -> str:
    safe = fname.replace("'", "''")
    cmd = (
        f"powershell -NoProfile -Command "
        f'"[Console]::Out.WriteLine([System.IO.Path]::Combine($env:TEMP, \'{safe}\'))"'
    )
    r = await conn.run(cmd, check=True, encoding="utf-8")
    out = (r.stdout or "").strip().splitlines()
    if not out:
        raise RuntimeError("Could not resolve temp path over SSH")
    return out[-1].strip()


async def ssh_read_file(conn: asyncssh.SSHClientConnection, remote_path: str) -> str:
    async with conn.start_sftp_client() as sftp:
        async with sftp.open(remote_path, "rb") as f:
            data = await f.read()
    if isinstance(data, bytes):
        return data.decode("utf-8", errors="replace")
    return str(data)


async def ssh_write_file(conn: asyncssh.SSHClientConnection, remote_path: str, content: str) -> None:
    data = content.encode("utf-8")
    async with conn.start_sftp_client() as sftp:
        async with sftp.open(remote_path, "wb") as f:
            await f.write(data)


async def ssh_remove_file(conn: asyncssh.SSHClientConnection, remote_path: str) -> None:
    try:
        async with conn.start_sftp_client() as sftp:
            await sftp.remove(remote_path)
    except (OSError, asyncssh.Error):
        pass


async def ssh_exec(machine_id: str | int, command: str) -> tuple[str, str, int]:
    remote = await prepare_remote_command(machine_id, command)
    conn = await connect_for_machine(machine_id)
    try:
        r = await conn.run(remote, check=False, encoding="utf-8")
        code = int(r.exit_status) if r.exit_status is not None else -1
        return r.stdout or "", r.stderr or "", code
    finally:
        conn.close()


async def iter_ssh_cmd_lines(
    conn: asyncssh.SSHClientConnection, cmd: str
) -> AsyncIterator[tuple[str, int | None]]:
    """Yield (`line`, None) for each output line, then (`__end__`, exit_code)."""
    process = await conn.create_process(cmd, encoding="utf-8")
    q: asyncio.Queue[str | None] = asyncio.Queue()

    async def pump(stream: Any) -> None:
        try:
            while True:
                line = await stream.readline()
                if not line:
                    break
                await q.put(line.rstrip("\r\n"))
        finally:
            await q.put(None)

    t1 = asyncio.create_task(pump(process.stdout))
    t2 = asyncio.create_task(pump(process.stderr))
    finished = 0
    try:
        while finished < 2:
            item = await q.get()
            if item is None:
                finished += 1
                continue
            if item:
                yield (item, None)
        await process.wait()
        yield (
            "__end__",
            process.exit_status if process.exit_status is not None else -1,
        )
    finally:
        await asyncio.gather(t1, t2, return_exceptions=True)


async def ssh_stream_lines(machine_id: str | int, command: str) -> AsyncIterator[tuple[str, int | None]]:
    remote = await prepare_remote_command(machine_id, command)
    conn = await connect_for_machine(machine_id)
    try:
        async for item in iter_ssh_cmd_lines(conn, remote):
            yield item
    finally:
        conn.close()


def temp_artifact_name(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}.txt"
