"""Benchmark : effet de la taille du triangle pour une zone cible donnée.

Usage : python experiments/bench_geometry.py

Sortie :
    assets/geometry_optimization.png
    assets/chiffres_cles.json (mis à jour avec le ratio efficace)

Question opérationnelle : "j'ai besoin de couvrir un disque de rayon Z,
quelle taille de triangle équilatéral choisir ?"

Variable libre = ratio (côté triangle) / (rayon zone).

L'erreur décroît monotonement avec la taille du triangle et s'approche
asymptotiquement du plancher de bruit (= σ_τ · c · GDOP_min). Il n'y
a donc PAS d'optimum classique : on cherche plutôt le **ratio efficace**,
défini comme la plus petite taille atteignant une erreur ≤ 1.2 × asymptote
(au-delà, augmenter le triangle ne gagne plus que <20% de précision).

En complément : un panneau secondaire avec 3 formes de triangle
(équilatéral, aplati, quasi-colinéaire) pour ancrer visuellement
"l'effet de la forme" vs "l'effet de la taille".
"""

import json
import math
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from tqdm import tqdm

from lightning_tdoa.geometry import Station, triangle_par_defaut
from lightning_tdoa.metrics import erreur_localisation
from lightning_tdoa.simulator import NoiseConfig, simulate_strike
from lightning_tdoa.solver import resoudre_nlls


# ----- Paramètres -----
ZONE_RAYON_KM = 50              # zone cible : disque de rayon Z
RATIOS = np.array([0.1, 0.2, 0.3, 0.5, 0.7, 1.0, 1.5, 2.0, 3.0, 5.0, 10.0, 20.0])
N_POINTS_ZONE = 30              # points d'évaluation dans la zone
N_TRIALS = 50                   # tirages Monte Carlo par point
SEED = 42
SEUIL_EFFICACE = 1.2            # erreur ≤ SEUIL_EFFICACE × asymptote

SIGMA_VLF_NS = 100
SIGMA_GPS_NS = 100
SIGMA_HORLOGE_NS = 100

ASSETS = Path(__file__).resolve().parent.parent / "assets"
CHIFFRES = ASSETS / "chiffres_cles.json"


def echantillonner_zone(rayon_m: float, n: int, rng: np.random.Generator) -> np.ndarray:
    """Tirage uniforme de n points dans un disque de rayon `rayon_m`."""
    angles = rng.uniform(0, 2 * np.pi, size=n)
    rayons = rayon_m * np.sqrt(rng.uniform(0, 1, size=n))
    return np.column_stack([rayons * np.cos(angles), rayons * np.sin(angles)])


def erreur_mediane_dans_zone(
    stations: list[Station],
    points: np.ndarray,
    cfg: NoiseConfig,
    n_trials: int,
    rng: np.random.Generator,
) -> tuple[float, float]:
    """Erreur médiane et p95 sur la zone (agrège sur tous les points et tirages)."""
    toutes_erreurs = []
    for impact in points:
        for _ in range(n_trials):
            toas = simulate_strike(
                tuple(impact), stations, cfg, rng, erreur_max_km=None
            )
            try:
                res = resoudre_nlls(toas, stations)
                toutes_erreurs.append(
                    erreur_localisation(res.position, tuple(impact))
                )
            except Exception:
                pass
    arr = np.array(toutes_erreurs)
    return float(np.median(arr)), float(np.percentile(arr, 95))


def main() -> None:
    ASSETS.mkdir(exist_ok=True)
    rng = np.random.default_rng(SEED)
    cfg = NoiseConfig(SIGMA_VLF_NS, SIGMA_GPS_NS, SIGMA_HORLOGE_NS)
    zone_rayon_m = ZONE_RAYON_KM * 1000.0

    # Tirage des points d'évaluation : MÊMES points pour toutes les tailles
    # (comparaison équitable).
    points = echantillonner_zone(zone_rayon_m, N_POINTS_ZONE, rng)

    medianes = np.empty(len(RATIOS))
    p95s = np.empty(len(RATIOS))

    n_total = len(RATIOS) * N_POINTS_ZONE * N_TRIALS
    with tqdm(total=n_total, desc="geometry_opt") as pbar:
        for i, ratio in enumerate(RATIOS):
            cote_km = ratio * ZONE_RAYON_KM
            stations = triangle_par_defaut(cote_km=cote_km)
            erreurs = []
            for impact in points:
                for _ in range(N_TRIALS):
                    toas = simulate_strike(
                        tuple(impact), stations, cfg, rng, erreur_max_km=None
                    )
                    try:
                        res = resoudre_nlls(toas, stations)
                        erreurs.append(
                            erreur_localisation(res.position, tuple(impact))
                        )
                    except Exception:
                        pass
                    pbar.update()
            arr = np.array(erreurs)
            medianes[i] = np.median(arr)
            p95s[i] = np.percentile(arr, 95)

    asymptote = float(np.min(medianes))
    seuil_erreur = SEUIL_EFFICACE * asymptote
    indices_efficaces = np.where(medianes <= seuil_erreur)[0]
    if len(indices_efficaces) > 0:
        i_efficace = int(indices_efficaces[0])
        ratio_efficace = float(RATIOS[i_efficace])
        erreur_efficace = float(medianes[i_efficace])
    else:
        ratio_efficace = float("nan")
        erreur_efficace = float("nan")

    # ---- Figure principale en 2 panneaux ----
    fig, (ax_opt, ax_formes) = plt.subplots(1, 2, figsize=(16, 7))

    # Panneau gauche : courbe d'effet de la taille
    ax_opt.loglog(RATIOS, medianes, marker="o", linewidth=2,
                  label="Erreur médiane", color="steelblue")
    ax_opt.loglog(RATIOS, p95s, marker="s", linewidth=1.5, linestyle="--",
                  label="Erreur p95", color="darkorange", alpha=0.7)
    ax_opt.axhline(asymptote, color="grey", linestyle=":", alpha=0.6,
                   label=f"Asymptote ≈ {asymptote:.0f} m")
    if not np.isnan(ratio_efficace):
        ax_opt.axvline(ratio_efficace, color="red", linestyle=":", alpha=0.7,
                       label=f"Ratio efficace ({ratio_efficace:.1f}, "
                             f"erreur ≤ {SEUIL_EFFICACE:.1f}× asymptote)")
    ax_opt.set_xlabel("Ratio  taille_triangle / rayon_zone")
    ax_opt.set_ylabel("Erreur sur la zone (m)")
    ax_opt.set_title(
        f"Effet de la taille — zone cible disque {ZONE_RAYON_KM} km, "
        f"σ_τ ≈ 175 ns\n"
        f"({N_POINTS_ZONE} points × {N_TRIALS} trials par taille)"
    )
    ax_opt.grid(True, which="both", alpha=0.3)
    ax_opt.legend()

    # Panneau droit : 3 formes de référence (positions des stations seulement)
    formes = {
        "Équilatéral": [(0, 28868), (-25000, -14434), (25000, -14434)],
        "Aplati": [(0, 5000), (-25000, -2500), (25000, -2500)],
        "Quasi-colinéaire": [(-25000, 0), (0, 500), (25000, 0)],
    }
    couleurs_formes = ["steelblue", "darkorange", "crimson"]
    for (nom, sommets), couleur in zip(formes.items(), couleurs_formes):
        xs = [p[0] for p in sommets] + [sommets[0][0]]
        ys = [p[1] for p in sommets] + [sommets[0][1]]
        ax_formes.plot(xs, ys, marker="^", markersize=12, linewidth=1.5,
                       color=couleur, label=nom)
    ax_formes.set_xlabel("East (m)")
    ax_formes.set_ylabel("North (m)")
    ax_formes.set_title("Formes de référence (effet forme vs taille)")
    ax_formes.set_aspect("equal")
    ax_formes.grid(True, alpha=0.3)
    ax_formes.legend()

    fig.tight_layout()
    chemin_png = ASSETS / "geometry_optimization.png"
    fig.savefig(chemin_png, dpi=120, bbox_inches="tight")
    plt.close(fig)

    chiffres = json.loads(CHIFFRES.read_text(encoding="utf-8")) if CHIFFRES.exists() else {}
    chiffres["geometry_ratio_efficace"] = ratio_efficace
    chiffres["geometry_erreur_efficace_m"] = erreur_efficace
    chiffres["geometry_asymptote_m"] = asymptote
    chiffres["geometry_seuil_efficace"] = SEUIL_EFFICACE
    chiffres["geometry_zone_rayon_km"] = ZONE_RAYON_KM
    CHIFFRES.write_text(
        json.dumps(chiffres, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    print(f"Chiffre cle : asymptote (noise floor) = {asymptote:.1f} m")
    print(f"Chiffre cle : ratio efficace (<= {SEUIL_EFFICACE:.1f}x asymptote) = {ratio_efficace:.2f}")
    print(f"Chiffre cle : erreur au ratio efficace = {erreur_efficace:.1f} m")
    print(f"Sortie : {chemin_png}")


if __name__ == "__main__":
    main()
