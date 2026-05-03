"""Start backend and frontend dev servers in parallel.

Ctrl+C or closing the terminal kills both server process trees.
Works on Windows (job object) and Unix (process group).
"""

import subprocess
import signal
import sys
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

procs = []
job = None


def _create_job_object():
    """Create a Windows job object that kills all children when the handle closes."""
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.windll.kernel32

    # CreateJobObjectW
    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        return None

    # JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.POINTER(ctypes.c_ulong)),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_uint64),
            ("WriteOperationCount", ctypes.c_uint64),
            ("OtherOperationCount", ctypes.c_uint64),
            ("ReadTransferCount", ctypes.c_uint64),
            ("WriteTransferCount", ctypes.c_uint64),
            ("OtherTransferCount", ctypes.c_uint64),
        ]

    class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
            ("IoInfo", IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
    info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    kernel32.SetInformationJobObject(
        job, 9, ctypes.byref(info), ctypes.sizeof(info)
    )
    return job


def _assign_to_job(proc, job_handle):
    import ctypes
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(0x1F0FFF, False, proc.pid)
    if handle:
        kernel32.AssignProcessToJobObject(job_handle, handle)
        kernel32.CloseHandle(handle)


def spawn(cmd, cwd):
    kwargs = dict(cwd=cwd)
    if sys.platform == "win32":
        # CREATE_NEW_PROCESS_GROUP so we can kill the tree
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["preexec_fn"] = os.setsid
    p = subprocess.Popen(cmd, shell=True, **kwargs)
    if sys.platform == "win32" and job:
        _assign_to_job(p, job)
    procs.append(p)
    return p


def shutdown(*_):
    for p in procs:
        try:
            if sys.platform == "win32":
                p.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                os.killpg(os.getpgid(p.pid), signal.SIGTERM)
        except (ProcessLookupError, OSError):
            pass
    for p in procs:
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()
    sys.exit(0)


if __name__ == "__main__":
    if sys.platform == "win32":
        job = _create_job_object()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    print("Starting backend  (http://localhost:3000)...")
    spawn("npm run dev", cwd=ROOT / "backend")

    print("Starting frontend (http://localhost:5173)...")
    spawn("npm run dev", cwd=ROOT / "frontend")

    print("\nBoth servers running. Press Ctrl+C to stop.\n")

    try:
        for p in procs:
            p.wait()
    except KeyboardInterrupt:
        shutdown()
