"""Démo des 4 fonctions de viz.py — génère 4 fichiers dans assets/.

Exécution :
    python experiments/demo_viz.py

Sorties :
    assets/demo_scenario.png    — un tir avec stations, impact, estimation
    assets/demo_heatmap.png     — heatmap GDOP autour du réseau
    assets/demo_noise_curve.png — erreur médiane vs σ_τ pour les 2 solveurs
    assets/demo_carte.html      — carte Folium interactive
"""

from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

from lightning_tdoa.geometry import triangle_par_defaut
from lightning_tdoa.metrics import gdop, monte_carlo
from lightning_tdoa.simulator import NoiseConfig, simulate_strike
from lightning_tdoa.solver import resoudre_analytique, resoudre_nlls
from lightning_tdoa.viz import (
    export_folium,
    plot_heatmap,
    plot_noise_curve,
    plot_scenario,
)


# ---------------------------------------------------------------------------
# Paramètres de la démo (en tête de fichier, modifiables)
# ---------------------------------------------------------------------------
COTE_KM = 50
SEED = 2026
DOSSIER_ASSETS = Path(__file__).resolve().parent.parent / "assets"

# Paramètres heatmap GDOP
HEATMAP_DEMI_LARGEUR_KM = 80
HEATMAP_RESOLUTION = 80  # cellules par côté

# Paramètres courbe de bruit
SIGMAS_NS = np.array([10, 30, 100, 300, 1000, 3000])
N_TRIALS_PAR_SIGMA = 200


def main() -> None:
    DOSSIER_ASSETS.mkdir(exist_ok=True)
    rng = np.random.default_rng(SEED)
    stations = triangle_par_defaut(cote_km=COTE_KM)
    cfg = NoiseConfig(sigma_vlf_ns=100, sigma_gps_ns=50, sigma_horloge_ns=100)

    # 1. Scenario
    impact_demo = (12_000.0, 8_000.0)
    toas = simulate_strike(impact_demo, stations, cfg, rng)
    estimee = resoudre_nlls(toas, stations).position

    fig = plot_scenario(
        stations, impact_demo, estimee,
        titre=f"Tir simulé — triangle {COTE_KM} km, σ_τ ≈ 150 ns",
    )
    chemin = DOSSIER_ASSETS / "demo_scenario.png"
    fig.savefig(chemin, dpi=120, bbox_inches="tight")
    plt.close(fig)

    # 2. Heatmap GDOP
    demi_largeur_m = HEATMAP_DEMI_LARGEUR_KM * 1000.0
    xs = np.linspace(-demi_largeur_m, demi_largeur_m, HEATMAP_RESOLUTION)
    ys = np.linspace(-demi_largeur_m, demi_largeur_m, HEATMAP_RESOLUTION)
    grille_gdop = np.empty((HEATMAP_RESOLUTION, HEATMAP_RESOLUTION))
    for i, y in enumerate(ys):
        for j, x in enumerate(xs):
            grille_gdop[i, j] = gdop(stations, (x, y))

    extent = (-demi_largeur_m, demi_largeur_m, -demi_largeur_m, demi_largeur_m)
    fig = plot_heatmap(
        grille_gdop, stations, extent=extent,
        log_scale=True, label_colorbar="GDOP",
        titre=f"GDOP autour du triangle {COTE_KM} km",
    )
    chemin = DOSSIER_ASSETS / "demo_heatmap.png"
    fig.savefig(chemin, dpi=120, bbox_inches="tight")
    plt.close(fig)

    # 3. Courbe de bruit
    impact_bench = (10_000.0, 0.0)
    erreurs_par_solveur: dict[str, np.ndarray] = {
        "NLLS": np.empty(len(SIGMAS_NS)),
        "Analytique": np.empty(len(SIGMAS_NS)),
    }
    for i, sigma_ns in enumerate(SIGMAS_NS):
        cfg_courant = NoiseConfig(
            sigma_vlf_ns=float(sigma_ns),
            sigma_gps_ns=float(sigma_ns),
            sigma_horloge_ns=float(sigma_ns),
        )
        # Garde-fou désactivé : on étudie le comportement sous bruit fort.
        for nom, fn in [("NLLS", resoudre_nlls), ("Analytique", resoudre_analytique)]:
            stats = monte_carlo(
                impact_bench, stations, cfg_courant,
                n_trials=N_TRIALS_PAR_SIGMA, solveur_fn=fn, rng=rng,
            )
            erreurs_par_solveur[nom][i] = stats["median"]

    fig = plot_noise_curve(
        SIGMAS_NS, erreurs_par_solveur,
        titre=f"Erreur médiane vs σ_τ — impact {impact_bench}",
    )
    chemin = DOSSIER_ASSETS / "demo_noise_curve.png"
    fig.savefig(chemin, dpi=120, bbox_inches="tight")
    plt.close(fig)

    # 4. Carte Folium
    chemin_html = export_folium(
        stations, impact_demo, estimee,
        chemin_sortie=DOSSIER_ASSETS / "demo_carte.html",
    )

    fichiers = sorted(DOSSIER_ASSETS.glob("demo_*"))
    for f in fichiers:
        taille_ko = f.stat().st_size / 1024
        print(f"  ecrit : {f.relative_to(DOSSIER_ASSETS.parent)}  ({taille_ko:.1f} ko)")


if __name__ == "__main__":
    main()
