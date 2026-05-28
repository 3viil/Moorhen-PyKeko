# PyMOL command translator for Interactive Scripting

The **Interactive Scripting** modal in this Moorhen fork has a `JavaScript / PyMOL`
language toggle. PyMOL mode runs a subset of PyMOL commands against the live
Moorhen scene — paste a PyMOL setup script, hit Run, see it execute. The same
runner is reachable from outside the modal via `window.MoorhenControlApi.runPymol(src)`
(used by the autonomous CDP test loop — see [`PROJECT-NOTES.md`](../PROJECT-NOTES.md#autonomous-cdp-test-loop)).

The translator is *not* a full PyMOL — Python expression evaluation (`iterate`,
`alter`, `cmd.do`) and movie commands are explicitly out of scope. The aim is
to cover ~80% of real-world setup/visualisation scripts. Everything unsupported
falls through with a `[pymol:N] <cmd>: unsupported` console warning so the
script continues running.

The mode preference is remembered in `localStorage` (`moorhen.scripting.mode`).
`.pml` files dragged into **Load and execute script…** auto-route to the PyMOL
runner; `.js` files use the JavaScript runner.

---

## Quick start

```
fetch 7sj3
hide everything
show cartoon
color red
color blue, chain A
show sticks, lig
color yellow, lig
zoom lig
```

Expected: 7sj3 is the two-chain CDK4–Cyclin D3 complex, so `color blue, chain A`
turns CDK4 (chain A) blue while Cyclin D3 (chain B) stays red; the bound
abemaciclib ligand shows as yellow sticks, and the view zooms onto it.

---

## Supported commands

### Loading and view

| Command | Notes |
|---------|-------|
| `fetch <id>` | Downloads `<id>.pdb` from RCSB, adds it as a Moorhen molecule, registers the id as the PyMOL object name. Replaces any existing molecule with the same name (PyMOL semantics). |
| `load <file>` | Local-path load isn't reachable from the browser sandbox; warns and is a no-op. Use the File menu or `fetch`. |
| `delete <name>` / `delete all` | Deletes the molecule and removes it from the Redux state. |
| `enable <name>` / `disable <name>` | Toggle a molecule's visibility (the cartoons/bonds actually hide/show — not just the Redux flag). |
| `zoom [sel]` | Centre + fit the view on `sel` (or the whole scene if no arg). |
| `orient [sel]` | Same as `zoom` for now (true camera reorientation isn't wired). |
| `center [sel]` | Set the view origin to the centroid of `sel` (no zoom change). |
| `set_view (...)` | Parse PyMOL's 18-float view matrix → `setQuat` / `setOrigin` / `setZoom`. Scene-recall scripts work; round-trip with PyMOL isn't 1:1 because Moorhen's zoom isn't a fov-style scalar. |

### Representation

| Command | Notes |
|---------|-------|
| `show <rep>[, sel]` | Find-or-create a representation. Mapping: `cartoon`/`ribbon` → CRs, `sticks`/`lines` → CBs, `spheres`/`sphere` → VdwSpheres, `surface`/`mesh`/`dots` → MolecularSurface, `nb_spheres` → VdwSpheres. |
| `hide <rep>[, sel]` | Hide that style (the buffers remain so the next `show` is fast). `hide everything` hides every representation on the molecule. |
| `as <rep>[, sel]` | `hide everything` then `show <rep>`. |

### Colour

| Command | Notes |
|---------|-------|
| `color <colour>[, sel]` | Adds a coot colour rule with the selection cid → hex, then redraws once per affected molecule. ~50 PyMOL colour names recognised (red, salmon, slate, firebrick, forest, …) plus `#RRGGBB` / `0xRRGGBB` literals. |
| `bg_color <colour>` | Dispatch `setBackgroundColor`. Note: persists as the user's default (Moorhen syncs `backgroundColor` → `defaultBackgroundColor` automatically). |
| `colour` / `bg_colour` | British-spelling aliases. |
| `spectrum b` / `spectrum b-factor` | Apply b-factor-normalised colour rule. Other modes (`count`, `rainbow`) currently warn — they were aliasing to symmetry-mate colouring which is wrong. |

### Selection algebra (the big one)

`select <name>, <expr>` stores `<expr>` under `<name>` so later commands can
reference it (`color red, my_sel`). `deselect` does nothing (PyMOL's transient
`sele` selection isn't tracked).

`<expr>` is a small DSL. The two-tier compiler tries a **CID-pure** mapping
first (chain/resi/name predicates with and/or — fast, no atom enumeration);
falls through to a **runtime atom-filter** for everything else (b/q comparisons,
within / byres / etc — iterates atoms in JS).

**Operators** (precedence low → high): `or` (`|`), `and` (`&`), `not` (`!`), parens.

**Atom predicates**:

| Form | Aliases | Example |
|------|---------|---------|
| `chain X[+Y…]` | `c.` | `chain A`, `chain A+B+C` |
| `resi N` / `resi A-B` | `i.` | `resi 100`, `resi 1-50`, `resi 5+10+15+20`, `resi -5` (negative residues OK) |
| `resn X[+Y…]` | `r.` | `resn TRP`, `resn TRP+TYR+PHE` |
| `name X[+Y…]` | `n.` | `name CA`, `name CA+CB+CG` |
| `elem X` | `e.` | `elem C`, `elem FE` |
| `alt X` |  | `alt A`, `alt B` |
| `segi X` | `s.` | rarely useful in mmdb-land |
| `b <op> N`, `q <op> N` |  | `b > 30`, `q < 0.5` (`=`, `<`, `>`, `<=`, `>=`, `<>`) |
| `index N` / `ID N` / `rank N` |  | atom serial / rank |

**Macros**:

| Macro | Aliases | Defined as |
|-------|---------|------------|
| `all` / `*` |  | every atom |
| `none` |  | empty |
| `hydro` / `hydrogen` | `h.` | element H or D |
| `polymer.protein` | `pol.` prefix | 20 standard AAs + MSE/SEC/PYL/HID/HIE/HIP/CYX/CYM/ASH/GLH |
| `polymer.nucleic` |  | DA/DC/DG/DT/A/C/G/U/T/I |
| `polymer` |  | protein ∪ nucleic |
| `solvent` / `water` | `sol.` | HOH/WAT/H2O/D2O/T3P/SOL/TIP/TIP3/TIP4 |
| `metals` |  | Li/Na/K/Rb/Cs/Mg/Ca/Sr/Ba/Mn/Fe/Co/Ni/Cu/Zn/Ag/Au/Al/Hg/Cd/Pb/Mo/W/V/Cr |
| `ions` |  | metals ∪ halides |
| `hetatm` / `het` |  | non-protein, non-nucleic, **non-solvent** (matches PyMOL's `het`) |
| `lig` |  | hetatm minus solvent minus ions minus standard residues |
| `backbone` / `bb.` | protein N/CA/C/O/OXT, nucleic P/OP1/OP2/O3'/O5'/C3'/C4'/C5' |
| `sidechain` / `sc.` |  | protein non-backbone non-H |
| `organic` |  | hetatm with C/N/O/S/P/H only |
| `inorganic` |  | non-(C/N/O/S/P/H) |

**Topology** (each takes one inner selection):

| Form | Aliases | Meaning |
|------|---------|---------|
| `byres P` | `br.` | Expand to whole residues containing any matched atom (CID-pure if `P` is). |
| `bychain P` | `bc.` | Expand to whole chains. |
| `byobject P` / `bymodel P` | `bo.` | Expand to whole molecule. |
| `bymolecule P` | `bm.` | Expand to connected component (distance-based covalent graph). |
| `bound_to P` / `neighbor P` | `nbr.` | Atoms directly bonded to `P` (distance-based bond approx). |
| `extend N P` | `xt.` | Expand `P` outward by `N` bonds. |

**Distance** (each takes a numeric Å cutoff and an inner selection):

| Form | Aliases | Meaning |
|------|---------|---------|
| `within N of P` | `w.` | Atoms within N Å of P (P included). |
| `near_to N of P` | `nto.` | within, but excluding P. |
| `beyond N of P` | `be.` | Atoms farther than N Å from P. |
| `contact N of P` |  | Same as `near_to` (vdw-touching is approximated). |
| `gap N of P` | `g.` | beyond with vdw-radius gap. |
| `P around N` | (postfix) | Equivalent to `near_to N of P`. |
| `P within N of Q` | (postfix-binary) | Compiles to `P AND (within N of Q)`. |

**Reducers**: `first P` / `last P`.

**Object names**: a bare identifier (or `7sj3`, `4hhb` — digit-led PDB ids work)
is treated as an object reference. Names registered by `fetch` or `select`
are resolved first; the live Redux molecule list is checked as a fallback.

### Measurements

| Command | Notes |
|---------|-------|
| `distance [name,] sel1, sel2` / `dist …` | Centroid-to-centroid distance. Three outputs: console log, snackbar toast, and a persistent red dashed line + label drawn through the same `measuredAtoms` mechanism as the mouse-driven measure tool. |

### Screenshots

| Command | Notes |
|---------|-------|
| `png [name]` | Hands off to Moorhen's screenshot pipeline (`videoRecorderRef.takeScreenShot`). Triggers a file download. |
| `ray <w>, <h>` | No software ray-tracing in Moorhen; warns and falls back to `png` (rasterised). |

### `set` (a curated subset)

| Setting | Mapped to |
|---------|-----------|
| `set transparency, <v>[, sel]` | Per-rep `setNonCustomOpacity(1-v)` |
| `set ray_shadow` / `shadows` | `setDoShadow` |
| `set ambient, <v>` | `setAmbient([v,v,v,1])` |
| `set specular` / `spec_reflect, <v>` | `setSpecular(...)` |
| `set specular_power` / `shininess, <v>` | `setSpecularPower(v)` |
| `set rocking` / `spin` | `setDoSpin` |
| `set fog_start, <v>` | `setFogStart(v)` |
| `set fog_end, <v>` | `setFogEnd(v)` |
| `set ray_trace_mode, <n>` / `depth_cue` | `setDoEdgeDetect` (truthy ↔ on) |
| `set ray_opaque_background, <0/1>` | Toast — takes effect at next `png`/`ray` |
| `set anaglyph` / `anaglyph_stereo` | `setDoAnaglyphStereo` |
| `set draw_axes` / `axes` | `setDrawAxes` |
| `set draw_crosshairs` / `crosshairs` | `setDrawCrosshairs` |
| `set draw_scale_bar` / `scale_bar` | `setDrawScaleBar` |
| `set viewport` / `size` | Warns — window size is browser-owned |
| `set surface_quality` / `_color` / `_solvent` | Deferred — warns |

Truthy parsing for booleans: `0` / `off` / `false` are false; everything else
is true (so `on`, `1`, `true` all work).

### Misc

| Command | Notes |
|---------|-------|
| `rock` | Alias for `set rocking, 1` (toggle scene spinning). |
| `pseudoatom <args>` | Recognised but no-op (with a warning). |

### Explicitly NOT supported

`iterate`, `alter`, `cmd.do(...)`, `python`/`endpython` blocks, `extend`,
`cmd.load_cgo`, `cealign`, `align`, `super`, movie commands (`mset`, `mplay`,
`frame`), scene `store`/`recall` (Moorhen has its own scene model). The `state`
selector is also out — Moorhen tracks model indices but doesn't expose multi-
state semantics cleanly.

---

## Selection examples worth trying

```
chain A and resi 1-50
(chain A or chain B) and resi 100-200
polymer.protein and not chain A
byres (chain A within 4 of resn HEM)        # all residues with any atom within 4 Å of any HEM atom
sidechain and resn TRP+TYR+PHE
b > 30 and polymer.protein                  # high-B-factor protein residues
first (chain A and name CA)                 # the very first CA in chain A
chain A around 5                            # all atoms within 5 Å of chain A (excluding A)
```

---

## Differences from PyMOL you should know

- **`orient`** doesn't rotate the camera the same way PyMOL does (Moorhen's
  view is a quaternion + zoom; we centre/fit but don't recompute the principal-
  axis orientation). Use `set_view (…)` to pin a specific camera.
- **`ray`** doesn't ray-trace. It rasterises the current WebGL view — same as
  `png`. Shadows, ambient occlusion, depth-of-field need to be enabled via
  `set` first.
- **`bound_to` / `extend` / `bymolecule`** use a distance-based covalent-bond
  approximation (covalent if d ≤ r₁ + r₂ + 0.4 Å). ~95 % accuracy on standard
  residues; can misjudge unusual covalent geometries in non-standard ligands.
  A real libcoot bond-list binding is on the TODO list.
- **`hetatm`** matches PyMOL's `het` semantics (non-standard *and* non-solvent).
  Use `solvent` explicitly for waters.
- **`set` keys** that don't have a Moorhen analogue (most ray-tracing settings,
  `surface_quality`, etc.) warn and no-op.
- **`bg_color`** persists — Moorhen's `backgroundColor` is auto-synced to the
  user's `defaultBackgroundColor` preference. If you write a test script that
  changes `bg_color`, end it with `bg_color black` (or whatever the user's
  preferred default is).

---

## Workarounds for unsupported commands

When something isn't supported, drop into JS mode and call the underlying API
directly. The script env has `commandCentre`, `molecules`, `maps`, `dispatch`,
the Redux action creators, and the `MoorhenMolecule` / `MoorhenMoleculeRepresentation`
classes available. Examples:

```javascript
// Run an arbitrary coot command
await run_command("split_residue_using_map", molNo, "//A/123", mapMolNo);

// Add a representation with custom bond width
const rep = new MoorhenMoleculeRepresentation("CBs", "//A", molecules[0].commandCentre);
rep.bondOptions.width = 0.05;
rep.setParentMolecule(molecules[0]);
await rep.draw();
```

The PyMOL handlers themselves are in `baby-gru/src/utils/MoorhenPymolTranslator.ts`
— look at the existing implementations for the pattern.

---

## Adding a new PyMOL command

1. Implement `cmdYourCmd(cmd, env, registry, scriptApi)` in
   `MoorhenPymolTranslator.ts` (handlers all live in that file).
2. Register it in the `handlers` table at the bottom of the same file.
3. Add a test case to `tests/__tests__/pymolParser.test.js` or
   `pymolSelectionParser.test.js` if it touches the lexer or AST.
4. Add a row to the table here under the appropriate section.

If the command needs a new selection-grammar construct, edit the AST + parser
in `MoorhenPymolSelectionParser.ts`, then either extend `compileSlots` (for the
CID-pure fast path) or `matchPred`/`evaluateNode` in `MoorhenPymolFilter.ts`
(for the runtime-filter path).

---

## Test corpus

The unit tests in `baby-gru/tests/__tests__/pymol*.test.js` are pure-JS and
don't need WASM:

```bash
cd baby-gru
npx jest --testPathPatterns pymol --selectProjects api-utils
```

Three files cover the line parser, selection grammar, and runtime filter
(62 tests total).

For end-to-end visual testing, see the
[autonomous CDP test loop](../PROJECT-NOTES.md#autonomous-cdp-test-loop) in
PROJECT-NOTES.md.
