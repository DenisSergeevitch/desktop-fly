#!/bin/zsh
# Build DesktopFly
set -e
cd "$(dirname "$0")"
# -wmo: one optimization unit, so the sim/body call chain inlines across files.
#   It also happens to build faster than the default primary-file mode here.
# -enforce-exclusivity=unchecked: the LIF loops touch class-stored arrays a few
#   million times a second, and the dynamic exclusivity check in front of every
#   one of those accesses (swift_beginAccess -> thread-local lookup) measured as
#   the single largest cost in the process. The sim is only ever stepped from the
#   SceneKit render queue; every cross-thread path goes through Coordinator's
#   lock or LIFSim.stimulate's, so there is nothing for the check to catch.
swiftc -module-cache-path "${TMPDIR:-/tmp}/desktopfly-module-cache" -O -wmo \
    -enforce-exclusivity=unchecked -swift-version 5 -o DesktopFly \
    main.swift FlyModel.swift LegDynamics.swift Locomotor.swift LocomotorTests.swift BeetleModel.swift Sim.swift BrainView.swift \
    Environment.swift -framework Cocoa -framework SceneKit
echo "Built ./DesktopFly"
