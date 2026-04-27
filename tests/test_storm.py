"""Tests du générateur d'orages (lightning_tdoa.storm).

Couverture demandée explicitement par le user en validation Phase 8 :
- Wrap-around topologique sur DISQUE (pas carré).
- Reproductibilité avec seed fixe.
- Validation des paramètres.
- Cadence moyenne convergente vers la valeur paramétrée (sanity statistique).
"""

import math

import numpy as np
import pytest

from lightning_tdoa.storm import (
    GenerateurOrage,
    ParametresOrage,
    _wrap_disque,
)


def _params_par_defaut() -> ParametresOrage:
    return ParametresOrage(
        rayon_max_m=50_000.0,
        cadence_par_min=10.0,
        distance_moy_m=2_000.0,
        derive_direction_deg=0.0,
        derive_vitesse_m_par_s=0.0,
    )


# --- Validation paramètres ---

def test_validation_rayon_negatif():
    with pytest.raises(ValueError):
        ParametresOrage(0.0, 10.0, 1000.0, 0.0, 0.0)
    with pytest.raises(ValueError):
        ParametresOrage(-10.0, 10.0, 1000.0, 0.0, 0.0)


def test_validation_cadence_negative():
    with pytest.raises(ValueError):
        ParametresOrage(1000.0, 0.0, 1000.0, 0.0, 0.0)


def test_validation_distance_negative():
    with pytest.raises(ValueError):
        ParametresOrage(1000.0, 10.0, 0.0, 0.0, 0.0)


def test_validation_derive_negative():
    with pytest.raises(ValueError):
        ParametresOrage(1000.0, 10.0, 1000.0, 0.0, -1.0)


# --- Wrap-around disque ---

def test_wrap_disque_dans_disque_inchange():
    """Point dans le disque : coordonnées inchangées."""
    x, y = _wrap_disque(100, 200, 0, 0, 1000)
    assert (x, y) == (100, 200)


def test_wrap_disque_juste_hors_renvoie_oppose():
    """Point juste hors disque (r entre R et 2R) : renvoyé au point
    diamétralement opposé à distance (2R - r)."""
    R = 1000
    # r = 1100, theta = 0 → r_mod = 1100, > R → new_r = 900, new_theta = π
    x, y = _wrap_disque(1100, 0, 0, 0, R)
    assert math.isclose(x, -900, abs_tol=1e-6)
    assert math.isclose(y, 0, abs_tol=1e-6)


def test_wrap_disque_axe_y():
    """Wrap fonctionne aussi en y (symétrie radiale)."""
    R = 1000
    x, y = _wrap_disque(0, 1500, 0, 0, R)
    # r=1500, theta=π/2 → r_mod=1500, > R → new_r=500, new_theta=π/2 + π = 3π/2
    # Position : (0, -500)
    assert math.isclose(x, 0, abs_tol=1e-6)
    assert math.isclose(y, -500, abs_tol=1e-6)


def test_wrap_disque_grand_depassement_modulo():
    """Point très loin (r > 2R) : modulo sur 2R puis traitement."""
    R = 1000
    # r = 2500 → r_mod = 500, ≤ R → renvoyé (500, 0) (même angle, pas de retournement)
    x, y = _wrap_disque(2500, 0, 0, 0, R)
    assert math.isclose(x, 500, abs_tol=1e-6)
    assert math.isclose(y, 0, abs_tol=1e-6)


def test_wrap_disque_centre_decale():
    """Wrap-around centré sur (cx, cy) ≠ (0, 0)."""
    cx, cy, R = 100.0, 200.0, 50.0
    # Point à (200, 200) : r_rel = (100, 0), r=100, theta=0
    # r_mod = 100 % 100 = 0... attention, modulo Python sur float
    # 100 % 100 = 0, ≤ R, donc inchangé en r → returned (cx + 0*cos, cy + 0*sin) = (cx, cy)
    x, y = _wrap_disque(200, 200, cx, cy, R)
    assert math.isclose(x, cx, abs_tol=1e-6)
    assert math.isclose(y, cy, abs_tol=1e-6)


# --- Premier éclair / état initial ---

def test_fixer_premier_eclair_obligatoire_avant_prochain():
    rng = np.random.default_rng(42)
    gen = GenerateurOrage((0, 0), _params_par_defaut(), rng)
    with pytest.raises(RuntimeError):
        gen.prochain_eclair()


def test_premier_eclair_garde_position_clic():
    rng = np.random.default_rng(42)
    gen = GenerateurOrage((0, 0), _params_par_defaut(), rng)
    gen.fixer_premier_eclair((1234.5, -987.6))
    # Vérifie via l'attribut interne
    assert gen._derniere_position == (1234.5, -987.6)


# --- Reproductibilité ---

def test_reproductibilite_meme_seed():
    """Deux générateurs avec même seed produisent la même séquence."""
    p = _params_par_defaut()
    rng_a = np.random.default_rng(seed=123)
    rng_b = np.random.default_rng(seed=123)
    gen_a = GenerateurOrage((0, 0), p, rng_a)
    gen_b = GenerateurOrage((0, 0), p, rng_b)
    gen_a.fixer_premier_eclair((100, 200))
    gen_b.fixer_premier_eclair((100, 200))

    for _ in range(50):
        a = gen_a.prochain_eclair()
        b = gen_b.prochain_eclair()
        assert a == b


def test_seeds_differentes_sequences_differentes():
    p = _params_par_defaut()
    gen_a = GenerateurOrage((0, 0), p, np.random.default_rng(seed=1))
    gen_b = GenerateurOrage((0, 0), p, np.random.default_rng(seed=2))
    gen_a.fixer_premier_eclair((0, 0))
    gen_b.fixer_premier_eclair((0, 0))
    a = gen_a.prochain_eclair()
    b = gen_b.prochain_eclair()
    assert a != b


# --- Invariants physiques ---

def test_eclairs_toujours_dans_le_disque():
    """Les positions retournées sont garanties dans le disque (après wrap)."""
    p = _params_par_defaut()
    gen = GenerateurOrage((0, 0), p, np.random.default_rng(seed=42))
    gen.fixer_premier_eclair((0, 0))
    for _ in range(500):
        _, (x, y) = gen.prochain_eclair()
        assert math.hypot(x, y) <= p.rayon_max_m + 1e-6


def test_cadence_moyenne_convergente():
    """Sur N tirages, la moyenne des intervalles tend vers 60/cadence_par_min."""
    p = ParametresOrage(
        rayon_max_m=100_000.0,
        cadence_par_min=12.0,  # ⇒ E[Δt] = 5 s
        distance_moy_m=100.0,
        derive_direction_deg=0.0,
        derive_vitesse_m_par_s=0.0,
    )
    gen = GenerateurOrage((0, 0), p, np.random.default_rng(seed=42))
    gen.fixer_premier_eclair((0, 0))

    deltas = [gen.prochain_eclair()[0] for _ in range(2000)]
    moyenne_observee = sum(deltas) / len(deltas)
    moyenne_attendue = 60.0 / p.cadence_par_min
    # Tolérance ±10% sur 2000 tirages
    assert abs(moyenne_observee - moyenne_attendue) / moyenne_attendue < 0.1


def test_derive_deplace_le_nuage():
    """Avec une dérive non nulle et marche faible, les éclairs dérivent en moyenne
    dans la direction de la dérive."""
    p = ParametresOrage(
        rayon_max_m=1_000_000.0,  # très grand pour éviter wrap
        cadence_par_min=60.0,     # 1 éclair/s en moyenne
        distance_moy_m=100.0,     # marche très faible
        derive_direction_deg=0.0, # dérive vers l'Est
        derive_vitesse_m_par_s=1000.0,  # 1 km/s vers l'Est
    )
    gen = GenerateurOrage((0, 0), p, np.random.default_rng(seed=42))
    gen.fixer_premier_eclair((0, 0))
    for _ in range(100):
        gen.prochain_eclair()
    pos_finale = gen._derniere_position
    # Après 100 secondes en moyenne avec dérive 1000 m/s, on attend ~100 km à l'Est
    assert pos_finale[0] > 50_000  # confortablement vers l'Est
