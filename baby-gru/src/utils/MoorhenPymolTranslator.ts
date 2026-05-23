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
 * Resolve a Phase-1 PyMOL selection argument. Phase 1 only supports
 * - bare names registered by fetch/load (object names)
 * - `all` macro
 * - `*` (== all)
 * - empty (== all)
 * Full selection algebra arrives in Phase 3.
 */
const resolveSelectionPhase1 = (
    arg: string | undefined,
    env: any,
    registry: PymolRegistry
): { molecule: MoorhenMolecule | null; cid: string } => {
    if (!arg || arg === "all" || arg === "*") {
        // Whole-scene; pick first molecule for centring
        const mols = env.store.getState().molecules.moleculeList as MoorhenMolecule[];
        return { molecule: mols[0] ?? null, cid: "//*/*/*/*" };
    }
    const resolved = registry.resolve(arg);
    if (resolved && resolved.kind === "object") {
        const mol = (env.store.getState().molecules.moleculeList as MoorhenMolecule[])
            .find(m => m.molNo === resolved.molNo);
        return { molecule: mol ?? null, cid: "//*/*/*/*" };
    }
    // Fallback: treat as an unsupported expression for now
    return { molecule: null, cid: "" };
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
    const { molecule, cid } = resolveSelectionPhase1(arg, env, registry);
    if (!molecule) {
        console.warn(`[pymol:${cmd.lineNo}] zoom: cannot resolve target "${arg}"`);
        return;
    }
    await molecule.centreOn(cid, true, true);
};

const cmdCenter = async (cmd: PymolCommand, env: any, registry: PymolRegistry) => {
    const arg = cmd.args.join(",");
    const { molecule, cid } = resolveSelectionPhase1(arg, env, registry);
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
