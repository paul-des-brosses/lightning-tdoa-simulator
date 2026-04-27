"""Benchmark : NLLS vs solveur analytique sur la même courbe de bruit.

Usage : python experiments/bench_solver_comparison.py

Sortie :
    assets/solver_comparison.png
    assets/chiffres_cles.json (mis à jour)

Justifie quantitativement le choix du NLLS comme solveur principal.
Pour 3 stations, les deux solveurs résolvent le même système algébrique,
on s'attend donc à des résultats identiques (à la précision FP près).
La différence visible entre les deux mesure l'amplification de bruit
des étapes de calcul, pas la qualité du modèle.
"""

import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from tqdm import tqdm

from lightning_tdoa.geometry import triangle_par_defaut
from lightning_tdoa.metrics import erreur_localisation
from lightning_tdoa.simulator import NoiseConfig, simulate_strike
from lightning_tdoa.solver import resoudre_analytique, resoudre_nlls
from lightning_tdoa.viz import plot_noise_curve


# ----- Paramètres -----
COTE_KM = 50
IMPACT = (10_000.0, 0.0)
SIGMAS_NS = np.array([1, 3, 10, 30, 100, 300, 1000, 3000])
N_TRIALS = 1000
SEED = 42

ASSETS = Path(__file__).resolve().parent.parent / "assets"
CHIFFRES = ASSETS / "chiffres_cles.json"


def main() -> None:
    ASSETS.mkdir(exist_ok=True)
    rng = np.random.default_rng(SEED)
    stations = triangle_par_defaut(cote_km=COTE_KM)

    erreurs = {
        "NLLS": np.empty(len(SIGMAS_NS)),
        "Analytique": np.empty(len(SIGMAS_NS)),
    }

    n_total = len(SIGMAS_NS) * N_TRIALS * 2
    with tqdm(total=n_total, desc="solver_comparison") as pbar:
        for i, sigma_ns in enumerate(SIGMAS_NS):
            cfg = NoiseConfig(
                sigma_vlf_ns=float(sigma_ns),
                sigma_gps_ns=float(sigma_ns),
                sigma_horloge_ns=float(sigma_ns),
            )
            for nom, fn in [("NLLS", resoudre_nlls), ("Analytique", resoudre_analytique)]:
                erreurs_solveur = []
                for _ in range(N_TRIALS):
                    toas = simulate_strike(IMPACT, stations, cfg, rng, erreur_max_km=None)
                    try:
                        res = fn(toas, stations)
                        erreurs_solveur.append(erreur_localisation(res.position, IMPACT))
                    except Exception:
                        pass
                    pbar.update()
                erreurs[nom][i] = np.median(np.array(erreurs_solveur))

    fig = plot_noise_curve(
        SIGMAS_NS, erreurs,
        titre=f"NLLS vs analytique — impact {IMPACT}, triangle {COTE_KM} km, "
              f"{N_TRIALS} trials/point",
    )
    chemin_png = ASSETS / "solver_comparison.png"
    fig.savefig(chemin_png, dpi=120, bbox_inches="tight")
    plt.close(fig)

    # Ratio des erreurs (devrait être ~1)
    ratio_max = float(np.max(np.abs(erreurs["NLLS"] / erreurs["Analytique"] - 1.0)))

    chiffres = json.loads(CHIFFRES.read_text(encoding="utf-8")) if CHIFFRES.exists() else {}
    chiffres["solver_comparison_ratio_ecart_max"] = ratio_max
    CHIFFRES.write_text(
        json.dumps(chiffres, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    print(f"Chiffre cle : ecart relatif max NLLS/Analytique = {ratio_max*100:.2f} %")
    print(f"Sortie : {chemin_png}")


if __name__ == "__main__":
    main()
