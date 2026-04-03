"""Shared SSH helpers for sam-desktop (Ollama host on Windows)."""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import AsyncIterator
from typing import Any

import asyncssh


def sam_desktop_host() -> str:
    return (os.environ.get("SAMDESKTOP_HOST") or "100.101.41.16").strip()


def sam_desktop_user() -> str:
    return (os.environ.get("SAMDESKTOP_USER") or "samki").strip()


def sam_desktop_key_path() -> str:
    return (os.environ.get("SAMDESKTOP_SSH_KEY") or "/opt/ollamactl/ssh/id_ed25519").strip()


def powershell_single_quote(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


NSSM_EXE = r"C:\Tools\nssm\nssm.exe"
OLLAMA_SERVICE = "ollama"


def _cmd_double_quoted_token(s: str) -> str:
    return '"' + s.replace('"', '""') + '"'


def nssm_cmd_get_app_environment_extra() -> str:
    inner = f'"{NSSM_EXE}" get {OLLAMA_SERVICE} AppEnvironmentExtra'
    return f'cmd /c "{inner}"'


def nssm_cmd_set_app_environment_extra(pairs: list[str]) -> str:
    args = " ".join(_cmd_double_quoted_token(p) for p in pairs)
    inner = f'"{NSSM_EXE}" set {OLLAMA_SERVICE} AppEnvironmentExtra {args}'
    return f'cmd /c "{inner}"'


def nssm_cmd_service_action(action: str) -> str:
    inner = f'"{NSSM_EXE}" {action} {OLLAMA_SERVICE}'
    return f'cmd /c "{inner}"'


async def connect_ssh(host: str, user: str) -> asyncssh.SSHClientConnection:
    h = (host or "").strip()
    u = (user or "").strip()
    if not h or not u:
        raise OSError("SSH host and user are required")
    key_path = sam_desktop_key_path()
    if not os.path.isfile(key_path):
        raise OSError("SSH key is not available")
    try:
        conn = await asyncio.wait_for(
            asyncssh.connect(
                h,
                username=u,
                client_keys=[key_path],
                known_hosts=None,
            ),
            timeout=15.0,
        )
    except (OSError, asyncssh.Error, asyncio.TimeoutError) as e:
        raise OSError("Could not connect over SSH") from e
    return conn


async def connect_sam_desktop() -> asyncssh.SSHClientConnection:
    return await connect_ssh(sam_desktop_host(), sam_desktop_user())


async def remote_temp_linux_path(conn: asyncssh.SSHClientConnection, prefix: str) -> str:
    """Linux/Bash remote temp file path (e.g. systemd Ollama hosts)."""
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in prefix)[:48] or "mf"
    r = await conn.run(f"mktemp -t ollamactl_{safe}_XXXXXX.txt", check=True, encoding="utf-8")
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


def temp_artifact_name(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}.txt"
