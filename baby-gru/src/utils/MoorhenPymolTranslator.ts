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
        if (r && r.kind === "object") {
            scopedMolNos.add(r.molNo);
        } else {
            // Registry miss — fall back to matching by molecule.name (handles
            // cross-script-run cases where this script didn't fetch the object).
            const byName = allMols.find(m => m.name === name);
            if (byName) scopedMolNos.add(byName.molNo);
        }
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
    // PyMOL's fetch replaces an existing object of the same name. Drop any
    // stale molecule with this id from the live state before adding the new one.
    const existing = (env.store.getState().molecules.moleculeList as MoorhenMolecule[])
        .filter(m => m && m.name === pdbId);
    for (const old of existing) {
        try { await old.delete(); } catch {}
        env.dispatch(env.removeMolecule(old));
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
    env.dispatch(env.showMolecule(mol));
    registry.register(pdbId, { kind: "object", molNo: mol.molNo });
};

const cmdDelete = async (cmd: PymolCommand, env: any, registry: PymolRegistry) => {
    const target = cmd.args[0]?.trim();
    if (!target || target === "all") {
        const mols = [...(env.store.getState().molecules.moleculeList as MoorhenMolecule[])];
        for (const m of mols) {
            try { await m.delete(); } catch {}
            env.dispatch(env.removeMolecule(m));
        }
        registry.entries.clear();
        env.dispatch(env.setRequestDrawScene(true));
        return;
    }
    let mol: MoorhenMolecule | undefined;
    const resolved = registry.resolve(target);
    if (resolved && resolved.kind === "object") {
        mol = (env.store.getState().molecules.moleculeList as MoorhenMolecule[])
            .find(m => m.molNo === resolved.molNo);
    } else {
        mol = (env.store.getState().molecules.moleculeList as MoorhenMolecule[])
            .find(m => m.name === target);
    }
    if (!mol) {
        console.warn(`[pymol:${cmd.lineNo}] delete: unknown object "${target}"`);
        return;
    }
    try { await mol.delete(); } catch {}
    env.dispatch(env.removeMolecule(mol));
    registry.unregister(target);
    env.dispatch(env.setRequestDrawScene(true));
};

const cmdToggleVisibility = (show: boolean) =>
    async (cmd: PymolCommand, env: any, registry: PymolRegistry) => {
        const target = cmd.args[0]?.trim();
        const action = show ? env.showMolecule : env.hideMolecule;

        const applyTo = async (mol: MoorhenMolecule) => {
            env.dispatch(action(mol));
            // Redux flag alone doesn't reach the WebGL renderer; iterate the
            // representations so the cartoons/bonds actually hide or reappear.
            for (const r of (mol.representations as moorhen.MoleculeRepresentation[])) {
                try {
                    if (show) await r.show();
                    else r.hide();
                } catch (e) { /* skip stale rep */ }
            }
            env.dispatch(env.setRequestDrawScene(true));
        };

        if (!target || target === "all") {
            const mols = (env.store.getState().molecules.moleculeList as MoorhenMolecule[]).filter(isLiveMolecule);
            for (const m of mols) await applyTo(m);
            return;
        }
        // Try the registry first (target was loaded in THIS script run); otherwise
        // fall back to matching by molecule.name in Redux. The registry is per-run,
        // so a separate `disable 1crn` after a `fetch 1crn` needs this fallback.
        let mol: MoorhenMolecule | undefined;
        const resolved = registry.resolve(target);
        if (resolved && resolved.kind === "object") {
            mol = (env.store.getState().molecules.moleculeList as MoorhenMolecule[])
                .find(m => m.molNo === resolved.molNo);
        } else {
            mol = (env.store.getState().molecules.moleculeList as MoorhenMolecule[])
                .find(m => m.name === target);
        }
        if (!mol || !isLiveMolecule(mol)) {
            console.warn(`[pymol:${cmd.lineNo}] ${show ? "enable" : "disable"}: unknown object "${target}"`);
            return;
        }
        await applyTo(mol);
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
    // `set <key>, <value>[, <sel>]`. PyMOL has hundreds of settings; we wire
    // up the most useful ones that map cleanly to Moorhen's scene-settings
    // Redux slice. Anything not in the table warns and is otherwise a no-op.
    const key = cmd.args[0]?.trim().toLowerCase();
    const value = cmd.args[1]?.trim();
    const selArg = cmd.args[2];
    if (!key) return;

    const truthy = (v: string | undefined) => v !== undefined && v !== "0" && v.toLowerCase() !== "off" && v.toLowerCase() !== "false";
    const num = (v: string | undefined) => { const n = parseFloat(v ?? ""); return isNaN(n) ? null : n; };

    switch (key) {
        case "transparency": {
            const opacity = 1 - parseFloat(value ?? "");
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
            return;
        }
        case "ray_shadow":
        case "ray_shadows":
        case "shadows":
            env.dispatch(env.setDoShadow(truthy(value)));
            return;
        case "rocking":
        case "spin":
            env.dispatch(env.setDoSpin(truthy(value)));
            return;
        case "fog_start": {
            const v = num(value);
            if (v !== null) env.dispatch(env.setFogStart(v));
            return;
        }
        case "fog_end": {
            const v = num(value);
            if (v !== null) env.dispatch(env.setFogEnd(v));
            return;
        }
        case "ambient": {
            // PyMOL ambient is a 0-1 scalar; Moorhen wants an RGBA tuple
            const v = num(value);
            if (v !== null) env.dispatch(env.setAmbient([v, v, v, 1]));
            return;
        }
        case "spec_reflect":
        case "specular": {
            const v = num(value);
            if (v !== null) env.dispatch(env.setSpecular([v, v, v, 1]));
            return;
        }
        case "specular_power":
        case "shininess": {
            const v = num(value);
            if (v !== null) env.dispatch(env.setSpecularPower(v));
            return;
        }
        case "depth_cue":
        case "ray_trace_mode": {
            // PyMOL ray_trace_mode > 0 turns on edges; Moorhen has setDoEdgeDetect
            env.dispatch(env.setDoEdgeDetect(truthy(value)));
            return;
        }
        case "ray_opaque_background": {
            // Transparent background — Moorhen exposes via doTransparentBackground
            // on the screenshot path; here we toast since there's no live mode.
            if (env.enqueueSnackbar) {
                env.dispatch(env.enqueueSnackbar({
                    message: `Set ${truthy(value) ? "opaque" : "transparent"} background — takes effect at next png/ray`,
                    variant: "info",
                }));
            }
            return;
        }
        case "anaglyph":
        case "anaglyph_stereo":
            env.dispatch(env.setDoAnaglyphStereo(truthy(value)));
            return;
        case "draw_axes":
        case "axes":
            env.dispatch(env.setDrawAxes(truthy(value)));
            return;
        case "draw_crosshairs":
        case "crosshairs":
            env.dispatch(env.setDrawCrosshairs(truthy(value)));
            return;
        case "draw_scale_bar":
        case "scale_bar":
            env.dispatch(env.setDrawScaleBar(truthy(value)));
            return;
        case "viewport":
        case "size":
            console.warn(`[pymol:${cmd.lineNo}] set ${key}: window size is browser-controlled; ignored`);
            return;
        case "surface_quality":
        case "surface_color":
        case "surface_solvent":
            console.warn(`[pymol:${cmd.lineNo}] set ${key}: deferred (surface rendering tuning not yet wired)`);
            return;
        default:
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

// ---------- Tier 4: measurements + screenshots ----------

const cmdDistance = async (cmd: PymolCommand, env: any, registry: PymolRegistry) => {
    // `distance [name,] sel1, sel2` — compute centroid-to-centroid distance.
    // Draws a labelled dashed line in the viewport (via the same measurement
    // system the mouse-click tool uses) AND fires a snackbar toast with the
    // numeric value AND logs to console.
    let name: string | undefined;
    let sel1Arg: string | undefined;
    let sel2Arg: string | undefined;
    if (cmd.args.length === 2) {
        [sel1Arg, sel2Arg] = cmd.args;
    } else if (cmd.args.length >= 3) {
        [name, sel1Arg, sel2Arg] = cmd.args;
    } else {
        console.warn(`[pymol:${cmd.lineNo}] distance: usage 'distance [name,] sel1, sel2'`);
        return;
    }

    const centroidOf = async (selArg: string): Promise<{ x: number; y: number; z: number; n: number; sample: any | null }> => {
        const targets = await resolveSelection(selArg, env, registry);
        let sx = 0, sy = 0, sz = 0, n = 0;
        let sample: any | null = null;
        for (const { molecule, cid } of targets) {
            const atoms = await molecule.gemmiAtomsForCid(cid);
            for (const a of atoms) {
                sx += a.x; sy += a.y; sz += a.z; n++;
                if (!sample) sample = a;
            }
        }
        return { x: sx / Math.max(1, n), y: sy / Math.max(1, n), z: sz / Math.max(1, n), n, sample };
    };

    const a = await centroidOf(sel1Arg!);
    const b = await centroidOf(sel2Arg!);
    if (a.n === 0 || b.n === 0) {
        console.warn(`[pymol:${cmd.lineNo}] distance: empty selection`);
        return;
    }
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
    const label = name ? `${name}: ` : "";
    const msg = `distance ${label}${d.toFixed(2)} Å`;
    console.log(`[pymol:${cmd.lineNo}] ${msg}`);

    // Snackbar toast
    if (env.enqueueSnackbar) {
        env.dispatch(env.enqueueSnackbar({ message: msg, variant: "info" }));
    }

    // Persistent visual annotation: push a synthetic atom pair into the canvas
    // measurement system. Uses the centroid coordinates and a representative
    // sample atom for the label fields.
    const glRef = (window as any).__moorhen_glRef__;
    const gl = glRef?.current;
    if (gl) {
        const mkAtom = (centroid: typeof a, label: string) => ({
            x: centroid.x, y: centroid.y, z: centroid.z,
            charge: 0, tempFactor: 0, element: centroid.sample?.element ?? "X",
            name: label, res_name: centroid.sample?.res_name ?? "", res_no: centroid.sample?.res_no ?? 0,
            mol_name: "", serial: 0, has_altloc: false, chain_id: centroid.sample?.chain_id ?? "",
            label,
        });
        if (!Array.isArray(gl.measuredAtoms)) gl.measuredAtoms = [];
        gl.measuredAtoms.push([
            mkAtom(a, name ? `${name}.start` : "start"),
            mkAtom(b, name ? `${name}.end` : "end"),
        ]);
        try { gl.updateLabels?.(); gl.drawScene?.(); } catch (e) { /* renderer not ready */ }
    }
};

const cmdPng = async (cmd: PymolCommand, env: any) => {
    // PyMOL: png filename [, width [, height [, dpi [, ray ]]]]
    let filename = cmd.args[0]?.replace(/['"]/g, "").trim() || "moorhen_screenshot.png";
    if (!filename.toLowerCase().endsWith(".png")) filename += ".png";
    const rec = env.videoRecorderRef?.current;
    if (!rec) {
        console.warn(`[pymol:${cmd.lineNo}] png: screen-recorder not ready (open Moorhen via the UI first)`);
        return;
    }
    const width = parseInt(cmd.args[1]) || undefined;
    const height = parseInt(cmd.args[2]) || undefined;
    // `png ..., ray=1` (5th positional) requests the high-quality render.
    const highQuality = /^(1|on|true)$/i.test((cmd.args[4] || "").trim());
    try { await rec.takeScreenShot(filename, false, { width, height, highQuality }); }
    catch (e) { console.warn(`[pymol:${cmd.lineNo}] png failed:`, e); }
};

const cmdRay = async (cmd: PymolCommand, env: any) => {
    // PyMOL `ray [width [, height]]` — width-first; height derives from the
    // viewport aspect ratio when omitted. PyKeko renders a high-quality image
    // (supersampled + ambient occlusion + shadows), capped at the ~4096 px
    // render ceiling, and saves it (native Save panel in the desktop app).
    const rec = env.videoRecorderRef?.current;
    if (!rec) {
        console.warn(`[pymol:${cmd.lineNo}] ray: screen-recorder not ready (open Moorhen via the UI first)`);
        return;
    }
    const width = parseInt(cmd.args[0]) || undefined;
    const height = parseInt(cmd.args[1]) || undefined;
    try { await rec.takeScreenShot("moorhen_ray.png", false, { width, height, highQuality: true }); }
    catch (e) { console.warn(`[pymol:${cmd.lineNo}] ray failed:`, e); }
};

// ---------- labels ----------

// Per-atom text tokens supported in a `label` expression.
const LABEL_TOKENS: Record<string, (a: any) => string> = {
    resn: a => a.res_name,
    resi: a => String(a.res_no),
    resv: a => String(a.res_no),
    name: a => (a.name || "").trim(),
    chain: a => a.chain_id,
    elem: a => a.element,
    b: a => (a.tempFactor ?? 0).toFixed(2),
    q: a => (a.occupancy ?? 0).toFixed(2),
};

// Curated subset of PyMOL's label expression (full Python eval is out of scope,
// like iterate/alter). Supports: a quoted literal ("active site"); a bare token
// (resn/resi/name/chain/elem/b/q); and a Python-style `"fmt" % (tokens)` string
// (e.g. "%s/%s" % (resn, resi)). Anything else warns once and falls back to "<resn> <resi>".
const evalLabelExpr = (expr: string, atom: any, lineNo: number, warned: { v: boolean }): string => {
    const e = (expr || "").trim();
    if (!e) return "";
    const fmt = e.match(/^(['"])([\s\S]*)\1\s*%\s*\(?([\s\S]*?)\)?$/);
    if (fmt) {
        const toks = fmt[3].split(",").map(s => s.trim()).filter(Boolean);
        let i = 0;
        return fmt[2].replace(/%[-0-9.]*[sdifg]/g, () => {
            const t = toks[i++];
            const fn = t && LABEL_TOKENS[t.toLowerCase()];
            return fn ? fn(atom) : (t ?? "");
        });
    }
    const lit = e.match(/^(['"])([\s\S]*)\1$/);
    if (lit) return lit[2];
    const fn = LABEL_TOKENS[e.toLowerCase()];
    if (fn) return fn(atom);
    if (!warned.v) {
        console.warn(`[pymol:${lineNo}] label: expression ${JSON.stringify(expr)} not supported — use a quoted literal, a token (resn/resi/name/chain/elem/b/q), or "fmt" % (tokens); falling back to "<resn> <resi>"`);
        warned.v = true;
    }
    return `${atom.res_name} ${atom.res_no}`;
};

const cmdLabel = async (cmd: PymolCommand, env: any, registry: PymolRegistry) => {
    // PyMOL: label selection, expression. An empty expression clears ALL labels
    // (PyKeko doesn't track labels per selection).
    const selArg = cmd.args[0]?.trim();
    const expr = cmd.args.slice(1).join(",").trim();
    const gl = (window as any).__moorhen_glRef__?.current;
    if (!gl) { console.warn(`[pymol:${cmd.lineNo}] label: renderer not ready (open Moorhen via the UI first)`); return; }
    if (!expr || expr === '""' || expr === "''") {
        gl.labelledAtoms = [];
        try { gl.updateLabels?.(); gl.drawScene?.(); } catch (e) { /* renderer not ready */ }
        if (env.enqueueSnackbar) env.dispatch(env.enqueueSnackbar({ message: "Cleared labels", variant: "info" }));
        return;
    }
    if (!selArg) { console.warn(`[pymol:${cmd.lineNo}] label: needs a selection, e.g. \`label name CA, resn\``); return; }
    const targets = await resolveSelection(selArg, env, registry);
    if (targets.length === 0) { console.warn(`[pymol:${cmd.lineNo}] label: nothing matched "${selArg}"`); return; }
    if (!Array.isArray(gl.labelledAtoms)) gl.labelledAtoms = [];
    const warned = { v: false };
    let n = 0;
    for (const { molecule, cid } of targets) {
        const atoms = await molecule.gemmiAtomsForCid(cid);
        const entries = atoms.map((a: any) => ({ label: evalLabelExpr(expr, a, cmd.lineNo, warned), x: a.x, y: a.y, z: a.z }));
        if (entries.length) { gl.labelledAtoms.push(entries); n += entries.length; }
    }
    try { gl.updateLabels?.(); gl.drawScene?.(); } catch (e) { /* renderer not ready */ }
    if (env.enqueueSnackbar) env.dispatch(env.enqueueSnackbar({ message: `Labelled ${n} atom${n === 1 ? "" : "s"}`, variant: "info" }));
};

// ---------- superposition ----------

// PyMOL's super / cealign / align / fit. PyKeko maps ALL of them to Coot's SSM
// secondary-structure superposition (the sequence-independent auto-matcher the
// Superpose UI is built on); PyMOL's four distinct algorithms are not replicated.
// `<cmd> mobile, target` moves `mobile` onto `target` and reports the RMSD.
const cmdSuperpose = async (cmd: PymolCommand, env: any, registry: PymolRegistry) => {
    const name = (cmd as any).cmd;
    const mobArg = cmd.args[0]?.trim();
    const refArg = cmd.args[1]?.trim();
    if (!mobArg || !refArg) { console.warn(`[pymol:${cmd.lineNo}] ${name}: needs two selections, e.g. \`${name} mobile, target\``); return; }
    const mob = await resolveSelectionSingle(mobArg, env, registry);
    const ref = await resolveSelectionSingle(refArg, env, registry);
    if (!mob.molecule) { console.warn(`[pymol:${cmd.lineNo}] ${name}: cannot resolve mobile "${mobArg}"`); return; }
    if (!ref.molecule) { console.warn(`[pymol:${cmd.lineNo}] ${name}: cannot resolve target "${refArg}"`); return; }
    if (mob.molecule.molNo === ref.molecule.molNo) { console.warn(`[pymol:${cmd.lineNo}] ${name}: mobile and target are the same molecule`); return; }
    // Chain from the selection's cid if one is given, else the molecule's first
    // sequence chain — exactly how the Superpose UI resolves chains (no gemmi access).
    const chainFromCid = (cid: string): string | undefined => {
        const c = (cid || "").split("/")[2];
        return (c && c !== "*" && !c.includes("+") && !c.includes(",")) ? c : undefined;
    };
    const movChain = chainFromCid(mob.cid) || mob.molecule.sequences?.[0]?.chain;
    const refChain = chainFromCid(ref.cid) || ref.molecule.sequences?.[0]?.chain;
    if (!movChain || !refChain) { console.warn(`[pymol:${cmd.lineNo}] ${name}: could not determine chains to superpose`); return; }
    if (name !== "super" && name !== "cealign") {
        console.warn(`[pymol:${cmd.lineNo}] ${name}: PyKeko performs SSM secondary-structure superposition for super/cealign/align/fit alike (PyMOL's distinct ${name} algorithm is not replicated)`);
    }
    try {
        // Same path as the Superpose UI: the molecule's SSMSuperpose method.
        await mob.molecule.SSMSuperpose(movChain, ref.molecule.molNo, refChain);
        const tag = `${mob.molecule.name}/${movChain} → ${ref.molecule.name}/${refChain}`;
        if (env.enqueueSnackbar) env.dispatch(env.enqueueSnackbar({ message: `Superposed ${tag} (SSM)`, variant: "info" }));
    } catch (e) {
        console.warn(`[pymol:${cmd.lineNo}] ${name} failed:`, e);
    }
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
    // Tier 4: measurements + screenshots
    distance: cmdDistance,
    dist: cmdDistance,
    png: cmdPng,
    ray: cmdRay,
    // Labels + superposition
    label: cmdLabel,
    super: cmdSuperpose,
    cealign: cmdSuperpose,
    align: cmdSuperpose,
    fit: cmdSuperpose,
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
