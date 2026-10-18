import json, struct, os, collections

base = os.path.join(os.environ["USERPROFILE"], ".cache", "huggingface", "hub",
                    "models--convaiinnovations--laya", "snapshots",
                    "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851")
for rel in ["model.safetensors", "multilingual/model.safetensors", "typed-decisions/model.safetensors"]:
    p = os.path.join(base, *rel.split("/"))
    with open(p, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        hdr = json.loads(f.read(n))
    c = collections.Counter()
    total = 0
    params = 0
    for k, v in hdr.items():
        if k == "__metadata__":
            continue
        c[v["dtype"]] += 1
        b = v["data_offsets"][1] - v["data_offsets"][0]
        total += b
    print(rel, dict(c), "filebytes=%.1fMB" % (total / 1e6))
