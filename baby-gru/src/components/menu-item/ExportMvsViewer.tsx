// "Export portable viewer (HTML)" menu item — PyKeko desktop app only.
// Collects coordinates + maps for the loaded scene, builds an MVS JSON
// document, and hands it to the wrapper IPC which injects it into the
// pre-built Mol* viewer template and writes a single self-contained .html
// via the native Save panel. Renders nothing in the browser build.
import { useDispatch, useSelector } from "react-redux";
import { RootState, enqueueSnackbar } from "@/store";
import { moorhen } from "../../types/moorhen";
import { buildMvsJson, MvsMapInput } from "../../utils/MvsExportBuilder";
import { cropCcp4 } from "../../utils/MvsCcp4Crop";
import { captureCamera } from "../../utils/MvsCameraCapture";
import { MoorhenMenuItem } from "../interface-base/MenuItems/MenuItem";

// Half-side (Å) of the density cube embedded in the portable viewer. Matches
// Moorhen's default on-screen map radius, so what the recipient sees in the
// standalone viewer is close to what was on screen at export time. Smaller =
// faster viewer + smaller file; larger = density visible over a wider region
// but the standalone viewer's isosurface mesh grows fast (a cubic relationship
// with radius).
const DENSITY_CUBE_HALF_SIDE_ANGSTROMS = 20;

const rgbToHex = (rgb: { r: number; g: number; b: number } | null | undefined): string | undefined => {
    if (!rgb) return undefined;
    const to255 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
    return "#" + [rgb.r, rgb.g, rgb.b].map(v => to255(v).toString(16).padStart(2, "0")).join("");
};

// Union XYZ centroid across all molecules — used as a fallback crop centre
// when no camera state is available (rare; only on the very first frame
// before the user has moved the view).
async function computeUnionCentroid(mols: moorhen.Molecule[]): Promise<[number, number, number] | null> {
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const m of mols) {
        const atoms = await m.gemmiAtomsForCid("/*/*/*/*");
        for (const a of atoms) { sx += a.x; sy += a.y; sz += a.z; n++; }
    }
    return n > 0 ? [sx / n, sy / n, sz / n] : null;
}

export const ExportMvsViewer = () => {
    const dispatch = useDispatch();
    const molecules = useSelector((state: RootState) => state.molecules.moleculeList) as moorhen.Molecule[];
    const maps = useSelector((state: RootState) => state.maps) as any as moorhen.Map[];
    const visibleMaps = useSelector((state: RootState) => state.mapContourSettings.visibleMaps);

    const handleClick = async () => {
        const ctrl = (window as any).__moorhenControl;
        if (!ctrl?.exportMvsViewer) {
            dispatch(enqueueSnackbar({ message: "Portable viewer export is only available in the PyKeko desktop app", variant: "warning" }));
            return;
        }
        if (!molecules || molecules.length === 0) {
            dispatch(enqueueSnackbar({ message: "Load a structure first", variant: "warning" }));
            return;
        }
        try {
            // --- Structures ---
            const mols = await Promise.all(molecules.map(async m => ({
                name: m.name,
                // PDB rather than mmCIF: Coot's mmCIF writer doesn't tag polymer
                // residues as polymer, so Mol*'s cartoon path can't fire (see builder).
                coords: await m.getAtoms("pdb"),
                // Per-chain colouring needs the actual chain letters (auth_asym_id).
                chains: (m.sequences || []).map((s: any) => s.chain).filter(Boolean),
            })));

            // --- Maps (visible only) ---
            // Crop each map to a cube around the camera target (matches Moorhen's
            // on-screen "sphere of density around the cursor" behaviour). Falls
            // back to the molecule centroid if no camera is available. Cropping
            // to a small cube (~20 Å half-side) keeps the embedded file small
            // AND the standalone viewer responsive — the isosurface mesh for a
            // whole-ASU's worth of density costs the viewer dearly.
            const cam = captureCamera();
            const cropCenter: [number, number, number] | null = cam?.target
                ?? (await computeUnionCentroid(molecules));
            const mapInputs: MvsMapInput[] = [];
            const skipped: string[] = [];
            const visible = new Set(visibleMaps || []);
            const candidateMaps = (maps || []).filter(m => visible.has(m.molNo));

            if (candidateMaps.length > 0 && !cropCenter) {
                // Shouldn't happen given the molecule-loaded check above, but be defensive.
                throw new Error("Cannot determine crop center (no camera + no molecules)");
            }

            for (const m of candidateMaps) {
                try {
                    const mapReply: any = await m.getMap();
                    const mapBuf: ArrayBuffer = mapReply?.data?.result?.mapData;
                    if (!mapBuf) { skipped.push(`${m.name} (no data)`); continue; }

                    const cropped = cropCcp4(mapBuf, {
                        centerXYZ: cropCenter!,
                        radiusAngstroms: DENSITY_CUBE_HALF_SIDE_ANGSTROMS,
                    });

                    const params = m.getMapContourParams();
                    // contourLevel is in ABSOLUTE density units (Moorhen's
                    // slider exposes σ but stores absolute, multiplying by
                    // the map's RMSD under the hood). Pass straight through
                    // as absolute_isovalue. For a map that was just loaded
                    // and never UI-adjusted, the Redux entry is missing —
                    // fall back to the map's own suggestedContourLevel
                    // (set by Coot's auto-fit at load time) so the export
                    // still matches what's on screen.
                    const contourAbsolute: number | null = typeof params?.contourLevel === "number"
                        ? params.contourLevel
                        : (typeof m.suggestedContourLevel === "number" ? m.suggestedContourLevel : null);

                    mapInputs.push({
                        name: m.name,
                        bytes: cropped.bytes,
                        isDifference: !!m.isDifference,
                        contourAbsolute,
                        color: rgbToHex(params?.mapColour as any) ?? "#3a86ff",
                        positiveColor: rgbToHex(params?.positiveMapColour as any),
                        negativeColor: rgbToHex(params?.negativeMapColour as any),
                    });
                } catch (e: any) {
                    skipped.push(`${m.name} (${e?.message || e})`);
                }
            }

            const mvsJson = buildMvsJson({
                molecules: mols,
                maps: mapInputs,
                camera: cam,
                title: `PyKeko — ${mols.map(m => m.name).join(", ")}`,
            });
            const suggestedName = (mols[0]?.name || "pykeko") + "_viewer.html";
            const r = await ctrl.exportMvsViewer(mvsJson, suggestedName);
            if (r?.ok) {
                const mapInfo = mapInputs.length > 0 ? ` (${mapInputs.length} map${mapInputs.length > 1 ? "s" : ""})` : "";
                dispatch(enqueueSnackbar({ message: `Saved portable viewer${mapInfo} to ${r.path}`, variant: "success" }));
                if (skipped.length > 0) {
                    dispatch(enqueueSnackbar({ message: `Skipped maps: ${skipped.join(", ")}`, variant: "warning" }));
                }
            } else if (r?.canceled) {
                dispatch(enqueueSnackbar({ message: "Export canceled", variant: "info" }));
            } else {
                dispatch(enqueueSnackbar({ message: `Export failed: ${r?.error || "unknown error"}`, variant: "error" }));
            }
        } catch (e: any) {
            dispatch(enqueueSnackbar({ message: `Export failed: ${e?.message || e}`, variant: "error" }));
        }
        document.body.click();
    };

    // Only meaningful inside the Electron wrapper (the browser build can't write to disk
    // and lacks the bundled viewer template).
    if (typeof window === "undefined" || !(window as any).__moorhenControl?.exportMvsViewer) return null;

    return (
        <MoorhenMenuItem onClick={handleClick}>
            Export portable viewer (.html)…
        </MoorhenMenuItem>
    );
};
