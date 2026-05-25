# DMG packaging plan (Tahoe-only, personal & redistributable)

This is a **plan**, not an implementation. The goal is to produce a self-contained
`.dmg` for macOS 15 (Tahoe) — and ideally Apple Silicon + Intel — without
disturbing the working PyKeko / PyKekoDev installs that the dev box
currently depends on.

The current wrapper (`~/PyKeko`) ships **two** variants today: `prod`
(PyKeko, vite port 5173, sources at `~/Moorhen/baby-gru`) and `dev`
(PyKekoDev, vite port 5174, sources at `~/Moorhen-dev/baby-gru`). Both
**require a vite dev server pointed at user-home source trees** to be running.
That is the single biggest reason the app is not currently a redistributable
`.dmg` — the packaged `.app` cannot find `~/Moorhen` on someone else's machine,
nor does that machine have node/npm/emsdk on PATH to run vite in the first
place.

This plan adds a **third variant** (`dist`) that self-contains everything. Dev
and prod variants remain untouched.

---

## 0. Non-goals

- **Not touching** `prod` or `dev` variants of PyKeko, PyKeko,
  PyKekoDev, `~/Moorhen`, or `~/Moorhen-dev`.
- **Not** building an installer for arbitrary macOS versions. Tahoe is the
  one-and-only target. Older macOS (Sequoia and below) may or may not work; not
  tested.
- **Not** removing the Electron wrapper. Everything else in this codebase
  assumes Electron (the WASM 32-bit force, `SharedArrayBuffer`, COOP/COEP,
  preload script, sandbox: false). Switching to a non-Electron path would be a
  much bigger project.
- **Not** trying to make a fully separate fork. The `dist` variant lives in the
  same PyKeko repo via the existing `MOORHEN_VARIANT` mechanism, and a
  separate output app name (`PyKeko.app`) so it cannot clobber PyKeko /
  PyKekoDev.

---

## 1. What "self-contained" means here

The packaged `.app` must work on a clean Tahoe machine that has:
- No Moorhen source tree
- No Node.js / npm
- No emsdk
- No CCP4 install
- Just the `.app` (or `.dmg`) downloaded from somewhere

For that to happen, everything the runtime needs has to be **inside** the app
bundle:

| Currently lives at | Must move to |
|---|---|
| `~/Moorhen/baby-gru/src/**` (TypeScript) | Built at package time → static `dist/` inside app bundle |
| `~/Moorhen/baby-gru/public/MoorhenAssets/wasm/*.wasm` | Same `dist/` |
| `~/Moorhen/baby-gru/public/MoorhenAssets/monomers/**` | Same `dist/` |
| Auto-generated files (`src/version.js`, `CootWorker.js`, protobuf, graphql) | Same `dist/` (codegen runs at package time, not runtime) |
| Vite dev server | **Removed**. Replaced with in-process Node HTTP server. |
| `npx vite` / `npm run …` calls in `main.js` | **Removed**. No node/npm dependency at runtime. |

---

## 2. Architecture changes

### 2.1 Replace vite with an in-process static server

The single hardest problem: `mainWindow.loadURL("http://localhost:5173/")`
currently loads from a vite dev server that spins up on app launch. For a
distributable `.dmg`, we need either:

- **(a) `loadURL("file://…")`** — direct file load. **This will NOT work** as-is:
  the renderer needs the COOP / COEP headers for `SharedArrayBuffer`, and
  Electron's `file://` protocol doesn't allow custom response headers. (Hacks
  exist via `protocol.handle`, but they're fragile.)
- **(b) In-process HTTP server** on a random localhost port, serving the
  pre-built `dist/` directory with the right headers. ← **recommended.**

The in-process server replacement (roughly 40 lines in `main.js`):

```js
function startStaticServer(distDir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // Strip query string, default to index.html
      let urlPath = req.url.split("?")[0];
      if (urlPath === "/" || urlPath === "") urlPath = "/index.html";
      const filePath = path.join(distDir, urlPath);
      // Path traversal guard
      if (!filePath.startsWith(distDir)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        const ext = path.extname(filePath).toLowerCase();
        const mime = MIME_TYPES[ext] || "application/octet-stream";
        res.writeHead(200, {
          "content-type": mime,
          // The two headers vite-plugin-cross-origin-isolation sets:
          "cross-origin-opener-policy": "same-origin",
          "cross-origin-embedder-policy": "require-corp",
        });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}
```

MIME table needs at least `.js`, `.mjs`, `.css`, `.html`, `.wasm`, `.json`,
`.svg`, `.png`, `.woff2`, `.ttf`, `.map`, `.cif`. The WASM mime must be
`application/wasm` (browsers reject `application/octet-stream` for streaming
instantiation).

### 2.2 Build the static bundle at package time

`baby-gru` already has a `vite build` script that produces `dist/`. The
`forge.config.js` `prePackage` hook should:

1. `cd ~/Moorhen && npm ci` (or `npm install --omit=dev` if size is an issue)
2. `npm run create-version transpile-ts-worker transpile-protobuf transpile-graphql-codegen`
3. `npm run build` (or whichever script produces `dist/`)
4. Copy `~/Moorhen/baby-gru/dist/**` into `~/PyKeko/dist-app/dist/` so
   electron-forge picks it up as part of the package.
5. Copy `~/Moorhen/baby-gru/public/MoorhenAssets/**` into the same
   `dist-app/dist/` (the static server serves both built JS and original
   monomer / pdb / wasm assets).

Note: this **does** require node + emsdk on the **build** machine — but not on
the **user's** machine. That's the point.

### 2.3 `dist` variant in `forge.config.js`

Append to the existing `VARIANTS`:

```js
dist: {
  name: "PyKeko",  // produces PyKeko.app, distinct from PyKeko.app
  config: {
    moorhenSubdir: null,    // static bundle path resolved below
    bundledDist: "dist-app/dist",  // path relative to app resources
    title: "PyKeko",
  },
},
```

`main.js`'s variant-loading logic adds a branch:

```js
const BUNDLED_DIST = VARIANT.bundledDist
  ? path.join(process.resourcesPath, "app", VARIANT.bundledDist)
  : null;
```

If `BUNDLED_DIST` is set, skip `startVite()` entirely and instead:

```js
const port = await startStaticServer(BUNDLED_DIST);
mainWindow.loadURL(`http://127.0.0.1:${port}/`);
```

Everything downstream (control server, screenshot, MCP) keeps working because
they target `127.0.0.1:<port>` either way.

### 2.4 Forge config for DMG

Add to `devDependencies`:

```json
"@electron-forge/maker-dmg": "^7.0.0"
```

Append to `makers`:

```js
{
  name: "@electron-forge/maker-dmg",
  config: {
    name: "PyKeko",
    overwrite: true,
    // optional: background image, icon, etc.
  },
},
```

Build command:

```bash
cd ~/PyKeko
MOORHEN_VARIANT=dist npm run make
# → ~/PyKeko/out/make/PyKeko-1.0.0-arm64.dmg (or x64)
```

### 2.5 Universal binary (arm64 + x64)

Electron supports `--arch=universal` to produce a universal `.app`. The WASM
artifacts are CPU-architecture-independent (they're 32-bit WASM running in the
browser), so the same `dist/` directory works on both arches — only the
**Electron** binary itself needs to be universal.

```js
packagerConfig: {
  name: variant.name,
  arch: variant.name === "PyKeko" ? "universal" : undefined,
}
```

Or pass `--arch=universal` to `electron-forge package`. Doubles the bundle size
(~250 MB → ~500 MB) — fine for a one-off distribution, less fine for routine
downloads.

---

## 3. Code-signing & notarisation

Three tiers, increasing rigour:

### 3.1 Personal-use unsigned (zero cost, brittle)

Builds work, but the OS will refuse to launch. Users have to:
- Right-click → Open the first time, **or**
- `xattr -dr com.apple.quarantine /Applications/PyKeko.app` after dragging in.

This is fine if "redistributable" means "I'll send the DMG to two collaborators
who know to run that command." Not fine for general distribution.

### 3.2 Developer ID signed, not notarised (~$99/year)

Need:
- Apple Developer Program membership
- A "Developer ID Application" certificate in Keychain
- An entitlements plist (Electron's defaults are mostly fine; may need
  `com.apple.security.cs.allow-unsigned-executable-memory` for WASM JIT, and
  `com.apple.security.cs.disable-library-validation` if any embedded `.dylib`s
  aren't ours)

Forge config:

```js
packagerConfig: {
  osxSign: {
    identity: "Developer ID Application: <Your Name> (<TEAM ID>)",
    entitlements: "entitlements.plist",
    "entitlements-inherit": "entitlements.plist",
  },
}
```

Result: launches without warning on the build machine, still warns on others
(Gatekeeper checks notarisation for downloaded apps).

### 3.3 Developer ID signed + notarised (recommended for public)

Add `osxNotarize` to forge config (uses `notarytool` under the hood):

```js
osxNotarize: {
  tool: "notarytool",
  appleId: process.env.APPLE_ID,
  appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
  teamId: process.env.APPLE_TEAM_ID,
}
```

Notarisation takes 1–20 minutes per build. After it succeeds the app is
**stapled** so it works offline too. This is the only tier that produces a
download other people can run without arcane terminal commands.

---

## 4. Repo layout (the proposed `dist` setup)

Nothing here clobbers anything that exists today:

```
~/PyKeko/
  main.js               # modified to handle BUNDLED_DIST
  forge.config.js       # adds `dist` variant + dmg maker
  preload.js            # unchanged
  package.json          # adds @electron-forge/maker-dmg
  variant.json          # baked at package time
  dist-app/             # NEW — staging dir; gitignored
    dist/               # built baby-gru output (from `npm run build` in ~/Moorhen)
  out/                  # electron-forge output (already gitignored)
    PyKeko-arm64.dmg
    PyKeko-arm64.zip  # unchanged
    PyKekoDev-arm64.zip    # unchanged
```

`MOORHEN_VARIANT=prod npm run package` still produces `PyKeko.app` from
`~/Moorhen/baby-gru` via vite. `MOORHEN_VARIANT=dev npm run package:dev` still
produces `PyKekoDev.app`. **The current daily workflow is untouched.**

`MOORHEN_VARIANT=dist npm run make` is the new path — produces `PyKeko.dmg`
that anyone on Tahoe can install.

---

## 5. Open questions

1. **Asset size**: the WASM blob is ~25 MB. Monomers add another ~20 MB.
   Universal Electron binary is ~250 MB. Final DMG: ~300 MB compressed. Is that
   acceptable for distribution? (PyMOL's installer is ~200 MB, ChimeraX is
   ~600 MB, so this is in normal range.)
2. **Auto-update**: not in scope. Adding `electron-updater` later would let the
   app self-update from a hosted feed — not worth the complexity for v1.
3. **External tool integration**: PyKekoMCP currently talks to the wrapper via
   a per-launch control file. That still works inside a packaged app because
   `~/.moorhen-mcp/control-<vitePort>.json` is written from inside the running
   process. But MCP itself is a separate `node` install. If a distribution
   user wants Claude integration, they still need to install PyKekoMCP
   separately. Documenting that is fine.
4. **Window background / icon / DMG layout art**: cosmetic, deferred.
5. **`window.MOORHEN_FORCE_32BIT`** is set by `preload.js` — needs to be tested
   to confirm the packaged app on a fresh machine still avoids the 64-bit init
   hang.

---

## 6. Estimated effort

| Step | Time |
|------|------|
| Add `dist` variant to `forge.config.js` + `variant.json` plumbing | 30 min |
| In-process static server in `main.js` | 1 hr |
| `prePackage` hook to build baby-gru + copy assets | 1 hr |
| Wire up `@electron-forge/maker-dmg` and test build on dev box | 1 hr |
| Verify packaged app runs on a clean Tahoe VM (or borrowed clean Mac) | 1 hr |
| Code-sign + notarise (if needed) — first time setup is fiddly | 3 hrs |
| **Total to a personal-use, unsigned DMG** | **~4 hrs** |
| **Total to a notarised, public-distributable DMG** | **~1 day** |

The 4-hour estimate assumes everything works first try. Practically: budget a
day either way. Most of the risk is in step 5 — the WASM-init / SharedArrayBuffer
path interacting with the static-server route — because we don't get to debug
against a known-good baseline (the packaged binary on someone else's machine
is the moment of truth).

---

## 7. How to proceed (when ready)

A safe sequencing that never breaks the current dev/prod:

1. Branch PyKeko (e.g., `dist-variant`). Do all the work there.
2. While on the branch, `MOORHEN_VARIANT=prod` and `=dev` should still produce
   the same outputs they always did. Verify both still launch on the dev box
   before merging.
3. Build a `dist` variant locally, install it as `/Applications/PyKeko.app`,
   verify it launches alongside (not replacing) PyKeko and PyKekoDev.
4. Copy the `.dmg` to a clean test machine — anything where you've never
   installed PyKeko — and confirm it launches without intervention (modulo
   the right-click-Open dance for unsigned builds).
5. If targeting notarisation: do an unsigned build first, get it working, then
   add signing. Signing failures are much easier to debug when the
   non-signing parts are already known to work.
6. Merge the branch back. The dist variant is now an option but doesn't change
   the default workflow.

---

## 8. Distribution via GitHub Releases

For a small audience (a few collaborators) on the dev box's owner, GitHub
Releases is the right host: free, no size pressure (2 GB per asset, unlimited
release storage that doesn't count against repo size), public URL, version
history. The repo is already on GitHub at
[3viil/Moorhen-PyKeko](https://github.com/3viil/Moorhen-PyKeko).

### 8.1 Manual release (recommended for v1)

After a successful local `MOORHEN_VARIANT=dist npm run make`:

```bash
# Optional: tag the Moorhen-dev tree at the SHA that produced this build
git -C ~/Moorhen-dev tag v0.1-dist
git -C ~/Moorhen-dev push origin v0.1-dist

# Upload the DMG
gh release create v0.1-dist \
  ~/PyKeko/out/make/PyKeko-1.0.0-arm64.dmg \
  --repo 3viil/Moorhen-PyKeko \
  --title "PyKeko v0.1 (unsigned macOS Tahoe build)" \
  --notes-file ~/Moorhen-dev/docs/release-notes-v0.1.md
```

This takes about 30 seconds once the DMG exists.

### 8.2 Release-notes template (so install actually works for recipients)

The recipient downloads a `.dmg` via browser → macOS attaches
`com.apple.quarantine` → Gatekeeper refuses to launch. **This is true for any
unsigned app downloaded from the internet, not just PyKeko.** The release
notes need to tell them how to bypass it. Suggested boilerplate:

```markdown
## Install (macOS 15 Tahoe, Apple Silicon)

1. Download PyKeko-1.0.0-arm64.dmg.
2. Open it and drag PyKeko.app into /Applications.
3. **One-time** — bypass Gatekeeper for this unsigned build:

   Open Terminal, paste, hit return:

       xattr -dr com.apple.quarantine /Applications/PyKeko.app

   (Alternative: in Finder, right-click PyKeko.app → Open → confirm. This
   works for the first launch only.)

4. Launch from /Applications or Spotlight as normal.

## What's in this build

- Coot-style keyboard shortcuts (w, p, n, d, l, o, g, …)
- PyMOL-style scripting in the Interactive Scripting modal
- NCS ghost overlays
- … (etc, summarised from README-MH)

This build is unsigned and not notarised. macOS will warn that the developer
cannot be verified — that is expected.
```

Stashing the boilerplate under `~/Moorhen-dev/docs/release-notes-v0.1.md` and
just bumping the version on each release saves rewriting it.

### 8.3 `curl` install (skips the quarantine dance)

Users who download via `curl` or `gh release download` don't pick up the
quarantine attribute — those tools don't set it. So the **power-user install**
is:

```bash
gh release download v0.1-dist --repo 3viil/Moorhen-PyKeko --pattern '*.dmg'
hdiutil attach PyKeko-1.0.0-arm64.dmg
cp -R /Volumes/PyKeko/PyKeko.app /Applications/
hdiutil detach /Volumes/PyKeko
```

No `xattr` step needed. Worth mentioning in release notes for collaborators
who live in a terminal.

### 8.4 GitHub Actions (later, when manual gets annoying)

A `.github/workflows/release.yml` that builds the DMG on tag push, uploaded to
the matching release. Skeleton:

```yaml
on:
  push:
    tags: ["v*-dist"]

jobs:
  build:
    runs-on: macos-15  # Tahoe
    steps:
      - uses: actions/checkout@v4
        with: { submodules: recursive }
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - uses: mymindstorm/setup-emsdk@v14
        with: { version: 3.1.50 }  # match TARGET_EMSDK_VERSION
      - run: |
          # Build CCP4 WASM (~1hr first time, cacheable)
          cd CCP4_WASM_BUILD && ./build.sh
      - run: |
          cd baby-gru && npm ci && npm run build
      - run: |
          cd ../PyKeko
          MOORHEN_VARIANT=dist npm ci
          MOORHEN_VARIANT=dist npm run make
      - uses: softprops/action-gh-release@v2
        with:
          files: PyKeko/out/make/*.dmg
```

The CCP4 WASM step is the painful one (~1 hr if uncached). With `actions/cache`
keyed on `CCP4_WASM_BUILD/VERSIONS`, subsequent runs drop to ~5 min. Not worth
setting up until manual releases start hurting. **Caveat**: this requires
PyKeko to live in the same repo (or a submodule of) Moorhen-PyKeko so the
checkout sees both. Today PyKeko is a separate repo on the dev box —
either bring it in as a submodule, or run two workflows that coordinate via
release artifacts.

### 8.5 Honesty about size

The DMG goes on the release. GitHub's free tier handles this fine for a few
downloads/month. If the project ever sees real distribution traffic, GitHub
Releases bandwidth is still free but is rate-limited per-IP; for that case
host on S3 or Cloudflare R2 and link from the release notes. Not a v1 problem.
