# Spawnwright — encounter spawn design workbench

A 3D level workbench for choosing **networked spawn pairings**. It samples
candidate positions inside real spawn zones, then selects combinations using
route cost to objective zones, mutual visibility, and initial activity
clearance. The author can switch between a **fair opening** and an
**asymmetric chase**, flip one-way doors, and inspect the geometry and
navigation queries behind every score.

The point is not to sprinkle dots on an overhead map. Walls, floors and
one-way passages change the real approach relation, so every evaluation comes
from a geometry query or a navigation result that you can re-run and check.

## Start the window (the graphical entry point)

The spawn design is **done in the window**; the command line is auxiliary
(automated checks, bundle, headless tests). To open the workbench:

```bash
npm install
npm run dev           # Vite dev server, prints a URL (default http://localhost:5173)
```

Open the printed URL. This is the primary entry point for spawn design: sample
candidates, edit spawn zones, flip doors, run a design, and play the encounter,
all from the same three-pane editor:

- **Left rail** — scene picker, mode switch, spawn conditions (hard limits) and
  soft weights (ranking only), the **spawn-zone editor** (numeric min/max X/Z per
  zone, applied live), and door flip controls.
- **Centre stage** — the 3D level. Spawn zones (drawn as translucent regions),
  objective, walls, crates, railings, one-way doors (with direction arrows),
  elevation ramps/stairs, candidates, rejected markers, pair sightlines, both
  routes, and the encounter overlay for the selected pair.
- **Right rail** — an **outcome banner** that names why a run failed, run
  status, actionable suggestions, candidate pairs (click to select), the actual
  **encounter panel** (candidate region vs. recorded encounter), the selected
  pair's score components, both directional exposures, raw evidence, rejected
  pairs/positions, the flip counterfactual, and a scene log.

Auxiliary commands:

```bash
npm test              # headless kernel tests (node --test)
npm run check         # contract + consistency + fixture checks (no browser)
npm run verify        # drives the real UI with Playwright, writes reports/
npm run build         # production bundle
npm run preview       # serve the production bundle
```

`npm run check` runs in a clean checkout with no hand-edited fixtures: it reads
the records the kernel actually generates and independently recomputes the
metrics. `npm run verify` needs the Playwright Chromium browser. On a machine
without the system libraries it needs, install them with
`npx playwright install-deps chromium` (requires root) or provide the missing
`.so` files on `LD_LIBRARY_PATH`; the command itself starts the browser, loads
the window, and checks it end to end.


## How to use it

1. Pick a scene: **Symmetric Arena**, **One-Way Gate**, or **Elevation Split**.
2. Choose **Fair opening** or **Asymmetric chase**.
3. Adjust spawn conditions. Hard limits (clearance, separation, fair cost delta,
   one-way rejection, lead window, pursuer sight minimum) are separated from
   soft weights (approach parity, mutual concealment, clearance, route cover,
   approach separation) and the separation between the two is spelled out under
   the weights in the left rail.
4. Optionally **edit a spawn zone** directly in the *Spawn zones* panel. Changing
   a min/max edge bumps the revision, revokes stale evidence, and re-runs the
   design on the live geometry, so the stage and the result rail stay in sync.
5. Press **Run design**. Candidates appear in the level; the result rail lists
   accepted pairs, rejected pairs and positions, and the exact queries behind
   every score. The **outcome banner** states whether the run succeeded, found no
   candidate positions, or reached a constraint conflict.
6. Select a pair, then **Play** or **Step** the replay to dispatch both
   characters along their real routes. Arrival times come from the same edge
   costs the planner used. The **encounter panel** contrasts the sampled
   candidate region with the recorded encounter (first mutual sight, both
   arrival times, both directional exposures).
7. Flip a one-way door under *Geometry edits* and re-run. The revision bumps,
   old results are revoked, and the flip counterfactual shows which side
   inherits the lead and whether the pair is still legal.

Press `?` or **How to start** for the same guidance in-app.

### Reading the outcome banner

A failed run is not one condition; the banner distinguishes the two fixes:

- **no candidate positions** — a spawn zone produced no geometrically valid
  positions, so pairing never started. The fix is geometry: enlarge the zone,
  clear obstacles, or lower the minimum clearance.
- **no pair satisfies the hard limits** — candidates exist in every zone, but
  every pair violates a limit or mode rule. The fix is the limits or the mode:
  read the named rejection codes and adjust the matching condition.

The banner text, the suggestions list, and the rejection codes all come from the
same plan record that the checks read, so the window and the tests agree.

### Re-scoring rejected spawn points after a weight change

Changing a soft weight does **not** rescue a rejected pair — the hard limits are
unchanged. The kernel exposes a re-scoring pass over the recorded rejections so
the author can see exactly what a weight change would have done to each rejected
spawn point's *preference* without implying it becomes legal. Rejected records
keep their metric snapshot and can be re-ranked with new weights; the acceptance
set never moves.


## Fair mode vs chase mode

**Fair opening** runs each side once. It rejects a pair when:

- either side cannot reach the primary objective;
- the pair is outside the separation window;
- either route cost differs by more than both the absolute cost delta and the
  relative delta (hard limits);
- a **door-neutral control** shows one side gains from a one-way door's
  orientation that the other cannot match. The control rebuilds the nav graph
  with the door temporarily two-way and compares each side's cost change, so a
  shared shortcut is *not* penalised. A direct head-on sightline can also be
  rejected if that option is enabled.

**Asymmetric chase** turns the route-cost gap into a lead time and accepts a
pair only when that lead falls inside the configured window
`leadSeconds ± tolerance`. It also checks that the pursuer can actually find the
prey for a configurable fraction of its route. Chase results still carry the
fair-mode reading, because a high total score is not proof that every gameplay
mode is fair.

## Evidence model

Each candidate keeps separate standing records per source, defined once in
`src/core/metrics.js`:

- `geometry:clearance` — 16-ray radial clearance plus headroom.
- `nav:path-cost` — route cost to each objective (seconds), with length, ascent,
  connectors and door crossings.
- `geometry:sightline` — 3D line of sight from the spawn to each objective.
- `geometry:route-exposure` — **directional**: the fraction of A's route that has
  eye-line to B's spawn (`A route seen from B`) and the fraction of B's route
  visible from A's spawn, recorded as two separate records. The pursuer is the
  slower side, and it is the pursuer's view of the prey's route that counts.
- `nav:door-neutral-control` — one-way advantage as the difference between
  authored and neutral-door route costs.

When the spawn-level sightline and the route-exposure sampling disagree (for
example, the spawns cannot see each other but most of a route can), both
records are retained and the pair is flagged `sight-vs-route` rather than
averaged away.

Results carry the scene hash and revision they were measured against. Editing
geometry bumps the revision; stale candidates are revoked and listed in the
scene log, and their evidence history is kept keyed by scene hash.

## Weight applicability

Every weight block declares where it applies (`src/core/metrics.js`
`WEIGHT_APPLICABILITY`), and the window shows the same statement under the
weights:

- Weights **only reorder pairs that already passed every hard limit**. Changing
  a weight cannot admit a rejected pair, reject an admitted pair, or prove that
  any gameplay mode is fair. The checks enforce this by re-planning with every
  weight perturbed and comparing the accepted set and rejection codes.
- Fair mode ranks on approach parity, mutual concealment, clearance, route
  exposure, and spatial spread. Chase mode ranks on the lead window,
  concealment, clearance, route exposure, and spatial spread. A weight outside
  its mode's list still does nothing.


## The soft score is not a fairness proof

The composite score is a **ranking preference only**, never an acceptance gate
and never a fairness proof. It is shown with its components, weights and
human-readable rationale, and labelled as such. The replay is evidence too: it
dispatches both characters and reports arrival times and verdicts, but a single
tie does not prove balance. Use the per-input, per-route evidence to argue the
case.

## Contract and checks

`src/core/contract.js` is the spawn-evaluation contract. Given a scene and a
plan it **independently recomputes** every claim the plan makes and reports a
pass/fail per check:

- scene hash/revision identity, and that `ok`/`outcome` match the result count;
- each accepted candidate's clearance, reachability and cost;
- each rejected position's justification;
- each accepted pair's separation, cost delta, sightline, both directional
  exposures, reachability, and fair-mode rules (fair delta, one-way neutral,
  no head-on) or chase rules (lead window, pursuit) appropriate to its mode;
- that every rejection reason is reproducible from the scene;
- that **weights do not gate acceptance** (re-plan with perturbed weights and
  compare the accepted set and rejection codes);
- replay arrivals, delta and verdict, plus the score arithmetic.

Because it recomputes rather than trusting stored values, it catches tampered
metrics and forged accepted pairs. `scripts/contract.mjs` runs it over every
built-in scene × fair/chase × door flip, plus negative cases (empty zone →
`no-candidates`, no spawns → `invalid-scene`, tampered cost/delta and a forged
pair must be rejected); `scripts/consistency.mjs` cross-checks plan costs
against replay arrivals and the scene hash; `scripts/fixture.mjs` builds a small
synthetic scene with asymmetric/gated geometry, independently validates
candidate reachability and cost, and proves the contract agrees. All three run
under `npm run check` with no hand-edited expectations.

## Test levels

- **Symmetric Arena** — mirrored lanes, central objective. Fair mode should
  accept mirror pairs with equal cost.
- **One-Way Gate** — north and south spawns are 12.5m from the objective on the
  overhead map, each with a one-way gate. In the authored direction both gates
  face inward and fair mode accepts the pair. Flip a gate and that side is
  stranded on the long way around: the lead moves to the opposite side, fair
  mode rejects the pair with a named gaining side, and chase mode compares the
  new lead against its window.
- **Elevation Split** — a ground objective, a tower spawn reached by a ramp, a
  gallery spawn reached by stairs, and a ground spawn. Routes include climbs, so
  overhead distance alone scores them wrongly; some spawn-zone edge positions
  are rejected for clearance, and the evidence tab lists them.

## Layout

```
index.html            UI shell (outcome banner, spawn-zone editor, encounter panel)
src/main.js           wiring: controls, run, replay, doors, live zone edits
src/styles.css
src/core/math.js      geometry primitives, seeded RNG
src/core/metrics.js   canonical metric + weight definitions, directional exposure
src/core/scene.js     scene model, doors, clearance, line of sight, zone edits
src/core/nav.js       raster nav graph, Dijkstra, route detail + timestamps
src/core/candidates.js  candidate sampling and per-source evidence
src/core/engine.js    pairing, hard limits vs soft weights, outcomes, replay,
                      counterfactuals, rejection re-scoring, suggestions
src/core/contract.js  independent plan recomputation + tamper/forgery detection
src/core/evidence.js  evidence store with revision-aware revocation
src/core/levels.js    the three test scenes
src/ui/viewport.js    Three.js renderer, spawn-region and encounter overlays
src/ui/panels.js      result, outcome, encounter, evidence, rejection and log rendering
tests/kernel.test.js  headless kernel tests
scripts/verify.js     browser-driven end-to-end verification
scripts/contract.mjs  contract over all scenes/modes/flips + negative cases
scripts/consistency.mjs  plan-cost vs replay-arrival consistency check
scripts/fixture.mjs   synthetic small-scene candidate/metric validation
```
