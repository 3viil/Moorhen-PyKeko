// Build a MolViewSpec (MVS) JSON document describing the current PyKeko scene
// for the self-contained Mol* viewer template (wrapper writes it into the HTML
// at export time).
//
// Milestone 1: one or more molecules, embedded inline as base64-mmCIF data
// URLs; polymer → cartoon, ligand → ball-and-stick, ion → ball-and-stick.
// No camera (Mol* auto-fits) and no per-chain colour override yet —
// representations rely on Mol*'s defaults for those reps. Maps + camera +
// richer colour translation come in subsequent milestones.
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

export interface MvsExportOptions {
    molecules: MvsMoleculeInput[];
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

// UTF-8-safe base64 (mmCIF is ASCII in practice, but be robust).
const toBase64 = (text: string): string => {
    const bytes = new TextEncoder().encode(text);
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
    const dataUrl = "data:text/plain;base64," + toBase64(coords);
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

export function buildMvsJson(opts: MvsExportOptions): string {
    const bg = opts.backgroundColor || "#000000";
    const children: any[] = [
        node("canvas", { background_color: bg }),
        ...opts.molecules.map(m => structureBranch(m.coords, m.chains)),
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
