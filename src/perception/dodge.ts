import type {
  Config,
  Observation,
  Vec2,
  Vec3,
  WorldQuery,
} from "../contracts.ts"

export interface DodgeResult {
  dodgeVec: Vec2
  dodgeUrgency: number
}

const HORIZON_S = 0.6
const MORTAR_STEPS = 20
const MECH_CENTER_Z = 4.5
const PROJ_DANGER_RADIUS = 3.5
const MORTAR_DANGER_RADIUS = 5.5
const LASER_RAY_RADIUS = 6.0

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function dist3(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  const dz = a[2] - b[2]
  return Math.hypot(dx, dy, dz)
}

function pickPerpendicular(dir2d: Vec2, away2d: Vec2, selfVel2d: Vec2): Vec2 {
  const len = Math.hypot(dir2d[0], dir2d[1])
  if (len < 1e-6) {
    const awayLen = Math.hypot(away2d[0], away2d[1])
    if (awayLen > 1e-6) {
      return [away2d[0] / awayLen, away2d[1] / awayLen]
    }
    return [1, 0]
  }
  const nx = dir2d[0] / len
  const ny = dir2d[1] / len
  const p1: Vec2 = [-ny, nx]
  const p2: Vec2 = [ny, -nx]

  const d1 = p1[0] * away2d[0] + p1[1] * away2d[1]
  const d2 = p2[0] * away2d[0] + p2[1] * away2d[1]
  if (Math.abs(d1 - d2) > 0.15) {
    return d1 >= d2 ? p1 : p2
  }
  // Dead-center: prefer side aligned with current velocity to preserve momentum
  const v1 = p1[0] * selfVel2d[0] + p1[1] * selfVel2d[1]
  const v2 = p2[0] * selfVel2d[0] + p2[1] * selfVel2d[1]
  return v1 >= v2 ? p1 : p2
}

/**
 * Compute a perpendicular 2D dodge vector and urgency [0, 1] from incoming
 * projectiles (linear gun/npc, parabolic mortar) and charging enemy lasers.
 */
export function computeDodge(
  obs: Observation,
  config: Config,
  world: WorldQuery,
): DodgeResult {
  const selfCenter: Vec3 = [
    obs.self.pos[0],
    obs.self.pos[1],
    obs.self.pos[2] + MECH_CENTER_Z,
  ]
  const selfVel2d: Vec2 = [obs.self.vel[0], obs.self.vel[1]]
  const gravity = config.weapons.mortar.gravity ?? 22

  let sumX = 0
  let sumY = 0
  let maxUrgency = 0

  for (const proj of obs.projectiles) {
    let minDist = Infinity
    let bestT = 0
    let closestPt: Vec3 = [proj.pos[0], proj.pos[1], proj.pos[2]]

    if (proj.kind === "mortar") {
      const dtStep = HORIZON_S / MORTAR_STEPS
      for (let i = 1; i <= MORTAR_STEPS; i++) {
        const t = i * dtStep
        const pt: Vec3 = [
          proj.pos[0] + proj.vel[0] * t,
          proj.pos[1] + proj.vel[1] * t,
          proj.pos[2] + proj.vel[2] * t - 0.5 * gravity * t * t,
        ]
        const d = dist3(pt, selfCenter)
        if (d < minDist) {
          minDist = d
          bestT = t
          closestPt = pt
        }
      }
    } else {
      const rel: Vec3 = [
        proj.pos[0] - selfCenter[0],
        proj.pos[1] - selfCenter[1],
        proj.pos[2] - selfCenter[2],
      ]
      const vSq = dot3(proj.vel, proj.vel)
      if (vSq < 1e-6) continue
      const tStar = clamp(-dot3(rel, proj.vel) / vSq, 0, HORIZON_S)
      if (tStar <= 0) continue
      closestPt = [
        proj.pos[0] + proj.vel[0] * tStar,
        proj.pos[1] + proj.vel[1] * tStar,
        proj.pos[2] + proj.vel[2] * tStar,
      ]
      minDist = dist3(closestPt, selfCenter)
      bestT = tStar
    }

    const dangerRadius =
      proj.kind === "mortar" ? MORTAR_DANGER_RADIUS : PROJ_DANGER_RADIUS
    if (minDist <= dangerRadius && bestT > 0) {
      const distFactor = 1 - clamp(minDist / dangerRadius, 0, 1)
      const timeFactor = 1 - clamp(bestT / HORIZON_S, 0, 1) * 0.4
      const urgency = clamp(0.45 + 0.55 * distFactor * timeFactor, 0, 1)

      const away2d: Vec2 = [
        selfCenter[0] - closestPt[0],
        selfCenter[1] - closestPt[1],
      ]
      const perp = pickPerpendicular(
        [proj.vel[0], proj.vel[1]],
        away2d,
        selfVel2d,
      )
      sumX += perp[0] * urgency
      sumY += perp[1] * urgency
      if (urgency > maxUrgency) maxUrgency = urgency
    }
  }

  for (const m of obs.mechs) {
    if (!m.charging) continue
    const origin: Vec3 = [m.pos[0], m.pos[1], m.pos[2] + MECH_CENTER_Z]
    const yaw = m.aim[0]
    const pitch = m.aim[1]
    const cp = Math.cos(pitch)
    const dir: Vec3 = [cp * Math.cos(yaw), cp * Math.sin(yaw), Math.sin(pitch)]

    const rel: Vec3 = [
      selfCenter[0] - origin[0],
      selfCenter[1] - origin[1],
      selfCenter[2] - origin[2],
    ]
    const projLen = dot3(rel, dir)
    if (projLen <= 0) continue

    const closestPt: Vec3 = [
      origin[0] + dir[0] * projLen,
      origin[1] + dir[1] * projLen,
      origin[2] + dir[2] * projLen,
    ]
    const d = dist3(selfCenter, closestPt)
    if (d <= LASER_RAY_RADIUS && world.hasShotLOS(origin, selfCenter)) {
      const urgency = clamp(0.65 + 0.35 * (1 - d / LASER_RAY_RADIUS), 0, 1)
      const away2d: Vec2 = [
        selfCenter[0] - closestPt[0],
        selfCenter[1] - closestPt[1],
      ]
      const perp = pickPerpendicular([dir[0], dir[1]], away2d, selfVel2d)
      sumX += perp[0] * urgency
      sumY += perp[1] * urgency
      if (urgency > maxUrgency) maxUrgency = urgency
    }
  }

  const mag = Math.hypot(sumX, sumY)
  if (mag < 1e-6 || maxUrgency <= 0) {
    return { dodgeVec: [0, 0], dodgeUrgency: 0 }
  }
  return {
    dodgeVec: [sumX / mag, sumY / mag],
    dodgeUrgency: clamp(maxUrgency, 0, 1),
  }
}
