"""Verify that the CUDA PyTorch build in this interpreter really works, including the
per-process VRAM budget that scripts/laya-gpu-boot.py applies.

Run it with the interpreter that will run Laya, so it exercises exactly that install:

    deps\\venv\\Scripts\\python.exe ops\\laya-gpu-check.py
    deps\\venv\\Scripts\\python.exe ops\\laya-gpu-check.py --probe-cap   # also prove the cap holds

`--probe-cap` allocates until the budget refuses it (a few seconds, and it needs the
whole budget free), so use it when no other Laya-on-GPU process is resident: it is the
only way to show that set_per_process_memory_fraction is actually enforced together
with PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True.

Read-only: it loads nothing from disk and writes no files.
"""

from __future__ import annotations

import os
import sys

try:
    import torch
except Exception as e:  # pragma: no cover - diagnostic path
    print("FATAL: cannot import torch: %s" % e)
    raise SystemExit(2)

frac_raw = os.environ.get("LAYA_GPU_MEM_FRACTION", "0.65")
probe = "--probe-cap" in sys.argv

print("python      :", sys.executable)
print("torch       :", torch.__version__, "| cuda build:", torch.version.cuda)
print("torch file  :", torch.__file__)
print("cuda avail  :", torch.cuda.is_available())
print("alloc conf  :", os.environ.get("PYTORCH_CUDA_ALLOC_CONF", "(unset)"))

if not torch.cuda.is_available():
    print("RESULT: no usable CUDA device in this interpreter -> Laya runs on the CPU")
    raise SystemExit(0)

p = torch.cuda.get_device_properties(0)
print("device      : %s sm_%d%d  %.2f GiB" % (p.name, p.major, p.minor, p.total_memory / 2**30))

# The budget has to be set before the first real allocation.
budget_gib = 0.0
try:
    frac = float(frac_raw)
    torch.cuda.set_per_process_memory_fraction(frac, 0)
    budget_gib = frac * p.total_memory / 2**30
    print("vram budget : fraction %s -> %.2f GiB" % (frac_raw, budget_gib))
except ValueError as e:
    print("vram budget : NOT capped (%s)" % e)

# 1. a real op, checked against the CPU result
x = torch.randn(1024, 1024, device="cuda")
y = (x @ x).sum()
xr = x.double().cpu()
yr = float((xr @ xr).sum())
rel = abs(float(y) - yr) / max(1.0, abs(yr))
print("matmul 1024^2 cuda %.4f  cpu(fp64) %.4f  rel err %.3e  dtype %s"
      % (float(y), yr, rel, x.dtype))
print("after op    : allocated %.2f GiB  reserved %.2f GiB"
      % (torch.cuda.memory_allocated() / 2**30, torch.cuda.memory_reserved() / 2**30))
del x, y, xr
torch.cuda.empty_cache()

if probe and budget_gib:
    held = []
    step = 64 * 1024 * 1024  # 64 MiB
    try:
        while True:
            held.append(torch.empty(step // 4, dtype=torch.float32, device="cuda"))
    except Exception as e:
        kind = type(e).__name__
        msg = str(e).splitlines()[0][:110]
        got = torch.cuda.memory_reserved() / 2**30
        print("cap probe   : refused after %.2f GiB reserved (%s: %s)" % (got, kind, msg))
        print("cap verdict : %s" % ("HELD (refused below the card's 5.9 GiB)" if got < p.total_memory / 2**30 - 0.5 else "NOT HELD"))
    finally:
        del held
        torch.cuda.empty_cache()

print("RESULT: CUDA works in this interpreter")
