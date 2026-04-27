"use strict";

/* ==========================================================================
   heatmap_erreur.js — Carte d'erreur calculée à la demande (P11)

   En CONFIGURATION ou EN_PAUSE, l'utilisateur peut lancer un calcul Monte
   Carlo sur une grille 2D autour des stations. La heatmap est ensuite
   superposée à la zone via un overlay SVG, avec la palette météo
   pivotée autour du seuil détection courant.

   - Calcul cellule par cellule (yield au browser entre cellules → progress
     bar live, comme P10 retiré).
   - Auto-invalidation : si les stations bougent (drag, preset géométrique),
     la heatmap est effacée car obsolète.

   Expose `window.heatmapErreur` :
   - .calculer()        → kicks off the async calc
   - .setVisible(b)     → show/hide overlay (sans recalculer)
   - .effacer()         → drop la grille + cache overlay
   - .dessinerOverlay(svg, t, svgEl) → appelé par svg_scene.dessinerScene
   ========================================================================== */

(function() {
  const RESOLUTION = 20;
  const N_TRIALS = 20;
  const EXTENT_RATIO = 3.0;       // grille = 3× le diamètre stations
  const FLOOR_SPAN_M = 60_000;     // floor pour stations très resserrées

  const etat = {
    grille: null,                  // {grille: number[], xs, ys, resolution}
    visible: false,
    en_cours: false,
    progres: { k: 0, n: 0 },
    stations_snapshot: null,
  };

  function emettreChange() {
    document.dispatchEvent(new CustomEvent("heatmap-erreur-change"));
  }

  function snapshotStations(stations) {
    return JSON.stringify(
      stations.map(s => ({ id: s.id, x_m: s.x_m, y_m: s.y_m }))
    );
  }

  function calculerExtent() {
    const stations = window.scene.etat.stations;
    const xs = stations.map(s => s.x_m);
    const ys = stations.map(s => s.y_m);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const dx = Math.max(...xs) - Math.min(...xs);
    const dy = Math.max(...ys) - Math.min(...ys);
    const span = Math.max(dx, dy, FLOOR_SPAN_M) * EXTENT_RATIO;
    return {
      xmin: cx - span / 2, xmax: cx + span / 2,
      ymin: cy - span / 2, ymax: cy + span / 2,
    };
  }

  async function calculer() {
    if (!window.pyodideBridge?.isReady) {
      console.warn("[heatmap_erreur] Pyodide pas prêt");
      return;
    }
    if (etat.en_cours) return;

    etat.en_cours = true;
    etat.grille = null;
    etat.progres = { k: 0, n: RESOLUTION * RESOLUTION };
    emettreChange();

    const stations = window.scene.etat.stations;
    const stations_data = stations.map(s => ({ id: s.id, x_m: s.x_m, y_m: s.y_m }));
    const sigmas = window.sidebar?.sigmasCourants?.() ?? { vlf: 50, gps: 50, horloge: 20 };
    const ext = calculerExtent();

    const xs = [];
    const ys = [];
    for (let i = 0; i < RESOLUTION; i++) {
      const t = i / (RESOLUTION - 1);
      xs.push(ext.xmin + t * (ext.xmax - ext.xmin));
      ys.push(ext.ymin + t * (ext.ymax - ext.ymin));
    }

    const grille = new Array(RESOLUTION * RESOLUTION).fill(Infinity);
    let k = 0;
    for (let i = 0; i < RESOLUTION; i++) {
      for (let j = 0; j < RESOLUTION; j++) {
        if (!etat.en_cours) return;  // annulation externe
        let score = Infinity;
        try {
          score = await window.pyodideBridge.evaluerCelluleErreur(
            stations_data, [xs[j], ys[i]], sigmas, N_TRIALS,
          );
        } catch (err) {
          console.error("[heatmap_erreur] échec cellule:", err);
        }
        grille[i * RESOLUTION + j] = score;
        k++;
        etat.progres = { k, n: RESOLUTION * RESOLUTION };
        emettreChange();
        await new Promise(r => setTimeout(r, 0));  // yield au browser
      }
    }

    etat.grille = { grille, xs, ys, resolution: RESOLUTION };
    etat.stations_snapshot = snapshotStations(stations);
    etat.visible = true;
    etat.en_cours = false;
    emettreChange();
    window.scene?.dessinerScene?.();
  }

  function setVisible(v) {
    etat.visible = v;
    emettreChange();
    window.scene?.dessinerScene?.();
  }

  function effacer() {
    etat.grille = null;
    etat.visible = false;
    etat.en_cours = false;
    etat.stations_snapshot = null;
    emettreChange();
    window.scene?.dessinerScene?.();
  }

  function invaliderSiPerime() {
    if (!etat.grille) return;
    const stations = window.scene.etat.stations;
    if (snapshotStations(stations) !== etat.stations_snapshot) {
      effacer();
    }
  }

  /* --- Rendu overlay (appelé par svg_scene.dessinerScene) --- */

  function dessinerOverlay(svg, t, svgEl) {
    if (!etat.visible || !etat.grille) return;
    const g = etat.grille;
    const overlay = svgEl("g", {
      class: "overlay-heatmap-erreur",
      "pointer-events": "none",
    });

    const cell_w_m = g.xs[1] - g.xs[0];
    const cell_h_m = g.ys[1] - g.ys[0];

    for (let i = 0; i < g.resolution; i++) {
      for (let j = 0; j < g.resolution; j++) {
        const score = g.grille[i * g.resolution + j];
        if (!Number.isFinite(score)) continue;
        // Coin haut-gauche en monde (y inversé pour SVG : haut = y_max)
        const x_world = g.xs[j] - cell_w_m / 2;
        const y_world = g.ys[i] + cell_h_m / 2;
        const tl = t.monde_vers_svg(x_world, y_world);
        const w_px = cell_w_m * t.scale;
        const h_px = cell_h_m * t.scale;
        const couleur = window.animation?.couleurMeteo?.(score) ?? "#888";
        overlay.appendChild(svgEl("rect", {
          x: tl.x, y: tl.y, width: w_px, height: h_px,
          fill: couleur, opacity: 0.45,
        }));
      }
    }
    svg.appendChild(overlay);
  }

  // Auto-invalidation : si stations bougent
  document.addEventListener("stations-change", invaliderSiPerime);

  window.heatmapErreur = {
    etat,
    calculer,
    setVisible,
    effacer,
    dessinerOverlay,
  };
})();
