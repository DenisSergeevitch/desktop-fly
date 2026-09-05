# MaleCNS locomotor circuit

`locomotor_circuit.json` is a bounded subgraph of the **MaleCNS v1.0** public
connectome. It supplements the existing female FlyWire v783 circuit; it does
not replace that specimen or turn the application into a complete CNS simulation.

The primary source is the [MaleCNS bulk download page](https://male-cns.janelia.org/download/).
The file embeds each exact download URL, byte size and SHA-256 digest in
`provenance.files`. Raw tables are kept outside the repository. The source data
and these derived data are [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Credit the MaleCNS collaboration: FlyEM at HHMI Janelia, University of Cambridge,
MRC Laboratory of Molecular Biology, and Google Research. The existing FlyWire
files retain their separate CC BY-NC 4.0 license.

## Reproduce

With Python 3, numpy, pandas and pyarrow installed:

```sh
python3 etl_malecns.py /tmp/fly-male-cns --download
```

The three public Feather tables total approximately 1.11 GB. The script streams
the full weighted graph to bound memory use. It writes this circuit and
`locomotor_report.json`, which records source row/contact totals, retained graph
counts, per-channel input coverage, and actual descending-to-motor paths.

## What is measured

- Body IDs, cell types, side, neuromere, peripheral nerves, receptor class,
  FlyWire/MANC type annotations, tracing status, soma coordinates and transmitter
  predictions are retained from the published tables. Soma coordinates are raw
  8 nm voxel coordinates, where provided; missing somata are left missing.
- Every retained graph edge is a published directed body-pair connection with
  at least five contacts in the source table filtered at synapse confidence 0.5.
  No edge is invented to complete a path, connect two datasets or balance sides.
- The **RF, LF, RM, LM, RH, LH** output order follows the app body. Motor legs
  use explicit `fl`/`ml`/`hl` subclass and `somaSide`; sensory legs use explicit
  `ProLN`/`MesoLN`/`MetaLN` entry nerve and `rootSide`. Premotor and ascending
  cells have no assigned leg. Graph position and ID parity never assign anatomy.
- Motor channels come from literal named muscle annotations: Ti flexor/extensor,
  Tr flexor/extensor, accessory flexors, named pleural promotor/remotor, and
  sternal anterior/posterior rotators.
  Anatomically unnamed motor types and other muscle groups are not assigned
  guessed actuator channels. In particular, the named promotor group occurs
  only on the front legs in this extraction. Sternal anterior/posterior rotator
  channels are present on all six legs. The
  [Azevedo et al. 2024 anatomical supplement](https://faculty.washington.edu/tuthill/docs/azevedo24_appendix.pdf)
  identifies these rotators with anterior/posterior coxal movement and
  trochanter flexors/extensors with elevation/depression. The distinct muscle
  channels remain separate in the data. A shared one-axis mechanical output
  is a body-model approximation, not an additional anatomical annotation.
- Sensory kinds use published `chordotonal organ`, `campaniform sensilla`,
  `hair plate`, or generic proprioceptive `leg` annotations. Only the three
  unambiguous leg nerves above are used; this is not all proprioception.

## What remains modeled

The graph measures contacts, not effective physiological weights. ACh is assigned
a positive sign, GABA and glutamate negative signs. Those receptor-effect choices
are assumptions. Unknown or modulatory transmitters retain their anatomical edges
with zero direct current. `rawSynapseCounts`, aligned one-to-one with `edges`,
preserve original integer counts, including zero-current edges. Original
individual and cell-type transmitter predictions and confidence values remain
available for a different physiological model.

The annotation tables do **not** identify the modeled angle/velocity tuning,
preferred direction or particular sensed joint of the selected proprioceptors.
Accordingly `sensoryJoint` and `sensoryDirection` are null. Any mapping of body
angle, angular velocity, contact or load to these cells is a declared model
assumption, not a measured neuron-specific response. A muscle label likewise
does not supply force, moment arm, activation kinetics or a complete mechanical
model.

`premotor` is an operational role for selected VNC interneurons, including
connecting interneurons; it does not assert that each directly contacts a motor
neuron. The selection keeps strong input partners per output channel and real
routes from identified male DNa01, DNa02, DNp09, MDN and DNg11 cells. Real
ascending paths return to those native male DNs. A modeled same-type/side
activity interface from the existing female FlyWire simulation is explicitly
cross-specimen; it is not a synapse in either source dataset.

Many incoming connections are omitted. The report gives both retained and full
incoming contact totals for each motor channel, so a visible movement cannot be
presented as a complete replay of the animal's motor physiology. Simulation
parameters, neural excitability, body mechanics and omitted inputs still require
modeling and behavioral calibration. A successful anatomical path check validates
the extraction; it does not validate biological motion.

The report's full raw-table totals include unannotated segments and fragments;
they should not be compared directly with the paper's neuron-to-neuron summary
counts as if they described the same filtered population.
