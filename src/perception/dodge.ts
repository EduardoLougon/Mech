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
  wantJump: boolean
  chargingLaserThreat: boolean
}

export interface DodgeModule {
  update(obs: Observation, world: WorldQuery): DodgeResult
}

interface DodgeThreat {
  dir: Vec2
  urgency: number
}

interface ChargingLaserInfo {
  origin: Vec3
  rayDir2d: Vec2
  chargeElapsed: number
  dist: number
}

const HORIZON_S = 0.6
const MORTAR_HORIZON_S = 2.5
const MORTAR_STEPS = 50
const CHARGE_STALE_S = 0.35
const LASER_SOUND_MATCH_RAD = (18 * Math.PI) / 180

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function normalizeAngle(rad: number): number {
  let a = rad % (2 * Math.PI)
  if (a > Math.PI) a -= 2 * Math.PI
  if (a < -Math.PI) a += 2 * Math.PI
  return a
}

function angleDiff(a: number, b: number): number {
  return Math.abs(normalizeAngle(a - b))
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
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
  const v1 = p1[0] * selfVel2d[0] + p1[1] * selfVel2d[1]
  const v2 = p2[0] * selfVel2d[0] + p2[1] * selfVel2d[1]
  return v1 >= v2 ? p1 : p2
}

/**
 * Perpendicular snap-juke that reverses our current lateral velocity (-dot(selfVel, perp))
 * to defeat linear laser tracking when no hard cover is reachable.
 */
function pickSnapJuke(
  rayDir2d: Vec2,
  selfVel2d: Vec2,
  fromOrigin2d: Vec2,
): Vec2 {
  let dx = rayDir2d[0]
  let dy = rayDir2d[1]
  let len = Math.hypot(dx, dy)
  if (len < 1e-6) {
    dx = fromOrigin2d[0]
    dy = fromOrigin2d[1]
    len = Math.hypot(dx, dy)
  }
  if (len < 1e-6) return [1, 0]

  const nx = dx / len
  const ny = dy / len
  const p1: Vec2 = [-ny, nx]
  const p2: Vec2 = [ny, -nx]

  const negDot1 = -(selfVel2d[0] * p1[0] + selfVel2d[1] * p1[1])
  const negDot2 = -(selfVel2d[0] * p2[0] + selfVel2d[1] * p2[1])
  if (Math.abs(negDot1 - negDot2) > 0.5) {
    return negDot1 >= negDot2 ? p1 : p2
  }
  const a1 = p1[0] * fromOrigin2d[0] + p1[1] * fromOrigin2d[1]
  const a2 = p2[0] * fromOrigin2d[0] + p2[1] * fromOrigin2d[1]
  return a1 >= a2 ? p1 : p2
}

function combineThreats(threats: DodgeThreat[]): { vec: Vec2; urgency: number } {
  if (threats.length === 0) {
    return { vec: [0, 0], urgency: 0 }
  }
  let top = threats[0]
  let sumX = 0
  let sumY = 0
  for (const th of threats) {
    sumX += th.dir[0] * th.urgency
    sumY += th.dir[1] * th.urgency
    if (th.urgency > top.urgency) {
      top = th
    }
  }
  const mag = Math.hypot(sumX, sumY)
  // Avoid opposite-threat zero-vector cancellation by committing to highest-urgency threat
  if (mag < top.urgency * 0.5 || mag < 1e-6) {
    return { vec: top.dir, urgency: clamp(top.urgency, 0, 1) }
  }
  return {
    vec: [sumX / mag, sumY / mag],
    urgency: clamp(top.urgency, 0, 1),
  }
}

/**
 * Create the stateful dodge module tracking per-enemy laser charge start times,
 * cover-first anti-laser evasion, velocity-aware gun/mortar evasion, and
 * non-cancelling threat vector combination.
 */
export function createDodge(config: Config): DodgeModule {
  const chargeStartT = new Map<number, number>()
  const chargeLastSeenT = new Map<number, number>()
  let prevT: number | null = null

  const gravity = config.weapons.mortar.gravity ?? 22
  const laserRange = config.weapons.laser.range ?? 280
  const laserChargeTime = config.weapons.laser.charge ?? 0.75
  const baseLightningRange = config.weapons.lightning.range ?? 45
  const baseRadius = config.mech.radius ?? 2.5
  const baseHeight = config.mech.height ?? 9.0
  const baseEyeHeight = config.mech.eye_height ?? 8.0
  const baseBoostSpeed = config.mech.boost_speed ?? 26
  const sizePerCube =
    typeof config.cubes.size_per_cube === "number"
      ? config.cubes.size_per_cube
      : 0.05

  function updateChargeTimers(obs: Observation): void {
    if (prevT !== null && obs.t < prevT) {
      chargeStartT.clear()
      chargeLastSeenT.clear()
    }
    prevT = obs.t

    // Clear timers for enemies that just fired a laser beam
    for (const beam of obs.beams) {
      if (beam.kind === "laser") {
        chargeStartT.delete(beam.by)
        chargeLastSeenT.delete(beam.by)
      }
    }

    for (const m of obs.mechs) {
      if (m.kind !== "mech") continue
      if (m.charging) {
        if (!chargeStartT.has(m.id)) {
          chargeStartT.set(m.id, obs.t)
        }
        chargeLastSeenT.set(m.id, obs.t)
      } else {
        chargeStartT.delete(m.id)
        chargeLastSeenT.delete(m.id)
      }
    }

    for (const [id, lastT] of chargeLastSeenT) {
      if (obs.t - lastT > CHARGE_STALE_S) {
        chargeStartT.delete(id)
        chargeLastSeenT.delete(id)
      }
    }
  }

  function update(obs: Observation, world: WorldQuery): DodgeResult {
    updateChargeTimers(obs)

    const self = obs.self
    const selfSizeScale = 1 + sizePerCube * self.cubes
    const selfRadius = self.stats.radius ?? baseRadius * selfSizeScale
    const selfHeight = self.stats.height ?? baseHeight * selfSizeScale
    const selfHalfH = selfHeight * 0.5
    const eyeHeight = self.stats.eye_height ?? baseEyeHeight * selfSizeScale
    const boostSpeed = self.stats.boost_speed ?? baseBoostSpeed

    const selfCenter: Vec3 = [
      self.pos[0],
      self.pos[1],
      self.pos[2] + selfHalfH,
    ]
    const selfEye: Vec3 = [
      self.pos[0],
      self.pos[1],
      self.pos[2] + eyeHeight,
    ]
    const selfVel: Vec3 = [self.vel[0], self.vel[1], self.vel[2]]
    const selfVel2d: Vec2 = [self.vel[0], self.vel[1]]

    const lightningWeapon = self.weapons.find(
      (w) => w !== null && w.kind === "lightning",
    )
    const holdsLightning = lightningWeapon !== undefined
    const lightningRange = lightningWeapon?.stats.range ?? baseLightningRange

    const threats: DodgeThreat[] = []
    let wantJump = false
    let chargingLaserThreat = false

    // 1. Cover-First Anti-Laser Evasion
    const evadeLasers: ChargingLaserInfo[] = []
    for (const m of obs.mechs) {
      if (m.kind !== "mech" || !m.charging) continue
      const enemyMuzzleZ = 8.0 * (1 + sizePerCube * (m.cubes ?? 0))
      const origin: Vec3 = [m.pos[0], m.pos[1], m.pos[2] + enemyMuzzleZ]
      const d = dist3(origin, selfCenter)
      if (d > laserRange) continue

      const yaw = m.aim[0]
      const pitch = m.aim[1]
      const cp = Math.cos(pitch)
      const aimDir: Vec3 = [
        cp * Math.cos(yaw),
        cp * Math.sin(yaw),
        Math.sin(pitch),
      ]

      let minAngle = Infinity
      for (const target of [selfCenter, selfEye]) {
        const rx = target[0] - origin[0]
        const ry = target[1] - origin[1]
        const rz = target[2] - origin[2]
        const rLen = Math.hypot(rx, ry, rz)
        if (rLen < 1e-6) {
          minAngle = 0
          break
        }
        const cosA = clamp(
          (rx * aimDir[0] + ry * aimDir[1] + rz * aimDir[2]) / rLen,
          -1,
          1,
        )
        const ang = Math.acos(cosA)
        if (ang < minAngle) minAngle = ang
      }

      const coneRad = Math.max(Math.atan2(6.5, Math.max(1, d)), 0.25)
      if (
        minAngle <= coneRad &&
        (world.hasShotLOS(origin, selfCenter) || world.hasShotLOS(origin, selfEye))
      ) {
        chargingLaserThreat = true
        // If we hold lightning and they are within lightning range, stay in range to short them!
        if (holdsLightning && d <= lightningRange) {
          continue
        }
        const chargeElapsed = Math.max(
          0,
          obs.t - (chargeStartT.get(m.id) ?? obs.t),
        )
        evadeLasers.push({
          origin,
          rayDir2d: [aimDir[0], aimDir[1]],
          chargeElapsed,
          dist: d,
        })
      }
    }

    // Also detect recent laser_charge sounds (age <= 0.6s)
    for (const s of obs.sounds) {
      if (s.kind !== "laser_charge" || s.age > 0.6) continue
      chargingLaserThreat = true
      const matchedVisible = obs.mechs.some(
        (m) =>
          m.kind === "mech" &&
          angleDiff(
            Math.atan2(m.pos[1] - self.pos[1], m.pos[0] - self.pos[0]),
            s.bearing,
          ) <= LASER_SOUND_MATCH_RAD,
      )
      if (!matchedVisible && (s.dist === "near" || s.dist === "mid")) {
        const estDist = s.dist === "near" ? 35 : 100
        const ox = self.pos[0] + Math.cos(s.bearing) * estDist
        const oy = self.pos[1] + Math.sin(s.bearing) * estDist
        const oz = world.heightAt(ox, oy) + 8.0
        evadeLasers.push({
          origin: [ox, oy, oz],
          rayDir2d: [-Math.cos(s.bearing), -Math.sin(s.bearing)],
          chargeElapsed: s.age,
          dist: estDist,
        })
      }
    }

    if (evadeLasers.length > 0) {
      const chargingOrigins = evadeLasers.map((l) => l.origin)
      let maxChargeElapsed = 0
      let primaryLaser = evadeLasers[0]
      for (const l of evadeLasers) {
        if (
          l.chargeElapsed > maxChargeElapsed ||
          (l.chargeElapsed === maxChargeElapsed && l.dist < primaryLaser.dist)
        ) {
          maxChargeElapsed = l.chargeElapsed
          primaryLaser = l
        }
      }

      const coverR = Math.min(
        18,
        boostSpeed * Math.max(0.25, laserChargeTime - maxChargeElapsed) + 2,
      )
      const cover = world.findCover(
        self.pos,
        chargingOrigins,
        coverR,
        undefined,
        eyeHeight,
      )

      if (cover !== null) {
        const cdx = cover[0] - self.pos[0]
        const cdy = cover[1] - self.pos[1]
        const clen = Math.hypot(cdx, cdy)
        if (clen > 0.25) {
          return {
            dodgeVec: [cdx / clen, cdy / clen],
            dodgeUrgency: 1.0,
            wantJump: false,
            chargingLaserThreat,
          }
        }
      }

      // Open ground: snap-juke perpendicular reversing lateral momentum, jump late
      const snapDir = pickSnapJuke(primaryLaser.rayDir2d, selfVel2d, [
        self.pos[0] - primaryLaser.origin[0],
        self.pos[1] - primaryLaser.origin[1],
      ])
      wantJump = maxChargeElapsed >= 0.42
      threats.push({ dir: snapDir, urgency: 0.85 })
    }

    // 2. Velocity-Aware Gun & Mortar Dodge
    const mortarDangerR = 10.5 + selfRadius
    const mortarMaxDz = selfHalfH * 2 + 8
    const gunHorizDanger = selfRadius + 1.5
    const gunVertDanger = selfHalfH + 1.5

    for (const proj of obs.projectiles) {
      if (proj.kind === "mortar") {
        const dtStep = MORTAR_HORIZON_S / MORTAR_STEPS
        let prevPt: Vec3 = [proj.pos[0], proj.pos[1], proj.pos[2]]
        let impactPt: Vec3 | null = null
        let blastOrigin: Vec3 | null = null
        let impactT = 0

        // Track mid-air closest pass in case mortar flies straight at us before hitting ground
        let bestMidDist2d = Infinity
        let bestMidPt: Vec3 | null = null
        let bestMidT = 0

        for (let i = 1; i <= MORTAR_STEPS; i++) {
          const t = i * dtStep
          const pt: Vec3 = [
            proj.pos[0] + proj.vel[0] * t,
            proj.pos[1] + proj.vel[1] * t,
            proj.pos[2] + proj.vel[2] * t - 0.5 * gravity * t * t,
          ]

          const hitWall = !world.hasShotLOS(prevPt, pt)
          const surfZ = world.surfaceZAt(pt[0], pt[1], pt[2])
          const hitGround = pt[2] <= surfZ

          if (hitWall || hitGround) {
            impactT = t
            if (hitWall && !hitGround) {
              impactPt = [
                (prevPt[0] + pt[0]) * 0.5,
                (prevPt[1] + pt[1]) * 0.5,
                (prevPt[2] + pt[2]) * 0.5,
              ]
              blastOrigin = prevPt
            } else {
              impactPt = [pt[0], pt[1], Math.max(pt[2], surfZ)]
              blastOrigin = [impactPt[0], impactPt[1], impactPt[2] + 0.5]
            }
            break
          }

          const predSelfX = self.pos[0] + selfVel[0] * t
          const predSelfY = self.pos[1] + selfVel[1] * t
          const predSelfCenterZ =
            selfCenter[2] + (self.grounded ? 0 : selfVel[2] * Math.min(t, 0.5))
          const midD2 = Math.min(
            Math.hypot(pt[0] - self.pos[0], pt[1] - self.pos[1]),
            Math.hypot(pt[0] - predSelfX, pt[1] - predSelfY),
          )
          if (
            midD2 < bestMidDist2d &&
            Math.abs(pt[2] - predSelfCenterZ) <= selfHalfH + 1.5
          ) {
            bestMidDist2d = midD2
            bestMidPt = pt
            bestMidT = t
          }

          prevPt = pt
        }

        if (impactPt !== null && blastOrigin !== null && impactT > 0) {
          const predT = Math.min(impactT, 1.8)
          const predX = self.pos[0] + selfVel[0] * predT
          const predY = self.pos[1] + selfVel[1] * predT
          const predZ =
            self.pos[2] + (self.grounded ? 0 : selfVel[2] * Math.min(impactT, 0.5))
          const predCenter: Vec3 = [predX, predY, predZ + selfHalfH]

          const dCurr2d = Math.hypot(
            self.pos[0] - impactPt[0],
            self.pos[1] - impactPt[1],
          )
          const dPred2d = Math.hypot(predX - impactPt[0], predY - impactPt[1])
          const minHoriz = Math.min(dCurr2d, dPred2d)
          const dz = Math.min(
            Math.abs(impactPt[2] - self.pos[2]),
            Math.abs(impactPt[2] - predZ),
          )

          if (minHoriz <= mortarDangerR && dz <= mortarMaxDz) {
            // Skip if solid terrain/wall shields both our current and predicted position from blast
            if (
              !world.hasShotLOS(blastOrigin, selfCenter) &&
              !world.hasShotLOS(blastOrigin, predCenter)
            ) {
              continue
            }

            const distFactor = 1 - clamp(minHoriz / mortarDangerR, 0, 1)
            const timeFactor =
              1 - clamp(impactT / MORTAR_HORIZON_S, 0, 1) * 0.45
            const urgency = clamp(0.48 + 0.52 * distFactor * timeFactor, 0, 1)

            // Steer away from impact relative to whichever position is closer to danger
            const refX = dPred2d < dCurr2d ? predX : self.pos[0]
            const refY = dPred2d < dCurr2d ? predY : self.pos[1]
            let awayX = refX - impactPt[0]
            let awayY = refY - impactPt[1]
            // If we're walking into a led impact, prefer steering away from impact relative to current pos
            if (dPred2d < dCurr2d && dCurr2d > 1e-3) {
              awayX = self.pos[0] - impactPt[0]
              awayY = self.pos[1] - impactPt[1]
            }
            const awayLen = Math.hypot(awayX, awayY)
            const dir: Vec2 =
              awayLen > 1e-3
                ? [awayX / awayLen, awayY / awayLen]
                : pickPerpendicular(
                    [proj.vel[0], proj.vel[1]],
                    [awayX, awayY],
                    selfVel2d,
                  )
            threats.push({ dir, urgency })
          }
        } else if (
          bestMidPt !== null &&
          bestMidDist2d <= selfRadius + 1.5 &&
          bestMidT > 0
        ) {
          const away2d: Vec2 = [
            self.pos[0] - bestMidPt[0],
            self.pos[1] - bestMidPt[1],
          ]
          const perp = pickPerpendicular(
            [proj.vel[0], proj.vel[1]],
            away2d,
            selfVel2d,
          )
          threats.push({ dir: perp, urgency: 0.75 })
        }
        continue
      }

      // Velocity-aware linear projectiles (gun, npc)
      const relPos: Vec3 = [
        proj.pos[0] - selfCenter[0],
        proj.pos[1] - selfCenter[1],
        proj.pos[2] - selfCenter[2],
      ]
      const relVel: Vec3 = [
        proj.vel[0] - selfVel[0],
        proj.vel[1] - selfVel[1],
        proj.vel[2] - selfVel[2],
      ]
      const relVelSq = dot3(relVel, relVel)
      if (relVelSq < 1e-6) continue

      const tStar = clamp(-dot3(relPos, relVel) / relVelSq, 0, HORIZON_S)
      if (tStar <= 0) continue

      const projPt: Vec3 = [
        proj.pos[0] + proj.vel[0] * tStar,
        proj.pos[1] + proj.vel[1] * tStar,
        proj.pos[2] + proj.vel[2] * tStar,
      ]
      const selfPt: Vec3 = [
        selfCenter[0] + selfVel[0] * tStar,
        selfCenter[1] + selfVel[1] * tStar,
        selfCenter[2] + selfVel[2] * tStar,
      ]

      const horizDist = Math.hypot(
        projPt[0] - selfPt[0],
        projPt[1] - selfPt[1],
      )
      const vertDist = Math.abs(projPt[2] - selfPt[2])

      if (horizDist <= gunHorizDanger && vertDist <= gunVertDanger) {
        if (!world.hasShotLOS(proj.pos, projPt)) {
          continue
        }
        const normDist = Math.max(
          horizDist / gunHorizDanger,
          vertDist / gunVertDanger,
        )
        const distFactor = 1 - clamp(normDist, 0, 1)
        const timeFactor = 1 - clamp(tStar / HORIZON_S, 0, 1) * 0.4
        const urgency = clamp(0.45 + 0.55 * distFactor * timeFactor, 0, 1)

        const away2d: Vec2 = [selfPt[0] - projPt[0], selfPt[1] - projPt[1]]
        const perp = pickPerpendicular(
          [proj.vel[0], proj.vel[1]],
          away2d,
          selfVel2d,
        )
        threats.push({ dir: perp, urgency })
      }
    }

    const combined = combineThreats(threats)
    return {
      dodgeVec: combined.vec,
      dodgeUrgency: combined.urgency,
      wantJump,
      chargingLaserThreat,
    }
  }

  return { update }
}
