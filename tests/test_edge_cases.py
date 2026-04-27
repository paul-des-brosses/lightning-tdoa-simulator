"""Test ROADMAP §5 n°4 : test_edge_cases.

- Stations colinéaires → ErreurGeometrie (pour validation et solveur analytique).
- Moins de 3 stations → erreur.
- NoiseConfig avec sigma négatif → ValueError.
- Garde-fou simulator : impact en zone GDOP > seuil → ErreurSimulation.
"""

import numpy as np
import pytest

from lightning_tdoa.geometry import (
    ErreurGeometrie,
    Station,
    triangle_par_defaut,
    verifier_non_colineaires,
)
from lightning_tdoa.simulator import (
    ErreurSimulation,
    NoiseConfig,
    simulate_strike,
)
from lightning_tdoa.solver import (
    ErreurSolveur,
    resoudre_analytique,
    resoudre_nlls,
)


# ---- Géométrie ----

def test_colineaire_leve_erreur_geometrie():
    stations = [
        Station("A", 0.0, 0.0),
        Station("B", 1000.0, 0.0),
        Station("C", 2000.0, 0.0),
    ]
    with pytest.raises(ErreurGeometrie):
        verifier_non_colineaires(stations)


def test_moins_de_3_stations_leve():
    stations = [Station("A", 0.0, 0.0), Station("B", 1000.0, 1000.0)]
    with pytest.raises(ErreurGeometrie):
        verifier_non_colineaires(stations)


def test_stations_confondues_leve():
    stations = [
        Station("A", 100.0, 100.0),
        Station("B", 100.0, 100.0),
        Station("C", 100.0, 100.0),
    ]
    with pytest.raises(ErreurGeometrie):
        verifier_non_colineaires(stations)


# ---- Solveur analytique : colinéarité ----

def test_solveur_analytique_rejette_colineaires():
    stations = [
        Station("A", 0.0, 0.0),
        Station("B", 1000.0, 0.0),
        Station("C", 2000.0, 0.0),
    ]
    toas = {"A": 0.0, "B": 1e-6, "C": 2e-6}
    with pytest.raises(ErreurGeometrie):
        resoudre_analytique(toas, stations)


def test_solveur_analytique_rejette_4_stations():
    stations = triangle_par_defaut(cote_km=50) + [Station("S4", 0.0, -10_000.0)]
    with pytest.raises(ErreurSolveur):
        resoudre_analytique({}, stations)


# ---- NLLS ----

def test_solveur_nlls_rejette_2_stations():
    stations = triangle_par_defaut(cote_km=50)[:2]
    with pytest.raises(ErreurSolveur):
        resoudre_nlls({"S1": 0.0, "S2": 1e-6}, stations)


def test_solveur_nlls_rejette_toa_manquant():
    stations = triangle_par_defaut(cote_km=50)
    toas_incompl = {"S1": 0.0, "S2": 1e-6}  # manque S3
    with pytest.raises(ErreurSolveur):
        resoudre_nlls(toas_incompl, stations)


# ---- NoiseConfig ----

def test_noise_config_sigma_negatif_leve():
    with pytest.raises(ValueError):
        NoiseConfig(sigma_vlf_ns=-1.0, sigma_gps_ns=0.0, sigma_horloge_ns=0.0)
    with pytest.raises(ValueError):
        NoiseConfig(sigma_vlf_ns=0.0, sigma_gps_ns=-1.0, sigma_horloge_ns=0.0)
    with pytest.raises(ValueError):
        NoiseConfig(sigma_vlf_ns=0.0, sigma_gps_ns=0.0, sigma_horloge_ns=-1.0)


# ---- Garde-fou simulator ----

def test_garde_fou_impact_lointain_leve():
    stations = triangle_par_defaut(cote_km=50)
    cfg = NoiseConfig(100.0, 100.0, 100.0)
    rng = np.random.default_rng(42)
    # Impact très loin -> erreur attendue >> 1 km par défaut
    with pytest.raises(ErreurSimulation):
        simulate_strike((0.0, 1_000_000.0), stations, cfg, rng)


def test_garde_fou_desactivable():
    stations = triangle_par_defaut(cote_km=50)
    cfg = NoiseConfig(100.0, 100.0, 100.0)
    rng = np.random.default_rng(42)
    # Avec erreur_max_km=None, la simulation doit passer
    toas = simulate_strike(
        (0.0, 1_000_000.0), stations, cfg, rng, erreur_max_km=None
    )
    assert len(toas) == 3
