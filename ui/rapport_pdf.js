"use strict";

/* ==========================================================================
   rapport_pdf.js — Génération du rapport PDF (P12)

   Déclenché depuis state_machine.arreter() après accord utilisateur.

   Pipeline :
   1. (optionnel) Lance heatmapErreur.calculer() si la case modale était cochée.
   2. Capture la zone SVG (sans heatmap) → PNG dataURL.
   3. Capture la zone SVG (avec heatmap) → PNG dataURL, si calculée.
   4. Charge jsPDF depuis le CDN à la demande (~50 Ko, premier appel uniquement).
   5. Construit le PDF (page de garde + tableaux + figures).
   6. Ouvre le PDF dans un nouvel onglet (Ctrl+S manuel pour sauvegarder).

   Mise en page : A4 portrait, marges 18 mm, largeur utile 174 mm.
   Page 1 : résumé exécutif (KPI cards + config + stations + stats).
   Page 2 : zone d'impacts.
   Page 3 (optionnelle) : carte d'erreur Monte Carlo.

   Fallback : si le chargement de jsPDF échoue, message d'erreur via alert().

   Expose `window.rapportPdf` :
   - .genererEtOuvrir({calculerHeatmap}) → Promise<void>
   ========================================================================== */

(function() {
  const JSPDF_URL = "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";

  /* ---------- Palette PDF (tons clairs, lisibles à l'impression) ---------- */
  // Accent foncé pour titres/barres
  const C_ACCENT     = [15, 23, 42];     // slate-900
  const C_ACCENT_2   = [30, 41, 59];     // slate-800
  // Texte
  const C_TEXT       = [17, 24, 39];     // gray-900
  const C_TEXT_MUTED = [100, 116, 139];  // slate-500
  // Surfaces
  const C_CARD_BG    = [241, 245, 249];  // slate-100
  const C_CARD_BORD  = [203, 213, 225];  // slate-300
  const C_TABLE_HEAD = [226, 232, 240];  // slate-200
  const C_TABLE_ROW  = [248, 250, 252];  // slate-50 (zébrures)
  // Mise en évidence
  const C_KPI_NUM    = [14, 165, 233];   // sky-500

  // Couleurs réutilisées pour la capture SVG (cohérence avec le canvas UI)
  const BG_SVG       = "#0a0e1a";
  const FG_SVG       = "#ffffff";

  /* ---------- Géométrie page A4 ---------- */
  const PAGE_W = 210;
  const PAGE_H = 297;
  const MARGE  = 18;
  const COL_W  = PAGE_W - 2 * MARGE;  // 174 mm

  /* ---------- Chargement jsPDF à la demande ---------- */

  let jsPdfPromesse = null;

  function chargerJsPdf() {
    if (jsPdfPromesse) return jsPdfPromesse;
    jsPdfPromesse = new Promise((resolve, reject) => {
      if (window.jspdf?.jsPDF) {
        resolve(window.jspdf.jsPDF);
        return;
      }
      const script = document.createElement("script");
      script.src = JSPDF_URL;
      script.onload = () => {
        if (window.jspdf?.jsPDF) resolve(window.jspdf.jsPDF);
        else reject(new Error("jsPDF chargé mais introuvable dans window.jspdf"));
      };
      script.onerror = () => reject(new Error(`Échec téléchargement jsPDF (${JSPDF_URL})`));
      document.head.appendChild(script);
    });
    return jsPdfPromesse;
  }

  /* ---------- SVG vers PNG ---------- */

  /**
   * Convertit l'élément SVG .scene en dataURL PNG.
   * - Inline les styles texte (les classes CSS ne s'appliquent pas dans
   *   un blob image isolé).
   * - Ajoute un fond opaque (le SVG d'origine est transparent).
   * - Rendu HD : multiplicateur 2× pour le rendu canvas.
   */
  function svgVersPng(svgEl) {
    return new Promise((resolve, reject) => {
      const rect = svgEl.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));

      const clone = svgEl.cloneNode(true);
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("width", w);
      clone.setAttribute("height", h);
      clone.setAttribute("viewBox", `0 0 ${w} ${h}`);

      // Fond opaque
      const ns = "http://www.w3.org/2000/svg";
      const bg = document.createElementNS(ns, "rect");
      bg.setAttribute("x", "0");
      bg.setAttribute("y", "0");
      bg.setAttribute("width", String(w));
      bg.setAttribute("height", String(h));
      bg.setAttribute("fill", BG_SVG);
      clone.insertBefore(bg, clone.firstChild);

      // Inline les styles texte (les classes CSS ne suivent pas)
      const style = document.createElementNS(ns, "style");
      style.textContent = `
        .label-station { font-family: monospace; font-size: 11px; fill: ${FG_SVG}; font-weight: 600; }
        .label-distance { font-family: monospace; font-size: 10px; font-weight: 600;
          fill: ${FG_SVG}; paint-order: stroke; stroke: ${BG_SVG}; stroke-width: 4px; stroke-linejoin: round; }
      `;
      clone.insertBefore(style, clone.firstChild);

      const xml = new XMLSerializer().serializeToString(clone);
      const svg64 = btoa(unescape(encodeURIComponent(xml)));
      const dataUrl = `data:image/svg+xml;base64,${svg64}`;

      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const scale = 2;  // HD
        canvas.width = w * scale;
        canvas.height = h * scale;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve({ dataUrl: canvas.toDataURL("image/png"), w, h });
      };
      img.onerror = () => reject(new Error("Échec rendu SVG en image"));
      img.src = dataUrl;
    });
  }

  /**
   * Force la heatmap visible/masquée le temps de la capture, puis restaure.
   * Force aussi un redraw pour que le SVG reflète l'état avant snapshot.
   */
  async function capturerZone({ avecHeatmap }) {
    const heatmapEtat = window.heatmapErreur?.etat;
    const visibleAvant = heatmapEtat?.visible ?? false;
    if (heatmapEtat) heatmapEtat.visible = !!avecHeatmap;
    window.scene?.dessinerScene?.();
    // Laisse le browser repaint avant la sérialisation
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const svg = document.querySelector(".scene");
    if (!svg) throw new Error("SVG .scene introuvable");
    const png = await svgVersPng(svg);
    if (heatmapEtat) heatmapEtat.visible = visibleAvant;
    window.scene?.dessinerScene?.();
    return png;
  }

  /* ---------- Capture de l'état pour le rapport ---------- */

  function snapshotConfig() {
    const sg = window.sidebar?.etat_geo ?? {};
    const sb = window.sidebar?.etat_bruit ?? {};
    const sigmas = window.sidebar?.sigmasCourants?.() ?? { vlf: "?", gps: "?", horloge: "?" };
    const sigma_total_ns = window.sidebar?.sigmaTotalNs?.() ?? null;
    return {
      preset_geo: sg.preset ?? "?",
      cote_km: sg.cote_km ?? null,
      mode: sg.mode ?? "?",
      parametres_orage: sg.parametres_orage ?? null,
      preset_bruit: sb.preset ?? "?",
      sigmas,
      sigma_total_ns: sigma_total_ns !== null ? Math.round(sigma_total_ns) : null,
    };
  }

  function snapshotStations() {
    return (window.scene?.etat?.stations ?? []).map(s => ({
      id: s.id,
      x_km: s.x_m / 1000,
      y_km: s.y_m / 1000,
    }));
  }

  /* ---------- Helpers de formatage ---------- */

  function formatNombre(n, decimales = 1) {
    if (n === null || n === undefined || Number.isNaN(n)) return "-";
    return n.toFixed(decimales);
  }

  function formatDistance(m) {
    if (m === null || m === undefined || Number.isNaN(m)) return "-";
    if (m >= 10000) return `${(m / 1000).toFixed(2)} km`;
    return `${Math.round(m)} m`;
  }

  function formatTemps(ms) {
    const total_s = Math.floor(ms / 1000);
    const h = Math.floor(total_s / 3600);
    const m = Math.floor((total_s % 3600) / 60);
    const s = total_s % 60;
    const pad = n => n.toString().padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  /* ---------- Primitives de mise en page ---------- */

  function setColor(doc, c, kind = "text") {
    if (kind === "text")   doc.setTextColor(c[0], c[1], c[2]);
    if (kind === "fill")   doc.setFillColor(c[0], c[1], c[2]);
    if (kind === "draw")   doc.setDrawColor(c[0], c[1], c[2]);
  }

  /**
   * Bandeau de page (haut + bas) : barre accent en haut, libellé projet
   * et numéro de page en bas. Dessiné après l'ajout de la page.
   */
  function dessinerCadrePage(doc, numeroPage, totalPages) {
    // Barre accent en haut
    setColor(doc, C_ACCENT, "fill");
    doc.rect(0, 0, PAGE_W, 4, "F");

    // Pied de page
    setColor(doc, C_TEXT_MUTED, "text");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.text("Lightning TDOA Simulator — rapport de session", MARGE, PAGE_H - 8);
    doc.text(`Page ${numeroPage} / ${totalPages}`, PAGE_W - MARGE, PAGE_H - 8, { align: "right" });

    // Filet bas
    setColor(doc, C_CARD_BORD, "draw");
    doc.setLineWidth(0.2);
    doc.line(MARGE, PAGE_H - 12, PAGE_W - MARGE, PAGE_H - 12);

    // Reset
    setColor(doc, C_TEXT, "text");
  }

  /**
   * En-tête de section : barre accent verticale + titre.
   * Renvoie le y juste après (avec un peu d'espace).
   */
  function dessinerSection(doc, titre, y) {
    const h = 6;
    setColor(doc, C_ACCENT, "fill");
    doc.rect(MARGE, y - h + 1, 2.5, h, "F");

    setColor(doc, C_ACCENT, "text");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text(titre, MARGE + 5, y + 0.5);

    // Reset
    setColor(doc, C_TEXT, "text");
    return y + 5;
  }

  /**
   * Bloc clé/valeur sur 2 colonnes alignées.
   * `paires` = [[label, valeur], ...]. Lignes commençant par "  " sont indentées.
   */
  function dessinerKV(doc, paires, y, opts = {}) {
    const { labelW = 70, lineH = 5.2 } = opts;

    doc.setFontSize(10);
    for (const [labelBrut, valeur] of paires) {
      const indent = labelBrut.startsWith("  ");
      const label = indent ? labelBrut.trimStart() : labelBrut;

      // Label
      setColor(doc, indent ? C_TEXT_MUTED : C_TEXT, "text");
      doc.setFont("helvetica", indent ? "normal" : "normal");
      doc.text(String(label), MARGE + (indent ? 5 : 0), y);

      // Valeur (mono pour les nombres)
      setColor(doc, C_TEXT, "text");
      doc.setFont("courier", "bold");
      doc.text(String(valeur), MARGE + labelW, y);

      y += lineH;
    }
    setColor(doc, C_TEXT, "text");
    doc.setFont("helvetica", "normal");
    return y + 2;
  }

  /**
   * Table avec en-tête fond gris, zébrures, bordure fine.
   * `colonnes` = [{label, w, align?}], `lignes` = [[v, v, v]].
   */
  function dessinerTable(doc, colonnes, lignes, y) {
    const lineH = 5.5;
    const totalW = colonnes.reduce((s, c) => s + c.w, 0);

    // En-tête
    setColor(doc, C_TABLE_HEAD, "fill");
    doc.rect(MARGE, y, totalW, lineH, "F");

    setColor(doc, C_TEXT, "text");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    let x = MARGE;
    for (const col of colonnes) {
      doc.text(col.label, x + 2, y + 3.8);
      x += col.w;
    }
    y += lineH;

    // Corps avec zébrures
    doc.setFont("helvetica", "normal");
    for (let i = 0; i < lignes.length; i++) {
      if (i % 2 === 0) {
        setColor(doc, C_TABLE_ROW, "fill");
        doc.rect(MARGE, y, totalW, lineH, "F");
      }
      x = MARGE;
      for (let j = 0; j < lignes[i].length; j++) {
        const col = colonnes[j];
        const align = col.align ?? "left";
        const valeur = String(lignes[i][j]);
        if (align === "right") {
          doc.text(valeur, x + col.w - 2, y + 3.8, { align: "right" });
        } else {
          doc.text(valeur, x + 2, y + 3.8);
        }
        x += col.w;
      }
      y += lineH;
    }

    // Bordure
    setColor(doc, C_CARD_BORD, "draw");
    doc.setLineWidth(0.2);
    doc.rect(MARGE, y - lineH * (lignes.length + 1), totalW, lineH * (lignes.length + 1));

    return y + 3;
  }

  /**
   * Carte KPI : nombre en gros, label en dessous. Bordure douce.
   * Renvoie largeur effective.
   */
  function dessinerKpi(doc, x, y, w, h, valeur, label) {
    // Fond
    setColor(doc, C_CARD_BG, "fill");
    setColor(doc, C_CARD_BORD, "draw");
    doc.setLineWidth(0.3);
    doc.roundedRect(x, y, w, h, 1.5, 1.5, "FD");

    // Valeur (gros, accent)
    setColor(doc, C_KPI_NUM, "text");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text(String(valeur), x + w / 2, y + h / 2 + 1, { align: "center" });

    // Label
    setColor(doc, C_TEXT_MUTED, "text");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.text(String(label), x + w / 2, y + h - 2.5, { align: "center" });

    setColor(doc, C_TEXT, "text");
  }

  function dessinerTitrePage(doc, titre, sousTitre) {
    setColor(doc, C_ACCENT, "text");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(20);
    doc.text(titre, MARGE, 22);

    if (sousTitre) {
      setColor(doc, C_TEXT_MUTED, "text");
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.text(sousTitre, MARGE, 28);
    }

    setColor(doc, C_TEXT, "text");
  }

  /**
   * Insère une image en respectant son aspect ratio dans une boîte (max_w, max_h).
   * Centre horizontalement, ajoute une fine bordure.
   */
  function insererImageContenue(doc, png, x, y, max_w, max_h) {
    const ratio = png.w / png.h;
    let w = max_w;
    let h = w / ratio;
    if (h > max_h) {
      h = max_h;
      w = h * ratio;
    }
    const x_centre = x + (max_w - w) / 2;
    doc.addImage(png.dataUrl, "PNG", x_centre, y, w, h);

    // Cadre fin
    setColor(doc, C_CARD_BORD, "draw");
    doc.setLineWidth(0.3);
    doc.rect(x_centre, y, w, h);
  }

  /* ---------- Construction du PDF ---------- */

  function genererPdf(jsPDF, donnees) {
    const { config, stations, stats, captureZone, captureHeatmap } = donnees;
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

    const totalPages = 2 + (captureHeatmap ? 1 : 0);

    /* ============== PAGE 1 — résumé exécutif ============== */
    dessinerCadrePage(doc, 1, totalPages);

    const date = new Date().toLocaleString("fr-FR", {
      dateStyle: "long", timeStyle: "short",
    });
    dessinerTitrePage(doc, "Rapport de simulation TDOA", `Généré le ${date}`);

    // KPI cards row
    let y = 36;
    const kpiH = 22;
    const gap = 4;
    const kpiW = (COL_W - 2 * gap) / 3;
    const kpiVal_med = stats.nb_detectes > 0 ? formatDistance(stats.mediane) : "—";
    const kpiVal_p95 = stats.nb_detectes > 0 ? formatDistance(stats.p95)     : "—";
    const kpiVal_pct = stats.nb_detectes > 0 ? `${stats.pct_sous_seuil} %`   : "—";
    dessinerKpi(doc, MARGE,                       y, kpiW, kpiH, kpiVal_med, "Erreur médiane");
    dessinerKpi(doc, MARGE + kpiW + gap,          y, kpiW, kpiH, kpiVal_p95, "Erreur p95");
    dessinerKpi(doc, MARGE + 2 * (kpiW + gap),    y, kpiW, kpiH, kpiVal_pct, `Détections < ${stats.seuil_m} m`);

    y += kpiH + 8;

    // Section : Configuration
    y = dessinerSection(doc, "Configuration", y);
    const paires_config = [
      ["Géométrie", `${config.preset_geo}${config.cote_km ? ` — côté ${config.cote_km} km` : ""}`],
      ["Mode de génération", config.mode === "aleatoire" ? "Aléatoire" : "Manuel"],
    ];
    if (config.mode === "aleatoire" && config.parametres_orage) {
      const p = config.parametres_orage;
      paires_config.push(
        ["  Rayon max", `${p.rayon_max_km} km`],
        ["  Cadence", `${p.cadence_par_min} éclairs/min`],
        ["  Distance moy. inter-éclairs", `${p.distance_moy_m} m`],
        ["  Dérive", `${p.derive_direction_deg}° à ${p.derive_vitesse_m_par_s} m/s`],
      );
    }
    // jsPDF Helvetica ne couvre que Latin-1, donc σ et τ sont translittérés
    // pour la sortie PDF (l'UI HTML garde les symboles grecs).
    paires_config.push(
      ["Mode de bruit", config.preset_bruit],
      ["  sigma_vlf", `${config.sigmas.vlf} ns`],
      ["  sigma_gps", `${config.sigmas.gps} ns`],
      ["  sigma_horloge", `${config.sigmas.horloge} ns`],
      ["  sigma_total", `${config.sigma_total_ns} ns`],
    );
    y = dessinerKV(doc, paires_config, y);

    // Section : Stations
    y = dessinerSection(doc, "Stations", y + 2);
    y = dessinerTable(doc,
      [
        { label: "ID",     w: 24 },
        { label: "x (km)", w: 40, align: "right" },
        { label: "y (km)", w: 40, align: "right" },
      ],
      stations.map(s => [s.id, formatNombre(s.x_km, 2), formatNombre(s.y_km, 2)]),
      y,
    );

    // Section : Statistiques détaillées
    y = dessinerSection(doc, "Statistiques de session", y + 4);
    const paires_stats = [
      ["Temps écoulé (hors pauses)", formatTemps(stats.temps_ms)],
      ["Éclairs générés", String(stats.nb_eclairs)],
      ["Éclairs détectés (Pyodide)", String(stats.nb_detectes)],
      ["Taux observé", stats.nb_eclairs > 0 ? `${formatNombre(stats.taux_par_min, 1)} /min` : "-"],
      ["Erreur médiane", formatDistance(stats.mediane)],
      ["Erreur p95", formatDistance(stats.p95)],
      ["Erreur max", formatDistance(stats.max)],
      [`Détections sous ${stats.seuil_m} m`, stats.nb_detectes > 0 ? `${stats.pct_sous_seuil} %` : "-"],
    ];
    y = dessinerKV(doc, paires_stats, y);

    /* ============== PAGE 2 — zone d'impacts ============== */
    doc.addPage();
    dessinerCadrePage(doc, 2, totalPages);
    dessinerTitrePage(doc, "Zone de simulation",
      "Stations (triangles), impacts réels (points blancs), détections estimées (palette météo).");

    const yImg2 = 38;
    const hImg2 = PAGE_H - yImg2 - 22;
    insererImageContenue(doc, captureZone, MARGE, yImg2, COL_W, hImg2);

    /* ============== PAGE 3 (optionnelle) — heatmap ============== */
    if (captureHeatmap) {
      doc.addPage();
      dessinerCadrePage(doc, 3, totalPages);
      dessinerTitrePage(doc, "Carte d'erreur Monte Carlo",
        "Erreur médiane sur 20 tirages bruités par cellule. Palette pivotée autour du seuil de détection.");

      const yImg3 = 38;
      const hImg3 = PAGE_H - yImg3 - 22;
      insererImageContenue(doc, captureHeatmap, MARGE, yImg3, COL_W, hImg3);
    }

    return doc;
  }

  /* ---------- Overlay de progression ---------- */

  function afficherChargement(texte) {
    let overlay = document.getElementById("rapport-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "rapport-overlay";
      overlay.innerHTML = `
        <style>
          #rapport-overlay {
            position: fixed; inset: 0; z-index: 1000;
            background: rgba(10, 14, 26, 0.85);
            display: flex; align-items: center; justify-content: center;
            flex-direction: column; gap: 18px;
            color: #ffffff; font-family: monospace; font-size: 14px;
          }
          #rapport-overlay .spin {
            width: 44px; height: 44px;
            border: 3px solid rgba(255,255,255,0.18);
            border-top-color: #0ea5e9;
            border-radius: 50%;
            animation: rapport-spin 0.8s linear infinite;
          }
          @keyframes rapport-spin { to { transform: rotate(360deg); } }
        </style>
        <div class="spin"></div>
        <div id="rapport-overlay-msg"></div>
      `;
      document.body.appendChild(overlay);
    }
    document.getElementById("rapport-overlay-msg").textContent = texte;
  }

  function masquerChargement() {
    document.getElementById("rapport-overlay")?.remove();
  }

  /**
   * Suit la progression du calcul heatmap et l'affiche sur l'overlay.
   * Renvoie un id d'intervalle à clear quand le calcul est fini.
   */
  function suivreProgresHeatmap() {
    return setInterval(() => {
      const e = window.heatmapErreur?.etat;
      if (!e?.en_cours) return;
      const k = e.progres?.k ?? 0;
      const n = e.progres?.n ?? 0;
      if (n > 0) afficherChargement(`Calcul de la carte d'erreur… ${k}/${n}`);
    }, 200);
  }

  /* ---------- Orchestration ---------- */

  async function genererEtOuvrir({ calculerHeatmap }) {
    let intervalId = null;
    try {
      afficherChargement("Préparation du rapport…");

      // 1. Calcul heatmap si demandé et pas encore fait
      if (calculerHeatmap && window.heatmapErreur && !window.heatmapErreur.etat.grille) {
        afficherChargement("Calcul de la carte d'erreur…");
        intervalId = suivreProgresHeatmap();
        await window.heatmapErreur.calculer();
        clearInterval(intervalId);
        intervalId = null;
      }

      // 2. Captures SVG (avant chargement jsPDF, pour donner un retour visuel rapide)
      afficherChargement("Capture de la zone de simulation…");
      const captureZone = await capturerZone({ avecHeatmap: false });
      const captureHeatmap = window.heatmapErreur?.etat?.grille
        ? await capturerZone({ avecHeatmap: true })
        : null;

      // 3. Snapshots des données
      const config = snapshotConfig();
      const stations = snapshotStations();
      const stats = window.statsPanel?.calculerStats?.() ?? {};
      stats.seuil_m = window.statsPanel?.seuilDetection?.() ?? 500;

      // 4. Charger jsPDF (CDN) à la demande
      afficherChargement("Construction du PDF…");
      const jsPDF = await chargerJsPdf();

      // 5. Construire le PDF
      const doc = genererPdf(jsPDF, { config, stations, stats, captureZone, captureHeatmap });

      // 6. Ouvrir dans un nouvel onglet
      const blobUrl = doc.output("bloburl");
      window.open(blobUrl, "_blank");
    } catch (err) {
      console.error("[rapport_pdf] Échec :", err);
      alert(`Échec de la génération du rapport :\n${err.message}\n\nVoir la console pour détails.`);
    } finally {
      if (intervalId !== null) clearInterval(intervalId);
      masquerChargement();
    }
  }

  window.rapportPdf = { genererEtOuvrir };
})();
