# Plan: PyMOL command translator in Interactive Scripting

A subset of PyMOL command syntax interpreted line-by-line and dispatched to
existing Moorhen APIs. Goal: paste-and-run for typical PyMOL setup /
visualization scripts (~80% of real-world use); explicitly out of scope for
`iterate` / `alter` / arbitrary Python expressions.

This plan was approved with these defaults baked in:

- Bond graph: **distance-based approximation** (covalent if d ≤ r1 + r2 + 0.4 Å).
  No libcoot bond-list binding for now.
- **No** `state` selector support.
- `pseudoatom` warns and is treated as a no-op.
- `set surface_quality` (and related surface-only flags) deferred to a later pass.
- `set_view` (18-float view matrix) is **supported** — it's what scene-recall
  scripts actually use.

---

## 1. UI changes

**File**: `baby-gru/src/components/modal/MoorhenScriptModal.tsx`

- Add a `<MoorhenSelect>` next to the editor with options `JavaScript` (default)
  and `PyMOL`.
- Persist last selection in `localStorage` (`moorhen.scripting.mode`) so
  paste-and-rerun feels natural.
- When `PyMOL` is selected:
  - Replace JS-specific helper hints in the modal header.
  - Add a `Show supported commands` button → opens a small popover with the
    command matrix from §4.
  - Change the Run button label to `Run PyMOL`.

For the file-input path (`LoadScript.tsx`), accept `.pml` in addition to `.js`
and infer mode from extension (`.pml` → PyMOL, `.js` → JavaScript).

---

## 2. Architecture

Three new files plus a small interface contract:

```
baby-gru/src/utils/
  MoorhenPymolTranslator.ts        — entry point: exe(src, env)
  MoorhenPymolParser.ts             — line tokenizer + command-arg splitter
  MoorhenPymolSelectionParser.ts    — selection-expression parser (chain X and resi N-M …)
  MoorhenPymolFilter.ts             — runtime atom filter + kd-tree
  __tests__/
    MoorhenPymolTranslator.test.ts  — golden script translations
    MoorhenPymolSelectionParser.test.ts — selection grammar test corpus
```

### 2.1 Flow

```
src (string)
  │
  ▼
MoorhenPymolParser.parse(src)
  │   → Command[]   { cmd: "show", args: ["cartoon", "chain A"], rawLine, lineNo }
  │
  ▼
For each Command:
  MoorhenPymolTranslator.dispatch(cmd, env, registry)
  │   │
  │   └─ resolves selection arg via MoorhenPymolSelectionParser when needed
  │       → CompiledSelection (CID-pure or runtime-filter)
  │       → if filter: MoorhenPymolFilter.evaluate(sel, mol) → CID[]
  │
  ├── normalize PyMOL color names → RGB tuples
  ├── map representation keywords → Moorhen styles ("cartoon" → "CRs")
  ├── look up named selections in the registry
  ▼
Awaited Moorhen API calls:
  - molecule.addRepresentation(...)
  - molecule.centreOn(...)
  - molecule.addColourRule(...)
  - dispatch(setBackgroundColor(...))
  - new MoorhenMolecule(...).loadToCootFromFetch(...)
  - etc.
```

Each command handler returns a `Promise<void>`. The translator awaits
sequentially (matching PyMOL's command-order semantics).

### 2.2 The `env` contract

The translator takes the *same* `env` object that `MoorhenScriptApi.exe()`
already builds (line 100-183 of `MoorhenScriptAPI.ts`) — so it gets
`molecules`, `maps`, `commandCentre`, `dispatch`, Redux action creators, and the
`MoorhenMolecule` / `MoorhenMap` constructors out of the box. Refactor
`MoorhenScriptApi` to expose `buildEnv()` that both modes use.

### 2.3 Selection registry

A `Map<string, SelectionResolver>` scoped to a single `exe()` call:

```typescript
type SelectionResolver =
  | { kind: "cid", cids: string[], molNo?: number }
  | { kind: "object", molNo: number }   // PyMOL object name → molecule
  | { kind: "compiled", sel: CompiledSelection, molNo?: number };
```

When a script does `select prot, chain A and resi 100-200`, the registry stores
`prot` keyed to the compiled selection. Subsequent `color red, prot` resolves
`prot` via the registry. `fetch`/`load` also register the molecule's
auto-generated PyMOL object name.

---

## 3. Command parsing

PyMOL syntax is line-based:

```
cmd_name arg1, arg2, arg3
```

with `,` separators between args. Comments start with `#`. Multi-line
continuation via `\` at end of line.

**`MoorhenPymolParser.parse(src)`**:

1. Split on `\n`.
2. Strip `#…` comments (respecting quoted strings).
3. Join `\`-continued lines.
4. For each non-empty line:
   - First whitespace-separated token = command name (lowercased).
   - Rest of line = arg-string.
   - Split arg-string on `,` but respect quoted strings and parentheses.
   - Trim each arg.

Returns `Command[]`. Line/column tracked for error reporting.

---

## 4. Supported commands matrix

Tiered by priority for incremental rollout.

### Tier 1 — loading + view

| PyMOL | Mapped to | Notes |
|-------|-----------|-------|
| `fetch <id>` | `MoorhenMolecule.loadToCootFromFetch(id)` + `dispatch(addMolecule(...))` | Auto-registers `<id>` as object name |
| `load <file>` | Browser: triggers file-picker fallback; Electron: reads via wrapper IPC bridge | Falls back with warning if path not accessible |
| `delete <name>` | `molecule.delete()` + remove from registry | `delete all` clears everything |
| `disable <name>` | `dispatch(hideMolecule(molNo))` | |
| `enable <name>` | `dispatch(showMolecule(molNo))` | |
| `zoom [sel]` | `molecule.centreOn(cid, true, true)` | No sel → centre all |
| `orient [sel]` | `molecule.centreOn(cid, true, true)` | Same as zoom for now (true orient requires a rotation calc) |
| `center [sel]` | `dispatch(setOrigin([-x, -y, -z]))` | Compute centroid of selection |
| `set_view (...)` | parse 18-float PyMOL matrix → `setQuat` + `setOrigin` + `setZoom` | scene-recall scripts |

### Tier 2 — representation + colour

| PyMOL | Mapped to | Notes |
|-------|-----------|-------|
| `show <rep>[, sel]` | new `MoleculeRepresentation(style, cid)` + `addRepresentation` | rep ↦ style: cartoon→CRs, sticks→CBs, lines→CBs (width=0.05), spheres→VdwSpheres, surface→MolecularSurface, mesh→MolecularSurface |
| `hide <rep>[, sel]` | Remove matching representations | `hide everything` clears all reps for sel |
| `as <rep>[, sel]` | hide everything + show rep | PyMOL's `as` semantics |
| `color <colour>, sel` | `molecule.addColourRule(ruleType, cid, color)` | Colour name lookup table → hex; supports red, blue, green, yellow, cyan, magenta, orange, purple, gray, white, black, salmon, slate, etc. (~40 entries) |
| `spectrum <expr>[, palette[, sel]]` | `molecule.addColourRule("rainbow"/"b-factor"/...)` | `count` → rainbow, `b` → B-factor |
| `bg_color <colour>` | `dispatch(setBackgroundColor([r,g,b,a]))` | |
| `set transparency, <v>[, sel]` | Per-rep opacity via existing `setNonCustomOpacity` | |

### Tier 3 — selection

| PyMOL | Mapped to | Notes |
|-------|-----------|-------|
| `select <name>, <expr>` | Compile expr → CompiledSelection, store in registry | See §5 |
| `deselect` | Clear `_sele` (PyMOL's default selection name) | |

### Tier 4 — measurements + screenshots

| PyMOL | Mapped to | Notes |
|-------|-----------|-------|
| `distance [name,] sel1, sel2` | Existing distance measurement tool dispatch | Persistent labeled line |
| `png <file>` | `webContents.capturePage()` via wrapper, save to download | Width/height optional |
| `ray <w>, <h>` | Same as `png` (Moorhen has no raytracer; rasterize via WebGL) | Warn that ray-tracing is mapped to high-quality rasterization |

### Tier 5 — misc set commands

| PyMOL | Mapped to | Notes |
|-------|-----------|-------|
| `set ray_shadow, 0/1` | `dispatch(setDoShadow(...))` | |
| `set ambient, <v>` | `dispatch(setAmbient([v,v,v,1]))` | |
| `set fog_start, <v>` | `dispatch(setFogStart(v))` | |
| `set ray_trace_mode, n` | Map to edge-detect on/off | Best-effort |
| `set spec_reflect, <v>` | `dispatch(setSpecular(...))` | |
| `rock` / `set rocking, 1` | `dispatch(setDoSpin(true))` | Closest equivalent |
| `viewport <w>, <h>` | No-op + warning | Browser-owned |
| `set surface_quality, n` | **Deferred** — toast: "set surface_quality not yet supported" | |

### Explicitly NOT supported (toast: "Unsupported PyMOL command")

`iterate`, `alter`, `cmd.do`, `python` / `endpython` blocks, `extend`,
`cmd.load_cgo`, `cealign`, `align`, `super`, ray-trace settings beyond on/off,
movie commands (`mset`, `mplay`, `frame`), scene `store` / `recall` (Moorhen
has a different scene model).

`pseudoatom <args>` warns and is treated as a no-op.

---

## 5. Selection algebra (complete)

PyMOL's selection language is a small expression DSL. Full coverage requires
distinguishing what CIDs can express natively (cheap) from what needs runtime
atom enumeration + JS filtering (more code, slower but unavoidable).

### 5.1 Lexicon

#### Logical operators (in precedence order, lowest to highest)

| Operator | Aliases | Notes |
|----------|---------|-------|
| `or` | `\|` | Set union |
| `and` | `&` | Set intersection |
| `not` | `!` | Set complement |
| `( )` |  | Grouping |

Operators are case-insensitive, surrounding whitespace required (no `chainA`).

#### Atom property predicates

| Predicate | Aliases | Argument syntax | Compile path |
|-----------|---------|-----------------|--------------|
| `chain <X>` | `c.` | identifier or quoted | CID slot |
| `resi <N>` | `i.` | `N`, `A-B`, `A+B+C`, `-N` (neg) | CID slot |
| `resn <X>` | `r.` | identifier | mmdb LITERAL in atom slot |
| `name <X>` | `n.` | identifier, multiple via `+` | CID slot, mmdb list |
| `elem <X>` | `e.` | element symbol | mmdb filter |
| `alt <X>` | | alt-loc code | CID alt-loc field |
| `segi <X>` | `s.` | segment ID | CID model slot (best fit) |
| `index <N>` | | mmdb atom index | post-filter |
| `ID <N>` | | atom serial (1-based) | post-filter |
| `rank <N>` | | atom rank | post-filter |
| `b <op> <N>` | | B-factor with `=`, `<`, `>`, `<=`, `>=`, `<>` | post-filter |
| `q <op> <N>` | | Occupancy | post-filter |
| `pc <op> <N>` | | Partial charge | post-filter (mostly N/A in Moorhen) |
| `formal_charge <op> <N>` | | Formal charge | post-filter |

#### Macro selectors (predefined sets)

| Macro | Aliases | Defined as |
|-------|---------|------------|
| `all` | `*` | every atom |
| `none` | | empty |
| `hydro` | `h.`, `hydrogen` | `elem H` ∪ `elem D` |
| `hetatm` | `het` | HETATM records (in mmdb terms: non-standard residues) |
| `polymer` | | proteins + nucleic acids |
| `polymer.protein` | `pol.protein` | the 20 standard AAs (+ MSE, SEC, PYL, etc.) |
| `polymer.nucleic` | `pol.nucleic` | DA, DC, DG, DT, A, C, G, U, T, plus modified |
| `solvent` | `water`, `sol.` | resn HOH, WAT, H2O, D2O, T3P, SOL, TIP, TIP3, TIP4 |
| `hydrogens` | | `elem H` |
| `metals` | | element in {LI, NA, K, RB, CS, MG, CA, SR, BA, MN, FE, CO, NI, CU, ZN, AG, AU, AL, HG, CD, PB, …} |
| `ions` | | metals + halides + ammonium etc. |
| `backbone` | `bb.` | name in (N, CA, C, O, OXT) for protein; (P, O3', O5', C3', C4', C5') for nucleic |
| `sidechain` | `sc.` | protein non-backbone, non-H |
| `lig` | | hetatm minus solvent minus ions minus standard residues |
| `organic` | | hetatm with C/N/O/S/P/H atoms only (vs inorganic ions) |
| `inorganic` | | hetatm without C |
| `nonbonded` | | atoms with 0 bonds (needs bond graph; rare in practice) |

Each macro compiles to an underlying expression at parse time, so
`polymer.protein and chain A` works by AND-ing the protein-residue set with
`chain A`.

#### Topology operators (graph walks)

| Operator | Aliases | Meaning | Compile path |
|----------|---------|---------|--------------|
| `byres <sel>` | `br.`, `byresidue` | expand sel to every atom in any residue containing a sel atom | CID with `*` in atom slot if sel is CID-pure; otherwise post-filter |
| `bychain <sel>` | `bc.` | expand to every atom in any chain hit by sel | CID with `*` in resi+atom slots |
| `bysegi <sel>` | `bs.` | expand to whole segments | CID seg slot |
| `byobject <sel>` | `bo.` | expand to whole object (molecule) | reset CID to all-atoms for matched molNos |
| `bymolecule <sel>` | `bm.` | expand to connected component | requires bond graph; **post-filter** |
| `bymodel <sel>` | | expand to whole model | same as `byobject` in Moorhen |
| `bound_to <sel>` | | atoms bonded to sel | post-filter via approximate bond graph |
| `extend <N> <sel>` | `xt.` | N-bond expansion outward | iterative post-filter |
| `neighbor <sel>` | `nbr.` | bonded neighbors of sel (= `bound_to`) | post-filter |

#### Distance operators

| Operator | Aliases | Meaning | Compile path |
|----------|---------|---------|--------------|
| `within <N> of <sel>` | `w.` | atoms ≤ N Å from any sel atom (sel included) | post-filter with kd-tree, OR libcoot `get_neighbours_cid` when sel is a single residue |
| `near_to <N> of <sel>` | `nto.` | within excluding sel itself | post-filter |
| `beyond <N> of <sel>` | `be.` | atoms > N Å from sel | post-filter |
| `gap <N> of <sel>` | `g.` | atoms ≥ N Å vdw-gap from sel | post-filter with vdw radii |
| `contact <N> of <sel>` | | atoms touching sel within N × vdw | post-filter |
| `<sel> around <N>` | | PyMOL postfix variant: equivalent to `near_to N of <sel>` | rewrites to `near_to` form |

#### Set-reducing operators

| Operator | Meaning | Compile path |
|----------|---------|--------------|
| `first <sel>` | first atom in sel | post-filter |
| `last <sel>` | last atom in sel | post-filter |

#### Other

| Predicate | Meaning | Compile path |
|-----------|---------|--------------|
| `state <N>` | atoms in state N | **Not supported** in this plan (toast). |
| `stereo` | atoms with stereo info | post-filter (rare) |
| `cis_peptide` | residues with cis peptide | post-filter via `get_cis_peptides` (Moorhen has it) |
| `trans_peptide` | trans peptide bonds | post-filter |

### 5.2 Compilation: two-tier strategy

Every AST gets classified **CID-pure** or **needs-filter**:

```ts
class CompiledSelection {
  cidPure: boolean;           // can express as CID(s) without runtime enumeration
  cids:    string[];          // if cidPure: pipe-joinable CID list
  filter:  (atom) => boolean; // if !cidPure: runtime predicate
  scope:   string[];          // CID(s) to fetch atoms from before filtering
}
```

Classification rules per AST node:

| Node | `cidPure`? | Notes |
|------|-----------|-------|
| Predicate on chain/resi/name | yes | maps to CID slot |
| Predicate on b/q/index/etc. | no | runtime |
| Macro selectors except `polymer.*`/`backbone`/`sidechain` | mostly yes | precompiled CIDs |
| `polymer.protein` | yes | use 20-AA literal list in resi-name filter |
| `byres P` | yes if P pure | else `byres` is a post-filter pass |
| `bychain P` | yes if P pure | |
| `byobject P` | yes | |
| `bymolecule P` / `bound_to P` / `extend N P` / `neighbor P` | no | bond-graph traversal |
| `within N of P` / `near_to` / `beyond` / `gap` / `contact` | no | kd-tree distance |
| `A and B` | both pure → intersect CID slots; mixed → keep B's filter, narrow scope to A's CIDs | |
| `A or B` | both pure → concatenate CIDs; mixed → union filter over A.cids ∪ B.cids | |
| `not A` | only if A is pure and trivially invertible (one slot, one value) | else post-filter |

### 5.3 Runtime atom-filter engine

`MoorhenPymolFilter.evaluate(selection, molecule): Promise<string[]>` returns
the list of explicit CIDs (atoms or residues) matching the selection.

```ts
async function evaluate(sel, mol) {
  // 1. Get the candidate atom set
  const scopeCid = sel.scope.length ? sel.scope.join("||") : "/*/*/*/*";
  const atoms = await mol.gemmiAtomsForCid(scopeCid);

  // 2. Apply runtime filter (if not CID-pure)
  const matched = sel.cidPure ? atoms : atoms.filter(sel.filter);

  // 3. Build the result CID list
  // For colouring: per-atom CIDs are too granular → coalesce to residues
  // For "select" registry: keep atom-level if name was specified, else residue-level
  return coalesce(matched, sel.granularity);
}
```

The filter API operates on Moorhen atom records
`{ x, y, z, chain_id, res_no, res_name, name, alt_conf, tempFactor, occupancy, element, serial, ... }`
already returned by `gemmiAtomsForCid`.

#### kd-tree for distance operators

`within N of <inner>` requires:
1. Evaluate `<inner>` to its matched atoms (Cartesian positions).
2. Build a kd-tree (or uniform grid for short cutoffs) over the molecule's
   atom positions ONCE per `exe()` call (cached on the registry).
3. For each candidate atom, query "any inner-set atom within N Å?".

Implementation: small kd-tree in TS, ~80 lines. Alternative: uniform 3D grid
with cell size = cutoff distance (faster for short cutoffs ~5 Å).

#### Bond-graph traversal (approximate)

`bound_to`, `extend N`, `bymolecule`, `neighbor` rely on bond connectivity.
Moorhen doesn't expose the bond list directly. **Per the agreed defaults**:

Build an approximate covalent-bond graph at filter time:
- For each atom pair within `r1 + r2 + 0.4 Å` (sum of vdw radii + 0.4 Å
  tolerance), treat as bonded.
- Use the kd-tree (cutoff 3 Å) to find candidate neighbors fast.
- Document the approximation in the user-facing docs:
  - ≥95% accuracy on standard residues
  - May misjudge unusual covalent geometries in non-standard ligands

If a future need arises, we can add a libcoot binding for the real bond list.

### 5.4 Operator precedence and parsing

Recursive-descent grammar:

```
expr     := orExpr
orExpr   := andExpr ( ("or" | "|") andExpr )*
andExpr  := notExpr ( ("and" | "&") notExpr )*
notExpr  := ("not" | "!")? unary
unary    := topo
          | dist
          | reducer
          | primary
topo     := ("byres" | "br." | "bychain" | "bc." | "byobject" | "bo."
            | "bysegi" | "bs." | "bymolecule" | "bm." | "bymodel"
            | "bound_to" | "neighbor" | "nbr.") unary
          | ("extend" | "xt.") NUMBER unary
dist     := ("within" | "w." | "near_to" | "nto." | "beyond" | "be."
            | "gap" | "g." | "contact") NUMBER "of" unary
reducer  := ("first" | "last") unary
primary  := "(" expr ")"
          | atom_pred
          | macro
          | object_name
          | unary "around" NUMBER     // postfix rewrite: X around N → near_to N of X
atom_pred:= ("chain" | "c.") strList
          | ("resi" | "i.") rangeList
          | ("resn" | "r.") strList
          | ("name" | "n.") strList
          | ("elem" | "e.") strList
          | ("alt") strList
          | ("segi" | "s.") strList
          | ("index" | "ID" | "rank") numList
          | ("b" | "q" | "pc" | "formal_charge") compOp NUMBER
          | ("stereo" | "cis_peptide" | "trans_peptide")
macro    := "all" | "none" | "hydro" | "hydrogen" | "h."
          | "hetatm" | "het"
          | "polymer" ("." ("protein" | "nucleic"))?
          | "solvent" | "water" | "sol."
          | "metals" | "ions" | "lig" | "organic" | "inorganic"
          | "backbone" | "bb." | "sidechain" | "sc."
          | "nonbonded"
strList  := str ("+" str)*           // PyMOL: resi 100+105+110, name CA+CB+CG, etc.
numList  := NUMBER ("+" NUMBER)*
rangeList:= range ("+" range)*
range    := NUMBER | NUMBER "-" NUMBER | NUMBER ":" NUMBER
str      := IDENT | QUOTED
compOp   := "<" | ">" | "<=" | ">=" | "=" | "<>"
object_name := IDENT (resolved against registry)
```

Notes:
- `not` binds tightest among logical ops; `not chain A and chain B` parses as
  `(not chain A) and chain B`.
- Aliases (`c.`, `i.`, `r.`, etc.) tokenize as single keywords.
- Multi-arg keywords with `+` separator: PyMOL accepts `chain A+B+C` =
  `chain A or chain B or chain C`. Parser expands this in `strList` / `rangeList`.
- `state` selector is recognized by the lexer but the AST node emits a warning
  and resolves to `none`.

### 5.5 Test corpus (must compile and evaluate correctly)

**Basic predicates**
```
chain A
chain A+B+C
resi 100
resi 100-200
resi 100+105+110
resi -5--1
name CA
name CA+CB+CG
resn TRP
resn TRP+TYR+PHE
elem C
alt A
```

**Logical**
```
chain A and resi 100-110
chain A or chain B
not chain A
chain A and not resi 100
(chain A or chain B) and resi 100-200
not (chain A and resi 100)
```

**Macros**
```
all
polymer
polymer.protein
polymer.nucleic
hetatm
solvent
water
ions
metals
backbone
sidechain
lig
organic
```

**Topology**
```
byres (chain A and name CA)
byres (resi 100)
bychain (resi 100)
byobject (chain A)
bound_to resi 100
extend 2 (chain A and resi 100)
neighbor (chain A and resi 100)
```

**Distance**
```
within 4 of (chain A and resi 100)
within 4 of resn HEM
near_to 5 of chain A
beyond 10 of (chain A)
contact 1.5 of resi 100
chain A around 4              # = near_to 4 of chain A
```

**Property comparisons**
```
b > 30
b > 30 and chain A
q < 1.0
b < 20 and polymer.protein
```

**Reducers**
```
first (chain A and resi 100-200 and name CA)
last (chain A and name CA)
```

**Combinations**
```
polymer.protein and chain A and not resi 100
byres (chain A within 4 of resn HEM)
(chain A and resi 1-50) or (chain B and resi 50-100)
chain A and name CA and b > 30
not (solvent or ions)
sidechain and resn TRP+TYR+PHE
```

**With named selections (Tier 3)**
```
select active_site, chain A and resi 100-110
select shell, byres (active_site around 4)
color red, active_site
color blue, shell and not active_site
```

### 5.6 Error reporting

Parse failures and "needs-filter without bond graph" diagnostics show
line/column + a friendly message:

```
Line 3, col 12: 'within' requires a numeric distance, got "of"
Line 5: 'bound_to' uses approximate covalent-bond detection (distance-based);
        accuracy ≥95% for typical structures
```

Bubble up via `enqueueSnackbar` warnings so the script keeps running where it
makes sense.

---

## 6. Implementation phases

| Phase | LOC | Time |
|-------|-----|------|
| 1: UI + Tier 1 commands | ~150 | 2-3h |
| 2: Tier 2 (rep/colour) + selection registry | ~150 | 2-3h |
| 3a: Selection lexer + recursive-descent parser | ~250 | 3-4h |
| 3b: CID-pure compilation path | ~150 | 2h |
| 3c: Runtime filter engine + kd-tree | ~250 | 4-5h |
| 3d: Bond-graph approximation (distance-based) | ~120 | 2h |
| 4: Tier 4 (measurements / screenshots) | ~80 | 1h |
| 5: Tier 5 (set commands) + `set_view` | ~150 | 1.5h |
| 6: Test suite | ~600 | 5-6h |
| 7: Docs (`docs/pymol-translator.md` + README/PROJECT-NOTES) | ~400 | 3h |
| **Total** | **~2300** | **3-3.5 working days** |

Each phase is independently shippable.

---

## 7. Documentation deliverables

### 7.1 Inline JSDoc

Every command handler and selection-AST node gets a JSDoc block including:
- The PyMOL syntax it accepts
- The Moorhen API it dispatches to
- Edge cases and explicit non-coverage

### 7.2 `docs/pymol-translator.md` (new file in repo)

Sections:
1. **Overview** — what's translated, the JS / PyMOL mode toggle
2. **Quick start** — paste this 5-line script, see this happen
3. **Supported commands** — full §4 table with example for each
4. **Selection grammar** — full §5 grammar + test cases as worked examples
5. **Coverage matrix** — what PyMOL features are NOT supported (and why)
6. **Differences from PyMOL** — semantic diffs the user should know:
   - `orient` doesn't rotate the camera the same way (Tier 1 limitation)
   - `ray` falls back to rasterizer
   - `bound_to` / `extend` use distance-based bond approximation
   - `state` selector unsupported
7. **Workarounds for unsupported commands** — when stuck, drop into JS mode and
   use the underlying API directly
8. **Adding new commands** — for future contributors: handler signature, where
   to register, how to write a test

### 7.3 README-MH.md update

Add to "Headline additions vs upstream":

```markdown
### PyMOL script mode (new)

Interactive Scripting has a JavaScript / PyMOL toggle. PyMOL mode runs a
subset of PyMOL commands (load/fetch, show/hide/color/select with full
selection grammar including `byres`, `within`, `around`, macros like
`polymer.protein`, etc.) — see [docs/pymol-translator.md](docs/pymol-translator.md).
Anything unsupported falls through with a toast naming the unsupported command.
```

### 7.4 PROJECT-NOTES.md entry

A "PyMOL translator" subsection in "Implemented features (beyond upstream)"
with:
- Pipeline diagram (the flow from §2.1)
- Architectural decisions:
  - Why a UI toggle instead of auto-detect (fewer false positives)
  - Why we compile to CID directly (matches Moorhen's idiom; avoids inventing
    a new query layer)
  - Why selections are conjunctive-AND in CID slots, OR via `||` (matches the
    existing Moorhen custom-rep syntax)
  - Why we use a distance-based bond approximation instead of binding the real
    libcoot bond list
- Known limitations:
  - `state` unsupported
  - `pseudoatom` is a no-op + warning
  - `set surface_quality` deferred
  - `bound_to` / `extend` are approximate
- Future work: state-based selections, real bond list binding, animation /
  movie commands, alignment / superposition.

---

## 8. Testing

Golden-test approach. Each test takes a PyMOL script string and asserts the
resulting Moorhen state (Redux store + molecule representations).

```ts
test("Tier 1: fetch + zoom + show cartoon + color", async () => {
  const env = makeMockEnv();
  await translator.exe(`
    fetch 1crn
    bg_color black
    hide everything
    show cartoon
    color red, chain A
    zoom chain A
  `, env);
  expect(env.store.getState().sceneSettings.backgroundColor).toEqual([0,0,0,1]);
  expect(env.molecules[0].representations.find(r => r.style === "CRs")).toBeDefined();
});
```

About 25-30 golden tests covering each tier, plus the §5.5 selection cases.

Manual smoke test: paste in real-world PyMOL scripts from common workflows
(fetched from `pymolwiki.org`) and visually confirm the result matches.

---

## 9. Open questions resolved (per approved defaults)

1. **Bond graph** — distance-based approximation. No libcoot binding yet.
2. **`state` selector** — not supported (out of scope).
3. **`pseudoatom`** — warns and is a no-op.
4. **`set surface_quality`** — deferred.
5. **`set_view`** — supported (18-float view matrix → `setQuat` / `setOrigin` /
   `setZoom`).

---

## 10. Out of scope

- Python expression evaluation (`iterate`, `alter`, `cmd.do(...)`)
- Movie commands (`mset`, `mplay`, `frame`)
- Plugins, extensions, `cmd.extend`
- Sequence viewer manipulation (PyMOL has its own; Moorhen has its own; they
  don't translate)
- True ray-tracing (Moorhen has no offline renderer; `ray` rasterizes)
- 3D Mouse / VR controls
- CGO objects (`load_cgo`)
- Multi-state PDB files / `state` selector
- `align` / `super` / `cealign` (Moorhen has its own SSM superpose path)

---

## 11. File layout (final)

```
baby-gru/src/utils/
  MoorhenScriptAPI.ts            (existing; refactored to expose buildEnv())
  MoorhenPymolTranslator.ts      (new)
  MoorhenPymolParser.ts          (new)
  MoorhenPymolSelectionParser.ts (new)
  MoorhenPymolFilter.ts          (new, includes kd-tree + bond approx)
  __tests__/
    MoorhenPymolTranslator.test.ts
    MoorhenPymolSelectionParser.test.ts
    MoorhenPymolFilter.test.ts

baby-gru/src/components/
  modal/MoorhenScriptModal.tsx           (modified: add mode toggle)
  menu-item/LoadScript.tsx                (modified: accept .pml)

docs/
  pymol-translator.md                     (new user-facing reference)
  pymol-translator-plan.md                (THIS FILE — implementation plan)
```

---

End of plan.
