// Build a PyMOL .pml bundle from the current PyKeko scene — a script
// plus sibling .pdb / .ccp4 files — so the user can open it in PyMOL.app
// for advanced figure work and ultimately `save` a real .pse from there.
//
// We do NOT try to emit a binary .pse file: it's an undocumented pickled
// C++ object graph specific to PyMOL's internals, with ~50+ object types,
// reverse-engineered only inside PyMOL itself. Writing one third-party
// would mean either bundling open-source PyMOL's C++ code (huge dep,
// GPL contamination) or reverse-engineering it from scratch. The .pml
// bundle is the practical handoff and is arguably better in most ways
// (human-readable, editable, version-controllable, reproducible).
//
// What we DO preserve in the bundle:
//   - Each loaded molecule's coordinates (.pdb, sibling files)
//   - Each loaded map's grid data (.ccp4, sibling files)
//   - PyMOL `load` lines, with absolute paths so the script works from
//     any CWD
//   - One PyMOL `show`/`color` line per Moorhen representation + colour rule
//   - A `bg_color` line matching the live scene
//   - `orient` at the end so the user gets a sensible view
//
// What's NOT preserved (yet):
//   - Camera (set_view): Moorhen → PyMOL camera math isn't 1:1; `orient`
//     covers the common case
//   - Named selections from `select` (the parser stores the AST; printing
//     it back to a PyMOL string isn't yet implemented)
//   - Custom NCS ghosts and PyKeko-specific reps that PyMOL doesn't know
//
// All these caveats appear as comments at the top of the generated script
// so the user isn't surprised.

import { MoorhenMolecule } from "./MoorhenMolecule";
import { moorhen } from "../types/moorhen";

export interface BundleFile {
    /** Filename relative to the bundle directory. */
    name: string;
    /** Base64-encoded file contents. */
    dataBase64: string;
}

const textToBase64 = (text: string): string => {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
    }
    return btoa(bin);
};

const bytesToBase64 = (bytes: Uint8Array): string => {
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
    }
    return btoa(bin);
};

// Sanitize a Moorhen molecule/map name to a safe filename basename.
const safeBaseName = (name: string): string =>
    name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "untitled";

// Convert a Moorhen CID like "//A/100-200/CA" to a PyMOL selection string.
// Multi-CID expressions joined by "||" become PyMOL "()" or "()" groups.
// Returns null if the cid is the whole-molecule wildcard (caller can skip
// the `and (...)` qualifier).
const cidToPymolSel = (cid: string): string | null => {
    if (!cid || cid === "/*/*/*/*" || cid === "/*/*/*/*:*" || cid === "//*") return null;
    if (cid.includes("||")) {
        const parts = cid.split("||").map(p => cidToPymolSel(p.trim())).filter(Boolean);
        if (parts.length === 0) return null;
        return parts.map(p => `(${p})`).join(" or ");
    }
    // Parse the //chain/resi/atom form. Empty / "*" slots are wildcards.
    const m = cid.match(/^\/\/([^/]*)(?:\/([^/]*)(?:\/([^/:]*))?)?/);
    if (!m) return null;
    const [, chainRaw, resiRaw, atomRaw] = m;
    const parts: string[] = [];
    if (chainRaw && chainRaw !== "*") parts.push(`chain ${chainRaw}`);
    if (resiRaw && resiRaw !== "*") {
        // Moorhen uses N-M or single N; PyMOL accepts both N-M and N:M, so leave as-is.
        parts.push(`resi ${resiRaw}`);
    }
    if (atomRaw && atomRaw !== "*") parts.push(`name ${atomRaw}`);
    return parts.length > 0 ? parts.join(" and ") : null;
};

// Moorhen representation style → PyMOL `show` argument. Returns null if
// the style has no clean PyMOL counterpart.
const styleToPymolRep = (style: string): string | null => {
    switch (style) {
        case "CRs":               return "cartoon";
        case "CBs":               return "sticks";
        case "VdwSpheres":        return "spheres";
        case "MolecularSurface":  return "surface";
        case "Calpha":            return "ribbon";
        case "DishyBases":        return "cartoon";  // PyMOL nucleic-flat shows
        default:                  return null;
    }
};

// Format one PyMOL line: `show cartoon, model and chain A` or `show cartoon, model`.
const showLine = (rep: string, molName: string, sel: string | null): string =>
    sel ? `show ${rep}, ${molName} and (${sel})` : `show ${rep}, ${molName}`;

const colorLine = (color: string, molName: string, sel: string | null): string =>
    sel ? `color ${color}, ${molName} and (${sel})` : `color ${color}, ${molName}`;

export interface BuildBundleOptions {
    /** The .pml file's own intended basename (used in the header comment). */
    pmlBasename: string;
    /** Absolute directory the bundle will be written into. The save dialog
     *  provides this at write time; we pre-bake absolute paths into the script
     *  so `pymol scene.pml` works from any CWD. */
    bundleDir: string;
    /** All currently-loaded molecules. */
    molecules: MoorhenMolecule[];
    /** All currently-loaded maps. Optional — we'll skip the maps section if empty. */
    maps?: any[];
    /** Background colour [r,g,b,a] (0-1 each) from scene settings. */
    backgroundColor?: [number, number, number, number] | null;
}

export interface BuiltBundle {
    /** [scene.pml, mol.pdb, mol.pdb, map.ccp4, ...] — first entry is the script. */
    files: BundleFile[];
    /** Human-readable notes (lines that became `# ...` comments at the top of the script). */
    notes: string[];
}

const escapePmlComment = (s: string): string => s.replace(/[\r\n]+/g, " ");

export async function buildPmlBundle(opts: BuildBundleOptions): Promise<BuiltBundle> {
    const files: BundleFile[] = [];
    const lines: string[] = [];
    const notes: string[] = [];

    // ── Header ────────────────────────────────────────────────────────
    const ts = new Date().toISOString();
    lines.push(`# Generated by PyKeko on ${ts}`);
    lines.push(`# `);
    lines.push(`# To use: open this file in PyMOL.app, then refine the figure with`);
    lines.push(`# PyMOL's full feature set, and \`save scene.pse\` from there.`);
    lines.push(`# `);
    lines.push(`# NOT preserved by this export:`);
    lines.push(`#   - Camera (we emit \`orient\` at the end instead)`);
    lines.push(`#   - Named PyMOL selections from \`select name, expr\``);
    lines.push(`#   - PyKeko-specific representations (NCS ghosts, etc.)`);
    lines.push(``);

    // ── Background ────────────────────────────────────────────────────
    if (opts.backgroundColor) {
        const [r, g, b] = opts.backgroundColor;
        // Detect dark (≈black) vs light; PyMOL accepts hex.
        const hex = "#" +
            Math.round(Math.max(0, Math.min(255, r * 255))).toString(16).padStart(2, "0") +
            Math.round(Math.max(0, Math.min(255, g * 255))).toString(16).padStart(2, "0") +
            Math.round(Math.max(0, Math.min(255, b * 255))).toString(16).padStart(2, "0");
        lines.push(`bg_color ${hex}`);
        lines.push(``);
    }

    // ── Molecules ────────────────────────────────────────────────────
    const usedNames = new Set<string>();
    const uniquify = (base: string): string => {
        if (!usedNames.has(base)) { usedNames.add(base); return base; }
        let i = 2;
        while (usedNames.has(`${base}_${i}`)) i++;
        const n = `${base}_${i}`;
        usedNames.add(n);
        return n;
    };

    for (const mol of opts.molecules) {
        const objName = uniquify(safeBaseName(mol.name));
        const pdbFilename = `${objName}.pdb`;
        const pdbPath = `${opts.bundleDir}/${pdbFilename}`;

        // Coordinates
        let coords = "";
        try {
            coords = await (mol as any).getAtoms("pdb");
        } catch (e) {
            notes.push(`Could not extract coordinates for ${mol.name}: ${(e as any)?.message || e}`);
            continue;
        }
        files.push({ name: pdbFilename, dataBase64: textToBase64(coords) });

        // Load + name
        lines.push(`# --- ${mol.name} ---`);
        lines.push(`load ${pdbPath}, ${objName}`);

        // Representations + colour rules. Each rep contributes one `show` line
        // (potentially scoped by its cid); each colour rule contributes one `color` line.
        const reps = (mol as any).representations as moorhen.MoleculeRepresentation[];
        if (Array.isArray(reps) && reps.length > 0) {
            // Start clean: PyMOL's default is lines+nb_spheres; explicit hide all
            // lets our `show` lines fully express the intended scene.
            lines.push(`hide everything, ${objName}`);
            for (const rep of reps) {
                if (!rep || (rep as any).isCustom === false) continue;
                const pmlRep = styleToPymolRep((rep as any).style);
                if (!pmlRep) {
                    notes.push(`Skipped representation style "${(rep as any).style}" on ${mol.name} — no clean PyMOL equivalent`);
                    continue;
                }
                const sel = cidToPymolSel((rep as any).cid);
                lines.push(showLine(pmlRep, objName, sel));

                const rules = ((rep as any).colourRules ?? []) as moorhen.ColourRule[];
                for (const rule of rules) {
                    const colour = (rule as any).color;
                    if (!colour || typeof colour !== "string") continue;
                    const cidSel = cidToPymolSel((rule as any).cid);
                    lines.push(colorLine(colour, objName, cidSel));
                }
            }
        }
        lines.push(``);
    }

    // ── Maps ─────────────────────────────────────────────────────────
    if (opts.maps && opts.maps.length > 0) {
        lines.push(`# --- maps ---`);
        for (const map of opts.maps) {
            const baseName = uniquify(safeBaseName(map.name));
            const mapFilename = `${baseName}.ccp4`;
            const mapPath = `${opts.bundleDir}/${mapFilename}`;
            try {
                const reply = await (map as any).getMap();
                const buf: ArrayBuffer | Uint8Array | undefined = reply?.data?.result?.mapData;
                if (!buf) {
                    notes.push(`Map ${map.name}: getMap() returned no data — skipped`);
                    continue;
                }
                const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
                files.push({ name: mapFilename, dataBase64: bytesToBase64(bytes) });
                lines.push(`load ${mapPath}, ${baseName}`);
                // Live contour level if known, else a sensible default (~1σ).
                const params = (map as any).getMapContourParams?.();
                const level = typeof params?.contourLevel === "number"
                    ? params.contourLevel
                    : (map.isDifference ? 3.0 : 1.5);
                // PyMOL: `isomesh mesh_name, map_name, level, sel, buffer`
                // Use the first molecule (if any) as the carve target; ligand pockets typically focus there.
                const target = opts.molecules[0] ? safeBaseName(opts.molecules[0].name) : "polymer";
                if (map.isDifference) {
                    lines.push(`isomesh ${baseName}_pos, ${baseName}, ${level}, ${target}, 5.0`);
                    lines.push(`color green, ${baseName}_pos`);
                    lines.push(`isomesh ${baseName}_neg, ${baseName}, -${level}, ${target}, 5.0`);
                    lines.push(`color red, ${baseName}_neg`);
                } else {
                    lines.push(`isomesh ${baseName}_mesh, ${baseName}, ${level}, ${target}, 5.0`);
                    lines.push(`color blue, ${baseName}_mesh`);
                }
            } catch (e) {
                notes.push(`Map ${map.name}: extraction failed — ${(e as any)?.message || e}`);
            }
        }
        lines.push(``);
    }

    // ── Closing ──────────────────────────────────────────────────────
    lines.push(`# Auto-frame on the scene; comment out and use \`set_view\` to pin a specific view.`);
    lines.push(`orient`);
    lines.push(``);

    // Surface any collected notes as comments near the top.
    if (notes.length > 0) {
        const noteBlock = [
            `# Notes from the PyKeko exporter:`,
            ...notes.map(n => `#   - ${escapePmlComment(n)}`),
            ``,
        ];
        // Insert after the existing header (after the first blank line).
        const blankIdx = lines.indexOf("");
        if (blankIdx >= 0) lines.splice(blankIdx + 1, 0, ...noteBlock);
        else lines.unshift(...noteBlock);
    }

    // PML script is the FIRST file in the bundle (per the save-bundle IPC contract).
    files.unshift({ name: opts.pmlBasename, dataBase64: textToBase64(lines.join("\n") + "\n") });

    return { files, notes };
}
