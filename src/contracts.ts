import type {
  ActorObs,
  Config,
  Hello,
  Observation,
  Vec2,
  Vec3,
  WeaponKind,
} from "./mechfight.ts"

export type { Vec2, Vec3, WeaponKind, ActorObs, Config, Hello, Observation }

export interface WorldQuery {
  /** Bilinear terrain height at (x, y) in meters. */
  heightAt(x: number, y: number): number
  /** Terrain slope in degrees at (x, y). */
  slopeAt(x: number, y: number): number
  /** True if a shot from a to b is NOT blocked by terrain or prisms (trees do NOT block shots). */
  hasShotLOS(a: Vec3, b: Vec3): boolean
  /** True if vision from a to b is NOT blocked by terrain, prisms, or tree trunks/dense canopy. */
  hasVisionLOS(a: Vec3, b: Vec3): boolean
  /** Return walkable/jettable surface Z at (x, y), or terrain Z if no roof/bridge. */
  surfaceZAt(x: number, y: number, currentZ: number): number
  /** True if a mech cylinder at (x, y, currentZ) is clear of blocking prisms/overhangs and steep terrain slopes. */
  isPointWalkable(
    x: number,
    y: number,
    currentZ: number,
    mechRadius?: number,
    mechHeight?: number,
  ): boolean
  /** True if a straight horizontal walk segment from `from` to `to` is free of walls/ledges/steep slopes. */
  hasDirectWalkLine(
    from: Vec3,
    to: Vec3,
    mechRadius?: number,
    mechHeight?: number,
  ): boolean
  /** Snap an arbitrary (x, y) (e.g. clamped zone point) out of solid buildings to the nearest walkable cell. */
  snapToWalkable(
    x: number,
    y: number,
    currentZ: number,
    mechRadius?: number,
  ): Vec3
  /** Find a path of waypoints from `from` to `to` on the 4m navgrid (node-capped). */
  findPath(
    from: Vec3,
    to: Vec3,
    canJetOrMaxClimb: boolean | number,
    wantRoof?: boolean,
  ): Vec3[]
  /** Find a nearby BFS-reachable cover position within `radius` that blocks shot LOS from `threats`. Returns null if no cell reduces exposure. */
  findCover(
    pos: Vec3,
    threats: Vec3[],
    radius: number,
    isSafe?: (x: number, y: number) => boolean,
    eyeHeight?: number,
    prevCover?: Vec3 | null,
    mechRadius?: number,
  ): Vec3 | null
  /** Find a BFS-reachable "slice-the-pie" corner cell within `radius` that HAS shot LOS to `targetPos` while blocking shot LOS from `otherThreats`. */
  findPeekCover(
    pos: Vec3,
    targetPos: Vec3,
    otherThreats: Vec3[],
    radius: number,
    isSafe?: (x: number, y: number) => boolean,
    eyeHeight?: number,
    prevCover?: Vec3 | null,
    mechRadius?: number,
    optRange?: number,
  ): Vec3 | null
  /** Find a defensible safe-zone rooftop (10-26m sweet-spot height, wide area, penthouse bonus) within `maxDist`. */
  findRooftopSpot(
    pos: Vec3,
    zoneCenter: Vec2,
    zoneRadius: number,
    maxDist: number,
    threats: Vec3[],
  ): Vec3 | null
  /** Stay on the connected roof: when attacking (targetPos != null), enforce pitch >= minPitch + 0.05 and minimize exposure to otherThreats; when healing (targetPos == null), step recessed / behind penthouse. */
  findRoofCombatSpot(
    pos: Vec3,
    targetPos: Vec3 | null,
    otherThreats: Vec3[],
    optRange: number,
    isSafe?: (x: number, y: number) => boolean,
    eyeHeight?: number,
    minPitch?: number,
    prevCover?: Vec3 | null,
  ): Vec3 | null
  /** Emergency roof-escape for regen_hide: scan precomputed rooftops (10-maxRelH tall) within maxEdgeDist of pos that are safe and unoccupied. */
  findEmergencyRoofEscape(
    pos: Vec3,
    maxRelH: number,
    maxEdgeDist: number,
    threats: Vec3[],
    isSafe?: (x: number, y: number) => boolean,
    eyeHeight?: number,
  ): Vec3 | null
}

export interface TrackedEnemy {
  id: number
  kind: "mech" | "npc"
  pos: Vec3
  vel: Vec3
  aim: Vec2
  hp: number
  maxHp: number
  cubes: number
  weapons: WeaponKind[]
  charging: boolean
  lastSeenT: number
  /** 1.0 when currently visible, decaying for memory_s / sound-only ghosts. */
  confidence: number
}

export interface ThreatState {
  enemies: TrackedEnemy[]
  /** Normalized 2D dodge vector away from incoming projectiles / charging lasers, or [0, 0]. */
  dodgeVec: Vec2
  /** Urgency of dodge in [0, 1]. */
  dodgeUrgency: number
  /** True when a late anti-laser juke recommends jumping. */
  wantJump: boolean
  /** True when an enemy laser is actively charging at us (or laser_charge heard nearby). */
  chargingLaserThreat: boolean
  /** World-frame yaw toward highest threat (to protect rear 180-deg armor arc), or null. */
  primaryThreatBearing: number | null
  /** Number of enemies likely able to see or shoot us right now. */
  spottedByCount: number
  /** 0 = likely 1v15 Practice, 1 = likely 16-mech FFA. */
  ffaConfidence: number
}

export type MacroMode =
  | "zone_sprint"
  | "regen_hide"
  | "ghost_kite"
  | "farm_crate"
  | "farm_npc"
  | "engage"
  | "contest_drop"

export interface MacroOrder {
  mode: MacroMode
  moveTarget: Vec3 | null
  primaryTargetId: number | null
  /** Preferred weapon loadout in priority order. */
  desiredLoadout: WeaponKind[]
  /** True if we should move silently (< step_speed) and avoid boost/jet unless dodging. */
  preferSilent: boolean
  /** True if we should hold fire to let 5s HP regen trigger. */
  holdFireForRegen: boolean
}
