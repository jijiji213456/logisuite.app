// ---------------------------------------------------------------------------
// Adaptateur Xano <-> forme interne de LogiSuite.
//
// Les composants React de LogiSuite (TourneeTab, SuiviTab, ChauffeurView...)
// attendent chaque tournée sous une forme précise : un tableau `stops`, plus
// des objets `statuses` / `comments` / `timestamps` indexés par id d'arrêt,
// et un tableau `order` d'INDICES (pas d'ids) représentant l'ordre optimisé.
//
// Xano, lui, stocke chaque arrêt comme une ligne indépendante avec ses propres
// champs `status`, `comment`, `status_at`, `status_by`, `sequence`.
//
// Ces fonctions font l'aller-retour entre les deux, pour ne quasiment rien
// changer dans le reste de l'application.
// ---------------------------------------------------------------------------

import { extractStopsFromTournee } from "./xano";

export function stopFromXano(raw) {
  return {
    id: String(raw.id),
    x: raw.x,
    y: raw.y,
    label: raw.label,
    clientName: raw.client_name || "",
    timeSlot: raw.time_slot || "",
    productId: raw.product_id != null ? String(raw.product_id) : null,
    qty: raw.qty || 1,
    _sequence: raw.sequence != null ? raw.sequence : null,
    _status: raw.status || "attente",
    _comment: raw.comment || "",
    _statusAt: raw.status_at || null,
    _statusBy: raw.status_by || null,
  };
}

export function tourneeFromXano(raw) {
  const rawStops = extractStopsFromTournee(raw).map(stopFromXano);

  const statuses = {};
  const comments = {};
  const timestamps = {};
  rawStops.forEach((s) => {
    statuses[s.id] = s._status;
    if (s._comment) comments[s.id] = s._comment;
    if (s._statusAt) timestamps[s.id] = { status: s._status, at: s._statusAt, by: s._statusBy };
  });

  const hasSequence = rawStops.some((s) => s._sequence != null);
  let order = null;
  let naiveOrder = null;
  if (hasSequence) {
    const withSeq = rawStops.map((s, i) => ({ i, seq: s._sequence == null ? Infinity : s._sequence }));
    withSeq.sort((a, b) => a.seq - b.seq);
    order = withSeq.map((e) => e.i);
    naiveOrder = rawStops.map((_, i) => i);
  }

  // strip the internal-only fields before handing stops to the app
  const stops = rawStops.map(({ _sequence, _status, _comment, _statusAt, _statusBy, ...clean }) => clean);

  return {
    id: String(raw.id),
    name: raw.name,
    driverName: raw.driver_name || "",
    vehicleName: raw.vehicle_name || "",
    depotId: raw.depot_id != null ? String(raw.depot_id) : null,
    stops,
    order,
    naiveOrder,
    statuses,
    comments,
    timestamps,
    status: raw.status || "attente",
    createdAt: raw.created_at || null,
    startedAt: raw.started_at || null,
    finishedAt: raw.finished_at || null,
  };
}

export function tourneeMetaToXano(patch) {
  const out = {};
  if ("name" in patch) out.name = patch.name;
  if ("driverName" in patch) out.driver_name = patch.driverName;
  if ("vehicleName" in patch) out.vehicle_name = patch.vehicleName;
  if ("depotId" in patch) out.depot_id = patch.depotId ? Number(patch.depotId) : null;
  if ("status" in patch) out.status = patch.status;
  if ("startedAt" in patch) out.started_at = patch.startedAt;
  if ("finishedAt" in patch) out.finished_at = patch.finishedAt;
  if ("order" in patch) out.is_optimized = !!patch.order;
  return out;
}

export function stopToXano(patch) {
  const out = {};
  if ("label" in patch) out.label = patch.label;
  if ("clientName" in patch) out.client_name = patch.clientName;
  if ("timeSlot" in patch) out.time_slot = patch.timeSlot;
  if ("productId" in patch) out.product_id = patch.productId ? Number(patch.productId) : null;
  if ("qty" in patch) out.qty = patch.qty;
  if ("x" in patch) out.x = patch.x;
  if ("y" in patch) out.y = patch.y;
  if ("sequence" in patch) out.sequence = patch.sequence;
  if ("status" in patch) out.status = patch.status;
  if ("comment" in patch) out.comment = patch.comment;
  if ("statusAt" in patch) out.status_at = patch.statusAt;
  if ("statusBy" in patch) out.status_by = patch.statusBy;
  return out;
}

export function depotFromXano(raw) {
  return { id: String(raw.id), name: raw.name, x: raw.x, y: raw.y };
}

export function productFromXano(raw) {
  return { id: String(raw.id), name: raw.name, qty: raw.qty || 0 };
}

export function userFromXano(raw) {
  return { id: String(raw.id), name: raw.name || raw.email, email: raw.email, role: raw.role || "chauffeur" };
}
