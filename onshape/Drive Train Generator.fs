/**
 * Pulley Drivetrain HTD3M -- Generator Layout Reduksi Belt 1/2-Stage
 * ===================================================================
 * Onshape EDU -- FeatureScript 3008
 *
 * Memposisikan komponen drivetrain (pulley + belt HTD3M) dengan jarak
 * antar-sumbu yang BENAR, dihitung dari panjang belt -- sebagai dasar
 * desain case/housing yang dibikin terpisah.
 *
 * - Preset sesuai komponen yang dimiliki: pulley 12T/20T/60T/90T,
 *   belt 270/330/480 mm (pitch length). Semua bisa CUSTOM.
 * - 1 atau 2 stage. Layout stage 2: lurus (inline), lipat balik 180 deg
 *   (bertumpuk kompak), atau sudut bebas. Stage 2 digeser aksial (Z)
 *   supaya shaft tengah bisa bawa 2 pulley.
 * - Jarak antar-sumbu di-solve dari rumus panjang belt terbuka exact:
 *       L(C) = 2*sqrt(C^2 - D^2) + PI*(r1+r2) + 2*D*asin(D/C),  D = |r2-r1|
 *   L(C) monoton naik terhadap C -> bisection, deterministik. Diverifikasi
 *   numerik (Python): 12T+60T belt 270 -> C = 77.590 mm;
 *   20T+90T belt 330 -> C = 74.912 mm; 20T+90T belt 270 -> infeasible.
 * - C1/C2 + rasio total dilaporkan via info message feature.
 *
 * Tooth profile: geometri HTD3M ASLI, bukan approximasi. Konstanta
 * (pitch, u, h, r0, rs) dan algoritma arc construction diambil dari
 * `freecad.gears` (FreeCAD Gears workbench open-source, file
 * timinggear.py, class TimingGear, data["htd3"]) -- proyek yang dipakai
 * luas dan sudah divalidasi komunitas buat generate pulley HTD/GT nyata.
 * Satu "tooth-cell" = 4 arc (root fillet - root valley - root fillet -
 * tip land); N tooth-cell dirangkai jadi SATU closed wire lalu di-extrude
 * SEKALI jadi solid -- gak ada operasi boolean buat bentuk gigi.
 * Pitch diameter (Pd = N * 3mm / pi) EXACT.
 */

FeatureScript 3008;
import(path : "onshape/std/geometry.fs", version : "3008.0");

// ─── Konstanta HTD3M (dari freecad.gears timinggear.py data["htd3"]) ──────────

const htdPitch  = 3 * millimeter;
const htdU      = 0.381 * millimeter;   // pitch radius -> tip radius offset (PLD)
const htdH      = 1.21  * millimeter;   // radial height gigi (tip -> root)
const htdR0     = 0.89  * millimeter;   // radius arc root (r_12 di source)
const htdRs     = 0.26  * millimeter;   // radius arc fillet (r_34 di source)
const beltThk   = 2.4   * millimeter;   // tebal total belt HTD3M standar
const overshoot = 1 * millimeter;

// ─── Presets ──────────────────────────────────────────────────────────────────

export enum PulleyPreset
{
    annotation { "Name" : "12T" }
    T12,
    annotation { "Name" : "20T" }
    T20,
    annotation { "Name" : "60T" }
    T60,
    annotation { "Name" : "90T" }
    T90,
    annotation { "Name" : "Custom" }
    CUSTOM
}

export enum BeltPreset
{
    annotation { "Name" : "270 mm (90 gigi)" }
    L270,
    annotation { "Name" : "330 mm (110 gigi)" }
    L330,
    annotation { "Name" : "480 mm (160 gigi)" }
    L480,
    annotation { "Name" : "Custom" }
    CUSTOM
}

export enum Stage2Layout
{
    annotation { "Name" : "Lurus (inline)" }
    INLINE,
    annotation { "Name" : "Lipat balik (bertumpuk)" }
    FOLDED,
    annotation { "Name" : "Sudut custom" }
    CUSTOM
}

export enum AlignAnchor
{
    annotation { "Name" : "Pulley input (poros awal)" }
    INPUT,
    annotation { "Name" : "Pulley output (poros akhir)" }
    OUTPUT
}

function presetTeeth(preset is PulleyPreset, customTeeth) returns number
{
    if (preset == PulleyPreset.T12)
        return 12;
    if (preset == PulleyPreset.T20)
        return 20;
    if (preset == PulleyPreset.T60)
        return 60;
    if (preset == PulleyPreset.T90)
        return 90;
    return customTeeth;
}

function presetBeltLength(preset is BeltPreset, customLength) returns ValueWithUnits
{
    if (preset == BeltPreset.L270)
        return 270 * millimeter;
    if (preset == BeltPreset.L330)
        return 330 * millimeter;
    if (preset == BeltPreset.L480)
        return 480 * millimeter;
    return customLength;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Plane sejajar `base`, digeser sejauh `z` di sepanjang normal `base`.
function offsetPlane(base is Plane, z is ValueWithUnits) returns Plane
{
    return plane(base.origin + base.normal * z, base.normal, base.x);
}

// Rotasi titik 2D (di XY plane) sejauh `ang` di sekitar origin.
function rot2d(p is Vector, ang is ValueWithUnits) returns Vector
{
    return vector(p[0] * cos(ang) - p[1] * sin(ang), p[0] * sin(ang) + p[1] * cos(ang));
}

// Pitch radius ASLI pulley HTD3M (dipakai untuk hitungan belt; profil gigi
// pakai rp = pitchRadius - htdU sesuai algoritma source).
function pitchRadius(numTeeth is number) returns ValueWithUnits
{
    return numTeeth * htdPitch / (2 * PI);
}

// Panjang belt terbuka exact untuk dua pulley (pitch radius r1, r2) dengan
// jarak antar-sumbu C.
function openBeltLength(C is ValueWithUnits, r1 is ValueWithUnits, r2 is ValueWithUnits) returns ValueWithUnits
{
    var D = abs(r2 - r1);
    return 2 * sqrt(C * C - D * D) + PI * (r1 + r2) + 2 * D * (asin(D / C) / radian);
}

// Solve jarak antar-sumbu C dari panjang belt L. L(C) monoton naik -> bisection.
// Return undefined kalau infeasible (belt kependekan bahkan saat C minimum).
function solveCenterDistance(L is ValueWithUnits, r1 is ValueWithUnits, r2 is ValueWithUnits)
{
    var lo = abs(r2 - r1) + 1e-6 * millimeter;
    var hi = L / 2;   // L(C) >= 2C, jadi C solusi selalu < L/2
    if (hi <= lo || openBeltLength(lo, r1, r2) >= L)
        return undefined;
    for (var i = 0; i < 80; i += 1)
    {
        var mid = (lo + hi) / 2;
        if (openBeltLength(mid, r1, r2) > L)
            hi = mid;
        else
            lo = mid;
    }
    return (lo + hi) / 2;
}

// Validasi hasil solver: selain solvable, kedua pulley juga gak boleh
// tabrakan (C harus > r1 + r2 + margin).
function requireFeasible(C, r1 is ValueWithUnits, r2 is ValueWithUnits, teeth1 is number, teeth2 is number, L is ValueWithUnits, stageLabel is string) returns ValueWithUnits
{
    if (C == undefined || C < r1 + r2 + 1 * millimeter)
        throw regenError(stageLabel ~ ": belt " ~ fmtMm(L) ~ " mm kependekan untuk pulley " ~ teeth1 ~ "T + " ~ teeth2 ~
            "T -- pulley bakal tabrakan. Pakai belt lebih panjang atau pulley lebih kecil.");
    return C;
}

// Format panjang jadi string mm 1 desimal (buat pesan info/error).
function fmtMm(x is ValueWithUnits) returns string
{
    return toString(round(x / millimeter * 10) / 10);
}

// ─── Builder: satu pulley bergigi + bore ──────────────────────────────────────
// Bangun pulley HTD3M `numTeeth` gigi setebal `width`, pusatnya di koordinat
// 2D `center` (frame basePlane: x = basePlane.x, y = normal x-cross-x) dan
// mulai di ketinggian `zStart` sepanjang normal. Origin plane pulley = pusat
// pulley, jadi seluruh matematika profil tetap origin-centered (tak berubah
// dari versi single-pulley sebelumnya).
function buildPulley(context is Context, id is Id, suffix is string, basePlane is Plane, center is Vector, zStart is ValueWithUnits, numTeeth is number, width is ValueWithUnits, boreR is ValueWithUnits)
{
    var N = numTeeth;
    var theta = 360 * degree / N;   // sudut satu tooth-pitch penuh

    // rp = pitch radius standar dikurangi u -- lihat source freecad.gears.
    var rp = pitchRadius(N) - htdU;

    // Titik-titik profil "tooth-cell" acuan (tooth ke-0), persis formula asli.
    var m34    = vector(-(htdR0 + htdRs), rp - htdH + htdR0);
    var x2     = vector(-htdR0,           rp - htdH + htdR0);
    var x4     = vector(-(htdR0 + htdRs), rp - htdH + htdR0 + htdRs);
    var xn2    = vector( htdR0,           rp - htdH + htdR0);
    var xn4    = vector( htdR0 + htdRs,   rp - htdH + htdR0 + htdRs);
    var mn34   = vector( htdR0 + htdRs,   rp - htdH + htdR0);
    var rootPt = vector(0 * millimeter,   rp - htdH);

    // x6 = titik akhir tooth-cell = xn4 di-rotate satu theta penuh (N cell
    // yang di-rotate berurutan otomatis nyambung jadi satu closed loop).
    var x6 = rot2d(xn4, theta);

    // Mid-point tiap arc (buat skArc 3-titik).
    var arc1Mid = mn34 + htdRs * normalize((xn4 + xn2) / 2 - mn34);
    var arc3Mid = m34  + htdRs * normalize((x2 + x4) / 2 - m34);
    var Rtip    = norm(x4);   // tip land = arc konsentris radius ini
    var arc4Mid = Rtip * normalize((x4 + x6) / 2);

    var Rroot = rp - htdH;
    if (Rroot <= boreR + 0.5 * millimeter)
        throw regenError("Bore terlalu besar untuk pulley " ~ N ~ "T -- root circle HTD3M kegencet bore. Kecilkan diameter bore atau tambah jumlah gigi.");

    // Plane pulley: origin = pusat pulley di (center, zStart).
    var yDir = cross(basePlane.normal, basePlane.x);
    var origin3d = basePlane.origin + basePlane.x * center[0] + yDir * center[1] + basePlane.normal * zStart;
    var pulleyPlane = plane(origin3d, basePlane.normal, basePlane.x);

    // Blank bergigi: N tooth-cell (masing2 4 arc) jadi SATU closed wire di
    // satu sketch, lalu satu extrude.
    var skToothId = id + (suffix ~ "skTooth");
    var skTooth = newSketchOnPlane(context, skToothId, { "sketchPlane" : pulleyPlane });
    for (var i = 0; i < N; i += 1)
    {
        var rot = i * theta;
        var tId = "tooth" ~ toString(i);
        skArc(skTooth, tId ~ "a1", { "start" : rot2d(xn4, rot), "mid" : rot2d(arc1Mid, rot), "end" : rot2d(xn2, rot) });
        skArc(skTooth, tId ~ "a2", { "start" : rot2d(xn2, rot), "mid" : rot2d(rootPt, rot),  "end" : rot2d(x2, rot)  });
        skArc(skTooth, tId ~ "a3", { "start" : rot2d(x2, rot),  "mid" : rot2d(arc3Mid, rot), "end" : rot2d(x4, rot)  });
        skArc(skTooth, tId ~ "a4", { "start" : rot2d(x4, rot),  "mid" : rot2d(arc4Mid, rot), "end" : rot2d(x6, rot)  });
    }
    skSolve(skTooth);
    opExtrude(context, id + (suffix ~ "extTooth"), {
        "entities"  : qSketchRegion(skToothId),
        "direction" : basePlane.normal,
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : width
    });
    var body = qCreatedBy(id + (suffix ~ "extTooth"), EntityType.BODY);

    // Bore tembus (sketch mundur overshoot, extrude lebih -- gotcha D4).
    var skBoreId = id + (suffix ~ "skBore");
    var skBore = newSketchOnPlane(context, skBoreId, {
        "sketchPlane" : plane(origin3d - basePlane.normal * overshoot, basePlane.normal, basePlane.x)
    });
    skCircle(skBore, "b", { "center" : vector(0, 0) * millimeter, "radius" : boreR });
    skSolve(skBore);
    opExtrude(context, id + (suffix ~ "extBore"), {
        "entities"  : qCreatedBy(skBoreId, EntityType.FACE),
        "direction" : basePlane.normal,
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : width + 2 * overshoot
    });
    opBoolean(context, id + (suffix ~ "boolBore"), {
        "tools"         : qCreatedBy(id + (suffix ~ "extBore"), EntityType.BODY),
        "targets"       : body,
        "operationType" : BooleanOperationType.SUBTRACTION
    });

    // Bersihkan sketch kerja (wire gigi + circle bore).
    opDeleteBodies(context, id + (suffix ~ "delWork"), {
        "entities" : qUnion([ qCreatedBy(skToothId, EntityType.BODY), qCreatedBy(skBoreId, EntityType.BODY) ])
    });
}

// ─── Builder: body belt smooth satu stage ─────────────────────────────────────
// Belt digambar sebagai path tertutup (2 garis tangen + 2 arc wrap) di
// mid-plane belt (z = zMid), lalu extrude jadi surface dan di-thicken
// (pola sama dengan belt.fs Onshape). Path digambar di radius "mid" belt
// (pitch + beltThk/2 - htdU), BUKAN pitch radius, supaya opThicken bisa
// simetris (orientasi normal surface hasil extrude tidak deterministik):
// inner face jatuh pas di tip radius pulley, outer face = punggung belt.
// Offset radius sama di kedua pulley tidak mengubah geometri tangen
// (alpha = (r1-r2)/C invariant), jadi path tetap konsisten.
function buildBelt(context is Context, id is Id, suffix is string, basePlane is Plane, c1 is Vector, c2 is Vector, r1pitch is ValueWithUnits, r2pitch is ValueWithUnits, zMid is ValueWithUnits, width is ValueWithUnits)
{
    var rMid1 = r1pitch + (beltThk / 2 - htdU);
    var rMid2 = r2pitch + (beltThk / 2 - htdU);

    // Titik tangen analitik (adaptasi getProfilePoints dari belt.fs,
    // kasus dua pulley external / open belt).
    var span = norm(c2 - c1);
    var d = (c2 - c1) / span;
    var t = vector(-d[1], d[0]);
    var alpha = (rMid1 - rMid2) / span;
    var beta = sqrt(1 - alpha * alpha);

    var nUp = alpha * d + beta * t;
    var nDn = alpha * d - beta * t;
    var pA1 = c1 + nUp * rMid1;   // tangen atas di pulley 1
    var pA2 = c2 + nUp * rMid2;   // tangen atas di pulley 2
    var pB1 = c1 + nDn * rMid1;   // tangen bawah di pulley 1
    var pB2 = c2 + nDn * rMid2;   // tangen bawah di pulley 2

    var skId = id + (suffix ~ "sk");
    var sk = newSketchOnPlane(context, skId, { "sketchPlane" : offsetPlane(basePlane, zMid) });
    skLineSegment(sk, "spanUp", { "start" : pA1, "end" : pA2 });
    skLineSegment(sk, "spanDn", { "start" : pB2, "end" : pB1 });
    // Mid arc = titik terluar wrap (menjauhi pulley lawan), simetris
    // terhadap garis antar-pusat.
    skArc(sk, "wrap1", { "start" : pB1, "mid" : c1 - d * rMid1, "end" : pA1 });
    skArc(sk, "wrap2", { "start" : pA2, "mid" : c2 + d * rMid2, "end" : pB2 });
    skSolve(sk);

    // Extrude WIRE path jadi surface (simetris dari mid-plane), lalu thicken.
    var extId = id + (suffix ~ "ext");
    var pathEdges = qConstructionFilter(qBodyType(qCreatedBy(skId, EntityType.EDGE), BodyType.WIRE), ConstructionObject.NO);
    opExtrude(context, extId, {
        "entities"   : pathEdges,
        "direction"  : basePlane.normal,
        "startBound" : BoundingType.BLIND,
        "startDepth" : width / 2,
        "endBound"   : BoundingType.BLIND,
        "endDepth"   : width / 2
    });
    opThicken(context, id + (suffix ~ "thicken"), {
        "entities"   : qCreatedBy(extId, EntityType.FACE),
        "thickness1" : beltThk / 2,
        "thickness2" : beltThk / 2
    });

    // Bersihkan body kerja (sketch path + surface extrude).
    opDeleteBodies(context, id + (suffix ~ "delWork"), {
        "entities" : qUnion([ qCreatedBy(skId, EntityType.BODY), qCreatedBy(extId, EntityType.BODY) ])
    });
}

// ─── Feature Definition ───────────────────────────────────────────────────────

annotation { "Feature Type Name" : "Pulley Drivetrain HTD3M", "Feature Name Template" : "Drivetrain #ratio:1" }
export const pulleyDrivetrainHTD3M = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "2 stage", "Default" : true }
        definition.twoStage is boolean;

        annotation { "Group Name" : "Stage 1", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Pulley driver (input)", "Default" : "T12", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            definition.s1Driver is PulleyPreset;

            if (definition.s1Driver == PulleyPreset.CUSTOM)
            {
                annotation { "Name" : "Gigi driver stage 1" }
                isInteger(definition.s1DriverTeeth, { (unitless) : [10, 20, 200] } as IntegerBoundSpec);
            }

            annotation { "Name" : "Pulley driven", "Default" : "T60", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            definition.s1Driven is PulleyPreset;

            if (definition.s1Driven == PulleyPreset.CUSTOM)
            {
                annotation { "Name" : "Gigi driven stage 1" }
                isInteger(definition.s1DrivenTeeth, { (unitless) : [10, 20, 200] } as IntegerBoundSpec);
            }

            annotation { "Name" : "Belt stage 1", "Default" : "L270", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            definition.s1Belt is BeltPreset;

            if (definition.s1Belt == BeltPreset.CUSTOM)
            {
                annotation { "Name" : "Panjang belt stage 1 (pitch)" }
                isLength(definition.s1BeltLength, { (millimeter) : [100, 270, 1500] } as LengthBoundSpec);
            }
        }

        if (definition.twoStage)
        {
            annotation { "Group Name" : "Stage 2", "Collapsed By Default" : false }
            {
                annotation { "Name" : "Pulley driver (di shaft tengah)", "Default" : "T20", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                definition.s2Driver is PulleyPreset;

                if (definition.s2Driver == PulleyPreset.CUSTOM)
                {
                    annotation { "Name" : "Gigi driver stage 2" }
                    isInteger(definition.s2DriverTeeth, { (unitless) : [10, 20, 200] } as IntegerBoundSpec);
                }

                annotation { "Name" : "Pulley driven (output)", "Default" : "T90", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                definition.s2Driven is PulleyPreset;

                if (definition.s2Driven == PulleyPreset.CUSTOM)
                {
                    annotation { "Name" : "Gigi driven stage 2" }
                    isInteger(definition.s2DrivenTeeth, { (unitless) : [10, 20, 200] } as IntegerBoundSpec);
                }

                annotation { "Name" : "Belt stage 2", "Default" : "L330", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                definition.s2Belt is BeltPreset;

                if (definition.s2Belt == BeltPreset.CUSTOM)
                {
                    annotation { "Name" : "Panjang belt stage 2 (pitch)" }
                    isLength(definition.s2BeltLength, { (millimeter) : [100, 330, 1500] } as LengthBoundSpec);
                }
            }
        }

        annotation { "Group Name" : "Layout", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Sudut arah stage 1", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isAngle(definition.stage1Angle, { (degree) : [-360, 0, 360] } as AngleBoundSpec);

            if (definition.twoStage)
            {
                annotation { "Name" : "Layout stage 2", "Default" : "INLINE", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                definition.stage2Layout is Stage2Layout;

                if (definition.stage2Layout == Stage2Layout.CUSTOM)
                {
                    annotation { "Name" : "Sudut stage 2 (relatif stage 1)" }
                    isAngle(definition.stage2Angle, { (degree) : [-360, 90, 360] } as AngleBoundSpec);
                }

                annotation { "Name" : "Offset aksial stage 2", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.stageOffset, { (millimeter) : [0, 11, 100] } as LengthBoundSpec);
            }
        }

        annotation { "Group Name" : "Belt & Lebar", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Lebar belt (= tebal pulley)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.beltWidth, { (millimeter) : [3, 9, 50] } as LengthBoundSpec);

            annotation { "Name" : "Generate body belt", "Default" : true }
            definition.generateBelts is boolean;
        }

        annotation { "Group Name" : "Bore", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Diameter bore shaft input", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.boreInput, { (millimeter) : [1, 5, 60] } as LengthBoundSpec);

            if (definition.twoStage)
            {
                annotation { "Name" : "Diameter bore shaft tengah", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.boreMid, { (millimeter) : [1, 5, 60] } as LengthBoundSpec);
            }

            annotation { "Name" : "Diameter bore shaft output", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.boreOutput, { (millimeter) : [1, 5, 60] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Placement", "Collapsed By Default" : true }
        {
            // Plane tempat generate. Kosong = XY global. Normal-nya = arah poros.
            annotation { "Name" : "Generate di plane / face", "Filter" : EntityType.FACE && GeometryType.PLANE, "MaxNumberOfPicks" : 1 }
            definition.buildPlane is Query;

            annotation { "Name" : "Balik arah normal", "UIHint" : ["OPPOSITE_DIRECTION", "REMEMBER_PREVIOUS_VALUE"] }
            definition.flipDirection is boolean;

            // Opsional: geser + puter layout biar poros pilihan sejajar & duduk
            // di mate connector ini. Kosong = biarkan di plane apa adanya.
            annotation { "Name" : "Sejajarkan ke mate connector", "Filter" : BodyType.MATE_CONNECTOR, "MaxNumberOfPicks" : 1 }
            definition.alignMate is Query;

            annotation { "Name" : "Poros yang disejajarkan", "Default" : "INPUT", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            definition.alignAnchor is AlignAnchor;
        }
    }
    {
        // Plane tempat generate (arah poros = normal-nya), atau XY global kalau
        // gak dipilih. Mate connector (opsional) dipakai nanti di blok "align"
        // buat geser + muter layout, bukan buat nentuin plane ini.
        var basePlane is Plane = isQueryEmpty(context, definition.buildPlane)
            ? plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1))
            : evPlane(context, { "face" : definition.buildPlane });
        if (definition.flipDirection)
            basePlane = plane(basePlane.origin, -basePlane.normal, basePlane.x);

        var w = definition.beltWidth;

        // ── Stage 1: shaft A (input, di origin) -> shaft B ─────────────────────
        var t1 = presetTeeth(definition.s1Driver, definition.s1DriverTeeth);
        var t2 = presetTeeth(definition.s1Driven, definition.s1DrivenTeeth);
        var L1 = presetBeltLength(definition.s1Belt, definition.s1BeltLength);
        var r1 = pitchRadius(t1);
        var r2 = pitchRadius(t2);
        var C1 = requireFeasible(solveCenterDistance(L1, r1, r2), r1, r2, t1, t2, L1, "Stage 1");

        var a1 = definition.stage1Angle;
        var posA = vector(0, 0) * millimeter;
        var posB = posA + C1 * vector(cos(a1), sin(a1));

        buildPulley(context, id, "p1", basePlane, posA, 0 * millimeter, t1, w, definition.boreInput / 2);
        var boreShaftB = definition.twoStage ? definition.boreMid : definition.boreOutput;
        buildPulley(context, id, "p2", basePlane, posB, 0 * millimeter, t2, w, boreShaftB / 2);
        if (definition.generateBelts)
            buildBelt(context, id, "b1", basePlane, posA, posB, r1, r2, w / 2, w);

        var ratio = t2 / t1;
        var info = "C1 = " ~ fmtMm(C1) ~ " mm";

        // Posisi 2D poros output: shaft B (1 stage) atau shaft C (2 stage, di-set ulang di bawah).
        var outPos2d = posB;

        // ── Stage 2: shaft B (tengah) -> shaft C (output), digeser aksial ──────
        if (definition.twoStage)
        {
            var t3 = presetTeeth(definition.s2Driver, definition.s2DriverTeeth);
            var t4 = presetTeeth(definition.s2Driven, definition.s2DrivenTeeth);
            var L2 = presetBeltLength(definition.s2Belt, definition.s2BeltLength);
            var r3 = pitchRadius(t3);
            var r4 = pitchRadius(t4);
            var C2 = requireFeasible(solveCenterDistance(L2, r3, r4), r3, r4, t3, t4, L2, "Stage 2");

            var a2 = a1;
            if (definition.stage2Layout == Stage2Layout.FOLDED)
                a2 = a1 + 180 * degree;
            else if (definition.stage2Layout == Stage2Layout.CUSTOM)
                a2 = a1 + definition.stage2Angle;

            var posC = posB + C2 * vector(cos(a2), sin(a2));
            outPos2d = posC;
            var z2 = definition.stageOffset;

            buildPulley(context, id, "p3", basePlane, posB, z2, t3, w, definition.boreMid / 2);
            buildPulley(context, id, "p4", basePlane, posC, z2, t4, w, definition.boreOutput / 2);
            if (definition.generateBelts)
                buildBelt(context, id, "b2", basePlane, posB, posC, r3, r4, z2 + w / 2, w);

            ratio = ratio * (t4 / t3);
            info = info ~ " | C2 = " ~ fmtMm(C2) ~ " mm";
        }

        // ── Align opsional: sejajarkan poros pilihan ke mate connector ─────────
        // Rotasi seluruh drivetrain (di sekitar poros pilihan, tetap tegak lurus
        // plane) biar sumbu X-nya searah mate connector, lalu geser biar poros itu
        // duduk pas di origin mate connector. Poros lain ikut. Arah poros TIDAK
        // dimiringkan -- tetap = normal plane (sesuai "generate di plane A").
        if (!isQueryEmpty(context, definition.alignMate))
        {
            var mc = evMateConnector(context, { "mateConnector" : definition.alignMate });
            var nrm = basePlane.normal;
            var yDir = cross(nrm, basePlane.x);

            // Sumbu X mate connector diproyeksikan ke plane -> sudut rotasi in-plane.
            var mxIn = mc.xAxis - dot(mc.xAxis, nrm) * nrm;
            var phi = 0 * radian;
            if (norm(mxIn) > 1e-6)   // skip kalau MC tegak lurus plane (proyeksi ~0)
            {
                var xp = normalize(mxIn);
                phi = atan2(dot(yDir, xp), dot(basePlane.x, xp));
            }

            var anchor2d = definition.alignAnchor == AlignAnchor.INPUT ? posA : outPos2d;
            var anchorPt = basePlane.origin + basePlane.x * anchor2d[0] + yDir * anchor2d[1];

            // Geser cuma DI DALAM plane: buang komponen normal biar part gak
            // ikut turun/naik ke posisi mate connector, tetap di plane-nya.
            var delta = mc.origin - anchorPt;
            delta = delta - dot(delta, nrm) * nrm;

            var rot = rotationAround(line(anchorPt, nrm), phi);   // anchor tetap saat diputar
            var move = transform(delta);                          // transform(Vector) = translasi murni
            opTransform(context, id + "align", {
                "bodies"    : qCreatedBy(id, EntityType.BODY),
                "transform" : move * rot
            });
        }

        var ratioRounded = round(ratio * 100) / 100;
        info = info ~ " | rasio total " ~ ratioRounded ~ ":1";
        reportFeatureInfo(context, id, info);
        setFeatureComputedParameter(context, id, { "name" : "ratio", "value" : ratioRounded });
    });
