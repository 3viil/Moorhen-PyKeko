// Tests for the PyMOL line/arg parser (no WASM, no Redux).
// Just feeds source strings and asserts the Command[] shape.
import { parsePymolScript } from "../../src/utils/MoorhenPymolParser";

describe("parsePymolScript: line + arg splitting", () => {
    test("empty source produces no commands", () => {
        expect(parsePymolScript("")).toEqual([]);
        expect(parsePymolScript("   \n  \t  ")).toEqual([]);
    });

    test("single command, no args", () => {
        const cmds = parsePymolScript("zoom");
        expect(cmds).toHaveLength(1);
        expect(cmds[0]).toMatchObject({ cmd: "zoom", args: [], lineNo: 1 });
    });

    test("single command with one arg", () => {
        const cmds = parsePymolScript("fetch 1crn");
        expect(cmds).toHaveLength(1);
        expect(cmds[0]).toMatchObject({ cmd: "fetch", args: ["1crn"], lineNo: 1 });
    });

    test("comma-separated args", () => {
        const cmds = parsePymolScript("color red, chain A");
        expect(cmds).toHaveLength(1);
        expect(cmds[0]).toMatchObject({ cmd: "color", args: ["red", "chain A"], lineNo: 1 });
    });

    test("multi-line script preserves line numbers", () => {
        const cmds = parsePymolScript("fetch 1crn\nhide everything\nshow cartoon");
        expect(cmds.map(c => ({ cmd: c.cmd, lineNo: c.lineNo }))).toEqual([
            { cmd: "fetch", lineNo: 1 },
            { cmd: "hide", lineNo: 2 },
            { cmd: "show", lineNo: 3 },
        ]);
    });

    test("blank lines and comments are skipped", () => {
        const cmds = parsePymolScript(`
# load
fetch 1crn

# colour
color red, chain A   # only chain A
        `);
        expect(cmds.map(c => c.cmd)).toEqual(["fetch", "color"]);
        // Comment after the args should NOT be in cmd.args
        expect(cmds[1].args).toEqual(["red", "chain A"]);
    });

    test("# inside double quotes is preserved", () => {
        const cmds = parsePymolScript('label "atom #1"');
        expect(cmds[0].args).toEqual(['"atom #1"']);
    });

    test("backslash continuation joins lines", () => {
        const cmds = parsePymolScript("set_view (\\\n  0.5, 0.5, 0.5,\\\n  0.0, 0.0, 0.0 )");
        expect(cmds).toHaveLength(1);
        expect(cmds[0].cmd).toBe("set_view");
        // Args should be the comma-split floats (commas inside () are preserved!)
        expect(cmds[0].args).toHaveLength(1);
        expect(cmds[0].args[0]).toContain("0.5");
    });

    test("commas inside parens are NOT split", () => {
        const cmds = parsePymolScript("foo (a, b, c), bar");
        expect(cmds[0].args).toEqual(["(a, b, c)", "bar"]);
    });

    test("command names lowercase, args case-preserved", () => {
        const cmds = parsePymolScript("ColoR Red, chain A");
        expect(cmds[0].cmd).toBe("color");
        expect(cmds[0].args).toEqual(["Red", "chain A"]);
    });

    test("CRLF line endings handled", () => {
        const cmds = parsePymolScript("fetch 1crn\r\nshow cartoon\r\n");
        expect(cmds.map(c => c.cmd)).toEqual(["fetch", "show"]);
    });
});
