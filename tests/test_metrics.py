"""Tests ROADMAP §5 n°3 : test_gdop_behavior.

Vérifie que :
- GDOP au barycentre est faible (~1) pour un triangle équilatéral.
- GDOP loin du réseau est élevée.
- GDOP croît monotonement avec la distance radiale (pour direction non-pathologique).
"""

import numpy as np

from lightning_tdoa.geometry import triangle_par_defaut
from lightning_tdoa.metrics import gdop, qualite_geometrique, SEUILS_GDOP


def test_gdop_centre_faible():
    stations = triangle_par_defaut(cote_km=50)
    g_centre = gdop(stations, (0.0, 0.0))
    assert g_centre < 1.0, f"GDOP au centre = {g_centre:.3f} (attendu < 1)"
    assert g_centre > 0.5, f"GDOP au centre = {g_centre:.3f} (attendu > 0.5, plancher théorique)"


def test_gdop_loin_eleve():
    stations = triangle_par_defaut(cote_km=50)
    g_loin = gdop(stations, (300_000.0, 0.0))
    assert g_loin > 100.0, f"GDOP a 300 km = {g_loin:.1f} (attendu > 100)"


def test_gdop_croit_avec_distance():
    """Direction (0, 1) est non-pathologique (vers vertex S1) : GDOP monotone."""
    stations = triangle_par_defaut(cote_km=50)
    distances = [10_000, 30_000, 100_000, 300_000]
    gdops = [gdop(stations, (0.0, d)) for d in distances]
    for i in range(len(gdops) - 1):
        assert gdops[i] < gdops[i + 1], (
            f"GDOP non-monotone: {gdops}"
        )


def test_qualite_geometrique_labels():
    stations = triangle_par_defaut(cote_km=50)
    label_centre = qualite_geometrique(stations, (0.0, 0.0))["label"]
    assert label_centre == "excellent"
    label_loin = qualite_geometrique(stations, (500_000.0, 0.0))["label"]
    assert label_loin == "inutilisable"


def test_seuils_gdop_ordre_croissant():
    """Garantie d'invariant : seuils dans l'ordre attendu pour la cascade."""
    valeurs = list(SEUILS_GDOP.values())
    assert valeurs == sorted(valeurs)
