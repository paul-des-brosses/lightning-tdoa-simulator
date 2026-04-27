# DECISIONS.md — Lightning TDOA Simulator

Ce document consigne les choix d'architecture et de méthode arrêtés avant implémentation. Toute déviation en phase de production doit être justifiée et reportée ici.

---

## 1. Formulation mathématique

**Choix retenu** : deux solveurs implémentés côte à côte.

- **Solveur principal** : moindres carrés non-linéaires (`scipy.optimize.least_squares`), minimisant la somme des carrés des résidus sur les différences de temps d'arrivée. Point de départ = barycentre des stations. Extensible à N stations, robuste au bruit.
- **Solveur de comparaison** : résolution analytique 2D par intersection d'hyperboles (3 stations strict). Sert de baseline pédagogique et de point de comparaison dans les benchmarks.

**Rejeté** : méthode de Chan. Complexité additionnelle non justifiée pour le message portfolio.

---

## 2. Modèle physique

- **Propagation** : vitesse fixée à `c = 299_792_458 m/s`. L'écart VLF réel (~0.99c dans le guide Terre-ionosphère) est documenté comme hypothèse simplificatrice dans le README.
- **Géométrie** : coordonnées cartésiennes locales en plan tangent ENU (East-North-Up), en mètres, autour d'un point de référence.

  - *Choix initial.* Validité bornée à un rayon fixe de 200 km autour du barycentre des stations.
  - *Itération 1 — passage à un critère GDOP géométrique.* Le 200 km étant arbitraire, on le remplace par un rayon de validité dérivé de la géométrie via la GDOP (Geometric Dilution of Precision). Implémentation :
      1. Fonction `distance_max_validite(stations, gdop_max)` ajoutée à `metrics.py`, calculée par dichotomie radiale.
      2. Quatre seuils standard avec labels qualitatifs : GDOP ≤ 2 = excellent, ≤ 5 = bon, ≤ 10 = dégradé, ≤ 20 = limite.
      3. Garde-fou actif : `simulate_strike` refuse (lève `ErreurSimulation`) tout impact au-delà de GDOP = 20 par défaut.
  - *Itération 2 — passage à un budget d'erreur user-facing.* Le seuil GDOP reste cryptique pour l'utilisateur. On expose un paramètre `erreur_max_km` qui exprime directement la tolérance d'erreur de position acceptable. Le seuil GDOP est dérivé dynamiquement :
      ```
      GDOP_max = (erreur_max_km · 1000) / (σ_τ_total · c)
      ```
      où `σ_τ_total = sqrt(σ_vlf² + σ_gps² + σ_horloge²)` est extrait de `NoiseConfig` (propriété `sigma_totale_s`). `simulate_strike(impact, ..., erreur_max_km=1.0)` est le nouveau défaut ; `erreur_max_km=None` désactive le garde-fou. Une fonction sœur `distance_max_validite_par_erreur(stations, erreur_max_km, noise_cfg)` expose le rayon utile dans cette nouvelle convention.
  - *Justification.* (a) Un rayon fixe ignore la dépendance physique à l'écartement des stations (loi d'échelle linéaire : `rayon_utile ≈ k · côté_baseline` observée empiriquement pour seuil GDOP fixé). (b) La GDOP capture cette dépendance sans référence à une distance absolue, mais elle est non-intuitive pour un utilisateur. (c) Le budget d'erreur en km est immédiatement compréhensible (`"je veux max 1 km de précision"`) et combine proprement les deux dimensions du problème : géométrie (GDOP) et bruit de mesure (σ_τ). Le défaut `erreur_max_km=1.0` reproduit approximativement le comportement de l'itération 1 (GDOP=20) pour les niveaux de bruit nominaux du projet, donc la transition est rétro-compatible. Le garde-fou reste là pour empêcher les usages silencieusement absurdes en champ très lointain (observés en Phase 3 : les deux solveurs convergent vers la même position erronée sans signal).
- **Simulation des temps d'arrivée** : niveau 1 — calcul direct `t_i = ‖impact − station_i‖ / c + bruit`. Pas de synthèse de forme d'onde.
- **Modèle de bruit** : trois composantes indépendantes, paramétrables séparément.
  1. Jitter de détection VLF (gaussien, σ ~ 100 ns à 1 μs).
  2. Bruit GPS sur timestamp (gaussien, σ ~ 50-100 ns avec PPS).
  3. Biais d'horloge par station (offset constant par station, ~100 ns).

---

## 3. Architecture du code

```
lightning_tdoa/
├── geometry.py      # Station, conversions ENU, primitives géométriques
├── simulator.py     # Génération d'impacts, TOA bruités
├── solver.py        # NLLS + solveur analytique, API uniforme
├── metrics.py       # Erreurs, GDOP, agrégats Monte Carlo
└── viz.py           # Plots matplotlib + export Folium HTML
tests/
  ├── test_solver.py
  ├── test_simulator_solver.py
  └── test_edge_cases.py
experiments/
  ├── bench_heatmap.py
  ├── bench_noise_curve.py
  ├── bench_solver_comparison.py
  └── bench_geometry.py
```

**Principe directeur** : `solver.py` est découplé de `simulator.py`. Le solveur accepte un dict `{station_id: t_arrival}` sans connaître l'origine des données. Cela permet de brancher ultérieurement de vraies mesures hardware sans toucher au solveur.

---

## 4. Visualisation

- **Matplotlib** : PNG générés et commités dans `assets/` pour affichage direct dans le README.
- **Folium** : export HTML interactif (carte, stations, impact, hyperboles, ellipse d'incertitude) hébergé sur GitHub Pages. Lien "Voir la démo interactive" dans le README.

### Évolution Phase 8 — UI web interactive

  - *Choix initial.* Rejeté : Streamlit / Gradio. Contrainte de déploiement et de maintenance non justifiée pour ce portfolio. Visualisation = matplotlib statique + Folium HTML uniquement.
  - *Itération.* Ajout d'une **UI web statique interactive** servie via Pyodide :
      1. HTML / CSS / JS vanilla (pas de framework lourd).
      2. **Pyodide** (CPython compilé en WebAssembly) charge `lightning_tdoa/` directement dans le navigateur, **sans backend**.
      3. Rendu temps-réel en SVG (stations draggables, animation des éclairs).
      4. Génération de rapport PDF côté client via swiftlatex.js (TeX Live WASM), avec fallback zip `.tex + PNG`.
      5. Déployable sur GitHub Pages (statique pur).
      6. Modules ajoutés à `lightning_tdoa/` : `storm.py` (générateur d'orages Poisson + dérive), extensions `metrics.py` (calculer_grille_erreur_mc, optimiser_placement_station), extensions `geometry.py` (triangle_etire, triangle_obtus, triangle_predefini), extensions `simulator.py` (PRESETS_BRUIT).
  - *Justification.* La contrainte initiale "pas de framework serveur" reste respectée : Pyodide est entièrement côté client, le déploiement reste statique. On obtient l'interactivité + la génération de rapport sans introduire de backend à maintenir. Le coût technique a été validé en P4 (Phase 8) : scipy/numpy passent Pyodide, premier load ~30 s, sessions ultérieures ~5 s grâce au cache navigateur. La lib Python existante est réutilisée telle quelle — aucune logique métier n'est dupliquée en JS (à l'exception d'une détection colinéarité légère pour le drag temps-réel, doublée par un appel `verifier_non_colineaires()` en P6).

---

## 5. Tests unitaires

Quatre tests retenus, chacun motivé par une propriété concrète à protéger :

| # | Nom | Ce qu'il vérifie | Pourquoi c'est critique |
|---|-----|-------------------|--------------------------|
| 1 | `test_solver_identity` | Impact connu → TOAs sans bruit → solveur récupère la position à < 1 m | Test de survie : si ça casse, tout est cassé |
| 2 | `test_simulator_solver_consistency` | 1000 impacts bruités (σ = 100 ns) → erreur médiane < seuil | Détecte toute régression sur la chaîne simu+solveur |
| 3 | `test_gdop_behavior` | GDOP faible au centre du triangle, élevée en config dégénérée | Valide la métrique de qualité géométrique |
| 4 | `test_edge_cases` | Stations colinéaires → exception explicite ; impact proche station → convergence stable | Protège contre les échecs silencieux |

**Rejetés** : test de symétrie (redondant avec test 1), tests de la couche viz (faible valeur).

---

## 6. Benchmarks (README)

Quatre expériences, générées par les scripts `experiments/*.py` et commitées sous forme de PNG dans `assets/`.

1. **Heatmap d'erreur RMS** (expérience phare) — grille 2D autour des stations, ≥100 trials Monte Carlo par cellule, σ_GPS fixé à 100 ns. Figure centrale du README.
2. **Courbe erreur médiane vs σ_bruit** en échelle log-log. Vérifie la linéarité attendue théoriquement et identifie la zone de décrochage.
3. **Comparatif solveur analytique vs NLLS** sur la même courbe de bruit. Justifie quantitativement le choix du NLLS.
4. **Optimisation de la géométrie pour zone cible**.

   - *Choix initial.* Trois heatmaps côte à côte (équilatéral, aplati, quasi-colinéaire) démontrant l'impact de la GDOP.
   - *Virage stratégique.* Le benchmark étudie maintenant l'optimisation du dimensionnement, plutôt qu'une comparaison de formes fixes :
       1. Zone cible paramétrée (disque de rayon Z).
       2. Variable libre : taille du triangle équilatéral, ratio taille / Z balayé sur {0.1, 0.3, 0.5, 1, 2, 5}.
       3. Pour chaque taille, erreur médiane et p95 sur la zone via Monte Carlo, plus une superposition des contours GDOP {5, 10, 20}.
       4. Sortie principale : courbe taille / Z → erreur, avec optimum identifié.
       5. Les 3 formes du choix initial restent comparées en panneau secondaire (ancrage visuel "forme vs taille").
   - *Justification.* "Comment la forme affecte la qualité" est pédagogique mais peu actionnable. La question utile pour un portfolio est "comment dimensionner mon réseau pour ma zone à couvrir". Le nouveau benchmark répond à cette question opérationnelle, et garde la comparaison des formes en bonus.

**Chiffre clé annoncé en intro du README** : précision médiane à l'intérieur du triangle (côté ~50 km) et à 100 km en dehors, pour σ_GPS = 100 ns.

---

## Hypothèses simplificatrices à documenter dans le README

- Propagation rectiligne à vitesse `c` constante (pas de modèle guide d'onde ionosphérique).
- Géométrie 2D en plan tangent (pas de WGS84, pas d'altitude).
- Bruits gaussiens indépendants (pas de corrélation spatiale de l'ionosphère).
- Pas de synthèse de forme d'onde VLF (extension possible en v2).
