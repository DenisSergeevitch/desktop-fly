// BeetleModel.swift — procedural 3D stag-beetle body, an alternate skin for the
// same FlyModel contract the behavior layer drives (legs[6] / foldedWings with
// exactly 2 children / blurWingL,R / abdomen), plus a pair of elytra.
//
// Local frame matches FlyModel.swift: +Y forward, +Z up, ground at z=0.
// The camera is orthographic straight down -Z, so this is read dorsally: the
// mandibles, the pronotum shield and the elytra seam carry the silhouette.

import Cocoa
import SceneKit

private let shellBlack = NSColor(calibratedRed: 0.13, green: 0.09, blue: 0.07, alpha: 1)
private let shellRed   = NSColor(calibratedRed: 0.31, green: 0.13, blue: 0.07, alpha: 1)
private let jawBlack   = NSColor(calibratedRed: 0.09, green: 0.06, blue: 0.05, alpha: 1)

/// One elytron outline, hinged at its front-inner corner (the local origin) so
/// opening swings it outward around that point. `side` is +1 right, -1 left; the
/// path is mirrored rather than the node, keeping both rotations sign-symmetric.
private func elytronShape(side: CGFloat) -> SCNGeometry {
    let p = NSBezierPath()
    let x = { (v: CGFloat) in side * v }
    p.move(to: NSPoint(x: 0, y: 0))
    p.curve(to: NSPoint(x: x(5.3), y: -4.6),
            controlPoint1: NSPoint(x: x(3.4), y: -0.2),
            controlPoint2: NSPoint(x: x(5.3), y: -2.2))
    p.curve(to: NSPoint(x: x(2.6), y: -12.2),
            controlPoint1: NSPoint(x: x(5.3), y: -8.4),
            controlPoint2: NSPoint(x: x(4.4), y: -11.2))
    p.curve(to: NSPoint(x: 0, y: -14.1),
            controlPoint1: NSPoint(x: x(1.7), y: -13.3),
            controlPoint2: NSPoint(x: x(0.7), y: -14.0))
    p.line(to: NSPoint(x: 0, y: 0))            // straight inner edge = the seam
    p.close()
    p.flatness = 0.1

    let shape = SCNShape(path: p, extrusionDepth: 2.2)
    shape.chamferRadius = 0.85                 // rounds the top edge into a dome
    let m = mat(shellRed, specular: 0.85, shininess: 0.95)
    m.isDoubleSided = true
    shape.materials = [m]
    return shape
}

/// Membranous hindwing — the surface that actually beats. Folded, it hides
/// under the elytron; it only shows once the elytra swing open.
private func hindwingShape(side: CGFloat) -> SCNGeometry {
    let p = NSBezierPath(ovalIn: NSRect(x: -1.9, y: -11.5, width: 3.8, height: 12.0))
    // `land()` refolds every wing to a fixed yaw of side*0.13; cancelling that
    // in the outline keeps the folded wing square under the elytron instead of
    // swinging its tip out past the shell edge.
    p.transform(using: AffineTransform(rotationByRadians: -side * 0.13))
    p.flatness = 0.1
    let shape = SCNShape(path: p, extrusionDepth: 0.12)
    let m = SCNMaterial()
    m.lightingModel = .blinn
    m.diffuse.contents = NSColor(calibratedRed: 0.58, green: 0.47, blue: 0.36, alpha: 0.42)
    m.specular.contents = NSColor(white: 0.85, alpha: 1)
    m.shininess = 0.85
    m.isDoubleSided = true
    shape.materials = [m]
    return shape
}

/// Pronotum shield: narrow at the head, widest at mid-length, squared off where
/// the elytra meet it — the outline that says "beetle" from directly above.
private func pronotumShape() -> SCNGeometry {
    let p = NSBezierPath()
    p.move(to: NSPoint(x: -3.3, y: 4.2))
    p.curve(to: NSPoint(x: -5.0, y: 0.4),
            controlPoint1: NSPoint(x: -4.6, y: 3.9), controlPoint2: NSPoint(x: -5.0, y: 2.2))
    p.curve(to: NSPoint(x: -4.3, y: -3.0),
            controlPoint1: NSPoint(x: -5.0, y: -1.4), controlPoint2: NSPoint(x: -4.8, y: -2.4))
    p.line(to: NSPoint(x: 4.3, y: -3.0))
    p.curve(to: NSPoint(x: 5.0, y: 0.4),
            controlPoint1: NSPoint(x: 4.8, y: -2.4), controlPoint2: NSPoint(x: 5.0, y: -1.4))
    p.curve(to: NSPoint(x: 3.3, y: 4.2),
            controlPoint1: NSPoint(x: 5.0, y: 2.2), controlPoint2: NSPoint(x: 4.6, y: 3.9))
    p.close()
    p.flatness = 0.1
    let shape = SCNShape(path: p, extrusionDepth: 3.0)
    shape.chamferRadius = 1.2
    let m = mat(shellBlack, specular: 0.85, shininess: 0.95)
    m.isDoubleSided = true
    shape.materials = [m]
    return shape
}

/// One mandible: a splayed outer segment, an inward-hooking tip, and an inner
/// tooth. Cones point along +Y by default, so the node yaw is a plain z-rotation.
private func buildMandible(side: CGFloat) -> SCNNode {
    let root = SCNNode()
    root.position = SCNVector3(side * 2.1, 10.8, 5.0)
    root.eulerAngles = SCNVector3(0, 0, -side * 0.42)          // splay outward

    let baseGeo = SCNCone(topRadius: 0.60, bottomRadius: 1.05, height: 5.0)
    baseGeo.materials = [mat(jawBlack, specular: 0.9, shininess: 0.95)]
    let base = SCNNode(geometry: baseGeo)
    base.position = SCNVector3(0, 2.5, 0)
    root.addChildNode(base)

    let joint = SCNNode()
    joint.position = SCNVector3(0, 5.0, 0)
    joint.eulerAngles = SCNVector3(0, 0, side * 1.16)          // hook back inward
    root.addChildNode(joint)

    let tipGeo = SCNCone(topRadius: 0.08, bottomRadius: 0.58, height: 4.2)
    tipGeo.materials = [mat(jawBlack, specular: 0.9, shininess: 0.95)]
    let tip = SCNNode(geometry: tipGeo)
    tip.position = SCNVector3(0, 2.1, 0)
    joint.addChildNode(tip)

    let toothGeo = SCNCone(topRadius: 0.06, bottomRadius: 0.42, height: 1.9)
    toothGeo.materials = [mat(jawBlack, specular: 0.9, shininess: 0.9)]
    let tooth = SCNNode(geometry: toothGeo)
    tooth.position = SCNVector3(-side * 0.45, 3.4, 0)
    tooth.eulerAngles = SCNVector3(0, 0, side * 1.45)
    root.addChildNode(tooth)

    return root
}

func buildBeetleModel() -> FlyModel {
    let root = SCNNode()
    root.scale = SCNVector3(FLY_SCALE, FLY_SCALE, FLY_SCALE)

    for side in [CGFloat(-1), 1] { root.addChildNode(buildMandible(side: side)) }

    let headGeo = SCNBox(width: 6.4, height: 4.2, length: 2.4, chamferRadius: 0.8)
    headGeo.materials = [mat(shellBlack, specular: 0.75, shininess: 0.85)]
    let head = SCNNode(geometry: headGeo)
    head.position = SCNVector3(0, 9.6, 5.4)
    root.addChildNode(head)

    let eyeGeo = SCNSphere(radius: 0.95)
    eyeGeo.materials = [mat(NSColor(calibratedWhite: 0.05, alpha: 1),
                            specular: 0.95, shininess: 0.95)]
    for side in [CGFloat(-1), 1] {
        let eye = SCNNode(geometry: eyeGeo)
        eye.position = SCNVector3(side * 3.1, 9.9, 6.0)
        eye.scale = SCNVector3(0.75, 1.0, 0.6)
        root.addChildNode(eye)
    }

    // geniculate antennae: an elbowed shaft ending in a small lamellate club
    for side in [CGFloat(-1), 1] {
        let shaftGeo = SCNCapsule(capRadius: 0.15, height: 2.6)
        shaftGeo.materials = [mat(jawBlack)]
        let shaft = SCNNode(geometry: shaftGeo)
        shaft.position = SCNVector3(side * 3.6, 9.6, 4.6)
        shaft.eulerAngles = SCNVector3(0, 0, -side * 1.05)
        root.addChildNode(shaft)

        let clubGeo = SCNBox(width: 0.65, height: 1.1, length: 0.35, chamferRadius: 0.15)
        clubGeo.materials = [mat(jawBlack)]
        let club = SCNNode(geometry: clubGeo)
        club.position = SCNVector3(side * 5.2, 10.2, 4.6)
        club.eulerAngles = SCNVector3(0, 0, -side * 1.25)
        root.addChildNode(club)
    }

    let pronotum = SCNNode(geometry: pronotumShape())
    pronotum.position = SCNVector3(0, 4.4, 5.6)
    root.addChildNode(pronotum)

    let scutGeo = SCNBox(width: 2.2, height: 1.8, length: 1.0, chamferRadius: 0.4)
    scutGeo.materials = [mat(shellBlack, specular: 0.8, shininess: 0.9)]
    let scut = SCNNode(geometry: scutGeo)
    scut.position = SCNVector3(0, 1.2, 6.2)
    root.addChildNode(scut)

    // abdomen: sits under the elytra, so it only shows once they open. The
    // behavior layer breathes it with a hardcoded base scale (0.9, 1.5, 0.75),
    // so size is set by the sphere radius alone.
    let abdGeo = SCNSphere(radius: 4.6)
    abdGeo.materials = [mat(NSColor(calibratedRed: 0.18, green: 0.11, blue: 0.08, alpha: 1),
                            specular: 0.4, shininess: 0.5)]
    // `abdomen` is an empty pivot: the behavior layer writes a hardcoded base
    // scale (0.9, 1.5, 0.75) onto it to breathe, so the extra flattening that
    // keeps a beetle abdomen tucked inside its shell lives on the child.
    let abdomen = SCNNode()
    abdomen.position = SCNVector3(0, -4.8, 3.7)
    abdomen.scale = SCNVector3(0.9, 1.5, 0.75)
    let abdShell = SCNNode(geometry: abdGeo)
    abdShell.scale = SCNVector3(1, 1, 0.60)
    abdomen.addChildNode(abdShell)
    root.addChildNode(abdomen)

    var legs: [Leg] = []
    let z: CGFloat = 4.0
    let specs: [(CGFloat, SCNVector3, CGFloat, CGFloat, Bool, CGFloat, CGFloat, CGFloat)] = [
        ( 1, SCNVector3( 4.4,  6.0, z),  0.95, 0.0, true,  4.0, 4.4, 2.6),
        (-1, SCNVector3(-4.4,  6.0, z),  0.95, 0.5, true,  4.0, 4.4, 2.6),
        ( 1, SCNVector3( 4.8,  2.2, z), -0.10, 0.5, false, 4.6, 5.0, 3.0),
        (-1, SCNVector3(-4.8,  2.2, z), -0.10, 0.0, false, 4.6, 5.0, 3.0),
        ( 1, SCNVector3( 4.4, -1.6, z), -0.95, 0.0, false, 5.4, 6.2, 3.6),
        (-1, SCNVector3(-4.4, -1.6, z), -0.95, 0.5, false, 5.4, 6.2, 3.6),
    ]
    for (side, attach, yawOff, phase, isFront, f, t, ta) in specs {
        let baseYaw: CGFloat = side > 0 ? yawOff : (.pi - yawOff)
        let leg = buildLeg(attach: attach, baseYaw: baseYaw, swingSign: side, phase: phase,
                           isFront: isFront, femur: f, tibia: t, tarsus: ta,
                           color: shellBlack.blended(withFraction: 0.18, of: shellRed) ?? shellBlack,
                           thickness: 1.35)
        root.addChildNode(leg.root)
        legs.append(leg)
    }

    // the two flapping surfaces the behavior layer drives, tucked under the elytra
    let foldedWings = SCNNode()
    for side in [CGFloat(-1), 1] {
        let wing = SCNNode(geometry: hindwingShape(side: side))
        wing.position = SCNVector3(side * 1.15, 0.6, 5.0)
        wing.eulerAngles = SCNVector3(0, 0, side * 0.13)
        foldedWings.addChildNode(wing)
    }
    root.addChildNode(foldedWings)

    // elytra: hinged at the seam, opened by updateWings (display only)
    var elytra: [SCNNode] = []
    for side in [CGFloat(-1), 1] {
        let e = SCNNode(geometry: elytronShape(side: side))
        e.position = SCNVector3(0, 1.6, 5.6)
        root.addChildNode(e)
        elytra.append(e)
    }

    func blurWing(_ side: CGFloat) -> SCNNode {
        let g = SCNSphere(radius: 1.0)
        let m = SCNMaterial()
        m.lightingModel = .constant
        m.diffuse.contents = NSColor(calibratedRed: 0.62, green: 0.52, blue: 0.40, alpha: 0.30)
        m.isDoubleSided = true
        g.materials = [m]
        let n = SCNNode(geometry: g)
        n.position = SCNVector3(side * 6.8, -1.2, 5.2)
        n.scale = SCNVector3(6.2, 2.6, 0.3)
        n.eulerAngles = SCNVector3(0, 0, side * -0.45)
        n.isHidden = true
        return n
    }
    let bl = blurWing(-1), br = blurWing(1)
    root.addChildNode(bl)
    root.addChildNode(br)

    return FlyModel(root: root, legs: legs, foldedWings: foldedWings,
                    blurWingL: bl, blurWingR: br, abdomen: abdomen,
                    elytraL: elytra[0], elytraR: elytra[1])
}
