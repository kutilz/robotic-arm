FeatureScript 3008;
import(path : "onshape/std/geometry.fs", version : "3008.0");

export enum NutSize
{
    annotation { "Name" : "M2" }
    M2,
    annotation { "Name" : "M2.5" }
    M2_5,
    annotation { "Name" : "M3" }
    M3,
    annotation { "Name" : "M4" }
    M4,
    annotation { "Name" : "M5" }
    M5,
    annotation { "Name" : "M6" }
    M6,
    annotation { "Name" : "M8" }
    M8,
    annotation { "Name" : "Custom" }
    CUSTOM
}

export enum PocketStyle
{
    annotation { "Name" : "Hex nut" }
    HEX_NUT,
    annotation { "Name" : "Round (screw head)" }
    ROUND_HEAD
}

// DIN 934 nut: af = across flats, h = tebal nut. DIN 912 socket head: hd = dia kepala, hh = tinggi kepala. (mm)
function nutSpec(size is NutSize) returns map
{
    if (size == NutSize.M2)
        return { "d" : 2.0, "af" : 4.0, "h" : 1.6, "hd" : 3.8, "hh" : 2.0 };
    if (size == NutSize.M2_5)
        return { "d" : 2.5, "af" : 5.0, "h" : 2.0, "hd" : 4.5, "hh" : 2.5 };
    if (size == NutSize.M3)
        return { "d" : 3.0, "af" : 5.5, "h" : 2.4, "hd" : 5.5, "hh" : 3.0 };
    if (size == NutSize.M4)
        return { "d" : 4.0, "af" : 7.0, "h" : 3.2, "hd" : 7.0, "hh" : 4.0 };
    if (size == NutSize.M5)
        return { "d" : 5.0, "af" : 8.0, "h" : 4.0, "hd" : 8.5, "hh" : 5.0 };
    if (size == NutSize.M6)
        return { "d" : 6.0, "af" : 10.0, "h" : 5.0, "hd" : 10.0, "hh" : 6.0 };
    if (size == NutSize.M8)
        return { "d" : 8.0, "af" : 13.0, "h" : 6.5, "hd" : 13.0, "hh" : 8.0 };
    return {};
}

annotation { "Feature Type Name" : "Nut Hole (Support-Free)" }
export const nutHole = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Positions (mate connector or circular edge)",
                    "Filter" : (EntityType.EDGE && GeometryType.CIRCLE) || BodyType.MATE_CONNECTOR }
        definition.locations is Query;

        annotation { "Name" : "Slot parallel to (optional line edge)",
                    "Filter" : EntityType.EDGE && GeometryType.LINE, "MaxNumberOfPicks" : 1 }
        definition.orientationEdge is Query;

        annotation { "Name" : "Pocket style", "UIHint" : ["REMEMBER_PREVIOUS_VALUE", "SHOW_LABEL"] }
        definition.style is PocketStyle;

        annotation { "Name" : "Size", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
        definition.size is NutSize;

        if (definition.size == NutSize.CUSTOM)
        {
            annotation { "Name" : "Bolt hole diameter" }
            isLength(definition.customHoleDia, { (millimeter) : [0.5, 3.1, 30] } as LengthBoundSpec);

            if (definition.style == PocketStyle.HEX_NUT)
            {
                annotation { "Name" : "Nut width across flats" }
                isLength(definition.customAf, { (millimeter) : [1, 5.5, 50] } as LengthBoundSpec);
            }
            else
            {
                annotation { "Name" : "Head pocket diameter" }
                isLength(definition.customHeadDia, { (millimeter) : [1, 5.5, 50] } as LengthBoundSpec);
            }

            annotation { "Name" : "Nut pocket depth" }
            isLength(definition.customPocketDepth, { (millimeter) : [0.2, 2.5, 30] } as LengthBoundSpec);
        }
        else
        {
            annotation { "Group Name" : "Preset clearance", "Collapsed By Default" : true }
            {
                annotation { "Name" : "Hole dia. clearance", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.holeClearance, { (millimeter) : [0, 0, 2] } as LengthBoundSpec);

                annotation { "Name" : "Pocket width clearance", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.widthClearance, { (millimeter) : [0, 0, 2] } as LengthBoundSpec);

                annotation { "Name" : "Pocket depth clearance", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.depthClearance, { (millimeter) : [0, 0, 2] } as LengthBoundSpec);
            }
        }

        annotation { "Name" : "Blind hole (set total depth)" }
        definition.blindHole is boolean;

        if (definition.blindHole)
        {
            annotation { "Name" : "Hole depth from face", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
            isLength(definition.holeDepth, { (millimeter) : [0.5, 10, 500] } as LengthBoundSpec);
        }

        annotation { "Name" : "Bridge layer thickness", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
        isLength(definition.layerThickness, { (millimeter) : [0.05, 0.2, 1] } as LengthBoundSpec);

        annotation { "Name" : "Cut all overlapping parts" }
        definition.cutAll is boolean;

        annotation { "Name" : "Flip cut direction" }
        definition.flipDirection is boolean;

        annotation { "Name" : "Debug mode" }
        definition.debug is boolean;
    }
    {
        // GUARD: stop kalau user belum select apa-apa
        if (isQueryEmpty(context, definition.locations))
            throw regenError("Select at least one mate connector or circular edge.", ["locations"]);

        // Resolve dimensi final
        var holeDia;
        var pocketW; // hex: width across flats, round: diameter pocket
        var pocketDepth;
        if (definition.size == NutSize.CUSTOM)
        {
            holeDia = definition.customHoleDia;
            if (definition.style == PocketStyle.HEX_NUT)
                pocketW = definition.customAf;
            else
                pocketW = definition.customHeadDia;
            pocketDepth = definition.customPocketDepth;
        }
        else
        {
            const spec = nutSpec(definition.size);
            holeDia = spec.d * millimeter + definition.holeClearance;
            if (definition.style == PocketStyle.HEX_NUT)
            {
                pocketW = spec.af * millimeter + definition.widthClearance;
                pocketDepth = spec.h * millimeter + definition.depthClearance;
            }
            else
            {
                pocketW = spec.hd * millimeter + definition.widthClearance;
                pocketDepth = spec.hh * millimeter + definition.depthClearance;
            }
        }

        const layerH = definition.layerThickness;
        var circleDepth = 1 * meter; // through: cukup panjang, kelebihan hilang saat subtract
        if (definition.blindHole)
        {
            circleDepth = definition.holeDepth;
            if (circleDepth < pocketDepth + 2 * layerH)
                throw regenError("Hole depth must be larger than pocket depth + 2 bridge layers.", ["holeDepth"]);
        }

        if (holeDia >= pocketW)
            throw regenError("Bolt hole diameter must be smaller than the pocket width/diameter.");

        const rFlat = pocketW / 2;
        const rVertex = rFlat / cos(30 * degree);
        const solids = qBodyType(qEverything(EntityType.BODY), BodyType.SOLID);

        var refDir = undefined;
        if (!isQueryEmpty(context, definition.orientationEdge))
            refDir = evLine(context, { "edge" : definition.orientationEdge }).direction;

        var dbg = "=== Nut Hole debug ===\n";
        dbg = dbg ~ "style=" ~ toString(definition.style) ~ " holeDia=" ~ toString(holeDia / millimeter) ~
            "mm width=" ~ toString(pocketW / millimeter) ~ "mm pocket=" ~ toString(pocketDepth / millimeter) ~
            "mm layer=" ~ toString(layerH / millimeter) ~ "mm\n";

        var sketchQueries = [];
        const locs = evaluateQuery(context, definition.locations);
        dbg = dbg ~ "locations selected: " ~ toString(size(locs)) ~ "\n";
        var idx = 0;
        var cutCount = 0;
        for (var loc in locs)
        {
            const locNum = idx;
            const locId = id + ("loc" ~ toString(idx));
            idx += 1;

            // Ambil coordinate system dari edge lingkaran atau mate connector
            var origin;
            var zDir;
            var xDir;
            var locType;
            if (!isQueryEmpty(context, qEntityFilter(loc, EntityType.EDGE)))
            {
                const curve = evCurveDefinition(context, { "edge" : loc });
                origin = curve.coordSystem.origin;
                zDir = curve.coordSystem.zAxis;
                xDir = curve.coordSystem.xAxis;
                locType = "edge";
            }
            else
            {
                const cs = evMateConnector(context, { "mateConnector" : loc });
                origin = cs.origin;
                zDir = cs.zAxis;
                xDir = cs.xAxis;
                locType = "MC";
            }
            const yDir = cross(zDir, xDir);

            // Deteksi arah: probe 8 arah melingkar x 2 kedalaman (dekat permukaan dan
            // dasar pocket). Sisi dengan skor material terbanyak yang dipilih —
            // menghindari salah arah kalau kedua sisi sama-sama ada material.
            const eps = min(0.2 * millimeter, pocketDepth / 2);
            const depths = [eps, max(eps, pocketDepth - eps)];
            const rTest = (holeDia / 2 + rFlat) / 2;
            var minusHits = [];
            var plusHits = [];
            var minusMask = "";
            var plusMask = "";
            var minusScore = 0;
            var plusScore = 0;
            for (var d in depths)
            {
                for (var k = 0; k < 8; k += 1)
                {
                    const ang = k * 45 * degree;
                    const radial = (xDir * cos(ang) + yDir * sin(ang)) * rTest;
                    const hitsM = evaluateQuery(context, qContainsPoint(solids, origin - zDir * d + radial));
                    const hitsP = evaluateQuery(context, qContainsPoint(solids, origin + zDir * d + radial));
                    if (size(hitsM) > 0)
                    {
                        minusHits = concatenateArrays([minusHits, hitsM]);
                        minusScore += 1;
                        minusMask = minusMask ~ "1";
                    }
                    else
                    {
                        minusMask = minusMask ~ "0";
                    }
                    if (size(hitsP) > 0)
                    {
                        plusHits = concatenateArrays([plusHits, hitsP]);
                        plusScore += 1;
                        plusMask = plusMask ~ "1";
                    }
                    else
                    {
                        plusMask = plusMask ~ "0";
                    }
                }
                minusMask = minusMask ~ ".";
                plusMask = plusMask ~ ".";
            }

            dbg = dbg ~ "loc" ~ toString(locNum) ~ " [" ~ locType ~ "] origin(mm)=" ~ toString(origin / millimeter) ~
                " z=" ~ toString(zDir) ~ "\n";
            dbg = dbg ~ "  probes rTest=" ~ toString(rTest / millimeter) ~ "mm minus=" ~ minusMask ~
                " (" ~ toString(minusScore) ~ ") plus=" ~ plusMask ~ " (" ~ toString(plusScore) ~ ")\n";

            if (minusScore == 0 && plusScore == 0)
            {
                dbg = dbg ~ "  -> SKIPPED: no material found on either side\n";
                reportFeatureWarning(context, id, "Skipped position " ~ toString(locNum) ~ ": no solid material found around it.");
                continue;
            }

            var useMinus = minusScore > plusScore; // seri -> plus; pakai Flip kalau salah arah
            if (definition.flipDirection)
                useMinus = !useMinus;

            var zIn = zDir;
            var targetArr = plusHits;
            if (useMinus)
            {
                zIn = -zDir;
                targetArr = minusHits;
            }
            if (size(targetArr) == 0)
                targetArr = concatenateArrays([minusHits, plusHits]);

            // Scope: default cuma part pemilik posisi; "Cut all overlapping parts" = semua yang kena probe
            var target;
            var scopeDbg;
            if (definition.cutAll)
            {
                target = qUnion(targetArr); // evaluate SEBELUM bikin tool bodies
                scopeDbg = "all(" ~ toString(size(targetArr)) ~ " hits)";
            }
            else if (locType == "edge")
            {
                target = qOwnerBody(loc);
                scopeDbg = "owner";
            }
            else
            {
                // MC: pilih body yang paling sering kena probe
                var best = targetArr[0];
                var bestCount = 0;
                for (var cand in targetArr)
                {
                    var c = 0;
                    for (var other in targetArr)
                    {
                        if (cand == other)
                            c += 1;
                    }
                    if (c > bestCount)
                    {
                        bestCount = c;
                        best = cand;
                    }
                }
                target = best;
                scopeDbg = "majority(" ~ toString(bestCount) ~ "/" ~ toString(size(targetArr)) ~ ")";
            }
            dbg = dbg ~ "  -> cut dir=" ~ toString(zIn) ~ " scope=" ~ scopeDbg ~ "\n";

            // Orientasi slot: sejajar garis referensi kalau diisi
            var xUse = xDir;
            if (refDir != undefined)
            {
                const proj = refDir - dot(refDir, zIn) * zIn;
                if (norm(proj) < 1e-6)
                {
                    reportFeatureWarning(context, id, "Orientation edge is perpendicular to the face at position " ~
                            toString(locNum) ~ "; using default orientation.");
                }
                else
                {
                    xUse = normalize(proj);
                }
            }

            // ---- Stage 1: pocket (hex nut / round screw head), 0 -> pocketDepth ----
            const skPocketId = locId + "skPocket";
            var skPocket = newSketchOnPlane(context, skPocketId, { "sketchPlane" : plane(origin, zIn, xUse) });
            if (definition.style == PocketStyle.HEX_NUT)
            {
                for (var k = 0; k < 6; k += 1)
                {
                    const a0 = (30 + 60 * k) * degree;
                    const a1 = (30 + 60 * (k + 1)) * degree;
                    skLineSegment(skPocket, "h" ~ toString(k), {
                                "start" : vector(rVertex * cos(a0), rVertex * sin(a0)),
                                "end" : vector(rVertex * cos(a1), rVertex * sin(a1))
                            });
                }
            }
            else
            {
                skCircle(skPocket, "pocket", { "center" : vector(0, 0) * millimeter, "radius" : rFlat });
            }
            skSolve(skPocket);
            opExtrude(context, locId + "pocket", {
                        "entities" : qSketchRegion(skPocketId),
                        "direction" : zIn,
                        "endBound" : BoundingType.BLIND,
                        "endDepth" : pocketDepth
                    });

            // ---- Stage 2: bridge layer 1 - slot membelah pocket, lebar = hole dia ----
            // Slot di-clip ke outline pocket supaya gak menembus dindingnya.
            const skSlotId = locId + "skSlot";
            var skSlot = newSketchOnPlane(context, skSlotId, {
                    "sketchPlane" : plane(origin + zIn * pocketDepth, zIn, xUse) });
            const hSlot = holeDia / 2;
            if (definition.style == PocketStyle.HEX_NUT)
            {
                const yF = rVertex / 2; // setengah panjang flat hex
                if (hSlot <= yF)
                {
                    // slot muat di flat: rectangle biasa, ujung pas di dinding hex
                    skRectangle(skSlot, "slot", {
                                "firstCorner" : vector(-rFlat, -hSlot),
                                "secondCorner" : vector(rFlat, hSlot)
                            });
                }
                else
                {
                    // slot lebih lebar dari flat: pojok dibelokkan mengikuti sisi miring hex
                    const xTop = rFlat * (2 - 2 * (hSlot / rVertex));
                    const pts = [
                            vector(rFlat, -yF), vector(rFlat, yF),
                            vector(xTop, hSlot), vector(-xTop, hSlot),
                            vector(-rFlat, yF), vector(-rFlat, -yF),
                            vector(-xTop, -hSlot), vector(xTop, -hSlot)
                        ];
                    for (var k = 0; k < 8; k += 1)
                    {
                        skLineSegment(skSlot, "s" ~ toString(k), { "start" : pts[k], "end" : pts[(k + 1) % 8] });
                    }
                }
            }
            else
            {
                // pocket bulat: slot = strip dipotong lingkaran (2 garis + 2 busur)
                const xC = sqrt(rFlat ^ 2 - hSlot ^ 2);
                skLineSegment(skSlot, "sTop", { "start" : vector(-xC, hSlot), "end" : vector(xC, hSlot) });
                skLineSegment(skSlot, "sBot", { "start" : vector(-xC, -hSlot), "end" : vector(xC, -hSlot) });
                skArc(skSlot, "aR", {
                            "start" : vector(xC, hSlot),
                            "mid" : vector(rFlat, 0 * millimeter),
                            "end" : vector(xC, -hSlot)
                        });
                skArc(skSlot, "aL", {
                            "start" : vector(-xC, -hSlot),
                            "mid" : vector(-rFlat, 0 * millimeter),
                            "end" : vector(-xC, hSlot)
                        });
            }
            skSolve(skSlot);
            opExtrude(context, locId + "slot", {
                        "entities" : qSketchRegion(skSlotId),
                        "direction" : zIn,
                        "endBound" : BoundingType.BLIND,
                        "endDepth" : layerH
                    });

            // ---- Stage 3: bridge layer 2 - kotak hole dia x hole dia ----
            const skSqId = locId + "skSquare";
            var skSq = newSketchOnPlane(context, skSqId, {
                    "sketchPlane" : plane(origin + zIn * (pocketDepth + layerH), zIn, xUse) });
            skRectangle(skSq, "square", {
                        "firstCorner" : vector(-holeDia / 2, -holeDia / 2),
                        "secondCorner" : vector(holeDia / 2, holeDia / 2)
                    });
            skSolve(skSq);
            opExtrude(context, locId + "square", {
                        "entities" : qSketchRegion(skSqId),
                        "direction" : zIn,
                        "endBound" : BoundingType.BLIND,
                        "endDepth" : layerH
                    });

            // ---- Stage 4: lubang bolt bulat (dari face sampai tembus / holeDepth) ----
            const skCircId = locId + "skCircle";
            var skCirc = newSketchOnPlane(context, skCircId, { "sketchPlane" : plane(origin, zIn, xUse) });
            skCircle(skCirc, "bolt", {
                        "center" : vector(0, 0) * millimeter,
                        "radius" : holeDia / 2
                    });
            skSolve(skCirc);
            opExtrude(context, locId + "hole", {
                        "entities" : qSketchRegion(skCircId),
                        "direction" : zIn,
                        "endBound" : BoundingType.BLIND,
                        "endDepth" : circleDepth
                    });

            // Subtract semua tool sekaligus dari body target
            var booleanOk = true;
            try
            {
                opBoolean(context, locId + "cut", {
                            "tools" : qUnion([
                                    qCreatedBy(locId + "pocket", EntityType.BODY),
                                    qCreatedBy(locId + "slot", EntityType.BODY),
                                    qCreatedBy(locId + "square", EntityType.BODY),
                                    qCreatedBy(locId + "hole", EntityType.BODY)
                                ]),
                            "targets" : target,
                            "operationType" : BooleanOperationType.SUBTRACTION
                        });
            }
            catch
            {
                booleanOk = false;
                dbg = dbg ~ "  -> BOOLEAN FAILED at loc" ~ toString(locNum) ~ "\n";
                reportFeatureWarning(context, id, "Boolean failed at position " ~ toString(locNum) ~ ".");
                // buang tool bodies yang nyangkut biar gak jadi part liar
                opDeleteBodies(context, locId + "cleanupTools", {
                            "entities" : qUnion([
                                    qCreatedBy(locId + "pocket", EntityType.BODY),
                                    qCreatedBy(locId + "slot", EntityType.BODY),
                                    qCreatedBy(locId + "square", EntityType.BODY),
                                    qCreatedBy(locId + "hole", EntityType.BODY)
                                ]) });
            }

            sketchQueries = append(sketchQueries, qCreatedBy(skPocketId, EntityType.BODY));
            sketchQueries = append(sketchQueries, qCreatedBy(skSlotId, EntityType.BODY));
            sketchQueries = append(sketchQueries, qCreatedBy(skSqId, EntityType.BODY));
            sketchQueries = append(sketchQueries, qCreatedBy(skCircId, EntityType.BODY));
            if (booleanOk)
            {
                dbg = dbg ~ "  -> OK\n";
                cutCount += 1;
            }
        }

        if (size(sketchQueries) > 0)
            opDeleteBodies(context, id + "deleteSketches", { "entities" : qUnion(sketchQueries) });

        dbg = dbg ~ "done: " ~ toString(cutCount) ~ "/" ~ toString(size(locs)) ~ " cut\n";

        if (definition.debug)
        {
            println(dbg);
            reportFeatureInfo(context, id, dbg);
        }

        if (cutCount == 0)
            throw regenError("No cuts were made. Check that each position touches a solid body.", ["locations"]);
    });
