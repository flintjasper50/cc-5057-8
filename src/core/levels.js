// Three hand-authored test levels. They are deliberately small so every
// evaluation can be traced by hand in the evidence view, while still carrying
// the geometry that matters: walls, two routes, a one-way door, and an
// elevation change that breaks Euclidean assumptions.

function wall(id, min, max, extra = {}) {
  return { id, role: 'wall', min, max, label: id, ...extra };
}

export const symmetricArena = {
  id: 'symmetric-arena',
  name: 'Symmetric Arena',
  blurb: 'Mirror-symmetric arena: two equal approach lanes meet at a central objective. Fair mode should accept mirror pairs with the same route cost.',
  bounds: { min: [-24, 0, -18], max: [24, 7, 18] },
  cellSize: 0.4,
  agent: { radius: 0.35, height: 1.8, eyeHeight: 1.6, speed: 4.4 },
  floors: [
    { id: 'ground', name: 'Ground', y: 0, rect: { min: [-22, -16], max: [22, 16] } },
  ],
  connectors: [],
  solids: [
    // outer shell
    wall('shell-n', [-22, 0, -16.4], [22, 6, -16]),
    wall('shell-s', [-22, 0, 16], [22, 6, 16.4]),
    wall('shell-w', [-22.4, 0, -16], [-22, 6, 16]),
    wall('shell-e', [22, 0, -16], [22.4, 6, 16]),
    // central objective room, open at north and south
    wall('core-w', [-3, 0, -7], [-2.6, 5, 7]),
    wall('core-e', [2.6, 0, -7], [3, 5, 7]),
    wall('core-n1', [-3, 0, -7.4], [-1.2, 5, -7]),
    wall('core-n2', [1.2, 0, -7.4], [3, 5, -7]),
    wall('core-s1', [-3, 0, 7], [-1.2, 5, 7.4]),
    wall('core-s2', [1.2, 0, 7], [3, 5, 7.4]),
    // two mirror cover blocks in the lower approach
    { id: 'cover-l', role: 'crate', min: [-11, 0, 5], max: [-8, 2.2, 8], label: 'Cover L' },
    { id: 'cover-r', role: 'crate', min: [8, 0, 5], max: [11, 2.2, 8], label: 'Cover R' },
    // upper approach pillars
    { id: 'pillar-l', role: 'block', min: [-10, 0, -11], max: [-9.2, 4, -10.2], label: 'Pillar L' },
    { id: 'pillar-r', role: 'block', min: [9.2, 0, -11], max: [10, 4, -10.2], label: 'Pillar R' },
  ],
  zones: [
    { id: 'spawn-l', name: 'West Lobby', kind: 'spawn', floor: 'ground', rect: { min: [-19, -6], max: [-15, 6] }, color: '#4fc3f7' },
    { id: 'spawn-r', name: 'East Lobby', kind: 'spawn', floor: 'ground', rect: { min: [15, -6], max: [19, 6] }, color: '#4fc3f7' },
    { id: 'objective', name: 'Center Objective', kind: 'objective', floor: 'ground', rect: { min: [-2, -2], max: [2, 2] }, priority: 2, color: '#ffcc69' },
  ],
};

export const oneWayChase = {
  id: 'oneway-chase',
  name: 'One-Way Gate',
  blurb: 'North and South spawns are 12.5m from the objective on the overhead map, and each side has a one-way gate into the chamber. In the authored orientation both gates face inward, so both sides get the same shortcut and fair mode accepts the pair. Flip either gate and that side is stranded on the long way around: the lead moves to the opposite side, fair mode rejects the pair, and chase mode compares the new lead against its configured window.',
  bounds: { min: [-26, 0, -20], max: [26, 9, 20] },
  cellSize: 0.4,
  agent: { radius: 0.35, height: 1.8, eyeHeight: 1.6, speed: 4.4 },
  floors: [
    { id: 'ground', name: 'Ground', y: 0, rect: { min: [-24, -18], max: [24, 18] } },
  ],
  connectors: [],
  solids: [
    wall('shell-n', [-24, 0, -18.4], [24, 8, -18]),
    wall('shell-s', [-24, 0, 18], [24, 8, 18.4]),
    wall('shell-w', [-24.4, 0, -18], [-24, 8, 18]),
    wall('shell-e', [24, 0, -18], [24.4, 8, 18]),

    // Chamber with a gated mouth on both north and south.
    wall('c-w', [-5.4, 0, -5], [-5, 7, 5]),
    wall('c-e', [5, 0, -5], [5.4, 7, 5]),
    wall('c-s-w', [-5, 0, 5], [-1.3, 7, 5.4]),
    wall('c-s-e', [1.3, 0, 5], [5, 7, 5.4]),
    wall('c-n-w', [-5, 0, -5.4], [-1.3, 7, -5]),
    wall('c-n-e', [1.3, 0, -5.4], [5, 7, -5]),
    {
      id: 'gate-north', role: 'door', label: 'North gate (inbound southbound)',
      min: [-1.3, 0, -5.4], max: [1.3, 2.8, -5],
      door: { kind: 'one-way', state: 'open', axis: 'z', allowedSign: 1, delay: 0.2 },
    },
    {
      id: 'gate-south', role: 'door', label: 'South gate (inbound northbound)',
      min: [-1.3, 0, 5], max: [1.3, 2.8, 5.4],
      door: { kind: 'one-way', state: 'open', axis: 'z', allowedSign: -1, delay: 0.2 },
    },

    // Survey cover, kept off both straight lanes.
    { id: 'cover-nw', role: 'crate', min: [-15, 0, -14], max: [-11, 2.2, -10], label: 'North-west cover' },
    { id: 'cover-ne', role: 'crate', min: [11, 0, -14], max: [15, 2.2, -10], label: 'North-east cover' },
    { id: 'cover-sw', role: 'crate', min: [-15, 0, 10], max: [-11, 2.2, 14], label: 'South-west cover' },
    { id: 'cover-se', role: 'crate', min: [11, 0, 10], max: [15, 2.2, 14], label: 'South-east cover' },
  ],
  zones: [
    { id: 'spawn-n', name: 'North Spawn', kind: 'spawn', floor: 'ground', rect: { min: [-2.2, -14], max: [2.2, -11] }, color: '#4fc3f7' },
    { id: 'spawn-s', name: 'South Spawn', kind: 'spawn', floor: 'ground', rect: { min: [-2.2, 11], max: [2.2, 14] }, color: '#4fc3f7' },
    { id: 'objective', name: 'Objective', kind: 'objective', floor: 'ground', rect: { min: [-1.2, -1.2], max: [1.2, 1.2] }, priority: 2, color: '#ffcc69' },
  ],
  suggested: {
    mode: 'fair',
    chase: { leadSeconds: 4.0, leadToleranceSeconds: 1.2 },
    demoFlip: 'gate-north',
  },
};

export const elevationSplit = {
  id: 'elevation-split',
  name: 'Elevation Split',
  blurb: 'Three levels. The west tower spawn is close on the overhead map but must climb; the east gallery spawn is farther on paper but level. Euclidean sprinkling scores these wrongly.',
  bounds: { min: [-26, -0.5, -22], max: [26, 12, 22] },
  cellSize: 0.4,
  agent: { radius: 0.35, height: 1.8, eyeHeight: 1.6, speed: 4.4 },
  floors: [
    { id: 'ground', name: 'Ground', y: 0, rect: { min: [-24, -20], max: [24, 20] } },
    {
      id: 'tower', name: 'West Tower', y: 5, rect: { min: [-22, -8], max: [-8, 8] },
      holes: [{ min: [-16, -2], max: [-12, 2] }],
    },
    {
      id: 'gallery', name: 'East Gallery', y: 5, rect: { min: [10, -12], max: [22, 12] },
    },
  ],
  connectors: [
    {
      id: 'tower-ramp', kind: 'ramp', lower: 'ground', upper: 'tower',
      rect: { min: [-16, -2], max: [-12, 2] }, costFactor: 1.35, label: 'Tower ramp',
    },
    {
      id: 'gallery-stairs', kind: 'stairs', lower: 'ground', upper: 'gallery',
      rect: { min: [14, -2], max: [18, 2] }, costFactor: 2.1, label: 'Gallery stairs',
    },
  ],
  solids: [
    wall('shell-n', [-24, 0, -20.4], [24, 9, -20]),
    wall('shell-s', [-24, 0, 20], [24, 9, 20.4]),
    wall('shell-w', [-24.4, 0, -20], [-24, 9, 20]),
    wall('shell-e', [24, 0, -20], [24.4, 9, 20]),

    // Tower parapet (walkable inside, walls around).
    wall('tower-n', [-22, 5, -8.4], [-8, 8.5, -8]),
    wall('tower-s', [-22, 5, 8], [-8, 8.5, 8.4]),
    wall('tower-w', [-22.4, 5, -8], [-22, 8.5, 8]),
    wall('tower-e', [-8, 5, -8], [-8.4, 8.5, 8]),

    // Gallery rails - low walls that stop bodies but not eyes.
    { id: 'gallery-n', role: 'railing', min: [10, 5, -12.3], max: [22, 6.1, -12], label: 'Gallery rail N' },
    { id: 'gallery-s', role: 'railing', min: [10, 5, 12], max: [22, 6.1, 12.3], label: 'Gallery rail S' },
    { id: 'gallery-w', role: 'railing', min: [10, 5, -12], max: [10.3, 6.1, 12], label: 'Gallery rail W' },

    // Cover on ground that blocks the tower sight line.
    { id: 'ground-cover', role: 'crate', min: [-6, 0, -3], max: [-2, 2.4, 3], label: 'Ground cover' },
    { id: 'pillar', role: 'block', min: [2, 0, -2], max: [3.2, 6, -0.8], label: 'Center pillar' },
  ],
  zones: [
    { id: 'spawn-tower', name: 'Tower Spawn', kind: 'spawn', floor: 'tower', rect: { min: [-21.4, -7.2], max: [-17, 7.2] }, color: '#4fc3f7' },
    { id: 'spawn-gallery', name: 'Gallery Spawn', kind: 'spawn', floor: 'gallery', rect: { min: [18, -4], max: [21.4, 4] }, color: '#4fc3f7' },
    { id: 'spawn-ground', name: 'Ground Spawn', kind: 'spawn', floor: 'ground', rect: { min: [-3, 14], max: [3, 18] }, color: '#4fc3f7' },
    { id: 'objective', name: 'Ground Objective', kind: 'objective', floor: 'ground', rect: { min: [-2, -2], max: [2, 2] }, priority: 2, color: '#ffcc69' },
    { id: 'objective-tower', name: 'Tower Relay', kind: 'objective', floor: 'tower', rect: { min: [-13, 3], max: [-10, 7] }, priority: 1, color: '#ffa726' },
  ],
};

export const builtinScenes = [symmetricArena, oneWayChase, elevationSplit];

export function sceneById(id) {
  return builtinScenes.find((s) => s.id === id) ?? null;
}
