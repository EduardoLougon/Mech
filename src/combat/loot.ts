import type { Config, MacroOrder, Observation, ThreatState, WeaponKind } from "../contracts.ts"
import type { BotAction } from "../mechfight.ts"

const FALLBACK_ORDER: WeaponKind[] = ["laser", "lightning", "mortar", "gun"]

function weaponPriority(
  kind: WeaponKind,
  desiredLoadout: WeaponKind[],
  avoidMortar: boolean,
): number {
  if (avoidMortar && kind === "mortar") {
    return desiredLoadout.length + 100
  }
  const idx = desiredLoadout.indexOf(kind)
  if (idx !== -1) return idx
  const fb = FALLBACK_ORDER.indexOf(kind)
  return desiredLoadout.length + (fb === -1 ? 99 : fb)
}

function horizDist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

/**
 * Decide weapon take / drop / swap actions for pickups within pickup_radius.
 * - Never picks up a kind already held (`have` fails).
 * - Never swaps out a slot whose laser is currently charging (`busy` fails).
 * - Guards against +60% cookoff by ranking mortar below gun when ghost_kite or enemies hold laser.
 * - Fills empty slot first; if both slots are full, swaps out the lower-priority slot.
 */
export function chooseLootAction(
  obs: Observation,
  config: Config,
  threats: ThreatState,
  order: MacroOrder,
): Pick<BotAction, "take" | "drop"> {
  const self = obs.self
  const pickupRadius = config.loot.pickup_radius ?? 4
  const avoidMortar =
    order.mode === "ghost_kite" ||
    threats.enemies.some((e) => e.kind === "mech" && e.weapons.includes("laser"))

  const heldKinds = new Set<WeaponKind>()
  for (const w of self.weapons) {
    if (w) heldKinds.add(w.kind)
  }

  const candidates = obs.pickups
    .filter((p) => {
      if (heldKinds.has(p.kind)) return false
      if (horizDist(p.pos, self.pos) > pickupRadius) return false
      if (Math.abs(p.pos[2] - self.pos[2]) > 4) return false
      return true
    })
    .sort((a, b) => {
      const pa = weaponPriority(a.kind, order.desiredLoadout, avoidMortar)
      const pb = weaponPriority(b.kind, order.desiredLoadout, avoidMortar)
      if (pa !== pb) return pa - pb
      return horizDist(a.pos, self.pos) - horizDist(b.pos, self.pos)
    })

  if (candidates.length > 0) {
    const best = candidates[0]
    const bestPriority = weaponPriority(best.kind, order.desiredLoadout, avoidMortar)

    // Prefer filling an empty slot (slot 1 is empty at spawn, or slot 0 if dropped)
    const emptySlot = self.weapons[1] === null ? 1 : self.weapons[0] === null ? 0 : -1
    if (emptySlot !== -1) {
      if (!(avoidMortar && best.kind === "mortar")) {
        return { take: best.id }
      }
    } else {
      // Both slots full: find the lowest-priority non-charging slot
      const w0 = self.weapons[0]!
      const w1 = self.weapons[1]!
      const p0 = weaponPriority(w0.kind, order.desiredLoadout, avoidMortar)
      const p1 = weaponPriority(w1.kind, order.desiredLoadout, avoidMortar)

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
  }

  // If taking laser damage while holding mortar + another weapon, drop mortar to prevent cookoff
  if (avoidMortar && self.weapons[0] && self.weapons[1]) {
    const takingLaser = obs.events.some(
      (ev) => ev.type === "damaged" && ev.weapon === "laser",
    )
    if (takingLaser) {
      const mortarSlot =
        self.weapons[0].kind === "mortar"
          ? 0
          : self.weapons[1].kind === "mortar"
            ? 1
            : -1
      if (mortarSlot !== -1) {
        return { drop: mortarSlot }
      }
    }
  }

  return {}
}
