"""Métriques de qualité d'estimation et de géométrie.

Trois familles de fonctions :

- Erreur scalaire d'estimation (`erreur_localisation`).
- Métriques géométriques de qualité (`gdop`, `qualite_geometrique`,
  `distance_max_validite`) qui caractérisent un réseau de stations
  indépendamment de toute observation.
- Agrégateur Monte Carlo (`monte_carlo`) pour évaluer un solveur sous
  tirages bruités répétés.
"""

import math
from typing import Callable

import numpy as np

from .geometry import Station


C_LIGHT = 299_792_458.0  # m/s, redéfini ici pour le découplage avec simulator

# Seuils GDOP standards utilisés pour qualifier une géométrie.
# Convention : ordre croissant, label "excellent" = le plus exigeant.
SEUILS_GDOP: dict[str, float] = {
    "excellent": 2.0,
    "bon": 5.0,
    "degrade": 10.0,
    "limite": 20.0,
}


def erreur_localisation(
    estimee: tuple[float, float], vraie: tuple[float, float]
) -> float:
    """Distance euclidienne entre une position estimée et la vraie position.

    Parameters
    ----------
    estimee : tuple of float
        Position retournée par un solveur, en mètres.
    vraie : tuple of float
        Position de référence (vrai impact), en mètres.

    Returns
    -------
    float
        Distance en mètres.
    """
    return math.hypot(estimee[0] - vraie[0], estimee[1] - vraie[1])


def gdop(stations: list[Station], position: tuple[float, float]) -> float:
    """Geometric Dilution of Precision en une position donnée.

    Mesure de combien la géométrie des stations amplifie le bruit de
    mesure TDOA en erreur de position. Sans dimension.

    Pour un bruit isotrope σ (en secondes) sur les TDOAs, l'écart-type
    attendu sur la position estimée vaut approximativement
    `σ * c * gdop(stations, position)`.

    Parameters
    ----------
    stations : list of Station
        Au moins 3 stations.
    position : tuple of float
        Point d'évaluation (x, y) en mètres.

    Returns
    -------
    float
        Valeur de la GDOP. Renvoie `inf` si la position coïncide avec une
        station ou si la matrice est singulière (stations colinéaires).
    """
    if len(stations) < 3:
        raise ValueError(f"il faut au moins 3 stations, reçu {len(stations)}")

    P = np.asarray(position, dtype=float)
    s_ref = np.asarray(stations[0].position, dtype=float)
    d_ref = float(np.linalg.norm(P - s_ref))
    if d_ref == 0.0:
        return float("inf")
    u_ref = (P - s_ref) / d_ref

    lignes_j = []
    for s in stations[1:]:
        s_pos = np.asarray(s.position, dtype=float)
        d_i = float(np.linalg.norm(P - s_pos))
        if d_i == 0.0:
            return float("inf")
        u_i = (P - s_pos) / d_i
        lignes_j.append(u_i - u_ref)

    J = np.array(lignes_j)
    try:
        cov = np.linalg.inv(J.T @ J)
    except np.linalg.LinAlgError:
        return float("inf")

    trace = float(np.trace(cov))
    if trace < 0:
        # Pathologique : matrice non-définie positive (numerical noise).
        return float("inf")
    return math.sqrt(trace)


def qualite_geometrique(
    stations: list[Station], position: tuple[float, float]
) -> dict:
    """Évalue la qualité géométrique d'une position d'impact.

    Calcule la GDOP et associe un label qualitatif basé sur les seuils
    standard `SEUILS_GDOP`.

    Parameters
    ----------
    stations : list of Station
    position : tuple of float

    Returns
    -------
    dict
        Avec les clés :
        - `gdop` (float) : valeur calculée.
        - `label` (str) : "excellent", "bon", "degrade", "limite", ou
          "inutilisable" si GDOP > 20.
    """
    g = gdop(stations, position)
    label = "inutilisable"
    for nom, seuil in SEUILS_GDOP.items():
        if g <= seuil:
            label = nom
            break
    return {"gdop": g, "label": label}


def distance_max_validite(
    stations: list[Station],
    gdop_max: float = 10.0,
    n_angles: int = 36,
    r_max_initial: float | None = None,
) -> float:
    """Rayon max autour du barycentre tel que GDOP <= seuil dans toutes les directions.

    Pour chaque direction angulaire, dichotomie radiale jusqu'à trouver
    la distance limite. Le rayon retourné est le minimum sur toutes les
    directions, donc il garantit que dans le disque correspondant, la
    GDOP reste sous le seuil.

    Parameters
    ----------
    stations : list of Station
    gdop_max : float, optional
        Seuil GDOP à ne pas dépasser (défaut 10, "dégradé").
    n_angles : int, optional
        Nombre de directions échantillonnées (défaut 36 = tous les 10°).
    r_max_initial : float or None, optional
        Borne supérieure initiale pour la dichotomie. Par défaut, 100 fois
        le diamètre du nuage de stations.

    Returns
    -------
    float
        Rayon en mètres. Vaut `r_max_initial` si même à cette distance la
        GDOP reste sous le seuil dans toutes les directions (réseau très
        permissif ou seuil très lâche).
    """
    coords = np.array([s.position for s in stations], dtype=float)
    barycentre = coords.mean(axis=0)

    if r_max_initial is None:
        diametre = float(np.ptp(coords, axis=0).max())
        r_max_initial = 100.0 * diametre

    distances = []
    for k in range(n_angles):
        theta = 2 * math.pi * k / n_angles
        direction = np.array([math.cos(theta), math.sin(theta)])

        P_far = tuple(barycentre + r_max_initial * direction)
        if gdop(stations, P_far) <= gdop_max:
            distances.append(r_max_initial)
            continue

        # Dichotomie : cherche r tel que gdop(barycentre + r·direction) ≈ gdop_max
        r_lo, r_hi = 0.0, r_max_initial
        for _ in range(50):  # ~50 itérations -> precision sub-millimétrique
            r_mid = 0.5 * (r_lo + r_hi)
            P_mid = tuple(barycentre + r_mid * direction)
            if gdop(stations, P_mid) <= gdop_max:
                r_lo = r_mid
            else:
                r_hi = r_mid
        distances.append(r_lo)

    return min(distances)


def distance_max_validite_par_erreur(
    stations: list[Station],
    erreur_max_km: float,
    noise_cfg,
    n_angles: int = 36,
) -> float:
    """Rayon utile pour un budget d'erreur acceptable et un niveau de bruit donné.

    Conversion physique : `gdop_max = (erreur_max_m) / (σ_τ_total · c)`.
    Délègue ensuite à `distance_max_validite` avec ce seuil dérivé.

    Parameters
    ----------
    stations : list of Station
    erreur_max_km : float
        Budget d'erreur de position acceptable, en kilomètres.
    noise_cfg : NoiseConfig
        Configuration du bruit. Doit exposer la propriété `sigma_totale_s`.
    n_angles : int, optional
        Nombre de directions échantillonnées (défaut 36).

    Returns
    -------
    float
        Rayon en mètres. Vaut `inf` si σ_τ_total = 0 (pas de bruit donc
        pas de limite physique sur la zone utile).
    """
    sigma_tau_s = noise_cfg.sigma_totale_s
    if sigma_tau_s == 0:
        return float("inf")
    gdop_max = (erreur_max_km * 1000.0) / (sigma_tau_s * C_LIGHT)
    return distance_max_validite(stations, gdop_max=gdop_max, n_angles=n_angles)


def evaluer_cellule_erreur(
    stations: list[Station],
    position: tuple[float, float],
    noise_cfg,
    n_trials: int,
    rng: np.random.Generator,
) -> float:
    """Médiane d'erreur Monte Carlo à une position donnée.

    Pour une grille de heatmap : appelée une fois par cellule (la boucle
    externe sur la grille est typiquement côté JS pour permettre le yield
    au browser entre cellules).

    Returns
    -------
    float
        Médiane des erreurs en mètres, ou `inf` si tous les essais ont
        échoué (e.g. configuration colinéaire).
    """
    from .simulator import simulate_strike
    from .solver import resoudre_nlls

    erreurs = []
    for _ in range(n_trials):
        try:
            toas = simulate_strike(
                position, stations, noise_cfg, rng, erreur_max_km=None,
            )
            res = resoudre_nlls(toas, stations)
            erreurs.append(erreur_localisation(res.position, position))
        except Exception:
            pass
    return float(np.median(erreurs)) if erreurs else float("inf")


def monte_carlo(
    impact: tuple[float, float],
    stations: list[Station],
    noise_cfg,
    n_trials: int,
    solveur_fn: Callable,
    rng: np.random.Generator,
) -> dict:
    """Statistiques d'erreur d'un solveur sur n_trials simulations bruitées.

    Parameters
    ----------
    impact : tuple of float
        Position vraie de l'impact (x, y) en mètres.
    stations : list of Station
    noise_cfg : NoiseConfig
        Configuration du bruit (de `simulator.NoiseConfig`).
    n_trials : int
        Nombre de tirages indépendants.
    solveur_fn : callable
        Fonction de signature `(toas, stations) -> ResultatSolveur`,
        typiquement `resoudre_nlls` ou `resoudre_analytique`.
    rng : numpy.random.Generator

    Returns
    -------
    dict
        Avec les clés `median`, `p95`, `mean`, `std`, toutes en mètres.
        En cas de non-convergence d'un essai, l'erreur est traitée comme
        `nan` et n'est pas comptée dans les statistiques (signalée via la
        clé `n_echecs`).
    """
    # Import local : évite l'import circulaire metrics <-> simulator.
    from .simulator import simulate_strike

    if n_trials <= 0:
        raise ValueError(f"n_trials doit être > 0, reçu {n_trials}")

    erreurs = []
    n_echecs = 0
    for _ in range(n_trials):
        try:
            toas = simulate_strike(impact, stations, noise_cfg, rng)
            res = solveur_fn(toas, stations)
            erreurs.append(erreur_localisation(res.position, impact))
        except Exception:
            n_echecs += 1

    if not erreurs:
        return {
            "median": float("nan"),
            "p95": float("nan"),
            "mean": float("nan"),
            "std": float("nan"),
            "n_echecs": n_echecs,
        }

    arr = np.array(erreurs)
    return {
        "median": float(np.median(arr)),
        "p95": float(np.percentile(arr, 95)),
        "mean": float(np.mean(arr)),
        "std": float(np.std(arr)),
        "n_echecs": n_echecs,
    }
