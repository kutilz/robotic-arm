FeatureScript 3008;
import(path : "onshape/std/common.fs", version : "3008.0");

/*
 * Servo Gear Gripper
 *
 * Generates a servo-driven gripper built from two identical meshing spur gears
 * (gear A = driver on the servo shaft, gear B = follower on a pivot pin).
 * Two mechanisms, selectable from the feature dialog:
 *   - ANGULAR:  fingers are one piece with the gears and open/close like scissors.
 *   - PARALLEL: each gear drives an arm; an idler link + finger carrier form a
 *               parallelogram so the jaw faces stay parallel. Per side 3 bodies
 *               (gear+arm, idler link, carrier), stacked in layers along the gear
 *               axis so they can be pinned together after printing.
 *
 * The base plate is NOT generated - the pivot positions to drill are reported
 * in the feature info message.
 *
 * Styling: every part is built from arc profiles instead of bare rectangles -
 * round hub at each gear center, arms that taper to a rounded tip, dogbone
 * idler links with pin bosses, rounded jaw fingers, and chamfered gear rims.
 *
 * REQUIRED SETUP - this feature reuses the "Spur Gear" custom feature:
 *   Option 1 (simplest): paste this code into the SAME Feature Studio that
 *     contains the Spur Gear feature and delete the import placeholder below.
 *   Option 2: keep it in its own Feature Studio, create a Version of the
 *     document, then replace the placeholder below with the real import of the
 *     spur gear Feature Studio (documentId/versionId/elementId).
 */
// TODO(option 2): uncomment and fill in with your document's ids:
// export import(path : "<documentId>/<versionId>/<elementId-spur-gear>", version : "<microversion>");

export enum GripperMechanism
{
    annotation { "Name" : "Angular (scissor)" }
    ANGULAR,
    annotation { "Name" : "Parallel jaw (4-bar)" }
    PARALLEL
}

annotation { "Feature Type Name" : "Servo Gear Gripper", "Feature Name Template" : "Gripper (#teeth teeth)" }
export const servoGearGripper = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Mechanism", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
        definition.mechanism is GripperMechanism;

        annotation { "Name" : "Number of teeth (per gear)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
        isInteger(definition.numTeeth, GRIPPER_TEETH_BOUNDS);

        annotation { "Name" : "Module", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
        isLength(definition.module, GRIPPER_MODULE_BOUNDS);

        annotation { "Name" : "Pressure angle", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
        isAngle(definition.pressureAngle, GRIPPER_PRESSURE_ANGLE_BOUNDS);

        annotation { "Name" : "Gear and finger thickness", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
        isLength(definition.gearDepth, GRIPPER_DEPTH_BOUNDS);

        annotation { "Name" : "Finger length", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
        isLength(definition.fingerLength, FINGER_LENGTH_BOUNDS);

        annotation { "Name" : "Finger width", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
        isLength(definition.fingerWidth, FINGER_WIDTH_BOUNDS);

        annotation { "Name" : "Grip pad / jaw length", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
        isLength(definition.padLength, PAD_BOUNDS);

        annotation { "Name" : "Driver bore dia. (servo shaft/horn)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
        isLength(definition.driverBoreDia, DRIVER_BORE_BOUNDS);

        annotation { "Name" : "Follower bore dia. (pivot pin)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
        isLength(definition.followerBoreDia, FOLLOWER_BORE_BOUNDS);

        if (definition.mechanism == GripperMechanism.PARALLEL)
        {
            annotation { "Group Name" : "Parallel linkage", "Collapsed By Default" : false }
            {
                annotation { "Name" : "Link offset", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.linkOffset, LINK_OFFSET_BOUNDS);

                annotation { "Name" : "Pin hole dia.", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.pinDia, PIN_BOUNDS);
            }
        }

        annotation { "Name" : "Servo travel (rotation per gear)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
        isAngle(definition.travelAngle, TRAVEL_BOUNDS);

        annotation { "Name" : "Pose angle (open)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
        isAngle(definition.poseAngle, POSE_BOUNDS);

        annotation { "Name" : "Add clearance for 3D printing" }
        definition.useClearance is boolean;

        if (definition.useClearance)
        {
            annotation { "Group Name" : "3D printing clearance", "Collapsed By Default" : false, "Driving Parameter" : "useClearance" }
            {
                annotation { "Name" : "Tooth backlash", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.backlash, CLEARANCE_BOUNDS);

                annotation { "Name" : "Bore clearance (on dia.)", "UIHint" : "REMEMBER_PREVIOUS_VALUE" }
                isLength(definition.boreClearance, CLEARANCE_BOUNDS);
            }
        }
    }

    {
        // ---- derived values ----
        const N = definition.numTeeth;
        const m = definition.module;
        const pcd = m * N;
        const centerDist = pcd; // identical gears, 1:1 -> center distance = one PCD
        const depth = definition.gearDepth;
        const fw = definition.fingerWidth;
        const fl = definition.fingerLength;
        const pad = definition.padLength;
        const theta = definition.poseAngle;

        // styling radii: round hub at the gear center, boss around each pin joint,
        // slimmer bar between the bosses (dogbone look), chamfer on the gear rims
        const rootR = min(1.25 * fw, pcd / 2 - 1.5 * m);
        const bossR = 0.62 * fw;
        const barR = 0.45 * fw;
        const chamferW = min(min(0.5 * millimeter, depth / 6), m / 4);

        var backlash = 0 * millimeter;
        var boreClear = 0 * millimeter;
        if (definition.useClearance)
        {
            backlash = definition.backlash;
            boreClear = definition.boreClearance;
        }

        checkGripperDefinition(definition, pcd);

        // Both gears are generated with a tooth centered on +X. With an even tooth
        // count that puts tooth tip against tooth tip at the mesh point, so gear B
        // is clocked by half a tooth pitch. With an odd count a gap already faces A.
        const meshOffsetAngle = (N % 2 == 0) ? (180 / N) * degree : 0 * degree;

        // ---- only the teeth that ever reach the mesh ----
        // Over its travel gear A turns counterclockwise by `travel` while the mesh
        // point sits at its local 0 deg, so the teeth it uses live between local
        // -travel - halfAction and +halfAction (gear B is the mirror about the line
        // of centers, meshing at its local 180 deg). halfAction is half the angle of
        // action: how far either side of the line of centers a tooth pair stays in
        // contact. usedToothSector adds one more tooth of margin at each end.
        const travel = definition.travelAngle;
        const pitchAngle = 360 / N * degree;
        const rTip = pcd / 2 + m;
        const rBase = pcd / 2 * cos(definition.pressureAngle);
        const contactPath = 2 * sqrt(rTip ^ 2 - rBase ^ 2) - centerDist * sin(definition.pressureAngle);
        const halfAction = contactPath / cos(definition.pressureAngle) / pcd * radian; // (arc of action / pitch radius) / 2
        const sectorA = usedToothSector(0 * degree, -travel - halfAction, halfAction, pitchAngle, N);
        const sectorB = usedToothSector(meshOffsetAngle, 180 * degree - halfAction, 180 * degree + travel + halfAction, pitchAngle, N);

        // Same plane the SpurGear feature uses by default (normal -Y): sketch X is
        // the line of centers, sketch Y (world Z) is the finger direction, and the
        // gears extrude from world Y = 0 down to -depth.
        const gripPlane = plane(vector(0, 0, 0) * meter, vector(0, -1, 0), vector(1, 0, 0));
        const axisDir = vector(0, 1, 0);
        const centerA = vector(0, 0, 0) * meter;
        const centerB = vector(1, 0, 0) * centerDist;

        // ---- the two meshing gears ----
        const gearDefBase = {
            "GearInputType" : GearInputType.module,
            "module" : m,
            "numTeeth" : N,
            "pitchCircleDiameter" : pcd,
            "pressureAngle" : definition.pressureAngle,
            "rootFillet" : RootFilletType.third,
            "chamfer" : true, // break the sharp rim edge - looks better and prints better
            "chamferType" : GearChamferType.OFFSET_ANGLE,
            "width" : chamferW,
            "angle" : 45 * degree,
            "oppositeDirection" : false,
            "centerHole" : false, // bores are cut here, after the fingers are joined on
            "centerHoleDia" : 0 * meter,
            "key" : false,
            "offset" : true, // required so offsetAngle/backlash take effect in SpurGear
            "backlash" : backlash,
            "dedendumFactor" : DedendumFactor.d250,
            "offsetClearance" : 0 * meter,
            "offsetDiameter" : 0 * meter,
            "helical" : false,
            "centerPoint" : false,
            "gearDepth" : depth,
            "flipGear" : false
        };

        // clocked so the first hobbed tooth space is the first one in use - only
        // sector.count tooth spaces get cut, the rest of the rim is trimmed off below
        SpurGear(context, id + "gearA", mergeMaps(gearDefBase, { "offsetAngle" : sectorA.offsetAngle, "toothCutCount" : sectorA.count }));
        SpurGear(context, id + "gearB", mergeMaps(gearDefBase, { "offsetAngle" : sectorB.offsetAngle, "toothCutCount" : sectorB.count }));

        opTransform(context, id + "moveGearB", {
                    "bodies" : qCreatedBy(id + "gearB", EntityType.BODY),
                    "transform" : transform(vector(1, 0, 0) * centerDist)
                });

        // ---- fingers / linkage, bores and pose, per side ----
        for (var side = 0; side < 2; side += 1)
        {
            const sideName = (side == 0) ? "A" : "B";
            const centerX = (side == 0) ? 0 * meter : centerDist;
            const inward = (side == 0) ? 1 : -1; // +X is "toward the other jaw" for side A
            const rotSign = (side == 0) ? -1 : 1; // opening direction about the gear axis
            const gearAxis = line((side == 0) ? centerA : centerB, axisDir);
            const gearSolid = qBodyType(qCreatedBy(id + ("gear" ~ sideName), EntityType.BODY), BodyType.SOLID);

            // drop the rim outside the working sector: what is left is a plain hub
            // cylinder plus the wedge of teeth that actually mesh
            const sector = (side == 0) ? sectorA : sectorB;
            if (!sector.full)
            {
                trimToSector(context, id + ("sector" ~ sideName), vector(centerX, 0 * meter),
                    sector.startAngle, sector.endAngle, pcd / 2 - 1.5 * m, pcd / 2 + 2 * m, depth, gearSolid);
            }

            var pivotX = 0 * meter;
            if (definition.mechanism == GripperMechanism.PARALLEL)
                pivotX = (side == 0) ? definition.linkOffset : centerDist - definition.linkOffset;

            // arm from the gear center: round hub tapering to a rounded tip
            // (used by both mechanisms; parallel gets a full pin boss at the tip,
            // which also puts material all around the arm pin hole)
            var armTipY = fl;
            var armTipR = bossR;
            if (definition.mechanism == GripperMechanism.ANGULAR)
            {
                armTipY = fl - fw / 2;
                armTipR = fw / 2;
            }
            extrudeLink(context, id + ("arm" ~ sideName), gripPlane,
                vector(centerX, 0 * meter), vector(centerX, armTipY), rootR, armTipR, depth);

            if (definition.mechanism == GripperMechanism.ANGULAR)
            {
                // rounded tapered grip pad reaching inward from the fingertip; its
                // root circle is offset from the arm tip circle so the union is a
                // clean transversal crossing (identical coincident cylinders can
                // fail the boolean)
                const padTipR = 0.4 * fw;
                extrudeLink(context, id + ("pad" ~ sideName), gripPlane,
                    vector(centerX + inward * 0.1 * fw, fl - fw / 2),
                    vector(centerX + inward * (fw / 2 + pad - padTipR), fl - fw / 2),
                    fw / 2, padTipR, depth);

                opBoolean(context, id + ("union" ~ sideName), {
                            "tools" : qUnion([gearSolid,
                                        qCreatedBy(id + ("arm" ~ sideName), EntityType.BODY),
                                        qCreatedBy(id + ("pad" ~ sideName), EntityType.BODY)]),
                            "operationType" : BooleanOperationType.UNION
                        });
            }
            else // PARALLEL
            {
                opBoolean(context, id + ("union" ~ sideName), {
                            "tools" : qUnion([gearSolid,
                                        qCreatedBy(id + ("arm" ~ sideName), EntityType.BODY)]),
                            "operationType" : BooleanOperationType.UNION
                        });

                // idler link on the next layer up (world Y in [0, depth]), so it can
                // swing over the gear; its base pivot goes in the user's base plate
                const linkPlane = plane(vector(0, 1, 0) * depth, vector(0, -1, 0), vector(1, 0, 0));
                const linkId = id + ("link" ~ sideName);
                extrudeLink(context, linkId + "bar", linkPlane,
                    vector(pivotX, 0 * meter), vector(pivotX, fl), barR, barR, depth);
                extrudeDisc(context, linkId + "b0", linkPlane, vector(pivotX, 0 * meter), bossR, depth);
                extrudeDisc(context, linkId + "b1", linkPlane, vector(pivotX, fl), bossR, depth);
                opBoolean(context, linkId + "u", {
                            "tools" : qCreatedBy(linkId, EntityType.BODY),
                            "operationType" : BooleanOperationType.UNION
                        });

                // finger carrier / jaw on the layer above the link (world Y in [depth, 2*depth])
                const carrierPlane = plane(vector(0, 1, 0) * (2 * depth), vector(0, -1, 0), vector(1, 0, 0));
                const carrId = id + ("carr" ~ sideName);
                extrudeLink(context, carrId + "bar", carrierPlane,
                    vector(centerX, fl), vector(pivotX, fl), barR, barR, depth);
                extrudeDisc(context, carrId + "b0", carrierPlane, vector(centerX, fl), bossR, depth);
                extrudeDisc(context, carrId + "b1", carrierPlane, vector(pivotX, fl), bossR, depth);
                // rounded tapered jaw finger rising from the link-pin boss to the grip line
                extrudeLink(context, carrId + "jaw", carrierPlane,
                    vector(pivotX, fl), vector(pivotX, fl + pad - 0.4 * fw), 0.55 * fw, 0.4 * fw, depth);
                opBoolean(context, carrId + "u", {
                            "tools" : qCreatedBy(carrId, EntityType.BODY),
                            "operationType" : BooleanOperationType.UNION
                        });

                // pin holes: arm tip, link both ends, carrier both pins
                const pinR = (definition.pinDia + boreClear) / 2;
                cutCircles(context, id + ("armHole" ~ sideName), gripPlane,
                    [vector(centerX, fl)], pinR, depth, gearSolid);
                cutCircles(context, id + ("linkHoles" ~ sideName), linkPlane,
                    [vector(pivotX, 0 * meter), vector(pivotX, fl)], pinR, depth,
                    qCreatedBy(id + ("link" ~ sideName), EntityType.BODY));
                cutCircles(context, id + ("carrHoles" ~ sideName), carrierPlane,
                    [vector(centerX, fl), vector(pivotX, fl)], pinR, depth,
                    qCreatedBy(id + ("carr" ~ sideName), EntityType.BODY));
            }

            // center bore (re-cut here because the arm covers the gear center)
            const boreDia = ((side == 0) ? definition.driverBoreDia : definition.followerBoreDia) + boreClear;
            cutCircles(context, id + ("bore" ~ sideName), gripPlane,
                [vector(centerX, 0 * meter)], boreDia / 2, depth, gearSolid);

            // pose the mechanism at the requested opening angle (counter-rotation keeps the mesh)
            if (theta != 0 * degree)
            {
                const alpha = rotSign * theta;
                var poseBodies = qUnion([qCreatedBy(id + ("gear" ~ sideName), EntityType.BODY),
                            qCreatedBy(id + ("arm" ~ sideName), EntityType.BODY)]);
                if (definition.mechanism == GripperMechanism.ANGULAR)
                    poseBodies = qUnion([poseBodies, qCreatedBy(id + ("pad" ~ sideName), EntityType.BODY)]);

                opTransform(context, id + ("poseGear" ~ sideName), {
                            "bodies" : poseBodies,
                            "transform" : rotationAround(gearAxis, alpha)
                        });

                if (definition.mechanism == GripperMechanism.PARALLEL)
                {
                    // idler link swings by the same angle about its base pivot
                    opTransform(context, id + ("poseLink" ~ sideName), {
                                "bodies" : qCreatedBy(id + ("link" ~ sideName), EntityType.BODY),
                                "transform" : rotationAround(line(vector(1, 0, 0) * pivotX, axisDir), alpha)
                            });
                    // the carrier of a parallelogram only translates (wrist pin arc), never rotates
                    opTransform(context, id + ("poseCarr" ~ sideName), {
                                "bodies" : qCreatedBy(id + ("carr" ~ sideName), EntityType.BODY),
                                "transform" : transform(vector(fl * sin(alpha), 0 * meter, fl * (cos(alpha) - 1)))
                            });
                }
            }
        }

        // ---- info for building the base plate ----
        var info = "Center distance (drill driver and follower pivots this far apart): " ~ fmtMM(centerDist) ~
            "<br>Driver (servo) axis at X = 0 mm, follower pivot at X = " ~ fmtMM(centerDist);
        if (definition.mechanism == GripperMechanism.PARALLEL)
        {
            info = info ~ "<br>Idler link base pivots (also in the base plate, on the same center line): X = " ~
                fmtMM(definition.linkOffset) ~ " and X = " ~ fmtMM(centerDist - definition.linkOffset) ~
                "<br>Axial stacking per side: gear+arm, then idler link, then jaw carrier (each " ~ fmtMM(depth) ~ " thick)";
        }
        else
        {
            const safeSwing = 90 * degree - asin(fw / pcd);
            info = info ~ "<br>Approx. safe rotation per gear before the finger root reaches the mesh zone: +/-" ~
                toString(round(safeSwing / degree)) ~ " deg";
        }
        if (sectorA.full)
        {
            info = info ~ "<br>Full gears: a travel of " ~ toString(round(travel / degree)) ~
                " deg needs every tooth, nothing was trimmed";
        }
        else
        {
            info = info ~ "<br>Sector gears: " ~ toString(sectorA.count - 1) ~ " of " ~ toString(N) ~
                " teeth kept per gear (travel " ~ toString(round(travel / degree)) ~ " deg + contact arc " ~
                toString(round(2 * halfAction / degree)) ~ " deg + one tooth of margin at each end)" ~
                "<br>The teeth are laid out for the closed pose - assemble the servo horn with the jaws closed, " ~
                "driving past the travel runs the gears off their teeth";
        }
        reportFeatureInfo(context, id, info);

        setFeatureComputedParameter(context, id, { "name" : "teeth", "value" : N });
    });

function checkGripperDefinition(definition is map, pcd is ValueWithUnits)
{
    if (definition.poseAngle > definition.travelAngle)
        throw regenError("Pose angle cannot exceed the servo travel - the teeth are only cut over the travel", ["poseAngle", "travelAngle"]);

    if (definition.fingerWidth >= 0.8 * pcd)
        throw regenError("Finger width is too large for the gear size - increase module or tooth count", ["fingerWidth"]);

    if (definition.fingerLength <= definition.fingerWidth)
        throw regenError("Finger length must be larger than finger width", ["fingerLength"]);

    if (definition.fingerLength <= pcd / 2 + definition.module)
        throw regenError("Finger length must extend beyond the gear teeth", ["fingerLength"]);

    if (definition.driverBoreDia >= pcd - 4 * definition.module)
        throw regenError("Driver bore diameter must be less than the gear root diameter", ["driverBoreDia"]);

    if (definition.followerBoreDia >= pcd - 4 * definition.module)
        throw regenError("Follower bore diameter must be less than the gear root diameter", ["followerBoreDia"]);

    if (definition.mechanism == GripperMechanism.PARALLEL && definition.pinDia >= definition.fingerWidth)
        throw regenError("Pin hole diameter must be smaller than the finger width", ["pinDia"]);

    // the rounded profiles need enough length between their end circles
    if (definition.padLength < 0.75 * definition.fingerWidth)
        throw regenError("Grip pad / jaw length must be at least 3/4 of the finger width", ["padLength"]);

    if (definition.mechanism == GripperMechanism.PARALLEL && definition.linkOffset < definition.fingerWidth)
        throw regenError("Link offset must be at least the finger width", ["linkOffset"]);
}

// Which teeth of a gear are worth cutting: [windowStart, windowEnd] is the range of
// gear-local angles that pass through the contact zone over the servo travel, and
// gapPhase is the angle of one tooth space (the gear's clocking). Returns the
// clocking to hand the gear so the first cut tooth space is the first one in use,
// how many spaces to cut, and the sector to keep - one tooth of margin at each end.
// Cutting n spaces leaves n - 1 whole teeth, and the sector ends at the middle of
// the outermost spaces, so the trim never slices through a tooth.
function usedToothSector(gapPhase is ValueWithUnits, windowStart is ValueWithUnits, windowEnd is ValueWithUnits, pitchAngle is ValueWithUnits, numTeeth is number) returns map
{
    const iMin = floor((windowStart - gapPhase) / pitchAngle) - 1;
    const iMax = ceil((windowEnd - gapPhase) / pitchAngle) + 1;
    const gapCount = iMax - iMin + 1;

    if (gapCount >= numTeeth)
        return { "full" : true, "offsetAngle" : normalizeAngle(gapPhase), "count" : numTeeth,
                "startAngle" : 0 * degree, "endAngle" : 0 * degree };

    const startAngle = gapPhase + iMin * pitchAngle;
    return { "full" : false, "offsetAngle" : normalizeAngle(startAngle), "count" : gapCount,
            "startAngle" : startAngle, "endAngle" : gapPhase + iMax * pitchAngle };
}

function normalizeAngle(angle is ValueWithUnits) returns ValueWithUnits
{
    const deg = angle / degree;
    return (deg - 360 * floor(deg / 360)) * degree;
}

// cut the unused rim off a gear: subtract the ring between hubR and outerR that the
// working sector [startAngle, endAngle] does not cover, leaving the teeth in use on
// a plain hub. Subtraction (not intersection) so the gear keeps its identity for the
// arm, bore and pose that follow. hubR stays clear of the root circle so no face of
// the tool lands on the gear's root cylinder.
function trimToSector(context is Context, baseId is Id, center is Vector, startAngle is ValueWithUnits, endAngle is ValueWithUnits, hubR is ValueWithUnits, outerR is ValueWithUnits, depth is ValueWithUnits, gearSolid is Query)
{
    // the tool overshoots both gear faces so the caps are not coincident
    const over = depth / 4;
    const toolPlane = plane(vector(0, 1, 0) * over, vector(0, -1, 0), vector(1, 0, 0));
    const toolDepth = depth + 2 * over;
    const dirStart = vector(cos(startAngle), sin(startAngle));
    const dirEnd = vector(cos(endAngle), sin(endAngle));

    const sk = newSketchOnPlane(context, baseId + "sk", { "sketchPlane" : toolPlane });
    skCircle(sk, "outer", { "center" : center, "radius" : outerR });
    skCircle(sk, "hub", { "center" : center, "radius" : hubR });
    skLineSegment(sk, "radius0", { "start" : center + hubR * dirStart, "end" : center + outerR * dirStart });
    skLineSegment(sk, "radius1", { "start" : center + hubR * dirEnd, "end" : center + outerR * dirEnd });
    skSolve(sk);

    // the two radii split the ring in two: keep the sector, extrude the other part.
    // Its middle is half a turn from the middle of the sector.
    const scrapAngle = (startAngle + endAngle) / 2 + 180 * degree;
    const scrapPoint = center + (hubR + outerR) / 2 * vector(cos(scrapAngle), sin(scrapAngle));
    opExtrude(context, baseId + "ext", {
                "entities" : qContainsPoint(qCreatedBy(baseId + "sk", EntityType.FACE), planeToWorld(toolPlane, scrapPoint)),
                "direction" : toolPlane.normal,
                "endBound" : BoundingType.BLIND,
                "endDepth" : toolDepth
            });
    opDeleteBodies(context, baseId + "delSk", { "entities" : qCreatedBy(baseId + "sk") });

    opBoolean(context, baseId + "trim", {
                "tools" : qCreatedBy(baseId + "ext", EntityType.BODY),
                "targets" : gearSolid,
                "operationType" : BooleanOperationType.SUBTRACTION
            });
}

// tapered link with rounded ends: circles r1 at c1 and r2 at c2 joined by their
// outer tangent lines, extruded along the plane normal (works for r1 != r2 as
// long as the center distance exceeds |r1 - r2|)
function extrudeLink(context is Context, baseId is Id, sketchPlane is Plane, c1 is Vector, c2 is Vector, r1 is ValueWithUnits, r2 is ValueWithUnits, depth is ValueWithUnits)
{
    const L = norm(c2 - c1);
    const u = (c2 - c1) / L;
    const v = vector(-u[1], u[0]);
    const delta = acos((r1 - r2) / L); // angle from the center line to the tangent points
    const dirP = cos(delta) * u + sin(delta) * v;
    const dirM = cos(delta) * u - sin(delta) * v;

    const sk = newSketchOnPlane(context, baseId + "sk", { "sketchPlane" : sketchPlane });
    skArc(sk, "backArc", { "start" : c1 + r1 * dirP, "mid" : c1 - r1 * u, "end" : c1 + r1 * dirM });
    skLineSegment(sk, "sideM", { "start" : c1 + r1 * dirM, "end" : c2 + r2 * dirM });
    skArc(sk, "tipArc", { "start" : c2 + r2 * dirM, "mid" : c2 + r2 * u, "end" : c2 + r2 * dirP });
    skLineSegment(sk, "sideP", { "start" : c2 + r2 * dirP, "end" : c1 + r1 * dirP });
    skSolve(sk);
    opExtrude(context, baseId + "ext", {
                "entities" : qSketchRegion(baseId + "sk"),
                "direction" : sketchPlane.normal,
                "endBound" : BoundingType.BLIND,
                "endDepth" : depth
            });
    opDeleteBodies(context, baseId + "delSk", { "entities" : qCreatedBy(baseId + "sk") });
}

// one filled circle, extruded (pin bosses)
function extrudeDisc(context is Context, baseId is Id, sketchPlane is Plane, center is Vector, radius is ValueWithUnits, depth is ValueWithUnits)
{
    const sk = newSketchOnPlane(context, baseId + "sk", { "sketchPlane" : sketchPlane });
    skCircle(sk, "c", { "center" : center, "radius" : radius });
    skSolve(sk);
    opExtrude(context, baseId + "ext", {
                "entities" : qSketchRegion(baseId + "sk"),
                "direction" : sketchPlane.normal,
                "endBound" : BoundingType.BLIND,
                "endDepth" : depth
            });
    opDeleteBodies(context, baseId + "delSk", { "entities" : qCreatedBy(baseId + "sk") });
}

// cut one or more equal circles through the targets (disjoint circles in one sketch are fine)
function cutCircles(context is Context, baseId is Id, sketchPlane is Plane, centers is array, radius is ValueWithUnits, depth is ValueWithUnits, targets is Query)
{
    const sk = newSketchOnPlane(context, baseId + "sk", { "sketchPlane" : sketchPlane });
    for (var i = 0; i < size(centers); i += 1)
    {
        skCircle(sk, "c" ~ i, { "center" : centers[i], "radius" : radius });
    }
    skSolve(sk);
    opExtrude(context, baseId + "ext", {
                "entities" : qCreatedBy(baseId + "sk", EntityType.FACE),
                "direction" : sketchPlane.normal,
                "endBound" : BoundingType.BLIND,
                "endDepth" : depth
            });
    opBoolean(context, baseId + "cut", {
                "tools" : qCreatedBy(baseId + "ext", EntityType.BODY),
                "targets" : targets,
                "operationType" : BooleanOperationType.SUBTRACTION
            });
    opDeleteBodies(context, baseId + "delSk", { "entities" : qCreatedBy(baseId + "sk") });
}

function fmtMM(v is ValueWithUnits) returns string
{
    return toString(round(v / millimeter * 100) / 100) ~ " mm";
}

const GRIPPER_TEETH_BOUNDS =
{
            (unitless) : [8, 20, 100]
        } as IntegerBoundSpec;

const GRIPPER_MODULE_BOUNDS =
{
            (meter) : [1e-5, 0.002, 0.5],
            (centimeter) : 0.2,
            (millimeter) : 2.0,
            (inch) : 0.08
        } as LengthBoundSpec;

const GRIPPER_PRESSURE_ANGLE_BOUNDS =
{
            (degree) : [12, 20, 35]
        } as AngleBoundSpec;

const GRIPPER_DEPTH_BOUNDS =
{
            (meter) : [1e-5, 0.006, 0.5],
            (centimeter) : 0.6,
            (millimeter) : 6.0,
            (inch) : 0.25
        } as LengthBoundSpec;

const FINGER_LENGTH_BOUNDS =
{
            (meter) : [1e-4, 0.05, 1],
            (centimeter) : 5.0,
            (millimeter) : 50.0,
            (inch) : 2.0
        } as LengthBoundSpec;

const FINGER_WIDTH_BOUNDS =
{
            (meter) : [1e-4, 0.008, 0.5],
            (centimeter) : 0.8,
            (millimeter) : 8.0,
            (inch) : 0.3
        } as LengthBoundSpec;

const PAD_BOUNDS =
{
            (meter) : [1e-5, 0.015, 0.5],
            (centimeter) : 1.5,
            (millimeter) : 15.0,
            (inch) : 0.6
        } as LengthBoundSpec;

const DRIVER_BORE_BOUNDS =
{
            (meter) : [1e-5, 0.006, 0.5],
            (centimeter) : 0.6,
            (millimeter) : 6.0,
            (inch) : 0.25
        } as LengthBoundSpec;

const FOLLOWER_BORE_BOUNDS =
{
            (meter) : [1e-5, 0.003, 0.5],
            (centimeter) : 0.3,
            (millimeter) : 3.0,
            (inch) : 0.125
        } as LengthBoundSpec;

const LINK_OFFSET_BOUNDS =
{
            (meter) : [1e-4, 0.012, 0.5],
            (centimeter) : 1.2,
            (millimeter) : 12.0,
            (inch) : 0.5
        } as LengthBoundSpec;

const PIN_BOUNDS =
{
            (meter) : [1e-5, 0.003, 0.1],
            (centimeter) : 0.3,
            (millimeter) : 3.0,
            (inch) : 0.125
        } as LengthBoundSpec;

const TRAVEL_BOUNDS =
{
            (degree) : [1, 60, 180]
        } as AngleBoundSpec;

const POSE_BOUNDS =
{
            (degree) : [0, 20, 60]
        } as AngleBoundSpec;

const CLEARANCE_BOUNDS =
{
            (meter) : [0, 0.00015, 0.002],
            (centimeter) : 0.015,
            (millimeter) : 0.15,
            (inch) : 0.006
        } as LengthBoundSpec;

export const SpurGear = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Number of teeth" }
        isInteger(definition.numTeeth, TEETH_BOUNDS);

        annotation { "Name" : "Input type" }
        definition.GearInputType is GearInputType;

        if (definition.GearInputType == GearInputType.module)
        {
            annotation { "Name" : "Module" }
            isLength(definition.module, MODULE_BOUNDS);
        }

        if (definition.GearInputType == GearInputType.diametralPitch)
        {
            annotation { "Name" : "Diametral pitch" }
            isReal(definition.diametralPitch, POSITIVE_REAL_BOUNDS);
        }

        if (definition.GearInputType == GearInputType.circularPitch)
        {
            annotation { "Name" : "Circular pitch" }
            isLength(definition.circularPitch, LENGTH_BOUNDS);
        }

        annotation { "Name" : "Pitch circle diameter" }
        isLength(definition.pitchCircleDiameter, LENGTH_BOUNDS);

        annotation { "Name" : "Pressure angle" }
        isAngle(definition.pressureAngle, PRESSURE_ANGLE_BOUNDS);

        annotation { "Name" : "Root fillet", "Default" : RootFilletType.third, "UIHint" : "SHOW_LABEL" }
        definition.rootFillet is RootFilletType;

        annotation { "Name" : "Chamfer", "Default" : false }
        definition.chamfer is boolean;

        if (definition.chamfer)
        {
            annotation { "Group Name" : "Chamfer", "Collapsed By Default" : false, "Driving Parameter" : "chamfer" }
            {
                // Copied from the Chamfer feature
                annotation { "Name" : "Chamfer type", "Default" : GearChamferType.OFFSET_ANGLE }
                definition.chamferType is GearChamferType;

                //first quantity input (length)
                if (definition.chamferType != GearChamferType.TWO_OFFSETS)
                {
                    annotation { "Name" : "Distance" }
                    isLength(definition.width, CHAMFER_BOUNDS);
                }
                else
                {
                    annotation { "Name" : "Distance 1" }
                    isLength(definition.width1, CHAMFER_BOUNDS);
                }

                //opposite direction button
                if (definition.chamferType == GearChamferType.OFFSET_ANGLE ||
                    definition.chamferType == GearChamferType.TWO_OFFSETS)
                {
                    annotation { "Name" : "Opposite direction", "Default" : false, "UIHint" : "OPPOSITE_DIRECTION" }
                    definition.oppositeDirection is boolean;
                }

                //second quantity input (length or angle depending on type)
                if (definition.chamferType == GearChamferType.TWO_OFFSETS)
                {
                    annotation { "Name" : "Distance 2" }
                    isLength(definition.width2, CHAMFER_BOUNDS);
                }
                else if (definition.chamferType == GearChamferType.OFFSET_ANGLE)
                {
                    annotation { "Name" : "Angle" }
                    isAngle(definition.angle, CHAMFER_ANGLE_BOUNDS);
                }
            }
        }

        annotation { "Name" : "Center bore" }
        definition.centerHole is boolean;

        if (definition.centerHole)
        {
            annotation { "Group Name" : "Center Bore", "Collapsed By Default" : false, "Driving Parameter" : "centerHole" }
            {
                annotation { "Name" : "Bore diameter" }
                isLength(definition.centerHoleDia, CENTERHOLE_BOUNDS);

                annotation { "Name" : "Keyway" }
                definition.key is boolean;

                if (definition.key)
                {
                    annotation { "Name" : "Key width" }
                    isLength(definition.keyWidth, KEY_BOUNDS);

                    annotation { "Name" : "Key height" }
                    isLength(definition.keyHeight, KEY_BOUNDS);
                }
            }
        }

        annotation { "Name" : "Profile offsets" }
        definition.offset is boolean;

        if (definition.offset)
        {
            annotation { "Group Name" : "Offsets", "Collapsed By Default" : false, "Driving Parameter" : "offset" }
            {
                annotation { "Name" : "Backlash" }
                isLength(definition.backlash, BACKLASH_BOUNDS);

                annotation { "Name" : "Dedendum", "Default" : DedendumFactor.d250, "UIHint" : "SHOW_LABEL" }
                definition.dedendumFactor is DedendumFactor;

                annotation { "Name" : "Root diameter" }
                isLength(definition.offsetClearance, ZERO_DEFAULT_LENGTH_BOUNDS);

                annotation { "Name" : "Tip diameter" }
                isLength(definition.offsetDiameter, ZERO_DEFAULT_LENGTH_BOUNDS);

                annotation { "Name" : "Clocking angle" }
                isAngle(definition.offsetAngle, ANGLE_360_ZERO_DEFAULT_BOUNDS);
            }
        }

        annotation { "Name" : "Helical" }
        definition.helical is boolean;

        if (definition.helical)
        {
            annotation { "Group Name" : "Helical", "Collapsed By Default" : false, "Driving Parameter" : "helical" }
            {
                annotation { "Name" : "Angle" }
                isAngle(definition.helixAngle, HELIX_ANGLE_BOUNDS);

                annotation { "Name" : "Handedness" }
                definition.handedness is HelixDirection;

                annotation { "Name" : "Double helix" }
                definition.double is boolean;
            }
        }

        annotation { "Name" : "Move origin" }
        definition.centerPoint is boolean;

        if (definition.centerPoint)
        {
            annotation { "Group Name" : "Center point", "Collapsed By Default" : false, "Driving Parameter" : "centerPoint" }
            {
                annotation { "Name" : "Sketch vertex or mate connector", "Filter" : (EntityType.VERTEX && SketchObject.YES) || BodyType.MATE_CONNECTOR, "MaxNumberOfPicks" : 1 }
                definition.center is Query;
            }
        }

        annotation { "Name" : "Depth" }
        isLength(definition.gearDepth, BLEND_BOUNDS);

        annotation { "Name" : "Depth direction", "UIHint" : "OPPOSITE_DIRECTION" }
        definition.flipGear is boolean;
    }

    {
        // diameters in gear definition
        var offsetDiameter = 0 * meter;
        var offsetClearance = 0 * meter;
        var offsetAngle = 0 * degree;
        var backlash = 0 * meter;
        var dedendumFactor = 1.25;

        if (definition.offset)
        {
            offsetDiameter = definition.offsetDiameter;
            offsetClearance = definition.offsetClearance;
            offsetAngle = definition.offsetAngle;
            backlash = definition.backlash;

            if (definition.dedendumFactor == DedendumFactor.d157)
                dedendumFactor = 1.157;

            if (definition.dedendumFactor == DedendumFactor.d200)
                dedendumFactor = 1.2;
        }

        if (definition.centerHole && definition.centerHoleDia >= definition.pitchCircleDiameter - 4 * definition.module)
        {
            throw regenError("Center hole diameter must be less than the root diameter", ["centerHoleDia"]);
        }

        if (definition.key && definition.keyHeight / 2 + definition.centerHoleDia >= definition.pitchCircleDiameter - 4 * definition.module)
        {
            throw regenError("Center hole diameter plus Key height must be less than the root diameter", ["keyHeight"]);
        }

        const addendum = definition.module + offsetDiameter;
        const dedendum = dedendumFactor * definition.module + offsetClearance;
        const base = definition.pitchCircleDiameter * cos(definition.pressureAngle);

        // angle between root of teeth
        const alpha = sqrt(definition.pitchCircleDiameter ^ 2 - base ^ 2) / base * radian - definition.pressureAngle;
        const beta = 360 / (4 * definition.numTeeth) * degree - alpha;

        // if no center vertex selected build gear on the front plane at the origin
        var location = vector(0, 0, 0) * meter;
        var sketchPlane = plane(location, vector(0, -1, 0), vector(1, 0, 0));

        // else find location of selected vertex and its sketch plane or use mate connector to create a new sketch for the gear profile
        if (definition.centerPoint)
        {
            try silent
            {
                sketchPlane = evPlane(context, { "face" : definition.center });
                location = sketchPlane.origin;
            }
            catch
            {
                sketchPlane = evOwnerSketchPlane(context, { "entity" : definition.center });
                location = evVertexPoint(context, { "vertex" : definition.center });
            }
        }

        const gearSketch = newSketchOnPlane(context, id + "gearSketch", { "sketchPlane" : sketchPlane });
        const center = worldToPlane(sketchPlane, location);

        // create the outer diameter circle
        skCircle(gearSketch, "addendum", { "center" : center, "radius" : definition.pitchCircleDiameter / 2 + addendum });

        if (definition.centerHole)
        {
            if (definition.key)
            {
                var keyVector = vector(0, 1);
                var perpKeyVector = vector(-1, 0);
                var keyHeight = (definition.keyHeight + definition.centerHoleDia) / 2;

                var points = [
                    center - (definition.keyWidth / 2) * perpKeyVector,
                    center - (definition.keyWidth / 2) * perpKeyVector + keyHeight * keyVector,
                    center + (definition.keyWidth / 2) * perpKeyVector + keyHeight * keyVector,
                    center + (definition.keyWidth / 2) * perpKeyVector];

                for (var i = 0; i < size(points); i += 1)
                {
                    skLineSegment(gearSketch, "line" ~ i, { "start" : points[i], "end" : points[(i + 1) % size(points)] });
                }
            }

            // center hole circle sketch
            skCircle(gearSketch, "Center", {
                        "center" : center,
                        "radius" : definition.centerHoleDia / 2 });
        }
        skSolve(gearSketch);

        opExtrude(context, id + "extrude1", {
                    "entities" : qSketchRegion(id + "gearSketch", true),
                    "direction" : sketchPlane.normal * (definition.flipGear ? -1 : 1),
                    "endBound" : BoundingType.BLIND,
                    "endDepth" : definition.gearDepth });

        if (definition.chamfer)
        {
            definition.entities = qLargest(qCreatedBy(id + "extrude1", EntityType.EDGE));
            opChamfer(context, id + "chamfer1", definition);
        }

        const toothSketch = newSketchOnPlane(context, id + "toothSketch", { "sketchPlane" : sketchPlane });

        // build involute splines for each tooth
        var involute1 = [];
        var involute2 = [];

        for (var t = 0; t <= 2; t += (1 / 50)) // (1/50) is the involute spline tolerance
        {
            // involute definition math
            var angle = (t + (backlash / cos(definition.pressureAngle)) / definition.pitchCircleDiameter / 2) * radian;
            var offset = beta + offsetAngle;
            var ca = cos(angle + offset);
            var sa = sin(angle + offset);
            var cab = cos(offset - beta * 2 - angle);
            var sab = sin(offset - beta * 2 - angle);
            var point1;
            var point2;

            if (base >= definition.pitchCircleDiameter - 2 * dedendum && t == 0) // special case when base cylinder diameter is greater than dedendum
            {
                // calculate involute spline point
                point1 = vector((definition.pitchCircleDiameter / 2 - dedendum) * ca, (definition.pitchCircleDiameter / 2 - dedendum) * sa);
                point2 = vector((definition.pitchCircleDiameter / 2 - dedendum) * cab, (definition.pitchCircleDiameter / 2 - dedendum) * sab);
            }
            else
            {
                point1 = vector(base * 0.5 * (ca + t * sa), base * 0.5 * (sa - t * ca));
                point2 = vector(base * 0.5 * (cab - t * sab), base * 0.5 * (sab + t * cab));
            }

            // and add to array
            involute1 = append(involute1, point1 + center);
            involute2 = append(involute2, point2 + center);

            // if involute points go outside the outer diameter of the gear then stop
            if (sqrt(point1[0] ^ 2 + point1[1] ^ 2) >= (definition.pitchCircleDiameter / 2 + addendum))
                break;
        }

        // create involute sketch splines
        skFitSpline(toothSketch, "spline1", { "points" : involute1 });
        skFitSpline(toothSketch, "spline2", { "points" : involute2 });

        const regionPoint = center + vector((definition.pitchCircleDiameter / 2 - dedendum + 0.1 * millimeter) * cos(offsetAngle), (definition.pitchCircleDiameter / 2 - dedendum + 0.1 * millimeter) * sin(offsetAngle));

        skCircle(toothSketch, "addendum", { "center" : center, "radius" : definition.pitchCircleDiameter / 2 + addendum });
        skCircle(toothSketch, "dedendum", { "center" : center, "radius" : definition.pitchCircleDiameter / 2 - dedendum });
        skCircle(toothSketch, "fillet", { "center" : regionPoint, "radius" : 0.1 * millimeter, "construction" : true });

        skConstraint(toothSketch, "fix1", { "constraintType" : ConstraintType.FIX, "localFirst" : "dedendum" });
        skConstraint(toothSketch, "fix2", { "constraintType" : ConstraintType.FIX, "localFirst" : "spline1" });
        skConstraint(toothSketch, "fix3", { "constraintType" : ConstraintType.FIX, "localFirst" : "spline2" });
        skConstraint(toothSketch, "tangent1", { "constraintType" : ConstraintType.TANGENT, "localFirst" : "fillet", "localSecond" : "dedendum" });
        skConstraint(toothSketch, "tangent2", { "constraintType" : ConstraintType.TANGENT, "localFirst" : "fillet", "localSecond" : "spline1" });
        skConstraint(toothSketch, "tangent3", { "constraintType" : ConstraintType.TANGENT, "localFirst" : "fillet", "localSecond" : "spline2" });

        skSolve(toothSketch);

        opExtrude(context, id + "tooth", {
                    "entities" : qContainsPoint(qCreatedBy(id + "toothSketch", EntityType.FACE), planeToWorld(sketchPlane, regionPoint)),
                    "direction" : sketchPlane.normal * (definition.flipGear ? -1 : 1),
                    "endBound" : BoundingType.BLIND,
                    "endDepth" : definition.gearDepth });

        const filletEdges = qClosestTo(qNonCapEntity(id + "tooth", EntityType.EDGE), location);

        var rootFilletRadius = evCurveDefinition(context, { "edge" : sketchEntityQuery(id + "toothSketch", EntityType.EDGE, "fillet") }).radius;

        if (definition.rootFillet == RootFilletType.none)
            rootFilletRadius = 0;

        if (definition.rootFillet == RootFilletType.third)
            rootFilletRadius /= 1.5;

        if (definition.rootFillet == RootFilletType.quarter)
            rootFilletRadius /= 2;

        if (rootFilletRadius > 0)
        {
            opFillet(context, id + "fillet", { "entities" : filletEdges, "radius" : rootFilletRadius });
        }

        if (definition.helical)
        {
            var profileFace = qCapEntity(id + "tooth", CapType.START, EntityType.FACE);
            var helicalPitch = (PI * definition.pitchCircleDiameter) / tan(definition.helixAngle);
            var clockwise = definition.handedness == HelixDirection.CW;

            if (definition.double)
                clockwise = !clockwise;

            if (definition.flipGear && definition.double)
                clockwise = !clockwise;

            opHelix(context, id + "helix", {
                        "direction" : sketchPlane.normal * (definition.flipGear ? -1 : 1),
                        "axisStart" : location,
                        "startPoint" : location + sketchPlane.x * definition.pitchCircleDiameter / 2,
                        "interval" : [0, definition.gearDepth / helicalPitch / (definition.double ? 2 : 1)],
                        "clockwise" : clockwise,
                        "helicalPitch" : helicalPitch,
                        "spiralPitch" : 0 * meter });

            opSweep(context, id + "toothHelix", {
                        "profiles" : profileFace,
                        "path" : qCreatedBy(id + "helix", EntityType.EDGE) });

            opDeleteBodies(context, id + "deleteTooth", {
                        "entities" : qUnion([qCreatedBy(id + "tooth"), qCreatedBy(id + "helix")]) });

            if (definition.double)
            {
                opPattern(context, id + "mirror", {
                            "entities" : qCreatedBy(id + "toothHelix", EntityType.BODY),
                            "transforms" : [mirrorAcross(evPlane(context, { "face" : qCapEntity(id + "toothHelix", CapType.END, EntityType.FACE) }))],
                            "instanceNames" : ["1"] });

                opBoolean(context, id + "double", {
                            "tools" : qUnion([qCreatedBy(id + "toothHelix", EntityType.BODY), qCreatedBy(id + "mirror", EntityType.BODY)]),
                            "operationType" : BooleanOperationType.UNION });
            }
        }

        var tools = qUnion([qCreatedBy(id + "tooth", EntityType.BODY), qCreatedBy(id + "toothHelix", EntityType.BODY)]);
        var transforms = [];
        var instanceNames = [];

        // optional partial hobbing: cut only this many tooth spaces, counting
        // counterclockwise from the clocking angle. Undefined (dialog use) = all of them.
        var toothCutCount = definition.numTeeth;
        if (definition.toothCutCount != undefined)
            toothCutCount = definition.toothCutCount;

        for (var i = 1; i < toothCutCount; i += 1)
        {
            var instanceTransform = rotationAround(line(location, sketchPlane.normal), i * (360 / definition.numTeeth) * degree);
            transforms = append(transforms, instanceTransform);
            instanceNames = append(instanceNames, "" ~ i);
        }

        if (size(transforms) > 0)
        {
            opPattern(context, id + "pattern", {
                        "entities" : tools,
                        "transforms" : transforms,
                        "instanceNames" : instanceNames });
        }

        opBoolean(context, id + "hobbed", {
                    "tools" : qUnion([tools, qCreatedBy(id + "pattern", EntityType.BODY)]),
                    "targets" : qCreatedBy(id + "extrude1", EntityType.BODY),
                    "operationType" : BooleanOperationType.SUBTRACTION });

        // Remove sketch entities - no longer required
        opDeleteBodies(context, id + "delete", {
                    "entities" : qUnion([qCreatedBy(id + "gearSketch"), qCreatedBy(id + "toothSketch")]) });

        // created PCD sketch
        const PCDSketch = newSketchOnPlane(context, id + "PCDsketch", { "sketchPlane" : sketchPlane });

        skCircle(PCDSketch, "PCD", {
                    "center" : center,
                    "radius" : definition.pitchCircleDiameter / 2,
                    "construction" : true });

        skSolve(PCDSketch);

        setFeatureComputedParameter(context, id, { "name" : "teeth", "value" : definition.numTeeth });
    });

export function editGearLogic(context is Context, id is Id, oldDefinition is map, definition is map, isCreating is boolean, specifiedParameters is map, hiddenBodies is Query) returns map
{
    // isCreating is required in the function definition for edit logic to work when editing an existing feature
    if (oldDefinition.numTeeth != definition.numTeeth)
    {
        definition.module = definition.pitchCircleDiameter / definition.numTeeth;
        definition.circularPitch = definition.module * PI;
        definition.diametralPitch = 1 * inch / definition.module;
        return definition;
    }

    if (oldDefinition.circularPitch != definition.circularPitch)
    {
        definition.module = definition.circularPitch / PI;
        definition.pitchCircleDiameter = (definition.circularPitch * definition.numTeeth) / PI;
        definition.diametralPitch = 1 * inch / definition.module;
        return definition;
    }

    if (oldDefinition.pitchCircleDiameter != definition.pitchCircleDiameter)
    {
        definition.module = definition.pitchCircleDiameter / definition.numTeeth;
        definition.circularPitch = (PI * definition.pitchCircleDiameter) / definition.numTeeth;
        definition.diametralPitch = 1 * inch / definition.module;
        return definition;
    }

    if (oldDefinition.module != definition.module)
    {
        definition.circularPitch = definition.module * PI;
        definition.pitchCircleDiameter = definition.numTeeth * definition.module;
        definition.diametralPitch = 1 * inch / definition.module;
        return definition;
    }

    if (oldDefinition.diametralPitch != definition.diametralPitch)
    {
        definition.circularPitch = PI / (definition.diametralPitch / inch);
        definition.module = definition.circularPitch / PI;
        definition.pitchCircleDiameter = (definition.circularPitch * definition.numTeeth) / PI;
        return definition;
    }

    return definition;
}

const TEETH_BOUNDS =
{
            (unitless) : [4, 25, 1000]
        } as IntegerBoundSpec;

const PRESSURE_ANGLE_BOUNDS =
{
            (degree) : [12, 20, 35]
        } as AngleBoundSpec;

const MODULE_BOUNDS =
{
            (meter) : [1e-5, 0.001, 500],
            (centimeter) : 0.1,
            (millimeter) : 1.0,
            (inch) : 0.04
        } as LengthBoundSpec;

const CENTERHOLE_BOUNDS =
{
            (meter) : [1e-5, 0.01, 500],
            (centimeter) : 1.0,
            (millimeter) : 10.0,
            (inch) : 0.375
        } as LengthBoundSpec;

const KEY_BOUNDS =
{
            (meter) : [1e-5, 0.003, 500],
            (centimeter) : 0.3,
            (millimeter) : 3.0,
            (inch) : 0.125
        } as LengthBoundSpec;

const CHAMFER_ANGLE_BOUNDS =
{
            (degree) : [0.1, 60, 179.9]
        } as AngleBoundSpec;

const CHAMFER_BOUNDS =
{
            (meter) : [1e-5, 0.0005, 500],
            (centimeter) : 0.05,
            (millimeter) : 0.5,
            (inch) : 0.02
        } as LengthBoundSpec;

const BACKLASH_BOUNDS =
{
            (meter) : [-500, 0.0, 500],
            (centimeter) : 0,
            (millimeter) : 0,
            (inch) : 0
        } as LengthBoundSpec;

const HELIX_ANGLE_BOUNDS =
{
            (degree) : [5, 15, 45]
        } as AngleBoundSpec;

export enum GearInputType
{
    annotation { "Name" : "Module" }
    module,
    annotation { "Name" : "Diametral pitch" }
    diametralPitch,
    annotation { "Name" : "Circular pitch" }
    circularPitch
}

export enum RootFilletType
{
    annotation { "Name" : "None" }
    none,
    annotation { "Name" : "1/4" }
    quarter,
    annotation { "Name" : "1/3" }
    third,
    annotation { "Name" : "Full" }
    full
}

export enum DedendumFactor
{
    annotation { "Name" : "1.157 x addendum" }
    d157,
    annotation { "Name" : "1.20 x addendum" }
    d200,
    annotation { "Name" : "1.25 x addendum" }
    d250
}

export enum GearChamferType
{
    annotation { "Name" : "Equal distance" }
    EQUAL_OFFSETS,
    annotation { "Name" : "Two distances" }
    TWO_OFFSETS,
    annotation { "Name" : "Distance and angle" }
    OFFSET_ANGLE,
    annotation { "Hidden" : true }
    RAW_OFFSET
}

export enum HelixDirection
{
    annotation { "Name" : "Clockwise" }
    CW,
    annotation { "Name" : "Counterclockwise" }
    CCW
}
