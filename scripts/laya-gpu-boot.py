"""Start Laya on the NVIDIA GPU with a hard VRAM budget, then hand over to `laya.serve`.

`laya` already prefers CUDA when `LAYA_DEVICE=cuda` and falls back to CPU by itself:
`Agent.__init__` downgrades to CPU when `torch.cuda.is_available()` is false, and it
catches `RuntimeError` / `torch.cuda.OutOfMemoryError` from `model.to(device)` and
reloads that one checkpoint on CPU (`agent.py`, "Place on device with graceful
fallback to CPU on memory error"). So this wrapper adds only the two things the
package has no env var for:

  1. a per-process VRAM cap (`torch.cuda.set_per_process_memory_fraction`), so the
     Windows desktop keeps headroom on a 6 GiB laptop GPU, and
  2. 16-bit resident weights. The three checkpoints are fp16 on disk but load as
     fp32 parameters (measured 4.67 GiB total), which does not fit 6 GiB with a
     display attached. Casting inside `build_model` -- i.e. on CPU, BEFORE
     `model.to(device)` -- keeps the GPU peak at the fp16 size instead of paying a
     fp32-plus-fp16 transient.

Nothing here edits site-packages: it rebinds one module-level function for the
lifetime of the process and then runs `python -m laya.serve` in-process.

Environment (all optional):
  LAYA_DEVICE              "cpu" skips all of this and runs exactly like before.
  LAYA_GPU                 auto (default) | cpu | gpu   - "cpu" is the same as LAYA_DEVICE=cpu
  LAYA_GPU_MEM_FRACTION    fraction of total VRAM torch may allocate (default 0.65,
                           ~4.0 GiB of the 6.1 GiB card). 0 or "off" disables the cap.
  LAYA_GPU_WEIGHTS         fp16 (default) | bf16 | fp32   resident weight dtype on CUDA.
                           fp32 is faithful but needs ~4.7 GiB of weights alone.
  LAYA_CUDA_AMP            autocast dtype; forced to match LAYA_GPU_WEIGHTS unless set.

A failure anywhere in here is logged and the process still starts Laya (on CPU if
CUDA is unusable), because a decision server that is down is worse than a slow one.
"""

from __future__ import annotations

import os
import runpy
import sys
import traceback

_LOG_PREFIX = "[laya-gpu] "


def _log(msg: str) -> None:
    print(_LOG_PREFIX + msg, flush=True)


def _device_pref() -> str:
    """The LAYA_DEVICE value this process will hand to laya ("" = let laya choose)."""
    return os.environ.get("LAYA_DEVICE", "").strip()


def _wants_cpu() -> bool:
    mode = os.environ.get("LAYA_GPU", "auto").strip().lower()
    if mode in ("cpu", "off", "0", "false"):
        return True
    dev = _device_pref().lower()
    return dev == "cpu" or dev.startswith("cpu:")


def _apply_vram_cap(torch) -> None:
    raw = os.environ.get("LAYA_GPU_MEM_FRACTION", "0.65").strip().lower()
    if raw in ("", "off", "none", "0"):
        _log("VRAM cap disabled (LAYA_GPU_MEM_FRACTION=%r)" % raw)
        return
    try:
        frac = float(raw)
        if not 0.0 < frac <= 1.0:
            raise ValueError("must be in (0, 1]")
    except ValueError as e:
        _log("WARNING LAYA_GPU_MEM_FRACTION=%r is invalid (%s); no cap applied" % (raw, e))
        return
    try:
        torch.cuda.set_per_process_memory_fraction(frac, 0)
        total = torch.cuda.get_device_properties(0).total_memory
        _log("VRAM budget: %.2f x %.2f GiB = %.2f GiB for this process"
             % (frac, total / 2 ** 30, frac * total / 2 ** 30))
    except Exception as e:  # never a reason to refuse to start
        _log("WARNING could not cap VRAM (%s); continuing uncapped" % e)


def _patch_weight_dtype(torch) -> None:
    """Build every checkpoint in `dtype` (on CPU), so the GPU never holds fp32 weights."""
    name = os.environ.get("LAYA_GPU_WEIGHTS", "fp16").strip().lower()
    if name in ("", "fp32", "float32", "full"):
        _log("LAYA_GPU_WEIGHTS=fp32: resident weights stay fp32 (~4.7 GiB for all 3; "
             "a checkpoint that does not fit falls back to CPU)")
        return
    if name in ("fp16", "float16", "half"):
        dtype = torch.float16
    elif name in ("bf16", "bfloat16"):
        dtype = torch.bfloat16
    else:
        _log("WARNING LAYA_GPU_WEIGHTS=%r is not fp16/bf16/fp32; leaving weights at fp32" % name)
        return

    try:
        import laya.agent as agent_mod
    except Exception as e:
        _log("WARNING laya.agent did not import (%s); leaving weights at fp32" % e)
        return
    original = getattr(agent_mod, "build_model", None)
    if original is None:
        _log("WARNING laya.agent.build_model not found; leaving weights at fp32")
        return
    if getattr(original, "_laya_gpu_wrapped", False):
        return

    def build_model_in_dtype(*args, **kwargs):
        model = original(*args, **kwargs)
        # Cast while the model is still on the CPU: it is moved to the device right
        # after this returns, and casting there would need fp32 + fp16 at once.
        return model.to(dtype)

    build_model_in_dtype._laya_gpu_wrapped = True  # type: ignore[attr-defined]
    agent_mod.build_model = build_model_in_dtype
    _log("checkpoint weights will be built in %s (cast on CPU, before the device move)" % dtype)


def _setup_gpu() -> None:
    import torch

    _log("torch %s  cuda_build=%s  cuda_available=%s"
         % (torch.__version__, torch.version.cuda, torch.cuda.is_available()))

    if _wants_cpu():
        # Make the preference explicit too: with LAYA_GPU=cpu plus a stale
        # LAYA_DEVICE=cuda, laya itself would still pick the GPU unless we rewrite it.
        os.environ["LAYA_DEVICE"] = "cpu"
        _log("CPU requested (LAYA_GPU=%r): no GPU setup, no weight cast, LAYA_DEVICE=cpu"
             % os.environ.get("LAYA_GPU", "auto"))
        return

    if not torch.cuda.is_available():
        os.environ["LAYA_DEVICE"] = "cpu"
        _log("CUDA is not available in this interpreter -> LAYA_DEVICE=cpu "
             "(laya would fall back on its own; this makes /health say so honestly)")
        return

    try:
        props = torch.cuda.get_device_properties(0)
        _log("device: %s  sm_%d%d  %.2f GiB  (driver-supplied via torch %s)"
             % (props.name, props.major, props.minor, props.total_memory / 2 ** 30, torch.version.cuda))
    except Exception as e:
        _log("WARNING could not read device properties (%s)" % e)

    # Set before any allocation; harmless if the launcher already set it.
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    _apply_vram_cap(torch)

    weights = os.environ.get("LAYA_GPU_WEIGHTS", "fp16").strip().lower()
    if "LAYA_CUDA_AMP" not in os.environ:
        os.environ["LAYA_CUDA_AMP"] = "bf16" if weights in ("bf16", "bfloat16") else "fp16"
        _log("LAYA_CUDA_AMP=%s (autocast follows the resident weights)" % os.environ["LAYA_CUDA_AMP"])
    _patch_weight_dtype(torch)


def main() -> None:
    try:
        _setup_gpu()
    except Exception:
        _log("WARNING GPU setup failed; starting Laya as-is:\n" + traceback.format_exc())
    # Same module the plain launcher runs (`python -m laya.serve`), now in-process.
    runpy.run_module("laya.serve", run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    sys.exit(main())
