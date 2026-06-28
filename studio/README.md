# Digital Twin Web — Cycloidal Arm Studio

Visualisasi 3D interaktif (Three.js) yang berperan sebagai **digital twin**:
mencerminkan posisi sendi lengan fisik secara real-time dan mengirim perintah
target balik ke lengan.

## Menjalankan

Buka `index.html` langsung di browser, atau sajikan lewat server statis:

```bash
python -m http.server 8000 --directory studio
# buka http://localhost:8000
```

## Menyambung ke lengan fisik / simulasi

1. Jalankan bridge: `python -m arm.bridge --simulate` (atau `--port COM5`).
2. Di studio, sambungkan ke `ws://localhost:8765`.
3. Sudut sendi dari encoder (pesan `feedback`) menggerakkan model 3D; perintah
   `goto` dari studio dikirim ke lengan.

Protokol pesan WebSocket:
- Masuk (dari bridge): `{"type":"feedback","angles":[a1..a6]}`
- Keluar (ke bridge): `{"cmd":"goto","angles":[a1..a6]}`

## Catatan

`index.html` adalah aplikasi mandiri (Three.js r128 via CDN), tanpa proses build.
Integrasi WebSocket ke bridge adalah langkah pengembangan berikutnya pada roadmap
(lihat README utama).
