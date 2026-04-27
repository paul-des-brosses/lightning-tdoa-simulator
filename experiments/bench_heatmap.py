"""Benchmark : heatmap d'erreur (FIGURE PHARE du README).

Usage : python experiments/bench_heatmap.py

Sortie :
    assets/heatmap_main.png
    assets/chiffres_cles.json (mis à jour avec l'erreur médiane intérieure)

Paramètres par défaut : grille 40×40, 100 trials/cellule.
Pour une figure plus fine (et plus longue), passer RESOLUTION=60 et
TRIALS_PAR_CELLULE=200 (durée ~ 5×).
"""

import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from tqdm import tqdm

from lightning_tdoa.geometry import triangle_par_defaut
from lightning_tdoa.metrics import erreur_localisation, gdop
from lightning_tdoa.simulator import NoiseConfig, simulate_strike
from lightning_tdoa.solver import resoudre_nlls
from lightning_tdoa.viz import plot_heatmap


# ----- Paramètres -----
COTE_KM = 50
DEMI_LARGEUR_KM = 80              # half-largeur de la heatmap
RESOLUTION = 30                   # cellules par côté (30×30 = 900 cellules)
TRIALS_PAR_CELLULE = 100          # >= 100 (ROADMAP)
SEED = 42

SIGMA_VLF_NS = 100
SIGMA_GPS_NS = 100
SIGMA_HORLOGE_NS = 100

# Contours GDOP à superposer
CONTOURS_GDOP = [5, 10, 20]

ASSETS = Path(__file__).resolve().parent.parent / "assets"
CHIFFRES = ASSETS / "chiffres_cles.json"


def main() -> None:
    ASSETS.mkdir(exist_ok=True)
    rng = np.random.default_rng(SEED)
    stations = triangle_par_defaut(cote_km=COTE_KM)
    cfg = NoiseConfig(SIGMA_VLF_NS, SIGMA_GPS_NS, SIGMA_HORLOGE_NS)

    demi_largeur_m = DEMI_LARGEUR_KM * 1000.0
    xs = np.linspace(-demi_largeur_m, demi_largeur_m, RESOLUTION)
    ys = np.linspace(-demi_largeur_m, demi_largeur_m, RESOLUTION)
    grille_erreur = np.full((RESOLUTION, RESOLUTION), np.nan)
    grille_gdop = np.empty((RESOLUTION, RESOLUTION))

    n_total = RESOLUTION * RESOLUTION * TRIALS_PAR_CELLULE
    with tqdm(total=n_total, desc="heatmap") as pbar:
        for i, y in enumerate(ys):
            for j, x in enumerate(xs):
                grille_gdop[i, j] = gdop(stations, (x, y))
                erreurs = []
                for _ in range(TRIALS_PAR_CELLULE):
                    toas = simulate_strike(
                        (x, y), stations, cfg, rng, erreur_max_km=None
                    )
                    try:
                        res = resoudre_nlls(toas, stations)
                        erreurs.append(
                            erreur_localisation(res.position, (x, y))
                        )
                    except Exception:
                        pass
                    pbar.update()
                if erreurs:
                    grille_erreur[i, j] = float(np.median(erreurs))

    # ---- Figure ----
    extent = (-demi_largeur_m, demi_largeur_m, -demi_largeur_m, demi_largeur_m)
    fig = plot_heatmap(
        grille_erreur, stations, extent=extent,
        log_scale=True, label_colorbar="Erreur médiane (m)",
        titre=f"Erreur médiane de localisation — triangle {COTE_KM} km, "
              f"σ_τ ≈ 175 ns, {TRIALS_PAR_CELLULE} trials/cellule",
    )

    # Superposition des contours GDOP
    ax = fig.axes[0]
    X, Y = np.meshgrid(xs, ys)
    cs = ax.contour(
        X, Y, grille_gdop, levels=CONTOURS_GDOP,
        colors="white", linewidths=1.2, alpha=0.85,
    )
    ax.clabel(cs, fmt={lvl: f"GDOP={lvl}" for lvl in CONTOURS_GDOP},
              fontsize=8, inline=True)

    chemin_png = ASSETS / "heatmap_main.png"
    fig.savefig(chemin_png, dpi=130, bbox_inches="tight")
    plt.close(fig)

    # ---- Chiffres clés ----
    # Médiane sur la zone "intérieure du triangle" (≈ disque inscrit, rayon ~14 km pour 50 km de côté)
    rayon_inscrit_m = COTE_KM * 1000.0 / (2.0 * np.sqrt(3.0))
    X_grid, Y_grid = np.meshgrid(xs, ys)
    masque_interieur = (X_grid**2 + Y_grid**2) <= rayon_inscrit_m**2
    erreurs_interieur = grille_erreur[masque_interieur]
    erreurs_interieur = erreurs_interieur[~np.isnan(erreurs_interieur)]
    median_interieur = float(np.median(erreurs_interieur)) if len(erreurs_interieur) else float("nan")

    # Médiane sur la zone "circumscrite" (rayon = circumradius, soit ≈ 29 km)
    rayon_circ_m = COTE_KM * 1000.0 / np.sqrt(3.0)
    masque_circ = (X_grid**2 + Y_grid**2) <= rayon_circ_m**2
    erreurs_circ = grille_erreur[masque_circ]
    erreurs_circ = erreurs_circ[~np.isnan(erreurs_circ)]
    median_circ = float(np.median(erreurs_circ)) if len(erreurs_circ) else float("nan")

    chiffres = json.loads(CHIFFRES.read_text(encoding="utf-8")) if CHIFFRES.exists() else {}
    chiffres["heatmap_median_disque_inscrit_m"] = median_interieur
    chiffres["heatmap_median_disque_circ_m"] = median_circ
    chiffres["heatmap_resolution"] = RESOLUTION
    chiffres["heatmap_trials_par_cellule"] = TRIALS_PAR_CELLULE
    CHIFFRES.write_text(
        json.dumps(chiffres, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    print(f"Chiffre cle (figure phare) :")
    print(f"  - mediane d'erreur dans le disque inscrit (~{rayon_inscrit_m/1000:.0f} km) = {median_interieur:.1f} m")
    print(f"  - mediane d'erreur dans le disque circonscrit (~{rayon_circ_m/1000:.0f} km) = {median_circ:.1f} m")
    print(f"Sortie : {chemin_png}")


if __name__ == "__main__":
    main()
