// Backbone phi/psi setter — the residue-menu "Edit phi/psi" tool.
//
// libcootapi has no backbone-torsion setter: rotate_around_bond is sidechain-only
// (it builds a single-residue atom_tree and set_dihedral within it), and coot's
// classic "Edit Backbone Torsion" lives in the GTK graphics layer. This implements a
// LOCAL edit matching that tool's behaviour — the chosen residue moves, the rest of the
// chain stays put, the peptide bond to the untouched neighbour stretches, and the caller
// real-space refines the zone afterwards to relax it. (An absolute rotation that rigidly
// swung the whole N-/C-terminal half of the model would be exact but useless.)
//
//   * phi = torsion(C(i-1), N(i), CA(i), C(i)): rotate residue i's C-side atoms about
//     N(i)-CA(i). Neighbours fixed; C(i)-N(i+1) stretches.
//   * psi = torsion(N(i),  CA(i), C(i), N(i+1)): rotate residue i's carbonyl O and
//     residue i+1's amide N about CA(i)-C(i). CA(i+1) onward fixed; N(i+1)-CA(i+1) stretches.
//
// phi and psi are independent (psi's rotation about CA-C leaves phi's atoms untouched and
// vice-versa). Standard amino acids; proline's ring makes its phi a special case, so the
// caller should refine after for Pro. Returns 1 on success, 0 on failure.

#include <cmath>
#include <string>

#include <clipper/core/coords.h>
#include "molecules-container.hh"

namespace {

   std::string trim_name(const char *n) {
      std::string s(n ? n : "");
      size_t a = s.find_first_not_of(' ');
      if (a == std::string::npos) return "";
      size_t b = s.find_last_not_of(' ');
      return s.substr(a, b - a + 1);
   }

   mmdb::Atom *atom_by_name(mmdb::Residue *r, const std::string &want) {
      if (!r) return nullptr;
      mmdb::PPAtom atoms = nullptr;
      int n = 0;
      r->GetAtomTable(atoms, n);
      for (int i = 0; i < n; ++i) {
         mmdb::Atom *at = atoms[i];
         if (!at || at->isTer()) continue;
         if (trim_name(at->name) == want) return at;
      }
      return nullptr;
   }

   clipper::Coord_orth co(mmdb::Atom *a) { return clipper::Coord_orth(a->x, a->y, a->z); }

   int residue_index_in_chain(mmdb::Chain *chain, mmdb::Residue *res) {
      int nres = chain->GetNumberOfResidues();
      for (int i = 0; i < nres; ++i)
         if (chain->GetResidue(i) == res) return i;
      return -1;
   }

   // Rodrigues rotation of atom about a UNIT axis (ux,uy,uz) through `origin`, by `angle` rad.
   void rotate_atom(mmdb::Atom *at, const clipper::Coord_orth &origin,
                    double ux, double uy, double uz, double angle) {
      double vx = at->x - origin.x();
      double vy = at->y - origin.y();
      double vz = at->z - origin.z();
      double c = std::cos(angle), s = std::sin(angle);
      double dot = ux * vx + uy * vy + uz * vz;
      double crx = uy * vz - uz * vy;
      double cry = uz * vx - ux * vz;
      double crz = ux * vy - uy * vx;
      at->x = origin.x() + vx * c + crx * s + ux * dot * (1.0 - c);
      at->y = origin.y() + vy * c + cry * s + uy * dot * (1.0 - c);
      at->z = origin.z() + vz * c + crz * s + uz * dot * (1.0 - c);
   }

   // Rotate a LOCAL atom set by `delta` rad about the bond (origin -> tip), leaving the
   // rest of the chain fixed. This mirrors Coot's "Edit Backbone Torsion": the edit is
   // local, the peptide bond to the untouched neighbour stretches, and you real-space
   // refine afterwards to relax it — far more useful than rigidly swinging the whole
   // N-/C-terminal half of the model (which an absolute downstream rotation would do).
   //   phi (bond N->CA): move residue i's C-side atoms only (everything except the amide
   //                     N and its H). The C(i)-N(i+1) peptide bond stretches.
   //   psi (bond CA->C): move residue i's carbonyl O (+OXT) and residue i+1's amide N
   //                     (+H) only. CA(i+1) onward stays put, so N(i+1)-CA(i+1) stretches.
   void rotate_local(mmdb::Residue *res, mmdb::Residue *next,
                     const clipper::Coord_orth &origin,
                     mmdb::Atom *tip_atom, double delta, bool is_phi) {
      double ax = tip_atom->x - origin.x();
      double ay = tip_atom->y - origin.y();
      double az = tip_atom->z - origin.z();
      double len = std::sqrt(ax * ax + ay * ay + az * az);
      if (len < 1e-6) return;
      ax /= len; ay /= len; az /= len;

      auto is_amide = [](const std::string &nm) {
         return nm == "N" || nm == "H" || nm == "HN" || nm == "H1" || nm == "H2" ||
                nm == "H3" || nm == "D" || nm == "D1" || nm == "D2" || nm == "D3";
      };

      mmdb::PPAtom atoms = nullptr; int na = 0;
      res->GetAtomTable(atoms, na);
      for (int a = 0; a < na; ++a) {
         mmdb::Atom *at = atoms[a];
         if (!at || at->isTer()) continue;
         std::string nm = trim_name(at->name);
         if (is_phi) {
            if (is_amide(nm)) continue;                 // amide N/H stay; C-side moves
            rotate_atom(at, origin, ax, ay, az, delta);
         } else if (nm == "O" || nm == "OXT") {         // psi: carbonyl O of residue i
            rotate_atom(at, origin, ax, ay, az, delta);
         }
      }

      if (!is_phi && next) {                            // psi: residue i+1's amide N (+H) only
         mmdb::PPAtom natoms = nullptr; int nn = 0;
         next->GetAtomTable(natoms, nn);
         for (int a = 0; a < nn; ++a) {
            mmdb::Atom *at = natoms[a];
            if (!at || at->isTer()) continue;
            if (is_amide(trim_name(at->name)))
               rotate_atom(at, origin, ax, ay, az, delta);
         }
      }
   }

} // namespace

int
molecules_container_t::set_phi_psi(int imol, const std::string &residue_cid,
                                   double phi, double psi) {

   if (!is_valid_model_molecule(imol)) return 0;

   mmdb::Residue *res = molecules[imol].cid_to_residue(residue_cid);
   if (!res) return 0;
   mmdb::Chain *chain = res->GetChain();
   if (!chain) return 0;
   int idx = residue_index_in_chain(chain, res);
   if (idx < 0) return 0;
   int nres = chain->GetNumberOfResidues();

   mmdb::Residue *prev = (idx > 0) ? chain->GetResidue(idx - 1) : nullptr;
   mmdb::Residue *next = (idx < nres - 1) ? chain->GetResidue(idx + 1) : nullptr;

   mmdb::Atom *N  = atom_by_name(res, "N");
   mmdb::Atom *CA = atom_by_name(res, "CA");
   mmdb::Atom *C  = atom_by_name(res, "C");
   if (!N || !CA || !C) return 0;

   mmdb::Atom *prevC = prev ? atom_by_name(prev, "C") : nullptr;
   mmdb::Atom *nextN = next ? atom_by_name(next, "N") : nullptr;

   int status = 0;

   // phi (needs the previous residue's C to define the torsion) — local move about N-CA
   if (prevC) {
      double cur = clipper::Coord_orth::torsion(co(prevC), co(N), co(CA), co(C)); // radians
      double delta = (phi * M_PI / 180.0) - cur;
      rotate_local(res, next, co(N), CA, delta, true);
      status = 1;
   }

   // psi (needs the next residue's N) — local move about CA-C; computed after phi
   if (nextN) {
      double cur = clipper::Coord_orth::torsion(co(N), co(CA), co(C), co(nextN)); // radians
      double delta = (psi * M_PI / 180.0) - cur;
      rotate_local(res, next, co(CA), C, delta, false);
      status = 1;
   }

   if (status) {
      mmdb::Manager *mol = molecules[imol].atom_sel.mol;
      if (mol) mol->FinishStructEdit();
      set_updating_maps_need_an_update(imol);
   }
   return status;
}
