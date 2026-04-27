"use strict";

/* ==========================================================================
   svg_scene.js — Rendu SVG de la zone de simulation (P2)

   Responsabilités :
   - Mapping coordonnées monde (mètres ENU) ↔ SVG (pixels).
   - Auto-fit : le triangle de stations occupe le cadre avec marge.
   - Dessin de la grille (10 km de pas), du réseau, du barycentre,
     des stations (triangle contour + cercle plein + label monospace
     positionné côté opposé au barycentre).
   - Drag & drop des stations (phase Configuration).
   - Détection colinéarité provisoire en JS pour feedback temps-réel
     pendant le drag. Sera complétée en P4 par appel à
     `verifier_non_colineaires()` côté Python pour l'autorité finale.
   ========================================================================== */

const SVG_NS = "http://www.w3.org/2000/svg";

// Seuil sur le ratio "aire / côté_max²" du triangle de stations.
// Calibré pour donner un avertissement précoce (avant le seuil tol=1e-3
// de la SVD côté Python). En P4 on appellera verifier_non_colineaires()
// en complément pour l'autorité finale.
const SEUIL_COLINEARITE = 0.05;

const PAS_GRILLE_M = 10000;  // 10 km par cellule, conformément à la spec
const FLOOR_SPAN_M = 50000;  // évite zoom infini si stations confondues
const MARGE_PX = 80;         // marge autour du triangle dans la zone

/* ----- État de la scène (sera consommé par d'autres modules en P3+) ----- */

const etat = {
  // 3 stations équilatérales par défaut, côté 50 km, centrées sur l'origine.
  stations: [
    { id: "S1", x_m: 0,         y_m:  28867.51 },
    { id: "S2", x_m: -25000.00, y_m: -14433.76 },
    { id: "S3", x_m:  25000.00, y_m: -14433.76 },
  ],
  drag: null,  // { station, offset_sx, offset_sy } pendant un drag

  // Zoom molette + centre visuel verrouillé en coordonnées monde.
  // centre_visuel_*_m === null → auto-fit (centre = barycentre stations).
  // Dès que l'utilisateur scrolle, le centre se "verrouille" en monde
  // pour que le drag de station ne décale pas le point de vue.
  zoom_facteur: 1.0,
  centre_visuel_x_m: null,
  centre_visuel_y_m: null,
};

/* ----- Mapping coordonnées monde ↔ SVG ----- */

function calculerTransformation(svg) {
  const W = svg.clientWidth;
  const H = svg.clientHeight;

  const xs = etat.stations.map(s => s.x_m);
  const ys = etat.stations.map(s => s.y_m);
  const cx_m_base = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy_m_base = (Math.min(...ys) + Math.max(...ys)) / 2;
  const dx_m = Math.max(...xs) - Math.min(...xs);
  const dy_m = Math.max(...ys) - Math.min(...ys);
  const span_m = Math.max(dx_m, dy_m, FLOOR_SPAN_M);
  const base_scale = (Math.min(W, H) - 2 * MARGE_PX) / span_m;

  // Centre visuel : barycentre stations par défaut (auto-fit), ou centre
  // verrouillé si l'utilisateur a déjà zoomé/scrollé.
  const cx_m = (etat.centre_visuel_x_m !== null) ? etat.centre_visuel_x_m : cx_m_base;
  const cy_m = (etat.centre_visuel_y_m !== null) ? etat.centre_visuel_y_m : cy_m_base;
  const scale = base_scale * etat.zoom_facteur;

  return {
    monde_vers_svg(x_m, y_m) {
      return {
        x: W / 2 + (x_m - cx_m) * scale,
        y: H / 2 - (y_m - cy_m) * scale,  // Nord = haut
      };
    },
    svg_vers_monde(sx, sy) {
      return {
        x_m: cx_m + (sx - W / 2) / scale,
        y_m: cy_m - (sy - H / 2) / scale,
      };
    },
    scale, W, H, cx_m, cy_m,
  };
}

function resetZoom() {
  etat.zoom_facteur = 1.0;
  etat.centre_visuel_x_m = null;
  etat.centre_visuel_y_m = null;
  dessinerScene();
}

/* ----- Détection colinéarité (JS, provisoire jusqu'à P4) ----- */

function ratioColinearite(stations) {
  if (stations.length < 3) return 0;
  const [a, b, c] = stations;
  const cross = Math.abs(
    (b.x_m - a.x_m) * (c.y_m - a.y_m) -
    (b.y_m - a.y_m) * (c.x_m - a.x_m)
  );
  const ab = Math.hypot(b.x_m - a.x_m, b.y_m - a.y_m);
  const bc = Math.hypot(c.x_m - b.x_m, c.y_m - b.y_m);
  const ca = Math.hypot(a.x_m - c.x_m, a.y_m - c.y_m);
  const max_side = Math.max(ab, bc, ca);
  return max_side > 0 ? cross / (max_side * max_side) : 0;
}

/* ----- Helper de création SVG ----- */

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

/* ----- Dessin ----- */

function dessinerGrille(svg, t) {
  const grille = svgEl("g", {
    class: "grille",
    stroke: "#161b2a",
    "stroke-width": "1",
    fill: "none",
  });

  // Bornes visibles du SVG en coordonnées monde
  const haut_gauche = t.svg_vers_monde(0, 0);
  const bas_droit = t.svg_vers_monde(t.W, t.H);

  // Pas adaptatif : maintient ~30-60 lignes visibles quel que soit le zoom.
  // Indispensable depuis que rayon_max peut atteindre 3500 km en aléatoire.
  const span_m = Math.max(bas_droit.x_m - haut_gauche.x_m, haut_gauche.y_m - bas_droit.y_m);
  const pas = pasGrilleAdaptatif(span_m);

  const x_min = Math.floor(haut_gauche.x_m / pas) * pas;
  const x_max = Math.ceil(bas_droit.x_m / pas) * pas;
  const y_min = Math.floor(bas_droit.y_m / pas) * pas;
  const y_max = Math.ceil(haut_gauche.y_m / pas) * pas;

  for (let x = x_min; x <= x_max; x += pas) {
    const p1 = t.monde_vers_svg(x, y_min);
    const p2 = t.monde_vers_svg(x, y_max);
    grille.appendChild(svgEl("line", {
      x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
    }));
  }
  for (let y = y_min; y <= y_max; y += pas) {
    const p1 = t.monde_vers_svg(x_min, y);
    const p2 = t.monde_vers_svg(x_max, y);
    grille.appendChild(svgEl("line", {
      x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
    }));
  }
  svg.appendChild(grille);
}

function pasGrilleAdaptatif(span_visible_m) {
  // Cible : ~40 cellules visibles. Arrondi à la décade ou demi-décade
  // (1, 2, 5, 10, 20, 50, 100, 200, 500 km).
  const cible_m = span_visible_m / 40;
  const decade = Math.pow(10, Math.floor(Math.log10(cible_m)));
  const ratio = cible_m / decade;
  const mult = ratio < 1.5 ? 1 : ratio < 3.5 ? 2 : ratio < 7.5 ? 5 : 10;
  return Math.max(1000, mult * decade);  // plancher 1 km
}

function formaterDistance(d_m) {
  if (d_m < 1000) return `${Math.round(d_m)} m`;
  return `${(d_m / 1000).toFixed(1)} km`;
}

function dessinerReseau(svg, t, stations, est_colineaire) {
  const couleur = est_colineaire ? "#ef4444" : "#ffffff";
  const opacite = est_colineaire ? 0.7 : 0.4;

  const reseau = svgEl("g", {
    class: "reseau",
    stroke: couleur,
    "stroke-width": "1",
    opacity: opacite,
    fill: "none",
  });

  // Lignes du réseau
  for (let i = 0; i < stations.length; i++) {
    for (let j = i + 1; j < stations.length; j++) {
      const p1 = t.monde_vers_svg(stations[i].x_m, stations[i].y_m);
      const p2 = t.monde_vers_svg(stations[j].x_m, stations[j].y_m);
      reseau.appendChild(svgEl("line", {
        x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
      }));
    }
  }
  svg.appendChild(reseau);

  // Labels de distance (groupe séparé pour avoir un fill indépendant)
  const labels = svgEl("g", { class: "labels-distance" });
  for (let i = 0; i < stations.length; i++) {
    for (let j = i + 1; j < stations.length; j++) {
      const a = stations[i];
      const b = stations[j];
      const p1 = t.monde_vers_svg(a.x_m, a.y_m);
      const p2 = t.monde_vers_svg(b.x_m, b.y_m);
      const dist_m = Math.hypot(b.x_m - a.x_m, b.y_m - a.y_m);

      const label = svgEl("text", {
        x: (p1.x + p2.x) / 2,
        y: (p1.y + p2.y) / 2,
        class: "label-distance",
        "text-anchor": "middle",
        "dominant-baseline": "central",
        fill: couleur,
      });
      label.textContent = formaterDistance(dist_m);
      labels.appendChild(label);
    }
  }
  svg.appendChild(labels);

  // Barycentre "+"
  const cx = stations.reduce((s, st) => s + st.x_m, 0) / stations.length;
  const cy = stations.reduce((s, st) => s + st.y_m, 0) / stations.length;
  const bp = t.monde_vers_svg(cx, cy);
  const bary = svgEl("g", {
    stroke: "#ffffff", "stroke-width": "1", opacity: "0.6",
  });
  bary.appendChild(svgEl("line", {
    x1: bp.x - 5, y1: bp.y, x2: bp.x + 5, y2: bp.y,
  }));
  bary.appendChild(svgEl("line", {
    x1: bp.x, y1: bp.y - 5, x2: bp.x, y2: bp.y + 5,
  }));
  svg.appendChild(bary);
}

function dessinerStation(svg, t, station, toutes_stations) {
  const p = t.monde_vers_svg(station.x_m, station.y_m);

  // Label : positionné à 18 px de la station, dans la direction OPPOSÉE
  // au barycentre du triangle (pour ne pas chevaucher le réseau).
  const cx = toutes_stations.reduce((s, st) => s + st.x_m, 0) / toutes_stations.length;
  const cy = toutes_stations.reduce((s, st) => s + st.y_m, 0) / toutes_stations.length;
  const bp = t.monde_vers_svg(cx, cy);
  const dir_x = p.x - bp.x;
  const dir_y = p.y - bp.y;
  const dir_norm = Math.hypot(dir_x, dir_y) || 1;
  const decalage = 18;
  const label_x = p.x + (dir_x / dir_norm) * decalage;
  const label_y = p.y + (dir_y / dir_norm) * decalage;

  // Choix du text-anchor selon la direction dominante (lisibilité)
  let anchor = "middle";
  if (Math.abs(dir_x) > Math.abs(dir_y) * 0.4) {
    anchor = dir_x > 0 ? "start" : "end";
  }

  const g = svgEl("g", {
    class: "station",
    "data-id": station.id,
  });

  // Triangle contour, ~22 px de côté pointe vers le haut
  const T = 11;
  const triangle_pts = [
    `${p.x},${p.y - T}`,
    `${p.x - T * 0.866},${p.y + T * 0.5}`,
    `${p.x + T * 0.866},${p.y + T * 0.5}`,
  ].join(" ");
  g.appendChild(svgEl("polygon", {
    points: triangle_pts,
    fill: "none",
    stroke: "#ffffff",
    "stroke-width": "1.5",
  }));

  // Petit cercle central blanc plein
  g.appendChild(svgEl("circle", {
    cx: p.x, cy: p.y, r: 2.5,
    fill: "#ffffff",
  }));

  const label = svgEl("text", {
    x: label_x, y: label_y,
    class: "label-station",
    "text-anchor": anchor,
    "dominant-baseline": "middle",
  });
  label.textContent = station.id;
  g.appendChild(label);

  svg.appendChild(g);
}

function afficherMessageColineaire(zone, est_colineaire) {
  let msg = zone.querySelector(".message-colineaire");
  if (est_colineaire && !msg) {
    msg = document.createElement("div");
    msg.className = "message-colineaire";
    msg.textContent = "Configuration quasi-colinéaire, solveur désactivé";
    zone.appendChild(msg);
  } else if (!est_colineaire && msg) {
    msg.remove();
  }
}

function dessinerScene() {
  const svg = document.querySelector(".scene");
  const zone = document.getElementById("zone-simulation");
  if (!svg) return;

  const t = calculerTransformation(svg);
  // viewBox synchronisée avec clientWidth/Height pour des unités = pixels
  svg.setAttribute("viewBox", `0 0 ${t.W} ${t.H}`);

  const ratio = ratioColinearite(etat.stations);
  const est_colineaire = ratio < SEUIL_COLINEARITE;

  // Préserver le groupe d'éclairs (animations en cours) avant le clear.
  const groupeEclairs = svg.querySelector("g.eclairs");

  svg.innerHTML = "";
  dessinerGrille(svg, t);
  // Heatmap d'erreur (P11) : sous le réseau pour rester lisible
  window.heatmapErreur?.dessinerOverlay?.(svg, t, svgEl);
  dessinerReseau(svg, t, etat.stations, est_colineaire);
  for (const station of etat.stations) {
    dessinerStation(svg, t, station, etat.stations);
  }

  // Réinjecter les éclairs en dernier (z-order au-dessus de tout).
  if (groupeEclairs) {
    svg.appendChild(groupeEclairs);
  }
  // Si une animation est en cours, redraw immédiat avec la nouvelle transformation
  // (sinon les éclairs gardent leurs SVG-coords obsolètes le temps d'une frame).
  if (window.animation?.dessinerEclairs) {
    window.animation.dessinerEclairs();
  }

  afficherMessageColineaire(zone, est_colineaire);
}

/* ----- Drag & drop ----- */

function pointerVersSvg(svg, evt) {
  const rect = svg.getBoundingClientRect();
  return {
    sx: evt.clientX - rect.left,
    sy: evt.clientY - rect.top,
  };
}

function trouverStationSousPointer(svg, evt) {
  const t = calculerTransformation(svg);
  const { sx, sy } = pointerVersSvg(svg, evt);
  // Tolerance ~18 px pour faciliter le ciblage
  for (const station of etat.stations) {
    const p = t.monde_vers_svg(station.x_m, station.y_m);
    if (Math.hypot(sx - p.x, sy - p.y) < 18) return station;
  }
  return null;
}

function brancherDragDrop(svg) {
  svg.addEventListener("pointerdown", (evt) => {
    // Drag autorisé uniquement en CONFIGURATION
    if (window.stateMachine && window.stateMachine.etat !== "configuration") return;
    const station = trouverStationSousPointer(svg, evt);
    if (!station) return;
    evt.preventDefault();

    const t = calculerTransformation(svg);
    const { sx, sy } = pointerVersSvg(svg, evt);
    const p_station_svg = t.monde_vers_svg(station.x_m, station.y_m);
    etat.drag = {
      station,
      offset_sx: sx - p_station_svg.x,
      offset_sy: sy - p_station_svg.y,
    };
    svg.setPointerCapture(evt.pointerId);
    svg.style.cursor = "grabbing";
  });

  svg.addEventListener("pointermove", (evt) => {
    if (!etat.drag) return;
    const t = calculerTransformation(svg);
    const { sx, sy } = pointerVersSvg(svg, evt);
    const p_svg = {
      x: sx - etat.drag.offset_sx,
      y: sy - etat.drag.offset_sy,
    };
    const p_monde = t.svg_vers_monde(p_svg.x, p_svg.y);
    etat.drag.station.x_m = p_monde.x_m;
    etat.drag.station.y_m = p_monde.y_m;
    dessinerScene();
  });

  function finDrag(evt) {
    if (!etat.drag) return;
    try { svg.releasePointerCapture(evt.pointerId); } catch (e) { /* ignore */ }
    etat.drag = null;
    svg.style.cursor = "";
    // Notifier les modules abonnés (ex : sidebar.js → bascule en "Personnalisé")
    if (window.scene && typeof window.scene.onAfterDrag === "function") {
      window.scene.onAfterDrag();
    }
    // Notifie le changement de stations (consommé par heatmap_erreur, etc.)
    document.dispatchEvent(new CustomEvent("stations-change"));
  }
  svg.addEventListener("pointerup", finDrag);
  svg.addEventListener("pointercancel", finDrag);
}

/* ----- Zoom molette (centré sur le pointeur) ----- */

function brancherZoomMolette(svg) {
  svg.addEventListener("wheel", (evt) => {
    evt.preventDefault();

    const t_avant = calculerTransformation(svg);
    const { sx, sy } = pointerVersSvg(svg, evt);
    const m_avant = t_avant.svg_vers_monde(sx, sy);

    // 1.15× par cran de molette (zoom in si scroll up, out si scroll down)
    const facteur = (evt.deltaY < 0) ? 1.15 : 1 / 1.15;
    // Borne basse 0.01 = vue continentale (jusqu'à ~5000 km de span monde),
    // requis pour visualiser un orage de rayon 3500 km autour des stations.
    etat.zoom_facteur = Math.max(0.01, Math.min(20, etat.zoom_facteur * facteur));

    // Au premier scroll, verrouille le centre visuel en monde pour que
    // le drag ultérieur d'une station ne décale pas le point de vue.
    if (etat.centre_visuel_x_m === null) {
      etat.centre_visuel_x_m = t_avant.cx_m;
      etat.centre_visuel_y_m = t_avant.cy_m;
    }

    // Compense le centre pour que la position monde sous la souris
    // reste exactement sous la souris après le zoom (zoom-to-cursor).
    const t_apres = calculerTransformation(svg);
    const m_apres = t_apres.svg_vers_monde(sx, sy);
    etat.centre_visuel_x_m += m_avant.x_m - m_apres.x_m;
    etat.centre_visuel_y_m += m_avant.y_m - m_apres.y_m;

    dessinerScene();
  }, { passive: false });
}

/* ----- Click handler : déclenche un éclair sur clic hors station ----- */

function brancherClicEclair(svg) {
  svg.addEventListener("click", async (evt) => {
    if (trouverStationSousPointer(svg, evt)) return;

    const t = calculerTransformation(svg);
    const { sx, sy } = pointerVersSvg(svg, evt);
    const { x_m, y_m } = t.svg_vers_monde(sx, sy);

    const e = window.stateMachine?.etat;
    if (e !== "en_attente" && e !== "simulation") return;

    const mode = window.sidebar?.etat_geo?.mode ?? "manuel";

    // En SIMULATION + mode aléatoire : les clics utilisateur sont ignorés
    // (les éclairs viennent du scheduler). Le clic ne déclenche QUE le 1er
    // éclair en EN_ATTENTE.
    if (e === "simulation" && mode === "aleatoire") return;

    // 1er éclair (EN_ATTENTE) ou éclair manuel (SIMULATION + mode manuel)
    if (e === "en_attente") {
      window.stateMachine.declencherPremierEclair();
    }
    window.animation?.declencherEclair(x_m, y_m);

    // Si mode aléatoire et c'était le 1er clic : démarre le scheduler
    if (e === "en_attente" && mode === "aleatoire") {
      const stations = window.scene.etat.stations;
      const cx = stations.reduce((s, st) => s + st.x_m, 0) / stations.length;
      const cy = stations.reduce((s, st) => s + st.y_m, 0) / stations.length;
      const po = window.sidebar.etat_geo.parametres_orage;
      const params_python = {
        rayon_max_m: po.rayon_max_km * 1000,
        cadence_par_min: po.cadence_par_min,
        distance_moy_m: po.distance_moy_m,
        derive_direction_deg: po.derive_direction_deg,
        derive_vitesse_m_par_s: po.derive_vitesse_m_par_s,
      };
      const seed = Math.floor(Math.random() * 1e9);
      try {
        await window.stormGenerator.demarrer(
          [cx, cy], params_python, [x_m, y_m], seed,
        );
      } catch (err) {
        console.error("[svg_scene] échec démarrage storm :", err);
      }
    }
  });
}

/* ----- Init ----- */

function init() {
  const svg = document.querySelector(".scene");
  if (!svg) return;

  // Re-dessine au redimensionnement de la zone
  const observer = new ResizeObserver(() => dessinerScene());
  observer.observe(svg);

  brancherDragDrop(svg);
  brancherClicEclair(svg);
  brancherZoomMolette(svg);
  dessinerScene();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// Exposition pour les autres modules (sidebar.js, animation.js, app.js…).
// `onAfterDrag` est un hook qu'un module peut surcharger.
window.scene = {
  etat,
  dessinerScene,
  calculerTransformation,
  svgEl,
  resetZoom,
  onAfterDrag: null,
};
