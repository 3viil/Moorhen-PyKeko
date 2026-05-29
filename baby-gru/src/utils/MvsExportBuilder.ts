// Build a MolViewSpec (MVS) JSON document describing the current PyKeko scene
// for the self-contained Mol* viewer template (wrapper writes it into the HTML
// at export time).
//
// Current scope:
//   - One or more molecules, embedded as base64-PDB data URLs.
//     polymer → cartoon (per-chain colours); ligand/ion → ball-and-stick.
//   - One or more maps, embedded as base64-CCP4 data URLs (already cropped
//     to model+padding by MvsCcp4Crop). 2Fo-Fc → single isosurface in the
//     map's colour; difference maps → two isosurfaces (+green, -red) at
//     ±contour.
//   - No camera (Mol* auto-fits) and no richer rep translation yet.
//
// The schema (kind/params/children) mirrors molstar/lib/extensions/mvs/tree
// and is what `MVSData.fromMVSJ(...)` + `loadMVS(...)` consume.

export interface MvsMoleculeInput {
    name: string;
    /** Coordinate text (PDB format) to embed as a data URL. */
    coords: string;
    /** Chain ids (auth_asym_id) used to colour the cartoon rep per-chain. */
    chains: string[];
}

export interface MvsMapInput {
    name: string;
    /** Raw CCP4 bytes (post-crop). */
    bytes: Uint8Array;
    /** True for Fo-Fc style maps — emits a second negative-isovalue surface. */
    isDifference: boolean;
    /** Contour level in ABSOLUTE density units (what Moorhen stores). Passed
     *  to MVS as `absolute_isovalue` so the displayed isosurface exactly
     *  matches what the user was looking at in PyKeko. The Mol* UI exposes
     *  a Relative/Absolute toggle on the slider so users can switch to σ. */
    contourAbsolute: number | null;
    /** Hex colour for 2Fo-Fc style maps. Ignored for diff maps (which use
     *  fixed green/red, matching Coot/Moorhen defaults). */
    color: string;
    /** Diff-map colours; used only when isDifference=true. */
    positiveColor?: string;
    negativeColor?: string;
}

export interface MvsExportOptions {
    molecules: MvsMoleculeInput[];
    maps?: MvsMapInput[];
    title?: string;
    backgroundColor?: string;
}

// Distinct hexes for chain colouring. MVS's `color` node is uniform-only
// (no built-in "chain-id rainbow" theme), so we emit one `color` node per
// chain with an `auth_asym_id` selector. Cycled for >10 chains.
const CHAIN_PALETTE = [
    "#9067cf", "#f08e3c", "#5ab4ac", "#d6604d", "#67a9cf",
    "#fee08b", "#bf812d", "#80cdc1", "#c994c7", "#a6dba0",
];

// UTF-8-safe base64 for text. (PDB is ASCII but stay robust.)
const textToBase64 = (text: string): string => {
    const bytes = new TextEncoder().encode(text);
    return bytesToBase64(bytes);
};

// Chunked base64 for binary; native btoa explodes on long single strings.
const bytesToBase64 = (bytes: Uint8Array): string => {
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
    }
    return btoa(bin);
};

const node = (kind: string, params: any = {}, children: any[] = []) => ({ kind, params, children });

const chainColorNodes = (chains: string[]) =>
    chains.map((c, i) => node("color", {
        // Note: ComponentExpressionT uses auth_asym_id (the CIF "author" chain field),
        // which is the user-facing chain letter (A/B/...). NOT chain_id.
        selector: { auth_asym_id: c },
        color: CHAIN_PALETTE[i % CHAIN_PALETTE.length],
    }));

const structureBranch = (coords: string, chains: string[]) => {
    const dataUrl = "data:text/plain;base64," + textToBase64(coords);
    return node("download", { url: dataUrl }, [
        // PDB rather than mmCIF: PyKeko/Coot's mmCIF writer doesn't emit
        // _entity_poly records and tags every atom as HETATM, so Mol*'s
        // `polymer` selector matches nothing (no cartoon). PDB's ATOM/HETATM
        // distinction is honoured correctly by Coot's writer.
        node("parse", { format: "pdb" }, [
            node("structure", { type: "model" }, [
                node("component", { selector: "polymer" }, [
                    node("representation", { type: "cartoon" }, chainColorNodes(chains)),
                ]),
                node("component", { selector: "ligand" }, [
                    node("representation", { type: "ball_and_stick" }, [
                        node("color", { color: "lightgreen" }),
                    ]),
                ]),
                node("component", { selector: "ion" }, [
                    node("representation", { type: "ball_and_stick" }, [
                        node("color", { color: "orange" }),
                    ]),
                ]),
            ]),
        ]),
    ]);
};

// One isosurface child node for a volume.
//   If `absoluteLevel` is given, we emit `absolute_isovalue` so the displayed
//   surface matches exactly what the user was looking at, independent of the
//   cropped map's recomputed stddev.
//   Otherwise we emit `relative_isovalue` (σ-multiples), which Mol* multiplies
//   by the map's RMSD at load time — sensible defaults for maps that came in
//   without a UI-set contour.
// Either way the Mol* slider exposes a Relative/Absolute toggle so users can
// switch interactively.
const isoSurface = (
    contour: { absolute: number } | { sigma: number },
    color: string,
) => {
    const params: any = {
        type: "isosurface",
        show_wireframe: true,
        show_faces: false,
    };
    if ("absolute" in contour) params.absolute_isovalue = contour.absolute;
    else params.relative_isovalue = contour.sigma;
    // MVS distinguishes structure `representation` from `volume_representation`
    // — they take different param schemas. Use the volume one here.
    return node("volume_representation", params, [ node("color", { color }) ]);
};

const volumeBranch = (m: MvsMapInput) => {
    const dataUrl = "data:application/octet-stream;base64," + bytesToBase64(m.bytes);
    const haveAbs = m.contourAbsolute !== null && m.contourAbsolute !== undefined;
    // For diff maps without an explicit contour, default to 3σ; for 2Fo-Fc, 1.5σ.
    const fallbackSigma = m.isDifference ? 3.0 : 1.5;
    const contourPos = haveAbs
        ? { absolute: m.contourAbsolute as number }
        : { sigma: fallbackSigma };
    const contourNeg = haveAbs
        ? { absolute: -(m.contourAbsolute as number) }
        : { sigma: -fallbackSigma };

    const reps = m.isDifference
        ? [
              isoSurface(contourPos, m.positiveColor ?? "#00cc44"),  // +Fo-Fc — green
              isoSurface(contourNeg, m.negativeColor ?? "#cc0033"),  // -Fo-Fc — red
          ]
        : [
              isoSurface(contourPos, m.color ?? "#3a86ff"),           // 2mFo-DFc — blue
          ];

    return node("download", { url: dataUrl }, [
        node("parse", { format: "map" }, [
            node("volume", {}, reps),
        ]),
    ]);
};

export function buildMvsJson(opts: MvsExportOptions): string {
    const bg = opts.backgroundColor || "#000000";
    const children: any[] = [
        node("canvas", { background_color: bg }),
        ...opts.molecules.map(m => structureBranch(m.coords, m.chains)),
        ...(opts.maps || []).map(volumeBranch),
    ];
    const doc = {
        metadata: {
            title: opts.title || "PyKeko export",
            version: "1",
            timestamp: new Date().toISOString(),
        },
        root: { kind: "root", params: {}, children },
    };
    return JSON.stringify(doc);
}
