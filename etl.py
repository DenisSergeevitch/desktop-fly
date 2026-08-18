#!/usr/bin/env python3
"""Build compact real-data files for DesktopFly from FlyWire Codex v783 dumps.

Inputs (raw Codex downloads, gzipped CSVs):
  classification.csv.gz          root_id, flow, super_class, class, sub_class, hemilineage, side, nerve
  coordinates.csv.gz             root_id, position "[x y z]" (nm), supervoxel_id
  connections.csv.gz             pre_root_id, post_root_id, neuropil, syn_count, nt_type  (>=5 syn)
  consolidated_cell_types.csv.gz root_id, primary_type, additional_type(s)

Outputs:
  data/brain_points.json   ~22k real soma positions + super_class index (for the brain viz)
  data/circuit.json        escape/steering circuit: real neurons, real signed synapse weights

Usage: python3 etl.py <raw_dir>
"""
import csv, gzip, json, os, sys
from collections import defaultdict

RAW = sys.argv[1] if len(sys.argv) > 1 else "."
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
os.makedirs(OUT, exist_ok=True)

CORE_TYPES = {          # primary_type -> role
    "LC4": "lc4",       # looming detector population (giant-fiber input)
    "LPLC2": "lplc2",   # looming detector population (giant-fiber input)
    "DNp01": "gf",      # giant fiber (escape command neuron)
    "DNa02": "dna02",   # steering descending neuron
    "DNa01": "dna01",   # steering descending neuron (partner of DNa02)
    "DNp09": "dnp09",   # forward-walking command neuron
    "DNg11": "dng11",   # grooming command neuron
    "MDN": "mdn",       # moonwalker (backward walking) descending neuron
    "DNp02": "escw",    # loom-responsive escape-maneuver DNs (wing responses)
    "DNp04": "escw",
    "DNp11": "escw",
}
NT_SIGN = {"ACH": 1.0, "GABA": -1.0, "GLUT": -1.0, "DA": 0.5, "SER": 0.5, "OCT": 0.5}
MAX_PARTNERS = 330
MAX_POINTS = 22000

def rows(name):
    with gzip.open(os.path.join(RAW, name), "rt") as f:
        r = csv.reader(f)
        header = next(r)
        yield from r

# --- cell types: find core populations -------------------------------------
core = {}            # root_id -> role
type_of = {}         # root_id -> primary_type (kept only for circuit members)
counts = defaultdict(int)
for row in rows("consolidated_cell_types.csv.gz"):
    rid, ptype = row[0], row[1].strip()
    # strict primary_type match only: additional_type matches pulled in
    # near-miss cell types (DNp71 as DNp09, DNae001 as DNa01)
    role = CORE_TYPES.get(ptype)
    if role:
        core[rid] = role
        type_of[rid] = ptype
        counts[ptype] += 1
print("core populations:", dict(counts))
if not counts.get("LC4") or not counts.get("LPLC2") or not counts.get("DNp01"):
    sys.exit("FATAL: missing a core population — check type names")

# --- classification + coordinates ------------------------------------------
klass = {}           # root_id -> (super_class, side)
for row in rows("classification.csv.gz"):
    klass[row[0]] = (row[2], row[6])

pos = {}             # root_id -> (x,y,z) nm, first occurrence
for row in rows("coordinates.csv.gz"):
    rid = row[0]
    if rid in pos:
        continue
    p = row[1].strip("[]").split()
    if len(p) == 3:
        pos[rid] = (float(p[0]), float(p[1]), float(p[2]))
print(f"classification: {len(klass)}, coordinates: {len(pos)}")

# --- connections pass 1: core-core edges + partner strengths ----------------
partner_strength = defaultdict(int)
strength_by_role = defaultdict(lambda: defaultdict(int))   # role -> partner -> syn
n_edges_seen = 0
for row in rows("connections.csv.gz"):
    pre, post, syn = row[0], row[1], int(row[3])
    n_edges_seen += 1
    pre_core, post_core = pre in core, post in core
    if pre_core and not post_core:
        partner_strength[post] += syn
        strength_by_role[core[pre]][post] += syn
    elif post_core and not pre_core:
        partner_strength[pre] += syn
        strength_by_role[core[post]][pre] += syn
print(f"connections rows: {n_edges_seen}, candidate partners: {len(partner_strength)}")

usable = lambda r: r in pos and r in klass
ranked = [rid for rid, s in sorted(partner_strength.items(), key=lambda kv: -kv[1]) if usable(rid)]
partners, seen = [], set()
def take(cands, k):
    n = 0
    for r in cands:
        if r in seen or not usable(r):
            continue
        seen.add(r); partners.append(r); n += 1
        if n == k:
            break
# every small command population gets its own strongest partners, so no DN
# ends up driven by noise alone
for role in ("gf", "dna01", "dna02", "dnp09", "dng11", "mdn", "escw"):
    take([r for r, s in sorted(strength_by_role[role].items(), key=lambda kv: -kv[1])], 10)
# reserved slots for body->brain feedback targets
take([r for r in ranked if klass[r][0] == "ascending"], 24)
take([r for r in ranked if klass[r][0] == "sensory"], 16)
take(ranked, MAX_PARTNERS - len(partners))
from collections import Counter as _C
print("partner super_classes:", dict(_C(klass[r][0] for r in partners)))
members = list(core.keys()) + partners
member_idx = {rid: i for i, rid in enumerate(members)}
print(f"circuit members: {len(members)} ({len(core)} core + {len(partners)} partners)")

# --- connections pass 2: all edges within the circuit -----------------------
edges = []
nt_missing = 0
for row in rows("connections.csv.gz"):
    pre, post = row[0], row[1]
    i, j = member_idx.get(pre), member_idx.get(post)
    if i is None or j is None:
        continue
    syn, nt = int(row[3]), row[4].strip().upper()
    sign = NT_SIGN.get(nt)
    if sign is None:
        sign, nt_missing = 1.0, nt_missing + 1
    edges.append((i, j, round(syn * sign, 1)))
print(f"circuit edges: {len(edges)} (unknown nt on {nt_missing})")

# --- normalization transform (fit whole brain into [-10,10]) ----------------
xs = [p[0] for p in pos.values()]; ys = [p[1] for p in pos.values()]; zs = [p[2] for p in pos.values()]
cx, cy, cz = (min(xs)+max(xs))/2, (min(ys)+max(ys))/2, (min(zs)+max(zs))/2
scale = 20.0 / max(max(xs)-min(xs), max(ys)-min(ys), max(zs)-min(zs))
def norm(p):
    # FAFB: x = left-right, y = dorsal-ventral (image y down), z = anterior-posterior
    return (round((p[0]-cx)*scale, 3), round(-(p[1]-cy)*scale, 3), round(-(p[2]-cz)*scale, 3))

# --- brain point cloud ------------------------------------------------------
SUPER_CLASSES = ["optic", "central", "sensory", "visual_projection", "visual_centrifugal",
                 "descending", "ascending", "motor", "endocrine"]
sc_idx = {s: i for i, s in enumerate(SUPER_CLASSES)}
cloud_ids = sorted(rid for rid in pos if rid in klass)
stride = max(1, len(cloud_ids) // MAX_POINTS)
points = []
for rid in cloud_ids[::stride]:
    sc = klass[rid][0]
    x, y, z = norm(pos[rid])
    points.append([x, y, z, sc_idx.get(sc, 1)])
with open(os.path.join(OUT, "brain_points.json"), "w") as f:
    json.dump({"classes": SUPER_CLASSES, "points": points,
               "source": "FlyWire Codex FAFB v783 coordinates.csv + classification.csv"}, f)
print(f"brain_points.json: {len(points)} points")

# --- circuit.json -----------------------------------------------------------
neurons = []
for rid in members:
    sc, side = klass.get(rid, ("", ""))
    p = norm(pos[rid]) if rid in pos else (0, 0, 0)
    neurons.append({"id": rid, "type": type_of.get(rid, sc or "?"),
                    "role": core.get(rid, "other"), "side": side, "pos": list(p)})
with open(os.path.join(OUT, "circuit.json"), "w") as f:
    json.dump({"neurons": neurons, "edges": edges,
               "source": "FlyWire Codex FAFB v783 connections.csv (syn>=5, signed by nt_type)"}, f)
print(f"circuit.json: {len(neurons)} neurons, {len(edges)} edges")

# report: strongest loom->GF convergence + in-circuit drive per DN population
gf_ids = {member_idx[r] for r, role in core.items() if role == "gf"}
loom_ids = {member_idx[r] for r, role in core.items() if role in ("lc4", "lplc2")}
loom_gf = [e for e in edges if e[0] in loom_ids and e[1] in gf_ids]
print(f"sanity: direct loom->GF edges: {len(loom_gf)}, total syn: {sum(abs(e[2]) for e in loom_gf):.0f}")
role_of = {member_idx[r]: role for r, role in core.items()}
for role in ("gf", "dna01", "dna02", "dnp09", "dng11", "mdn", "escw"):
    ids = {i for i, r in role_of.items() if r == role}
    indeg = sum(abs(e[2]) for e in edges if e[1] in ids)
    print(f"  in-circuit drive onto {role}: {indeg:.0f} syn")
