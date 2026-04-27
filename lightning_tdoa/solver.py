"""Solveurs TDOA : retrouver la position d'un impact à partir des TOAs.

Deux solveurs sont fournis avec une API uniforme :

- `resoudre_nlls` : moindres carrés non-linéaires (solveur principal, robuste,
  extensible à N stations).
- `resoudre_analytique` : intersection closed-form de deux hyperboles 2D
  (3 stations strict, sert de baseline pédagogique).

Ce module ne doit JAMAIS importer `simulator.py` : le solveur reçoit un
dict `{station_id: t_arrival}` sans connaître l'origine des données.
Cela permet de brancher de vraies mesures hardware ultérieurement.
"""

import math
from dataclasses import dataclass

import numpy as np
from scipy.optimize import least_squares

from .geometry import Station, verifier_non_colineaires


C_LIGHT = 299_792_458.0  # m/s, redéfini ici pour respecter le découplage


class ErreurSolveur(Exception):
    """Levée quand un solveur échoue (non-convergence, données invalides)."""


@dataclass
class ResultatSolveur:
    """Sortie d'un solveur TDOA.

    Attributes
    ----------
    position : tuple of float
        Position estimée (x, y) en mètres dans le plan ENU.
    residus : numpy.ndarray
        Vecteur des résidus exprimés en mètres (différences de portées),
        un par paire (station_i, station_de_reference). Le choix du mètre
        plutôt que la seconde est dicté par le conditionnement numérique :
        des valeurs en secondes (~1e-6) font tomber l'optimiseur sous ses
        tolérances par défaut.
    converge : bool
        True si le solveur a convergé selon ses critères internes.
    """

    position: tuple[float, float]
    residus: np.ndarray
    converge: bool


def _toas_vers_tdoas(
    toas: dict[str, float], stations: list[Station]
) -> tuple[Station, list[Station], np.ndarray]:
    """Convertit un dict de TOAs en TDOAs vis-à-vis de la première station.

    Returns
    -------
    station_ref : Station
    autres : list of Station
    tdoas : numpy.ndarray
        TDOAs (t_i - t_ref) pour chaque station dans `autres`, en secondes.
    """
    manquantes = [s.id for s in stations if s.id not in toas]
    if manquantes:
        raise ErreurSolveur(f"TOAs manquants pour les stations : {manquantes}")

    station_ref = stations[0]
    autres = stations[1:]
    t_ref = toas[station_ref.id]
    tdoas = np.array([toas[s.id] - t_ref for s in autres], dtype=float)
    return station_ref, autres, tdoas


def resoudre_nlls(
    toas: dict[str, float], stations: list[Station]
) -> ResultatSolveur:
    """Résout la position de l'impact par moindres carrés non-linéaires.

    Utilise `scipy.optimize.least_squares` (méthode trust-region reflective)
    pour minimiser la somme des carrés des résidus TDOA. Le point de départ
    est le barycentre des stations.

    Parameters
    ----------
    toas : dict of str to float
        Temps d'arrivée en secondes, indexés par identifiant de station.
    stations : list of Station
        Au moins 3 stations.

    Returns
    -------
    ResultatSolveur

    Raises
    ------
    ErreurSolveur
        Si moins de 3 stations, TOAs manquants, ou non-convergence.
    """
    if len(stations) < 3:
        raise ErreurSolveur(f"il faut au moins 3 stations, reçu {len(stations)}")

    station_ref, autres, tdoas_mesurees = _toas_vers_tdoas(toas, stations)
    x_ref, y_ref = station_ref.position

    # On résout en MÈTRES (multiplie par c) : valeurs en seconde sont trop
    # petites pour les tolérances par défaut de least_squares.
    differences_portees = C_LIGHT * tdoas_mesurees

    def residus(pos: np.ndarray) -> np.ndarray:
        d_ref = np.hypot(pos[0] - x_ref, pos[1] - y_ref)
        out = np.empty(len(autres))
        for i, s in enumerate(autres):
            d_i = np.hypot(pos[0] - s.x, pos[1] - s.y)
            out[i] = (d_i - d_ref) - differences_portees[i]
        return out

    # Point de départ : barycentre des stations
    x0 = np.array([
        np.mean([s.x for s in stations]),
        np.mean([s.y for s in stations]),
    ])

    # least_squares (méthode trf) calibre sa taille de pas sur |x|. Si le
    # barycentre tombe à ~1e-12 (bruit d'arrondi pour un triangle centré),
    # le pas devient minuscule et le solveur abandonne dès l'itération 1.
    # On snap les valeurs négligeables devant l'échelle des stations.
    coords = np.array([s.position for s in stations])
    echelle = np.ptp(coords, axis=0).max()  # diamètre du nuage de stations
    x0 = np.where(np.abs(x0) < echelle * 1e-9, 0.0, x0)

    res = least_squares(residus, x0, method="trf")

    if not res.success:
        raise ErreurSolveur(f"non-convergence NLLS : {res.message}")

    return ResultatSolveur(
        position=(float(res.x[0]), float(res.x[1])),
        residus=res.fun,
        converge=bool(res.success),
    )


def resoudre_analytique(
    toas: dict[str, float], stations: list[Station]
) -> ResultatSolveur:
    """Résout la position de l'impact par intersection closed-form de 2 hyperboles.

    Méthode 2D stricte pour 3 stations. Sert de baseline pédagogique et de
    point de comparaison face au solveur NLLS dans les benchmarks.

    Approche : on paramètre la position candidate `P` comme fonction affine
    de la distance auxiliaire `r0 = ‖P - s_ref‖`, puis on substitue dans
    `‖P - s_ref‖² = r0²` pour obtenir une quadratique en r0. Les deux
    racines positives donnent deux candidats P, on retient celui de plus
    petit résidu (l'autre est typiquement étrangère, introduite par le
    passage au carré).

    Parameters
    ----------
    toas : dict of str to float
        Temps d'arrivée en secondes, indexés par identifiant de station.
    stations : list of Station
        Exactement 3 stations.

    Returns
    -------
    ResultatSolveur

    Raises
    ------
    ErreurSolveur
        Si nombre de stations != 3, TOAs manquants, ou aucune solution réelle
        positive (cas dégénéré ou bruit énorme).
    ErreurGeometrie
        Si les 3 stations sont colinéaires (système linéaire singulier).
    """
    if len(stations) != 3:
        raise ErreurSolveur(
            f"resoudre_analytique exige exactement 3 stations, reçu {len(stations)}"
        )

    verifier_non_colineaires(stations)

    s0, s1, s2 = stations
    for s in stations:
        if s.id not in toas:
            raise ErreurSolveur(f"TOA manquant pour la station {s.id!r}")

    # Différences de portées en mètres (référence = première station)
    d1 = C_LIGHT * (toas[s1.id] - toas[s0.id])
    d2 = C_LIGHT * (toas[s2.id] - toas[s0.id])

    s0_pos = np.array(s0.position)
    s1_pos = np.array(s1.position)
    s2_pos = np.array(s2.position)

    # Système linéaire M @ P = b + d * r0
    M = np.array([s0_pos - s1_pos, s0_pos - s2_pos])
    norm_s0_sq = float(np.dot(s0_pos, s0_pos))
    b = np.array([
        (d1**2 - float(np.dot(s1_pos, s1_pos)) + norm_s0_sq) / 2,
        (d2**2 - float(np.dot(s2_pos, s2_pos)) + norm_s0_sq) / 2,
    ])
    d_vec = np.array([d1, d2])

    # P = alpha + beta * r0
    alpha = np.linalg.solve(M, b)
    beta = np.linalg.solve(M, d_vec)

    # Quadratique : A r0² + B r0 + C = 0
    gamma = alpha - s0_pos
    A = float(np.dot(beta, beta)) - 1.0
    B = 2.0 * float(np.dot(gamma, beta))
    C = float(np.dot(gamma, gamma))

    racines_r0 = _racines_quadratique(A, B, C)
    racines_positives = [r for r in racines_r0 if r >= 0]
    if not racines_positives:
        raise ErreurSolveur(
            "aucune racine r0 réelle positive — données incompatibles avec une "
            "intersection physique d'hyperboles"
        )

    # Désambiguïsation : tri lexicographique (coût, distance au barycentre).
    # Le coût départage les cas bruités. En noiseless, les 2 racines ont un
    # coût numériquement identique (toutes deux à zéro à la précision FP) ;
    # on retombe alors sur la distance au barycentre, heuristique standard
    # qui matche le comportement de NLLS partant du barycentre.
    barycentre = np.array([
        np.mean([s.x for s in stations]),
        np.mean([s.y for s in stations]),
    ])

    candidats = []
    for r0 in racines_positives:
        P = alpha + beta * r0
        d_ref = float(np.hypot(P[0] - s0.x, P[1] - s0.y))
        d_a = float(np.hypot(P[0] - s1.x, P[1] - s1.y))
        d_b = float(np.hypot(P[0] - s2.x, P[1] - s2.y))
        residus_pos = np.array([(d_a - d_ref) - d1, (d_b - d_ref) - d2])
        cout = float(np.sum(residus_pos**2))
        dist_bary = float(np.hypot(P[0] - barycentre[0], P[1] - barycentre[1]))
        candidats.append((cout, dist_bary, P, residus_pos))

    candidats.sort(key=lambda c: (c[0], c[1]))
    _, _, P_best, residus_best = candidats[0]

    return ResultatSolveur(
        position=(float(P_best[0]), float(P_best[1])),
        residus=residus_best,
        converge=True,
    )


def _racines_quadratique(A: float, B: float, C: float) -> list[float]:
    """Racines réelles de A·x² + B·x + C = 0 (gère le cas A ≈ 0)."""
    if abs(A) < 1e-12:
        if abs(B) < 1e-12:
            return []
        return [-C / B]
    discriminant = B**2 - 4 * A * C
    if discriminant < 0:
        return []
    racine = math.sqrt(discriminant)
    return [(-B + racine) / (2 * A), (-B - racine) / (2 * A)]
