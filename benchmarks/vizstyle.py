"""Gaya visual bersama untuk seluruh grafik di `benchmarks/`.

Tujuan: gambar yang dicetak di naskah skripsi harus terbaca sekali lihat,
angka kuncinya tersorot, dan tetap terbaca oleh pembaca dengan color vision
deficiency maupun saat dicetak hitam-putih.

Aturan yang dipakai (dan alasannya, supaya tidak diubah asal-asalan):

1. Warna kategorikal dipakai untuk IDENTITAS (sendi mana), bukan untuk
   besaran. Urutannya tetap: slot 1 biru, slot 2 oranye, slot 3 aqua, slot 4
   kuning. Urutan ini sudah divalidasi terhadap simulasi color vision
   deficiency pada permukaan putih (worst adjacent CVD dE 9.1, normal 22.9).
   Jangan menyisipkan warna baru di tengah urutan.
2. Warna sekuensial dipakai untuk BESARAN (heatmap torsi, kerapatan titik):
   satu hue biru terang ke gelap. Bukan viridis/magma, karena ramp pelangi
   memetakan besaran ke hue sehingga urutan besarannya tidak lagi terbaca
   sendiri dan hancur saat dicetak abu-abu.
3. Warna status (merah/kuning/hijau) HANYA untuk arti lulus/gagal, tidak
   pernah dipakai sebagai warna seri.
4. Seri yang bukan fokus dibuat abu-abu (MUTED), fokusnya diberi warna. Satu
   grafik menceritakan satu hal.
5. Tiap seri juga dibedakan bentuk marker dan gaya garis, bukan warna saja,
   supaya tetap terbaca saat dicetak hitam-putih.
6. Angka kunci ditulis langsung di gambar (direct label), tidak hanya di
   legenda, karena gambar di naskah dibaca tanpa tooltip.
"""

from __future__ import annotations

# --- Slot kategorikal (identitas). Urutan tetap, jangan dicampur. ---------
SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"]
SERIES_BLUE, SERIES_ORANGE, SERIES_AQUA, SERIES_YELLOW = SERIES

# Pembeda kedua selain warna (untuk cetak hitam-putih dan CVD).
MARKERS = ["o", "s", "^", "D"]
LINESTYLES = ["-", "--", "-.", ":"]

# --- Ink dan chrome ------------------------------------------------------
INK = "#0b0b0b"          # teks utama
INK_SECOND = "#52514e"   # teks pendukung
MUTED = "#898781"        # sumbu, label, seri yang tidak difokuskan
GRID = "#e1e0d9"         # gridline hairline
SURFACE = "#ffffff"      # kertas naskah

# --- Status (arti, bukan identitas) --------------------------------------
GOOD = "#0ca30c"
WARNING = "#fab219"
CRITICAL = "#d03b3b"

# --- Sekuensial satu hue: biru terang -> gelap (untuk besaran) ------------
SEQ_BLUE = [
    "#eaf2fd", "#cde2fb", "#9ec5f4", "#6da7ec",
    "#3987e5", "#2a78d6", "#256abf", "#184f95", "#0d366b",
]


def sequential_cmap(name: str = "seq_blue"):
    """Colormap satu hue biru terang->gelap untuk heatmap besaran."""
    from matplotlib.colors import LinearSegmentedColormap

    return LinearSegmentedColormap.from_list(name, SEQ_BLUE)


def apply_rc(plt) -> None:
    """Setel rcParams global: tipografi, gridline hairline, sumbu resesif."""
    plt.rcParams.update({
        "figure.dpi": 110,
        "savefig.dpi": 200,
        "figure.facecolor": SURFACE,
        "axes.facecolor": SURFACE,
        "savefig.facecolor": SURFACE,
        "font.family": "DejaVu Sans",
        "font.size": 9,
        "axes.titlesize": 10,
        "axes.titleweight": "bold",
        "axes.titlecolor": INK,
        "axes.labelsize": 9,
        "axes.labelcolor": INK_SECOND,
        "axes.edgecolor": MUTED,
        "axes.linewidth": 0.8,
        "axes.grid": True,
        "axes.axisbelow": True,
        "grid.color": GRID,
        "grid.linewidth": 0.7,
        "grid.linestyle": "-",       # gridline putus-putus terbaca sebagai ambang
        "xtick.color": MUTED,
        "ytick.color": MUTED,
        "xtick.labelsize": 8,
        "ytick.labelsize": 8,
        "legend.frameon": False,
        "legend.fontsize": 8,
        "legend.labelcolor": INK_SECOND,
        "lines.linewidth": 2.0,
        "lines.markersize": 5,
    })


def strip_frame(ax, keep=("left", "bottom")) -> None:
    """Buang garis tepi yang tidak membawa informasi."""
    for side, spine in ax.spines.items():
        spine.set_visible(side in keep)


def emphasise(names, focus):
    """Warna per kategori: yang difokuskan berwarna, sisanya abu-abu.

    Dipakai saat grafik menceritakan SATU kategori (mis. sendi paling
    berkontribusi). Memberi warna berbeda ke semua batang justru menyembunyikan
    ceritanya.
    """
    focus = set(focus if isinstance(focus, (list, tuple, set)) else [focus])
    return [SERIES_BLUE if n in focus else MUTED for n in names]


def annotate_value(ax, x, y, text, *, color=INK, dx=6, dy=6, weight="bold",
                   size=9, ha="left", va="bottom", box=True):
    """Tulis angka kunci langsung di gambar, dengan kotak putih tipis.

    Kotak putih (bukan garis tepi) memisahkan label dari mark di belakangnya
    tanpa menambah garis baru ke gambar.
    """
    bbox = None
    if box:
        bbox = dict(boxstyle="round,pad=0.28", facecolor=SURFACE,
                    edgecolor="none", alpha=0.88)
    return ax.annotate(
        text, xy=(x, y), xytext=(dx, dy), textcoords="offset points",
        color=color, fontsize=size, fontweight=weight, ha=ha, va=va,
        bbox=bbox, zorder=6,
    )


def callout(ax, xy, text, xytext, *, color=CRITICAL, size=9):
    """Anotasi bergaris penunjuk untuk temuan yang harus dilihat pembaca."""
    return ax.annotate(
        text, xy=xy, xytext=xytext, textcoords="offset points",
        color=color, fontsize=size, fontweight="bold",
        bbox=dict(boxstyle="round,pad=0.32", facecolor=SURFACE,
                  edgecolor=color, linewidth=1.0, alpha=0.95),
        arrowprops=dict(arrowstyle="-", color=color, linewidth=1.0,
                        shrinkA=0, shrinkB=3),
        zorder=7,
    )


def threshold_line(ax, y, label, *, color=CRITICAL, ls="--", lw=1.4,
                   x_text=0.985, va="bottom"):
    """Garis ambang horizontal + labelnya di ujung kanan.

    Ambang (target, kapasitas, batas lulus) memang boleh putus-putus: di sini
    garis putus BERARTI 'ini ambang, bukan data'.
    """
    ax.axhline(y, color=color, linestyle=ls, linewidth=lw, zorder=4)
    ax.text(x_text, y, f" {label}", transform=ax.get_yaxis_transform(),
            color=color, fontsize=8, fontweight="bold", ha="right", va=va,
            bbox=dict(boxstyle="round,pad=0.22", facecolor=SURFACE,
                      edgecolor="none", alpha=0.9), zorder=6)


def hero(ax, text, sub=None, *, loc=(0.5, 0.5), color=INK, size=26):
    """Angka pamungkas sebagai teks besar: dipakai saat ceritanya satu angka."""
    ax.text(loc[0], loc[1], text, transform=ax.transAxes, ha="center",
            va="center", fontsize=size, fontweight="bold", color=color)
    if sub:
        ax.text(loc[0], loc[1] - 0.14, sub, transform=ax.transAxes,
                ha="center", va="center", fontsize=9, color=INK_SECOND)


def figure_caption(fig, text, *, y=0.005, size=8):
    """Catatan kaki gambar: sumber data, parameter, dan batas model."""
    fig.text(0.5, y, text, ha="center", va="bottom", fontsize=size,
             color=MUTED, wrap=True)


def suptitle(fig, title, subtitle=None):
    """Judul gambar: satu kalimat temuan, bukan sekadar nama variabel."""
    fig.suptitle(title, fontsize=12, fontweight="bold", color=INK, y=0.985)
    if subtitle:
        fig.text(0.5, 0.938, subtitle, ha="center", va="top", fontsize=9,
                 color=INK_SECOND)
