/**
 * PyMOL selection-expression parser.
 *
 * Lexer + recursive-descent parser → AST. The translator then compiles the
 * AST either to a CID-pure form (cheap; expressible as one or more Moorhen
 * CIDs joined by `||`) or to a runtime atom-filter (more expensive; needs
 * MoorhenPymolFilter).
 *
 * Grammar (see docs/pymol-translator-plan.md §5 for the full reference):
 *   expr     := orExpr
 *   orExpr   := andExpr (("or"|"|") andExpr)*
 *   andExpr  := notExpr (("and"|"&") notExpr)*
 *   notExpr  := ("not"|"!")? unary
 *   unary    := postfix
 *   postfix  := primary ("around" NUMBER)?
 *   primary  := "(" expr ")" | topo | dist | reducer | atom_pred | macro | ident
 *
 * Aliases (c., i., r., n., e., s., br., bc., bo., bs., bm., w., nto., be., g.,
 * nbr., xt., bb., sc., pol., h., sol., het.) are tokenized as single keywords.
 */

// ---------- AST ----------

export type SelNode =
    | { kind: "or" | "and"; l: SelNode; r: SelNode }
    | { kind: "not"; inner: SelNode }
    | { kind: "byres" | "bychain" | "byobject" | "bysegi" | "bymolecule" | "bymodel" | "bound_to" | "neighbor"; inner: SelNode }
    | { kind: "extend"; n: number; inner: SelNode }
    | { kind: "dist"; op: "within" | "near_to" | "beyond" | "gap" | "contact"; n: number; inner: SelNode }
    | { kind: "first" | "last"; inner: SelNode }
    | { kind: "pred_str"; prop: "chain" | "resn" | "name" | "elem" | "alt" | "segi"; values: string[] }
    | { kind: "pred_resi"; ranges: Array<{ lo: number; hi: number }> }
    | { kind: "pred_num"; prop: "index" | "id" | "rank"; values: number[] }
    | { kind: "pred_comp"; prop: "b" | "q" | "pc" | "formal_charge"; op: ">" | "<" | ">=" | "<=" | "=" | "<>"; value: number }
    | { kind: "macro"; name: string }
    | { kind: "object"; name: string }
    | { kind: "all" }
    | { kind: "none" };

// ---------- Lexer ----------

type Token = {
    type: "kw" | "ident" | "number" | "punct" | "string";
    value: string;
    pos: number;
};

// Token kinds that act as keywords (case-insensitive). Multi-letter aliases
// like `br.` are listed; the lexer recognizes them as single tokens.
const KEYWORDS = new Set([
    "or", "and", "not",
    "byres", "byresidue", "bychain", "byobject", "bysegi", "bymolecule", "bymodel",
    "bound_to", "neighbor",
    "extend",
    "within", "near_to", "beyond", "gap", "contact", "around",
    "first", "last",
    "of",
    // Atom-property keywords
    "chain", "resi", "resn", "name", "elem", "element", "alt", "segi",
    "index", "id", "rank",
    "b", "q", "pc", "formal_charge",
    "state",
    // Macros
    "all", "none", "hydro", "hydrogen", "hetatm", "het",
    "polymer", "solvent", "water", "metals", "ions", "lig",
    "organic", "inorganic", "backbone", "sidechain", "nonbonded",
    "stereo", "cis_peptide", "trans_peptide",
]);

// Multi-letter aliases mapped to their full keyword form
const ALIASES: Record<string, string> = {
    "c.": "chain", "i.": "resi", "r.": "resn", "n.": "name",
    "e.": "elem", "s.": "segi", "alt.": "alt",
    "br.": "byres", "bc.": "bychain", "bo.": "byobject", "bs.": "bysegi",
    "bm.": "bymolecule", "nbr.": "neighbor", "xt.": "extend",
    "w.": "within", "nto.": "near_to", "be.": "beyond", "g.": "gap",
    "bb.": "backbone", "sc.": "sidechain", "h.": "hydrogen", "sol.": "solvent",
    "pol.": "polymer", "het.": "hetatm",
};

const PUNCT = new Set(["(", ")", ",", "+", "-", ":", "&", "|", "!", "<", ">", "="]);

const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdentCont = (c: string) => /[A-Za-z0-9_.*?]/.test(c);
// PDB ids and selection names often start with a digit (e.g. 1crn, 3ec7).
// We accept digit-led identifiers when at least one alpha char follows.
const isDigitLedIdent = (src: string, i: number): number => {
    if (!/\d/.test(src[i])) return 0;
    let j = i;
    let sawAlpha = false;
    while (j < src.length && isIdentCont(src[j])) {
        if (/[A-Za-z_]/.test(src[j])) sawAlpha = true;
        j++;
    }
    return sawAlpha ? j - i : 0;
};

const tokenize = (src: string): Token[] => {
    const toks: Token[] = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === '"' || c === "'") {
            const quote = c;
            let j = i + 1;
            while (j < src.length && src[j] !== quote) j++;
            toks.push({ type: "string", value: src.slice(i + 1, j), pos: i });
            i = j + 1;
            continue;
        }
        if (c === "+" && i + 1 < src.length && /\d/.test(src[i + 1])) {
            // unary + (in numlist contexts) — fold into number
            i++;
            continue;
        }
        // Digit-led identifier (PDB ids like 1crn)? Check before number.
        const identLen = isDigitLedIdent(src, i);
        if (identLen > 0) {
            toks.push({ type: "ident", value: src.slice(i, i + identLen).toLowerCase(), pos: i });
            i += identLen;
            continue;
        }
        // Numbers — including signed negative when context suggests it.
        // Carefully: `1-10` is "1, -, 10" (range), NOT "1-10" as one malformed number.
        // We only eat `-` as the LEADING sign and never inside the digit run.
        const negPrefix = c === "-" && i + 1 < src.length && /\d/.test(src[i + 1]) &&
            (toks.length === 0 || toks[toks.length - 1].type === "punct" || toks[toks.length - 1].type === "kw");
        if (/\d/.test(c) || negPrefix) {
            let j = i + 1;
            while (j < src.length && /[0-9]/.test(src[j])) j++;
            // Optional fractional part
            if (j < src.length && src[j] === ".") {
                j++;
                while (j < src.length && /[0-9]/.test(src[j])) j++;
            }
            // Optional exponent
            if (j < src.length && (src[j] === "e" || src[j] === "E")) {
                j++;
                if (j < src.length && (src[j] === "+" || src[j] === "-")) j++;
                while (j < src.length && /[0-9]/.test(src[j])) j++;
            }
            const numStr = src.slice(i, j);
            if (!isNaN(Number(numStr))) {
                toks.push({ type: "number", value: numStr, pos: i });
                i = j;
                continue;
            }
        }
        if (PUNCT.has(c)) {
            // Two-char compound operators
            const two = src.slice(i, i + 2);
            if (two === "<=" || two === ">=" || two === "<>") {
                toks.push({ type: "punct", value: two, pos: i });
                i += 2;
                continue;
            }
            toks.push({ type: "punct", value: c, pos: i });
            i++;
            continue;
        }
        if (isIdentStart(c)) {
            let j = i + 1;
            while (j < src.length && isIdentCont(src[j])) j++;
            const original = src.slice(i, j);
            const lower = original.toLowerCase();
            let resolved = lower;
            if (ALIASES[lower]) resolved = ALIASES[lower];
            else if (lower.endsWith(".") && ALIASES[lower]) resolved = ALIASES[lower];
            const isKw = KEYWORDS.has(resolved) || resolved.startsWith("polymer.") || resolved === "polymer.protein" || resolved === "polymer.nucleic";
            // Keywords get their canonical lowercase form; idents keep original case
            // (PyMOL chain names are case-sensitive: "chain A" != "chain a").
            toks.push({ type: isKw ? "kw" : "ident", value: isKw ? resolved : original, pos: i });
            i = j;
            continue;
        }
        // Unrecognised char — skip
        i++;
    }
    return toks;
};

// ---------- Parser ----------

class Parser {
    toks: Token[];
    pos: number;
    constructor(toks: Token[]) { this.toks = toks; this.pos = 0; }
    peek(off = 0): Token | undefined { return this.toks[this.pos + off]; }
    eat(): Token | undefined { return this.toks[this.pos++]; }
    match(value: string): boolean {
        const t = this.peek();
        if (t && (t.value === value || t.value.toLowerCase() === value)) { this.pos++; return true; }
        return false;
    }
    matchKw(values: string[]): string | null {
        const t = this.peek();
        if (t && values.includes(t.value)) { this.pos++; return t.value; }
        return null;
    }
    expect(value: string): Token {
        const t = this.eat();
        if (!t || t.value !== value) throw new Error(`expected "${value}"${t ? ` at pos ${t.pos}` : ""}`);
        return t;
    }

    parseExpr(): SelNode { return this.parseOr(); }

    parseOr(): SelNode {
        let left = this.parseAnd();
        while (this.matchKw(["or"]) || this.match("|")) {
            const right = this.parseAnd();
            left = { kind: "or", l: left, r: right };
        }
        return left;
    }
    parseAnd(): SelNode {
        let left = this.parseNot();
        while (this.matchKw(["and"]) || this.match("&")) {
            const right = this.parseNot();
            left = { kind: "and", l: left, r: right };
        }
        return left;
    }
    parseNot(): SelNode {
        if (this.matchKw(["not"]) || this.match("!")) {
            return { kind: "not", inner: this.parseUnary() };
        }
        return this.parseUnary();
    }

    parseUnary(): SelNode {
        // Topology: byres / bychain / byobject / bysegi / bymolecule / bymodel / bound_to / neighbor
        const topo = this.matchKw(["byres", "byresidue", "bychain", "byobject", "bysegi", "bymolecule", "bymodel", "bound_to", "neighbor"]);
        if (topo) {
            const inner = this.parseUnary();
            const key = topo === "byresidue" ? "byres" : topo;
            return { kind: key as any, inner };
        }
        if (this.matchKw(["extend"])) {
            const numTok = this.eat();
            if (!numTok || numTok.type !== "number") throw new Error("extend: expected number");
            const inner = this.parseUnary();
            return { kind: "extend", n: parseInt(numTok.value, 10), inner };
        }
        // Distance: within / near_to / beyond / gap / contact <N> of <sel>
        const dist = this.matchKw(["within", "near_to", "beyond", "gap", "contact"]);
        if (dist) {
            const numTok = this.eat();
            if (!numTok || numTok.type !== "number") throw new Error(`${dist}: expected number`);
            this.matchKw(["of"]); // optional "of"
            const inner = this.parseUnary();
            return { kind: "dist", op: dist as any, n: parseFloat(numTok.value), inner };
        }
        // first / last
        const reducer = this.matchKw(["first", "last"]);
        if (reducer) {
            const inner = this.parseUnary();
            return { kind: reducer as any, inner };
        }
        // Primary
        let node = this.parsePrimary();
        // Postfix distance ops:
        //   X around N         ≡ near_to N of X
        //   X within N of Y    ≡ X AND (within N of Y)   (and same for near_to/beyond/gap/contact)
        // The around form takes no inner Y (Y defaults to all-atoms in PyMOL).
        while (true) {
            if (this.matchKw(["around"])) {
                const numTok = this.eat();
                if (numTok && numTok.type === "number") {
                    node = { kind: "dist", op: "near_to", n: parseFloat(numTok.value), inner: node };
                }
                continue;
            }
            const dist = this.matchKw(["within", "near_to", "beyond", "gap", "contact"]);
            if (dist) {
                const numTok = this.eat();
                if (!numTok || numTok.type !== "number") throw new Error(`${dist}: expected number`);
                this.matchKw(["of"]);
                const inner = this.parseUnary();
                const distNode: SelNode = { kind: "dist", op: dist as any, n: parseFloat(numTok.value), inner };
                node = { kind: "and", l: node, r: distNode };
                continue;
            }
            break;
        }
        return node;
    }

    parsePrimary(): SelNode {
        const t = this.peek();
        if (!t) throw new Error("unexpected end of selection");

        if (t.value === "(") {
            this.eat();
            const expr = this.parseExpr();
            this.expect(")");
            return expr;
        }
        if (t.type === "kw") {
            // Atom property predicates
            if (t.value === "chain" || t.value === "resn" || t.value === "name" ||
                t.value === "elem" || t.value === "element" || t.value === "alt" || t.value === "segi") {
                this.eat();
                const values = this.parseStrList();
                const prop = (t.value === "element" ? "elem" : t.value) as "chain"|"resn"|"name"|"elem"|"alt"|"segi";
                return { kind: "pred_str", prop, values };
            }
            if (t.value === "resi") {
                this.eat();
                return { kind: "pred_resi", ranges: this.parseRangeList() };
            }
            if (t.value === "index" || t.value === "id" || t.value === "rank") {
                this.eat();
                return { kind: "pred_num", prop: t.value as any, values: this.parseNumList() };
            }
            if (t.value === "b" || t.value === "q" || t.value === "pc" || t.value === "formal_charge") {
                this.eat();
                const opTok = this.eat();
                if (!opTok || opTok.type !== "punct") throw new Error(`${t.value}: expected comparison operator`);
                const op = opTok.value as any;
                const numTok = this.eat();
                if (!numTok || numTok.type !== "number") throw new Error(`${t.value}: expected number`);
                return { kind: "pred_comp", prop: t.value as any, op, value: parseFloat(numTok.value) };
            }
            if (t.value === "state") {
                this.eat();
                this.eat(); // consume the number; we don't support state selection
                return { kind: "none" };
            }
            // Macros
            if (t.value === "all") { this.eat(); return { kind: "all" }; }
            if (t.value === "none") { this.eat(); return { kind: "none" }; }
            if (["polymer", "polymer.protein", "polymer.nucleic", "solvent", "water",
                 "hydro", "hydrogen", "hetatm", "het", "metals", "ions", "lig",
                 "organic", "inorganic", "backbone", "sidechain", "nonbonded",
                 "stereo", "cis_peptide", "trans_peptide"].includes(t.value)) {
                this.eat();
                return { kind: "macro", name: t.value };
            }
            throw new Error(`unexpected keyword "${t.value}" at pos ${t.pos}`);
        }
        if (t.type === "ident" || t.type === "string") {
            // Bare identifier = object name (resolved against registry at compile time)
            this.eat();
            // PyMOL allows `*` as a wildcard for "all"
            if (t.value === "*") return { kind: "all" };
            return { kind: "object", name: t.value };
        }
        throw new Error(`unexpected token "${t.value}" at pos ${t.pos}`);
    }

    parseStrList(): string[] {
        const out: string[] = [];
        const first = this.eat();
        if (!first) throw new Error("expected identifier");
        out.push(first.value);
        while (this.match("+")) {
            const next = this.eat();
            if (next) out.push(next.value);
        }
        return out;
    }
    parseNumList(): number[] {
        const out: number[] = [];
        const first = this.eat();
        if (!first || first.type !== "number") throw new Error("expected number");
        out.push(parseFloat(first.value));
        while (this.match("+")) {
            const next = this.eat();
            if (next && next.type === "number") out.push(parseFloat(next.value));
        }
        return out;
    }
    parseRangeList(): Array<{ lo: number; hi: number }> {
        const out: Array<{ lo: number; hi: number }> = [];
        out.push(this.parseRange());
        while (this.match("+")) out.push(this.parseRange());
        return out;
    }
    parseRange(): { lo: number; hi: number } {
        const lo = this.eat();
        if (!lo || lo.type !== "number") throw new Error("expected residue number");
        const loN = parseFloat(lo.value);
        // PyMOL: 100-110 or 100:110
        if (this.peek()?.value === "-" || this.peek()?.value === ":") {
            this.eat();
            const hi = this.eat();
            if (!hi || hi.type !== "number") throw new Error("expected residue number");
            return { lo: loN, hi: parseFloat(hi.value) };
        }
        return { lo: loN, hi: loN };
    }
}

/**
 * Parse a PyMOL selection string into an AST. Throws on syntax error.
 */
export const parseSelection = (src: string): SelNode => {
    const toks = tokenize(src);
    if (toks.length === 0) return { kind: "all" };
    const p = new Parser(toks);
    return p.parseExpr();
};
