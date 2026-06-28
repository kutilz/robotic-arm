# Motor & Cycloidal-Drive Sizing Report — 3D-Printed 6-DOF Arm

**Prepared for:** Ilyas — final-year robotics, fully 3D-printed 6-DOF arm (custom cycloidal drives + NEMA17 steppers)

## TL;DR
- **Worst-case (fully extended, horizontal) static holding torques are roughly J2 shoulder ≈ 11.4 N·m, J3 elbow ≈ 4.5 N·m, J5 wrist-pitch ≈ 0.7 N·m; with a 2.5× dynamic/safety factor the required OUTPUT torques become ≈ 29, 11, and 1.7 N·m.** The roll/yaw joints (J1, J4, J6) carry almost no gravity load in this pose and are sized by friction/inertia (~0.5–3 N·m).
- **A single 17HS4401-class NEMA17 (0.4 N·m holding, ~0.2 N·m running) cannot drive the shoulder alone:** the shoulder needs ~1:50–60 reduction off a NEMA23 (1.26 N·m); the elbow needs a long-body NEMA17 (17HS19-2004S1, 0.59 N·m) at ~1:50; the wrist joints are fine on a 17HS4401 at your existing 1:15.
- **A 3D-printed PLA+ cycloidal of your size (22 mm pin circle) realistically tops out around 13 N·m before wear/jamming** — this is the *measured* limit of a closely comparable printed 19:1 drive (HowToMechatronics: the PLA version gave ~13 N·m versus ~34 N·m for the CNC-machined twin, with disc wear and a failed threaded insert). The shoulder therefore needs a larger pin circle / thicker (or twin) discs / a tougher filament (PETG or PA-CF) or a metal-reinforced gearbox; PLA+ alone is marginal at the elbow and adequate only from the wrist out.

## Key Findings
1. The arm is feasible with steppers + printed cycloidals, but **the shoulder and elbow are the whole design problem.** Everything from the wrist pitch outward is easy.
2. **Holding torque ≠ running torque.** Size every joint on ~50% of the catalog holding torque: per MotorMicro/Keshuo's stepper-torque guide, running torque "is always lower than Holding Torque and decreases as the motor's speed increases… due to winding inductance and back electromotive force." A NEMA17 rated 0.5 N·m may deliver only ~0.2 N·m at 300 RPM and <0.1 N·m at 600 RPM (Zbotic / StepperOnline torque-speed data).
3. **Printed-cycloidal contact stress, not steel-pin strength, is the limiter.** The steel roller pins are fine; the PLA lobe-on-pin contact and the printed pin bores are where it fails. Use ≥50% infill and 6 perimeters on discs — the documented fix for a jammed printed cycloidal joint.

---

## 1. Assumptions (state-and-defend)

**Kinematic split for 70 cm reach (anthropomorphic):**
| Segment | Length | Note |
|---|---|---|
| Upper arm (J2→J3) | 0.33 m | human upper-arm proportion |
| Forearm (J3→J5) | 0.27 m | |
| Wrist (J5→end-effector) | 0.10 m | |
| **Total reach** | **0.70 m** | |

This mirrors human upper-arm:forearm proportions (roughly equal, slightly longer upper arm), consistent with anthropometric arm models (upper arm ≈ 0.186 × height, forearm ≈ 0.146 × height).

**Mass model (lumped point masses, distance measured horizontally from the shoulder axis J2):**
| Item | Mass (kg) | Dist. from J2 (m) | Basis |
|---|---|---|---|
| Upper-arm link (PLA+) | 0.20 | 0.165 | structural rear link |
| Elbow drive (J3 motor + gearbox) | 0.55 | 0.33 | NEMA17 long ~0.35 kg + printed gbox ~0.20 kg |
| Forearm link (ABS) | 0.15 | 0.465 | lighter front link |
| Wrist-pitch drive (J5 motor + gearbox) | 0.45 | 0.60 | NEMA17 0.30 kg + gbox 0.15 kg |
| Wrist roll/yaw (J4/J6) + link + EE | 0.40 | 0.65 | small motors + gripper |
| Payload | 0.50 | 0.70 | spec minimum |

- NEMA17 mass: 17HS4401 (40 mm) = 280 g; 17HS19-2004S1 (48 mm) = 390 g; NEMA23 = ~660 g (vendor datasheets).
- Printed cycloidal assembly: ~150–200 g.
- Total moving mass ≈ 2.25 kg + shoulder drive ~0.6 kg at the joint ≈ **2.85 kg arm**. This already lifts well over its own weight + 0.5 kg, so the 0.5 kg payload case and the "lift its own weight" case are both inside this envelope.

**Worst case:** arm fully extended, horizontal — maximises the gravity moment at every pitch joint. Roll/yaw axes (J1 vertical, J4/J6 coaxial with the arm) see ~zero gravity moment in this pose.

**Cycloidal efficiency:** lab/commercial single-stage cycloidals run ~85–93% (Wikipedia; Firgelli), but a budget 3D-printed unit is lower and variable — HowToMechatronics measured ~66% on an early 15:1 build ("we've got torque increase of around 10 times… That's efficiency of around 66%, considering that the reduction ratio is 15:1") and ~85% on a cleaner 19:1 build. **I use η = 0.75** for sizing — conservative for a printed drive.

**Stepper derate:** **running torque = 0.5 × holding torque** for sizing (MotorMicro/Keshuo: running torque "is always lower than Holding Torque and decreases as the motor's speed increases").

**Dynamic/safety factor:** **2.5×** on static torque. Industrial robot practice is 2–3× static (Firgelli) to cover angular acceleration (τ_dyn = Iα), joint friction, CoM-estimate error, and the fact that the worst dynamic pose isn't purely static. I pick 2.5× as a defensible middle.

---

## 2. Static torque — moment-arm summation

Method (serial manipulator, gravity load): for joint *j*,
**τ_j = g · Σ_(i distal to j) m_i · d_i**, where d_i is the horizontal distance from joint *j*'s axis to mass *i*. (g = 9.81 m/s².)

**J2 — shoulder pitch** (everything is distal):
Σ m·d = 0.20·0.165 + 0.55·0.33 + 0.15·0.465 + 0.45·0.60 + 0.40·0.65 + 0.50·0.70
= 0.033 + 0.1815 + 0.0698 + 0.270 + 0.260 + 0.350 = **1.164 kg·m**
**τ_J2 = 9.81 × 1.164 = 11.4 N·m**

**J3 — elbow pitch** (distal: forearm link, wrist-pitch drive, wrist cluster, payload; distances measured from 0.33 m):
Σ m·d = 0.15·0.135 + 0.45·0.27 + 0.40·0.32 + 0.50·0.37
= 0.0203 + 0.1215 + 0.128 + 0.185 = **0.455 kg·m**
**τ_J3 = 9.81 × 0.455 = 4.46 N·m**

**J5 — wrist pitch** (distal: wrist cluster at 0.05 m, payload at 0.10 m):
Σ m·d = 0.40·0.05 + 0.50·0.10 = 0.020 + 0.050 = **0.070 kg·m**
**τ_J5 = 9.81 × 0.070 = 0.69 N·m**

**J1 (base yaw), J4 (wrist roll), J6 (end roll):** ≈ **0 N·m gravity** in this pose. Sized by friction + inertia. Estimates: J1 must accelerate the whole arm's rotational inertia about the vertical → assign ~3 N·m output target; J4 ~1 N·m; J6 ~0.5 N·m.

**Apply 2.5× → required OUTPUT torque:**
| Joint | Static (N·m) | ×2.5 → Required output (N·m) |
|---|---|---|
| J1 base yaw | ~0 (inertia) | **~3** |
| **J2 shoulder** | 11.4 | **~29** |
| **J3 elbow** | 4.46 | **~11** |
| J4 wrist roll | ~0 | **~1** |
| **J5 wrist pitch** | 0.69 | **~1.7** |
| J6 end roll | ~0 | **~0.5** |

---

## 3. Required gear reduction per joint

**Output = T_motor,running × ratio × η** → **ratio = T_required / (T_motor,running × η)**, with η = 0.75 and T_running = 0.5 × T_holding.

Usable running torque of candidate motors:
- 17HS4401 (0.40 N·m hold) → ~0.20 N·m running
- 17HS8401 (0.52 N·m) → ~0.26 N·m
- 17HS19-2004S1 (0.59 N·m) → ~0.30 N·m
- NEMA23 (1.26 N·m) → ~0.63 N·m

| Joint | Req. out (N·m) | Motor | Ratio = Req/(T_run·0.75) | **Recommended ratio** |
|---|---|---|---|---|
| J2 shoulder | 29 | NEMA23 (0.63) | 29/0.47 = **61** | **~1:50–60** |
| J3 elbow | 11 | 17HS19 (0.30) | 11/0.225 = **49** | **~1:50** |
| J5 wrist pitch | 1.7 | 17HS4401 (0.20) | 1.7/0.15 = **11.3** | **1:15** (your existing) |
| J1 base yaw | 3 | 17HS19 (0.30) | 3/0.225 = **13.3** | **~1:20** |
| J4 wrist roll | 1 | 17HS4401 (0.20) | 1/0.15 = **6.7** | **1:15** (margin) |
| J6 end roll | 0.5 | 17HS4401 (0.20) | 0.5/0.15 = **3.3** | **1:15** (large margin) |

Note: driving the shoulder with a NEMA17 instead of a NEMA23 would need ~1:130 — impractical in one printed stage and far too slow. Hence the NEMA23 (or a two-stage reduction) at the shoulder. Your existing 1:15 (15-lobe disc, 16 ring pins) is the natural building block; the higher ratios are reached by reducing the lobe count toward a one-lobe difference or by stacking a second stage.

---

## 4. Output speed per joint

NEMA17/23 usable band is ~200–600 RPM input; torque holds best at the low end and falls off steeply with speed (a 0.5 N·m NEMA17 → ~0.2 N·m at 300 RPM, <0.1 N·m at 600 RPM at 12 V). Take **300 RPM nominal input**. Output RPM = 300 / ratio (×6 → °/s):

| Joint | Ratio | Output RPM @300 | °/s | Verdict |
|---|---|---|---|---|
| J2 | 1:50 | 6 | 36 | Slow but normal for a loaded shoulder |
| J3 | 1:50 | 6 | 36 | Fine |
| J5 | 1:15 | 20 | 120 | Snappy |
| J1 | 1:20 | 15 | 90 | Good |
| J4 | 1:15 | 20 | 120 | Good |
| J6 | 1:15 | 20 | 120 | Good |

36°/s at the shoulder is acceptable for a manipulator; push the motor toward 500 RPM for ~60°/s if your driver/voltage keep torque up. Above 600 RPM at 12 V a NEMA17 loses most of its torque, so **run 24 V+ drivers** (TMC/DM542-class).

---

## 5. Gearbox stress — can printed PLA+/ABS take it?

**Tangential pin force:** **F ≈ T_out / (N_eff × R_pc)**, R_pc = 22 mm = 0.022 m. Ideal cycloidal load-sharing engages ~50% of the pins (≈8 of your 16); print clearance reduces effective contacts, and the most-loaded pin sees roughly 2× the average. So I bracket N_eff = 8 (optimistic average) down to ~4 (peak/clearance).

- **Shoulder, 29 N·m:** F_avg = 29/(8·0.022) = **165 N**; peak/few-pin ≈ **330–440 N**.
- **Elbow, 11 N·m:** F_avg = 11/(8·0.022) = **62 N**; peak ≈ **125–250 N**.
- **Wrist pitch, 1.7 N·m:** F_avg = **10 N**; peak ≈ **20–40 N**.

The **2.97 mm steel roller pins are not the problem** — steel handles these loads with huge margin. The problem is the **PLA lobe contact and the printed pin bores.**

**Hertzian line-contact estimate** (steel pin radius 1.485 mm on a near-flat PLA lobe, disc thickness ~10 mm, E* ≈ 4 GPa dominated by PLA):
- Shoulder peak (330 N): p_max ≈ **~170 MPa** — **exceeds PLA's compressive/bearing limit.**
- Elbow peak (125 N): p_max ≈ **~100 MPa** — **marginal/over.**
- Wrist (≤40 N): p_max ≈ **~50 MPa** — **OK.**

These are order-of-magnitude (sensitive to disc thickness and lobe radius), but the conclusion is robust and matches the empirical record:
- **HowToMechatronics' printed-vs-CNC test:** identical 19:1 drives — both gave ~450 N·cm (4.5 N·m) on a NEMA17 at ~85% efficiency, but pushed with a NEMA23 the **CNC version reached ~34 N·m while the PLA version managed only ~13 N·m** ("That's a torque of just around 13Nm, which is actually significantly less compared to the 34Nm torque I got from the CNC machined version… Even the threaded insert failed under these loads").
- A **jammed printed cycloidal joint** was traced to disc damage at the pins printed at **20% infill / 2 perimeters**; the fix was **50% infill / 6 perimeters** (Hackaday "active compliance" joint — discs there were actually PETG Pro, but the failure-and-fix lesson holds for PLA+).
- A peer-reviewed pin-bearing study — **Khosravani, Sadeghian, Ayatollahi & Reinicke, "On the Pin-Bearing Strength of Additively Manufactured Polymer Parts," *Polymers* 2023, 15(7):1660 (DOI 10.3390/polym15071660)** — found **ABS out-bears PLA in every width/edge ratio**, with the highest ultimate bearing strength **189 ± 5 MPa** (ABS, smallest hole, 100% infill). Load is carried mainly along the rasters; the inter-layer (Z) bonds carry little, so **print discs flat with the load in-plane.** (Note: those are 100%-infill upper bounds — hobby infills of 20–50% will be well below this.)
- For context on the high-torque ceiling of a *bigger* printed actuator: Caden Kraft's 3D-printed quasi-direct-drive actuator with a printed cycloidal-planetary gearbox reached **29.4 N·m holding torque**, but it used a larger gearbox, an ironless BLDC, and explicitly warns **"USE ENGINEERING PLASTICS (PA6-GF, PA6-CF, PET-CF…); using PLA is tempting but [it] will… creep."**

**Material reality:** the official eSUN PLA+ technical data sheet (GB/T 1040) gives **X-Y tensile strength 53.34 MPa vs Z-direction 31.2 MPa** — a ~1.7× anisotropy driven by weak layer adhesion. (The often-quoted ~63 MPa figure is eSUN's PLA *Basic*, not PLA+.) eSUN ABS+ is ~40 MPa tensile, but its much higher impact toughness and superior pin-bearing strength make it the better disc material under shock/contact loading. **FDM layer adhesion is the weak link; orient discs so contact loads run along layers, not across them.**

**Verdicts:**
- **Wrist (J5/J4/J6):** PLA+ at 1:15, 22 mm pin circle is **fine.**
- **Elbow (J3, ~11 N·m):** **right at the printed-PLA ceiling** (≈13 N·m measured). Use ≥50% infill, 6+ perimeters, a thicker (or twin 180°-offset) disc, and ideally **PETG or PA-CF** discs, or enlarge the pin circle to ~30–35 mm to drop contact stress.
- **Shoulder (J2, ~29 N·m):** **beyond a single printed-PLA cycloidal of this size.** Options, best first: (a) larger gearbox — bigger pin circle (≥35–40 mm), thicker/twin discs, more/larger steel pins; (b) tougher filament (PA-CF / PETG-CF, with steel pins and a steel ring/pin housing — "metal-reinforced"); (c) two-stage reduction to cut per-stage load; (d) accept a slower, lower-payload shoulder. A pure 22 mm PLA+ shoulder drive will wear and back-drive/jam under sustained load.

---

## 6. Consolidated recommendation table

| Joint | Req. output torque | Cycloidal ratio | Motor (model) | Motor holding torque | Output speed @300 RPM | Stress / feasibility |
|---|---|---|---|---|---|---|
| **J1 base yaw** | ~3 N·m | 1:20 | 17HS19-2004S1 (NEMA17 48 mm) | 0.59 N·m / 84 oz·in | 15 RPM (90°/s) | PLA+ OK; vertical axis, low contact stress |
| **J2 shoulder** | ~29 N·m | 1:50–60 | **NEMA23 1.26 N·m** (or 2-stage NEMA17) | 1.26 N·m / 178 oz·in | 5–6 RPM (30–36°/s) | **PLA+ inadequate** — enlarge gearbox / PA-CF / metal-reinforce |
| **J3 elbow** | ~11 N·m | 1:50 | 17HS19-2004S1 | 0.59 N·m / 84 oz·in | 6 RPM (36°/s) | **Marginal** — 50% infill, twin disc, PETG/PA-CF or bigger pin circle |
| **J4 wrist roll** | ~1 N·m | 1:15 | 17HS4401 | 0.40 N·m / 57 oz·in | 20 RPM (120°/s) | PLA+ OK |
| **J5 wrist pitch** | ~1.7 N·m | 1:15 | 17HS4401 | 0.40 N·m / 57 oz·in | 20 RPM (120°/s) | PLA+ OK (your existing design) |
| **J6 end roll** | ~0.5 N·m | 1:15 | 17HS4401 (or pancake) | 0.40 N·m / 57 oz·in | 20 RPM (120°/s) | PLA+ OK, large margin |

---

## 7. Practical buying guidance (with marketplace conversions)

Conversions: **1 N·m = 141.6 oz·in = 10,197 g·cm.**

| Model | Body | Holding torque | oz·in | g·cm | Best for |
|---|---|---|---|---|---|
| 17HS4401 | NEMA17 40 mm, 1.7 A, 280 g | 0.40–0.43 N·m | ~57 | ~4,000–4,300 | J4, J5, J6 (wrist) |
| 17HS8401 | NEMA17 48 mm, 1.8 A, ~380 g | 0.52 N·m | ~74 | ~5,300 | alt. for J1/J3 |
| 17HS19-2004S1 | NEMA17 48 mm, 2.0 A, 390 g | 0.59 N·m | ~84 | ~6,000 | J1, J3 (best NEMA17) |
| NEMA23 (12,600 g·cm listing) | 57×56 mm, 2.8 A, ~660 g | 1.26 N·m | ~178 | ~12,600 | **J2 shoulder** |
| 42HS048DF600F-01 | NEMA17 | 0.35 N·m | ~50 | ~3,570 | wrist (lower-torque option) |

**Buying rules of thumb:**
1. **Match by running, not holding, torque** — the marketplace lists holding torque; halve it for your sizing. A "0.4 N·m" 17HS4401 is really ~0.2 N·m at speed.
2. **Prefer 48 mm-body NEMA17 (17HS19-2004S1, 2 A) over 40 mm** for J1/J3 — same footprint, ~50% more torque, only ~110 g heavier.
3. **NEMA23 only at the shoulder.** Its 1.26 N·m holding (≈0.63 N·m running) × 1:50 × 0.75 ≈ 24 N·m output — close to the 29 N·m target; raise to 1:60, or use a less-conservative 0.6× running derate (good 24 V driver) to clear it. The extra ~660 g of shoulder mass sits at the joint, so it adds little gravity moment.
4. **Drive everything at 24 V+** with current-chopping drivers (DM542T / TMC2209-class) to keep torque up across 200–600 RPM; 12 V will cost you ~70% of torque by 400 RPM.
5. **0.9°/step variants** improve wrist resolution if you need fine end-effector positioning, at some torque cost.

---

## Recommendations (staged)
1. **Build & validate the wrist cluster first (J4/J5/J6) on 17HS4401 + 1:15 PLA+.** This is proven by your prior build; confirm ~1.7 N·m output and smooth motion. *Threshold to proceed:* the joint holds 0.5 kg at full wrist extension without back-driving.
2. **Prototype the elbow (J3) as a 17HS19-2004S1 at 1:50, but reprint the disc at ≥50% infill / 6 perimeters and test to ~11 N·m.** *If it wears or loses motion within a few hundred cycles* → switch discs to PETG/PA-CF or enlarge the pin circle to 30–35 mm (or go twin-disc).
3. **Treat the shoulder (J2) as a mini-project.** Start with a NEMA23 at 1:50–60 and a **scaled-up gearbox** (pin circle ≥35 mm, twin 180°-offset discs, ≥6 steel pins, PA-CF or a metal ring). *If sustained holding torque > ~13 N·m causes disc wear/jamming* (the empirically demonstrated printed-PLA ceiling), move to a two-stage reduction or a metal-reinforced/CNC ring and disc.
4. **Instrument early:** measure actual output torque with a lever + luggage scale (the HowToMechatronics method) at each joint before trusting the calc — printed-drive efficiency and load-sharing vary widely.
5. **Benchmarks that change the plan:** if measured printed-cycloidal efficiency is ≥85% (not 75%), shoulder ratio can drop to ~1:50; if the running derate is only to 0.65 (good 24 V driver), the elbow can use a 17HS8401. If your real arm mass comes in under ~2.3 kg, recompute — shoulder torque scales nearly linearly with distal mass.

## Caveats
- **All masses and CoM positions are estimates.** The shoulder torque scales directly with them; a 20% mass error is a 20% torque error. Re-run §2 with weighed parts once printed.
- **The 2.5× factor bundles dynamics + friction + margin.** If you want guaranteed fast acceleration, compute τ_dyn = Iα explicitly and add it rather than relying on the blanket factor.
- **Hertzian stress numbers in §5 are order-of-magnitude** (sensitive to disc thickness, lobe-tip radius, real contact count). They flag *trend and feasibility*, not a certified stress. Validate by test.
- **Printed-cycloidal load sharing is optimistic in theory (50% of pins) but worse in practice** due to print clearance; the most-loaded pin governs failure.
- **Backlash / lost motion** on printed cycloidals is significant (the printed 19:1 unit showed ~7 mm play at 15 cm vs ~4 mm for the CNC twin) — fine for slow positioning, poor for high-bandwidth control.
- **NEMA23 at the shoulder changes your BOM** (higher driver current, 6.35 mm shaft, heavier). Confirm your printed motor mount and bearings suit it.
- **Material-property sources vary** by test standard and print orientation; treat single-figure tensile/bearing numbers as indicative, and remember the published bearing strengths (e.g. 189 MPa ABS) are at 100% infill — your hobby infills will be lower.