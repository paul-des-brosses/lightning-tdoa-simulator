# Notes techniques - bugs et décisions

Bugs rencontrés pendant le développement, leur diagnostic et leur correction.
Décisions techniques annexes prises au fil du code, qui n'ont pas leur place
dans `DECISIONS.md` parce qu'elles sont trop locales.

Le but de ce fichier est de garder une trace exploitable de ce qui était
non-évident à la lecture du code (hacks volontaires, choix qui *semblent*
faux mais sont délibérés). Si on rouvre le projet dans six mois, c'est ici
qu'on retrouve le « pourquoi ».

---

# Bugs rencontrés

## 2026-04-23 - solver.py - NLLS coincé au point de départ (problème d'échelle)

**Symptôme**
Lors des premiers tests de `resoudre_nlls`, la position retournée était
toujours exactement le barycentre des stations (= point de départ), pour
n'importe quel impact. Les 1000 essais Monte Carlo donnaient tous la même
erreur (= distance entre l'impact et le barycentre), confirmant que
l'optimiseur n'itérait jamais. Pourtant `res.success` était `True` et aucun
warning n'était émis.

**Cause**
Les résidus étaient calculés en **secondes** (TDOA différence). Pour des
TDOA typiques de l'ordre de 10⁻⁶ s, les résidus sont en 10⁻⁶, leurs carrés
en 10⁻¹², et le coût total de `least_squares` en 10⁻⁹. Or la tolérance par
défaut `ftol=1e-8` de scipy demande une **réduction relative** du coût.
Avec un coût initial déjà dans les 10⁻⁹, le critère "réduit-le d'un facteur
1e-8" est trivialement satisfait dès la première itération. scipy considère
qu'il a convergé immédiatement, sans avoir bougé.

**Fix**
Les résidus sont maintenant exprimés en **mètres** (multipliés par c).
Concrètement : `out[i] = (d_i - d_ref) - C_LIGHT * tdoas_mesurees[i]` au lieu
de `(d_i - d_ref)/C_LIGHT - tdoas_mesurees[i]`. Les résidus typiques sont
maintenant en milliers à dizaines de milliers de mètres, l'optimiseur
itère normalement.

Bonus : les résidus retournés dans `ResultatSolveur.residus` sont aussi
plus interprétables (un résidu de 100 m parle plus qu'un résidu de 333 ns).

**Leçon générale**
Avant d'utiliser un optimiseur numérique avec ses paramètres par défaut,
toujours vérifier que la magnitude de la fonction objectif est cohérente
avec les tolérances supposées. Ces dernières assument généralement des
valeurs "normalisées" autour de 1.

---

## 2026-04-23 - solver.py - TRF se piège quand x0 est numériquement proche de zéro

**Symptôme**
Après le fix précédent (résidus en mètres), le solveur restait toujours
coincé au barycentre. Bizarre, car les résidus à `x0` étaient maintenant
de l'ordre de 14 000 m, l'optimiseur devait clairement bouger.

**Cause**
Le barycentre d'un triangle équilatéral centré sur l'origine vaut
mathématiquement `(0, 0)`. Mais en flottant double, `np.mean` des cosinus
et sinus aux angles `π/2`, `π/2 + 2π/3`, `π/2 + 4π/3` accumule des
erreurs d'arrondi qui donnent un barycentre à `(-3.6e-12, -1.8e-12)`.

Or la méthode `trust-region reflective` (TRF) de scipy calibre la **taille
initiale de son rayon de confiance** proportionnellement à `|x|`. Quand
`|x| ≈ 1e-12`, le premier pas tenté fait `4e-12 m`. Évidemment, pour
naviguer vers un impact à 10 km, c'est insuffisant - l'optimiseur conclut
"fonction plate localement" et abandonne.

Démonstration empirique trouvée pendant le debug :
- `x0 = (0.0, 0.0)` (exact) → marche correctement
- `x0 = (1.0, 1.0)` → marche
- `x0 = (0.001, 0.001)` → marche
- `x0 = (-3.6e-12, -1.8e-12)` → échoue
- `x0 = (-3.6e-9, -1.8e-9)` → échoue

Tester avec `method='lm'` (Levenberg-Marquardt) ou `method='dogbox'`
échoue de la même façon. Tester `x_scale='jac'` ou `x_scale=[L, L]`
explicite ne suffit pas non plus à débloquer la situation.

**Fix**
Snap-to-zero préventif : toute composante de `x0` plus petite en valeur
absolue que `1e-9 × diamètre_du_nuage_de_stations` est forcée à `0.0`
avant de passer à `least_squares`. Concrètement :

```python
coords = np.array([s.position for s in stations])
echelle = np.ptp(coords, axis=0).max()
x0 = np.where(np.abs(x0) < echelle * 1e-9, 0.0, x0)
```

Cela enlève le bruit d'arrondi, scipy voit un vrai zéro et utilise sa
logique de fallback pour les points proches de l'origine.

**Leçon générale**
Les méthodes "trust-region" ont des biais cachés liés à la valeur initiale.
Si on part près de zéro mais pas exactement zéro, on peut tomber dans une
zone pathologique. Dans le doute, snapper les valeurs négligeables au zéro
exact, ou choisir un point de départ explicitement non-nul.

---

## 2026-04-23 - solver.py - Solveur analytique pioche le mauvais des 2 candidats en noiseless

**Symptôme**
Pour un impact loin du triangle (testé : `(-30000, 80000)` avec triangle de
côté 50 km centré à l'origine), `resoudre_analytique` retournait une position
à 3.67 km de l'impact réel, alors que NLLS récupérait parfaitement.

**Cause**
Avec exactement 3 stations, l'intersection des 2 hyperboles TDOA donne
**deux solutions mathématiques valides** : l'impact réel et un "fantôme
géométrique". Sans 4ème station ou information *a priori*, on ne peut pas
les distinguer mathématiquement.

Le critère initial "garder le candidat de plus petit résidu" est correct
en cas bruité (le vrai impact a généralement des résidus plus petits que
le fantôme à cause de l'asymétrie introduite par le bruit). Mais en
**noiseless**, les deux candidats ont des résidus exactement nuls
(à la précision flottante près). Test reproductible avec impact
`(-30000, 80000)` :

```
r0+ = 62855 → P = (-31051, 83518), résidus = [0, 1.45e-11], coût = 2.1e-22
r0- = 59283 → P = (-30000, 80000), résidus = [-7e-12, +7e-12], coût = 1.06e-22
```

Avec une comparaison stricte `<` et `meilleur_cout = inf` initial, le
premier itéré est gardé. Comme `_racines_quadratique` retourne dans
l'ordre `[(-B+sqrt)/(2A), (-B-sqrt)/(2A)]`, c'est `r0+` qui passe en
premier - et c'est le mauvais.

**Fix**
Critère de départage secondaire : **distance du candidat au barycentre
des stations**. Tri lexicographique sur `(coût, distance_barycentre)`.

Justification de l'heuristique : le candidat le plus proche du barycentre
correspond au minimum local que NLLS atteindrait depuis son point de
départ (le barycentre justement). Donc les deux solveurs reportent la
même solution, ce qui est cohérent et reproductible. C'est aussi
l'heuristique standard en TDOA quand on n'a pas d'info supplémentaire.

**Limitation persistante** : si l'impact réel est plus loin du barycentre
que son fantôme, on prendra le fantôme. Avec 3 stations, c'est inhérent
au problème. La seule vraie solution serait une 4ème station ou un
*prior* géographique.

**Leçon générale**
Quand un solveur a plusieurs solutions mathématiquement valides, prévoir
explicitement un critère de désambiguïsation déterministe. Tester
spécifiquement avec un cas qui révèle l'ambiguïté (impact loin du
domaine "intuitif") - sinon le bug se cache jusqu'à ce qu'un benchmark
bizarre tombe dessus.

---

## 2026-04-23 - ui/pyodide_bridge.js - `JsProxy object is not subscriptable` au passage JS→Python

**Symptôme**
Premier appel à `simulerEtResoudre()` depuis l'UI lève
`TypeError: 'pyodide.ffi.JsProxy' object is not subscriptable` à
l'accès `s["id"]` sur un élément d'une liste de stations passée depuis JS.

**Cause**
`pyodide.globals.set("_stations", arrayDObjetsJS)` puis `_stations.to_py()`
côté Python convertit le top-level Array en `list` Python, mais les
Objects internes restent des `pyodide.ffi.JsProxy` qui ne sont **pas
subscriptables** comme un dict. Le `dict_converter` par défaut ne descend
pas récursivement.

**Fix**
Sérialiser systématiquement en JSON côté JS, parser via `json.loads`
côté Python :

```js
this.pyodide.globals.set("_stations_json", JSON.stringify(stations_js));
```
```python
import json
_stations_data = json.loads(_stations_json)
# _stations_data est maintenant une vraie list[dict] Python
```

Plus verbeux mais sémantique déterministe et explicite. Retour Python →
JS reste géré par `result.toJs({ dict_converter: Object.fromEntries })`
qui marche bien dans ce sens.

**Leçon générale**
Pour les frontières Pyodide ↔ JS avec des structures imbriquées,
**préférer JSON** plutôt que les conversions implicites `to_py()`/`toJs()`.
Évite toutes les surprises sur la profondeur de conversion et rend le
contrat explicite (les deux côtés savent exactement quel format ils
manipulent).

---

# Décisions techniques

## 2026-04-23 - solver.py - Résidus exprimés en mètres dans `ResultatSolveur`

**Choix**
`ResultatSolveur.residus` contient les résidus en **mètres** (différences
de portées), pas en secondes (différences de TDOA).

**Alternatives considérées**
- En secondes (forme "naturelle" du résidu TDOA).
- En microsecondes (compromis lisibilité).

**Justification**
1. Cohérence avec le calcul interne de `least_squares` qui doit travailler
   en mètres pour des raisons de conditionnement numérique (voir Bug #1).
2. Plus interprétables physiquement : un résidu de 100 m se relie
   immédiatement à une erreur de positionnement, alors qu'un résidu de
   333 ns demande une multiplication mentale par c.
3. Comparable directement entre les deux solveurs (NLLS et analytique
   utilisent la même unité).

---

## 2026-04-23 - geometry.py - Détection de colinéarité par SVD

**Choix**
`verifier_non_colineaires` utilise la décomposition SVD des coordonnées
centrées. Le ratio `σ_min / σ_max` mesure la "minceur" du nuage de
stations. Si ratio < `tol` → colinéaire.

**Alternatives considérées**
- Produit vectoriel `(B - A) × (C - A)` normalisé par côté max.
  Élémentaire, pas de numpy nécessaire, mais ne gère que 3 points.
- Test de variance perpendiculaire à la droite de régression.

**Justification**
1. Marche pour N ≥ 3 stations (généralisation gratuite, évite de
   réécrire si extension future à plus de 3 récepteurs).
2. Scale-invariant naturellement (le ratio est sans dimension).
3. Code plus court (1 appel `np.linalg.svd`) que la gestion de cas
   par produit vectoriel.
4. Interprétation claire de `tol` : c'est le seuil sur l'aspect ratio
   du nuage. `tol = 1e-3` rejette les configurations 1000× plus longues
   que larges.

---

## 2026-04-23 - simulator.py - `NoiseConfig` régénère les biais d'horloge à chaque appel

**Choix**
Les biais d'horloge par station sont tirés à neuf à chaque appel de
`simulate_strike`, comme les autres composantes de bruit (jitter VLF,
bruit GPS).

**Alternatives considérées**
- Biais fixés une fois pour toutes par station, stockés à part, réutilisés
  entre appels successifs (plus réaliste pour une vraie campagne hardware).

**Justification**
DECISIONS.md spécifie un offset "constant par station" mais cela vaut
pour un événement d'observation donné, pas nécessairement entre essais
Monte Carlo indépendants. Pour les benchmarks (Monte Carlo de 1000+
essais), on veut moyenner aussi sur l'aléa du biais - sinon on évalue
juste la précision pour UN tirage particulier de biais, ce qui n'est
pas représentatif.

L'API reste extensible : pour des biais fixes (simulation d'une vraie
campagne avec stations identifiées), on ajouterait un paramètre
optionnel `biais_fixes: dict[str, float] | None = None` à `simulate_strike`.

---

## 2026-04-23 - simulator.py + metrics.py - API user-facing : `erreur_max_km` au lieu de seuil GDOP

**Choix**
Le garde-fou actif de `simulate_strike` est paramétré par un budget
d'erreur de position acceptable (`erreur_max_km`, défaut 1 km), et non
plus par un seuil GDOP brut. Le seuil GDOP est dérivé dynamiquement en
combinant le budget et le niveau de bruit total `σ_τ_total` extrait de
`NoiseConfig`. Une fonction `distance_max_validite_par_erreur` est
ajoutée pour calculer le rayon utile dans cette nouvelle convention.

**Alternatives considérées**
- Garder le seuil GDOP nu (`verifier_validite=True/False`, GDOP=20 fixe).
  Plus pur mathématiquement mais pas intuitif pour l'utilisateur.
- Combiner les deux : garde-fou GDOP=20 (sécurité absolue) + paramètre
  `erreur_max_km` complémentaire. Trop d'options à maintenir.
- Retirer complètement le garde-fou. Risque de produire des données
  silencieusement absurdes en champ lointain.

**Justification**
L'utilisateur (lecteur de code, futur appelant) doit comprendre l'API
en lisant les paramètres. `erreur_max_km` est immédiatement parlant ;
un seuil GDOP demande de connaître la théorie sous-jacente.

Mathématiquement les deux conventions sont équivalentes via la formule
`erreur ≈ σ_τ_total · c · GDOP`. La nouvelle API expose la vraie quantité
métier (l'erreur attendue en mètres), le calcul GDOP devient une étape
intermédiaire interne. Le défaut `erreur_max_km=1.0` correspond
approximativement à GDOP=20 pour le bruit nominal du projet (σ_τ ≈ 150 ns,
c ≈ 3·10⁸ m/s → GDOP_max ≈ 22), donc la rétro-compatibilité est assurée.

---

## 2026-04-23 - solver.py - Désambiguïsation analytique par distance au barycentre

**Choix**
Quand `resoudre_analytique` produit deux candidats valides, le choix se fait
par tri lexicographique sur `(coût, distance_au_barycentre)`. En cas
d'égalité de coût (cas noiseless), le candidat le plus proche du
barycentre des stations est retenu.

**Alternatives considérées**
- "Plus petit r₀" (distance à la station de référence) : arbitraire,
  pas de justification physique.
- "Plus grande hauteur" (au-dessus du plan des stations) : on est en 2D,
  hors sujet.
- Aucun critère, retour des 2 candidats : casse l'API uniforme avec NLLS.

**Justification**
1. Le candidat le plus proche du barycentre est aussi le minimum local
   atteint par NLLS depuis le barycentre comme point de départ. Donc les
   deux solveurs sont cohérents par construction.
2. Heuristique standard en TDOA quand on n'a pas d'information *a priori*
   sur la zone d'origine de l'impact.
3. Reproductible (déterministe).

Limitation acceptée : si le vrai impact est plus loin du barycentre
que son fantôme, on prend le fantôme. Inhérent à la triangulation
3 stations.
