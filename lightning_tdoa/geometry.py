"""Primitives géométriques pour le simulateur TDOA.

Les stations sont positionnées dans un plan local 2D ENU (East-North-Up),
coordonnées en mètres. Valable pour des étalements de stations < 200 km
(au-delà, la courbure terrestre devient non négligeable).
"""

import math
from dataclasses import dataclass

import numpy as np


class ErreurGeometrie(Exception):
    """Levée quand la géométrie des stations est invalide (ex: colinéaires)."""


@dataclass
class Station:
    """Une station de détection VLF en coordonnées 2D ENU (mètres)."""

    id: str
    x: float
    y: float

    @property
    def position(self) -> tuple[float, float]:
        """Position de la station sous forme de tuple (x, y)."""
        return (self.x, self.y)


def distance(p1: tuple[float, float], p2: tuple[float, float]) -> float:
    """Distance euclidienne entre deux points 2D.

    Parameters
    ----------
    p1, p2 : tuple of float
        Points sous la forme (x, y) en mètres.

    Returns
    -------
    float
        Distance en mètres.
    """
    return math.hypot(p1[0] - p2[0], p1[1] - p2[1])


def triangle_par_defaut(cote_km: float) -> list[Station]:
    """Triangle équilatéral de 3 stations centré sur l'origine.

    Géométrie de référence saine pour les tests et benchmarks. Un sommet
    pointe vers le Nord, les deux autres vers le Sud-Ouest et le Sud-Est.

    Parameters
    ----------
    cote_km : float
        Longueur du côté du triangle, en kilomètres.

    Returns
    -------
    list of Station
        Trois stations étiquetées "S1", "S2", "S3", positions en mètres.
    """
    if cote_km <= 0:
        raise ErreurGeometrie(f"cote_km doit être positif, reçu {cote_km}")

    cote_m = cote_km * 1000.0
    rayon = cote_m / math.sqrt(3.0)  # rayon du cercle circonscrit

    angles_rad = [math.pi / 2 + i * 2 * math.pi / 3 for i in range(3)]
    return [
        Station(id=f"S{i + 1}", x=rayon * math.cos(a), y=rayon * math.sin(a))
        for i, a in enumerate(angles_rad)
    ]


def verifier_non_colineaires(stations: list[Station], tol: float = 1e-3) -> None:
    """Lève ErreurGeometrie si les stations sont presque colinéaires.

    Utilise la SVD des coordonnées centrées : le ratio de la plus petite sur
    la plus grande valeur singulière mesure à quel point le nuage est "fin".
    Un ratio inférieur à `tol` signifie une configuration quasi-alignée, qui
    rend la trilatération TDOA mal conditionnée.

    Parameters
    ----------
    stations : list of Station
        Au moins 3 stations.
    tol : float, optional
        Seuil sans dimension sur le ratio sigma_min / sigma_max
        (défaut 1e-3). Une valeur plus basse est plus permissive.

    Raises
    ------
    ErreurGeometrie
        Si moins de 3 stations, toutes confondues, ou configuration trop fine.
    """
    if len(stations) < 3:
        raise ErreurGeometrie(f"il faut au moins 3 stations, reçu {len(stations)}")

    coords = np.array([s.position for s in stations], dtype=float)
    centrees = coords - coords.mean(axis=0)
    sigma = np.linalg.svd(centrees, compute_uv=False)

    if sigma[0] == 0:
        raise ErreurGeometrie("toutes les stations sont au même endroit")

    ratio = sigma[1] / sigma[0]
    if ratio < tol:
        raise ErreurGeometrie(
            f"stations presque colinéaires (ratio {ratio:.2e} < tol {tol:.2e})"
        )
