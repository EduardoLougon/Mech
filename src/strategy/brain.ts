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
import type { DropObs } from "../mechfight.ts"
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

const COVER_LATCH_S = 1.2
const SOUND_LATCH_S = 2.5
const ROOF_LATCH_S = 2.5

function dist2D(a: Vec2 | Vec3, b: Vec2 | Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

function isRealMech(e: TrackedEnemy): boolean {
  return e.kind === "mech" && e.id >= 0 && e.confidence >= 0.45
}

function countMechsNear(realMechs: TrackedEnemy[], pos: Vec3, radius: number): number {
  let count = 0
  for (const e of realMechs) {
    if (isRealMech(e) && dist2D(e.pos, pos) <= radius) {
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
  realMechs: TrackedEnemy[],
  spottedByCount: number,
  world: WorldQuery,
  eyeHeight: number,
): TrackedEnemy | null {
  // Strictly gate kill-confirm: never suicide at low HP or in a 1v2+
  if (obs.self.hp <= 480 || spottedByCount > 1) return null

  let best: TrackedEnemy | null = null
  let bestScore = -Infinity

  for (const e of realMechs) {
    if (e.confidence < 0.9) continue
    if (e.hp <= 0 || e.hp > 340) continue
    if (!hasMechShotLOS(obs, world, e.pos, eyeHeight)) continue

    const d = dist2D(obs.self.pos, e.pos)
    const score = (340 - e.hp) * 1.2 - d * 0.5
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
  realMechs: TrackedEnemy[],
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
    // Never detour > 18m for mortar pickups
    if (p.kind === "mortar" && d > 18) continue
    if (countMechsNear(realMechs, p.pos, 25) >= 2) continue

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
  realMechs: TrackedEnemy[],
  world: WorldQuery,
  eyeHeight: number,
  lastTargetId: number | null,
): TrackedEnemy | null {
  let best: TrackedEnemy | null = null
  let bestScore = -Infinity

  for (const e of realMechs) {
    const d = dist2D(obs.self.pos, e.pos)
    const hpRatio = e.hp / Math.max(1, e.maxHp)

    // Heavily favor low HP + high confidence + close range
    let score = (1 - hpRatio) * 115 + e.confidence * 70 - d * 0.55
    if (e.hp > 0 && e.hp <= 340) score += 55
    if (e.charging) score += 18
    if (e.confidence >= 0.9 && hasMechShotLOS(obs, world, e.pos, eyeHeight)) {
      score += 22
    }
    // Stickiness hysteresis to prevent target thrashing in 1v2+
    if (lastTargetId !== null && e.id === lastTargetId) {
      score += 35
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

function fleeFromCentroid(
  me: Vec3,
  positions: Vec3[],
  stepDist: number,
  obs: Observation,
  world: WorldQuery,
): Vec3 {
  if (positions.length === 0) {
    return clampToSafeZone(obs.zone.next_center[0], obs.zone.next_center[1], obs, world)
  }

  let cx = 0
  let cy = 0
  for (const p of positions) {
    cx += p[0]
    cy += p[1]
  }
  cx /= positions.length
  cy /= positions.length

  let dx = me[0] - cx
  let dy = me[1] - cy
  let d = Math.hypot(dx, dy)

  if (d < 1e-3) {
    // Degenerate: surrounded symmetrically; break perpendicular to first threat or toward safe zone
    const altX = obs.zone.next_center[0] - me[0]
    const altY = obs.zone.next_center[1] - me[1]
    const altD = Math.hypot(altX, altY)
    if (altD > 1e-3) {
      dx = altX
      dy = altY
      d = altD
    } else {
      dx = 1
      dy = 0
      d = 1
    }
  }

  const tx = me[0] + (dx / d) * stepDist
  const ty = me[1] + (dy / d) * stepDist
  return clampToSafeZone(tx, ty, obs, world)
}

function computeOptimalCombatRange(
  obs: Observation,
  config: Config,
  target: TrackedEnemy,
  otherMechsCount: number,
): number {
  const laserW = obs.self.weapons.find((w) => w?.kind === "laser") ?? null
  const lightningW = obs.self.weapons.find((w) => w?.kind === "lightning") ?? null
  const gunW = obs.self.weapons.find((w) => w?.kind === "gun") ?? null

  const lightningRange =
    lightningW?.stats?.range ?? config.weapons.lightning?.range ?? 45

  if (lightningW) {
    const isolated1v1 = otherMechsCount === 0
    const laserOnCooldown = laserW !== null && laserW.cooldown > 0.6
    const shouldCloseForLightning =
      isolated1v1 && (!laserW || laserOnCooldown || target.charging)

    if (shouldCloseForLightning) {
      return lightningRange * 0.78
    }
  }

  if (laserW) {
    return 68
  }

  if (lightningW) {
    return Math.max(40, lightningRange * 0.88)
  }

  if (gunW) {
    return 44
  }

  return 62
}

interface StrafeResult {
  point: Vec3
  dir: 1 | -1
}

function getCoverBiasedStrafePoint(
  obs: Observation,
  targetPos: Vec3,
  optRange: number,
  secondaryThreats: Vec3[],
  threats: ThreatState,
  world: WorldQuery,
  eyeHeight: number,
  mechRadius: number | undefined,
  prevCover: Vec3 | null,
  prevDir: 1 | -1,
  canFlip: boolean,
): StrafeResult {
  const me = obs.self.pos
  const rx = me[0] - targetPos[0]
  const ry = me[1] - targetPos[1]
  const d = Math.hypot(rx, ry)

  const ux = d > 1e-3 ? rx / d : 1
  const uy = d > 1e-3 ? ry / d : 0

  // Step radial distance smoothly so local tangent walkability probes stay accurate
  const radialDelta = Math.max(-18, Math.min(18, optRange - d))
  const stepR = Math.max(12, d + radialDelta)
  const strafeStep = 14
  const targetMid: Vec3 = [targetPos[0], targetPos[1], targetPos[2] + 4.5]

  let bestDir: 1 | -1 = prevDir
  let bestScore = -Infinity
  let bestRawX = me[0]
  let bestRawY = me[1]

  const candidates: Array<1 | -1> = [1, -1]
  for (const dir of candidates) {
    const tangX = -uy * dir
    const tangY = ux * dir

    const candX = targetPos[0] + ux * stepR + tangX * strafeStep
    const candY = targetPos[1] + uy * stepR + tangY * strafeStep
    const candZ = world.surfaceZAt(candX, candY, me[2])
    const candPos: Vec3 = [candX, candY, candZ]

    const walkable = world.isPointWalkable(candX, candY, me[2], mechRadius)
    const directWalk = walkable && world.hasDirectWalkLine(me, candPos, mechRadius)
    const inSafe = isPointInSafeZone([candX, candY], obs, 8)

    let score = 0
    score += walkable ? 48 : -65
    if (directWalk) score += 16
    score += inSafe ? 28 : -48

    // Prefer keeping shot LOS from candidate while hugging nearby duck-in cover
    const candEye: Vec3 = [candX, candY, candZ + eyeHeight]
    if (world.hasShotLOS(candEye, targetMid)) {
      score += 10
    }

    const probe8X = candX + tangX * 8
    const probe8Y = candY + tangY * 8
    const probe8Z = world.surfaceZAt(probe8X, probe8Y, candZ)
    if (!world.hasShotLOS([probe8X, probe8Y, probe8Z + eyeHeight], targetMid)) {
      score += 22
    } else {
      const probe16X = candX + tangX * 16
      const probe16Y = candY + tangY * 16
      const probe16Z = world.surfaceZAt(probe16X, probe16Y, candZ)
      if (!world.hasShotLOS([probe16X, probe16Y, probe16Z + eyeHeight], targetMid)) {
        score += 12
      }
    }

    if (prevCover) {
      const dBefore = dist2D(me, prevCover)
      const dAfter = dist2D(candPos, prevCover)
      score += Math.max(-10, Math.min(12, (dBefore - dAfter) * 0.7))
    }

    // Prefer moving farther away from any secondary threats
    for (const st of secondaryThreats) {
      const dBefore = dist2D(me, st)
      const dAfter = dist2D(candPos, st)
      score += Math.max(-25, Math.min(25, (dAfter - dBefore) * 1.4))
    }

    // Align with active projectile/laser dodge vector when dodging
    if (threats.dodgeUrgency > 0.25) {
      const dot = tangX * threats.dodgeVec[0] + tangY * threats.dodgeVec[1]
      score += dot * 20 * threats.dodgeUrgency
    }

    // Direction hysteresis: stick unless flip window allows breaking projectile lead
    if (dir === prevDir) {
      score += canFlip ? -5 : 14
    }

    if (score > bestScore) {
      bestScore = score
      bestDir = dir
      bestRawX = candX
      bestRawY = candY
    }
  }

  return {
    point: clampToSafeZone(bestRawX, bestRawY, obs, world),
    dir: bestDir,
  }
}

function findRetreatTarget(
  obs: Observation,
  realMechs: TrackedEnemy[],
  world: WorldQuery,
  eyeHeight: number,
  prevCover: Vec3 | null,
  mechRadius: number | undefined,
): { target: Vec3; usedCover: boolean } {
  const enemyPositions = realMechs.map((e) => e.pos)
  const isSafe = (cx: number, cy: number) => isPointInSafeZone([cx, cy], obs, 4)

  if (enemyPositions.length > 0) {
    const coverNear = world.findCover(
      obs.self.pos,
      enemyPositions,
      38,
      isSafe,
      eyeHeight,
      prevCover,
      mechRadius,
    )
    if (coverNear) {
      return { target: coverNear, usedCover: true }
    }

    const coverFar = world.findCover(
      obs.self.pos,
      enemyPositions,
      60,
      isSafe,
      eyeHeight,
      prevCover,
      mechRadius,
    )
    if (coverFar) {
      return { target: coverFar, usedCover: true }
    }

    return {
      target: fleeFromCentroid(obs.self.pos, enemyPositions, 42, obs, world),
      usedCover: false,
    }
  }

  return {
    target: clampToSafeZone(obs.zone.next_center[0], obs.zone.next_center[1], obs, world),
    usedCover: false,
  }
}

function findSoundInvestigatePoint(
  obs: Observation,
  world: WorldQuery,
  combatOnly: boolean,
): Vec3 | null {
  let bestBearing: number | null = null
  let bestDistStep = 48
  let bestScore = -Infinity

  for (const s of obs.sounds) {
    const isCombat = COMBAT_SOUND_KINDS.has(s.kind)
    const isMove = MOVEMENT_SOUND_KINDS.has(s.kind)
    if (combatOnly && !isCombat) continue
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
 * Create the v4 "Apex Wave-Slayer & FFA Snowball" macro strategy engine.
 */
export function createStrategy(config: Config): Strategy {
  let inRegenHide = false
  let inZoneSprint = false
  let patrolAngle: number | null = null

  // State hysteresis latches
  let lastTargetId: number | null = null
  let prevCoverPos: Vec3 | null = null
  let prevCoverExpireT = 0
  let activeSoundGoal: Vec3 | null = null
  let activeSoundExpireT = 0
  let activeRoofSpot: Vec3 | null = null
  let activeRoofExpireT = 0
  let prevStrafeDir: 1 | -1 = 1
  let nextStrafeFlipT = 0

  function getActivePrevCover(t: number): Vec3 | null {
    return t <= prevCoverExpireT ? prevCoverPos : null
  }

  function latchCover(pos: Vec3 | null, t: number): void {
    if (pos) {
      prevCoverPos = pos
      prevCoverExpireT = t + COVER_LATCH_S
    }
  }

  return {
    decide(obs: Observation, world: WorldQuery, threats: ThreatState) {
      const pick = pickUpgrade(obs, config)
      const desiredLoadout = DESIRED_LOADOUT
      const eyeHeight = obs.self.stats.eye_height ?? 8
      const mechRadius = obs.self.stats.radius ?? config.mech.radius
      const zoneAdvice = evaluateZone(obs, world, config, inZoneSprint)
      inZoneSprint = zoneAdvice.mustSprint

      const hpRatio = obs.self.hp / Math.max(1, obs.self.max_hp)
      const isPractice = threats.ffaConfidence < 0.5
      const activePrevCover = getActivePrevCover(obs.t)

      // CRITICAL: Filter real mechs only (exclude sound ghosts id < 0 and NPCs)
      const realMechs = threats.enemies.filter(isRealMech)
      const realMechPositions = realMechs.map((e) => e.pos)

      let nearestRealMechDist = Infinity
      for (const e of realMechs) {
        const d = dist2D(obs.self.pos, e.pos)
        if (d < nearestRealMechDist) nearestRealMechDist = d
      }

      const silentNearEnemies =
        isPractice && threats.spottedByCount === 0 && nearestRealMechDist < 75

      // Priority 1 — Safe Zone (zone_sprint): avoid zone damage (ignores armor & resets regen)
      if (zoneAdvice.mustSprint) {
        if (!obs.self.in_zone) {
          inRegenHide = false
        }
        const bestMech = pickBestMechTarget(obs, realMechs, world, eyeHeight, lastTargetId)
        lastTargetId = bestMech?.id ?? null
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

      // Priority 2 — Hardened Kill-Confirm Override & Fast Combat Regen (regen_hide)
      const killConfirmTarget = findKillConfirmTarget(
        obs,
        realMechs,
        threats.spottedByCount,
        world,
        eyeHeight,
      )

      let naniteStacks = 0
      for (const u of obs.self.upgrades) {
        if (u === "nanites") naniteStacks++
      }

      let enterRegenRatio: number
      if (threats.spottedByCount >= 3) {
        enterRegenRatio = naniteStacks >= 2 ? 0.58 : 0.54
      } else if (threats.spottedByCount === 2) {
        enterRegenRatio = naniteStacks >= 2 ? 0.54 : 0.48
      } else {
        enterRegenRatio = naniteStacks >= 2 ? 0.48 : 0.42
      }

      const exitRegenRatio = naniteStacks >= 1 ? 0.86 : 0.80

      if (killConfirmTarget !== null || !obs.self.in_zone || hpRatio >= exitRegenRatio) {
        inRegenHide = false
      } else if (hpRatio < enterRegenRatio && obs.self.in_zone) {
        inRegenHide = true
      }

      if (inRegenHide && obs.self.in_zone) {
        const retreat = findRetreatTarget(
          obs,
          realMechs,
          world,
          eyeHeight,
          activePrevCover,
          mechRadius,
        )
        if (retreat.usedCover) {
          latchCover(retreat.target, obs.t)
        }
        // Only hold fire if we actually found cover or are unspotted; if chased in open with no cover, shoot back!
        const canActuallyBreakLOS = retreat.usedCover || threats.spottedByCount === 0
        return {
          pick,
          order: {
            mode: "regen_hide",
            moveTarget: retreat.target,
            primaryTargetId: canActuallyBreakLOS ? null : (realMechs[0]?.id ?? null),
            desiredLoadout,
            preferSilent: false,
            holdFireForRegen: canActuallyBreakLOS,
          },
        }
      }

      // Priority 3 — Timed Supply Drops with Cover Staging (contest_drop)
      if (obs.drops.length > 0 && !(killConfirmTarget && hpRatio < enterRegenRatio)) {
        let bestDrop: DropObs | null = null
        let bestDropDist = Infinity
        let dropEnemyId: number | null = null

        for (const drop of obs.drops) {
          if (drop.lands_in > 25) continue
          if (!isPointInSafeZone(drop.pos, obs, 4)) continue

          const myDist = dist2D(obs.self.pos, drop.pos)
          const maxDropDist = hpRatio < 0.75 ? 180 : 135
          if (myDist > maxDropDist) continue
          // Don't march past a close enemy who is actively fighting us
          if (nearestRealMechDist <= 55 && myDist > drop.radius + 12) continue
          const almostCaptured =
            (drop.holder === obs.self.id || myDist <= drop.radius + 4) &&
            drop.progress >= 2.5 &&
            hpRatio > 0.5

          if (isPractice) {
            if (
              !almostCaptured &&
              (countMechsNear(realMechs, drop.pos, 65) > 0 ||
                nearestRealMechDist <= 65 ||
                threats.spottedByCount >= 2)
            ) {
              continue
            }
          } else {
            if (countMechsNear(realMechs, drop.pos, 45) > 1) continue
          }

          let nearestEnemyToDrop = Infinity
          let nearEnemyId: number | null = null
          for (const e of realMechs) {
            const ed = dist2D(e.pos, drop.pos)
            if (ed < nearestEnemyToDrop) {
              nearestEnemyToDrop = ed
              if (ed <= 45) nearEnemyId = e.id
            }
          }

          if (!(almostCaptured || hpRatio > 0.45 || myDist < nearestEnemyToDrop)) continue

          if (myDist < bestDropDist) {
            bestDropDist = myDist
            bestDrop = drop
            dropEnemyId = nearEnemyId
          }
        }

        if (bestDrop) {
          const readyToRush = bestDrop.lands_in <= bestDropDist / 14 + 1.0
          let dropMoveTarget: Vec3

          if (readyToRush) {
            dropMoveTarget = world.isPointWalkable(
              bestDrop.pos[0],
              bestDrop.pos[1],
              bestDrop.pos[2],
              mechRadius,
            )
              ? bestDrop.pos
              : world.snapToWalkable(
                  bestDrop.pos[0],
                  bestDrop.pos[1],
                  obs.self.pos[2],
                  mechRadius,
                )
          } else {
            // Stage at nearest cover 20-45m from the drop until ready to rush
            const dropPos = bestDrop.pos
            const threatRef = realMechPositions.length > 0 ? realMechPositions : [dropPos]
            const isStagingSafe = (cx: number, cy: number) => {
              const dd = dist2D([cx, cy], dropPos)
              return dd >= 20 && dd <= 45 && isPointInSafeZone([cx, cy], obs, 4)
            }

            let stageCover: Vec3 | null = null
            if (bestDropDist <= 75) {
              stageCover = world.findCover(
                obs.self.pos,
                threatRef,
                48,
                isStagingSafe,
                eyeHeight,
                activePrevCover,
                mechRadius,
              )
            }

            if (stageCover) {
              latchCover(stageCover, obs.t)
              dropMoveTarget = stageCover
            } else {
              const stagingAnchor = getStandoffPoint(obs.self.pos, dropPos, 32, obs, world)
              const anchorCover = world.findCover(
                stagingAnchor,
                threatRef,
                22,
                isStagingSafe,
                eyeHeight,
                activePrevCover,
                mechRadius,
              )
              if (anchorCover) {
                latchCover(anchorCover, obs.t)
                dropMoveTarget = anchorCover
              } else {
                dropMoveTarget = stagingAnchor
              }
            }
          }

          return {
            pick,
            order: {
              mode: "contest_drop",
              moveTarget: dropMoveTarget,
              primaryTargetId: dropEnemyId,
              desiredLoadout,
              preferSilent: !readyToRush && silentNearEnemies,
              holdFireForRegen: false,
            },
          }
        }
      }

      const bestMech =
        killConfirmTarget ?? pickBestMechTarget(obs, realMechs, world, eyeHeight, lastTargetId)
      lastTargetId = bestMech?.id ?? null

      // Priority 4 — Combat-Gated Economy & Smart Cube Cap (10 / 15)
      if (!killConfirmTarget) {
        const inCombatOrCloseMech =
          threats.spottedByCount > 0 || nearestRealMechDist <= 55

        // 4a. Loose cubes: scoop up to 10, and 12..14 to hit the 15-cube 5th upgrade; stop >= 15
        const wantLooseCubes =
          obs.self.cubes < 10 || (obs.self.cubes >= 12 && obs.self.cubes < 15)

        if (wantLooseCubes) {
          const maxCubeDist = inCombatOrCloseMech ? 10 : 45
          let bestCubePos: Vec3 | null = null
          let bestCubeDist = maxCubeDist
          for (const c of obs.cubes) {
            if (!isPointInSafeZone(c.pos, obs, 6)) continue
            const d = dist2D(obs.self.pos, c.pos)
            if (d >= bestCubeDist) continue
            if (countMechsNear(realMechs, c.pos, 25) >= 2) continue
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
                preferSilent: silentNearEnemies,
                holdFireForRegen: false,
              },
            }
          }
        }

        // 4b. Grab desired floor pickups (combat-gated to < 10m when threatened, mortar <= 18m)
        const maxPickupDist = inCombatOrCloseMech ? 10 : 70
        const pickupPos = findDesiredPickup(obs, desiredLoadout, maxPickupDist, realMechs)
        if (pickupPos) {
          return {
            pick,
            order: {
              mode: "farm_crate",
              moveTarget: pickupPos,
              primaryTargetId: bestMech?.id ?? null,
              desiredLoadout,
              preferSilent: silentNearEnemies,
              holdFireForRegen: false,
            },
          }
        }

        // 4c. Farm crates & NPCs up to 10 cubes ONLY when completely unspotted & nearest real mech > 80m
        const safeToFarm = threats.spottedByCount === 0 && nearestRealMechDist > 80

        if (obs.self.cubes < 10 && safeToFarm) {
          const hasEmptySlot = obs.self.weapons.some((w) => w === null)
          let bestFarmMode: "farm_crate" | "farm_npc" | null = null
          let bestFarmPos: Vec3 | null = null
          let bestFarmTargetId: number | null = null
          let bestFarmScore = -Infinity

          for (const crate of obs.crates) {
            if (!isPointInSafeZone(crate.pos, obs, 6)) continue
            // Skip crates high on unreachable rooftops when on ground (or far below when on roof)
            if (Math.abs(crate.pos[2] - obs.self.pos[2]) > 3.5) continue
            const d = dist2D(obs.self.pos, crate.pos)
            if (d > 95) continue
            if (countMechsNear(realMechs, crate.pos, 30) > 0) continue

            const score = (hasEmptySlot ? 60 : 45) - d
            if (score > bestFarmScore) {
              bestFarmScore = score
              bestFarmMode = "farm_crate"
              // Stand 16m back so pitch (-0.36 rad) stays well inside min_pitch (-0.7 rad)!
              bestFarmPos = getStandoffPoint(obs.self.pos, crate.pos, 16, obs, world)
              bestFarmTargetId = null
            }
          }

          for (const e of threats.enemies) {
            if (e.kind !== "npc" || e.id < 0) continue
            if (!isPointInSafeZone(e.pos, obs, 6)) continue
            const d = dist2D(obs.self.pos, e.pos)
            if (d > 95) continue
            if (countMechsNear(realMechs, e.pos, 30) > 0) continue

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

      // Priority 5 — Active 1v1 Cover-Biased Strafe & Early 1vN "Slice-the-Pie" (engage)
      if (bestMech) {
        // Clear latched patrol/sound goals once engaged with a real mech
        activeSoundGoal = null

        const otherMechs = realMechs
          .filter((e) => e.id !== bestMech.id && dist2D(obs.self.pos, e.pos) <= 140)
          .map((e) => e.pos)

        const optRange = computeOptimalCombatRange(obs, config, bestMech, otherMechs.length)
        const isSafe = (cx: number, cy: number) => isPointInSafeZone([cx, cy], obs, 4)

        let moveTarget: Vec3
        if (otherMechs.length > 0) {
          // Early 1vN Slice-the-Pie: isolate bestMech behind cover from ANY other real mech <= 140m
          const peekCover = world.findPeekCover(
            obs.self.pos,
            bestMech.pos,
            otherMechs,
            48,
            isSafe,
            eyeHeight,
            activePrevCover,
            mechRadius,
          )
          if (peekCover) {
            latchCover(peekCover, obs.t)
            moveTarget = peekCover
          } else {
            const cover = world.findCover(
              obs.self.pos,
              otherMechs,
              48,
              isSafe,
              eyeHeight,
              activePrevCover,
              mechRadius,
            )
            if (cover) {
              latchCover(cover, obs.t)
              moveTarget = cover
            } else {
              // No peek/hard cover in 1v2+: kite away from multi-mech centroid
              const allThreatPositions = [bestMech.pos, ...otherMechs]
              moveTarget = fleeFromCentroid(
                obs.self.pos,
                allThreatPositions,
                Math.max(36, optRange * 0.6),
                obs,
                world,
              )
            }
          }
        } else {
          // Isolated 1v1 Duel: Cover-Biased Strafe at optimal weapon range
          const distantSecondaryThreats = realMechs
            .filter((e) => e.id !== bestMech.id)
            .map((e) => e.pos)

          const canFlip = obs.t >= nextStrafeFlipT
          const strafe = getCoverBiasedStrafePoint(
            obs,
            bestMech.pos,
            optRange,
            distantSecondaryThreats,
            threats,
            world,
            eyeHeight,
            mechRadius,
            activePrevCover,
            prevStrafeDir,
            canFlip,
          )
          if (strafe.dir !== prevStrafeDir) {
            prevStrafeDir = strafe.dir
            nextStrafeFlipT = obs.t + 1.5
          } else if (canFlip) {
            nextStrafeFlipT = obs.t + 1.0
          }
          moveTarget = strafe.point
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

      // Priority 6 — Active Hunter Search (Latched Sounds) & Defensible Rooftop Anchors
      if (activeSoundGoal !== null) {
        if (
          obs.t > activeSoundExpireT ||
          dist2D(obs.self.pos, activeSoundGoal) < 12 ||
          !isPointInSafeZone(activeSoundGoal, obs, 6)
        ) {
          activeSoundGoal = null
        }
      }

      // In FFA, third-party latched combat sounds first
      if (!isPractice) {
        if (activeSoundGoal === null) {
          const combatSound = findSoundInvestigatePoint(obs, world, true)
          if (combatSound) {
            activeSoundGoal = combatSound
            activeSoundExpireT = obs.t + SOUND_LATCH_S
          }
        }
        if (activeSoundGoal !== null) {
          return {
            pick,
            order: {
              mode: "engage",
              moveTarget: activeSoundGoal,
              primaryTargetId: null,
              desiredLoadout,
              preferSilent: false,
              holdFireForRegen: false,
            },
          }
        }
      }

      // Claim defensible high ground (12-24m wide roofs / penthouses) ONLY once farmed (>= 6 cubes) or mid/late game (>= 75s)
      if (activeRoofSpot !== null) {
        const roofUnsafe =
          obs.t > activeRoofExpireT ||
          !isPointInSafeZone(activeRoofSpot, obs, 6) ||
          countMechsNear(realMechs, activeRoofSpot, 35) > 0 ||
          (obs.self.cubes < 6 && obs.t < 75)
        if (roofUnsafe) {
          activeRoofSpot = null
        }
      }

      if (obs.self.energy >= 55 && (obs.self.cubes >= 6 || obs.t >= 75)) {
        if (activeRoofSpot === null) {
          const roof = world.findRooftopSpot(
            obs.self.pos,
            obs.zone.next_center,
            obs.zone.next_radius,
            150,
            realMechPositions,
          )
          if (roof) {
            activeRoofSpot = roof
            activeRoofExpireT = obs.t + 10.0
          }
        }
        if (activeRoofSpot !== null) {
          return {
            pick,
            order: {
              mode: "engage",
              moveTarget: activeRoofSpot,
              primaryTargetId: null,
              desiredLoadout,
              preferSilent: false,
              holdFireForRegen: false,
            },
          }
        }
      }

      // Fallback latched sound search (any combat/near movement sound) when no rooftop anchor is available
      if (activeSoundGoal === null) {
        const anySound = findSoundInvestigatePoint(obs, world, isPractice)
        if (anySound) {
          activeSoundGoal = anySound
          activeSoundExpireT = obs.t + SOUND_LATCH_S
        }
      }
      if (activeSoundGoal !== null) {
        return {
          pick,
          order: {
            mode: "engage",
            moveTarget: activeSoundGoal,
            primaryTargetId: null,
            desiredLoadout,
            preferSilent: silentNearEnemies,
            holdFireForRegen: false,
          },
        }
      }

      // Final fallback: Patrol the inner safe-zone ring (0.45 * next_radius)
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
          preferSilent: silentNearEnemies,
          holdFireForRegen: false,
        },
      }
    },
  }
}
