/* ============================================================================
   View toggles: menerapkan STATE.show ke scene. Menggantikan features/
   inspector.js lama yang selain toggle juga membawa mode riset (offsets /
   drive), ghost fokus per sendi, envelope packaging, dan sweep ghost J3.
   Semua itu alat bantu memilih geometri; geometrinya sudah terkunci di CAD dan
   fokus studio sekarang kontrol + digital twin, jadi ikut dihapus bersama twin
   parametriknya.
   ========================================================================== */
import { STATE } from '../config/arm.js';
import { world, setXray } from '../model/rig.js';
import { setCadVisible } from '../model/cadModel.js';

export function refreshVisToggles() {
  for (const n of world.massNodes) if (n.userData.dot) n.userData.dot.visible = STATE.show.masses;
  if (world.dimGroup) world.dimGroup.visible = STATE.show.dims;
  for (const a of world.axisHelpers) a.visible = STATE.show.axes;
  for (const s of world.skelParts) s.visible = STATE.show.skeleton;
  setXray(STATE.show.xray);
  setCadVisible(STATE.show.cad);
}
