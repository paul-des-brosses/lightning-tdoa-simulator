# ROADMAP.md — Plan d'implémentation

Étapes ordonnées pour construire le simulateur. Chaque phase se termine par un livrable testable avant de passer à la suivante. Estimations indicatives.

---

## Phase 0 — Setup (30 min)

- [ ] Initialiser le repo : `pyproject.toml`, `.gitignore` (Python standard), `LICENSE` (MIT).
- [ ] Dépendances : `numpy`, `scipy`, `matplotlib`, `folium`, `pytest`, `tqdm`.
- [ ] Arborescence : `lightning_tdoa/`, `tests/`, `experiments/`, `assets/`.
- [ ] Commiter `DECISIONS.md` et `CLAUDE.md` à la racine.
- [ ] README.md squelette (titre + 1 ligne de description, à enrichir en phase 6).

**Livrable** : `pip install -e .` fonctionne, `pytest` tourne (0 tests).

---

## Phase 1 — Géométrie (1-2h)

Module `geometry.py`.

- [ ] Dataclass `Station(id: str, x: float, y: float)` (coordonnées ENU en mètres).
- [ ] Fonction `distance(p1, p2) -> float`.
- [ ] Fonction `check_non_collinear(stations, tol=1e-3) -> None` (lève `GeometryError` sinon).
- [ ] Exception `GeometryError`.
- [ ] Helper `default_triangle(side_km: float) -> list[Station]` pour les tests et benchmarks.

**Livrable** : module importable, fonctions unitaires testables à la main dans un REPL.

---

## Phase 2 — Simulateur (2-3h)

Module `simulator.py`.

- [ ] Dataclass `NoiseConfig(sigma_vlf_ns, sigma_gps_ns, clock_bias_ns_per_station)`.
- [ ] Fonction `simulate_strike(impact: tuple[float, float], stations, noise_cfg, rng) -> dict[str, float]`.
  - Calcule `t_i = ‖impact − station_i‖ / c`.
  - Ajoute 3 composantes de bruit indépendantes.
  - Retourne les TOAs absolus (le solveur ne travaillera qu'avec les différences).
- [ ] Constante `C_LIGHT = 299_792_458.0` (m/s).
- [ ] Validation : `NoiseConfig` rejette les σ négatifs.

**Livrable** : générer un impact, inspecter les TOAs, vérifier que l'écart max entre stations est cohérent avec la distance max / c.

---

## Phase 3 — Solveurs (3-4h)

Module `solver.py`.

- [ ] Dataclass `SolverResult(position: tuple[float, float], residuals: np.ndarray, converged: bool)`.
- [ ] Exception `SolverError`.
- [ ] `solve_nlls(toas, stations) -> SolverResult` :
  - Convertit TOAs → TDOA par rapport à une station de référence.
  - Fonction résidu : différence entre TDOA mesurés et TDOA prédits pour une position candidate.
  - `scipy.optimize.least_squares`, point de départ = barycentre.
  - Raise `SolverError` si non-convergence.
- [ ] `solve_analytical(toas, stations) -> SolverResult` :
  - Intersection de 2 hyperboles en 2D (équations closed-form).
  - Désambiguïsation des 2 solutions candidates par résidu minimal.
  - Raise `GeometryError` si stations colinéaires.
- [ ] API uniforme : les deux solveurs ont la même signature.

**Livrable** : Test 1 (`test_solver_identity`) passe pour les deux solveurs.

---

## Phase 4 — Métriques (1-2h)

Module `metrics.py`.

- [ ] `location_error(estimated, truth) -> float` (distance euclidienne).
- [ ] `gdop(stations, position) -> float` (dilution de précision géométrique).
- [ ] `monte_carlo_error(impact, stations, noise_cfg, n_trials, solver_fn, rng) -> dict` retournant `{median, p95, mean, std}`.

**Livrable** : Tests 2, 3, 4 implémentés et passent.

---

## Phase 5 — Visualisation (2-3h)

Module `viz.py`.

- [ ] `plot_scenario(stations, impact, estimate, ax=None)` : vue statique d'un tir.
- [ ] `plot_heatmap(error_grid, stations, ax=None)` : heatmap d'erreur avec stations superposées.
- [ ] `plot_noise_curve(sigmas, errors_per_solver, ax=None)` : courbe log-log, plusieurs solveurs superposables.
- [ ] `export_folium(stations, impact, estimate, output_path)` : carte HTML interactive.
- [ ] Toutes les fonctions retournent la `Figure` ou le chemin du fichier. Pas d'appel à `plt.show()` caché.

**Livrable** : scripts de démo visuelle qui génèrent les PNG attendus.

---

## Phase 6 — Benchmarks (3-4h)

Scripts `experiments/*.py`.

- [ ] `bench_heatmap.py` — heatmap phare, σ_GPS = 100 ns, grille 50×50, ≥100 trials/cellule → `assets/heatmap_main.png`.
- [ ] `bench_noise_curve.py` — erreur médiane vs σ en log-log, impact fixe, 1000 trials/point → `assets/noise_curve.png`.
- [ ] `bench_solver_comparison.py` — même courbe, NLLS vs analytique superposés → `assets/solver_comparison.png`.
- [ ] `bench_geometry.py` — 3 heatmaps côte à côte (équilatéral, aplati, colinéaire-limite) → `assets/geometry_effect.png`.
- [ ] Chaque script affiche en fin d'exécution le chiffre clé (ex : "median error = X m").
- [ ] Extraction du chiffre clé principal pour l'intro du README.

**Livrable** : `assets/` contient les 4 figures. Le chiffre clé du projet est connu.

---

## Phase 7 — README et finition (2-3h)

- [ ] README.md complet selon structure imposée par `CLAUDE.md`.
- [ ] Équations TDOA en LaTeX (MathJax rendu par GitHub).
- [ ] Intégration des 4 figures.
- [ ] Section "Limitations" honnête (hypothèses 2D, pas de waveform, bruit gaussien simplifié).
- [ ] Lien vers démo Folium hébergée sur GitHub Pages.
- [ ] Setup GitHub Pages : branche `gh-pages` ou dossier `docs/`, upload du HTML Folium.
- [ ] Dernière passe : lisibilité, fautes, cohérence des chiffres entre README et scripts.

**Livrable** : repo public prêt à être lien dans le CV.

---

## Phase 8 (optionnelle) — Extensions

À considérer uniquement si phases 0-7 terminées et temps disponible :

- Synthèse de forme d'onde VLF + extraction TDOA par corrélation croisée (`waveform.py`).
- Extension à N stations et étude de la convergence en fonction de N.
- Implémentation de la méthode de Chan pour comparaison triple.
- CI GitHub Actions : lint (`ruff`), tests (`pytest`), génération automatique des figures.

Ces extensions sont des bonus. **Ne pas les commencer avant que le cœur soit poli.**

---

## Ordre de priorité en cas de temps limité

Si seulement la moitié du temps est disponible, ordre de coupe :
1. Skip phase 8 (évident).
2. Dans phase 6, ne garder que `bench_heatmap.py` et `bench_noise_curve.py`.
3. Dans phase 5, skip Folium, garder matplotlib seulement.
4. Dans phase 3, skip `solve_analytical`, garder NLLS seul (mais alors retirer le bench comparatif).

**Ce qu'il ne faut jamais skipper** : phases 1-4 complètes + heatmap principale + README structuré. C'est le minimum vital pour que le projet existe.
