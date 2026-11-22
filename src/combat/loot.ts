import type {
  Config,
  MacroOrder,
  Observation,
  ThreatState,
  Vec3,
  WeaponKind,
  WorldQuery,
} from "../contracts.ts"
import type { BotAction } from "../mechfight.ts"

const FALLBACK_ORDER: WeaponKind[] = ["laser", "lightning", "gun", "mortar"]

function weaponPriority(kind: WeaponKind, desiredLoadout: WeaponKind[]): number {
  const idx = desiredLoadout.indexOf(kind)
  if (idx !== -1) return idx
  const fb = FALLBACK_ORDER.indexOf(kind)
  return desiredLoadout.length + (fb === -1 ? 99 : fb)
}

function horizDist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

function dist3(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/**
 * Decide weapon take / drop / swap actions for pickups within pickup_radius.
 * - Never picks up a kind already held (`have` fails).
 * - Never swaps out a slot whose laser is currently charging (`busy` fails).
 * - Proactive cookoff guard:
 *   - Do NOT pick up `mortar` if a visible enemy mech within 180m holds `laser`.
 *   - Proactively drop `mortar` if holding a 2nd weapon AND a visible enemy holding `laser`
 *     has shot LOS within 220m (260m if actively charging) or we just suffered `cookoff`.
 */
export function chooseLootAction(
  obs: Observation,
  config: Config,
  threats: ThreatState,
  order: MacroOrder,
  ignoredPickupIds?: ReadonlySet<number>,
  world?: WorldQuery,
): Pick<BotAction, "take" | "drop"> {
  const self = obs.self
  const pickupRadius = config.loot.pickup_radius ?? 4

  const heldKinds = new Set<WeaponKind>()
  for (const w of self.weapons) {
    if (w) heldKinds.add(w.kind)
  }

  const hasAnyWeapon = heldKinds.size > 0
  const visibleLaserEnemyWithin180 = threats.enemies.some(
    (e) =>
      e.kind === "mech" &&
      e.confidence >= 0.95 &&
      e.weapons.includes("laser") &&
      dist3(e.pos, self.pos) <= 180,
  )

  const candidates = obs.pickups
    .filter((p) => {
      if (ignoredPickupIds?.has(p.id)) return false
      if (heldKinds.has(p.kind)) return false
      if (p.kind === "mortar" && hasAnyWeapon && visibleLaserEnemyWithin180) return false
      if (horizDist(p.pos, self.pos) > pickupRadius) return false
      if (Math.abs(p.pos[2] - self.pos[2]) > 4) return false
      return true
    })
    .sort((a, b) => {
      const pa = weaponPriority(a.kind, order.desiredLoadout)
      const pb = weaponPriority(b.kind, order.desiredLoadout)
      if (pa !== pb) return pa - pb
      return horizDist(a.pos, self.pos) - horizDist(b.pos, self.pos)
    })

  if (candidates.length > 0) {
    const best = candidates[0]
    const bestPriority = weaponPriority(best.kind, order.desiredLoadout)

    // Always fill an empty slot with any available non-held weapon (except mortar vs nearby laser)
    const emptySlot = self.weapons[1] === null ? 1 : self.weapons[0] === null ? 0 : -1
    if (emptySlot !== -1) {
      return { take: best.id }
    }

    // Both slots full: find the lowest-priority non-charging slot
    const w0 = self.weapons[0]!
    const w1 = self.weapons[1]!
    const p0 = weaponPriority(w0.kind, order.desiredLoadout)
    const p1 = weaponPriority(w1.kind, order.desiredLoadout)

    const busy0 = w0.kind === "laser" && (w0.charge ?? 0) > 0
    const busy1 = w1.kind === "laser" && (w1.charge ?? 0) > 0

    let dropSlot = -1
    let dropPriority = -1

    if (!busy0 && !busy1) {
      if (p0 >= p1) {
        dropSlot = 0
        dropPriority = p0
      } else {
        dropSlot = 1
        dropPriority = p1
      }
    } else if (!busy0) {
      dropSlot = 0
      dropPriority = p0
    } else if (!busy1) {
      dropSlot = 1
      dropPriority = p1
    }

    if (dropSlot !== -1 && bestPriority < dropPriority) {
      return { take: best.id, drop: dropSlot }
    }
  }

  // Proactive cookoff guard: drop mortar if we hold a 2nd weapon AND either:
  // (a) we just suffered cookoff, OR
  // (b) a visible enemy holding laser has shot LOS within 220m (260m if charging).
  if (self.weapons[0] && self.weapons[1]) {
    const mortarSlot =
      self.weapons[0].kind === "mortar"
        ? 0
        : self.weapons[1].kind === "mortar"
          ? 1
          : -1
    if (mortarSlot !== -1) {
      const gotCookoff = obs.events.some(
        (ev) => ev.type === "effect" && ev.effect === "cookoff",
      )
      const selfCenter: Vec3 = [self.pos[0], self.pos[1], self.pos[2] + 4.5]
      const selfUpper: Vec3 = [
        self.pos[0],
        self.pos[1],
        self.pos[2] + (self.stats.muzzle_height ?? 7),
      ]
      const laserThreatInLOS = threats.enemies.some((e) => {
        if (e.kind !== "mech" || e.confidence < 0.95) return false
        if (!e.weapons.includes("laser")) return false
        const d = dist3(e.pos, self.pos)
        const maxDist = e.charging ? 260 : 220
        if (d > maxDist) return false
        if (!world) return true
        const enemyMuzzle: Vec3 = [e.pos[0], e.pos[1], e.pos[2] + 7]
        return (
          world.hasShotLOS(enemyMuzzle, selfCenter) ||
          world.hasShotLOS(enemyMuzzle, selfUpper)
        )
      })
      if (gotCookoff || laserThreatInLOS) {
        return { drop: mortarSlot }
      }
    }
  }

  return {}
}
