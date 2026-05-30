// Tests for the PyMOL runtime atom-filter (no WASM).
// We mock a tiny molecule + atom list and exercise the filter directly.
import { parseSelection } from "../../src/utils/MoorhenPymolSelectionParser";
import { evaluateSelectionForMolecule, coalesceResidueCids } from "../../src/utils/MoorhenPymolFilter";

// 12-atom mock structure: chain A residues 1-3 (each with N, CA, C, O),
// chain B residue 1 (one heme HEM with 4 atoms FE/N1/N2/CHA), one solvent HOH.
const makeAtoms = () => [
    { x:0, y:0, z:0, chain_id:"A", res_no:1, res_name:"ALA", name:"N",  alt_conf:"", element:"N", tempFactor:25, occupancy:1, serial:1  },
    { x:1, y:0, z:0, chain_id:"A", res_no:1, res_name:"ALA", name:"CA", alt_conf:"", element:"C", tempFactor:20, occupancy:1, serial:2  },
    { x:2, y:0, z:0, chain_id:"A", res_no:1, res_name:"ALA", name:"C",  alt_conf:"", element:"C", tempFactor:22, occupancy:1, serial:3  },
    { x:2, y:1, z:0, chain_id:"A", res_no:1, res_name:"ALA", name:"O",  alt_conf:"", element:"O", tempFactor:24, occupancy:1, serial:4  },
    { x:3, y:0, z:0, chain_id:"A", res_no:2, res_name:"GLY", name:"N",  alt_conf:"", element:"N", tempFactor:35, occupancy:1, serial:5  },
    { x:4, y:0, z:0, chain_id:"A", res_no:2, res_name:"GLY", name:"CA", alt_conf:"", element:"C", tempFactor:33, occupancy:1, serial:6  },
    { x:5, y:0, z:0, chain_id:"A", res_no:2, res_name:"GLY", name:"C",  alt_conf:"", element:"C", tempFactor:31, occupancy:1, serial:7  },
    { x:6, y:0, z:0, chain_id:"A", res_no:3, res_name:"TRP", name:"CA", alt_conf:"", element:"C", tempFactor:15, occupancy:1, serial:8  },
    { x:10, y:10, z:10, chain_id:"B", res_no:101, res_name:"HEM", name:"FE", alt_conf:"", element:"FE", tempFactor:18, occupancy:1, serial:9 },
    { x:11, y:10, z:10, chain_id:"B", res_no:101, res_name:"HEM", name:"N1", alt_conf:"", element:"N", tempFactor:19, occupancy:1, serial:10 },
    { x:9,  y:10, z:10, chain_id:"B", res_no:101, res_name:"HEM", name:"N2", alt_conf:"", element:"N", tempFactor:21, occupancy:1, serial:11 },
    { x:20, y:20, z:20, chain_id:"W", res_no:1,   res_name:"HOH", name:"O",  alt_conf:"", element:"O", tempFactor:40, occupancy:1, serial:12 },
];

const makeMockMolecule = (atoms) => ({
    name: "mock",
    molNo: 0,
    async gemmiAtomsForCid(_cid) { return atoms; },
});

describe("evaluateSelectionForMolecule: macros", () => {
    test("all -> single all-atoms CID (fast path)", async () => {
        const mol = makeMockMolecule(makeAtoms());
        const cids = await evaluateSelectionForMolecule({ kind: "all" }, mol);
        expect(cids).toEqual(["/*/*/*/*"]);
    });

    test("none -> empty", async () => {
        const mol = makeMockMolecule(makeAtoms());
        const cids = await evaluateSelectionForMolecule({ kind: "none" }, mol);
        expect(cids).toEqual([]);
    });

    test("solvent picks HOH", async () => {
        const mol = makeMockMolecule(makeAtoms());
        const ast = parseSelection("solvent");
        const cids = await evaluateSelectionForMolecule(ast, mol);
        expect(cids).toContain("//W/1");
        expect(cids).not.toContain("//A/1");
    });

    test("polymer.protein excludes HOH and HEM", async () => {
        const mol = makeMockMolecule(makeAtoms());
        const ast = parseSelection("polymer.protein");
        const cids = await evaluateSelectionForMolecule(ast, mol);
        expect(cids).toEqual(expect.arrayContaining(["//A/1", "//A/2", "//A/3"]));
        expect(cids).not.toContain("//W/1");
        expect(cids).not.toContain("//B/101");
    });

    test("hetatm picks HEM (non-standard, non-solvent)", async () => {
        // This implementation treats hetatm/het identically as
        // "non-protein, non-nucleic, non-solvent" — matches PyMOL's `het`
        // semantics. Use `solvent` for waters specifically.
        const mol = makeMockMolecule(makeAtoms());
        const ast = parseSelection("hetatm");
        const cids = await evaluateSelectionForMolecule(ast, mol);
        expect(cids).toContain("//B/101"); // HEM
        expect(cids).not.toContain("//W/1"); // HOH excluded
    });

    test("metals picks FE", async () => {
        const mol = makeMockMolecule(makeAtoms());
        const ast = parseSelection("metals");
        const cids = await evaluateSelectionForMolecule(ast, mol);
        expect(cids).toContain("//B/101"); // HEM has FE atom
    });

    test("backbone matches only protein backbone atoms", async () => {
        const mol = makeMockMolecule(makeAtoms());
        const ast = parseSelection("backbone");
        const cids = await evaluateSelectionForMolecule(ast, mol);
        // A/1 (ALA): N CA C O are backbone — residue should be hit
        expect(cids).toContain("//A/1");
        // W/1 (HOH): no backbone
        expect(cids).not.toContain("//W/1");
    });
});

describe("evaluateSelectionForMolecule: property comparisons", () => {
    test("b > 30 picks high-B atoms", async () => {
        const mol = makeMockMolecule(makeAtoms());
        const ast = parseSelection("b > 30");
        const cids = await evaluateSelectionForMolecule(ast, mol);
        // GLY/2 atoms all have b in 31-35 → residue 2 in list
        expect(cids).toContain("//A/2");
        // ALA/1 (b 20-25) NOT in list
        expect(cids).not.toContain("//A/1");
    });

    test("b < 20 picks low-B atoms (e.g. TRP/3 CA b=15)", async () => {
        const mol = makeMockMolecule(makeAtoms());
        const ast = parseSelection("b < 20");
        const cids = await evaluateSelectionForMolecule(ast, mol);
        expect(cids).toContain("//A/3");
    });
});

describe("evaluateSelectionForMolecule: distance ops", () => {
    test("within 2 of resn HEM picks HEM atoms (≤ 2 Å)", async () => {
        const mol = makeMockMolecule(makeAtoms());
        const ast = parseSelection("within 2 of resn HEM");
        const cids = await evaluateSelectionForMolecule(ast, mol);
        expect(cids).toContain("//B/101"); // HEM itself within 2 Å of HEM
        // Nothing else is within 2 Å (protein at x∈[0,6], HEM at x∈[9,11])
        expect(cids).not.toContain("//A/1");
    });

    test("near_to 5 of resn HEM excludes HEM itself", async () => {
        const mol = makeMockMolecule(makeAtoms());
        const ast = parseSelection("near_to 5 of resn HEM");
        const cids = await evaluateSelectionForMolecule(ast, mol);
        // Nothing else within 5 Å either, but result excludes the HEM
        expect(cids).not.toContain("//B/101");
    });

    test("around N is equivalent to near_to N of <sel>", async () => {
        const mol = makeMockMolecule(makeAtoms());
        const aroundAst = parseSelection("resn HEM around 5");
        const nearAst   = parseSelection("near_to 5 of resn HEM");
        const aroundCids = await evaluateSelectionForMolecule(aroundAst, mol);
        const nearCids   = await evaluateSelectionForMolecule(nearAst,   mol);
        expect(aroundCids.sort()).toEqual(nearCids.sort());
    });
});

describe("evaluateSelectionForMolecule: byres + topology", () => {
    test("byres expands an atom-pick to its whole residue", async () => {
        const mol = makeMockMolecule(makeAtoms());
        const ast = parseSelection("byres (chain A and name CA)");
        const cids = await evaluateSelectionForMolecule(ast, mol);
        // Should hit residues 1, 2, 3 entirely
        expect(cids.sort()).toEqual(["//A/1", "//A/2", "//A/3"]);
    });
});

describe("evaluateSelectionForMolecule: and/or/not with set-level children", () => {
    // Regression for the bug where matchPred returned false for `dist`,
    // silently killing AND/OR/NOT whose child was a set-level op like
    // `within ... of`. Without the fix, `byres organic within 6 of chain A`
    // returns 0 even when there's organic atoms 6 Å from chain A.

    test("organic-and-within: returns the organic atoms near chain A", async () => {
        // Add an organic ligand near chain A (within 6 Å of ALA/1).
        const atoms = makeAtoms();
        atoms.push({ x:3, y:3, z:0, chain_id:"L", res_no:200, res_name:"LIG",
                     name:"C1", alt_conf:"", element:"C", tempFactor:30, occupancy:1, serial:13 });
        const mol = makeMockMolecule(atoms);
        const ast = parseSelection("byres organic within 6 of chain A");
        const cids = await evaluateSelectionForMolecule(ast, mol);
        expect(cids).toContain("//L/200");
    });

    test("polymer-and-within: protein atoms near solvent", async () => {
        // Move HOH close to GLY/2 so polymer-within-3-of-solvent picks GLY/2.
        const atoms = makeAtoms();
        atoms[11].x = 4; atoms[11].y = 0; atoms[11].z = 0;  // HOH adjacent to GLY/2 N
        const mol = makeMockMolecule(atoms);
        const ast = parseSelection("byres polymer within 3 of solvent");
        const cids = await evaluateSelectionForMolecule(ast, mol);
        expect(cids).toContain("//A/2");
    });

    test("OR of chain-pred and set-level produces the union", async () => {
        const mol = makeMockMolecule(makeAtoms());
        // chain B (HEM residue) OR within-2-of-resn-HEM. Should at least include the HEM residue.
        const ast = parseSelection("chain B or (chain A within 2 of resn HEM)");
        const cids = await evaluateSelectionForMolecule(ast, mol);
        expect(cids).toContain("//B/101");
    });

    test("NOT of a set-level expression complements correctly", async () => {
        const mol = makeMockMolecule(makeAtoms());
        const ast = parseSelection("not (byres resn HEM)");
        const cids = await evaluateSelectionForMolecule(ast, mol);
        expect(cids).not.toContain("//B/101");
        // chain A residues should still be present
        expect(cids).toEqual(expect.arrayContaining(["//A/1", "//A/2", "//A/3"]));
    });

    test("pure-predicate AND/OR/NOT still works (fast path unchanged)", async () => {
        const mol = makeMockMolecule(makeAtoms());
        const ast = parseSelection("chain A and not resn GLY");
        const cids = await evaluateSelectionForMolecule(ast, mol);
        expect(cids).toEqual(expect.arrayContaining(["//A/1", "//A/3"]));
        expect(cids).not.toContain("//A/2");
    });
});

// Bundle builder unit tests — pure-JS, no WASM.
import { buildPmlBundle } from "../../src/utils/MoorhenPymolSaveBundle";

const decodeBase64 = (b64) => Buffer.from(b64, "base64").toString("utf-8");

const makeMockMolWithReps = (name, pdbText, reps) => ({
    name, molNo: 0,
    async getAtoms(_fmt) { return pdbText; },
    representations: reps,
});

describe("buildPmlBundle", () => {
    test("emits a valid scene script with absolute load + show/color lines", async () => {
        const reps = [
            { isCustom: true, style: "CRs", cid: "/*/*/*/*", colourRules: [
                { cid: "//A", color: "#ff0000" },
                { cid: "//B", color: "#00ff00" },
            ]},
            { isCustom: true, style: "CBs", cid: "//A/100-200", colourRules: [] },
        ];
        const mol = makeMockMolWithReps("7sj3", "REMARK fake\nEND\n", reps);
        const bundle = await buildPmlBundle({
            pmlBasename: "scene.pml",
            bundleDir: ".",
            molecules: [mol],
            maps: [],
            backgroundColor: [1, 1, 1, 1],  // white
        });
        // First file is the script; rest are siblings.
        expect(bundle.files[0].name).toBe("scene.pml");
        const script = decodeBase64(bundle.files[0].dataBase64);
        // Header
        expect(script).toMatch(/Generated by PyKeko/);
        // White background
        expect(script).toMatch(/^bg_color #ffffff/m);
        // Load with the chosen basename
        expect(script).toMatch(/^load \.\/7sj3\.pdb, 7sj3$/m);
        expect(script).toMatch(/^hide everything, 7sj3$/m);
        // Cartoon over the whole molecule (no `and (...)` since cid is wildcard)
        expect(script).toMatch(/^show cartoon, 7sj3$/m);
        // Sticks scoped to a residue range
        expect(script).toMatch(/^show sticks, 7sj3 and \(chain A and resi 100-200\)$/m);
        // Color rules from the cartoon rep
        expect(script).toMatch(/^color #ff0000, 7sj3 and \(chain A\)$/m);
        expect(script).toMatch(/^color #00ff00, 7sj3 and \(chain B\)$/m);
        // Closing orient
        expect(script).toMatch(/^orient$/m);
        // The PDB sibling file
        const pdbFile = bundle.files.find(f => f.name === "7sj3.pdb");
        expect(pdbFile).toBeDefined();
        expect(decodeBase64(pdbFile.dataBase64)).toBe("REMARK fake\nEND\n");
    });

    test("skips unknown representation styles with a note", async () => {
        const mol = makeMockMolWithReps("x", "X\n", [
            { isCustom: true, style: "WeirdNewStyle", cid: "/*/*/*/*", colourRules: [] },
        ]);
        const bundle = await buildPmlBundle({
            pmlBasename: "a.pml", bundleDir: ".", molecules: [mol], maps: [], backgroundColor: null,
        });
        const script = decodeBase64(bundle.files[0].dataBase64);
        // Note about the skipped rep should appear up top
        expect(script).toMatch(/WeirdNewStyle.*no clean PyMOL equivalent/);
        // No `show` line should leak for the unsupported style
        expect(script).not.toMatch(/show WeirdNewStyle/);
    });

    test("uniquifies overlapping molecule basenames", async () => {
        const m1 = makeMockMolWithReps("model", "A\n", []);
        const m2 = makeMockMolWithReps("model", "B\n", []);
        const bundle = await buildPmlBundle({
            pmlBasename: "out.pml", bundleDir: ".", molecules: [m1, m2], maps: [], backgroundColor: null,
        });
        const names = bundle.files.map(f => f.name).sort();
        // Two distinct PDB filenames; the second got disambiguated.
        expect(names).toContain("model.pdb");
        expect(names.some(n => n === "model_2.pdb")).toBe(true);
    });

    test("multi-cid CIDs become PyMOL `(...) or (...)`", async () => {
        const reps = [{
            isCustom: true, style: "CRs",
            cid: "//A/100||//B/200",
            colourRules: [],
        }];
        const mol = makeMockMolWithReps("m", "X\n", reps);
        const bundle = await buildPmlBundle({
            pmlBasename: "x.pml", bundleDir: ".", molecules: [mol], maps: [], backgroundColor: null,
        });
        const script = decodeBase64(bundle.files[0].dataBase64);
        expect(script).toMatch(/show cartoon, m and \(\(chain A and resi 100\) or \(chain B and resi 200\)\)/);
    });
});

describe("coalesceResidueCids: contiguous range collapse", () => {
    test("merges contiguous residues into ranges", () => {
        const input = ["//A/1", "//A/2", "//A/3", "//A/5"];
        expect(coalesceResidueCids(input)).toEqual(["//A/1-3", "//A/5"]);
    });

    test("keeps chains separate", () => {
        const input = ["//A/1", "//A/2", "//B/1", "//B/2"];
        expect(coalesceResidueCids(input).sort()).toEqual(["//A/1-2", "//B/1-2"]);
    });
});
