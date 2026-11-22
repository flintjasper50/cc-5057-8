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

## Start the window

```bash
npm install
npm run dev           # Vite dev server, prints a URL (default http://localhost:5173)
```

Open the printed URL. The window is a three-pane editor:

- **Left rail** — scene picker, mode switch, spawn conditions (hard limits) and
  soft weights (ranking only), plus door flip controls.
- **Centre stage** — the 3D level. Spawn zones, objective, walls, crates,
  railings, one-way doors (with direction arrows), elevation ramps/stairs,
  candidates, rejected markers, pair sightlines and both routes.
- **Right rail** — result status, actionable suggestions when nothing survives,
  candidate pairs (click to select), the selected pair's score components and
  raw evidence, rejected pairs/positions, the flip counterfactual, and a scene
  log.

Other launch paths:

```bash
npm test              # headless kernel tests (node --test)
npm run verify        # drives the real UI with Playwright, writes reports/
npm run build         # production bundle
npm run preview       # serve the production bundle
```

`npm run verify` needs the Playwright Chromium browser. On a machine without
the system libraries it needs, install them with `npx playwright install-deps
chromium` (requires root) or provide the missing `.so` files on
`LD_LIBRARY_PATH`; the command itself starts the browser, loads the window, and
checks it end to end.

## How to use it

1. Pick a scene: **Symmetric Arena**, **One-Way Gate**, or **Elevation Split**.
2. Choose **Fair opening** or **Asymmetric chase**.
3. Adjust spawn conditions. Hard limits (clearance, separation, fair cost delta,
   one-way rejection, lead window, pursuer sight minimum) are separated from
   soft weights (approach parity, concealment, clearance, route cover).
4. Press **Run design**. Candidates appear in the level; the result rail lists
   accepted pairs, rejected pairs and positions, and the exact queries behind
   every score.
5. Select a pair, then **Play** or **Step** the replay to dispatch both
   characters along their real routes. Arrival times come from the same edge
   costs the planner used.
6. Flip a one-way door under *Geometry edits* and re-run. The revision bumps,
   old results are revoked, and the flip counterfactual shows which side
   inherits the lead and whether the pair is still legal.

Press `?` or **How to start** for the same guidance in-app.

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

Each candidate keeps separate standing records per source:

- `geometry:clearance` — 16-ray radial clearance plus headroom.
- `nav:path-cost` — route cost to each objective (seconds), with length, ascent,
  connectors and door crossings.
- `geometry:sightline` — 3D line of sight from the spawn to each objective.
- `geometry:route-exposure` — fraction of sampled route points with eye-line to
  the opposing spawn.
- `nav:door-neutral-control` — one-way advantage as the difference between
  authored and neutral-door route costs.

When the spawn-level sightline and the route-exposure sampling disagree (for
example, the spawns cannot see each other but most of a route can), both
records are retained and the pair is flagged `sight-vs-route` rather than
averaged away.

Results carry the scene hash and revision they were measured against. Editing
geometry bumps the revision; stale candidates are revoked and listed in the
scene log, and their evidence history is kept keyed by scene hash.

## The soft score is not a fairness proof

The composite score is a **ranking preference only**. It is shown with its
components, weights and human-readable rationale, and labelled as such. The
replay is evidence too: it dispatches both characters and reports arrival times
and verdicts, but a single tie does not prove balance. Use the per-input,
per-route evidence to argue the case.

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
index.html            UI shell
src/main.js           wiring: controls, run, replay, doors
src/styles.css
src/core/math.js      geometry primitives, seeded RNG
src/core/scene.js     scene model, doors, clearance, line of sight, edits
src/core/nav.js       raster nav graph, Dijkstra, route detail + timestamps
src/core/candidates.js  candidate sampling and per-source evidence
src/core/engine.js    pairing, hard limits vs soft weights, replay,
                      counterfactuals, failure suggestions
src/core/evidence.js  evidence store with revision-aware revocation
src/core/levels.js    the three test scenes
src/ui/viewport.js    Three.js renderer and picking
src/ui/panels.js      result, evidence, rejection and log rendering
tests/kernel.test.js  headless kernel tests
scripts/verify.js     browser-driven end-to-end verification
scripts/consistency.mjs  plan-cost vs replay-arrival consistency check
```
