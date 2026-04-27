"""Test ROADMAP §5 n°2 : test_simulator_solver_consistency.

Sur 1000 essais à σ=100 ns par composante, l'erreur médiane doit rester
sous un seuil (≈ σ_τ_total · c · GDOP · facteur de marge).

Pour σ=100ns/composante et impact intérieur à un triangle 50 km :
- σ_τ_total = sqrt(3·100²) ≈ 173 ns
- σ_τ_total · c ≈ 52 m
- GDOP ≈ 1.1 au centre du triangle
- Erreur médiane attendue ≈ 60 m
- Seuil de test : 100 m (marge × 1.7)
"""

import numpy as np

from lightning_tdoa.geometry import triangle_par_defaut
from lightning_tdoa.metrics import monte_carlo
from lightning_tdoa.simulator import NoiseConfig
from lightning_tdoa.solver import resoudre_nlls


def test_simulator_solver_consistency():
    stations = triangle_par_defaut(cote_km=50)
    cfg = NoiseConfig(sigma_vlf_ns=100.0, sigma_gps_ns=100.0, sigma_horloge_ns=100.0)
    rng = np.random.default_rng(seed=2026)
    impact = (5_000.0, -3_000.0)

    stats = monte_carlo(
        impact, stations, cfg, n_trials=1000, solveur_fn=resoudre_nlls, rng=rng
    )

    assert stats["n_echecs"] == 0
    assert stats["median"] < 100.0, (
        f"erreur mediane {stats['median']:.1f} m hors seuil (100 m attendu)"
    )
    # p95 doit aussi rester raisonnable (~ 2.5 × médiane)
    assert stats["p95"] < 250.0
