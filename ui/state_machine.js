"use strict";

/* ==========================================================================
   state_machine.js — Machine à états globale (P6)

   5 états :
     CONFIGURATION  → état initial. Drag des stations, choix géométrie/mode/bruit.
     EN_ATTENTE     → après "Lancer", attente du premier clic utilisateur.
     SIMULATION     → chronomètre tourne, génération d'éclairs active.
     EN_PAUSE       → chrono figé, accès au calcul carte d'erreur, choix Reprendre/Arrêter.
     RAPPORT        → modale "Générer un rapport ?", puis retour CONFIGURATION.

   Transitions valides :
     CONFIGURATION  → EN_ATTENTE  (lancer)
     EN_ATTENTE     → SIMULATION  (1er clic dans la zone)
     EN_ATTENTE     → EN_PAUSE    (pause)
     SIMULATION     → EN_PAUSE    (pause)
     EN_PAUSE       → SIMULATION  (lancer = "Reprendre")
     EN_PAUSE       → RAPPORT     (arrêter)
     RAPPORT        → CONFIGURATION
     CONFIGURATION  → CONFIGURATION  (reset, après confirmation si éclairs)
     EN_PAUSE       → CONFIGURATION  (reset, idem)

   Notifie via CustomEvent("etat-change") sur document.
   Multiplicateur de vitesse stocké à part, notifie via CustomEvent("multiplicateur-change").
   ========================================================================== */

(function() {
  const ETATS = {
    CONFIGURATION: "configuration",
    EN_ATTENTE:    "en_attente",
    SIMULATION:    "simulation",
    EN_PAUSE:      "en_pause",
    RAPPORT:       "rapport",
  };

  const sm = {
    etat: ETATS.CONFIGURATION,
    multiplicateur: 1,
    t_simulation_debut: null,   // performance.now() au "Lancer"
    t_pause_debut: null,        // performance.now() à l'entrée en EN_PAUSE
    t_pause_total_ms: 0,        // somme des durées passées en pause

    _changer(nouveau) {
      const ancien = this.etat;
      if (ancien === nouveau) return;
      this.etat = nouveau;
      document.dispatchEvent(new CustomEvent("etat-change", {
        detail: { ancien, nouveau, multiplicateur: this.multiplicateur }
      }));
    },

    /* --- Transitions --- */

    lancer() {
      if (this.etat === ETATS.CONFIGURATION) {
        this.t_simulation_debut = performance.now();
        this.t_pause_total_ms = 0;
        this.t_pause_debut = null;
        this._changer(ETATS.EN_ATTENTE);
      } else if (this.etat === ETATS.EN_PAUSE) {
        // Reprise : accumuler le temps passé en pause
        if (this.t_pause_debut !== null) {
          this.t_pause_total_ms += performance.now() - this.t_pause_debut;
          this.t_pause_debut = null;
        }
        this._changer(ETATS.SIMULATION);
      }
    },

    declencherPremierEclair() {
      // Appelée par svg_scene quand on clique en EN_ATTENTE (le clic
      // génère le 1er éclair ET fait basculer en SIMULATION).
      if (this.etat === ETATS.EN_ATTENTE) {
        this._changer(ETATS.SIMULATION);
      }
    },

    pause() {
      if (this.etat === ETATS.EN_ATTENTE || this.etat === ETATS.SIMULATION) {
        this.t_pause_debut = performance.now();
        this._changer(ETATS.EN_PAUSE);
      }
    },

    async arreter() {
      if (this.etat !== ETATS.EN_PAUSE) return;
      this._changer(ETATS.RAPPORT);
      const heatmapDeja = !!window.heatmapErreur?.etat?.grille;
      const choix = await window.modale.choixRapport({ heatmapDeja });
      if (choix.generer) {
        await window.rapportPdf.genererEtOuvrir({
          calculerHeatmap: choix.calculerHeatmap,
        });
      }
      this._reset();
    },

    async reset() {
      if (this.etat !== ETATS.CONFIGURATION && this.etat !== ETATS.EN_PAUSE) return;
      const aDesEclairs = (window.animation?.eclairs?.length ?? 0) > 0;
      if (aDesEclairs) {
        const confirme = await window.modale.choixOuiNon(
          "Réinitialiser ?<br>Tous les éclairs et statistiques seront perdus."
        );
        if (!confirme) return;
      }
      this._reset();
    },

    _reset() {
      // Vide les éclairs en cours
      if (window.animation?.eclairs) {
        window.animation.eclairs.length = 0;
        window.animation.dessinerEclairs?.();
      }
      // Reset du zoom/centre visuel à l'auto-fit
      window.scene?.resetZoom?.();
      // Reset du seuil détection à sa valeur par défaut
      window.statsPanel?.resetSeuil?.();
      this.t_simulation_debut = null;
      this.t_pause_debut = null;
      this.t_pause_total_ms = 0;
      this.multiplicateur = 1;
      document.dispatchEvent(new CustomEvent("multiplicateur-change", {
        detail: { multiplicateur: 1 }
      }));
      this._changer(ETATS.CONFIGURATION);
    },

    setMultiplicateur(m) {
      this.multiplicateur = m;
      document.dispatchEvent(new CustomEvent("multiplicateur-change", {
        detail: { multiplicateur: m }
      }));
    },

    /* --- Abonnements --- */

    surChangement(callback) {
      document.addEventListener("etat-change", callback);
    },
    surMultiplicateur(callback) {
      document.addEventListener("multiplicateur-change", callback);
    },
  };

  window.stateMachine = sm;
  window.ETATS = ETATS;
})();
