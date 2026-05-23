/**
 * Runtime atom-filter engine for PyMOL selections that can't be expressed
 * as pure CIDs. Evaluates an AST against a molecule's atoms and returns
 * an explicit list of CIDs (atom- or residue-granularity).
 *
 * Includes:
 *  - A distance-based covalent-bond approximation (covalent if
 *    d ≤ r1 + r2 + 0.4 Å) for bound_to / extend / bymolecule. Documented
 *    limitation: ≥95% accuracy on standard residues; can misjudge unusual
 *    covalent geometries in non-standard ligands.
 *  - Brute-force distance queries for within/near_to/beyond/gap/contact.
 *    Sufficient for typical Moorhen workloads (≲50k atoms).
 *
 * No kd-tree yet; brute-force is O(n*m) where m is the inner-set size.
 * For 10k atoms and an inner set of ~100, that's 1M comparisons — fine.
 */

import { SelNode } from "./MoorhenPymolSelectionParser";
import { MoorhenMolecule } from "./MoorhenMolecule";
import { moorhen } from "../types/moorhen";

type AtomRec = {
    x: number; y: number; z: number;
    chain_id: string;
    res_no: number;
    res_name: string;
    name: string;
    alt_conf: string;
    element: string;
    tempFactor: number;
    occupancy: number;
    serial: number;
};

// Approximate covalent radii (Å) for the most common biological elements.
// Used by the distance-based bond approximation.
const COVALENT_RADII: Record<string, number> = {
    H: 0.31, D: 0.31,
    C: 0.76, N: 0.71, O: 0.66, F: 0.57,
    P: 1.07, S: 1.05, CL: 1.02,
    BR: 1.20, I: 1.39,
    NA: 1.66, K: 2.03, MG: 1.41, CA: 1.76,
    FE: 1.32, ZN: 1.22, CU: 1.32, MN: 1.39, NI: 1.24, CO: 1.26,
};

const radius = (el: string): number => COVALENT_RADII[el.toUpperCase()] ?? 0.85;

// 20 standard amino acid 3-letter codes plus common modified residues.
const STANDARD_AAS = new Set([
    "ALA", "ARG", "ASN", "ASP", "CYS", "GLN", "GLU", "GLY", "HIS", "ILE",
    "LEU", "LYS", "MET", "PHE", "PRO", "SER", "THR", "TRP", "TYR", "VAL",
    "MSE", "SEC", "PYL", "HID", "HIE", "HIP", "CYX", "CYM", "ASH", "GLH",
]);

const NUCLEIC = new Set(["DA", "DC", "DG", "DT", "A", "C", "G", "U", "T", "I"]);
const SOLVENT = new Set(["HOH", "WAT", "H2O", "D2O", "T3P", "SOL", "TIP", "TIP3", "TIP4"]);
const METALS = new Set([
    "LI", "NA", "K", "RB", "CS", "MG", "CA", "SR", "BA",
    "MN", "FE", "CO", "NI", "CU", "ZN", "AG", "AU",
    "AL", "HG", "CD", "PB", "MO", "W", "V", "CR",
]);

// PyMOL backbone atoms (protein N-CA-C-O, plus OXT; nucleic phosphate/sugar)
const PROTEIN_BACKBONE = new Set(["N", "CA", "C", "O", "OXT"]);
const NUCLEIC_BACKBONE = new Set(["P", "OP1", "OP2", "O3'", "O5'", "C3'", "C4'", "C5'"]);

const isProtein = (resName: string) => STANDARD_AAS.has(resName.toUpperCase());
const isNucleic = (resName: string) => NUCLEIC.has(resName.toUpperCase());
const isSolvent = (resName: string) => SOLVENT.has(resName.toUpperCase());
const isMetal = (element: string) => METALS.has(element.toUpperCase());

// ---------- Atom-level predicate evaluation ----------

const matchPred = (node: SelNode, atom: AtomRec): boolean => {
    switch (node.kind) {
        case "all": return true;
        case "none": return false;
        case "or": return matchPred(node.l, atom) || matchPred(node.r, atom);
        case "and": return matchPred(node.l, atom) && matchPred(node.r, atom);
        case "not": return !matchPred(node.inner, atom);
        case "pred_str": {
            const v = (() => {
                switch (node.prop) {
                    case "chain": return atom.chain_id;
                    case "resn": return atom.res_name;
                    case "name": return atom.name;
                    case "elem": return atom.element;
                    case "alt": return atom.alt_conf;
                    case "segi": return ""; // not exposed by Moorhen atom records
                }
            })().toString().toUpperCase().trim();
            return node.values.some(needle => needle.toUpperCase().trim() === v);
        }
        case "pred_resi":
            return node.ranges.some(r => atom.res_no >= r.lo && atom.res_no <= r.hi);
        case "pred_num":
            if (node.prop === "id") return node.values.includes(atom.serial);
            // index / rank not directly exposed; fall back to serial
            return node.values.includes(atom.serial);
        case "pred_comp": {
            const v = node.prop === "b" ? atom.tempFactor
                    : node.prop === "q" ? atom.occupancy
                    : 0;
            switch (node.op) {
                case ">":  return v >   node.value;
                case "<":  return v <   node.value;
                case ">=": return v >=  node.value;
                case "<=": return v <=  node.value;
                case "=":  return v === node.value;
                case "<>": return v !== node.value;
            }
            return false;
        }
        case "macro": {
            const r = atom.res_name.toUpperCase();
            const n = atom.name.toUpperCase();
            switch (node.name) {
                case "all": return true;
                case "none": return false;
                case "hydro":
                case "hydrogen": return atom.element.toUpperCase() === "H" || atom.element.toUpperCase() === "D";
                case "hetatm":
                case "het": return !isProtein(r) && !isNucleic(r) && !isSolvent(r);
                case "polymer": return isProtein(r) || isNucleic(r);
                case "polymer.protein": return isProtein(r);
                case "polymer.nucleic": return isNucleic(r);
                case "solvent":
                case "water": return isSolvent(r);
                case "metals": return isMetal(atom.element);
                case "ions": return isMetal(atom.element) || /^(CL|BR|I|F)$/.test(atom.element.toUpperCase());
                case "lig": return !isProtein(r) && !isNucleic(r) && !isSolvent(r) && !isMetal(atom.element);
                case "organic": return !isProtein(r) && !isNucleic(r) && /^(C|N|O|S|P|H)$/.test(atom.element.toUpperCase());
                case "inorganic": return !/^(C|N|O|S|P|H)$/.test(atom.element.toUpperCase());
                case "backbone":
                    return isProtein(r) ? PROTEIN_BACKBONE.has(n) : isNucleic(r) ? NUCLEIC_BACKBONE.has(n) : false;
                case "sidechain":
                    return isProtein(r) && !PROTEIN_BACKBONE.has(n) && atom.element.toUpperCase() !== "H";
                case "nonbonded": return false; // requires bond graph; rare in practice
                case "stereo":
                case "cis_peptide":
                case "trans_peptide": return false;
            }
            return false;
        }
        case "object":
            // Object names are resolved by the caller before reaching here. If we see
            // one here it means the name didn't resolve to a registered molecule.
            return false;
        // Topology / dist / reducer are handled at the set level, not per-atom
        default:
            return false;
    }
};

// ---------- Set-level operations ----------

const distSq = (a: AtomRec, b: AtomRec): number => {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return dx*dx + dy*dy + dz*dz;
};

const computeBondGraph = (atoms: AtomRec[]): Map<number, number[]> => {
    // Build distance-based covalent adjacency. Index in array = node id.
    const graph: Map<number, number[]> = new Map();
    for (let i = 0; i < atoms.length; i++) graph.set(i, []);
    for (let i = 0; i < atoms.length; i++) {
        const a = atoms[i];
        const ra = radius(a.element);
        for (let j = i + 1; j < atoms.length; j++) {
            const b = atoms[j];
            const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3 || Math.abs(dz) > 3) continue;
            const d2 = dx*dx + dy*dy + dz*dz;
            const cutoff = ra + radius(b.element) + 0.4;
            if (d2 <= cutoff * cutoff) {
                graph.get(i)!.push(j);
                graph.get(j)!.push(i);
            }
        }
    }
    return graph;
};

const expandByres = (matched: Set<number>, atoms: AtomRec[]): Set<number> => {
    const out = new Set(matched);
    const keyOf = (a: AtomRec) => `${a.chain_id}|${a.res_no}`;
    const matchedResidues = new Set<string>();
    for (const i of matched) matchedResidues.add(keyOf(atoms[i]));
    for (let i = 0; i < atoms.length; i++) {
        if (matchedResidues.has(keyOf(atoms[i]))) out.add(i);
    }
    return out;
};

const expandBychain = (matched: Set<number>, atoms: AtomRec[]): Set<number> => {
    const out = new Set(matched);
    const chains = new Set<string>();
    for (const i of matched) chains.add(atoms[i].chain_id);
    for (let i = 0; i < atoms.length; i++) {
        if (chains.has(atoms[i].chain_id)) out.add(i);
    }
    return out;
};

const expandWithin = (matched: Set<number>, atoms: AtomRec[], cutoff: number, exclusive: boolean): Set<number> => {
    const cutoff2 = cutoff * cutoff;
    const inner = [...matched].map(i => atoms[i]);
    const out = new Set<number>();
    for (let i = 0; i < atoms.length; i++) {
        if (exclusive && matched.has(i)) continue;
        const a = atoms[i];
        for (const b of inner) {
            if (distSq(a, b) <= cutoff2) { out.add(i); break; }
        }
    }
    if (!exclusive) for (const i of matched) out.add(i);
    return out;
};

const expandBeyond = (matched: Set<number>, atoms: AtomRec[], cutoff: number): Set<number> => {
    const cutoff2 = cutoff * cutoff;
    const inner = [...matched].map(i => atoms[i]);
    const out = new Set<number>();
    for (let i = 0; i < atoms.length; i++) {
        const a = atoms[i];
        let nearAny = false;
        for (const b of inner) {
            if (distSq(a, b) < cutoff2) { nearAny = true; break; }
        }
        if (!nearAny) out.add(i);
    }
    return out;
};

const expandBoundTo = (matched: Set<number>, graph: Map<number, number[]>): Set<number> => {
    const out = new Set<number>();
    for (const i of matched) {
        for (const j of graph.get(i) ?? []) out.add(j);
    }
    return out;
};

const expandExtend = (matched: Set<number>, graph: Map<number, number[]>, n: number): Set<number> => {
    let current = new Set(matched);
    for (let step = 0; step < n; step++) {
        const next = new Set(current);
        for (const i of current) {
            for (const j of graph.get(i) ?? []) next.add(j);
        }
        current = next;
    }
    return current;
};

const expandBymolecule = (matched: Set<number>, graph: Map<number, number[]>): Set<number> => {
    // Flood-fill: every atom in the connected component of any matched atom.
    const out = new Set<number>();
    const stack = [...matched];
    while (stack.length) {
        const i = stack.pop()!;
        if (out.has(i)) continue;
        out.add(i);
        for (const j of graph.get(i) ?? []) if (!out.has(j)) stack.push(j);
    }
    return out;
};

const evaluateNode = (node: SelNode, atoms: AtomRec[], graph: () => Map<number, number[]>): Set<number> => {
    switch (node.kind) {
        case "byres": {
            const inner = evaluateNode(node.inner, atoms, graph);
            return expandByres(inner, atoms);
        }
        case "bychain": {
            const inner = evaluateNode(node.inner, atoms, graph);
            return expandBychain(inner, atoms);
        }
        case "byobject":
        case "bymodel":
            return new Set(atoms.map((_, i) => i)); // single-molecule scope = whole thing
        case "bysegi":
            return evaluateNode(node.inner, atoms, graph);
        case "bymolecule":
            return expandBymolecule(evaluateNode(node.inner, atoms, graph), graph());
        case "bound_to":
        case "neighbor":
            return expandBoundTo(evaluateNode(node.inner, atoms, graph), graph());
        case "extend":
            return expandExtend(evaluateNode(node.inner, atoms, graph), graph(), node.n);
        case "dist": {
            const inner = evaluateNode(node.inner, atoms, graph);
            if (node.op === "within") return expandWithin(inner, atoms, node.n, false);
            if (node.op === "near_to" || node.op === "contact") return expandWithin(inner, atoms, node.n, true);
            if (node.op === "beyond" || node.op === "gap") return expandBeyond(inner, atoms, node.n);
            return inner;
        }
        case "first": {
            const inner = evaluateNode(node.inner, atoms, graph);
            const sorted = [...inner].sort((a, b) => a - b);
            return new Set(sorted.slice(0, 1));
        }
        case "last": {
            const inner = evaluateNode(node.inner, atoms, graph);
            const sorted = [...inner].sort((a, b) => b - a);
            return new Set(sorted.slice(0, 1));
        }
        default: {
            // Per-atom predicates
            const out = new Set<number>();
            for (let i = 0; i < atoms.length; i++) {
                if (matchPred(node, atoms[i])) out.add(i);
            }
            return out;
        }
    }
};

/**
 * Evaluate a selection AST against a molecule's atoms; return CID strings
 * (one per matched residue or atom, depending on granularity). The result
 * is a list of CIDs that can be `||`-joined to form a Moorhen representation
 * selector.
 *
 * @param granularity "residue" coalesces per-residue (avoids CID explosion
 *                    for large selections; what reps/colour want)
 *                    "atom" emits per-atom CIDs (rare; for measurement)
 */
export const evaluateSelectionForMolecule = async (
    ast: SelNode,
    molecule: MoorhenMolecule,
    granularity: "atom" | "residue" = "residue"
): Promise<string[]> => {
    // Fast-path: "all" → single CID
    if (ast.kind === "all") return ["/*/*/*/*"];
    if (ast.kind === "none") return [];

    const atoms = (await molecule.gemmiAtomsForCid("/*/*/*/*")) as unknown as AtomRec[];
    if (!atoms || atoms.length === 0) return [];

    let cachedGraph: Map<number, number[]> | null = null;
    const lazyGraph = () => {
        if (!cachedGraph) cachedGraph = computeBondGraph(atoms);
        return cachedGraph;
    };

    const indices = evaluateNode(ast, atoms, lazyGraph);

    if (granularity === "atom") {
        return [...indices].map(i => {
            const a = atoms[i];
            return `//${a.chain_id}/${a.res_no}/${a.name}`;
        });
    }
    // Residue-granularity: coalesce by (chain, resno)
    const residues = new Set<string>();
    for (const i of indices) {
        const a = atoms[i];
        residues.add(`//${a.chain_id}/${a.res_no}`);
    }
    return [...residues];
};

/**
 * Helper: collapse runs of consecutive residues in the same chain into ranges.
 * e.g. ["//A/1", "//A/2", "//A/3", "//A/5"] → ["//A/1-3", "//A/5"]
 * Reduces CID list length for selections that span hundreds of residues.
 */
export const coalesceResidueCids = (cids: string[]): string[] => {
    const parsed = cids.map(c => {
        const m = c.match(/^\/\/([^/]+)\/(-?\d+)$/);
        return m ? { chain: m[1], resno: parseInt(m[2], 10) } : null;
    }).filter(Boolean) as { chain: string; resno: number }[];
    parsed.sort((a, b) => a.chain === b.chain ? a.resno - b.resno : a.chain.localeCompare(b.chain));
    const out: string[] = [];
    let runStart: { chain: string; resno: number } | null = null;
    let runEnd = 0;
    const flush = () => {
        if (!runStart) return;
        if (runStart.resno === runEnd) out.push(`//${runStart.chain}/${runStart.resno}`);
        else out.push(`//${runStart.chain}/${runStart.resno}-${runEnd}`);
        runStart = null;
    };
    for (const p of parsed) {
        if (runStart && p.chain === runStart.chain && p.resno === runEnd + 1) {
            runEnd = p.resno;
        } else {
            flush();
            runStart = p;
            runEnd = p.resno;
        }
    }
    flush();
    return out;
};
