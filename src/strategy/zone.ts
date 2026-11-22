import type { Config, Observation, Vec2, Vec3, WorldQuery } from "../contracts.ts"

export interface ZoneAdvice {
  mustSprint: boolean
  moveTarget: Vec3
  inNextSafe: boolean
  timeLeft: number
  distToNextCenter: number
  safeRadius: number
}

const ZONE_SAFETY_MARGIN = 15

/**
 * Compute a point inside `next_center` / `next_radius` closest to `fromPos`.
 */
export function clampToSafeZone(
  x: number,
  y: number,
  obs: Observation,
  world: WorldQuery,
  margin = ZONE_SAFETY_MARGIN,
): Vec3 {
  const [ncx, ncy] = obs.zone.next_center
  const safeR =
    obs.zone.next_radius > margin
      ? obs.zone.next_radius - margin
      : obs.zone.next_radius * 0.5

  const dx = x - ncx
  const dy = y - ncy
  const dist = Math.hypot(dx, dy)

  let tx = x
  let ty = y
  if (dist > safeR && dist > 1e-3) {
    const scale = safeR / dist
    tx = ncx + dx * scale
    ty = ncy + dy * scale
  } else if (safeR <= 1e-3) {
    tx = ncx
    ty = ncy
  }

  return [tx, ty, world.surfaceZAt(tx, ty, obs.self.pos[2])]
}

/**
 * Check whether a 2D/3D point is inside the current zone (and optionally within `margin` of the edge).
 */
export function isPointInSafeZone(
  pos: Vec2 | Vec3,
  obs: Observation,
  margin = 8,
): boolean {
  const [cx, cy] = obs.zone.center
  const dist = Math.hypot(pos[0] - cx, pos[1] - cy)
  if (dist > Math.max(obs.zone.radius * 0.5, obs.zone.radius - margin)) {
    return false
  }
  // If shrink is active or imminent, prefer points not far outside next_radius
  if (obs.t >= obs.zone.shrink_start - 5) {
    const [ncx, ncy] = obs.zone.next_center
    const nextDist = Math.hypot(pos[0] - ncx, pos[1] - ncy)
    if (nextDist > obs.zone.next_radius + 20) {
      return false
    }
  }
  return true
}

/**
 * Evaluate zone urgency and compute a safe rotation target inside `next_center` / `next_radius`.
 */
export function evaluateZone(
  obs: Observation,
  world: WorldQuery,
  config: Config,
): ZoneAdvice {
  const pos = obs.self.pos
  const [ncx, ncy] = obs.zone.next_center
  const [cx, cy] = obs.zone.center

  const safeRadius =
    obs.zone.next_radius > ZONE_SAFETY_MARGIN
      ? obs.zone.next_radius - ZONE_SAFETY_MARGIN
      : obs.zone.next_radius * 0.5

  const distToNextCenter = Math.hypot(pos[0] - ncx, pos[1] - ncy)
  const distToCurrentCenter = Math.hypot(pos[0] - cx, pos[1] - cy)
  const currentEdgeMargin = obs.zone.radius - distToCurrentCenter

  const timeLeft = Math.max(0, obs.zone.shrink_end - obs.t)
  const timeToShrinkStart = obs.zone.shrink_start - obs.t

  const moveSpeed = obs.self.stats.speed ?? config.mech.speed ?? 12
  const effectiveSpeed = Math.max(4, moveSpeed * 0.75)
  const distToSafe = Math.max(0, distToNextCenter - safeRadius)
  const travelTime = distToSafe / effectiveSpeed

  const inNextSafe = distToNextCenter <= safeRadius

  let mustSprint = false
  if (!obs.self.in_zone) {
    mustSprint = true
  } else if (!inNextSafe) {
    if (timeLeft <= travelTime + 4) {
      mustSprint = true
    } else if (timeToShrinkStart <= travelTime + 3 && obs.t >= obs.zone.shrink_start - 8) {
      mustSprint = true
    } else if (
      currentEdgeMargin < 12 &&
      obs.zone.shrink_end > obs.t &&
      obs.t >= obs.zone.shrink_start - 3
    ) {
      mustSprint = true
    }
  }

  const targetRadius = Math.max(0, safeRadius - 5)
  let tx = ncx
  let ty = ncy
  if (distToNextCenter > 1e-3 && targetRadius > 0) {
    const scale = Math.min(1, targetRadius / distToNextCenter)
    tx = ncx + (pos[0] - ncx) * scale
    ty = ncy + (pos[1] - ncy) * scale
  }
  const moveTarget: Vec3 = [tx, ty, world.surfaceZAt(tx, ty, pos[2])]

  return {
    mustSprint,
    moveTarget,
    inNextSafe,
    timeLeft,
    distToNextCenter,
    safeRadius,
  }
}
