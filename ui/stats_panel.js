"use strict";

/* ==========================================================================
   stats_panel.js — Encadré stats live bas-droite (P9)

   Visible à partir de l'état EN_ATTENTE (caché en CONFIGURATION et RAPPORT).
   Met à jour 5 fois par seconde tant que le panel est visible :
   - Temps écoulé (mm:ss ou hh:mm:ss), exclu les pauses
   - Nombre d'éclairs (toutes phases d'animation)
   - Taux observé (éclairs/min)
   - Erreurs médiane / p95 / max (sur les éclairs avec détection)
   - Pourcentage de détections sous le seuil paramétrable

   Le seuil détection (défaut 500 m) est éditable inline. Modifier le seuil :
   1. recalcule immédiatement le pourcentage,
   2. force le redraw des éclairs (couleurs palette météo pivotées).

   Expose `window.statsPanel` :
   - .seuilDetection() → number  (utilisé par animation.couleurMeteo)
   - .resetSeuil()                (appelé par state_machine au reset)
   - .actualiser()                (forçage manuel)
   ========================================================================== */

(function() {
  const SEUIL_DEFAUT_M = 500;
  const PERIODE_REFRESH_MS = 200;  // 5 Hz

  const etat_stats = { seuil_m: SEUIL_DEFAUT_M };
  let timerId = null;

  /* ---- Calculs ---- */

  function tempsEcouleMs() {
    const sm = window.stateMachine;
    if (!sm || sm.t_simulation_debut === null) return 0;
    const now = performance.now();
    let total = now - sm.t_simulation_debut - (sm.t_pause_total_ms ?? 0);
    if (sm.etat === "en_pause" && sm.t_pause_debut !== null) {
      total -= (now - sm.t_pause_debut);
    }
    return Math.max(0, total);
  }

  function median(arr) {
    if (!arr.length) return NaN;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function percentile(arr, p) {
    if (!arr.length) return NaN;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
  }

  function calculerStats() {
    const eclairs = window.animation?.eclairs ?? [];
    const erreurs = eclairs
      .filter(e => e.detection)
      .map(e => e.detection.erreur_m);
    const t_ms = tempsEcouleMs();
    const taux_par_min = (eclairs.length > 0 && t_ms > 0)
      ? eclairs.length / (t_ms / 60000) : 0;
    const sous_seuil = erreurs.filter(e => e < etat_stats.seuil_m).length;
    return {
      temps_ms: t_ms,
      nb_eclairs: eclairs.length,
      nb_detectes: erreurs.length,
      taux_par_min,
      mediane: median(erreurs),
      p95: percentile(erreurs, 95),
      max: erreurs.length ? Math.max(...erreurs) : NaN,
      pct_sous_seuil: erreurs.length
        ? Math.round((sous_seuil / erreurs.length) * 100) : 0,
    };
  }

  /* ---- Formatage ---- */

  function formatTemps(ms) {
    const total_s = Math.floor(ms / 1000);
    const h = Math.floor(total_s / 3600);
    const m = Math.floor((total_s % 3600) / 60);
    const s = total_s % 60;
    const pad = n => n.toString().padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function formatDistance(m) {
    if (Number.isNaN(m)) return "—";
    if (m >= 10000) return `${(m / 1000).toFixed(1)} km`;
    return `${Math.round(m)} m`;
  }

  /* ---- Rendu ---- */

  function actualiser() {
    const panel = document.getElementById("stats-panel");
    if (!panel) return;
    const s = calculerStats();
    const lignes = panel.querySelectorAll(".ligne:not(.ligne-seuil) .val");

    if (lignes[0]) lignes[0].textContent = formatTemps(s.temps_ms);
    if (lignes[1]) lignes[1].textContent = String(s.nb_eclairs);
    if (lignes[2]) lignes[2].textContent = s.nb_eclairs > 0
      ? `${s.taux_par_min.toFixed(1)} /min`
      : "— /min";
    if (lignes[3]) lignes[3].textContent = formatDistance(s.mediane);
    if (lignes[4]) lignes[4].textContent = formatDistance(s.p95);
    if (lignes[5]) lignes[5].textContent = formatDistance(s.max);

    const pctVal = panel.querySelector(".ligne-seuil .val");
    if (pctVal) {
      pctVal.textContent = s.nb_detectes > 0
        ? `${s.pct_sous_seuil} %`
        : "— %";
    }
  }

  function visible(estVisible) {
    const panel = document.getElementById("stats-panel");
    if (!panel) return;
    panel.classList.toggle("cache", !estVisible);
  }

  function demarrer() {
    if (timerId !== null) return;
    actualiser();
    timerId = setInterval(actualiser, PERIODE_REFRESH_MS);
  }

  function arreter() {
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
  }

  /* ---- Init ---- */

  function init() {
    const panel = document.getElementById("stats-panel");
    if (!panel) return;

    const seuilInput = panel.querySelector(".seuil-input");
    if (seuilInput) {
      seuilInput.value = etat_stats.seuil_m;
      seuilInput.addEventListener("input", () => {
        const v = parseInt(seuilInput.value, 10);
        if (!Number.isNaN(v) && v >= 0) {
          etat_stats.seuil_m = v;
          actualiser();
          window.animation?.dessinerEclairs?.();  // recolore les détections
        }
      });
    }

    if (window.stateMachine) {
      const maj = () => {
        const e = window.stateMachine.etat;
        const peutVoir = e === "en_attente" || e === "simulation" || e === "en_pause";
        visible(peutVoir);
        if (peutVoir) demarrer(); else arreter();
      };
      window.stateMachine.surChangement(maj);
      maj();
    } else {
      visible(false);
    }
  }

  function resetSeuil() {
    etat_stats.seuil_m = SEUIL_DEFAUT_M;
    const seuilInput = document.querySelector("#stats-panel .seuil-input");
    if (seuilInput) seuilInput.value = SEUIL_DEFAUT_M;
    actualiser();
  }

  window.statsPanel = {
    seuilDetection: () => etat_stats.seuil_m,
    resetSeuil,
    actualiser,
    calculerStats,  // exposé pour rapport_pdf (P12)
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
