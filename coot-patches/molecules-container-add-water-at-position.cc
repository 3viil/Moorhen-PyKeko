// Single-water-at-position primitive (the `w` shortcut needs this so we can
// place a water at the crosshairs and then refine it, like Coot 0.9.x).
// Reuses insert_waters_into_molecule so chain selection and residue numbering
// are handled the same way as the existing batch add_waters.

#include <climits>
#include <vector>
#include <string>

#include <clipper/core/coords.h>

#include "molecules-container.hh"
#include "mini-mol/mini-mol.hh"

std::string
molecules_container_t::add_water_at_position(int imol, float x, float y, float z) {

   if (!is_valid_model_molecule(imol)) {
      return "";
   }

   std::vector<clipper::Coord_orth> pos { clipper::Coord_orth(x, y, z) };
   coot::minimol::molecule water_mol(pos, "HOH", " O", "X", " O");
   molecules[imol].insert_waters_into_molecule(water_mol, "HOH");
   set_updating_maps_need_an_update(imol);

   // Find the new water: highest-seqNum HOH in any solvent chain.
   mmdb::Manager *mol = molecules[imol].atom_sel.mol;
   if (!mol) return "";
   int nchains = mol->GetNumberOfChains(1);
   std::string best_chain;
   int best_seq = INT_MIN;
   for (int i = 0; i < nchains; ++i) {
      mmdb::Chain *chain_p = mol->GetChain(1, i);
      if (!chain_p || !chain_p->isSolventChain()) continue;
      int nres = chain_p->GetNumberOfResidues();
      for (int r = 0; r < nres; ++r) {
         mmdb::Residue *res_p = chain_p->GetResidue(r);
         if (!res_p) continue;
         if (std::string(res_p->name) != "HOH") continue;
         if (res_p->seqNum > best_seq) {
            best_seq = res_p->seqNum;
            best_chain = chain_p->GetChainID();
         }
      }
   }
   if (best_chain.empty() || best_seq == INT_MIN) return "";
   return "/1/" + best_chain + "/" + std::to_string(best_seq);
}
