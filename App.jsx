import React, { useState, useRef, useCallback, useMemo, useEffect } from "react";
import Papa from "papaparse";
import { authApi, depotsApi, productsApi, tourneesApi, stopsApi, usersApi, getToken, setToken, ApiError } from "./api/xano";
import {
  tourneeFromXano,
  tourneeMetaToXano,
  stopToXano,
  depotFromXano,
  productFromXano,
  userFromXano,
} from "./api/normalize";
import {
  MapPin,
  Home,
  RotateCcw,
  Zap,
  Fuel,
  Clock,
  TrendingDown,
  Route,
  Truck,
  Package,
  Plus,
  X,
  CheckCircle2,
  AlertTriangle,
  Circle,
  PlayCircle,
  Upload,
  Download,
  Compass,
  Loader2,
  LayoutGrid,
  RefreshCw,
  FileText,
  User,
  MessageSquare,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Warehouse,
  Users,
  UserPlus,
  KeyRound,
  LogOut,
  History,
  Bell,
  Copy,
  Printer,
} from "lucide-react";

// ---------- shared tokens ----------
const COLORS = {
  bg: "#12161B",
  panel: "#171D23",
  border: "#262C33",
  accent: "#FF6A1A",
  text: "#E9E6DF",
  muted: "#9BA3AD",
  dim: "#6B7480",
  blue: "#4DA3FF",
  green: "#34D399",
  red: "#F26D6D",
};

const LOW_STOCK = 5;
const KM_PER_UNIT = 12 / 100;
const SPEED_KMH = 28;
const LITERS_PER_KM = 0.14;
const MAX_STOPS = 20;

// ---------- geometry / TSP ----------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const pathLength = (order, points, depot) => {
  if (order.length === 0) return 0;
  let total = dist(depot, points[order[0]]);
  for (let i = 0; i < order.length - 1; i++) {
    total += dist(points[order[i]], points[order[i + 1]]);
  }
  return total;
};

function nearestNeighbor(points, depot) {
  const remaining = points.map((_, i) => i);
  const order = [];
  let current = depot;
  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    remaining.forEach((idx, ri) => {
      const d = dist(current, points[idx]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = ri;
      }
    });
    const chosen = remaining.splice(bestIdx, 1)[0];
    order.push(chosen);
    current = points[chosen];
  }
  return order;
}

function twoOpt(order, points, depot) {
  let improved = true;
  let best = [...order];
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const newOrder = [
          ...best.slice(0, i),
          ...best.slice(i, k + 1).reverse(),
          ...best.slice(k + 1),
        ];
        if (
          pathLength(newOrder, points, depot) <
          pathLength(best, points, depot) - 0.0001
        ) {
          best = newOrder;
          improved = true;
        }
      }
    }
  }
  return best;
}

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// deterministic pseudo-position from a text address, so importing the same
// CSV twice always places stops the same way (stand-in for real geocoding)
function hashPosition(str, depot) {
  let h1 = 0,
    h2 = 0;
  for (let i = 0; i < str.length; i++) {
    h1 = (h1 * 31 + str.charCodeAt(i)) >>> 0;
    h2 = (h2 * 17 + str.charCodeAt(i) + 7) >>> 0;
  }
  let x = 10 + (h1 % 80);
  let y = 10 + (h2 % 80);
  if (dist({ x, y }, depot) < 8) {
    x = Math.min(92, x + 14);
    y = Math.max(8, y - 14);
  }
  return { x, y };
}

// ---------- dépôts ----------
function getDepot(depots, depotId) {
  return (depots && depots.find((d) => d.id === depotId)) || (depots && depots[0]) || { id: null, name: "Dépôt", x: 50, y: 50 };
}

// ---------- utilisateurs / rôles ----------
const ROLE_META = {
  exploitant: { label: "Exploitant", color: COLORS.accent },
  chauffeur: { label: "Chauffeur", color: COLORS.blue },
};

// ---------- tournée helpers ----------
const TOURNEE_STATUS_META = {
  attente: { label: "En attente", color: COLORS.dim },
  encours: { label: "En cours", color: COLORS.blue },
  terminee: { label: "Terminée", color: COLORS.green },
};

function tourneeStats(tournee, depot) {
  const stops = tournee.stops;
  const seqIdx = tournee.order || stops.map((_, i) => i);
  const distance = stops.length ? pathLength(seqIdx, stops, depot) * KM_PER_UNIT : 0;
  const driveTimeMin = (distance / SPEED_KMH) * 60;
  return { distance, driveTimeMin };
}

// ---------- printable "carnet de route" (opens in a new tab → PDF) ----------
// Rather than calling window.print() on the current page — which sandboxed
// preview environments (like the Claude artifact iframe) can silently block —
// this builds a standalone HTML document and opens it in a brand-new browser
// tab. That tab is a normal top-level window, so its own "Imprimer /
// Enregistrer en PDF" button and the browser's native print (Ctrl+P) always
// work, regardless of where the app itself is embedded.
function escapeHtml(str) {
  return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function buildCarnetHtml(tournee, products, depots) {
  const depot = getDepot(depots, tournee.depotId);
  const sequence = tournee.order ? tournee.order.map((i) => tournee.stops[i]) : tournee.stops;
  const { distance, driveTimeMin } = tourneeStats(tournee, depot);
  const delivered = sequence.filter((s) => tournee.statuses[s.id] === "livre");
  const failed = sequence.filter((s) => tournee.statuses[s.id] === "echec");
  const totalQty = delivered.reduce((sum, s) => sum + (s.qty || 0), 0);
  const dateStr = new Date().toLocaleDateString("fr-FR");

  const stats = [
    ["Arrêts", sequence.length],
    ["Livrés", delivered.length],
    ["Échecs", failed.length],
    ["Qté livrée", totalQty],
    ["Distance", `${distance.toFixed(1)} km`],
    ["Conduite", `${Math.round(driveTimeMin)} min`],
  ];

  const rows = sequence
    .map((s, idx) => {
      const status = STATUS_META[tournee.statuses[s.id] || "attente"];
      const product = products.find((p) => p.id === s.productId);
      const ts = tournee.timestamps[s.id];
      const time = ts ? new Date(ts.at).toLocaleTimeString("fr-FR") : "-";
      const statusColor = tournee.statuses[s.id] === "echec" ? "#c0392b" : tournee.statuses[s.id] === "livre" ? "#1e8e5a" : "#8a8f98";
      const commentRow = tournee.comments[s.id]
        ? `<tr style="border-bottom:1px solid #eee;"><td></td><td colspan="5" style="font-size:11px;color:#c0392b;font-style:italic;padding:0 8px 6px;">⚠ ${escapeHtml(tournee.comments[s.id])}${ts && ts.by ? " — signalé par " + escapeHtml(ts.by) : ""}</td></tr>`
        : "";
      return `<tr style="border-bottom:${tournee.comments[s.id] ? "none" : "1px solid #eee"};">
          <td style="font-size:11px;padding:6px 8px;">${idx + 1}</td>
          <td style="font-size:11px;padding:6px 8px;">${escapeHtml(s.label || "Adresse sans nom")}${s.clientName ? " — " + escapeHtml(s.clientName) : ""}</td>
          <td style="font-size:11px;padding:6px 8px;">${escapeHtml(s.timeSlot || "-")}</td>
          <td style="font-size:11px;padding:6px 8px;">${product ? `${s.qty} × ${escapeHtml(product.name)}` : "-"}</td>
          <td style="font-size:11px;padding:6px 8px;color:${statusColor};font-weight:700;">${escapeHtml(status.label)}</td>
          <td style="font-size:11px;padding:6px 8px;">${time}</td>
        </tr>${commentRow}`;
    })
    .join("");

  const metaCells = [
    ["Chauffeur", tournee.driverName || "Non assigné"],
    ["Véhicule", tournee.vehicleName || "Non renseigné"],
    ["Dépôt de départ", depot.name],
    ["Départ", tournee.startedAt ? new Date(tournee.startedAt).toLocaleTimeString("fr-FR") : "-"],
    ["Fin", tournee.finishedAt ? new Date(tournee.finishedAt).toLocaleTimeString("fr-FR") : "-"],
    ["Statut", TOURNEE_STATUS_META[tournee.status].label],
  ];

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<title>Carnet de route — ${escapeHtml(tournee.name)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a1d21; margin: 0; padding: 14mm; }
  table { border-collapse: collapse; width: 100%; }
  .toolbar { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 14px; }
  .toolbar button { background: #FF6A1A; color: #fff; border: none; border-radius: 5px; padding: 10px 16px; font-size: 13px; font-weight: 700; cursor: pointer; }
  .toolbar span { font-size: 12px; color: #888; align-self: center; }
  @media print { .toolbar { display: none; } @page { margin: 12mm; } }
</style>
</head>
<body>
  <div class="toolbar">
    <span>Choisis "Enregistrer en PDF" comme imprimante &rarr;</span>
    <button onclick="window.print()">Imprimer / Enregistrer en PDF</button>
  </div>

  <div style="background:#FF6A1A;color:#fff;padding:9px 14px;font-weight:700;font-size:12px;letter-spacing:1px;">
    LOGISUITE — CARNET DE ROUTE
  </div>
  <h1 style="font-size:21px;margin:16px 0 2px;">${escapeHtml(tournee.name)}</h1>
  <div style="font-size:11.5px;color:#666;margin-bottom:14px;">Date : ${dateStr}</div>

  <table style="margin-bottom:14px;width:auto;">
    <tr>${metaCells.map(([label]) => `<td style="font-size:9px;color:#8a8f98;text-transform:uppercase;padding:3px 8px 0;white-space:nowrap;">${escapeHtml(label)}</td>`).join("")}</tr>
    <tr>${metaCells.map(([, value]) => `<td style="font-size:12px;color:#1a1d21;font-weight:600;padding:0 8px 8px;">${escapeHtml(value)}</td>`).join("")}</tr>
  </table>

  <table style="margin-bottom:18px;border:1px solid #ddd;">
    <tr>
      ${stats
        .map(
          ([label, value], i) => `<td style="text-align:center;padding:8px 4px;${i < stats.length - 1 ? "border-right:1px solid #ddd;" : ""}">
            <div style="font-size:15px;font-weight:700;color:#FF6A1A;">${escapeHtml(value)}</div>
            <div style="font-size:8.5px;color:#8a8f98;text-transform:uppercase;">${escapeHtml(label)}</div>
          </td>`
        )
        .join("")}
    </tr>
  </table>

  <table>
    <thead>
      <tr>
        <th style="font-size:9.5px;text-transform:uppercase;color:#8a8f98;text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;width:24px;">#</th>
        <th style="font-size:9.5px;text-transform:uppercase;color:#8a8f98;text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;">Adresse / Client</th>
        <th style="font-size:9.5px;text-transform:uppercase;color:#8a8f98;text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;width:90px;">Créneau</th>
        <th style="font-size:9.5px;text-transform:uppercase;color:#8a8f98;text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;width:120px;">Article</th>
        <th style="font-size:9.5px;text-transform:uppercase;color:#8a8f98;text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;width:70px;">Statut</th>
        <th style="font-size:9.5px;text-transform:uppercase;color:#8a8f98;text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;width:60px;">Heure</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>

  <div style="font-size:9px;color:#aaa;margin-top:18px;">
    LogiSuite — généré le ${new Date().toLocaleString("fr-FR")}
  </div>
</body>
</html>`;
}

// ---------- root app ----------
export default function LogiSuite() {
  const [tab, setTab] = useState("tournee");
  const [role, setRole] = useState("exploitant"); // "exploitant" | "chauffeur"
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [authError, setAuthError] = useState(null);

  const [tournees, setTournees] = useState([]);
  const [depots, setDepots] = useState([]);
  const [users, setUsers] = useState([]);
  const [products, setProducts] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [toasts, setToasts] = useState([]);

  const [activeTourneeId, setActiveTourneeId] = useState(null);
  const [chauffeurTourneeId, setChauffeurTourneeId] = useState(null);
  const [optimizing, setOptimizing] = useState(false);
  const [drawProgress, setDrawProgress] = useState(0);

  // Downloads the carnet de route as a standalone HTML file, the same way the
  // CSV template export already works. A plain file download (via a Blob +
  // an <a download> link) isn't blocked by sandboxed preview environments the
  // way window.print()/window.open() can be. The user opens the downloaded
  // file in their browser and prints/saves it as PDF from there.
  const requestPrint = (tournee, products, depots) => {
    const html = buildCarnetHtml(tournee, products, depots);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const dateSlug = new Date().toISOString().slice(0, 10);
    a.download = `carnet-de-route-${tournee.name.replace(/\s+/g, "-").toLowerCase()}-${dateSlug}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  // tracks which (tournée, arrêt, horodatage) échec combinations have
  // already been surfaced as a notification, so the real-time poll below only
  // alerts on genuinely new failures rather than replaying history every time
  const failureKeysRef = useRef(null);

  const collectFailureKeys = (list) => {
    const set = new Set();
    (list || []).forEach((t) => {
      Object.entries(t.timestamps || {}).forEach(([stopId, info]) => {
        if (info && info.status === "echec") set.add(`${t.id}:${stopId}:${info.at}`);
      });
    });
    return set;
  };

  // Wraps a mutation so failures surface as a visible alert (crucial while
  // we're still ironing out exact Xano field/endpoint names) and so the
  // sidebar's save indicator reflects real backend calls instead of a local
  // debounce like before.
  const withSave = async (fn) => {
    setSaveState("saving");
    try {
      const result = await fn();
      setSaveState("saved");
      setLastSyncAt(Date.now());
      return result;
    } catch (e) {
      setSaveState("error");
      window.alert(
        (e && e.message) ||
          "Une erreur est survenue en parlant au serveur. Vérifie ta connexion et réessaie."
      );
      throw e;
    }
  };

  // ---- fetch everything from Xano (used on login and on manual sync) ----
  const fetchAll = useCallback(async () => {
    const [rawDepots, rawProducts, rawTournees, rawUsers] = await Promise.all([
      depotsApi.list(),
      productsApi.list(),
      tourneesApi.list(),
      usersApi.list(),
    ]);
    const nextDepots = (rawDepots || []).map(depotFromXano);
    const nextProducts = (rawProducts || []).map(productFromXano);
    const nextTournees = (rawTournees || []).map(tourneeFromXano);
    const nextUsers = (rawUsers || []).map(userFromXano);
    setDepots(nextDepots);
    setProducts(nextProducts);
    setTournees(nextTournees);
    setUsers(nextUsers);
    failureKeysRef.current = collectFailureKeys(nextTournees);
  }, []);

  // ---- bootstrap: is there already a valid session on this device? ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = getToken();
      if (!token) {
        setLoaded(true);
        return;
      }
      try {
        const me = await authApi.me();
        if (cancelled) return;
        const user = userFromXano(me);
        setCurrentUser(user);
        setRole(user.role);
        await fetchAll();
      } catch (e) {
        setToken(null);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchAll]);

  // ---- create a first tournée automatically if none exist yet ----
  useEffect(() => {
    if (loaded && currentUser && tournees.length === 0 && depots.length > 0 && activeTourneeId === null) {
      // no-op placeholder: with a real backend we no longer auto-create an
      // empty tournée on every login — the exploitant creates one explicitly
      // from the Flotte tab. Left here intentionally empty so the effect
      // dependency list stays honest if this behaviour is revisited later.
    }
  }, [loaded, currentUser, tournees, depots, activeTourneeId]);

  // ---- keep the driver's selected tournée valid ----
  useEffect(() => {
    if (role !== "chauffeur") return;
    if (chauffeurTourneeId && tournees.find((t) => t.id === chauffeurTourneeId)) return;
    const next = tournees.find((t) => t.status !== "terminee") || tournees[0] || null;
    setChauffeurTourneeId(next ? next.id : null);
  }, [role, tournees, chauffeurTourneeId]);

  // manual "Synchronisation" — re-fetches everything from Xano right now,
  // instead of waiting for the next automatic poll
  const syncNow = useCallback(() => withSave(fetchAll), [fetchAll]);

  // ---- real-time-ish polling: exploitant devices re-check Xano every few
  // seconds so a driver's "échec" entered on another device shows up here as
  // a notification without a manual refresh. To avoid clobbering an
  // exploitant's in-progress edits, the pulled data is only applied to local
  // state while they're NOT on the route-builder tab.
  const tabRef = useRef(tab);
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  useEffect(() => {
    if (!loaded || !currentUser || currentUser.role !== "exploitant") return;
    const poll = async () => {
      try {
        const rawList = await tourneesApi.list();
        const freshTournees = (rawList || []).map(tourneeFromXano);

        const newFailures = [];
        freshTournees.forEach((t) => {
          Object.entries(t.timestamps || {}).forEach(([stopId, info]) => {
            if (!info || info.status !== "echec") return;
            const key = `${t.id}:${stopId}:${info.at}`;
            if (failureKeysRef.current && !failureKeysRef.current.has(key)) {
              failureKeysRef.current.add(key);
              const stop = t.stops.find((s) => s.id === stopId);
              newFailures.push({
                id: key,
                tourneeId: t.id,
                stopId,
                tourneeName: t.name,
                stopLabel: stop ? stop.clientName || stop.label || "Arrêt" : "Arrêt",
                comment: (t.comments && t.comments[stopId]) || "",
                at: info.at,
                read: false,
              });
            }
          });
        });

        if (tabRef.current !== "tournee") {
          setTournees(freshTournees);
        }

        if (newFailures.length) {
          setNotifications((prev) => [...newFailures, ...prev].slice(0, 50));
          setToasts((prev) => [...prev, ...newFailures.map((f) => ({ id: f.id, text: `Échec — ${f.tourneeName} : ${f.stopLabel}` }))]);
          newFailures.forEach((f) => {
            setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== f.id)), 7000);
          });
        }
      } catch (e) {
        // silent — a missed poll just tries again next interval
      }
    };
    const interval = setInterval(poll, 9000);
    return () => clearInterval(interval);
  }, [loaded, currentUser]);

  // ---- auth ----
  const login = async (email, password) => {
    setAuthError(null);
    try {
      const res = await authApi.login(email, password);
      setToken(res.authToken || res.token);
      const me = await authApi.me();
      const user = userFromXano(me);
      setCurrentUser(user);
      setRole(user.role || "exploitant");
      await fetchAll();
    } catch (e) {
      setToken(null);
      setAuthError((e && e.message) || "Connexion impossible.");
    }
  };

  // Only meant for bootstrapping the very first (admin) account. Subsequent
  // team members should be created by an exploitant from the Équipe tab.
  const signupFirstAccount = async (email, password, name) => {
    setAuthError(null);
    try {
      const res = await authApi.signup(email, password, name);
      setToken(res.authToken || res.token);
      const me = await authApi.me();
      let user = userFromXano(me);
      const list = await usersApi.list().catch(() => []);
      const isFirstEver = (list || []).length <= 1;
      if (isFirstEver && user.role !== "exploitant") {
        await usersApi.update(user.id, { role: "exploitant" }).catch(() => {});
        user = { ...user, role: "exploitant" };
      }
      setCurrentUser(user);
      setRole(user.role || "exploitant");
      await fetchAll();
    } catch (e) {
      setToken(null);
      setAuthError((e && e.message) || "Création de compte impossible.");
    }
  };

  const logout = () => {
    setToken(null);
    setCurrentUser(null);
    setTournees([]);
    setDepots([]);
    setProducts([]);
    setUsers([]);
    setNotifications([]);
    setActiveTourneeId(null);
    setChauffeurTourneeId(null);
  };

  // ---- dépôts ----
  const createDepot = (name, x, y) =>
    withSave(async () => {
      const raw = await depotsApi.create({ name: name && name.trim() ? name.trim() : "Dépôt", x, y });
      const d = depotFromXano(raw);
      setDepots((prev) => [...prev, d]);
      return d;
    });

  const deleteDepot = (id) =>
    withSave(async () => {
      if (depots.length <= 1) {
        window.alert("Impossible de supprimer le dernier dépôt.");
        return;
      }
      const fallback = depots.find((d) => d.id !== id);
      const affected = tournees.filter((t) => t.depotId === id);
      await Promise.all(affected.map((t) => tourneesApi.update(t.id, { depot_id: Number(fallback.id) })));
      await depotsApi.remove(id);
      setDepots((prev) => prev.filter((d) => d.id !== id));
      setTournees((prev) => prev.map((t) => (t.depotId === id ? { ...t, depotId: fallback.id } : t)));
    });

  // ---- équipe ----
  // Creates a real Xano account (hashed password) via the public signup
  // endpoint, WITHOUT touching our own session token, then sets the role.
  const createUser = (name, role_, email, password) =>
    withSave(async () => {
      await authApi.signup(email, password, name);
      const rawList = await usersApi.list();
      const match = (rawList || []).find((u) => u.email === email);
      if (match) {
        await usersApi.update(match.id, { role: role_ });
      }
      const refreshed = await usersApi.list();
      setUsers((refreshed || []).map(userFromXano));
    });

  const deleteUser = (id) =>
    withSave(async () => {
      await usersApi.remove(id);
      setUsers((prev) => prev.filter((u) => u.id !== id));
    });

  // ---- tournée-scoped mutations ----
  const updateTournee = (id, updater) => {
    setTournees((prev) => prev.map((t) => (t.id === id ? updater(t) : t)));
  };

  const createTournee = (name, driverName, vehicleName, depotId) =>
    withSave(async () => {
      const raw = await tourneesApi.create({
        name: name && name.trim() ? name.trim() : "Nouvelle tournée",
        driver_name: driverName || "",
        vehicle_name: vehicleName || "",
        depot_id: (depotId || (depots[0] && depots[0].id)) ? Number(depotId || depots[0].id) : null,
        status: "attente",
      });
      const t = tourneeFromXano(raw);
      setTournees((prev) => [...prev, t]);
      setActiveTourneeId(t.id);
      setTab("tournee");
      return t;
    });

  const duplicateTournee = (id) =>
    withSave(async () => {
      const source = tournees.find((t) => t.id === id);
      if (!source) return null;
      const rawT = await tourneesApi.create({
        name: `${source.name} (copie)`,
        driver_name: source.driverName,
        vehicle_name: source.vehicleName,
        depot_id: source.depotId ? Number(source.depotId) : null,
        status: "attente",
      });
      const newId = String(rawT.id);
      const seq = source.order ? source.order.map((i) => source.stops[i]) : source.stops;
      for (let i = 0; i < seq.length; i++) {
        const s = seq[i];
        await stopsApi.create({
          tournee_id: Number(newId),
          product_id: s.productId ? Number(s.productId) : null,
          label: s.label,
          client_name: s.clientName,
          time_slot: s.timeSlot,
          qty: s.qty,
          x: s.x,
          y: s.y,
          sequence: source.order ? i + 1 : null,
          status: "attente",
        });
      }
      if (source.order) {
        await tourneesApi.update(newId, { is_optimized: true });
      }
      await fetchAll();
      return newId;
    });

  const deleteTournee = (id) =>
    withSave(async () => {
      const t = tournees.find((tt) => tt.id === id);
      if (t) {
        await Promise.all(t.stops.map((s) => stopsApi.remove(s.id).catch(() => {})));
      }
      await tourneesApi.remove(id);
      setTournees((prev) => prev.filter((t) => t.id !== id));
      setActiveTourneeId((prev) => (prev === id ? null : prev));
    });

  const updateTourneeMeta = (id, patch) =>
    withSave(async () => {
      await tourneesApi.update(id, tourneeMetaToXano(patch));
      updateTournee(id, (t) => ({ ...t, ...patch }));
    });

  const addStop = (tourneeId, x, y, extra = {}) =>
    withSave(async () => {
      const raw = await stopsApi.create({
        tournee_id: Number(tourneeId),
        x,
        y,
        label: extra.label ?? null,
        client_name: extra.clientName || "",
        time_slot: extra.timeSlot || "",
        product_id: extra.productId ? Number(extra.productId) : null,
        qty: extra.qty || 1,
        status: "attente",
      });
      const newStop = {
        id: String(raw.id),
        x: raw.x,
        y: raw.y,
        label: raw.label,
        clientName: raw.client_name || "",
        timeSlot: raw.time_slot || "",
        productId: raw.product_id != null ? String(raw.product_id) : null,
        qty: raw.qty || 1,
      };
      updateTournee(tourneeId, (t) => ({
        ...t,
        stops: [...t.stops, newStop],
        statuses: { ...t.statuses, [newStop.id]: "attente" },
        order: null,
        naiveOrder: null,
      }));
      await tourneesApi.update(tourneeId, { is_optimized: false }).catch(() => {});
      return newStop;
    });

  const addStopsBulk = (tourneeId, newStops) =>
    withSave(async () => {
      const created = [];
      for (const s of newStops) {
        const raw = await stopsApi.create({
          tournee_id: Number(tourneeId),
          x: s.x,
          y: s.y,
          label: s.label,
          client_name: s.clientName || "",
          time_slot: s.timeSlot || "",
          product_id: s.productId ? Number(s.productId) : null,
          qty: s.qty || 1,
          status: "attente",
        });
        created.push({
          id: String(raw.id),
          x: raw.x,
          y: raw.y,
          label: raw.label,
          clientName: raw.client_name || "",
          timeSlot: raw.time_slot || "",
          productId: raw.product_id != null ? String(raw.product_id) : null,
          qty: raw.qty || 1,
        });
      }
      updateTournee(tourneeId, (t) => {
        const nextStatuses = { ...t.statuses };
        created.forEach((s) => (nextStatuses[s.id] = "attente"));
        return { ...t, stops: [...t.stops, ...created], statuses: nextStatuses, order: null, naiveOrder: null };
      });
      await tourneesApi.update(tourneeId, { is_optimized: false }).catch(() => {});
    });

  const removeStop = (tourneeId, id) =>
    withSave(async () => {
      await stopsApi.remove(id);
      updateTournee(tourneeId, (t) => {
        const nextStatuses = { ...t.statuses };
        delete nextStatuses[id];
        return { ...t, stops: t.stops.filter((s) => s.id !== id), statuses: nextStatuses, order: null, naiveOrder: null };
      });
      await tourneesApi.update(tourneeId, { is_optimized: false }).catch(() => {});
    });

  const updateStop = (tourneeId, id, patch) =>
    withSave(async () => {
      await stopsApi.update(id, stopToXano(patch));
      updateTournee(tourneeId, (t) => ({
        ...t,
        stops: t.stops.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      }));
    });

  const resetTournee = (tourneeId) =>
    withSave(async () => {
      const t = tournees.find((tt) => tt.id === tourneeId);
      if (t) {
        await Promise.all(t.stops.map((s) => stopsApi.remove(s.id).catch(() => {})));
      }
      await tourneesApi.update(tourneeId, { status: "attente", is_optimized: false, started_at: null, finished_at: null }).catch(() => {});
      updateTournee(tourneeId, (tt) => ({
        ...tt,
        stops: [],
        order: null,
        naiveOrder: null,
        statuses: {},
        comments: {},
        timestamps: {},
        status: "attente",
        startedAt: null,
        finishedAt: null,
      }));
      setDrawProgress(0);
    });

  const runOptimize = (tourneeId) => {
    const t = tournees.find((tt) => tt.id === tourneeId);
    if (!t || t.stops.length < 2) return;
    const depot = getDepot(depots, t.depotId);
    setOptimizing(true);
    setDrawProgress(0);
    const naive = t.stops.map((_, i) => i);
    updateTournee(tourneeId, (tt) => ({ ...tt, naiveOrder: naive }));
    setTimeout(() => {
      const nn = nearestNeighbor(t.stops, depot);
      const improved = twoOpt(nn, t.stops, depot);
      withSave(async () => {
        await Promise.all(improved.map((stopIdx, seqPos) => stopsApi.update(t.stops[stopIdx].id, { sequence: seqPos + 1 })));
        await tourneesApi.update(tourneeId, { is_optimized: true });
      })
        .catch(() => {})
        .finally(() => {
          updateTournee(tourneeId, (tt) => ({ ...tt, order: improved }));
          setOptimizing(false);
          let p = 0;
          const step = () => {
            p += 0.04;
            setDrawProgress(Math.min(p, 1));
            if (p < 1) requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
    }, 550);
  };

  const startTournee = (tourneeId) =>
    withSave(async () => {
      const t = tournees.find((tt) => tt.id === tourneeId);
      if (!t || t.status !== "attente") return;
      const now = Date.now();
      await tourneesApi.update(tourneeId, { status: "encours", started_at: now });
      updateTournee(tourneeId, (tt) => ({ ...tt, status: "encours", startedAt: now }));
    });

  // sets a stop's status; for "echec" a non-empty comment is required by callers
  const setStopStatus = (tourneeId, stopId, newStatus, comment = "") =>
    withSave(async () => {
      const t = tournees.find((tt) => tt.id === tourneeId);
      if (!t) return;
      const stop = t.stops.find((s) => s.id === stopId);
      const current = t.statuses[stopId] || "attente";
      const byName = currentUser ? currentUser.name : null;
      const now = Date.now();

      await stopsApi.update(stopId, {
        status: newStatus,
        comment: newStatus === "echec" ? comment : null,
        status_at: now,
        status_by: byName,
      });

      if (stop && stop.productId) {
        const wasDelivered = current === "livre";
        const willBeDelivered = newStatus === "livre";
        if (willBeDelivered !== wasDelivered) {
          const delta = willBeDelivered ? -(stop.qty || 1) : stop.qty || 1;
          const product = products.find((p) => p.id === stop.productId);
          if (product) {
            const newQty = Math.max(0, product.qty + delta);
            await productsApi.update(stop.productId, { qty: newQty }).catch(() => {});
            setProducts((pList) => pList.map((p) => (p.id === stop.productId ? { ...p, qty: newQty } : p)));
          }
        }
      }

      const nextStatuses = { ...t.statuses, [stopId]: newStatus };
      const seq = t.order ? t.order.map((i) => t.stops[i]) : t.stops;
      const allDone = seq.length > 0 && seq.every((s) => ["livre", "echec"].includes(nextStatuses[s.id] || "attente"));
      await tourneesApi
        .update(tourneeId, { status: allDone ? "terminee" : "encours", finished_at: allDone ? t.finishedAt || now : null })
        .catch(() => {});

      updateTournee(tourneeId, (tt) => {
        const nextComments = { ...tt.comments };
        if (newStatus === "echec") nextComments[stopId] = comment;
        else delete nextComments[stopId];
        return {
          ...tt,
          statuses: nextStatuses,
          comments: nextComments,
          timestamps: { ...tt.timestamps, [stopId]: { status: newStatus, at: now, by: byName } },
          status: allDone ? "terminee" : "encours",
          finishedAt: allDone ? tt.finishedAt || now : null,
        };
      });
    });

  const addProduct = (name, qty) =>
    withSave(async () => {
      if (!name.trim()) return;
      const raw = await productsApi.create({ name: name.trim(), qty: qty || 0 });
      setProducts((prev) => [...prev, productFromXano(raw)]);
    });

  const removeProduct = (id) =>
    withSave(async () => {
      const affectedStops = [];
      tournees.forEach((t) => t.stops.forEach((s) => s.productId === id && affectedStops.push(s.id)));
      await Promise.all(affectedStops.map((sid) => stopsApi.update(sid, { product_id: null }).catch(() => {})));
      await productsApi.remove(id);
      setProducts((prev) => prev.filter((p) => p.id !== id));
      setTournees((prev) =>
        prev.map((t) => ({
          ...t,
          stops: t.stops.map((s) => (s.productId === id ? { ...s, productId: null } : s)),
        }))
      );
    });

  const markNotificationsRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  const goToNotification = (n) => {
    setActiveTourneeId(n.tourneeId);
    setTab("suivi");
    setNotifications((prev) => prev.map((p) => (p.id === n.id ? { ...p, read: true } : p)));
  };

  const activeTournee = tournees.find((t) => t.id === activeTourneeId) || null;

  if (!loaded) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: COLORS.bg,
          color: COLORS.dim,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "'Inter', sans-serif",
          fontSize: 13,
          gap: 10,
        }}
      >
        <Loader2 size={16} className="spin" />
        Chargement des donn&eacute;es&hellip;
        <style>{`.spin { animation: spin 0.8s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  const globalStyle = (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap');
      * { box-sizing: border-box; }
      .mono { font-family: 'JetBrains Mono', monospace; }
      .display { font-family: 'Oswald', sans-serif; text-transform: uppercase; letter-spacing: 0.04em; }
      button { cursor: pointer; font-family: inherit; }
      button:disabled { cursor: not-allowed; opacity: 0.4; }
      select, input, textarea { font-family: inherit; }
      ::placeholder { color: #55606B; }
      .spin { animation: spin 0.8s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
    `}</style>
  );

  if (!currentUser) {
    return (
      <div style={{ minHeight: "100vh", background: COLORS.bg, color: COLORS.text, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>
        {globalStyle}
        <LoginScreen onLogin={login} onSignup={signupFirstAccount} authError={authError} />
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: COLORS.bg,
        color: COLORS.text,
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        display: "flex",
      }}
    >
      {globalStyle}
      <ToastStack toasts={toasts} />

      {role === "chauffeur" ? (
        <ChauffeurView
          tournees={tournees}
          depots={depots}
          chauffeurTourneeId={chauffeurTourneeId}
          setChauffeurTourneeId={setChauffeurTourneeId}
          products={products}
          setRole={setRole}
          currentUser={currentUser}
          logout={logout}
          startTournee={startTournee}
          setStopStatus={setStopStatus}
          syncNow={syncNow}
          saveState={saveState}
          lastSyncAt={lastSyncAt}
          createTournee={createTournee}
          requestPrint={requestPrint}
          addStop={addStop}
          removeStop={removeStop}
          runOptimize={runOptimize}
          optimizing={optimizing}
        />
      ) : (
        <>
          <Sidebar
            tab={tab}
            setTab={setTab}
            tournees={tournees}
            activeTournee={activeTournee}
            products={products}
            saveState={saveState}
            lastSyncAt={lastSyncAt}
            syncNow={syncNow}
            setRole={setRole}
            currentUser={currentUser}
            logout={logout}
            notifications={notifications}
            markNotificationsRead={markNotificationsRead}
            goToNotification={goToNotification}
          />

          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
            {tab === "flotte" && (
              <FlotteTab
                tournees={tournees}
                depots={depots}
                setActiveTourneeId={setActiveTourneeId}
                setTab={setTab}
                createTournee={createTournee}
                deleteTournee={deleteTournee}
              />
            )}
            {tab === "tournee" && (
              <TourneeTab
                tournee={activeTournee}
                tourneeId={activeTourneeId}
                tournees={tournees}
                depots={depots}
                setActiveTourneeId={setActiveTourneeId}
                createTournee={createTournee}
                optimizing={optimizing}
                drawProgress={drawProgress}
                products={products}
                addStop={addStop}
                addStopsBulk={addStopsBulk}
                removeStop={removeStop}
                updateStop={updateStop}
                resetTournee={resetTournee}
                runOptimize={runOptimize}
                updateTourneeMeta={updateTourneeMeta}
              />
            )}
            {tab === "suivi" && (
              <SuiviTab
                tournee={activeTournee}
                products={products}
                depots={depots}
                setStopStatus={setStopStatus}
                startTournee={startTournee}
                requestPrint={requestPrint}
              />
            )}
            {tab === "stock" && <StockTab products={products} addProduct={addProduct} removeProduct={removeProduct} />}
            {tab === "depots" && <DepotsTab depots={depots} tournees={tournees} createDepot={createDepot} deleteDepot={deleteDepot} />}
            {tab === "equipe" && (
              <UsersTab users={users} currentUser={currentUser} createUser={createUser} deleteUser={deleteUser} />
            )}
            {tab === "historique" && (
              <HistoriqueTab
                tournees={tournees}
                products={products}
                depots={depots}
                setActiveTourneeId={setActiveTourneeId}
                setTab={setTab}
                duplicateTournee={duplicateTournee}
                requestPrint={requestPrint}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
// ---------- sidebar nav ----------

function Sidebar({
  tab,
  setTab,
  tournees,
  activeTournee,
  products,
  saveState,
  lastSyncAt,
  syncNow,
  setRole,
  currentUser,
  logout,
  notifications,
  markNotificationsRead,
  goToNotification,
}) {
  const [showNotif, setShowNotif] = useState(false);
  const delivered = activeTournee
    ? Object.values(activeTournee.statuses).filter((s) => s === "livre").length
    : 0;
  const lowStock = products.filter((p) => p.qty < LOW_STOCK).length;
  const enCours = tournees.filter((t) => t.status === "encours").length;
  const unread = notifications.filter((n) => !n.read).length;

  const items = [
    { key: "flotte", label: "Flotte", icon: LayoutGrid, badge: enCours ? enCours : null },
    { key: "tournee", label: "Tournée", icon: Route },
    {
      key: "suivi",
      label: "Suivi",
      icon: Truck,
      badge: activeTournee && activeTournee.stops.length ? `${delivered}/${activeTournee.stops.length}` : null,
    },
    { key: "historique", label: "Historique", icon: History },
    { key: "stock", label: "Stock", icon: Package, badge: lowStock ? lowStock : null, alert: lowStock > 0 },
    { key: "depots", label: "Dépôts", icon: Warehouse },
    { key: "equipe", label: "Équipe", icon: Users },
  ];

  return (
    <div
      style={{
        width: 220,
        borderRight: `1px solid ${COLORS.border}`,
        padding: "20px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 4px 18px" }}>
        <div
          style={{
            width: 30,
            height: 30,
            background: COLORS.accent,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 4,
            flexShrink: 0,
          }}
        >
          <Zap size={16} color={COLORS.bg} strokeWidth={2.5} />
        </div>
        <div className="display" style={{ fontSize: 16, fontWeight: 600, flex: 1 }}>
          LogiSuite<span style={{ color: COLORS.accent }}>.</span>
        </div>
        <div style={{ position: "relative" }}>
          <button
            onClick={() => {
              setShowNotif((v) => !v);
              if (!showNotif) markNotificationsRead();
            }}
            title="Notifications"
            style={{
              position: "relative",
              background: showNotif ? "#1E252C" : "transparent",
              border: `1px solid ${COLORS.border}`,
              borderRadius: 6,
              padding: 7,
              display: "flex",
              color: COLORS.muted,
            }}
          >
            <Bell size={14} />
            {unread > 0 && (
              <span
                className="mono"
                style={{
                  position: "absolute",
                  top: -5,
                  right: -5,
                  background: COLORS.red,
                  color: "#fff",
                  fontSize: 9,
                  fontWeight: 700,
                  borderRadius: 8,
                  minWidth: 15,
                  height: 15,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "0 3px",
                }}
              >
                {unread}
              </span>
            )}
          </button>
          {showNotif && (
            <div
              style={{
                position: "absolute",
                top: "110%",
                right: 0,
                width: 280,
                maxHeight: 340,
                overflow: "auto",
                background: COLORS.panel,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 8,
                boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
                zIndex: 20,
                padding: 8,
              }}
            >
              <div className="display" style={{ fontSize: 11, color: COLORS.dim, padding: "4px 6px 8px" }}>
                Échecs signalés
              </div>
              {notifications.length === 0 ? (
                <div style={{ fontSize: 12, color: COLORS.dim, padding: "6px 6px 10px" }}>
                  Aucune notification pour le moment.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {notifications.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => {
                        goToNotification(n);
                        setShowNotif(false);
                      }}
                      style={{
                        textAlign: "left",
                        background: "transparent",
                        border: "none",
                        borderRadius: 5,
                        padding: "8px 8px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 2,
                      }}
                    >
                      <div style={{ fontSize: 12.5, color: COLORS.text, display: "flex", alignItems: "center", gap: 6 }}>
                        <AlertTriangle size={12} color={COLORS.red} />
                        {n.tourneeName} — {n.stopLabel}
                      </div>
                      {n.comment && (
                        <div style={{ fontSize: 11, color: COLORS.dim, paddingLeft: 18 }}>{n.comment}</div>
                      )}
                      <div className="mono" style={{ fontSize: 10, color: COLORS.dim, paddingLeft: 18 }}>
                        {new Date(n.at).toLocaleTimeString("fr-FR")}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <button
        onClick={() => setRole("chauffeur")}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 7,
          background: "transparent",
          border: `1px solid ${COLORS.border}`,
          color: COLORS.muted,
          borderRadius: 6,
          fontSize: 12,
          fontWeight: 500,
          padding: "8px 10px",
          marginBottom: 14,
        }}
      >
        <Truck size={14} />
        Passer en mode Chauffeur
      </button>

      {items.map(({ key, label, icon: Icon, badge, alert }) => (
        <button
          key={key}
          onClick={() => setTab(key)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 12px",
            borderRadius: 6,
            border: "none",
            background: tab === key ? "#1E252C" : "transparent",
            color: tab === key ? COLORS.text : COLORS.muted,
            fontSize: 13.5,
            fontWeight: 500,
            textAlign: "left",
            borderLeft: tab === key ? `2px solid ${COLORS.accent}` : "2px solid transparent",
          }}
        >
          <Icon size={16} color={tab === key ? COLORS.accent : COLORS.dim} />
          <span style={{ flex: 1 }}>{label}</span>
          {badge !== null && badge !== undefined && (
            <span
              className="mono"
              style={{
                fontSize: 10.5,
                background: alert ? "rgba(242,109,109,0.15)" : "#20262D",
                color: alert ? COLORS.red : COLORS.dim,
                padding: "2px 6px",
                borderRadius: 10,
              }}
            >
              {badge}
            </span>
          )}
        </button>
      ))}

      <div style={{ marginTop: "auto", padding: "14px 8px 0" }}>
        <button
          onClick={syncNow}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            width: "100%",
            background: "transparent",
            border: `1px solid ${COLORS.border}`,
            color: COLORS.muted,
            borderRadius: 5,
            fontSize: 11.5,
            padding: "7px 10px",
            marginBottom: 10,
          }}
        >
          <RefreshCw size={12} className={saveState === "saving" ? "spin" : ""} />
          Synchroniser
        </button>

        <div style={{ fontSize: 10.5, color: COLORS.dim, lineHeight: 1.6, marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: saveState === "error" ? COLORS.red : saveState === "saving" ? COLORS.accent : COLORS.green,
                flexShrink: 0,
              }}
            />
            <span className="mono">
              {saveState === "saving" ? "SAUVEGARDE…" : saveState === "error" ? "ERREUR DE SAUVEGARDE" : "SAUVEGARDÉ"}
            </span>
          </div>
          <div style={{ marginTop: 4 }}>
            {lastSyncAt
              ? `Dernière synchro : ${new Date(lastSyncAt).toLocaleTimeString("fr-FR")}`
              : "Sauvegardé sur ton compte Claude."}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderTop: `1px solid ${COLORS.border}`,
            paddingTop: 10,
          }}
        >
          <div
            style={{
              width: 26,
              height: 26,
              borderRadius: "50%",
              background: `${ROLE_META[currentUser.role].color}22`,
              color: ROLE_META[currentUser.role].color,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {currentUser.name.slice(0, 1).toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentUser.name}</div>
            <div style={{ fontSize: 10, color: COLORS.dim }}>{ROLE_META[currentUser.role].label}</div>
          </div>
          <button onClick={logout} title="Se déconnecter" style={{ background: "none", border: "none", color: COLORS.dim, padding: 4 }}>
            <LogOut size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- TAB 0: Flotte (exploitant dashboard) ----------

function FlotteTab({ tournees, depots, setActiveTourneeId, setTab, createTournee, deleteTournee }) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [driverName, setDriverName] = useState("");
  const [vehicleName, setVehicleName] = useState("");
  const [depotId, setDepotId] = useState(depots[0] ? depots[0].id : "");

  const open = (id, targetTab) => {
    setActiveTourneeId(id);
    setTab(targetTab);
  };

  const submit = () => {
    createTournee(name, driverName, vehicleName, depotId);
    setName("");
    setDriverName("");
    setVehicleName("");
    setShowForm(false);
  };

  const active = tournees.filter((t) => t.status !== "terminee");
  const counts = {
    attente: tournees.filter((t) => t.status === "attente").length,
    encours: tournees.filter((t) => t.status === "encours").length,
    terminee: tournees.filter((t) => t.status === "terminee").length,
  };

  return (
    <>
      <TopHeader title="Flotte" subtitle={`${active.length} tournée${active.length > 1 ? "s" : ""} active${active.length > 1 ? "s" : ""}`} />
      <div style={{ padding: 24, maxWidth: 780 }}>
        <div style={{ display: "flex", gap: 14, marginBottom: 22, flexWrap: "wrap" }}>
          <StatRow icon={<Circle size={15} color={COLORS.dim} />} label="En attente" value={counts.attente} />
          <StatRow icon={<PlayCircle size={15} color={COLORS.blue} />} label="En cours" value={counts.encours} />
          <StatRow icon={<CheckCircle2 size={15} color={COLORS.green} />} label="Terminées" value={counts.terminee} />
        </div>

        {showForm ? (
          <div
            style={{
              background: COLORS.panel,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 6,
              padding: 14,
              marginBottom: 18,
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <input
              placeholder="Nom de la tournée"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={inputStyle({ flex: "1 1 160px" })}
            />
            <input
              placeholder="Chauffeur"
              value={driverName}
              onChange={(e) => setDriverName(e.target.value)}
              style={inputStyle({ flex: "1 1 140px" })}
            />
            <input
              placeholder="Véhicule"
              value={vehicleName}
              onChange={(e) => setVehicleName(e.target.value)}
              style={inputStyle({ flex: "1 1 140px" })}
            />
            <select value={depotId} onChange={(e) => setDepotId(e.target.value)} style={{ ...inputStyle({ flex: "1 1 160px" }), background: COLORS.bg }}>
              {depots.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <button onClick={submit} className="display" style={accentButtonStyle()}>
              <Plus size={14} strokeWidth={2.5} />
              Créer
            </button>
            <button onClick={() => setShowForm(false)} style={ghostButtonStyle()}>
              Annuler
            </button>
          </div>
        ) : (
          <button onClick={() => setShowForm(true)} className="display" style={{ ...accentButtonStyle(), marginBottom: 18 }}>
            <Plus size={14} strokeWidth={2.5} />
            Nouvelle tournée
          </button>
        )}

        {active.length === 0 ? (
          <div style={{ border: `1px dashed ${COLORS.border}`, borderRadius: 6, padding: 18, fontSize: 13, color: COLORS.dim }}>
            Aucune tournée active pour le moment.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {active.map((t) => {
              const meta = TOURNEE_STATUS_META[t.status];
              const delivered = Object.values(t.statuses).filter((s) => s === "livre").length;
              const failed = Object.values(t.statuses).filter((s) => s === "echec").length;
              const depot = getDepot(depots, t.depotId);
              return (
                <div
                  key={t.id}
                  style={{
                    background: COLORS.panel,
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 6,
                    padding: "14px 16px",
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ flex: "1 1 200px", minWidth: 160 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{t.name}</div>
                    <div style={{ fontSize: 11.5, color: COLORS.dim, display: "flex", alignItems: "center", gap: 6, marginTop: 2, flexWrap: "wrap" }}>
                      <User size={11} />
                      {t.driverName || "Chauffeur non assigné"}
                      {t.vehicleName ? ` · ${t.vehicleName}` : ""}
                      <Warehouse size={11} style={{ marginLeft: 6 }} />
                      {depot.name}
                    </div>
                  </div>
                  <div className="mono" style={{ fontSize: 11.5, color: COLORS.muted, width: 110 }}>
                    {t.stops.length} arrêt{t.stops.length > 1 ? "s" : ""}
                  </div>
                  <div className="mono" style={{ fontSize: 11.5, color: COLORS.muted, width: 130 }}>
                    {delivered} livré{delivered > 1 ? "s" : ""}
                    {failed > 0 ? `, ${failed} échec${failed > 1 ? "s" : ""}` : ""}
                  </div>
                  <span
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      color: meta.color,
                      background: `${meta.color}18`,
                      padding: "3px 9px",
                      borderRadius: 10,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {meta.label}
                  </span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <SmallBtn icon={Route} label="Ouvrir" onClick={() => open(t.id, "tournee")} />
                    <SmallBtn icon={Truck} label="Suivi" onClick={() => open(t.id, "suivi")} />
                    <button
                      onClick={() => {
                        if (window.confirm(`Supprimer la tournée « ${t.name} » ? Cette action est irréversible.`)) {
                          deleteTournee(t.id);
                        }
                      }}
                      style={{ background: "none", border: "none", color: COLORS.dim, padding: 4 }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p style={{ fontSize: 11.5, color: COLORS.dim, marginTop: 16 }}>
          Les tournées terminées sont archivées dans l'onglet <strong style={{ color: COLORS.text }}>Historique</strong>.
        </p>
      </div>
    </>
  );
}

function inputStyle(extra = {}) {
  return {
    minWidth: 100,
    background: COLORS.bg,
    border: `1px solid ${COLORS.border}`,
    color: COLORS.text,
    borderRadius: 5,
    padding: "9px 12px",
    fontSize: 13,
    ...extra,
  };
}

function accentButtonStyle(extra = {}) {
  return {
    background: COLORS.accent,
    color: COLORS.bg,
    border: "none",
    borderRadius: 5,
    padding: "9px 16px",
    fontSize: 12.5,
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    gap: 6,
    ...extra,
  };
}

function ghostButtonStyle(extra = {}) {
  return {
    background: "transparent",
    color: COLORS.muted,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 5,
    padding: "9px 14px",
    fontSize: 12.5,
    ...extra,
  };
}

// ---------- TAB 1: Tournée (builder) ----------
function TourneeTab(props) {
  const {
    tournee,
    tourneeId,
    tournees,
    depots,
    setActiveTourneeId,
    createTournee,
    optimizing,
    drawProgress,
    products,
    addStop,
    addStopsBulk,
    removeStop,
    updateStop,
    resetTournee,
    runOptimize,
    updateTourneeMeta,
  } = props;
  const svgRef = useRef(null);
  const fileInputRef = useRef(null);
  const [importError, setImportError] = useState(null);

  // Hooks must always run in the same order on every render, so these are
  // derived with safe fallbacks *before* the early return below rather than
  // bailing out first (that previously caused a "rendered more hooks than
  // during the previous render" crash whenever `tournee` was null).
  const stops = tournee ? tournee.stops : [];
  const order = tournee ? tournee.order : null;
  const naiveOrder = tournee ? tournee.naiveOrder : null;
  const depot = getDepot(depots, tournee ? tournee.depotId : null);

  const handleCanvasClick = useCallback(
    (e) => {
      if (!tournee || optimizing || stops.length >= MAX_STOPS) return;
      const rect = svgRef.current.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      if (dist({ x, y }, depot) < 6) return;
      addStop(tourneeId, x, y);
    },
    [tournee, stops, optimizing, addStop, depot, tourneeId]
  );

  const naiveDist = useMemo(
    () => (naiveOrder ? pathLength(naiveOrder, stops, depot) * KM_PER_UNIT : 0),
    [naiveOrder, stops, depot]
  );
  const optDist = useMemo(
    () => (order ? pathLength(order, stops, depot) * KM_PER_UNIT : 0),
    [order, stops, depot]
  );

  if (!tournee) {
    return (
      <>
        <TopHeader title="Tournée" subtitle="Aucune tournée sélectionnée" />
        <div style={{ padding: 24 }}>
          <div style={{ border: `1px dashed ${COLORS.border}`, borderRadius: 6, padding: 22, fontSize: 13, color: COLORS.muted, maxWidth: 420, display: "flex", flexDirection: "column", gap: 12 }}>
            <span>Crée une tournée pour commencer.</span>
            <button
              onClick={() => createTournee("", "", "")}
              className="display"
              style={{ ...accentButtonStyle(), alignSelf: "flex-start" }}
            >
              <Plus size={14} strokeWidth={2.5} />
              Nouvelle tournée
            </button>
          </div>
        </div>
      </>
    );
  }

  const handleCsvFile = (file) => {
    setImportError(null);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        try {
          const rows = results.data;
          const room = MAX_STOPS - stops.length;
          if (room <= 0) {
            setImportError(`Limite de ${MAX_STOPS} arrêts atteinte.`);
            return;
          }
          const newStops = rows.slice(0, room).map((row) => {
            const keys = Object.keys(row).reduce((acc, k) => {
              acc[k.trim().toLowerCase()] = row[k];
              return acc;
            }, {});
            const label = (keys["adresse"] || keys["address"] || "Adresse sans nom").trim();
            const pos = hashPosition(label, depot);
            const productName = (keys["produit"] || keys["article"] || "").trim();
            const match = productName
              ? products.find((p) => p.name.toLowerCase() === productName.toLowerCase())
              : null;
            const qty = parseInt(keys["quantite"] || keys["quantité"] || keys["qty"], 10) || 1;
            const clientName = (keys["client"] || keys["nomclient"] || keys["destinataire"] || "").trim();
            const timeSlot = (keys["creneau"] || keys["créneau"] || keys["horaire"] || keys["plage"] || "").trim();
            return {
              id: uid(),
              x: pos.x,
              y: pos.y,
              label,
              clientName,
              timeSlot,
              productId: match ? match.id : null,
              qty,
            };
          });
          if (newStops.length === 0) {
            setImportError("Aucune ligne valide trouvée dans ce fichier.");
            return;
          }
          addStopsBulk(tourneeId, newStops);
          if (rows.length > room) {
            setImportError(`Seuls les ${room} premiers arrêts ont été importés (limite de ${MAX_STOPS}).`);
          }
        } catch (e) {
          setImportError("Le fichier n'a pas pu être lu. Vérifie qu'il contient bien une colonne 'adresse'.");
        }
      },
      error: () => setImportError("Le fichier n'a pas pu être lu."),
    });
  };

  const downloadTemplate = () => {
    const sample =
      "adresse,client,creneau,produit,quantite\n" +
      "12 rue des Lilas, Strasbourg,Boulangerie Muller,08:00-10:00,Colis standard,2\n" +
      "5 avenue Foch, Strasbourg,Garage Weber,10:00-12:00,Palette,1\n" +
      "8 place Kléber, Strasbourg,Librairie Kléber,14:00-16:00,Colis standard,3\n";
    const blob = new Blob([sample], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "modele-tournee.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const savings = naiveDist > 0 ? ((naiveDist - optDist) / naiveDist) * 100 : 0;
  const timeSavedMin = ((naiveDist - optDist) / SPEED_KMH) * 60;
  const fuelSaved = (naiveDist - optDist) * LITERS_PER_KM;

  const routePoints = order ? [depot, ...order.map((i) => stops[i])] : null;
  const pathD = (pts) => (pts && pts.length ? "M " + pts.map((p) => `${p.x} ${p.y}`).join(" L ") : "");

  const displayList = order ? order.map((i) => stops[i]) : stops;

  const tourneeIdx = tournees.findIndex((t) => t.id === tourneeId);
  const goToOffset = (offset) => {
    if (tournees.length === 0) return;
    const nextIdx = (tourneeIdx + offset + tournees.length) % tournees.length;
    setActiveTourneeId(tournees[nextIdx].id);
  };

  return (
    <>
      <TopHeader title="Tournée" subtitle={`${stops.length}/${MAX_STOPS} arrêts placés`} />
      <div style={{ padding: "18px 24px 0" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              border: `1px solid ${COLORS.border}`,
              borderRadius: 5,
              overflow: "hidden",
            }}
          >
            <button
              onClick={() => goToOffset(-1)}
              disabled={tournees.length < 2}
              title="Tournée précédente"
              style={{ background: "transparent", border: "none", color: COLORS.muted, padding: "9px 8px", display: "flex" }}
            >
              <ChevronLeft size={14} />
            </button>
            <select
              value={tourneeId || ""}
              onChange={(e) => setActiveTourneeId(e.target.value)}
              className="mono"
              style={{
                background: COLORS.panel,
                border: "none",
                borderLeft: `1px solid ${COLORS.border}`,
                borderRight: `1px solid ${COLORS.border}`,
                color: COLORS.text,
                padding: "9px 10px",
                fontSize: 12.5,
                minWidth: 170,
              }}
            >
              {tournees.map((t, i) => (
                <option key={t.id} value={t.id}>
                  {i + 1}. {t.name}
                  {t.driverName ? ` — ${t.driverName}` : ""}
                </option>
              ))}
            </select>
            <button
              onClick={() => goToOffset(1)}
              disabled={tournees.length < 2}
              title="Tournée suivante"
              style={{ background: "transparent", border: "none", color: COLORS.muted, padding: "9px 8px", display: "flex" }}
            >
              <ChevronRight size={14} />
            </button>
          </div>
          <span className="mono" style={{ fontSize: 11, color: COLORS.dim }}>
            {tourneeIdx + 1}/{tournees.length}
          </span>
          <button onClick={() => createTournee("", "", "")} style={ghostButtonStyle({ display: "flex", alignItems: "center", gap: 6 })}>
            <Plus size={13} />
            Nouvelle tournée
          </button>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            placeholder="Nom de la tournée"
            value={tournee.name}
            onChange={(e) => updateTourneeMeta(tourneeId, { name: e.target.value })}
            style={inputStyle({ flex: "1 1 160px" })}
          />
          <input
            placeholder="Chauffeur assigné"
            value={tournee.driverName}
            onChange={(e) => updateTourneeMeta(tourneeId, { driverName: e.target.value })}
            style={inputStyle({ flex: "1 1 140px" })}
          />
          <input
            placeholder="Véhicule"
            value={tournee.vehicleName}
            onChange={(e) => updateTourneeMeta(tourneeId, { vehicleName: e.target.value })}
            style={inputStyle({ flex: "1 1 140px" })}
          />
          <select
            value={tournee.depotId || ""}
            onChange={(e) => updateTourneeMeta(tourneeId, { depotId: e.target.value, order: null, naiveOrder: null })}
            style={{ ...inputStyle({ flex: "1 1 160px" }), background: COLORS.bg }}
            title="Dépôt de départ"
          >
            {depots.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div style={{ flex: 1, display: "flex", flexWrap: "wrap", overflow: "auto" }}>
        <div style={{ flex: "1 1 520px", padding: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
            <p style={{ fontSize: 13, color: COLORS.muted, margin: 0, maxWidth: 400 }}>
              Clique sur la carte pour poser un arr&ecirc;t, ou importe une liste d'adresses en une fois.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                style={{ display: "none" }}
                onChange={(e) => {
                  if (e.target.files[0]) handleCsvFile(e.target.files[0]);
                  e.target.value = "";
                }}
              />
              <SmallBtn icon={Upload} label="Importer un CSV" onClick={() => fileInputRef.current.click()} />
              <SmallBtn icon={Download} label="Modèle" onClick={downloadTemplate} />
            </div>
          </div>

          {importError && (
            <div
              style={{
                fontSize: 12,
                color: COLORS.red,
                background: "rgba(242,109,109,0.1)",
                border: "1px solid rgba(242,109,109,0.3)",
                borderRadius: 5,
                padding: "8px 12px",
                marginBottom: 10,
              }}
            >
              {importError}
            </div>
          )}

          <MapView
            svgRef={svgRef}
            onClick={handleCanvasClick}
            depot={depot}
            stops={stops}
            order={order}
            naiveOrder={naiveOrder}
            routePoints={routePoints}
            pathD={pathD}
            drawProgress={drawProgress}
            optimizing={optimizing}
            removeStop={(id) => removeStop(tourneeId, id)}
          />

          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <button
              onClick={() => runOptimize(tourneeId)}
              disabled={stops.length < 2 || optimizing}
              className="display"
              style={{
                background: COLORS.accent,
                color: COLORS.bg,
                border: "none",
                padding: "11px 20px",
                borderRadius: 5,
                fontWeight: 600,
                fontSize: 13,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Zap size={15} strokeWidth={2.5} />
              {optimizing ? "Calcul en cours…" : "Optimiser la tournée"}
            </button>
            <button
              onClick={() => resetTournee(tourneeId)}
              style={{
                background: "transparent",
                color: COLORS.muted,
                border: `1px solid ${COLORS.border}`,
                padding: "11px 16px",
                borderRadius: 5,
                fontSize: 13,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <RotateCcw size={14} />
              R&eacute;initialiser
            </button>
          </div>

          {order && (
            <div style={{ display: "flex", gap: 14, marginTop: 20, flexWrap: "wrap" }}>
              <StatRow icon={<TrendingDown size={15} color={COLORS.accent} />} label="Distance" value={`${optDist.toFixed(1)} km`} sub={`vs ${naiveDist.toFixed(1)} km`} />
              <StatRow icon={<Clock size={15} color={COLORS.accent} />} label="Temps gagné" value={`${Math.max(timeSavedMin, 0).toFixed(0)} min`} sub={`à ${SPEED_KMH} km/h`} />
              <StatRow icon={<Fuel size={15} color={COLORS.accent} />} label="Carburant" value={`${Math.max(fuelSaved, 0).toFixed(2)} L`} sub={`-${Math.max(savings, 0).toFixed(0)}%`} />
            </div>
          )}
        </div>

        <div style={{ flex: "1 1 320px", maxWidth: 380, borderLeft: `1px solid ${COLORS.border}`, padding: 24 }}>
          <div className="display" style={{ fontSize: 12.5, color: COLORS.dim, marginBottom: 12 }}>
            Arr&ecirc;ts {order ? "(ordre optimisé)" : ""}
          </div>
          {stops.length === 0 ? (
            <div style={{ border: `1px dashed ${COLORS.border}`, borderRadius: 6, padding: 18, fontSize: 13, color: COLORS.dim }}>
              Aucun arr&ecirc;t pour le moment. Clique sur la carte ou importe un CSV.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 560, overflow: "auto" }}>
              {displayList.map((s, idx) => (
                <div
                  key={s.id}
                  style={{
                    background: COLORS.panel,
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 6,
                    padding: "10px 12px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="mono" style={{ color: COLORS.accent, fontSize: 12, width: 16, flexShrink: 0 }}>
                      {idx + 1}
                    </span>
                    <MapPin size={13} color={COLORS.dim} style={{ flexShrink: 0 }} />
                    <span style={{ fontSize: 12.5, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.label || "Arrêt manuel"}
                    </span>
                    <button onClick={() => removeStop(tourneeId, s.id)} style={{ background: "none", border: "none", color: COLORS.dim, padding: 2, flexShrink: 0 }}>
                      <X size={13} />
                    </button>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      placeholder="Nom du client"
                      value={s.clientName || ""}
                      onChange={(e) => updateStop(tourneeId, s.id, { clientName: e.target.value })}
                      style={inputStyle({ flex: 1, padding: "6px 8px", fontSize: 12 })}
                    />
                    <input
                      placeholder="Créneau (08:00-10:00)"
                      value={s.timeSlot || ""}
                      onChange={(e) => updateStop(tourneeId, s.id, { timeSlot: e.target.value })}
                      style={inputStyle({ flex: 1, padding: "6px 8px", fontSize: 12 })}
                    />
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <select
                      value={s.productId || ""}
                      onChange={(e) => updateStop(tourneeId, s.id, { productId: e.target.value || null })}
                      style={{
                        flex: 1,
                        background: COLORS.bg,
                        border: `1px solid ${COLORS.border}`,
                        color: COLORS.text,
                        borderRadius: 4,
                        fontSize: 12,
                        padding: "6px 8px",
                      }}
                    >
                      <option value="">Aucun article lié</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    {s.productId && (
                      <input
                        type="number"
                        min={1}
                        value={s.qty}
                        onChange={(e) => {
                          const val = e.target.value;
                          updateStop(tourneeId, s.id, { qty: val === "" ? "" : parseInt(val, 10) });
                        }}
                        onBlur={(e) => {
                          const val = parseInt(e.target.value, 10);
                          updateStop(tourneeId, s.id, { qty: !val || val < 1 ? 1 : val });
                        }}
                        style={{
                          width: 52,
                          background: COLORS.bg,
                          border: `1px solid ${COLORS.border}`,
                          color: COLORS.text,
                          borderRadius: 4,
                          fontSize: 12,
                          padding: "6px 8px",
                        }}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function SmallBtn({ icon: Icon, label, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "transparent",
        border: `1px solid ${COLORS.border}`,
        color: COLORS.muted,
        borderRadius: 5,
        fontSize: 11.5,
        padding: "7px 10px",
        whiteSpace: "nowrap",
      }}
    >
      <Icon size={13} />
      {label}
    </button>
  );
}

// ---------- polished map ----------
function MapView({ svgRef, onClick, depot, stops, order, naiveOrder, routePoints, pathD, drawProgress, optimizing, removeStop }) {
  return (
    <div style={{ position: "relative" }}>
      <svg
        ref={svgRef}
        viewBox="0 0 100 100"
        onClick={onClick}
        style={{
          width: "100%",
          aspectRatio: "1.5 / 1",
          background: COLORS.panel,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 6,
          cursor: optimizing ? "wait" : "crosshair",
        }}
      >
        <defs>
          <pattern id="grid" width="5" height="5" patternUnits="userSpaceOnUse">
            <path d="M 5 0 L 0 0 0 5" fill="none" stroke="#20262D" strokeWidth="0.15" />
          </pattern>
        </defs>
        <rect width="100" height="100" fill="url(#grid)" />
        {/* faint avenue lines for a city-map feel */}
        <line x1="0" y1="30" x2="100" y2="30" stroke="#20262D" strokeWidth="0.4" />
        <line x1="0" y1="72" x2="100" y2="72" stroke="#20262D" strokeWidth="0.4" />
        <line x1="26" y1="0" x2="26" y2="100" stroke="#20262D" strokeWidth="0.4" />
        <line x1="68" y1="0" x2="68" y2="100" stroke="#20262D" strokeWidth="0.4" />

        {naiveOrder && !order && (
          <path
            d={pathD([depot, ...naiveOrder.map((i) => stops[i])])}
            fill="none"
            stroke={COLORS.dim}
            strokeWidth="0.6"
            strokeDasharray="1.2 1.2"
          />
        )}

        {routePoints && (
          <path
            d={pathD(routePoints)}
            fill="none"
            stroke={COLORS.accent}
            strokeWidth="0.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={100}
            style={{ strokeDasharray: 100, strokeDashoffset: 100 - drawProgress * 100 }}
          />
        )}

        <g transform={`translate(${depot.x}, ${depot.y})`}>
          <circle r="4.2" fill={COLORS.bg} stroke={COLORS.accent} strokeWidth="0.6" />
          <text x="0" y="1.4" textAnchor="middle" fontSize="4" fill={COLORS.accent} fontWeight="700">
            D
          </text>
        </g>

        {stops.map((s, i) => {
          const seq = order ? order.indexOf(i) + 1 : null;
          return (
            <g key={s.id} transform={`translate(${s.x}, ${s.y})`}>
              <title>{s.label || `Arrêt ${i + 1}`}</title>
              <circle
                r="2.8"
                fill={order ? "#1C2229" : "#232A31"}
                stroke={order ? COLORS.accent : COLORS.dim}
                strokeWidth="0.5"
                onClick={(e) => {
                  e.stopPropagation();
                  removeStop(s.id);
                }}
                style={{ cursor: "pointer" }}
              />
              <text x="0" y="1" textAnchor="middle" fontSize="2.8" fill={COLORS.text} fontWeight="600" style={{ pointerEvents: "none" }}>
                {seq || i + 1}
              </text>
            </g>
          );
        })}
      </svg>

      {/* scale bar + compass, dispatch-board styling */}
      <div style={{ position: "absolute", bottom: 10, left: 12, display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{ width: 34, height: 2, background: COLORS.dim }} />
        <span className="mono" style={{ fontSize: 9.5, color: COLORS.dim }}>
          &asymp; {(34 * 0.01 * (100 * KM_PER_UNIT)).toFixed(1)} km
        </span>
      </div>
      <div style={{ position: "absolute", top: 10, right: 12, display: "flex", alignItems: "center", gap: 4, color: COLORS.dim }}>
        <Compass size={13} />
        <span className="mono" style={{ fontSize: 9.5 }}>N</span>
      </div>
    </div>
  );
}

// ---------- TAB 2: Suivi (TMS light) ----------
const STATUS_META = {
  attente: { label: "En attente", color: COLORS.dim, icon: Circle },
  encours: { label: "En cours", color: COLORS.blue, icon: PlayCircle },
  livre: { label: "Livré", color: COLORS.green, icon: CheckCircle2 },
  echec: { label: "Échec", color: COLORS.red, icon: AlertTriangle },
};

function SuiviTab({ tournee, products, depots, setStopStatus, startTournee, requestPrint }) {
  const [echecDraft, setEchecDraft] = useState({});

  if (!tournee) {
    return (
      <>
        <TopHeader title="Suivi" subtitle="Suivi des livraisons" />
        <div style={{ padding: 24 }}>
          <div style={{ border: `1px dashed ${COLORS.border}`, borderRadius: 6, padding: 22, fontSize: 13, color: COLORS.muted, maxWidth: 420 }}>
            Crée une tournée depuis l'onglet <strong style={{ color: COLORS.text }}>Flotte</strong> pour commencer.
          </div>
        </div>
      </>
    );
  }

  if (!tournee.order) {
    return (
      <>
        <TopHeader title="Suivi" subtitle={tournee.name} />
        <div style={{ padding: 24 }}>
          <div style={{ border: `1px dashed ${COLORS.border}`, borderRadius: 6, padding: 22, fontSize: 13, color: COLORS.muted, maxWidth: 420 }}>
            Optimise d'abord cette tournée dans l'onglet <strong style={{ color: COLORS.text }}>Tourn&eacute;e</strong> pour
            voir appara&icirc;tre la liste des livraisons ici.
          </div>
        </div>
      </>
    );
  }

  const sequence = tournee.order.map((i) => tournee.stops[i]);
  const done = sequence.filter((s) => tournee.statuses[s.id] === "livre" || tournee.statuses[s.id] === "echec").length;
  const pct = sequence.length ? Math.round((done / sequence.length) * 100) : 0;

  const handleStatusChange = (stopId, nextStatus) => {
    if (nextStatus === "echec") {
      setEchecDraft((prev) => ({ ...prev, [stopId]: prev[stopId] ?? (tournee.comments[stopId] || "") }));
      return;
    }
    setEchecDraft((prev) => {
      const n = { ...prev };
      delete n[stopId];
      return n;
    });
    setStopStatus(tournee.id, stopId, nextStatus);
  };

  const confirmEchec = (stopId) => {
    const comment = (echecDraft[stopId] || "").trim();
    if (!comment) return;
    setStopStatus(tournee.id, stopId, "echec", comment);
    setEchecDraft((prev) => {
      const n = { ...prev };
      delete n[stopId];
      return n;
    });
  };

  const cancelEchec = (stopId) =>
    setEchecDraft((prev) => {
      const n = { ...prev };
      delete n[stopId];
      return n;
    });

  return (
    <>
      <TopHeader title="Suivi" subtitle={`${tournee.name} — ${done}/${sequence.length} arrêts traités`} />
      <div style={{ padding: 24, maxWidth: 640 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
          {tournee.status === "attente" && (
            <button onClick={() => startTournee(tournee.id)} className="display" style={accentButtonStyle()}>
              <PlayCircle size={14} />
              Commencer la tournée
            </button>
          )}
          <SmallBtn icon={Printer} label="Exporter le carnet (PDF)" onClick={() => requestPrint(tournee, products, depots)} />
        </div>

        <div style={{ marginBottom: 20 }}>
          <div style={{ height: 6, background: COLORS.panel, borderRadius: 3, overflow: "hidden", border: `1px solid ${COLORS.border}` }}>
            <div style={{ height: "100%", width: `${pct}%`, background: COLORS.accent, transition: "width 0.4s ease" }} />
          </div>
          <div className="mono" style={{ fontSize: 11, color: COLORS.dim, marginTop: 6 }}>
            {pct}% DE LA TOURN&Eacute;E TRAIT&Eacute;E
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sequence.map((s, idx) => {
            const status = tournee.statuses[s.id] || "attente";
            const meta = STATUS_META[status];
            const Icon = meta.icon;
            const product = products.find((p) => p.id === s.productId);
            const drafting = echecDraft[s.id] !== undefined;
            return (
              <div
                key={s.id}
                style={{
                  background: COLORS.panel,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 6,
                  padding: "12px 14px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <span className="mono" style={{ color: COLORS.accent, fontSize: 12, width: 18 }}>
                    {idx + 1}
                  </span>
                  <Icon size={16} color={meta.color} />
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <div style={{ fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.label || `Arrêt ${idx + 1}`}
                      {s.clientName ? ` — ${s.clientName}` : ""}
                    </div>
                    <div style={{ fontSize: 11.5, color: COLORS.dim }}>
                      {product ? `${s.qty} × ${product.name}` : "Sans article lié"}
                      {s.timeSlot ? ` · ${s.timeSlot}` : ""}
                    </div>
                  </div>
                  <StatusSwitcher current={status} onChange={(next) => handleStatusChange(s.id, next)} />
                </div>

                {drafting && (
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <textarea
                      autoFocus
                      placeholder="Motif de l'échec (obligatoire) : client absent, accès impossible…"
                      value={echecDraft[s.id]}
                      onChange={(e) => setEchecDraft((prev) => ({ ...prev, [s.id]: e.target.value }))}
                      style={{
                        flex: 1,
                        minWidth: 200,
                        minHeight: 50,
                        background: COLORS.bg,
                        border: `1px solid ${COLORS.red}`,
                        color: COLORS.text,
                        borderRadius: 5,
                        fontSize: 12,
                        padding: "8px 10px",
                        resize: "vertical",
                      }}
                    />
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <button
                        onClick={() => confirmEchec(s.id)}
                        disabled={!echecDraft[s.id] || !echecDraft[s.id].trim()}
                        style={{
                          background: COLORS.red,
                          color: "#fff",
                          border: "none",
                          borderRadius: 5,
                          padding: "7px 12px",
                          fontSize: 11.5,
                          fontWeight: 600,
                        }}
                      >
                        Confirmer l'échec
                      </button>
                      <button onClick={() => cancelEchec(s.id)} style={ghostButtonStyle({ padding: "6px 12px", fontSize: 11.5 })}>
                        Annuler
                      </button>
                    </div>
                  </div>
                )}

                {!drafting && tournee.comments[s.id] && (
                  <div style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 11.5, color: COLORS.red }}>
                    <MessageSquare size={12} style={{ marginTop: 2, flexShrink: 0 }} />
                    {tournee.comments[s.id]}
                    {tournee.timestamps[s.id] && tournee.timestamps[s.id].by && (
                      <span style={{ color: COLORS.dim }}>&nbsp;— signalé par {tournee.timestamps[s.id].by}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <p style={{ fontSize: 11.5, color: COLORS.dim, marginTop: 16, lineHeight: 1.5 }}>
          Un statut n'est jamais d&eacute;finitif &mdash; clique sur un autre statut &agrave; tout moment
          pour corriger une erreur. Si tu annules un &laquo;&nbsp;Livr&eacute;&nbsp;&raquo;, l'article
          concern&eacute; est automatiquement r&eacute;int&eacute;gr&eacute; au stock.
        </p>
      </div>
    </>
  );
}

function StatusSwitcher({ current, onChange }) {
  const order = ["attente", "encours", "livre", "echec"];
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {order.map((key) => {
        const meta = STATUS_META[key];
        const Icon = meta.icon;
        const active = key === current;
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            title={meta.label}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              background: active ? `${meta.color}22` : "transparent",
              border: `1px solid ${active ? meta.color : COLORS.border}`,
              color: active ? meta.color : COLORS.dim,
              borderRadius: 4,
              fontSize: 11,
              padding: "5px 8px",
              fontWeight: 500,
            }}
          >
            <Icon size={12} />
            {active && <span>{meta.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ---------- TAB 3: Stock (WMS light) ----------
function StockTab({ products, addProduct, removeProduct }) {
  const [name, setName] = useState("");
  const [qty, setQty] = useState(10);

  return (
    <>
      <TopHeader title="Stock" subtitle={`${products.length} références`} />
      <div style={{ padding: 24, maxWidth: 640 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          <input
            placeholder="Nom de l'article"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              flex: 1,
              minWidth: 160,
              background: COLORS.panel,
              border: `1px solid ${COLORS.border}`,
              color: COLORS.text,
              borderRadius: 5,
              padding: "9px 12px",
              fontSize: 13,
            }}
          />
          <input
            type="number"
            min={0}
            value={qty}
            onChange={(e) => setQty(parseInt(e.target.value) || 0)}
            style={{
              width: 90,
              background: COLORS.panel,
              border: `1px solid ${COLORS.border}`,
              color: COLORS.text,
              borderRadius: 5,
              padding: "9px 12px",
              fontSize: 13,
            }}
          />
          <button
            onClick={() => {
              addProduct(name, qty);
              setName("");
              setQty(10);
            }}
            className="display"
            style={{
              background: COLORS.accent,
              color: COLORS.bg,
              border: "none",
              borderRadius: 5,
              padding: "9px 16px",
              fontSize: 12.5,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Plus size={14} strokeWidth={2.5} />
            Ajouter
          </button>
        </div>

        {products.length === 0 ? (
          <div style={{ border: `1px dashed ${COLORS.border}`, borderRadius: 6, padding: 18, fontSize: 13, color: COLORS.dim }}>
            Aucun article en stock. Ajoutes-en un ci-dessus.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div className="mono" style={{ display: "flex", fontSize: 10.5, color: COLORS.dim, padding: "0 14px", marginBottom: 2 }}>
              <span style={{ flex: 1 }}>ARTICLE</span>
              <span style={{ width: 90, textAlign: "right" }}>QUANTIT&Eacute;</span>
              <span style={{ width: 30 }} />
            </div>
            {products.map((p) => {
              const low = p.qty < LOW_STOCK;
              return (
                <div
                  key={p.id}
                  style={{
                    background: COLORS.panel,
                    border: `1px solid ${low ? "rgba(242,109,109,0.4)" : COLORS.border}`,
                    borderRadius: 6,
                    padding: "11px 14px",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <span style={{ flex: 1, fontSize: 13.5 }}>{p.name}</span>
                  {low && (
                    <span
                      className="mono"
                      style={{ fontSize: 9.5, color: COLORS.red, background: "rgba(242,109,109,0.12)", padding: "2px 6px", borderRadius: 8 }}
                    >
                      STOCK BAS
                    </span>
                  )}
                  <span className="mono" style={{ width: 90, textAlign: "right", fontSize: 14, color: low ? COLORS.red : COLORS.text }}>
                    {p.qty}
                  </span>
                  <button onClick={() => removeProduct(p.id)} style={{ width: 30, background: "none", border: "none", color: COLORS.dim, display: "flex", justifyContent: "center" }}>
                    <X size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <p style={{ fontSize: 11.5, color: COLORS.dim, marginTop: 16, lineHeight: 1.5 }}>
          Le stock se met &agrave; jour automatiquement quand un arr&ecirc;t li&eacute; &agrave; un article est
          marqu&eacute; <span style={{ color: COLORS.green }}>Livr&eacute;</span> dans l'onglet Suivi.
        </p>
      </div>
    </>
  );
}

// ---------- Mode Chauffeur (tablet-first) ----------
function ChauffeurView({
  tournees,
  depots,
  chauffeurTourneeId,
  setChauffeurTourneeId,
  products,
  setRole,
  currentUser,
  logout,
  startTournee,
  setStopStatus,
  syncNow,
  saveState,
  lastSyncAt,
  createTournee,
  requestPrint,
  addStop,
  removeStop,
  runOptimize,
  optimizing,
}) {
  const [echecDraft, setEchecDraft] = useState({});
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDriver, setNewDriver] = useState(currentUser ? currentUser.name : "");
  const [newVehicle, setNewVehicle] = useState("");
  const [newDepotId, setNewDepotId] = useState(depots[0] ? depots[0].id : "");
  const [stopAddress, setStopAddress] = useState("");
  const [stopClient, setStopClient] = useState("");
  const [stopSlot, setStopSlot] = useState("");
  const [stopProductId, setStopProductId] = useState("");
  const [stopQty, setStopQty] = useState(1);

  const tournee = tournees.find((t) => t.id === chauffeurTourneeId) || null;
  const depot = getDepot(depots, tournee ? tournee.depotId : null);
  const sequence = tournee ? (tournee.order ? tournee.order.map((i) => tournee.stops[i]) : tournee.stops) : [];
  const done = tournee ? sequence.filter((s) => ["livre", "echec"].includes(tournee.statuses[s.id])).length : 0;
  const pct = sequence.length ? Math.round((done / sequence.length) * 100) : 0;

  const confirmEchec = (stopId) => {
    const c = (echecDraft[stopId] || "").trim();
    if (!c) return;
    setStopStatus(tournee.id, stopId, "echec", c);
    setEchecDraft((prev) => {
      const n = { ...prev };
      delete n[stopId];
      return n;
    });
  };

  const submitCreate = () => {
    const t = createTournee(newName, newDriver, newVehicle, newDepotId);
    setChauffeurTourneeId(t.id);
    setNewName("");
    setNewVehicle("");
    setShowCreateForm(false);
  };

  const submitAddStop = () => {
    if (!tournee || !stopAddress.trim()) return;
    const pos = hashPosition(stopAddress.trim(), depot);
    addStop(tournee.id, pos.x, pos.y, {
      label: stopAddress.trim(),
      clientName: stopClient.trim(),
      timeSlot: stopSlot.trim(),
      productId: stopProductId || null,
      qty: stopProductId ? Math.max(1, parseInt(stopQty, 10) || 1) : 1,
    });
    setStopAddress("");
    setStopClient("");
    setStopSlot("");
    setStopProductId("");
    setStopQty(1);
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
      <header
        style={{
          borderBottom: `1px solid ${COLORS.border}`,
          padding: "16px 20px",
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, background: COLORS.accent, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 5 }}>
            <Truck size={17} color={COLORS.bg} strokeWidth={2.5} />
          </div>
          <div className="display" style={{ fontSize: 16, fontWeight: 600 }}>
            Mode Chauffeur
          </div>
        </div>

        <select
          value={chauffeurTourneeId || ""}
          onChange={(e) => setChauffeurTourneeId(e.target.value)}
          style={{
            flex: "1 1 200px",
            maxWidth: 320,
            background: COLORS.panel,
            border: `1px solid ${COLORS.border}`,
            color: COLORS.text,
            borderRadius: 6,
            padding: "10px 12px",
            fontSize: 14,
          }}
        >
          {tournees.length === 0 && <option value="">Aucune tournée</option>}
          {tournees.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} {t.driverName ? `— ${t.driverName}` : ""}
            </option>
          ))}
        </select>

        <button
          onClick={() => setShowCreateForm((v) => !v)}
          title="Créer ma propre tournée"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: showCreateForm ? `${COLORS.accent}22` : "transparent",
            border: `1px solid ${showCreateForm ? COLORS.accent : COLORS.border}`,
            color: showCreateForm ? COLORS.accent : COLORS.muted,
            borderRadius: 6,
            fontSize: 13,
            padding: "10px 14px",
          }}
        >
          <Plus size={15} />
          Ma tournée
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
          <span style={{ fontSize: 12.5, color: COLORS.muted, display: "flex", alignItems: "center", gap: 6 }}>
            <User size={13} />
            {currentUser ? currentUser.name : ""}
          </span>
          <button
            onClick={syncNow}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              background: "transparent",
              border: `1px solid ${COLORS.border}`,
              color: COLORS.muted,
              borderRadius: 6,
              fontSize: 13,
              padding: "10px 14px",
            }}
          >
            <RefreshCw size={15} className={saveState === "saving" ? "spin" : ""} />
            Synchroniser
          </button>
          {currentUser && currentUser.role === "exploitant" && (
            <button
              onClick={() => setRole("exploitant")}
              style={{
                background: "transparent",
                border: `1px solid ${COLORS.border}`,
                color: COLORS.muted,
                borderRadius: 6,
                fontSize: 13,
                padding: "10px 14px",
              }}
            >
              Mode Exploitant
            </button>
          )}
          <button
            onClick={logout}
            title="Se déconnecter"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "transparent",
              border: `1px solid ${COLORS.border}`,
              color: COLORS.muted,
              borderRadius: 6,
              fontSize: 13,
              padding: "10px 14px",
            }}
          >
            <LogOut size={15} />
          </button>
        </div>
      </header>

      {showCreateForm && (
        <div
          style={{
            borderBottom: `1px solid ${COLORS.border}`,
            padding: "14px 20px",
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
            background: COLORS.panel,
          }}
        >
          <input
            placeholder="Nom de la tournée (ex: Tournée 2)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={inputStyle({ flex: "1 1 180px" })}
          />
          <input
            placeholder="Ton nom"
            value={newDriver}
            onChange={(e) => setNewDriver(e.target.value)}
            style={inputStyle({ flex: "1 1 140px" })}
          />
          <input
            placeholder="Véhicule"
            value={newVehicle}
            onChange={(e) => setNewVehicle(e.target.value)}
            style={inputStyle({ flex: "1 1 140px" })}
          />
          <select
            value={newDepotId}
            onChange={(e) => setNewDepotId(e.target.value)}
            style={{ ...inputStyle({ flex: "1 1 160px" }), background: COLORS.bg }}
          >
            {depots.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <button onClick={submitCreate} className="display" style={accentButtonStyle()}>
            <Plus size={14} strokeWidth={2.5} />
            Créer et commencer
          </button>
          <button onClick={() => setShowCreateForm(false)} style={ghostButtonStyle()}>
            Annuler
          </button>
        </div>
      )}

      <div style={{ padding: "8px 20px 4px", fontSize: 11, color: COLORS.dim }} className="mono">
        {lastSyncAt ? `Dernière synchro : ${new Date(lastSyncAt).toLocaleTimeString("fr-FR")}` : "Pas encore synchronisé"}
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "12px 20px 40px" }}>
        {!tournee ? (
          <div style={{ border: `1px dashed ${COLORS.border}`, borderRadius: 8, padding: 24, fontSize: 14, color: COLORS.muted, maxWidth: 480, display: "flex", flexDirection: "column", gap: 12 }}>
            <span>Aucune tournée disponible.</span>
            <button
              onClick={() => setShowCreateForm(true)}
              className="display"
              style={{ ...accentButtonStyle(), alignSelf: "flex-start" }}
            >
              <Plus size={14} strokeWidth={2.5} />
              Créer ma tournée
            </button>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
              <div className="display" style={{ fontSize: 20, fontWeight: 700 }}>
                {tournee.name}
              </div>
              <span
                className="mono"
                style={{
                  fontSize: 11.5,
                  color: TOURNEE_STATUS_META[tournee.status].color,
                  background: `${TOURNEE_STATUS_META[tournee.status].color}18`,
                  padding: "4px 10px",
                  borderRadius: 10,
                }}
              >
                {TOURNEE_STATUS_META[tournee.status].label}
              </span>
              {tournee.vehicleName && (
                <span style={{ fontSize: 13, color: COLORS.muted }}>{tournee.vehicleName}</span>
              )}
            </div>

            {!tournee.order ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 560 }}>
                <div style={{ border: `1px dashed ${COLORS.border}`, borderRadius: 8, padding: "14px 16px", fontSize: 13.5, color: COLORS.muted }}>
                  Cette tournée n'est pas encore optimisée. Ajoute tes arr&ecirc;ts ci-dessous, puis lance
                  l'optimisation pour obtenir l'ordre de passage id&eacute;al.
                </div>

                {tournee.stops.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {tournee.stops.map((s, idx) => {
                      const product = products.find((p) => p.id === s.productId);
                      return (
                        <div
                          key={s.id}
                          style={{
                            background: COLORS.panel,
                            border: `1px solid ${COLORS.border}`,
                            borderRadius: 8,
                            padding: "12px 14px",
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                          }}
                        >
                          <span className="mono" style={{ color: COLORS.accent, fontSize: 14, width: 20, flexShrink: 0 }}>
                            {idx + 1}
                          </span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {s.label}
                              {s.clientName ? ` — ${s.clientName}` : ""}
                            </div>
                            <div style={{ fontSize: 12, color: COLORS.dim }}>
                              {s.timeSlot ? `${s.timeSlot} · ` : ""}
                              {product ? `${s.qty} × ${product.name}` : "Sans article lié"}
                            </div>
                          </div>
                          <button
                            onClick={() => removeStop(tournee.id, s.id)}
                            style={{ background: "none", border: "none", color: COLORS.dim, padding: 4, flexShrink: 0 }}
                          >
                            <X size={16} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
                  <div className="display" style={{ fontSize: 13, color: COLORS.dim }}>
                    Ajouter un arr&ecirc;t
                  </div>
                  <input
                    placeholder="Adresse"
                    value={stopAddress}
                    onChange={(e) => setStopAddress(e.target.value)}
                    style={inputStyle({ fontSize: 14, padding: "11px 12px" })}
                  />
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <input
                      placeholder="Nom du client"
                      value={stopClient}
                      onChange={(e) => setStopClient(e.target.value)}
                      style={inputStyle({ flex: "1 1 160px", fontSize: 14, padding: "11px 12px" })}
                    />
                    <input
                      placeholder="Créneau (08:00-10:00)"
                      value={stopSlot}
                      onChange={(e) => setStopSlot(e.target.value)}
                      style={inputStyle({ flex: "1 1 160px", fontSize: 14, padding: "11px 12px" })}
                    />
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <select
                      value={stopProductId}
                      onChange={(e) => setStopProductId(e.target.value)}
                      style={{
                        flex: 1,
                        background: COLORS.bg,
                        border: `1px solid ${COLORS.border}`,
                        color: COLORS.text,
                        borderRadius: 5,
                        fontSize: 14,
                        padding: "11px 12px",
                      }}
                    >
                      <option value="">Aucun article lié</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    {stopProductId && (
                      <input
                        type="number"
                        min={1}
                        value={stopQty}
                        onChange={(e) => setStopQty(e.target.value)}
                        style={inputStyle({ width: 70, fontSize: 14, padding: "11px 12px" })}
                      />
                    )}
                  </div>
                  <button
                    onClick={submitAddStop}
                    disabled={!stopAddress.trim() || tournee.stops.length >= MAX_STOPS}
                    className="display"
                    style={{ ...accentButtonStyle({ justifyContent: "center", fontSize: 13.5, padding: "12px" }) }}
                  >
                    <Plus size={15} strokeWidth={2.5} />
                    Ajouter l'arr&ecirc;t
                  </button>
                </div>

                <button
                  onClick={() => runOptimize(tournee.id)}
                  disabled={tournee.stops.length < 2 || optimizing}
                  className="display"
                  style={{
                    background: COLORS.accent,
                    color: COLORS.bg,
                    border: "none",
                    borderRadius: 8,
                    padding: "16px 18px",
                    fontSize: 15,
                    fontWeight: 700,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                  }}
                >
                  <Zap size={17} strokeWidth={2.5} />
                  {optimizing
                    ? "Calcul en cours…"
                    : tournee.stops.length < 2
                    ? "Ajoute au moins 2 arrêts pour optimiser"
                    : "Optimiser mon itinéraire"}
                </button>
              </div>
            ) : (
              <>
                {tournee.status === "attente" ? (
                  <button
                    onClick={() => startTournee(tournee.id)}
                    className="display"
                    style={{
                      width: "100%",
                      background: COLORS.accent,
                      color: COLORS.bg,
                      border: "none",
                      borderRadius: 8,
                      padding: "18px 20px",
                      fontSize: 16,
                      fontWeight: 700,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 10,
                      marginBottom: 18,
                    }}
                  >
                    <PlayCircle size={20} />
                    Commencer la tournée
                  </button>
                ) : (
                  <div style={{ marginBottom: 18 }}>
                    <div style={{ height: 8, background: COLORS.panel, borderRadius: 4, overflow: "hidden", border: `1px solid ${COLORS.border}` }}>
                      <div style={{ height: "100%", width: `${pct}%`, background: COLORS.accent, transition: "width 0.4s ease" }} />
                    </div>
                    <div className="mono" style={{ fontSize: 12, color: COLORS.dim, marginTop: 6 }}>
                      {done}/{sequence.length} arrêts traités ({pct}%)
                    </div>
                  </div>
                )}

                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {sequence.map((s, idx) => {
                    const status = tournee.statuses[s.id] || "attente";
                    const meta = STATUS_META[status];
                    const Icon = meta.icon;
                    const product = products.find((p) => p.id === s.productId);
                    const pending = status === "attente" || status === "encours";
                    const drafting = echecDraft[s.id] !== undefined;
                    const ts = tournee.timestamps[s.id];

                    return (
                      <div
                        key={s.id}
                        style={{
                          background: COLORS.panel,
                          border: `1px solid ${status === "echec" ? "rgba(242,109,109,0.5)" : COLORS.border}`,
                          borderRadius: 10,
                          padding: "16px 18px",
                          display: "flex",
                          flexDirection: "column",
                          gap: 10,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                          <span className="mono" style={{ color: COLORS.accent, fontSize: 18, fontWeight: 700, width: 28, flexShrink: 0 }}>
                            {idx + 1}
                          </span>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 16.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              <MapPin size={15} color={COLORS.dim} />
                              {s.label || `Arrêt ${idx + 1}`}
                            </div>
                            {s.clientName && (
                              <div style={{ fontSize: 14, color: COLORS.muted, marginTop: 3, display: "flex", alignItems: "center", gap: 6 }}>
                                <User size={13} />
                                {s.clientName}
                              </div>
                            )}
                            <div style={{ fontSize: 13.5, color: COLORS.dim, marginTop: 3, display: "flex", gap: 14, flexWrap: "wrap" }}>
                              {s.timeSlot && (
                                <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                                  <Clock size={12} /> {s.timeSlot}
                                </span>
                              )}
                              <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                                <Package size={12} /> {product ? `${s.qty} × ${product.name}` : "Sans article lié"}
                              </span>
                            </div>
                          </div>
                          <span
                            className="mono"
                            style={{
                              fontSize: 11,
                              color: meta.color,
                              background: `${meta.color}18`,
                              padding: "5px 10px",
                              borderRadius: 10,
                              display: "flex",
                              alignItems: "center",
                              gap: 5,
                              flexShrink: 0,
                            }}
                          >
                            <Icon size={12} />
                            {meta.label}
                          </span>
                        </div>

                        {tournee.status !== "attente" && pending && !drafting && (
                          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                            <button
                              onClick={() => setStopStatus(tournee.id, s.id, "livre")}
                              style={{
                                flex: 1,
                                background: COLORS.green,
                                color: "#0B1410",
                                border: "none",
                                borderRadius: 8,
                                padding: "14px 12px",
                                fontSize: 14.5,
                                fontWeight: 700,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                gap: 8,
                              }}
                            >
                              <CheckCircle2 size={17} />
                              Valider la livraison
                            </button>
                            <button
                              onClick={() => setEchecDraft((prev) => ({ ...prev, [s.id]: "" }))}
                              style={{
                                flex: 1,
                                background: "transparent",
                                color: COLORS.red,
                                border: `1.5px solid ${COLORS.red}`,
                                borderRadius: 8,
                                padding: "14px 12px",
                                fontSize: 14.5,
                                fontWeight: 700,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                gap: 8,
                              }}
                            >
                              <AlertTriangle size={17} />
                              Marquer un échec
                            </button>
                          </div>
                        )}

                        {drafting && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <textarea
                              autoFocus
                              placeholder="Motif de l'échec (obligatoire) : client absent, accès impossible…"
                              value={echecDraft[s.id]}
                              onChange={(e) => setEchecDraft((prev) => ({ ...prev, [s.id]: e.target.value }))}
                              style={{
                                minHeight: 64,
                                background: COLORS.bg,
                                border: `1px solid ${COLORS.red}`,
                                color: COLORS.text,
                                borderRadius: 8,
                                fontSize: 14,
                                padding: "10px 12px",
                                resize: "vertical",
                              }}
                            />
                            <div style={{ display: "flex", gap: 10 }}>
                              <button
                                onClick={() => confirmEchec(s.id)}
                                disabled={!echecDraft[s.id] || !echecDraft[s.id].trim()}
                                style={{
                                  flex: 1,
                                  background: COLORS.red,
                                  color: "#fff",
                                  border: "none",
                                  borderRadius: 8,
                                  padding: "12px",
                                  fontSize: 14,
                                  fontWeight: 700,
                                }}
                              >
                                Confirmer l'échec
                              </button>
                              <button
                                onClick={() =>
                                  setEchecDraft((prev) => {
                                    const n = { ...prev };
                                    delete n[s.id];
                                    return n;
                                  })
                                }
                                style={ghostButtonStyle({ flex: 1, padding: "12px", fontSize: 14 })}
                              >
                                Annuler
                              </button>
                            </div>
                          </div>
                        )}

                        {!pending && (
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                            <div style={{ fontSize: 12.5, color: COLORS.dim }}>
                              {ts && `à ${new Date(ts.at).toLocaleTimeString("fr-FR")}`}
                              {status === "echec" && tournee.comments[s.id] && (
                                <span style={{ color: COLORS.red, marginLeft: 8 }}>
                                  <MessageSquare size={11} style={{ marginRight: 4, verticalAlign: "middle" }} />
                                  {tournee.comments[s.id]}
                                </span>
                              )}
                            </div>
                            <button
                              onClick={() => setStopStatus(tournee.id, s.id, "attente")}
                              style={{ background: "none", border: "none", color: COLORS.dim, fontSize: 12, textDecoration: "underline" }}
                            >
                              Réouvrir
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                <button
                  onClick={() => requestPrint(tournee, products, depots)}
                  style={{
                    width: "100%",
                    marginTop: 20,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    background: "transparent",
                    border: `1px solid ${COLORS.border}`,
                    color: COLORS.muted,
                    borderRadius: 8,
                    padding: "14px",
                    fontSize: 14,
                  }}
                >
                  <Printer size={16} />
                  Exporter le carnet (PDF)
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------- shared bits ----------
// ---------- login screen ----------
function LoginScreen({ onLogin, onSignup, authError }) {
  const [mode, setMode] = useState("login"); // "login" | "signup"
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!email.trim() || !password) return;
    setSubmitting(true);
    try {
      if (mode === "login") {
        await onLogin(email.trim(), password);
      } else {
        await onSignup(email.trim(), password, name.trim());
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28 }}>
        <div
          style={{
            width: 36,
            height: 36,
            background: COLORS.accent,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 6,
          }}
        >
          <Zap size={19} color={COLORS.bg} strokeWidth={2.5} />
        </div>
        <div className="display" style={{ fontSize: 22, fontWeight: 600 }}>
          LogiSuite<span style={{ color: COLORS.accent }}>.</span>
        </div>
      </div>

      <div
        style={{
          background: COLORS.panel,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 10,
          padding: 24,
          width: 300,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ fontSize: 13.5, color: COLORS.muted, marginBottom: 4, textAlign: "center" }}>
          {mode === "login" ? "Connecte-toi pour continuer" : "Création du compte administrateur"}
        </div>

        {mode === "signup" && (
          <input
            placeholder="Ton nom"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              background: COLORS.bg,
              border: `1px solid ${COLORS.border}`,
              color: COLORS.text,
              borderRadius: 6,
              padding: "10px 12px",
              fontSize: 14,
            }}
          />
        )}
        <input
          type="email"
          autoFocus
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          style={{
            background: COLORS.bg,
            border: `1px solid ${COLORS.border}`,
            color: COLORS.text,
            borderRadius: 6,
            padding: "10px 12px",
            fontSize: 14,
          }}
        />
        <input
          type="password"
          placeholder="Mot de passe"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          style={{
            background: COLORS.bg,
            border: `1px solid ${authError ? COLORS.red : COLORS.border}`,
            color: COLORS.text,
            borderRadius: 6,
            padding: "10px 12px",
            fontSize: 14,
          }}
        />

        {authError && <div style={{ fontSize: 12, color: COLORS.red }}>{authError}</div>}

        <button
          onClick={submit}
          disabled={submitting || !email.trim() || !password}
          className="display"
          style={{ ...accentButtonStyle(), width: "100%", justifyContent: "center" }}
        >
          {submitting ? "..." : mode === "login" ? "Se connecter" : "Créer le compte"}
        </button>

        <button
          onClick={() => setMode(mode === "login" ? "signup" : "login")}
          style={{ background: "none", border: "none", color: COLORS.dim, fontSize: 12, marginTop: 4 }}
        >
          {mode === "login"
            ? "Première configuration ? Créer le compte administrateur"
            : "← Retour à la connexion"}
        </button>
      </div>

      {mode === "signup" && (
        <div style={{ fontSize: 11, color: COLORS.dim, marginTop: 14, maxWidth: 300, textAlign: "center" }}>
          ⚠️ Cet écran de création ne sert qu'une fois, pour le tout premier compte (exploitant).
          Les comptes suivants (chauffeurs, etc.) se créent depuis l'onglet Équipe une fois connecté.
        </div>
      )}
    </div>
  );
}

// ---------- toast stack (real-time échec alerts) ----------
function ToastStack({ toasts }) {
  if (!toasts.length) return null;
  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        maxWidth: 300,
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          style={{
            background: COLORS.panel,
            border: `1px solid ${COLORS.red}`,
            borderRadius: 8,
            padding: "12px 14px",
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          }}
        >
          <AlertTriangle size={16} color={COLORS.red} style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 12.5, color: COLORS.text }}>{t.text}</div>
        </div>
      ))}
    </div>
  );
}

// ---------- TAB: Dépôts ----------
function DepotsTab({ depots, tournees, createDepot, deleteDepot }) {
  const [name, setName] = useState("");
  const svgRef = useRef(null);

  const handleMapClick = (e) => {
    if (!name.trim()) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    createDepot(name.trim(), x, y);
    setName("");
  };

  const usageCount = (id) => tournees.filter((t) => t.depotId === id).length;

  return (
    <>
      <TopHeader title="Dépôts" subtitle={`${depots.length} dépôt${depots.length > 1 ? "s" : ""}`} />
      <div style={{ padding: 24, maxWidth: 640 }}>
        <p style={{ fontSize: 13, color: COLORS.muted, marginTop: 0 }}>
          Renseigne un nom puis clique sur la carte pour positionner un nouveau dépôt. Chaque tournée part
          d’un dépôt choisi dans l’onglet Tournée.
        </p>
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <input
            placeholder="Nom du dépôt (ex: Entrepôt Nord)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={inputStyle({ flex: 1 })}
          />
        </div>

        <svg
          ref={svgRef}
          viewBox="0 0 100 100"
          onClick={handleMapClick}
          style={{
            width: "100%",
            aspectRatio: "1.8 / 1",
            background: COLORS.panel,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 6,
            cursor: name.trim() ? "crosshair" : "default",
            marginBottom: 18,
          }}
        >
          <defs>
            <pattern id="grid2" width="5" height="5" patternUnits="userSpaceOnUse">
              <path d="M 5 0 L 0 0 0 5" fill="none" stroke="#20262D" strokeWidth="0.15" />
            </pattern>
          </defs>
          <rect width="100" height="100" fill="url(#grid2)" />
          {depots.map((d, i) => (
            <g key={d.id} transform={`translate(${d.x}, ${d.y})`}>
              <title>{d.name}</title>
              <circle r="3.6" fill={COLORS.bg} stroke={COLORS.accent} strokeWidth="0.6" />
              <text x="0" y="1.2" textAnchor="middle" fontSize="3.6" fill={COLORS.accent} fontWeight="700">
                {i + 1}
              </text>
            </g>
          ))}
        </svg>
        {!name.trim() && (
          <div style={{ fontSize: 11.5, color: COLORS.dim, marginTop: -12, marginBottom: 14 }}>
            Saisis un nom ci-dessus pour activer le placement sur la carte.
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {depots.map((d, i) => {
            const used = usageCount(d.id);
            return (
              <div
                key={d.id}
                style={{
                  background: COLORS.panel,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 6,
                  padding: "12px 14px",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <span className="mono" style={{ color: COLORS.accent, fontSize: 12, width: 18 }}>
                  {i + 1}
                </span>
                <Warehouse size={15} color={COLORS.dim} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5 }}>{d.name}</div>
                  <div style={{ fontSize: 11, color: COLORS.dim }}>
                    {used} tournée{used > 1 ? "s" : ""} associée{used > 1 ? "s" : ""}
                  </div>
                </div>
                <button
                  onClick={() => {
                    if (depots.length <= 1) {
                      window.alert("Impossible de supprimer le dernier dépôt.");
                      return;
                    }
                    const msg = used > 0
                      ? `${used} tournée(s) utilisent ce dépôt et seront réaffectées au premier dépôt restant. Continuer ?`
                      : `Supprimer le dépôt « ${d.name} » ?`;
                    if (window.confirm(msg)) deleteDepot(d.id);
                  }}
                  style={{ background: "none", border: "none", color: COLORS.dim, padding: 4 }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ---------- TAB: Équipe (utilisateurs / rôles) ----------
function UsersTab({ users, currentUser, createUser, deleteUser }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("chauffeur");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!name.trim() || !email.trim() || password.length < 8) return;
    setSubmitting(true);
    try {
      await createUser(name, role, email.trim(), password);
      setName("");
      setEmail("");
      setPassword("");
      setRole("chauffeur");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = (u) => {
    if (u.id === currentUser.id) {
      window.alert("Tu ne peux pas supprimer ton propre compte pendant que tu es connecté.");
      return;
    }
    const remainingExploitants = users.filter((x) => x.role === "exploitant" && x.id !== u.id).length;
    if (u.role === "exploitant" && remainingExploitants === 0) {
      window.alert("Impossible de supprimer le dernier compte Exploitant.");
      return;
    }
    if (window.confirm(`Supprimer le compte « ${u.name} » ?`)) deleteUser(u.id);
  };

  return (
    <>
      <TopHeader title="Équipe" subtitle={`${users.length} compte${users.length > 1 ? "s" : ""}`} />
      <div style={{ padding: 24, maxWidth: 640 }}>
        <p style={{ fontSize: 13, color: COLORS.muted, marginTop: 0 }}>
          Crée un vrai compte (email + mot de passe, 8 caractères minimum) pour chaque personne de
          l'équipe — c'est ce compte qu'elle utilisera pour se connecter.
        </p>
        <div
          style={{
            background: COLORS.panel,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 6,
            padding: 14,
            marginBottom: 20,
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <input placeholder="Nom" value={name} onChange={(e) => setName(e.target.value)} style={inputStyle({ flex: "1 1 140px" })} />
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={inputStyle({ flex: "1 1 160px" })}
          />
          <input
            type="password"
            placeholder="Mot de passe (8+ car.)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle({ flex: "1 1 160px" })}
          />
          <select value={role} onChange={(e) => setRole(e.target.value)} style={{ ...inputStyle({ flex: "1 1 130px" }), background: COLORS.bg }}>
            <option value="chauffeur">Chauffeur</option>
            <option value="exploitant">Exploitant</option>
          </select>
          <button
            onClick={submit}
            disabled={submitting || !name.trim() || !email.trim() || password.length < 8}
            className="display"
            style={accentButtonStyle()}
          >
            <UserPlus size={14} strokeWidth={2.5} />
            {submitting ? "..." : "Ajouter"}
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {users.map((u) => (
            <div
              key={u.id}
              style={{
                background: COLORS.panel,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 6,
                padding: "12px 14px",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: "50%",
                  background: `${ROLE_META[u.role].color}22`,
                  color: ROLE_META[u.role].color,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {u.name.slice(0, 1).toUpperCase()}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, display: "flex", alignItems: "center", gap: 6 }}>
                  {u.name}
                  {u.id === currentUser.id && (
                    <span className="mono" style={{ fontSize: 9.5, color: COLORS.dim }}>
                      (toi)
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: COLORS.dim, display: "flex", alignItems: "center", gap: 6 }}>
                  {u.email}
                </div>
              </div>
              <span
                className="mono"
                style={{
                  fontSize: 10.5,
                  color: ROLE_META[u.role].color,
                  background: `${ROLE_META[u.role].color}18`,
                  padding: "3px 9px",
                  borderRadius: 10,
                }}
              >
                {ROLE_META[u.role].label}
              </span>
              <button onClick={() => handleDelete(u)} style={{ background: "none", border: "none", color: COLORS.dim, padding: 4 }}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ---------- TAB: Historique ----------
function HistoriqueTab({ tournees, products, depots, setActiveTourneeId, setTab, duplicateTournee, requestPrint }) {
  const finished = tournees
    .filter((t) => t.status === "terminee")
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));

  const openSuivi = (id) => {
    setActiveTourneeId(id);
    setTab("suivi");
  };

  return (
    <>
      <TopHeader title="Historique" subtitle={`${finished.length} tournée${finished.length > 1 ? "s" : ""} terminée${finished.length > 1 ? "s" : ""}`} />
      <div style={{ padding: 24, maxWidth: 780 }}>
        {finished.length === 0 ? (
          <div style={{ border: `1px dashed ${COLORS.border}`, borderRadius: 6, padding: 18, fontSize: 13, color: COLORS.dim }}>
            Aucune tournée terminée pour le moment.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {finished.map((t) => {
              const delivered = Object.values(t.statuses).filter((s) => s === "livre").length;
              const failed = Object.values(t.statuses).filter((s) => s === "echec").length;
              const depot = getDepot(depots, t.depotId);
              const { distance } = tourneeStats(t, depot);
              return (
                <div
                  key={t.id}
                  style={{
                    background: COLORS.panel,
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 6,
                    padding: "14px 16px",
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ flex: "1 1 200px", minWidth: 160 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{t.name}</div>
                    <div style={{ fontSize: 11.5, color: COLORS.dim, marginTop: 2 }}>
                      {t.driverName || "Chauffeur non assigné"}
                      {t.vehicleName ? ` · ${t.vehicleName}` : ""}
                      {t.finishedAt ? ` · ${new Date(t.finishedAt).toLocaleDateString("fr-FR")} à ${new Date(t.finishedAt).toLocaleTimeString("fr-FR")}` : ""}
                    </div>
                  </div>
                  <div className="mono" style={{ fontSize: 11.5, color: COLORS.muted, width: 130 }}>
                    {delivered} livré{delivered > 1 ? "s" : ""}
                    {failed > 0 ? `, ${failed} échec${failed > 1 ? "s" : ""}` : ""}
                  </div>
                  <div className="mono" style={{ fontSize: 11.5, color: COLORS.muted, width: 80 }}>
                    {distance.toFixed(1)} km
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <SmallBtn icon={Truck} label="Détail" onClick={() => openSuivi(t.id)} />
                    <SmallBtn icon={Printer} label="PDF" onClick={() => requestPrint(t, products, depots)} />
                    <SmallBtn
                      icon={Copy}
                      label="Dupliquer"
                      onClick={() => {
                        duplicateTournee(t.id);
                        setTab("flotte");
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function TopHeader({ title, subtitle }) {
  return (
    <header
      style={{
        borderBottom: `1px solid ${COLORS.border}`,
        padding: "18px 24px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
      }}
    >
      <div className="display" style={{ fontSize: 17, fontWeight: 600 }}>
        {title}
      </div>
      <div className="mono" style={{ fontSize: 11, color: COLORS.dim }}>
        {subtitle}
      </div>
    </header>
  );
}

function StatRow({ icon, label, value, sub }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
      <div style={{ marginTop: 2 }}>{icon}</div>
      <div>
        <div style={{ fontSize: 12, color: COLORS.muted }}>{label}</div>
        <div className="mono" style={{ fontSize: 15, fontWeight: 600 }}>
          {value}
        </div>
        {sub && <div style={{ fontSize: 10.5, color: COLORS.dim }}>{sub}</div>}
      </div>
    </div>
  );
}
