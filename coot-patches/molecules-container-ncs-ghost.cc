// NCS ghost matrix computation
// Returns the 4x4 transformation matrix that maps `copy_chain` onto `master_chain`
// within the same molecule, computed via SSM alignment.
// Crucially, atoms are NOT moved - the matrix is just returned for use as a
// rendering transform overlay.

#include "molecules-container.hh"

std::vector<float>
molecules_container_t::get_ncs_ghost_matrix(int imol,
                                            const std::string &master_chain,
                                            const std::string &copy_chain) {

   // Return 16 floats. Empty vector indicates failure.
   std::vector<float> result;

#ifdef HAVE_SSMLIB

   if (!is_valid_model_molecule(imol)) {
      std::cout << "get_ncs_ghost_matrix: invalid molecule " << imol << std::endl;
      return result;
   }

   atom_selection_container_t asc = molecules[imol].atom_sel;
   if (asc.n_selected_atoms == 0) {
      std::cout << "get_ncs_ghost_matrix: no atoms in molecule " << imol << std::endl;
      return result;
   }

   // Make atom selections for the master and copy chains within the same molecule
   int sel_master = asc.mol->NewSelection();
   int sel_copy   = asc.mol->NewSelection();

   asc.mol->SelectAtoms(sel_master, 0, master_chain.c_str(),
                        mmdb::ANY_RES, "*", mmdb::ANY_RES, "*",
                        "*", "*", "*", "*");
   asc.mol->SelectAtoms(sel_copy,   0, copy_chain.c_str(),
                        mmdb::ANY_RES, "*", mmdb::ANY_RES, "*",
                        "*", "*", "*", "*");

   int n_master = 0, n_copy = 0;
   mmdb::PAtom *atoms_master = nullptr;
   mmdb::PAtom *atoms_copy   = nullptr;
   asc.mol->GetSelIndex(sel_master, atoms_master, n_master);
   asc.mol->GetSelIndex(sel_copy,   atoms_copy,   n_copy);

   if (n_master == 0 || n_copy == 0) {
      std::cout << "get_ncs_ghost_matrix: empty selection - master=" << n_master
                << " copy=" << n_copy << std::endl;
      asc.mol->DeleteSelection(sel_master);
      asc.mol->DeleteSelection(sel_copy);
      return result;
   }

   ssm::SetConnectivityCheck(ssm::CONNECT_Flexible);
   ssm::SetMatchPrecision(ssm::PREC_Normal);
   ssm::Align *SSMAlign = new ssm::Align();
   // AlignSelectedMatch(mol_mov, mol_ref, ..., sel_mov, sel_ref)
   // We want the matrix that maps copy -> master, so copy is the "moving" selection
   int rc = SSMAlign->AlignSelectedMatch(asc.mol, asc.mol,
                                          ssm::PREC_Normal,
                                          ssm::CONNECT_Flexible,
                                          sel_copy, sel_master);

   if (rc) {
      std::cout << "get_ncs_ghost_matrix: SSM alignment failed rc=" << rc << std::endl;
   } else {
      // Pack TMatrix (mmdb::mat44 = realtype[4][4]) into 16 floats, row-major
      for (int i = 0; i < 4; ++i) {
         for (int j = 0; j < 4; ++j) {
            result.push_back(static_cast<float>(SSMAlign->TMatrix[i][j]));
         }
      }
      std::cout << "get_ncs_ghost_matrix: RMSD=" << SSMAlign->rmsd
                << " aligned=" << SSMAlign->nalgn
                << " (" << master_chain << " <- " << copy_chain << ")" << std::endl;
   }

   delete SSMAlign;
   asc.mol->DeleteSelection(sel_master);
   asc.mol->DeleteSelection(sel_copy);

#else
   std::cout << "get_ncs_ghost_matrix: SSMLIB not available" << std::endl;
#endif

   return result;
}
