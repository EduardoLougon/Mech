import type { Config, Vec2, Vec3, WorldQuery } from "../contracts.ts"
import { loadWorldData } from "./loader.ts"
import {
  buildNavGrid,
  findCover,
  findEmergencyRoofEscape,
  findPath,
  findPeekCover,
  findRoofCombatSpot,
  findRooftopSpot,
} from "./nav.ts"
import {
  createRaycastScratch,
  hasDirectWalkLine,
  hasShotLOS,
  hasVisionLOS,
  heightAt,
  isPointWalkable,
  slopeAt,
  snapToWalkable,
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
    isPointWalkable(
      x: number,
      y: number,
      currentZ: number,
      mechRadius = 2.5,
      mechHeight = 9.0,
    ): boolean {
      return isPointWalkable(world, x, y, currentZ, mechRadius, mechHeight, maxSlopeDeg)
    },
    hasDirectWalkLine(
      from: Vec3,
      to: Vec3,
      mechRadius = 2.5,
      mechHeight = 9.0,
    ): boolean {
      return hasDirectWalkLine(world, from, to, mechRadius, mechHeight, maxSlopeDeg)
    },
    snapToWalkable(
      x: number,
      y: number,
      currentZ: number,
      mechRadius = 2.5,
    ): Vec3 {
      return snapToWalkable(world, x, y, currentZ, mechRadius, maxSlopeDeg)
    },
    findPath(
      from: Vec3,
      to: Vec3,
      canJetOrMaxClimb: boolean | number,
      wantRoof = false,
    ): Vec3[] {
      return findPath(nav, from, to, canJetOrMaxClimb, wantRoof)
    },
    findCover(
      pos: Vec3,
      threats: Vec3[],
      radius: number,
      isSafe?: (x: number, y: number) => boolean,
      eyeHeight = 8,
      prevCover?: Vec3 | null,
      mechRadius = 2.5,
    ): Vec3 | null {
      return findCover(
        nav,
        world,
        scratch,
        pos,
        threats,
        radius,
        isSafe,
        eyeHeight,
        prevCover,
        mechRadius,
      )
    },
    findPeekCover(
      pos: Vec3,
      targetPos: Vec3,
      otherThreats: Vec3[],
      radius: number,
      isSafe?: (x: number, y: number) => boolean,
      eyeHeight = 8,
      prevCover?: Vec3 | null,
      mechRadius = 2.5,
      optRange?: number,
    ): Vec3 | null {
      return findPeekCover(
        nav,
        world,
        scratch,
        pos,
        targetPos,
        otherThreats,
        radius,
        isSafe,
        eyeHeight,
        prevCover,
        mechRadius,
        optRange,
      )
    },
    findRooftopSpot(
      pos: Vec3,
      zoneCenter: Vec2,
      zoneRadius: number,
      maxDist: number,
      threats: Vec3[],
    ): Vec3 | null {
      return findRooftopSpot(nav, pos, zoneCenter, zoneRadius, maxDist, threats)
    },
    findRoofCombatSpot(
      pos: Vec3,
      targetPos: Vec3 | null,
      otherThreats: Vec3[],
      optRange: number,
      isSafe?: (x: number, y: number) => boolean,
      eyeHeight = 8,
      minPitch = -0.7,
      prevCover: Vec3 | null = null,
    ): Vec3 | null {
      return findRoofCombatSpot(
        nav,
        world,
        scratch,
        pos,
        targetPos,
        otherThreats,
        optRange,
        isSafe,
        eyeHeight,
        minPitch,
        prevCover,
      )
    },
    findEmergencyRoofEscape(
      pos: Vec3,
      maxRelH: number,
      maxEdgeDist: number,
      threats: Vec3[],
      isSafe?: (x: number, y: number) => boolean,
      eyeHeight = 8,
    ): Vec3 | null {
      return findEmergencyRoofEscape(
        nav,
        world,
        scratch,
        pos,
        maxRelH,
        maxEdgeDist,
        threats,
        isSafe,
        eyeHeight,
      )
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
  mechRadius: number,
  mechHeight: number,
  keepOnRoof: boolean,
): boolean {
  let prevZ = pos[2]
  for (let s = 0; s < steps.length; s++) {
    const step = steps[s]
    const fx = pos[0] + dirX * step
    const fy = pos[1] + dirY * step
    const sz = world.surfaceZAt(fx, fy, prevZ)
    if (sz - prevZ > 1.5) return false
    if (keepOnRoof && prevZ - sz > 2.5) return false
    if (!world.isPointWalkable(fx, fy, sz, mechRadius, mechHeight)) {
      return false
    }
    if (maxSlopeDeg < 50) {
      const tz = world.heightAt(fx, fy)
      if (Math.abs(sz - tz) <= 1.0 && world.slopeAt(fx, fy) > maxSlopeDeg) {
        return false
      }
    }
    prevZ = sz
  }
  return true
}

export function computeLocalSteer(
  world: WorldQuery,
  pos: Vec3,
  target: Vec3,
  maxSlopeDeg = 50,
  mechRadius = 2.5,
  mechHeight = 9.0,
  keepOnRoof = false,
): Vec2 {
  const dx = target[0] - pos[0]
  const dy = target[1] - pos[1]
  const dist = Math.hypot(dx, dy)
  if (dist < 1e-4) return [0, 0]

  const baseYaw = Math.atan2(dy, dx)
  const steps = dist < 2.0 ? [dist] : [2.0, Math.min(4.0, dist)]

  // Pass 1: 2m and 4m feeler steps with full mechRadius clearance
  for (let i = 0; i < STEER_ANGLES.length; i++) {
    const yaw = baseYaw + STEER_ANGLES[i]
    const dirX = Math.cos(yaw)
    const dirY = Math.sin(yaw)
    if (
      isSteerClear(
        world,
        pos,
        dirX,
        dirY,
        maxSlopeDeg,
        steps,
        mechRadius,
        mechHeight,
        keepOnRoof,
      )
    ) {
      return [dirX, dirY]
    }
  }

  // Pass 2: tighter clearance fallback in narrow corridors
  const tightRadius = mechRadius * 0.55
  for (let i = 0; i < STEER_ANGLES.length; i++) {
    const yaw = baseYaw + STEER_ANGLES[i]
    const dirX = Math.cos(yaw)
    const dirY = Math.sin(yaw)
    if (
      isSteerClear(
        world,
        pos,
        dirX,
        dirY,
        maxSlopeDeg,
        steps,
        tightRadius,
        mechHeight,
        keepOnRoof,
      )
    ) {
      return [dirX, dirY]
    }
  }

  return [dx / dist, dy / dist]
}
