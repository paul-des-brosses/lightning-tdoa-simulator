"use strict";

/* ==========================================================================
   sidebar.js — Section haute adaptative de la sidebar (P3)

   En P3 : seul le bloc "Géométries prédéfinies" est rendu.
   Sera enrichi en P3 (autres blocs : mode de génération, paramètres orage),
   P6 (sidebar adaptative selon état), P10 (assistant placement S3), etc.

   Communique avec svg_scene.js via window.scene :
   - lit/écrit window.scene.etat.stations
   - appelle window.scene.dessinerScene()
   - s'abonne à window.scene.onAfterDrag (callback fin de drag)
   ========================================================================== */

(function() {
  const COTE_DEFAUT_KM = 50;
  const COTE_MIN_KM = 20;
  const COTE_MAX_KM = 100;

  // État local de la sidebar (preset, slider, mode de génération, params orage).
  // Consommé par storm_generator.js et svg_scene.js via window.sidebar.
  const etat_geo = {
    preset: "equilateral",
    cote_km: COTE_DEFAUT_KM,
    mode: "manuel",  // "manuel" | "aleatoire"
    parametres_orage: {
      rayon_max_km: 50,
      cadence_par_min: 12,         // 1 éclair toutes les 5 s en moyenne
      distance_moy_m: 5000,        // 5 km de marche moyenne
      derive_direction_deg: 0,     // 0 = Est
      derive_vitesse_m_par_s: 0,   // 0 = orage stationnaire
    },
  };

  /* --- Géométries (formules JS, à remplacer par triangle_predefini() Python en P4) --- */

  function geometrieEquilateral(L_m) {
    const R = L_m / Math.sqrt(3);  // rayon du cercle circonscrit
    return [
      { id: "S1", x_m: 0,        y_m:  R },
      { id: "S2", x_m: -L_m / 2, y_m: -R / 2 },
      { id: "S3", x_m:  L_m / 2, y_m: -R / 2 },
    ];
  }

  function geometrieEtire(L_m, aplatissement = 0.3) {
    // Triangle isocèle : base = L_m, hauteur = aplatissement × L_m, centré.
    const h = L_m * aplatissement;
    return [
      { id: "S1", x_m: 0,        y_m:  2 * h / 3 },
      { id: "S2", x_m: -L_m / 2, y_m: -h / 3 },
      { id: "S3", x_m:  L_m / 2, y_m: -h / 3 },
    ];
  }

  function geometrieObtus(L_m, angle_obtus_deg = 135) {
    // Triangle isocèle : 2 côtés issus de S1 de longueur L_m,
    // angle au sommet S1 = angle_obtus_deg. Recentré au barycentre.
    const demi_angle = (angle_obtus_deg / 2) * Math.PI / 180;
    const dx = L_m * Math.sin(demi_angle);
    const dy = L_m * Math.cos(demi_angle);
    // Repère où S1 = (0, 0), S2/S3 sous S1. Décalage pour mettre barycentre en (0, 0).
    return [
      { id: "S1", x_m: 0,    y_m:  2 * dy / 3 },
      { id: "S2", x_m: -dx,  y_m: -dy / 3 },
      { id: "S3", x_m:  dx,  y_m: -dy / 3 },
    ];
  }

  /* --- Application d'un preset --- */

  function appliquerPreset(nom) {
    if (nom === "personnalise") return;  // jamais cliqué directement
    etat_geo.preset = nom;
    const L = etat_geo.cote_km * 1000;
    let stations;
    if (nom === "equilateral")     stations = geometrieEquilateral(L);
    else if (nom === "etire")      stations = geometrieEtire(L);
    else if (nom === "obtus")      stations = geometrieObtus(L);
    else return;

    window.scene.etat.stations = stations;
    window.scene.dessinerScene();
    document.dispatchEvent(new CustomEvent("stations-change"));
    miseAJourBoutons();
    miseAJourVisibiliteSlider();
  }

  function miseAJourBoutons() {
    document.querySelectorAll(".boutons-geo button").forEach(btn => {
      const actif = btn.dataset.preset === etat_geo.preset;
      btn.classList.toggle("actif", actif);
      btn.setAttribute("aria-pressed", String(actif));
    });
  }

  function miseAJourVisibiliteSlider() {
    const slider_bloc = document.getElementById("slider-equilateral");
    if (!slider_bloc) return;
    slider_bloc.style.display = etat_geo.preset === "equilateral" ? "" : "none";
  }

  /* --- Bascule auto en "Personnalisé" sur drag --- */

  function basculerEnPersonnalise() {
    if (etat_geo.preset === "personnalise") return;
    etat_geo.preset = "personnalise";
    miseAJourBoutons();
    miseAJourVisibiliteSlider();
  }

  /* --- Rendu --- */

  function rendreSidebarConfiguration() {
    const haut = document.getElementById("sidebar-haut");
    if (!haut) return;

    const po = etat_geo.parametres_orage;
    const blocOrageVisible = etat_geo.mode === "aleatoire";

    haut.innerHTML = `
      <div class="sidebar-section">
        <h3>Géométries prédéfinies</h3>
        <div class="boutons-exclusifs boutons-geo">
          <button data-preset="equilateral" ${etat_geo.preset === "equilateral" ? "class='actif' aria-pressed='true'" : "aria-pressed='false'"}>Équilatéral</button>
          <button data-preset="etire" ${etat_geo.preset === "etire" ? "class='actif' aria-pressed='true'" : "aria-pressed='false'"}>Étiré</button>
          <button data-preset="obtus" ${etat_geo.preset === "obtus" ? "class='actif' aria-pressed='true'" : "aria-pressed='false'"}>Obtus</button>
          <button data-preset="personnalise" disabled ${etat_geo.preset === "personnalise" ? "class='actif' aria-pressed='true'" : "aria-pressed='false'"} title="S'active automatiquement quand vous déplacez une station">Personnalisé</button>
        </div>
        <div class="slider-bloc" id="slider-equilateral" style="${etat_geo.preset === "equilateral" ? "" : "display:none;"}">
          <label>Côté <span class="val" id="cote-val">${etat_geo.cote_km} km</span></label>
          <input type="range" id="cote-slider"
                 min="${COTE_MIN_KM}" max="${COTE_MAX_KM}"
                 value="${etat_geo.cote_km}" step="1"
                 aria-label="Longueur du côté du triangle équilatéral en km">
        </div>
      </div>

      <div class="sidebar-section">
        <h3>Mode de génération</h3>
        <div class="boutons-exclusifs boutons-mode">
          <button data-mode="aleatoire" ${etat_geo.mode === "aleatoire" ? "class='actif' aria-pressed='true'" : "aria-pressed='false'"}>Aléatoire</button>
          <button data-mode="manuel" ${etat_geo.mode === "manuel" ? "class='actif' aria-pressed='true'" : "aria-pressed='false'"}>Manuel</button>
        </div>
      </div>

      <div class="sidebar-section" id="bloc-params-orage" style="${blocOrageVisible ? "" : "display:none;"}">
        <h3>Paramètres orage</h3>
        <div class="slider-bloc">
          <label>Rayon max <span class="val" id="po-rayon-val">${po.rayon_max_km} km</span></label>
          <input type="range" id="po-rayon" min="5" max="3500" step="5" value="${po.rayon_max_km}">
        </div>
        <div class="slider-bloc">
          <label>Cadence <span class="val" id="po-cadence-val">${po.cadence_par_min} /min</span></label>
          <input type="range" id="po-cadence" min="1" max="60" step="1" value="${po.cadence_par_min}">
        </div>
        <div class="slider-bloc">
          <label>Distance moy. <span class="val" id="po-dist-val">${po.distance_moy_m} m</span></label>
          <input type="range" id="po-dist" min="100" max="20000" step="100" value="${po.distance_moy_m}">
        </div>
        <div class="slider-bloc">
          <label>Direction dérive <span class="val" id="po-dir-val">${po.derive_direction_deg}°</span></label>
          <input type="number" id="po-dir" min="0" max="359" step="1" value="${po.derive_direction_deg}" class="input-numerique">
        </div>
        <div class="slider-bloc">
          <label>Vitesse dérive <span class="val" id="po-vit-val">${po.derive_vitesse_m_par_s} m/s</span></label>
          <input type="range" id="po-vit" min="0" max="50" step="1" value="${po.derive_vitesse_m_par_s}">
        </div>
      </div>

      <div class="sidebar-section" id="bloc-heatmap-config">
        ${rendreBoutonHeatmap("config")}
      </div>

      <div class="sidebar-section">
        <button class="btn-lancer-sidebar" id="btn-lancer-sidebar">Lancer la simulation</button>
      </div>
    `;

    /* --- Listeners géométrie --- */
    document.querySelectorAll(".boutons-geo button:not(:disabled)").forEach(btn => {
      btn.addEventListener("click", () => appliquerPreset(btn.dataset.preset));
    });

    const slider = document.getElementById("cote-slider");
    const cote_val = document.getElementById("cote-val");
    if (slider && cote_val) {
      slider.addEventListener("input", () => {
        etat_geo.cote_km = parseInt(slider.value, 10);
        cote_val.textContent = `${etat_geo.cote_km} km`;
        if (etat_geo.preset === "equilateral") {
          window.scene.etat.stations = geometrieEquilateral(etat_geo.cote_km * 1000);
          window.scene.dessinerScene();
          document.dispatchEvent(new CustomEvent("stations-change"));
        }
      });
    }

    /* --- Listeners mode de génération --- */
    document.querySelectorAll(".boutons-mode button").forEach(btn => {
      btn.addEventListener("click", () => {
        etat_geo.mode = btn.dataset.mode;
        rendreSidebarConfiguration();  // re-render pour afficher/masquer params
      });
    });

    /* --- Listeners paramètres orage --- */
    function brancherSlider(id, valId, suffixe, cible) {
      const el = document.getElementById(id);
      const val = document.getElementById(valId);
      if (!el || !val) return;
      el.addEventListener("input", () => {
        const v = parseFloat(el.value);
        po[cible] = v;
        val.textContent = `${v} ${suffixe}`;
      });
    }
    brancherSlider("po-rayon",   "po-rayon-val",   "km",    "rayon_max_km");
    brancherSlider("po-cadence", "po-cadence-val", "/min",  "cadence_par_min");
    brancherSlider("po-dist",    "po-dist-val",    "m",     "distance_moy_m");
    brancherSlider("po-dir",     "po-dir-val",     "°",     "derive_direction_deg");
    brancherSlider("po-vit",     "po-vit-val",     "m/s",   "derive_vitesse_m_par_s");

    document.getElementById("btn-lancer-sidebar")?.addEventListener("click", () => {
      window.stateMachine?.lancer();
    });

    brancherListenersHeatmap("config");
  }

  function rendreSidebarSimulation() {
    const haut = document.getElementById("sidebar-haut");
    if (!haut) return;

    const etat = window.stateMachine?.etat;
    const carteActive = etat === window.ETATS?.EN_PAUSE;
    const rappelAttente = etat === window.ETATS?.EN_ATTENTE;
    const heatmap = window.heatmapErreur?.etat;
    const heatmapDispo = !!heatmap?.grille;

    haut.innerHTML = `
      <div class="sidebar-section">
        <h3>Couches visibles</h3>
        <label class="checkbox"><input type="checkbox" checked disabled> Éclairs réels</label>
        <label class="checkbox"><input type="checkbox" checked disabled> Détections</label>
        <label class="checkbox" id="cb-carte-erreur-pause"
               ${(!carteActive || !heatmapDispo) ? "title='Calculer la carte d\\'erreur d\\'abord'" : ""}>
          <input type="checkbox"
                 ${(carteActive && heatmapDispo && heatmap?.visible) ? "checked" : ""}
                 ${(carteActive && heatmapDispo) ? "" : "disabled"}>
          Carte d'erreur
        </label>
        <label class="checkbox"><input type="checkbox" disabled> Cercle de validité</label>
      </div>
      <div class="sidebar-section" id="bloc-heatmap-pause">
        ${rendreBoutonHeatmap(carteActive ? "pause" : "pause-grise")}
      </div>
      ${rappelAttente ? `
        <div class="sidebar-section attente-rappel">
          <strong>Mode manuel</strong><br>
          <em>Cliquez sur la zone pour déclencher le premier éclair.</em>
        </div>
      ` : ""}
    `;
    if (carteActive) {
      brancherListenersHeatmap("pause");
    }
  }

  /* --- Bloc bouton "Calculer la carte d'erreur" (P11) --- */

  function rendreBoutonHeatmap(contexte) {
    // contexte ∈ {"config", "pause", "pause-grise"}
    const e = window.heatmapErreur?.etat;
    const enCours = e?.en_cours;
    const dispo = !!e?.grille;
    const peutCliquer = (contexte === "config" || contexte === "pause") && !enCours;
    const grise = !peutCliquer;

    let label;
    if (enCours) {
      label = `Calcul carte… ${e.progres.k}/${e.progres.n}`;
    } else if (dispo) {
      label = "Recalculer la carte d'erreur";
    } else {
      label = "Calculer la carte d'erreur";
    }

    const tooltip = (contexte === "pause-grise")
      ? "title='Mettre en pause pour calculer'" : "";

    return `
      <button class="btn-section ${grise ? 'grise' : ''}"
              id="btn-calc-heatmap"
              ${grise ? 'disabled' : ''} ${tooltip}>
        ${label}
      </button>
    `;
  }

  function brancherListenersHeatmap(contexte) {
    document.getElementById("btn-calc-heatmap")?.addEventListener("click", () => {
      window.heatmapErreur?.calculer();
    });

    if (contexte === "pause") {
      const cb = document.querySelector("#cb-carte-erreur-pause input");
      if (cb) {
        cb.addEventListener("change", () => {
          window.heatmapErreur?.setVisible(cb.checked);
        });
      }
    }
  }

  function rerenderBoutonHeatmap() {
    const e = window.stateMachine?.etat;
    if (e === "configuration" || !e) {
      const bloc = document.getElementById("bloc-heatmap-config");
      if (bloc) {
        bloc.innerHTML = rendreBoutonHeatmap("config");
        brancherListenersHeatmap("config");
      }
    } else if (e === "en_attente" || e === "simulation" || e === "en_pause") {
      // Re-render aussi le bloc couches visibles (la checkbox change)
      // Plus simple : re-render full sidebar simulation
      rendreSidebarSimulation();
    }
  }

  function rendreSelonEtat() {
    const e = window.stateMachine?.etat ?? window.ETATS?.CONFIGURATION ?? "configuration";
    if (e === "configuration" || e === "rapport") {
      rendreSidebarConfiguration();
    } else {
      rendreSidebarSimulation();
    }
    majSidebarBasseGrise(e);
    majOverlayAttente(e);
  }

  function majSidebarBasseGrise(e) {
    const bas = document.getElementById("sidebar-bas");
    if (bas) bas.classList.toggle("grise", e !== "configuration");
  }

  function majOverlayAttente(e) {
    const overlay = document.querySelector(".overlay-attente");
    if (overlay) overlay.hidden = (e !== "en_attente");
  }

  /* --- Section basse persistante : mode de bruit (P8) --- */

  const etat_bruit = {
    preset: "desert",  // "desert" | "rural" | "urbain" | "personnalise"
    presets: {
      desert: { vlf: 50,  gps: 50,  horloge: 20 },
      rural:  { vlf: 150, gps: 80,  horloge: 50 },
      urbain: { vlf: 500, gps: 150, horloge: 100 },
    },
    sigmas_personnalise: { vlf: 100, gps: 50, horloge: 30 },
  };

  function sigmasCourants() {
    if (etat_bruit.preset === "personnalise") return etat_bruit.sigmas_personnalise;
    return etat_bruit.presets[etat_bruit.preset];
  }

  function sigmaTotalNs() {
    const s = sigmasCourants();
    return Math.sqrt(s.vlf ** 2 + s.gps ** 2 + s.horloge ** 2);
  }

  function rendreSidebarBas() {
    const bas = document.getElementById("sidebar-bas");
    if (!bas) return;
    const s = sigmasCourants();
    const isPerso = etat_bruit.preset === "personnalise";

    bas.innerHTML = `
      <h3>Mode de bruit</h3>
      <div class="boutons-exclusifs boutons-bruit">
        <button data-bruit="desert" ${etat_bruit.preset === "desert" ? "class='actif' aria-pressed='true'" : "aria-pressed='false'"}>Désert</button>
        <button data-bruit="rural" ${etat_bruit.preset === "rural" ? "class='actif' aria-pressed='true'" : "aria-pressed='false'"}>Rural</button>
        <button data-bruit="urbain" ${etat_bruit.preset === "urbain" ? "class='actif' aria-pressed='true'" : "aria-pressed='false'"}>Urbain</button>
        <button data-bruit="personnalise" ${isPerso ? "class='actif' aria-pressed='true'" : "aria-pressed='false'"}>Personnalisé</button>
      </div>

      ${isPerso ? `
        <div class="sliders-bruit">
          <div class="slider-bloc">
            <label>σ_vlf <span class="val" id="sigma-vlf-val">${s.vlf} ns</span></label>
            <input type="range" id="sigma-vlf" min="0" max="2000" step="10" value="${s.vlf}">
          </div>
          <div class="slider-bloc">
            <label>σ_gps <span class="val" id="sigma-gps-val">${s.gps} ns</span></label>
            <input type="range" id="sigma-gps" min="0" max="500" step="5" value="${s.gps}">
          </div>
          <div class="slider-bloc">
            <label>σ_horloge <span class="val" id="sigma-horloge-val">${s.horloge} ns</span></label>
            <input type="range" id="sigma-horloge" min="0" max="500" step="5" value="${s.horloge}">
          </div>
        </div>
      ` : `
        <div class="sigmas-readonly">
          <div class="ligne"><span>σ_vlf</span><span class="val">${s.vlf} ns</span></div>
          <div class="ligne"><span>σ_gps</span><span class="val">${s.gps} ns</span></div>
          <div class="ligne"><span>σ_horloge</span><span class="val">${s.horloge} ns</span></div>
        </div>
      `}

      <div class="ligne sigma-total">
        <span>σ_τ_total</span><span class="val" id="sigma-total-val">${Math.round(sigmaTotalNs())} ns</span>
      </div>
    `;

    document.querySelectorAll(".boutons-bruit button").forEach(btn => {
      btn.addEventListener("click", () => {
        etat_bruit.preset = btn.dataset.bruit;
        rendreSidebarBas();
      });
    });

    if (isPerso) {
      const brancherSigma = (id, valId, cible) => {
        const el = document.getElementById(id);
        const val = document.getElementById(valId);
        if (!el || !val) return;
        el.addEventListener("input", () => {
          const v = parseInt(el.value, 10);
          etat_bruit.sigmas_personnalise[cible] = v;
          val.textContent = `${v} ns`;
          document.getElementById("sigma-total-val").textContent =
            `${Math.round(sigmaTotalNs())} ns`;
        });
      };
      brancherSigma("sigma-vlf", "sigma-vlf-val", "vlf");
      brancherSigma("sigma-gps", "sigma-gps-val", "gps");
      brancherSigma("sigma-horloge", "sigma-horloge-val", "horloge");
    }
  }

  /* --- Init --- */

  function init() {
    rendreSelonEtat();
    rendreSidebarBas();
    if (window.scene) {
      window.scene.onAfterDrag = basculerEnPersonnalise;
    } else {
      console.warn("[sidebar] window.scene non défini — svg_scene.js doit être chargé avant.");
    }
    if (window.stateMachine) {
      window.stateMachine.surChangement(rendreSelonEtat);
    }
    // P11 : maj du bouton heatmap quand son état change
    document.addEventListener("heatmap-erreur-change", rerenderBoutonHeatmap);
  }

  // Exposition pour debug et modules consommateurs
  window.sidebar = { etat_geo, appliquerPreset, etat_bruit, sigmasCourants, sigmaTotalNs };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
