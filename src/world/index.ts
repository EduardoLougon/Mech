import type { Config, Vec2, Vec3, WorldQuery } from "../contracts.ts"
import { loadWorldData } from "./loader.ts"
import { buildNavGrid, findCover, findPath } from "./nav.ts"
import {
  createRaycastScratch,
  hasShotLOS,
  hasVisionLOS,
  heightAt,
  slopeAt,
  surfaceZAt,
} from "./raycast.ts"

export function createWorld(mapDir: string, config: Config): WorldQuery {
  const world = loadWorldData(mapDir)
  const scratch = createRaycastScratch(world)
  const maxSlopeDeg = config.mech?.max_slope_deg ?? world.rules.maxSlopeDeg
  const canopyBlocks = config.vision?.canopy_blocks ?? true
  const nav = buildNavGrid(world, maxSlopeDeg)

  return {
    heightAt(x: number, y: number): number {
      return heightAt(world, x, y)
    },
    slopeAt(x: number, y: number): number {
      return slopeAt(world, x, y)
    },
    hasShotLOS(a: Vec3, b: Vec3): boolean {
      return hasShotLOS(world, scratch, a, b)
    },
    hasVisionLOS(a: Vec3, b: Vec3): boolean {
      return hasVisionLOS(world, scratch, a, b, canopyBlocks)
    },
    surfaceZAt(x: number, y: number, currentZ: number): number {
      return surfaceZAt(world, x, y, currentZ)
    },
    findPath(from: Vec3, to: Vec3, canJet: boolean): Vec3[] {
      return findPath(nav, from, to, canJet)
    },
    findCover(
      pos: Vec3,
      threats: Vec3[],
      radius: number,
      isSafe?: (x: number, y: number) => boolean,
      eyeHeight = 8,
    ): Vec3 | null {
      return findCover(nav, world, scratch, pos, threats, radius, isSafe, eyeHeight)
    },
  }
}

const STEER_ANGLES = [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.57, -1.57]

function isSteerClear(
  world: WorldQuery,
  pos: Vec3,
  dirX: number,
  dirY: number,
  maxSlopeDeg: number,
  steps: number[],
  checkLateral: boolean,
): boolean {
  const perpX = -dirY
  const perpY = dirX

  for (let s = 0; s < steps.length; s++) {
    const step = steps[s]
    const fx = pos[0] + dirX * step
    const fy = pos[1] + dirY * step
    const sz = world.surfaceZAt(fx, fy, pos[2])
    if (sz - pos[2] > 1.5 || world.slopeAt(fx, fy) > maxSlopeDeg) {
      return false
    }
    if (checkLateral) {
      const lx = fx + perpX * 2.5
      const ly = fy + perpY * 2.5
      if (world.surfaceZAt(lx, ly, pos[2]) - pos[2] > 1.5) return false

      const rx = fx - perpX * 2.5
      const ry = fy - perpY * 2.5
      if (world.surfaceZAt(rx, ry, pos[2]) - pos[2] > 1.5) return false
    }
  }
  return true
}

export function computeLocalSteer(
  world: WorldQuery,
  pos: Vec3,
  target: Vec3,
  maxSlopeDeg = 50,
): Vec2 {
  const dx = target[0] - pos[0]
  const dy = target[1] - pos[1]
  const dist = Math.hypot(dx, dy)
  if (dist < 1e-4) return [0, 0]

  const baseYaw = Math.atan2(dy, dx)
  const steps = dist < 2.0 ? [dist] : [2.0, Math.min(4.0, dist)]

  // Pass 1: 2m and 4m steps with +/- 2.5m lateral clearance
  for (let i = 0; i < STEER_ANGLES.length; i++) {
    const yaw = baseYaw + STEER_ANGLES[i]
    const dirX = Math.cos(yaw)
    const dirY = Math.sin(yaw)
    if (isSteerClear(world, pos, dirX, dirY, maxSlopeDeg, steps, true)) {
      return [dirX, dirY]
    }
  }

  // Pass 2: center-line clearance fallback in tight corridors
  for (let i = 0; i < STEER_ANGLES.length; i++) {
    const yaw = baseYaw + STEER_ANGLES[i]
    const dirX = Math.cos(yaw)
    const dirY = Math.sin(yaw)
    if (isSteerClear(world, pos, dirX, dirY, maxSlopeDeg, steps, false)) {
      return [dirX, dirY]
    }
  }

  return [dx / dist, dy / dist]
}
