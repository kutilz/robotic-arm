/**
 * Ball Groove Generator - groove pada cylindrical face yang dipilih user
 * ======================================================================
 * Onshape EDU - FeatureScript 3008
 *
 * Mode:
 *   AUTO            - pilih satu cyl face dari tube; groove di kedua face coaxial
 *   OUTER_FACE_ONLY - pilih outer cyl face; groove cut radial inward
 *   INNER_FACE_ONLY - pilih inner cyl face (bore); groove cut radial outward
 *
 * Crown/lip (optional):
 *   off  - cutter half-torus sederhana (axial extent = 2*grooveR)
 *   on   - 90deg arc + 45deg chamfer + lip wall (axial extent = 2*yLip)
 *          Math identik bearing.fs (yArc = grooveR/sqrt2, yLip = grooveR*sqrt2 - lip)
 *
 * Crown retainer (optional):
 *   Crown cage satu sisi, port geometri model FreeCAD crown_v2
 *   (freecad-bearing-python/): ring annulus separuh solid, sphere pocket
 *   (ballR + margin) di muka band solid, prong runcing dari diagonal lurus
 *   antar-pocket + dua flex slot vertikal per pocket.
 *
 * Pattern groove + lip math diadaptasi dari bearing.fs:175-260.
 */

FeatureScript 3008;
import(path : "onshape/std/geometry.fs", version : "3008.0");

// ─── Enum ─────────────────────────────────────────────────────────────────────
export enum GrooveMode
{
    annotation { "Name" : "Auto (detect tube)" }    AUTO,
    annotation { "Name" : "Outer face only" }       OUTER_FACE_ONLY,
    annotation { "Name" : "Inner face only" }       INNER_FACE_ONLY
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Pick unit vector perpendicular to `dir` (deterministic, no global state).
function pickPerpVector(dir is Vector) returns Vector
{
    var d = normalize(dir);
    var ref = abs(d[2]) < 0.9 ? vector(0, 0, 1) : vector(1, 0, 0);
    return normalize(cross(d, ref));
}

// Format ValueWithUnits panjang -> string mm (4 desimal) untuk debug print.
function mmStr(v is ValueWithUnits) returns string
{
    return toString(roundToPrecision(v / millimeter, 4));
}

// Kumpulkan baris debug: println (console) + simpan ke box untuk dilaporkan
// sebagai feature status di akhir regen (println tidak selalu tampil di
// notices Part Studio).
function dbgOut(lines is box, msg is string)
{
    println(msg);
    lines[] = append(lines[], msg);
}

// 8 corners dari axis-aligned bounding box.
function bboxCorners(bbox is Box3d) returns array
{
    var lo = bbox.minCorner;
    var hi = bbox.maxCorner;
    return [
        vector(lo[0], lo[1], lo[2]),
        vector(hi[0], lo[1], lo[2]),
        vector(lo[0], hi[1], lo[2]),
        vector(hi[0], hi[1], lo[2]),
        vector(lo[0], lo[1], hi[2]),
        vector(hi[0], lo[1], hi[2]),
        vector(lo[0], hi[1], hi[2]),
        vector(hi[0], hi[1], hi[2])
    ];
}

// Inspect cylindrical face. Returns { axis, radius, isOuter, axialMin, axialMax }.
// Throws regenError kalau face bukan silinder.
function inspectCylFace(context is Context, face is Query) returns map
{
    var axisResult = try(evAxis(context, { "axis" : face }));
    if (axisResult == undefined)
        throw regenError("Face yang dipilih tidak punya axis (bukan silinder).");
    var axisLine = axisResult;

    var tanPlane = evFaceTangentPlane(context, {
                "face" : face,
                "parameter" : vector(0.5, 0.5)
            });
    var samplePt = tanPlane.origin;

    var axisDir = normalize(axisLine.direction);
    var t = dot(samplePt - axisLine.origin, axisDir);
    var projected = axisLine.origin + t * axisDir;
    var radialVec = samplePt - projected;
    var radius = norm(radialVec);
    if (radius < 1e-5 * millimeter)
        throw regenError("Face tidak punya radius valid.");
    var radialOut = radialVec / radius;

    // Inner-vs-outer: offset sample point inward radially. Kalau di dalam body
    // -> material extends ke axis -> face adalah OUTER face. Kalau di luar
    // body (di bore) -> face adalah INNER face (bore).
    var ownerBody = qOwnerBody(face);
    var testInsidePt = samplePt - 0.01 * millimeter * radialOut;
    var containingQ = qContainsPoint(ownerBody, testInsidePt);
    var isOuter = size(evaluateQuery(context, containingQ)) > 0;

    var bbox = evBox3d(context, { "topology" : face });
    var corners = bboxCorners(bbox);
    var minProj = dot(corners[0] - axisLine.origin, axisDir);
    var maxProj = minProj;
    for (var i = 1; i < 8; i += 1)
    {
        var p = dot(corners[i] - axisLine.origin, axisDir);
        if (p < minProj) minProj = p;
        if (p > maxProj) maxProj = p;
    }

    return {
                "axis"     : axisLine,
                "radius"   : radius,
                "isOuter"  : isOuter,
                "axialMin" : minProj,
                "axialMax" : maxProj
            };
}

// Proyeksikan extent aksial `info` ke frame axis referensi (refOrigin, refDir).
// Origin/arah evAxis bisa beda antar face coaxial, jadi extent dua face TIDAK
// boleh di-min/max langsung tanpa konversi ini.
function extentInFrame(info is map, refOrigin is Vector, refDir is Vector) returns map
{
    var d = normalize(info.axis.direction);
    var lo3d = info.axis.origin + info.axialMin * d;
    var hi3d = info.axis.origin + info.axialMax * d;
    var t1 = dot(lo3d - refOrigin, refDir);
    var t2 = dot(hi3d - refOrigin, refDir);
    return { "lo" : min(t1, t2), "hi" : max(t1, t2) };
}

// Cari cylindrical face di body yang sama, coaxial, dgn orientasi berlawanan
// dari `primary`. Return { face, info } atau undefined kalau tidak ketemu.
function findCoaxialPartner(context is Context, body is Query, primaryFace is Query, primary is map)
{
    var otherFacesQ = qSubtraction(qOwnedByBody(body, EntityType.FACE), primaryFace);
    var cylFacesQ = qGeometry(otherFacesQ, GeometryType.CYLINDER);
    var others = evaluateQuery(context, cylFacesQ);

    var primaryDir = normalize(primary.axis.direction);
    var primaryOrigin = primary.axis.origin;
    var axisTol = 1e-4;                       // unitless: 1 - |dirDot|
    var originTol = 1e-3 * millimeter;        // perpendicular distance antar axis origins

    var bestFace = undefined;
    var bestInfo = undefined;
    var minRadDist = undefined;

    for (var f in others)
    {
        var infoTry = try(inspectCylFace(context, f));
        if (infoTry == undefined) continue;
        var info = infoTry;

        // Coaxial: direction parallel + origins colinear (perp offset ~ 0)
        var dirDot = abs(dot(normalize(info.axis.direction), primaryDir));
        if (1 - dirDot > axisTol) continue;
        var originDiff = info.axis.origin - primaryOrigin;
        var perpComp = originDiff - dot(originDiff, primaryDir) * primaryDir;
        if (norm(perpComp) > originTol) continue;

        // Orientasi harus berlawanan (satu outer, satu inner)
        if (info.isOuter == primary.isOuter) continue;

        // Pilih yang punya axial overlap terbesar dgn primary. Extent kandidat
        // dikonversi dulu ke frame axis primary.
        var ext = extentInFrame(info, primaryOrigin, primaryDir);
        var ovLo = ext.lo > primary.axialMin ? ext.lo : primary.axialMin;
        var ovHi = ext.hi < primary.axialMax ? ext.hi : primary.axialMax;
        var overlap = ovHi - ovLo;

        // Membutuhkan overlap aksial non-trivial (minimal 20% dari panjang face yang lebih pendek)
        var minOverlap = min(primary.axialMax - primary.axialMin, ext.hi - ext.lo) * 0.2;
        if (overlap < minOverlap) continue;

        var radDist = abs(primary.radius - info.radius);
        if (minRadDist == undefined || radDist < minRadDist)
        {
            minRadDist = radDist;
            bestFace = f;
            bestInfo = info;
        }
    }

    if (bestFace == undefined) return undefined;
    return { "face" : bestFace, "info" : bestInfo };
}

// Gabungkan extent aksial semua segmen cylinder coaxial se-radius dan
// se-orientasi pada body pemilik `face`. Groove dari feature sebelumnya
// membelah cylindrical face jadi beberapa segmen; validasi batas aman harus
// pakai extent face asli (gabungan), bukan extent satu segmen, supaya tidak
// false-positive.
function mergeCoaxialSegments(context is Context, face is Query, info is map) returns map
{
    var merged = info;
    var dir = normalize(info.axis.direction);
    var origin = info.axis.origin;

    var siblingsQ = qGeometry(
        qSubtraction(qOwnedByBody(qOwnerBody(face), EntityType.FACE), face),
        GeometryType.CYLINDER);
    for (var f in evaluateQuery(context, siblingsQ))
    {
        var oi = try(inspectCylFace(context, f));
        if (oi == undefined) continue;
        if (abs(oi.radius - info.radius) > 1e-3 * millimeter) continue;
        if (oi.isOuter != info.isOuter) continue;

        var dirDot = dot(normalize(oi.axis.direction), dir);
        if (1 - abs(dirDot) > 1e-4) continue;
        var originDiff = oi.axis.origin - origin;
        var perpComp = originDiff - dot(originDiff, dir) * dir;
        if (norm(perpComp) > 1e-3 * millimeter) continue;

        // Konversi extent segmen ke frame axis `info` (origin/arah bisa beda)
        var base = dot(originDiff, dir);
        var lo = base + (dirDot > 0 ? oi.axialMin : -oi.axialMax);
        var hi = base + (dirDot > 0 ? oi.axialMax : -oi.axialMin);
        if (lo < merged.axialMin) merged.axialMin = lo;
        if (hi > merged.axialMax) merged.axialMax = hi;
    }
    return merged;
}

// Bangun cutter + subtract dari owner body. Wraps per-face validation.
// Pattern from bearing.fs:175-260 (groove + lip math).
// Profile: chamfer 45 + arc 90 + chamfer 45 + closing line (4 segmen).
function applyGroove(context is Context, id is Id, suffix is string,
                      info is map, ballR is ValueWithUnits, clearance is ValueWithUnits,
                      lipParam is ValueWithUnits, axialCenter is ValueWithUnits,
                      ownerBody is Query)
{
    var grooveR = ballR + clearance;
    var faceR = info.radius;
    var faceLength = info.axialMax - info.axialMin;
    var isOuter = info.isOuter;
    var axisLine = info.axis;

    var root2 = sqrt(2.0);
    var yArc = grooveR / root2;
    var lip = lipParam;
    if (lip >= yArc)
    {
        throw regenError("Celah (gap) atau Crown width terlalu lebar untuk diameter bola ini. Tangent line berpotongan negatif di belakang arc (lip = " ~ toString(lip) ~ ", yArc = " ~ toString(yArc) ~ ").");
    }
    if (lip < 0 * millimeter) lip = 0 * millimeter;
    var yLip = grooveR * root2 - lip;
    var halfExtent = yLip;

    // Validasi axial fit
    if (2 * halfExtent > faceLength)
    {
        reportFeatureWarning(context, id, "Groove axial extent (" ~ toString(2 * halfExtent)
            ~ ") tidak muat di face panjang " ~ toString(faceLength)
            ~ ". Kurangi ball diameter atau lip width.");
    }
    var minCenter = info.axialMin + halfExtent;
    var maxCenter = info.axialMax - halfExtent;
    if (axialCenter < minCenter || axialCenter > maxCenter)
    {
        reportFeatureWarning(context, id, "Groove " ~ suffix ~ " berada di luar batas aman face (mungkin tidak sejajar secara visual atau terpotong).");
    }

    // Validasi radial - groove tidak boleh tembus axis (only matters for outer face)
    if (isOuter && faceR - grooveR < 0.5 * millimeter)
    {
        throw regenError("Groove terlalu dalam: faceR (" ~ toString(faceR)
            ~ ") - grooveR (" ~ toString(grooveR) ~ ") < 0.5mm. "
            ~ "Kecilkan ball diameter atau pakai face dgn radius lebih besar.");
    }

    // Sketch plane: berisi cylinder axis. Local X = radial outward, Y = axial.
    var perp = pickPerpVector(axisLine.direction);
    var axisDir = normalize(axisLine.direction);
    var planeNormal = cross(perp, axisDir);
    var sketchPlane = plane(axisLine.origin, planeNormal, perp);

    var skId  = id + ("sk"  ~ suffix);
    var revId = id + ("rev" ~ suffix);
    var cutId = id + ("cut" ~ suffix);

    var sk = newSketchOnPlane(context, skId, { "sketchPlane" : sketchPlane });

    var cy = axialCenter;

    if (isOuter)
    {
        // Cut radial inward. Lip wall di face surface (radius = faceR).
        var ballPitchR = faceR + lip;
        var xArcTan = ballPitchR - yArc;
        var arcMidR = ballPitchR - grooveR;

        skLineSegment(sk, "lb",  { "start" : vector(faceR,   cy - yLip), "end" : vector(xArcTan, cy - yArc) });
        skArc(sk, "arc", {
                    "start" : vector(xArcTan, cy - yArc),
                    "mid"   : vector(arcMidR, cy),
                    "end"   : vector(xArcTan, cy + yArc)
                });
        skLineSegment(sk, "lt",  { "start" : vector(xArcTan, cy + yArc), "end" : vector(faceR,   cy + yLip) });
        skLineSegment(sk, "cl",  { "start" : vector(faceR,   cy + yLip), "end" : vector(faceR,   cy - yLip) });
    }
    else
    {
        // Cut radial outward. Lip wall di bore surface (radius = faceR).
        var ballPitchR = faceR - lip;
        var xArcTan = ballPitchR + yArc;
        var arcMidR = ballPitchR + grooveR;

        skLineSegment(sk, "lb",  { "start" : vector(faceR,   cy + yLip), "end" : vector(xArcTan, cy + yArc) });
        skArc(sk, "arc", {
                    "start" : vector(xArcTan, cy + yArc),
                    "mid"   : vector(arcMidR, cy),
                    "end"   : vector(xArcTan, cy - yArc)
                });
        skLineSegment(sk, "lt",  { "start" : vector(xArcTan, cy - yArc), "end" : vector(faceR,   cy - yLip) });
        skLineSegment(sk, "cl",  { "start" : vector(faceR,   cy - yLip), "end" : vector(faceR,   cy + yLip) });
    }
    skSolve(sk);

    try
    {
        opRevolve(context, revId, {
                    "entities"     : qSketchRegion(skId),
                    "axis"         : axisLine,
                    "angleForward" : 360 * degree
                });
    }
    catch
    {
        throw regenError("Gagal revolve groove cutter (face " ~ suffix ~ "). Cek profil sketch / axis.");
    }

    try
    {
        opBoolean(context, cutId, {
                    "tools"         : qCreatedBy(revId, EntityType.BODY),
                    "targets"       : ownerBody,
                    "operationType" : BooleanOperationType.SUBTRACTION
                });
    }
    catch
    {
        reportFeatureWarning(context, id,
            "Cutter tidak intersect body atau boolean gagal (face " ~ suffix
            ~ "). Cek radius dan axial offset.");
    }
}

// ─── Crown Helpers ────────────────────────────────────────────────────────────

// Circular-pattern body `seed` sebanyak n-1 salinan sekitar axisLine.
// Return query gabungan (original + copies). n <= 1 -> seed apa adanya.
function patternAroundAxis(context is Context, patId is Id, seed is Query, axisLine is Line, n is number) returns Query
{
    if (n <= 1)
        return seed;
    var xf = [];
    var nm = [];
    for (var i = 1; i < n; i += 1)
    {
        xf = append(xf, rotationAround(axisLine, (360.0 / n * i) * degree));
        nm = append(nm, "i" ~ toString(i));
    }
    opPattern(context, patId, {
                "entities"         : seed,
                "transforms"       : xf,
                "instanceFunction" : opPattern,
                "instanceNames"    : nm
            });
    return qUnion([seed, qCreatedBy(patId, EntityType.BODY)]);
}

// ─── Crown Builder ────────────────────────────────────────────────────────────
// Crown cage satu sisi: port geometri model FreeCAD crown_v2
// (freecad-bearing-python/gatau apa (1).py + cage-crown.py). Strategi CUT:
// ring annulus penuh, lalu notch prism per pocket + sphere pocket dipotong.
//
// Level aksial (c = axialCenter = pusat sphere pocket; flip = true me-mirror
// seluruh crown terhadap bidang c sehingga prong menghadap arah sebaliknya):
//   c + halfWidth  ujung bebas prong (runcing)
//   c              pusat sphere pocket = muka band solid
//   c - halfWidth  dasar ring solid
//
// Layout tangensial per sisi pocket (x = jarak arc dari pusat pocket, diukur
// di permukaan LUAR ring, konvensi FreeCAD CrownSurfaceLength):
//   0 .. pocketR              pocket (sphere carve, pocketR = ballR + margin)
//   .. pocketR + slotOffset   bibir flank (dibatasi diagonal)
//   .. + slotW                FLEX SLOT vertikal, turun sampai level c
//   .. wHalf                  flank diagonal lanjut ke ujung prong runcing
//
// Diagonal: bibir pocket sekaligus flank prong. Slope-nya dihitung dari
// kebutuhan SNAP (theta = acos((ballR - grip)/pocketR)), BUKAN dari lebar
// sel, supaya jepitan bola konsisten berapa pun ball count: bukaan antar
// bibir = ballDia - 2*grip < ballDia -> bola nge-klik masuk dan terkunci
// (flex slot melenturkan bibir). Di config referensi FreeCAD (ballDia 3.5,
// margin 0.25, n=16) grip 0.1 menghasilkan slope 0.69 = persis diagonal
// manual ke titik tengah antar-pocket, jadi bentuk referensi tetap match.
// Diagonal berhenti di band top: sel lebar -> prong flat-top; sel sempit ->
// dua diagonal tetangga ketemu -> prong runcing.
function buildCrown(context is Context, id is Id,
                     axisLine is Line,
                     pitchR is ValueWithUnits,
                     crownWall is ValueWithUnits,
                     crownCl is ValueWithUnits,
                     lip is ValueWithUnits,
                     halfWidth is ValueWithUnits,
                     axialCenter is ValueWithUnits,
                     ballR is ValueWithUnits,
                     margin is ValueWithUnits,
                     grip is ValueWithUnits,
                     slotOffset is ValueWithUnits,
                     slotW is ValueWithUnits,
                     flip is boolean,
                     nBalls is number)
{
    var mm = millimeter;

    // Crown ring inner/outer radius: centered on pitch circle
    var crInnerR = pitchR - crownWall;
    var crOuterR = pitchR + crownWall;

    // Clamp to fit within groove lip walls + clearance
    var maxCrInner = pitchR - lip + crownCl;
    var minCrOuter = pitchR + lip - crownCl;
    if (crInnerR < maxCrInner) { crInnerR = maxCrInner; }
    if (crOuterR > minCrOuter) { crOuterR = minCrOuter; }

    if (crOuterR - crInnerR < 0.3 * mm)
    {
        reportFeatureWarning(context, id,
            "Crown wall terlalu tipis setelah clamp ke lip gap. "
            ~ "Perbesar lip width atau kurangi clearance.");
    }
    if (crOuterR <= crInnerR + 0.2 * mm)
    {
        reportFeatureWarning(context, id,
            "Crown tidak bisa dibangun: ketebalan radial tidak cukup.");
        return;
    }

    // ── Level aksial ──────────────────────────────────────────────────────
    var pocketR = ballR + margin;        // FreeCAD: Sphere.Radius = ballDia/2 + 0.25
    var c      = axialCenter;            // pusat sphere = muka band solid
    var dir    = flip ? -1 : 1;          // arah prong relatif +axis
    var top    = c + dir * halfWidth;    // ujung bebas prong
    var bottom = c - dir * halfWidth;    // dasar ring solid

    if (halfWidth < pocketR + 0.5 * mm)
    {
        reportFeatureWarning(context, id,
            "Band solid tipis: half width < pocketR + 0.5mm. "
            ~ "Sphere pocket nyaris/akan tembus dasar cage.");
    }

    // ── Layout tangensial ─────────────────────────────────────────────────
    // Setengah sel diukur di keliling permukaan LUAR ring (konvensi FreeCAD:
    // CrownSurfaceLength = 2*PI*outerR).
    var wHalf   = PI * crOuterR / nBalls;
    var slotIn  = pocketR + slotOffset;  // tepi dalam flex slot (manual: 3.5)
    var slotOut = slotIn + slotW;        // tepi luar flex slot (manual: 4.5)
    if (slotOut > 0.9 * wHalf)
    {
        reportFeatureWarning(context, id,
            "Flex slot keluar dari sela antar-bola - slot offset dikecilkan otomatis. "
            ~ "Kurangi slot offset / slot width atau ball count.");
        slotOffset = 0.9 * wHalf - slotW - pocketR;
        if (slotOffset < 0.1 * mm) { slotOffset = 0.1 * mm; }
        slotIn  = pocketR + slotOffset;
        slotOut = slotIn + slotW;
    }
    if (slotOut > wHalf)
    {
        reportFeatureWarning(context, id,
            "Sela antar-bola terlalu sempit untuk pocket + flex slot. Crown dilewati. "
            ~ "Kurangi ball count, slot width, atau pocket margin.");
        return;
    }

    // ── Coordinate frame (axis arbitrer, bukan asumsi Z) ──────────────────
    var axisDir   = normalize(axisLine.direction);
    var radialDir = pickPerpVector(axisDir);
    var tangDir   = normalize(cross(radialDir, axisDir));

    // Radial profile plane: local X = jarak radial dari axis, local Y = posisi
    // axial absolut (konsisten dengan axialCenter).
    var skPlane = plane(axisLine.origin, tangDir, radialDir);

    // Tangent plane di pocket pertama: normal = radialDir (keluar), local X =
    // tangensial, local Y = axial absolut. Prisma diextrude ke -radialDir.
    var planeOff  = crOuterR + 2 * mm;
    var tangX     = normalize(cross(axisDir, radialDir));
    var tangPlane = plane(axisLine.origin + planeOff * radialDir, radialDir, tangX);

    // Kedalaman extrude prisma: backface di 0.7*crInnerR supaya rentang radial
    // [crIn..crOut] ter-cover walau prisma datar (chord vs arc), tanpa
    // menyentuh sumbu.
    var prismDepth = planeOff - 0.7 * crInnerR;

    // ── 1. RING annulus (solid penuh, bottom..top) ────────────────────────
    var skRing = newSketchOnPlane(context, id + "skRing", { "sketchPlane" : skPlane });
    skRectangle(skRing, "ringRect", {
        "firstCorner"  : vector(crInnerR, bottom),
        "secondCorner" : vector(crOuterR, top)
    });
    skSolve(skRing);
    opRevolve(context, id + "revRing", {
        "entities"     : qSketchRegion(id + "skRing"),
        "axis"         : axisLine,
        "angleForward" : 360 * degree
    });

    // ── 2. NOTCH cutter per pocket (V diagonal + flex slot) ───────────────
    // Slope diagonal dari kebutuhan snap: bibir membungkus bola sampai theta
    // di atas ekuator -> bukaan antar bibir = 2*pocketR*cos(theta) =
    // ballDia - 2*grip. xE = titik diagonal keluar dari band (atau 1.1*wHalf
    // kalau diagonal terlalu landai buat sampai top di dalam sel); cutter
    // tetangga saling overlap sehingga sisa material selalu di bawah envelope
    // diagonal terdekat. Fillet r=0.1 ujung prong (model FreeCAD) dilewati.
    var theta    = acos((ballR - grip) / pocketR);
    var slopeMag = tan(theta);
    var ovN      = 0.5 * mm;
    var xE       = min(1.1 * wHalf, (halfWidth + 0.25 * mm) / slopeMag);
    var yDiag    = c + dir * slopeMag * xE;      // ketinggian diagonal di x = xE
    var yTop     = c + dir * (halfWidth + ovN);  // tembus melewati ujung bebas

    // V cutter: trapesium apex di pusat pocket, diagonal ke +-xE, tutup di
    // atas band. Segmen vertikal v2/v4 minimal 0.25mm (tidak degenerate).
    var skV = newSketchOnPlane(context, id + "skNotchV", { "sketchPlane" : tangPlane });
    skLineSegment(skV, "v1", { "start" : vector(0 * mm, c),     "end" : vector( xE,     yDiag) });
    skLineSegment(skV, "v2", { "start" : vector( xE,    yDiag), "end" : vector( xE,     yTop)  });
    skLineSegment(skV, "v3", { "start" : vector( xE,    yTop),  "end" : vector(-xE,     yTop)  });
    skLineSegment(skV, "v4", { "start" : vector(-xE,    yTop),  "end" : vector(-xE,     yDiag) });
    skLineSegment(skV, "v5", { "start" : vector(-xE,    yDiag), "end" : vector(0 * mm,  c)     });
    skSolve(skV);
    opExtrude(context, id + "extNotchV", {
        "entities"  : qSketchRegion(id + "skNotchV"),
        "direction" : -radialDir,
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : prismDepth
    });

    // Flex slot: dua rect tembus band penuh (level c .. lewat ujung bebas).
    var skSlot = newSketchOnPlane(context, id + "skNotchSlot", { "sketchPlane" : tangPlane });
    skRectangle(skSlot, "slotR", {
        "firstCorner"  : vector( slotIn,  c),
        "secondCorner" : vector( slotOut, yTop)
    });
    skRectangle(skSlot, "slotL", {
        "firstCorner"  : vector(-slotOut, c),
        "secondCorner" : vector(-slotIn,  yTop)
    });
    skSolve(skSlot);
    opExtrude(context, id + "extNotchSlot", {
        "entities"  : qCreatedBy(id + "skNotchSlot", EntityType.FACE),
        "direction" : -radialDir,
        "endBound"  : BoundingType.BLIND,
        "endDepth"  : prismDepth
    });

    var notchQ = patternAroundAxis(context, id + "notchPat",
        qUnion([
            qCreatedBy(id + "extNotchV",    EntityType.BODY),
            qCreatedBy(id + "extNotchSlot", EntityType.BODY)
        ]), axisLine, nBalls);
    opBoolean(context, id + "notchCut", {
        "targets"       : qCreatedBy(id + "revRing", EntityType.BODY),
        "tools"         : notchQ,
        "operationType" : BooleanOperationType.SUBTRACTION
    });

    // ── 3. POCKET sphere cuts ─────────────────────────────────────────────
    // Semicircle + diameter di skPlane, revolve sekitar diameternya sendiri
    // (radialDir lewat pusat sphere, terletak DI sketch plane) -> sphere penuh
    // di (pitchR, c). Valid untuk axis arbitrer.
    var sphereCenter3d = axisLine.origin + c * axisDir + pitchR * radialDir;

    var skPk = newSketchOnPlane(context, id + "skCrPk", { "sketchPlane" : skPlane });
    skArc(skPk, "pArc", {
        "start" : vector(pitchR - pocketR, c),
        "mid"   : vector(pitchR,           c + pocketR),
        "end"   : vector(pitchR + pocketR, c)
    });
    skLineSegment(skPk, "pDiam", {
        "start" : vector(pitchR + pocketR, c),
        "end"   : vector(pitchR - pocketR, c)
    });
    skSolve(skPk);
    opRevolve(context, id + "revCrPk", {
        "entities"     : qSketchRegion(id + "skCrPk"),
        "axis"         : line(sphereCenter3d, radialDir),
        "angleForward" : 360 * degree
    });

    var pkQ = patternAroundAxis(context, id + "pkPat",
        qCreatedBy(id + "revCrPk", EntityType.BODY), axisLine, nBalls);

    opBoolean(context, id + "crPkCut", {
        "targets"       : qCreatedBy(id + "revRing", EntityType.BODY),
        "tools"         : pkQ,
        "operationType" : BooleanOperationType.SUBTRACTION
    });
}

// ─── Feature Definition ───────────────────────────────────────────────────────
annotation { "Feature Type Name" : "Ball Groove Generator" }
export const ballGrooveGenerator = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Mode", "UIHint" : "HORIZONTAL_ENUM" }
        definition.mode is GrooveMode;

        annotation { "Name" : "Cylindrical face",
                     "Filter" : EntityType.FACE && GeometryType.CYLINDER && BodyType.SOLID,
                     "MaxNumberOfPicks" : 1 }
        definition.face is Query;

        annotation { "Name" : "Ball diameter", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
        isLength(definition.ballDiameter, { (millimeter) : [1, 4, 50] } as LengthBoundSpec);

        annotation { "Name" : "Groove axial offset (0 = center)",
                     "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
        isLength(definition.axialOffset, { (millimeter) : [-50, 0, 50] } as LengthBoundSpec);

        annotation { "Name" : "Ball groove clearance (radial)",
                     "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
        isLength(definition.ballClearance, { (millimeter) : [0, 0.15, 0.5] } as LengthBoundSpec);

        // Crown width = jarak radial lip wall dari pitch (sama semantik bearing.fs).
        // Menentukan jepitan bola: lip lebih besar = mulut groove lebih sempit =
        // cengkeraman lebih kuat. Ditampilkan di SEMUA mode (termasuk AUTO) supaya
        // grip bisa dituning manual, tidak lagi ikut tebal dinding tube.
        annotation { "Name" : "Crown width (lip)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
        isLength(definition.lipWidth, { (millimeter) : [0.0, 1.0, 3.0] } as LengthBoundSpec);

        // ── Crown retainer (only in AUTO mode with tube) ──────────────────
        annotation { "Name" : "Add crown retainer", "Default" : false }
        definition.addCrown is boolean;

        if (definition.addCrown)
        {
            annotation { "Group Name" : "Crown Parameters", "Collapsed By Default" : false }
            {
                annotation { "Name" : "Ball count for crown" }
                isInteger(definition.crownBallCount, { (unitless) : [4, 6, 48] } as IntegerBoundSpec);

                // Balik arah prong (default: prong ke arah +axis face)
                annotation { "Name" : "Flip prong direction", "UIHint" : "OPPOSITE_DIRECTION" }
                definition.crownFlip is boolean;

                annotation { "Name" : "Crown wall thickness", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.crownWall, { (millimeter) : [0.5, 0.7, 3.0] } as LengthBoundSpec);

                // Jarak radial dinding crown ke lip wall race (anti-seret radial)
                annotation { "Name" : "Radial clearance (to lip)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.crownClearance, { (millimeter) : [0.05, 0.2, 0.5] } as LengthBoundSpec);

                // Crown dipendekkan dari kedua ujung (anti-seret aksial
                // kalau atas/bawah cage ketemu part lain)
                annotation { "Name" : "Axial clearance (top/bottom)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.crownAxialClearance, { (millimeter) : [0.0, 0.2, 2.0] } as LengthBoundSpec);

                // pocketR = ballR + margin (FreeCAD: Sphere.Radius = ballDia/2 + 0.25)
                annotation { "Name" : "Pocket margin (gap)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.crownMargin, { (millimeter) : [0.0, 0.25, 0.5] } as LengthBoundSpec);

                // Interferensi bibir pocket per sisi: bukaan pocket =
                // ballDia - 2*grip -> bola nge-klik masuk dan terkunci,
                // konsisten berapa pun ball count
                annotation { "Name" : "Snap grip (lip interference)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.crownSnapGrip, { (millimeter) : [0.02, 0.1, 0.4] } as LengthBoundSpec);

                // Jarak tepi dalam flex slot dari permukaan pocket
                annotation { "Name" : "Slot offset", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.crownSlotOffset, { (millimeter) : [0.5, 1.5, 6.0] } as LengthBoundSpec);

                annotation { "Name" : "Slot width", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.crownSlotWidth, { (millimeter) : [0.3, 1.0, 3.0] } as LengthBoundSpec);
            }
        }

        annotation { "Name" : "Debug info (print ke FS notices)", "Default" : false }
        definition.debugMode is boolean;
    }
    {
        // Guard: belum ada selection
        if (isQueryEmpty(context, definition.face))
            return;

        var faces = evaluateQuery(context, definition.face);
        if (size(faces) == 0)
            throw regenError("Pilih satu cylindrical face.");

        var primaryFace = faces[0];
        var primary = inspectCylFace(context, primaryFace);

        var dbg = definition.debugMode;
        var dbgLines = new box([]);
        if (dbg)
        {
            dbgOut(dbgLines, "primary: r=" ~ mmStr(primary.radius)
                ~ " isOuter=" ~ toString(primary.isOuter)
                ~ " ext=[" ~ mmStr(primary.axialMin) ~ ", " ~ mmStr(primary.axialMax) ~ "]"
                ~ " len=" ~ mmStr(primary.axialMax - primary.axialMin));
            dbgOut(dbgLines, "primary axis: origin(mm)=" ~ toString(primary.axis.origin / millimeter)
                ~ " dir=" ~ toString(normalize(primary.axis.direction)));
        }

        var ballR = definition.ballDiameter / 2;

        var targets = [];  // array of { face, info }

        if (definition.mode == GrooveMode.OUTER_FACE_ONLY)
        {
            if (!primary.isOuter)
                throw regenError("Mode 'Outer face only' tapi face yang dipilih adalah inner face (bore). "
                    ~ "Ganti mode atau pilih outer face.");
            targets = [{ "face" : primaryFace, "info" : primary }];
        }
        else if (definition.mode == GrooveMode.INNER_FACE_ONLY)
        {
            if (primary.isOuter)
                throw regenError("Mode 'Inner face only' tapi face yang dipilih adalah outer face. "
                    ~ "Ganti mode atau pilih inner face (bore).");
            targets = [{ "face" : primaryFace, "info" : primary }];
        }
        else // AUTO
        {
            var pair = findCoaxialPartner(context, qAllSolidBodies(), primaryFace, primary);
            if (pair == undefined)
            {
                reportFeatureWarning(context, id,
                    "Auto mode: tidak ada cyl face pasangan (coaxial + orientasi berlawanan). Groove hanya dibuat di face yang dipilih.");
                targets = [{ "face" : primaryFace, "info" : primary }];
            }
            else
            {
                var isBearingMode = (primary.isOuter && primary.radius < pair.info.radius) ||
                                    (!primary.isOuter && primary.radius > pair.info.radius);

                if (!isBearingMode)
                {
                    var wall = abs(primary.radius - pair.info.radius);
                    var grooveDepth = ballR + definition.ballClearance;
                    var minWall = 2 * grooveDepth + 0.5 * millimeter;
                    if (wall < minWall)
                    {
                        throw regenError("Wall tube terlalu tipis untuk dua groove. "
                            ~ "Wall = " ~ toString(wall)
                            ~ ", minimum dibutuhkan = " ~ toString(minWall) ~ ".");
                    }
                    if (wall > minWall + 3 * millimeter)
                    {
                        reportFeatureInfo(context, id,
                            "Wall jauh lebih tebal dari minimum - groove dibuat di kedua face, "
                            ~ "tapi banyak material sisa di tengah wall.");
                    }
                }
                // Face partner bisa sudah terbelah jadi beberapa segmen oleh
                // groove dari feature sebelumnya (mis. satu inner ring dipakai
                // dua outer ring). Pakai extent gabungan segmen supaya validasi
                // batas aman & tinggi crown tidak false-positive.
                var mergedPartner = mergeCoaxialSegments(context, pair.face, pair.info);
                if (dbg)
                {
                    dbgOut(dbgLines, "partner RAW: r=" ~ mmStr(pair.info.radius)
                        ~ " isOuter=" ~ toString(pair.info.isOuter)
                        ~ " ext=[" ~ mmStr(pair.info.axialMin) ~ ", " ~ mmStr(pair.info.axialMax) ~ "]");
                    dbgOut(dbgLines, "partner axis: origin(mm)=" ~ toString(pair.info.axis.origin / millimeter)
                        ~ " dir=" ~ toString(normalize(pair.info.axis.direction)));
                    dbgOut(dbgLines, "partner MERGED ext=[" ~ mmStr(mergedPartner.axialMin)
                        ~ ", " ~ mmStr(mergedPartner.axialMax) ~ "]");
                    var pfr = extentInFrame(mergedPartner,
                        primary.axis.origin, normalize(primary.axis.direction));
                    dbgOut(dbgLines, "partner MERGED di frame primary=[" ~ mmStr(pfr.lo) ~ ", " ~ mmStr(pfr.hi) ~ "]"
                        ~ " isBearingMode=" ~ toString(isBearingMode));
                }
                targets = [
                    { "face" : primaryFace, "info" : primary },
                    { "face" : pair.face,   "info" : mergedPartner }
                ];
            }
        }

        // Lip dipakai langsung dari input di semua mode. Sebelumnya AUTO memaksa
        // lip = gap/2 (setengah tebal dinding) sehingga grip bergantung ke tebal
        // tube, bukan ke bola -> sering longgar. Sekarang manual seperti mode lain.
        var lip = definition.lipWidth;

        var primaryCenter = (primary.axialMin + primary.axialMax) / 2 + definition.axialOffset;
        
        // Clamp primary center
        var primaryHalfExtent = (ballR + definition.ballClearance) * sqrt(2.0) - lip;
        var primaryMin = primary.axialMin + primaryHalfExtent;
        var primaryMax = primary.axialMax - primaryHalfExtent;
        if (primaryCenter < primaryMin)
        {
            reportFeatureWarning(context, id, "Axial offset bikin groove keluar dari face. Auto-clamp ke batas bawah.");
            primaryCenter = primaryMin;
        }
        else if (primaryCenter > primaryMax)
        {
            reportFeatureWarning(context, id, "Axial offset bikin groove keluar dari face. Auto-clamp ke batas atas.");
            primaryCenter = primaryMax;
        }
        if (dbg)
        {
            dbgOut(dbgLines, "primaryCenter=" ~ mmStr(primaryCenter)
                ~ " (clamp range [" ~ mmStr(primaryMin) ~ ", " ~ mmStr(primaryMax) ~ "])");
        }

        var centers = [primaryCenter];
        if (size(targets) == 2)
        {
            var primaryDir = normalize(primary.axis.direction);
            var centerPt = primary.axis.origin + primaryCenter * primaryDir;

            var partnerDir = normalize(targets[1].info.axis.direction);
            var partnerCenter = dot(centerPt - targets[1].info.axis.origin, partnerDir);
            centers = append(centers, partnerCenter);
            if (dbg) dbgOut(dbgLines, "partnerCenter (frame partner)=" ~ mmStr(partnerCenter));
        }

        for (var i = 0; i < size(targets); i += 1)
        {
            applyGroove(context, id, toString(i),
                        targets[i].info, ballR, definition.ballClearance,
                        lip, centers[i],
                        qOwnerBody(targets[i].face));
        }

        // ── CROWN RETAINER ────────────────────────────────────────────────
        if (definition.addCrown)
        {
            // Determine pitch radius and half-width for crown
            var crownPitchR = 0 * millimeter;
            var crownHalfW  = 0 * millimeter;
            var crownAxisLine = primary.axis;

            if (size(targets) == 2)
            {
                // Two faces (tube): pitch = midpoint between inner & outer radius
                var r1 = targets[0].info.radius;
                var r2 = targets[1].info.radius;
                var outerFaceR = r1 > r2 ? r1 : r2;
                var innerFaceR = r1 < r2 ? r1 : r2;

                // Pitch radius: halfway between the groove centers
                // Outer face groove cuts inward: ball center at outerFaceR + lip
                // Inner face groove cuts outward: ball center at innerFaceR - lip
                // But simpler: midpoint of the radial gap
                crownPitchR = (innerFaceR + outerFaceR) / 2;

                // Crown axial half-width: ikuti tinggi face BORE (outer race
                // yang membungkus crown) di sekitar pusat groove, bukan
                // overlap kedua face. Kalau face shaft lebih pendek dari ring
                // (ujung shaft chamfer / ring overhang), overlap menyusut dan
                // crown ikut memendek padahal ruangnya masih ada -> axial
                // clearance membengkak simetris. Crown tetap harus muat di
                // dalam ring: pakai jarak terpendek dari pusat groove ke
                // kedua ujung face bore.
                var primaryDirN = normalize(primary.axis.direction);
                var boreIdx = targets[0].info.isOuter ? 1 : 0;
                var boreExt = extentInFrame(targets[boreIdx].info,
                    primary.axis.origin, primaryDirN);
                crownHalfW = min(primaryCenter - boreExt.lo, boreExt.hi - primaryCenter);

                // Info kalau crown melewati ujung face race pasangan (mis.
                // shaft berhenti/berbahu di dalam ring) - aman selama tidak
                // ada shoulder/step yang naik ke jalur crown di situ.
                var otherExt = extentInFrame(targets[1 - boreIdx].info,
                    primary.axis.origin, primaryDirN);
                if (primaryCenter - crownHalfW < otherExt.lo - 1e-3 * millimeter
                    || primaryCenter + crownHalfW > otherExt.hi + 1e-3 * millimeter)
                {
                    reportFeatureInfo(context, id,
                        "Crown melewati ujung face race pasangan (face lawan lebih pendek "
                        ~ "dari ring). Aman selama tidak ada shoulder/step di area itu.");
                }

                if (dbg)
                {
                    dbgOut(dbgLines, "crown: boreIdx=" ~ toString(boreIdx)
                        ~ " (bore r=" ~ mmStr(targets[boreIdx].info.radius) ~ ")");
                    dbgOut(dbgLines, "crown: boreExt=[" ~ mmStr(boreExt.lo) ~ ", " ~ mmStr(boreExt.hi) ~ "]"
                        ~ " otherExt=[" ~ mmStr(otherExt.lo) ~ ", " ~ mmStr(otherExt.hi) ~ "]");
                    dbgOut(dbgLines, "crown: pitchR=" ~ mmStr(crownPitchR)
                        ~ " halfW(sebelum axial clearance)=" ~ mmStr(crownHalfW));
                }
            }
            else
            {
                // Single face: place crown at the groove pitch
                var faceR = targets[0].info.radius;
                if (targets[0].info.isOuter)
                {
                    // Outer face: groove cuts inward, ball center at faceR + lip
                    crownPitchR = faceR + lip;
                }
                else
                {
                    // Inner face: groove cuts outward, ball center at faceR - lip
                    crownPitchR = faceR - lip;
                }
                var faceLen = targets[0].info.axialMax - targets[0].info.axialMin;
                crownHalfW = faceLen / 2;
            }

            // Axial clearance: crown dipendekkan dari KEDUA ujung supaya
            // tidak seret kalau atas/bawah cage ketemu part lain.
            crownHalfW = crownHalfW - definition.crownAxialClearance;
            if (dbg)
            {
                dbgOut(dbgLines, "crown: halfW(final)=" ~ mmStr(crownHalfW)
                    ~ " span=[" ~ mmStr(primaryCenter - crownHalfW)
                    ~ ", " ~ mmStr(primaryCenter + crownHalfW) ~ "] (frame primary)");
            }

            // Validasi pitch radius > 0
            if (crownPitchR < 1 * millimeter)
            {
                reportFeatureWarning(context, id,
                    "Crown pitch radius terlalu kecil. Cek dimensi tube/face.");
            }
            else if (crownHalfW < 0.5 * millimeter)
            {
                reportFeatureWarning(context, id,
                    "Axial clearance terlalu besar: crown jadi terlalu pendek. Crown dilewati.");
            }
            else
            {
                buildCrown(context, id + "crown",
                    crownAxisLine,
                    crownPitchR,
                    definition.crownWall,
                    definition.crownClearance,
                    lip,
                    crownHalfW,
                    primaryCenter,
                    ballR,
                    definition.crownMargin,
                    definition.crownSnapGrip,
                    definition.crownSlotOffset,
                    definition.crownSlotWidth,
                    definition.crownFlip,
                    definition.crownBallCount);
            }
        }

        // Dump debug sebagai feature status (warning icon oranye) supaya pasti
        // tampil - println tidak selalu muncul di notices Part Studio.
        if (dbg)
        {
            var msg = "=== BallGroove DEBUG ===";
            for (var l in dbgLines[])
                msg = msg ~ "\n" ~ l;
            reportFeatureWarning(context, id, msg);
        }
    });
