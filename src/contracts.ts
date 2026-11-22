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
  /** Find a path of waypoints from `from` to `to` on the 4m navgrid (node-capped). */
  findPath(from: Vec3, to: Vec3, canJet: boolean): Vec3[]
  /** Find a nearby cover position within `radius` that blocks shot LOS from `threats` and satisfies optional `isSafe(x, y)`. */
  findCover(
    pos: Vec3,
    threats: Vec3[],
    radius: number,
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
  /** World-frame yaw toward highest threat (to protect rear 180-deg armor arc), or null. */
  primaryThreatBearing: number | null
  /** Number of enemies likely able to see or converge on us right now. */
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
