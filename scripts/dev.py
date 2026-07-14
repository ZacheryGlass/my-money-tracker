"""Start backend and frontend dev servers in parallel.

Ctrl+C or closing the terminal kills both server process trees.
Works on Windows (job object + taskkill fallback) and Unix (process group).
"""

import subprocess
import signal
import sys
import os
import atexit
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

procs = []
job = None
_shutting_down = False


def _create_job_object():
    """Create a Windows job object that kills all children when the handle closes."""
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.windll.kernel32

    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    job_handle = kernel32.CreateJobObjectW(None, None)
    if not job_handle:
        return None

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
    ok = kernel32.SetInformationJobObject(
        job_handle, 9, ctypes.byref(info), ctypes.sizeof(info)
    )
    if not ok:
        return None
    return job_handle


def _assign_to_job(proc, job_handle):
    import ctypes
    from ctypes import wintypes
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(0x1F0FFF, False, proc.pid)
    if handle:
        kernel32.AssignProcessToJobObject(job_handle, handle)
        kernel32.CloseHandle(handle)


def spawn(cmd, cwd, env=None):
    kwargs = dict(cwd=cwd, env=env)
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["preexec_fn"] = os.setsid
    p = subprocess.Popen(cmd, shell=True, **kwargs)
    if sys.platform == "win32" and job:
        _assign_to_job(p, job)
    procs.append(p)
    return p


def shutdown(*_):
    global _shutting_down
    if _shutting_down:
        return
    _shutting_down = True

    for p in procs:
        if p.poll() is not None:
            continue
        try:
            if sys.platform == "win32":
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(p.pid)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            else:
                os.killpg(os.getpgid(p.pid), signal.SIGTERM)
        except (ProcessLookupError, OSError):
            pass

    for p in procs:
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()


def cleanup_ports(ports):
    """Kill processes listening on the specified ports."""
    import psutil
    print(f"Checking for lingering processes on ports: {', '.join(map(str, ports))}...")
    for port in ports:
        for conn in psutil.net_connections(kind='inet'):
            if conn.laddr.port == port and conn.status == 'LISTEN':
                try:
                    p = psutil.Process(conn.pid)
                    print(f"Killing process {p.name()} (PID: {conn.pid}) on port {port}...")
                    p.terminate()
                    p.wait(timeout=3)
                except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.TimeoutExpired):
                    try:
                        p.kill()
                    except:
                        pass

if __name__ == "__main__":
    if sys.platform == "win32":
        job = _create_job_object()

    # Pre-start cleanup
    try:
        cleanup_ports([3000, 5173])
    except Exception as e:
        print(f"Warning: Port cleanup failed: {e}")

    signal.signal(signal.SIGINT, lambda *_: (shutdown(), sys.exit(0)))
    signal.signal(signal.SIGTERM, lambda *_: (shutdown(), sys.exit(0)))
    atexit.register(shutdown)

    print("Starting backend  (http://localhost:3000)...")
    spawn("npm run dev", cwd=ROOT / "backend")

    # Bind Vite to all interfaces so the app is reachable from other devices on
    # the local network. Route API requests through Vite's proxy rather than
    # embedding localhost in the browser bundle (where localhost is the phone).
    frontend_env = os.environ.copy()
    frontend_env["VITE_API_URL"] = "/"
    print("Starting frontend (http://localhost:5173, available on your local network)...")
    spawn("npm run dev -- --host 0.0.0.0", cwd=ROOT / "frontend", env=frontend_env)

    print("\nBoth servers running. Press Ctrl+C to stop.\n")

    try:
        for p in procs:
            p.wait()
    except KeyboardInterrupt:
        shutdown()
        sys.exit(0)
