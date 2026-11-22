import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"
import type {
  Action,
  ActorObs,
  BeamObs,
  Config,
  DropObs,
  GameEvent,
  Hello,
  ItemObs,
  Observation,
  Offer,
  PickupObs,
  ProjectileObs,
  SoundObs,
  UpgradeDef,
  Vec2,
  Vec3,
  WeaponKind,
  WeaponObs,
} from "../src/mechfight.ts"

// ---------------------------------------------------------------------------
// Config & Math Helpers
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: Config = {
  match: {
    tick_hz: 20,
    decide_every: 2,
    duration_s: 480,
    mechs: 16,
    spawn_min_separation: 130,
    spawn_zone_fraction: 0.8,
    arena_margin: 30,
  },
  bot: {
    tick_budget_ms: 50,
    hello_budget_ms: 20000,
    coast_s: 1,
    offer_timeout_s: 5,
    max_line_bytes: 65536,
  },
  mech: {
    radius: 2.5,
    height: 9,
    eye_height: 8,
    muzzle_height: 7,
    hp: 1400,
    walk_speed: 11.7,
    boost_speed: 19.5,
    ground_accel: 58.5,
    air_accel: 12,
    gravity: 22,
    jump_speed: 11,
    jet_accel: 34,
    max_rise_speed: 10,
    step_up: 1.2,
    max_slope_deg: 50,
    energy: 100,
    energy_regen: 18,
    energy_regen_delay: 0.6,
    boost_drain: 17,
    jet_drain: 15,
    turn_rate: 4,
    pitch_rate: 3,
    min_pitch: -0.7,
    max_pitch: 1.3,
    regen_delay: 5,
    regen_per_s: 45,
    charge_move_mult: 0.5,
    self_damage_mult: 0.5,
    armor: 0,
    rear_mult: 1.5,
    front_arc_deg: 180,
    near_range_bonus: 0,
    vision_bonus: 0,
    hearing: 1,
  },
  vision: {
    range: 200,
    fov_deg: 120,
    near_range: 45,
    canopy_blocks: true,
    show_enemy_hp: true,
    memory_s: 5,
  },
  sound: {
    bearing_noise_deg: 7,
    near: 60,
    mid: 160,
    step_speed: 5,
    step_every: 0.6,
    range: {
      step: 40,
      boost: 90,
      reload: 60,
      gun: 320,
      mortar: 420,
      explosion: 420,
      laser_charge: 140,
      laser: 380,
      lightning: 160,
      jet: 90,
      death: 600,
      crate: 220,
      npc_gun: 200,
      drop: 600,
    },
  },
  weapons: {
    gun: { damage: 45, cooldown: 0.24, speed: 252, range: 230, spread_deg: 0.6, mag: 12, reload: 2.4 },
    mortar: { damage: 200, splash: 160, splash_radius: 7, splash_edge: 0.3, cooldown: 2.6, speed: 72, gravity: 22, ttl: 7, knock: 16, knock_up: 9, drain: 45 },
    laser: { damage: 315, charge: 0.75, min_charge: 0.15, min_frac: 0.35, hold_s: 2, cooldown: 1.65, range: 280, pierce: 0, charge_turn_mult: 1, cookoff: 0.6 },
    lightning: { damage: 60, cooldown: 0.25, range: 45, cone_deg: 30, chain: 2, chain_range: 14, chain_falloff: 0.7, energy: 3, short_s: 2 },
  },
  projectile: { gun_radius: 0.3, npc_radius: 0.3 },
  cubes: {
    pickup_radius: 3.5,
    hp_per_cube: 0.04,
    damage_per_cube: 0.04,
    stat_cap: 10,
    death_drop_extra: 2,
    size_per_cube: 0.05,
    upgrade_thresholds: [1, 3, 6, 10, 15, 21, 28, 36, 45],
  },
  crates: { count: 36, roof_fraction: 0.25, hp: 300, radius: 1.4, height: 2.4, cubes: 1 },
  loot: {
    pickup_radius: 4,
    equip_s: 1,
    floor_count: 40,
    floor_roof_fraction: 0.25,
    crate_weapon_chance: 0.5,
    death_drop: 1,
    weights: { gun: 0, mortar: 1, laser: 1, lightning: 1 },
  },
  npc: {
    count: 12,
    hp: 350,
    radius: 1.8,
    height: 3.5,
    speed: 5,
    leash: 30,
    chase_leash: 60,
    aggro_range: 45,
    deaggro_range: 90,
    spawn_clear: 0,
    damage: 25,
    cooldown: 1,
    projectile_speed: 90,
    spread_deg: 2.5,
    cubes: 2,
  },
  drops: { times: [70, 140, 210], fall_s: 25, radius: 8, capture_s: 4, cubes: 3, repair: 1, spread: 0.7 },
  zone: {
    start_center: [41.3, -72.8],
    start_radius: 560,
    phases: [
      { hold_s: 60, shrink_s: 50, radius: 380, dps: 20 },
      { hold_s: 45, shrink_s: 40, radius: 240, dps: 35 },
      { hold_s: 35, shrink_s: 35, radius: 140, dps: 60 },
      { hold_s: 30, shrink_s: 30, radius: 70, dps: 100 },
      { hold_s: 25, shrink_s: 25, radius: 25, dps: 160 },
      { hold_s: 15, shrink_s: 25, radius: 0, dps: 260 },
    ],
  },
  replay: { frame_every: 2 },
  debug: { max_lines: 64, max_points: 64, max_text: 16, max_text_chars: 80, max_bytes: 8192, max_match_bytes: 8000000, hold_s: 0.5 },
  upgrades: [
    { id: "plating", name: "Composite plating", desc: "+15% max HP", max: 3, effects: [{ path: "mech.hp", mul: 1.15 }] },
    { id: "armor", name: "Reactive armor", desc: "-8% damage taken", max: 3, effects: [{ path: "mech.armor", add: 0.08 }] },
    { id: "servos", name: "Leg servos", desc: "+8% walk and boost speed", max: 3, effects: [{ path: "mech.walk_speed", mul: 1.08 }, { path: "mech.boost_speed", mul: 1.08 }] },
    { id: "capacitor", name: "Capacitor bank", desc: "+30 max energy", max: 3, effects: [{ path: "mech.energy", add: 30 }] },
    { id: "reactor", name: "Reactor tune", desc: "+30% energy regen", max: 3, effects: [{ path: "mech.energy_regen", mul: 1.3 }] },
    { id: "jets", name: "Efficient jets", desc: "-25% boost and jet energy drain", max: 2, effects: [{ path: "mech.boost_drain", mul: 0.75 }, { path: "mech.jet_drain", mul: 0.75 }] },
    { id: "nanites", name: "Repair nanites", desc: "+60% out-of-combat regen, starts 1.5 s sooner", max: 2, effects: [{ path: "mech.regen_per_s", mul: 1.6 }, { path: "mech.regen_delay", add: -1.5 }] },
    { id: "gyros", name: "Torso gyros", desc: "+30% aim turn rate", max: 2, effects: [{ path: "mech.turn_rate", mul: 1.3 }, { path: "mech.pitch_rate", mul: 1.3 }] },
    { id: "sensors", name: "Sensor suite", desc: "+15 m proximity sensors, +25 m vision", max: 2, effects: [{ path: "mech.near_range_bonus", add: 15 }, { path: "mech.vision_bonus", add: 25 }, { path: "mech.hearing", mul: 0.5 }] },
    { id: "gun_damage", name: "Tungsten rounds", desc: "+15% arm gun damage", requires: "gun", max: 3, effects: [{ path: "weapons.gun.damage", mul: 1.15 }] },
    { id: "gun_rate", name: "Rotary feed", desc: "+15% arm gun fire rate", requires: "gun", max: 3, effects: [{ path: "weapons.gun.cooldown", mul: 0.87 }] },
    { id: "gun_velocity", name: "Rail barrel", desc: "+25% arm gun projectile speed", requires: "gun", max: 2, effects: [{ path: "weapons.gun.speed", mul: 1.25 }, { path: "weapons.gun.range", mul: 1.15 }] },
    { id: "gun_mag", name: "Drum magazine", desc: "+8 rounds, -20% reload time", requires: "gun", max: 2, effects: [{ path: "weapons.gun.mag", add: 8 }, { path: "weapons.gun.reload", mul: 0.8 }] },
    { id: "mortar_splash", name: "Cluster shells", desc: "+30% mortar splash radius", requires: "mortar", max: 2, effects: [{ path: "weapons.mortar.splash_radius", mul: 1.3 }] },
    { id: "mortar_reload", name: "Autoloader", desc: "-18% mortar cooldown", requires: "mortar", max: 3, effects: [{ path: "weapons.mortar.cooldown", mul: 0.82 }] },
    { id: "mortar_velocity", name: "Long tube", desc: "+20% shell speed", requires: "mortar", max: 2, effects: [{ path: "weapons.mortar.speed", mul: 1.2 }] },
    { id: "laser_charge", name: "Fast capacitors", desc: "-25% laser charge time", requires: "laser", max: 2, effects: [{ path: "weapons.laser.charge", mul: 0.75 }] },
    { id: "laser_damage", name: "Focusing lens", desc: "+18% laser damage", requires: "laser", max: 3, effects: [{ path: "weapons.laser.damage", mul: 1.18 }] },
    { id: "laser_pierce", name: "Phased beam", desc: "Laser passes through one more target", requires: "laser", max: 1, effects: [{ path: "weapons.laser.pierce", add: 1 }] },
    { id: "lightning_chain", name: "Arc relay", desc: "+1 lightning chain jump", requires: "lightning", max: 2, effects: [{ path: "weapons.lightning.chain", add: 1 }] },
    { id: "lightning_range", name: "Tesla coil", desc: "+20% lightning range and cone", requires: "lightning", max: 2, effects: [{ path: "weapons.lightning.range", mul: 1.2 }, { path: "weapons.lightning.cone_deg", mul: 1.2 }] },
    { id: "lightning_efficiency", name: "Superconductor", desc: "-35% lightning energy cost, +10% damage", requires: "lightning", max: 2, effects: [{ path: "weapons.lightning.energy", mul: 0.65 }, { path: "weapons.lightning.damage", mul: 1.1 }] },
  ],
}

class Rng {
  private s: number
  constructor(seed: number) {
    this.s = (seed >>> 0) || 1
  }
  next(): number {
    this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0
    return this.s / 0x100000000
  }
  range(min: number, max: number): number {
    return min + this.next() * (max - min)
  }
  int(min: number, maxExclusive: number): number {
    return Math.floor(this.range(min, maxExclusive))
  }
  gaussian(): number {
    const u1 = Math.max(1e-12, this.next())
    const u2 = this.next()
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}

function moveTowardsAngle(cur: number, target: number, maxDelta: number): number {
  const diff = wrapAngle(target - cur)
  if (Math.abs(diff) <= maxDelta) return wrapAngle(target)
  return wrapAngle(cur + Math.sign(diff) * maxDelta)
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function dist2(a: Vec2 | Vec3, b: Vec2 | Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

function dirFromAim(aim: Vec2): Vec3 {
  const cp = Math.cos(aim[1])
  return [cp * Math.cos(aim[0]), cp * Math.sin(aim[0]), Math.sin(aim[1])]
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

// ---------------------------------------------------------------------------
// SimWorld (terrain.i16 + v2/world.json)
// ---------------------------------------------------------------------------

interface RawWorldJson {
  bounds: { minX: number; maxX: number; minY: number; maxY: number }
  rules: { maxStep: number; maxSlopeDeg: number; canopyDensity: number; canopyBlockT: number }
  terrain: { minX: number; minY: number; step: number; nx: number; ny: number; scale: number }
  prisms: Array<{ kind: string; base: number; top: number; ring: number[]; holes: number[][] }>
  trees: { fields: string[]; data: number[] }
}

interface Prism {
  kind: string
  base: number
  top: number
  ring: number[]
  holes: number[][]
  minX: number
  maxX: number
  minY: number
  maxY: number
}

interface Tree {
  x: number
  y: number
  z: number
  height: number
  crownR: number
  crownBase: number
  trunkR: number
  crownX: number
  crownY: number
}

const GRID_CELL = 32

function pointInRing(x: number, y: number, ring: number[]): boolean {
  let inside = false
  const n = ring.length
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1]
    const xj = ring[j], yj = ring[j + 1]
    const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function pointInPrismXY(x: number, y: number, p: Prism): boolean {
  if (x < p.minX || x > p.maxX || y < p.minY || y > p.maxY) return false
  if (!pointInRing(x, y, p.ring)) return false
  for (const h of p.holes) {
    if (pointInRing(x, y, h)) return false
  }
  return true
}

export class SimWorld {
  readonly bounds: RawWorldJson["bounds"]
  readonly canopyDensity: number
  readonly canopyBlockT: number
  private readonly tMinX: number
  private readonly tMinY: number
  private readonly tStep: number
  private readonly tNx: number
  private readonly tNy: number
  private readonly tScale: number
  private readonly heights: Int16Array
  readonly prisms: Prism[]
  private readonly prismGrid = new Map<number, Prism[]>()
  private readonly treeGrid = new Map<number, Tree[]>()

  constructor(arenaDir: string) {
    const worldPath = resolve(arenaDir, "v2/world.json")
    const terrainPath = resolve(arenaDir, "v2/terrain.i16")
    const raw = JSON.parse(readFileSync(worldPath, "utf8")) as RawWorldJson
    const buf = readFileSync(terrainPath)

    this.bounds = raw.bounds
    this.canopyDensity = raw.rules.canopyDensity ?? 0.35
    this.canopyBlockT = raw.rules.canopyBlockT ?? 0.25
    this.tMinX = raw.terrain.minX
    this.tMinY = raw.terrain.minY
    this.tStep = raw.terrain.step
    this.tNx = raw.terrain.nx
    this.tNy = raw.terrain.ny
    this.tScale = raw.terrain.scale
    this.heights = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2)

    this.prisms = raw.prisms.map((p) => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (let i = 0; i < p.ring.length; i += 2) {
        const x = p.ring[i], y = p.ring[i + 1]
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      const prism: Prism = { ...p, minX, maxX, minY, maxY }
      const gx0 = Math.floor(minX / GRID_CELL), gx1 = Math.floor(maxX / GRID_CELL)
      const gy0 = Math.floor(minY / GRID_CELL), gy1 = Math.floor(maxY / GRID_CELL)
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const key = (gx + 512) * 2048 + (gy + 512)
          let list = this.prismGrid.get(key)
          if (!list) {
            list = []
            this.prismGrid.set(key, list)
          }
          list.push(prism)
        }
      }
      return prism
    })

    // Index trees
    const fields = raw.trees.fields
    const stride = fields.length
    const idx = (name: string) => fields.indexOf(name)
    const ix = idx("x"), iy = idx("y"), iz = idx("z"), ih = idx("height")
    const icr = idx("crownR"), icb = idx("crownBase"), itr = idx("trunkR")
    const icx = idx("crownX"), icy = idx("crownY")
    const data = raw.trees.data
    for (let i = 0; i < data.length; i += stride) {
      const x = data[i + ix], y = data[i + iy]
      const cr = data[i + icr]
      const tree: Tree = {
        x, y, z: data[i + iz], height: data[i + ih],
        crownR: cr, crownBase: data[i + icb], trunkR: data[i + itr],
        crownX: icx >= 0 ? data[i + icx] : x,
        crownY: icy >= 0 ? data[i + icy] : y,
      }
      const gx0 = Math.floor((x - cr) / GRID_CELL), gx1 = Math.floor((x + cr) / GRID_CELL)
      const gy0 = Math.floor((y - cr) / GRID_CELL), gy1 = Math.floor((y + cr) / GRID_CELL)
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const key = (gx + 512) * 2048 + (gy + 512)
          let list = this.treeGrid.get(key)
          if (!list) {
            list = []
            this.treeGrid.set(key, list)
          }
          list.push(tree)
        }
      }
    }
  }

  private gridKey(x: number, y: number): number {
    return (Math.floor(x / GRID_CELL) + 512) * 2048 + (Math.floor(y / GRID_CELL) + 512)
  }

  private queryPrismsBox(minX: number, minY: number, maxX: number, maxY: number): Prism[] {
    const gx0 = Math.floor(minX / GRID_CELL), gx1 = Math.floor(maxX / GRID_CELL)
    const gy0 = Math.floor(minY / GRID_CELL), gy1 = Math.floor(maxY / GRID_CELL)
    const out: Prism[] = []
    const seen = new Set<Prism>()
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const list = this.prismGrid.get((gx + 512) * 2048 + (gy + 512))
        if (!list) continue
        for (const p of list) {
          if (!seen.has(p)) {
            seen.add(p)
            out.push(p)
          }
        }
      }
    }
    return out
  }

  heightAt(x: number, y: number): number {
    const fx = clamp((x - this.tMinX) / this.tStep, 0, this.tNx - 1.0001)
    const fy = clamp((y - this.tMinY) / this.tStep, 0, this.tNy - 1.0001)
    const i = Math.floor(fx)
    const j = Math.floor(fy)
    const tx = fx - i
    const ty = fy - j
    const row0 = j * this.tNx + i
    const row1 = row0 + this.tNx
    const h00 = this.heights[row0] * this.tScale
    const h10 = this.heights[row0 + 1] * this.tScale
    const h01 = this.heights[row1] * this.tScale
    const h11 = this.heights[row1 + 1] * this.tScale
    return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty
  }

  slopeAt(x: number, y: number): number {
    const eps = 0.5
    const dzdx = (this.heightAt(x + eps, y) - this.heightAt(x - eps, y)) / (2 * eps)
    const dzdy = (this.heightAt(x, y + eps) - this.heightAt(x, y - eps)) / (2 * eps)
    return (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI
  }

  surfaceZAt(x: number, y: number, currentZ: number): number {
    let best = this.heightAt(x, y)
    const list = this.prismGrid.get(this.gridKey(x, y))
    if (list) {
      for (const p of list) {
        if (p.top <= currentZ + 1.25 && p.top > best && pointInPrismXY(x, y, p)) {
          best = p.top
        }
      }
    }
    return best
  }

  isInsideSolid(x: number, y: number, z: number): boolean {
    if (z < this.heightAt(x, y)) return true
    const list = this.prismGrid.get(this.gridKey(x, y))
    if (!list) return false
    for (const p of list) {
      if (z >= p.base && z <= p.top && pointInPrismXY(x, y, p)) return true
    }
    return false
  }

  /** Raycast segment a->b against terrain + prisms. Returns t in [0, 1] of first hit, or null. */
  raycastShot(a: Vec3, b: Vec3): number | null {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2]
    const len = Math.hypot(dx, dy, dz)
    if (len < 1e-6) return null
    const steps = Math.max(2, Math.ceil(len / 1.5))
    const cand = this.queryPrismsBox(
      Math.min(a[0], b[0]), Math.min(a[1], b[1]),
      Math.max(a[0], b[0]), Math.max(a[1], b[1])
    )
    const zMin = Math.min(a[2], b[2]), zMax = Math.max(a[2], b[2])
    const activePrisms = cand.filter((p) => p.top >= zMin && p.base <= zMax)

    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      const x = a[0] + dx * t
      const y = a[1] + dy * t
      const z = a[2] + dz * t
      if (z < this.heightAt(x, y)) return t
      for (const p of activePrisms) {
        if (z >= p.base && z <= p.top && pointInPrismXY(x, y, p)) return t
      }
    }
    return null
  }

  hasShotLOS(a: Vec3, b: Vec3): boolean {
    return this.raycastShot(a, b) === null
  }

  hasVisionLOS(a: Vec3, b: Vec3, canopyBlocks = true): boolean {
    if (!this.hasShotLOS(a, b)) return false
    if (!canopyBlocks) return true

    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2]
    const len = Math.hypot(dx, dy, dz)
    if (len < 1e-6) return true
    const steps = Math.max(2, Math.ceil(len / 3))
    let canopyHits = 0
    for (let s = 1; s < steps; s++) {
      const t = s / steps
      const x = a[0] + dx * t, y = a[1] + dy * t, z = a[2] + dz * t
      const list = this.treeGrid.get(this.gridKey(x, y))
      if (!list) continue
      for (const tr of list) {
        if (z < tr.z || z > tr.z + tr.height) continue
        if (z < tr.crownBase) {
          if (Math.hypot(x - tr.x, y - tr.y) <= tr.trunkR) return false
        } else {
          if (Math.hypot(x - tr.crownX, y - tr.crownY) <= tr.crownR) {
            canopyHits++
            if ((canopyHits * (len / steps)) * this.canopyDensity >= 1 - this.canopyBlockT) {
              return false
            }
          }
        }
      }
    }
    return true
  }

  resolveMove(
    oldX: number,
    oldY: number,
    newX: number,
    newY: number,
    z: number,
    radius: number,
    height: number,
    stepUp: number
  ): [number, number] {
    let x = clamp(newX, this.bounds.minX + radius, this.bounds.maxX - radius)
    let y = clamp(newY, this.bounds.minY + radius, this.bounds.maxY - radius)
    const cand = this.queryPrismsBox(x - radius - 2, y - radius - 2, x + radius + 2, y + radius + 2)

    const blockedAt = (px: number, py: number): boolean => {
      for (const p of cand) {
        if (p.top <= z + stepUp || p.base >= z + height) continue
        // Check center + 4 cardinal points on mech cylinder
        if (
          pointInPrismXY(px, py, p) ||
          pointInPrismXY(px + radius * 0.85, py, p) ||
          pointInPrismXY(px - radius * 0.85, py, p) ||
          pointInPrismXY(px, py + radius * 0.85, p) ||
          pointInPrismXY(px, py - radius * 0.85, p)
        ) {
          return true
        }
      }
      return false
    }

    if (!blockedAt(x, y)) return [x, y]
    if (!blockedAt(x, oldY)) return [x, oldY]
    if (!blockedAt(oldX, y)) return [oldX, y]
    return [oldX, oldY]
  }
}

// ---------------------------------------------------------------------------
// External Bot Process Wrapper (mechfight/1 JSON lines)
// ---------------------------------------------------------------------------

function splitCmd(cmd: string): [string, string[]] {
  const parts: string[] = []
  let cur = ""
  let quote: '"' | "'" | null = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (cur) {
        parts.push(cur)
        cur = ""
      }
    } else {
      cur += ch
    }
  }
  if (cur) parts.push(cur)
  return [parts[0], parts.slice(1)]
}

class ExternalBotClient {
  readonly slot: number
  private proc: ChildProcessWithoutNullStreams
  private buf = ""
  private waiters: Array<(line: string | null) => void> = []
  private queue: string[] = []
  private closed = false
  name = "external-bot"

  constructor(slot: number, cmd: string) {
    this.slot = slot
    const [exe, args] = splitCmd(cmd)
    this.proc = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"] })
    this.proc.stdout.setEncoding("utf8")
    this.proc.stdout.on("data", (chunk: string) => {
      this.buf += chunk
      let idx: number
      while ((idx = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, idx).trim()
        this.buf = this.buf.slice(idx + 1)
        if (!line) continue
        const w = this.waiters.shift()
        if (w) w(line)
        else this.queue.push(line)
      }
    })
    const onEnd = () => {
      this.closed = true
      while (this.waiters.length > 0) {
        this.waiters.shift()!(null)
      }
    }
    this.proc.stdout.on("end", onEnd)
    this.proc.on("exit", onEnd)
    this.proc.stderr.resume()
  }

  private nextLine(timeoutMs: number): Promise<string | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!)
    if (this.closed) return Promise.resolve(null)
    return new Promise((res) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(resolveFn)
        if (idx >= 0) this.waiters.splice(idx, 1)
        res(null)
      }, timeoutMs)
      const resolveFn = (line: string | null) => {
        clearTimeout(timer)
        res(line)
      }
      this.waiters.push(resolveFn)
    })
  }

  async handshake(hello: Hello, budgetMs: number): Promise<boolean> {
    if (this.closed) return false
    this.proc.stdin.write(JSON.stringify(hello) + "\n")
    const line = await this.nextLine(budgetMs)
    if (!line) return false
    try {
      const msg = JSON.parse(line) as { type?: string; name?: string }
      if (msg.type === "ready") {
        if (msg.name) this.name = String(msg.name).slice(0, 32)
        return true
      }
    } catch {
      return false
    }
    return false
  }

  async decide(obs: Observation, timeoutMs: number): Promise<{ action: Action | null; latencyMs: number }> {
    if (this.closed) return { action: null, latencyMs: timeoutMs }
    const t0 = performance.now()
    this.proc.stdin.write(JSON.stringify(obs) + "\n")
    while (true) {
      const elapsed = performance.now() - t0
      const rem = timeoutMs - elapsed
      if (rem <= 0) return { action: null, latencyMs: elapsed }
      const line = await this.nextLine(rem)
      const latencyMs = performance.now() - t0
      if (!line) return { action: null, latencyMs }
      try {
        const act = JSON.parse(line) as Action
        if (act.tick === obs.tick) return { action: act, latencyMs }
      } catch {
        // Ignore malformed lines
      }
    }
  }

  finish(place: number, kills: number): void {
    if (!this.closed) {
      try {
        this.proc.stdin.write(JSON.stringify({ type: "end", place, kills }) + "\n")
        this.proc.stdin.end()
      } catch {
        // ignore
      }
    }
    setTimeout(() => {
      if (!this.closed) {
        try {
          this.proc.kill()
        } catch {
          // ignore
        }
      }
    }, 250)
  }
}

// ---------------------------------------------------------------------------
// Built-in House Bot AI (baseline opponent for 1v15)
// ---------------------------------------------------------------------------

function houseBotAct(obs: Observation, rng: Rng, isSquad1v15 = false): Action {
  const me = obs.self
  const act: Action = { tick: obs.tick }

  if (obs.offer) {
    act.pick = 0
  }

  // Pick up nearby weapon if slot 1 is empty
  if (!me.weapons[1] && obs.pickups.length > 0) {
    let bestP = obs.pickups[0]
    let bestD = dist3(me.pos, bestP.pos)
    for (const p of obs.pickups) {
      const d = dist3(me.pos, p.pos)
      if (d < bestD) {
        bestD = d
        bestP = p
      }
    }
    if (bestD <= 4) {
      act.take = bestP.id
    } else if (bestD < 30 && me.in_zone) {
      const dx = bestP.pos[0] - me.pos[0], dy = bestP.pos[1] - me.pos[1]
      const len = Math.hypot(dx, dy) || 1
      act.move = [dx / len, dy / len]
    }
  }

  // In 1v15 squad mode, house bots ONLY target slot 0 (player), never each other.
  // In FFA mode, target nearest visible enemy mech (or NPC).
  const enemies = isSquad1v15
    ? obs.mechs.filter((m) => m.kind === "mech" && m.id === 0)
    : obs.mechs.filter((m) => m.kind === "mech")
  let target = enemies[0] ?? (isSquad1v15 ? null : obs.mechs[0] ?? null)
  if (!isSquad1v15 && enemies.length > 1) {
    target = enemies.reduce((best, cur) =>
      dist3(me.pos, cur.pos) < dist3(me.pos, best.pos) ? cur : best
    )
  }

  if (target) {
    const dx = target.pos[0] - me.pos[0]
    const dy = target.pos[1] - me.pos[1]
    const horiz = Math.hypot(dx, dy) || 1
    const dz = (target.pos[2] + 4.5) - (me.pos[2] + 7)
    const yaw = Math.atan2(dy, dx)
    const pitch = Math.atan2(dz, horiz)
    act.aim = [yaw, pitch]

    // Early game in 1v15: 1-3 bots converge aggressively, others converge later or when close
    const squadConverge = !isSquad1v15 || obs.t >= 40 || obs.zone.radius < 380 || me.id <= 3 || horiz < 130

    const fire: [boolean, boolean] = [false, false]
    if (horiz < 250) {
      for (let s = 0; s < 2; s++) {
        const w = me.weapons[s]
        if (!w) continue
        if (w.kind === "gun" && (w.ammo ?? 0) > 0 && w.cooldown <= 0 && horiz < 210) fire[s] = true
        if (w.kind === "lightning" && horiz < 42 && me.energy > 15 && w.cooldown <= 0) fire[s] = true
        if (w.kind === "laser" && horiz < 250 && w.cooldown <= 0) {
          fire[s] = (w.charge ?? 0) < 0.7
        }
        if (w.kind === "mortar" && horiz > 20 && horiz < 210 && w.cooldown <= 0) fire[s] = true
      }
    }
    act.fire = fire

    if (!act.move && squadConverge) {
      const strafe = (obs.tick % 40) < 20 ? 1 : -1
      const desiredDist = 45
      const radial = horiz > desiredDist ? 0.75 : -0.45
      const nx = dx / horiz, ny = dy / horiz
      const mx = nx * radial - ny * 0.65 * strafe
      const my = ny * radial + nx * 0.65 * strafe
      const mlen = Math.hypot(mx, my) || 1
      act.move = [mx / mlen, my / mlen]
      act.boost = !me.in_zone || horiz > 120
    }
  }

  if (!act.move) {
    // Move toward zone center with mild wander
    const zx = obs.zone.next_center[0] - me.pos[0]
    const zy = obs.zone.next_center[1] - me.pos[1]
    const zdist = Math.hypot(zx, zy)
    if (!me.in_zone || zdist > obs.zone.radius * 0.6) {
      const len = zdist || 1
      act.move = [zx / len, zy / len]
      act.boost = !me.in_zone
    } else {
      const ang = ((obs.tick * 0.05 + me.id * 1.7) % (Math.PI * 2))
      act.move = [Math.cos(ang) * 0.6, Math.sin(ang) * 0.6]
    }
    if (!act.aim) {
      act.aim = [wrapAngle(me.aim[0] + (rng.next() - 0.5) * 0.4), 0]
    }
  }

  return act
}

// ---------------------------------------------------------------------------
// Arena Match Simulation
// ---------------------------------------------------------------------------

interface WeaponState {
  kind: WeaponKind
  cooldown: number
  ammo: number
  reload: number
  charge: number
  shortTimer: number
  stats: Record<string, number>
}

interface MechState {
  id: number
  pos: Vec3
  vel: Vec3
  aim: Vec2
  hp: number
  maxHp: number
  energy: number
  maxEnergy: number
  energyRegenDelay: number
  grounded: boolean
  alive: boolean
  place: number
  kills: number
  cubes: number
  upgrades: string[]
  upgradeCounts: Map<string, number>
  offer: Offer | null
  nextThresholdIdx: number
  weapons: [WeaponState | null, WeaponState | null]
  stats: Record<string, number>
  lastCombatT: number
  stepTimer: number
  lastAction: Action
  missedDecisionS: number
  events: GameEvent[]
  sounds: SoundObs[]
  beams: BeamObs[]
  memory: Map<number, number> // actorId -> expiryT
  client: ExternalBotClient | null
}

interface SimProjectile {
  id: number
  ownerId: number
  kind: "gun" | "mortar" | "npc"
  pos: Vec3
  vel: Vec3
  damage: number
  gravity: number
  ttl: number
  rangeLeft: number
  splash?: number
  splashRadius?: number
  splashEdge?: number
  knock?: number
  knockUp?: number
  drain?: number
}

interface SimNpc {
  id: number
  home: Vec3
  pos: Vec3
  vel: Vec3
  aim: Vec2
  hp: number
  maxHp: number
  cooldown: number
  targetId: number | null
  alive: boolean
}

interface SimCrate {
  id: number
  pos: Vec3
  hp: number
  alive: boolean
}

interface SimCube {
  id: number
  pos: Vec3
  alive: boolean
}

interface SimPickup {
  id: number
  kind: WeaponKind
  pos: Vec3
  ammo: number
  cooldown: number
  alive: boolean
}

interface SimDrop {
  id: number
  pos: Vec3
  landsIn: number
  progress: number
  holder: number | null
  captured: boolean
  called: boolean
}

export interface MatchResult {
  matchIndex: number
  ticks: number
  durationS: number
  placements: Array<{ slot: number; name: string; place: number; kills: number; score: number; isTarget: boolean }>
  targetLatenciesMs: number[]
}

export class ArenaMatch {
  private readonly world: SimWorld
  private readonly cfg: Config
  private readonly rng: Rng
  private readonly mode: "1v15" | "ffa"
  private squadKnownUntilT = -1
  private mechs: MechState[] = []
  private projectiles: SimProjectile[] = []
  private npcs: SimNpc[] = []
  private crates: SimCrate[] = []
  private cubes: SimCube[] = []
  private pickups: SimPickup[] = []
  private drops: SimDrop[] = []
  private nextEntityId = 1
  private tick = 0
  private t = 0
  private aliveCount = 16
  private zonePhaseIdx = 0
  private phaseElapsed = 0
  private zoneCenter: Vec2
  private zoneRadius: number
  private nextZoneCenter: Vec2
  private nextZoneRadius: number
  private targetLatenciesMs: number[] = []

  constructor(world: SimWorld, seed: number, cfg: Config = DEFAULT_CONFIG, mode: "1v15" | "ffa" = "1v15") {
    this.world = world
    this.cfg = cfg
    this.rng = new Rng(seed)
    this.mode = mode
    this.zoneCenter = [...cfg.zone.start_center] as Vec2
    this.zoneRadius = cfg.zone.start_radius
    this.nextZoneCenter = this.pickNextZoneCenter(this.zoneCenter, this.zoneRadius, cfg.zone.phases[0].radius)
    this.nextZoneRadius = cfg.zone.phases[0].radius
  }

  private pickNextZoneCenter(cur: Vec2, curR: number, nextR: number): Vec2 {
    const maxShift = Math.max(0, curR - nextR) * 0.7
    const ang = this.rng.range(0, Math.PI * 2)
    const r = this.rng.range(0, maxShift)
    return [cur[0] + Math.cos(ang) * r, cur[1] + Math.sin(ang) * r]
  }

  private randomOpenPoint(center: Vec2, maxRadius: number, allowRoof = false): Vec3 {
    for (let attempt = 0; attempt < 200; attempt++) {
      const ang = this.rng.range(0, Math.PI * 2)
      const rad = Math.sqrt(this.rng.next()) * maxRadius
      const x = clamp(center[0] + Math.cos(ang) * rad, this.world.bounds.minX + 30, this.world.bounds.maxX - 30)
      const y = clamp(center[1] + Math.sin(ang) * rad, this.world.bounds.minY + 30, this.world.bounds.maxY - 30)
      const gz = this.world.heightAt(x, y)
      const sz = allowRoof ? this.world.surfaceZAt(x, y, gz + 80) : gz
      if (!allowRoof && sz > gz + 0.5) continue
      if (!this.world.isInsideSolid(x, y, sz + 1.0) && this.world.slopeAt(x, y) < 40) {
        return [x, y, sz]
      }
    }
    const x = center[0], y = center[1]
    return [x, y, this.world.heightAt(x, y)]
  }

  private makeWeapon(kind: WeaponKind): WeaponState {
    const stats = { ...this.cfg.weapons[kind] }
    return {
      kind,
      cooldown: 0,
      ammo: kind === "gun" ? stats.mag : 0,
      reload: 0,
      charge: 0,
      shortTimer: 0,
      stats,
    }
  }

  async setup(clients: Array<ExternalBotClient | null>): Promise<void> {
    const spawnR = this.cfg.zone.start_radius * this.cfg.match.spawn_zone_fraction
    const positions: Vec3[] = []
    for (let i = 0; i < this.cfg.match.mechs; i++) {
      let chosen: Vec3 | null = null
      for (let tries = 0; tries < 150; tries++) {
        const pt = this.randomOpenPoint(this.zoneCenter, spawnR, false)
        const ok = positions.every((p) => dist2(p, pt) >= this.cfg.match.spawn_min_separation)
        if (ok) {
          chosen = pt
          break
        }
      }
      positions.push(chosen ?? this.randomOpenPoint(this.zoneCenter, spawnR, false))
    }

    for (let i = 0; i < this.cfg.match.mechs; i++) {
      const pos = positions[i]
      const stats = { ...this.cfg.mech }
      this.mechs.push({
        id: i,
        pos,
        vel: [0, 0, 0],
        aim: [this.rng.range(-Math.PI, Math.PI), 0],
        hp: stats.hp,
        maxHp: stats.hp,
        energy: stats.energy,
        maxEnergy: stats.energy,
        energyRegenDelay: 0,
        grounded: true,
        alive: true,
        place: 1,
        kills: 0,
        cubes: 0,
        upgrades: [],
        upgradeCounts: new Map(),
        offer: null,
        nextThresholdIdx: 0,
        weapons: [this.makeWeapon("gun"), null],
        stats,
        lastCombatT: -100,
        stepTimer: 0,
        lastAction: { tick: 0 },
        missedDecisionS: 0,
        events: [],
        sounds: [],
        beams: [],
        memory: new Map(),
        client: clients[i] ?? null,
      })
    }

    // Spawn crates (1000+)
    for (let i = 0; i < this.cfg.crates.count; i++) {
      const allowRoof = i < Math.floor(this.cfg.crates.count * this.cfg.crates.roof_fraction)
      this.crates.push({
        id: 1000 + i,
        pos: this.randomOpenPoint(this.zoneCenter, spawnR, allowRoof),
        hp: this.cfg.crates.hp,
        alive: true,
      })
    }

    // Spawn floor pickups (8000+)
    const kinds: WeaponKind[] = ["mortar", "laser", "lightning"]
    for (let i = 0; i < this.cfg.loot.floor_count; i++) {
      const allowRoof = i < Math.floor(this.cfg.loot.floor_count * this.cfg.loot.floor_roof_fraction)
      const kind = kinds[i % kinds.length]
      this.pickups.push({
        id: 8000 + i,
        kind,
        pos: this.randomOpenPoint(this.zoneCenter, spawnR, allowRoof),
        ammo: 0,
        cooldown: 0,
        alive: true,
      })
    }

    // Spawn NPCs (100+)
    for (let i = 0; i < this.cfg.npc.count; i++) {
      const pos = this.randomOpenPoint(this.zoneCenter, spawnR, false)
      this.npcs.push({
        id: 100 + i,
        home: [...pos] as Vec3,
        pos,
        vel: [0, 0, 0],
        aim: [this.rng.range(-Math.PI, Math.PI), 0],
        hp: this.cfg.npc.hp,
        maxHp: this.cfg.npc.hp,
        cooldown: 0,
        targetId: null,
        alive: true,
      })
    }

    // Schedule supply drops (20000+)
    const dropTimes = this.cfg.drops?.times ?? []
    for (let i = 0; i < dropTimes.length; i++) {
      this.drops.push({
        id: 20000 + i,
        pos: this.randomOpenPoint(this.zoneCenter, 220, false),
        landsIn: this.cfg.drops?.fall_s ?? 25,
        progress: 0,
        holder: null,
        captured: false,
        called: false,
      })
    }
  }

  private isVisible(observer: MechState, targetPos: Vec3, targetHeight: number): boolean {
    const eye: Vec3 = [observer.pos[0], observer.pos[1], observer.pos[2] + observer.stats.eye_height]
    const dx = targetPos[0] - eye[0]
    const dy = targetPos[1] - eye[1]
    const horiz = Math.hypot(dx, dy)
    const nearR = this.cfg.vision.near_range + (observer.stats.near_range_bonus ?? 0)
    const farR = this.cfg.vision.range + (observer.stats.vision_bonus ?? 0)
    if (horiz > farR) return false

    const inNear = horiz <= nearR
    if (!inNear) {
      const yawTo = Math.atan2(dy, dx)
      const diff = Math.abs(wrapAngle(yawTo - observer.aim[0]))
      if (diff > ((this.cfg.vision.fov_deg * Math.PI) / 180) * 0.5) return false
    }

    const center: Vec3 = [targetPos[0], targetPos[1], targetPos[2] + targetHeight * 0.5]
    const top: Vec3 = [targetPos[0], targetPos[1], targetPos[2] + targetHeight]
    const canopyBlocks = !inNear && this.cfg.vision.canopy_blocks
    return (
      this.world.hasVisionLOS(eye, center, canopyBlocks) ||
      this.world.hasVisionLOS(eye, top, canopyBlocks)
    )
  }

  private emitSound(kind: string, origin: Vec3, excludeId?: number): void {
    const maxR = this.cfg.sound.range[kind] ?? 100
    for (const m of this.mechs) {
      if (!m.alive || m.id === excludeId) continue
      const dx = origin[0] - m.pos[0], dy = origin[1] - m.pos[1]
      const d = Math.hypot(dx, dy)
      if (d > maxR) continue
      if (this.mode === "1v15" && excludeId === 0 && m.id > 0) {
        this.squadKnownUntilT = Math.max(this.squadKnownUntilT, this.t + (this.cfg.vision.memory_s ?? 5))
      }
      const noiseRad = ((this.cfg.sound.bearing_noise_deg * (m.stats.hearing ?? 1)) * Math.PI) / 180
      const bearing = wrapAngle(Math.atan2(dy, dx) + this.rng.gaussian() * noiseRad)
      const dist: SoundObs["dist"] = d < this.cfg.sound.near ? "near" : d < this.cfg.sound.mid ? "mid" : "far"
      m.sounds.push({ kind, bearing, dist, age: 0 })
    }
  }

  private buildObs(m: MechState): Observation {
    const mechsObs: ActorObs[] = []
    for (const other of this.mechs) {
      if (!other.alive || other.id === m.id) continue
      if (this.mode === "1v15" && m.id > 0 && other.id > 0) continue
      const vis = this.isVisible(m, other.pos, other.stats.height)
      if (vis) {
        m.memory.set(other.id, this.t + (this.cfg.vision.memory_s ?? 5))
        if (this.mode === "1v15" && m.id > 0 && other.id === 0) {
          this.squadKnownUntilT = Math.max(this.squadKnownUntilT, this.t + (this.cfg.vision.memory_s ?? 5))
        }
      }
      const squadShared = this.mode === "1v15" && m.id > 0 && other.id === 0 && this.squadKnownUntilT >= this.t
      const memExp = m.memory.get(other.id) ?? -1
      if (vis || memExp >= this.t || squadShared) {
        mechsObs.push({
          id: other.id,
          kind: "mech",
          pos: [other.pos[0], other.pos[1], other.pos[2]],
          vel: [other.vel[0], other.vel[1], other.vel[2]],
          aim: [other.aim[0], other.aim[1]],
          hp: other.hp,
          max_hp: other.maxHp,
          cubes: other.cubes,
          weapons: other.weapons.filter((w): w is WeaponState => w !== null).map((w) => w.kind),
          charging: other.weapons.some((w) => w?.kind === "laser" && w.charge > 0),
        })
      }
    }

    for (const npc of this.npcs) {
      if (!npc.alive) continue
      const vis = this.isVisible(m, npc.pos, this.cfg.npc.height)
      if (vis) m.memory.set(npc.id, this.t + (this.cfg.vision.memory_s ?? 5))
      if (vis || (m.memory.get(npc.id) ?? -1) >= this.t) {
        mechsObs.push({
          id: npc.id,
          kind: "npc",
          pos: [npc.pos[0], npc.pos[1], npc.pos[2]],
          vel: [npc.vel[0], npc.vel[1], npc.vel[2]],
          aim: [npc.aim[0], npc.aim[1]],
          hp: npc.hp,
          max_hp: npc.maxHp,
        })
      }
    }

    const projObs: ProjectileObs[] = this.projectiles
      .filter((p) => p.ownerId !== m.id && dist3(m.pos, p.pos) <= 220 && this.isVisible(m, p.pos, 0.5))
      .map((p) => ({ id: p.id, kind: p.kind, pos: [...p.pos] as Vec3, vel: [...p.vel] as Vec3 }))

    const crateObs: ItemObs[] = this.crates
      .filter((c) => c.alive && this.isVisible(m, c.pos, this.cfg.crates.height))
      .map((c) => ({ id: c.id, pos: [...c.pos] as Vec3, hp: c.hp }))

    const cubeObs: ItemObs[] = this.cubes
      .filter((c) => c.alive && this.isVisible(m, c.pos, 1))
      .map((c) => ({ id: c.id, pos: [...c.pos] as Vec3 }))

    const pickupObs: PickupObs[] = this.pickups
      .filter((p) => p.alive && this.isVisible(m, p.pos, 1))
      .map((p) => ({ id: p.id, kind: p.kind, pos: [...p.pos] as Vec3 }))

    const activeDrops: DropObs[] = this.drops
      .filter((d) => d.called && !d.captured)
      .map((d) => ({
        id: d.id,
        pos: [...d.pos] as Vec3,
        radius: this.cfg.drops?.radius ?? 8,
        lands_in: Math.max(0, d.landsIn),
        capture_s: this.cfg.drops?.capture_s ?? 4,
        progress: d.progress,
        holder: d.holder,
      }))

    const phase = this.cfg.zone.phases[Math.min(this.zonePhaseIdx, this.cfg.zone.phases.length - 1)]
    const shrinkStart = this.t - this.phaseElapsed + phase.hold_s
    const shrinkEnd = shrinkStart + phase.shrink_s

    const wObs = (w: WeaponState | null): WeaponObs | null => {
      if (!w) return null
      return {
        kind: w.kind,
        cooldown: Math.max(0, w.cooldown),
        ...(w.kind === "gun" ? { ammo: w.ammo, reload: Math.max(0, w.reload) } : {}),
        ...(w.kind === "laser" ? { charge: w.charge } : {}),
        stats: { ...w.stats },
      }
    }

    const obs: Observation = {
      type: "obs",
      tick: this.tick,
      t: Number(this.t.toFixed(3)),
      alive: this.aliveCount,
      self: {
        id: m.id,
        pos: [m.pos[0], m.pos[1], m.pos[2]],
        vel: [m.vel[0], m.vel[1], m.vel[2]],
        aim: [m.aim[0], m.aim[1]],
        hp: m.hp,
        max_hp: m.maxHp,
        energy: m.energy,
        max_energy: m.maxEnergy,
        grounded: m.grounded,
        cubes: m.cubes,
        upgrades: [...m.upgrades],
        weapons: [wObs(m.weapons[0]), wObs(m.weapons[1])],
        in_zone: dist2(m.pos, this.zoneCenter) <= this.zoneRadius,
        stats: { ...m.stats },
      },
      mechs: mechsObs,
      projectiles: projObs,
      crates: crateObs,
      cubes: cubeObs,
      pickups: pickupObs,
      sounds: m.sounds.splice(0, m.sounds.length),
      beams: m.beams.splice(0, m.beams.length),
      events: m.events.splice(0, m.events.length),
      zone: {
        center: [this.zoneCenter[0], this.zoneCenter[1]],
        radius: this.zoneRadius,
        next_center: [this.nextZoneCenter[0], this.nextZoneCenter[1]],
        next_radius: this.nextZoneRadius,
        shrink_start: Number(shrinkStart.toFixed(2)),
        shrink_end: Number(shrinkEnd.toFixed(2)),
        dps: phase.dps,
      },
      offer: m.offer,
      drops: activeDrops,
    }
    return obs
  }

  private damageMech(target: MechState, rawAmount: number, weapon: string, sourcePos: Vec3 | null, attackerId: number | null): void {
    if (!target.alive) return
    if (this.mode === "1v15" && attackerId !== null && attackerId > 0 && target.id > 0) return
    let amount = rawAmount
    let rear = false
    let bearing: number | null = null

    if (sourcePos) {
      const dx = sourcePos[0] - target.pos[0], dy = sourcePos[1] - target.pos[1]
      bearing = Math.atan2(dy, dx)
      const diff = Math.abs(wrapAngle(bearing - target.aim[0]))
      if (diff > ((target.stats.front_arc_deg * Math.PI) / 180) * 0.5) {
        rear = true
        amount *= target.stats.rear_mult
      }
    }

    if (weapon !== "zone") {
      amount *= Math.max(0.1, 1 - (target.stats.armor ?? 0))
    }
    if (attackerId === target.id) {
      amount *= target.stats.self_damage_mult
    }

    target.hp -= amount
    target.lastCombatT = this.t
    target.events.push({ type: "damaged", amount, weapon, bearing, by: attackerId, ...(rear ? { rear: true } : {}) })

    if (attackerId !== null && attackerId !== target.id) {
      const atk = this.mechs[attackerId]
      if (atk) {
        atk.lastCombatT = this.t
        atk.events.push({ type: "hit", target: target.id, amount, weapon, ...(rear ? { rear: true } : {}) })
      }
    }

    if (target.hp <= 0) {
      target.hp = 0
      target.alive = false
      target.place = this.aliveCount
      this.aliveCount--
      this.emitSound("death", target.pos)
      if (attackerId !== null && attackerId !== target.id) {
        const atk = this.mechs[attackerId]
        if (atk) {
          atk.kills++
          atk.events.push({ type: "kill", target: target.id })
        }
      }
      // Drop cubes + non-gun weapons
      const dropCubes = target.cubes + Number(this.cfg.cubes.death_drop_extra)
      for (let c = 0; c < dropCubes; c++) {
        this.cubes.push({
          id: 5000 + this.nextEntityId++,
          pos: [target.pos[0] + this.rng.range(-2, 2), target.pos[1] + this.rng.range(-2, 2), target.pos[2]],
          alive: true,
        })
      }
      for (const w of target.weapons) {
        if (w && w.kind !== "gun") {
          this.pickups.push({
            id: 8000 + this.nextEntityId++,
            kind: w.kind,
            pos: [target.pos[0] + this.rng.range(-1.5, 1.5), target.pos[1] + this.rng.range(-1.5, 1.5), target.pos[2]],
            ammo: w.ammo,
            cooldown: w.cooldown,
            alive: true,
          })
        }
      }
    }
  }

  private grantCubes(m: MechState, count: number): void {
    const cap = Number(this.cfg.cubes.stat_cap)
    const hpPerCube = Number(this.cfg.cubes.hp_per_cube)
    const sizePerCube = Number(this.cfg.cubes.size_per_cube)
    const prevEff = Math.min(m.cubes, cap)
    m.cubes += count
    const nextEff = Math.min(m.cubes, cap)
    if (nextEff > prevEff) {
      const prevMult = 1 + prevEff * hpPerCube
      const nextMult = 1 + nextEff * hpPerCube
      const ratio = nextMult / prevMult
      const oldMax = m.maxHp
      m.maxHp *= ratio
      m.hp += m.maxHp - oldMax
    }
    const sizeScale = 1 + m.cubes * sizePerCube
    m.stats.eye_height = this.cfg.mech.eye_height * sizeScale
    m.stats.muzzle_height = this.cfg.mech.muzzle_height * sizeScale
    m.events.push({ type: "pickup", cubes: m.cubes })

    const thresholds = this.cfg.cubes.upgrade_thresholds
    if (!m.offer && m.nextThresholdIdx < thresholds.length && m.cubes >= thresholds[m.nextThresholdIdx]) {
      m.nextThresholdIdx++
      const heldKinds = new Set(m.weapons.filter((w): w is WeaponState => w !== null).map((w) => w.kind))
      const avail = this.cfg.upgrades.filter(
        (u) => (!u.requires || heldKinds.has(u.requires)) && (m.upgradeCounts.get(u.id) ?? 0) < u.max
      )
      if (avail.length > 0) {
        const choices: UpgradeDef[] = []
        const pool = [...avail]
        while (choices.length < 3 && pool.length > 0) {
          const idx = this.rng.int(0, pool.length)
          choices.push(pool.splice(idx, 1)[0])
        }
        m.offer = {
          id: this.nextEntityId++,
          expires: this.t + this.cfg.bot.offer_timeout_s,
          choices: choices.map((c) => ({ id: c.id, name: c.name, desc: c.desc })),
        }
      }
    }
  }

  private applyUpgrade(m: MechState, upgId: string): void {
    const def = this.cfg.upgrades.find((u) => u.id === upgId)
    if (!def) return
    m.upgrades.push(def.id)
    m.upgradeCounts.set(def.id, (m.upgradeCounts.get(def.id) ?? 0) + 1)
    for (const eff of def.effects) {
      const [scope, sub, key] = eff.path.split(".")
      if (scope === "mech" && sub) {
        const cur = m.stats[sub] ?? 0
        m.stats[sub] = eff.mul !== undefined ? cur * eff.mul : cur + (eff.add ?? 0)
        if (sub === "hp") {
          const prev = m.maxHp
          m.maxHp = m.maxHp * (eff.mul ?? 1)
          m.hp += m.maxHp - prev
        }
        if (sub === "energy") {
          m.maxEnergy = m.stats.energy
        }
      } else if (scope === "weapons" && sub && key) {
        for (const w of m.weapons) {
          if (w && w.kind === sub) {
            const cur = w.stats[key] ?? 0
            w.stats[key] = eff.mul !== undefined ? cur * eff.mul : cur + (eff.add ?? 0)
          }
        }
      }
    }
    m.events.push({ type: "upgrade", id: def.id })
  }

  private stepPhysics(dt: number): void {
    const dmgScale = (m: MechState) =>
      1 + Math.min(m.cubes, Number(this.cfg.cubes.stat_cap)) * Number(this.cfg.cubes.damage_per_cube)

    // 1. Mechs movement, aim, weapons, regen, zone
    const phase = this.cfg.zone.phases[Math.min(this.zonePhaseIdx, this.cfg.zone.phases.length - 1)]
    for (const m of this.mechs) {
      if (!m.alive) continue
      const act = m.lastAction

      // Offer expiry / pick
      if (m.offer && this.t >= m.offer.expires) {
        const chosen = m.offer.choices[0]
        m.offer = null
        if (chosen) this.applyUpgrade(m, chosen.id)
      }

      // Aim slew
      if (act.aim) {
        m.aim[0] = moveTowardsAngle(m.aim[0], act.aim[0], m.stats.turn_rate * dt)
        const tgtPitch = clamp(act.aim[1], m.stats.min_pitch, m.stats.max_pitch)
        const dp = tgtPitch - m.aim[1]
        const maxP = m.stats.pitch_rate * dt
        m.aim[1] = Math.abs(dp) <= maxP ? tgtPitch : m.aim[1] + Math.sign(dp) * maxP
      }

      // Move & boost/jet
      const move = act.move ?? [0, 0]
      let mx = move[0], my = move[1]
      const mlen = Math.hypot(mx, my)
      if (mlen > 1) {
        mx /= mlen
        my /= mlen
      }
      const charging = m.weapons.some((w) => w?.kind === "laser" && w.charge > 0)
      const boosting = Boolean(act.boost) && m.energy > 0
      const speed = (boosting && m.grounded && mlen > 0.05 ? m.stats.boost_speed : m.stats.walk_speed) * (charging ? m.stats.charge_move_mult : 1)
      const accel = m.grounded ? m.stats.ground_accel : m.stats.air_accel
      const dvx = mx * speed - m.vel[0]
      const dvy = my * speed - m.vel[1]
      const dvLen = Math.hypot(dvx, dvy)
      const maxDv = accel * dt
      if (dvLen <= maxDv) {
        m.vel[0] = mx * speed
        m.vel[1] = my * speed
      } else {
        m.vel[0] += (dvx / dvLen) * maxDv
        m.vel[1] += (dvy / dvLen) * maxDv
      }

      if (act.jump && m.grounded) {
        m.vel[2] = m.stats.jump_speed
        m.grounded = false
      }
      if (!m.grounded && boosting) {
        m.vel[2] = Math.min(m.stats.max_rise_speed, m.vel[2] + m.stats.jet_accel * dt)
        m.energy = Math.max(0, m.energy - m.stats.jet_drain * dt)
        m.energyRegenDelay = m.stats.energy_regen_delay
      } else if (m.grounded && boosting && mlen > 0.05) {
        m.energy = Math.max(0, m.energy - m.stats.boost_drain * dt)
        m.energyRegenDelay = m.stats.energy_regen_delay
      } else {
        if (m.energyRegenDelay > 0) m.energyRegenDelay -= dt
        else m.energy = Math.min(m.maxEnergy, m.energy + m.stats.energy_regen * dt)
      }

      m.vel[2] -= m.stats.gravity * dt
      const [nx, ny] = this.world.resolveMove(
        m.pos[0], m.pos[1],
        m.pos[0] + m.vel[0] * dt, m.pos[1] + m.vel[1] * dt,
        m.pos[2], m.stats.radius, m.stats.height, m.stats.step_up
      )
      m.pos[0] = nx
      m.pos[1] = ny
      m.pos[2] += m.vel[2] * dt

      const surfZ = this.world.surfaceZAt(m.pos[0], m.pos[1], m.pos[2])
      if (m.pos[2] <= surfZ) {
        m.pos[2] = surfZ
        m.vel[2] = 0
        m.grounded = true
      } else {
        m.grounded = false
      }

      // Footstep / boost sound
      if (m.grounded && Math.hypot(m.vel[0], m.vel[1]) > this.cfg.sound.step_speed) {
        m.stepTimer -= dt
        if (m.stepTimer <= 0) {
          m.stepTimer = this.cfg.sound.step_every
          this.emitSound(boosting ? "boost" : "step", m.pos, m.id)
        }
      }

      // Weapons tick
      for (let s = 0; s < 2; s++) {
        const w = m.weapons[s]
        if (!w) continue
        if (w.cooldown > 0) w.cooldown = Math.max(0, w.cooldown - dt)
        if (w.shortTimer > 0) w.shortTimer = Math.max(0, w.shortTimer - dt)
        if (w.reload > 0) {
          w.reload -= dt
          if (w.reload <= 0) {
            w.reload = 0
            w.ammo = w.stats.mag
          }
        }

        const wantFire = Boolean(act.fire?.[s])
        if (w.kind === "gun") {
          if (wantFire && w.cooldown <= 0 && w.reload <= 0 && w.ammo > 0) {
            w.ammo--
            w.cooldown = w.stats.cooldown
            const d = dirFromAim(m.aim)
            const muzzle: Vec3 = [m.pos[0] + d[0] * 3, m.pos[1] + d[1] * 3, m.pos[2] + m.stats.muzzle_height + d[2] * 3]
            this.projectiles.push({
              id: this.nextEntityId++,
              ownerId: m.id,
              kind: "gun",
              pos: muzzle,
              vel: [d[0] * w.stats.speed, d[1] * w.stats.speed, d[2] * w.stats.speed],
              damage: w.stats.damage * dmgScale(m),
              gravity: 0,
              ttl: w.stats.range / w.stats.speed,
              rangeLeft: w.stats.range,
            })
            this.emitSound("gun", muzzle, m.id)
            if (w.ammo === 0) {
              w.reload = w.stats.reload
              this.emitSound("reload", m.pos, m.id)
            }
          }
        } else if (w.kind === "mortar") {
          if (wantFire && w.cooldown <= 0) {
            w.cooldown = w.stats.cooldown
            const d = dirFromAim(m.aim)
            const muzzle: Vec3 = [m.pos[0] + d[0] * 3, m.pos[1] + d[1] * 3, m.pos[2] + m.stats.height + 0.5]
            this.projectiles.push({
              id: this.nextEntityId++,
              ownerId: m.id,
              kind: "mortar",
              pos: muzzle,
              vel: [d[0] * w.stats.speed, d[1] * w.stats.speed, d[2] * w.stats.speed],
              damage: w.stats.damage * dmgScale(m),
              gravity: w.stats.gravity,
              ttl: w.stats.ttl,
              rangeLeft: 1000,
              splash: w.stats.splash * dmgScale(m),
              splashRadius: w.stats.splash_radius,
              splashEdge: w.stats.splash_edge,
              knock: w.stats.knock,
              knockUp: w.stats.knock_up,
              drain: w.stats.drain,
            })
            this.emitSound("mortar", muzzle, m.id)
          }
        } else if (w.kind === "laser") {
          if (wantFire && w.cooldown <= 0 && w.shortTimer <= 0) {
            if (w.charge === 0) this.emitSound("laser_charge", m.pos, m.id)
            w.charge += dt
            if (w.charge >= w.stats.charge + w.stats.hold_s) {
              this.fireLaser(m, w, dmgScale(m))
            }
          } else if (w.charge > 0) {
            if (w.charge >= w.stats.min_charge) {
              this.fireLaser(m, w, dmgScale(m))
            } else {
              w.charge = 0
            }
          }
        } else if (w.kind === "lightning") {
          if (wantFire && w.cooldown <= 0 && m.energy >= w.stats.energy) {
            m.energy -= w.stats.energy
            m.energyRegenDelay = m.stats.energy_regen_delay
            w.cooldown = w.stats.cooldown
            this.fireLightning(m, w, dmgScale(m))
          }
        }
      }

      // Zone & HP regen
      const inZone = dist2(m.pos, this.zoneCenter) <= this.zoneRadius
      if (!inZone) {
        this.damageMech(m, phase.dps * dt, "zone", null, null)
      } else if (this.t - m.lastCombatT >= m.stats.regen_delay && m.hp < m.maxHp) {
        m.hp = Math.min(m.maxHp, m.hp + m.stats.regen_per_s * dt)
      }

      // Cube pickup
      const cubePickupR = Number(this.cfg.cubes.pickup_radius)
      for (const cube of this.cubes) {
        if (!cube.alive) continue
        if (dist2(m.pos, cube.pos) <= cubePickupR && Math.abs(m.pos[2] - cube.pos[2]) <= 4) {
          cube.alive = false
          this.grantCubes(m, 1)
        }
      }
    }

    // 2. Projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i]
      p.ttl -= dt
      p.vel[2] -= p.gravity * dt
      const nextPos: Vec3 = [p.pos[0] + p.vel[0] * dt, p.pos[1] + p.vel[1] * dt, p.pos[2] + p.vel[2] * dt]
      const segLen = dist3(p.pos, nextPos)
      p.rangeLeft -= segLen

      let hitMech: MechState | null = null
      for (const m of this.mechs) {
        if (!m.alive || m.id === p.ownerId) continue
        if (dist2(nextPos, m.pos) <= m.stats.radius + 0.5 && nextPos[2] >= m.pos[2] && nextPos[2] <= m.pos[2] + m.stats.height) {
          hitMech = m
          break
        }
      }

      let hitCrate: SimCrate | null = null
      if (!hitMech) {
        for (const c of this.crates) {
          if (!c.alive) continue
          if (dist2(nextPos, c.pos) <= this.cfg.crates.radius + 0.5 && nextPos[2] >= c.pos[2] && nextPos[2] <= c.pos[2] + this.cfg.crates.height) {
            hitCrate = c
            break
          }
        }
      }

      let hitNpc: SimNpc | null = null
      if (!hitMech && !hitCrate && p.kind !== "npc") {
        for (const npc of this.npcs) {
          if (!npc.alive) continue
          if (dist2(nextPos, npc.pos) <= this.cfg.npc.radius + 0.5 && nextPos[2] >= npc.pos[2] && nextPos[2] <= npc.pos[2] + this.cfg.npc.height) {
            hitNpc = npc
            break
          }
        }
      }

      const hitWorld = this.world.raycastShot(p.pos, nextPos) !== null
      if (hitMech || hitCrate || hitNpc || hitWorld || p.ttl <= 0 || p.rangeLeft <= 0) {
        if (p.kind === "mortar") {
          this.explodeMortar(p, nextPos, hitMech)
        } else {
          if (hitMech) this.damageMech(hitMech, p.damage, p.kind, p.pos, p.ownerId >= 0 ? p.ownerId : null)
          if (hitCrate) this.damageCrate(hitCrate, p.damage, p.ownerId)
          if (hitNpc) this.damageNpc(hitNpc, p.damage, p.ownerId)
        }
        this.projectiles.splice(i, 1)
      } else {
        p.pos = nextPos
      }
    }

    // 3. NPCs
    for (const npc of this.npcs) {
      if (!npc.alive) continue
      if (npc.cooldown > 0) npc.cooldown -= dt
      let bestTarget: MechState | null = null
      let bestDist = this.cfg.npc.aggro_range
      for (const m of this.mechs) {
        if (!m.alive) continue
        const d = dist3(npc.pos, m.pos)
        if (d < bestDist && this.world.hasShotLOS([npc.pos[0], npc.pos[1], npc.pos[2] + 2], [m.pos[0], m.pos[1], m.pos[2] + 4.5])) {
          bestDist = d
          bestTarget = m
        }
      }
      if (bestTarget && npc.cooldown <= 0) {
        npc.cooldown = this.cfg.npc.cooldown
        const dx = bestTarget.pos[0] - npc.pos[0], dy = bestTarget.pos[1] - npc.pos[1]
        const dz = bestTarget.pos[2] + 4.5 - (npc.pos[2] + 2)
        const d = Math.hypot(dx, dy, dz) || 1
        const spd = this.cfg.npc.projectile_speed
        this.projectiles.push({
          id: this.nextEntityId++,
          ownerId: -1,
          kind: "npc",
          pos: [npc.pos[0], npc.pos[1], npc.pos[2] + 2],
          vel: [(dx / d) * spd, (dy / d) * spd, (dz / d) * spd],
          damage: this.cfg.npc.damage,
          gravity: 0,
          ttl: 2,
          rangeLeft: 180,
        })
        this.emitSound("npc_gun", npc.pos)
      }
    }

    // 4. Supply drops
    const dropTimes = this.cfg.drops?.times ?? []
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i]
      if (d.captured) continue
      if (!d.called && this.t >= dropTimes[i]) {
        d.called = true
      }
      if (!d.called) continue
      if (d.landsIn > 0) {
        d.landsIn = Math.max(0, d.landsIn - dt)
        if (d.landsIn === 0) this.emitSound("drop", d.pos)
        continue
      }
      const inRing = this.mechs.filter((m) => m.alive && dist2(m.pos, d.pos) <= (this.cfg.drops?.radius ?? 8))
      if (inRing.length === 1) {
        const cap = inRing[0]
        if (d.holder !== cap.id) {
          d.holder = cap.id
          d.progress = 0
        }
        d.progress += dt
        if (d.progress >= (this.cfg.drops?.capture_s ?? 4)) {
          d.captured = true
          cap.hp = cap.maxHp
          cap.energy = cap.maxEnergy
          this.grantCubes(cap, this.cfg.drops?.cubes ?? 3)
          cap.events.push({ type: "drop", id: d.id, cubes: cap.cubes })
        }
      } else if (inRing.length === 0) {
        d.holder = null
        d.progress = 0
      }
    }

    // 5. Zone shrink
    this.phaseElapsed += dt
    if (this.phaseElapsed > phase.hold_s && this.phaseElapsed <= phase.hold_s + phase.shrink_s) {
      const u = (this.phaseElapsed - phase.hold_s) / Math.max(0.01, phase.shrink_s)
      const prevPhase = this.zonePhaseIdx === 0 ? this.cfg.zone.start_radius : this.cfg.zone.phases[this.zonePhaseIdx - 1].radius
      this.zoneRadius = prevPhase + (this.nextZoneRadius - prevPhase) * u
    } else if (this.phaseElapsed > phase.hold_s + phase.shrink_s && this.zonePhaseIdx < this.cfg.zone.phases.length - 1) {
      this.zonePhaseIdx++
      this.phaseElapsed = 0
      this.zoneCenter = [...this.nextZoneCenter] as Vec2
      this.zoneRadius = this.nextZoneRadius
      const nextP = this.cfg.zone.phases[this.zonePhaseIdx]
      this.nextZoneRadius = nextP.radius
      this.nextZoneCenter = this.pickNextZoneCenter(this.zoneCenter, this.zoneRadius, nextP.radius)
    }
  }

  private fireLaser(m: MechState, w: WeaponState, dmgScale: number): void {
    const frac = clamp(w.charge / w.stats.charge, w.stats.min_frac, 1)
    const dmg = w.stats.damage * frac * dmgScale
    w.charge = 0
    w.cooldown = w.stats.cooldown

    const d = dirFromAim(m.aim)
    const muzzle: Vec3 = [m.pos[0] + d[0] * 3, m.pos[1] + d[1] * 3, m.pos[2] + m.stats.muzzle_height + d[2] * 3]
    const maxEnd: Vec3 = [muzzle[0] + d[0] * w.stats.range, muzzle[1] + d[1] * w.stats.range, muzzle[2] + d[2] * w.stats.range]
    const wallT = this.world.raycastShot(muzzle, maxEnd)
    const maxDist = wallT !== null ? wallT * w.stats.range : w.stats.range
    const end: Vec3 = [muzzle[0] + d[0] * maxDist, muzzle[1] + d[1] * maxDist, muzzle[2] + d[2] * maxDist]

    // Find closest mech/crate/npc along ray
    let bestT = maxDist
    let hitTarget: MechState | null = null
    for (const other of this.mechs) {
      if (!other.alive || other.id === m.id) continue
      if (this.mode === "1v15" && m.id > 0 && other.id > 0) continue
      const ox = other.pos[0] - muzzle[0], oy = other.pos[1] - muzzle[1], oz = other.pos[2] + 4.5 - muzzle[2]
      const proj = ox * d[0] + oy * d[1] + oz * d[2]
      if (proj < 0 || proj > bestT) continue
      const perp = Math.hypot(ox - d[0] * proj, oy - d[1] * proj, oz - d[2] * proj)
      if (perp <= other.stats.radius + 0.8) {
        bestT = proj
        hitTarget = other
      }
    }
    if (hitTarget) {
      const hasMortar = hitTarget.weapons.some((wp) => wp?.kind === "mortar")
      const mult = hasMortar ? 1 + w.stats.cookoff : 1
      this.damageMech(hitTarget, dmg * mult, "laser", muzzle, m.id)
      if (hasMortar) {
        hitTarget.events.push({ type: "effect", effect: "cookoff", by: m.id })
      }
    }

    for (const obsM of this.mechs) {
      if (obsM.alive && obsM.id !== m.id && dist3(obsM.pos, muzzle) <= 280) {
        obsM.beams.push({ by: m.id, kind: "laser", path: [muzzle, end], age: 0 })
      }
    }
    this.emitSound("laser", muzzle, m.id)
  }

  private fireLightning(m: MechState, w: WeaponState, dmgScale: number): void {
    const dmg = w.stats.damage * dmgScale
    const muzzle: Vec3 = [m.pos[0], m.pos[1], m.pos[2] + m.stats.muzzle_height]
    const coneRad = ((w.stats.cone_deg * Math.PI) / 180) * 0.5
    let best: MechState | null = null
    let bestD = w.stats.range
    for (const other of this.mechs) {
      if (!other.alive || other.id === m.id) continue
      if (this.mode === "1v15" && m.id > 0 && other.id > 0) continue
      const d = dist3(muzzle, other.pos)
      if (d > bestD) continue
      const yaw = Math.atan2(other.pos[1] - muzzle[1], other.pos[0] - muzzle[0])
      if (Math.abs(wrapAngle(yaw - m.aim[0])) <= coneRad && this.world.hasShotLOS(muzzle, [other.pos[0], other.pos[1], other.pos[2] + 4.5])) {
        bestD = d
        best = other
      }
    }
    const path: Vec3[] = [muzzle]
    if (best) {
      path.push([best.pos[0], best.pos[1], best.pos[2] + 4.5])
      this.damageMech(best, dmg, "lightning", muzzle, m.id)
      const laserW = best.weapons.find((wp) => wp?.kind === "laser")
      if (laserW) {
        laserW.charge = 0
        laserW.shortTimer = w.stats.short_s
        best.events.push({ type: "effect", effect: "short", by: m.id })
      }
    } else {
      const dir = dirFromAim(m.aim)
      path.push([muzzle[0] + dir[0] * w.stats.range, muzzle[1] + dir[1] * w.stats.range, muzzle[2] + dir[2] * w.stats.range])
    }
    for (const obsM of this.mechs) {
      if (obsM.alive && obsM.id !== m.id && dist3(obsM.pos, muzzle) <= 220) {
        obsM.beams.push({ by: m.id, kind: "lightning", path, age: 0 })
      }
    }
    this.emitSound("lightning", muzzle, m.id)
  }

  private explodeMortar(p: SimProjectile, at: Vec3, directMech: MechState | null): void {
    this.emitSound("explosion", at)
    const r = p.splashRadius ?? 7
    const edge = p.splashEdge ?? 0.3
    for (const m of this.mechs) {
      if (!m.alive) continue
      if (m === directMech) {
        this.damageMech(m, p.damage, "mortar", at, p.ownerId)
      }
      const d = dist3(at, [m.pos[0], m.pos[1], m.pos[2] + 4.5])
      if (d <= r && this.world.hasShotLOS(at, [m.pos[0], m.pos[1], m.pos[2] + 4.5])) {
        const falloff = 1 - (1 - edge) * (d / r)
        if (m !== directMech) {
          this.damageMech(m, (p.splash ?? 160) * falloff, "mortar", at, p.ownerId)
        }
        const dx = m.pos[0] - at[0], dy = m.pos[1] - at[1]
        const h = Math.hypot(dx, dy) || 1
        m.vel[0] += (dx / h) * (p.knock ?? 16) * falloff
        m.vel[1] += (dy / h) * (p.knock ?? 16) * falloff
        m.vel[2] += (p.knockUp ?? 9) * falloff
        m.energy = Math.max(0, m.energy - (p.drain ?? 45) * falloff)
        m.events.push({ type: "effect", effect: "concuss", by: p.ownerId })
      }
    }
  }

  private damageCrate(c: SimCrate, amount: number, attackerId: number): void {
    c.hp -= amount
    this.emitSound("crate", c.pos)
    if (attackerId >= 0 && this.mechs[attackerId]) {
      this.mechs[attackerId].events.push({ type: "hit", target: c.id, amount, weapon: "gun" })
    }
    if (c.hp <= 0) {
      c.alive = false
      this.cubes.push({ id: 5000 + this.nextEntityId++, pos: [...c.pos] as Vec3, alive: true })
      if (this.rng.next() < this.cfg.loot.crate_weapon_chance) {
        const kinds: WeaponKind[] = ["mortar", "laser", "lightning"]
        this.pickups.push({
          id: 8000 + this.nextEntityId++,
          kind: kinds[this.rng.int(0, kinds.length)],
          pos: [...c.pos] as Vec3,
          ammo: 0,
          cooldown: 0,
          alive: true,
        })
      }
    }
  }

  private damageNpc(npc: SimNpc, amount: number, attackerId: number): void {
    npc.hp -= amount
    if (attackerId >= 0 && this.mechs[attackerId]) {
      this.mechs[attackerId].events.push({ type: "hit", target: npc.id, amount, weapon: "gun" })
    }
    if (npc.hp <= 0) {
      npc.alive = false
      for (let i = 0; i < this.cfg.npc.cubes; i++) {
        this.cubes.push({
          id: 5000 + this.nextEntityId++,
          pos: [npc.pos[0] + this.rng.range(-1, 1), npc.pos[1] + this.rng.range(-1, 1), npc.pos[2]],
          alive: true,
        })
      }
    }
  }

  private applyOneShotAction(m: MechState, act: Action): void {
    if (act.pick !== undefined && m.offer) {
      const ch = m.offer.choices[act.pick]
      if (ch) {
        m.offer = null
        this.applyUpgrade(m, ch.id)
      }
    }
    if (act.reload) {
      const g = m.weapons.find((w) => w?.kind === "gun")
      if (g && g.reload <= 0 && g.ammo < g.stats.mag) {
        g.reload = g.stats.reload
        this.emitSound("reload", m.pos, m.id)
      }
    }
    if (act.take !== undefined) {
      const p = this.pickups.find((pk) => pk.id === act.take && pk.alive)
      if (!p) {
        m.events.push({ type: "take_failed", id: act.take, reason: "gone" })
      } else if (dist2(m.pos, p.pos) > this.cfg.loot.pickup_radius || Math.abs(m.pos[2] - p.pos[2]) > 4) {
        m.events.push({ type: "take_failed", id: act.take, reason: "range" })
      } else if (m.weapons.some((w) => w?.kind === p.kind)) {
        m.events.push({ type: "take_failed", id: act.take, reason: "have" })
      } else {
        const slot = act.drop !== undefined ? act.drop : m.weapons[0] === null ? 0 : m.weapons[1] === null ? 1 : -1
        if (slot < 0 || slot > 1) {
          m.events.push({ type: "take_failed", id: act.take, reason: "full" })
        } else {
          const old = m.weapons[slot]
          if (old && old.kind === "laser" && old.charge > 0) {
            m.events.push({ type: "take_failed", id: act.take, reason: "busy" })
          } else {
            p.alive = false
            if (old) {
              const dropId = 8000 + this.nextEntityId++
              this.pickups.push({ id: dropId, kind: old.kind, pos: [...m.pos] as Vec3, ammo: old.ammo, cooldown: old.cooldown, alive: true })
              m.events.push({ type: "dropped", id: dropId, kind: old.kind, slot })
            }
            const nw = this.makeWeapon(p.kind)
            nw.cooldown = Math.max(this.cfg.loot.equip_s, p.cooldown)
            if (p.kind === "gun" && p.ammo > 0) nw.ammo = p.ammo
            m.weapons[slot] = nw
            m.events.push({ type: "took", id: p.id, kind: p.kind, slot })
          }
        }
      }
    } else if (act.drop !== undefined && (act.drop === 0 || act.drop === 1)) {
      const old = m.weapons[act.drop]
      if (old && !(old.kind === "laser" && old.charge > 0)) {
        m.weapons[act.drop] = null
        const dropId = 8000 + this.nextEntityId++
        this.pickups.push({ id: dropId, kind: old.kind, pos: [...m.pos] as Vec3, ammo: old.ammo, cooldown: old.cooldown, alive: true })
        m.events.push({ type: "dropped", id: dropId, kind: old.kind, slot: act.drop })
      }
    }
  }

  async run(matchIndex: number, maxTicks: number, targetSlots: Set<number>): Promise<MatchResult> {
    const dt = 1 / this.cfg.match.tick_hz
    const decideEvery = this.cfg.match.decide_every

    while (this.aliveCount > 1 && this.tick < maxTicks && (this.mode !== "1v15" || this.mechs[0].alive)) {
      if (this.tick % decideEvery === 0) {
        const aliveMechs = this.mechs.filter((m) => m.alive)
        await Promise.all(
          aliveMechs.map(async (m) => {
            const obs = this.buildObs(m)
            if (m.client) {
              const { action, latencyMs } = await m.client.decide(obs, Math.max(200, this.cfg.bot.tick_budget_ms * 4))
              if (targetSlots.has(m.id)) this.targetLatenciesMs.push(latencyMs)
              if (action) {
                m.lastAction = action
                m.missedDecisionS = 0
                this.applyOneShotAction(m, action)
              } else {
                m.missedDecisionS += decideEvery * dt
                if (m.missedDecisionS > this.cfg.bot.coast_s) {
                  m.lastAction = { tick: this.tick }
                }
              }
            } else {
              const act = houseBotAct(obs, this.rng, this.mode === "1v15" && m.id > 0)
              m.lastAction = act
              this.applyOneShotAction(m, act)
            }
          })
        )
      }

      this.stepPhysics(dt)
      this.tick++
      this.t += dt
    }

    // Rank remaining survivors by HP descending
    const survivors = this.mechs.filter((m) => m.alive).sort((a, b) => b.hp - a.hp)
    for (let i = 0; i < survivors.length; i++) {
      survivors[i].place = i + 1
    }

    for (const m of this.mechs) {
      if (m.client) m.client.finish(m.place, m.kills)
    }

    return {
      matchIndex,
      ticks: this.tick,
      durationS: Number(this.t.toFixed(1)),
      placements: this.mechs.map((m) => ({
        slot: m.id,
        name: m.client ? m.client.name : `house-${m.id}`,
        place: m.place,
        kills: m.kills,
        score: 16 - m.place,
        isTarget: targetSlots.has(m.id),
      })),
      targetLatenciesMs: this.targetLatenciesMs,
    }
  }
}

// ---------------------------------------------------------------------------
// Benchmark Runner & CLI
// ---------------------------------------------------------------------------

export interface BenchmarkOptions {
  mode: "1v15" | "ffa"
  matches: number
  botCmd: string
  houseCmd: string | null
  arenaDir: string
  seed: number
  maxTicks: number
  quiet: boolean
}

export async function runBenchmark(opts: BenchmarkOptions): Promise<void> {
  const world = new SimWorld(opts.arenaDir)
  const cfg = DEFAULT_CONFIG
  const allScores: number[] = []
  const allKills: number[] = []
  const allPlaces: number[] = []
  const allLatencies: number[] = []
  let wins = 0

  for (let mIdx = 0; mIdx < opts.matches; mIdx++) {
    const matchSeed = opts.seed + mIdx * 997
    const match = new ArenaMatch(world, matchSeed, cfg, opts.mode)
    const clients: Array<ExternalBotClient | null> = []
    const targetSlots = new Set<number>()

    if (opts.mode === "1v15") {
      targetSlots.add(0)
      for (let s = 0; s < cfg.match.mechs; s++) {
        if (s === 0) {
          clients.push(new ExternalBotClient(s, opts.botCmd))
        } else if (opts.houseCmd) {
          clients.push(new ExternalBotClient(s, opts.houseCmd))
        } else {
          clients.push(null)
        }
      }
    } else {
      for (let s = 0; s < cfg.match.mechs; s++) {
        targetSlots.add(s)
        clients.push(new ExternalBotClient(s, opts.botCmd))
      }
    }

    // Handshake all external bots
    await Promise.all(
      clients.map(async (c, slot) => {
        if (!c) return
        const hello: Hello = {
          type: "hello",
          protocol: "mechfight/1",
          slot,
          seed: (matchSeed + slot * 7919) >>> 0,
          map: { dir: resolve(opts.arenaDir), files: ["v2/world.json", "v2/terrain.i16"] },
          config: cfg,
        }
        const ok = await c.handshake(hello, cfg.bot.hello_budget_ms)
        if (!ok) {
          console.error(`[sim] Match ${mIdx + 1}: bot slot ${slot} failed handshake`)
        }
      })
    )

    await match.setup(clients)
    const res = await match.run(mIdx, opts.maxTicks, targetSlots)

    for (const p of res.placements) {
      if (p.isTarget) {
        allScores.push(p.score)
        allKills.push(p.kills)
        allPlaces.push(p.place)
        if (p.place === 1) wins++
      }
    }
    allLatencies.push(...res.targetLatenciesMs)

    if (!opts.quiet) {
      const targetRow = res.placements.find((p) => p.isTarget)
      console.log(
        `Match ${mIdx + 1}/${opts.matches} (${res.durationS}s, ${res.ticks} ticks): ` +
          `place=${targetRow?.place ?? "?"} score=${targetRow?.score ?? "?"} kills=${targetRow?.kills ?? 0}`
      )
    }
  }

  allLatencies.sort((a, b) => a - b)
  const mean = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
  console.log("\n=== Mech Royale Arena Sim Summary ===")
  console.log(`Mode: ${opts.mode} | Matches: ${opts.matches} | Bot: ${opts.botCmd}`)
  console.log(`Mean Score (16 - place): ${mean(allScores).toFixed(2)} / 15.00`)
  console.log(`Mean Place: ${mean(allPlaces).toFixed(2)} | Win Rate: ${((wins / Math.max(1, allPlaces.length)) * 100).toFixed(1)}% | Mean Kills: ${mean(allKills).toFixed(2)}`)
  console.log(
    `Tick Latency (ms): p50=${percentile(allLatencies, 50).toFixed(2)} ` +
      `p95=${percentile(allLatencies, 95).toFixed(2)} ` +
      `p99=${percentile(allLatencies, 99).toFixed(2)} ` +
      `max=${(allLatencies[allLatencies.length - 1] ?? 0).toFixed(2)} (n=${allLatencies.length})`
  )
}

function parseArgs(argv: string[]): BenchmarkOptions {
  const opts: BenchmarkOptions = {
    mode: "1v15",
    matches: 3,
    botCmd: "node dist/bot.js",
    houseCmd: null,
    arenaDir: "mechfight-kit/arena",
    seed: 12345,
    maxTicks: DEFAULT_CONFIG.match.duration_s * DEFAULT_CONFIG.match.tick_hz,
    quiet: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--mode" && argv[i + 1]) opts.mode = argv[++i] as "1v15" | "ffa"
    else if (a === "--matches" && argv[i + 1]) opts.matches = Number(argv[++i])
    else if (a === "--bot" && argv[i + 1]) opts.botCmd = argv[++i]
    else if (a === "--house" && argv[i + 1]) opts.houseCmd = argv[++i]
    else if (a === "--arena" && argv[i + 1]) opts.arenaDir = argv[++i]
    else if (a === "--seed" && argv[i + 1]) opts.seed = Number(argv[++i])
    else if (a === "--max-ticks" && argv[i + 1]) opts.maxTicks = Number(argv[++i])
    else if (a === "--quiet") opts.quiet = true
  }
  return opts
}

const isEntrypoint = process.argv[1]?.endsWith("arena_sim.ts") || process.argv[1]?.endsWith("sim.js")
if (isEntrypoint) {
  runBenchmark(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
