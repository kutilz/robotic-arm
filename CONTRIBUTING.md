# Berkontribusi

Terima kasih atas minatnya! Proyek ini adalah skripsi open source — kontribusi,
issue, dan saran dipersilakan.

## Cara berkontribusi

1. Fork & buat branch fitur: `git checkout -b fitur/nama-fitur`
2. Pasang dependensi dev: `pip install -e ".[dev]"`
3. Pastikan uji lulus sebelum commit: `pytest -q`
4. Jaga gaya kode konsisten dengan modul yang ada (komentar Bahasa Indonesia,
   docstring menjelaskan *mengapa*, bukan sekadar *apa*).
5. Buka Pull Request dengan deskripsi jelas.

## Lingkup

- **Kode Python** (`src/arm/`, `benchmarks/`) — kontrol, analisis, sizing.
- **Firmware** (`firmware/`) — Arduino; cantumkan motor/driver yang diuji.
- **Digital twin** (`studio/`) — web Three.js.
- **Dokumen** (`docs/`, `thesis/`) — perbaikan, sumber tambahan dengan sitasi.

## Mengubah parameter fisik

Semua parameter (panjang link, massa, motor) ada di `src/arm/config.py`. Setelah
mengubahnya, jalankan `pytest` — sebagian uji mengunci nilai ke dokumen riset,
jadi sesuaikan acuannya bila perubahan memang disengaja.
