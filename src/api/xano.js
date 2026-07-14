// ---------------------------------------------------------------------------
// Client Xano pour LogiSuite.
//
// Deux backends distincts (deux groupes d'API différents dans Xano) :
//  - AUTH_BASE  : connexion / inscription / "qui suis-je"
//  - DATA_BASE  : dépôts, produits, arrêts, tournées, utilisateurs
//
// ⚠️ À VÉRIFIER : les noms de segments d'URL ci-dessous (RESOURCES) sont une
// hypothèse basée sur la façon dont Xano transforme généralement un nom de
// table accentué en URL (ex: "dépôts" → "depots"). Ouvre la Documentation
// Swagger de ton groupe "LogiSuite" dans Xano et compare avec les chemins
// réels affichés là-bas. Si un nom diffère, corrige-le juste ici — rien
// d'autre dans le code n'a besoin de changer.
// ---------------------------------------------------------------------------

const AUTH_BASE = import.meta.env.VITE_XANO_AUTH_URL || "https://x8ki-letl-twmt.n7.xano.io/api:6TmswaGi";
const DATA_BASE = import.meta.env.VITE_XANO_DATA_URL || "https://x8ki-letl-twmt.n7.xano.io/api:logisuite";

const RESOURCES = {
  depots: "depots",
  products: "produits",
  stops: "arrets",
  tournees: "tournois",
  users: "utilisateurs",
};

// Noms possibles sous lesquels Xano peut renvoyer les arrêts liés, selon
// comment l'addon a été nommé lors de sa création. On essaie chacun.
const STOPS_ADDON_KEYS = ["arrets", "stops", "_arrets", "_stops", "arrêts"];

const TOKEN_KEY = "logisuite_token";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(base, path, { method = "GET", body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth) {
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError("Impossible de contacter le serveur. Vérifie ta connexion internet.", 0);
  }

  if (res.status === 401) {
    setToken(null);
    throw new ApiError("Session expirée, reconnecte-toi.", 401);
  }

  if (!res.ok) {
    let message = `Erreur ${res.status}`;
    try {
      const errBody = await res.json();
      message = errBody.message || errBody.error || message;
    } catch (e) {
      // réponse d'erreur non-JSON, on garde le message générique
    }
    throw new ApiError(message, res.status);
  }

  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---- Authentification ----
export const authApi = {
  login: (email, password) =>
    request(AUTH_BASE, "/auth/login", { method: "POST", body: { email, password }, auth: false }),
  signup: (email, password, name) =>
    request(AUTH_BASE, "/auth/signup", { method: "POST", body: { email, password, name }, auth: false }),
  me: () => request(AUTH_BASE, "/auth/me"),
};

// ---- Dépôts ----
export const depotsApi = {
  list: () => request(DATA_BASE, `/${RESOURCES.depots}`),
  create: (data) => request(DATA_BASE, `/${RESOURCES.depots}`, { method: "POST", body: data }),
  update: (id, data) => request(DATA_BASE, `/${RESOURCES.depots}/${id}`, { method: "PATCH", body: data }),
  remove: (id) => request(DATA_BASE, `/${RESOURCES.depots}/${id}`, { method: "DELETE" }),
};

// ---- Produits ----
export const productsApi = {
  list: () => request(DATA_BASE, `/${RESOURCES.products}`),
  create: (data) => request(DATA_BASE, `/${RESOURCES.products}`, { method: "POST", body: data }),
  update: (id, data) => request(DATA_BASE, `/${RESOURCES.products}/${id}`, { method: "PATCH", body: data }),
  remove: (id) => request(DATA_BASE, `/${RESOURCES.products}/${id}`, { method: "DELETE" }),
};

// ---- Tournées (renvoyées avec leurs arrêts imbriqués via l'addon) ----
export const tourneesApi = {
  list: () => request(DATA_BASE, `/${RESOURCES.tournees}`),
  create: (data) => request(DATA_BASE, `/${RESOURCES.tournees}`, { method: "POST", body: data }),
  update: (id, data) => request(DATA_BASE, `/${RESOURCES.tournees}/${id}`, { method: "PATCH", body: data }),
  remove: (id) => request(DATA_BASE, `/${RESOURCES.tournees}/${id}`, { method: "DELETE" }),
};

// ---- Arrêts ----
export const stopsApi = {
  create: (data) => request(DATA_BASE, `/${RESOURCES.stops}`, { method: "POST", body: data }),
  update: (id, data) => request(DATA_BASE, `/${RESOURCES.stops}/${id}`, { method: "PATCH", body: data }),
  remove: (id) => request(DATA_BASE, `/${RESOURCES.stops}/${id}`, { method: "DELETE" }),
};

// ---- Utilisateurs (la création passe par authApi.signup, pas par ici) ----
export const usersApi = {
  list: () => request(DATA_BASE, `/${RESOURCES.users}`),
  update: (id, data) => request(DATA_BASE, `/${RESOURCES.users}/${id}`, { method: "PATCH", body: data }),
  remove: (id) => request(DATA_BASE, `/${RESOURCES.users}/${id}`, { method: "DELETE" }),
};

export function extractStopsFromTournee(rawTournee) {
  for (const key of STOPS_ADDON_KEYS) {
    if (Array.isArray(rawTournee[key])) return rawTournee[key];
  }
  return [];
}

export { ApiError };
