import type {
  Config,
  MacroOrder,
  Observation,
  TrackedEnemy,
  Vec2,
  Vec3,
  WeaponKind,
  WorldQuery,
  ThreatState,
} from "../contracts.ts"
import { pickUpgrade } from "./upgrades.ts"
import { clampToSafeZone, evaluateZone, isPointInSafeZone } from "./zone.ts"

const PRACTICE_LOADOUT: WeaponKind[] = ["laser", "lightning", "gun", "mortar"]
const FFA_LOADOUT: WeaponKind[] = ["laser", "lightning", "mortar", "gun"]

const COMBAT_SOUND_KINDS = new Set([
  "gun",
  "laser",
  "laser_charge",
  "mortar",
  "explosion",
  "death",
  "lightning",
])

function dist2D(a: Vec2 | Vec3, b: Vec2 | Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

function hasEnemyWithin(enemies: TrackedEnemy[], pos: Vec3, radius: number): boolean {
  for (const e of enemies) {
    if (e.kind === "mech" && dist2D(e.pos, pos) <= radius) {
      return true
    }
  }
  return false
}

function countMechsNear(enemies: TrackedEnemy[], pos: Vec3, radius: number): number {
  let count = 0
  for (const e of enemies) {
    if (e.kind === "mech" && dist2D(e.pos, pos) <= radius) {
      count++
    }
  }
  return count
}

function getHeldWeaponKinds(obs: Observation): Set<WeaponKind> {
  const held = new Set<WeaponKind>()
  for (const w of obs.self.weapons) {
    if (w) held.add(w.kind)
  }
  return held
}

function findDesiredPickup(
  obs: Observation,
  desiredLoadout: WeaponKind[],
  maxDist: number,
  enemies: TrackedEnemy[],
  avoidEnemiesRadius: number,
): Vec3 | null {
  const held = getHeldWeaponKinds(obs)
  const hasEmptySlot = obs.self.weapons.some((w) => w === null)

  let worstHeldRank = -1
  for (const w of obs.self.weapons) {
    if (w) {
      const rank = desiredLoadout.indexOf(w.kind)
      if (rank > worstHeldRank) worstHeldRank = rank
    }
  }

  let bestPos: Vec3 | null = null
  let bestScore = -Infinity

  for (const p of obs.pickups) {
    if (held.has(p.kind)) continue
    const rank = desiredLoadout.indexOf(p.kind)
    if (rank === -1) continue
    if (!hasEmptySlot && rank >= worstHeldRank) continue
    if (!isPointInSafeZone(p.pos, obs, 6)) continue

    const d = dist2D(obs.self.pos, p.pos)
    if (d > maxDist) continue
    if (avoidEnemiesRadius > 0 && hasEnemyWithin(enemies, p.pos, avoidEnemiesRadius)) continue

    // Higher priority weapon + closer distance
    const score = (desiredLoadout.length - rank) * 25 - d
    if (score > bestScore) {
      bestScore = score
      bestPos = p.pos
    }
  }

  return bestPos
}

function pickBestMechTarget(
  obs: Observation,
  threats: ThreatState,
  isPractice: boolean,
): TrackedEnemy | null {
  let best: TrackedEnemy | null = null
  let bestScore = -Infinity

  for (const e of threats.enemies) {
    if (e.kind !== "mech") continue
    const d = dist2D(obs.self.pos, e.pos)
    const hpRatio = e.hp / Math.max(1, e.maxHp)

    // Prioritize visible/recent, wounded, and closer targets
    let score = e.confidence * 50 + (1 - hpRatio) * 65 - d * 0.45
    if (e.charging) score += 15
    if (isPractice && d > 180) score -= 30

    if (score > bestScore) {
      bestScore = score
      best = e
    }
  }

  return best
}

function getStandoffPoint(
  me: Vec3,
  target: Vec3,
  desiredDist: number,
  obs: Observation,
  world: WorldQuery,
): Vec3 {
  const dx = me[0] - target[0]
  const dy = me[1] - target[1]
  const d = Math.hypot(dx, dy)
  if (d < 1e-3) {
    return clampToSafeZone(me[0], me[1], obs, world)
  }
  const tx = target[0] + (dx / d) * desiredDist
  const ty = target[1] + (dy / d) * desiredDist
  return clampToSafeZone(tx, ty, obs, world)
}

function getPreferredCombatRange(held: Set<WeaponKind>): number {
  if (held.has("lightning")) return 28
  if (held.has("laser")) return 68
  if (held.has("mortar")) return 62
  return 40
}

function findRetreatTarget(
  obs: Observation,
  threats: ThreatState,
  world: WorldQuery,
): Vec3 {
  const enemyPositions = threats.enemies.map((e) => e.pos)
  if (enemyPositions.length > 0) {
    const cover = world.findCover(
      obs.self.pos,
      enemyPositions,
      36,
      (cx, cy) => isPointInSafeZone([cx, cy], obs, 4),
      obs.self.stats.eye_height ?? 8,
    )
    if (cover) {
      return cover
    }
  }

  // Fallback: move directly away from nearest threat, clamped to safe zone
  let nearest: TrackedEnemy | null = null
  let nearestDist = Infinity
  for (const e of threats.enemies) {
    const d = dist2D(obs.self.pos, e.pos)
    if (d < nearestDist) {
      nearestDist = d
      nearest = e
    }
  }

  if (nearest && nearestDist > 1e-3) {
    const dx = obs.self.pos[0] - nearest.pos[0]
    const dy = obs.self.pos[1] - nearest.pos[1]
    const tx = obs.self.pos[0] + (dx / nearestDist) * 32
    const ty = obs.self.pos[1] + (dy / nearestDist) * 32
    return clampToSafeZone(tx, ty, obs, world)
  }

  const [ncx, ncy] = obs.zone.next_center
  return [ncx, ncy, world.surfaceZAt(ncx, ncy, obs.self.pos[2])]
}

function findSoundInvestigatePoint(
  obs: Observation,
  world: WorldQuery,
): Vec3 | null {
  let bestBearing: number | null = null
  let bestScore = -Infinity

  for (const s of obs.sounds) {
    if (!COMBAT_SOUND_KINDS.has(s.kind)) continue
    if (s.age > 3.5) continue
    if (s.dist === "far") continue

    let score = s.dist === "near" ? 40 : 25
    if (s.kind === "death") score += 20
    else if (s.kind === "laser" || s.kind === "gun") score += 10
    score -= s.age * 6

    if (score > bestScore) {
      bestScore = score
      bestBearing = s.bearing
    }
  }

  if (bestBearing === null) return null

  const tx = obs.self.pos[0] + Math.cos(bestBearing) * 48
  const ty = obs.self.pos[1] + Math.sin(bestBearing) * 48
  return clampToSafeZone(tx, ty, obs, world)
}

export interface Strategy {
  decide(
    obs: Observation,
    world: WorldQuery,
    threats: ThreatState,
  ): { order: MacroOrder; pick?: number }
}

/**
 * Create the dual-mode macro strategy engine (1v15 Practice + 16-mech FFA).
 */
export function createStrategy(config: Config): Strategy {
  let inRegenHide = false

  return {
    decide(obs: Observation, world: WorldQuery, threats: ThreatState) {
      const pick = pickUpgrade(obs, config)
      const isPractice = threats.ffaConfidence < 0.45
      const desiredLoadout = isPractice ? PRACTICE_LOADOUT : FFA_LOADOUT
      const held = getHeldWeaponKinds(obs)
      const zoneAdvice = evaluateZone(obs, world, config)
      const practicePreferSilent =
        threats.spottedByCount === 0 && !hasEnemyWithin(threats.enemies, obs.self.pos, 50)

      // 1. Zone Override: avoid zone damage (ignores armor and resets 5s HP regen)
      if (zoneAdvice.mustSprint) {
        if (!obs.self.in_zone) {
          inRegenHide = false
        }
        const nearestMech = pickBestMechTarget(obs, threats, isPractice)
        return {
          pick,
          order: {
            mode: "zone_sprint",
            moveTarget: zoneAdvice.moveTarget,
            primaryTargetId: nearestMech?.id ?? null,
            desiredLoadout,
            preferSilent: false,
            holdFireForRegen: false,
          },
        }
      }

      // 2. Emergency Regen (with hysteresis): enter < 0.65 (Practice) or < 0.50 (FFA), stay until >= 0.92
      const hpRatio = obs.self.hp / Math.max(1, obs.self.max_hp)
      const regenThreshold = isPractice ? 0.65 : 0.50
      if (!obs.self.in_zone || hpRatio >= 0.92) {
        inRegenHide = false
      } else if (hpRatio < regenThreshold) {
        inRegenHide = true
      }

      if (inRegenHide && obs.self.in_zone) {
        const retreatTarget = findRetreatTarget(obs, threats, world)
        const silentRegen = isPractice
          ? practicePreferSilent
          : threats.spottedByCount === 0 && hasEnemyWithin(threats.enemies, obs.self.pos, 45)
        return {
          pick,
          order: {
            mode: "regen_hide",
            moveTarget: retreatTarget,
            primaryTargetId: null,
            desiredLoadout,
            preferSilent: silentRegen,
            holdFireForRegen: true,
          },
        }
      }

      // 3. 1v15 Practice Mode
      if (isPractice) {
        const preferSilent = practicePreferSilent

        // Only collect loose cubes and ground pickups when unspotted (never shoot crates or NPCs in Practice)
        if (threats.spottedByCount === 0) {
          if (obs.self.cubes < 8) {
            for (const c of obs.cubes) {
              if (
                dist2D(obs.self.pos, c.pos) <= 40 &&
                isPointInSafeZone(c.pos, obs, 6) &&
                !hasEnemyWithin(threats.enemies, c.pos, 50)
              ) {
                return {
                  pick,
                  order: {
                    mode: "farm_crate",
                    moveTarget: c.pos,
                    primaryTargetId: null,
                    desiredLoadout,
                    preferSilent,
                    holdFireForRegen: false,
                  },
                }
              }
            }
          }

          // Safe desired weapon pickup
          const pickupPos = findDesiredPickup(obs, desiredLoadout, 45, threats.enemies, 50)
          if (pickupPos) {
            return {
              pick,
              order: {
                mode: "farm_crate",
                moveTarget: pickupPos,
                primaryTargetId: null,
                desiredLoadout,
                preferSilent,
                holdFireForRegen: false,
              },
            }
          }
        }

        // Ghost kite: stay behind cover, lob mortar over walls, splash contested drops
        const target = pickBestMechTarget(obs, threats, true)
        const mechPositions = threats.enemies
          .filter((e) => e.kind === "mech")
          .map((e) => e.pos)

        let moveTarget: Vec3 | null = null
        if (mechPositions.length > 0) {
          const cover = world.findCover(
            obs.self.pos,
            mechPositions,
            36,
            (cx, cy) => isPointInSafeZone([cx, cy], obs, 4),
            obs.self.stats.eye_height ?? 8,
          )
          if (cover) {
            moveTarget = cover
          } else if (target) {
            const kiteRange = held.has("mortar") ? 65 : 42
            moveTarget = getStandoffPoint(obs.self.pos, target.pos, kiteRange, obs, world)
          }
        } else if (held.has("mortar") && obs.drops.length > 0) {
          // Position within mortar range of an active drop without walking into it
          const activeDrop = obs.drops.find(
            (d) => (d.lands_in <= 10 || d.holder !== null) && isPointInSafeZone(d.pos, obs, 6),
          )
          if (activeDrop) {
            const d = dist2D(obs.self.pos, activeDrop.pos)
            if (d > 140) {
              moveTarget = getStandoffPoint(obs.self.pos, activeDrop.pos, 95, obs, world)
            }
          }
        }

        if (!moveTarget && !zoneAdvice.inNextSafe) {
          moveTarget = zoneAdvice.moveTarget
        }

        return {
          pick,
          order: {
            mode: "ghost_kite",
            moveTarget,
            primaryTargetId: target?.id ?? null,
            desiredLoadout,
            preferSilent,
            holdFireForRegen: false,
          },
        }
      }

      // 4. 16-mech FFA Mode
      // 4a. Contest supply drops when healthy and few enemies nearby
      if (hpRatio > 0.7 && threats.spottedByCount <= 1) {
        let bestDropPos: Vec3 | null = null
        let bestDropDist = Infinity
        let dropEnemyId: number | null = null

        for (const drop of obs.drops) {
          if (drop.lands_in > 12) continue
          if (!isPointInSafeZone(drop.pos, obs, 4)) continue
          const nearbyMechs = countMechsNear(threats.enemies, drop.pos, 55)
          if (nearbyMechs > 1) continue

          const d = dist2D(obs.self.pos, drop.pos)
          if (d < bestDropDist) {
            bestDropDist = d
            bestDropPos = drop.pos
            const nearEnemy = threats.enemies.find(
              (e) => e.kind === "mech" && dist2D(e.pos, drop.pos) <= 55,
            )
            dropEnemyId = nearEnemy?.id ?? null
          }
        }

        if (bestDropPos) {
          return {
            pick,
            order: {
              mode: "contest_drop",
              moveTarget: bestDropPos,
              primaryTargetId: dropEnemyId,
              desiredLoadout,
              preferSilent: false,
              holdFireForRegen: false,
            },
          }
        }
      }

      // 4b. Grab nearby desired weapon pickups
      const ffaPickup = findDesiredPickup(obs, desiredLoadout, 45, threats.enemies, 25)
      if (ffaPickup) {
        return {
          pick,
          order: {
            mode: "farm_crate",
            moveTarget: ffaPickup,
            primaryTargetId: null,
            desiredLoadout,
            preferSilent: false,
            holdFireForRegen: false,
          },
        }
      }

      // 4c. Early/mid game farming up to ~10 cubes (avoid bloating past ~12)
      if (obs.self.cubes < 10) {
        // Free loose cubes first
        let bestCubePos: Vec3 | null = null
        let bestCubeDist = 35
        for (const c of obs.cubes) {
          const d = dist2D(obs.self.pos, c.pos)
          if (d < bestCubeDist && isPointInSafeZone(c.pos, obs, 6)) {
            bestCubeDist = d
            bestCubePos = c.pos
          }
        }
        if (bestCubePos) {
          return {
            pick,
            order: {
              mode: "farm_crate",
              moveTarget: bestCubePos,
              primaryTargetId: null,
              desiredLoadout,
              preferSilent: false,
              holdFireForRegen: false,
            },
          }
        }

        // Compare nearby crates and NPC drones
        let bestFarmMode: "farm_crate" | "farm_npc" | null = null
        let bestFarmPos: Vec3 | null = null
        let bestFarmTargetId: number | null = null
        let bestFarmScore = -Infinity

        for (const crate of obs.crates) {
          if (!isPointInSafeZone(crate.pos, obs, 6)) continue
          const d = dist2D(obs.self.pos, crate.pos)
          if (d > 85) continue
          if (hasEnemyWithin(threats.enemies, crate.pos, 35)) continue
          const score = 40 - d
          if (score > bestFarmScore) {
            bestFarmScore = score
            bestFarmMode = "farm_crate"
            bestFarmPos = crate.pos
            bestFarmTargetId = null
          }
        }

        if (hpRatio > 0.55) {
          for (const e of threats.enemies) {
            if (e.kind !== "npc") continue
            if (!isPointInSafeZone(e.pos, obs, 6)) continue
            const d = dist2D(obs.self.pos, e.pos)
            if (d > 85) continue
            if (hasEnemyWithin(threats.enemies, e.pos, 35)) continue
            // NPCs drop 2 cubes vs 1 for crate
            const score = 55 - d
            if (score > bestFarmScore) {
              bestFarmScore = score
              bestFarmMode = "farm_npc"
              bestFarmPos = getStandoffPoint(obs.self.pos, e.pos, 26, obs, world)
              bestFarmTargetId = e.id
            }
          }
        }

        if (bestFarmMode && bestFarmPos) {
          return {
            pick,
            order: {
              mode: bestFarmMode,
              moveTarget: bestFarmPos,
              primaryTargetId: bestFarmTargetId,
              desiredLoadout,
              preferSilent: false,
              holdFireForRegen: false,
            },
          }
        }
      }

      // 4d. Third-party / engage wounded mechs or combat sounds
      const target = pickBestMechTarget(obs, threats, false)
      if (target) {
        const range = getPreferredCombatRange(held)
        const moveTarget = getStandoffPoint(obs.self.pos, target.pos, range, obs, world)
        return {
          pick,
          order: {
            mode: "engage",
            moveTarget,
            primaryTargetId: target.id,
            desiredLoadout,
            preferSilent: false,
            holdFireForRegen: false,
          },
        }
      }

      const soundTarget = findSoundInvestigatePoint(obs, world)
      if (soundTarget) {
        return {
          pick,
          order: {
            mode: "engage",
            moveTarget: soundTarget,
            primaryTargetId: null,
            desiredLoadout,
            preferSilent: false,
            holdFireForRegen: false,
          },
        }
      }

      // Fallback: rotate toward safe next_center
      const fallbackTarget = zoneAdvice.distToNextCenter > Math.max(25, zoneAdvice.safeRadius * 0.5)
        ? zoneAdvice.moveTarget
        : null

      return {
        pick,
        order: {
          mode: "engage",
          moveTarget: fallbackTarget,
          primaryTargetId: null,
          desiredLoadout,
          preferSilent: false,
          holdFireForRegen: false,
        },
      }
    },
  }
}
