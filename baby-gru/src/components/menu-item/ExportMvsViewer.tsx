// "Export portable viewer (HTML)" menu item — PyKeko desktop app only.
// Collects mmCIF for each loaded molecule, builds an MVS JSON document, and
// hands it to the wrapper IPC which injects it into the pre-built Mol* viewer
// template and writes a single self-contained .html via the native Save panel.
// Renders nothing in the browser build.
import { useDispatch, useSelector } from "react-redux";
import { RootState, enqueueSnackbar } from "@/store";
import { moorhen } from "../../types/moorhen";
import { buildMvsJson } from "../../utils/MvsExportBuilder";

export const ExportMvsViewer = () => {
    const dispatch = useDispatch();
    const molecules = useSelector((state: RootState) => state.molecules.moleculeList) as moorhen.Molecule[];

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
            const mols = await Promise.all(molecules.map(async m => ({
                name: m.name,
                // PDB rather than mmCIF: Coot's mmCIF writer doesn't tag polymer
                // residues as polymer, so Mol*'s cartoon path can't fire (see builder).
                coords: await m.getAtoms("pdb"),
                // Per-chain colouring needs the actual chain letters (auth_asym_id).
                chains: (m.sequences || []).map((s: any) => s.chain).filter(Boolean),
            })));
            const mvsJson = buildMvsJson({
                molecules: mols,
                title: `PyKeko — ${mols.map(m => m.name).join(", ")}`,
            });
            const suggestedName = (mols[0]?.name || "pykeko") + "_viewer.html";
            const r = await ctrl.exportMvsViewer(mvsJson, suggestedName);
            if (r?.ok) {
                dispatch(enqueueSnackbar({ message: `Saved portable viewer to ${r.path}`, variant: "success" }));
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
        <span className="moorhen__input__label-menu" style={{ cursor: "pointer" }} onClick={handleClick}>
            Export portable viewer (HTML)…
        </span>
    );
};
