"use strict";

/* ==========================================================================
   control_bar.js — Barre de contrôle top-right (P6)

   Lit les boutons HTML existants (id : btn-lancer/pause/arreter/reset,
   data-mult sur multiplicateurs) et adapte leur état actif/grisé/label
   selon stateMachine.etat.

   Active/grisé par état :
     CONFIGURATION : Lancer actif ; autres grisés
     EN_ATTENTE/SIMULATION : Lancer grisé, Pause actif, Stop+Reset grisés
     EN_PAUSE : Lancer = "Reprendre" actif, Pause grisé, Stop+Reset actifs
     RAPPORT (modale) : tout grisé temporairement
   ========================================================================== */

(function() {
  function init() {
    const btnLancer  = document.getElementById("btn-lancer");
    const btnPause   = document.getElementById("btn-pause");
    const btnArreter = document.getElementById("btn-arreter");
    const btnReset   = document.getElementById("btn-reset");
    const btnsMult   = document.querySelectorAll("[data-mult]");

    btnLancer ?.addEventListener("click", () => window.stateMachine.lancer());
    btnPause  ?.addEventListener("click", () => window.stateMachine.pause());
    btnArreter?.addEventListener("click", () => window.stateMachine.arreter());
    btnReset  ?.addEventListener("click", () => window.stateMachine.reset());

    btnsMult.forEach(btn => {
      btn.addEventListener("click", () => {
        const m = parseInt(btn.dataset.mult, 10);
        window.stateMachine.setMultiplicateur(m);
      });
    });

    window.stateMachine.surChangement(majBoutonsControle);
    window.stateMachine.surMultiplicateur(majBoutonsMult);
    majBoutonsControle();
    majBoutonsMult();
  }

  function setBouton(id, actif, label, tooltip) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = !actif;
    btn.classList.toggle("grise", !actif);
    if (label) btn.textContent = label;
    if (tooltip) btn.title = tooltip; else btn.removeAttribute("title");
  }

  function majBoutonsControle() {
    const e = window.stateMachine.etat;
    const E = window.ETATS;

    if (e === E.CONFIGURATION) {
      setBouton("btn-lancer",  true,  "Lancer");
      setBouton("btn-pause",   false, null);
      setBouton("btn-arreter", false, null);
      setBouton("btn-reset",   false, null, "Aucun éclair à réinitialiser");
    } else if (e === E.EN_ATTENTE || e === E.SIMULATION) {
      setBouton("btn-lancer",  false, "Lancer");
      setBouton("btn-pause",   true,  null);
      setBouton("btn-arreter", false, null, "Mettre en pause d'abord");
      setBouton("btn-reset",   false, null, "Mettre en pause d'abord");
    } else if (e === E.EN_PAUSE) {
      setBouton("btn-lancer",  true,  "Reprendre");
      setBouton("btn-pause",   false, null);
      setBouton("btn-arreter", true,  null);
      setBouton("btn-reset",   true,  null);
    } else if (e === E.RAPPORT) {
      // Pendant la modale Rapport, tout grisé
      setBouton("btn-lancer",  false, "Lancer");
      setBouton("btn-pause",   false, null);
      setBouton("btn-arreter", false, null);
      setBouton("btn-reset",   false, null);
    }
  }

  function majBoutonsMult() {
    const m = window.stateMachine.multiplicateur;
    document.querySelectorAll("[data-mult]").forEach(btn => {
      const actif = parseInt(btn.dataset.mult, 10) === m;
      btn.classList.toggle("actif", actif);
      btn.setAttribute("aria-pressed", String(actif));
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
