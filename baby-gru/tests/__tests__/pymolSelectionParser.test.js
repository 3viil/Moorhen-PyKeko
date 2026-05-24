// Tests for the PyMOL selection-expression parser (no WASM, no Redux).
// Asserts the parse tree shape for each grammar form.
import { parseSelection } from "../../src/utils/MoorhenPymolSelectionParser";

describe("parseSelection: atom-property predicates", () => {
    test("chain X", () => {
        expect(parseSelection("chain A")).toEqual({ kind: "pred_str", prop: "chain", values: ["A"] });
    });

    test("chain X+Y+Z (multi-arg with + separator)", () => {
        expect(parseSelection("chain A+B+C")).toEqual({
            kind: "pred_str", prop: "chain", values: ["A", "B", "C"]
        });
    });

    test("resi N", () => {
        expect(parseSelection("resi 100")).toEqual({
            kind: "pred_resi", ranges: [{ lo: 100, hi: 100 }]
        });
    });

    test("resi A-B (range)", () => {
        expect(parseSelection("resi 100-110")).toEqual({
            kind: "pred_resi", ranges: [{ lo: 100, hi: 110 }]
        });
    });

    test("resi A+B+C (list)", () => {
        expect(parseSelection("resi 5+10+15+20")).toEqual({
            kind: "pred_resi", ranges: [
                { lo: 5, hi: 5 }, { lo: 10, hi: 10 }, { lo: 15, hi: 15 }, { lo: 20, hi: 20 },
            ]
        });
    });

    test("resi A-B+C-D (mixed list)", () => {
        const ast = parseSelection("resi 1-10+20-30");
        expect(ast).toEqual({
            kind: "pred_resi",
            ranges: [{ lo: 1, hi: 10 }, { lo: 20, hi: 30 }],
        });
    });

    test("name X+Y (atom-name list)", () => {
        expect(parseSelection("name CA+CB")).toEqual({
            kind: "pred_str", prop: "name", values: ["CA", "CB"]
        });
    });

    test("resn TRP", () => {
        expect(parseSelection("resn TRP")).toEqual({
            kind: "pred_str", prop: "resn", values: ["TRP"]
        });
    });

    test("chain X is case-preserving", () => {
        expect(parseSelection("chain A").values[0]).toBe("A");
        expect(parseSelection("chain a").values[0]).toBe("a");
        // Keyword still resolves lowercase
        const node = parseSelection("CHAIN A");
        expect(node).toEqual({ kind: "pred_str", prop: "chain", values: ["A"] });
    });

    test("aliases: c. / i. / r. / n.", () => {
        expect(parseSelection("c. A")).toMatchObject({ prop: "chain", values: ["A"] });
        expect(parseSelection("i. 100")).toMatchObject({ kind: "pred_resi" });
        expect(parseSelection("r. TRP")).toMatchObject({ prop: "resn", values: ["TRP"] });
        expect(parseSelection("n. CA")).toMatchObject({ prop: "name", values: ["CA"] });
    });
});

describe("parseSelection: logical operators", () => {
    test("and", () => {
        expect(parseSelection("chain A and resi 5")).toEqual({
            kind: "and",
            l: { kind: "pred_str", prop: "chain", values: ["A"] },
            r: { kind: "pred_resi", ranges: [{ lo: 5, hi: 5 }] },
        });
    });

    test("or", () => {
        expect(parseSelection("chain A or chain B")).toEqual({
            kind: "or",
            l: { kind: "pred_str", prop: "chain", values: ["A"] },
            r: { kind: "pred_str", prop: "chain", values: ["B"] },
        });
    });

    test("not", () => {
        expect(parseSelection("not chain A")).toEqual({
            kind: "not",
            inner: { kind: "pred_str", prop: "chain", values: ["A"] },
        });
    });

    test("parentheses group precedence", () => {
        const ast = parseSelection("(chain A or chain B) and resi 100");
        expect(ast.kind).toBe("and");
        expect(ast.l.kind).toBe("or");
        expect(ast.r.kind).toBe("pred_resi");
    });

    test("and binds tighter than or", () => {
        const ast = parseSelection("chain A or chain B and resi 5");
        // Should parse as: chain A or (chain B and resi 5)
        expect(ast.kind).toBe("or");
        expect(ast.l.kind).toBe("pred_str"); // chain A
        expect(ast.r.kind).toBe("and");      // chain B AND resi 5
    });

    test("symbolic operators: & | !", () => {
        expect(parseSelection("chain A & chain B").kind).toBe("and");
        expect(parseSelection("chain A | chain B").kind).toBe("or");
        expect(parseSelection("! chain A").kind).toBe("not");
    });
});

describe("parseSelection: macros", () => {
    test("all and none", () => {
        expect(parseSelection("all")).toEqual({ kind: "all" });
        expect(parseSelection("none")).toEqual({ kind: "none" });
    });

    test("polymer / polymer.protein / polymer.nucleic", () => {
        expect(parseSelection("polymer")).toEqual({ kind: "macro", name: "polymer" });
        expect(parseSelection("polymer.protein")).toEqual({ kind: "macro", name: "polymer.protein" });
        expect(parseSelection("polymer.nucleic")).toEqual({ kind: "macro", name: "polymer.nucleic" });
    });

    test("solvent / hetatm / backbone / sidechain / etc.", () => {
        for (const name of ["solvent", "water", "hetatm", "het", "metals", "ions", "lig",
                           "organic", "inorganic", "backbone", "sidechain", "hydro", "hydrogen"]) {
            const ast = parseSelection(name);
            expect(ast.kind).toBe("macro");
        }
    });
});

describe("parseSelection: topology operators", () => {
    test("byres", () => {
        const ast = parseSelection("byres chain A");
        expect(ast).toEqual({
            kind: "byres",
            inner: { kind: "pred_str", prop: "chain", values: ["A"] },
        });
    });

    test("bychain", () => {
        expect(parseSelection("bychain resi 100").kind).toBe("bychain");
    });

    test("extend N P", () => {
        const ast = parseSelection("extend 2 chain A");
        expect(ast).toMatchObject({ kind: "extend", n: 2 });
    });
});

describe("parseSelection: distance operators", () => {
    test("within N of <sel>", () => {
        const ast = parseSelection("within 4 of chain A");
        expect(ast).toMatchObject({ kind: "dist", op: "within", n: 4 });
        expect(ast.inner.kind).toBe("pred_str");
    });

    test("near_to N of <sel>", () => {
        expect(parseSelection("near_to 5 of resi 100").kind).toBe("dist");
    });

    test("postfix-binary: X within N of Y", () => {
        // Should parse as: X AND (within N of Y)
        const ast = parseSelection("chain A within 4 of resn HEM");
        expect(ast.kind).toBe("and");
        expect(ast.l.kind).toBe("pred_str");
        expect(ast.r.kind).toBe("dist");
        expect(ast.r.op).toBe("within");
        expect(ast.r.n).toBe(4);
    });

    test("X around N (postfix shorthand)", () => {
        const ast = parseSelection("chain A around 5");
        // around <N> is equivalent to (chain A) AND (near_to N of (all)?) no —
        // actually the parser emits a dist node with the same inner.
        expect(ast.kind).toBe("dist");
        expect(ast.op).toBe("near_to");
        expect(ast.n).toBe(5);
    });
});

describe("parseSelection: object names + edge cases", () => {
    test("bare ident parses as object name", () => {
        expect(parseSelection("my_selection")).toEqual({ kind: "object", name: "my_selection" });
    });

    test("digit-led identifiers (PDB ids)", () => {
        // 1crn is a PDB id, not a number — parser must accept it as an object name
        expect(parseSelection("1crn")).toEqual({ kind: "object", name: "1crn" });
        expect(parseSelection("4hhb")).toEqual({ kind: "object", name: "4hhb" });
    });

    test("* parses as all", () => {
        expect(parseSelection("*")).toEqual({ kind: "all" });
    });

    test("empty string parses as all", () => {
        expect(parseSelection("")).toEqual({ kind: "all" });
    });

    test("negative residue numbers", () => {
        // PyMOL allows negative resids (e.g. for symmetry-mate copies)
        expect(parseSelection("resi -5")).toEqual({
            kind: "pred_resi", ranges: [{ lo: -5, hi: -5 }],
        });
    });
});

describe("parseSelection: complex combinations", () => {
    test("polymer.protein and chain A and not resi 100", () => {
        const ast = parseSelection("polymer.protein and chain A and not resi 100");
        // Left-associative and: ((polymer.protein and chain A) and not resi 100)
        expect(ast.kind).toBe("and");
        expect(ast.r.kind).toBe("not");
    });

    test("byres (chain A within 4 of resn HEM)", () => {
        const ast = parseSelection("byres (chain A within 4 of resn HEM)");
        expect(ast.kind).toBe("byres");
        expect(ast.inner.kind).toBe("and"); // chain A AND (within ... of ...)
    });

    test("sidechain and resn TRP+TYR+PHE", () => {
        const ast = parseSelection("sidechain and resn TRP+TYR+PHE");
        expect(ast.kind).toBe("and");
        expect(ast.l).toEqual({ kind: "macro", name: "sidechain" });
        expect(ast.r).toEqual({ kind: "pred_str", prop: "resn", values: ["TRP", "TYR", "PHE"] });
    });
});

describe("parseSelection: property comparisons", () => {
    test("b > 30", () => {
        const ast = parseSelection("b > 30");
        expect(ast).toEqual({ kind: "pred_comp", prop: "b", op: ">", value: 30 });
    });

    test("q < 0.5", () => {
        const ast = parseSelection("q < 0.5");
        expect(ast).toMatchObject({ kind: "pred_comp", prop: "q", op: "<", value: 0.5 });
    });
});
