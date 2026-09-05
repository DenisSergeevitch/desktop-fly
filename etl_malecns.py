#!/usr/bin/env python3
"""Extract a bounded, anatomically identified leg circuit from MaleCNS v1.0.

Requires numpy, pandas and pyarrow. Raw files stay outside the repository:
    python3 etl_malecns.py /tmp/fly-male-cns --download

Connectivity is always a subset of published edges. Muscle names and peripheral
nerve annotations identify output/input channels; graph position never assigns
a leg, muscle, joint, or sensory tuning. See data/LOCOMOTOR_PROVENANCE.md.
"""
import argparse
from collections import Counter, deque
import hashlib
import json
from pathlib import Path
import urllib.request

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.feather as feather
import pyarrow.ipc as ipc

BASE = "https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome/"
FILES = {
    "annotations": "body-annotations-male-cns-v1.0-minconf-0.5.feather",
    "neurotransmitters": "body-neurotransmitters-male-cns-v1.0.feather",
    "weights": "connectome-weights-male-cns-v1.0-minconf-0.5.feather",
}
DN_TYPES = ["DNa01", "DNa02", "DNp09", "MDN", "DNg11"]
# Explicit side and front/middle/hind annotations, in the existing body order.
LEG_ORDER = ["RF", "LF", "RM", "LM", "RH", "LH"]
LEG_SUBCLASS = {"fl": 0, "ml": 2, "hl": 4}
LEG_NERVE = {"ProLN": 0, "MesoLN": 2, "MetaLN": 4}
MOTOR_CHANNEL = {
    "Ti flexor MN": "tibia_flexor",
    "Acc. ti flexor MN": "tibia_flexor",
    "Ti extensor MN": "tibia_extensor",
    "Tr flexor MN": "trochanter_flexor",
    "Acc. tr flexor MN": "trochanter_flexor",
    "Tr extensor MN": "trochanter_extensor",
    "Tergopleural/Pleural promotor MN": "coxa_promotor",
    "Pleural remotor/abductor MN": "coxa_remotor",
    "Sternal anterior rotator MN": "coxa_anterior_rotator",
    "Sternal posterior rotator MN": "coxa_posterior_rotator",
}
SENSORY_KIND = {
    "chordotonal organ": "chordotonal",
    "campaniform sensilla": "campaniform",
    "hair plate": "hair_plate",
    "leg": "proprioceptive_unspecified",
}
# Receptor effects are model assumptions, not measurements in the connectome.
# Unknown and modulatory transmissions remain present as anatomically weighted
# zero-current edges; their raw integer counts are preserved separately.
NT_SIGN = {"acetylcholine": 1, "gaba": -1, "glutamate": -1}


def clean(value):
    if isinstance(value, np.ndarray):
        return [clean(v) for v in value]
    if isinstance(value, (np.integer, np.floating)):
        value = value.item()
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return None
    return value


def sha256(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def ranked(series, count):
    # Explicit body-ID tie break makes extraction independent of input row order.
    return sorted(series.index, key=lambda k: (-series.loc[k], int(k)))[:count]


def extract(raw, out, download=False, closure_rounds=0, upstream_partners=6, inhibitory_partners=2):
    if closure_rounds < 0 or upstream_partners < 1 or inhibitory_partners < 0:
        raise SystemExit("Closure rounds must be nonnegative, upstream partners positive, and inhibitory partners nonnegative")
    raw.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    sources = {}
    for key, name in FILES.items():
        path = raw / name
        if not path.exists() and download:
            temporary = path.with_suffix(".partial")
            print("Downloading", name, flush=True)
            urllib.request.urlretrieve(BASE + name, temporary)
            temporary.replace(path)
        if not path.exists():
            raise SystemExit(f"Missing {path}; rerun with --download")
        sources[key] = {"url": BASE + name, "bytes": path.stat().st_size,
                        "sha256": sha256(path)}

    annotations = pd.read_feather(raw / FILES["annotations"]).set_index("bodyId", drop=False)
    assert annotations.index.is_unique, "Body annotations must have unique IDs"
    nt = pd.read_feather(raw / FILES["neurotransmitters"]).set_index("body", drop=False)
    descending = annotations[(annotations.superclass == "descending_neuron")
                             & annotations.type.isin(DN_TYPES)]
    motors = annotations[(annotations.superclass == "vnc_motor")
                         & annotations.subclass.isin(LEG_SUBCLASS)
                         & annotations.somaSide.isin(["L", "R"])
                         & annotations.type.isin(MOTOR_CHANNEL)].copy()
    motors["leg"] = motors.subclass.map(LEG_SUBCLASS) + (motors.somaSide == "L").astype(int)
    motors["channel"] = motors.type.map(MOTOR_CHANNEL)
    sensory = annotations[(annotations.superclass == "vnc_sensory")
                          & (annotations["class"] == "mechanosensory_proprioceptive")
                          & annotations.entryNerve.isin(LEG_NERVE)
                          & annotations.rootSide.isin(["L", "R"])
                          & annotations.subclass.isin(SENSORY_KIND)].copy()
    sensory["leg"] = sensory.entryNerve.map(LEG_NERVE) + (sensory.rootSide == "L").astype(int)
    sensory["kind"] = sensory.subclass.map(SENSORY_KIND)
    pool = annotations[annotations.superclass.isin(["vnc_intrinsic", "ascending_neuron"])
                       | annotations.index.isin(set(descending.index) | set(motors.index) | set(sensory.index))]
    pool = pool.sort_index()
    ids = pa.array(pool.index.to_numpy())
    full_in = np.zeros(len(pool), dtype=np.int64)
    full_out = np.zeros(len(pool), dtype=np.int64)
    reader = ipc.open_file(pa.memory_map(str(raw / FILES["weights"])))
    tables, raw_rows, raw_contacts = [], 0, 0
    for batch_index in range(reader.num_record_batches):
        batch = reader.get_batch(batch_index)
        weights = batch["weight"].to_numpy()
        raw_rows += len(batch)
        raw_contacts += int(weights.sum())
        pre = pc.fill_null(pc.index_in(batch["body_pre"], value_set=ids), -1).to_numpy()
        post = pc.fill_null(pc.index_in(batch["body_post"], value_set=ids), -1).to_numpy()
        for index, target in ((pre, full_out), (post, full_in)):
            valid = index >= 0
            np.add.at(target, index[valid], weights[valid])
        mask = (pre >= 0) & (post >= 0) & (weights >= 5)
        if mask.any():
            tables.append(pa.Table.from_batches([batch.filter(pa.array(mask))]))
    edges = pa.concat_tables(tables).to_pandas()
    assert not edges.duplicated(["body_pre", "body_post"]).any()
    print(f"Raw: {raw_rows:,} segment pairs / {raw_contacts:,} contacts; "
          f"candidate graph: {len(pool):,} neurons / {len(edges):,} edges", flush=True)
    pool["fullInput"] = full_in
    pool["fullOutput"] = full_out

    dn_ids = set(descending.index)
    motor_ids = set(motors.index)
    vnc_ids = set(pool[pool.superclass == "vnc_intrinsic"].index)
    dn_vnc = edges[edges.body_pre.isin(dn_ids) & edges.body_post.isin(vnc_ids)]
    direct = set(dn_vnc.body_post)
    # A candidate premotor must be at most two VNC hops from an identified DN.
    bridges = edges[edges.body_pre.isin(direct) & edges.body_post.isin(vnc_ids)]
    reachable = direct | set(bridges.body_post)
    to_motor = edges[edges.body_pre.isin(reachable) & edges.body_post.isin(motor_ids)]
    premotor = set()
    for (_, _), group in motors.groupby(["leg", "channel"]):
        scores = to_motor[to_motor.body_post.isin(group.index)].groupby("body_pre").weight.sum()
        premotor.update(ranked(scores, 12))
    # Keep strong native inputs for every selected descending cell as well.
    for _, group in dn_vnc.groupby("body_pre"):
        premotor.update(ranked(group.set_index("body_post").weight, 6))
    # Preserve a real shortest connecting edge for any selected two-hop premotor.
    for body in sorted(premotor - direct):
        options = bridges[bridges.body_post == body].set_index("body_pre").weight
        premotor.add(int(ranked(options, 1)[0]))
    selected = dn_ids | motor_ids | premotor

    # Reserve sensors by explicit leg and anatomical receptor class; choose their
    # strongest actual outgoing contacts onto the selected locomotor network.
    sensor_scores = edges[edges.body_pre.isin(sensory.index)
                          & edges.body_post.isin(selected)].groupby("body_pre").weight.sum()
    selected_sensory = set()
    for (_, _), group in sensory.groupby(["leg", "kind"]):
        scores = sensor_scores[sensor_scores.index.isin(group.index)]
        selected_sensory.update(ranked(scores, 10))
    selected |= selected_sensory

    # Closed ascending routes must have selected VNC/sensory input AND an actual
    # synapse onto one of the selected native male DNs. No cross-specimen edges.
    asc_ids = set(pool[pool.superclass == "ascending_neuron"].index)
    asc_in = edges[edges.body_pre.isin(premotor | selected_sensory)
                   & edges.body_post.isin(asc_ids)].groupby("body_post").weight.sum()
    asc_to_dn = edges[edges.body_pre.isin(asc_in.index) & edges.body_post.isin(dn_ids)]
    selected_ascending = set()
    for _, group in asc_to_dn.groupby("body_post"):
        scores = group.set_index("body_pre").weight
        selected_ascending.update(ranked(scores, 4))
    selected |= selected_ascending
    # Optional completeness experiment. Default extraction is byte-for-byte
    # unchanged. Add real upstream VNC cells, retaining the existing output and
    # sensory identities, rather than inventing oscillator connections.
    base_premotor = set(premotor)
    base_selected = set(selected)
    closure_counts = []
    frontier = set(premotor)
    negative_bodies = set(nt[nt.consensus_nt.isin(["gaba", "glutamate"])].index)
    vnc_incoming = edges[edges.body_pre.isin(vnc_ids)]
    for _ in range(closure_rounds):
        incoming = vnc_incoming[vnc_incoming.body_post.isin(frontier)]
        additions = set()
        for _, group in incoming.groupby("body_post"):
            strengths = group.set_index("body_pre").weight
            additions.update(ranked(strengths, upstream_partners))
            inhibitory = strengths[strengths.index.isin(negative_bodies)]
            additions.update(ranked(inhibitory, inhibitory_partners))
        additions -= selected
        selected |= additions
        premotor |= additions
        frontier = additions
        closure_counts.append(len(additions))
    selected_ids = sorted(selected)
    index_of = {body: i for i, body in enumerate(selected_ids)}
    induced = edges[edges.body_pre.isin(selected) & edges.body_post.isin(selected)].sort_values(
        ["body_pre", "body_post"])

    neurons = []
    for body in selected_ids:
        row = annotations.loc[body]
        if body in dn_ids:
            role = "descending"
        elif body in motor_ids:
            role = "motor"
        elif body in selected_sensory:
            role = "sensory"
        elif body in selected_ascending:
            role = "ascending"
        else:
            role = "premotor"
        transmitter = nt.loc[body] if body in nt.index else None
        side = row.rootSide if role == "sensory" else row.somaSide
        node = {"id": str(body), "type": clean(row.type) or "untyped", "role": role,
                "side": {"L": "left", "R": "right", "M": "center"}.get(side, "unknown"),
                "leg": int(motors.loc[body, "leg"]) if role == "motor" else
                       int(sensory.loc[body, "leg"]) if role == "sensory" else None,
                "motorChannel": MOTOR_CHANNEL.get(row.type) if role == "motor" else None,
                "sensoryKind": SENSORY_KIND.get(row.subclass) if role == "sensory" else None,
                "sensoryJoint": None, "sensoryDirection": None,
                "annotations": {key: clean(row[key]) for key in
                    ["type", "instance", "superclass", "class", "subclass", "somaSide", "rootSide",
                     "somaNeuromere", "entryNerve", "exitNerve", "receptorType", "flywireType",
                     "mancType", "mancBodyid", "matchingNotes", "status", "somaLocation"]},
                "neurotransmitter": {key: clean(transmitter[key]) if transmitter is not None else None
                    for key in ["consensus_nt", "predicted_nt", "predicted_nt_confidence", "ground_truth",
                                "celltype_predicted_nt", "celltype_predicted_nt_confidence"]}}
        neurons.append(node)
    edge_rows, unsigned_counts = [], []
    for pre, post, count in induced[["body_pre", "body_post", "weight"]].itertuples(index=False, name=None):
        neurotransmitter = neurons[index_of[pre]]["neurotransmitter"]["consensus_nt"]
        edge_rows.append([index_of[pre], index_of[post], int(count) * NT_SIGN.get(neurotransmitter, 0)])
        unsigned_counts.append(int(count))

    # Anatomical path evidence and checks are intrinsic to extraction. Each
    # representative path lists actual body IDs and published contact counts.
    outgoing = {}
    for pre, post, count in induced[["body_pre", "body_post", "weight"]].itertuples(index=False, name=None):
        outgoing.setdefault(pre, []).append((post, int(count)))
    reached = {body: [] for body in sorted(dn_ids)}
    queue = deque(sorted(dn_ids))
    while queue:
        body = queue.popleft()
        for target, count in sorted(outgoing.get(body, []), key=lambda pair: (-pair[1], pair[0])):
            if target not in reached:
                reached[target] = reached[body] + [[str(body), str(target), count]]
                queue.append(target)
    paths, coverage = [], []
    selected_inputs = induced.groupby("body_post").weight.sum()
    for (leg, channel), group in motors.groupby(["leg", "channel"]):
        reachable_motors = sorted(set(group.index) & reached.keys())
        assert reachable_motors, f"No descending route to {LEG_ORDER[leg]} {channel}"
        best = min(reachable_motors, key=lambda body: (len(reached[body]), body))
        paths.append({"leg": int(leg), "label": LEG_ORDER[leg], "motorChannel": channel,
                      "motorBodyId": str(best), "path": reached[best]})
        total_input = int(pool.loc[group.index, "fullInput"].sum())
        retained_input = int(selected_inputs.reindex(group.index, fill_value=0).sum())
        coverage.append({"leg": int(leg), "label": LEG_ORDER[leg], "motorChannel": channel,
                         "neurons": len(group), "reachableNeurons": len(reachable_motors),
                         "fullIncomingContacts": total_input, "retainedIncomingContacts": retained_input,
                         "incomingFraction": round(retained_input / max(1, total_input), 6)})
    for leg in range(6):
        for channel in ["tibia_flexor", "tibia_extensor", "trochanter_flexor", "trochanter_extensor",
                        "coxa_anterior_rotator", "coxa_posterior_rotator"]:
            assert any(p["leg"] == leg and p["motorChannel"] == channel for p in paths)
        assert any(n["leg"] == leg and n["role"] == "sensory" for n in neurons)
    assert selected_ascending, "No real ascending return path survived selection"
    assert len(edge_rows) == len(unsigned_counts)
    assert all(c > 0 for c in unsigned_counts)
    report = {
        "rawSegmentPairRows": raw_rows, "rawSegmentPairContacts": raw_contacts,
        "annotationRows": len(annotations), "neurotransmitterRows": len(nt),
        "candidateNeurons": len(pool), "candidateEdgesAtLeastFive": len(edges),
        "neurons": len(neurons), "edges": len(edge_rows), "contacts": sum(unsigned_counts),
        "roles": dict(Counter(n["role"] for n in neurons)),
        "neurotransmitters": dict(Counter(n["neurotransmitter"]["consensus_nt"] or "missing" for n in neurons)),
        "zeroCurrentEdges": sum(e[2] == 0 for e in edge_rows),
        "zeroCurrentContacts": sum(c for e, c in zip(edge_rows, unsigned_counts) if e[2] == 0),
        "descendingTypes": dict(Counter(descending.type)),
        "motorCoverage": coverage, "descendingToMotorPaths": paths,
        "selectedSensoryByLegAndKind": {f"{LEG_ORDER[leg]}:{kind}": sum(
            n["role"] == "sensory" and n["leg"] == leg and n["sensoryKind"] == kind for n in neurons)
            for leg in range(6) for kind in SENSORY_KIND.values()},
        "ascendingReturnEdges": int(sum(induced.body_pre.isin(selected_ascending) & induced.body_post.isin(dn_ids))),
    }
    provenance = {
        "dataset": "MaleCNS v1.0", "specimen": "male Drosophila melanogaster",
        "downloadPage": "https://male-cns.janelia.org/download/", "license": "CC-BY-4.0",
        "files": sources, "edgeThreshold": 5, "synapseConfidenceThreshold": 0.5,
        "selection": "All named Ti/Tr flexor-extensor, coxa promotor/remotor and sternal anterior/posterior rotator motor cells; "
                     "12 strongest DN-reachable VNC partners per leg/motor channel; strongest direct DN "
                     "targets and required real connecting partners; up to 10 sensors per leg/receptor "
                     "class; up to 4 ascending cells per DN with an actual VNC-to-DN return path.",
        "weightModel": {"consensusNTSigns": NT_SIGN, "unknownAndModulatorySign": 0,
                        "note": "Signs are model assumptions; rawSynapseCounts preserve original contact counts."},
        "legAssignment": "Motor subclass fl/ml/hl + somaSide; sensory entryNerve ProLN/MesoLN/MetaLN + rootSide.",
        "muscleFunctionSource": {
            "url": "https://faculty.washington.edu/tuthill/docs/azevedo24_appendix.pdf",
            "title": "Azevedo et al. 2024, Supplementary Methods: Identification of leg motor neuron targets",
            "interpretation": "The anatomical table identifies anterior/posterior coxal movement for sternal "
                              "anterior/posterior rotators and trochanter flexors/extensors as levators/depressors. "
                              "Distinct source muscle channels remain separate in the data; projecting coxal "
                              "rotation and promotion/remotion onto one body joint is a mechanical simplification."},
        "sensoryTuning": "No joint or directional tuning supplied in these annotations. All angle, velocity, "
                         "contact and load transduction is an explicit body-model assumption.",
        "premotorRole": "Operational selection label for VNC interneurons on retained descending-to-motor routes; "
                        "includes connecting interneurons, not a claim that every cell directly innervates a motor neuron.",
        "flywireInterface": "Existing female FlyWire v783 and native male DNs are different specimens. "
                            "A same-type/side activity interface is modeled; no cross-specimen synapses are claimed.",
        "scope": "Leg locomotor subgraph, not the complete CNS. Muscles, body mechanics, neuron dynamics, "
                 "sensory tuning, omitted inputs and neuromodulation remain modeled or unresolved.",
    }
    if closure_rounds:
        base_induced = induced[induced.body_pre.isin(base_selected) & induced.body_post.isin(base_selected)]
        baseline_input = int(base_induced[base_induced.body_post.isin(base_premotor)].weight.sum())
        expanded_input = int(induced[induced.body_post.isin(base_premotor)].weight.sum())
        full_input = int(pool.loc[sorted(base_premotor), "fullInput"].sum())
        recurrence = induced[induced.body_pre.isin(premotor) & induced.body_post.isin(premotor)]
        provenance["upstreamClosure"] = {
            "rounds": closure_rounds, "strongestPartnersPerTarget": upstream_partners,
            "strongestInhibitoryPartnersPerTarget": inhibitory_partners,
            "addedNeuronsByRound": closure_counts,
            "note": "Union of strongest incoming VNC contacts and strongest GABA/glutamate contacts per target; "
                    "each further round targets newly added VNC cells. No contacts are synthesized or reweighted."}
        report["upstreamClosure"] = {
            **provenance["upstreamClosure"], "basePremotorNeurons": len(base_premotor),
            "basePremotorFullIncomingContacts": full_input,
            "basePremotorBaselineIncomingContacts": baseline_input,
            "basePremotorExpandedIncomingContacts": expanded_input,
            "basePremotorBaselineIncomingFraction": round(baseline_input / max(1, full_input), 6),
            "basePremotorExpandedIncomingFraction": round(expanded_input / max(1, full_input), 6),
            "expandedPremotorRecurrentEdges": len(recurrence),
            "expandedPremotorRecurrentContacts": int(recurrence.weight.sum()),
            "expandedPremotorRecurrentInhibitoryContacts": int(recurrence[recurrence.body_pre.isin(negative_bodies)].weight.sum()),
            "addedNeuronsReachableFromDescending": len((selected - base_selected) & reached.keys()),
        }
        provenance["premotorRole"] += " Expanded alternatives also include explicitly selected upstream VNC partners."
    circuit = {"schemaVersion": 1, "source": "MaleCNS v1.0 public annotated leg locomotor subgraph",
               "legOrder": LEG_ORDER, "neurons": neurons, "edges": edge_rows,
               "rawSynapseCounts": unsigned_counts, "provenance": provenance,
               "summary": {k: report[k] for k in ["neurons", "edges", "contacts", "roles", "zeroCurrentEdges"]}}
    (out / "locomotor_circuit.json").write_text(json.dumps(circuit, separators=(",", ":"), allow_nan=False) + "\n")
    (out / "locomotor_report.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps(circuit["summary"], indent=2))
    print("Verified all six legs have real DN paths to coxal rotator, Ti and Tr antagonist channels and sensory inputs; "
          f"{len(selected_ascending)} ascending neurons return to native male DNs.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("raw_dir", type=Path)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent / "data")
    parser.add_argument("--closure-rounds", type=int, default=0,
                        help="Optional upstream VNC closure rounds; zero preserves the default graph")
    parser.add_argument("--upstream-partners", type=int, default=6,
                        help="Strongest incoming VNC partners per target in each closure round")
    parser.add_argument("--inhibitory-partners", type=int, default=2,
                        help="Additionally retain this many strongest GABA/glutamate partners per target")
    arguments = parser.parse_args()
    extract(arguments.raw_dir, arguments.out, arguments.download, arguments.closure_rounds,
            arguments.upstream_partners, arguments.inhibitory_partners)
