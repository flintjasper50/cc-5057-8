import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { floorById, floorEdgeInfo, activityClearance } from '../core/scene.js';

const COLORS = {
  slab: 0x2a3646,
  slabHole: 0x11161d,
  wall: 0x55657a,
  block: 0x4a5868,
  crate: 0x6b5a44,
  railing: 0x3f7f9e,
  decor: 0x39424e,
  doorTwoWay: 0x4f9e6a,
  doorOneWay: 0xd08a3a,
  zoneSpawn: 0x4fc3f7,
  zoneObjective: 0xffcc69,
  candidate: 0x9aa7b8,
  candidateBlocked: 0x6b3a3a,
  pairA: 0x4fc3f7,
  pairB: 0xf78fb3,
  routeA: 0x4fc3f7,
  routeB: 0xf78fb3,
  sightVisible: 0x7ee787,
  sightBlocked: 0xff7b72,
  rejected: 0xff7b72,
  connector: 0x8f7ee7,
};

export class Viewport {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0e13);
    this.scene.fog = new THREE.Fog(0x0a0e13, 90, 190);

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 600);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    const hemi = new THREE.HemisphereLight(0xbcd6f0, 0x2a2f38, 0.9);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.25);
    key.position.set(34, 58, 24);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -60; key.shadow.camera.right = 60;
    key.shadow.camera.top = 60; key.shadow.camera.bottom = -60;
    key.shadow.camera.far = 200;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x7f9fc0, 0.5);
    fill.position.set(-30, 30, -20);
    this.scene.add(fill);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.overlay = new THREE.Group();
    this.scene.add(this.overlay);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.mode = 'persp';
    this.sceneData = null;
    this.plan = null;
    this.animation = null;

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.resize();
    this.renderer.setAnimationLoop((t) => this.tick(t));
    this.controls.addEventListener('change', () => this.renderer.render(this.scene, this.camera));
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  tick() {
    if (this.animation) this.animation.step();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  disposeGroup(group) {
    while (group.children.length) {
      const child = group.children.pop();
      child.traverse?.((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material.dispose();
        }
      });
      group.remove(child);
    }
  }

  clearOverlay() {
    this.disposeGroup(this.overlay);
    this.animation = null;
  }

  buildScene(sceneData) {
    this.sceneData = sceneData;
    this.clearOverlay();
    this.disposeGroup(this.root);
    this.plan = null;

    const bounds = sceneData.bounds;
    const cx = (bounds.min[0] + bounds.max[0]) / 2;
    const cz = (bounds.min[2] + bounds.max[2]) / 2;

    for (const floor of sceneData.floors) {
      this.buildFloor(floor);
    }
    for (const conn of sceneData.connectors) this.buildConnector(conn);
    for (const solid of sceneData.solids) this.buildSolid(solid);
    for (const zone of sceneData.zones) this.buildZone(zone);

    this.buildGrid(cx, cz, bounds);
    this.setView(this.mode, true);
  }

  buildFloor(floor) {
    const w = floor.rect.max[0] - floor.rect.min[0];
    const d = floor.rect.max[1] - floor.rect.min[1];
    const cx = (floor.rect.min[0] + floor.rect.max[0]) / 2;
    const cz = (floor.rect.min[1] + floor.rect.max[1]) / 2;
    const holes = floor.holes ?? [];

    if (!holes.length) {
      const geo = new THREE.BoxGeometry(w, floor.slabThickness, d);
      const mat = new THREE.MeshStandardMaterial({ color: COLORS.slab, roughness: 0.92, metalness: 0.05 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(cx, floor.y - floor.slabThickness / 2, cz);
      mesh.receiveShadow = true;
      this.root.add(mesh);
      return;
    }

    // Build the slab as four strips around the hole union via a simple grid
    // decomposition: split the floor rectangle into a coarse set of cells and
    // omit hole cells. Keeps holes honest at the cost of a few draw calls.
    const n = 1.5;
    const nx = Math.max(1, Math.ceil(w / n));
    const nz = Math.max(1, Math.ceil(d / n));
    const cells = [];
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        const minX = floor.rect.min[0] + (ix / nx) * w;
        const maxX = floor.rect.min[0] + ((ix + 1) / nx) * w;
        const minZ = floor.rect.min[1] + (iz / nz) * d;
        const maxZ = floor.rect.min[1] + ((iz + 1) / nz) * d;
        const mx = (minX + maxX) / 2;
        const mz = (minZ + maxZ) / 2;
        const inHole = holes.some((h) => mx >= h.min[0] && mx <= h.max[0] && mz >= h.min[1] && mz <= h.max[1]);
        if (!inHole) cells.push([minX, maxX, minZ, maxZ]);
      }
    }
    const mat = new THREE.MeshStandardMaterial({ color: COLORS.slab, roughness: 0.92, metalness: 0.05 });
    for (const [minX, maxX, minZ, maxZ] of cells) {
      const geo = new THREE.BoxGeometry(maxX - minX, floor.slabThickness, maxZ - minZ);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set((minX + maxX) / 2, floor.y - floor.slabThickness / 2, (minZ + maxZ) / 2);
      mesh.receiveShadow = true;
      this.root.add(mesh);
    }
    // Hole rims
    const rimMat = new THREE.LineBasicMaterial({ color: 0x4a5a6d });
    for (const h of holes) {
      const pts = [
        new THREE.Vector3(h.min[0], floor.y + 0.01, h.min[1]),
        new THREE.Vector3(h.max[0], floor.y + 0.01, h.min[1]),
        new THREE.Vector3(h.max[0], floor.y + 0.01, h.max[1]),
        new THREE.Vector3(h.min[0], floor.y + 0.01, h.max[1]),
        new THREE.Vector3(h.min[0], floor.y + 0.01, h.min[1]),
      ];
      this.root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), rimMat));
    }
  }

  buildSolid(solid) {
    if (solid.role === 'slab' || solid.role === 'decor') return;
    const sx = solid.max[0] - solid.min[0];
    const sy = solid.max[1] - solid.min[1];
    const sz = solid.max[2] - solid.min[2];
    const geo = new THREE.BoxGeometry(sx, sy, sz);
    let color = COLORS.wall;
    if (solid.role === 'crate') color = COLORS.crate;
    else if (solid.role === 'block') color = COLORS.block;
    else if (solid.role === 'railing') color = COLORS.railing;
    else if (solid.role === 'door') color = solid.door?.kind === 'one-way' ? COLORS.doorOneWay : COLORS.doorTwoWay;

    const transparent = solid.role === 'door' || solid.role === 'railing';
    const mat = new THREE.MeshStandardMaterial({
      color, roughness: 0.78, metalness: 0.08,
      transparent, opacity: solid.role === 'door' ? 0.55 : 0.85,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set((solid.min[0] + solid.max[0]) / 2, (solid.min[1] + solid.max[1]) / 2, (solid.min[2] + solid.max[2]) / 2);
    mesh.castShadow = !transparent;
    mesh.receiveShadow = true;
    mesh.userData.solidId = solid.id;
    this.root.add(mesh);

    if (solid.role === 'door' && solid.door) {
      this.buildDoorArrow(solid);
    }
  }

  buildDoorArrow(solid) {
    const door = solid.door;
    const c = [(solid.min[0] + solid.max[0]) / 2, (solid.min[2] + solid.max[2]) / 2];
    const y = solid.max[1] + 0.35;
    const n = door.axis === 'x' ? [1, 0] : [0, 1];
    const sign = door.kind === 'two-way' ? 1 : door.allowedSign;
    const a = new THREE.Vector3(c[0] - n[0] * sign * 1.1, y, c[1] - n[1] * sign * 1.1);
    const b = new THREE.Vector3(c[0] + n[0] * sign * 1.1, y, c[1] + n[1] * sign * 1.1);
    const mat = new THREE.LineBasicMaterial({ color: door.kind === 'one-way' ? 0xffb454 : 0x7ee787 });
    this.root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), mat));
    // Arrow head as a cone at the destination end.
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.6, 12),
      new THREE.MeshStandardMaterial({ color: door.kind === 'one-way' ? 0xffb454 : 0x7ee787, emissive: 0x20140a }),
    );
    cone.position.copy(b);
    const dir = new THREE.Vector3().subVectors(b, a).normalize();
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    this.root.add(cone);

    if (door.kind === 'one-way') {
      const label = makeLabel(`↦ ${door.allowedSign > 0 ? '+axis' : '−axis'}`, '#ffcc69');
      label.position.set(c[0], y + 0.7, c[1]);
      this.root.add(label);
    }
  }

  buildConnector(conn) {
    const yLow = floorById(this.sceneData, conn.lower)?.y ?? 0;
    const yHigh = floorById(this.sceneData, conn.upper)?.y ?? 0;
    const cx = (conn.rect.min[0] + conn.rect.max[0]) / 2;
    const cz = (conn.rect.min[1] + conn.rect.max[1]) / 2;
    const w = conn.rect.max[0] - conn.rect.min[0];
    const d = conn.rect.max[1] - conn.rect.min[1];
    const len = Math.hypot(w, d, yHigh - yLow) * 0.9;
    const geo = new THREE.BoxGeometry(w * 0.82, 0.12, d * 0.82);
    const mat = new THREE.MeshStandardMaterial({ color: COLORS.connector, transparent: true, opacity: 0.5, roughness: 0.6 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx, (yLow + yHigh) / 2, cz);
    mesh.rotation.z = Math.atan2(yHigh - yLow, Math.max(w, d) || 1) * (w >= d ? 1 : 0);
    mesh.rotation.x = w >= d ? 0 : -Math.atan2(yHigh - yLow, Math.max(w, d) || 1);
    this.root.add(mesh);
    const label = makeLabel(`${conn.kind === 'ramp' ? '↗ ramp' : '⇡ stairs'}`, '#b9a7ff');
    label.position.set(cx, (yLow + yHigh) / 2 + 0.9, cz);
    this.root.add(label);
  }

  buildZone(zone) {
    const floor = floorById(this.sceneData, zone.floor);
    const y = (floor?.y ?? 0) + 0.03;
    const w = zone.rect.max[0] - zone.rect.min[0];
    const d = zone.rect.max[1] - zone.rect.min[1];
    const cx = (zone.rect.min[0] + zone.rect.max[0]) / 2;
    const cz = (zone.rect.min[1] + zone.rect.max[1]) / 2;
    const color = zone.kind === 'spawn' ? COLORS.zoneSpawn : COLORS.zoneObjective;
    const geo = new THREE.PlaneGeometry(w, d);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(cx, y, cz);
    this.root.add(mesh);
    const pts = [
      new THREE.Vector3(zone.rect.min[0], y + 0.01, zone.rect.min[1]),
      new THREE.Vector3(zone.rect.max[0], y + 0.01, zone.rect.min[1]),
      new THREE.Vector3(zone.rect.max[0], y + 0.01, zone.rect.max[1]),
      new THREE.Vector3(zone.rect.min[0], y + 0.01, zone.rect.max[1]),
      new THREE.Vector3(zone.rect.min[0], y + 0.01, zone.rect.min[1]),
    ];
    this.root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 })));
    const label = makeLabel(`${zone.kind === 'spawn' ? '◎' : '★'} ${zone.name}`, zone.kind === 'spawn' ? '#9fe0ff' : '#ffe2a3');
    label.position.set(cx, y + 1.2, cz);
    this.root.add(label);
  }

  buildGrid(cx, cz, bounds) {
    const size = Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2]) * 1.5;
    const grid = new THREE.GridHelper(size, Math.round(size / 2), 0x1c2734, 0x151d27);
    grid.position.set(cx, -0.05, cz);
    this.root.add(grid);
  }

  setView(mode, immediate = false) {
    this.mode = mode;
    const sceneData = this.sceneData;
    if (!sceneData) return;
    const b = sceneData.bounds;
    const cx = (b.min[0] + b.max[0]) / 2;
    const cz = (b.min[2] + b.max[2]) / 2;
    const span = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]);
    if (mode === 'top') {
      this.camera.position.set(cx, span * 1.25 + 18, cz + 0.001);
      this.camera.up.set(0, 0, -1);
      this.controls.target.set(cx, 0, cz);
    } else {
      this.camera.up.set(0, 1, 0);
      this.camera.position.set(cx + span * 0.62, span * 0.72 + 14, cz + span * 0.78);
      this.controls.target.set(cx, 1, cz);
    }
    this.controls.update();
    if (immediate) this.renderer.render(this.scene, this.camera);
  }

  // ---- plan/overlay -------------------------------------------------------

  showPlan(sceneData, plan) {
    this.sceneData = sceneData;
    this.plan = plan;
    this.clearOverlay();
    if (!plan) return;

    // Rejected candidates: small red discs with a ring.
    if (plan.zoneReports) {
      for (const zr of plan.zoneReports) {
        this.addSpawnRegion(zr);
        for (const cand of zr.candidatesRaw?.rejected ?? []) {
          this.addRejectedMarker(cand);
        }
        for (const cand of zr.candidates) this.addCandidateMarker(cand);
      }
    }

    for (const pair of plan.pairs ?? []) this.addPair(pair);
  }

  // The editable spawn-zone footprint, drawn as a bright quad so the candidate
  // region is visible even before any candidate passes the limits.
  addSpawnRegion(zr) {
    const zone = this.sceneData.zones.find((z) => z.id === zr.zoneId);
    if (!zone) return;
    const floor = floorById(this.sceneData, zone.floor);
    const y = (floor?.y ?? 0) + 0.05;
    const w = zone.rect.max[0] - zone.rect.min[0];
    const d = zone.rect.max[1] - zone.rect.min[1];
    const cx = (zone.rect.min[0] + zone.rect.max[0]) / 2;
    const cz = (zone.rect.min[1] + zone.rect.max[1]) / 2;
    const geo = new THREE.PlaneGeometry(w, d);
    const mat = new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(cx, y, cz);
    mesh.userData.regionZoneId = zone.id;
    this.overlay.add(mesh);
  }

  // Draw where the two characters actually are when they first see each other
  // (or at the end of the replay if they never do). Coordinates come from the
  // replay's own sample records, not from the plan.
  showEncounter(replay) {
    if (!replay) return;
    const marker = replay.firstVisibility;
    const at = marker ? marker.t : Math.max(
      replay.sides.A?.path?.at(-1)?.t ?? 0,
      replay.sides.B?.path?.at(-1)?.t ?? 0,
    );
    const pA = sampleAtPath(replay.sides.A?.path, at);
    const pB = sampleAtPath(replay.sides.B?.path, at);
    if (!pA || !pB) return;
    const A = new THREE.Vector3(pA.pos2[0], pA.y + 0.9, pA.pos2[1]);
    const B = new THREE.Vector3(pB.pos2[0], pB.y + 0.9, pB.pos2[1]);
    const visible = !!marker;
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([A, B]),
      new THREE.LineBasicMaterial({ color: visible ? 0x7ee787 : 0xff7b72, transparent: true, opacity: 0.85 }),
    );
    line.userData.kind = 'encounter';
    this.overlay.add(line);
    for (const P of [A, B]) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 0.62, 28),
        new THREE.MeshBasicMaterial({ color: visible ? 0x7ee787 : 0xff7b72, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
      );
      ring.position.copy(P);
      ring.userData.kind = 'encounter';
      this.overlay.add(ring);
    }
  }

  addCandidateMarker(cand) {
    const floor = floorById(this.sceneData, cand.floorId);
    const y = (floor?.y ?? 0) + 0.06;
    const geo = new THREE.CylinderGeometry(0.28, 0.28, 0.08, 20);
    const mat = new THREE.MeshStandardMaterial({ color: COLORS.candidate, emissive: 0x1a2430, roughness: 0.5 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cand.pos[0], y, cand.pos[1]);
    mesh.userData.candidateId = cand.id;
    this.overlay.add(mesh);
    // Clearance ring preserves the geometric source visibly on the floor.
    const ringGeo = new THREE.RingGeometry(Math.max(0.3, cand.clearance.radius - 0.03), Math.max(0.36, cand.clearance.radius), 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: COLORS.candidate, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(cand.pos[0], y + 0.01, cand.pos[1]);
    this.overlay.add(ring);
  }

  addRejectedMarker(cand) {
    const floor = floorById(this.sceneData, cand.floorId);
    const y = (floor?.y ?? 0) + 0.05;
    const geo = new THREE.RingGeometry(0.12, 0.3, 4);
    const mat = new THREE.MeshBasicMaterial({ color: COLORS.rejected, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(cand.pos[0], y, cand.pos[1]);
    mesh.userData.rejectedId = cand.id;
    mesh.userData.rejectedReason = cand.blockedReason;
    this.overlay.add(mesh);
  }

  highlightRejected(id, on = true) {
    for (const child of this.overlay.children) {
      if (child.userData.rejectedId !== id || !child.material) continue;
      child.material.opacity = on ? 0.95 : 0.5;
      child.material.color.set(on ? 0xff9a90 : COLORS.rejected);
    }
  }

  addPair(pair) {
    const floorA = floorById(this.sceneData, pair.floors[0]);
    const floorB = floorById(this.sceneData, pair.floors[1]);
    const yA = (floorA?.y ?? 0) + 0.12;
    const yB = (floorB?.y ?? 0) + 0.12;
    const A = new THREE.Vector3(pair.points.A[0], yA, pair.points.A[1]);
    const B = new THREE.Vector3(pair.points.B[0], yB, pair.points.B[1]);

    const sphereA = new THREE.Mesh(new THREE.SphereGeometry(0.34, 20, 16), new THREE.MeshStandardMaterial({ color: COLORS.pairA, emissive: 0x123340 }));
    sphereA.position.copy(A);
    sphereA.userData.pairId = pair.id; sphereA.userData.side = 'A';
    this.overlay.add(sphereA);
    const sphereB = new THREE.Mesh(new THREE.SphereGeometry(0.34, 20, 16), new THREE.MeshStandardMaterial({ color: COLORS.pairB, emissive: 0x3a1a26 }));
    sphereB.position.copy(B);
    sphereB.userData.pairId = pair.id; sphereB.userData.side = 'B';
    this.overlay.add(sphereB);

    // Sightline evidence as a dashed line, green when visible, red when blocked.
    const visible = pair.mutualVisibility;
    const lineGeo = new THREE.BufferGeometry().setFromPoints([A, B]);
    const lineMat = new THREE.LineDashedMaterial({
      color: visible ? COLORS.sightVisible : COLORS.sightBlocked,
      dashSize: 0.6, gapSize: 0.4, transparent: true,
      opacity: visible ? 0.9 : 0.35,
    });
    const line = new THREE.Line(lineGeo, lineMat);
    line.computeLineDistances();
    line.userData.pairId = pair.id;
    line.userData.kind = 'sightline';
    this.overlay.add(line);

    // Route polylines.
    this.addRoute(pair.id, 'A', pair.candidates[0], COLORS.routeA);
    this.addRoute(pair.id, 'B', pair.candidates[1], COLORS.routeB);
  }

  addRoute(pairId, side, cand, color) {
    const route = cand.routes?.[0];
    if (!route?.waypoints?.length) return;
    const floor = floorById(this.sceneData, cand.floorId);
    const baseY = (floor?.y ?? 0) + 0.16;
    const pts = route.waypoints.map((p) => new THREE.Vector3(p[0], baseY, p[1]));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75 });
    const line = new THREE.Line(geo, mat);
    line.userData.pairId = pairId;
    line.userData.side = side;
    line.userData.kind = 'route';
    this.overlay.add(line);
  }

  focusPair(pair) {
    // Highlight the selected pair by dimming other markers. Kept simple and
    // non-destructive so the same overlays can be reused for replay.
    for (const child of this.overlay.children) {
      if (!child.userData.pairId) continue;
      const match = child.userData.pairId === pair.id;
      if (child.material) {
        child.material.opacity = match ? (child.material.opacity ?? 1) : 0.18;
        child.material.transparent = true;
      }
    }
  }

  clearFocus() {
    for (const child of this.overlay.children) {
      if (!child.userData.pairId || !child.material) continue;
      const isLine = child.isLine;
      child.material.opacity = isLine ? (child.userData.kind === 'sightline' ? 0.6 : 0.75) : 1;
    }
  }

  playReplay(replay, onTick) {
    this.stopReplay();
    const floorA = floorById(this.sceneData, replay.sides.A.floorId ?? this.plan?.pairs.find((p) => p.id === replay.pairId)?.floors[0]);
    const floorB = floorById(this.sceneData, replay.sides.B.floorId ?? this.plan?.pairs.find((p) => p.id === replay.pairId)?.floors[1]);

    const avatarA = makeAvatar(COLORS.pairA);
    const avatarB = makeAvatar(COLORS.pairB);
    this.overlay.add(avatarA, avatarB);

    const pathA = replay.sides.A.path;
    const pathB = replay.sides.B.path;
    const duration = Math.max(
      pathA.at(-1)?.t ?? 0,
      pathB.at(-1)?.t ?? 0,
      0.1,
    );

    this.animation = {
      playing: true,
      t: 0,
      duration,
      step: () => {
        if (this.animation?.playing) {
          this.animation.t += 1 / 60;
          if (this.animation.t >= duration) {
            this.animation.t = duration;
            this.animation.playing = false;
          }
        }
        const t = this.animation?.t ?? 0;
        applySample(avatarA, pathA, t);
        applySample(avatarB, pathB, t);
        onTick?.(t, duration);
      },
    };
    this.animation.step();
  }

  stopReplay() {
    if (this.animation) {
      this.animation = null;
    }
    for (const child of [...this.overlay.children]) {
      if (child.userData.avatar) {
        this.overlay.remove(child);
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  setReplayTime(t) {
    if (this.animation) {
      this.animation.playing = false;
      this.animation.t = t;
      this.animation.step();
    }
  }

  // Picking: candidate markers and rejected markers are clickable.
  pickAt(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.overlay.children, false);
    for (const hit of hits) {
      const ud = hit.object.userData;
      if (ud.candidateId) return { type: 'candidate', id: ud.candidateId };
      if (ud.rejectedId) return { type: 'rejected', id: ud.rejectedId };
      if (ud.pairId && ud.side) return { type: 'pair', id: ud.pairId, side: ud.side };
      if (ud.pairId) return { type: 'pair', id: ud.pairId };
    }
    return null;
  }
}

function sampleAtPath(path, t) {
  if (!path?.length) return null;
  if (t <= path[0].t) return path[0];
  for (let i = 1; i < path.length; i++) {
    if (path[i].t >= t) return path[i];
  }
  return path[path.length - 1];
}

function applySample(avatar, path, t) {  if (!path?.length) { avatar.visible = false; return; }
  avatar.visible = true;
  let a = path[0], b = path[0];
  for (let i = 1; i < path.length; i++) {
    if (path[i].t >= t) { a = path[i - 1]; b = path[i]; break; }
    a = b = path[i];
  }
  const span = (b.t - a.t) || 1;
  const f = Math.min(1, Math.max(0, (t - a.t) / span));
  const x = a.pos2[0] + (b.pos2[0] - a.pos2[0]) * f;
  const z = a.pos2[1] + (b.pos2[1] - a.pos2[1]) * f;
  const y = a.y + (b.y - a.y) * f;
  avatar.position.set(x, y + 0.9, z);
  const dx = b.pos2[0] - a.pos2[0];
  const dz = b.pos2[1] - a.pos2[1];
  if (Math.hypot(dx, dz) > 1e-4) avatar.rotation.y = Math.atan2(dx, dz);
}

function makeAvatar(color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.32, 0.9, 6, 12),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.4 }),
  );
  body.position.y = 0;
  g.add(body);
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 14, 12),
    new THREE.MeshStandardMaterial({ color: 0xf0f4f8, roughness: 0.5 }),
  );
  head.position.y = 0.85;
  g.add(head);
  g.userData.avatar = true;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.52, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -0.88;
  g.add(ring);
  return g;
}

function makeLabel(text, color) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = '600 30px ui-sans-serif, system-ui, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 28;
  canvas.width = w;
  canvas.height = 54;
  ctx.font = font;
  ctx.fillStyle = 'rgba(9,13,18,0.72)';
  roundRect(ctx, 1, 1, w - 2, 52, 12);
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,150,180,0.35)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, 1, 1, w - 2, 52, 12);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 14, 28);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const scale = 0.016;
  sprite.scale.set(w * scale, 54 * scale, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
