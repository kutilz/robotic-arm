# Motor & Actuator Selection for the Wrist (J4/J5/J6) and Gripper of a 6‑DOF 3D‑Printed Arm

## TL;DR
- **J4 (wrist roll):** The 17PM‑K054 is the **technically cleaner distal choice**: it is a genuine **1.8° hybrid** stepper (not a coarse PM stepper, correcting the project's stated worry), so it loses nothing in resolution or smoothness, weighs less, and after 15:1 still delivers ~1.5 N·m against a 1 N·m target. The honest tie‑breaker is logistics: if shared spares/firmware/clone‑risk management matter more than ~60 g of distal mass, standardize on the **17HS4401** you already run in J1/J3. **The DC gearmotor is the clear loser and should be rejected** for a position‑feedback thesis.
- **J5 & J6 (MG996R):** **Lock in MG996R for J6 (0.3 N·m roll) without reservation, and provisionally for J5 (0.65 N·m pitch) with a defined go/no‑go test.** At your ≤130k IDR cap, MG996R is genuinely the rational pick; nothing meaningfully better exists under budget (the better DS3218 is 2–5× over). J5 runs MG996R at ~60–70 % of stall *continuously*, which is the real risk (heat, gear wear, jitter); keep your in‑stock 17HS4401 + 15:1 cycloidal as a tested fallback.
- **Rotation range & gripper:** J5 = **positional** (bounded pitch); J6 = **positional is sufficient** for 0.2 kg pick‑and‑place; go continuous only if you truly need >120° roll and will close the loop on the AS5600 (and handle its single‑turn wrap); **gripper = positional, ~90°, and a smaller MG90S is the better, lighter choice** than another MG996R. A continuous‑rotation servo on a gripper is simply wrong.

## Key Findings
1. **The single most important verification: the 17PM‑K054 is NOT a coarse permanent‑magnet stepper.** Despite the "PM" in Minebea's family name, the **entire 17PM‑K series is a 1.8°/200‑step‑per‑rev two‑phase HYBRID** stepper. This is confirmed on the MinebeaMitsumi datasheet "17PM‑K(42□ 1.8°)" (rev. 2024/02/28), where every winding row lists "Step Angle 1.800°," filed under "Rotary Components > Stepping motors > **Hybrid** stepping motors," and corroborated by NMB/Mouser/Newark distributor pages. The premise that this might be a 7.5°/48‑step PM motor is **false**, which moves the J4 analysis in the motor's favour.
2. **Verified 17PM‑K054 specs (it belongs to the 34 mm K0xx bipolar family, winding code 17PM‑K053B):** Rated Current **1.20 A**, Resistance 2.20 Ω, Holding Torque **270 mN·m (0.27 N·m), confirmed**, Inductance 4.6 mH, Rotor Inertia 37.0 g·cm², Detent Torque 11.0 mN·m, **Mass 200 g (not 226 g)**, 2‑phase bipolar. Rated voltage is not printed by Minebea; V = I×R ≈ 2.6 V (computed).
3. **Verified 17HS4401 specs:** 1.8° hybrid, 200 steps/rev; **holding torque 0.42 N·m (≈42 N·cm)** per BesFoc datasheet (model BF42HS40‑1704‑13A: "1.7A, 1.5Ω 2.3mH and with holding torque 0.42Nm") and Cytron ("40 N·cm, 56 oz·in"); 1.5–1.7 A; ~280 g; rotor inertia ~54–57 g·cm².
4. **Both steppers clear the J4 torque target with margin** after 15:1 cycloidal at η=0.75 using running torque ≈ 0.5×holding: 17PM‑K054 ≈ 0.135×15×0.75 ≈ **1.52 N·m**; 17HS4401 ≈ 0.21×15×0.75 ≈ **2.4 N·m**. Target is 1 N·m. The 17HS4401's extra torque is real but **unused headroom** on a zero‑gravity roll axis.
5. **MG996R verified (TowerPro datasheet, verbatim):** "Weight: 55 g… Stall torque: 9.4 kgfcm (4.8 V) [≈0.92 N·m], 11 kgfcm (6 V) [≈1.08 N·m]… Stall Current 2.5 A (6V)… This high‑torque standard servo can rotate **approximately 120 degrees (60 in each direction)**." The "180°"/"360°" labels on resellers are clone/variant framing, not the standard positional spec. Running current 500–900 mA; metal gears; dual ball bearing.
6. **J5 at 0.65 N·m runs MG996R at ~60 % of 6 V stall (≈70 % of 4.8 V stall) continuously**, exactly the sustained high‑fraction‑of‑stall holding regime that vendor and community sources flag for **heat buildup, accelerated gear wear, and winding burnout**.
7. **MG996R jitter is real and well‑documented**, caused by the analog control IC + cheap potentiometer feedback + power‑supply sag/brownout (it draws up to 2.5 A at stall). Standard fixes: dedicated 5–6 V/≥3 A supply, a 470–1000 µF electrolytic across servo power near the connector, common ground, short signal leads, avoid commanding the mechanical end‑stops.
8. **TowerPro itself warns of widespread counterfeits** (verbatim): "There are many counterfeit servos of TowerPro… If the suppliers removed 'TowerPro' logo from the photos and the products description, they are selling counterfeits low quality servo." Clones show shaft wobble (bushing instead of dual ball bearing), lower real torque, plastic gears mislabeled as metal, poor repeatability, and early failure.
9. **AS5600 is 12‑bit single‑turn absolute**: "resolution of 12 bit = 4096 positions per revolution," default range 0–360°, which **wraps**. 360°/4096 = **0.0879°/LSB**. Multi‑turn requires software revolution counting, relevant if J6 goes continuous.
10. **Indonesian pricing (2025–26, excl. shipping):** MG996R ~Rp33k–48k; MG995 ~Rp37k–55k; MG90S ~Rp21k–35k; **17HS4401 base 1.8° ~Rp93k–98k**, all **under 130k**. **DS3218 20 kg/270° ~Rp235k–600k, over budget.**

## Details

### DECISION 1: J4 (wrist roll) motor

**The coarse‑step worry is moot.** The AS5600 resolves 0.0879°/LSB at the output. Even ignoring the encoder, the 17PM‑K054 is a 1.8° hybrid, so after 15:1 one full step is **1.8°/15 = 0.12°** at the output (3000 full steps/rev at the output; far finer with any microstepping). There is no "0.5°/step" penalty; that only applies to a 7.5° PM motor, which this is not. Consequently both candidate steppers are identical in step angle (1.8°), drive electronics (standard bipolar chopper driver: A4988/DRV8825/TMC), firmware steps‑per‑degree constant, and microstepping behaviour. Hybrid steppers are also smoother and lower‑resonance than PM steppers; that distinction simply never arises here. **Action item for your write‑up: correct the "PM/coarse‑step" assumption explicitly; it is the kind of premise an examiner will probe.**

**Torque:** both exceed the 1 N·m target comfortably (≈1.52 vs ≈2.4 N·m). Because J4 is a roll axis with ≈0 gravity arm, the sizing driver is inertia + cycloidal friction, not gravity torque, so the 17HS4401's extra torque buys nothing functional here.

**The true tradeoff is ~60 g + ~0.5 A vs standardization.** This arm follows the PAROL6 principle, documented by its designer Petar Crnjak (verbatim): *"The design was so that motors are not on the axes that they are actuating. By doing that you remove mass to the bottom of the robot and reduce the inertia of the joints."* (PAROL6: 400 mm reach, 6 axes, 5.5 kg, 1 kg payload, 0.08 mm repeatability.) The J4 motor sits near the elbow; ~60 g there adds to J2/J3 shoulder/elbow torque and to the inertia J2/J3 must accelerate. On pure design philosophy, **the lighter 17PM‑K054 (200 g vs ~280 g) is the more defensible distal choice**: it meets torque with margin, is a true hybrid (no resolution/smoothness loss), and saves distal mass.

Against that is a real virtue you already identified: **standardization**. J1 and J3 already use 17HS4401. One motor type means one spares pool, one driver tuning, one steps/rev constant, and one failure mode to characterize, which materially de‑risks a time‑boxed thesis build, and is easier to authenticate/replace given marketplace clone uncertainty.

**Verdict (J4):** This is a genuine judgement call; frame it as one.
- *If the thesis narrative is mass‑to‑base / minimal distal inertia, and you can source a genuine 17PM‑K054 → choose it.* It is the cleaner distal engineering answer.
- *If build‑risk, spares, and firmware simplicity dominate (a very reasonable thesis‑pragmatic stance) → standardize on 17HS4401* and document the +~60 g distal‑mass penalty as an accepted tradeoff.
Both are defensible; what is **not** defensible is the original fear that the 17PM‑K is a coarse PM motor.

**The DC gearmotor (RS‑310/ZGA25R 1:217, ~38 rpm, ~5 kgf·cm): reject it.** For a thesis whose premise is output‑side position feedback, a brushed DC gearmotor is the wrong tool:
- **No inherent position feedback**: you must build a full PID + PWM H‑bridge loop on the AS5600. That is strictly more control complexity than a stepper, which positions open‑loop and uses the encoder only for correction.
- **Backlash:** cheap ZGA25R‑class metal gearboxes have meaningful, unspecified backlash; with the output‑side AS5600 you can *measure* position, but the loop must hunt across the lash deadband on every reversal, poor for a wrist that reverses often.
- **Datasheet unreliability:** these list optimistic *stall* figures; rated/continuous torque is much lower and often unstated, matching your note that "datasheets are usually incomplete." "5 kgf·cm" is typically a stall number you cannot use continuously.
- **No static holding:** unlike a stepper (detent + holding torque), a DC gearmotor holds position only via active power/braking, worse for a joint expected to hold.
- **Speed:** 38 rpm output is adequate for wrist roll, so speed is not the disqualifier; the control architecture is.

Steppers are clearly superior for J4.

### DECISION 2: J5 & J6 on MG996R

**J6 (end roll, 0.3 N·m, zero gravity arm): clearly fine on MG996R.** 0.3 N·m ≈ 3 kgf·cm is under one‑third of even the 4.8 V stall (9.4 kgf·cm); it is a roll axis with negligible holding load. This is exactly MG996R's comfort zone. Lock it in.

**J5 (wrist pitch, 0.65 N·m, fights gravity): acceptable but marginal, adopt with a go/no‑go test.** 0.65 N·m ≈ 6.6 kgf·cm. Against 11 kgf·cm (6 V) that is ~60 % of stall; against 9.4 kgf·cm (4.8 V) it is ~70 %. Three concrete risks:
- **(i) Jitter:** MG996R is analog with a cheap pot; it hunts around setpoint, worse under load and with sagging supply. Mitigations: dedicated 5–6 V supply rated ≥3 A, 470–1000 µF electrolytic across servo power at the connector, common ground, short/shielded signal lead, avoid commanding the mechanical end‑stops; and, because you have an **output AS5600**, run an outer software position loop with a small deadband to suppress residual dither.
- **(ii) Thermal / sustained hold ("motor ditahan"):** holding a pitched wrist at ~60 % of stall continuously is the documented failure regime: heat buildup, gear wear, and (on clones) stripped gears or burned windings. The community/vendor consensus is explicit that the MG996R "is not designed for" prolonged static holding under load. Mitigate by mechanically minimizing the held torque: keep payload/wrist mass low, and where possible bias the pitch geometry so gravity isn't fought at full lever arm continuously.
- **(iii) Clones:** TowerPro warns of rampant counterfeits; clones underperform on torque, bearings, gear material, and lifespan. A clone worsens the J5 margin and pushes you to the fallback sooner.

**Alternatives under 130k IDR:** MG995 (older, less accurate, no improvement); MG90S (too small for 0.65 N·m); various JX/other hobby digitals (variable quality). The genuinely better servo, **DS3218 (20 kg, 270°, digital)**, exists but is **~Rp235k–600k, well over your 130k cap.** So within budget **MG996R really is the rational J5 pick**; you are not overlooking a better option.

**Go/no‑go: abandon MG996R for J5 and switch to the in‑stock 17HS4401 + 15:1 cycloidal (≈2.4–2.5 N·m output) if any of these occur in test:**
- Servo case temperature exceeds ~50 °C (uncomfortable to touch) within a normal duty cycle, or keeps climbing during a typical program;
- Stall/buzzing or failure to hold position during dynamic horizontal‑load pitch moves at 0.2 kg payload;
- Any gear strip, growing backlash, or audible grinding;
- Jitter that the AS5600 outer loop + clean power cannot bring within your repeatability spec.
The stepper fallback removes all four risks (true holding torque, no pot jitter, abundant torque) at the cost of mass and a cycloidal stage, which is exactly why keeping it tested‑and‑ready is the correct hedge.

### DECISION 3: Rotation range per joint, and the gripper

**J5 (pitch): positional, bounded.** A pitch joint needs a bounded sweep (≈±90°). MG996R's ~120° total travel gives roughly **±60° about center**. **If you need more than ±60° of pitch, MG996R's native travel is insufficient** and you must either (a) extend pulse width modestly (stay within 1000–2000 µs for safety; pushing toward 500–2500 µs risks gears and is clone‑dependent), or (b) add a small mechanical lever/gear ratio, at the cost of torque. Confirm your required pitch envelope; if ±60° suffices, MG996R positional is correct as‑is.

**J6 (roll): positional is sufficient for 0.2 kg pick‑and‑place; go continuous only deliberately.** A standard positional MG996R gives ~120° roll, usually enough for typical orientation tasks. A **continuous‑rotation servo gives unlimited roll but loses the internal pot loop (it becomes speed‑controlled)**, you can no longer command an absolute angle from the servo itself. You *do* have an AS5600 at J6 output, so you *can* close an absolute‑position loop in software around a continuous servo. **But** the AS5600 is **single‑turn**: past 360° it wraps, so multi‑turn roll requires software revolution counting, and your closed‑form IK / wrist‑concurrency assumes a defined J6 range. **Recommendation: keep J6 positional unless the application genuinely needs >120° roll.** The added control complexity and wrap handling are not justified at 0.2 kg for ordinary tasks.

**Gripper: positional, ~90°, NOT continuous, and a smaller servo is better.** A jaw mechanism (linkage / rack‑and‑pinion / scissor) needs bounded travel with position control to set grip width, plus good stall/holding to clamp. A continuous‑rotation servo is wrong here (no grip‑width control, awkward force control). ~90° of servo travel is plenty for a typical jaw throw. At 0.2 kg payload an **MG90S metal‑gear micro servo (~2.2 kgf·cm, ~13–14 g)** is the better choice than another 55 g MG996R: it saves distal mass (again the PAROL6 principle) and provides ample clamping for light objects; reserve MG996R for the gripper only if your jaw geometry or grip force genuinely demands it. Grip force = servo torque ÷ linkage lever arm; design the linkage so commanded grip stays well below stall to avoid the same overheating problem.

### Design‑judgment aside: payload and reach
- **Reducing wrist/distal mass from 200 g toward 150 g or 100 g directly relaxes J5.** J5 torque is dominated by gravity × lever arm of (J6 + EE + payload). Cutting that mass is the single most effective way to pull MG996R from ~60–70 % of stall down to a comfortable ~40–50 %, improving thermal margin, reducing jitter under load, and extending life. If MG996R stays on J5, **trimming the wrist‑mass budget is the highest‑leverage design move: target ≤150 g.**
- **Shortening reach toward 400 mm (PAROL6‑like) reduces lever arms throughout**, lowering J2/J3 demand and making the distal‑mass penalty of either J4 stepper less significant, which in turn makes the *standardization* choice (17HS4401 everywhere) cheaper in design terms.
- Keeping 200 g payload and 600 mm reach is fine *if* you accept the J5 risk and keep the stepper fallback ready. If you want MG996R to be comfortably (not marginally) adequate on J5, **reduce distal mass first, reach second.**

## Recommendations
**Stage 1: Lock the certain choices now.**
- J6 roll → **MG996R, positional (~120°).** No reservations.
- Gripper → **MG90S, positional ~90°**, linkage designed so commanded grip force stays below stall. No continuous rotation.
- Reject the DC gearmotor for J4.

**Stage 2: Decide J4 on your real priority.**
- Thesis narrative = mass‑to‑base / minimal distal inertia → **17PM‑K054** (a 1.8° hybrid, 0.27 N·m, ~200 g, ~1.2 A; correct the "PM/coarse‑step" misconception in your write‑up).
- Priority = build‑risk / spares / firmware simplicity → **standardize on 17HS4401** and document the +~60 g distal penalty as accepted. Both pass the 1 N·m target with margin.

**Stage 3: Adopt MG996R for J5 provisionally and test against thresholds.**
- Power from a dedicated 5–6 V ≥3 A rail; 470–1000 µF cap at the connector; common ground; AS5600 outer loop with small deadband.
- Run a duty‑cycle‑representative pitch‑under‑load test at 0.2 kg.
- **Switch to the in‑stock 17HS4401 + 15:1 cycloidal** if any go/no‑go threshold trips (case >~50 °C or climbing; stall or failure to hold horizontal pitch; any gear strip / backlash growth; uncontrollable jitter).

**Stage 4: Buy genuine, then verify.**
- Buy MG996R from sellers showing the TowerPro logo; on receipt check ~55 g weight, dual ball bearing (no shaft wobble), all‑metal gear train, clean centering. Treat a clone as automatically pushing J5 toward the stepper fallback.

**Benchmarks that change the plan:** trimming wrist mass to ≤150 g (or reach to ~400 mm) moves J5's MG996R margin from marginal to comfortable, allowing the stepper fallback to be retired. If a genuine digital metal‑gear servo ≥10 kgf·cm with ≥180° travel appears under 130k IDR, re‑evaluate J5 (none found at this writing; DS3218 is ~2–5× over budget).

## Caveats
- **Exact "‑054" suffix:** MinebeaMitsumi's official table lists the 34 mm K0xx bipolar family by winding code, and the values quoted are from row **17PM‑K053B** (1.20 A, 2.20 Ω, 270 mN·m, 37 g·cm², 200 g). The electrical core (1.8° hybrid, 0.27 N·m, ~200 g) is solid; **1.2 A matches the K053B winding but cannot be 100 % certified against a literal "054" code, and the project's "226 g" appears wrong; the datasheet says 200 g.** Confirm the unit's label on arrival; the trailing "‑04VS/‑G7WS" codes denote shaft/lead/connector/gear options, not a different electrical motor.
- **Rated voltage** for the 17PM‑K is computed (V = I×R ≈ 2.6 V), not printed by Minebea, who spec current + resistance for chopper drive.
- **MG996R behaviour is unit‑variable**, especially across clones; torque, jitter, and lifespan figures from community sources are indicative, not guaranteed; bench‑test your actual units.
- **Indonesian prices** are live marketplace listings (through mid‑2026), exclude shipping, and fluctuate by seller and sub‑model.
- Torque estimates use running torque ≈ 0.5×holding and cycloidal η = 0.75, reasonable engineering rules of thumb, not measured values; validate on the built joint.