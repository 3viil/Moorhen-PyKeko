// First-run welcome for the PyKeko desktop app. Shows once per version (tracked in
// localStorage), pointing new users at the command-line launcher so they don't have to
// hunt for it in Preferences. Renders nothing in the browser build and nothing once
// dismissed for the current version — bump HINT_VERSION to re-surface (e.g. a "what's new").
import { useEffect, useState } from "react";
import { Dialog, DialogTitle, DialogContent, DialogActions, Typography, Box } from "@mui/material";
import { useDispatch } from "react-redux";
import { MoorhenButton } from "../inputs";
import { enqueueSnackbar } from "@/store";

// Bump this when there's something new worth re-announcing to returning users.
const HINT_VERSION = "0.2.0";
const STORAGE_KEY = "pykeko-seen-hint-version";

export const MoorhenFirstRunHint = () => {
    const dispatch = useDispatch();
    const [open, setOpen] = useState<boolean>(false);
    const [installed, setInstalled] = useState<{ name: string } | null>(null);

    useEffect(() => {
        const ctrl = (window as any).__moorhenControl;
        // Desktop app only — the browser build can't install a CLI launcher.
        if (typeof window === "undefined" || !ctrl?.installCliLauncher) return;
        let seen: string | null = null;
        try { seen = window.localStorage.getItem(STORAGE_KEY); } catch (e) { /* private mode */ }
        if (seen !== HINT_VERSION) setOpen(true);
        ctrl.cliLauncherStatus?.()
            .then((s: any) => { if (s?.installed) setInstalled({ name: s.name }); })
            .catch(() => { });
    }, []);

    const dismiss = () => {
        try { window.localStorage.setItem(STORAGE_KEY, HINT_VERSION); } catch (e) { /* private mode */ }
        setOpen(false);
    };

    const handleInstall = async () => {
        const ctrl = (window as any).__moorhenControl;
        try {
            const r = await ctrl.installCliLauncher();
            if (r?.ok) {
                setInstalled({ name: r.name });
                dispatch(enqueueSnackbar({ message: `Installed '${r.name}' — run it from any terminal (e.g. \`${r.name} file.pdb\`)`, variant: "success" }));
            } else if (r?.canceled) {
                dispatch(enqueueSnackbar({ message: "Command-line launcher install canceled", variant: "info" }));
            } else {
                dispatch(enqueueSnackbar({ message: `Install failed: ${r?.error || "unknown error"}`, variant: "error" }));
            }
        } catch (e: any) {
            dispatch(enqueueSnackbar({ message: `Install failed: ${e?.message || e}`, variant: "error" }));
        }
        dismiss();
    };

    if (!open) return null;

    return (
        <Dialog open={open} onClose={dismiss} maxWidth="sm">
            <DialogTitle>Welcome to PyKeko {HINT_VERSION}</DialogTitle>
            <DialogContent>
                <Typography gutterBottom>
                    PyKeko can open structures straight from the terminal — like Coot's <code>coot file.pdb</code>
                    {" "}or PyMOL's <code>pymol file.pdb</code>.
                </Typography>
                <Box sx={{ my: 1, p: 1, backgroundColor: "rgba(77,171,247,0.12)", borderRadius: 1 }}>
                    <Typography variant="body2" component="div">
                        Install the launcher, then from any shell:
                        <pre style={{ margin: "0.4rem 0 0", fontSize: "0.8rem", whiteSpace: "pre-wrap" }}>
{`pykeko model.pdb data.mtz ligand.cif
pykeko 1crn          # fetch by PDB id
pykeko script.pml    # run a PyMOL-style script`}
                        </pre>
                    </Typography>
                </Box>
                <Typography variant="body2" color="text.secondary">
                    {installed
                        ? `Already installed as '${installed.name}'. You can reinstall anytime from Preferences → Install command-line launcher.`
                        : "You can always do this later from Preferences → Install command-line launcher."}
                </Typography>
            </DialogContent>
            <DialogActions>
                <MoorhenButton variant="secondary" onClick={dismiss}>
                    {installed ? "Got it" : "Maybe later"}
                </MoorhenButton>
                {!installed && (
                    <MoorhenButton variant="primary" onClick={handleInstall}>
                        Install now…
                    </MoorhenButton>
                )}
            </DialogActions>
        </Dialog>
    );
};
