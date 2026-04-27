"use strict";

/* ==========================================================================
   pyodide_bridge.js — Chargement Pyodide + lib Python (P4)

   Charge :
   - Pyodide (runtime CPython compilé en WebAssembly) depuis le CDN jsdelivr.
   - numpy et scipy (depuis l'index Pyodide).
   - Les modules de `lightning_tdoa/` (fetch + écriture dans le FS Pyodide).

   Démarre le chargement automatiquement au load de la page. Met à jour
   l'overlay #pyodide-overlay tant que ce n'est pas prêt.

   Premier chargement : 30-60 s (téléchargement scipy/numpy + lib).
   Sessions ultérieures : 5-10 s (cache IndexedDB navigateur).

   Expose `window.pyodideBridge` :
   - .isReady (bool)
   - .chargerEtAttendre() → Promise (idempotent)
   - .simulerEtResoudre(impact_m, stations_js, sigmas_ns) → Promise<{...}>
   ========================================================================== */

const PYODIDE_VERSION = "0.26.4";
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const MODULES_LIB = ["__init__", "geometry", "simulator", "solver", "metrics", "storm"];

window.pyodideBridge = {
  isReady: false,
  pyodide: null,
  loadPromise: null,

  chargerEtAttendre() {
    if (!this.loadPromise) {
      this.loadPromise = this._charger();
    }
    return this.loadPromise;
  },

  async _charger() {
    if (typeof loadPyodide !== "function") {
      throw new Error("loadPyodide non défini — pyodide.js n'est pas chargé. " +
                      "Vérifier la balise <script> dans index.html.");
    }

    this._setStatut("Téléchargement du runtime Pyodide…");
    this.pyodide = await loadPyodide({ indexURL: PYODIDE_CDN });

    this._setStatut("Installation de numpy et scipy (~30 Mo)…");
    await this.pyodide.loadPackage(["numpy", "scipy"]);

    this._setStatut("Chargement de la lib lightning_tdoa…");
    await this._chargerLibPython();

    this._setStatut("Initialisation terminée.");
    this.isReady = true;
  },

  async _chargerLibPython() {
    this.pyodide.FS.mkdirTree("/home/pyodide/lightning_tdoa");

    // Cache-buster : sans ça, le navigateur peut servir une version stale
    // de metrics.py/etc. depuis son cache HTTP, et l'import au runtime
    // échoue avec "cannot import name X from lightning_tdoa.Y".
    const v = Date.now();
    for (const nom of MODULES_LIB) {
      const url = `../lightning_tdoa/${nom}.py?v=${v}`;
      const reponse = await fetch(url, { cache: "no-store" });
      if (!reponse.ok) {
        throw new Error(`Échec chargement ${url} (HTTP ${reponse.status})`);
      }
      const code = await reponse.text();
      this.pyodide.FS.writeFile(`/home/pyodide/lightning_tdoa/${nom}.py`, code);
    }

    // Ajoute le dossier au sys.path et import préventif (vérifie tout marche).
    await this.pyodide.runPythonAsync(`
import sys
if "/home/pyodide" not in sys.path:
    sys.path.insert(0, "/home/pyodide")
from lightning_tdoa import geometry, simulator, solver, metrics
`);
  },

  _setStatut(msg) {
    const el = document.querySelector("#pyodide-overlay .pyodide-msg");
    if (el) el.textContent = msg;
  },

  /* ----- API métier ----- */

  /**
   * Simule un éclair à `impact_m`, retrouve sa position estimée via NLLS,
   * et renvoie aussi GDOP + erreur de localisation.
   *
   * @param {[number, number]} impact_m       position vraie en mètres
   * @param {Array<{id:string, x_m:number, y_m:number}>} stations_js
   * @param {{vlf:number, gps:number, horloge:number}} sigmas_ns  bruit en ns
   * @returns {Promise<{
   *   toas: Object,            // {S1: t, S2: t, S3: t} en secondes
   *   position_estimee: [number, number],
   *   erreur_m: number,
   *   gdop: number,
   *   converge: boolean,
   * }>}
   */
  async simulerEtResoudre(impact_m, stations_js, sigmas_ns) {
    if (!this.isReady) {
      throw new Error("Pyodide pas encore prêt — attendre chargerEtAttendre().");
    }

    // Sérialisation JSON pour le passage JS → Python : `.to_py()` ne convertit
    // que le top-level d'un array d'objets, les objets internes restent des
    // JsProxy non-subscriptables. JSON contourne ce piège proprement.
    this.pyodide.globals.set("_impact_json", JSON.stringify(impact_m));
    this.pyodide.globals.set("_stations_json", JSON.stringify(stations_js));
    this.pyodide.globals.set("_sigmas_json", JSON.stringify(sigmas_ns));

    const py_result = await this.pyodide.runPythonAsync(`
import json
import numpy as np
from lightning_tdoa.geometry import Station
from lightning_tdoa.simulator import NoiseConfig, simulate_strike
from lightning_tdoa.solver import resoudre_nlls
from lightning_tdoa.metrics import erreur_localisation, gdop

_impact_data = json.loads(_impact_json)
_stations_data = json.loads(_stations_json)
_sigmas_data = json.loads(_sigmas_json)

_impact_py = (float(_impact_data[0]), float(_impact_data[1]))
_stations_py = [
    Station(id=s["id"], x=float(s["x_m"]), y=float(s["y_m"]))
    for s in _stations_data
]
_cfg = NoiseConfig(
    sigma_vlf_ns=float(_sigmas_data["vlf"]),
    sigma_gps_ns=float(_sigmas_data["gps"]),
    sigma_horloge_ns=float(_sigmas_data["horloge"]),
)
_rng = np.random.default_rng()
# erreur_max_km=None : garde-fou désactivé pour P4 (l'utilisateur peut
# cliquer hors zone utile, on doit retourner un résultat même si grossier).
_toas = simulate_strike(_impact_py, _stations_py, _cfg, _rng, erreur_max_km=None)
_res = resoudre_nlls(_toas, _stations_py)
_g = gdop(_stations_py, _impact_py)

{
    "toas": dict(_toas),
    "position_estimee": [float(_res.position[0]), float(_res.position[1])],
    "erreur_m": float(erreur_localisation(_res.position, _impact_py)),
    "gdop": float(_g),
    "converge": bool(_res.converge),
}
    `);

    return py_result.toJs({ dict_converter: Object.fromEntries });
  },

  /* ----- Générateur d'orages (P7) ----- */

  /**
   * Crée un GenerateurOrage Python avec les paramètres donnés.
   * Stocké dans la global Python `_generateur_orage_global`.
   */
  async creerGenerateurOrage(centre_xy, parametres, seed) {
    if (!this.isReady) throw new Error("Pyodide pas prêt");
    this.pyodide.globals.set("_centre_json", JSON.stringify(centre_xy));
    this.pyodide.globals.set("_params_json", JSON.stringify(parametres));
    this.pyodide.globals.set("_seed", seed);
    await this.pyodide.runPythonAsync(`
import json
import numpy as np
from lightning_tdoa.storm import GenerateurOrage, ParametresOrage

_centre = json.loads(_centre_json)
_p_data = json.loads(_params_json)
_p = ParametresOrage(
    rayon_max_m=float(_p_data["rayon_max_m"]),
    cadence_par_min=float(_p_data["cadence_par_min"]),
    distance_moy_m=float(_p_data["distance_moy_m"]),
    derive_direction_deg=float(_p_data["derive_direction_deg"]),
    derive_vitesse_m_par_s=float(_p_data["derive_vitesse_m_par_s"]),
)
_rng_orage = np.random.default_rng(seed=int(_seed))
_generateur_orage_global = GenerateurOrage(
    (float(_centre[0]), float(_centre[1])), _p, _rng_orage,
)
`);
  },

  async fixerPremierEclair(position) {
    if (!this.isReady) throw new Error("Pyodide pas prêt");
    this.pyodide.globals.set("_pos_json", JSON.stringify(position));
    await this.pyodide.runPythonAsync(`
import json
_pos = json.loads(_pos_json)
_generateur_orage_global.fixer_premier_eclair((float(_pos[0]), float(_pos[1])))
`);
  },

  async prochainEclair() {
    if (!this.isReady) throw new Error("Pyodide pas prêt");
    const py_result = await this.pyodide.runPythonAsync(`
_dt, _pos = _generateur_orage_global.prochain_eclair()
{"delta_t_s": float(_dt), "x_m": float(_pos[0]), "y_m": float(_pos[1])}
`);
    return py_result.toJs({ dict_converter: Object.fromEntries });
  },

  /* ----- Heatmap d'erreur (P11) ----- */

  /**
   * Évalue la médiane d'erreur Monte Carlo à une position donnée.
   * Appelée cellule par cellule depuis heatmap_erreur.js (boucle externe JS
   * pour pouvoir yield au browser entre cellules → progress bar live).
   */
  async evaluerCelluleErreur(stations_data, position_xy, sigmas_ns, n_trials) {
    if (!this.isReady) throw new Error("Pyodide pas prêt");
    this.pyodide.globals.set("_st_json", JSON.stringify(stations_data));
    this.pyodide.globals.set("_pos_json", JSON.stringify(position_xy));
    this.pyodide.globals.set("_sg_json", JSON.stringify(sigmas_ns));
    this.pyodide.globals.set("_n_tr", n_trials);
    const score = await this.pyodide.runPythonAsync(`
import json
import numpy as np
from lightning_tdoa.geometry import Station
from lightning_tdoa.simulator import NoiseConfig
from lightning_tdoa.metrics import evaluer_cellule_erreur

_st = json.loads(_st_json)
_pos = json.loads(_pos_json)
_sg = json.loads(_sg_json)

_stations = [Station(id=s["id"], x=float(s["x_m"]), y=float(s["y_m"])) for s in _st]
_cfg = NoiseConfig(
    sigma_vlf_ns=float(_sg["vlf"]),
    sigma_gps_ns=float(_sg["gps"]),
    sigma_horloge_ns=float(_sg["horloge"]),
)
float(evaluer_cellule_erreur(
    _stations, (float(_pos[0]), float(_pos[1])), _cfg,
    int(_n_tr), np.random.default_rng(),
))
`);
    return Number(score);
  },

};

// Démarre le chargement dès que la page est prête. Cache l'overlay quand prêt.
function _initPyodide() {
  window.pyodideBridge.chargerEtAttendre()
    .then(() => {
      const overlay = document.getElementById("pyodide-overlay");
      if (overlay) overlay.hidden = true;
      console.log("[pyodide] Lib lightning_tdoa prête. Cliquez dans la zone pour tester.");
    })
    .catch(err => {
      console.error("[pyodide] Échec :", err);
      const msg = document.querySelector("#pyodide-overlay .pyodide-msg");
      const detail = document.querySelector("#pyodide-overlay .pyodide-detail");
      if (msg) {
        msg.textContent = "Échec du chargement Pyodide";
        msg.style.color = "#ef4444";
      }
      if (detail) {
        detail.textContent = err.message + "  (Voir la console pour détails)";
      }
    });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _initPyodide);
} else {
  _initPyodide();
}
