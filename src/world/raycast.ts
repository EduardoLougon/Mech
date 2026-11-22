import type { Vec3 } from "../contracts.ts"
import type { Prism, WorldData } from "./loader.ts"

export interface RaycastScratch {
  prismStamp: Int32Array
  treeStamp: Int32Array
  stamp: number
  tBuffer: Float64Array
}

export function createRaycastScratch(world: WorldData): RaycastScratch {
  return {
    prismStamp: new Int32Array(world.prisms.length),
    treeStamp: new Int32Array(world.trees.count),
    stamp: 0,
    tBuffer: new Float64Array(512),
  }
}

export function heightAt(world: WorldData, x: number, y: number): number {
  const { minX, minY, step, nx, ny, scale, data } = world.terrain
  const gx = (x - minX) / step
  const gy = (y - minY) / step

  const i0 = Math.max(0, Math.min(nx - 2, Math.floor(gx)))
  const j0 = Math.max(0, Math.min(ny - 2, Math.floor(gy)))
  const tx = Math.max(0, Math.min(1, gx - i0))
  const ty = Math.max(0, Math.min(1, gy - j0))

  const row0 = j0 * nx + i0
  const row1 = row0 + nx
  const h00 = data[row0]
  const h10 = data[row0 + 1]
  const h01 = data[row1]
  const h11 = data[row1 + 1]

  const h0 = h00 + (h10 - h00) * tx
  const h1 = h01 + (h11 - h01) * tx
  return (h0 + (h1 - h0) * ty) * scale
}

export function slopeAt(world: WorldData, x: number, y: number): number {
  const eps = 0.5
  const invSpan = 1 / (2 * eps)
  const dx = (heightAt(world, x + eps, y) - heightAt(world, x - eps, y)) * invSpan
  const dy = (heightAt(world, x, y + eps) - heightAt(world, x, y - eps)) * invSpan
  return Math.atan(Math.hypot(dx, dy)) * (180 / Math.PI)
}

export function pointInRing(x: number, y: number, ring: Float64Array): boolean {
  const len = ring.length
  if (len < 6) return false
  let inside = false
  let x1 = ring[len - 2]
  let y1 = ring[len - 1]
  for (let i = 0; i < len; i += 2) {
    const x2 = ring[i]
    const y2 = ring[i + 1]
    if ((y2 > y) !== (y1 > y) && x < ((x1 - x2) * (y - y2)) / (y1 - y2) + x2) {
      inside = !inside
    }
    x1 = x2
    y1 = y2
  }
  return inside
}

export function pointInPrismXY(x: number, y: number, p: Prism): boolean {
  if (x < p.minX || x > p.maxX || y < p.minY || y > p.maxY) return false
  if (!pointInRing(x, y, p.ring)) return false
  for (let h = 0; h < p.holes.length; h++) {
    if (pointInRing(x, y, p.holes[h])) return false
  }
  return true
}

export function surfaceZAt(world: WorldData, x: number, y: number, currentZ: number): number {
  let bestZ = heightAt(world, x, y)
  const { hash, prisms } = world
  const cx = Math.floor((x - hash.minX) / hash.cellSize)
  const cy = Math.floor((y - hash.minY) / hash.cellSize)
  if (cx < 0 || cx >= hash.nx || cy < 0 || cy >= hash.ny) return bestZ

  const cell = cy * hash.nx + cx
  const start = hash.prismOffsets[cell]
  const end = hash.prismOffsets[cell + 1]
  const maxReachable = currentZ + 1.5

  for (let idx = start; idx < end; idx++) {
    const p = prisms[hash.prismIndices[idx]]
    if (p.top <= maxReachable && p.top > bestZ && pointInPrismXY(x, y, p)) {
      bestZ = p.top
    }
  }
  return bestZ
}

function collectRingCrossings(
  ax: number,
  ay: number,
  dx: number,
  dy: number,
  tz0: number,
  tz1: number,
  ring: Float64Array,
  tBuffer: Float64Array,
  count: number,
): number {
  const len = ring.length
  if (len < 6) return count
  let x1 = ring[len - 2]
  let y1 = ring[len - 1]
  for (let i = 0; i < len; i += 2) {
    const x2 = ring[i]
    const y2 = ring[i + 1]
    const ex = x2 - x1
    const ey = y2 - y1
    const denom = dx * ey - dy * ex
    if (Math.abs(denom) > 1e-12) {
      const qpx = x1 - ax
      const qpy = y1 - ay
      const t = (qpx * ey - qpy * ex) / denom
      if (t > tz0 && t < tz1) {
        const u = (qpx * dy - qpy * dx) / denom
        if (u >= 0 && u <= 1 && count < tBuffer.length) {
          tBuffer[count++] = t
        }
      }
    }
    x1 = x2
    y1 = y2
  }
  return count
}

function segmentHitsPrism(
  ax: number,
  ay: number,
  az: number,
  dx: number,
  dy: number,
  dz: number,
  p: Prism,
  tBuffer: Float64Array,
): boolean {
  let tz0 = 0
  let tz1 = 1
  if (Math.abs(dz) < 1e-9) {
    if (az < p.base || az > p.top) return false
  } else {
    const tA = (p.base - az) / dz
    const tB = (p.top - az) / dz
    tz0 = Math.max(0, Math.min(tA, tB))
    tz1 = Math.min(1, Math.max(tA, tB))
    if (tz0 > tz1) return false
  }

  // Segment AABB on [tz0, tz1] vs prism AABB
  const sx0 = ax + tz0 * dx
  const sx1 = ax + tz1 * dx
  const sy0 = ay + tz0 * dy
  const sy1 = ay + tz1 * dy
  if (Math.max(sx0, sx1) < p.minX || Math.min(sx0, sx1) > p.maxX) return false
  if (Math.max(sy0, sy1) < p.minY || Math.min(sy0, sy1) > p.maxY) return false

  let count = 0
  tBuffer[count++] = tz0
  count = collectRingCrossings(ax, ay, dx, dy, tz0, tz1, p.ring, tBuffer, count)
  for (let h = 0; h < p.holes.length; h++) {
    count = collectRingCrossings(ax, ay, dx, dy, tz0, tz1, p.holes[h], tBuffer, count)
  }
  if (count < tBuffer.length) tBuffer[count++] = tz1

  // Insertion sort on tiny array
  for (let i = 1; i < count; i++) {
    const v = tBuffer[i]
    let j = i - 1
    while (j >= 0 && tBuffer[j] > v) {
      tBuffer[j + 1] = tBuffer[j]
      j--
    }
    tBuffer[j + 1] = v
  }

  for (let i = 0; i < count - 1; i++) {
    const u0 = tBuffer[i]
    const u1 = tBuffer[i + 1]
    if (u1 - u0 < 1e-9) continue
    const uMid = 0.5 * (u0 + u1)
    if (pointInPrismXY(ax + uMid * dx, ay + uMid * dy, p)) {
      return true
    }
  }
  return false
}

function terrainBlocksSegment(
  world: WorldData,
  ax: number,
  ay: number,
  az: number,
  dx: number,
  dy: number,
  dz: number,
): boolean {
  const dist2D = Math.hypot(dx, dy)
  if (dist2D < 1e-6) return false
  const steps = Math.max(2, Math.ceil(dist2D / 1.5))
  for (let s = 1; s < steps; s++) {
    const t = s / steps
    const px = ax + t * dx
    const py = ay + t * dy
    const pz = az + t * dz
    if (pz < heightAt(world, px, py) - 0.05) {
      return true
    }
  }
  return false
}

function nextStamp(scratch: RaycastScratch): number {
  scratch.stamp++
  if (scratch.stamp >= 0x7fffffff) {
    scratch.prismStamp.fill(0)
    scratch.treeStamp.fill(0)
    scratch.stamp = 1
  }
  return scratch.stamp
}

function prismsBlockSegment(
  world: WorldData,
  scratch: RaycastScratch,
  stamp: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  dx: number,
  dy: number,
  dz: number,
): boolean {
  const { hash, prisms } = world
  const cellSize = hash.cellSize
  let cx = Math.floor((ax - hash.minX) / cellSize)
  let cy = Math.floor((ay - hash.minY) / cellSize)
  const endCx = Math.floor((bx - hash.minX) / cellSize)
  const endCy = Math.floor((by - hash.minY) / cellSize)

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0
  const tDeltaX = stepX !== 0 ? cellSize / Math.abs(dx) : Infinity
  const tDeltaY = stepY !== 0 ? cellSize / Math.abs(dy) : Infinity
  const nextBX = hash.minX + (cx + (stepX > 0 ? 1 : 0)) * cellSize
  const nextBY = hash.minY + (cy + (stepY > 0 ? 1 : 0)) * cellSize
  let tMaxX = stepX !== 0 ? (nextBX - ax) / dx : Infinity
  let tMaxY = stepY !== 0 ? (nextBY - ay) / dy : Infinity

  const maxIter = hash.nx + hash.ny + 4
  for (let iter = 0; iter < maxIter; iter++) {
    if (cx >= 0 && cx < hash.nx && cy >= 0 && cy < hash.ny) {
      const cell = cy * hash.nx + cx
      const start = hash.prismOffsets[cell]
      const end = hash.prismOffsets[cell + 1]
      for (let idx = start; idx < end; idx++) {
        const pIdx = hash.prismIndices[idx]
        if (scratch.prismStamp[pIdx] === stamp) continue
        scratch.prismStamp[pIdx] = stamp
        if (segmentHitsPrism(ax, ay, az, dx, dy, dz, prisms[pIdx], scratch.tBuffer)) {
          return true
        }
      }
    }

    if (cx === endCx && cy === endCy) break
    if (tMaxX < tMaxY) {
      if (tMaxX > 1) break
      cx += stepX
      tMaxX += tDeltaX
    } else {
      if (tMaxY > 1) break
      cy += stepY
      tMaxY += tDeltaY
    }
  }
  return false
}

function segmentCircleInterval2D(
  ax: number,
  ay: number,
  dx: number,
  dy: number,
  len2DSq: number,
  cx: number,
  cy: number,
  r: number,
): [number, number] | null {
  const fx = ax - cx
  const fy = ay - cy
  const c = fx * fx + fy * fy - r * r
  if (len2DSq < 1e-12) {
    return c <= 0 ? [0, 1] : null
  }
  const bHalf = fx * dx + fy * dy
  const disc = bHalf * bHalf - len2DSq * c
  if (disc <= 0) return null
  const sqrtD = Math.sqrt(disc)
  const t0 = Math.max(0, (-bHalf - sqrtD) / len2DSq)
  const t1 = Math.min(1, (-bHalf + sqrtD) / len2DSq)
  return t1 > t0 ? [t0, t1] : null
}

function treesBlockVision(
  world: WorldData,
  scratch: RaycastScratch,
  stamp: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  dx: number,
  dy: number,
  dz: number,
): boolean {
  const { hash, trees, rules } = world
  if (trees.count === 0) return false

  const len2DSq = dx * dx + dy * dy
  const len3D = Math.sqrt(len2DSq + dz * dz)
  const canopyBlockLen =
    -Math.log(Math.max(1e-6, rules.canopyBlockT)) / Math.max(1e-6, rules.canopyDensity)
  let canopyAccumLen = 0

  const cellSize = hash.cellSize
  let cx = Math.floor((ax - hash.minX) / cellSize)
  let cy = Math.floor((ay - hash.minY) / cellSize)
  const endCx = Math.floor((bx - hash.minX) / cellSize)
  const endCy = Math.floor((by - hash.minY) / cellSize)

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0
  const tDeltaX = stepX !== 0 ? cellSize / Math.abs(dx) : Infinity
  const tDeltaY = stepY !== 0 ? cellSize / Math.abs(dy) : Infinity
  const nextBX = hash.minX + (cx + (stepX > 0 ? 1 : 0)) * cellSize
  const nextBY = hash.minY + (cy + (stepY > 0 ? 1 : 0)) * cellSize
  let tMaxX = stepX !== 0 ? (nextBX - ax) / dx : Infinity
  let tMaxY = stepY !== 0 ? (nextBY - ay) / dy : Infinity

  const maxIter = hash.nx + hash.ny + 4
  for (let iter = 0; iter < maxIter; iter++) {
    if (cx >= 0 && cx < hash.nx && cy >= 0 && cy < hash.ny) {
      const cell = cy * hash.nx + cx
      const start = hash.treeOffsets[cell]
      const end = hash.treeOffsets[cell + 1]
      for (let idx = start; idx < end; idx++) {
        const tIdx = hash.treeIndices[idx]
        if (scratch.treeStamp[tIdx] === stamp) continue
        scratch.treeStamp[tIdx] = stamp

        const tz = trees.z[tIdx]
        const tTop = tz + trees.height[tIdx]

        // 1. Trunk check
        const trunkHit = segmentCircleInterval2D(
          ax,
          ay,
          dx,
          dy,
          len2DSq,
          trees.x[tIdx],
          trees.y[tIdx],
          trees.trunkR[tIdx],
        )
        if (trunkHit !== null) {
          const z0 = az + trunkHit[0] * dz
          const z1 = az + trunkHit[1] * dz
          if (Math.max(z0, z1) >= tz && Math.min(z0, z1) <= tTop) {
            return true
          }
        }

        // 2. Canopy check
        const crownR = trees.crownR[tIdx]
        if (crownR > 0) {
          const crownHit = segmentCircleInterval2D(
            ax,
            ay,
            dx,
            dy,
            len2DSq,
            trees.crownX[tIdx],
            trees.crownY[tIdx],
            crownR,
          )
          if (crownHit !== null) {
            const cBase = tz + trees.crownBase[tIdx]
            let t0 = crownHit[0]
            let t1 = crownHit[1]
            if (Math.abs(dz) < 1e-9) {
              if (az < cBase || az > tTop) {
                t1 = -1
              }
            } else {
              const tA = (cBase - az) / dz
              const tB = (tTop - az) / dz
              t0 = Math.max(t0, Math.min(tA, tB))
              t1 = Math.min(t1, Math.max(tA, tB))
            }
            if (t1 > t0) {
              canopyAccumLen += (t1 - t0) * len3D
              if (canopyAccumLen >= canopyBlockLen) {
                return true
              }
            }
          }
        }
      }
    }

    if (cx === endCx && cy === endCy) break
    if (tMaxX < tMaxY) {
      if (tMaxX > 1) break
      cx += stepX
      tMaxX += tDeltaX
    } else {
      if (tMaxY > 1) break
      cy += stepY
      tMaxY += tDeltaY
    }
  }
  return false
}

export function hasShotLOS(
  world: WorldData,
  scratch: RaycastScratch,
  a: Vec3,
  b: Vec3,
): boolean {
  const ax = a[0]
  const ay = a[1]
  const az = a[2]
  const bx = b[0]
  const by = b[1]
  const bz = b[2]
  const dx = bx - ax
  const dy = by - ay
  const dz = bz - az
  const stamp = nextStamp(scratch)

  if (prismsBlockSegment(world, scratch, stamp, ax, ay, az, bx, by, dx, dy, dz)) {
    return false
  }
  if (terrainBlocksSegment(world, ax, ay, az, dx, dy, dz)) {
    return false
  }
  return true
}

export function hasVisionLOS(
  world: WorldData,
  scratch: RaycastScratch,
  a: Vec3,
  b: Vec3,
  canopyBlocks: boolean,
): boolean {
  const ax = a[0]
  const ay = a[1]
  const az = a[2]
  const bx = b[0]
  const by = b[1]
  const bz = b[2]
  const dx = bx - ax
  const dy = by - ay
  const dz = bz - az
  const stamp = nextStamp(scratch)

  if (prismsBlockSegment(world, scratch, stamp, ax, ay, az, bx, by, dx, dy, dz)) {
    return false
  }
  if (terrainBlocksSegment(world, ax, ay, az, dx, dy, dz)) {
    return false
  }
  if (canopyBlocks && treesBlockVision(world, scratch, stamp, ax, ay, az, bx, by, dx, dy, dz)) {
    return false
  }
  return true
}
