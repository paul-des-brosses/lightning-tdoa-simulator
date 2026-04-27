"""Simulation des temps d'arrivée (TOA) pour un impact de foudre.

Modèle de niveau 1 : pour chaque station, on calcule le temps de vol
géométrique entre l'impact et la station (`t = d / c`), auquel on ajoute
trois composantes de bruit indépendantes (jitter VLF, bruit GPS, biais
d'horloge). Pas de synthèse de forme d'onde.

Hypothèses physiques :
- Propagation rectiligne à vitesse `c` constante.
- Bruits gaussiens indépendants entre composantes et entre stations.
- L'impact a lieu à t = 0 (les TOAs sont des temps de vol absolus).
"""

import math
from dataclasses import dataclass

import numpy as np

from .geometry import Station, distance


C_LIGHT = 299_792_458.0  # vitesse de la lumière dans le vide, en m/s

NS_TO_S = 1e-9


class ErreurSimulation(Exception):
    """Levée quand le simulateur refuse une configuration (impact hors zone valide)."""


@dataclass
class NoiseConfig:
    """Paramètres des trois composantes de bruit ajoutées aux TOAs.

    Toutes les sigmas sont en nanosecondes (ordre de grandeur typique en VLF).

    Attributes
    ----------
    sigma_vlf_ns : float
        Écart-type du jitter de détection VLF, par station (gaussien).
    sigma_gps_ns : float
        Écart-type du bruit de timestamp GPS, par station (gaussien).
    sigma_horloge_ns : float
        Écart-type du biais d'horloge par station (gaussien, constant
        par station pour un impact donné).
    """

    sigma_vlf_ns: float
    sigma_gps_ns: float
    sigma_horloge_ns: float

    def __post_init__(self) -> None:
        for nom in ("sigma_vlf_ns", "sigma_gps_ns", "sigma_horloge_ns"):
            valeur = getattr(self, nom)
            if valeur < 0:
                raise ValueError(f"{nom} doit être >= 0, reçu {valeur}")

    @property
    def sigma_totale_s(self) -> float:
        """Écart-type combiné des trois bruits, en secondes.

        Les trois composantes étant indépendantes et gaussiennes, leur somme
        est gaussienne de variance égale à la somme des variances.
        """
        var_ns2 = (
            self.sigma_vlf_ns**2
            + self.sigma_gps_ns**2
            + self.sigma_horloge_ns**2
        )
        return math.sqrt(var_ns2) * NS_TO_S


def simulate_strike(
    impact: tuple[float, float],
    stations: list[Station],
    noise_cfg: NoiseConfig,
    rng: np.random.Generator,
    erreur_max_km: float | None = 1.0,
) -> dict[str, float]:
    """Simule les temps d'arrivée d'un impact de foudre aux stations.

    Pour chaque station, calcule le temps de vol géométrique
    `t = ‖impact - station‖ / c`, puis ajoute trois bruits gaussiens
    indépendants tirés via le générateur `rng`.

    Garde-fou paramétrable : refuse les impacts dont l'erreur de position
    attendue dépasse le budget `erreur_max_km`. L'erreur attendue est
    estimée par `σ_τ_total × c × GDOP(impact)`, où σ_τ_total est extrait
    de `noise_cfg`. Pour désactiver le garde-fou, passer `None`.

    Parameters
    ----------
    impact : tuple of float
        Position de l'impact (x, y) en mètres (plan ENU local).
    stations : list of Station
        Stations de détection.
    noise_cfg : NoiseConfig
        Paramètres des bruits à appliquer.
    rng : numpy.random.Generator
        Générateur aléatoire (passé explicitement pour reproductibilité).
    erreur_max_km : float or None, optional
        Budget d'erreur de position acceptable, en kilomètres. Défaut 1 km.
        Si l'erreur estimée pour cet impact dépasse ce budget, lève
        `ErreurSimulation`. Mettre `None` pour désactiver le garde-fou
        et étudier le comportement en champ lointain (avec risque de
        recevoir des données absurdes sans signal).

    Returns
    -------
    dict of str to float
        TOAs en secondes, indexés par identifiant de station.

    Raises
    ------
    ErreurSimulation
        Si l'erreur attendue dépasse `erreur_max_km`.
    """
    if not stations:
        raise ValueError("la liste de stations est vide")

    if erreur_max_km is not None:
        # Import local pour casser le cycle simulator <-> metrics.
        from .metrics import gdop

        sigma_tau_s = noise_cfg.sigma_totale_s
        if sigma_tau_s > 0:
            g = gdop(stations, impact)
            erreur_attendue_m = g * sigma_tau_s * C_LIGHT
            budget_m = erreur_max_km * 1000.0
            if erreur_attendue_m > budget_m:
                raise ErreurSimulation(
                    f"erreur attendue {erreur_attendue_m:.0f} m > budget "
                    f"{budget_m:.0f} m (GDOP={g:.1f}, σ_τ={sigma_tau_s*1e9:.0f} ns). "
                    f"Augmenter erreur_max_km, ou erreur_max_km=None pour désactiver."
                )

    n = len(stations)

    # 3 tirages gaussiens indépendants, en nanosecondes
    bruit_vlf_ns = rng.normal(0.0, noise_cfg.sigma_vlf_ns, size=n)
    bruit_gps_ns = rng.normal(0.0, noise_cfg.sigma_gps_ns, size=n)
    bruit_horloge_ns = rng.normal(0.0, noise_cfg.sigma_horloge_ns, size=n)

    bruit_total_s = (bruit_vlf_ns + bruit_gps_ns + bruit_horloge_ns) * NS_TO_S

    toas: dict[str, float] = {}
    for i, station in enumerate(stations):
        temps_vol_s = distance(impact, station.position) / C_LIGHT
        toas[station.id] = temps_vol_s + bruit_total_s[i]

    return toas
