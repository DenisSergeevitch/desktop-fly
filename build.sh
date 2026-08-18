#!/bin/zsh
# Build DesktopFly
cd "$(dirname "$0")"
swiftc -O -swift-version 5 -o DesktopFly main.swift FlyModel.swift Sim.swift BrainView.swift \
    Environment.swift -framework Cocoa -framework SceneKit
echo "Built ./DesktopFly"
