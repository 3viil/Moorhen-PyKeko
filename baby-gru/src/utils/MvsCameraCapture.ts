// Convert Moorhen's WebGL camera state to MVS camera params, so the
// portable viewer opens looking at the same thing PyKeko was showing.
//
// Moorhen's view matrix construction (mgWebGL.tsx drawScene):
//   mvMatrix = T_z(-fogClipOffset) · R(quat) · T(origin)
// where `origin` is stored NEGATED (i.e. origin = -worldCentre).
//
// MVS camera params (mvs-tree.js): target/position/up in world coords.
//
// Derivation:
//   The scene centre in world space is C = -origin.
//   mvMatrix(C) = (0, 0, -fogClipOffset) — i.e. the centre sits in front of
//     the camera at z = -fogClipOffset.
//   The camera in view space is at the origin. To find its world position,
//   invert the view matrix at (0,0,0,1):
//     camera_world = T(C) · R⁻¹ · (0, 0, +fogClipOffset)
//                  = C + R⁻¹ · (0, 0, +fogClipOffset)
//   And the screen-Y direction in world space:
//     up_world = R⁻¹ · (0, 1, 0)
//
// Zoom complication: Moorhen scales the projection matrix by 1/zoom
// (orthographic-style zoom). Mol* uses a perspective camera, so we
// approximate by moving the camera proportionally — distance / zoom —
// which preserves apparent size at the target depth. Off-target depths
// won't match exactly, but the overall framing reads right.

export interface MvsCamera {
    target: [number, number, number];
    position: [number, number, number];
    up: [number, number, number];
}

const DEFAULT_FOG_CLIP_OFFSET = 250.0;  // mgWebGL.tsx:1055

// Rotate vector v by unit quaternion q = [x, y, z, w], i.e. v' = q ⊗ v ⊗ q⁻¹.
// Uses the standard expansion that avoids constructing the full matrix.
function rotateByQuat(
    q: [number, number, number, number],
    v: [number, number, number],
): [number, number, number] {
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const vx = v[0], vy = v[1], vz = v[2];
    // t = 2 * (q.xyz × v)
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    // v' = v + q.w * t + (q.xyz × t)
    return [
        vx + qw * tx + (qy * tz - qz * ty),
        vy + qw * ty + (qz * tx - qx * tz),
        vz + qw * tz + (qx * ty - qy * tx),
    ];
}

/**
 * Read the live camera from Moorhen's GL state and convert to MVS.
 * Prefers Redux (source of truth, mutated by every centre/zoom/rotate dispatch);
 * falls back to the MGWebGL instance fields (which usually mirror Redux but
 * can lag in non-rendering contexts). Returns null if neither is available.
 */
export function captureCamera(): MvsCamera | null {
    const glRef = (window as any).__moorhen_glRef__;
    const inst = glRef?.current;
    const reduxState = inst?.props?.store?.getState?.()?.glRef;

    const len = (x: any) => (x != null && typeof x.length === "number" ? x.length : 0);

    // Source-of-truth: Redux. Quat is stored as either [x,y,z,w] array or
    // an object with numeric keys depending on how it was last dispatched.
    const reduxQuat = reduxState?.quat;
    const quatFromRedux: [number, number, number, number] | null =
        reduxQuat != null && (Array.isArray(reduxQuat) || len(reduxQuat) >= 4)
            ? [reduxQuat[0], reduxQuat[1], reduxQuat[2], reduxQuat[3]]
            : null;
    const originFromRedux: [number, number, number] | null =
        reduxState?.origin != null && len(reduxState.origin) >= 3
            ? [reduxState.origin[0], reduxState.origin[1], reduxState.origin[2]]
            : null;
    const zoomFromRedux = typeof reduxState?.zoom === "number" && reduxState.zoom > 0 ? reduxState.zoom : null;

    // Fallback: instance fields.
    if ((quatFromRedux == null || originFromRedux == null) && (!inst || len(inst.myQuat) < 4 || len(inst.origin) < 3)) {
        return null;
    }
    const quat: [number, number, number, number] = quatFromRedux ?? [inst.myQuat[0], inst.myQuat[1], inst.myQuat[2], inst.myQuat[3]];
    const origin: [number, number, number] = originFromRedux ?? [inst.origin[0], inst.origin[1], inst.origin[2]];
    const zoom = zoomFromRedux ?? (typeof inst?.zoom === "number" && inst.zoom > 0 ? inst.zoom : 1);
    const fogClipOffset = typeof inst?.fogClipOffset === "number" && inst.fogClipOffset > 0
        ? inst.fogClipOffset
        : DEFAULT_FOG_CLIP_OFFSET;

    // Target = -origin (Moorhen stores the negated centre).
    const target: [number, number, number] = [-origin[0], -origin[1], -origin[2]];

    // Inverse of a unit quaternion: negate the vector part, keep w.
    const invQuat: [number, number, number, number] = [-quat[0], -quat[1], -quat[2], quat[3]];

    // Distance from target to camera along the view direction.
    // Moorhen's pMatrix is scaled by 1/zoom, so on-screen size scales by 1/zoom
    // (zoom > 1 = appears smaller / "zoomed out"; zoom < 1 = appears bigger /
    // "zoomed in"). In Mol*'s perspective camera, apparent size scales as
    // 1/distance, so to match: distance ∝ zoom. Multiplying — not dividing.
    const distance = fogClipOffset * zoom;

    // The eye-to-target direction in view space is (0, 0, -1); the
    // target-to-eye direction is (0, 0, +1). Rotate to world space.
    const targetToEye = rotateByQuat(invQuat, [0, 0, 1]);
    const position: [number, number, number] = [
        target[0] + targetToEye[0] * distance,
        target[1] + targetToEye[1] * distance,
        target[2] + targetToEye[2] * distance,
    ];

    const up = rotateByQuat(invQuat, [0, 1, 0]);

    return { target, position, up };
}
