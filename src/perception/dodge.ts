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
  chargingLaserThreat: boolean
}

const HORIZON_S = 0.6
const MORTAR_HORIZON_S = 2.5
const MORTAR_STEPS = 25

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

function pickPerpendicular(
  dir2d: Vec2,
  away2d: Vec2,
  selfVel2d: Vec2,
  selfPos: Vec3,
  world: WorldQuery,
  mechRadius: number,
  mechHeight: number,
): Vec2 {
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

  const p1Open = world.isPointWalkable(
    selfPos[0] + p1[0] * 4,
    selfPos[1] + p1[1] * 4,
    selfPos[2],
    mechRadius,
    mechHeight,
  )
  const p2Open = world.isPointWalkable(
    selfPos[0] + p2[0] * 4,
    selfPos[1] + p2[1] * 4,
    selfPos[2],
    mechRadius,
    mechHeight,
  )
  if (p1Open && !p2Open) return p1
  if (p2Open && !p1Open) return p2

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
 * Compute a 2D dodge vector, urgency [0, 1], and visible LOS charging-laser
 * threat flag from incoming projectiles (linear gun/npc with relative-velocity
 * CPA & LOS check, parabolic mortar up to 2.5s with wall & surfaceZAt checks)
 * and visible LOS charging enemy lasers.
 */
export function computeDodge(
  obs: Observation,
  config: Config,
  world: WorldQuery,
): DodgeResult {
  const sizePerCube = (config.cubes.size_per_cube as number | undefined) ?? 0.05
  const sizeScale = 1 + sizePerCube * obs.self.cubes
  const mechRadius = obs.self.stats.radius ?? 2.5 * sizeScale
  const mechHeight = obs.self.stats.height ?? 9 * sizeScale
  const selfCenterZ = 0.5 * mechHeight
  const selfHighZ = 0.85 * mechHeight
  const projDangerRadius = mechRadius + 1.0
  const mortarDangerRadius =
    (config.weapons.mortar.splash_radius ?? 7) + mechRadius
  const laserRayRadius = mechRadius + 3.5

  const selfCenter: Vec3 = [
    obs.self.pos[0],
    obs.self.pos[1],
    obs.self.pos[2] + selfCenterZ,
  ]
  const selfHigh: Vec3 = [
    obs.self.pos[0],
    obs.self.pos[1],
    obs.self.pos[2] + selfHighZ,
  ]
  const selfVel2d: Vec2 = [obs.self.vel[0], obs.self.vel[1]]
  const gravity = config.weapons.mortar.gravity ?? 22

  let sumX = 0
  let sumY = 0
  let maxUrgency = 0
  let chargingLaserThreat = false

  for (const proj of obs.projectiles) {
    if (proj.kind === "mortar") {
      const dtStep = MORTAR_HORIZON_S / MORTAR_STEPS
      let minDist = Infinity
      let bestT = 0
      let threatPt: Vec3 = [proj.pos[0], proj.pos[1], proj.pos[2]]
      let prevPt: Vec3 = [proj.pos[0], proj.pos[1], proj.pos[2]]
      let impacted = false

      for (let i = 1; i <= MORTAR_STEPS; i++) {
        const t = i * dtStep
        const pt: Vec3 = [
          proj.pos[0] + proj.vel[0] * t,
          proj.pos[1] + proj.vel[1] * t,
          proj.pos[2] + proj.vel[2] * t - 0.5 * gravity * t * t,
        ]
        if (!world.hasShotLOS(prevPt, pt)) {
          const dImpact = dist3(prevPt, selfCenter)
          if (dImpact < minDist) {
            minDist = dImpact
            bestT = t
            threatPt = prevPt
          }
          impacted = true
          break
        }
        const surfZ = world.surfaceZAt(pt[0], pt[1], pt[2])
        if (pt[2] <= surfZ) {
          const impactPt: Vec3 = [pt[0], pt[1], surfZ]
          const dImpact = dist3(impactPt, selfCenter)
          if (dImpact < minDist) {
            minDist = dImpact
            bestT = t
            threatPt = impactPt
          }
          impacted = true
          break
        }
        const d = dist3(pt, selfCenter)
        if (d < minDist) {
          minDist = d
          bestT = t
          threatPt = pt
        }
        prevPt = pt
      }

      if (minDist <= mortarDangerRadius && bestT > 0) {
        // Skip if a wall/terrain blocks the mortar blast from us after impact
        if (
          impacted &&
          !world.hasShotLOS(
            [threatPt[0], threatPt[1], threatPt[2] + 0.5],
            selfCenter,
          )
        ) {
          continue
        }
        const distFactor = 1 - clamp(minDist / mortarDangerRadius, 0, 1)
        const timeFactor = 1 - clamp(bestT / MORTAR_HORIZON_S, 0, 1) * 0.45
        let urgency = clamp(0.45 + 0.55 * distFactor * timeFactor, 0, 1)
        if (bestT > 1.3) {
          urgency = Math.min(urgency, 0.48)
        }

        // Steer directly away from predicted mortar impact
        const awayX = selfCenter[0] - threatPt[0]
        const awayY = selfCenter[1] - threatPt[1]
        const awayLen = Math.hypot(awayX, awayY)
        const dir: Vec2 =
          awayLen > 1e-3
            ? [awayX / awayLen, awayY / awayLen]
            : pickPerpendicular(
                [proj.vel[0], proj.vel[1]],
                [awayX, awayY],
                selfVel2d,
                obs.self.pos,
                world,
                mechRadius,
                mechHeight,
              )
        sumX += dir[0] * urgency
        sumY += dir[1] * urgency
        if (urgency > maxUrgency) maxUrgency = urgency
      }
      continue
    }

    // Linear projectiles (gun, npc) using relative-velocity CPA
    const rel: Vec3 = [
      proj.pos[0] - selfCenter[0],
      proj.pos[1] - selfCenter[1],
      proj.pos[2] - selfCenter[2],
    ]
    const relVel: Vec3 = [
      proj.vel[0] - obs.self.vel[0],
      proj.vel[1] - obs.self.vel[1],
      proj.vel[2] - obs.self.vel[2],
    ]
    const vSq = dot3(relVel, relVel)
    if (vSq < 1e-6) continue
    const tStar = clamp(-dot3(rel, relVel) / vSq, 0, HORIZON_S)
    if (tStar <= 0) continue

    const closestPt: Vec3 = [
      proj.pos[0] + proj.vel[0] * tStar,
      proj.pos[1] + proj.vel[1] * tStar,
      proj.pos[2] + proj.vel[2] * tStar,
    ]
    const selfAtT: Vec3 = [
      selfCenter[0] + obs.self.vel[0] * tStar,
      selfCenter[1] + obs.self.vel[1] * tStar,
      selfCenter[2] + obs.self.vel[2] * tStar,
    ]
    const minDist = dist3(closestPt, selfAtT)
    if (minDist <= projDangerRadius) {
      // Skip shots blocked by terrain/prisms before reaching us
      if (!world.hasShotLOS(proj.pos, closestPt)) {
        continue
      }
      const distFactor = 1 - clamp(minDist / projDangerRadius, 0, 1)
      const timeFactor = 1 - clamp(tStar / HORIZON_S, 0, 1) * 0.4
      const urgency = clamp(0.45 + 0.55 * distFactor * timeFactor, 0, 1)

      const away2d: Vec2 = [
        selfAtT[0] - closestPt[0],
        selfAtT[1] - closestPt[1],
      ]
      const perp = pickPerpendicular(
        [proj.vel[0], proj.vel[1]],
        away2d,
        selfVel2d,
        obs.self.pos,
        world,
        mechRadius,
        mechHeight,
      )
      sumX += perp[0] * urgency
      sumY += perp[1] * urgency
      if (urgency > maxUrgency) maxUrgency = urgency
    }
  }

  for (const m of obs.mechs) {
    if (!m.charging) continue
    const enemyMuzzleZ = 7.0 * (1 + sizePerCube * (m.cubes ?? 0))
    const origin: Vec3 = [m.pos[0], m.pos[1], m.pos[2] + enemyMuzzleZ]
    const yaw = m.aim[0]
    const pitch = m.aim[1]
    const cp = Math.cos(pitch)
    const dir: Vec3 = [cp * Math.cos(yaw), cp * Math.sin(yaw), Math.sin(pitch)]

    let bestDist = Infinity
    let bestClosestPt: Vec3 | null = null
    let bestTarget: Vec3 | null = null

    for (const target of [selfCenter, selfHigh]) {
      const rel: Vec3 = [
        target[0] - origin[0],
        target[1] - origin[1],
        target[2] - origin[2],
      ]
      const projLen = dot3(rel, dir)
      if (projLen <= 0) continue

      const closestPt: Vec3 = [
        origin[0] + dir[0] * projLen,
        origin[1] + dir[1] * projLen,
        origin[2] + dir[2] * projLen,
      ]
      const d = dist3(target, closestPt)
      if (d < bestDist) {
        bestDist = d
        bestClosestPt = closestPt
        bestTarget = target
      }
    }

    if (
      bestClosestPt !== null &&
      bestTarget !== null &&
      bestDist <= laserRayRadius * 1.8 &&
      world.hasShotLOS(origin, bestTarget)
    ) {
      chargingLaserThreat = true
      if (bestDist <= laserRayRadius) {
        const urgency = clamp(
          0.65 + 0.35 * (1 - bestDist / laserRayRadius),
          0,
          1,
        )
        const away2d: Vec2 = [
          bestTarget[0] - bestClosestPt[0],
          bestTarget[1] - bestClosestPt[1],
        ]
        const perp = pickPerpendicular(
          [dir[0], dir[1]],
          away2d,
          selfVel2d,
          obs.self.pos,
          world,
          mechRadius,
          mechHeight,
        )
        sumX += perp[0] * urgency
        sumY += perp[1] * urgency
        if (urgency > maxUrgency) maxUrgency = urgency
      }
    }
  }

  const mag = Math.hypot(sumX, sumY)
  if (mag < 1e-6 || maxUrgency <= 0) {
    return { dodgeVec: [0, 0], dodgeUrgency: 0, chargingLaserThreat }
  }
  return {
    dodgeVec: [sumX / mag, sumY / mag],
    dodgeUrgency: clamp(maxUrgency, 0, 1),
    chargingLaserThreat,
  }
}
