#!/usr/bin/env python3
"""daemon-local.py — keep the VolOS terminal ALWAYS RUNNING on localhost + preview.

    python3 scripts/daemon-local.py start     # double-fork daemon → run-local.sh supervisor
    python3 scripts/daemon-local.py status    # is the supervisor alive?
    python3 scripts/daemon-local.py stop      # stop the supervisor (and its children)

WHY A DOUBLE-FORK: the sandbox reaps processes spawned by tool calls between
invocations — a plain nohup/setsid child gets collected when its parent shell
dies. A double-fork daemon reparents to init (PID 1) before the parent exits,
so the run-local.sh supervisor (5s health-check, auto-restart, adopts whoever
serves :3000) survives and keeps the app up for the whole sandbox lifetime —
on localhost AND through the preview proxy.
"""

import os
import signal
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG_DIR = ROOT / ".local-logs"
PID_FILE = LOG_DIR / "daemon.pid"
DAEMON_LOG = LOG_DIR / "daemon.log"


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        # zombie check — a reaped daemon leaves a defunct entry owned by init
        with open(f"/proc/{pid}/stat") as f:
            state = f.read().split(") ", 1)[1].split()[0]
        return state not in ("Z",)
    except (OSError, IndexError, ValueError):
        return False


def current_pid() -> int | None:
    try:
        pid = int(PID_FILE.read_text().strip())
    except (OSError, ValueError):
        return None
    return pid if (pid and _alive(pid)) else None


def cmd_start() -> int:
    LOG_DIR.mkdir(exist_ok=True)
    if (pid := current_pid()) is not None:
        print(f"[daemon] already running (pid {pid}) — supervisor watching :3000")
        return 0

    # ── double-fork daemonize ──────────────────────────────────────────────────
    # fork 1: parent exits immediately (the caller returns); child detaches
    # its session so terminal signals never reach it.
    if os.fork() > 0:
        print("[daemon] supervisor launched — always-on localhost:3000 + preview")
        return 0
    os.setsid()
    # fork 2: the intermediate child exits; the grandchild is reparented to
    # init, so no tool-call shell ever owns it (this is what beats the reaper).
    if os.fork() > 0:
        os._exit(0)

    os.umask(0o022)
    os.chdir(ROOT)
    fd = os.open(DAEMON_LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(fd, 1)
    os.dup2(fd, 2)
    if fd > 2:
        os.close(fd)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    if devnull > 2:
        os.close(devnull)

    PID_FILE.write_text(str(os.getpid()) + "\n")

    # replace this process with the supervisor (adopt-or-take-over :3000 with
    # a 5s health check and auto-restart; engine/gateway flags may be added
    # by editing RUN_ARGS).
    RUN_ARGS = os.environ.get("DAEMON_LOCAL_ARGS", "").split()
    os.execvp("bash", ["bash", "run-local.sh", *RUN_ARGS])
    return 0  # unreachable


def cmd_status() -> int:
    pid = current_pid()
    if pid is None:
        print("[daemon] NOT running — start it: python3 scripts/daemon-local.py start")
        return 1
    print(f"[daemon] running (pid {pid}) — supervising http://localhost:3000")
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            cmd = f.read().replace(b"\0", b" ").decode(errors="replace").strip()
        print(f"[daemon] cmdline: {cmd}")
    except OSError:
        pass
    return 0


def cmd_stop() -> int:
    pid = current_pid()
    if pid is None:
        PID_FILE.unlink(missing_ok=True)
        print("[daemon] not running (stale pidfile cleaned)")
        return 0
    os.kill(pid, signal.SIGTERM)
    print(f"[daemon] SIGTERM → pid {pid} (supervisor shuts its children down)")
    PID_FILE.unlink(missing_ok=True)
    return 0


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "start":
        return cmd_start()
    if cmd == "stop":
        return cmd_stop()
    if cmd == "status":
        return cmd_status()
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
