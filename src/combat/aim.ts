import type { MacroOrder, Observation, ThreatState, Vec2, Vec3, WeaponKind, WorldQuery } from "../contracts.ts"

export function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI
  while (a < -Math.PI) a += 2 * Math.PI
  return a
}

export function aimDiff(actual: Vec2, desired: Vec2): { yawDiff: number; pitchDiff: number } {
  return {
    yawDiff: Math.abs(normalizeAngle(desired[0] - actual[0])),
    pitchDiff: Math.abs(desired[1] - actual[1]),
  }
}

export function isAligned(
  actual: Vec2,
  desired: Vec2,
  yawThresh: number,
  pitchThresh: number,
): boolean {
  const { yawDiff, pitchDiff } = aimDiff(actual, desired)
  return yawDiff <= yawThresh && pitchDiff <= pitchThresh
}

export function muzzlePos(self: Observation["self"], kind?: WeaponKind): Vec3 {
  const muzzleH = self.stats.muzzle_height ?? 7
  const zOffset = kind === "mortar" ? 9.5 * (muzzleH / 7) : muzzleH
  return [self.pos[0], self.pos[1], self.pos[2] + zOffset]
}

export function solveDirectAim(from: Vec3, to: Vec3): Vec2 {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const dz = to[2] - from[2]
  const horiz = Math.max(1e-4, Math.hypot(dx, dy))
  return [Math.atan2(dy, dx), Math.atan2(dz, horiz)]
}

/**
 * Exact quadratic lead intercept: |P_rel + V_rel * t| = speed * t.
 * Verifies range and WorldQuery.hasShotLOS.
 */
export function solveGunIntercept(
  muzzle: Vec3,
  targetPos: Vec3,
  targetVel: Vec3,
  speed: number,
  range: number,
  world: WorldQuery,
  barrelOffset = 3.0,
  minZAboveSurf = 1.0,
): { aim: Vec2; intercept: Vec3; t: number } | null {
  const px = targetPos[0] - muzzle[0]
  const py = targetPos[1] - muzzle[1]
  const pz = targetPos[2] - muzzle[2]

  const vx = targetVel[0]
  const vy = targetVel[1]
  const vz = targetVel[2]

  const a = vx * vx + vy * vy + vz * vz - speed * speed
  const b = 2 * (px * vx + py * vy + pz * vz)
  const c = px * px + py * py + pz * pz

  let t = -1
  if (Math.abs(a) < 1e-6) {
    if (b < -1e-6) t = -c / b
  } else {
    const disc = b * b - 4 * a * c
    if (disc >= 0) {
      const sqrtD = Math.sqrt(disc)
      const t1 = (-b - sqrtD) / (2 * a)
      const t2 = (-b + sqrtD) / (2 * a)
      if (t1 > 0 && t2 > 0) t = Math.min(t1, t2)
      else if (t1 > 0) t = t1
      else if (t2 > 0) t = t2
    }
  }

  if (t <= 0) {
    const dist = Math.hypot(px, py, pz)
    if (dist - barrelOffset > range) return null
    t = Math.max(0, (dist - barrelOffset) / speed)
  } else {
    t = Math.max(0, t - barrelOffset / speed)
  }

  const vzLead =
    vz < -2.0
      ? vz * t - 0.5 * 22 * t * t
      : vz > 2.0
        ? vz * t - 0.5 * 6 * t * t
        : vz * t
  const ix = targetPos[0] + vx * t
  const iy = targetPos[1] + vy * t
  const rawZ = targetPos[2] + vzLead
  const surfZ = world.surfaceZAt(ix, iy, targetPos[2])
  let intercept: Vec3 = [ix, iy, Math.max(surfZ + minZAboveSurf, rawZ)]

  const shotDist = Math.hypot(
    intercept[0] - muzzle[0],
    intercept[1] - muzzle[1],
    intercept[2] - muzzle[2],
  )
  if (shotDist - barrelOffset > range) return null
  if (!world.hasShotLOS(muzzle, intercept)) {
    if (!world.hasShotLOS(muzzle, targetPos)) return null
    // 3-step binary search wall-corner bisection along targetPos -> intercept
    let lo = 0
    let hi = 1
    let bestPt: Vec3 = targetPos
    for (let step = 0; step < 3; step++) {
      const mid = 0.5 * (lo + hi)
      const cand: Vec3 = [
        targetPos[0] + (intercept[0] - targetPos[0]) * mid,
        targetPos[1] + (intercept[1] - targetPos[1]) * mid,
        targetPos[2] + (intercept[2] - targetPos[2]) * mid,
      ]
      if (world.hasShotLOS(muzzle, cand)) {
        bestPt = cand
        lo = mid
      } else {
        hi = mid
      }
    }
    intercept = bestPt
  }

  return {
    aim: solveDirectAim(muzzle, intercept),
    intercept,
    t,
  }
}

function solveBallisticPitch(
  R: number,
  dz: number,
  speed: number,
  gravity: number,
  highArc: boolean,
): number | null {
  if (R < 1.0) return null
  const A = (gravity * R * R) / (2 * speed * speed)
  const disc = R * R - 4 * A * (dz + A)
  if (disc < 0) return null
  const sqrtD = Math.sqrt(disc)
  const tanTheta = highArc ? (R + sqrtD) / (2 * A) : (R - sqrtD) / (2 * A)
  return Math.atan(tanTheta)
}

function checkMortarParabola(
  muzzle: Vec3,
  yaw: number,
  pitch: number,
  speed: number,
  gravity: number,
  tFlight: number,
  world: WorldQuery,
): boolean {
  const cosP = Math.cos(pitch)
  const sinP = Math.sin(pitch)
  const dirX = cosP * Math.cos(yaw)
  const dirY = cosP * Math.sin(yaw)
  const dirZ = sinP

  // Shot origin is 3.0m out along aim
  const p0: Vec3 = [muzzle[0] + 3.0 * dirX, muzzle[1] + 3.0 * dirY, muzzle[2] + 3.0 * dirZ]
  if (!world.hasShotLOS(muzzle, p0)) return false

  const vx = speed * dirX
  const vy = speed * dirY
  const vz = speed * dirZ

  let prev = p0
  const steps = 10
  for (let i = 1; i <= steps; i++) {
    const ti = (i / steps) * tFlight
    const next: Vec3 = [
      p0[0] + vx * ti,
      p0[1] + vy * ti,
      p0[2] + vz * ti - 0.5 * gravity * ti * ti,
    ]
    if (!world.hasShotLOS(prev, next)) return false
    prev = next
  }
  return true
}

/**
 * Closed-form low-arc (-) and high-arc (+) mortar ballistic solver.
 * Samples 10 segments along the parabola with WorldQuery.hasShotLOS
 * and rejects trajectories that splash within 7.5m of self.pos.
 */
export function solveMortarArc(
  muzzle: Vec3,
  selfPos: Vec3,
  targetPos: Vec3,
  targetVel: Vec3,
  speed: number,
  gravity: number,
  minPitch: number,
  maxPitch: number,
  world: WorldQuery,
  preferHighArc = false,
): { aim: Vec2; impact: Vec3; highArc: boolean; t: number } | null {
  const arcOrder = preferHighArc ? [true, false] : [false, true]

  for (const highArc of arcOrder) {
    let impact: Vec3 = [targetPos[0], targetPos[1], targetPos[2]]
    let pitch = 0
    let yaw = 0
    let tFlight = 0
    let valid = true

    // 2 iterations to refine lead + 3.0m barrel offset
    for (let iter = 0; iter < 2; iter++) {
      yaw = Math.atan2(impact[1] - muzzle[1], impact[0] - muzzle[0])
      const R_total = Math.hypot(impact[0] - muzzle[0], impact[1] - muzzle[1])
      const dz_total = impact[2] - muzzle[2]

      // First estimate without barrel offset, then refine with 3.0m offset
      const pEst = solveBallisticPitch(R_total, dz_total, speed, gravity, highArc)
      if (pEst === null) {
        valid = false
        break
      }

      const R_eff = R_total - 3.0 * Math.cos(pEst)
      const dz_eff = dz_total - 3.0 * Math.sin(pEst)
      const pRefined = solveBallisticPitch(R_eff, dz_eff, speed, gravity, highArc)
      if (pRefined === null) {
        valid = false
        break
      }

      pitch = pRefined
      if (pitch < minPitch || pitch > maxPitch) {
        valid = false
        break
      }

      tFlight = R_eff / Math.max(1e-3, speed * Math.cos(pitch))
      // Lead horizontally; keep Z near target's surface
      const leadX = targetPos[0] + targetVel[0] * tFlight
      const leadY = targetPos[1] + targetVel[1] * tFlight
      impact = [leadX, leadY, targetPos[2]]
    }

    if (!valid || tFlight <= 0) continue

    // Prevent self-splash within 7.5m
    const selfDist = Math.hypot(
      impact[0] - selfPos[0],
      impact[1] - selfPos[1],
      impact[2] - selfPos[2],
    )
    if (selfDist <= 7.5) continue

    if (checkMortarParabola(muzzle, yaw, pitch, speed, gravity, tFlight, world)) {
      return { aim: [yaw, pitch], impact, highArc, t: tFlight }
    }
  }

  return null
}

/**
 * Rear-armor yaw protection when idle or holding fire for regen.
 * Oscillates +-0.9 rad around moveYaw when no primaryThreatBearing so the 120° FOV sweeps ~220°.
 */
export function idleAim(obs: Observation, threats: ThreatState, order: MacroOrder): Vec2 {
  if (threats.primaryThreatBearing !== null) {
    return [threats.primaryThreatBearing, -0.04]
  }
  let moveYaw = obs.self.aim[0]
  if (order.moveTarget) {
    const dx = order.moveTarget[0] - obs.self.pos[0]
    const dy = order.moveTarget[1] - obs.self.pos[1]
    if (Math.hypot(dx, dy) > 1) {
      moveYaw = Math.atan2(dy, dx)
    }
  } else {
    const dx = obs.zone.next_center[0] - obs.self.pos[0]
    const dy = obs.zone.next_center[1] - obs.self.pos[1]
    if (Math.hypot(dx, dy) > 1) {
      moveYaw = Math.atan2(dy, dx)
    }
  }
  const sweep = 0.9 * Math.sin(obs.t * 2.2)
  return [normalizeAngle(moveYaw + sweep), -0.04]
}
