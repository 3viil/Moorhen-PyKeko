import { useDispatch, useSelector, useStore } from "react-redux";
import { useState } from "react";
import { useCommandCentre, useMoorhenInstance, useTimeCapsule } from "../../InstanceManager";
import { MoorhenReduxStoreType, RootState } from "../../store/MoorhenReduxStore";
import { autoOpenFiles } from "../../utils/MoorhenFileLoading";
import { MoorhenFileInput } from "../inputs";

export const AutoLoadFiles = () => {
    const commandCentre = useCommandCentre();
    const store: MoorhenReduxStoreType = useStore<RootState>();
    const defaultBondSmoothness = useSelector((state: RootState) => state.sceneSettings.defaultBondSmoothness);
    const monomerLibraryPath = useMoorhenInstance().paths.monomerLibraryPath;
    const dispatch = useDispatch();
    const timeCapsule = useTimeCapsule();
    const backgroundColor = useSelector((state: RootState) => state.sceneSettings.backgroundColor);
    const [isLoading, setIsLoading] = useState<boolean>(false);

    const autoLoadHandler = async (e: React.ChangeEvent<HTMLInputElement>) => {
        setIsLoading(true);
        const files: File[] = [];
        if (e.target.files) {
            for (let ifile = 0; ifile < e.target.files.length; ifile++) {
                files.push(e.target.files[ifile]);
            }
            await autoOpenFiles(
                files,
                commandCentre,
                store,
                monomerLibraryPath,
                backgroundColor,
                defaultBondSmoothness,
                timeCapsule,
                dispatch
            );
        }
        setIsLoading(false);
        document.body.click();
    };

    // Under the PyKeko Electron wrapper, route "Open Files" through a native OS dialog
    // rooted at the app's working directory (browser <input type=file> can't set a start
    // directory). The wrapper reads the chosen files, loads them via the loadFiles control
    // verb, and remembers the last-used folder. Falls back to the browser input elsewhere.
    const nativeOpen = (window as any).__moorhenControl?.openFiles;
    const nativeOpenHandler = async () => {
        setIsLoading(true);
        try { await nativeOpen(); }
        catch (e) { console.warn("native open failed", e); }
        finally { setIsLoading(false); document.body.click(); }
    };

    return (
        <>
            <span className="moorhen__input__label-menu">Open Files</span>
            {typeof nativeOpen === "function" ? (
                <button
                    type="button"
                    className="moorhen_menu-custom-left-margin moorhen__input-files-upload"
                    onClick={nativeOpenHandler}
                    disabled={isLoading}
                    style={{ cursor: "pointer", border: "none", background: "transparent", textAlign: "left", font: "inherit", padding: 0 }}
                >
                    {isLoading ? "Opening…" : "Browse…"}
                </button>
            ) : (
                <MoorhenFileInput
                    accept=".pdb, .mmcif, .cif, .ent, .mol, .mtz, .map, .pb,.mrc"
                    multiple={true}
                    isLoading={isLoading}
                    className="moorhen_menu-custom-left-margin"
                    onChange={e => {
                        autoLoadHandler(e);
                    }}
                />
            )}
        </>
    );
};

// const LoadPDB = () => {
//     const loadPdbFiles = async (files: FileList) => {
//         const readPromises: Promise<moorhen.Molecule>[] = [];
//         Array.from(files).forEach(file => {
//             readPromises.push(readPdbFile(file));
//         });

//         let newMolecules: moorhen.Molecule[] = await Promise.all(readPromises);
//         if (!newMolecules.every(molecule => molecule.molNo !== -1)) {
//             dispatch(enqueueSnackbar({ message:"Failed to read molecule",  variant: "warning" }));
//             newMolecules = newMolecules.filter(molecule => molecule.molNo !== -1);
//             if (newMolecules.length === 0) {
//                 return;
//             }
//         }

//         const drawPromises: Promise<void>[] = [];
//         for (const newMolecule of newMolecules) {
//             drawPromises.push(newMolecule.fetchIfDirtyAndDraw(newMolecule.atomCount >= 50000 ? "CRs" : "CBs"));
//         }
//         await Promise.all(drawPromises);

//         dispatch(addMoleculeList(newMolecules));
//         newMolecules.at(-1).centreOn("/*/*/*/*", true);
//     };
//     return (
//         <>
//             <label htmlFor="coordinates-file-input" className="moorhen__input__label-menu">
//                 Coordinates
//             </label>
//             <input
//                 id="coordinates-file-input"
//                 className="moorhen__input-files-upload"
//                 type="file"
//                 accept=".pdb, .mmcif, .cif, .ent, .mol"
//                 multiple={true}
//                 onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
//                     loadPdbFiles(e.target.files);
//                 }}
//             />
//         </>
//     );
// };
