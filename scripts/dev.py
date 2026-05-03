"""Start backend and frontend dev servers in parallel. Ctrl+C stops both."""

import subprocess
import signal
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

procs = []

def shutdown(*_):
    for p in procs:
        p.terminate()
    for p in procs:
        p.wait()
    sys.exit(0)

signal.signal(signal.SIGINT, shutdown)
signal.signal(signal.SIGTERM, shutdown)

print("Starting backend  (http://localhost:3000)...")
procs.append(subprocess.Popen(["npm", "run", "dev"], cwd=ROOT / "backend", shell=True))

print("Starting frontend (http://localhost:5173)...")
procs.append(subprocess.Popen(["npm", "run", "dev"], cwd=ROOT / "frontend", shell=True))

for p in procs:
    p.wait()
