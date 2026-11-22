import type {
  Config,
  MacroOrder,
  Observation,
  ThreatState,
  TrackedEnemy,
  Vec2,
  Vec3,
  WorldQuery,
} from "../contracts.ts"
import type { WeaponObs } from "../mechfight.ts"
import {
  idleAim,
  isAligned,
  muzzlePos,
  normalizeAngle,
  solveDirectAim,
  solveGunIntercept,
  solveMortarArc,
} from "./aim.ts"

interface SlotPlan {
  slot: 0 | 1
  score: number
  aim: Vec2
  fire: boolean
  reload?: boolean
  targetPos?: Vec3
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function targetCenter(pos: Vec3, kind: "mech" | "npc" | "crate"): Vec3 {
  const zOff = kind === "mech" ? 4.5 : kind === "npc" ? 1.75 : 1.0
  return [pos[0], pos[1], pos[2] + zOff]
}

function evaluateLaser(
  slot: 0 | 1,
  w: WeaponObs,
  obs: Observation,
  config: Config,
  world: WorldQuery,
  threats: TrackedEnemy[],
  order: MacroOrder,
  skipFarm: boolean,
): SlotPlan | null {
  const self = obs.self
  const muzzle = muzzlePos(self, "laser")
  const charge = w.charge ?? 0
  if (w.cooldown > 0.10 && charge === 0) return null

  const fullCharge = w.stats.charge ?? config.weapons.laser.charge ?? 0.75
  const minCharge = w.stats.min_charge ?? config.weapons.laser.min_charge ?? 0.15
  const holdS = w.stats.hold_s ?? config.weapons.laser.hold_s ?? 2.0
  const range = w.stats.range ?? config.weapons.laser.range ?? 280
  const damage = w.stats.damage ?? config.weapons.laser.damage ?? 315
  const minFrac = w.stats.min_frac ?? config.weapons.laser.min_frac ?? 0.35
  const minPitch = self.stats.min_pitch ?? config.mech.min_pitch ?? -0.7
  const maxPitch = self.stats.max_pitch ?? config.mech.max_pitch ?? 1.3
  const dmgPerCube =
    typeof config.cubes.damage_per_cube === "number" ? config.cubes.damage_per_cube : 0.04
  const statCap =
    typeof config.cubes.stat_cap === "number" ? config.cubes.stat_cap : 10
  const cubeMult = 1 + dmgPerCube * Math.min(self.cubes, statCap)

  let bestEnemy: TrackedEnemy | null = null
  let bestScore = -Infinity
  let bestLOS = false

  for (const e of threats) {
    if (e.kind !== "mech") continue
    const c = targetCenter(e.pos, "mech")
    const d = dist3(muzzle, c)
    if (d > range) continue

    const rawShotLOS = world.hasShotLOS(muzzle, c)
    const hasLOS = e.confidence >= 0.95 && rawShotLOS

    // Allow pre-charging when within 180m with hasShotLOS (or confidence >= 0.9 and approaching)
    const dx = self.pos[0] - e.pos[0]
    const dy = self.pos[1] - e.pos[1]
    const hd = Math.hypot(dx, dy)
    const relVx = e.vel[0] - self.vel[0]
    const relVy = e.vel[1] - self.vel[1]
    const closingSpeed = hd > 1e-3 ? (dx * relVx + dy * relVy) / hd : 0
    const approaching = closingSpeed > 1.5
    const canPrecharge =
      hasLOS ||
      (d <= 180 && ((e.confidence >= 0.7 && rawShotLOS) || (e.confidence >= 0.9 && approaching)))

    if (!canPrecharge && charge === 0) continue

    const cookoffMult = e.weapons.includes("mortar") ? 1.6 : 1.0
    let score = hasLOS ? 105 : 60 * e.confidence
    if (e.weapons.includes("mortar")) score += 60 // +60% cookoff priority
    if (e.id === order.primaryTargetId) score += 30
    if (e.hp > 0 && e.hp <= damage * cubeMult * cookoffMult) score += 25
    score -= d * 0.15

    if (score > bestScore) {
      bestScore = score
      bestEnemy = e
      bestLOS = hasLOS
    }
  }

  if (bestEnemy) {
    const c = targetCenter(bestEnemy.pos, "mech")
    const desiredAim = solveDirectAim(muzzle, c)
    const d = dist3(muzzle, c)
    const pitchOk = desiredAim[1] >= minPitch - 0.02 && desiredAim[1] <= maxPitch + 0.02
    if (charge === 0 && !pitchOk) return null

    if (bestLOS) {
      const yawThresh = Math.max(0.014, Math.min(0.10, Math.atan2(2.2, d)))
      const pitchThresh = Math.max(0.035, Math.min(0.18, Math.atan2(3.8, d)))
      const aligned = isAligned(self.aim, desiredAim, yawThresh, pitchThresh)
      const frac = charge >= fullCharge ? 1 : minFrac + (1 - minFrac) * (charge / fullCharge)
      const cookoffMult = bestEnemy.weapons.includes("mortar") ? 1.6 : 1.0
      const estDmg = damage * cubeMult * frac * cookoffMult
      const earlyKill = charge >= minCharge && bestEnemy.hp > 0 && bestEnemy.hp <= estDmg * 0.95
      const nearAutoFire = charge >= fullCharge + holdS * 0.85

      const readyToRelease = !pitchOk || (aligned && (charge >= fullCharge || earlyKill || nearAutoFire))
      const fire = charge > 0 ? !readyToRelease : true

      return {
        slot,
        score: bestScore + (charge > 0 ? 200 : 0),
        aim: desiredAim,
        fire,
        targetPos: c,
      }
    }

    // Pre-charging approaching mech or holding charge while target ducked behind cover
    const fire = charge === 0 ? true : charge < fullCharge + holdS * 0.9
    return {
      slot,
      score: bestScore + (charge > 0 ? 200 : 0),
      aim: desiredAim,
      fire,
      targetPos: c,
    }
  }

  // Fallback to visible NPCs and crates whenever no enemy mech is prioritized (unless holding fire for regen)
  if (!skipFarm) {
    let bestFarmAim: Vec2 | null = null
    let bestFarmScore = -Infinity
    let bestFarmPos: Vec3 | undefined
    let bestFarmFire = false

    for (const npc of threats) {
      if (npc.kind !== "npc" || npc.confidence < 0.95) continue
      const c = targetCenter(npc.pos, "npc")
      const d = dist3(muzzle, c)
      if (d > range || !world.hasShotLOS(muzzle, c)) continue

      const score = 48 - d * 0.1 + (charge > 0 ? 200 : 0)
      if (score > bestFarmScore) {
        const desiredAim = solveDirectAim(muzzle, c)
        if (desiredAim[1] < minPitch - 0.02 || desiredAim[1] > maxPitch + 0.02) continue
        const yawThresh = Math.max(0.014, Math.min(0.10, Math.atan2(1.5, d)))
        const pitchThresh = Math.max(0.03, Math.min(0.16, Math.atan2(1.8, d)))
        const aligned = isAligned(self.aim, desiredAim, yawThresh, pitchThresh)
        const frac = charge >= fullCharge ? 1 : minFrac + (1 - minFrac) * (charge / fullCharge)
        const estDmg = damage * cubeMult * frac
        const ready =
          charge >= fullCharge + 0.45 ||
          (aligned && (charge >= fullCharge || (charge >= minCharge && npc.hp > 0 && npc.hp <= estDmg * 0.95)))
        bestFarmScore = score
        bestFarmAim = desiredAim
        bestFarmPos = c
        bestFarmFire = charge > 0 ? !ready : true
      }
    }

    for (const crate of obs.crates) {
      const c = targetCenter(crate.pos, "crate")
      const d = dist3(muzzle, c)
      if (d > range || !world.hasShotLOS(muzzle, c)) continue

      const score = 26 - d * 0.1 + (charge > 0 ? 200 : 0)
      if (score > bestFarmScore) {
        const desiredAim = solveDirectAim(muzzle, c)
        if (desiredAim[1] < minPitch - 0.02 || desiredAim[1] > maxPitch + 0.02) continue
        const yawThresh = Math.max(0.014, Math.min(0.08, Math.atan2(1.0, d)))
        const pitchThresh = Math.max(0.025, Math.min(0.10, Math.atan2(1.0, d)))
        const aligned = isAligned(self.aim, desiredAim, yawThresh, pitchThresh)
        const frac = charge >= fullCharge ? 1 : minFrac + (1 - minFrac) * (charge / fullCharge)
        const estDmg = damage * cubeMult * frac
        const crateHp = crate.hp ?? config.crates.hp ?? 120
        const ready =
          charge >= fullCharge + 0.45 ||
          (aligned && (charge >= fullCharge || (charge >= minCharge && crateHp <= estDmg * 0.95)))
        bestFarmScore = score
        bestFarmAim = desiredAim
        bestFarmPos = c
        bestFarmFire = charge > 0 ? !ready : true
      }
    }

    if (bestFarmAim) {
      return {
        slot,
        score: bestFarmScore,
        aim: bestFarmAim,
        fire: bestFarmFire,
        targetPos: bestFarmPos,
      }
    }
  }

  if (charge > 0) {
    // Already charging with no target: release if near timeout, else hold
    return {
      slot,
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
  threats: TrackedEnemy[],
  order: MacroOrder,
  skipFarm: boolean,
): SlotPlan | null {
  const self = obs.self
  const energyCost = w.stats.energy ?? config.weapons.lightning.energy ?? 3
  if (w.cooldown > 0.10 || self.energy < energyCost) return null

  const muzzle = muzzlePos(self, "lightning")
  const range = w.stats.range ?? config.weapons.lightning.range ?? 45
  const coneDeg = w.stats.cone_deg ?? config.weapons.lightning.cone_deg ?? 30
  const halfConeRad = (coneDeg * 0.5 * Math.PI) / 180

  let bestAim: Vec2 | null = null
  let bestScore = -Infinity
  let bestPos: Vec3 | undefined

  // Check enemy mechs (energy > 3) and NPCs (energy > 15, unless holding fire for regen)
  for (const e of threats) {
    if (e.confidence < 0.95) continue
    if (e.kind === "npc" && (skipFarm || self.energy <= 15)) continue
    const c = targetCenter(e.pos, e.kind)
    const d = dist3(muzzle, c)
    if (d > range) continue
    if (!world.hasShotLOS(muzzle, c)) continue

    let score = e.kind === "mech" ? 120 : 50
    if (e.kind === "mech") {
      if (e.charging) score += 80 // Short cancels charging laser!
      if (e.weapons.includes("laser")) score += 30
      if (e.id === order.primaryTargetId) score += 25
    }
    score -= d * 0.5

    if (score > bestScore) {
      bestScore = score
      bestAim = solveDirectAim(muzzle, c)
      bestPos = c
    }
  }

  // Check crates (energy > 15, unless holding fire for regen)
  if (!skipFarm && self.energy > 15) {
    for (const crate of obs.crates) {
      const c = targetCenter(crate.pos, "crate")
      const d = dist3(muzzle, c)
      if (d > range) continue
      if (!world.hasShotLOS(muzzle, c)) continue

      const score = 35 - d * 0.4
      if (score > bestScore) {
        bestScore = score
        bestAim = solveDirectAim(muzzle, c)
        bestPos = c
      }
    }
  }

  if (!bestAim) return null

  const yawDiff = Math.abs(normalizeAngle(bestAim[0] - self.aim[0]))
  const inCone = yawDiff <= halfConeRad * 0.94
  return {
    slot,
    score: bestScore,
    aim: bestAim,
    fire: inCone,
    targetPos: bestPos,
  }
}

function evaluateMortar(
  slot: 0 | 1,
  w: WeaponObs,
  obs: Observation,
  config: Config,
  world: WorldQuery,
  threats: TrackedEnemy[],
  order: MacroOrder,
  skipFarm: boolean,
): SlotPlan | null {
  if (w.cooldown > 0.10) return null

  const self = obs.self
  const muzzle = muzzlePos(self, "mortar")
  const speed = w.stats.speed ?? config.weapons.mortar.speed ?? 72
  const gravity = w.stats.gravity ?? config.weapons.mortar.gravity ?? 22
  const minPitch = config.mech.min_pitch ?? -1.35
  const maxPitch = config.mech.max_pitch ?? 1.35

  let bestAim: Vec2 | null = null
  let bestScore = -Infinity
  let bestPos: Vec3 | undefined

  for (const e of threats) {
    if (e.kind === "npc" && skipFarm) continue
    if (e.confidence < 0.25) continue

    const targetGround: Vec3 = [e.pos[0], e.pos[1], e.pos[2] + 0.8]
    const d = dist3(self.pos, targetGround)
    if (d <= 7.5 || d > 240) continue

    const directLOS =
      e.confidence >= 0.95 && world.hasShotLOS(muzzle, targetCenter(e.pos, e.kind))
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
    )
    if (!sol) continue

    let score = (e.kind === "mech" ? 90 : 35) * e.confidence
    if (e.id === order.primaryTargetId) score += 30
    score -= d * 0.1

    if (score > bestScore) {
      bestScore = score
      bestAim = sol.aim
      bestPos = sol.impact
    }
  }

  if (!skipFarm) {
    for (const crate of obs.crates) {
      const targetGround: Vec3 = [crate.pos[0], crate.pos[1], crate.pos[2] + 0.5]
      const d = dist3(self.pos, targetGround)
      if (d <= 7.5 || d > 240) continue

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
      )
      if (!sol) continue

      const score = 22 - d * 0.1
      if (score > bestScore) {
        bestScore = score
        bestAim = sol.aim
        bestPos = sol.impact
      }
    }
  }

  if (!bestAim) return null

  const aligned = isAligned(self.aim, bestAim, 0.04, 0.04)
  return {
    slot,
    score: bestScore,
    aim: bestAim,
    fire: aligned,
    targetPos: bestPos,
  }
}

function evaluateGun(
  slot: 0 | 1,
  w: WeaponObs,
  obs: Observation,
  config: Config,
  world: WorldQuery,
  threats: TrackedEnemy[],
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

  const closeThreat = threats.some(
    (e) => e.kind === "mech" && e.confidence >= 0.8 && dist3(e.pos, self.pos) <= 40,
  )
  const wantIdleReload = !reloading && (ammo <= 0 || (ammo <= Math.ceil(mag * 0.4) && !closeThreat))

  if (reloading || ammo <= 0) {
    return !reloading && ammo <= 0
      ? { slot, score: -1, aim: self.aim, fire: false, reload: true }
      : null
  }
  if (w.cooldown > 0.10) {
    return null
  }

  let bestAim: Vec2 | null = null
  let bestScore = -Infinity
  let bestDist = Infinity
  let bestPos: Vec3 | undefined
  let bestKind: "mech" | "npc" | "crate" = "mech"

  for (const e of threats) {
    if (e.confidence < 0.85) continue
    if (e.kind === "npc" && skipFarm) continue

    const c = targetCenter(e.pos, e.kind)
    const sol = solveGunIntercept(muzzle, c, e.vel, speed, range, world)
    if (!sol) continue

    const d = dist3(muzzle, sol.intercept)
    let score = (e.kind === "mech" ? 85 : 45) * e.confidence
    if (e.id === order.primaryTargetId) score += 30
    score -= d * 0.15

    if (score > bestScore) {
      bestScore = score
      bestAim = sol.aim
      bestDist = d
      bestPos = sol.intercept
      bestKind = e.kind
    }
  }

  if (!skipFarm) {
    for (const crate of obs.crates) {
      const c = targetCenter(crate.pos, "crate")
      const sol = solveGunIntercept(muzzle, c, [0, 0, 0], speed, range, world)
      if (!sol) continue

      const d = dist3(muzzle, sol.intercept)
      const score = 30 - d * 0.15
      if (score > bestScore) {
        bestScore = score
        bestAim = sol.aim
        bestDist = d
        bestPos = sol.intercept
        bestKind = "crate"
      }
    }
  }

  if (!bestAim) {
    return wantIdleReload ? { slot, score: -1, aim: self.aim, fire: false, reload: true } : null
  }

  const yawThresh =
    bestKind === "crate"
      ? Math.max(0.015, Math.min(0.08, Math.atan2(1.0, bestDist)))
      : Math.max(0.015, Math.min(0.12, Math.atan2(2.3, bestDist)))
  const pitchThresh =
    bestKind === "crate"
      ? Math.max(0.025, Math.min(0.10, Math.atan2(1.0, bestDist)))
      : Math.max(0.035, Math.min(0.20, Math.atan2(3.8, bestDist)))
  const aligned = isAligned(self.aim, bestAim, yawThresh, pitchThresh)
  return {
    slot,
    score: bestScore,
    aim: bestAim,
    fire: aligned,
    reload: false,
    targetPos: bestPos,
  }
}

function evaluateSlot(
  slot: 0 | 1,
  w: WeaponObs | null,
  obs: Observation,
  config: Config,
  world: WorldQuery,
  threats: TrackedEnemy[],
  order: MacroOrder,
  skipFarm: boolean,
): SlotPlan | null {
  if (!w) return null
  switch (w.kind) {
    case "laser":
      return evaluateLaser(slot, w, obs, config, world, threats, order, skipFarm)
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
): { aim: Vec2; fire: [boolean, boolean]; reload?: boolean } {
  const muzzle = muzzlePos(obs.self)

  const urgentLOSEnemy = threats.enemies.some(
    (e) =>
      e.kind === "mech" &&
      e.confidence >= 0.8 &&
      world.hasShotLOS(muzzle, targetCenter(e.pos, "mech")) &&
      (dist3(e.pos, obs.self.pos) <= 38 || (e.hp > 0 && e.hp <= 380)),
  )

  if (order.holdFireForRegen && !urgentLOSEnemy) {
    // Check if a laser is mid-charge; only release if aligned on a valid target, else aim away/wait cleanly
    const laserSlot =
      obs.self.weapons[0]?.kind === "laser" && (obs.self.weapons[0].charge ?? 0) > 0
        ? 0
        : obs.self.weapons[1]?.kind === "laser" && (obs.self.weapons[1].charge ?? 0) > 0
          ? 1
          : -1
    if (laserSlot !== -1) {
      const lp = evaluateLaser(
        laserSlot as 0 | 1,
        obs.self.weapons[laserSlot]!,
        obs,
        config,
        world,
        threats.enemies,
        order,
        true,
      )
      if (lp && !lp.fire) {
        const fire: [boolean, boolean] = [false, false]
        return { aim: lp.aim, fire }
      }
    }
    return {
      aim: idleAim(obs, threats, order),
      fire: [false, false],
    }
  }

  const skipFarm = order.holdFireForRegen
  const p0 = evaluateSlot(0, obs.self.weapons[0], obs, config, world, threats.enemies, order, skipFarm)
  const p1 = evaluateSlot(1, obs.self.weapons[1], obs, config, world, threats.enemies, order, skipFarm)

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
  const fire: [boolean, boolean] = [false, false]
  fire[primary.slot] = primary.fire

  // Secondary weapon: dual-weapon weaving (gun/lightning while laser charges, or clean laser release)
  if (plans.length > 1) {
    const sec = plans[1]
    const secWeapon = obs.self.weapons[sec.slot]
    if (secWeapon?.kind === "laser" && (secWeapon.charge ?? 0) > 0) {
      fire[sec.slot] = sec.fire
    } else if (secWeapon?.kind === "lightning" && sec.fire) {
      const coneDeg = secWeapon.stats.cone_deg ?? config.weapons.lightning.cone_deg ?? 30
      const halfConeRad = (coneDeg * 0.5 * Math.PI) / 180
      if (Math.abs(normalizeAngle(sec.aim[0] - obs.self.aim[0])) <= halfConeRad * 0.90) {
        fire[sec.slot] = true
      }
    } else if (
      secWeapon?.kind === "gun" &&
      sec.fire &&
      isAligned(obs.self.aim, sec.aim, 0.10, 0.16)
    ) {
      fire[sec.slot] = true
    } else if (sec.fire && isAligned(obs.self.aim, sec.aim, 0.08, 0.10)) {
      fire[sec.slot] = true
    }
  }

  return {
    aim: primary.aim,
    fire,
    ...(reload ? { reload: true } : {}),
  }
}
