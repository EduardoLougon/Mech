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
import type { WeaponObs } from "../mechfight.ts"
import {
  aimDiff,
  idleAim,
  isAligned,
  muzzlePos,
  normalizeAngle,
  solveDirectAim,
  solveGunIntercept,
  solveMortarArc,
} from "./aim.ts"

const READY_CD = 0.10

export interface CombatWeaponState {
  lastLaserVisibleTargetT: number
}

export function createCombatWeaponState(): CombatWeaponState {
  return { lastLaserVisibleTargetT: -1e9 }
}

const defaultWeaponState = createCombatWeaponState()

interface SlotPlan {
  slot: 0 | 1
  kind: WeaponKind
  score: number
  aim: Vec2
  fire: boolean
  reload?: boolean
  targetPos?: Vec3
  targetDist?: number
  trackingOnly?: boolean
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function mechHitbox(enemy: TrackedEnemy, config: Config): { r: number; halfH: number } {
  const sizePerCube =
    typeof config.cubes.size_per_cube === "number" ? config.cubes.size_per_cube : 0.05
  const sizeScale = 1 + sizePerCube * enemy.cubes
  return {
    r: 2.5 * sizeScale,
    halfH: 4.5 * sizeScale,
  }
}

function resolveAimPoint(
  muzzle: Vec3,
  basePos: Vec3,
  halfH: number,
  world: WorldQuery,
  allowUpperTorso: boolean,
): { point: Vec3; hasLOS: boolean; aimHalfH: number; isUpper: boolean } {
  const center: Vec3 = [basePos[0], basePos[1], basePos[2] + halfH]
  if (world.hasShotLOS(muzzle, center)) {
    return { point: center, hasLOS: true, aimHalfH: halfH, isUpper: false }
  }
  if (allowUpperTorso) {
    const upper: Vec3 = [basePos[0], basePos[1], basePos[2] + halfH * 1.6]
    if (world.hasShotLOS(muzzle, upper)) {
      return { point: upper, hasLOS: true, aimHalfH: halfH * 0.45, isUpper: true }
    }
  }
  return { point: center, hasLOS: false, aimHalfH: halfH, isUpper: false }
}

function isRearShot(
  selfPos: Vec3,
  enemy: TrackedEnemy,
  config: Config,
  marginRad = 0.0,
): boolean {
  const frontHalfArcRad = ((config.mech.front_arc_deg ?? 180) * 0.5 * Math.PI) / 180
  const bearingFromEnemyToMe = Math.atan2(selfPos[1] - enemy.pos[1], selfPos[0] - enemy.pos[0])
  const angleOffFront = Math.abs(normalizeAngle(bearingFromEnemyToMe - enemy.aim[0]))
  return angleOffFront > frontHalfArcRad + marginRad
}

function trackingScore(bestScore: number): number {
  return Math.min(20, Math.max(8, bestScore * 0.25))
}

function safeAwayAim(obs: Observation, threats: ThreatState): Vec2 {
  const awayYaw =
    threats.primaryThreatBearing !== null
      ? normalizeAngle(threats.primaryThreatBearing + Math.PI)
      : normalizeAngle(obs.self.aim[0] + Math.PI * 0.5)
  return [awayYaw, 1.15]
}

function evaluateLaser(
  slot: 0 | 1,
  w: WeaponObs,
  obs: Observation,
  config: Config,
  world: WorldQuery,
  threats: ThreatState,
  order: MacroOrder,
  skipFarm: boolean,
  state: CombatWeaponState,
  effectiveHoldRegen: boolean,
): SlotPlan | null {
  const self = obs.self
  const muzzle = muzzlePos(self, "laser")
  const charge = w.charge ?? 0
  const readyToStart = w.cooldown <= READY_CD

  const fullCharge = w.stats.charge ?? config.weapons.laser.charge ?? 0.75
  const minCharge = w.stats.min_charge ?? config.weapons.laser.min_charge ?? 0.15
  const holdS = w.stats.hold_s ?? config.weapons.laser.hold_s ?? 2.0
  const range = w.stats.range ?? config.weapons.laser.range ?? 280
  const damage = w.stats.damage ?? config.weapons.laser.damage ?? 315
  const minFrac = w.stats.min_frac ?? config.weapons.laser.min_frac ?? 0.35
  const minPitch = self.stats.min_pitch ?? config.mech.min_pitch ?? -0.7
  const maxPitch = self.stats.max_pitch ?? config.mech.max_pitch ?? 1.3
  const rearMultCfg = config.mech.rear_mult ?? 1.5
  const dmgPerCube =
    typeof config.cubes.damage_per_cube === "number" ? config.cubes.damage_per_cube : 0.04
  const statCap =
    typeof config.cubes.stat_cap === "number" ? config.cubes.stat_cap : 10
  const cubeMult = 1 + dmgPerCube * Math.min(self.cubes, statCap)

  const enemyLightningClose = threats.enemies.some(
    (e) =>
      e.kind === "mech" &&
      e.confidence >= 0.7 &&
      e.weapons.includes("lightning") &&
      dist3(e.pos, self.pos) <= 45,
  )

  const unsafeToStartCharge =
    threats.dodgeUrgency > 0.35 ||
    !self.in_zone ||
    order.mode === "zone_sprint" ||
    order.mode === "regen_hide" ||
    threats.chargingLaserThreat

  let bestEnemy: TrackedEnemy | null = null
  let bestScore = -Infinity
  let bestLOS = false
  let bestAimPoint: Vec3 | null = null
  let bestR = 2.5
  let bestAimHalfH = 4.5
  let bestDist = Infinity

  let bestAlignedVisible: { aim: Vec2; pos: Vec3; dist: number; err: number } | null = null
  let anyVisibleMech = false

  for (const e of threats.enemies) {
    if (e.kind !== "mech") continue

    // Lead laser target by 0.05s (1 tick latency)
    const ledX = e.pos[0] + e.vel[0] * 0.05
    const ledY = e.pos[1] + e.vel[1] * 0.05
    const rawLedZ = e.pos[2] + e.vel[2] * 0.05
    const ledZ =
      e.vel[2] < -1.5 ? Math.max(world.surfaceZAt(ledX, ledY, e.pos[2]), rawLedZ) : rawLedZ
    const ledBase: Vec3 = [ledX, ledY, ledZ]

    const { r, halfH } = mechHitbox(e, config)
    const aimInfo = resolveAimPoint(muzzle, ledBase, halfH, world, true)
    const c = aimInfo.point
    const d = dist3(muzzle, c)
    if (d > range) continue

    const rawShotLOS = aimInfo.hasLOS
    const hasLOS = e.confidence >= 0.95 && rawShotLOS

    if (hasLOS) {
      anyVisibleMech = true
      const candidateAim = solveDirectAim(muzzle, c)
      const { yawDiff, pitchDiff } = aimDiff(self.aim, candidateAim)
      const err = yawDiff + pitchDiff
      if (!bestAlignedVisible || err < bestAlignedVisible.err) {
        bestAlignedVisible = { aim: candidateAim, pos: c, dist: d, err }
      }
    }

    // Restrict blind pre-charge (!hasLOS) to d <= 75m && threats.spottedByCount <= 1
    const dx = self.pos[0] - e.pos[0]
    const dy = self.pos[1] - e.pos[1]
    const hd = Math.hypot(dx, dy)
    const relVx = e.vel[0] - self.vel[0]
    const relVy = e.vel[1] - self.vel[1]
    const closingSpeed = hd > 1e-3 ? (dx * relVx + dy * relVy) / hd : 0
    const approaching = closingSpeed > 1.5
    const canPrecharge =
      hasLOS ||
      (d <= 75 &&
        threats.spottedByCount <= 1 &&
        ((e.confidence >= 0.7 && rawShotLOS) || (e.confidence >= 0.9 && approaching)))

    if (!canPrecharge && charge === 0) continue

    const cookoffMult = e.weapons.includes("mortar") ? 1.6 : 1.0
    const rearHit = isRearShot(self.pos, e, config)
    const rearMult = rearHit ? rearMultCfg : 1.0

    let score = hasLOS ? 105 : 60 * e.confidence
    if (e.weapons.includes("mortar")) score += 60 // +60% cookoff priority
    if (rearHit) score += 45 // 1.5x rear-armor priority
    if (e.id === order.primaryTargetId) score += 30
    if (e.hp > 0 && e.hp <= damage * cubeMult * cookoffMult * rearMult) score += 25
    score -= d * 0.15

    if (score > bestScore) {
      bestScore = score
      bestEnemy = e
      bestLOS = hasLOS
      bestAimPoint = c
      bestR = r
      bestAimHalfH = aimInfo.aimHalfH
      bestDist = d
    }
  }

  // Check if any visible farm target exists (so charging on a visible NPC/crate doesn't abort at 0.35s)
  let anyVisibleFarm = false
  if (!anyVisibleMech && !skipFarm && charge > 0) {
    for (const npc of threats.enemies) {
      if (npc.kind !== "npc" || npc.confidence < 0.95) continue
      const c: Vec3 = [npc.pos[0], npc.pos[1], npc.pos[2] + 1.75]
      if (dist3(muzzle, c) <= range && world.hasShotLOS(muzzle, c)) {
        anyVisibleFarm = true
        break
      }
    }
    if (!anyVisibleFarm) {
      for (const crate of obs.crates) {
        const c: Vec3 = [crate.pos[0], crate.pos[1], crate.pos[2] + 1.0]
        if (dist3(muzzle, c) <= range && world.hasShotLOS(muzzle, c)) {
          anyVisibleFarm = true
          break
        }
      }
    }
  }

  const anyVisibleTarget = anyVisibleMech || anyVisibleFarm
  if (charge === 0 || obs.t < state.lastLaserVisibleTargetT || anyVisibleTarget) {
    state.lastLaserVisibleTargetT = obs.t
  }

  // Emergency snap-release while already charging to immediately restore 1.0x move speed
  if (charge > 0) {
    const noVisibleTooLong = !anyVisibleTarget && obs.t - state.lastLaserVisibleTargetT > 0.35
    const emergencyRelease =
      threats.dodgeUrgency > 0.45 ||
      threats.chargingLaserThreat ||
      order.mode === "zone_sprint" ||
      effectiveHoldRegen ||
      noVisibleTooLong

    if (emergencyRelease) {
      if (effectiveHoldRegen) {
        return {
          slot,
          kind: "laser",
          score: 300,
          aim: safeAwayAim(obs, threats),
          fire: false,
        }
      }
      if (bestAlignedVisible) {
        return {
          slot,
          kind: "laser",
          score: 300,
          aim: bestAlignedVisible.aim,
          fire: false,
          targetPos: bestAlignedVisible.pos,
          targetDist: bestAlignedVisible.dist,
        }
      }
      return {
        slot,
        kind: "laser",
        score: 250,
        aim: bestAimPoint ? solveDirectAim(muzzle, bestAimPoint) : self.aim,
        fire: false,
      }
    }
  }

  // If on cooldown (not charging): return tracking-only plan to keep torso pre-aimed
  if (charge === 0 && !readyToStart) {
    if (bestEnemy && bestAimPoint && bestLOS) {
      return {
        slot,
        kind: "laser",
        score: trackingScore(bestScore),
        aim: solveDirectAim(muzzle, bestAimPoint),
        fire: false,
        targetPos: bestAimPoint,
        targetDist: bestDist,
        trackingOnly: true,
      }
    }
    return null
  }

  // Never START charging under unsafe conditions
  if (charge === 0 && unsafeToStartCharge) {
    return null
  }

  if (bestEnemy && bestAimPoint) {
    // Do not start charging if an enemy within 45m holds lightning (unless target is lethal <= 380 HP)
    if (charge === 0 && enemyLightningClose && !(bestEnemy.hp > 0 && bestEnemy.hp <= 380)) {
      return null
    }

    const desiredAim = solveDirectAim(muzzle, bestAimPoint)
    const pitchReachable = desiredAim[1] >= minPitch - 0.02 && desiredAim[1] <= maxPitch + 0.02
    if (charge === 0 && !pitchReachable) {
      return null
    }

    if (bestLOS) {
      const yawThresh = Math.max(0.004, Math.min(0.10, Math.atan2(bestR * 0.82, bestDist)))
      const pitchThresh = Math.max(
        0.006,
        Math.min(0.18, Math.atan2(bestAimHalfH * 0.80, bestDist)),
      )
      const aligned = isAligned(self.aim, desiredAim, yawThresh, pitchThresh)
      const frac = charge >= fullCharge ? 1 : minFrac + (1 - minFrac) * (charge / fullCharge)
      const cookoffMult = bestEnemy.weapons.includes("mortar") ? 1.6 : 1.0
      const rearMultForKill = isRearShot(self.pos, bestEnemy, config, 0.08) ? rearMultCfg : 1.0
      const estDmg = damage * cubeMult * frac * cookoffMult * rearMultForKill
      const earlyKill =
        charge >= minCharge && bestEnemy.hp > 0 && bestEnemy.hp <= estDmg * 0.95
      const overHeld = charge >= fullCharge + 0.35

      const readyToRelease =
        overHeld || !pitchReachable || (aligned && (charge >= fullCharge || earlyKill))
      const fire = charge > 0 ? !readyToRelease : true

      return {
        slot,
        kind: "laser",
        score: bestScore + (charge > 0 ? 200 : 0),
        aim: desiredAim,
        fire,
        targetPos: bestAimPoint,
        targetDist: bestDist,
      }
    }

    // Blind pre-charge (already restricted to d <= 75m && spottedByCount <= 1) or holding briefly
    const fire = charge === 0 ? true : charge < fullCharge + 0.25
    return {
      slot,
      kind: "laser",
      score: bestScore + (charge > 0 ? 200 : 0),
      aim: desiredAim,
      fire,
      targetPos: bestAimPoint,
      targetDist: bestDist,
    }
  }

  // Fallback to visible NPCs and crates when no enemy mech is prioritized (skip if enemy lightning close)
  if (!skipFarm && !(charge === 0 && enemyLightningClose)) {
    let bestFarmAim: Vec2 | null = null
    let bestFarmScore = -Infinity
    let bestFarmPos: Vec3 | undefined
    let bestFarmDist = Infinity
    let bestFarmFire = false

    for (const npc of threats.enemies) {
      if (npc.kind !== "npc" || npc.confidence < 0.95) continue
      const c: Vec3 = [
        npc.pos[0] + npc.vel[0] * 0.05,
        npc.pos[1] + npc.vel[1] * 0.05,
        npc.pos[2] + 1.75,
      ]
      const d = dist3(muzzle, c)
      if (d > range || !world.hasShotLOS(muzzle, c)) continue

      const desiredAim = solveDirectAim(muzzle, c)
      if (desiredAim[1] < minPitch - 0.02 || desiredAim[1] > maxPitch + 0.02) continue

      const score = 48 - d * 0.1 + (charge > 0 ? 200 : 0)
      if (score > bestFarmScore) {
        const yawThresh = Math.max(0.004, Math.min(0.10, Math.atan2(1.5 * 0.82, d)))
        const pitchThresh = Math.max(0.006, Math.min(0.18, Math.atan2(1.75 * 0.80, d)))
        const aligned = isAligned(self.aim, desiredAim, yawThresh, pitchThresh)
        const frac = charge >= fullCharge ? 1 : minFrac + (1 - minFrac) * (charge / fullCharge)
        const estDmg = damage * cubeMult * frac
        const ready =
          charge >= fullCharge + 0.35 ||
          (aligned &&
            (charge >= fullCharge || (charge >= minCharge && npc.hp > 0 && npc.hp <= estDmg * 0.95)))
        bestFarmScore = score
        bestFarmAim = desiredAim
        bestFarmPos = c
        bestFarmDist = d
        bestFarmFire = charge > 0 ? !ready : true
      }
    }

    for (const crate of obs.crates) {
      const c: Vec3 = [crate.pos[0], crate.pos[1], crate.pos[2] + 1.0]
      const d = dist3(muzzle, c)
      if (d > range || !world.hasShotLOS(muzzle, c)) continue
      const desiredAim = solveDirectAim(muzzle, c)
      if (desiredAim[1] < minPitch - 0.02 || desiredAim[1] > maxPitch + 0.02) continue

      const score = 26 - d * 0.1 + (charge > 0 ? 200 : 0)
      if (score > bestFarmScore) {
        const yawThresh = Math.max(0.004, Math.min(0.10, Math.atan2(1.0 * 0.82, d)))
        const pitchThresh = Math.max(0.006, Math.min(0.18, Math.atan2(1.0 * 0.80, d)))
        const aligned = isAligned(self.aim, desiredAim, yawThresh, pitchThresh)
        const frac = charge >= fullCharge ? 1 : minFrac + (1 - minFrac) * (charge / fullCharge)
        const estDmg = damage * cubeMult * frac
        const crateHp = crate.hp ?? config.crates.hp ?? 120
        const ready =
          charge >= fullCharge + 0.35 ||
          (aligned &&
            (charge >= fullCharge || (charge >= minCharge && crateHp <= estDmg * 0.95)))
        bestFarmScore = score
        bestFarmAim = desiredAim
        bestFarmPos = c
        bestFarmDist = d
        bestFarmFire = charge > 0 ? !ready : true
      }
    }

    if (bestFarmAim) {
      return {
        slot,
        kind: "laser",
        score: bestFarmScore,
        aim: bestFarmAim,
        fire: bestFarmFire,
        targetPos: bestFarmPos,
        targetDist: bestFarmDist,
      }
    }
  }

  if (charge > 0) {
    // Already charging with no target: release if near timeout, else hold briefly (aborts at 0.35s above)
    return {
      slot,
      kind: "laser",
      score: 150,
      aim: self.aim,
      fire: charge < fullCharge + holdS * 0.85,
    }
  }

  return null
}

function evaluateLightning(
  slot: 0 | 1,
  w: WeaponObs,
  obs: Observation,
  config: Config,
  world: WorldQuery,
  threats: ThreatState,
  order: MacroOrder,
  skipFarm: boolean,
): SlotPlan | null {
  const self = obs.self
  const energyCost = w.stats.energy ?? config.weapons.lightning.energy ?? 3
  if (self.energy < energyCost) return null

  const readyToFire = w.cooldown <= READY_CD
  const muzzle = muzzlePos(self, "lightning")
  const range = w.stats.range ?? config.weapons.lightning.range ?? 45
  const coneDeg = w.stats.cone_deg ?? config.weapons.lightning.cone_deg ?? 30
  const halfConeRad = (coneDeg * 0.5 * Math.PI) / 180
  const farmEnergyFloor = Math.max(15, energyCost * 4)

  let bestAim: Vec2 | null = null
  let bestScore = -Infinity
  let bestPos: Vec3 | undefined
  let bestDist = Infinity
  let bestIsMech = false

  // Check enemy mechs (energy >= energyCost) and NPCs (energy > farmEnergyFloor, unless skipping farm)
  for (const e of threats.enemies) {
    if (e.confidence < 0.95) continue
    if (e.kind === "npc" && (skipFarm || self.energy <= farmEnergyFloor)) continue

    const halfH = e.kind === "mech" ? mechHitbox(e, config).halfH : 1.75
    const aimInfo = resolveAimPoint(muzzle, e.pos, halfH, world, e.kind === "mech")
    if (!aimInfo.hasLOS) continue
    const c = aimInfo.point
    const d = dist3(muzzle, c)
    if (d > range) continue

    let score = e.kind === "mech" ? 120 : 50
    if (e.kind === "mech") {
      if (e.charging) score += 80 // Short cancels charging laser!
      if (e.weapons.includes("laser")) score += 30
      if (isRearShot(self.pos, e, config)) score += 20
      if (e.id === order.primaryTargetId) score += 25
    }
    score -= d * 0.5

    if (score > bestScore) {
      bestScore = score
      bestAim = solveDirectAim(muzzle, c)
      bestPos = c
      bestDist = d
      bestIsMech = e.kind === "mech"
    }
  }

  // Check crates (energy > farmEnergyFloor, unless skipping farm)
  if (!skipFarm && self.energy > farmEnergyFloor) {
    for (const crate of obs.crates) {
      const c: Vec3 = [crate.pos[0], crate.pos[1], crate.pos[2] + 1.0]
      const d = dist3(muzzle, c)
      if (d > range) continue
      if (!world.hasShotLOS(muzzle, c)) continue

      const score = 35 - d * 0.4
      if (score > bestScore) {
        bestScore = score
        bestAim = solveDirectAim(muzzle, c)
        bestPos = c
        bestDist = d
        bestIsMech = false
      }
    }
  }

  if (!bestAim) return null

  const targetYaw = bestAim[0]
  let commandedAim: Vec2 = [bestAim[0], bestAim[1]]
  let avoidedBlockerYaw: number | null = null

  // Crate/NPC-steal avoidance: if a closer crate/NPC sits inside ±halfConeRad ahead of a target mech,
  // bias aim[0] slightly away from the blocker while keeping the mech inside ±halfConeRad * 0.9.
  if (bestIsMech) {
    let closestBlockerDist = bestDist
    let closestBlockerRelYaw: number | null = null
    let closestBlockerYaw: number | null = null

    for (const crate of obs.crates) {
      const c: Vec3 = [crate.pos[0], crate.pos[1], crate.pos[2] + 1.0]
      const d = dist3(muzzle, c)
      if (d >= closestBlockerDist || d > range) continue
      const bYaw = Math.atan2(c[1] - muzzle[1], c[0] - muzzle[0])
      const rel = normalizeAngle(bYaw - targetYaw)
      if (Math.abs(rel) <= halfConeRad * 1.02 && world.hasShotLOS(muzzle, c)) {
        closestBlockerDist = d
        closestBlockerRelYaw = rel
        closestBlockerYaw = bYaw
      }
    }

    for (const npc of threats.enemies) {
      if (npc.kind !== "npc" || npc.confidence < 0.95) continue
      const c: Vec3 = [npc.pos[0], npc.pos[1], npc.pos[2] + 1.75]
      const d = dist3(muzzle, c)
      if (d >= closestBlockerDist || d > range) continue
      const bYaw = Math.atan2(c[1] - muzzle[1], c[0] - muzzle[0])
      const rel = normalizeAngle(bYaw - targetYaw)
      if (Math.abs(rel) <= halfConeRad * 1.02 && world.hasShotLOS(muzzle, c)) {
        closestBlockerDist = d
        closestBlockerRelYaw = rel
        closestBlockerYaw = bYaw
      }
    }

    if (closestBlockerRelYaw !== null && closestBlockerYaw !== null) {
      const maxBias = halfConeRad * 0.90
      if (closestBlockerRelYaw >= 0) {
        // Blocker is CCW of mech -> bias CW (negative)
        const needed = closestBlockerRelYaw - halfConeRad - 0.03
        if (needed >= -maxBias) {
          commandedAim = [normalizeAngle(targetYaw + Math.min(-0.04, needed)), bestAim[1]]
          avoidedBlockerYaw = closestBlockerYaw
        } else {
          commandedAim = [normalizeAngle(targetYaw - maxBias), bestAim[1]]
        }
      } else {
        // Blocker is CW of mech -> bias CCW (positive)
        const needed = closestBlockerRelYaw + halfConeRad + 0.03
        if (needed <= maxBias) {
          commandedAim = [normalizeAngle(targetYaw + Math.max(0.04, needed)), bestAim[1]]
          avoidedBlockerYaw = closestBlockerYaw
        } else {
          commandedAim = [normalizeAngle(targetYaw + maxBias), bestAim[1]]
        }
      }
    }
  }

  if (!readyToFire) {
    return {
      slot,
      kind: "lightning",
      score: trackingScore(bestScore),
      aim: commandedAim,
      fire: false,
      targetPos: bestPos,
      targetDist: bestDist,
      trackingOnly: true,
    }
  }

  // Per protocol.md:306, Lightning checks yaw only (no pitch check!)
  const mechYawDiff = Math.abs(normalizeAngle(targetYaw - self.aim[0]))
  const mechInCone = mechYawDiff <= halfConeRad * 0.94
  const blockerClear =
    avoidedBlockerYaw === null ||
    Math.abs(normalizeAngle(avoidedBlockerYaw - self.aim[0])) > halfConeRad

  return {
    slot,
    kind: "lightning",
    score: bestScore,
    aim: commandedAim,
    fire: mechInCone && blockerClear,
    targetPos: bestPos,
    targetDist: bestDist,
  }
}

function evaluateMortar(
  slot: 0 | 1,
  w: WeaponObs,
  obs: Observation,
  config: Config,
  world: WorldQuery,
  threats: ThreatState,
  order: MacroOrder,
  skipFarm: boolean,
): SlotPlan | null {
  const readyToFire = w.cooldown <= READY_CD
  const self = obs.self
  const muzzle = muzzlePos(self, "mortar")
  const speed = w.stats.speed ?? config.weapons.mortar.speed ?? 72
  const gravity = w.stats.gravity ?? config.weapons.mortar.gravity ?? 22
  const splash = w.stats.splash ?? config.weapons.mortar.splash ?? 7
  const selfSplashRadius = splash + 0.8
  const minPitch = config.mech.min_pitch ?? -1.35
  const maxPitch = config.mech.max_pitch ?? 1.35

  let bestAim: Vec2 | null = null
  let bestScore = -Infinity
  let bestPos: Vec3 | undefined
  let bestDist = Infinity

  for (const e of threats.enemies) {
    if (e.kind === "npc" && skipFarm) continue
    if (e.confidence < 0.25) continue

    const targetGround: Vec3 = [e.pos[0], e.pos[1], e.pos[2] + 0.8]
    const d = dist3(self.pos, targetGround)
    if (d <= selfSplashRadius || d > 240) continue

    const halfH = e.kind === "mech" ? mechHitbox(e, config).halfH : 1.75
    const directLOS =
      e.confidence >= 0.95 &&
      resolveAimPoint(muzzle, e.pos, halfH, world, e.kind === "mech").hasLOS

    const sol = solveMortarArc(
      muzzle,
      self.pos,
      targetGround,
      e.confidence >= 0.7 ? e.vel : [0, 0, 0],
      speed,
      gravity,
      minPitch,
      maxPitch,
      world,
      !directLOS,
      selfSplashRadius,
    )
    if (!sol) continue

    let score = (e.kind === "mech" ? 90 : 35) * e.confidence
    if (e.id === order.primaryTargetId) score += 30
    score -= d * 0.1

    if (score > bestScore) {
      bestScore = score
      bestAim = sol.aim
      bestPos = sol.impact
      bestDist = d
    }
  }

  if (!skipFarm) {
    for (const crate of obs.crates) {
      const targetGround: Vec3 = [crate.pos[0], crate.pos[1], crate.pos[2] + 0.5]
      const d = dist3(self.pos, targetGround)
      if (d <= selfSplashRadius || d > 240) continue

      const sol = solveMortarArc(
        muzzle,
        self.pos,
        targetGround,
        [0, 0, 0],
        speed,
        gravity,
        minPitch,
        maxPitch,
        world,
        false,
        selfSplashRadius,
      )
      if (!sol) continue

      const score = 22 - d * 0.1
      if (score > bestScore) {
        bestScore = score
        bestAim = sol.aim
        bestPos = sol.impact
        bestDist = d
      }
    }
  }

  if (!bestAim) return null

  if (!readyToFire) {
    return {
      slot,
      kind: "mortar",
      score: trackingScore(bestScore),
      aim: bestAim,
      fire: false,
      targetPos: bestPos,
      targetDist: bestDist,
      trackingOnly: true,
    }
  }

  const aligned = isAligned(self.aim, bestAim, 0.04, 0.04)
  return {
    slot,
    kind: "mortar",
    score: bestScore,
    aim: bestAim,
    fire: aligned,
    targetPos: bestPos,
    targetDist: bestDist,
  }
}

function evaluateGun(
  slot: 0 | 1,
  w: WeaponObs,
  obs: Observation,
  config: Config,
  world: WorldQuery,
  threats: ThreatState,
  order: MacroOrder,
  skipFarm: boolean,
): SlotPlan | null {
  const self = obs.self
  const muzzle = muzzlePos(self, "gun")
  const speed = w.stats.speed ?? config.weapons.gun.speed ?? 252
  const range = w.stats.range ?? config.weapons.gun.range ?? 230
  const mag = w.stats.mag ?? config.weapons.gun.mag ?? 12
  const ammo = w.ammo ?? mag
  const reloading = (w.reload ?? 0) > 0

  if (reloading) return null
  if (ammo <= 0) {
    return { slot, kind: "gun", score: -1, aim: self.aim, fire: false, reload: true }
  }

  const readyToFire = w.cooldown <= READY_CD

  let bestAim: Vec2 | null = null
  let bestScore = -Infinity
  let bestDist = Infinity
  let bestPos: Vec3 | undefined
  let bestR = 2.5
  let bestAimHalfH = 4.5

  for (const e of threats.enemies) {
    if (e.confidence < 0.85) continue
    if (e.kind === "npc" && skipFarm) continue

    const isMech = e.kind === "mech"
    const { r, halfH } = isMech ? mechHitbox(e, config) : { r: 1.5, halfH: 1.75 }

    const center: Vec3 = [e.pos[0], e.pos[1], e.pos[2] + halfH]
    let sol = solveGunIntercept(muzzle, center, e.vel, speed, range, world, halfH)
    let aimHalfH = halfH

    // Upper-torso LOS fallback for mechs partially behind cover
    if (!sol && isMech) {
      const upperZOff = halfH * 1.6
      const upper: Vec3 = [e.pos[0], e.pos[1], e.pos[2] + upperZOff]
      sol = solveGunIntercept(muzzle, upper, e.vel, speed, range, world, upperZOff)
      aimHalfH = halfH * 0.45
    }
    if (!sol) continue

    const d = dist3(muzzle, sol.intercept)
    let score = (isMech ? 85 : 45) * e.confidence
    if (e.id === order.primaryTargetId) score += 30
    if (isMech && isRearShot(self.pos, e, config)) score += 20
    score -= d * 0.15

    if (score > bestScore) {
      bestScore = score
      bestAim = sol.aim
      bestDist = d
      bestPos = sol.intercept
      bestR = r
      bestAimHalfH = aimHalfH
    }
  }

  if (!skipFarm) {
    for (const crate of obs.crates) {
      const c: Vec3 = [crate.pos[0], crate.pos[1], crate.pos[2] + 1.0]
      const sol = solveGunIntercept(muzzle, c, [0, 0, 0], speed, range, world, 1.0)
      if (!sol) continue

      const d = dist3(muzzle, sol.intercept)
      const score = 30 - d * 0.15
      if (score > bestScore) {
        bestScore = score
        bestAim = sol.aim
        bestDist = d
        bestPos = sol.intercept
        bestR = 1.0
        bestAimHalfH = 1.0
      }
    }
  }

  // NEVER force-reload while ammo > 0 and we have a valid target!
  if (!bestAim) {
    if (ammo < Math.ceil(mag * 0.5)) {
      return { slot, kind: "gun", score: -1, aim: self.aim, fire: false, reload: true }
    }
    return null
  }

  if (!readyToFire) {
    return {
      slot,
      kind: "gun",
      score: trackingScore(bestScore),
      aim: bestAim,
      fire: false,
      reload: false,
      targetPos: bestPos,
      targetDist: bestDist,
      trackingOnly: true,
    }
  }

  const yawThresh = Math.max(0.004, Math.min(0.10, Math.atan2(bestR * 0.82, bestDist)))
  const pitchThresh = Math.max(0.006, Math.min(0.18, Math.atan2(bestAimHalfH * 0.80, bestDist)))
  const aligned = isAligned(self.aim, bestAim, yawThresh, pitchThresh)
  return {
    slot,
    kind: "gun",
    score: bestScore,
    aim: bestAim,
    fire: aligned,
    reload: false,
    targetPos: bestPos,
    targetDist: bestDist,
  }
}

function evaluateSlot(
  slot: 0 | 1,
  w: WeaponObs | null,
  obs: Observation,
  config: Config,
  world: WorldQuery,
  threats: ThreatState,
  order: MacroOrder,
  skipFarm: boolean,
  state: CombatWeaponState,
  effectiveHoldRegen: boolean,
): SlotPlan | null {
  if (!w) return null
  switch (w.kind) {
    case "laser":
      return evaluateLaser(
        slot,
        w,
        obs,
        config,
        world,
        threats,
        order,
        skipFarm,
        state,
        effectiveHoldRegen,
      )
    case "lightning":
      return evaluateLightning(slot, w, obs, config, world, threats, order, skipFarm)
    case "mortar":
      return evaluateMortar(slot, w, obs, config, world, threats, order, skipFarm)
    case "gun":
      return evaluateGun(slot, w, obs, config, world, threats, order, skipFarm)
    default:
      return null
  }
}

export function chooseWeaponAction(
  obs: Observation,
  config: Config,
  world: WorldQuery,
  threats: ThreatState,
  order: MacroOrder,
  state: CombatWeaponState = defaultWeaponState,
): { aim: Vec2; fire: [boolean, boolean]; reload?: boolean } {
  const muzzle = muzzlePos(obs.self)

  // Regen hold discipline: ONLY break fire-hold if an enemy mech with shot LOS is < 22m
  // (point-blank brawl) OR (self.hp > 500 && e.hp <= 320).
  const urgentLOSEnemy = threats.enemies.some((e) => {
    if (e.kind !== "mech" || e.confidence < 0.8) return false
    const { halfH } = mechHitbox(e, config)
    const { hasLOS } = resolveAimPoint(muzzle, e.pos, halfH, world, true)
    if (!hasLOS) return false
    const d = dist3(e.pos, obs.self.pos)
    return d < 22 || (obs.self.hp > 500 && e.hp > 0 && e.hp <= 320)
  })

  const effectiveHoldRegen = order.holdFireForRegen && !urgentLOSEnemy

  if (effectiveHoldRegen) {
    // If laser is already mid-charge, immediately snap-release aiming safely away so we restore 1.0x speed
    // without hitting anything and resetting 5s HP regen.
    const chargingLaser = obs.self.weapons.some(
      (w) => w?.kind === "laser" && (w.charge ?? 0) > 0,
    )
    const wantRegenReload = obs.self.weapons.some((w) => {
      if (w?.kind !== "gun") return false
      const mag = w.stats.mag ?? config.weapons.gun.mag ?? 12
      const ammo = w.ammo ?? mag
      return (w.reload ?? 0) <= 0 && ammo < Math.ceil(mag * 0.5)
    })
    return {
      aim: chargingLaser ? safeAwayAim(obs, threats) : idleAim(obs, threats, order),
      fire: [false, false],
      ...(wantRegenReload ? { reload: true } : {}),
    }
  }

  const skipFarm = order.holdFireForRegen
  const p0 = evaluateSlot(
    0,
    obs.self.weapons[0],
    obs,
    config,
    world,
    threats,
    order,
    skipFarm,
    state,
    effectiveHoldRegen,
  )
  const p1 = evaluateSlot(
    1,
    obs.self.weapons[1],
    obs,
    config,
    world,
    threats,
    order,
    skipFarm,
    state,
    effectiveHoldRegen,
  )

  const plans = [p0, p1].filter((p): p is SlotPlan => p !== null && p.score >= 0)
  const reload = Boolean(p0?.reload || p1?.reload)

  if (plans.length === 0) {
    return {
      aim: idleAim(obs, threats, order),
      fire: [false, false],
      ...(reload ? { reload: true } : {}),
    }
  }

  plans.sort((a, b) => b.score - a.score)
  const primary = plans[0]
  let aim: Vec2 = primary.aim
  const fire: [boolean, boolean] = [false, false]
  fire[primary.slot] = primary.fire

  // Secondary weapon: Laser+Gun weaving, yaw-only Lightning secondary, and charge-start guard
  if (plans.length > 1) {
    const sec = plans[1]
    const primaryWeapon = obs.self.weapons[primary.slot]
    const secWeapon = obs.self.weapons[sec.slot]

    if (
      primaryWeapon?.kind === "laser" &&
      primary.fire &&
      !primary.trackingOnly &&
      secWeapon?.kind === "gun" &&
      (sec.fire || sec.targetPos !== undefined)
    ) {
      // Laser + Gun Weaving: aim at Gun's led intercept while holding laser charge,
      // then snap to laser.aim for the final 0.16s before release.
      const charge = primaryWeapon.charge ?? 0
      const fullCharge = primaryWeapon.stats.charge ?? config.weapons.laser.charge ?? 0.75
      const turnRate = obs.self.stats.turn_rate ?? config.mech.turn_rate ?? 4
      const aimGap = Math.hypot(
        normalizeAngle(sec.aim[0] - primary.aim[0]),
        sec.aim[1] - primary.aim[1],
      )
      const snapMargin = Math.max(0.16, aimGap / Math.max(1, turnRate) + 0.08)
      const timeLeftToSnap = fullCharge - snapMargin - charge
      const gunCanFireBeforeSnap = sec.fire || secWeapon.cooldown <= Math.max(READY_CD, timeLeftToSnap + READY_CD)

      if (charge > 0 && timeLeftToSnap > 0 && gunCanFireBeforeSnap) {
        aim = sec.aim
        fire[primary.slot] = true
        fire[sec.slot] = sec.fire
      } else if (charge === 0 && !sec.trackingOnly) {
        // Start laser charge while aiming/shooting gun on tick 0
        aim = sec.aim
        fire[primary.slot] = true
        fire[sec.slot] = sec.fire
      } else if (sec.fire) {
        // In final snap window: aim at laser, still fire gun if already aligned
        fire[sec.slot] = true
      }
    } else if (secWeapon?.kind === "laser" && !sec.trackingOnly) {
      const secCharge = secWeapon.charge ?? 0
      if (secCharge > 0) {
        fire[sec.slot] = sec.fire
      } else {
        // Never start charging laser as sec when primary is lightning at < 42m
        const blockStart =
          primaryWeapon?.kind === "lightning" && (primary.targetDist ?? Infinity) < 42
        if (!blockStart) {
          fire[sec.slot] = sec.fire
        }
      }
    } else if (secWeapon?.kind === "lightning" && !sec.trackingOnly) {
      // Yaw-only cone check for secondary lightning
      const coneDeg = secWeapon.stats.cone_deg ?? config.weapons.lightning.cone_deg ?? 30
      const halfConeRad = (coneDeg * 0.5 * Math.PI) / 180
      if (
        sec.fire &&
        Math.abs(normalizeAngle(obs.self.aim[0] - sec.aim[0])) <= halfConeRad * 0.90
      ) {
        fire[sec.slot] = true
      }
    } else if (secWeapon?.kind === "gun" && !sec.trackingOnly) {
      // sec.fire already verified exact alignment with obs.self.aim
      if (sec.fire) {
        fire[sec.slot] = true
      }
    } else if (!sec.trackingOnly && sec.fire && isAligned(obs.self.aim, sec.aim, 0.06, 0.08)) {
      fire[sec.slot] = true
    }
  }

  return {
    aim,
    fire,
    ...(reload ? { reload: true } : {}),
  }
}
