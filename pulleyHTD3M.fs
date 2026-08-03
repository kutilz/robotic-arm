/**
 * Pulley HTD3M: Adjustable Timing Pulley Generator
 * ===================================================
 * Onshape EDU, FeatureScript 2945
 *
 * Tooth profile: geometri HTD3M ASLI, bukan approximasi. Konstanta
 * (pitch, u, h, r0, rs) dan algoritma arc construction diambil dari
 * `freecad.gears` (FreeCAD Gears workbench open-source, file
 * timinggear.py, class TimingGear, data["htd3"]) -- proyek yang dipakai
 * luas dan sudah divalidasi komunitas buat generate pulley HTD/GT nyata.
 * Matematikanya sudah diverifikasi ulang manual (Python/numpy) sebelum
 * dipakai di sini: satu "tooth-cell" = 4 arc (root fillet - root valley -
 * root fillet - tip land), titik-titiknya dihitung persis sesuai algoritma
 * asli (branch offset=0, yang berlaku utk semua profil HTD karena offset
 * HTD selalu 0 di data source -- beda dgn GT2/GT3/GT5 yang punya offset).
 * N tooth-cell (masing2 di-rotate i*360/N derajat, sudah dicek numerik
 * bahwa titik akhir tooth ke-i persis nyambung ke titik awal tooth ke-i+1)
 * dirangkai jadi SATU closed wire lalu di-extrude SEKALI jadi solid --
 * gak ada operasi boolean cut/union sama sekali buat bentuk gigi.
 *
 * Pitch diameter (Pd = N * 3mm / pi) EXACT.
 */

FeatureScript 2945;
import(path : "onshape/std/geometry.fs", version : "2945.0");

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Plane sejajar `base`, digeser sejauh `z` di sepanjang normal `base`.
// Dipakai supaya seluruh model bisa ditempel ke face mana pun (lihat
// definition.attachToFace) -- bukan cuma terpaku di XY plane global.
function offsetPlane(base is Plane, z is ValueWithUnits) returns Plane
{
    return plane(base.origin + base.normal * z, base.normal, base.x);
}

// Rotasi titik 2D (di XY plane) sejauh `ang` di sekitar origin.
function rot2d(p is Vector, ang is ValueWithUnits) returns Vector
{
    return vector(p[0] * cos(ang) - p[1] * sin(ang), p[0] * sin(ang) + p[1] * cos(ang));
}

// ─── Feature Definition ───────────────────────────────────────────────────────
annotation { "Feature Type Name" : "Pulley HTD3M (adjustable)" }
export const pulleyHTD3M = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Group Name" : "Belt & Teeth", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Jumlah gigi (N)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isInteger(definition.numTeeth, { (unitless) : [10, 20, 200] } as IntegerBoundSpec);

            annotation { "Name" : "Lebar belt (belt width)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.beltWidth, { (millimeter) : [3, 9, 50] } as LengthBoundSpec);
        }

        annotation { "Group Name" : "Placement", "Collapsed By Default" : true }
        {
            annotation { "Name" : "Tempel ke face tertentu", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            definition.attachToFace is boolean;

            if (definition.attachToFace)
            {
                annotation { "Name" : "Face / plane tujuan", "Filter" : EntityType.FACE && GeometryType.PLANE, "MaxNumberOfPicks" : 1 }
                definition.attachFace is Query;

                annotation { "Name" : "Balik arah", "UIHint" : ["OPPOSITE_DIRECTION", "REMEMBER_PREVIOUS_VALUE"] }
                definition.flipDirection is boolean;
            }
        }

        annotation { "Group Name" : "Bore & Shaft", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Diameter bore", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.boreDiameter, { (millimeter) : [1, 5, 60] } as LengthBoundSpec);

            annotation { "Name" : "Tambah keyway", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            definition.hasKeyway is boolean;

            if (definition.hasKeyway)
            {
                annotation { "Name" : "Lebar keyway", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.keywayWidth, { (millimeter) : [0.5, 3, 12] } as LengthBoundSpec);

                annotation { "Name" : "Kedalaman keyway (dari dinding bore)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.keywayDepth, { (millimeter) : [0.3, 1.5, 8] } as LengthBoundSpec);
            }
        }

        annotation { "Group Name" : "Flange", "Collapsed By Default" : true }
        {
            annotation { "Name" : "Tambah flange (bibir penahan belt)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            definition.hasFlange is boolean;

            if (definition.hasFlange)
            {
                annotation { "Name" : "Diameter flange", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.flangeDiameter, { (millimeter) : [5, 30, 400] } as LengthBoundSpec);

                annotation { "Name" : "Tebal flange", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.flangeThickness, { (millimeter) : [0.5, 1.5, 15] } as LengthBoundSpec);

                annotation { "Name" : "Flange di kedua sisi", "Default" : true, "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                definition.flangeBothSides is boolean;
            }
        }

        annotation { "Group Name" : "Hub & Set Screw", "Collapsed By Default" : true }
        {
            annotation { "Name" : "Tambah hub (boss mounting)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            definition.hasHub is boolean;

            if (definition.hasHub)
            {
                annotation { "Name" : "Diameter hub", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.hubDiameter, { (millimeter) : [5, 15, 150] } as LengthBoundSpec);

                annotation { "Name" : "Panjang hub", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.hubLength, { (millimeter) : [1, 10, 150] } as LengthBoundSpec);
            }

            // Set screw TIDAK butuh hub -- belt width 10-15mm HTD3M biasa sudah
            // cukup tebal buat grub screw langsung ke body (dipakai buat pulley
            // print yang di-grub ke shaft, sesuai catatan komponen robotic arm).
            annotation { "Name" : "Tambah lubang set screw (radial, tembus)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            definition.hasSetScrew is boolean;

            if (definition.hasSetScrew)
            {
                annotation { "Name" : "Diameter lubang set screw", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.setScrewDiameter, { (millimeter) : [1.5, 3.3, 10] } as LengthBoundSpec);
            }
        }
    }
    {
        // Konstanta HTD3M asli dari freecad.gears timinggear.py data["htd3"].
        const htdPitch  = 3 * millimeter;
        const htdU      = 0.381 * millimeter;   // pitch radius -> tip radius offset
        const htdH      = 1.21  * millimeter;   // radial height gigi (tip -> root)
        const htdR0     = 0.89  * millimeter;   // radius arc root (r_12 di source)
        const htdRs     = 0.26  * millimeter;   // radius arc fillet (r_34 di source)
        const overshoot = 1 * millimeter;

        // Base plane tempat pulley dibangun: kalau "Tempel ke face" aktif,
        // pakai plane dari face yang dipilih user; kalau nggak, default ke
        // XY plane global (sama seperti sebelumnya).
        var basePlane is Plane = definition.attachToFace
            ? evPlane(context, { "face" : definition.attachFace })
            : plane(vector(0, 0, 0) * millimeter, vector(0, 0, 1));

        if (definition.attachToFace && definition.flipDirection)
            basePlane = plane(basePlane.origin, -basePlane.normal, basePlane.x);

        var N = definition.numTeeth;
        var beltWidth = definition.beltWidth;
        var boreR = definition.boreDiameter / 2;

        var theta = 360 * degree / N;   // sudut satu tooth-pitch penuh

        // rp = pitch radius standar (N*pitch/2pi) dikurangi u -- lihat source.
        var rp = (N * htdPitch / PI) / 2 - htdU;

        // Titik-titik profil "tooth-cell" acuan (tooth ke-0), persis formula asli.
        var m34    = vector(-(htdR0 + htdRs), rp - htdH + htdR0);
        var x2     = vector(-htdR0,           rp - htdH + htdR0);
        var x4     = vector(-(htdR0 + htdRs), rp - htdH + htdR0 + htdRs);
        var xn2    = vector( htdR0,           rp - htdH + htdR0);
        var xn4    = vector( htdR0 + htdRs,   rp - htdH + htdR0 + htdRs);
        var mn34   = vector( htdR0 + htdRs,   rp - htdH + htdR0);
        var rootPt = vector(0 * millimeter,   rp - htdH);

        // x6 = titik akhir tooth-cell = xn4 di-rotate satu theta penuh (sudah
        // diverifikasi numerik: rotate(xn4, theta) == x6 asli, jadi N tooth-cell
        // yang di-rotate berurutan otomatis nyambung jadi satu closed loop).
        var x6 = rot2d(xn4, theta);

        // Mid-point tiap arc (buat skArc 3-titik), pakai rumus yang sama dgn
        // source (arc_from_points_and_center): mid = center + r*normalize(...).
        var arc1Mid = mn34 + htdRs * normalize((xn4 + xn2) / 2 - mn34);
        var arc3Mid = m34  + htdRs * normalize((x2 + x4) / 2 - m34);
        var Rtip    = norm(x4);   // tip land = arc konsentris radius ini
        var arc4Mid = Rtip * normalize((x4 + x6) / 2);

        var Rroot = rp - htdH;

        if (Rroot <= boreR + 0.5 * millimeter)
            throw regenError("Bore terlalu besar untuk jumlah gigi ini -- root circle HTD3M kegencet bore. Kecilkan diameter bore atau tambah jumlah gigi.");

        // ── 1. BLANK BERGIGI -- profil HTD3M asli, satu sketch + satu extrude ──
        // N tooth-cell (masing2 4 arc) dirangkai jadi SATU closed wire di satu
        // sketch (bukan cut/union) -- gak ada resiko boolean gagal dari step ini.
        var skTooth = newSketchOnPlane(context, id + "skTooth", {
            "sketchPlane" : offsetPlane(basePlane, 0 * millimeter)
        });
        for (var i = 0; i < N; i += 1)
        {
            var rot = i * theta;
            var pXn4 = rot2d(xn4, rot);
            var pXn2 = rot2d(xn2, rot);
            var pRoot = rot2d(rootPt, rot);
            var pX2  = rot2d(x2, rot);
            var pX4  = rot2d(x4, rot);
            var pX6  = rot2d(x6, rot);
            var pArc1Mid = rot2d(arc1Mid, rot);
            var pArc3Mid = rot2d(arc3Mid, rot);
            var pArc4Mid = rot2d(arc4Mid, rot);

            var tId = "tooth" ~ toString(i);
            skArc(skTooth, tId ~ "a1", { "start" : pXn4, "mid" : pArc1Mid, "end" : pXn2 });
            skArc(skTooth, tId ~ "a2", { "start" : pXn2, "mid" : pRoot,    "end" : pX2  });
            skArc(skTooth, tId ~ "a3", { "start" : pX2,  "mid" : pArc3Mid, "end" : pX4  });
            skArc(skTooth, tId ~ "a4", { "start" : pX4,  "mid" : pArc4Mid, "end" : pX6  });
        }
        skSolve(skTooth);
        opExtrude(context, id + "extTooth", {
            "entities"  : qSketchRegion(id + "skTooth"),
            "direction" : basePlane.normal,
            "endBound"  : BoundingType.BLIND,
            "endDepth"  : beltWidth
        });
        var body = qCreatedBy(id + "extTooth", EntityType.BODY);

        // ── 2. FLANGE (opsional) ────────────────────────────────────────────────
        var zFront = 0 * millimeter;
        var zBackFace = beltWidth;

        if (definition.hasFlange)
        {
            var flangeR = definition.flangeDiameter / 2;
            var flangeT = definition.flangeThickness;

            if (flangeR <= Rtip)
                throw regenError("Diameter flange harus lebih besar dari diameter luar gigi (OD).");

            // Sketch mundur "overshoot" ke dalam body utama supaya UNION punya
            // volume overlap genuine (bukan cuma nempel di satu bidang -- lihat
            // FeatureScript gotcha D4, touch-only T-junction bikin BOOLEAN_BAD_INPUT).
            var skFlBack = newSketchOnPlane(context, id + "skFlBack", {
                "sketchPlane" : offsetPlane(basePlane, zBackFace - overshoot)
            });
            skCircle(skFlBack, "f", {
                "center" : vector(0, 0) * millimeter,
                "radius" : flangeR
            });
            skSolve(skFlBack);
            opExtrude(context, id + "extFlBack", {
                "entities"  : qCreatedBy(id + "skFlBack", EntityType.FACE),
                "direction" : basePlane.normal,
                "endBound"  : BoundingType.BLIND,
                "endDepth"  : flangeT + overshoot
            });
            opBoolean(context, id + "boolFlBack", {
                "tools"         : qUnion([ body, qCreatedBy(id + "extFlBack", EntityType.BODY) ]),
                "operationType" : BooleanOperationType.UNION
            });
            zBackFace += flangeT;

            if (definition.flangeBothSides)
            {
                var skFlFront = newSketchOnPlane(context, id + "skFlFront", {
                    "sketchPlane" : offsetPlane(basePlane, -flangeT)
                });
                skCircle(skFlFront, "f", {
                    "center" : vector(0, 0) * millimeter,
                    "radius" : flangeR
                });
                skSolve(skFlFront);
                opExtrude(context, id + "extFlFront", {
                    "entities"  : qCreatedBy(id + "skFlFront", EntityType.FACE),
                    "direction" : basePlane.normal,
                    "endBound"  : BoundingType.BLIND,
                    "endDepth"  : flangeT + overshoot   // overlap ke body utama (gotcha D4)
                });
                opBoolean(context, id + "boolFlFront", {
                    "tools"         : qUnion([ body, qCreatedBy(id + "extFlFront", EntityType.BODY) ]),
                    "operationType" : BooleanOperationType.UNION
                });
                zFront = -flangeT;
            }
        }

        // ── 3. HUB (opsional) ────────────────────────────────────────────────────
        var hubBackFace = zBackFace;   // z tempat hub mulai (kalau ada)

        if (definition.hasHub)
        {
            var hubR = definition.hubDiameter / 2;
            var hubLen = definition.hubLength;

            if (hubR <= boreR)
                throw regenError("Diameter hub harus lebih besar dari diameter bore.");

            // Sketch mundur "overshoot" ke dalam body utama -- overlap volume
            // genuine buat UNION (gotcha D4, sama seperti flange di atas).
            var skHub = newSketchOnPlane(context, id + "skHub", {
                "sketchPlane" : offsetPlane(basePlane, zBackFace - overshoot)
            });
            skCircle(skHub, "h", {
                "center" : vector(0, 0) * millimeter,
                "radius" : hubR
            });
            skSolve(skHub);
            opExtrude(context, id + "extHub", {
                "entities"  : qCreatedBy(id + "skHub", EntityType.FACE),
                "direction" : basePlane.normal,
                "endBound"  : BoundingType.BLIND,
                "endDepth"  : hubLen + overshoot
            });
            opBoolean(context, id + "boolHub", {
                "tools"         : qUnion([ body, qCreatedBy(id + "extHub", EntityType.BODY) ]),
                "operationType" : BooleanOperationType.UNION
            });

            zBackFace += hubLen;
        }

        var totalDepth = zBackFace - zFront;

        // ── 4. BORE (tembus semua -- flange & hub ikut kepotong) ────────────────
        var skBore = newSketchOnPlane(context, id + "skBore", {
            "sketchPlane" : offsetPlane(basePlane, zFront - overshoot)
        });
        skCircle(skBore, "b", {
            "center" : vector(0, 0) * millimeter,
            "radius" : boreR
        });
        skSolve(skBore);
        opExtrude(context, id + "extBore", {
            "entities"  : qCreatedBy(id + "skBore", EntityType.FACE),
            "direction" : basePlane.normal,
            "endBound"  : BoundingType.BLIND,
            "endDepth"  : totalDepth + 2 * overshoot
        });
        opBoolean(context, id + "boolBore", {
            "tools"         : qCreatedBy(id + "extBore", EntityType.BODY),
            "targets"       : body,
            "operationType" : BooleanOperationType.SUBTRACTION
        });

        // ── 5. KEYWAY (opsional) ────────────────────────────────────────────────
        if (definition.hasKeyway)
        {
            var kw = definition.keywayWidth;
            var kd = definition.keywayDepth;

            var skKey = newSketchOnPlane(context, id + "skKey", {
                "sketchPlane" : offsetPlane(basePlane, zFront - overshoot)
            });
            // firstCorner MULAI DARI SUMBU (bukan dari boreR) -- kalau mulai
            // persis di boreR, sisi kiri rectangle cuma NYENTUH lingkaran bore
            // di satu titik tangent (bukan overlap), bikin BOOLEAN_NON_MANIFOLD_
            // RESULT (analog gotcha D4 tapi utk SUBTRACTION). Region 0..boreR
            // sudah kosong (bekas bore) jadi aman ditumpuk.
            skRectangle(skKey, "slot", {
                "firstCorner"  : vector(0 * millimeter, -kw / 2),
                "secondCorner" : vector(boreR + kd,      kw / 2)
            });
            skSolve(skKey);
            opExtrude(context, id + "extKey", {
                "entities"  : qCreatedBy(id + "skKey", EntityType.FACE),
                "direction" : basePlane.normal,
                "endBound"  : BoundingType.BLIND,
                "endDepth"  : totalDepth + 2 * overshoot
            });
            opBoolean(context, id + "boolKey", {
                "tools"         : qCreatedBy(id + "extKey", EntityType.BODY),
                "targets"       : body,
                "operationType" : BooleanOperationType.SUBTRACTION
            });
        }

        // ── 6. SET SCREW HOLE (opsional, radial tembus) ─────────────────────────
        if (definition.hasSetScrew)
        {
            var ssR = definition.setScrewDiameter / 2;

            // Kalau ada hub, screw di tengah hub (radius = hub OD). Kalau nggak,
            // screw langsung di badan utama bergigi (radius = tip/OD, Rtip),
            // ditengahin di lebar belt -- cukup buat belt 10-15mm HTD3M.
            var screwOuterR = definition.hasHub ? definition.hubDiameter / 2 : Rtip;
            var zScrew = definition.hasHub
                ? hubBackFace + definition.hubLength / 2
                : beltWidth / 2;

            // Plane radial: normalnya basePlane.x (arah radial sembarang tapi
            // well-defined), "x" plane ini = basePlane.normal supaya origin-nya
            // (0,0) di local coords jatuh persis di sumbu putar pulley.
            var skScrew = newSketchOnPlane(context, id + "skScrew", {
                "sketchPlane" : plane(basePlane.origin + basePlane.normal * zScrew, basePlane.x, basePlane.normal)
            });
            skCircle(skScrew, "s", {
                "center" : vector(0, 0) * millimeter,
                "radius" : ssR
            });
            skSolve(skScrew);
            opExtrude(context, id + "extScrew", {
                "entities"   : qCreatedBy(id + "skScrew", EntityType.FACE),
                "direction"  : basePlane.x,
                "startBound" : BoundingType.BLIND,
                "startDepth" : screwOuterR + overshoot,
                "endBound"   : BoundingType.BLIND,
                "endDepth"   : screwOuterR + overshoot
            });
            opBoolean(context, id + "boolScrew", {
                "tools"         : qCreatedBy(id + "extScrew", EntityType.BODY),
                "targets"       : body,
                "operationType" : BooleanOperationType.SUBTRACTION
            });
        }
    });
