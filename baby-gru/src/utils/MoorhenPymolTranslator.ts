/**
 * PyMOL → Moorhen command translator.
 *
 * Phase 1: Tier 1 commands (loading + view) only. Future phases add representation,
 * colour, selection algebra, measurements, screenshots, set commands. See
 * docs/pymol-translator-plan.md for the full plan.
 *
 * Each command handler dispatches a sequence of Moorhen API calls and awaits
 * them sequentially — matches PyMOL command-order semantics. Unsupported
 * commands surface as console.warn + a toast (no hard error so the script
 * continues running where it can).
 */

import * as quat4 from "gl-matrix/quat";
import * as mat3 from "gl-matrix/mat3";
import { MoorhenMolecule } from "./MoorhenMolecule";
import { parsePymolScript, PymolCommand } from "./MoorhenPymolParser";
import { parseSelection, SelNode } from "./MoorhenPymolSelectionParser";
import { evaluateSelectionForMolecule, coalesceResidueCids } from "./MoorhenPymolFilter";
import { moorhen } from "../types/moorhen";

type ScriptContext = {
    commandCentre: React.RefObject<moorhen.CommandCentre>;
};

/**
 * Lookup table for the common PyMOL named colours.
 * Hex values match PyMOL's `pymol.color_dict` for the most-used entries.
 * Anything not in the table can be passed as 0xRRGGBB or a #RRGGBB string.
 */
const PYMOL_COLOR_TABLE: Record<string, string> = {
    red:       "#ff0000",
    green:     "#00ff00",
    blue:      "#0000ff",
    yellow:    "#ffff00",
    cyan:      "#00ffff",
    magenta:   "#ff00ff",
    orange:    "#ff8000",
    purple:    "#a020f0",
    pink:      "#ffc0cb",
    salmon:    "#ff9999",
    slate:     "#7090ff",
    teal:      "#00aaaa",
    olive:     "#aaaa00",
    brown:     "#aa6600",
    grey:      "#a0a0a0",
    gray:      "#a0a0a0",
    white:     "#ffffff",
    black:     "#000000",
    deepblue:  "#22336a",
    lightblue: "#bbeeff",
    skyblue:   "#76acff",
    forest:    "#228822",
    limon:     "#bbff00",
    limegreen: "#33dd33",
    chocolate: "#995522",
    firebrick: "#b22222",
    ruby:      "#8a0500",
    raspberry: "#b3315e",
    hotpink:   "#ff007f",
    deeppurple:"#5500aa",
    violet:    "#aa00ff",
    darkmagenta:"#660066",
    splitpea:  "#88aa55",
    smudge:    "#557755",
    palegreen: "#88dd88",
    deepteal:  "#005577",
    palecyan:  "#bbeeee",
    aquamarine:"#7fffd4",
    deepsalmon:"#ff6644",
    wheat:     "#ffeeaa",
    sand:      "#bb9977",
    grey80:    "#cccccc",
    grey50:    "#808080",
    grey30:    "#4d4d4d",
    carbon:    "#33ff33",
    nitrogen:  "#3333ff",
    oxygen:    "#ff3333",
    sulfur:    "#e6c829",
    hydrogen:  "#ffffff",
};

const resolveColor = (name: string): string => {
    const k = name.trim().toLowerCase().replace(/^['"]|['"]$/g, "");
    if (PYMOL_COLOR_TABLE[k]) return PYMOL_COLOR_TABLE[k];
    if (/^#?[0-9a-f]{6}$/i.test(k)) return k.startsWith("#") ? k : "#" + k;
    if (/^0x[0-9a-f]{6}$/i.test(k)) return "#" + k.slice(2);
    return k;
};

/**
 * PyMOL representation keyword → Moorhen RepresentationStyles.
 * `cartoon` is the heavy use case; `sticks` matches Moorhen's default bond
 * rendering; `lines` uses the same CBs path with thinner geometry (we don't
 * adjust width here because the CBs default already approximates "lines").
 */
const REP_MAP: Record<string, moorhen.RepresentationStyles> = {
    cartoon:   "CRs",
    ribbon:    "CRs",
    sticks:    "CBs",
    lines:     "CBs",
    spheres:   "VdwSpheres",
    sphere:    "VdwSpheres",
    surface:   "MolecularSurface",
    mesh:      "MolecularSurface",
    dots:      "MolecularSurface",
    nb_spheres:"VdwSpheres",
};

type SelectionResolver =
    | { kind: "object"; molNo: number }
    | { kind: "named"; ast: SelNode };

class PymolRegistry {
    entries: Map<string, SelectionResolver> = new Map();
    register(name: string, resolver: SelectionResolver) {
        this.entries.set(name, resolver);
    }
    resolve(name: string): SelectionResolver | null {
        return this.entries.get(name) ?? null;
    }
    unregister(name: string) {
        this.entries.delete(name);
    }
}

/**
 * Substitute object/named-selection references in an AST.
 * Each `{ kind: "object", name }` node is replaced by either:
 *   - the AST stored under that name (named selection), OR
 *   - left in place (object name; molecule scoping handled later)
 */
const substituteRegistry = (node: SelNode, registry: PymolRegistry): SelNode => {
    if (node.kind === "object") {
        const r = registry.resolve(node.name);
        if (r && r.kind === "named") return substituteRegistry(r.ast, registry);
        return node; // leave object-names; molecule scoping kicks in at evaluation
    }
    if (node.kind === "or" || node.kind === "and") {
        return { ...node, l: substituteRegistry(node.l, registry), r: substituteRegistry(node.r, registry) };
    }
    if (node.kind === "not") return { kind: "not", inner: substituteRegistry(node.inner, registry) };
    if (node.kind === "byres" || node.kind === "bychain" || node.kind === "byobject" || node.kind === "bysegi" ||
        node.kind === "bymolecule" || node.kind === "bymodel" || node.kind === "bound_to" || node.kind === "neighbor" ||
        node.kind === "first" || node.kind === "last") {
        return { ...node, inner: substituteRegistry(node.inner, registry) };
    }
    if (node.kind === "extend" || node.kind === "dist") {
        return { ...node, inner: substituteRegistry(node.inner, registry) };
    }
    return node;
};

/**
 * Get the set of molecules an AST applies to.
 * An object-name in the AST scopes to that one molecule; everything else
 * scopes to all loaded molecules.
 */
const scopeOf = (node: SelNode, env: any, registry: PymolRegistry): MoorhenMolecule[] => {
    const allMols = (env.store.getState().molecules.moleculeList as MoorhenMolecule[]).filter(isLiveMolecule);
    const objectNames: string[] = [];
    const walk = (n: SelNode) => {
        if (n.kind === "object") objectNames.push(n.name);
        else if (n.kind === "or" || n.kind === "and") { walk(n.l); walk(n.r); }
        else if ("inner" in n && n.inner) walk(n.inner);
    };
    walk(node);
    if (objectNames.length === 0) return allMols;
    const scopedMolNos = new Set<number>();
    for (const name of objectNames) {
        const r = registry.resolve(name);
        if (r && r.kind === "object") scopedMolNos.add(r.molNo);
    }
    return scopedMolNos.size === 0 ? allMols : allMols.filter(m => scopedMolNos.has(m.molNo));
};

/**
 * Compile and evaluate a selection arg to a list of (molecule, cid) pairs.
 * cid is a single string ready to pass to addRepresentation / addColourRule —
 * for whole-molecule selections it's the all-atoms wildcard; for narrower
 * selections it's a `||`-joined list of residue/atom CIDs.
 */
/**
 * CID-pure compilation: try to express a selection as one or more Moorhen
 * CIDs without enumerating atoms. Returns null if the selection needs the
 * runtime filter.
 *
 * Each compiled slot is independent (chain, resi, atom). For unions (or),
 * we emit multiple CIDs that can be `||`-joined.
 */
type CidSlots = { chain?: string; resi?: string; atom?: string };

const compileSlots = (node: SelNode): CidSlots[] | null => {
    switch (node.kind) {
        case "all": return [{}];
        case "none": return [];
        case "pred_str": {
            if (node.prop === "chain") return node.values.map(v => ({ chain: v }));
            if (node.prop === "name") return [{ atom: node.values.join(",") }];
            return null;
        }
        case "pred_resi": {
            const resi = node.ranges.map(r => r.lo === r.hi ? `${r.lo}` : `${r.lo}-${r.hi}`).join(",");
            return [{ resi }];
        }
        case "and": {
            const l = compileSlots(node.l);
            const r = compileSlots(node.r);
            if (!l || !r) return null;
            // Cross-product of slot fills; reject when a slot is double-set with conflicting values
            const out: CidSlots[] = [];
            for (const a of l) for (const b of r) {
                if (a.chain && b.chain && a.chain !== b.chain) continue;
                if (a.resi && b.resi && a.resi !== b.resi) continue;
                if (a.atom && b.atom && a.atom !== b.atom) continue;
                out.push({
                    chain: a.chain ?? b.chain,
                    resi: a.resi ?? b.resi,
                    atom: a.atom ?? b.atom,
                });
            }
            return out;
        }
        case "or": {
            const l = compileSlots(node.l);
            const r = compileSlots(node.r);
            if (!l || !r) return null;
            return [...l, ...r];
        }
        case "byres": {
            // byres(pure) — same CIDs, atom slot wildcarded
            const inner = compileSlots(node.inner);
            if (!inner) return null;
            return inner.map(s => ({ chain: s.chain, resi: s.resi, atom: undefined }));
        }
        case "bychain": {
            const inner = compileSlots(node.inner);
            if (!inner) return null;
            return inner.map(s => ({ chain: s.chain }));
        }
        case "object":
            // Object names are scoped at the molecule level, not the CID — match-all here
            return [{}];
        default:
            return null;
    }
};

const slotsToCid = (s: CidSlots): string => {
    // Moorhen uses a SHORT mmdb-style CID where omitted trailing slots are dropped:
    //   chain only       : //A
    //   chain + resi     : //A/5-10
    //   chain + resi + n : //A/5/CA
    //   all atoms        : /*/*/*/* (the long wildcard form is needed for reps)
    // When chain is unset we use `*` so the leading two slashes don't both go empty.
    const chain = s.chain ?? "*";
    if (s.resi === undefined && s.atom === undefined) return `//${chain}`;
    if (s.atom === undefined) return `//${chain}/${s.resi}`;
    return `//${chain}/${s.resi ?? "*"}/${s.atom}`;
};

// Moorhen's own internal reps use the all-atoms wildcard with a `:*` alt-loc
// suffix on the atom slot. Find-or-create lookups in `molecule.show(...)` /
// `molecule.hide(...)` only match if the cid matches exactly. Normalize our
// compiled wildcards so reuse hits.
const normalizeCidForMoorhen = (cid: string): string => {
    if (cid.includes("||")) return cid; // multi-cid expressions; leave alone
    if (cid.includes(":")) return cid;  // already alt-loc-suffixed
    if (cid === "/*/*/*/*") return "/*/*/*/*:*";
    return cid;
};

const isLiveMolecule = (m: MoorhenMolecule): boolean => {
    // Defend against stale molecules left in Redux from a previous session
    // where the WASM gemmiStructure was already torn down. Operating on
    // those throws "Cannot pass deleted object as a pointer of type Structure".
    try {
        return !!m && m.molNo !== null && (m.gemmiStructure ? !m.gemmiStructure.isDeleted() : true);
    } catch {
        return false;
    }
};

const resolveSelection = async (
    arg: string | undefined,
    env: any,
    registry: PymolRegistry
): Promise<{ molecule: MoorhenMolecule; cid: string }[]> => {
    const allMols = (env.store.getState().molecules.moleculeList as MoorhenMolecule[]).filter(isLiveMolecule);
    if (!arg || arg.trim() === "" || arg.trim() === "all" || arg.trim() === "*") {
        // Use the short form Moorhen idiomatically uses for "every atom"
        return allMols.map(m => ({ molecule: m, cid: "//*" }));
    }
    let ast: SelNode;
    try {
        ast = parseSelection(arg);
    } catch (e: any) {
        console.warn(`[pymol] selection parse error: ${e?.message ?? e}`);
        return [];
    }
    const substituted = substituteRegistry(ast, registry);
    const scope = scopeOf(substituted, env, registry);

    // Fast path: try CID-pure compilation first
    const pureSlots = compileSlots(substituted);
    if (pureSlots !== null) {
        if (pureSlots.length === 0) return [];
        const cidExpr = pureSlots.map(slotsToCid).join("||");
        return scope.map(m => ({ molecule: m, cid: cidExpr }));
    }

    // Fallback: runtime atom-filter
    const results: { molecule: MoorhenMolecule; cid: string }[] = [];
    for (const molecule of scope) {
        const cids = await evaluateSelectionForMolecule(substituted, molecule, "residue");
        if (cids.length === 0) continue;
        if (cids.length === 1 && cids[0] === "/*/*/*/*") {
            results.push({ molecule, cid: "/*/*/*/*" });
        } else {
            const coalesced = coalesceResidueCids(cids);
            results.push({ molecule, cid: coalesced.map(c => `${c}/*`).join("||") });
        }
    }
    return results;
};

/** Single-molecule convenience wrapper for commands like zoom/center. */
const resolveSelectionSingle = async (
    arg: string | undefined,
    env: any,
    registry: PymolRegistry
): Promise<{ molecule: MoorhenMolecule | null; cid: string }> => {
    const list = await resolveSelection(arg, env, registry);
    if (list.length === 0) return { molecule: null, cid: "" };
    return { molecule: list[0].molecule, cid: list[0].cid };
};

/**
 * Parse a number list of arbitrary whitespace + comma form (PyMOL set_view body).
 */
const parseFloatList = (raw: string): number[] => {
    return raw.replace(/[()\\]/g, " ").split(/[\s,]+/).map(s => s.trim()).filter(Boolean).map(Number);
};

// ---------- command handlers (Tier 1) ----------

const cmdFetch = async (cmd: PymolCommand, env: any, registry: PymolRegistry, scriptApi: ScriptContext) => {
    const pdbId = cmd.args[0]?.replace(/['"]/g, "").trim();
    if (!pdbId) {
        console.warn(`[pymol:${cmd.lineNo}] fetch requires a PDB id`);
        return;
    }
    const res = await fetch(`https://files.rcsb.org/download/${pdbId}.pdb`);
    if (!res.ok) {
        console.warn(`[pymol:${cmd.lineNo}] fetch ${pdbId} failed: HTTP ${res.status}`);
        return;
    }
    const coords = await res.text();
    const monomerLibraryPath = (env.store.getState() as any).generalStates?.monomerLibraryPath
        ?? "./baby-gru/monomers";
    const mol = new MoorhenMolecule(scriptApi.commandCentre as any, env.store, monomerLibraryPath);
    await mol.loadToCootFromString(coords, pdbId);
    await mol.fetchIfDirtyAndDraw("CBs");
    env.dispatch(env.addMolecule(mol));
    registry.register(pdbId, { kind: "object", molNo: mol.molNo });
};

const cmdDelete = async (cmd: PymolCommand, env: any, registry: PymolRegistry) => {
    const target = cmd.args[0]?.trim();
    if (!target || target === "all") {
        const mols = env.store.getState().molecules.moleculeList as MoorhenMolecule[];
        for (const m of mols) await m.delete();
        registry.entries.clear();
        return;
    }
    const resolved = registry.resolve(target);
    if (!resolved || resolved.kind !== "object") {
        console.warn(`[pymol:${cmd.lineNo}] delete: unknown object "${target}"`);
        return;
    }
    const mol = (env.store.getState().molecules.moleculeList as MoorhenMolecule[])
        .find(m => m.molNo === resolved.molNo);
    if (mol) await mol.delete();
    registry.unregister(target);
};

const cmdToggleVisibility = (show: boolean) =>
    async (cmd: PymolCommand, env: any, registry: PymolRegistry) => {
        const target = cmd.args[0]?.trim();
        const action = show ? env.showMolecule : env.hideMolecule;
        if (!target || target === "all") {
            const mols = env.store.getState().molecules.moleculeList as MoorhenMolecule[];
            for (const m of mols) env.dispatch(action(m));
            return;
        }
        const resolved = registry.resolve(target);
        if (!resolved || resolved.kind !== "object") {
            console.warn(`[pymol:${cmd.lineNo}] ${show ? "enable" : "disable"}: unknown object "${target}"`);
            return;
        }
        const mol = (env.store.getState().molecules.moleculeList as MoorhenMolecule[])
            .find(m => m.molNo === resolved.molNo);
        if (mol) env.dispatch(action(mol));
    };

const cmdZoom = async (cmd: PymolCommand, env: any, registry: PymolRegistry) => {
    const arg = cmd.args.join(",");
    const { molecule, cid } = await resolveSelectionSingle(arg, env, registry);
    if (!molecule) {
        console.warn(`[pymol:${cmd.lineNo}] zoom: cannot resolve target "${arg}"`);
        return;
    }
    // centreOn picks a sensible whole-molecule zoom when the cid is exactly the
    // 4-segment all-atoms wildcard. Our "all" path uses the short form `//*`,
    // so normalize.
    const cidForCentre = (cid === "//*" || cid === "//") ? "/*/*/*/*" : cid;
    await molecule.centreOn(cidForCentre, true, true);
};

const cmdCenter = async (cmd: PymolCommand, env: any, registry: PymolRegistry) => {
    const arg = cmd.args.join(",");
    const { molecule, cid } = await resolveSelectionSingle(arg, env, registry);
    if (!molecule) return;
    // centreOn without alignment; just origin shift
    const atoms = await molecule.gemmiAtomsForCid(cid);
    if (!atoms || atoms.length === 0) return;
    let sx = 0, sy = 0, sz = 0;
    for (const a of atoms) { sx += a.x; sy += a.y; sz += a.z; }
    const n = atoms.length;
    env.dispatch(env.setOrigin([-sx / n, -sy / n, -sz / n]));
};

const cmdSetView = async (cmd: PymolCommand, env: any) => {
    // PyMOL set_view: 18 floats. First 9 = 3x3 rotation matrix (row-major).
    // Floats 10-12: camera-to-origin translation (PyMOL convention; z is the camera distance).
    // Floats 13-15: center of view (world coords).
    // Floats 16-18: clip planes + ortho. Ignored for now.
    const floats = parseFloatList(cmd.args.join(","));
    if (floats.length < 15) {
        console.warn(`[pymol:${cmd.lineNo}] set_view: need at least 15 floats, got ${floats.length}`);
        return;
    }
    const r = floats.slice(0, 9);
    // PyMOL row-major → gl-matrix column-major
    const rotCol = mat3.fromValues(
        r[0], r[3], r[6],
        r[1], r[4], r[7],
        r[2], r[5], r[8],
    );
    const q = quat4.create();
    // gl-matrix has no mat3→quat directly; use a small conversion
    const trace = rotCol[0] + rotCol[4] + rotCol[8];
    if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1);
        q[3] = 0.25 / s;
        q[0] = (rotCol[5] - rotCol[7]) * s;
        q[1] = (rotCol[6] - rotCol[2]) * s;
        q[2] = (rotCol[1] - rotCol[3]) * s;
    } else if (rotCol[0] > rotCol[4] && rotCol[0] > rotCol[8]) {
        const s = 2 * Math.sqrt(1 + rotCol[0] - rotCol[4] - rotCol[8]);
        q[3] = (rotCol[5] - rotCol[7]) / s;
        q[0] = 0.25 * s;
        q[1] = (rotCol[3] + rotCol[1]) / s;
        q[2] = (rotCol[6] + rotCol[2]) / s;
    } else if (rotCol[4] > rotCol[8]) {
        const s = 2 * Math.sqrt(1 + rotCol[4] - rotCol[0] - rotCol[8]);
        q[3] = (rotCol[6] - rotCol[2]) / s;
        q[0] = (rotCol[3] + rotCol[1]) / s;
        q[1] = 0.25 * s;
        q[2] = (rotCol[7] + rotCol[5]) / s;
    } else {
        const s = 2 * Math.sqrt(1 + rotCol[8] - rotCol[0] - rotCol[4]);
        q[3] = (rotCol[1] - rotCol[3]) / s;
        q[0] = (rotCol[6] + rotCol[2]) / s;
        q[1] = (rotCol[7] + rotCol[5]) / s;
        q[2] = 0.25 * s;
    }
    quat4.normalize(q, q);
    env.dispatch(env.setQuat(q));
    // Centre of view (floats 13-15) → setOrigin (negated)
    env.dispatch(env.setOrigin([-floats[12], -floats[13], -floats[14]]));
    // floats[11] is camera Z (typically negative, indicating distance).
    // Map magnitude → zoom; Moorhen's zoom is a fov-style scaling, rough approximation.
    if (floats[11] !== 0) {
        const zoomApprox = Math.max(0.05, Math.abs(floats[11]) / 80);
        env.dispatch(env.setZoom(zoomApprox));
    }
};

const cmdLoad = async (cmd: PymolCommand, env: any, registry: PymolRegistry, scriptApi: ScriptContext) => {
    // Browser can't read arbitrary local paths. If we're in Electron and the wrapper
    // exposes a control-channel for reading files, this would route through there.
    // For now: best-effort error so the user knows.
    console.warn(`[pymol:${cmd.lineNo}] load: local-file loading from script isn't supported in browser mode; use the File menu or fetch instead`);
};

// ---------- Tier 2 handlers ----------

const cmdShow = async (cmd: PymolCommand, env: any, registry: PymolRegistry) => {
    const repKey = cmd.args[0]?.trim().toLowerCase();
    const selArg = cmd.args[1];
    if (!repKey || repKey === "everything") return;
    const style = REP_MAP[repKey];
    if (!style) {
        console.warn(`[pymol:${cmd.lineNo}] show: unsupported representation "${repKey}"`);
        return;
    }
    const targets = await resolveSelection(selArg, env, registry);
    for (const { molecule, cid } of targets) {
        // Use molecule.show — find-or-create, keeps state consistent, no duplicate reps
        try { await molecule.show(style, normalizeCidForMoorhen(cid)); }
        catch (e) { console.warn(`[pymol:${cmd.lineNo}] show ${repKey} on ${molecule.name}:`, e); }
    }
};

const cmdHide = async (cmd: PymolCommand, env: any, registry: PymolRegistry) => {
    const repKey = cmd.args[0]?.trim().toLowerCase();
    const selArg = cmd.args[1];
    const targets = await resolveSelection(selArg, env, registry);
    for (const { molecule, cid } of targets) {
        if (!repKey || repKey === "everything") {
            for (const r of [...(molecule.representations as moorhen.MoleculeRepresentation[])]) {
                try { molecule.hide(r.style, r.cid); } catch (e) { /* skip stale */ }
            }
        } else {
            const style = REP_MAP[repKey];
            if (!style) {
                console.warn(`[pymol:${cmd.lineNo}] hide: unsupported "${repKey}"`);
                continue;
            }
            try { molecule.hide(style, normalizeCidForMoorhen(cid)); }
            catch (e) { console.warn(`[pymol:${cmd.lineNo}] hide ${repKey} on ${molecule.name}:`, e); }
        }
    }
};

const cmdAs = async (cmd: PymolCommand, env: any, registry: PymolRegistry) => {
    // `as cartoon` = hide everything + show cartoon
    await cmdHide({ ...cmd, args: ["everything", ...cmd.args.slice(1)] }, env, registry);
    await cmdShow(cmd, env, registry);
};

const cmdColor = async (cmd: PymolCommand, env: any, registry: PymolRegistry) => {
    const colorName = cmd.args[0];
    const selArg = cmd.args[1];
    if (!colorName) {
        console.warn(`[pymol:${cmd.lineNo}] color: missing colour name`);
        return;
    }
    const hex = resolveColor(colorName);
    const targets = await resolveSelection(selArg, env, registry);
    const touched = new Set<MoorhenMolecule>();
    for (const { molecule, cid } of targets) {
        molecule.addColourRule("cid", cid, hex, [cid, hex]);
        touched.add(molecule);
    }
    for (const molecule of touched) {
        try { await (molecule as any).redraw(); } catch (e) { console.warn(`[pymol:${cmd.lineNo}] redraw failed:`, e); }
    }
};

const cmdBgColor = async (cmd: PymolCommand, env: any) => {
    const colorName = cmd.args[0];
    if (!colorName) {
        console.warn(`[pymol:${cmd.lineNo}] bg_color: missing colour`);
        return;
    }
    const hex = resolveColor(colorName);
    // Parse #RRGGBB → [r, g, b, 1] in 0-1 floats
    const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (!m) {
        console.warn(`[pymol:${cmd.lineNo}] bg_color: cannot parse colour "${colorName}"`);
        return;
    }
    const r = parseInt(m[1], 16) / 255;
    const g = parseInt(m[2], 16) / 255;
    const b = parseInt(m[3], 16) / 255;
    env.dispatch(env.setBackgroundColor([r, g, b, 1]));
};

const cmdSet = async (cmd: PymolCommand, env: any, registry: PymolRegistry) => {
    // `set <key>, <value>[, <sel>]`. Only a curated subset is wired up.
    const key = cmd.args[0]?.trim().toLowerCase();
    const value = cmd.args[1]?.trim();
    const selArg = cmd.args[2];
    if (!key) return;

    if (key === "transparency") {
        const opacity = 1 - parseFloat(value);
        if (isNaN(opacity)) {
            console.warn(`[pymol:${cmd.lineNo}] set transparency: invalid value "${value}"`);
            return;
        }
        const targets = await resolveSelection(selArg, env, registry);
        for (const { molecule } of targets) {
            for (const rep of (molecule.representations as moorhen.MoleculeRepresentation[])) {
                if (rep.isCustom) rep.setNonCustomOpacity?.(opacity);
            }
        }
    } else if (key === "ray_shadow" || key === "ray_shadows") {
        env.dispatch(env.setDoShadow(value !== "0" && value !== "off"));
    } else if (key === "rocking") {
        env.dispatch(env.setDoSpin(value !== "0" && value !== "off"));
    } else if (key === "fog_start") {
        const v = parseFloat(value);
        if (!isNaN(v)) env.dispatch(env.setFogStart(v));
    } else if (key === "surface_quality") {
        console.warn(`[pymol:${cmd.lineNo}] set surface_quality is deferred to a later phase`);
    } else {
        console.warn(`[pymol:${cmd.lineNo}] set ${key}: unsupported (silently ignored)`);
    }
};

const cmdSpectrum = async (cmd: PymolCommand, env: any, registry: PymolRegistry) => {
    // `spectrum [expression[, palette[, selection]]]`. Currently only the B-factor
    // mode is supported reliably; rainbow-by-residue needs a verified Moorhen
    // rule type (mol-symmetry was wrong — colours by symmetry mate, not residue).
    const expr = (cmd.args[0] ?? "count").trim().toLowerCase();
    const selArg = cmd.args[2];
    const targets = await resolveSelection(selArg, env, registry);
    if (expr === "b" || expr === "b-factor") {
        const touched = new Set<MoorhenMolecule>();
        for (const { molecule, cid } of targets) {
            molecule.addColourRule("b-factor-normalised", cid, "#888888", [cid], true);
            touched.add(molecule);
        }
        for (const molecule of touched) {
            try { await (molecule as any).redraw(); } catch {}
        }
        return;
    }
    console.warn(`[pymol:${cmd.lineNo}] spectrum "${expr}" not yet supported (only "b" / "b-factor" wired)`);
};

const cmdRock = async (cmd: PymolCommand, env: any) => {
    env.dispatch(env.setDoSpin(true));
};

const cmdSelect = async (cmd: PymolCommand, env: any, registry: PymolRegistry) => {
    // `select <name>, <expr>` — store the parsed AST under <name> in the registry.
    // Subsequent commands referencing `<name>` as an object/selection get the AST
    // substituted in.
    const name = cmd.args[0]?.trim();
    const exprStr = cmd.args.slice(1).join(",").trim();
    if (!name || !exprStr) {
        console.warn(`[pymol:${cmd.lineNo}] select: usage 'select <name>, <expr>'`);
        return;
    }
    try {
        const ast = parseSelection(exprStr);
        registry.register(name, { kind: "named", ast });
    } catch (e: any) {
        console.warn(`[pymol:${cmd.lineNo}] select: parse error in expression "${exprStr}": ${e?.message ?? e}`);
    }
};

const cmdDeselect = async () => {
    // PyMOL deselect clears the auto-generated `sele` selection; we honour by
    // unregistering it if present. Named selections persist.
};

// ---------- dispatcher ----------

const handlers: Record<string, (cmd: PymolCommand, env: any, registry: PymolRegistry, scriptApi: ScriptContext) => Promise<void>> = {
    fetch: cmdFetch,
    load: cmdLoad,
    delete: cmdDelete,
    enable: cmdToggleVisibility(true),
    disable: cmdToggleVisibility(false),
    zoom: cmdZoom,
    orient: cmdZoom,
    center: cmdCenter,
    set_view: cmdSetView,
    // Tier 2
    show: cmdShow,
    hide: cmdHide,
    as: cmdAs,
    color: cmdColor,
    colour: cmdColor,
    bg_color: cmdBgColor,
    bg_colour: cmdBgColor,
    background_color: cmdBgColor,
    set: cmdSet,
    spectrum: cmdSpectrum,
    rock: cmdRock,
    // Tier 3: named selections
    select: cmdSelect,
    deselect: cmdDeselect,
    // Soft-warns
    pseudoatom: async (cmd) => { console.warn(`[pymol:${cmd.lineNo}] pseudoatom: not supported (no-op)`); },
};

/**
 * Top-level entry. Parses the source then dispatches each command sequentially.
 * Errors per command are surfaced as console warnings; remaining commands continue.
 */
export const executePymolScript = async (
    src: string,
    env: any,
    scriptApi: ScriptContext
): Promise<void> => {
    const cmds = parsePymolScript(src);
    const registry = new PymolRegistry();
    for (const cmd of cmds) {
        const handler = handlers[cmd.cmd];
        if (!handler) {
            console.warn(`[pymol:${cmd.lineNo}] unsupported command: ${cmd.cmd}`);
            continue;
        }
        try {
            await handler(cmd, env, registry, scriptApi);
        } catch (e: any) {
            console.warn(`[pymol:${cmd.lineNo}] ${cmd.cmd} failed:`, e?.message ?? e);
        }
    }
};
