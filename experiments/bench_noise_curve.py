"""Benchmark : erreur médiane vs niveau de bruit, en log-log.

Usage : python experiments/bench_noise_curve.py

Sortie :
    assets/noise_curve.png
    assets/chiffres_cles.json (mis à jour avec la pente observée)

Vérifie la prédiction théorique : erreur ∝ σ_τ (pente 1 en log-log).
"""

import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from tqdm import tqdm

from lightning_tdoa.geometry import triangle_par_defaut
from lightning_tdoa.metrics import erreur_localisation
from lightning_tdoa.simulator import NoiseConfig, simulate_strike
from lightning_tdoa.solver import resoudre_nlls
from lightning_tdoa.viz import plot_noise_curve


# ----- Paramètres -----
COTE_KM = 50                     # taille du triangle
IMPACT = (10_000.0, 0.0)         # impact fixe (intérieur du triangle)
SIGMAS_NS = np.array([           # niveaux de bruit testés (ns)
    1, 3, 10, 30, 100, 300, 1000, 3000,
])
N_TRIALS = 1000                  # tirages Monte Carlo par point
SEED = 42

ASSETS = Path(__file__).resolve().parent.parent / "assets"
CHIFFRES = ASSETS / "chiffres_cles.json"


def main() -> None:
    ASSETS.mkdir(exist_ok=True)
    rng = np.random.default_rng(SEED)
    stations = triangle_par_defaut(cote_km=COTE_KM)

    erreurs_medianes = np.empty(len(SIGMAS_NS))
    erreurs_p95 = np.empty(len(SIGMAS_NS))

    n_total = len(SIGMAS_NS) * N_TRIALS
    with tqdm(total=n_total, desc="noise_curve") as pbar:
        for i, sigma_ns in enumerate(SIGMAS_NS):
            cfg = NoiseConfig(
                sigma_vlf_ns=float(sigma_ns),
                sigma_gps_ns=float(sigma_ns),
                sigma_horloge_ns=float(sigma_ns),
            )
            erreurs = []
            for _ in range(N_TRIALS):
                # Garde-fou désactivé : on étudie le comportement même en bruit fort.
                toas = simulate_strike(IMPACT, stations, cfg, rng, erreur_max_km=None)
                try:
                    res = resoudre_nlls(toas, stations)
                    erreurs.append(erreur_localisation(res.position, IMPACT))
                except Exception:
                    pass
                pbar.update()
            arr = np.array(erreurs)
            erreurs_medianes[i] = np.median(arr)
            erreurs_p95[i] = np.percentile(arr, 95)

    # Régression log-log pour extraire la pente
    pente, ordonnee = np.polyfit(np.log10(SIGMAS_NS), np.log10(erreurs_medianes), 1)

    fig = plot_noise_curve(
        SIGMAS_NS,
        {"NLLS — médiane": erreurs_medianes, "NLLS — p95": erreurs_p95},
        titre=f"Erreur vs σ_τ — impact {IMPACT}, triangle {COTE_KM} km, "
              f"{N_TRIALS} trials/point (pente médiane = {pente:.2f})",
    )
    chemin_png = ASSETS / "noise_curve.png"
    fig.savefig(chemin_png, dpi=120, bbox_inches="tight")
    plt.close(fig)

    # Mise à jour des chiffres clés
    chiffres = json.loads(CHIFFRES.read_text(encoding="utf-8")) if CHIFFRES.exists() else {}
    chiffres["noise_curve_pente_log_log"] = float(pente)
    chiffres["noise_curve_erreur_a_100ns"] = float(
        erreurs_medianes[np.argmin(np.abs(SIGMAS_NS - 100))]
    )
    CHIFFRES.write_text(
        json.dumps(chiffres, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    print(f"Chiffre cle : pente log-log = {pente:.3f} (theorie : 1.0)")
    print(f"Chiffre cle : erreur mediane @ sigma=100ns = {chiffres['noise_curve_erreur_a_100ns']:.1f} m")
    print(f"Sortie : {chemin_png}")


if __name__ == "__main__":
    main()
