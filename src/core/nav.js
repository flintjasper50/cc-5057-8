import {
  cellWalkable, floorById, doorCrossing, doorSolids, doorBlocksNav, segmentHitsSolid2D,
  insideFloor, sceneHash,
} from './scene.js';
import { dist2, round, EPS, pointInRect2 } from './math.js';

const NEIGHBORS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

function keyOf(floorId, ix, iz) {
  return `${floorId}|${ix}|${iz}`;
}

// A directed navigation graph built on a regular raster. One-way doors are
// direction filters on edges; closed two-way doors remove cells; stairs link
// lower/upper raster cells with a cost factor.
export class NavGraph {
  constructor(scene) {
    this.scene = scene;
    this.hash = sceneHash(scene);
    this.cell = scene.cellSize;
    this.nodes = [];
    this.nodeByKey = new Map();
    this.floorNodes = new Map();
    this.adj = [];
    this.radj = [];
    this.doors = doorSolids(scene);
    this.build();
  }

  build() {
    const { scene } = this;
    for (const floor of scene.floors) {
      const list = [];
      this.floorNodes.set(floor.id, list);
      const minX = floor.rect.min[0];
      const minZ = floor.rect.min[1];
      const nx = Math.max(1, Math.ceil((floor.rect.max[0] - floor.rect.min[0]) / this.cell));
      const nz = Math.max(1, Math.ceil((floor.rect.max[1] - floor.rect.min[1]) / this.cell));
      for (let ix = 0; ix < nx; ix++) {
        for (let iz = 0; iz < nz; iz++) {
          const x = minX + (ix + 0.5) * this.cell;
          const z = minZ + (iz + 0.5) * this.cell;
          if (!insideFloor(scene, floor, x, z, 0.01)) continue;
          if (!cellWalkable(scene, floor, x, z)) continue;
          const node = {
            id: this.nodes.length,
            floorId: floor.id,
            ix, iz, x, z, y: floor.y,
            key: keyOf(floor.id, ix, iz),
          };
          this.nodeByKey.set(node.key, node);
          list.push(node);
          this.nodes.push(node);
          this.adj.push([]);
          this.radj.push([]);
        }
      }
    }

    // Same-floor edges (directed through doors).
    for (const node of this.nodes) {
      const floor = floorById(scene, node.floorId);
      for (const [dx, dz, baseCost] of NEIGHBORS) {
        const other = this.nodeByKey.get(keyOf(node.floorId, node.ix + dx, node.iz + dz));
        if (!other) continue;
        if (dx !== 0 && dz !== 0) {
          const a = this.nodeByKey.get(keyOf(node.floorId, node.ix + dx, node.iz));
          const b = this.nodeByKey.get(keyOf(node.floorId, node.ix, node.iz + dz));
          if (!a || !b) continue;
        }
        const a2 = [node.x, node.z];
        const b2 = [other.x, other.z];
        const wall = segmentHitsSolid2D(scene, floor, a2, b2, true);
        if (wall) continue;
        const crossing = this.crossDoor(a2, b2);
        if (crossing && !crossing.allowed) continue;
        // Costs are traversal *time* in seconds, so planning lead time and
        // replay arrival time share one model.
        const cost = (baseCost * this.cell) / scene.agent.speed + (crossing?.delay ?? 0);
        this.addEdge(node.id, other.id, cost, { kind: 'walk', crossing: crossing?.id ?? null });
      }
    }

    // Stair / ramp links between floors.
    for (const conn of scene.connectors) {
      const lowerNodes = this.floorNodes.get(conn.lower) ?? [];
      const upperNodes = this.floorNodes.get(conn.upper) ?? [];
      const lower = floorById(scene, conn.lower);
      const upper = floorById(scene, conn.upper);
      if (!lower || !upper) continue;
      const lowerIn = lowerNodes.filter((n) => pointInRect2([n.x, n.z], conn.rect));
      const upperIn = upperNodes.filter((n) => pointInRect2([n.x, n.z], conn.rect));
      if (!lowerIn.length || !upperIn.length) continue;
      const upperByKey = new Map(upperIn.map((n) => [`${n.ix}|${n.iz}`, n]));
      for (const ln of lowerIn) {
        // Pair with the same raster column when possible, else nearest column.
        let un = upperByKey.get(`${ln.ix}|${ln.iz}`);
        if (!un) {
          let best = null;
          for (const cand of upperIn) {
            const d = dist2([ln.x, ln.z], [cand.x, cand.z]);
            if (!best || d < best.d) best = { d, cand };
          }
          un = best?.cand;
          if (un && best.d > this.cell * 1.25) continue;
        }
        if (!un) continue;
        const horiz = dist2([ln.x, ln.z], [un.x, un.z]);
        const vertical = Math.abs(upper.y - lower.y);
        const cost = (Math.hypot(horiz, vertical) / scene.agent.speed) * conn.costFactor;
        this.addEdge(ln.id, un.id, cost, { kind: 'connector', connectorId: conn.id, bidirectional: true });
        this.addEdge(un.id, ln.id, cost, { kind: 'connector', connectorId: conn.id, bidirectional: true });
      }
    }
  }

  addEdge(from, to, cost, meta = {}) {
    this.adj[from].push({ to, cost, ...meta });
    this.radj[to]?.push({ to: from, cost, ...meta });
  }

  crossDoor(a2, b2) {
    for (const solid of this.doors) {
      const c = doorCrossing(solid, a2, b2);
      if (!c) continue;
      const delay = c.allowed ? (solid.door.delay ?? 0) : 0;
      return { id: solid.id, allowed: c.allowed, sign: c.sign, point: c.point, delay };
    }
    return null;
  }

  nearestNode(floorId, x, z, maxRings = 6) {
    const floor = floorById(this.scene, floorId);
    if (!floor) return null;
    const ix = Math.floor((x - floor.rect.min[0]) / this.cell);
    const iz = Math.floor((z - floor.rect.min[1]) / this.cell);
    let best = null;
    for (let ring = 0; ring <= maxRings; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dz = -ring; dz <= ring; dz++) {
          if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
          const node = this.nodeByKey.get(keyOf(floorId, ix + dx, iz + dz));
          if (!node) continue;
          const d = Math.hypot(node.x - x, node.z - z);
          if (!best || d < best.d) best = { node, d };
        }
      }
      if (best) break;
    }
    return best;
  }

  nodeForPoint(floorId, point) {
    return this.nearestNode(floorId, point[0], point[1]);
  }

  // Multi-source Dijkstra on the reverse graph gives every node's cost *to* a
  // zone, respecting one-way doors (which break ordinary cost symmetry).
  costsToZone(zone) {
    const { scene } = this;
    const dist = new Float64Array(this.nodes.length).fill(Infinity);
    const prev = new Int32Array(this.nodes.length).fill(-1);
    const viaCross = new Array(this.nodes.length).fill(null);
    const heap = new MinHeap();
    for (const node of this.floorNodes.get(zone.floor) ?? []) {
      if (pointInRect2([node.x, node.z], zone.rect)) {
        dist[node.id] = 0;
        prev[node.id] = -2;
        heap.push(0, node.id);
      }
    }
    while (heap.size) {
      const [d, id] = heap.pop();
      if (d > dist[id] + EPS) continue;
      for (const edge of this.radj[id]) {
        const nd = d + edge.cost;
        if (nd + EPS < dist[edge.to]) {
          dist[edge.to] = nd;
          prev[edge.to] = id;
          viaCross[edge.to] = edge.crossing ?? viaCross[id];
          heap.push(nd, edge.to);
        }
      }
    }
    return { zoneId: zone.id, floorId: zone.floor, dist, prev, viaCross, sources: this.nodes.filter((n) => dist[n.id] === 0).map((n) => n.id) };
  }

  pathFrom(result, startNodeId) {
    const targets = new Set(result.sources);
    const ids = [];
    let cur = startNodeId;
    let guard = 0;
    while (cur >= 0 && guard++ < this.nodes.length + 4) {
      ids.push(cur);
      if (targets.has(cur)) break;
      const next = result.prev[cur];
      if (next === -2) break;
      cur = next;
      if (cur < 0) break;
    }
    if (!ids.length || !targets.has(ids[ids.length - 1])) return null;
    return ids;
  }

  routeFromPoint(floorId, point, result) {
    const snap = this.nearestNode(floorId, point[0], point[1]);
    if (!snap) return { reachable: false, reason: 'no-nav-node', path: null, cost: Infinity };
    const speed = this.scene.agent.speed;
    const startSeconds = snap.d / speed;
    const cost = result.dist[snap.node.id] + startSeconds;
    if (!Number.isFinite(cost)) {
      return { reachable: false, reason: 'unreachable', snap, path: null, cost: Infinity };
    }
    const ids = this.pathFrom(result, snap.node.id);
    if (!ids) return { reachable: false, reason: 'no-path', snap, path: null, cost: Infinity };
    const points = [[point[0], point[1]]];
    for (const id of ids) {
      const n = this.nodes[id];
      points.push([n.x, n.z]);
    }
    const yStart = floorById(this.scene, floorId)?.y ?? 0;
    const points3 = points.map((p, i) => {
      if (i === 0) return [p[0], yStart + 0.05, p[1]];
      const n = this.nodes[ids[i - 1]];
      return [p[0], n.y + 0.05, p[1]];
    });
    // Arrival times along the polyline, accumulated from the same edge costs
    // the planner used. This keeps replay arrival identical to plan cost.
    const times = [0, round(startSeconds, 4)];
    const edgeKinds = ['walk'];
    let acc = startSeconds;
    for (let i = 1; i < ids.length; i++) {
      const edge = this.adj[ids[i - 1]]?.find((e) => e.to === ids[i]);
      acc += edge ? edge.cost : Math.hypot(
        points[i + 1][0] - points[i][0],
        points[i + 1][1] - points[i][1],
      ) / this.scene.agent.speed;
      times.push(round(acc, 4));
      edgeKinds.push(edge?.kind ?? 'walk');
    }
    // The zone itself is reached when dist hits zero at the last source node.
    return {
      reachable: true,
      snap,
      cost,
      path: ids,
      points,
      points3,
      times,
      edgeKinds,
      startCost: snap.d,
      startSeconds: round(startSeconds, 4),
      targetZoneId: result.zoneId,
    };
  }

  routeToZone(floorId, point, zone) {
    if (!this._zoneCache) this._zoneCache = new Map();
    let result = this._zoneCache.get(zone.id);
    if (!result) {
      result = this.costsToZone(zone);
      this._zoneCache.set(zone.id, result);
    }
    return this.routeFromPoint(floorId, point, result);
  }

  // Route with door-crossing evidence and per-segment breakdown.
  routeDetail(floorId, point, zone) {
    const route = this.routeToZone(floorId, point, zone);
    if (!route.reachable) return { ...route, crossings: [], connectors: [], length2D: Infinity, ascent: 0 };
    const crossings = [];
    const connectors = [];
    let length2D = 0;
    let ascent = 0;
    let prev = null;
    for (const id of route.path) {
      const n = this.nodes[id];
      if (prev) {
        length2D += Math.hypot(n.x - prev.x, n.z - prev.z);
        ascent += Math.abs(n.y - prev.y);
      }
      prev = n;
    }
    // Detect door crossings along the polyline (the graph already filtered legality).
    const pts = route.points;
    for (let i = 1; i < pts.length; i++) {
      for (const solid of this.doors) {
        const c = doorCrossing(solid, pts[i - 1], pts[i]);
        if (c) {
          crossings.push({
            solidId: solid.id, kind: solid.door.kind, sign: c.sign,
            allowed: c.allowed, at: [round(c.point[0], 3), round(c.point[1], 3)],
          });
        }
      }
    }
    const usedConnectors = new Set();
    for (let i = 1; i < route.path.length; i++) {
      const a = this.nodes[route.path[i - 1]];
      const b = this.nodes[route.path[i]];
      if (a.floorId !== b.floorId) {
        const conn = this.scene.connectors.find((c) =>
          (c.lower === a.floorId && c.upper === b.floorId) ||
          (c.upper === a.floorId && c.lower === b.floorId));
        if (conn) usedConnectors.add(conn.id);
      }
    }
    return {
      ...route,
      crossings,
      connectors: [...usedConnectors],
      length2D: round(length2D, 3),
      ascent: round(ascent, 3),
    };
  }

  clearZoneCache() {
    this._zoneCache = null;
  }
}

// Binary min-heap keyed by cost.
class MinHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(cost, id) {
    const a = this.items;
    a.push([cost, id]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let s = i;
        if (l < a.length && a[l][0] < a[s][0]) s = l;
        if (r < a.length && a[r][0] < a[s][0]) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top;
  }
}

const navCache = new Map();

export function getNavGraph(scene, maxCached = 6) {
  const hash = sceneHash(scene);
  if (navCache.has(hash)) return navCache.get(hash);
  const nav = new NavGraph(scene);
  navCache.set(hash, nav);
  while (navCache.size > maxCached) {
    const oldest = navCache.keys().next().value;
    navCache.delete(oldest);
  }
  return nav;
}

export function clearNavCache() {
  navCache.clear();
}
