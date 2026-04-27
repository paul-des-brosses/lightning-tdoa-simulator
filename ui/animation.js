"use strict";

/* ==========================================================================
   animation.js — Cycle de vie visuel d'un éclair (P5)

   Phases d'animation (timing FIXÉ par la spec, indépendant de la physique) :

     T = 0         : point central blanc plein (rayon 3 + puissance px) +
                     halo blanc large flash (rayon × 5, opacité 0.6 → 0).
     T = 0  → 150  : halo s'étend et s'estompe.
     T = 0  → 800  : onde circulaire blanche, rayon 0 → 20+15·puissance px,
                     opacité 0.8 → 0, trait 1.5 px.
     T ≥ 800       : point central reste à opacité 0.4.
     T = 800       : appel Pyodide arrive → point de détection apparaît à
                     la position estimée (couleur palette météo, opacité 1.0).
     T = 800+30000 : début du fade détection vers opacité 0.4.

   L'appel Python est lancé EN PARALLÈLE de l'animation visuelle (au clic),
   et synchronisé visuellement avec la fin de l'onde (800 ms minimum).
   ========================================================================== */

(function() {
  const SVG_NS = "http://www.w3.org/2000/svg";

  // P5 : puissance fixe. Branchée aux contrôles UI en P9+ si besoin.
  const PUISSANCE_DEFAUT = 1;
  // Fallback si la sidebar n'a pas encore été initialisée (preset Désert)
  const SIGMAS_DEFAUT = { vlf: 50, gps: 50, horloge: 20 };

  function sigmasCourants() {
    return window.sidebar?.sigmasCourants?.() ?? SIGMAS_DEFAUT;
  }

  // Timings d'animation (millisecondes)
  const DUREE_HALO_MS = 150;
  const DUREE_ONDE_MS = 800;
  const DUREE_PLEINE_OPACITE_MS = 30000;
  const DUREE_FADE_MS = 5000;

  // Palette météo : pivote autour du seuil détection courant.
  // Ratios fixes [0.2×, 1×, 4×] du seuil → avec défaut 500 m, donne les
  // bornes initiales 100/500/2000 m de la spec.
  const SEUIL_DEFAUT_M = 500;

  /* État interne */
  const eclairs = [];   // [{id, t_debut, x_m, y_m, puissance, detection}]
  let animationId = null;

  /* Helpers */

  function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, v);
    }
    return el;
  }

  function couleurMeteo(erreur_m) {
    const s = window.statsPanel?.seuilDetection?.() ?? SEUIL_DEFAUT_M;
    if (erreur_m < s * 0.2) return "#10b981";  // vert émeraude
    if (erreur_m < s)        return "#eab308";  // jaune
    if (erreur_m < s * 4)    return "#f97316";  // orange
    return "#ef4444";                            // rouge
  }

  function obtenirGroupeEclairs(svg) {
    let g = svg.querySelector("g.eclairs");
    if (!g) {
      g = svgEl("g", { class: "eclairs" });
      svg.appendChild(g);
    }
    // Toujours réinjecter en dernier pour z-order au-dessus de tout
    svg.appendChild(g);
    return g;
  }

  /* Rendu des éclairs (appelé chaque frame quand actifs, et sur dessinerScene) */

  function dessinerEclairs() {
    const svg = document.querySelector(".scene");
    if (!svg || !window.scene) return;

    const g = obtenirGroupeEclairs(svg);
    g.innerHTML = "";

    const t = window.scene.calculerTransformation(svg);
    const t_now = performance.now();

    for (const eclair of eclairs) {
      const dt = t_now - eclair.t_debut;
      const p = t.monde_vers_svg(eclair.x_m, eclair.y_m);
      const r_point = 3 + eclair.puissance;

      // Halo flash (0 → 150 ms) : grand cercle blanc qui s'estompe
      if (dt < DUREE_HALO_MS) {
        const progres = dt / DUREE_HALO_MS;
        const r_halo = r_point * 5 * (1 + progres * 0.5);
        g.appendChild(svgEl("circle", {
          cx: p.x, cy: p.y, r: r_halo,
          fill: "#ffffff",
          opacity: 0.6 * (1 - progres),
        }));
      }

      // Onde circulaire (0 → 800 ms)
      if (dt < DUREE_ONDE_MS) {
        const progres = dt / DUREE_ONDE_MS;
        const r_onde = progres * (20 + 15 * eclair.puissance);
        g.appendChild(svgEl("circle", {
          cx: p.x, cy: p.y, r: r_onde,
          fill: "none", stroke: "#ffffff",
          "stroke-width": 1.5,
          opacity: 0.8 * (1 - progres),
        }));
      }

      // Point central (toujours visible : opacité 1.0 puis 0.4 après l'onde)
      const opacity_point = (dt < DUREE_ONDE_MS) ? 1.0 : 0.4;
      g.appendChild(svgEl("circle", {
        cx: p.x, cy: p.y, r: r_point,
        fill: "#ffffff",
        opacity: opacity_point,
      }));

      // Détection (si Pyodide a répondu)
      if (eclair.detection) {
        const det = eclair.detection;
        const dt_det = t_now - det.t_apparition;
        let opacity_det = 1.0;
        if (dt_det > DUREE_PLEINE_OPACITE_MS) {
          const fade = Math.min(1, (dt_det - DUREE_PLEINE_OPACITE_MS) / DUREE_FADE_MS);
          opacity_det = 1.0 - fade * 0.6;  // 1.0 → 0.4
        }
        const p_det = t.monde_vers_svg(det.x_m, det.y_m);
        const couleur = couleurMeteo(det.erreur_m);

        // Ligne d'erreur réelle ↔ estimée (pointillé discret)
        g.appendChild(svgEl("line", {
          x1: p.x, y1: p.y, x2: p_det.x, y2: p_det.y,
          stroke: couleur, "stroke-width": 1,
          "stroke-dasharray": "2 3",
          opacity: opacity_det * 0.5,
        }));

        // Point de détection (palette météo)
        g.appendChild(svgEl("circle", {
          cx: p_det.x, cy: p_det.y, r: 5,
          fill: couleur,
          opacity: opacity_det,
        }));
      }
    }
  }

  /* Boucle d'animation : tourne tant qu'au moins un éclair n'est pas terminé */

  function tousLesEclairsTermines() {
    if (eclairs.length === 0) return true;
    const t_now = performance.now();
    return eclairs.every(e => {
      // Tant que pas de détection, on attend Pyodide
      if (!e.detection) return false;
      const dt_det = t_now - e.detection.t_apparition;
      return dt_det > DUREE_PLEINE_OPACITE_MS + DUREE_FADE_MS;
    });
  }

  function lancerBoucleAnimation() {
    if (animationId !== null) return;
    function frame() {
      dessinerEclairs();
      if (tousLesEclairsTermines()) {
        animationId = null;
        // Un dernier dessin pour figer l'état final
        dessinerEclairs();
      } else {
        animationId = requestAnimationFrame(frame);
      }
    }
    animationId = requestAnimationFrame(frame);
  }

  /* API publique */

  async function declencherEclair(x_m, y_m, puissance = PUISSANCE_DEFAUT) {
    const eclair = {
      id: Date.now() + Math.random(),
      t_debut: performance.now(),
      x_m, y_m,
      puissance,
      detection: null,
    };
    eclairs.push(eclair);
    lancerBoucleAnimation();

    if (!window.pyodideBridge?.isReady) {
      console.warn("[animation] Pyodide pas prêt — pas de détection calculée.");
      return;
    }

    try {
      // Appel Python en parallèle de l'animation visuelle
      const promesseRes = window.pyodideBridge.simulerEtResoudre(
        [x_m, y_m],
        window.scene.etat.stations,
        sigmasCourants(),
      );
      // Attendre AU MOINS la fin de l'onde (800 ms) pour que la détection
      // apparaisse au bon moment visuellement, même si Python répond plus vite.
      const tempsRestant = DUREE_ONDE_MS - (performance.now() - eclair.t_debut);
      const promesseAttente = new Promise(r => setTimeout(r, Math.max(0, tempsRestant)));
      const [res] = await Promise.all([promesseRes, promesseAttente]);

      eclair.detection = {
        x_m: res.position_estimee[0],
        y_m: res.position_estimee[1],
        erreur_m: res.erreur_m,
        gdop: res.gdop,
        t_apparition: performance.now(),
      };
      lancerBoucleAnimation();  // au cas où la boucle s'était arrêtée
    } catch (err) {
      console.error("[animation] Échec Pyodide :", err);
    }
  }

  /* Expose */
  window.animation = {
    declencherEclair,
    dessinerEclairs,
    couleurMeteo,
    eclairs,  // pour debug et P9 (stats panel)
  };
})();
