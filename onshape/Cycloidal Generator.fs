FeatureScript 3008;
import(path : "onshape/std/common.fs", version : "3008.0");

/**
 * CYCLOIDAL DRIVE v5 - ALL-IN-ONE GENERATOR
 * ─────────────────────────────────────────────────────────────────────────────
 * SATU feature ("Cycloidal Drive - All Parts") men-generate semua komponen
 * sekaligus dengan SATU set parameter. Checkbox per part tetap ada supaya bisa
 * reprint satu komponen saja (mis. iterasi disk) tanpa regen yang lain.
 *
 * Perubahan besar v5 (dari v4 yang 7 feature terpisah):
 *   1. UNIFIED  – 7 defineFeature dihapus, diganti 1. Parameter shared
 *                 (diskThickness, diskGap, Dr, dll.) dideklarasi SEKALI.
 *   2. AUTO LAYOUT – semua circle/bore (output pin circle, base bolt circle,
 *                 flange ring bore, cover bolt circle, base plate dia, boss
 *                 thickness, dst.) DITURUNKAN dari geometri inti (Dr, N, pin,
 *                 bearing, e) dengan margin web. Scale Dr naik/turun -> semua
 *                 lubang ikut.
 *   3. VALIDASI – konfigurasi yang gak muat sekarang MENOLAK dengan pesan
 *                 berisi angka konkret (bukan diam-diam motong geometri).
 *   4. OUTPUT MODE – eksplisit dua arsitektur:
 *        HOUSING_OUTPUT (v4, default): bottom+top base statik, dowel statik
 *          ngunci rotasi disk -> housing+roller+cover jadi OUTPUT.
 *          Rasio = N : 1  (N = jumlah ring pin).
 *          Di mode ini flange housing TIDAK punya lubang output pin (dowel
 *          statik lewat bore tengah flange yang terbuka) — di v4 lama lubang
 *          nominal itu bikin housing ke-lock sama dowel statik + flange nabrak
 *          bottom base. Sekarang bore flange otomatis > base plate.
 *        LEGACY_HUB (v2/v3): housing statik, output hub di atas.
 *          Rasio = (N-1) : 1.
 *   5. FIT NOMINAL — lubang roller, dowel output, & baut M3 default = diameter
 *      NOMINAL (yang kamu input keluar apa adanya). Clearance/interference
 *      diset MANUAL di grup "Fit / Tolerance" (default 0). Gak ada fit empiris
 *      tersembunyi lagi (dulu ANCHOR/LOCATE/GRIP/CLEAR nambah 0.14/0.25/0.10/0.20).
 *
 * Perubahan v5.1 (UX interface layout):
 *   a. OVERRIDE PER-DIMENSI — saklar "Auto Layout" all-or-nothing DIHAPUS.
 *      Layout selalu auto; tiap dimensi punya checkbox "Override ..." sendiri.
 *      Yang gak dicentang tetap ngikut geometri, termasuk ngikutin dimensi
 *      yang KAMU override (pinCircle -> base plate -> flange bore / cover ring).
 *      Dulu matiin auto = 11 dimensi sekaligus lepas ke default statis yang
 *      saling bentrok -> betulin satu, muncul error berikutnya.
 *   b. VALIDASI TERKUMPUL — semua konflik dilaporin SEKALI, bernomor, bukan
 *      report-and-return per cek.
 *   c. PESAN BER-RANGE — tiap error nyebut jendela legal dua sisi + nilai auto
 *      sebagai titik balik. Kalau jendelanya kosong (lo > hi) dibilang eksplisit
 *      + Dr minimum yang dibutuhkan, karena di situ ngutak-atik dimensi itu
 *      sendiri gak akan pernah selesai.
 *   d. minWeb jadi parameter (dulu hard-code 1.6mm) -- itu yang nentuin ketat/
 *      longgarnya validator.
 *   e. Bottom & Top Base Plate dipisah (dulu satu angka buat dua-duanya).
 *
 * Konvensi Z (tidak berubah dari v4):
 *   z = zOffset - flangeThickness  -> (kosong; cam base plate DIHAPUS di v5.x)
 *   z = zOffset + 0                -> dasar housing flange / bottom base
 *   z = zOffset + flangeThickness  -> dasar disk 1
 *   z = zOffset + fl + ringH       -> dasar top base / cover / hub
 *     ringH = dual ? 2*diskThick + diskGap : diskThick
 *
 * Layout radial disk (auto), dari dalam ke luar:
 *   [bearing bore eccOR] web [base bolt ring] web [output pin ring] web [root lobe]
 *   Kalau band gak cukup utk 2 ring -> fallback 1 ring gabungan (pin & bolt
 *   selang-seling, butuh Base Bolt Count == Output Pin Count). Kalau 1 ring
 *   pun gak muat -> error dengan Dr minimum yang dibutuhkan.
 *
 * Fit lubang (diametral, USER-CONTROLLED, default 0 = nominal):
 *   diameter lubang = 2*nomR + clearance   (clearance dari parameter grup
 *   "Fit / Tolerance"; boleh negatif utk interference/press-fit).
 *
 * Rumus profil cycloidal — BASE HYPOTROCHOID (N-1 lobus, lobe tip di t=0):
 *   xa = Rr*sin(t) + e*sin(N*t)   [local frame, disk center di origin]
 *   ya = Rr*cos(t) + e*cos(N*t)
 *   r^2 = Rr^2 + e^2 + 2*Rr*e*cos((N-1)*t)  -> N-1 lobus
 *   Pin radius correction: opOffsetFace(-(Rp+clr) + diskFitAdjustment)
 *
 * CATATAN opBoolean:
 *   SUBTRACTION : tools = pemotong, targets = yang dipotong
 *   UNION       : SEMUA body di "tools" via qUnion([...]), targets DIABAIKAN
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── ENUMS ─────────────────────────────────────────────────────────────────────

export enum MotorType {
    annotation { "Name" : "NEMA 17 (shaft 5mm)" }
    NEMA17,
    annotation { "Name" : "DC 395 / RS550 (shaft 3.17mm)" }
    DC_RS
}

export enum EccBearingType {
    annotation { "Name" : "6900ZZ - 10x22x6mm (NEMA17 build, default)" }
    B_6900ZZ,
    annotation { "Name" : "608ZZ - 8x22x7mm" }
    B_608ZZ,
    annotation { "Name" : "6203ZZ - 17x40x12mm" }
    B_6203ZZ
}

export enum CycloOutputMode {
    annotation { "Name" : "Housing output (v4: base statik, ratio N:1)" }
    HOUSING_OUTPUT,
    annotation { "Name" : "Legacy hub (v2/v3: housing statik, ratio N-1:1)" }
    LEGACY_HUB
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function zPlane(z is ValueWithUnits) returns Plane
{
    return plane(vector(0, 0, 1) * z, vector(0, 0, 1));
}

function resolveShaft(motorType is MotorType) returns ValueWithUnits
{
    return (motorType == MotorType.NEMA17) ? 5 * millimeter : 3.17 * millimeter;
}

function resolveBearing(eccBearing is EccBearingType) returns map
{
    if (eccBearing == EccBearingType.B_6900ZZ)
        return {
            "eccBearingInner" : 10 * millimeter,
            "eccBearingOuter" : 22 * millimeter,
            "eccBearingWidth" : 6  * millimeter
        };
    else if (eccBearing == EccBearingType.B_608ZZ)
        return {
            "eccBearingInner" : 8  * millimeter,
            "eccBearingOuter" : 22 * millimeter,
            "eccBearingWidth" : 7  * millimeter
        };
    else  // 6203ZZ
        return {
            "eccBearingInner" : 17 * millimeter,
            "eccBearingOuter" : 40 * millimeter,
            "eccBearingWidth" : 12 * millimeter
        };
}

// ── Fit lubang: NOMINAL + clearance USER (lihat grup "Fit / Tolerance") ───────
// Gak ada fit empiris tersembunyi. Tiap lubang seat/thru dihitung inline:
//   radius skCircle = nomR + clearance_diametral / 2   (clearance dari parameter)
// Default clearance = 0 -> diameter lubang == diameter yang kamu input.
// Clearance boleh NEGATIF utk interference / press-fit.

// Format panjang -> string mm 2 desimal (buat pesan error/println)
function mmStr(v is ValueWithUnits) returns string
{
    return toString(round(v / millimeter * 100) / 100) ~ "mm";
}

// Radius internal -> string DIAMETER "Ø..mm". SEMUA input feature = diameter,
// jadi pesan error/println ngomong diameter juga (cocok sama yg kamu ketik).
function dStr(r is ValueWithUnits) returns string
{
    return "Ø" ~ mmStr(2 * r);
}

// ── Validasi layout: range legal, bukan "kegedean/kekecilan" doang ────────────
/**
 * Cek satu dimensi layout terhadap jendela legal-nya. Return "" kalau OK, atau
 * pesan lengkap: nilai sekarang, RANGE legal (dua sisi sekaligus), nilai auto
 * sebagai titik balik, dan penyebab batasnya.
 * lo / hi boleh undefined = tak berbatas di sisi itu.
 * Kalau lo > hi berarti gak ada nilai yang valid sama sekali -> dibilang
 * eksplisit, karena di situ ngutak-atik dimensi ini gak akan pernah selesai.
 */
function checkRange(name is string, r is ValueWithUnits, lo, hi,
                    autoR is ValueWithUnits, why is string) returns string
{
    var tol   = 0.01 * millimeter;
    var loBad = (lo is ValueWithUnits) && (r < lo - tol);
    var hiBad = (hi is ValueWithUnits) && (r > hi + tol);
    if (!loBad && !hiBad)
        return "";

    var rng = "";
    if ((lo is ValueWithUnits) && (hi is ValueWithUnits))
        rng = (lo > hi)
              ? ("RANGE LEGAL KOSONG (" ~ dStr(lo) ~ " > " ~ dStr(hi) ~ ") -- gak ada nilai yg valid")
              : ("range legal " ~ dStr(lo) ~ " .. " ~ dStr(hi));
    else if (lo is ValueWithUnits)
        rng = "range legal >= " ~ dStr(lo);
    else
        rng = "range legal <= " ~ dStr(hi);

    return name ~ " = " ~ dStr(r) ~ " -> " ~ rng ~ ". Auto = " ~ dStr(autoR) ~ ". " ~ why;
}

// Baris laporan layout buat println (nilai efektif + sumber + range legal).
function layoutLine(name is string, r is ValueWithUnits, manual is boolean, lo, hi) returns string
{
    var rng = "";
    if ((lo is ValueWithUnits) && (hi is ValueWithUnits))
        rng = "   legal " ~ dStr(lo) ~ " .. " ~ dStr(hi) ~ ((lo > hi) ? "  <-- KOSONG" : "");
    else if (lo is ValueWithUnits)
        rng = "   legal >= " ~ dStr(lo);
    else if (hi is ValueWithUnits)
        rng = "   legal <= " ~ dStr(hi);
    return "   " ~ name ~ " = " ~ dStr(r) ~ (manual ? " [MANUAL]" : " [auto]") ~ rng;
}

// Kasih nama part hasil satu builder (semua body dari sub-id tsb)
function nameBodies(context is Context, subId is Id, partName is string)
{
    setProperty(context, {
        "entities"     : qCreatedBy(subId, EntityType.BODY),
        "propertyType" : PropertyType.NAME,
        "value"        : partName
    });
}

// ── HELPER: bolt lugs (ears) ──────────────────────────────────────────────────
/**
 * Tambah N "lug" (kuping baut) yg NONJOL keluar dari ring/wall (gak ngikut wall),
 * lalu bor lubang baut di tiap lug. Bentuk tiap lug = stadium: 2 garis tangent +
 * 1 tangent arc (cap) di sisi luar + 1 garis base yg terkubur di body (overlap
 * supaya UNION bersih, gak ada coincident face / T-junction).
 *
 * p (map):
 *   count       – jumlah lug
 *   boltCR      – radius pusat baut (= pusat cap arc). Harus > ringOuterR biar nonjol.
 *   capR        – radius cap arc = holeR + wall (default wall 2mm)
 *   holeR       – radius lubang baut (grip / clearance, sudah termasuk fit)
 *   ringOuterR  – radius luar body yg dipasangi lug (buat ngubur base line)
 *   zBase       – z dasar lug (dasar extrude)
 *   height      – tinggi lug (= depth extrude)
 *   body        – Query body target buat di-UNION & di-bor
 */
function addBoltLugs(context is Context, id is Id, p is map)
{
    var n      = p.count;
    var boltCR = p.boltCR;
    var capR   = p.capR;
    var holeR  = p.holeR;
    var rOuter = p.ringOuterR;
    var zBase  = p.zBase;
    var h      = p.height;
    var body   = p.body;
    var burial = 1.5 * millimeter;          // base line dikubur sedalam ini ke body
    var xBase  = rOuter - burial;
    var ov     = 1 * millimeter;

    // ── Profil lug (stadium) untuk tiap posisi ───────────────────────────────
    var skLug = newSketchOnPlane(context, id + "skLug", { "sketchPlane" : zPlane(zBase) });
    for (var i = 0; i < n; i += 1)
    {
        var a  = (i * 360 / n) * degree;
        var ca = cos(a);
        var sa = sin(a);
        // frame lokal: u (radial) = (ca,sa), t (tangensial) = (-sa,ca)
        var p1  = vector(xBase * ca - capR * sa,            xBase * sa + capR * ca);            // inner-top
        var p2  = vector(boltCR * ca - capR * sa,           boltCR * sa + capR * ca);           // cap-top (tangent)
        var tip = vector((boltCR + capR) * ca,              (boltCR + capR) * sa);              // ujung radial (mid arc)
        var p3  = vector(boltCR * ca + capR * sa,           boltCR * sa - capR * ca);           // cap-bottom (tangent)
        var p4  = vector(xBase * ca + capR * sa,            xBase * sa - capR * ca);            // inner-bottom
        skLineSegment(skLug, "lt" ~ toString(i), { "start" : p1, "end" : p2 });   // garis tangent atas
        skArc(skLug,         "ar" ~ toString(i), { "start" : p2, "mid" : tip, "end" : p3 }); // cap arc
        skLineSegment(skLug, "lb" ~ toString(i), { "start" : p3, "end" : p4 });   // garis tangent bawah
        skLineSegment(skLug, "ba" ~ toString(i), { "start" : p4, "end" : p1 });   // base (terkubur)
    }
    skSolve(skLug);
    opExtrude(context, id + "extLug", {
        "entities"  : qCreatedBy(id + "skLug", EntityType.FACE),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : h
    });
    opBoolean(context, id + "boolLug", {
        "tools"         : qUnion([ body, qCreatedBy(id + "extLug", EntityType.BODY) ]),
        "operationType" : BooleanOperationType.UNION
    });

    // ── Lubang baut di tiap lug ──────────────────────────────────────────────
    var skH = newSketchOnPlane(context, id + "skLugH", { "sketchPlane" : zPlane(zBase - ov) });
    for (var i = 0; i < n; i += 1)
    {
        var a = (i * 360 / n) * degree;
        skCircle(skH, "h" ~ toString(i), {
            "center" : vector(boltCR * cos(a), boltCR * sin(a)),
            "radius" : holeR
        });
    }
    skSolve(skH);
    opExtrude(context, id + "extLugH", {
        "entities"  : qCreatedBy(id + "skLugH", EntityType.FACE),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : h + 2 * ov
    });
    opBoolean(context, id + "boolLugH", {
        "tools"         : qCreatedBy(id + "extLugH", EntityType.BODY),
        "targets"       : body,
        "operationType" : BooleanOperationType.SUBTRACTION
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  BUILDER 1: HOUSING  (open-top, printable)
// ════════════════════════════════════════════════════════════════════════════
/**
 * Housing open-top: bottom flange + ring wall (tanpa top flange).
 * v5: lubang output pin di flange hanya dibuat saat def.flangeOutputHoles=true
 * (LEGACY_HUB mode). Di HOUSING_OUTPUT, dowel statik lewat flange ring bore.
 */
function makeHousing(context is Context, id is Id, def is map)
{
    var N       = def.numPins;
    var Rr      = def.pinCircleRadius;
    var Rp      = def.pinRadius;
    var e       = def.eccentricity;
    var thick   = def.diskThickness;
    var clr     = 0 * millimeter;   // semua dimensi nominal
    var wall    = def.wallThickness;
    var fl      = def.flangeThickness;
    var dual    = def.dualDisk;
    var bearIR  = def.eccBearingInner / 2;
    var dGap    = def.diskGap;
    var zOff    = def.zOffset;
    var ringH   = dual ? (2 * thick + dGap) : thick;
    var totalH  = fl + ringH;
    var cavR    = Rr + Rp - e + clr;
    var outR    = Rr + Rp + clr + wall;
    var ov      = 1 * millimeter;
    var nOut    = def.numOutputPins;
    var outPR   = def.outputPinRadius;
    var outCR   = def.outputPinCircleR;
    var ringFlange = def.useFlangeRing;
    var coverBolts = def.useCoverBolts;


    // ── Silinder penuh (dasar housing) ───────────────────────────────────────
    var skMain = newSketchOnPlane(context, id + "skMain", {
        "sketchPlane" : zPlane(zOff)
    });
    skCircle(skMain, "o", {
        "center" : vector(0, 0) * millimeter,
        "radius" : outR
    });
    skSolve(skMain);
    opExtrude(context, id + "extMain", {
        "entities"  : qCreatedBy(id + "skMain", EntityType.FACE),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : totalH
    });
    var body = qCreatedBy(id + "extMain", EntityType.BODY);

    // ── Cavity (dari zOff+fl hingga zOff+fl+ringH) ───────────────────────────
    var skCav = newSketchOnPlane(context, id + "skCav", {
        "sketchPlane" : zPlane(zOff + fl)
    });
    skCircle(skCav, "c", {
        "center" : vector(0, 0) * millimeter,
        "radius" : cavR
    });
    skSolve(skCav);
    opExtrude(context, id + "extCav", {
        "entities"  : qCreatedBy(id + "skCav", EntityType.FACE),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : ringH
    });
    opBoolean(context, id + "boolCav", {
        "tools"         : qCreatedBy(id + "extCav", EntityType.BODY),
        "targets"       : body,
        "operationType" : BooleanOperationType.SUBTRACTION
    });

    // ── N lubang pin roller (tembus full height, +1mm overshoot) ─────────────
    var skPins = newSketchOnPlane(context, id + "skPins", {
        "sketchPlane" : zPlane(zOff - ov)
    });
    for (var i = 0; i < N; i += 1)
    {
        var ang = (i * 360 / N) * degree;
        // Lubang roller = Rp NOMINAL + Roller Pin Hole Clearance (default 0).
        // Mesh tetap pakai Rp asli (profil disk); ini lubang fisiknya.
        skCircle(skPins, "p" ~ toString(i), {
            "center" : vector(Rr * cos(ang), Rr * sin(ang)),
            "radius" : Rp + def.rollerFitClearance / 2
        });
    }
    skSolve(skPins);
    opExtrude(context, id + "extPins", {
        "entities"  : qCreatedBy(id + "skPins", EntityType.FACE),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : totalH + ov
    });
    opBoolean(context, id + "boolPins", {
        "tools"         : qCreatedBy(id + "extPins", EntityType.BODY),
        "targets"       : body,
        "operationType" : BooleanOperationType.SUBTRACTION
    });

    // ── Cam-boss clearance hole di bottom flange ──────────────────────────────
    var camClrR = e + bearIR + clr;
    var skCamH = newSketchOnPlane(context, id + "skCamH", {
        "sketchPlane" : zPlane(zOff - ov)
    });
    skCircle(skCamH, "ch", {
        "center" : vector(0, 0) * millimeter,
        "radius" : camClrR
    });
    skSolve(skCamH);
    opExtrude(context, id + "extCamH", {
        "entities"  : qCreatedBy(id + "skCamH", EntityType.FACE),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : fl + ov
    });
    opBoolean(context, id + "boolCamH", {
        "tools"         : qCreatedBy(id + "extCamH", EntityType.BODY),
        "targets"       : body,
        "operationType" : BooleanOperationType.SUBTRACTION
    });

    // ── N_out output pin holes di bottom flange — LEGACY_HUB mode SAJA ────────
    // v5: di HOUSING_OUTPUT lubang ini dihilangkan. Dowel output statik dan
    // flange ini ikut MUTER sebagai output; lubang nominal di sini bakal
    // ngunci housing ke dowel (bug v4). Bore ring flange yang buka jalannya.
    if (def.flangeOutputHoles)
    {
        var skOutPins = newSketchOnPlane(context, id + "skOutPins", {
            "sketchPlane" : zPlane(zOff - ov)
        });
        for (var j = 0; j < nOut; j += 1)
        {
            var ang = (j * 360 / nOut) * degree;
            skCircle(skOutPins, "op" ~ toString(j), {
                "center" : vector(outCR * cos(ang), outCR * sin(ang)),
                "radius" : outPR + clr
            });
        }
        skSolve(skOutPins);
        opExtrude(context, id + "extOutPins", {
            "entities"  : qCreatedBy(id + "skOutPins", EntityType.FACE),
            "direction" : vector(0, 0, 1),
            "endBound"  : BoundingType.BLIND,
            "endDepth"  : fl + 2 * ov
        });
        opBoolean(context, id + "boolOutPins", {
            "tools"         : qCreatedBy(id + "extOutPins", EntityType.BODY),
            "targets"       : body,
            "operationType" : BooleanOperationType.SUBTRACTION
        });
    }

    // ── Buka tengah flange jadi RING ──────────────────────────────────────────
    // HOUSING_OUTPUT: bore > base plate + dowel statik (auto layout jamin).
    // LEGACY_HUB: bore kecil, clearance bearing orbit saja.
    if (ringFlange)
    {
        var flBoreR = def.flangeRingInnerR;
        var skFR = newSketchOnPlane(context, id + "skFlRing", {
            "sketchPlane" : zPlane(zOff - ov)
        });
        skCircle(skFR, "fr", {
            "center" : vector(0, 0) * millimeter,
            "radius" : flBoreR
        });
        skSolve(skFR);
        opExtrude(context, id + "extFlRing", {
            "entities"  : qCreatedBy(id + "skFlRing", EntityType.FACE),
            "direction" : vector(0, 0, 1),
            "endBound"  : BoundingType.BLIND,
            "endDepth"  : fl + 2 * ov
        });
        opBoolean(context, id + "boolFlRing", {
            "tools"         : qCreatedBy(id + "extFlRing", EntityType.BODY),
            "targets"       : body,
            "operationType" : BooleanOperationType.SUBTRACTION
        });
    }

    // ── Lug + lubang baut M3 cover->housing ───────────────────────────────────
    // Lug nonjol keluar wall. Lubang = M3 nominal + M3 Bolt Hole Clearance
    // (default 0; set negatif kalau mau self-tap grip). Boss di ATAS wall.
    if (coverBolts)
    {
        var cbNomR = 1.5 * millimeter;                  // M3 nominal
        var cbWall = def.coverBoltWall;
        var cbHoleR = cbNomR + def.m3FitClearance / 2;  // nominal + M3 clearance
        addBoltLugs(context, id + "hsgLug", {
            "count"      : def.coverBoltCount,
            "boltCR"     : def.coverBoltCircleR,
            "capR"       : cbHoleR + cbWall,
            "holeR"      : cbHoleR,
            "ringOuterR" : outR,
            "zBase"      : zOff + totalH - def.coverBoltBossHeight,
            "height"     : def.coverBoltBossHeight,
            "body"       : body
        });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  BUILDER 2: CYCLOIDAL DISK  (forum approach + dual disk support)
// ════════════════════════════════════════════════════════════════════════════
/**
 * Separation fisik antar dua disk = 0.3mm tetap (kecil, hanya untuk hindari
 * kontak). Housing cavity menggunakan diskGap yang lebih besar -> sisa ruang
 * adalah clearance Z untuk orbital motion.
 * v5: sudut base bolt = def.baseBoltAngleDeg (derived; 15 deg utk layout
 * 2-ring, setengah pitch pin utk layout 1-ring selang-seling).
 */
function makeDisk(context is Context, id is Id, def is map)
{
    var N       = def.numPins;
    var Rr      = def.pinCircleRadius;
    var e       = def.eccentricity;
    var Rp      = def.pinRadius;
    var thick   = def.diskThickness;
    var clr     = 0 * millimeter;   // semua dimensi nominal
    var fl      = def.flangeThickness;
    var eccOR   = def.eccBearingOuter / 2;
    var nOut    = def.numOutputPins;
    var outPR   = def.outputPinRadius;
    var outCR   = def.outputPinCircleR;
    var outClr  = def.outputPinClearance;           // running clearance DIAMETRAL lubang output pin
    var dual    = def.dualDisk;
    var physGap = 0.3 * millimeter;                 // separasi fisik antar disk (tetap)
    var zOff    = def.zOffset;
    var fitAdj  = def.diskFitAdjustment;            // koreksi fit radial outer lobe
                                                    // (+) = disk lebih gede = mesh lebih rapat = backlash turun
    var ov      = 1 * millimeter;
    var nPts    = N * 20;

    var count = dual ? 2 : 1;
    for (var d = 0; d < count; d += 1)
    {
        var dId   = id + ("d" ~ toString(d));
        var eSign = (d == 0) ? 1.0 : -1.0;
        var eX    = e * eSign;
        var zBot  = zOff + fl + d * (thick + physGap);
        // ── Phasing dual-disk (berlaku N ganjil & genap) ─────────────────────
        // Dua disk dual wajib beda SETENGAH lobe = 180/(N-1) deg, diterapkan
        // sbg ROTASI RIGID profil lobe. Lubang (bearing/output/baut) TIDAK ikut
        // diputar -> output pin tetap tembus lurus. Parity utk PRINT:
        //   - lobus GANJIL (N genap): kedua disk = part SAMA, tinggal balik 180deg.
        //   - lobus GENAP  (N ganjil, mis. 25): dua part BERBEDA, cetak keduanya.
        var lobeRot = d * (180 / (N - 1)) * degree;   // disk1=0, disk2=setengah-lobe
        var cR = cos(lobeRot);
        var sR = sin(lobeRot);

        // ── BASE HYPOTROCHOID — DUA SETENGAH (di-rotasi rigid sebesar lobeRot) ─
        var half   = nPts / 2;
        var halfA  = [];
        var halfB  = [];
        for (var i = 0; i <= half; i += 1)
        {
            var t  = (2 * PI * radian) * i / nPts;
            var bx = Rr * sin(t) + e * sin(N * t);
            var by = Rr * cos(t) + e * cos(N * t);
            halfA = append(halfA, vector(eX + bx * cR - by * sR,
                                              bx * sR + by * cR));
        }
        for (var i = half; i <= nPts; i += 1)
        {
            var tB  = (2 * PI * radian) * i / nPts;
            var bxB = Rr * sin(tB) + e * sin(N * tB);
            var byB = Rr * cos(tB) + e * cos(N * tB);
            halfB = append(halfB, vector(eX + bxB * cR - byB * sR,
                                               bxB * sR + byB * cR));
        }

        // ── Dua skFitSpline dalam satu sketch ─────────────────────────────────
        var skProf = newSketchOnPlane(context, dId + "skProf", {
            "sketchPlane" : zPlane(zBot)
        });
        skFitSpline(skProf, "halfA", { "points" : halfA });
        skFitSpline(skProf, "halfB", { "points" : halfB });
        skSolve(skProf);

        opExtrude(context, dId + "extProf", {
            "entities"  : qSketchRegion(dId + "skProf", true),
            "direction" : vector(0, 0, 1),
            "endBound"  : BoundingType.BLIND,
            "endDepth"  : thick
        });
        var diskBody = qCreatedBy(dId + "extProf", EntityType.BODY);

        // ── opOffsetFace: koreksi pin radius + clearance + fit adjustment ─────
        // Offset NEGATIF menyusutkan lobe (parallel offset kurva cycloidal).
        // Holes dipotong SETELAH offset ini, posisinya gak ikut berubah.
        var lateralFace = qSubtraction(
            qCreatedBy(dId + "extProf", EntityType.FACE),
            qUnion([qCapEntity(dId + "extProf", false), qCapEntity(dId + "extProf", true)])
        );
        opOffsetFace(context, dId + "offsetProf", {
            "moveFaces"      : lateralFace,
            "offsetDistance" : -(Rp + clr) + fitAdj
        });

        // ── Bearing hole ──────────────────────────────────────────────────────
        var skBear = newSketchOnPlane(context, dId + "skBear", {
            "sketchPlane" : zPlane(zBot - ov)
        });
        skCircle(skBear, "b", {
            "center" : vector(eX, 0 * millimeter),
            "radius" : eccOR + clr
        });
        skSolve(skBear);
        opExtrude(context, dId + "extBear", {
            "entities"  : qSketchRegion(dId + "skBear", true),
            "direction" : vector(0, 0, 1),
            "endBound"  : BoundingType.BLIND,
            "endDepth"  : thick + 2 * ov
        });
        opBoolean(context, dId + "boolBear", {
            "tools"         : qCreatedBy(dId + "extBear", EntityType.BODY),
            "targets"       : diskBody,
            "operationType" : BooleanOperationType.SUBTRACTION
        });

        // ── Output pin holes ──────────────────────────────────────────────────
        var skOut = newSketchOnPlane(context, dId + "skOut", {
            "sketchPlane" : zPlane(zBot - ov)
        });
        for (var j = 0; j < nOut; j += 1)
        {
            var ang = (j * 360 / nOut) * degree;
            // MOVING HOLE: lubang ngorbit ngelilingin pin STATIK, harus muat
            // pin + orbit penuh (e) + running clearance:
            //   r lubang = outPR + e + outputPinClearance/2
            // outClr=0 -> pas teori (macet). Naikin biar bebas; turunin biar
            // backlash output kecil.
            skCircle(skOut, "o" ~ toString(j), {
                "center" : vector(eX + outCR * cos(ang), outCR * sin(ang)),
                "radius" : outPR + e + outClr / 2
            });
        }
        skSolve(skOut);
        opExtrude(context, dId + "extOut", {
            "entities"  : qSketchRegion(dId + "skOut", true),
            "direction" : vector(0, 0, 1),
            "endBound"  : BoundingType.BLIND,
            "endDepth"  : thick + 2 * ov
        });
        opBoolean(context, dId + "boolOut", {
            "tools"         : qCreatedBy(dId + "extOut", EntityType.BODY),
            "targets"       : diskBody,
            "operationType" : BooleanOperationType.SUBTRACTION
        });

        // ── M3 base-holder clearance holes (eccentric + non-contact clr) ──────
        // Jalur baut M3 penyatuan base bawah<->atas; baut statik & ber-thread,
        // disk TIDAK boleh nyentuh. Radius = boltR + e + boltClr.
        // Toggle: Add Base Bolts (definition.useBaseBolts) -- kalau off, disk
        // gak butuh clearance ini sama sekali (gak ada baut yg lewat).
        if (def.useBaseBolts)
        {
            var nBolt   = def.numBaseBolts;
            var boltR   = def.baseBoltRadius;
            var boltCR  = def.baseBoltCircleR;
            var boltClr = def.boltHoleClearance;
            var skMb = newSketchOnPlane(context, dId + "skMb", {
                "sketchPlane" : zPlane(zBot - ov)
            });
            for (var j = 0; j < nBolt; j += 1)
            {
                // v5: offset sudut derived (baseBoltAngleDeg). 2-ring: 15 deg
                // (hindari garis retak bearing-baut-pin segaris radial). 1-ring:
                // 180/nOut deg (selang-seling persis di antara output pin).
                var angB = (j * 360 / nBolt + def.baseBoltAngleDeg) * degree;
                skCircle(skMb, "mb" ~ toString(j), {
                    "center" : vector(eX + boltCR * cos(angB), boltCR * sin(angB)),
                    "radius" : boltR + e + boltClr
                });
            }
            skSolve(skMb);
            opExtrude(context, dId + "extMb", {
                "entities"  : qSketchRegion(dId + "skMb", true),
                "direction" : vector(0, 0, 1),
                "endBound"  : BoundingType.BLIND,
                "endDepth"  : thick + 2 * ov
            });
            opBoolean(context, dId + "boolMb", {
                "tools"         : qCreatedBy(dId + "extMb", EntityType.BODY),
                "targets"       : diskBody,
                "operationType" : BooleanOperationType.SUBTRACTION
            });
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  BUILDER 3: ECCENTRIC INPUT CAM  (dual boss, D-shaft bore, no flange)
// ════════════════════════════════════════════════════════════════════════════
/**
 * Cam eksentrik TANPA flange/base plate (v5.x: base plate dihapus; cam = boss
 * eksentrik yang langsung dipress ke shaft). Dua segmen saat dualDisk=true,
 * satu segmen saat single:
 *
 *   Boss 1 : z = zOff .. zOff + boss1Thickness, center (+e, 0), r = bearIR-clr
 *   Boss 2 : z = zOff + boss1 .. + boss2, center (-e, 0), hanya jika dualDisk
 *
 * Shaft hole = profil-D (port dari dShaftFitTest): round part = shaftBore-
 * Diameter (preset 5.14 utk NEMA17 5mm). Flat diposisikan supaya gap radial ke
 * shaft konsisten: flatDepth = shaftDia(nominal motor) - flatDist, flat di
 * boreR - flatDepth dari pusat. Flat Dist >= shaft dia -> lubang bulat biasa
 * (mis. motor DC shaft bulat 3.17mm). Opsi mouse-ear relief: 2 lingkaran kecil
 * di sudut flat-arc buat kompensasi rounding FDM (default on).
 */
function makeCam(context is Context, id is Id, def is map)
{
    var e        = def.eccentricity;
    var bearIR   = def.eccBearingInner / 2;
    var clr      = 0 * millimeter;   // semua dimensi nominal
    var dual     = def.dualDisk;
    var boss1H   = def.boss1Thickness;
    var boss2H   = 0 * millimeter;
    if (dual)
        boss2H   = def.boss2Thickness;
    var totalBH  = dual ? (boss1H + boss2H) : boss1H;
    var zOff     = def.zOffset;
    var ov       = 1 * millimeter;

    // ── Boss 1 (z = zOff .. zOff+boss1H), center (+e,0) ──────────────────────
    var skBoss1 = newSketchOnPlane(context, id + "skBoss1", {
        "sketchPlane" : zPlane(zOff)
    });
    skCircle(skBoss1, "b1", {
        "center" : vector(e, 0 * millimeter),
        "radius" : bearIR - clr
    });
    skSolve(skBoss1);
    opExtrude(context, id + "extBoss1", {
        "entities"  : qCreatedBy(id + "skBoss1", EntityType.FACE),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : boss1H
    });

    if (dual)
    {
        // ── Boss 2, center (-e, 0) — berlawanan 180 deg dari boss 1 ──────────
        var skBoss2 = newSketchOnPlane(context, id + "skBoss2", {
            "sketchPlane" : zPlane(zOff + boss1H)
        });
        skCircle(skBoss2, "b2", {
            "center" : vector(-(e), 0 * millimeter),
            "radius" : bearIR - clr
        });
        skSolve(skBoss2);
        opExtrude(context, id + "extBoss2", {
            "entities"  : qCreatedBy(id + "skBoss2", EntityType.FACE),
            "direction" : vector(0, 0, 1),
            "endBound"  : BoundingType.BLIND,
            "endDepth"  : boss2H
        });
        // UNION 2 body: boss1 + boss2
        opBoolean(context, id + "boolBoss", {
            "tools"         : qUnion([
                                  qCreatedBy(id + "extBoss1", EntityType.BODY),
                                  qCreatedBy(id + "extBoss2", EntityType.BODY)
                              ]),
            "operationType" : BooleanOperationType.UNION
        });
    }

    // Body cam (extBoss1 = hasil merged setelah UNION kalau dual)
    var camBody = qCreatedBy(id + "extBoss1", EntityType.BODY);

    // ── Shaft hole PROFIL-D (port dari dShaftFitTest) ─────────────────────────
    // round part = shaftBoreDiameter; flat di (boreR - flatDepth) dari pusat.
    // flatDepth dihitung dari shaft NOMINAL motor supaya clearance flat == round.
    var boreR     = def.shaftBoreDiameter / 2;
    var flatDepth = def.shaftDia - def.shaftFlatDist;
    var isDee     = flatDepth > 0 * millimeter && flatDepth < 2 * boreR;
    var fo        = isDee ? (boreR - flatDepth) : 0 * millimeter;              // offset flat dari pusat
    var xj        = isDee ? sqrt(boreR * boreR - fo * fo) : 0 * millimeter;    // titik pertemuan flat-arc

    var skShaft = newSketchOnPlane(context, id + "skShaft", {
        "sketchPlane" : zPlane(zOff - ov)
    });
    if (isDee)
    {
        // D-profil = arc + flat (center di origin, flat di sisi +y)
        skArc(skShaft, "arc", {
            "start" : vector( xj, fo),
            "mid"   : vector(0 * millimeter, -boreR),
            "end"   : vector(-xj, fo)
        });
        skLineSegment(skShaft, "flat", {
            "start" : vector(-xj, fo),
            "end"   : vector( xj, fo)
        });
    }
    else
    {
        // Flat gak berlaku (flat dist >= shaft dia, mis. shaft bulat) -> bulat
        skCircle(skShaft, "h", {
            "center" : vector(0, 0) * millimeter,
            "radius" : boreR
        });
    }
    skSolve(skShaft);
    opExtrude(context, id + "extShaft", {
        "entities"  : qSketchRegion(id + "skShaft"),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : totalBH + 2 * ov
    });
    opBoolean(context, id + "boolShaft", {
        "tools"         : qCreatedBy(id + "extShaft", EntityType.BODY),
        "targets"       : camBody,
        "operationType" : BooleanOperationType.SUBTRACTION
    });

    // ── Mouse-ear relief di 2 sudut flat-arc (port dari dShaftFitTest) ────────
    // 2 lingkaran kecil r=earR persis di titik pertemuan flat-arc (±xj, fo).
    // Bikin printer FDM gak numpuk filament di sudut dalam -> shaft-D duduk
    // penuh. Cuma relevan kalau ada flat (isDee); toggle off = bentuk regular.
    if (isDee && def.shaftMouseEar)
    {
        var er = def.shaftEarRadius;
        var skEar = newSketchOnPlane(context, id + "skEar", {
            "sketchPlane" : zPlane(zOff - ov)
        });
        skCircle(skEar, "el", { "center" : vector(-xj, fo), "radius" : er });
        skCircle(skEar, "er", { "center" : vector( xj, fo), "radius" : er });
        skSolve(skEar);
        opExtrude(context, id + "extEar", {
            "entities"  : qSketchRegion(id + "skEar"),
            "direction" : vector(0, 0, 1),
            "endBound"  : BoundingType.BLIND,
            "endDepth"  : totalBH + 2 * ov
        });
        opBoolean(context, id + "boolEar", {
            "tools"         : qCreatedBy(id + "extEar", EntityType.BODY),
            "targets"       : camBody,
            "operationType" : BooleanOperationType.SUBTRACTION
        });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  BUILDER 4: OUTPUT HUB  (LEGACY_HUB mode; plate press-fit untuk pin rods)
// ════════════════════════════════════════════════════════════════════════════
function makeOutputHub(context is Context, id is Id, def is map)
{
    var Rr    = def.pinCircleRadius;
    var Rp    = def.pinRadius;
    var thick = def.diskThickness;
    var fl    = def.flangeThickness;
    var clr   = 0 * millimeter;   // semua dimensi nominal
    var wall  = def.wallThickness;
    var dual  = def.dualDisk;
    var dGap  = def.diskGap;
    var zOff  = def.zOffset;
    var nOut  = def.numOutputPins;
    var outPR = def.outputPinRadius;
    var outCR = def.outputPinCircleR;
    var diskR = Rr + Rp + clr + wall;
    var ringH = dual ? (2 * thick + dGap) : thick;
    var zHub  = zOff + fl + ringH;
    var ov    = 1 * millimeter;

    // ── Plate solid ───────────────────────────────────────────────────────────
    var sk = newSketchOnPlane(context, id + "sk", {
        "sketchPlane" : zPlane(zHub)
    });
    skCircle(sk, "outer", {
        "center" : vector(0, 0) * millimeter,
        "radius" : diskR
    });
    skSolve(sk);
    opExtrude(context, id + "hubExt", {
        "entities"  : qCreatedBy(id + "sk", EntityType.FACE),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : fl
    });
    var hubBody = qCreatedBy(id + "hubExt", EntityType.BODY);

    // ── N_out press-fit holes untuk output pin rods ───────────────────────────
    var skPins = newSketchOnPlane(context, id + "skPins", {
        "sketchPlane" : zPlane(zHub - ov)
    });
    for (var j = 0; j < nOut; j += 1)
    {
        var ang = (j * 360 / nOut) * degree;
        // Lubang = outPR NOMINAL + Output Pin Seat Clearance (default 0).
        // Mau press-fit? isi Output Pin Seat Clearance negatif (mis. -0.10).
        skCircle(skPins, "p" ~ toString(j), {
            "center" : vector(outCR * cos(ang), outCR * sin(ang)),
            "radius" : outPR + def.outputPinFitClearance / 2
        });
    }
    skSolve(skPins);
    opExtrude(context, id + "extPins", {
        "entities"  : qCreatedBy(id + "skPins", EntityType.FACE),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : fl + 2 * ov
    });
    opBoolean(context, id + "boolPins", {
        "tools"         : qCreatedBy(id + "extPins", EntityType.BODY),
        "targets"       : hubBody,
        "operationType" : BooleanOperationType.SUBTRACTION
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  BUILDER 5: BOTTOM BASE  (static carrier, NEMA17 mount)
// ════════════════════════════════════════════════════════════════════════════
/**
 * Plate statik di bawah disk stack. Z = zOff .. zOff+fl. Disk 1 duduk di atasnya.
 * Semua lubang di posisi NOMINAL (tanpa eccentric) karena base statik.
 *
 * Lubang:
 *   - center bore          : clearance NEMA17 pilot + cam base plate
 *   - 4 stepper holes      : pola kotak (NEMA17 = 31x31mm), tembus
 *   - N dowel seats        : ANCHOR press-fit (derived dari pin dia), tembus
 *   - N_bolt M3 clearance  : CLEAR fit, tembus
 *   - N_bolt hex nut pocket: di muka BAWAH
 */
function makeBottomBase(context is Context, id is Id, def is map)
{
    var fl      = def.flangeThickness;
    var zOff    = def.zOffset;
    var baseR   = def.baseOuterRadius;
    var boreR   = def.centerBoreRadius;
    var nDowel  = def.numOutputPins;
    var dowelHoleDia = def.dowelHoleDia;
    var dowelCR = def.outputPinCircleR;
    var ov      = 1 * millimeter;
    var zBot    = zOff;

    // ── Plate solid ──────────────────────────────────────────────────────────
    var skP = newSketchOnPlane(context, id + "skPlate", { "sketchPlane" : zPlane(zBot) });
    skCircle(skP, "o", { "center" : vector(0, 0) * millimeter, "radius" : baseR });
    skSolve(skP);
    opExtrude(context, id + "extPlate", {
        "entities"  : qCreatedBy(id + "skPlate", EntityType.FACE),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : fl
    });
    var body = qCreatedBy(id + "extPlate", EntityType.BODY);

    // ── Center bore (through) ──────────────────────────────────────────────────
    var skB = newSketchOnPlane(context, id + "skBore", { "sketchPlane" : zPlane(zBot - ov) });
    skCircle(skB, "b", { "center" : vector(0, 0) * millimeter, "radius" : boreR });
    skSolve(skB);
    opExtrude(context, id + "extBore", {
        "entities"  : qCreatedBy(id + "skBore", EntityType.FACE),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : fl + 2 * ov
    });
    opBoolean(context, id + "boolBore", {
        "tools" : qCreatedBy(id + "extBore", EntityType.BODY),
        "targets" : body, "operationType" : BooleanOperationType.SUBTRACTION
    });

    // ── Dowel seats (ANCHOR press-fit, through) ────────────────────────────────
    var skD = newSketchOnPlane(context, id + "skDowel", { "sketchPlane" : zPlane(zBot - ov) });
    for (var j = 0; j < nDowel; j += 1)
    {
        var a = (j * 360 / nDowel) * degree;
        skCircle(skD, "d" ~ toString(j), {
            "center" : vector(dowelCR * cos(a), dowelCR * sin(a)),
            "radius" : dowelHoleDia / 2
        });
    }
    skSolve(skD);
    opExtrude(context, id + "extDowel", {
        "entities"  : qCreatedBy(id + "skDowel", EntityType.FACE),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : fl + 2 * ov
    });
    opBoolean(context, id + "boolDowel", {
        "tools" : qCreatedBy(id + "extDowel", EntityType.BODY),
        "targets" : body, "operationType" : BooleanOperationType.SUBTRACTION
    });

    // ── M3 clearance holes (through) -- toggle: Add Base Bolts ─────────────────
    if (def.useBaseBolts)
    {
        var nBolt  = def.numBaseBolts;
        var boltR  = def.baseBoltRadius;
        var boltCR = def.baseBoltCircleR;
        var skM = newSketchOnPlane(context, id + "skM3", { "sketchPlane" : zPlane(zBot - ov) });
        for (var j = 0; j < nBolt; j += 1)
        {
            var a = (j * 360 / nBolt + def.baseBoltAngleDeg) * degree;
            // Lubang M3 = boltR NOMINAL + M3 Bolt Hole Clearance (default 0).
            skCircle(skM, "m" ~ toString(j), {
                "center" : vector(boltCR * cos(a), boltCR * sin(a)),
                "radius" : boltR + def.m3FitClearance / 2
            });
        }
        skSolve(skM);
        opExtrude(context, id + "extM3", {
            "entities"  : qCreatedBy(id + "skM3", EntityType.FACE),
            "direction" : vector(0, 0, 1),
            "endBound"  : BoundingType.BLIND,
            "endDepth"  : fl + 2 * ov
        });
        opBoolean(context, id + "boolM3", {
            "tools" : qCreatedBy(id + "extM3", EntityType.BODY),
            "targets" : body, "operationType" : BooleanOperationType.SUBTRACTION
        });

        // ── Hex nut pockets di muka BAWAH -- toggle: Add Hex Nut Pockets ────────
        // Sepasang sama lubang M3 di atas (posisi sama, boltCR/baseBoltAngleDeg);
        // butuh Base Bolts ON dulu (gak ada artinya tanpa lubang bautnya).
        if (def.useNutPockets)
        {
            var nutAF   = def.nutAcrossFlats;
            var nutD    = def.nutPocketDepth;
            var hexCirc = (nutAF / 2) / cos(30 * degree);
            var skN = newSketchOnPlane(context, id + "skNut", { "sketchPlane" : zPlane(zBot - ov) });
            for (var j = 0; j < nBolt; j += 1)
            {
                var a  = (j * 360 / nBolt + def.baseBoltAngleDeg) * degree;
                var cx = boltCR * cos(a);
                var cy = boltCR * sin(a);
                var v = [];
                for (var k = 0; k < 6; k += 1)
                {
                    var ha = (60 * k + 30) * degree;
                    v = append(v, vector(cx + hexCirc * cos(ha), cy + hexCirc * sin(ha)));
                }
                for (var k = 0; k < 6; k += 1)
                {
                    var nxt = (k + 1 == 6) ? 0 : k + 1;
                    skLineSegment(skN, "n" ~ toString(j) ~ "_" ~ toString(k), {
                        "start" : v[k],
                        "end"   : v[nxt]
                    });
                }
            }
            skSolve(skN);
            opExtrude(context, id + "extNut", {
                "entities"  : qSketchRegion(id + "skNut"),
                "direction" : vector(0, 0, 1),
                "endBound"  : BoundingType.BLIND,
                "endDepth"  : nutD + ov
            });
            opBoolean(context, id + "boolNut", {
                "tools" : qCreatedBy(id + "extNut", EntityType.BODY),
                "targets" : body, "operationType" : BooleanOperationType.SUBTRACTION
            });
        }
    }

    // ── Stepper bolt holes (kotak pattern, through) -- toggle: Add Stepper ─────
    // Mounting Holes. Independen dari Base Bolts (posisi & fungsi beda).
    if (def.useStepperHoles)
    {
        var stepR  = def.stepperHoleRadius;
        var stepSq = def.stepperSquare;
        var hs = stepSq / 2;
        var sx = [hs, -hs, -hs, hs];
        var sy = [hs,  hs, -hs, -hs];
        var skS = newSketchOnPlane(context, id + "skStep", { "sketchPlane" : zPlane(zBot - ov) });
        for (var j = 0; j < 4; j += 1)
        {
            skCircle(skS, "s" ~ toString(j), {
                "center" : vector(sx[j], sy[j]),
                "radius" : stepR
            });
        }
        skSolve(skS);
        opExtrude(context, id + "extStep", {
            "entities"  : qCreatedBy(id + "skStep", EntityType.FACE),
            "direction" : vector(0, 0, 1),
            "endBound"  : BoundingType.BLIND,
            "endDepth"  : fl + 2 * ov
        });
        opBoolean(context, id + "boolStep", {
            "tools" : qCreatedBy(id + "extStep", EntityType.BODY),
            "targets" : body, "operationType" : BooleanOperationType.SUBTRACTION
        });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  BUILDER 6: TOP BASE  (static carrier, dowel + bolt lock)
// ════════════════════════════════════════════════════════════════════════════
/**
 * Plate statik di atas disk stack. Z = zOff+fl+ringH .. +fl. Mengunci ujung
 * atas dowel (LOCATE fit) + baut M3. Tanpa stepper holes / nut pocket.
 * Harus muat DI DALAM ring Top Roller Cover (auto layout jamin gap-nya).
 */
function makeTopBase(context is Context, id is Id, def is map)
{
    var fl      = def.flangeThickness;
    var zOff    = def.zOffset;
    var baseR   = def.baseOuterRadius;
    var boreR   = def.centerBoreRadius;
    var nDowel  = def.numOutputPins;
    var dowelHoleDia = def.dowelHoleDia;
    var dowelCR = def.outputPinCircleR;
    var dual    = def.dualDisk;
    var thick   = def.diskThickness;
    var dGap    = def.diskGap;
    var ringH   = dual ? (2 * thick + dGap) : thick;
    var ov      = 1 * millimeter;
    var zTop    = zOff + fl + ringH;

    // ── Plate solid ──────────────────────────────────────────────────────────
    var skP = newSketchOnPlane(context, id + "skPlate", { "sketchPlane" : zPlane(zTop) });
    skCircle(skP, "o", { "center" : vector(0, 0) * millimeter, "radius" : baseR });
    skSolve(skP);
    opExtrude(context, id + "extPlate", {
        "entities"  : qCreatedBy(id + "skPlate", EntityType.FACE),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : fl
    });
    var body = qCreatedBy(id + "extPlate", EntityType.BODY);

    // ── Center bore (through) ──────────────────────────────────────────────────
    var skB = newSketchOnPlane(context, id + "skBore", { "sketchPlane" : zPlane(zTop - ov) });
    skCircle(skB, "b", { "center" : vector(0, 0) * millimeter, "radius" : boreR });
    skSolve(skB);
    opExtrude(context, id + "extBore", {
        "entities"  : qCreatedBy(id + "skBore", EntityType.FACE),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : fl + 2 * ov
    });
    opBoolean(context, id + "boolBore", {
        "tools" : qCreatedBy(id + "extBore", EntityType.BODY),
        "targets" : body, "operationType" : BooleanOperationType.SUBTRACTION
    });

    // ── Dowel seats (LOCATE fit, through) ──────────────────────────────────────
    var skD = newSketchOnPlane(context, id + "skDowel", { "sketchPlane" : zPlane(zTop - ov) });
    for (var j = 0; j < nDowel; j += 1)
    {
        var a = (j * 360 / nDowel) * degree;
        skCircle(skD, "d" ~ toString(j), {
            "center" : vector(dowelCR * cos(a), dowelCR * sin(a)),
            "radius" : dowelHoleDia / 2
        });
    }
    skSolve(skD);
    opExtrude(context, id + "extDowel", {
        "entities"  : qCreatedBy(id + "skDowel", EntityType.FACE),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : fl + 2 * ov
    });
    opBoolean(context, id + "boolDowel", {
        "tools" : qCreatedBy(id + "extDowel", EntityType.BODY),
        "targets" : body, "operationType" : BooleanOperationType.SUBTRACTION
    });

    // ── M3 clearance holes (through) -- toggle: Add Base Bolts ─────────────────
    if (def.useBaseBolts)
    {
        var nBolt  = def.numBaseBolts;
        var boltR  = def.baseBoltRadius;
        var boltCR = def.baseBoltCircleR;
        var skM = newSketchOnPlane(context, id + "skM3", { "sketchPlane" : zPlane(zTop - ov) });
        for (var j = 0; j < nBolt; j += 1)
        {
            var a = (j * 360 / nBolt + def.baseBoltAngleDeg) * degree;
            // Lubang M3 = boltR NOMINAL + M3 Bolt Hole Clearance (default 0).
            skCircle(skM, "m" ~ toString(j), {
                "center" : vector(boltCR * cos(a), boltCR * sin(a)),
                "radius" : boltR + def.m3FitClearance / 2
            });
        }
        skSolve(skM);
        opExtrude(context, id + "extM3", {
            "entities"  : qCreatedBy(id + "skM3", EntityType.FACE),
            "direction" : vector(0, 0, 1),
            "endBound"  : BoundingType.BLIND,
            "endDepth"  : fl + 2 * ov
        });
        opBoolean(context, id + "boolM3", {
            "tools" : qCreatedBy(id + "extM3", EntityType.BODY),
            "targets" : body, "operationType" : BooleanOperationType.SUBTRACTION
        });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  BUILDER 7: TOP ROLLER COVER  (ring; nahan ujung ATAS roller dowel)
// ════════════════════════════════════════════════════════════════════════════
/**
 * Ring sejajar Top Base (konsentris: top base di dalam, ring cover di luar).
 * Duduk di ATAS housing. Nahan ujung ATAS roller dowel (LOCATE fit); housing
 * flange nahan ujung bawah. Baut M3 CLEARANCE lewat lug nonjol -> lug housing.
 */
function makeTopRollerCover(context is Context, id is Id, def is map)
{
    var N      = def.numPins;
    var Rr     = def.pinCircleRadius;
    var Rp     = def.pinRadius;
    var fl     = def.flangeThickness;
    var thick  = def.diskThickness;
    var dual   = def.dualDisk;
    var dGap   = def.diskGap;
    var zOff   = def.zOffset;
    var outR   = def.coverOuterRadius;
    var innR   = def.ringInnerR;
    var ringH  = dual ? (2 * thick + dGap) : thick;
    var zTop   = zOff + fl + ringH;
    var ov     = 1 * millimeter;

    // ── Ring plate solid ─────────────────────────────────────────────────────
    var skP = newSketchOnPlane(context, id + "skP", { "sketchPlane" : zPlane(zTop) });
    skCircle(skP, "o", { "center" : vector(0, 0) * millimeter, "radius" : outR });
    skSolve(skP);
    opExtrude(context, id + "extP", {
        "entities"  : qCreatedBy(id + "skP", EntityType.FACE),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : fl
    });
    var body = qCreatedBy(id + "extP", EntityType.BODY);

    // ── Center bore (ring inner, clearance top base statik) ──────────────────
    var skB = newSketchOnPlane(context, id + "skBore", { "sketchPlane" : zPlane(zTop - ov) });
    skCircle(skB, "b", { "center" : vector(0, 0) * millimeter, "radius" : innR });
    skSolve(skB);
    opExtrude(context, id + "extBore", {
        "entities"  : qCreatedBy(id + "skBore", EntityType.FACE),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : fl + 2 * ov
    });
    opBoolean(context, id + "boolBore", {
        "tools"         : qCreatedBy(id + "extBore", EntityType.BODY),
        "targets"       : body,
        "operationType" : BooleanOperationType.SUBTRACTION
    });

    // ── N roller-top holes (Rp NOMINAL + Roller Pin Hole Clearance) ──────────
    var skR = newSketchOnPlane(context, id + "skRoll", { "sketchPlane" : zPlane(zTop - ov) });
    for (var i = 0; i < N; i += 1)
    {
        var a = (i * 360 / N) * degree;
        skCircle(skR, "r" ~ toString(i), {
            "center" : vector(Rr * cos(a), Rr * sin(a)),
            "radius" : Rp + def.rollerFitClearance / 2
        });
    }
    skSolve(skR);
    opExtrude(context, id + "extRoll", {
        "entities"  : qCreatedBy(id + "skRoll", EntityType.FACE),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : fl + 2 * ov
    });
    opBoolean(context, id + "boolRoll", {
        "tools"         : qCreatedBy(id + "extRoll", EntityType.BODY),
        "targets"       : body,
        "operationType" : BooleanOperationType.SUBTRACTION
    });

    // ── Bolt lugs (M3 CLEARANCE; baut narik cover rapet ke housing) ──────────
    if (def.useCoverBolts)
    {
        var cbNomR  = 1.5 * millimeter;                 // M3 nominal
        var cbWall  = def.coverBoltWall;
        var cbHoleR = cbNomR + def.m3FitClearance / 2;  // nominal + M3 clearance
        addBoltLugs(context, id + "covLug", {
            "count"      : def.coverBoltCount,
            "boltCR"     : def.coverBoltCircleR,
            "capR"       : cbHoleR + cbWall,
            "holeR"      : cbHoleR,
            "ringOuterR" : outR,
            "zBase"      : zTop,
            "height"     : fl,
            "body"       : body
        });
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  THE FEATURE: CYCLOIDAL DRIVE - ALL PARTS  (satu feature, semua komponen)
// ════════════════════════════════════════════════════════════════════════════
annotation { "Feature Type Name" : "Cycloidal Drive - All Parts" }
export const cycloidalDrive = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Group Name" : "Architecture", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Output Mode" }
            definition.outputMode is CycloOutputMode;
        }

        annotation { "Group Name" : "Parts to Generate", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Housing", "Default" : true }
            definition.genHousing is boolean;

            annotation { "Name" : "Cycloid Disk(s)", "Default" : true }
            definition.genDisks is boolean;

            annotation { "Name" : "Input Cam", "Default" : true }
            definition.genCam is boolean;

            if (definition.outputMode == CycloOutputMode.HOUSING_OUTPUT)
            {
                annotation { "Name" : "Bottom Base (NEMA mount)", "Default" : true }
                definition.genBottomBase is boolean;

                annotation { "Name" : "Top Base", "Default" : true }
                definition.genTopBase is boolean;

                annotation { "Name" : "Top Roller Cover", "Default" : true }
                definition.genCover is boolean;
            }
            else
            {
                annotation { "Name" : "Output Hub (legacy)", "Default" : true }
                definition.genHub is boolean;
            }
        }

        annotation { "Group Name" : "Gear Parameters", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Ring Pin Count N (ratio: N:1 housing-out / N-1:1 hub-out)" }
            isInteger(definition.numPins,
                      { (unitless) : [6, 25, 100] } as IntegerBoundSpec);

            annotation { "Name" : "Pin Circle Diameter Dr" }
            isLength(definition.pinCircleDiameter,
                     { (millimeter) : [30, 76, 300] } as LengthBoundSpec);

            annotation { "Name" : "Pin/Roller Diameter Dp (rod 3.97mm)" }
            isLength(definition.pinDiameter,
                     { (millimeter) : [2.0, 3.97, 10.0] } as LengthBoundSpec);

            annotation { "Name" : "Auto Eccentricity (0.75 x Rr/N, di-cap cavity)", "Default" : true }
            definition.autoEccentricity is boolean;

            if (!definition.autoEccentricity)
            {
                annotation { "Name" : "Eccentricity e (max = Rr/N)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.eccentricity,
                         { (millimeter) : [0.3, 1.0, 5.0] } as LengthBoundSpec);
            }
        }

        annotation { "Group Name" : "Stack, Bearing, Motor", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Disk Thickness" }
            isLength(definition.diskThickness,
                     { (millimeter) : [4, 6, 30] } as LengthBoundSpec);

            annotation { "Name" : "Flange / Plate Thickness (semua plate)" }
            isLength(definition.flangeThickness,
                     { (millimeter) : [2, 5, 15] } as LengthBoundSpec);

            annotation { "Name" : "Wall Thickness" }
            isLength(definition.wallThickness,
                     { (millimeter) : [1, 2, 15] } as LengthBoundSpec);

            annotation { "Name" : "Eccentric Bearing" }
            definition.eccBearing is EccBearingType;

            annotation { "Name" : "Motor Type" }
            definition.motorType is MotorType;

            annotation { "Name" : "Input Cam D-Bore Diameter (round part; preset 5.14 = NEMA17 5mm fit)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.shaftBoreDiameter,
                     { (millimeter) : [2.0, 5.14, 12.0] } as LengthBoundSpec);

            annotation { "Name" : "Input Cam D-Flat Dist (flat->tepi seberang shaft; >= shaft dia = bulat)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.shaftFlatDist,
                     { (millimeter) : [2.0, 4.5, 12.0] } as LengthBoundSpec);

            annotation { "Name" : "Input Cam Mouse-Ear Relief (relief sudut flat-arc; kompensasi FDM)", "Default" : true }
            definition.shaftMouseEar is boolean;

            if (definition.shaftMouseEar)
            {
                annotation { "Name" : "    Mouse-Ear Radius", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.shaftEarRadius,
                         { (millimeter) : [0.05, 0.25, 1.0] } as LengthBoundSpec);
            }

            annotation { "Name" : "Dual Disk (2x disks, 180 deg phase)", "Default" : true }
            definition.dualDisk is boolean;

            annotation { "Name" : "Disk Gap (cavity extra height)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.diskGap,
                     { (millimeter) : [0.2, 1.0, 5.0] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Output Dowels & Base Bolts", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Output Pin Count" }
            isInteger(definition.numOutputPins,
                      { (unitless) : [3, 6, 12] } as IntegerBoundSpec);

            annotation { "Name" : "Output Pin Diameter (dowel 5mm)" }
            isLength(definition.outputPinDiameter,
                     { (millimeter) : [2.0, 5.0, 12.0] } as LengthBoundSpec);

            annotation { "Name" : "Output Pin Running Clearance (dia; hole = pin + 2e + this)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.outputPinClearance,
                     { (millimeter) : [0.0, 0.3, 1.5] } as LengthBoundSpec);

            annotation { "Name" : "Add Base Bolts (join Bottom<->Top Base thru Disk; M3 holes)", "Default" : true }
            definition.useBaseBolts is boolean;

            if (definition.useBaseBolts)
            {
                annotation { "Name" : "Base Bolt Count (kalau layout 1-ring: samakan dgn pin count)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isInteger(definition.numBaseBolts,
                          { (unitless) : [2, 4, 12] } as IntegerBoundSpec);

                annotation { "Name" : "Base Bolt Nominal Diameter (M3 3mm)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.baseBoltDiameter,
                         { (millimeter) : [2.0, 3.0, 8.0] } as LengthBoundSpec);

                annotation { "Name" : "Bolt Hole Clearance (non-contact, beyond orbit)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.boltHoleClearance,
                         { (millimeter) : [0.2, 0.6, 2.0] } as LengthBoundSpec);
            }
        }

        annotation { "Group Name" : "Layout (auto; centang override per-dimensi)", "Collapsed By Default" : false }
        {
            // v5.1: GAK ADA lagi saklar "Auto Layout" all-or-nothing. Semua circle
            // & bore SELALU diturunkan dari geometri inti. Yang mau kamu pegang
            // sendiri tinggal dicentang -- sisanya tetap ngikut. Jadi override
            // Output Pin Circle doang gak bikin base plate / flange bore / cover
            // ring lepas ke default statis yang saling bentrok (bug UX v5.0).
            annotation { "Name" : "Base<->Ring Radial Gap (plate statik vs flange/cover muter)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.plateRingGap,
                     { (millimeter) : [0.3, 2.0, 8.0] } as LengthBoundSpec);

            // Dulu hard-coded 1.6mm. Ini yang nentuin ketat/longgarnya validator,
            // jadi harus bisa diturunin kalau printer/proses-mu sanggup.
            annotation { "Name" : "Minimum Web (material tersisa antar lubang)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.minWeb,
                     { (millimeter) : [0.4, 1.6, 5.0] } as LengthBoundSpec);

            annotation { "Name" : "Print Layout Report (nilai efektif + range legal tiap dimensi)", "Default" : true }
            definition.showLayoutReport is boolean;

            annotation { "Name" : "Override Output Pin Circle" }
            definition.ovrPinCircle is boolean;

            if (definition.ovrPinCircle)
            {
                annotation { "Name" : "    Output Pin Circle Diameter", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.outputPinCircleDiameter,
                         { (millimeter) : [10, 52, 200] } as LengthBoundSpec);
            }

            if (definition.useBaseBolts)
            {
                annotation { "Name" : "Override Base Bolt Circle" }
                definition.ovrBoltCircle is boolean;

                if (definition.ovrBoltCircle)
                {
                    annotation { "Name" : "    Base Bolt Circle Diameter", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                    isLength(definition.baseBoltCircleDiameter,
                             { (millimeter) : [10, 34, 160] } as LengthBoundSpec);
                }
            }

            annotation { "Name" : "Override Cam Boss Thickness" }
            definition.ovrBoss is boolean;

            if (definition.ovrBoss)
            {
                annotation { "Name" : "    Boss 1 Thickness", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.boss1Thickness,
                         { (millimeter) : [3, 11, 30] } as LengthBoundSpec);

                if (definition.dualDisk)
                {
                    annotation { "Name" : "    Boss 2 Thickness", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                    isLength(definition.boss2Thickness,
                             { (millimeter) : [3, 6.3, 30] } as LengthBoundSpec);
                }
            }

            annotation { "Name" : "Override Flange Ring Inner Diameter" }
            definition.ovrFlangeBore is boolean;

            if (definition.ovrFlangeBore)
            {
                annotation { "Name" : "    Flange Ring Inner Diameter", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.flangeRingInnerDiameter,
                         { (millimeter) : [10, 27, 200] } as LengthBoundSpec);
            }

            if (definition.outputMode == CycloOutputMode.HOUSING_OUTPUT)
            {
                // Bottom & top base DIPISAH (v5.0 nyatuin keduanya ke satu angka;
                // itu bikin bottom ikut kegedean gara-gara top, terus flange bore
                // kejepit). Rantai constraint-nya beda: bottom vs flange bore,
                // top vs cover ring.
                annotation { "Name" : "Override Bottom Base Plate Diameter" }
                definition.ovrBottomBase is boolean;

                if (definition.ovrBottomBase)
                {
                    annotation { "Name" : "    Bottom Base Plate Diameter", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                    isLength(definition.basePlateDiameter,
                             { (millimeter) : [30, 90, 200] } as LengthBoundSpec);
                }

                annotation { "Name" : "Override Top Base Plate Diameter" }
                definition.ovrTopBase is boolean;

                if (definition.ovrTopBase)
                {
                    annotation { "Name" : "    Top Base Plate Diameter", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                    isLength(definition.topPlateDiameter,
                             { (millimeter) : [30, 90, 200] } as LengthBoundSpec);
                }

                annotation { "Name" : "Override Bottom Base Center Bore" }
                definition.ovrBottomBore is boolean;

                if (definition.ovrBottomBore)
                {
                    annotation { "Name" : "    Bottom Base Center Bore Diameter", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                    isLength(definition.bottomBoreDiameter,
                             { (millimeter) : [8, 23, 60] } as LengthBoundSpec);
                }

                annotation { "Name" : "Override Top Base Center Bore" }
                definition.ovrTopBore is boolean;

                if (definition.ovrTopBore)
                {
                    annotation { "Name" : "    Top Base Center Bore Diameter", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                    isLength(definition.topBoreDiameter,
                             { (millimeter) : [6, 16, 60] } as LengthBoundSpec);
                }

                annotation { "Name" : "Override Cover Outer Diameter" }
                definition.ovrCoverOuter is boolean;

                if (definition.ovrCoverOuter)
                {
                    annotation { "Name" : "    Cover Outer Diameter", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                    isLength(definition.coverOuterDiameter,
                             { (millimeter) : [40, 84, 200] } as LengthBoundSpec);
                }

                annotation { "Name" : "Override Cover Ring Inner Diameter" }
                definition.ovrCoverRing is boolean;

                if (definition.ovrCoverRing)
                {
                    annotation { "Name" : "    Cover Ring Inner Diameter", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                    isLength(definition.coverRingInnerDiameter,
                             { (millimeter) : [20, 66, 180] } as LengthBoundSpec);
                }
            }
        }

        annotation { "Group Name" : "Fit / Tolerance (diametral; 0 = nominal, no auto-add)", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Disk Fit Adjustment (+tighter / -looser, per side)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.diskFitAdjustment,
                     { (millimeter) : [-0.5, 0.0, 0.5] } as LengthBoundSpec);

            annotation { "Name" : "Roller Pin Hole Clearance (dia; housing+cover; - = press)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.rollerFitClearance,
                     { (millimeter) : [-1.0, 0.0, 1.0] } as LengthBoundSpec);

            annotation { "Name" : "Output Pin Seat Clearance (dia; base seats / hub; - = press)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.outputPinFitClearance,
                     { (millimeter) : [-1.0, 0.0, 1.0] } as LengthBoundSpec);

            annotation { "Name" : "M3 Bolt Hole Clearance (dia; all M3 thru-holes; - = press)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.m3FitClearance,
                     { (millimeter) : [-1.0, 0.0, 1.0] } as LengthBoundSpec);
        }

        if (definition.outputMode == CycloOutputMode.HOUSING_OUTPUT)
        {
            annotation { "Group Name" : "Stepper Mount & Nuts (Bottom Base)", "Collapsed By Default" : true }
            {
                annotation { "Name" : "Add Stepper Mounting Holes", "Default" : true }
                definition.useStepperHoles is boolean;

                if (definition.useStepperHoles)
                {
                    annotation { "Name" : "Stepper Bolt Square (NEMA17 = 31mm)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                    isLength(definition.stepperSquare,
                             { (millimeter) : [20, 31, 50] } as LengthBoundSpec);

                    annotation { "Name" : "Stepper Bolt Hole Diameter (M3 grip 3.10)" }
                    isLength(definition.stepperBoltHoleDiameter,
                             { (millimeter) : [2.0, 3.1, 6.0] } as LengthBoundSpec);
                }

                if (definition.useBaseBolts)
                {
                    annotation { "Name" : "Add Hex Nut Pockets (bottom face; pairs w/ Base Bolt holes)", "Default" : true }
                    definition.useNutPockets is boolean;

                    if (definition.useNutPockets)
                    {
                        annotation { "Name" : "Nut Pocket Across-Flats (M3 nut -> 5.55mm)" }
                        isLength(definition.nutAcrossFlats,
                                 { (millimeter) : [4, 5.55, 12] } as LengthBoundSpec);

                        annotation { "Name" : "Nut Pocket Depth" }
                        isLength(definition.nutPocketDepth,
                                 { (millimeter) : [1, 2.6, 6] } as LengthBoundSpec);
                    }
                }
            }

            annotation { "Group Name" : "Cover Bolts (housing <-> cover)", "Collapsed By Default" : true }
            {
                annotation { "Name" : "Add Cover Bolt Lugs", "Default" : true }
                definition.useCoverBolts is boolean;

                if (definition.useCoverBolts)
                {
                    annotation { "Name" : "Cover Bolt Count", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                    isInteger(definition.coverBoltCount,
                              { (unitless) : [2, 6, 12] } as IntegerBoundSpec);

                    annotation { "Name" : "Cover Bolt Lug Wall (around hole)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                    isLength(definition.coverBoltWall,
                             { (millimeter) : [1, 2, 5] } as LengthBoundSpec);

                    annotation { "Name" : "Cover Bolt Boss Height (grip depth from top)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                    isLength(definition.coverBoltBossHeight,
                             { (millimeter) : [3, 10, 25] } as LengthBoundSpec);

                    // Override-nya ditaruh di sini (bukan grup Layout) karena
                    // definition.useCoverBolts baru dideklarasi di grup ini.
                    annotation { "Name" : "Override Cover Bolt Circle Diameter" }
                    definition.ovrCoverBoltCircle is boolean;

                    if (definition.ovrCoverBoltCircle)
                    {
                        annotation { "Name" : "    Cover Bolt Circle Diameter", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                        isLength(definition.coverBoltCircleDiameter,
                                 { (millimeter) : [40, 94, 220] } as LengthBoundSpec);
                    }
                }
            }
        }

        annotation { "Group Name" : "Assembly Placement", "Collapsed By Default" : true }
        {
            annotation { "Name" : "Z Offset (shift assembly up/down)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.zOffset,
                     { (millimeter) : [-200, 0, 200] } as LengthBoundSpec);
        }
    }
    {
        // ── 0. Resolve enum & konversi dasar ─────────────────────────────────
        var bSpec = resolveBearing(definition.eccBearing);
        definition.eccBearingInner = bSpec.eccBearingInner;
        definition.eccBearingOuter = bSpec.eccBearingOuter;
        definition.eccBearingWidth = bSpec.eccBearingWidth;
        definition.shaftDia        = resolveShaft(definition.motorType);

        var housingMode = (definition.outputMode == CycloOutputMode.HOUSING_OUTPUT);
        var useBolts = definition.useBaseBolts;     // master toggle: base bolts + M3 holes + hex pockets
        var N     = definition.numPins;
        var Rr    = definition.pinCircleDiameter / 2;
        var Rp    = definition.pinDiameter / 2;
        var outPR = definition.outputPinDiameter / 2;
        var eccOR = definition.eccBearingOuter / 2;
        var eccIR = definition.eccBearingInner / 2;
        var bearW = definition.eccBearingWidth;
        var fl    = definition.flangeThickness;
        var wall  = definition.wallThickness;
        var thick = definition.diskThickness;
        var dual  = definition.dualDisk;
        var nOut  = definition.numOutputPins;
        var WEB   = definition.minWeb;              // web material minimum antar lubang (param user)
        var ringH = dual ? (2 * thick + definition.diskGap) : thick;
        var outR  = Rr + Rp + wall;                 // OD housing

        // Semua konflik dimensi dikumpulin di sini dan dilaporin SEKALI di akhir
        // (v5.0 report-and-return per cek -> betulin satu, muncul yg berikutnya).
        var problems = [];

        // mbR/nBolt cuma valid (dan cuma dibaca dari UI) saat useBolts ON --
        // fallback 0 dipakai buat sizing/layout math biar aman dibaca di mana pun.
        var mbR   = 0 * millimeter;
        var nBolt = 0;
        if (useBolts)
        {
            mbR   = definition.baseBoltDiameter / 2;
            nBolt = definition.numBaseBolts;
        }

        definition.pinCircleRadius = Rr;
        definition.pinRadius       = Rp;
        definition.outputPinRadius = outPR;
        definition.baseBoltRadius  = mbR;

        // ── 1. Eccentricity (auto / manual) + validasi ───────────────────────
        // eMaxUndercut : >= ini profil hypotrochoid self-intersect (loop).
        // eMaxCavity   : >= ini jangkauan orbit disk (Rr+2e-Rp) mepet/nabrak
        //                cavity wall housing (cavR = Rr+Rp-e); sisa clearance
        //                = 2*Rp - 3*e, minimal 0.4mm buat FDM.
        var eMaxUndercut = Rr / N;
        var eMaxCavity   = (2 * Rp - 0.4 * millimeter) / 3;
        var e = definition.autoEccentricity
                ? min(0.75 * eMaxUndercut, eMaxCavity)
                : definition.eccentricity;

        var maxSafeE = (definition.eccBearingOuter - definition.eccBearingInner) / 4;

        // e ikut nentuin SEMUA radius lubang di bawah -- kalau dia invalid, angka
        // layout hasilnya ngawur. Jadi tiga cek ini dikumpulin bareng lalu
        // langsung return, gak diteruskan ke validasi layout.
        if (e >= eMaxUndercut)
            problems = append(problems,
                "Eccentricity e=" ~ mmStr(e) ~ " >= Rr/N=" ~ mmStr(eMaxUndercut) ~
                ". Profil bakal self-intersect. Pakai e < " ~ mmStr(eMaxUndercut) ~ ".");
        if (e > eMaxCavity)
            problems = append(problems,
                "Eccentricity e=" ~ mmStr(e) ~ " kegedean utk pin dia " ~ mmStr(2 * Rp) ~
                " -- disk bakal ngegesek cavity wall housing (clearance = 2*Rp-3*e = " ~
                mmStr(2 * Rp - 3 * e) ~ "). Max e = " ~ mmStr(eMaxCavity) ~
                ", atau perbesar Pin/Roller Diameter.");
        if (e > maxSafeE)
            problems = append(problems,
                "Eccentricity e=" ~ mmStr(e) ~ " terlalu besar utk bearing ini. Max aman ~" ~
                mmStr(maxSafeE) ~ ".");

        if (size(problems) > 0)
        {
            var eMsg = "Eccentricity gak valid (" ~ toString(size(problems)) ~ " masalah):";
            for (var i = 0; i < size(problems); i += 1)
                eMsg = eMsg ~ "\n" ~ toString(i + 1) ~ ") " ~ problems[i];
            eMsg = eMsg ~ "\nMax e yang aman utk config ini = " ~
                   mmStr(min(min(eMaxUndercut, eMaxCavity), maxSafeE)) ~ ".";
            reportFeatureError(context, id, eMsg);
            return;
        }
        definition.eccentricity = e;

        // ── 2. Layout radial disk: base-bolt ring + output-pin ring ──────────
        // Band tersedia: [bearing bore eccOR] .. [root lobe rootR], dikurangi WEB.
        // useBolts=false -> ring base-bolt GAK direservasi sama sekali (Disk cuma
        // butuh muat lubang output pin) -> band jauh lebih longgar / Dr bisa lebih
        // kecil. rMb=0 dipakai sbg placeholder aman di rumus drMin*.
        var rootR    = Rr - e - Rp;                                    // valley lobe (setelah offset pin)
        var rHole    = outPR + e + definition.outputPinClearance / 2;  // r lubang output pin di disk
        var rMb      = 0 * millimeter;                                 // r lubang base bolt di disk
        if (useBolts)
            rMb = mbR + e + definition.boltHoleClearance;
        var innerLim = eccOR + WEB;
        var outerLim = rootR - WEB;
        var drMin2    = 2 * (eccOR + 3 * WEB + 2 * rMb + 2 * rHole + e + Rp);
        var drMin1    = 2 * (eccOR + 2 * WEB + 2 * max(rHole, rMb) + e + Rp);
        var drMinNoMb = 2 * (eccOR + 2 * WEB + 2 * rHole + e + Rp);

        // ── 2a. Kandidat AUTO (selalu dihitung, dipakai/enggak) ──────────────
        // Dihitung duluan tanpa report supaya (a) nilainya bisa dipakai sebagai
        // fallback per-dimensi, (b) bisa ditampilkan di layout report sebagai
        // titik balik kalau override-mu nyasar.
        var autoPinCR      = 0 * millimeter;
        var autoBoltCR     = 0 * millimeter;
        var autoFail       = "";   // "" = auto layout ketemu solusi

        if (!useBolts)
        {
            // Base Bolts OFF: satu ring, cuma output pin, di tengah band penuh.
            var pinMin0 = innerLim + rHole;
            var pinMax0 = outerLim - rHole;
            if (pinMin0 <= pinMax0)
            {
                autoPinCR = (pinMin0 + pinMax0) / 2;
            }
            else
            {
                autoPinCR = pinMin0;
                autoFail  = "Dr " ~ mmStr(2 * Rr) ~ " terlalu kecil: lubang output pin gak muat di " ~
                            "sekeliling bearing " ~ mmStr(2 * eccOR) ~ ". Butuh Dr >= ~" ~
                            mmStr(drMinNoMb) ~ ", atau kecilkan Output Pin Diameter.";
            }
            autoBoltCR = autoPinCR;   // gak dipakai buat drilling saat useBolts off
        }
        else
        {
            // 2-ring: [bearing] web [bolt ring] web [pin ring] web [root]
            var boltCR2 = innerLim + rMb;
            var pinMin  = boltCR2 + rMb + WEB + rHole;
            var pinMax  = outerLim - rHole;
            if (pinMin <= pinMax)
            {
                autoBoltCR = boltCR2;
                autoPinCR  = (pinMin + pinMax) / 2;
            }
            else if (nBolt == nOut &&
                     innerLim + max(rHole, rMb) <= outerLim - max(rHole, rMb))
            {
                // Fallback 1-ring: pin & bolt selang-seling di radius sama.
                autoPinCR  = (innerLim + outerLim) / 2;
                autoBoltCR = autoPinCR;
            }
            else
            {
                autoBoltCR = boltCR2;
                autoPinCR  = pinMin;
                autoFail   = "Dr " ~ mmStr(2 * Rr) ~ " terlalu kecil buat layout auto (butuh Dr >= ~" ~
                             mmStr(drMin2) ~ " utk 2-ring, atau ~" ~ mmStr(drMin1) ~
                             " utk 1-ring selang-seling yang syaratnya Base Bolt Count == Output " ~
                             "Pin Count -- sekarang " ~ toString(nBolt) ~ " vs " ~ toString(nOut) ~
                             "). Opsi: perbesar Dr, samakan count, kecilkan Output Pin Diameter, " ~
                             "kurangi clearance, atau matikan Add Base Bolts.";
            }
        }

        // ── 2b. Nilai efektif = auto, kecuali di-override ────────────────────
        var pinCR  = definition.ovrPinCircle
                     ? definition.outputPinCircleDiameter / 2
                     : autoPinCR;
        var boltCR = (useBolts && definition.ovrBoltCircle == true)
                     ? definition.baseBoltCircleDiameter / 2
                     : autoBoltCR;

        // 1-ring = dua lingkaran berdempetan sampai lubangnya selang-seling.
        // Rumus ini sekarang dipakai utk auto MAUPUN override (v5.0 nurunin
        // oneRing dari cabang auto, jadi urutan boltCR > pinCR salah dibaca).
        var oneRing = useBolts && (abs(pinCR - boltCR) < (rHole + rMb + WEB));

        // autoFail cuma relevan kalau ada nilai yang MASIH ngandelin auto.
        if (autoFail != "" &&
            (!definition.ovrPinCircle || (useBolts && definition.ovrBoltCircle != true)))
            problems = append(problems, autoFail);

        // ── 2c. Range legal tiap ring, dicek dua sisi sekaligus ──────────────
        // Batas melingkar (lubang saling tabrakan) ikut jadi batas BAWAH radius,
        // jadi satu pesan sudah nutup semua constraint ring tsb.
        var pinSpacingLo = oneRing
                           ? (rHole + rMb + WEB) / (2 * sin((90 / nOut) * degree))
                           : (rHole + WEB / 2) / sin((180 / nOut) * degree);
        var pinCRLo = max(innerLim + rHole, pinSpacingLo);
        var pinCRHi = outerLim - rHole;

        var pPin = checkRange("Output Pin Circle Diameter", pinCR, pinCRLo, pinCRHi, autoPinCR,
                              "Batas dalam = bearing " ~ dStr(eccOR) ~ " + web " ~ mmStr(WEB) ~
                              " dan jarak antar lubang (" ~ toString(nOut) ~ "x, r lubang " ~
                              mmStr(rHole) ~ "); batas luar = root lobe " ~ dStr(rootR) ~
                              " - web. Kalau range kosong: perbesar Dr, kecilkan Output Pin " ~
                              "Diameter/Clearance, atau kurangi Output Pin Count.");
        if (pPin != "")
            problems = append(problems, pPin);

        if (useBolts)
        {
            var boltSpacingLo = oneRing
                                ? 0 * millimeter   // sudah dicakup pinSpacingLo (radius sama)
                                : (rMb + WEB / 2) / sin((180 / nBolt) * degree);
            var boltCRLo = max(innerLim + rMb, boltSpacingLo);
            var boltCRHi = outerLim - rMb;

            var pBolt = checkRange("Base Bolt Circle Diameter", boltCR, boltCRLo, boltCRHi, autoBoltCR,
                                   "Batas dalam = bearing " ~ dStr(eccOR) ~ " + web dan jarak antar " ~
                                   "lubang (" ~ toString(nBolt) ~ "x, r lubang " ~ mmStr(rMb) ~
                                   "); batas luar = root lobe " ~ dStr(rootR) ~ " - web.");
            if (pBolt != "")
                problems = append(problems, pBolt);

            if (oneRing && nBolt != nOut)
                problems = append(problems,
                    "Pin circle (" ~ dStr(pinCR) ~ ") & bolt circle (" ~ dStr(boltCR) ~
                    ") jaraknya cuma " ~ mmStr(abs(pinCR - boltCR)) ~ " -> jadi 1-ring selang-seling, " ~
                    "tapi count beda (" ~ toString(nOut) ~ " pin vs " ~ toString(nBolt) ~ " bolt). " ~
                    "Samakan count, ATAU pisahkan radius minimal " ~ mmStr(rHole + rMb + WEB) ~
                    " biar jadi 2 ring terpisah.");
        }

        definition.baseBoltAngleDeg = (useBolts && oneRing) ? (180 / nOut) : 15;
        definition.outputPinCircleR = pinCR;
        definition.baseBoltCircleR  = boltCR;

        // ── 3. Roller ring & fit radii ───────────────────────────────────────
        // Seat/thru holes = NOMINAL + user clearance (diametral), simetris atas/bawah.
        var rollSeatR = Rp    + definition.rollerFitClearance    / 2;  // roller: housing + cover
        var outSeatR  = outPR + definition.outputPinFitClearance / 2;  // output dowel: base seats / hub

        if (2 * Rr * sin((180 / N) * degree) < 2 * rollSeatR + 0.8 * millimeter)
            problems = append(problems,
                "N=" ~ toString(N) ~ " ring pin terlalu rapat di Dr " ~ mmStr(2 * Rr) ~
                " (jarak antar lubang " ~ mmStr(2 * Rr * sin((180 / N) * degree)) ~
                ", butuh >= " ~ mmStr(2 * rollSeatR + 0.8 * millimeter) ~ "). Kurangi N, atau " ~
                "pakai Dr >= " ~ mmStr((2 * rollSeatR + 0.8 * millimeter) / sin((180 / N) * degree)) ~ ".");

        // ── 4. Boss cam (auto, kecuali di-override) ──────────────────────────
        var autoBoss1 = fl + bearW;                 // span base plate + bearing 1
        var autoBoss2 = bearW + 0.3 * millimeter;   // bearing 2 + physGap disk
        var boss1 = (definition.ovrBoss == true) ? definition.boss1Thickness : autoBoss1;
        var boss2 = (definition.ovrBoss == true && dual) ? definition.boss2Thickness : autoBoss2;
        definition.boss1Thickness = boss1;
        definition.boss2Thickness = boss2;

        if (boss1 < bearW)
            problems = append(problems,
                "Boss 1 Thickness " ~ mmStr(boss1) ~ " < lebar bearing " ~ mmStr(bearW) ~
                " -> bearing disk 1 gak ter-support penuh. Legal >= " ~ mmStr(bearW) ~
                ". Auto = " ~ mmStr(autoBoss1) ~ ".");
        if (dual && boss2 < bearW)
            problems = append(problems,
                "Boss 2 Thickness " ~ mmStr(boss2) ~ " < lebar bearing " ~ mmStr(bearW) ~
                " -> bearing disk 2 gak ter-support penuh. Legal >= " ~ mmStr(bearW) ~
                ". Auto = " ~ mmStr(autoBoss2) ~ ".");

        // ── 5. Mode-specific: flange, bases, cover ───────────────────────────
        var flangeBoreR = 0 * millimeter;
        var bottomBaseR = 0 * millimeter;
        var topBaseR    = 0 * millimeter;
        var bottomBoreR = 0 * millimeter;
        var topBoreR    = 0 * millimeter;
        definition.useFlangeRing = true;

        if (housingMode)
        {
            definition.flangeOutputHoles = false;   // dowel statik lewat bore, bukan nembus flange

            // hexCircR/stepDiag/stepHoleR HANYA dibaca dari UI saat toggle-nya ON
            // (field disembunyikan & gak eksis di map kalau off) -> fallback 0mm.
            var hexCircR = 0 * millimeter;
            if (useBolts)
            {
                if (definition.useNutPockets)
                    hexCircR = (definition.nutAcrossFlats / 2) / cos(30 * degree);
            }
            var stepDiag  = 0 * millimeter;
            var stepHoleR = 0 * millimeter;
            if (definition.useStepperHoles)
            {
                stepDiag  = definition.stepperSquare * sqrt(2) / 2;
                stepHoleR = definition.stepperBoltHoleDiameter / 2;
            }
            definition.stepperHoleRadius = stepHoleR;
            var camBaseR  = eccIR + 4 * millimeter;

            // ── 5a. Kandidat AUTO ────────────────────────────────────────────
            // Rantainya: pinCR/boltCR -> base plate -> flange bore / cover ring.
            // Karena tiap tingkat baca nilai EFEKTIF tingkat sebelumnya, override
            // di satu dimensi otomatis diikuti semua turunannya. Tiap footprint
            // (bolt/hex/stepper) cuma masuk hitungan kalau toggle-nya ON.
            var autoBottomBaseR = pinCR + outSeatR + WEB;
            if (useBolts)
            {
                var bottomBoltFP = mbR + definition.m3FitClearance / 2;
                if (definition.useNutPockets)
                    bottomBoltFP = max(bottomBoltFP, hexCircR);
                autoBottomBaseR = max(autoBottomBaseR, boltCR + bottomBoltFP + WEB);
            }
            if (definition.useStepperHoles)
                autoBottomBaseR = max(autoBottomBaseR, stepDiag + stepHoleR + WEB);

            var autoTopBaseR = pinCR + outSeatR + WEB;
            if (useBolts)
                autoTopBaseR = max(autoTopBaseR, boltCR + (mbR + definition.m3FitClearance / 2) + WEB);

            var autoBottomBoreR = max((definition.motorType == MotorType.NEMA17)
                                          ? 11.5 * millimeter : 6 * millimeter,
                                      camBaseR + e + 1 * millimeter);
            var autoTopBoreR    = eccIR + e + 3 * millimeter;

            bottomBaseR = (definition.ovrBottomBase == true) ? definition.basePlateDiameter / 2 : autoBottomBaseR;
            topBaseR    = (definition.ovrTopBase    == true) ? definition.topPlateDiameter  / 2 : autoTopBaseR;
            bottomBoreR = (definition.ovrBottomBore == true) ? definition.bottomBoreDiameter / 2 : autoBottomBoreR;
            topBoreR    = (definition.ovrTopBore    == true) ? definition.topBoreDiameter   / 2 : autoTopBoreR;

            // Flange bore & cover ring ngikut base plate EFEKTIF (bukan auto),
            // jadi override base plate gak otomatis nabrak keduanya.
            var autoFlangeBoreR = max(bottomBaseR + definition.plateRingGap,
                                      pinCR + outPR + 1 * millimeter);
            var autoRingInnerR  = topBaseR + definition.plateRingGap;
            var autoCoverOuterR = outR;

            flangeBoreR                 = (definition.ovrFlangeBore == true) ? definition.flangeRingInnerDiameter / 2 : autoFlangeBoreR;
            definition.ringInnerR       = (definition.ovrCoverRing  == true) ? definition.coverRingInnerDiameter / 2 : autoRingInnerR;
            definition.coverOuterRadius = (definition.ovrCoverOuter == true) ? definition.coverOuterDiameter     / 2 : autoCoverOuterR;

            var autoCoverBoltCR = outR + (1.5 * millimeter + definition.m3FitClearance / 2) + definition.coverBoltWall;
            if (definition.useCoverBolts)
                definition.coverBoltCircleR = (definition.ovrCoverBoltCircle == true)
                                              ? definition.coverBoltCircleDiameter / 2
                                              : autoCoverBoltCR;

            // ── 5b. Range legal (dua sisi), semua konflik dikumpulin ─────────
            // Batas atas flange bore & cover ring sama-sama dari lubang roller.
            var rollInnerR  = Rr - rollSeatR;          // tepi dalam lubang roller
            var ringHiLimit = rollInnerR - WEB;

            var flangeLo = max(pinCR + outPR + 1 * millimeter, bottomBaseR + 0.6 * millimeter);
            var pFl = checkRange("Flange Ring Inner Diameter", flangeBoreR, flangeLo, ringHiLimit, autoFlangeBoreR,
                                 "Batas bawah = yang lebih besar antara output pin statik " ~
                                 dStr(pinCR + outPR) ~ " (+1mm) dan Bottom Base " ~ dStr(bottomBaseR) ~
                                 " (+0.6mm, sejajar z); batas atas = lubang roller mulai " ~
                                 dStr(rollInnerR) ~ " - web " ~ mmStr(WEB) ~ ". Kalau range kosong, " ~
                                 "Dr-nya yang kurang: butuh Dr >= " ~
                                 dStr(flangeLo + rollSeatR + WEB) ~ ", atau kecilkan Bottom Base / " ~
                                 "Output Pin Circle / Base<->Ring Gap.");
            if (pFl != "")
                problems = append(problems, pFl);

            var ringLo = topBaseR + 0.6 * millimeter;
            var pRing = checkRange("Cover Ring Inner Diameter", definition.ringInnerR, ringLo, ringHiLimit, autoRingInnerR,
                                   "Batas bawah = Top Base " ~ dStr(topBaseR) ~ " (+0.6mm, sejajar z); " ~
                                   "batas atas = lubang roller di cover mulai " ~ dStr(rollInnerR) ~
                                   " - web " ~ mmStr(WEB) ~ ". Kalau range kosong: butuh Dr >= " ~
                                   dStr(ringLo + rollSeatR + WEB) ~ ", atau kecilkan Top Base Plate " ~
                                   "Diameter / Base<->Ring Gap.");
            if (pRing != "")
                problems = append(problems, pRing);

            var pCov = checkRange("Cover Outer Diameter", definition.coverOuterRadius,
                                  Rr + rollSeatR + WEB, undefined, autoCoverOuterR,
                                  "Lubang roller nyampe " ~ dStr(Rr + rollSeatR) ~ ", butuh web " ~
                                  mmStr(WEB) ~ " sampai tepi.");
            if (pCov != "")
                problems = append(problems, pCov);

            if (definition.useStepperHoles && stepDiag + stepHoleR > bottomBaseR - 0.5 * millimeter)
                problems = append(problems,
                    "Stepper Bolt Square " ~ mmStr(definition.stepperSquare) ~ " gak muat di Bottom Base " ~
                    dStr(bottomBaseR) ~ " (baut nyampe " ~ dStr(stepDiag + stepHoleR) ~ "). Butuh Bottom " ~
                    "Base Plate Diameter >= " ~ dStr(stepDiag + stepHoleR + 0.5 * millimeter) ~
                    ", atau kecilkan Stepper Bolt Square.");

            if (definition.useCoverBolts)
            {
                var cbLo = outR + 0.2 * millimeter + (1.5 * millimeter + definition.m3FitClearance / 2);
                var pCb = checkRange("Cover Bolt Circle Diameter", definition.coverBoltCircleR,
                                     cbLo, undefined, autoCoverBoltCR,
                                     "Lubang lug harus di luar wall housing (OD " ~ dStr(outR) ~ ").");
                if (pCb != "")
                    problems = append(problems, pCb);

                if (definition.coverBoltBossHeight > fl + ringH)
                    problems = append(problems,
                        "Cover Bolt Boss Height " ~ mmStr(definition.coverBoltBossHeight) ~
                        " > tinggi housing " ~ mmStr(fl + ringH) ~ ". Legal <= " ~ mmStr(fl + ringH) ~ ".");
            }

            if (definition.showLayoutReport)
            {
                println("== LAYOUT (nilai efektif | sumber | range legal) ==");
                println(layoutLine("Output Pin Circle ", pinCR,  definition.ovrPinCircle == true,  pinCRLo, pinCRHi));
                if (useBolts)
                    println(layoutLine("Base Bolt Circle  ", boltCR, definition.ovrBoltCircle == true, undefined, undefined));
                println(layoutLine("Bottom Base Plate ", bottomBaseR, definition.ovrBottomBase == true, undefined, flangeBoreR - 0.6 * millimeter));
                println(layoutLine("Top Base Plate    ", topBaseR,    definition.ovrTopBase    == true, undefined, definition.ringInnerR - 0.6 * millimeter));
                println(layoutLine("Bottom Center Bore", bottomBoreR, definition.ovrBottomBore == true, undefined, undefined));
                println(layoutLine("Top Center Bore   ", topBoreR,    definition.ovrTopBore    == true, undefined, undefined));
                println(layoutLine("Flange Ring Inner ", flangeBoreR, definition.ovrFlangeBore == true, flangeLo, ringHiLimit));
                println(layoutLine("Cover Ring Inner  ", definition.ringInnerR, definition.ovrCoverRing == true, ringLo, ringHiLimit));
                println(layoutLine("Cover Outer       ", definition.coverOuterRadius, definition.ovrCoverOuter == true, Rr + rollSeatR + WEB, undefined));
                if (definition.useCoverBolts)
                    println(layoutLine("Cover Bolt Circle ", definition.coverBoltCircleR, definition.ovrCoverBoltCircle == true,
                                       outR + 0.2 * millimeter + (1.5 * millimeter + definition.m3FitClearance / 2), undefined));
                println("   Cam Boss 1 = " ~ mmStr(boss1) ~ (definition.ovrBoss == true ? " [MANUAL]" : " [auto]") ~
                        "   Cam Boss 2 = " ~ mmStr(boss2) ~ "   (legal >= lebar bearing " ~ mmStr(bearW) ~ ")");
            }
        }
        else
        {
            definition.flangeOutputHoles = true;    // legacy: pin nembus flange (semua statik)
            definition.useCoverBolts     = false;
            var autoLegacyBore = eccOR + e + 1.5 * millimeter;
            flangeBoreR = (definition.ovrFlangeBore == true)
                          ? definition.flangeRingInnerDiameter / 2
                          : autoLegacyBore;

            var legacyLo = eccOR + e;                        // bearing + orbit penuh
            var legacyHi = pinCR - outPR - 1 * millimeter;   // jangan makan lubang output pin
            var pLeg = checkRange("Flange Ring Inner Diameter", flangeBoreR, legacyLo, legacyHi, autoLegacyBore,
                                  "Legacy mode: batas bawah = bearing " ~ dStr(eccOR) ~ " + orbit " ~
                                  mmStr(e) ~ "; batas atas = lubang output pin di flange mulai " ~
                                  dStr(pinCR - outPR) ~ ".");
            if (pLeg != "")
                problems = append(problems, pLeg);

            if (definition.showLayoutReport)
            {
                println("== LAYOUT (nilai efektif | sumber | range legal) ==");
                println(layoutLine("Output Pin Circle ", pinCR, definition.ovrPinCircle == true, pinCRLo, pinCRHi));
                if (useBolts)
                    println(layoutLine("Base Bolt Circle  ", boltCR, definition.ovrBoltCircle == true, undefined, undefined));
                println(layoutLine("Flange Ring Inner ", flangeBoreR, definition.ovrFlangeBore == true, legacyLo, legacyHi));
                println("   Cam Boss 1 = " ~ mmStr(boss1) ~ (definition.ovrBoss == true ? " [MANUAL]" : " [auto]") ~
                        "   Cam Boss 2 = " ~ mmStr(boss2) ~ "   (legal >= lebar bearing " ~ mmStr(bearW) ~ ")");
            }
        }
        definition.flangeRingInnerR = flangeBoreR;

        // ── 5c. Lapor SEMUA konflik sekaligus ────────────────────────────────
        // Semua cek di atas cuma ngumpulin string, gak ada yang return duluan --
        // jadi satu kali regen kamu lihat seluruh daftarnya, bukan satu-satu.
        if (size(problems) > 0)
        {
            var msg = "Ada " ~ toString(size(problems)) ~ " dimensi bentrok (SEMUANYA di bawah, " ~
                      "bukan satu per satu):";
            for (var i = 0; i < size(problems); i += 1)
                msg = msg ~ "\n" ~ toString(i + 1) ~ ") " ~ problems[i];
            msg = msg ~ "\nMatikan centang Override yang bersangkutan kalau mau balik ke nilai auto. " ~
                  "Angka auto tiap dimensi ada di Layout Report (panel notices).";
            reportFeatureError(context, id, msg);
            return;
        }

        // ── 6. Ringkasan ─────────────────────────────────────────────────────
        var ratioStr = housingMode ? (toString(N) ~ ":1 (housing output)")
                                   : (toString(N - 1) ~ ":1 (hub output)");
        println("== Cycloidal v5: ratio " ~ ratioStr ~
                "  Dr=" ~ mmStr(2 * Rr) ~ "  N=" ~ toString(N) ~
                "  e=" ~ mmStr(e) ~ (definition.autoEccentricity ? " (auto)" : "") ~
                "  OD=" ~ mmStr(2 * outR) ~ "  H=" ~ mmStr(fl + ringH));
        println("   layout " ~ (oneRing ? "1-ring selang-seling" : "2-ring") ~
                ": pinCircle=D" ~ mmStr(2 * pinCR) ~
                "  boltCircle=D" ~ mmStr(2 * boltCR) ~
                "  flangeBore=D" ~ mmStr(2 * flangeBoreR) ~
                (housingMode ? ("  base=D" ~ mmStr(2 * bottomBaseR)) : ""));
        if (dual)
            println("   dual disk: " ~ (((N - 1) % 2 == 0)
                    ? "lobus GENAP -> 2 part BEDA, cetak keduanya"
                    : "lobus GANJIL -> part sama, cetak 1 file 2x (balik 180 deg)"));

        // ── 7. Build parts ───────────────────────────────────────────────────
        if (definition.genHousing)
        {
            makeHousing(context, id + "housing", definition);
            nameBodies(context, id + "housing", housingMode ? "Housing (output)" : "Housing");
        }
        if (definition.genDisks)
        {
            makeDisk(context, id + "disk", definition);
            nameBodies(context, id + "disk", "Cycloid Disk");
        }
        if (definition.genCam)
        {
            makeCam(context, id + "cam", definition);
            nameBodies(context, id + "cam", "Input Cam");
        }
        if (housingMode)
        {
            if (definition.genBottomBase)
            {
                makeBottomBase(context, id + "bbase", mergeMaps(definition, {
                    "baseOuterRadius"  : bottomBaseR,
                    "centerBoreRadius" : bottomBoreR,
                    "dowelHoleDia"     : 2 * outSeatR
                }));
                nameBodies(context, id + "bbase", "Bottom Base");
            }
            if (definition.genTopBase)
            {
                makeTopBase(context, id + "tbase", mergeMaps(definition, {
                    "baseOuterRadius"  : topBaseR,
                    "centerBoreRadius" : topBoreR,
                    "dowelHoleDia"     : 2 * outSeatR
                }));
                nameBodies(context, id + "tbase", "Top Base");
            }
            if (definition.genCover)
            {
                makeTopRollerCover(context, id + "cover", definition);
                nameBodies(context, id + "cover", "Top Roller Cover");
            }
        }
        else if (definition.genHub)
        {
            makeOutputHub(context, id + "hub", definition);
            nameBodies(context, id + "hub", "Output Hub");
        }
    }
);
