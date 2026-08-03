FeatureScript 2931;
import(path : "onshape/std/common.fs", version : "2931.0");

/**
 * CYCLOIDAL DRIVE - 4 Part Generators
 * ─────────────────────────────────────────────────────────────────────────────
 * Panggil setiap fitur di Part Studio yang sama agar komponen sejajar:
 *   1. "Cycloidal - 1 Housing"     – ring luar open-top + pin holes
 *   2. "Cycloidal - 2 Disk"        – cycloidal disk (opsional dual 2x180 deg)
 *   3. "Cycloidal - 3 Input Cam"   – cam eksentrik (opsional dual boss)
 *   4. "Cycloidal - 4 Output Hub"  – plate output dengan press-fit untuk pin rods
 *
 * Konvensi Z (parameter SAMA di semua fitur agar sejajar):
 *   z = zOffset - flangeThickness  → dasar cam base plate
 *   z = zOffset + 0               → dasar housing / atas cam base plate
 *   z = zOffset + flangeThickness  → dasar cavity (disk mulai di sini)
 *   z = zOffset + fl + diskThick  → atas disk 1 (single disk)
 *   z = zOffset + fl + diskThick + diskGap + diskThick → atas disk 2 (dual disk)
 *   z = zOffset + housing_height  → dasar output hub
 *
 * Parameter baru di v2:
 *   zOffset       – geser seluruh assembly secara vertikal (default 0mm)
 *   diskGap       – jarak antar dua disk slot di housing cavity (default 1.0mm)
 *   boss1Thickness – ketebalan boss cam segmen 1 (default 9.5mm)
 *   boss2Thickness – ketebalan boss cam segmen 2, hanya muncul saat dualDisk=true
 *                    (default 7.5mm)
 *
 * Parameter baru di v3 (Disk feature saja):
 *   diskFitAdjustment – koreksi fit radial untuk OUTER lobe disk (default 0mm).
 *                       (+) menebalkan sisi luar lobe -> mesh lebih rapat ke pin,
 *                       backlash turun. (-) sebaliknya. Holes TIDAK berubah, jadi
 *                       bisa iterasi reprint disk saja tanpa cetak ulang semua part.
 *                       Default ratio diset 25:1 (numPins=25) untuk tes pertama.
 *
 * Parameter / perubahan v4 (FIT EMPIRIS + Top Roller Cover):
 *   Fit lubang diputuskan dari hasil tes cetak nyata (FDM). SEMUA clearance
 *   ditulis DIAMETRAL (selisih diameter), bukan radial -> input nominal nyambung
 *   langsung ke ukuran lubang: dia_lubang = 2*nominalRadius + clearance_diametral.
 *     M3 baut  : 3.10mm = ulir nge-GRIP plastik (self-tap, buat ngunci).
 *                3.15mm = mulai slide tapi berat.
 *       -> GRIP  (ulir masuk plastik, tanpa nut)  : +0.10mm dia -> 3.10mm
 *       -> CLEAR (lewat bebas, ada nut / nge-klem): +0.20mm dia -> 3.20mm
 *     M5 dowel : 5.14mm = seret banget (palu / press, ANCHOR).
 *                5.25mm = bisa ditekan jari, agak longgar (LOCATE).
 *       -> ANCHOR (ujung yg ngunci dowel)         : +0.14mm dia -> 5.14mm
 *       -> LOCATE (ujung yg cuma nahan/locate)    : +0.25mm dia -> 5.25mm
 *     Pembagian: dowel di-ANCHOR di satu ujung (bottom base / housing flange),
 *     di-LOCATE di ujung lain (top base / top cover) -> gampang dirakit.
 *     CATATAN: bug lama "boltR + 0.2" itu nambah 0.2 ke RADIUS (jadi 3.40mm),
 *     padahal maksudnya 0.2 ke DIAMETER (3.20mm). Sekarang dibetulin & dipusatkan
 *     di fungsi m3ClearRadius() dkk supaya gak ada lagi angka ajaib inline.
 *
 *   Top Roller Cover (Feature 7): ring sejajar top base yg nahan ujung ATAS
 *   roller dowel. Housing flange (bawah) nahan ujung bawah. Flange housing kini
 *   bisa dibuka tengahnya (ring) + 6 baut M3 cover->housing (lug nonjol, bukan
 *   nempel wall). Inner radius ring = input eksplisit. Semua toggle, default ON.
 *
 * Rumus profil cycloidal: BASE HYPOTROCHOID (N-1 lobus, lobe tip di t=0):
 *   xa = Rr*sin(t) + e*sin(N*t)   [local frame, disk center di origin]
 *   ya = Rr*cos(t) + e*cos(N*t)
 *   r² = Rr² + e² + 2*Rr*e*cos((N-1)*t)  → N-1 lobus ✓
 *   Pin radius correction: opOffsetFace(-(Rp+clr) + diskFitAdjustment) setelah extrude
 *
 * CATATAN PENTING tentang opBoolean:
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

// ── Fit lubang empiris (lihat header v4) ──────────────────────────────────────
// PENTING (anti "black box"): clearance SELALU ditulis sebagai nilai DIAMETRAL
// (selisih diameter lubang vs diameter nominal), lalu dibagi 2 jadi jari2 utk
// skCircle. Jadi input "nominal radius" nyambung langsung ke diameter lubang:
//
//   diameter lubang = 2*nomR + clearance_diametral
//
// nomR = jari2 nominal fastener (M3 -> 1.5mm ; dowel 5mm -> Rp 2.5mm).
// Hasil utk M3 (nomR 1.5) / dowel 5mm (Rp 2.5):
//   GRIP   : +0.10mm dia  -> 3.00 + 0.10 = 3.10mm  (ulir grip plastik, TANPA nut)
//   CLEAR  : +0.20mm dia  -> 3.00 + 0.20 = 3.20mm  (clearance close-fit, ADA nut/klem)
//   ANCHOR : +0.14mm dia  -> 5.00 + 0.14 = 5.14mm  (tight press, palu/bor duduk)
//   LOCATE : +0.25mm dia  -> 5.00 + 0.25 = 5.25mm  (hand press, agak longgar)
function m3GripRadius(nomR is ValueWithUnits)    returns ValueWithUnits { return nomR + (0.10 * millimeter) / 2; } // M3 -> dia 3.10
function m3ClearRadius(nomR is ValueWithUnits)   returns ValueWithUnits { return nomR + (0.20 * millimeter) / 2; } // M3 -> dia 3.20
function dowelAnchorRadius(Rp is ValueWithUnits) returns ValueWithUnits { return Rp   + (0.14 * millimeter) / 2; } // dowel -> dia 5.14
function dowelLocateRadius(Rp is ValueWithUnits) returns ValueWithUnits { return Rp   + (0.25 * millimeter) / 2; } // dowel -> dia 5.25

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
 *
 * Parameter baru:
 *   def.diskGap  – jarak ekstra di cavity antara slot disk 1 dan disk 2 (dual mode)
 *                  Housing ring height = 2*thick + diskGap (dual) / thick (single)
 *   def.zOffset  – geser seluruh housing ke atas / bawah di Z
 */
function makeHousing(context is Context, id is Id, def is map)
{
    var N       = def.numPins;
    var Rr      = def.pinCircleRadius;
    var Rp      = def.pinRadius;
    var e       = def.eccentricity;
    var thick   = def.diskThickness;
    var clr     = 0 * millimeter;   // clearance param dihapus -> semua dimensi nominal
    var wall    = def.wallThickness;
    var fl      = def.flangeThickness;
    var dual    = def.dualDisk;
    var bearIR  = def.eccBearingInner / 2;
    var dGap    = def.diskGap;                      // NEW: was hardcoded 1mm
    var zOff    = def.zOffset;                      // NEW: was hardcoded 0
    var ringH   = dual ? (2 * thick + dGap) : thick;
    var totalH  = fl + ringH;
    var cavR    = Rr + Rp - e + clr;
    var outR    = Rr + Rp + clr + wall;
    var ov      = 1 * millimeter;
    var nOut    = def.numOutputPins;
    var outPR   = def.outputPinRadius;
    var outCR   = def.outputPinCircleR;
    // NEW v4: flange ring + cover-bolt interface (sub-fields dibaca di dlm guard
    // krn cuma ada saat toggle-nya ON)
    var ringFlange = def.useFlangeRing;
    var coverBolts = def.useCoverBolts;


    // ── Silinder penuh (dasar housing) ───────────────────────────────────────
    var skMain = newSketchOnPlane(context, id + "skMain", {
        "sketchPlane" : zPlane(zOff)                // was: zPlane(0*mm)
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
        "sketchPlane" : zPlane(zOff + fl)           // was: zPlane(fl)
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
        "sketchPlane" : zPlane(zOff - ov)           // was: zPlane(-(ov))
    });
    for (var i = 0; i < N; i += 1)
    {
        var ang = (i * 360 / N) * degree;
        // ANCHOR fit: housing nahan ujung BAWAH roller dowel -> tight press
        // (dia 5.14mm utk dowel 5mm). Mesh tetap pakai Rp asli (offset disk
        // gak ikut berubah), cuma lubang fisiknya yg di-press-fit.
        skCircle(skPins, "p" ~ toString(i), {
            "center" : vector(Rr * cos(ang), Rr * sin(ang)),
            "radius" : dowelAnchorRadius(Rp)
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
        "sketchPlane" : zPlane(zOff - ov)           // was: zPlane(-(ov))
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
/*
    // ── 4x lubang baut M3 di bottom flange (offset 45 deg) ───────────────────
    var boltR  = 1.65 * millimeter;
    var boltCR = outR - wall / 2;
    var skBolt = newSketchOnPlane(context, id + "skBolt", {
        "sketchPlane" : zPlane(zOff - ov)
    });
    for (var b = 0; b < 4; b += 1)
    {
        var ab = (b * 90 + 45) * degree;
        skCircle(skBolt, "b" ~ toString(b), {
            "center" : vector(boltCR * cos(ab), boltCR * sin(ab)),
            "radius" : boltR
        });
    }
    skSolve(skBolt);
    opExtrude(context, id + "extBolt", {
        "entities"  : qCreatedBy(id + "skBolt", EntityType.FACE),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : fl + ov
    });
    opBoolean(context, id + "boolBolt", {
        "tools"         : qCreatedBy(id + "extBolt", EntityType.BODY),
        "targets"       : body,
        "operationType" : BooleanOperationType.SUBTRACTION
    });*/

    // ── N_out output pin holes di bottom flange ───────────────────────────────
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

    // ── NEW v4: buka tengah flange jadi RING (clearance bearing) ──────────────
    // Flange dulunya disk penuh (cuma ada cam clearance hole). Sekarang opsional
    // dibor tengahnya radius eksplisit (input) supaya ada gap buat bearing &
    // gak nabrak bottom base. Default ON.
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

    // ── NEW v4: lug + lubang baut M3 cover->housing (GRIP, self-tap) ──────────
    // 6 baut M3 ngerapetin Top Roller Cover ke housing. Lug nonjol keluar wall
    // (bukan nebelin wall). Lubang GRIP (dia 3.10mm) biar ulir nge-grip plastik.
    // Bolt boss ada di bagian ATAS wall (grip depth dari atas ke bawah).
    if (coverBolts)
    {
        var cbNomR = 1.5 * millimeter;                  // M3 nominal
        var cbWall = def.coverBoltWall;
        var cbHoleR = m3GripRadius(cbNomR);             // dia 3.10 -> grip
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
 * Parameter baru:
 *   def.diskGap  – jarak antar dua disk (physical separation = 0.3mm tetap,
 *                  tetapi housing cavity menggunakan diskGap yang sama agar aligned)
 *   def.zOffset  – geser seluruh disk ke atas / bawah di Z
 *
 * Separation fisik antar dua disk = 0.3mm tetap (kecil, hanya untuk hindari
 * kontak). Housing cavity menggunakan diskGap yang lebih besar → sisa ruang
 * adalah clearance Z untuk orbital motion.
 */
function makeDisk(context is Context, id is Id, def is map)
{
    var N       = def.numPins;
    var Rr      = def.pinCircleRadius;
    var e       = def.eccentricity;
    var Rp      = def.pinRadius;
    var thick   = def.diskThickness;
    var clr     = 0 * millimeter;   // clearance param dihapus -> semua dimensi nominal
    var fl      = def.flangeThickness;
    var eccOR   = def.eccBearingOuter / 2;
    var nOut    = def.numOutputPins;
    var outPR   = def.outputPinRadius;
    var outCR   = def.outputPinCircleR;
    var outClr  = def.outputPinClearance;           // running clearance DIAMETRAL lubang output pin
    var dual    = def.dualDisk;
    var physGap = 0.3 * millimeter;                 // separasi fisik antar disk (tetap)
                                                    // (housing cavity pakai diskGap yg lebih besar)
    var zOff    = def.zOffset;
    var fitAdj  = def.diskFitAdjustment;            // NEW v3: koreksi fit radial outer lobe.
                                                    // (+) = disk lebih gede = mesh lebih rapat = backlash turun
                                                    // (-) = disk lebih kecil = lebih longgar
    var ov      = 1 * millimeter;
    var nPts    = N * 20;

    var count = dual ? 2 : 1;
    for (var d = 0; d < count; d += 1)
    {
        var dId   = id + ("d" ~ toString(d));
        var eSign = (d == 0) ? 1.0 : -1.0;
        var eX    = e * eSign;
        var zBot  = zOff + fl + d * (thick + physGap);   // was: fl + d*(thick+0.1mm)
        // ── FIX phasing dual-disk (berlaku N ganjil & genap) ─────────────────
        // BUG LAMA: phase = d*PI = geser PARAMETER t sebesar 180deg. Utk kurva
        // hypotrochoid ini, geser parameter BUKAN rotasi rigid; lagipula 180deg
        // = (N-1)/2 lobe-pitch. Kalau (N-1) GENAP (mis. N=25 -> 24 lobus) itu
        // kelipatan utuh lobe = NO-OP: disk2 keluar IDENTIK & SE-FASE dgn disk1
        // -> pas dirakit numpuk, gak mau eccentric berlawanan.
        // BENAR: dua disk dual wajib beda SETENGAH lobe = 180/(N-1) deg, diterap-
        // kan sbg ROTASI RIGID profil lobe (terverifikasi mesh utk N ganjil &
        // genap). Lubang (bearing/output/baut) TIDAK ikut diputar -> output pin
        // tetap tembus lurus & disk tetap kompatibel dgn housing+cam yg sudah
        // dicetak; yang perlu reprint cuma disk-nya. Konsekuensi parity utk PRINT:
        //   - lobus GANJIL (N genap): kedua disk = part SAMA, tinggal balik 180deg.
        //   - lobus GENAP  (N ganjil, mis. 25): dua part BERBEDA, cetak keduanya.
        var lobeRot = d * (180 / (N - 1)) * degree;   // disk1=0, disk2=setengah-lobe
        var cR = cos(lobeRot);
        var sR = sin(lobeRot);

        // ── BASE HYPOTROCHOID: DUA SETENGAH (di-rotasi rigid sebesar lobeRot) ─
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
        // Offset NEGATIF menyusutkan lobe (parallel offset kurva cycloidal,
        // bentuk lobe TETAP, bukan scale). fitAdj menambah kembali sebagian
        // material di sisi luar lobe: makin (+), disk makin gede & makin rapat
        // ke pin. Holes (bearing + output pin) dipotong SETELAH offset ini,
        // jadi posisinya gak ikut berubah → cukup reprint disk-nya aja.
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
            // MOVING HOLE: lubang ini ngorbit ngelilingin pin STATIK, jadi harus
            // muat pin + orbit penuh (e) + running clearance.
            //   dia lubang = 2*outPR + 2*e + outputPinClearance
            //   r lubang   = outPR + e + outputPinClearance/2
            // outClr=0 -> pas teori (pin nyentuh dinding di ujung orbit) -> MACET.
            // Naikin outClr biar muter bebas; turunin biar backlash output kecil.
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
        // Lubang ini cuma jalur baut M3 yg menyatukan base bawah<->atas; baut
        // statik & ber-thread, jadi disk TIDAK boleh nyentuh sama sekali.
        // Radius = boltR + e + boltClr:
        //   boltR  = jari2 nominal baut (M3 -> 1.5mm)
        //   e      = orbit disk (supaya gak nahan saat eksentrik)
        //   boltClr= margin non-contact ekstra (default 0.6mm, ada knob)
        var nBolt   = def.numBaseBolts;
        var boltR   = def.baseBoltRadius;
        var boltCR  = def.baseBoltCircleR;
        var boltClr = def.boltHoleClearance;
        var skMb = newSketchOnPlane(context, dId + "skMb", {
            "sketchPlane" : zPlane(zBot - ov)
        });
        for (var j = 0; j < nBolt; j += 1)
        {
            // offset 15 deg -> baut TIDAK segaris radial sama pin statik
            // (hilangin garis retak bearing-baut-pin), tetap ~30 deg dari
            // diagonal stepper di base. 15 deg = spacing seragam ke tiap pin.
            var angB = (j * 360 / nBolt + 15) * degree;
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

// ════════════════════════════════════════════════════════════════════════════
//  BUILDER 3: ECCENTRIC INPUT CAM  (dual boss support)
// ════════════════════════════════════════════════════════════════════════════
/**
 * Cam eksentrik. Tiga segmen saat dualDisk=true, dua segmen saat single:
 *
 *   Segmen 1 (Base Plate) : z = zOff - flangeThickness .. zOff
 *                           tebal = flangeThickness (sudah ada di UI lama)
 *   Segmen 2 (Boss 1)     : z = zOff .. zOff + boss1Thickness
 *                           center di (+e, 0), radius = bearingInner/2 - clr
 *   Segmen 3 (Boss 2)     : z = zOff + boss1Thickness .. zOff + boss1 + boss2
 *                           center di (-e, 0), hanya jika dualDisk=true
 *
 * Parameter baru:
 *   def.boss1Thickness – ketebalan boss 1 (was hardcoded 9.5mm)
 *   def.boss2Thickness – ketebalan boss 2 (was hardcoded 7.5mm, hanya dual)
 *   def.zOffset        – geser seluruh cam ke atas / bawah di Z
 */
function makeCam(context is Context, id is Id, def is map)
{
    var e        = def.eccentricity;
    var shaftR   = def.shaftDia / 2;
    var bearIR   = def.eccBearingInner / 2;
    var fl       = def.flangeThickness;
    var clr      = 0 * millimeter;   // clearance param dihapus -> semua dimensi nominal
    var dual     = def.dualDisk;
    var baseR    = bearIR + 4 * millimeter;
    var boss1H   = def.boss1Thickness;             // NEW: was hardcoded 9.5mm
    var boss2H   = 0 * millimeter;
    if (dual)
        boss2H   = def.boss2Thickness;             // NEW: was hardcoded 7.5mm
    var totalBH  = dual ? (boss1H + boss2H) : boss1H;
    var zOff     = def.zOffset;                    // NEW: was hardcoded 0
    var ov       = 1 * millimeter;

    // ── Segmen 1: Base plate (z = zOff-fl hingga z = zOff) ───────────────────
    var skBase = newSketchOnPlane(context, id + "skBase", {
        "sketchPlane" : zPlane(zOff - fl)          // was: zPlane(-(fl))
    });
    skCircle(skBase, "o", {
        "center" : vector(0, 0) * millimeter,
        "radius" : baseR
    });
    skSolve(skBase);
    opExtrude(context, id + "extBase", {
        "entities"  : qCreatedBy(id + "skBase", EntityType.FACE),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : fl
    });

    // ── Segmen 2: Boss 1 (z = zOff hingga z = zOff+boss1H), center (+e,0) ────
    var skBoss1 = newSketchOnPlane(context, id + "skBoss1", {
        "sketchPlane" : zPlane(zOff)               // was: zPlane(0*mm)
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
        // ── Segmen 3: Boss 2 (z = zOff+boss1H hingga z = zOff+boss1H+boss2H) ─
        // center (-e, 0), berlawanan 180 deg dari boss 1
        var skBoss2 = newSketchOnPlane(context, id + "skBoss2", {
            "sketchPlane" : zPlane(zOff + boss1H)  // was: zPlane(boss1H)
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
        // UNION 3 body: base + boss1 + boss2
        opBoolean(context, id + "boolBoss", {
            "tools"         : qUnion([
                                  qCreatedBy(id + "extBase",  EntityType.BODY),
                                  qCreatedBy(id + "extBoss1", EntityType.BODY),
                                  qCreatedBy(id + "extBoss2", EntityType.BODY)
                              ]),
            "operationType" : BooleanOperationType.UNION
        });
    }
    else
    {
        // UNION 2 body: base + boss1
        opBoolean(context, id + "boolBoss", {
            "tools"         : qUnion([
                                  qCreatedBy(id + "extBase",  EntityType.BODY),
                                  qCreatedBy(id + "extBoss1", EntityType.BODY)
                              ]),
            "operationType" : BooleanOperationType.UNION
        });
    }

    // Setelah UNION, extBase menjadi merged result
    var camBody = qCreatedBy(id + "extBase", EntityType.BODY);

    // ── Shaft hole (overshoot 1mm kedua ujung) ────────────────────────────────
    var skShaft = newSketchOnPlane(context, id + "skShaft", {
        "sketchPlane" : zPlane(zOff - fl - ov)     // was: zPlane(-(fl+ov))
    });
    skCircle(skShaft, "h", {
        "center" : vector(0, 0) * millimeter,
        "radius" : shaftR
    });
    skSolve(skShaft);
    opExtrude(context, id + "extShaft", {
        "entities"  : qCreatedBy(id + "skShaft", EntityType.FACE),
        "direction" : vector(0, 0, 1),
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : fl + totalBH + 2 * ov
    });
    opBoolean(context, id + "boolShaft", {
        "tools"         : qCreatedBy(id + "extShaft", EntityType.BODY),
        "targets"       : camBody,
        "operationType" : BooleanOperationType.SUBTRACTION
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  BUILDER 4: OUTPUT HUB  (plate sederhana, press-fit untuk pin rods)
// ════════════════════════════════════════════════════════════════════════════
/**
 * Parameter baru:
 *   def.diskGap – harus SAMA dengan housing agar zHub terhitung benar
 *   def.zOffset – harus SAMA dengan housing
 */
function makeOutputHub(context is Context, id is Id, def is map)
{
    var Rr    = def.pinCircleRadius;
    var Rp    = def.pinRadius;
    var thick = def.diskThickness;
    var fl    = def.flangeThickness;
    var clr   = 0 * millimeter;   // clearance param dihapus -> semua dimensi nominal
    var wall  = def.wallThickness;
    var dual  = def.dualDisk;
    var dGap  = def.diskGap;                        // NEW: was hardcoded 1mm
    var zOff  = def.zOffset;                        // NEW: was hardcoded 0
    var nOut  = def.numOutputPins;
    var outPR = def.outputPinRadius;
    var outCR = def.outputPinCircleR;
    var diskR = Rr + Rp + clr + wall;
    var ringH = dual ? (2 * thick + dGap) : thick;
    var zHub  = zOff + fl + ringH;                  // was: fl + ringH
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
        // PRESS fit: dia = 2*outPR - 0.10mm (interferensi 0.10mm diametral) supaya
        // pin rod ke-cengkeram di hub. outPR 2.5 -> lubang 4.90mm utk dowel 5mm.
        skCircle(skPins, "p" ~ toString(j), {
            "center" : vector(outCR * cos(ang), outCR * sin(ang)),
            "radius" : outPR - (0.10 * millimeter) / 2
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
//  FEATURE 1: HOUSING
// ════════════════════════════════════════════════════════════════════════════
annotation { "Feature Type Name" : "Cycloidal - 1 Housing" }
export const cycloidHousing = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Group Name" : "Gear Parameters", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Ring Pin Count N  (reduction = N:1, default 25)" }
            isInteger(definition.numPins,
                      { (unitless) : [6, 25, 100] } as IntegerBoundSpec);

            annotation { "Name" : "Pin Circle Diameter Dr" }
            isLength(definition.pinCircleDiameter,
                     { (millimeter) : [40, 76, 300] } as LengthBoundSpec);

            annotation { "Name" : "Pin/Roller Diameter Dp (rod 3.97mm)" }
            isLength(definition.pinDiameter,
                     { (millimeter) : [2.0, 3.97, 10.0] } as LengthBoundSpec);

            annotation { "Name" : "Eccentricity e (max = Rr/N)" }
            isLength(definition.eccentricity,
                     { (millimeter) : [0.5, 1.0, 5.0] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Housing Dimensions", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Disk Thickness" }
            isLength(definition.diskThickness,
                     { (millimeter) : [4, 6, 30] } as LengthBoundSpec);

            annotation { "Name" : "Flange Thickness" }
            isLength(definition.flangeThickness,
                     { (millimeter) : [2, 5, 15] } as LengthBoundSpec);

            annotation { "Name" : "Wall Thickness" }
            isLength(definition.wallThickness,
                     { (millimeter) : [1, 2, 15] } as LengthBoundSpec);

            annotation { "Name" : "Eccentric Bearing" }
            definition.eccBearing is EccBearingType;

            annotation { "Name" : "Dual Disk (2x disks, 180 deg phase)", "Default" : true }
            definition.dualDisk is boolean;

            // Disk gap hanya bermakna saat dual disk aktif, tapi selalu tampil
            // agar user bisa set dulu sebelum toggle dual
            annotation { "Name" : "Disk Gap (cavity extra height, match Disk+Hub)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.diskGap,
                     { (millimeter) : [0.2, 1.0, 5.0] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Output Mechanism", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Output Pin Count" }
            isInteger(definition.numOutputPins,
                      { (unitless) : [3, 6, 12] } as IntegerBoundSpec);

            annotation { "Name" : "Output Pin Diameter (dowel 5mm)" }
            isLength(definition.outputPinDiameter,
                     { (millimeter) : [2.0, 5.0, 12.0] } as LengthBoundSpec);

            annotation { "Name" : "Output Pin Circle Diameter" }
            isLength(definition.outputPinCircleDiameter,
                     { (millimeter) : [16, 52, 160] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Top Cover Interface (v4)", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Open Flange Center (ring for bearing)", "Default" : true }
            definition.useFlangeRing is boolean;

            if (definition.useFlangeRing)
            {
                annotation { "Name" : "Flange Ring Inner Diameter (explicit, clear bottom base)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.flangeRingInnerDiameter,
                         { (millimeter) : [12, 27, 60] } as LengthBoundSpec);
            }

            annotation { "Name" : "Add Cover Bolt Lugs (M3 cover->housing)", "Default" : true }
            definition.useCoverBolts is boolean;

            if (definition.useCoverBolts)
            {
                annotation { "Name" : "Cover Bolt Count", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isInteger(definition.coverBoltCount,
                          { (unitless) : [2, 6, 12] } as IntegerBoundSpec);

                annotation { "Name" : "Cover Bolt Circle Diameter (match Cover; lug nonjol di luar wall)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.coverBoltCircleDiameter,
                         { (millimeter) : [60, 94, 180] } as LengthBoundSpec);

                annotation { "Name" : "Cover Bolt Lug Wall (around hole)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.coverBoltWall,
                         { (millimeter) : [1, 2, 5] } as LengthBoundSpec);

                annotation { "Name" : "Cover Bolt Boss Height (grip depth from top)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.coverBoltBossHeight,
                         { (millimeter) : [3, 10, 25] } as LengthBoundSpec);
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
        var bSpec = resolveBearing(definition.eccBearing);
        definition.eccBearingInner = bSpec.eccBearingInner;
        definition.eccBearingOuter = bSpec.eccBearingOuter;
        definition.eccBearingWidth = bSpec.eccBearingWidth;

        // ── Konversi diameter input -> radius internal ───────────────────────
        definition.pinCircleRadius  = definition.pinCircleDiameter / 2;
        definition.pinRadius        = definition.pinDiameter / 2;
        definition.outputPinRadius  = definition.outputPinDiameter / 2;
        definition.outputPinCircleR = definition.outputPinCircleDiameter / 2;
        if (definition.useCoverBolts)
            definition.coverBoltCircleR = definition.coverBoltCircleDiameter / 2;

        // ── Validasi v4: flange ring bore gak boleh makan lubang output pin ───
        if (definition.useFlangeRing)
        {
            definition.flangeRingInnerR = definition.flangeRingInnerDiameter / 2;
            var maxFlBore = definition.outputPinCircleR - definition.outputPinRadius - 1 * millimeter;
            if (definition.flangeRingInnerR > maxFlBore)
            {
                reportFeatureError(context, id,
                    "Flange Ring Inner Diameter terlalu besar -- bakal makan lubang output pin. " ~
                    "Max ~" ~ toString(2 * maxFlBore / millimeter) ~ "mm.");
                return;
            }
        }

        var dGap  = definition.diskGap;
        var ringH = definition.dualDisk
                    ? (2 * definition.diskThickness + dGap)
                    : definition.diskThickness;
        var totalH  = definition.flangeThickness + ringH;
        var outerDia = 2 * (definition.pinCircleRadius + definition.pinRadius
                            + definition.wallThickness);

        println("-- Housing: ratio=" ~ toString(definition.numPins) ~ ":1" ~
                "  OD=" ~ toString(outerDia / millimeter) ~
                "mm  H=" ~ toString(totalH / millimeter) ~
                "mm  N=" ~ toString(definition.numPins) ~
                "  diskGap=" ~ toString(dGap / millimeter) ~ "mm" ~
                "  zOff=" ~ toString(definition.zOffset / millimeter) ~ "mm" ~
                (definition.dualDisk ? "  [DUAL]" : "  [SINGLE]"));

        makeHousing(context, id, definition);
    }
);

// ════════════════════════════════════════════════════════════════════════════
//  FEATURE 2: CYCLOIDAL DISK
// ════════════════════════════════════════════════════════════════════════════
annotation { "Feature Type Name" : "Cycloidal - 2 Disk" }
export const cycloidDisk = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Group Name" : "Gear Parameters", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Ring Pin Count N  (reduction = N:1, default 25)" }
            isInteger(definition.numPins,
                      { (unitless) : [6, 25, 100] } as IntegerBoundSpec);

            annotation { "Name" : "Pin Circle Diameter Dr" }
            isLength(definition.pinCircleDiameter,
                     { (millimeter) : [40, 76, 300] } as LengthBoundSpec);

            annotation { "Name" : "Pin/Roller Diameter Dp (rod 3.97mm)" }
            isLength(definition.pinDiameter,
                     { (millimeter) : [2.0, 3.97, 10.0] } as LengthBoundSpec);

            annotation { "Name" : "Eccentricity e (max = Rr/N)" }
            isLength(definition.eccentricity,
                     { (millimeter) : [0.5, 1.0, 5.0] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Fit Tuning (iterate disk print)", "Collapsed By Default" : false }
        {
            // Tuning per-sisi untuk outer lobe SAJA. Holes gak berubah, jadi
            // kalau hasil print disk masih longgar tinggal naikin nilai ini
            // (mis. +0.08mm) dan reprint disk-nya doang.
            //   (+) outer lobe lebih tebal -> mesh lebih rapat -> backlash turun
            //   (-) outer lobe lebih tipis -> lebih longgar
            annotation { "Name" : "Disk Fit Adjustment (+tighter / -looser, per side)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.diskFitAdjustment,
                     { (millimeter) : [-0.5, 0.0, 0.5] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Base Holder Bolts (M3, thru disk)", "Collapsed By Default" : false }
        {
            // Harus SAMA persis dgn Bottom/Top Base agar baut lurus lewat semua.
            annotation { "Name" : "Base Bolt Count", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isInteger(definition.numBaseBolts,
                      { (unitless) : [2, 4, 8] } as IntegerBoundSpec);

            // Lubang disk = nomR + e + Bolt Hole Clearance (non-contact, lihat bawah).
            annotation { "Name" : "Base Bolt Nominal Diameter (M3 3mm; hole = nomR+e+clr)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.baseBoltDiameter,
                     { (millimeter) : [2.0, 3.0, 8.0] } as LengthBoundSpec);

            annotation { "Name" : "Base Bolt Circle Diameter (match Base)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.baseBoltCircleDiameter,
                     { (millimeter) : [16, 34, 80] } as LengthBoundSpec);

            annotation { "Name" : "Bolt Hole Clearance (non-contact, beyond orbit)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.boltHoleClearance,
                     { (millimeter) : [0.2, 0.6, 2.0] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Disk & Bearing", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Disk Thickness" }
            isLength(definition.diskThickness,
                     { (millimeter) : [4, 6, 30] } as LengthBoundSpec);

            annotation { "Name" : "Flange Thickness (match Housing)" }
            isLength(definition.flangeThickness,
                     { (millimeter) : [2, 5, 15] } as LengthBoundSpec);

            annotation { "Name" : "Eccentric Bearing" }
            definition.eccBearing is EccBearingType;

            annotation { "Name" : "Dual Disk (2x disks, 180 deg phase)", "Default" : true }
            definition.dualDisk is boolean;

            // diskGap di sini hanya dipakai oleh builder untuk cek ringH di log.
            // Separasi fisik antar disk = 0.3mm tetap (hardcoded di builder).
            // Set sama dengan Housing agar z-convention aligned.
            annotation { "Name" : "Disk Gap (match Housing)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.diskGap,
                     { (millimeter) : [0.2, 1.0, 5.0] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Output Mechanism", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Output Pin Count" }
            isInteger(definition.numOutputPins,
                      { (unitless) : [3, 6, 12] } as IntegerBoundSpec);

            annotation { "Name" : "Output Pin Diameter (dowel 5mm)" }
            isLength(definition.outputPinDiameter,
                     { (millimeter) : [2.0, 5.0, 12.0] } as LengthBoundSpec);

            annotation { "Name" : "Output Pin Circle Diameter" }
            isLength(definition.outputPinCircleDiameter,
                     { (millimeter) : [16, 52, 160] } as LengthBoundSpec);

            // Lubang output pin = MOVING HOLE: dia = pin + 2e + clearance ini.
            // 0 = pas teori (macet). Naikin biar muter; turunin biar backlash kecil.
            annotation { "Name" : "Output Pin Running Clearance (dia; hole = pin + 2e + this)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.outputPinClearance,
                     { (millimeter) : [0.0, 0.3, 1.5] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Assembly Placement", "Collapsed By Default" : true }
        {
            annotation { "Name" : "Z Offset (match Housing)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.zOffset,
                     { (millimeter) : [-200, 0, 200] } as LengthBoundSpec);
        }
    }
    {
        var bSpec = resolveBearing(definition.eccBearing);
        definition.eccBearingInner = bSpec.eccBearingInner;
        definition.eccBearingOuter = bSpec.eccBearingOuter;
        definition.eccBearingWidth = bSpec.eccBearingWidth;

        // ── Konversi diameter input -> radius internal ───────────────────────
        definition.pinCircleRadius  = definition.pinCircleDiameter / 2;
        definition.pinRadius        = definition.pinDiameter / 2;
        definition.outputPinRadius  = definition.outputPinDiameter / 2;
        definition.outputPinCircleR = definition.outputPinCircleDiameter / 2;
        definition.baseBoltRadius   = definition.baseBoltDiameter / 2;
        definition.baseBoltCircleR  = definition.baseBoltCircleDiameter / 2;

        // ── Validasi 1: batas eksentrisitas ───────────────────────────────────
        var eMax = definition.pinCircleRadius / definition.numPins;
        if (definition.eccentricity >= eMax)
        {
            reportFeatureError(context, id,
                "Eccentricity e=" ~ toString(definition.eccentricity / millimeter) ~
                "mm >= Rr/N=" ~ toString(eMax / millimeter) ~
                "mm. Base hypotrochoid akan self-intersect (loop). " ~
                "Gunakan e < " ~ toString(eMax / millimeter) ~ "mm.");
            return;
        }

        // ── Validasi 2: output pin circle tidak menabrak bearing hole ─────────
        // Pakai tepi-dalam lubang yg SUDAH diperbesar (termasuk orbit + clearance).
        var minHoleR    = definition.eccBearingOuter / 2;
        var outPinInner = definition.outputPinCircleR
                          - definition.outputPinRadius
                          - definition.eccentricity
                          - definition.outputPinClearance / 2;
        if (outPinInner < minHoleR)
        {
            reportFeatureError(context, id,
                "Output pin circle terlalu kecil -- akan menabrak bearing hole. " ~
                "Perbesar Output Pin Circle Diameter atau kecilkan Output Pin Diameter.");
            return;
        }

        println("-- Disk: ratio=" ~ toString(definition.numPins) ~ ":1" ~
                "  lobus=" ~ toString(definition.numPins - 1) ~
                "  e=" ~ toString(definition.eccentricity / millimeter) ~ "mm" ~
                "  fitAdj=" ~ toString(definition.diskFitAdjustment / millimeter) ~ "mm" ~
                "  outPinClr=" ~ toString(definition.outputPinClearance / millimeter) ~ "mm" ~
                "  physGap=0.3mm" ~
                "  zOff=" ~ toString(definition.zOffset / millimeter) ~ "mm" ~
                (definition.dualDisk ? "  [DUAL x2]" : ""));

        if (definition.dualDisk)
        {
            var halfLobeDeg = 180 / (definition.numPins - 1);
            var lobesGenap  = ((definition.numPins - 1) % 2) == 0;
            println("   dual-phase: disk2 di-rotasi " ~ toString(halfLobeDeg) ~
                    " deg (setengah lobe). " ~
                    (lobesGenap
                       ? "Lobus GENAP -> dua disk part BERBEDA, cetak KEDUANYA."
                       : "Lobus GANJIL -> disk identik, cetak 1 lalu balik 180 deg."));
        }

        makeDisk(context, id, definition);
    }
);

// ════════════════════════════════════════════════════════════════════════════
//  FEATURE 3: INPUT CAM
// ════════════════════════════════════════════════════════════════════════════
annotation { "Feature Type Name" : "Cycloidal - 3 Input Cam" }
export const cycloidCam = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Group Name" : "Cam Parameters", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Eccentricity e (max = Rr/N)" }
            isLength(definition.eccentricity,
                     { (millimeter) : [0.5, 1.0, 5.0] } as LengthBoundSpec);

            annotation { "Name" : "Motor Type" }
            definition.motorType is MotorType;

            annotation { "Name" : "Eccentric Bearing" }
            definition.eccBearing is EccBearingType;

            annotation { "Name" : "Dual Disk (2x boss, 180 deg offset)", "Default" : true }
            definition.dualDisk is boolean;
        }

        annotation { "Group Name" : "Cam Segment Sizes", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Seg 1 - Base Plate Thickness (match Housing Flange)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.flangeThickness,
                     { (millimeter) : [2, 5, 15] } as LengthBoundSpec);

            annotation { "Name" : "Seg 2 - Boss 1 Thickness (spans base 5mm + bearing 6mm)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.boss1Thickness,
                     { (millimeter) : [3, 11, 30] } as LengthBoundSpec);

            if (definition.dualDisk)
            {
                annotation { "Name" : "Seg 3 - Boss 2 Thickness (>= bearing 6mm)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.boss2Thickness,
                         { (millimeter) : [3, 6, 30] } as LengthBoundSpec);
            }
        }

        annotation { "Group Name" : "Assembly Placement", "Collapsed By Default" : true }
        {
            annotation { "Name" : "Z Offset (match Housing)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.zOffset,
                     { (millimeter) : [-200, 0, 200] } as LengthBoundSpec);
        }
    }
    {
        definition.shaftDia = resolveShaft(definition.motorType);

        var bSpec = resolveBearing(definition.eccBearing);
        definition.eccBearingInner = bSpec.eccBearingInner;
        definition.eccBearingOuter = bSpec.eccBearingOuter;
        definition.eccBearingWidth = bSpec.eccBearingWidth;

        // ── Validasi: eccentricity vs bearing annular space ───────────────────
        var maxSafeE = (definition.eccBearingOuter - definition.eccBearingInner) / 4;
        if (definition.eccentricity > maxSafeE)
        {
            reportFeatureError(context, id,
                "Eccentricity (e=" ~ toString(definition.eccentricity / millimeter) ~
                "mm) terlalu besar. Max aman ~" ~ toString(maxSafeE / millimeter) ~ "mm.");
            return;
        }

        // ── Validasi: boss1Thickness harus cukup untuk bearing ────────────────
        if (definition.boss1Thickness < definition.eccBearingWidth)
        {
            reportFeatureError(context, id,
                "Boss 1 Thickness (" ~ toString(definition.boss1Thickness / millimeter) ~
                "mm) < bearing width (" ~ toString(definition.eccBearingWidth / millimeter) ~
                "mm). Bearing tidak akan ter-support penuh.");
            return;
        }

        var boss2H = 0 * millimeter;
        if (definition.dualDisk)
        {
            boss2H = definition.boss2Thickness;
            if (boss2H < definition.eccBearingWidth)
            {
                reportFeatureError(context, id,
                    "Boss 2 Thickness (" ~ toString(boss2H / millimeter) ~
                    "mm) < bearing width (" ~ toString(definition.eccBearingWidth / millimeter) ~
                    "mm). Bearing disk 2 tidak akan ter-support penuh.");
                return;
            }
        }

        var totalBH = definition.dualDisk
                      ? (definition.boss1Thickness + boss2H)
                      : definition.boss1Thickness;

        println("-- Cam: e=" ~ toString(definition.eccentricity / millimeter) ~
                "mm  shaft=" ~ toString(definition.shaftDia / millimeter) ~
                "mm  basePlate=" ~ toString(definition.flangeThickness / millimeter) ~
                "mm  boss1=" ~ toString(definition.boss1Thickness / millimeter) ~ "mm" ~
                (definition.dualDisk ? ("  boss2=" ~ toString(boss2H / millimeter) ~ "mm") : "") ~
                "  totalBoss=" ~ toString(totalBH / millimeter) ~ "mm" ~
                "  zOff=" ~ toString(definition.zOffset / millimeter) ~ "mm" ~
                (definition.dualDisk ? "  [DUAL boss x2]" : ""));

        makeCam(context, id, definition);
    }
);

// ════════════════════════════════════════════════════════════════════════════
//  FEATURE 4: OUTPUT HUB
// ════════════════════════════════════════════════════════════════════════════
annotation { "Feature Type Name" : "Cycloidal - 4 Output Hub" }
export const cycloidOutputHub = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Group Name" : "Assembly Position (match Housing)", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Disk Thickness" }
            isLength(definition.diskThickness,
                     { (millimeter) : [4, 6, 30] } as LengthBoundSpec);

            annotation { "Name" : "Flange Thickness" }
            isLength(definition.flangeThickness,
                     { (millimeter) : [2, 5, 15] } as LengthBoundSpec);

            annotation { "Name" : "Wall Thickness" }
            isLength(definition.wallThickness,
                     { (millimeter) : [1, 2, 15] } as LengthBoundSpec);

            annotation { "Name" : "Pin Circle Diameter Dr" }
            isLength(definition.pinCircleDiameter,
                     { (millimeter) : [40, 76, 300] } as LengthBoundSpec);

            annotation { "Name" : "Pin/Roller Diameter Dp" }
            isLength(definition.pinDiameter,
                     { (millimeter) : [2.0, 3.97, 10.0] } as LengthBoundSpec);

            annotation { "Name" : "Dual Disk (match Housing/Disk setting)", "Default" : true }
            definition.dualDisk is boolean;

            annotation { "Name" : "Disk Gap (match Housing)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.diskGap,
                     { (millimeter) : [0.2, 1.0, 5.0] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Output Pin Rods", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Output Pin Count" }
            isInteger(definition.numOutputPins,
                      { (unitless) : [3, 6, 12] } as IntegerBoundSpec);

            annotation { "Name" : "Output Pin Diameter (same rod as roller pins)" }
            isLength(definition.outputPinDiameter,
                     { (millimeter) : [2.0, 5.0, 12.0] } as LengthBoundSpec);

            annotation { "Name" : "Output Pin Circle Diameter" }
            isLength(definition.outputPinCircleDiameter,
                     { (millimeter) : [16, 52, 160] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Assembly Placement", "Collapsed By Default" : true }
        {
            annotation { "Name" : "Z Offset (match Housing)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.zOffset,
                     { (millimeter) : [-200, 0, 200] } as LengthBoundSpec);
        }
    }
    {
        definition.pinCircleRadius  = definition.pinCircleDiameter / 2;
        definition.pinRadius        = definition.pinDiameter / 2;
        definition.outputPinRadius  = definition.outputPinDiameter / 2;
        definition.outputPinCircleR = definition.outputPinCircleDiameter / 2;

        var dGap  = definition.diskGap;
        var ringH = definition.dualDisk
                    ? (2 * definition.diskThickness + dGap)
                    : definition.diskThickness;
        var zHub  = definition.zOffset + definition.flangeThickness + ringH;

        println("-- Output Hub: zPos=" ~ toString(zHub / millimeter) ~
                "mm  nPins=" ~ toString(definition.numOutputPins) ~
                "  diskGap=" ~ toString(dGap / millimeter) ~ "mm" ~
                "  zOff=" ~ toString(definition.zOffset / millimeter) ~ "mm");

        makeOutputHub(context, id, definition);
    }
);

// ════════════════════════════════════════════════════════════════════════════
//  BUILDER 5: BOTTOM BASE  (static carrier, NEMA17 mount)
// ════════════════════════════════════════════════════════════════════════════
/**
 * Plate statik di bawah disk stack. Z = zOff .. zOff+fl (mengisi celah antara
 * top cam-base-plate dan dasar disk 1). Disk 1 duduk persis di atasnya.
 *
 * Semua lubang dibuat di posisi NOMINAL (tanpa eccentric) karena base statik,
 * yg orbit cuma disk-nya. Lubang di disk sudah diperbesar (+e) untuk kompensasi.
 *
 * Lubang:
 *   - center bore         : clearance NEMA17 pilot (~22mm) + cam base plate
 *   - N stepper holes      : pola kotak (NEMA17 = 31x31mm), tembus
 *   - N dowel seats        : press-fit (dia = dowelHoleDia, default 5.25mm), tembus
 *   - N_bolt M3 clearance  : dia = 2*boltR + 0.20mm (3.20mm utk M3), tembus
 *   - N_bolt hex nut pocket: di muka BAWAH (across-flats = nutAcrossFlats)
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
    var nBolt   = def.numBaseBolts;
    var boltR   = def.baseBoltRadius;
    var boltCR  = def.baseBoltCircleR;
    var nutAF   = def.nutAcrossFlats;
    var nutD    = def.nutPocketDepth;
    var stepR   = def.stepperHoleRadius;
    var stepSq  = def.stepperSquare;
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

    // ── Dowel seats (press-fit, through) ───────────────────────────────────────
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

    // ── M3 clearance holes (through) ───────────────────────────────────────────
    var skM = newSketchOnPlane(context, id + "skM3", { "sketchPlane" : zPlane(zBot - ov) });
    for (var j = 0; j < nBolt; j += 1)
    {
        var a = (j * 360 / nBolt + 15) * degree;
        // CLEAR fit: dia = 2*boltR + 0.20mm. boltR 1.5 -> 3.20mm (close clearance,
        // ada nut di bawah). DULU "boltR + 0.2" = 3.40mm (0.2 kena radius, bukan dia).
        skCircle(skM, "m" ~ toString(j), {
            "center" : vector(boltCR * cos(a), boltCR * sin(a)),
            "radius" : m3ClearRadius(boltR)
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

    // ── Hex nut pockets di muka BAWAH (closed line loop -> region) ─────────────
    var hexCirc = (nutAF / 2) / cos(30 * degree);
    var skN = newSketchOnPlane(context, id + "skNut", { "sketchPlane" : zPlane(zBot - ov) });
    for (var j = 0; j < nBolt; j += 1)
    {
        var a  = (j * 360 / nBolt + 15) * degree;
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

    // ── Stepper bolt holes (kotak pattern, through) ────────────────────────────
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

// ════════════════════════════════════════════════════════════════════════════
//  BUILDER 6: TOP BASE  (static carrier, dowel + bolt lock)
// ════════════════════════════════════════════════════════════════════════════
/**
 * Plate statik di atas disk stack. Z = zOff+fl+ringH .. +fl
 * (posisi sama dgn Output Hub lama). Mengunci ujung atas dowel pin + baut M3.
 * Tanpa stepper holes / nut pocket.
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
    var nBolt   = def.numBaseBolts;
    var boltR   = def.baseBoltRadius;
    var boltCR  = def.baseBoltCircleR;
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

    // ── Dowel seats (press-fit, through) ───────────────────────────────────────
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

    // ── M3 clearance holes (through) ───────────────────────────────────────────
    var skM = newSketchOnPlane(context, id + "skM3", { "sketchPlane" : zPlane(zTop - ov) });
    for (var j = 0; j < nBolt; j += 1)
    {
        var a = (j * 360 / nBolt + 15) * degree;
        // CLEAR fit: dia = 2*boltR + 0.20mm. boltR 1.5 -> 3.20mm (close clearance).
        // DULU "boltR + 0.2" = 3.40mm (0.2 kena radius, bukan diameter).
        skCircle(skM, "m" ~ toString(j), {
            "center" : vector(boltCR * cos(a), boltCR * sin(a)),
            "radius" : m3ClearRadius(boltR)
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

// ════════════════════════════════════════════════════════════════════════════
//  FEATURE 5: BOTTOM BASE
// ════════════════════════════════════════════════════════════════════════════
annotation { "Feature Type Name" : "Cycloidal - 5 Bottom Base" }
export const cycloidBottomBase = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Group Name" : "Base Plate", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Base Plate Diameter", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.basePlateDiameter,
                     { (millimeter) : [50, 90, 160] } as LengthBoundSpec);

            annotation { "Name" : "Base Thickness (match Flange = 5mm)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.flangeThickness,
                     { (millimeter) : [2, 5, 15] } as LengthBoundSpec);

            annotation { "Name" : "Center Bore Diameter (clear NEMA17 pilot + cam)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.centerBoreDiameter,
                     { (millimeter) : [12, 23, 50] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Stepper Mount (NEMA17)", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Stepper Bolt Square (NEMA17 = 31mm)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.stepperSquare,
                     { (millimeter) : [20, 31, 50] } as LengthBoundSpec);

            annotation { "Name" : "Stepper Bolt Hole Diameter (M3 clr -> 3.10mm)" }
            isLength(definition.stepperBoltHoleDiameter,
                     { (millimeter) : [2.0, 3.1, 6.0] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Dowel Pins (static)", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Dowel Pin Count" }
            isInteger(definition.numOutputPins,
                      { (unitless) : [3, 6, 12] } as IntegerBoundSpec);

            // ANCHOR end: bottom base ngunci dowel -> tight press 5.14mm (palu/press).
            annotation { "Name" : "Dowel Hole Diameter (ANCHOR tight; 5.14 press / 5.25 hand)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.dowelHoleDia,
                     { (millimeter) : [5.0, 5.14, 5.7] } as LengthBoundSpec);

            annotation { "Name" : "Dowel Pin Circle Diameter (match Disk)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.outputPinCircleDiameter,
                     { (millimeter) : [16, 52, 160] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Base Holder Bolts (M3 + nut)", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Base Bolt Count", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isInteger(definition.numBaseBolts,
                      { (unitless) : [2, 4, 8] } as IntegerBoundSpec);

            annotation { "Name" : "Base Bolt Nominal Diameter (M3 3mm -> clearance hole 3.20mm)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.baseBoltDiameter,
                     { (millimeter) : [2.0, 3.0, 8.0] } as LengthBoundSpec);

            annotation { "Name" : "Base Bolt Circle Diameter (match Disk)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.baseBoltCircleDiameter,
                     { (millimeter) : [16, 34, 80] } as LengthBoundSpec);

            annotation { "Name" : "Nut Pocket Across-Flats (M3 nut -> 5.55mm)" }
            isLength(definition.nutAcrossFlats,
                     { (millimeter) : [4, 5.55, 12] } as LengthBoundSpec);

            annotation { "Name" : "Nut Pocket Depth" }
            isLength(definition.nutPocketDepth,
                     { (millimeter) : [1, 2.6, 6] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Assembly Placement", "Collapsed By Default" : true }
        {
            annotation { "Name" : "Z Offset (match Housing)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.zOffset,
                     { (millimeter) : [-200, 0, 200] } as LengthBoundSpec);
        }
    }
    {
        // ── Konversi diameter input -> radius internal ───────────────────────
        definition.baseOuterRadius  = definition.basePlateDiameter / 2;
        definition.centerBoreRadius = definition.centerBoreDiameter / 2;
        definition.stepperHoleRadius = definition.stepperBoltHoleDiameter / 2;
        definition.outputPinCircleR = definition.outputPinCircleDiameter / 2;
        definition.baseBoltRadius   = definition.baseBoltDiameter / 2;
        definition.baseBoltCircleR  = definition.baseBoltCircleDiameter / 2;

        // ── Validasi: stepper square diagonal harus muat di base plate ─────────
        var stepDiag = definition.stepperSquare * sqrt(2) / 2;
        if (stepDiag + definition.stepperHoleRadius > definition.baseOuterRadius)
        {
            reportFeatureError(context, id,
                "Stepper square terlalu besar untuk Base Plate Diameter. " ~
                "Perbesar Base Plate Diameter atau kecilkan Stepper Square.");
            return;
        }

        println("-- Bottom Base: D=" ~ toString(definition.basePlateDiameter / millimeter) ~
                "mm  bore=" ~ toString(definition.centerBoreDiameter / millimeter) ~
                "mm  stepper=" ~ toString(definition.stepperSquare / millimeter) ~ "mm sq" ~
                "  dowel=" ~ toString(definition.numOutputPins) ~ "@D" ~ toString(definition.outputPinCircleDiameter / millimeter) ~
                "  M3=" ~ toString(definition.numBaseBolts) ~ "@D" ~ toString(definition.baseBoltCircleDiameter / millimeter) ~
                "  zOff=" ~ toString(definition.zOffset / millimeter) ~ "mm");

        makeBottomBase(context, id, definition);
    }
);

// ════════════════════════════════════════════════════════════════════════════
//  FEATURE 6: TOP BASE
// ════════════════════════════════════════════════════════════════════════════
annotation { "Feature Type Name" : "Cycloidal - 6 Top Base" }
export const cycloidTopBase = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Group Name" : "Base Plate", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Base Plate Diameter", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.basePlateDiameter,
                     { (millimeter) : [50, 90, 160] } as LengthBoundSpec);

            annotation { "Name" : "Base Thickness (match Flange = 5mm)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.flangeThickness,
                     { (millimeter) : [2, 5, 15] } as LengthBoundSpec);

            annotation { "Name" : "Center Bore Diameter (clear cam boss top)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.centerBoreDiameter,
                     { (millimeter) : [8, 16, 50] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Disk Stack (match Housing/Disk)", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Disk Thickness" }
            isLength(definition.diskThickness,
                     { (millimeter) : [4, 6, 30] } as LengthBoundSpec);

            annotation { "Name" : "Dual Disk (match Housing/Disk)", "Default" : true }
            definition.dualDisk is boolean;

            annotation { "Name" : "Disk Gap (match Housing)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.diskGap,
                     { (millimeter) : [0.2, 1.0, 5.0] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Dowel Pins (static)", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Dowel Pin Count" }
            isInteger(definition.numOutputPins,
                      { (unitless) : [3, 6, 12] } as IntegerBoundSpec);

            // LOCATE end: top base cuma nahan ujung atas dowel -> hand press 5.25mm
            // (gampang dirakit; anchor-nya udah di bottom base).
            annotation { "Name" : "Dowel Hole Diameter (LOCATE hand; 5.25 hand / 5.14 tight)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.dowelHoleDia,
                     { (millimeter) : [5.0, 5.25, 5.7] } as LengthBoundSpec);

            annotation { "Name" : "Dowel Pin Circle Diameter (match Disk)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.outputPinCircleDiameter,
                     { (millimeter) : [16, 52, 160] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Base Holder Bolts (M3)", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Base Bolt Count", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isInteger(definition.numBaseBolts,
                      { (unitless) : [2, 4, 8] } as IntegerBoundSpec);

            annotation { "Name" : "Base Bolt Nominal Diameter (M3 3mm -> clearance hole 3.20mm)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.baseBoltDiameter,
                     { (millimeter) : [2.0, 3.0, 8.0] } as LengthBoundSpec);

            annotation { "Name" : "Base Bolt Circle Diameter (match Disk)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.baseBoltCircleDiameter,
                     { (millimeter) : [16, 34, 80] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Assembly Placement", "Collapsed By Default" : true }
        {
            annotation { "Name" : "Z Offset (match Housing)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.zOffset,
                     { (millimeter) : [-200, 0, 200] } as LengthBoundSpec);
        }
    }
    {
        // ── Konversi diameter input -> radius internal ───────────────────────
        definition.baseOuterRadius  = definition.basePlateDiameter / 2;
        definition.centerBoreRadius = definition.centerBoreDiameter / 2;
        definition.outputPinCircleR = definition.outputPinCircleDiameter / 2;
        definition.baseBoltRadius   = definition.baseBoltDiameter / 2;
        definition.baseBoltCircleR  = definition.baseBoltCircleDiameter / 2;

        var ringH = definition.dualDisk
                    ? (2 * definition.diskThickness + definition.diskGap)
                    : definition.diskThickness;
        var zTop  = definition.zOffset + definition.flangeThickness + ringH;

        println("-- Top Base: zBot=" ~ toString(zTop / millimeter) ~
                "mm  D=" ~ toString(definition.basePlateDiameter / millimeter) ~
                "mm  dowel=" ~ toString(definition.numOutputPins) ~
                "  M3=" ~ toString(definition.numBaseBolts) ~
                "  zOff=" ~ toString(definition.zOffset / millimeter) ~ "mm");

        makeTopBase(context, id, definition);
    }
);

// ════════════════════════════════════════════════════════════════════════════
//  BUILDER 7: TOP ROLLER COVER  (ring; nahan ujung ATAS roller dowel)
// ════════════════════════════════════════════════════════════════════════════
/**
 * Ring sejajar Top Base. Duduk di ATAS housing (z sama dgn Top Base / Output Hub
 * lama). Nahan ujung ATAS roller dowel; housing flange nahan ujung bawah. Tengah
 * dibuka (ring) buat clearance bearing -> inner radius = input EKSPLISIT.
 * 6 baut M3 (CLEARANCE) lewat lug nonjol -> nyambung ke lug housing (yg GRIP).
 *
 * Z-convention SAMA dgn Top Base: zTop = zOff + fl + ringH, tebal = fl.
 * Roller holes pakai LOCATE fit (dia 5.25mm) supaya gampang dirakit.
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

    // ── Center bore (ring inner, clearance bearing/output) ───────────────────
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

    // ── N roller-top holes (LOCATE fit, dia 5.25mm) ──────────────────────────
    var skR = newSketchOnPlane(context, id + "skRoll", { "sketchPlane" : zPlane(zTop - ov) });
    for (var i = 0; i < N; i += 1)
    {
        var a = (i * 360 / N) * degree;
        skCircle(skR, "r" ~ toString(i), {
            "center" : vector(Rr * cos(a), Rr * sin(a)),
            "radius" : dowelLocateRadius(Rp)
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
        var cbHoleR = m3ClearRadius(cbNomR);            // dia 3.40 -> clearance
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
//  FEATURE 7: TOP ROLLER COVER
// ════════════════════════════════════════════════════════════════════════════
annotation { "Feature Type Name" : "Cycloidal - 7 Top Roller Cover" }
export const cycloidTopRollerCover = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Group Name" : "Roller Ring (match Housing)", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Ring Pin Count N" }
            isInteger(definition.numPins,
                      { (unitless) : [6, 25, 100] } as IntegerBoundSpec);

            annotation { "Name" : "Pin Circle Diameter Dr (match Housing)" }
            isLength(definition.pinCircleDiameter,
                     { (millimeter) : [40, 76, 300] } as LengthBoundSpec);

            annotation { "Name" : "Pin/Roller Diameter Dp (dowel 5mm)" }
            isLength(definition.pinDiameter,
                     { (millimeter) : [2.0, 5.0, 10.0] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Cover Plate", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Cover Outer Diameter (match Housing OD)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.coverOuterDiameter,
                     { (millimeter) : [50, 90, 180] } as LengthBoundSpec);

            annotation { "Name" : "Ring Inner Diameter (explicit, clear bearing/output)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.ringInnerDiameter,
                     { (millimeter) : [20, 66, 160] } as LengthBoundSpec);

            annotation { "Name" : "Cover Thickness (match Flange)" }
            isLength(definition.flangeThickness,
                     { (millimeter) : [2, 5, 15] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Disk Stack (match Housing/Disk)", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Disk Thickness" }
            isLength(definition.diskThickness,
                     { (millimeter) : [4, 6, 30] } as LengthBoundSpec);

            annotation { "Name" : "Dual Disk (match Housing/Disk)", "Default" : true }
            definition.dualDisk is boolean;

            annotation { "Name" : "Disk Gap (match Housing)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.diskGap,
                     { (millimeter) : [0.2, 1.0, 5.0] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Cover Bolts (M3 -> Housing)", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Add Cover Bolt Lugs", "Default" : true }
            definition.useCoverBolts is boolean;

            if (definition.useCoverBolts)
            {
                annotation { "Name" : "Cover Bolt Count (match Housing)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isInteger(definition.coverBoltCount,
                          { (unitless) : [2, 6, 12] } as IntegerBoundSpec);

                annotation { "Name" : "Cover Bolt Circle Diameter (match Housing)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.coverBoltCircleDiameter,
                         { (millimeter) : [60, 94, 180] } as LengthBoundSpec);

                annotation { "Name" : "Cover Bolt Lug Wall (around hole)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.coverBoltWall,
                         { (millimeter) : [1, 2, 5] } as LengthBoundSpec);
            }
        }

        annotation { "Group Name" : "Assembly Placement", "Collapsed By Default" : true }
        {
            annotation { "Name" : "Z Offset (match Housing)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.zOffset,
                     { (millimeter) : [-200, 0, 200] } as LengthBoundSpec);
        }
    }
    {
        // ── Konversi diameter input -> radius internal ───────────────────────
        definition.pinCircleRadius = definition.pinCircleDiameter / 2;
        definition.pinRadius       = definition.pinDiameter / 2;
        definition.coverOuterRadius = definition.coverOuterDiameter / 2;
        definition.ringInnerR      = definition.ringInnerDiameter / 2;
        if (definition.useCoverBolts)
            definition.coverBoltCircleR = definition.coverBoltCircleDiameter / 2;

        // ── Validasi: roller holes harus muat di band ring ────────────────────
        if (definition.ringInnerR
            > definition.pinCircleRadius - definition.pinRadius - 0.5 * millimeter)
        {
            reportFeatureError(context, id,
                "Ring Inner Diameter kegedean -- bakal makan lubang roller. " ~
                "Kecilkan Ring Inner Diameter atau perbesar Pin Circle Diameter.");
            return;
        }
        if (definition.coverOuterRadius
            < definition.pinCircleRadius + definition.pinRadius + 0.5 * millimeter)
        {
            reportFeatureError(context, id,
                "Cover Outer Diameter kekecilan -- lubang roller bakal keluar tepi. " ~
                "Perbesar Cover Outer Diameter.");
            return;
        }

        var ringH = definition.dualDisk
                    ? (2 * definition.diskThickness + definition.diskGap)
                    : definition.diskThickness;
        var zTop  = definition.zOffset + definition.flangeThickness + ringH;

        println("-- Top Roller Cover: zBot=" ~ toString(zTop / millimeter) ~
                "mm  OD=" ~ toString(definition.coverOuterDiameter / millimeter) ~
                "mm  innerD=" ~ toString(definition.ringInnerDiameter / millimeter) ~
                "mm  rollers=" ~ toString(definition.numPins) ~ "@D" ~ toString(definition.pinCircleDiameter / millimeter) ~
                (definition.useCoverBolts ? ("  bolts=" ~ toString(definition.coverBoltCount)) : "  [no bolts]") ~
                "  zOff=" ~ toString(definition.zOffset / millimeter) ~ "mm");

        makeTopRollerCover(context, id, definition);
    }
);