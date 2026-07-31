r"""Interface dokumentasi: preview kamera, setir gimbal, foto/klip/timelapse.

    python tools/dokumentasi_ui.py

Kenapa ada: waktu tangan lagi pegang obeng dan lengan robot setengah terbongkar,
mengetik `capture_docs.py snap -l "..."` di terminal itu friksi - ujungnya
dokumentasi tidak keburu diambil. Jendela ini menaruh semuanya di satu tempat:
lihat framing dulu, arahkan gimbal, ketik label, tekan Foto.

Semua logika kamera/berkas dipinjam dari capture_docs.py - file ini murni
lapisan tampilan, supaya CLI dan GUI tidak pernah beda perilaku (nama berkas,
stempel waktu, dan baris log dihasilkan fungsi yang sama).

Arsitekturnya: satu thread kamera membaca frame terus-menerus ke dalam kotak
`_frame_terakhir`, Tk cuma menggambar ulang tiap ~33 ms dari kotak itu. Kalau
cap.read() dipanggil langsung di callback Tk, UI-nya membeku tiap kali gimbal
bergerak atau timelapse menunggu.
"""

from __future__ import annotations

import queue
import threading
import time
import tkinter as tk
from tkinter import messagebox, simpledialog, ttk

import cv2
from PIL import Image, ImageTk

import capture_docs as cd

LEBAR_PREVIEW = 860


class Aplikasi:
    def __init__(self, root: tk.Tk, index: int = 0) -> None:
        self.root = root
        self.index = index
        root.title("Dokumentasi Lengan Robot - OBSBOT")
        root.minsize(1120, 700)

        self.pan = tk.DoubleVar(value=0.0)
        self.tilt = tk.DoubleVar(value=0.0)
        self.zoom = tk.DoubleVar(value=0.0)
        self.langkah = tk.IntVar(value=5)
        self.label = tk.StringVar()
        self.stempel = tk.BooleanVar(value=True)
        self.status = tk.StringVar(value="Menghubungkan ke kamera...")

        # dipegang bersama thread kamera
        self._frame_terakhir = None
        self._kunci = threading.Lock()
        self._jalan = True
        self._sibuk = False  # True selama klip/timelapse: kunci tombol lain
        self.antrian: queue.Queue = queue.Queue()  # worker -> main thread

        self._bangun_tampilan()

        self.cap, self.res = cd.buka(index, cd.VIDEO)
        self.thread = threading.Thread(target=self._loop_kamera, daemon=True)
        self.thread.start()

        root.protocol("WM_DELETE_WINDOW", self.tutup)
        self._gambar_ulang()
        self.set_status(f"Siap - {self.res[0]}x{self.res[1]}, foto disimpan 4K ke {cd.MEDIA}")

    # --- tampilan -----------------------------------------------------------

    def _bangun_tampilan(self) -> None:
        utama = ttk.Frame(self.root, padding=10)
        utama.pack(fill="both", expand=True)

        self.kanvas = tk.Label(utama, background="#111", anchor="center")
        self.kanvas.grid(row=0, column=0, sticky="nsew", padx=(0, 10))

        sisi = ttk.Frame(utama)
        sisi.grid(row=0, column=1, sticky="ns")
        utama.columnconfigure(0, weight=1)
        utama.rowconfigure(0, weight=1)

        # -- arah kamera
        kotak = ttk.LabelFrame(sisi, text="Arah kamera", padding=8)
        kotak.pack(fill="x", pady=(0, 10))

        pad = ttk.Frame(kotak)
        pad.pack()
        ttk.Button(pad, text="▲", width=4, command=lambda: self.geser(tilt=+1)).grid(row=0, column=1, pady=2)
        ttk.Button(pad, text="◀", width=4, command=lambda: self.geser(pan=-1)).grid(row=1, column=0, padx=2)
        ttk.Button(pad, text="●", width=4, command=self.tengah).grid(row=1, column=1)
        ttk.Button(pad, text="▶", width=4, command=lambda: self.geser(pan=+1)).grid(row=1, column=2, padx=2)
        ttk.Button(pad, text="▼", width=4, command=lambda: self.geser(tilt=-1)).grid(row=2, column=1, pady=2)

        baris = ttk.Frame(kotak)
        baris.pack(fill="x", pady=(8, 0))
        ttk.Label(baris, text="Langkah").pack(side="left")
        ttk.Spinbox(baris, from_=1, to=30, width=5, textvariable=self.langkah).pack(side="left", padx=6)
        ttk.Label(baris, text="derajat").pack(side="left")

        self.lbl_posisi = ttk.Label(kotak, text="", font=("Consolas", 10))
        self.lbl_posisi.pack(anchor="w", pady=(8, 0))

        ttk.Label(kotak, text="Zoom").pack(anchor="w", pady=(8, 0))
        ttk.Scale(kotak, from_=cd.ZOOM[0], to=cd.ZOOM[1], variable=self.zoom,
                  command=lambda _e: self.terapkan()).pack(fill="x")

        # -- preset
        kotak = ttk.LabelFrame(sisi, text="Preset arah", padding=8)
        kotak.pack(fill="x", pady=(0, 10))
        self.pilih_preset = ttk.Combobox(kotak, state="readonly", width=22)
        self.pilih_preset.pack(fill="x")
        baris = ttk.Frame(kotak)
        baris.pack(fill="x", pady=(6, 0))
        ttk.Button(baris, text="Pakai", command=self.muat_preset).pack(side="left")
        ttk.Button(baris, text="Simpan...", command=self.simpan_preset).pack(side="left", padx=4)
        ttk.Button(baris, text="Hapus", command=self.hapus_preset).pack(side="left")
        self.segarkan_preset()

        # -- capture
        kotak = ttk.LabelFrame(sisi, text="Ambil dokumentasi", padding=8)
        kotak.pack(fill="x", pady=(0, 10))
        ttk.Label(kotak, text="Label (jadi nama berkas + baris log)").pack(anchor="w")
        ttk.Entry(kotak, textvariable=self.label).pack(fill="x", pady=(2, 6))
        ttk.Checkbutton(kotak, text="Cap waktu di gambar", variable=self.stempel).pack(anchor="w")

        self.tombol_foto = ttk.Button(kotak, text="Foto 4K", command=self.foto)
        self.tombol_foto.pack(fill="x", pady=(8, 4))

        baris = ttk.Frame(kotak)
        baris.pack(fill="x")
        ttk.Label(baris, text="Klip").pack(side="left")
        self.durasi = tk.IntVar(value=20)
        ttk.Spinbox(baris, from_=5, to=600, width=6, textvariable=self.durasi).pack(side="left", padx=4)
        ttk.Label(baris, text="detik").pack(side="left")
        self.tombol_klip = ttk.Button(baris, text="Rekam", command=self.klip)
        self.tombol_klip.pack(side="right")

        baris = ttk.Frame(kotak)
        baris.pack(fill="x", pady=(6, 0))
        ttk.Label(baris, text="Lapse tiap").pack(side="left")
        self.interval = tk.IntVar(value=10)
        ttk.Spinbox(baris, from_=1, to=600, width=5, textvariable=self.interval).pack(side="left", padx=4)
        ttk.Label(baris, text="s,").pack(side="left")
        self.menit = tk.IntVar(value=30)
        ttk.Spinbox(baris, from_=1, to=480, width=5, textvariable=self.menit).pack(side="left", padx=4)
        ttk.Label(baris, text="menit").pack(side="left")
        self.tombol_lapse = ttk.Button(kotak, text="Mulai timelapse", command=self.lapse)
        self.tombol_lapse.pack(fill="x", pady=(6, 0))
        self.tombol_stop = ttk.Button(kotak, text="Stop", command=self.stop, state="disabled")
        self.tombol_stop.pack(fill="x", pady=(4, 0))

        # -- log
        kotak = ttk.LabelFrame(sisi, text="Sesi ini", padding=8)
        kotak.pack(fill="both", expand=True)
        self.daftar = tk.Listbox(kotak, height=7, font=("Consolas", 8))
        self.daftar.pack(fill="both", expand=True)

        ttk.Label(self.root, textvariable=self.status, relief="sunken",
                  anchor="w", padding=4).pack(fill="x", side="bottom")

        self.root.bind("<Left>", lambda e: self.geser(pan=-1))
        self.root.bind("<Right>", lambda e: self.geser(pan=+1))
        self.root.bind("<Up>", lambda e: self.geser(tilt=+1))
        self.root.bind("<Down>", lambda e: self.geser(tilt=-1))

    def set_status(self, teks: str) -> None:
        self.status.set(teks)

    def _kunci_tombol(self, sibuk: bool) -> None:
        self._sibuk = sibuk
        keadaan = "disabled" if sibuk else "normal"
        for t in (self.tombol_foto, self.tombol_klip, self.tombol_lapse):
            t.configure(state=keadaan)
        self.tombol_stop.configure(state="normal" if sibuk else "disabled")

    # --- kamera -------------------------------------------------------------

    def _loop_kamera(self) -> None:
        """Baca frame terus-menerus di thread sendiri; UI tinggal ambil yang terakhir."""
        while self._jalan:
            ok, frame = self.cap.read()
            if not ok:
                time.sleep(0.05)
                continue
            with self._kunci:
                self._frame_terakhir = frame

    def frame_sekarang(self):
        with self._kunci:
            return None if self._frame_terakhir is None else self._frame_terakhir.copy()

    def _gambar_ulang(self) -> None:
        frame = self.frame_sekarang()
        if frame is not None:
            tinggi = int(frame.shape[0] * LEBAR_PREVIEW / frame.shape[1])
            kecil = cv2.resize(frame, (LEBAR_PREVIEW, tinggi), interpolation=cv2.INTER_AREA)
            gambar = ImageTk.PhotoImage(Image.fromarray(cv2.cvtColor(kecil, cv2.COLOR_BGR2RGB)))
            self.kanvas.configure(image=gambar)
            self.kanvas.image = gambar  # tahan referensi, kalau tidak digaruk GC
        self.lbl_posisi.configure(
            text=f"pan {self.pan.get():+6.0f}°   tilt {self.tilt.get():+6.0f}°"
                 f"   zoom {self.zoom.get():3.0f}")
        self._proses_antrian()
        self.root.after(33, self._gambar_ulang)

    # --- gimbal -------------------------------------------------------------

    def terapkan(self) -> None:
        cd.arahkan(self.cap, self.pan.get(), self.tilt.get(), self.zoom.get(), tunggu=0)

    def geser(self, pan: int = 0, tilt: int = 0) -> None:
        langkah = self.langkah.get()
        self.pan.set(cd.jepit(self.pan.get() + pan * langkah, cd.PAN))
        self.tilt.set(cd.jepit(self.tilt.get() + tilt * langkah, cd.TILT))
        self.terapkan()

    def tengah(self) -> None:
        self.pan.set(0.0)
        self.tilt.set(0.0)
        self.zoom.set(0.0)
        self.terapkan()

    # --- preset -------------------------------------------------------------

    def segarkan_preset(self) -> None:
        nama = sorted(cd.baca_preset())
        self.pilih_preset["values"] = nama
        if nama and not self.pilih_preset.get():
            self.pilih_preset.set(nama[0])

    def muat_preset(self) -> None:
        nama = self.pilih_preset.get()
        if not nama:
            return
        v = cd.baca_preset().get(nama, {})
        self.pan.set(v.get("pan", 0.0))
        self.tilt.set(v.get("tilt", 0.0))
        self.zoom.set(v.get("zoom", 0.0))
        self.terapkan()
        self.set_status(f"Preset '{nama}' dipakai.")

    def simpan_preset(self) -> None:
        nama = simpledialog.askstring("Simpan preset", "Nama arah ini:", parent=self.root)
        if not nama:
            return
        data = cd.baca_preset()
        data[nama.strip()] = {"pan": round(self.pan.get(), 1),
                              "tilt": round(self.tilt.get(), 1),
                              "zoom": round(self.zoom.get(), 1)}
        cd.tulis_preset(data)
        self.segarkan_preset()
        self.pilih_preset.set(nama.strip())
        self.set_status(f"Preset '{nama.strip()}' disimpan ke {cd.PRESET.name}.")

    def hapus_preset(self) -> None:
        nama = self.pilih_preset.get()
        if not nama:
            return
        data = cd.baca_preset()
        if data.pop(nama, None) is not None:
            cd.tulis_preset(data)
            self.pilih_preset.set("")
            self.segarkan_preset()
            self.set_status(f"Preset '{nama}' dihapus.")

    # --- capture ------------------------------------------------------------
    #
    # Aturan main threading di bawah ini: worker TIDAK BOLEH menyentuh Tk sama
    # sekali - baik .get() variabel maupun .after(). Tkinter tidak thread-safe;
    # membaca self.label.get() dari thread perekam melempar "main thread is not
    # in main loop" (kejadian waktu diuji, dan bikin klip gagal tanpa jejak).
    # Jadi: nilai UI di-snapshot di main thread sebelum thread dijalankan, dan
    # hasilnya dikirim balik lewat antrian yang dipompa _proses_antrian().

    def _proses_antrian(self) -> None:
        """Dipanggil dari tick gambar - satu-satunya tempat pesan worker jadi UI."""
        while True:
            try:
                jenis, muatan = self.antrian.get_nowait()
            except queue.Empty:
                return
            if jenis == "status":
                self.set_status(muatan)
            elif jenis == "catat":
                berkas, keterangan, label = muatan
                cd.catat(berkas, label, keterangan)
                self.daftar.insert(0, f"{time.strftime('%H:%M')}  {berkas.name}")
            elif jenis == "selesai":
                self._kunci_tombol(False)

    def _snapshot(self) -> dict:
        """Ambil semua nilai UI sekali, di main thread, buat dipakai worker."""
        return {"label": self.label.get(), "stempel": self.stempel.get()}

    def foto(self) -> None:
        """Foto 4K: naikkan resolusi sebentar, ambil, lalu balik ke resolusi preview."""
        self._kunci_tombol(True)
        self.set_status("Mengambil foto 4K...")
        ui_val = self._snapshot()

        def kerja():
            try:
                self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, cd.FOTO[0])
                self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, cd.FOTO[1])
                # tunggu sampai thread kamera benar-benar mengeluarkan frame 4K,
                # bukan sekadar tidur menebak-nebak lamanya ganti mode
                batas = time.monotonic() + 5.0
                frame = None
                while time.monotonic() < batas:
                    kandidat = self.frame_sekarang()
                    if kandidat is not None and kandidat.shape[1] >= cd.FOTO[0]:
                        frame = kandidat
                        break
                    time.sleep(0.05)
                if frame is None:
                    frame = self.frame_sekarang()
                    if frame is None:
                        raise RuntimeError("tidak ada frame dari kamera")
                    self.antrian.put(("status", "Kamera tidak mau 4K, foto diambil "
                                                f"{frame.shape[1]}x{frame.shape[0]}"))
                if ui_val["stempel"]:
                    cd.stempel(frame, cd.teks_stempel(ui_val["label"]))
                tujuan = cd.folder_hari_ini() / cd.nama_berkas(ui_val["label"], "jpg")
                cv2.imwrite(str(tujuan), frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
                h, w = frame.shape[:2]
                self.antrian.put(("catat", (tujuan, f"foto {w}x{h}", ui_val["label"])))
                self.antrian.put(("status", f"Tersimpan {w}x{h}: {tujuan}"))
            except Exception as e:
                self.antrian.put(("status", f"Gagal: {e}"))
            finally:
                self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, cd.VIDEO[0])
                self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, cd.VIDEO[1])
                self.antrian.put(("selesai", None))

        threading.Thread(target=kerja, daemon=True).start()

    def klip(self) -> None:
        durasi = self.durasi.get()
        ui_val = self._snapshot()
        self._kunci_tombol(True)

        def kerja():
            tujuan = cd.folder_hari_ini() / cd.nama_berkas(ui_val["label"], "mp4")
            writer = cv2.VideoWriter(str(tujuan), cv2.VideoWriter_fourcc(*"mp4v"), 30.0, self.res)
            mulai = time.monotonic()
            n = 0
            # Tulis tepat 30 frame per detik pakai deadline absolut. Kalau hanya
            # "baca lalu sleep(1/30)", overhead bikin fps nyata ~23 sementara
            # header video tetap 30 - hasilnya durasi playback meleset. Frame
            # terakhir diulang kalau kamera belum mengeluarkan yang baru.
            for i in range(int(durasi * 30)):
                if not self._sibuk:
                    break
                tenggat = mulai + i / 30
                jeda = tenggat - time.monotonic()
                if jeda > 0:
                    time.sleep(jeda)
                frame = self.frame_sekarang()
                if frame is None or frame.shape[1] != self.res[0]:
                    continue
                if ui_val["stempel"]:
                    cd.stempel(frame, cd.teks_stempel(ui_val["label"]))
                writer.write(frame)
                n += 1
                if i % 15 == 0:
                    sisa = durasi - (time.monotonic() - mulai)
                    self.antrian.put(("status", f"Merekam... sisa {sisa:.0f} s"))
            writer.release()
            lama = time.monotonic() - mulai
            self.antrian.put(("catat", (
                tujuan, f"klip {lama:.0f} s, {self.res[1]}p, {n / max(lama, 1e-9):.0f} fps",
                ui_val["label"])))
            self.antrian.put(("status", f"Klip {lama:.0f} s ({n} frame) tersimpan: {tujuan}"))
            self.antrian.put(("selesai", None))

        threading.Thread(target=kerja, daemon=True).start()

    def lapse(self) -> None:
        interval, menit = self.interval.get(), self.menit.get()
        total = max(1, int(menit * 60 / interval))
        ui_val = self._snapshot()
        self._kunci_tombol(True)

        def kerja():
            tujuan = cd.folder_hari_ini() / cd.nama_berkas(ui_val["label"] or "timelapse", "mp4")
            writer = cv2.VideoWriter(str(tujuan), cv2.VideoWriter_fourcc(*"mp4v"), 15.0, self.res)
            n = 0
            berikutnya = time.monotonic()
            try:
                while self._sibuk and n < total:
                    if time.monotonic() < berikutnya:
                        time.sleep(0.1)
                        continue
                    frame = self.frame_sekarang()
                    if frame is None or frame.shape[1] != self.res[0]:
                        time.sleep(0.05)
                        continue
                    if ui_val["stempel"]:
                        cd.stempel(frame, cd.teks_stempel(ui_val["label"]))
                    writer.write(frame)
                    n += 1
                    berikutnya += interval
                    self.antrian.put(("status", f"Timelapse {n}/{total} frame - "
                                                "Stop untuk berhenti lebih awal"))
            finally:
                writer.release()
            self.antrian.put(("catat", (
                tujuan, f"timelapse {n} frame @ {interval} s, {self.res[1]}p", ui_val["label"])))
            self.antrian.put(("status", f"Timelapse {n} frame tersimpan: {tujuan}"))
            self.antrian.put(("selesai", None))

        threading.Thread(target=kerja, daemon=True).start()

    def stop(self) -> None:
        """Cukup lepas flag-nya: thread perekam berhenti sendiri dan menutup berkas."""
        self._sibuk = False
        self.set_status("Dihentikan - berkas tetap tersimpan.")

    # --- tutup --------------------------------------------------------------

    def tutup(self) -> None:
        if self._sibuk and not messagebox.askokcancel(
                "Masih merekam", "Perekaman sedang jalan. Tutup saja?"):
            return
        self._jalan = False
        self._sibuk = False
        time.sleep(0.15)
        self.cap.release()
        self.root.destroy()


def main() -> None:
    root = tk.Tk()
    try:
        ttk.Style().theme_use("vista")
    except tk.TclError:
        pass
    Aplikasi(root)
    root.mainloop()


if __name__ == "__main__":
    main()
