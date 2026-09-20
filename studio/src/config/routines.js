/* ============================================================================
   RUTIN GERAK untuk HARDWARE (bukan demo animasi).

   Bedanya dengan DEMO_POSES di arm.js: yang di sini dijalankan di lengan nyata
   lewat features/runner.js, satu langkah per klik, dengan konfirmasi manusia di
   tiap langkah. Karena itu formatnya bukan sekadar daftar sudut:

     { a: [J1..J6] }       langkah gerak sendi   -> {"cmd":"goto"}
     { grip: 'open'|'close' } langkah gripper    -> {"cmd":"servo_us"}
     label                 nama langkah di UI
     note                  yang harus DILIHAT operator saat langkah ini jalan
     warn                  peringatan yang wajib dibaca sebelum kirim

   Gripper BUKAN sendi (tidak ada di angles[]), jadi ia dapat langkahnya sendiri
   dan tidak pernah nebeng di pose. Sesuai README studio, sebelum pemetaan sudut
   dikalibrasi yang dipakai adalah PULSA MENTAH (us), bukan derajat.

   ---------------------------------------------------------------------------
   ARAH DEPAN: J2 DAN J3 POSITIF. Dibetulkan 13 Agu 2026.

   Sampai 12 Agu 2026 seluruh file ini memakai J2/J3 NEGATIF untuk pose kerja,
   dengan alasan "tanda dibalik supaya cocok dengan twin". Itu salah arah, dan
   akibatnya bisa dihitung, bukan didebatkan: pose "atas titik ambil" yang lama
   [0,-21,-60,0,-34,0] menaruh TCP di (z +442, y +501), yaitu setengah meter di
   atas meja DI BELAKANG lengan. Seluruh rutin lama menjulur ke arah yang
   berlawanan dengan meja.

   Yang membuktikannya di lengan nyata: operator membetulkan sendiri keyframe
   "dekat titik ambil" sampai gripper benar benar berada di atas benda, dan
   angka yang keluar [0, 8,5, 139, 0, 15,5, 0] semuanya POSITIF. Pose itu
   dipakai apa adanya di bawah sebagai jangkar; sisa rutin disusun mengelilingi
   dia, bukan sebaliknya.

   Konvensi yang berlaku sekarang (semua sudah cocok satu sama lain: lengan,
   twin, dan verify_cad_rig.mjs):
     J2/J3 positif  -> lengan mengayun ke DEPAN, ke arah -Z studio, ke meja
     J5 positif     -> ujung gripper mengangkat (nose up)
     J1 0..-90      -> satu satunya sektor yang boleh dipakai, lihat di bawah

   ---------------------------------------------------------------------------
   BIDANG KERJA DI MEJA INI (13 Agu 2026)

   Lengan cuma punya 90 derajat sektor kerja: J1 dari 0 (lurus ke depan, ke
   kertas milimeter) sampai -90 (ke kanan, ke bidang meja yang kosong). J1
   POSITIF tidak boleh dipakai sama sekali. Titik taruh karena itu ada di
   J1 -90, bukan +90 seperti rutin lama.

   Batas ini BUKAN batas mekanis (JDEF J1 tetap +-180 dan firmware juga), jadi
   dia tidak dijaga oleh limit sendi mana pun. Yang menjaganya cuma pemeriksaan
   di verify_cad_rig.mjs; jangan menambah pose dengan J1 > 0 tanpa mengubah
   pemeriksaan itu lebih dulu.

   ---------------------------------------------------------------------------
   SERVO SAMPAI DULUAN. Ini yang bikin lengan menabrak sebelum bergerak.

   J5 dan J6 servo MG996R: firmware menulis pulsa target ke servo tiap putaran
   loop (servoWriteUs di arm_controller_esp32.ino), jadi begitu satu goto masuk,
   servo langsung berangkat penuh (~0,2 detik per 60 derajat). Stepper J1..J4
   jalan pada profil kecepatan: 8 dps di TEACH, 25 dps di RUN, yaitu 20 sampai
   60 kali lebih lambat. Satu keyframe yang menurunkan lengan SAMBIL menekuk
   pergelangan ke bawah karena itu tidak dieksekusi sebagai satu gerakan: yang
   terjadi adalah pergelangan menekuk penuh lebih dulu, di posisi lama, lalu
   lengan menyusul. Kalau posisi lama sudah dekat meja, gripper menghantam meja
   sebelum lengan sempat bergerak.

   Tiga aturan yang membentuk urutan langkah di bawah, dan yang diperiksa
   `node studio/tools/verify_cad_rig.mjs` untuk tiap perpindahan langkah:

     1 J5 hanya boleh berubah banyak saat lengan masih TINGGI. Di dekat meja,
       J5 dibiarkan tetap dan yang bekerja cuma J2/J3.
     2 Kalau J5 memang harus berubah di dekat meja, arahnya harus MENGANGKAT
       ujung (nose up), tidak pernah menekuk ke bawah.
     3 Perpindahan yang membawa lengan turun dikerjakan dengan J5 yang sudah
       bernilai sama dengan tujuannya, sehingga servo tidak bergerak sama
       sekali selama turun.

   Pemeriksaannya bukan aturan di kepala: verify_cad_rig.mjs menyusun ulang
   jalur tiap perpindahan dengan model "servo sudah di target sejak detik nol,
   tiap stepper jalan sendiri sendiri", lalu mencari titik terendah seluruh
   rakitan sepanjang jalur itu.

   ---------------------------------------------------------------------------
   KENAPA PERGELANGAN TIDAK BISA BENAR BENAR SEJAJAR MEJA

   Permintaannya "luruskan J5 supaya sejajar bidang meja". Batasnya bukan
   servo, melainkan geometri gripper sendiri, dan berlakunya PADA TINGGI UJUNG
   JAW YANG TETAP: kalau sumbu tool dibuat lebih mendatar dari sekitar -37
   derajat sementara ujung jaw ditahan di 15 mm, servo MG90S gripper (yang
   menggantung di sisi bawah rakitan jaw) turun melewati ujung jaw dan DIA yang
   menyentuh meja lebih dulu. Pada tool -38 derajat sisa terendah 7 mm; pada
   tool 0 derajat servo J6 sudah 26 mm DI BAWAH permukaan meja. Angka ini dari
   bbox part CAD, bukan taksiran.

   Yang dilakukan operator 13 Agu 2026 justru bukan itu. J5 dinaikkan ke 43
   derajat TANPA menurunkan J2/J3, jadi pusat pergelangan tetap di tempat dan
   yang terjadi adalah ujung jaw ikut TERANGKAT: tool -19 derajat dengan ujung
   jaw 68 mm di atas meja dan sisa part terendah 42 mm. Itu sebabnya pose ambil
   sekarang jauh lebih longgar terhadap meja daripada versi hitungan yang
   dulu, bukan lebih mepet.

   Kalau benda perlu dijepit dengan gripper benar benar mendatar DAN duduk
   langsung di meja, satu satunya jalan tetap menaikkan bendanya: pada tool -20
   derajat, ujung jaw baru aman di ketinggian 40 mm, jadi benda harus duduk di
   atas balok setinggi ~4 cm.

   ---------------------------------------------------------------------------
   PERGELANGAN DIBONGKAR PASANG SESUDAH POSE INI DIAJARKAN (13 Agu 2026)

   Pose ambil dan taruh di bawah diajarkan ke lengan SEBELUM pergelangannya
   dibetulkan (J4 terpasang/ter-home setengah putaran dari semestinya). Jadi
   sebelum rutin ini dijalankan penuh lagi, tiap langkah wajib dilewati satu per
   satu di profil TEACH dan ditandai ulang. Tanda verifikasi lama memang sudah
   dibuang sekalian (kunci localStorage runner naik ke v5), jadi tombol JALAN
   PENUH terkunci sampai semuanya dilihat ulang oleh mata.

   Kemungkinan besar angkanya masih berlaku, dan itu bisa dihitung: pose teach
   di bawah hanya masuk akal pada pergelangan yang orientasinya sesuai CAD.
   Kalau pergelangan fisik saat mengajar benar benar ter-roll 180, pose yang
   sama menaruh ujung jaw 32 sampai 57 mm DI BAWAH permukaan meja, yaitu
   tabrakan yang tidak mungkin luput. Tapi "kemungkinan besar" bukan alasan
   untuk mengirim keyframe ke lengan yang baru dibongkar; yang memutuskan tetap
   satu langkah TEACH pertama yang dilihat sendiri.

   ---------------------------------------------------------------------------
   TWIN DAN LENGAN BELUM TENTU SEPAKAT SOAL J5

   Pose ambil dan taruh di bawah adalah angka yang BENAR BENAR DIKIRIM ke lengan
   saat operator mengajarkannya, jadi itu yang dipakai apa adanya. Tapi J5
   adalah servo tanpa umpan balik terkalibrasi (pot internal masih placeholder),
   jadi tidak ada satu pun pengukuran yang membuktikan bahwa J5 = 43 di layar
   sama dengan 43 derajat di pergelangan.

   Bedanya bisa dilihat dari satu angka: menurut CAD, pose ambil hasil teach
   menaruh ujung jaw 68 mm di atas meja. Kalau di meja sungguhan rahang itu
   menjepit benda yang duduk langsung di permukaan, berarti trim J5 twin
   meleset belasan derajat, dan yang perlu dibetulkan adalah TWIN_CAL J5 di
   cadRig.js, bukan rutin ini. Cara membuktikannya cuma satu dan murah: jalankan
   langkah "maju + luruskan pergelangan", lalu ukur tinggi ujung jaw dengan
   mistar.

   ---------------------------------------------------------------------------
   KEADAAN LENGAN yang membentuk isi file ini:
   - Encoder AS5600 cuma di J1 dan J2. J3, J4 open-loop: posisinya dilaporkan
     dari step counter, jadi step yang hilang TIDAK akan ketahuan dari feedback.
     Itulah alasan rutin `repeat` ada: satu-satunya cara membuktikannya adalah
     kembali ke titik yang sama berulang kali lalu diukur dari luar.
   - J6 MENTOK di pose home dan belum bisa dibetulkan tanpa membongkar. Semua
     rutin karena itu menahan J6 di 0; hanya showcase yang mencobanya, kecil
     (+-30) dan sebagai langkah terakhir supaya bisa dilewati.

   Semua pose statik di file ini diperiksa `node studio/tools/verify_cad_rig.mjs`
   (TCP di atas meja, tidak ada part yang menembus meja, di dalam limit sendi,
   di dalam sektor J1, dan tiap perpindahan aman terhadap servo yang mendahului
   stepper).
   ========================================================================== */

/* Pulsa gripper (us). Sejak 13 Agu 2026 ini HASIL UKUR di lengan terakit, bukan
   lagi tebakan aman di sekitar netral 1500: operator menyapu travel MG90S
   gripper di mode SERVICE sampai rahang benar benar membuka dan menutup, dan yang
   di bawah adalah dua ujung yang dipakainya.

   Yang penting bukan cuma angkanya, tapi ARAHNYA: di gripper ini pulsa KECIL
   membuka rahang dan pulsa BESAR menutupnya. Tebakan lama (open 1300, close
   1700) sekaligus salah dua duanya, karena 1300 ada di LUAR travel terukur
   1406..1859 us, yaitu perintah yang mendorong rahang melewati batas
   mekanisnya. Runner tetap menjepit nilai ini ke travel hasil cal_get; yang
   diperbaiki bersama commit ini adalah arah jepitannya (lihat syncGripLimits di
   features/runner.js), yang dulu mengasumsikan kebalikannya. */
export const GRIP_US_DEFAULT = { open: 1406, close: 1856 };

/* Kecepatan (derajat/detik) yang dikirim sebagai cal_set sebelum gerak.
   TEACH sengaja jauh di bawah default firmware (60): pada 8 dps sendi butuh
   ~11 detik untuk 90 derajat, cukup lambat untuk melihat kabel tersangkut dan
   masih sempat menekan E-STOP sebelum sesuatu rusak.

   Perhatikan bahwa memperlambat profil ini justru MEMPERBESAR jarak waktu
   antara servo dan stepper (servo tidak ikut melambat), jadi TEACH yang lebih
   aman untuk stepper adalah TEACH yang lebih ekstrem untuk urutan J5. Itu
   alasan lain kenapa urutan langkah di bawah tidak boleh mengandalkan "toh
   geraknya pelan". */
export const SPEED = {
  teach: { speed: 8, accel: 30 },
  run: { speed: 25, accel: 90 },
};

/* Pose jangkar pick & place. Ditulis sebagai konstanta bernama karena beberapa
   langkah memakai BENTUK yang sama persis di yaw yang berbeda: titik taruh
   adalah titik ambil yang diputar ke J1 -90, dan kalau angkanya diketik ulang,
   pose yang dibetulkan di lapangan di satu tempat akan menyimpang diam diam
   dari kembarannya di tempat lain.

   Yang dicapai tiap pose (dari CAD, TCP = ujung wedge jaw saat tertutup;
   y = tinggi TCP di atas meja, r = jarak mendatar dari sumbu J1, sisa = part
   TERENDAH seluruh rakitan, bukan cuma TCP):

     SIAGA   r 400  y 250  tool  -7   sisa 213 mm  J5 = J5 DEKAT, turun tanpa servo
     DEKAT   r 394  y  35  tool -42   sisa  28 mm  teach operator 13 Agu 2026
     AMBIL   r 473  y  68  tool -19   sisa  42 mm  teach operator 13 Agu 2026
     ANGKAT  r 439  y 307  tool +16   sisa 209 mm  J5 = J5 AMBIL, naik tanpa servo
     TARUH   r 474  y  74  tool -17   sisa  46 mm  teach operator 13 Agu 2026
     MUNDUR  r 415  y 121  tool -12   sisa  89 mm  J5 = J5 TARUH, mundur tanpa servo

   J5 SISI AMBIL DAN J5 SISI TARUH BERBEDA (43 vs 45), dan itu memang hasil
   teach: operator membetulkan pergelangan dua kali, sekali di tiap titik.
   Selisih 2 derajat itu tidak dirata ratakan di sini. Yang penting justru
   konsekuensinya pada urutan: karena kedua sisi punya J5 sendiri, perpindahan
   antar sisi harus MEMBAWA J5 ikut pindah selagi lengan masih tinggi.

   Itu sebabnya ANGKAT memakai J5 sisi ambil dan seluruh pose sisi taruh memakai
   J5 sisi taruh. Versi yang ditempel apa adanya dari "ekspor rutin" tidak
   begitu: di sana J5 balik ke 24,1 tepat di dua langkah yang lengannya masih di
   dekat meja, dan karena servo sampai duluan, jalur "maju + luruskan -> angkat"
   melorot ke 7 mm dari meja sebelum lengan sempat naik. verify_cad_rig.mjs
   menandainya sebagai MELOROT DI DEKAT MEJA. Dengan J5 dibawa serta, titik
   terendah tiap perpindahan sekarang selalu jatuh di salah satu ujungnya. */
const J5_AMBIL = 43;    // teach sisi ambil, 13 Agu 2026
const J5_TARUH = 45;    // teach sisi taruh, 13 Agu 2026

const SIAGA  = [0, -18.3, 130.5, 0, 15.5, 0];
const DEKAT  = [0, 8.5, 139, 0, 15.5, 0];
const AMBIL  = [0, 22.7, 129.5, 0, J5_AMBIL, 0];
const ANGKAT = [0, -6, 123.5, 0, J5_AMBIL, 0];
const MUNDUR = [0, 5.8, 141.5, 0, J5_TARUH, 0];

const TARUH = -90;   // yaw titik taruh: 90 derajat ke kanan, ujung sektor kerja

/** pose yang sama, dipindah ke sisi taruh: yaw diputar dan J5 diganti J5 sisi
 *  itu. Bentuk lengan (J2/J3/J4) tidak berubah, jadi benda mendarat pada sikap
 *  yang sama seperti waktu diambil. */
const diTaruh = (a) => [TARUH, a[1], a[2], a[3], J5_TARUH, a[5]];

export const ROUTINES = {
  pickPlace: {
    name: 'Pick & place',
    desc: 'Ambil benda di kertas milimeter (J1 0), pindah 90 deg ke kanan (J1 -90), taruh, balik home. '
      + 'Pose diajarkan SEBELUM pergelangan dibongkar pasang: lewati sekali lagi per langkah di TEACH.',
    speed: 25,
    steps: [
      { a: [0, 0, 0, 0, 0, 0], label: 'home', note: 'titik awal, lengan tegak' },
      {
        a: SIAGA, label: 'siaga atas ambil',
        note: 'TCP 250 mm di atas meja, tepat di atas jalur turun. Belum ada yang dekat benda.',
        warn: 'Langkah ini yang memutar J5 dari 0 ke 15,5. Sengaja dilakukan di sini, selagi '
          + 'pergelangan masih 200 mm di atas meja, supaya servo boleh sampai duluan.',
      },
      {
        a: DEKAT, label: 'dekat titik ambil',
        note: 'Ujung jaw menggantung 35 mm di atas meja, tepat di belakang benda. Ini pose yang '
          + 'diajarkan operator langsung di lengan.',
      },
      { grip: 'open', label: 'buka rahang', note: 'rahang membuka selebar benda, lengan diam' },
      {
        a: AMBIL, label: 'maju + luruskan pergelangan',
        note: 'TCP maju 79 mm sambil J5 mendatar (tool -42 -> -19 deg); karena pusat pergelangan '
          + 'tidak ikut turun, ujung jaw justru naik dari 35 ke 68 mm. Rahang menyusup mengapit '
          + 'benda dari samping, bukan menekan dari atas. Ini pose hasil teach di lengan.',
        warn: 'Kalau benda ternyata lebih jauh, betulkan lewat slider lalu "simpan sudut ini"; '
          + 'jangan menambah J2 sambil jalan. Kalau di lengan nyata rahang malah menempel meja, '
          + 'berhenti: menurut CAD pose ini menyisakan 42 mm, jadi yang meleset trim J5 twin dan '
          + 'bukan rutinnya.',
      },
      { grip: 'close', label: 'jepit', note: 'benda terpegang, tidak selip' },
      {
        a: ANGKAT, label: 'angkat',
        note: 'Naik 239 mm ke ketinggian transfer. J5 ditahan di nilai pose ambil, jadi servo '
          + 'diam total dan yang bekerja cuma J2/J3.',
      },
      {
        a: diTaruh(ANGKAT), label: 'putar ke titik taruh',
        note: 'J1 berputar 90 deg penuh di ketinggian 300 mm. J5 sekalian digeser 2 deg ke nilai '
          + 'sisi taruh di sini, selagi masih jauh dari meja.',
        warn: 'Ayunan J1 terbesar di rutin ini, dan lintasannya melewati atas kotak elektronik. '
          + 'Perhatikan kabel encoder dan kabel servo yang melintasi base.',
      },
      {
        a: diTaruh(AMBIL), label: 'turun taruh',
        note: 'Bentuk lengan sama persis dengan pose ambil, jadi benda mendarat pada sikap yang '
          + 'sama seperti waktu diambil. J5 sudah bernilai sisi taruh sejak langkah sebelumnya, '
          + 'jadi servo diam selama turun.',
      },
      { grip: 'open', label: 'lepas', note: 'benda ditinggal, jaw bebas' },
      {
        a: diTaruh(MUNDUR), label: 'mundur dari benda',
        note: 'Rahang ditarik keluar 60 mm dan naik 47 mm dengan J5 tetap, jadi tidak ada satu '
          + 'pun gerakan servo di dekat benda yang baru ditaruh.',
      },
      { a: diTaruh(ANGKAT), label: 'angkat', note: 'kembali ke ketinggian transfer' },
      { a: [0, 0, 0, 0, 0, 0], label: 'home', note: 'kembali tegak' },
    ],
  },

  repeat: {
    name: 'Repeat position',
    desc: 'Bolak-balik ke satu titik ukur di atas kertas milimeter. Menguji apakah J3/J4 yang open-loop kehilangan step.',
    speed: 25,
    /* Yang diukur cuma langkah TITIK UKUR. Langkah "ayunan besar" ada supaya
       tiap siklus benar-benar menempuh jarak jauh dulu: pengulangan yang
       diukur setelah gerak 5 derajat tidak membuktikan apa pun tentang step
       yang hilang.

       Langkah "kembali ke bidang ukur" bukan basa basi. Tanpa dia, perpindahan
       dari ayunan langsung ke titik ukur membuat J4 memutar balik 90 deg
       SEMENTARA pergelangan sudah menekuk ke bawah (servo J5 sampai duluan),
       dan jalurnya turun sampai 20 mm di atas meja, lebih rendah daripada
       kedua ujungnya sendiri. Dengan langkah transit ini J4 dan J1 selesai
       dulu di ketinggian 200 mm, baru lengan turun tegak lurus dengan servo
       yang sudah diam. Titik ukur juga selalu didekati dari arah yang sama,
       yang memang syarat uji pengulangan. */
    cycles: 10,
    loopFrom: 1,
    measureAt: 3,
    steps: [
      { a: [0, 0, 0, 0, 0, 0], label: 'referensi home', note: 'titik nol siklus' },
      {
        a: [-90, -20, 120, 90, 30, 0], label: 'ayunan besar',
        note: 'lengan pindah ke ujung kanan sektor kerja dan J4 memutar 90 deg',
        warn: 'Pose paling ekstrem di rutin ini. Jalankan per sendi dulu lewat slider LIVE.',
      },
      {
        a: [0, -18.3, 130.5, 0, 5.9, 0], label: 'kembali ke bidang ukur',
        note: 'J1 dan J4 pulang ke nol di ketinggian 220 mm. J5 sudah disetel ke nilai titik '
          + 'ukur di sini, jadi turunnya nanti tanpa gerakan servo sama sekali.',
      },
      {
        a: [0, 9.9, 131, 0, 5.9, 0], label: 'TITIK UKUR',
        note: 'INI yang diukur tiap siklus: TCP 45 mm di atas kertas milimeter, r 420 mm. '
          + 'Catat pembacaan dial/laser sebelum lanjut.',
      },
    ],
  },

  showcase: {
    name: 'Showcase sendi',
    desc: 'Satu sendi bergerak per langkah dari pose dasar. Untuk peragaan, bukan presisi.',
    speed: 30,
    steps: [
      { a: [0, 0, 0, 0, 0, 0], label: 'home', note: 'pose dasar' },
      { a: [-45, 0, 0, 0, 0, 0], label: 'J1 -45', note: 'base yaw ke kanan, lengan tetap tegak' },
      { a: [-90, 0, 0, 0, 0, 0], label: 'J1 -90', note: 'ujung sektor kerja di meja ini' },
      { a: [0, 0, 0, 0, 0, 0], label: 'balik tengah', note: 'kembali menghadap kertas milimeter' },
      {
        a: [0, 60, 0, 0, 0, 0], label: 'J2 +60', note: 'bahu turun ke depan, torsi terbesar',
        warn: 'Lengan lurus menjulur 692 mm ke depan pada ketinggian 463 mm. Pastikan tidak ada '
          + 'monitor, tembok, atau orang di jalur itu sebelum kirim.',
      },
      { a: [0, 30, 90, 0, 0, 0], label: 'J3 +90', note: 'siku menekuk, ujung turun ke 124 mm' },
      { a: [0, 30, 60, 90, 0, 0], label: 'J4 +90', note: 'pergelangan berputar pada sumbunya' },
      { a: [0, 30, 60, 0, 90, 0], label: 'J5 +90', note: 'pergelangan mengangguk ke atas' },
      {
        a: [0, 30, 60, 0, 0, 30], label: 'J6 +30 (hati-hati)',
        note: 'putaran ujung, sengaja kecil',
        warn: 'J6 MENTOK di home dan belum dibetulkan. Kirim per sendi, dan batalkan begitu terdengar servo mengerang atau lengan bergetar.',
      },
      { a: [0, 0, 0, 0, 0, 0], label: 'home', note: 'kembali tegak' },
    ],
  },

  /* Pose-nya dihitung IK saat rutin dipilih (butuh scene graph), jadi tidak ada
     daftar sudut di sini dan verify_cad_rig.mjs melewatinya. Pembangunnya ada
     di features/demos.js -> lineSteps().

     Seed = TCP 60 mm di atas kertas milimeter, r 420, tool -45 deg. Sumbu Z
     dipilih (bukan X) karena garisnya jadi radial keluar-masuk pada J1 tetap 0:
     itu membuat seluruh lintasan berada di dalam sektor kerja 0..-90 tanpa
     harus menyentuh J1 sama sekali, dan simpangannya bisa dibaca langsung di
     kotak kertas milimeter yang sudah ada di meja. Kedua ujung (r 340 dan
     r 500) sudah dicek: part terendah tetap 53 mm di atas meja. */
  line: {
    name: 'Lintasan lurus (uji IK)',
    desc: 'TCP menempuh garis lurus 160 mm di ketinggian tetap 60 mm, di atas kertas milimeter.',
    speed: 20,
    dynamic: 'line',
    line: { seed: [0, 7, 129.8, 0, 1.7, 0], axis: 'z', span: 160, points: 5 },
  },
};

/** daftar [key, routine] yang punya pose statik (bisa diaudit tanpa WebGL). */
export function staticRoutines() {
  return Object.entries(ROUTINES).filter(([, r]) => Array.isArray(r.steps));
}
/** pose sendi saja dari sebuah rutin (langkah gripper dibuang). */
export function posesOf(r) {
  return (r.steps || []).filter(s => Array.isArray(s.a)).map(s => s.a);
}
