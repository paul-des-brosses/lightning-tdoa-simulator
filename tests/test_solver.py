"""Tests ROADMAP §5 :
- 1. test_solver_identity : impact connu, 0 bruit, erreur < 1 m (les 2 solveurs).
- 4. test_edge_cases (partie convergence proche station) : impact près d'une
     station doit converger.
"""

import numpy as np
import pytest

from lightning_tdoa.geometry import Station, triangle_par_defaut
from lightning_tdoa.metrics import erreur_localisation
from lightning_tdoa.simulator import NoiseConfig, simulate_strike
from lightning_tdoa.solver import resoudre_analytique, resoudre_nlls


@pytest.fixture
def stations():
    return triangle_par_defaut(cote_km=50)


@pytest.fixture
def cfg_zero():
    return NoiseConfig(sigma_vlf_ns=0.0, sigma_gps_ns=0.0, sigma_horloge_ns=0.0)


@pytest.fixture
def rng():
    return np.random.default_rng(seed=2026)


# Impacts intérieurs au triangle (évite l'ambiguïté analytique 2-candidats
# quand le vrai impact n'est pas le plus proche du barycentre).
IMPACTS_INTERIEUR = [
    (0.0, 0.0),
    (5_000.0, -3_000.0),
    (-7_000.0, 4_000.0),
    (10_000.0, 5_000.0),
    (-2_000.0, -8_000.0),
]


@pytest.mark.parametrize("impact", IMPACTS_INTERIEUR)
def test_solver_identity_nlls(stations, cfg_zero, rng, impact):
    """NLLS récupère un impact à <1 m sans bruit."""
    toas = simulate_strike(impact, stations, cfg_zero, rng, erreur_max_km=None)
    res = resoudre_nlls(toas, stations)
    assert erreur_localisation(res.position, impact) < 1.0


@pytest.mark.parametrize("impact", IMPACTS_INTERIEUR)
def test_solver_identity_analytique(stations, cfg_zero, rng, impact):
    """Analytique récupère un impact à <1 m sans bruit."""
    toas = simulate_strike(impact, stations, cfg_zero, rng, erreur_max_km=None)
    res = resoudre_analytique(toas, stations)
    assert erreur_localisation(res.position, impact) < 1.0


def test_edge_case_proche_station(stations, cfg_zero, rng):
    """Impact à 10 m d'une station : le solveur doit converger (pas planter).

    NB : la précision peut être dégradée car la quasi-singularité géométrique
    (une station à distance ~0, deux autres à distance grande) introduit
    une ambiguïté entre la solution réelle et son symétrique. ROADMAP §5
    demande seulement la convergence, pas la précision.
    """
    s_proche = stations[0]
    impact = (s_proche.x + 10.0, s_proche.y + 10.0)
    toas = simulate_strike(impact, stations, cfg_zero, rng, erreur_max_km=None)
    res_nlls = resoudre_nlls(toas, stations)
    assert res_nlls.converge is True
    # Résidus quasi-nuls = solveur a vraiment trouvé un minimum (même si fantôme)
    assert float(np.max(np.abs(res_nlls.residus))) < 1e-6
