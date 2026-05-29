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
    mmcif: string;
}

export interface MvsExportOptions {
    molecules: MvsMoleculeInput[];
    title?: string;
}

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

const structureBranch = (mmcif: string) => {
    const dataUrl = "data:text/plain;base64," + toBase64(mmcif);
    return node("download", { url: dataUrl }, [
        node("parse", { format: "mmcif" }, [
            node("structure", { type: "model" }, [
                node("component", { selector: "polymer" }, [
                    node("representation", { type: "cartoon" }),
                ]),
                node("component", { selector: "ligand" }, [
                    node("representation", { type: "ball_and_stick" }),
                ]),
                node("component", { selector: "ion" }, [
                    node("representation", { type: "ball_and_stick" }),
                ]),
            ]),
        ]),
    ]);
};

export function buildMvsJson(opts: MvsExportOptions): string {
    const children = opts.molecules.map(m => structureBranch(m.mmcif));
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
