"use strict";

/* ==========================================================================
   storm_generator.js — Scheduler JS du générateur d'orages (P7)

   Rôle : pendant l'état SIMULATION et si mode = "aleatoire", appelle Pyodide
   `prochainEclair()` pour obtenir (delta_t_s, x_m, y_m), schedule un setTimeout
   correspondant (divisé par le multiplicateur de vitesse), puis déclenche
   l'éclair via `animation.declencherEclair()` et recommence.

   Pause / Reprise :
   - À l'entrée en EN_PAUSE : annule le timer en cours.
   - Au retour en SIMULATION : reprogramme la suite.

   Limitation acceptée : changer le multiplicateur ou faire pause pendant
   qu'un éclair est tiré côté Python (entre `prochainEclair()` et le firing
   du timer) "consomme" cet éclair sans le rendre visible. La position
   suivante est tirée depuis cette position fantôme. Documenté dans
   BUGS_AND_DECISIONS.md.

   Expose `window.stormGenerator` :
   - .demarrer(centre_xy, parametres, position_premier_eclair, seed)
   - .arreter()
   ========================================================================== */

(function() {
  let timeoutId = null;
  let actif = false;  // true entre demarrer() et arreter()/reset

  async function demarrer(centre_xy, parametres, position_premier_eclair, seed) {
    if (!window.pyodideBridge?.isReady) {
      console.warn("[storm] Pyodide pas prêt.");
      return;
    }
    await window.pyodideBridge.creerGenerateurOrage(centre_xy, parametres, seed);
    await window.pyodideBridge.fixerPremierEclair(position_premier_eclair);
    actif = true;
    programmerProchain();
  }

  function arreter() {
    actif = false;
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }

  async function programmerProchain() {
    if (!actif) return;
    if (window.stateMachine?.etat !== "simulation") return;

    let res;
    try {
      res = await window.pyodideBridge.prochainEclair();
    } catch (err) {
      console.error("[storm] échec tirage prochain éclair :", err);
      return;
    }

    // Si l'état a changé pendant l'attente du tirage, on jette ce résultat
    // (note : la position est consommée côté Python, marche 2D décalée).
    if (!actif || window.stateMachine?.etat !== "simulation") return;

    const multiplicateur = window.stateMachine.multiplicateur ?? 1;
    const delta_ms = Math.max(0, (res.delta_t_s / multiplicateur) * 1000);

    timeoutId = setTimeout(() => {
      timeoutId = null;
      if (!actif || window.stateMachine?.etat !== "simulation") return;
      window.animation?.declencherEclair(res.x_m, res.y_m);
      programmerProchain();
    }, delta_ms);
  }

  /* --- Réagir aux changements d'état et de multiplicateur --- */

  function init() {
    if (!window.stateMachine) return;

    window.stateMachine.surChangement((evt) => {
      const nouveau = evt.detail.nouveau;
      if (nouveau === "en_pause") {
        // Suspend juste le timer (actif reste à true pour reprise)
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      } else if (nouveau === "simulation") {
        if (actif && timeoutId === null) {
          programmerProchain();
        }
      } else if (nouveau === "configuration") {
        arreter();
      }
    });

    window.stateMachine.surMultiplicateur(() => {
      // Annule timer en cours et reprogramme avec nouveau multiplicateur.
      // Coût : un éclair "perdu" dans la marche (déjà tiré côté Python).
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
        if (actif && window.stateMachine?.etat === "simulation") {
          programmerProchain();
        }
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.stormGenerator = { demarrer, arreter };
})();
