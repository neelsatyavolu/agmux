#!/usr/bin/env python3
"""Mock mlx_lm.server for tests — does nothing useful, just stays alive
   and prints lines that mimic the real server's stderr."""
import sys, time
print("Fetching 1 files: 0%", file=sys.stderr, flush=True)
time.sleep(0.05)
print("Fetching 1 files: 100%", file=sys.stderr, flush=True)
print("Server running on http://127.0.0.1:21434", file=sys.stderr, flush=True)
while True:
    time.sleep(1)
