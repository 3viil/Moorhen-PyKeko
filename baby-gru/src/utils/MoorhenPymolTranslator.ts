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
    | { kind: "cid"; cids: string[]; molNo?: number };

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
 * Resolve a Phase-1/2 PyMOL selection argument. Supports:
 *  - bare names registered by fetch/load (object names) → that one molecule
 *  - `all` / `*` / empty → every loaded molecule
 *  Full selection algebra (chain X and resi N…) arrives in Phase 3.
 *
 * Returns the list of (molecule, cid) pairs to operate on. Phase 1/2 always
 * uses the all-atoms CID since we can't compile real selections yet.
 */
const resolveSelectionPhase1 = (
    arg: string | undefined,
    env: any,
    registry: PymolRegistry
): { molecule: MoorhenMolecule; cid: string }[] => {
    const allMols = env.store.getState().molecules.moleculeList as MoorhenMolecule[];
    if (!arg || arg === "all" || arg === "*") {
        return allMols.map(m => ({ molecule: m, cid: "/*/*/*/*" }));
    }
    const trimmed = arg.trim();
    const resolved = registry.resolve(trimmed);
    if (resolved && resolved.kind === "object") {
        const mol = allMols.find(m => m.molNo === resolved.molNo);
        return mol ? [{ molecule: mol, cid: "/*/*/*/*" }] : [];
    }
    return [];
};

/** Single-molecule convenience wrapper for commands like zoom/center. */
const resolveSelectionSingle = (
    arg: string | undefined,
    env: any,
    registry: PymolRegistry
): { molecule: MoorhenMolecule | null; cid: string } => {
    const list = resolveSelectionPhase1(arg, env, registry);
    return list[0] ?? { molecule: null, cid: "" };
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
    const { molecule, cid } = resolveSelectionSingle(arg, env, registry);
    if (!molecule) {
        console.warn(`[pymol:${cmd.lineNo}] zoom: cannot resolve target "${arg}"`);
        return;
    }
    await molecule.centreOn(cid, true, true);
};

const cmdCenter = async (cmd: PymolCommand, env: any, registry: PymolRegistry) => {
    const arg = cmd.args.join(",");
    const { molecule, cid } = resolveSelectionSingle(arg, env, registry);
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
    if (!repKey || repKey === "everything") {
        // `show everything` is rare in scripts but exists; map to all reps for sel
        // For now just pass — no-op
        return;
    }
    const style = REP_MAP[repKey];
    if (!style) {
        console.warn(`[pymol:${cmd.lineNo}] show: unsupported representation "${repKey}"`);
        return;
    }
    const targets = resolveSelectionPhase1(selArg, env, registry);
    for (const { molecule, cid } of targets) {
        await molecule.addRepresentation(style, cid, true);
    }
};

const cmdHide = async (cmd: PymolCommand, env: any, registry: PymolRegistry) => {
    const repKey = cmd.args[0]?.trim().toLowerCase();
    const selArg = cmd.args[1];
    const targets = resolveSelectionPhase1(selArg, env, registry);
    for (const { molecule } of targets) {
        const reps = [...(molecule.representations as moorhen.MoleculeRepresentation[])];
        const toRemove = repKey === "everything" || !repKey
            ? reps
            : reps.filter(r => r.style === REP_MAP[repKey]);
        for (const r of toRemove) {
            r.deleteBuffers?.();
            const idx = molecule.representations.indexOf(r);
            if (idx >= 0) molecule.representations.splice(idx, 1);
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
    const targets = resolveSelectionPhase1(selArg, env, registry);
    for (const { molecule, cid } of targets) {
        molecule.addColourRule("cid", cid, hex, [cid, hex]);
        // Re-apply existing representations so the new rule takes effect
        await molecule.fetchIfDirtyAndDraw("CBs");
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
        const targets = resolveSelectionPhase1(selArg, env, registry);
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
    // `spectrum [expression[, palette[, selection]]]`. Most common cases:
    //   spectrum count, rainbow        → rainbow by residue number
    //   spectrum b                     → B-factor
    //   spectrum b, blue_white_red, sel
    const expr = (cmd.args[0] ?? "count").trim().toLowerCase();
    const selArg = cmd.args[2];
    const targets = resolveSelectionPhase1(selArg, env, registry);
    let ruleType: string;
    if (expr === "count" || expr === "resi" || expr === "rainbow") ruleType = "mol-symmetry"; // closest stock rule
    else if (expr === "b" || expr === "b-factor") ruleType = "b-factor-normalised";
    else {
        console.warn(`[pymol:${cmd.lineNo}] spectrum: unsupported expression "${expr}"`);
        return;
    }
    for (const { molecule, cid } of targets) {
        molecule.addColourRule(ruleType, cid, "#888888", [cid], true);
        await molecule.fetchIfDirtyAndDraw("CBs");
    }
};

const cmdRock = async (cmd: PymolCommand, env: any) => {
    env.dispatch(env.setDoSpin(true));
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
