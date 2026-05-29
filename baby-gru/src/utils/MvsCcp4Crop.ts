// Crop a CCP4/MAP volume to a model bounding box (plus padding), in pure JS.
//
// Why: Moorhen's worker writes full CCP4 maps; embedded in a portable viewer
// they're 20-100+ MB each. For "look at the density around the molecule" use
// (the portable-viewer audience), cropping to model+padding cuts that to
// ~1-10 MB while preserving everything the reader cares about.
//
// CCP4/MRC2014 format reference:
//   https://www.ccpem.ac.uk/mrc_format/mrc2014.php
//   https://www.ccp4.ac.uk/html/maplib.html
//
// Header layout (256 int32 = 1024 bytes), then optional symmetry, then
// NC*NR*NS float32 grid values in column-fastest order.
//
// Crystallographic frame notes:
//   - The map's data covers ONE asymmetric unit's worth of grid points
//     (typically fractional [0,1) along each axis). A loaded molecule
//     can sit at any symmetry-equivalent position, including negative
//     fractional coordinates — so the model's bbox in grid space is NOT
//     constrained to fit inside the original NCSTART range. We translate
//     the grid by reading voxels modulo the grid count (the crystal IS
//     periodic, so this is exact), and report a shifted NCSTART/NRSTART/
//     NSSTART so Mol* renders the density at the model's location.
//   - Limits we accept:
//     - Orthorhombic-cell fast path for fractional conversion. Triclinic
//       cells over-crop slightly but render correctly.
//     - No downsampling in v1 — added only if cropped files turn out to
//       still be too big in practice.

const HEADER_BYTES = 1024;

// Field offsets in int32 words (1-indexed in CCP4 docs; 0-indexed here).
const F = {
    NC: 0, NR: 1, NS: 2, MODE: 3,
    NCSTART: 4, NRSTART: 5, NSSTART: 6,
    NX: 7, NY: 8, NZ: 9,
    // Cell: 6 floats at words 10-15 (0-idx)
    CELL_A: 10, CELL_B: 11, CELL_C: 12,
    CELL_ALPHA: 13, CELL_BETA: 14, CELL_GAMMA: 15,
    MAPC: 16, MAPR: 17, MAPS: 18,
    AMIN: 19, AMAX: 20, AMEAN: 21,
    ISPG: 22, NSYMBT: 23,
    // ORIGIN (3 floats) at words 49-51
    ORIGIN_X: 49, ORIGIN_Y: 50, ORIGIN_Z: 51,
    // 'MAP ' magic at word 52, MACHST at 53
    ARMS: 54,
};

export interface Ccp4Header {
    nc: number; nr: number; ns: number;
    mode: number;
    ncstart: number; nrstart: number; nsstart: number;
    nx: number; ny: number; nz: number;
    cellA: number; cellB: number; cellC: number;
    alpha: number; beta: number; gamma: number;
    mapc: number; mapr: number; maps: number;
    amin: number; amax: number; amean: number;
    ispg: number; nsymbt: number;
    originX: number; originY: number; originZ: number;
    arms: number;
}

function readHeader(buf: ArrayBuffer): Ccp4Header {
    const i32 = new Int32Array(buf, 0, 256);
    const f32 = new Float32Array(buf, 0, 256);
    return {
        nc: i32[F.NC], nr: i32[F.NR], ns: i32[F.NS],
        mode: i32[F.MODE],
        ncstart: i32[F.NCSTART], nrstart: i32[F.NRSTART], nsstart: i32[F.NSSTART],
        nx: i32[F.NX], ny: i32[F.NY], nz: i32[F.NZ],
        cellA: f32[F.CELL_A], cellB: f32[F.CELL_B], cellC: f32[F.CELL_C],
        alpha: f32[F.CELL_ALPHA], beta: f32[F.CELL_BETA], gamma: f32[F.CELL_GAMMA],
        mapc: i32[F.MAPC], mapr: i32[F.MAPR], maps: i32[F.MAPS],
        amin: f32[F.AMIN], amax: f32[F.AMAX], amean: f32[F.AMEAN],
        ispg: i32[F.ISPG], nsymbt: i32[F.NSYMBT],
        originX: f32[F.ORIGIN_X], originY: f32[F.ORIGIN_Y], originZ: f32[F.ORIGIN_Z],
        arms: f32[F.ARMS],
    };
}

function patchHeader(buf: ArrayBuffer, hdr: Ccp4Header) {
    const i32 = new Int32Array(buf, 0, 256);
    const f32 = new Float32Array(buf, 0, 256);
    i32[F.NC] = hdr.nc; i32[F.NR] = hdr.nr; i32[F.NS] = hdr.ns;
    i32[F.NCSTART] = hdr.ncstart; i32[F.NRSTART] = hdr.nrstart; i32[F.NSSTART] = hdr.nsstart;
    // NX/NY/NZ change under downsampling (they encode the cell sampling rate;
    // voxel size = cell / NX). Cell dimensions themselves are preserved.
    i32[F.NX] = hdr.nx; i32[F.NY] = hdr.ny; i32[F.NZ] = hdr.nz;
    f32[F.AMIN] = hdr.amin; f32[F.AMAX] = hdr.amax; f32[F.AMEAN] = hdr.amean;
    f32[F.ARMS] = hdr.arms;
    // cell, origin, mapc/mapr/maps, ispg, nsymbt, machst, MAP-magic
    // are all preserved as-is in the copied header bytes.
}

export interface CropOptions {
    /** Min corner of the bounding box, in orthogonal Å. */
    boxMin: [number, number, number];
    /** Max corner of the bounding box, in orthogonal Å. */
    boxMax: [number, number, number];
    /** Extra padding to add to each side of the box (Å). Default 8 — generous
     *  enough that a 1.5σ surface lobe doesn't get clipped at the edge. */
    paddingAngstroms?: number;
    /** Output file size budget per map (bytes). If the cropped grid would
     *  exceed this, the algorithm picks the smallest power-of-2 stride that
     *  fits the budget and emits a downsampled grid. Default 8 MB. Set 0 to
     *  disable downsampling. */
    maxBytes?: number;
}

export interface CroppedMap {
    /** Valid CCP4 file as bytes. */
    bytes: Uint8Array;
    /** Total output size. */
    sizeBytes: number;
    /** Downsample stride that was applied (1 = no downsample). */
    downsampleStride: number;
    /** AMEAN computed on the sub-grid. */
    newMean: number;
    /** ARMS (σ) computed on the sub-grid. Mol* uses this for relative_isovalue. */
    newStddev: number;
    /** What we cropped to, in grid-index coordinates (XYZ axis order, pre-downsample). */
    cropDescription: { startXYZ: [number, number, number]; sizeXYZ: [number, number, number] };
}

/**
 * Crop a CCP4 buffer to a bounding box (model-extent + padding).
 *
 * The grid axes (column/row/section) don't necessarily correspond to X/Y/Z
 * in that order — MAPC/MAPR/MAPS in the header tell us the mapping. We compute
 * the crop in XYZ space (because the bounding box is in XYZ) then translate
 * back to CRS for the actual extraction.
 */
export function cropCcp4(buf: ArrayBuffer, opts: CropOptions): CroppedMap {
    const hdr = readHeader(buf);
    if (hdr.mode !== 2) {
        throw new Error(`MvsCcp4Crop: unsupported MRC mode ${hdr.mode} (only float32, mode 2, is supported)`);
    }

    const pad = opts.paddingAngstroms ?? 8;

    // --- Convert bbox (Å) to fractional cell coordinates ---
    // Orthorhombic fast path. For triclinic this slightly over-crops; that's
    // safer than under-cropping and the rendered surface still looks right.
    const fmin: [number, number, number] = [
        (opts.boxMin[0] - pad) / hdr.cellA,
        (opts.boxMin[1] - pad) / hdr.cellB,
        (opts.boxMin[2] - pad) / hdr.cellC,
    ];
    const fmax: [number, number, number] = [
        (opts.boxMax[0] + pad) / hdr.cellA,
        (opts.boxMax[1] + pad) / hdr.cellB,
        (opts.boxMax[2] + pad) / hdr.cellC,
    ];

    // --- Convert fractional XYZ to grid indices in XYZ axis order ---
    const xyzCount = [hdr.nx, hdr.ny, hdr.nz];
    // Grid index relative to the cell origin; ORIGIN field (when non-zero,
    // typical for cryo-EM) shifts it. Crystallographic maps from Coot have
    // ORIGIN=0 and use NCSTART/NRSTART/NSSTART instead.
    const origin = [hdr.originX / hdr.cellA, hdr.originY / hdr.cellB, hdr.originZ / hdr.cellC];

    // Desired XYZ grid index range (inclusive lo, exclusive hi).
    const xyzLo: number[] = [0, 0, 0];
    const xyzHi: number[] = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
        xyzLo[a] = Math.floor((fmin[a] - origin[a]) * xyzCount[a]);
        xyzHi[a] = Math.ceil((fmax[a] - origin[a]) * xyzCount[a]);
    }

    // --- Map XYZ axes back to CRS (column/row/section) ---
    // mapc/mapr/maps say "axis (1=X,2=Y,3=Z) for the column/row/section index".
    // Build the inverse: for each XYZ axis, which CRS slot is it?
    const crsForXyz = [-1, -1, -1];
    crsForXyz[hdr.mapc - 1] = 0;
    crsForXyz[hdr.mapr - 1] = 1;
    crsForXyz[hdr.maps - 1] = 2;

    const origCrsStart = [hdr.ncstart, hdr.nrstart, hdr.nsstart];
    const origCrsCount = [hdr.nc, hdr.nr, hdr.ns];

    // Compute the desired CRS index range. We do NOT clamp to the file's present
    // range — the crystal is periodic, so a model at fractional Y = -0.5 is just
    // as valid as a model at +0.5, and we'll read the corresponding voxels via
    // modular indexing below. Mol*'s CCP4 reader honours arbitrary (including
    // negative) NCSTART/NRSTART/NSSTART.
    const newCrsStart: number[] = [0, 0, 0];
    const newCrsEnd: number[] = [0, 0, 0];  // exclusive
    for (let xyz = 0; xyz < 3; xyz++) {
        const crs = crsForXyz[xyz];
        newCrsStart[crs] = xyzLo[xyz];
        newCrsEnd[crs] = xyzHi[xyz];
    }

    // --- Pick downsample stride to fit the size budget ---
    // Each output voxel is 4 bytes; account for the 1024-byte header + symmetry.
    const rawNc = newCrsEnd[0] - newCrsStart[0];
    const rawNr = newCrsEnd[1] - newCrsStart[1];
    const rawNs = newCrsEnd[2] - newCrsStart[2];
    if (rawNc <= 0 || rawNr <= 0 || rawNs <= 0) {
        throw new Error(`MvsCcp4Crop: empty crop (${rawNc}x${rawNr}x${rawNs})`);
    }
    const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
    let stride = 1;
    if (maxBytes > 0) {
        const overhead = HEADER_BYTES + hdr.nsymbt;
        // Try strides 1, 2, 3, 4, ... — not just powers of two, because integer
        // strides give simpler voxel-position math (NX must remain integral).
        while (stride < 8) {
            const ceilDiv = (a: number, b: number) => Math.ceil(a / b);
            const bytes = ceilDiv(rawNc, stride) * ceilDiv(rawNr, stride) * ceilDiv(rawNs, stride) * 4 + overhead;
            if (bytes <= maxBytes) break;
            stride++;
        }
    }

    // --- Extract the sub-grid (with periodic wrap-around + stride downsample) ---
    const ceilDiv = (a: number, b: number) => Math.ceil(a / b);
    const outNc = ceilDiv(rawNc, stride);
    const outNr = ceilDiv(rawNr, stride);
    const outNs = ceilDiv(rawNs, stride);
    const outCount = outNc * outNr * outNs;

    const inData = new Float32Array(buf, HEADER_BYTES + hdr.nsymbt, origCrsCount[0] * origCrsCount[1] * origCrsCount[2]);
    const outData = new Float32Array(outCount);

    // posMod handles negatives correctly: (-25 mod 90) → 65, not JS's -25.
    const posMod = (a: number, n: number) => ((a % n) + n) % n;

    // CCP4 is column-fastest: index = ((s * nr) + r) * nc + c
    // For each output voxel at grid index (newCrsStart + outIdx*stride), the
    // input voxel is at the same grid index mod the cell sampling — read with
    // modular indexing relative to origCrsStart.
    let outIdx = 0;
    let sum = 0, sumSq = 0;
    let aminOut = Number.POSITIVE_INFINITY;
    let amaxOut = Number.NEGATIVE_INFINITY;

    for (let s = 0; s < outNs; s++) {
        const sIn = posMod(newCrsStart[2] + s * stride - origCrsStart[2], origCrsCount[2]);
        for (let r = 0; r < outNr; r++) {
            const rIn = posMod(newCrsStart[1] + r * stride - origCrsStart[1], origCrsCount[1]);
            const rowBase = (sIn * origCrsCount[1] + rIn) * origCrsCount[0];
            for (let c = 0; c < outNc; c++) {
                const cIn = posMod(newCrsStart[0] + c * stride - origCrsStart[0], origCrsCount[0]);
                const v = inData[rowBase + cIn];
                outData[outIdx++] = v;
                sum += v;
                sumSq += v * v;
                if (v < aminOut) aminOut = v;
                if (v > amaxOut) amaxOut = v;
            }
        }
    }
    const newMean = sum / outCount;
    const variance = Math.max(0, sumSq / outCount - newMean * newMean);
    const newStddev = Math.sqrt(variance);

    // --- Header updates for the downsampled output ---
    // Voxel size = cell / NX. To keep voxel size correct when sampling every
    // stride-th input voxel, divide NX/NY/NZ by stride. Likewise NCSTART
    // (which is in NX-units) divides by stride; non-multiples drift by a
    // sub-voxel, negligible at typical strides 1–4.
    const newNxyz: [number, number, number] = [
        Math.max(1, Math.round(hdr.nx / stride)),
        Math.max(1, Math.round(hdr.ny / stride)),
        Math.max(1, Math.round(hdr.nz / stride)),
    ];
    const newCrsForCrs = (crs: 0 | 1 | 2) => Math.round(newCrsStart[crs] / stride);

    // --- Assemble output buffer ---
    const outBuf = new ArrayBuffer(HEADER_BYTES + hdr.nsymbt + outData.byteLength);
    new Uint8Array(outBuf).set(new Uint8Array(buf, 0, HEADER_BYTES + hdr.nsymbt));
    patchHeader(outBuf, {
        ...hdr,
        nc: outNc, nr: outNr, ns: outNs,
        ncstart: newCrsForCrs(0), nrstart: newCrsForCrs(1), nsstart: newCrsForCrs(2),
        nx: newNxyz[0], ny: newNxyz[1], nz: newNxyz[2],
        amin: aminOut, amax: amaxOut, amean: newMean, arms: newStddev,
    });
    new Float32Array(outBuf, HEADER_BYTES + hdr.nsymbt, outCount).set(outData);

    // Report what we cropped to, in XYZ axis order (pre-downsample, in
    // original-grid index units, for diagnostics).
    const xyzStart: [number, number, number] = [0, 0, 0];
    const xyzSize: [number, number, number] = [0, 0, 0];
    for (let xyz = 0; xyz < 3; xyz++) {
        const crs = crsForXyz[xyz];
        xyzStart[xyz] = newCrsStart[crs];
        xyzSize[xyz] = newCrsEnd[crs] - newCrsStart[crs];
    }

    return {
        bytes: new Uint8Array(outBuf),
        sizeBytes: outBuf.byteLength,
        downsampleStride: stride,
        newMean,
        newStddev,
        cropDescription: { startXYZ: xyzStart, sizeXYZ: xyzSize },
    };
}
