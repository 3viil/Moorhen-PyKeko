// "Install command-line launcher" menu item (PyKeko desktop app only). Writes a `pykeko`
// launcher to /usr/local/bin via the wrapper (one admin prompt), so `pykeko file.pdb` works
// from any shell. Talks to the Electron main process through window.__moorhenControl
// (exposed by PyKeko's preload). Renders nothing in the browser build.
import { useEffect, useState } from "react";
import { useDispatch } from "react-redux";
import { enqueueSnackbar } from "@/store";

export const InstallCliLauncher = () => {
    const dispatch = useDispatch();
    const [installed, setInstalled] = useState<{ name: string } | null>(null);

    useEffect(() => {
        const ctrl = (window as any).__moorhenControl;
        ctrl?.cliLauncherStatus?.()
            .then((s: any) => { if (s?.installed) setInstalled({ name: s.name }); })
            .catch(() => { });
    }, []);

    const handleClick = async () => {
        const ctrl = (window as any).__moorhenControl;
        if (!ctrl?.installCliLauncher) {
            dispatch(enqueueSnackbar({ message: "The command-line launcher is only available in the PyKeko desktop app", variant: "warning" }));
            return;
        }
        try {
            const r = await ctrl.installCliLauncher();
            if (r?.ok) {
                setInstalled({ name: r.name });
                dispatch(enqueueSnackbar({ message: `Installed '${r.name}' at ${r.target} — run it from any terminal (e.g. \`${r.name} file.pdb\`)`, variant: "success" }));
            } else if (r?.canceled) {
                dispatch(enqueueSnackbar({ message: "Command-line launcher install canceled", variant: "info" }));
            } else {
                dispatch(enqueueSnackbar({ message: `Install failed: ${r?.error || "unknown error"}`, variant: "error" }));
            }
        } catch (e: any) {
            dispatch(enqueueSnackbar({ message: `Install failed: ${e?.message || e}`, variant: "error" }));
        }
        document.body.click();
    };

    // Only meaningful inside the Electron wrapper (the browser build can't write to PATH).
    if (typeof window === "undefined" || !(window as any).__moorhenControl?.installCliLauncher) return null;

    return (
        <span className="moorhen__input__label-menu" style={{ cursor: "pointer" }} onClick={handleClick}>
            {installed ? `Re-install command-line launcher (${installed.name} installed)` : "Install command-line launcher…"}
        </span>
    );
};
