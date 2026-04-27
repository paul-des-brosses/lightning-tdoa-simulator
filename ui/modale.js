"use strict";

/* ==========================================================================
   modale.js — Modales bloquantes (P6, P12)

   API :
   - window.modale.choixOuiNon(message) → Promise<boolean>
   - window.modale.choixRapport({heatmapDeja}) → Promise<{generer, calculerHeatmap}>
   ========================================================================== */

(function() {
  function choixOuiNon(message) {
    return new Promise(resolve => {
      const overlay = document.createElement("div");
      overlay.className = "modale-overlay";
      overlay.innerHTML = `
        <div class="modale" role="dialog" aria-modal="true">
          <div class="modale-message">${message}</div>
          <div class="modale-boutons">
            <button class="modale-btn modale-non">Non</button>
            <button class="modale-btn modale-oui">Oui</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const cleanup = (val) => {
        document.body.removeChild(overlay);
        resolve(val);
      };

      overlay.querySelector(".modale-oui").addEventListener("click", () => cleanup(true));
      overlay.querySelector(".modale-non").addEventListener("click", () => cleanup(false));
      // Échap = Non
      const onKey = (e) => {
        if (e.key === "Escape") {
          document.removeEventListener("keydown", onKey);
          cleanup(false);
        }
      };
      document.addEventListener("keydown", onKey);
    });
  }

  function choixRapport({ heatmapDeja }) {
    return new Promise(resolve => {
      const overlay = document.createElement("div");
      overlay.className = "modale-overlay";
      // La case heatmap n'apparaît que si la heatmap n'est pas déjà calculée.
      // Si elle l'est, le rapport l'inclut automatiquement.
      const blocCase = heatmapDeja ? "" : `
        <label class="modale-checkbox">
          <input type="checkbox" id="modale-cb-heatmap">
          Calculer la carte d'erreur (~30 s)
        </label>
      `;
      overlay.innerHTML = `
        <div class="modale" role="dialog" aria-modal="true">
          <div class="modale-message">
            Arrêter la session.<br>Générer un rapport PDF ?
          </div>
          ${blocCase}
          <div class="modale-boutons">
            <button class="modale-btn modale-non">Non</button>
            <button class="modale-btn modale-oui">Oui</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const cleanup = (resultat) => {
        document.body.removeChild(overlay);
        resolve(resultat);
      };

      overlay.querySelector(".modale-oui").addEventListener("click", () => {
        const cb = overlay.querySelector("#modale-cb-heatmap");
        cleanup({ generer: true, calculerHeatmap: cb ? cb.checked : false });
      });
      overlay.querySelector(".modale-non").addEventListener("click", () => {
        cleanup({ generer: false, calculerHeatmap: false });
      });
      const onKey = (e) => {
        if (e.key === "Escape") {
          document.removeEventListener("keydown", onKey);
          cleanup({ generer: false, calculerHeatmap: false });
        }
      };
      document.addEventListener("keydown", onKey);
    });
  }

  window.modale = { choixOuiNon, choixRapport };
})();
