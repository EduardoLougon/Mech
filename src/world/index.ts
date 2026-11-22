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
    findCover(pos: Vec3, threats: Vec3[], radius: number): Vec3 | null {
      return findCover(nav, world, scratch, pos, threats, radius, canopyBlocks)
    },
  }
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
  const feelerDist = Math.min(4.0, dist)
  const angles = [0, 0.55, -0.55, 1.05, -1.05]

  for (let i = 0; i < angles.length; i++) {
    const yaw = baseYaw + angles[i]
    const fx = pos[0] + Math.cos(yaw) * feelerDist
    const fy = pos[1] + Math.sin(yaw) * feelerDist
    const sz = world.surfaceZAt(fx, fy, pos[2])
    if (sz - pos[2] <= 1.4 && world.slopeAt(fx, fy) <= maxSlopeDeg) {
      return [Math.cos(yaw), Math.sin(yaw)]
    }
  }

  return [dx / dist, dy / dist]
}
