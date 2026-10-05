"""Report the real in-memory size and dtype of a Laya checkpoint as torch loads it.

Reads only: opens the local HF snapshot, builds the model with laya's own code path
(Agent), and sums parameter/buffer bytes. No server is started and nothing is written.
Usage: deps\\venv\\Scripts\\python.exe ops\\laya-size-probe.py [device]  (default cpu)
"""
import os
import sys
import collections

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "deps", "venv", "Lib", "site-packages"))

import torch  # noqa: E402
from laya.agent import Agent  # noqa: E402

SNAP = os.path.join(
    os.environ["USERPROFILE"], ".cache", "huggingface", "hub",
    "models--convaiinnovations--laya", "snapshots",
    "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851",
)

device = sys.argv[1] if len(sys.argv) > 1 else "cpu"
print("torch", torch.__version__, "cuda_build", torch.version.cuda, "cuda_available", torch.cuda.is_available())

for rel in ["", "multilingual", "typed-decisions"]:
    path = os.path.join(SNAP, rel) if rel else SNAP
    agent = Agent(path, device=device)
    counts = collections.Counter()
    total = 0
    n = 0
    for t in list(agent.model.parameters()) + list(agent.model.buffers()):
        counts[str(t.dtype)] += 1
        total += t.numel() * t.element_size()
        n += t.numel()
    print("%-16s device=%-5s dtype=%-14s params=%d tensor_bytes=%.2f GB (%s)"
          % (rel or "english", agent.device, agent.dtype, n, total / 1e9, dict(counts)))
    if torch.cuda.is_available():
        print("   cuda allocated=%.2f GB reserved=%.2f GB"
              % (torch.cuda.memory_allocated() / 1e9, torch.cuda.memory_reserved() / 1e9))
    del agent
    import gc
    gc.collect()
