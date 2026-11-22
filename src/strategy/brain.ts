import type {
  Config,
  MacroOrder,
  Observation,
  ThreatState,
  TrackedEnemy,
  Vec2,
  Vec3,
  WeaponKind,
  WorldQuery,
} from "../contracts.ts"
import { pickUpgrade } from "./upgrades.ts"
import { clampToSafeZone, evaluateZone, isPointInSafeZone } from "./zone.ts"

const DESIRED_LOADOUT: WeaponKind[] = ["laser", "lightning", "gun", "mortar"]

const COMBAT_SOUND_KINDS = new Set([
  "gun",
  "laser",
  "laser_charge",
  "mortar",
  "explosion",
  "death",
  "lightning",
])

const MOVEMENT_SOUND_KINDS = new Set(["step", "boost", "jet"])

function dist2D(a: Vec2 | Vec3, b: Vec2 | Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
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

function hasMechShotLOS(
  obs: Observation,
  world: WorldQuery,
  enemyPos: Vec3,
  eyeHeight: number,
): boolean {
  const selfEye: Vec3 = [obs.self.pos[0], obs.self.pos[1], obs.self.pos[2] + eyeHeight]
  const targetMid: Vec3 = [enemyPos[0], enemyPos[1], enemyPos[2] + 4.5]
  return world.hasShotLOS(selfEye, targetMid)
}

function findKillConfirmTarget(
  obs: Observation,
  threats: ThreatState,
  world: WorldQuery,
  eyeHeight: number,
): TrackedEnemy | null {
  if (obs.self.hp <= 220) return null

  let best: TrackedEnemy | null = null
  let bestScore = -Infinity

  for (const e of threats.enemies) {
    if (e.kind !== "mech") continue
    if (e.confidence < 0.9) continue
    if (e.hp <= 0 || e.hp > 380) continue
    if (!hasMechShotLOS(obs, world, e.pos, eyeHeight)) continue

    const d = dist2D(obs.self.pos, e.pos)
    const score = (380 - e.hp) * 1.2 - d * 0.5
    if (score > bestScore) {
      bestScore = score
      best = e
    }
  }

  return best
}

function findDesiredPickup(
  obs: Observation,
  desiredLoadout: WeaponKind[],
  maxDist: number,
  enemies: TrackedEnemy[],
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

    if (!hasEmptySlot) {
      const isTopTierUpgrade = p.kind === "laser" || p.kind === "lightning"
      if (!isTopTierUpgrade || rank >= worstHeldRank) continue
    }

    if (!isPointInSafeZone(p.pos, obs, 6)) continue

    const d = dist2D(obs.self.pos, p.pos)
    if (d > maxDist) continue
    if (countMechsNear(enemies, p.pos, 25) >= 2) continue

    const score = (desiredLoadout.length - rank) * 28 - d
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
  world: WorldQuery,
  eyeHeight: number,
): TrackedEnemy | null {
  let best: TrackedEnemy | null = null
  let bestScore = -Infinity

  for (const e of threats.enemies) {
    if (e.kind !== "mech") continue
    const d = dist2D(obs.self.pos, e.pos)
    const hpRatio = e.hp / Math.max(1, e.maxHp)

    // Heavily favor low HP + high confidence + close range
    let score = (1 - hpRatio) * 115 + e.confidence * 70 - d * 0.55
    if (e.hp > 0 && e.hp <= 380) score += 55
    if (e.charging) score += 18
    if (e.confidence >= 0.9 && hasMechShotLOS(obs, world, e.pos, eyeHeight)) {
      score += 22
    }

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

function getOrbitalStrafePoint(
  obs: Observation,
  targetPos: Vec3,
  optRange: number,
  world: WorldQuery,
): Vec3 {
  const me = obs.self.pos
  const rx = me[0] - targetPos[0]
  const ry = me[1] - targetPos[1]
  const d = Math.hypot(rx, ry)

  const ux = d > 1e-3 ? rx / d : 1
  const uy = d > 1e-3 ? ry / d : 0

  // Flip tangent direction every 1.6s to break projectile lead prediction
  const dir = Math.floor(obs.t / 1.6) % 2 === 0 ? 1 : -1
  const tangX = -uy * dir
  const tangY = ux * dir
  const strafeStep = 14

  const desiredX = targetPos[0] + ux * optRange + tangX * strafeStep
  const desiredY = targetPos[1] + uy * optRange + tangY * strafeStep
  return clampToSafeZone(desiredX, desiredY, obs, world)
}

function findRetreatTarget(
  obs: Observation,
  threats: ThreatState,
  world: WorldQuery,
  eyeHeight: number,
): Vec3 {
  const enemyPositions = threats.enemies.map((e) => e.pos)
  if (enemyPositions.length > 0) {
    const cover = world.findCover(
      obs.self.pos,
      enemyPositions,
      36,
      (cx, cy) => isPointInSafeZone([cx, cy], obs, 4),
      eyeHeight,
    )
    if (cover) {
      return cover
    }
  }

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

function findSoundInvestigatePoint(obs: Observation, world: WorldQuery): Vec3 | null {
  let bestBearing: number | null = null
  let bestDistStep = 48
  let bestScore = -Infinity

  for (const s of obs.sounds) {
    const isCombat = COMBAT_SOUND_KINDS.has(s.kind)
    const isMove = MOVEMENT_SOUND_KINDS.has(s.kind)
    if (!isCombat && !isMove) continue
    if (s.age > 3.5) continue
    if (!isCombat && s.dist === "far") continue

    let score = s.dist === "near" ? 45 : s.dist === "mid" ? 28 : 12
    if (s.kind === "death") score += 22
    else if (s.kind === "laser" || s.kind === "gun" || s.kind === "lightning") score += 12
    else if (!isCombat) score -= 12
    score -= s.age * 6

    if (score > bestScore) {
      bestScore = score
      bestBearing = s.bearing
      bestDistStep = s.dist === "far" ? 72 : s.dist === "mid" ? 56 : 36
    }
  }

  if (bestBearing === null) return null

  const tx = obs.self.pos[0] + Math.cos(bestBearing) * bestDistStep
  const ty = obs.self.pos[1] + Math.sin(bestBearing) * bestDistStep
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
 * Create the v3 "Apex Wave-Slayer & FFA Snowball" macro strategy engine.
 */
export function createStrategy(config: Config): Strategy {
  let inRegenHide = false
  let patrolAngle: number | null = null

  return {
    decide(obs: Observation, world: WorldQuery, threats: ThreatState) {
      const pick = pickUpgrade(obs, config)
      const desiredLoadout = DESIRED_LOADOUT
      const held = getHeldWeaponKinds(obs)
      const eyeHeight = obs.self.stats.eye_height ?? 8
      const zoneAdvice = evaluateZone(obs, world, config)
      const hpRatio = obs.self.hp / Math.max(1, obs.self.max_hp)

      // Priority 1 — Safe Zone (zone_sprint): avoid zone damage (ignores armor & resets regen)
      if (zoneAdvice.mustSprint) {
        if (!obs.self.in_zone) {
          inRegenHide = false
        }
        const bestMech = pickBestMechTarget(obs, threats, world, eyeHeight)
        return {
          pick,
          order: {
            mode: "zone_sprint",
            moveTarget: zoneAdvice.moveTarget,
            primaryTargetId: bestMech?.id ?? null,
            desiredLoadout,
            preferSilent: false,
            holdFireForRegen: false,
          },
        }
      }

      // Priority 2 — Kill-Confirm Override & Fast Combat Regen (regen_hide)
      const killConfirmTarget = findKillConfirmTarget(obs, threats, world, eyeHeight)
      const hasNanites = obs.self.upgrades.includes("nanites")
      const enterRegenRatio = threats.spottedByCount >= 2 ? 0.55 : 0.42
      const exitRegenRatio = hasNanites ? 0.88 : 0.80

      if (killConfirmTarget !== null || !obs.self.in_zone || hpRatio >= exitRegenRatio) {
        inRegenHide = false
      } else if (hpRatio < enterRegenRatio && obs.self.in_zone) {
        inRegenHide = true
      }

      if (inRegenHide && obs.self.in_zone) {
        const retreatTarget = findRetreatTarget(obs, threats, world, eyeHeight)
        return {
          pick,
          order: {
            mode: "regen_hide",
            moveTarget: retreatTarget,
            primaryTargetId: null,
            desiredLoadout,
            preferSilent: false,
            holdFireForRegen: true,
          },
        }
      }

      // Priority 3 — Uncontested Supply Drops (contest_drop)
      if (obs.drops.length > 0 && !(killConfirmTarget && hpRatio < enterRegenRatio)) {
        let bestDropPos: Vec3 | null = null
        let bestDropDist = Infinity
        let dropEnemyId: number | null = null

        for (const drop of obs.drops) {
          if (drop.lands_in > 14) continue
          if (!isPointInSafeZone(drop.pos, obs, 4)) continue
          if (countMechsNear(threats.enemies, drop.pos, 45) > 1) continue

          const myDist = dist2D(obs.self.pos, drop.pos)
          let nearestEnemyToDrop = Infinity
          let nearEnemyId: number | null = null
          for (const e of threats.enemies) {
            if (e.kind !== "mech") continue
            const ed = dist2D(e.pos, drop.pos)
            if (ed < nearestEnemyToDrop) {
              nearestEnemyToDrop = ed
              if (ed <= 45) nearEnemyId = e.id
            }
          }

          if (!(hpRatio > 0.45 || myDist < nearestEnemyToDrop)) continue

          if (myDist < bestDropDist) {
            bestDropDist = myDist
            bestDropPos = drop.pos
            dropEnemyId = nearEnemyId
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

      const bestMech = killConfirmTarget ?? pickBestMechTarget(obs, threats, world, eyeHeight)

      // Priority 4 — Blitz-Snowball Economy (0-10 Cubes + 2nd Weapon)
      if (!killConfirmTarget) {
        // 4a. Scoop loose cubes within 45m if < 14 cubes and safe from 2+ enemies on top of it
        if (obs.self.cubes < 14) {
          let bestCubePos: Vec3 | null = null
          let bestCubeDist = 45
          for (const c of obs.cubes) {
            if (!isPointInSafeZone(c.pos, obs, 6)) continue
            const d = dist2D(obs.self.pos, c.pos)
            if (d > bestCubeDist) continue
            if (countMechsNear(threats.enemies, c.pos, 25) >= 2) continue
            bestCubeDist = d
            bestCubePos = c.pos
          }
          if (bestCubePos) {
            return {
              pick,
              order: {
                mode: "farm_crate",
                moveTarget: bestCubePos,
                primaryTargetId: bestMech?.id ?? null,
                desiredLoadout,
                preferSilent: false,
                holdFireForRegen: false,
              },
            }
          }
        }

        // 4b. Grab desired floor pickups within 70m if empty slot or strict upgrade (laser/lightning)
        const pickupPos = findDesiredPickup(obs, desiredLoadout, 70, threats.enemies)
        if (pickupPos) {
          return {
            pick,
            order: {
              mode: "farm_crate",
              moveTarget: pickupPos,
              primaryTargetId: bestMech?.id ?? null,
              desiredLoadout,
              preferSilent: false,
              holdFireForRegen: false,
            },
          }
        }

        // 4c. Aggressively farm nearby crates & NPC drones within 95m while < 10 cubes
        let nearestVisibleMechDist = Infinity
        for (const e of threats.enemies) {
          if (e.kind === "mech" && e.confidence >= 0.85) {
            const d = dist2D(obs.self.pos, e.pos)
            if (d < nearestVisibleMechDist) nearestVisibleMechDist = d
          }
        }

        const safeToFarm =
          threats.spottedByCount === 0 || (nearestVisibleMechDist > 65 && hpRatio > 0.6)

        if (obs.self.cubes < 10 && safeToFarm) {
          const hasEmptySlot = obs.self.weapons.some((w) => w === null)
          let bestFarmMode: "farm_crate" | "farm_npc" | null = null
          let bestFarmPos: Vec3 | null = null
          let bestFarmTargetId: number | null = null
          let bestFarmScore = -Infinity

          for (const crate of obs.crates) {
            if (!isPointInSafeZone(crate.pos, obs, 6)) continue
            const d = dist2D(obs.self.pos, crate.pos)
            if (d > 95) continue
            if (countMechsNear(threats.enemies, crate.pos, 30) > 0) continue

            const score = (hasEmptySlot ? 60 : 45) - d
            if (score > bestFarmScore) {
              bestFarmScore = score
              bestFarmMode = "farm_crate"
              bestFarmPos = crate.pos
              bestFarmTargetId = null
            }
          }

          for (const e of threats.enemies) {
            if (e.kind !== "npc") continue
            if (!isPointInSafeZone(e.pos, obs, 6)) continue
            const d = dist2D(obs.self.pos, e.pos)
            if (d > 95) continue
            if (countMechsNear(threats.enemies, e.pos, 30) > 0) continue

            // NPCs drop 2 cubes vs 1 for crate
            const score = 68 - d
            if (score > bestFarmScore) {
              bestFarmScore = score
              bestFarmMode = "farm_npc"
              bestFarmPos = getStandoffPoint(obs.self.pos, e.pos, 26, obs, world)
              bestFarmTargetId = e.id
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
      }

      // Priority 5 — Active 1v1 Execution & 1vN "Slice-the-Pie" (engage)
      if (bestMech) {
        const otherMechs = threats.enemies
          .filter(
            (e) =>
              e.kind === "mech" &&
              e.id !== bestMech.id &&
              dist2D(obs.self.pos, e.pos) < 160,
          )
          .map((e) => e.pos)

        let moveTarget: Vec3
        if (threats.spottedByCount >= 2 && otherMechs.length > 0) {
          // 1vN Slice-the-Pie: isolate bestMech behind cover from otherMechs
          const peekCover = world.findPeekCover(
            obs.self.pos,
            bestMech.pos,
            otherMechs,
            32,
            (cx, cy) => isPointInSafeZone([cx, cy], obs, 4),
            eyeHeight,
          )
          if (peekCover) {
            moveTarget = peekCover
          } else {
            const cover = world.findCover(
              obs.self.pos,
              otherMechs,
              32,
              (cx, cy) => isPointInSafeZone([cx, cy], obs, 4),
              eyeHeight,
            )
            if (cover) {
              moveTarget = cover
            } else {
              const optRange = held.has("lightning") ? 28 : held.has("laser") ? 58 : 44
              moveTarget = getOrbitalStrafePoint(obs, bestMech.pos, optRange, world)
            }
          }
        } else {
          // 1v1 Duel: Orbital Strafe at optimal weapon range
          const optRange = held.has("lightning") ? 28 : held.has("laser") ? 58 : 44
          moveTarget = getOrbitalStrafePoint(obs, bestMech.pos, optRange, world)
        }

        return {
          pick,
          order: {
            mode: "engage",
            moveTarget,
            primaryTargetId: bestMech.id,
            desiredLoadout,
            preferSilent: false,
            holdFireForRegen: false,
          },
        }
      }

      // Priority 6 — Active Hunter Search
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

      // Patrol the inner safe-zone ring (0.45 * next_radius) to hunt down next enemy/crate
      const [ncx, ncy] = obs.zone.next_center
      const patrolRadius = Math.max(
        6,
        Math.min(zoneAdvice.safeRadius, obs.zone.next_radius * 0.45),
      )

      if (patrolAngle === null) {
        patrolAngle = Math.atan2(obs.self.pos[1] - ncy, obs.self.pos[0] - ncx) + 0.75
      }

      let px = ncx + Math.cos(patrolAngle) * patrolRadius
      let py = ncy + Math.sin(patrolAngle) * patrolRadius
      const reachThreshold = Math.min(18, Math.max(5, patrolRadius * 0.5))

      if (dist2D(obs.self.pos, [px, py]) < reachThreshold) {
        patrolAngle += 0.9
        px = ncx + Math.cos(patrolAngle) * patrolRadius
        py = ncy + Math.sin(patrolAngle) * patrolRadius
      }

      const patrolTarget = clampToSafeZone(px, py, obs, world)

      return {
        pick,
        order: {
          mode: "engage",
          moveTarget: patrolTarget,
          primaryTargetId: null,
          desiredLoadout,
          preferSilent: false,
          holdFireForRegen: false,
        },
      }
    },
  }
}
