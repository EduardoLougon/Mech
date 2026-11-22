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
const CURRENT_ZONE_MARGIN = 12
const ZONE_BLEND_LEAD_S = 10

/**
 * Clamp a tactical/combat target inside the active safe zone.
 * Before `shrink_start - 10s`, clamps to the CURRENT zone (`center`, `radius - 12`)
 * to prevent early-game inward hijacking, then smoothly blends to `next_center / next_radius`.
 * Always snaps the resulting point to the nearest walkable cell.
 */
export function clampToSafeZone(
  x: number,
  y: number,
  obs: Observation,
  world: WorldQuery,
  margin = ZONE_SAFETY_MARGIN,
): Vec3 {
  const [ccx, ccy] = obs.zone.center
  const [ncx, ncy] = obs.zone.next_center

  const curMargin = Math.min(margin, CURRENT_ZONE_MARGIN)
  const curSafeR =
    obs.zone.radius > curMargin
      ? obs.zone.radius - curMargin
      : obs.zone.radius * 0.5

  const nextSafeR =
    obs.zone.next_radius > margin
      ? obs.zone.next_radius - margin
      : obs.zone.next_radius * 0.5

  const blendStart = obs.zone.shrink_start - ZONE_BLEND_LEAD_S
  let alpha = 0
  if (obs.t >= blendStart) {
    alpha = Math.max(0, Math.min(1, (obs.t - blendStart) / ZONE_BLEND_LEAD_S))
  }

  const cx = ccx + (ncx - ccx) * alpha
  const cy = ccy + (ncy - ccy) * alpha
  const safeR = curSafeR + (nextSafeR - curSafeR) * alpha

  const dx = x - cx
  const dy = y - cy
  const dist = Math.hypot(dx, dy)

  let tx = x
  let ty = y
  if (safeR <= 1e-3) {
    tx = cx
    ty = cy
  } else if (dist > safeR && dist > 1e-3) {
    const scale = safeR / dist
    tx = cx + dx * scale
    ty = cy + dy * scale
  }

  return world.snapToWalkable(tx, ty, obs.self.pos[2], obs.self.stats.radius)
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
 * Evaluate zone urgency and compute a walkable rotation target inside `next_center` / `next_radius`.
 * Supports `wasSprinting` hysteresis to avoid oscillating across the safe-zone boundary.
 */
export function evaluateZone(
  obs: Observation,
  world: WorldQuery,
  config: Config,
  wasSprinting = false,
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

  const moveSpeed = obs.self.stats.walk_speed ?? config.mech.walk_speed ?? 11.7
  const effectiveSpeed = Math.max(4, moveSpeed * 0.75)

  // Apply hysteresis margin when already sprinting so we step cleanly inside before releasing
  const hysteresisRadius = wasSprinting ? Math.max(0, safeRadius - 6) : safeRadius
  const distToSafe = Math.max(0, distToNextCenter - hysteresisRadius)
  const travelTime = distToSafe / effectiveSpeed

  const inNextSafe = distToNextCenter <= safeRadius
  const inHysteresisSafe = distToNextCenter <= hysteresisRadius

  let mustSprint = false
  if (!obs.self.in_zone) {
    mustSprint = true
  } else if (!inHysteresisSafe) {
    const timeMargin = wasSprinting ? 6 : 4
    const preShrinkMargin = wasSprinting ? 5 : 3
    const preShrinkWindow = wasSprinting ? 10 : 8
    const edgeMargin = wasSprinting ? 18 : 12

    if (timeLeft <= travelTime + timeMargin) {
      mustSprint = true
    } else if (
      timeToShrinkStart <= travelTime + preShrinkMargin &&
      obs.t >= obs.zone.shrink_start - preShrinkWindow
    ) {
      mustSprint = true
    } else if (
      currentEdgeMargin < edgeMargin &&
      obs.zone.shrink_end > obs.t &&
      obs.t >= obs.zone.shrink_start - 3
    ) {
      mustSprint = true
    }
  }

  const targetRadius = Math.max(0, safeRadius - 6)
  let tx = ncx
  let ty = ncy
  if (distToNextCenter > 1e-3 && targetRadius > 0) {
    const scale = Math.min(1, targetRadius / distToNextCenter)
    tx = ncx + (pos[0] - ncx) * scale
    ty = ncy + (pos[1] - ncy) * scale
  }
  const moveTarget = world.snapToWalkable(tx, ty, pos[2], obs.self.stats.radius)

  return {
    mustSprint,
    moveTarget,
    inNextSafe,
    timeLeft,
    distToNextCenter,
    safeRadius,
  }
}
