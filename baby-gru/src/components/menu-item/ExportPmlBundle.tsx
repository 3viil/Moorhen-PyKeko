// "Save as PyMOL bundle (.pml)" menu item — PyKeko desktop app only.
// Collects the live scene (loaded molecules + visible maps + reps + colour
// rules + background) and emits a PyMOL script + sibling .pdb/.ccp4 files
// via the wrapper's save-bundle IPC. Open the .pml in PyMOL.app to refine
// the figure and save a real .pse from there.
//
// Mirrors ExportMvsViewer.tsx exactly in shape, so the file/menu plumbing
// is identical — only the export payload differs.
import { useDispatch, useSelector } from "react-redux";
import { RootState, enqueueSnackbar } from "@/store";
import { moorhen } from "../../types/moorhen";
import { buildPmlBundle } from "../../utils/MoorhenPymolSaveBundle";

const isLiveMol = (m: any): boolean => {
    // Same liveness check the translator uses — skip molecules whose backing
    // gemmi structure has been deleted but Redux still references.
    try {
        return !!m && m.molNo !== null && (m.gemmiStructure ? !m.gemmiStructure.isDeleted() : true);
    } catch { return false; }
};

export const ExportPmlBundle = () => {
    const dispatch = useDispatch();
    const molecules = useSelector((state: RootState) => state.molecules.moleculeList) as moorhen.Molecule[];
    const maps = useSelector((state: RootState) => state.maps) as any as moorhen.Map[];
    const visibleMaps = useSelector((state: RootState) => state.mapContourSettings.visibleMaps);
    const bgColor = useSelector((state: RootState) => (state as any).sceneSettings?.backgroundColor) as [number, number, number, number] | undefined;

    const handleClick = async () => {
        const ctrl = (window as any).__moorhenControl;
        if (!ctrl?.saveBundle) {
            dispatch(enqueueSnackbar({
                message: "PyMOL bundle export needs a newer PyKeko build (saveBundle IPC missing). Rebuild PyKekoDev or wait for the next dist.",
                variant: "warning",
            }));
            return;
        }
        if (!molecules || molecules.length === 0) {
            dispatch(enqueueSnackbar({ message: "Load a structure first", variant: "warning" }));
            return;
        }
        try {
            const liveMols = molecules.filter(isLiveMol) as any[];
            // Only export maps the user can currently see — matches what they'd
            // expect "save the scene" to mean.
            const visible = new Set(visibleMaps || []);
            const liveMaps = (maps || []).filter(m => visible.has(m.molNo));

            const suggestedName = (liveMols[0]?.name || "pykeko") + "_scene.pml";
            const bundle = await buildPmlBundle({
                pmlBasename: suggestedName,
                bundleDir: ".",   // relative loads — PyMOL resolves vs CWD
                molecules: liveMols,
                maps: liveMaps,
                backgroundColor: bgColor ?? null,
            });

            const r = await ctrl.saveBundle(suggestedName, bundle.files);
            if (r?.ok) {
                const n = bundle.files.length;
                dispatch(enqueueSnackbar({
                    message: `Saved PyMOL bundle (${n} file${n === 1 ? "" : "s"}) → ${r.primary}`,
                    variant: "success",
                }));
                if (bundle.notes.length > 0) {
                    // Surface the bundle-builder caveats (skipped reps, etc.)
                    dispatch(enqueueSnackbar({
                        message: `Bundle notes: ${bundle.notes.join("; ")}`,
                        variant: "info",
                    }));
                }
            } else if (r?.canceled) {
                dispatch(enqueueSnackbar({ message: "Save canceled", variant: "info" }));
            } else {
                dispatch(enqueueSnackbar({
                    message: `Save failed: ${r?.error || "unknown error"}`,
                    variant: "error",
                }));
            }
        } catch (e: any) {
            dispatch(enqueueSnackbar({
                message: `Save failed: ${e?.message || e}`,
                variant: "error",
            }));
        }
        document.body.click();
    };

    // Only meaningful inside the Electron wrapper (the browser build can't write to disk).
    if (typeof window === "undefined" || !(window as any).__moorhenControl?.saveBundle) return null;

    return (
        <span className="moorhen__input__label-menu" style={{ cursor: "pointer" }} onClick={handleClick}>
            Save as PyMOL bundle (.pml)…
        </span>
    );
};
