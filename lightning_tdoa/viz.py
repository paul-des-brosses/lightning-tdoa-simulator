"""Visualisation matplotlib + export Folium pour le simulateur TDOA.

Toutes les fonctions consomment des données déjà calculées (positions,
grilles d'erreur, courbes). Aucune logique métier ici : les calculs
appartiennent à `metrics.py`, `simulator.py`, `solver.py`.

Conventions :
- Les fonctions matplotlib retournent la `Figure` créée. L'appelant gère
  l'affichage ou la sauvegarde via `fig.savefig(...)`.
- `export_folium` retourne le `Path` du fichier HTML écrit.
- Aucun appel à `plt.show()` n'est caché dans ces fonctions.
"""

import math
from pathlib import Path

import folium
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import LogNorm
from matplotlib.figure import Figure

from .geometry import Station


def plot_scenario(
    stations: list[Station],
    impact: tuple[float, float],
    estimee: tuple[float, float] | None = None,
    ax=None,
    titre: str = "",
) -> Figure:
    """Vue statique d'un tir : stations, impact réel, estimation, vecteur d'erreur.

    Parameters
    ----------
    stations : list of Station
        Stations à afficher (triangles bleus).
    impact : tuple of float
        Position vraie de l'impact (étoile dorée).
    estimee : tuple of float or None, optional
        Position estimée par un solveur (croix rouge). Si fournie, une ligne
        pointillée relie l'impact réel à l'estimation.
    ax : matplotlib.axes.Axes or None, optional
        Axes existants où dessiner. Si None, une figure est créée.
    titre : str, optional
        Titre du graphique.

    Returns
    -------
    matplotlib.figure.Figure
    """
    if ax is None:
        fig, ax = plt.subplots(figsize=(8, 8))
    else:
        fig = ax.figure

    xs_stations = [s.x for s in stations]
    ys_stations = [s.y for s in stations]
    ax.scatter(
        xs_stations, ys_stations,
        s=250, marker="^", color="steelblue",
        edgecolor="black", label="Stations", zorder=3,
    )
    for s in stations:
        ax.annotate(s.id, (s.x, s.y), textcoords="offset points",
                    xytext=(12, 8), fontsize=10, fontweight="bold")

    ax.scatter(
        impact[0], impact[1],
        s=300, marker="*", color="gold",
        edgecolor="black", label="Impact réel", zorder=4,
    )

    if estimee is not None:
        ax.scatter(
            estimee[0], estimee[1],
            s=150, marker="X", color="crimson",
            edgecolor="black", label="Estimation", zorder=4,
        )
        ax.plot(
            [impact[0], estimee[0]], [impact[1], estimee[1]],
            color="crimson", linestyle="--", alpha=0.6, linewidth=1.2,
        )

    ax.set_xlabel("East (m)")
    ax.set_ylabel("North (m)")
    ax.set_aspect("equal")
    ax.grid(True, alpha=0.3)
    ax.legend(loc="best")
    if titre:
        ax.set_title(titre)

    return fig


def plot_heatmap(
    error_grid: np.ndarray,
    stations: list[Station],
    extent: tuple[float, float, float, float],
    ax=None,
    log_scale: bool = True,
    label_colorbar: str = "Erreur (m)",
    titre: str = "",
) -> Figure:
    """Heatmap 2D d'une grandeur (erreur ou GDOP) avec stations superposées.

    Parameters
    ----------
    error_grid : numpy.ndarray
        Tableau 2D de valeurs à afficher. Convention : `error_grid[i, j]`
        correspond à la cellule (x_j, y_i) (axe i = North, axe j = East),
        ce qui est l'orientation naturelle pour `imshow(..., origin="lower")`.
    stations : list of Station
        Stations à superposer (marqueurs rouges).
    extent : tuple of float
        `(xmin, xmax, ymin, ymax)` en mètres, bornes spatiales de la grille.
    ax : matplotlib.axes.Axes or None, optional
    log_scale : bool, optional
        Si True (défaut), couleurs en échelle log. Pertinent pour les erreurs
        qui couvrent plusieurs ordres de grandeur.
    label_colorbar : str, optional
        Étiquette de la colorbar. Défaut "Erreur (m)".
    titre : str, optional

    Returns
    -------
    matplotlib.figure.Figure
    """
    if ax is None:
        fig, ax = plt.subplots(figsize=(10, 8))
    else:
        fig = ax.figure

    norm = LogNorm() if log_scale else None
    im = ax.imshow(
        error_grid,
        extent=extent,
        origin="lower",
        cmap="viridis",
        norm=norm,
        aspect="equal",
        interpolation="bilinear",
    )
    fig.colorbar(im, ax=ax, label=label_colorbar)

    xs = [s.x for s in stations]
    ys = [s.y for s in stations]
    ax.scatter(
        xs, ys, s=200, marker="^",
        color="red", edgecolor="white", linewidths=1.5,
        label="Stations", zorder=3,
    )

    ax.set_xlabel("East (m)")
    ax.set_ylabel("North (m)")
    ax.legend(loc="upper right")
    if titre:
        ax.set_title(titre)

    return fig


def plot_noise_curve(
    sigmas_ns: np.ndarray,
    errors_per_solver: dict[str, np.ndarray],
    ax=None,
    titre: str = "",
) -> Figure:
    """Courbe log-log d'erreur médiane vs niveau de bruit, plusieurs solveurs.

    Parameters
    ----------
    sigmas_ns : numpy.ndarray
        Niveaux de bruit testés, en nanosecondes (axe x).
    errors_per_solver : dict of str to numpy.ndarray
        Pour chaque solveur (clé = nom à afficher), tableau d'erreurs
        médianes en mètres (même longueur que `sigmas_ns`).
    ax : matplotlib.axes.Axes or None, optional
    titre : str, optional

    Returns
    -------
    matplotlib.figure.Figure
    """
    if ax is None:
        fig, ax = plt.subplots(figsize=(10, 6))
    else:
        fig = ax.figure

    marqueurs = ["o", "s", "D", "^", "v"]
    for i, (nom, erreurs) in enumerate(errors_per_solver.items()):
        ax.loglog(
            sigmas_ns, erreurs,
            marker=marqueurs[i % len(marqueurs)],
            label=nom, linewidth=1.5, markersize=7,
        )

    ax.set_xlabel("σ_τ (ns)")
    ax.set_ylabel("Erreur médiane (m)")
    ax.grid(True, which="both", alpha=0.3)
    ax.legend(loc="upper left")
    if titre:
        ax.set_title(titre)

    return fig


def export_folium(
    stations: list[Station],
    impact: tuple[float, float],
    estimee: tuple[float, float] | None,
    chemin_sortie: str | Path,
    reference_latlon: tuple[float, float] = (48.85, 2.35),
) -> Path:
    """Carte interactive HTML (Folium) montrant stations, impact et estimation.

    Les coordonnées internes sont en plan tangent ENU (mètres). On les
    convertit en latitude/longitude par approximation petits angles autour
    d'un point de référence (défaut : Paris).

    Parameters
    ----------
    stations : list of Station
    impact : tuple of float
        Position de l'impact en ENU (mètres).
    estimee : tuple of float or None
        Estimation du solveur, en ENU (mètres). Si fournie, une ligne
        d'erreur est tracée.
    chemin_sortie : str or pathlib.Path
        Chemin du fichier HTML à écrire.
    reference_latlon : tuple of float, optional
        Latitude/longitude du point ENU = (0, 0). Défaut (Paris).

    Returns
    -------
    pathlib.Path
        Chemin du fichier HTML écrit.
    """
    lat0, lon0 = reference_latlon
    cos_lat0 = math.cos(math.radians(lat0))

    def enu_vers_latlon(x_m: float, y_m: float) -> tuple[float, float]:
        delta_lat = y_m / 111_000.0
        delta_lon = x_m / (111_000.0 * cos_lat0)
        return lat0 + delta_lat, lon0 + delta_lon

    impact_latlon = enu_vers_latlon(*impact)
    carte = folium.Map(location=list(impact_latlon), zoom_start=10,
                       tiles="OpenStreetMap")

    for s in stations:
        s_latlon = enu_vers_latlon(s.x, s.y)
        folium.Marker(
            location=list(s_latlon),
            popup=f"Station {s.id}<br>ENU: ({s.x:.0f}, {s.y:.0f}) m",
            icon=folium.Icon(color="blue", icon="signal", prefix="fa"),
        ).add_to(carte)

    folium.Marker(
        location=list(impact_latlon),
        popup=f"Impact réel<br>ENU: ({impact[0]:.0f}, {impact[1]:.0f}) m",
        icon=folium.Icon(color="orange", icon="bolt", prefix="fa"),
    ).add_to(carte)

    if estimee is not None:
        est_latlon = enu_vers_latlon(*estimee)
        folium.Marker(
            location=list(est_latlon),
            popup=f"Estimation<br>ENU: ({estimee[0]:.0f}, {estimee[1]:.0f}) m",
            icon=folium.Icon(color="red", icon="crosshairs", prefix="fa"),
        ).add_to(carte)
        folium.PolyLine(
            locations=[list(impact_latlon), list(est_latlon)],
            color="red", weight=2, dash_array="6,6",
            popup="Vecteur d'erreur",
        ).add_to(carte)

    chemin_sortie = Path(chemin_sortie)
    carte.save(str(chemin_sortie))
    return chemin_sortie
