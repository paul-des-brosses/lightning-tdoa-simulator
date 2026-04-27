"""Générateur d'orages : Poisson temporel + marche 2D + dérive + wrap-around disque.

Modèle :
- Intervalles inter-éclairs : exponentielle de moyenne 60/cadence_par_min secondes
  (processus de Poisson temporel de paramètre λ_temps).
- Position de l'éclair N+1 : marche 2D depuis l'éclair N. Distance ~ exponentielle
  de moyenne `distance_moy_m`, direction uniforme sur [0, 2π).
- Dérive globale : à chaque intervalle dt, on ajoute un déplacement
  `derive_vitesse · dt` dans la direction `derive_direction_deg`.
- Si la nouvelle position sort du disque de rayon R_max autour du centre,
  wrap-around topologique : (r, θ) avec R_max < r ≤ 2·R_max devient
  (2·R_max - r, θ+π). Pour r > 2·R_max, modulo sur 2·R_max.

Hypothèses :
- Le centre du disque ne bouge pas (typiquement = barycentre des stations).
- La dérive est constante pendant la session (modélise un noyau orageux
  qui se déplace avec un vent dominant).
- La position du PREMIER éclair est imposée de l'extérieur (clic utilisateur),
  pas tirée par le générateur.
"""

import math
from dataclasses import dataclass
from typing import Optional

import numpy as np


@dataclass
class ParametresOrage:
    """Paramètres d'un orage simulé en temps réel.

    Attributes
    ----------
    rayon_max_m : float
        Rayon de la zone d'orage autour du centre (typiquement le barycentre
        des stations). Toute position sortant subit un wrap-around topologique.
    cadence_par_min : float
        Cadence moyenne d'éclairs (éclairs/minute). Détermine λ_temps.
    distance_moy_m : float
        Distance moyenne entre 2 éclairs successifs (mètres). Détermine λ_dist.
    derive_direction_deg : float
        Direction de la dérive du noyau orageux, en degrés trigonométriques
        (0 = Est, 90 = Nord). Modulo 360 implicite.
    derive_vitesse_m_par_s : float
        Vitesse de translation du noyau orageux (m/s). 0 = orage stationnaire.
    """

    rayon_max_m: float
    cadence_par_min: float
    distance_moy_m: float
    derive_direction_deg: float
    derive_vitesse_m_par_s: float

    def __post_init__(self) -> None:
        if self.rayon_max_m <= 0:
            raise ValueError(f"rayon_max_m doit être > 0, reçu {self.rayon_max_m}")
        if self.cadence_par_min <= 0:
            raise ValueError(f"cadence_par_min doit être > 0, reçu {self.cadence_par_min}")
        if self.distance_moy_m <= 0:
            raise ValueError(f"distance_moy_m doit être > 0, reçu {self.distance_moy_m}")
        if self.derive_vitesse_m_par_s < 0:
            raise ValueError(
                f"derive_vitesse_m_par_s doit être >= 0, reçu {self.derive_vitesse_m_par_s}"
            )


def _wrap_disque(
    x: float, y: float, centre_x: float, centre_y: float, rayon_max_m: float
) -> tuple[float, float]:
    """Wrap-around topologique sur disque centré (centre_x, centre_y).

    Pour un point (x, y) :
    - Si à distance r ≤ R_max du centre : retourné inchangé.
    - Sinon : modulo sur 2·R_max puis rabat (2·R_max - r, θ+π) si r_mod > R_max.

    Choix esthétique (pas physique) : permet à un orage de "rebondir" dans
    le disque visuellement plutôt que de sortir indéfiniment.
    """
    x_rel = x - centre_x
    y_rel = y - centre_y
    r = math.hypot(x_rel, y_rel)
    if r <= rayon_max_m:
        return x, y

    theta = math.atan2(y_rel, x_rel)
    diametre = 2.0 * rayon_max_m
    r_mod = r % diametre
    if r_mod > rayon_max_m:
        new_r = diametre - r_mod
        new_theta = theta + math.pi
    else:
        new_r = r_mod
        new_theta = theta
    return (
        centre_x + new_r * math.cos(new_theta),
        centre_y + new_r * math.sin(new_theta),
    )


class GenerateurOrage:
    """Stream d'éclairs reproductible.

    Usage
    -----
        rng = np.random.default_rng(seed=42)
        gen = GenerateurOrage((0, 0), parametres, rng)
        gen.fixer_premier_eclair((1000, -2000))
        for _ in range(N):
            delta_t_s, (x_m, y_m) = gen.prochain_eclair()
    """

    def __init__(
        self,
        centre_xy: tuple[float, float],
        parametres: ParametresOrage,
        rng: np.random.Generator,
    ):
        self.centre_x = float(centre_xy[0])
        self.centre_y = float(centre_xy[1])
        self.parametres = parametres
        self.rng = rng
        self._derniere_position: Optional[tuple[float, float]] = None

    def fixer_premier_eclair(self, position: tuple[float, float]) -> None:
        """Fixe la position du premier éclair (clic utilisateur après "Lancer").

        Cette position n'est PAS tirée par le générateur ; elle sert d'ancre
        pour la marche 2D des éclairs suivants.
        """
        self._derniere_position = (float(position[0]), float(position[1]))

    def prochain_eclair(self) -> tuple[float, tuple[float, float]]:
        """Tire le prochain éclair après le précédent.

        Returns
        -------
        delta_t_s : float
            Intervalle de temps depuis le précédent éclair, en secondes.
        position : tuple of float
            Nouvelle position (x_m, y_m), garantie dans le disque (après
            wrap-around éventuel).

        Raises
        ------
        RuntimeError
            Si `fixer_premier_eclair()` n'a pas été appelée auparavant.
        """
        if self._derniere_position is None:
            raise RuntimeError(
                "fixer_premier_eclair() doit être appelée avant prochain_eclair()."
            )

        # Intervalle temporel : exponentielle de moyenne 60/cadence
        delta_t_s = float(self.rng.exponential(60.0 / self.parametres.cadence_par_min))

        # Marche 2D : distance ~ exponentielle, direction uniforme
        delta_d_m = float(self.rng.exponential(self.parametres.distance_moy_m))
        theta_marche = float(self.rng.uniform(0.0, 2.0 * math.pi))

        # Dérive globale du noyau pendant cet intervalle
        derive_dir_rad = math.radians(self.parametres.derive_direction_deg)
        v = self.parametres.derive_vitesse_m_par_s
        dx_derive = v * delta_t_s * math.cos(derive_dir_rad)
        dy_derive = v * delta_t_s * math.sin(derive_dir_rad)

        x_brut = self._derniere_position[0] + delta_d_m * math.cos(theta_marche) + dx_derive
        y_brut = self._derniere_position[1] + delta_d_m * math.sin(theta_marche) + dy_derive

        x_final, y_final = _wrap_disque(
            x_brut, y_brut, self.centre_x, self.centre_y, self.parametres.rayon_max_m
        )
        self._derniere_position = (x_final, y_final)
        return delta_t_s, (x_final, y_final)
