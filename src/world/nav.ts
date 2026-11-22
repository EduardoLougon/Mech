import type { Vec2, Vec3 } from "../contracts.ts"
import type { WorldData } from "./loader.ts"
import {
  hasVisionLOS,
  heightAt,
  pointInPrismXY,
  slopeAt,
  surfaceZAt,
  type RaycastScratch,
} from "./raycast.ts"

const NAV_STEP = 4
const MAX_EXPANSIONS = 1500
const HEAP_CAP = 16384

const DX = [1, -1, 0, 0, 1, 1, -1, -1]
const DY = [0, 0, 1, -1, 1, -1, 1, -1]
const STEP_DIST = [
  NAV_STEP,
  NAV_STEP,
  NAV_STEP,
  NAV_STEP,
  NAV_STEP * Math.SQRT2,
  NAV_STEP * Math.SQRT2,
  NAV_STEP * Math.SQRT2,
  NAV_STEP * Math.SQRT2,
]

export interface NavGrid {
  minX: number
  minY: number
  step: number
  nx: number
  ny: number
  maxSlopeDeg: number
  cellZ: Float32Array
  cellRoofZ: Float32Array
  cellSlope: Float32Array
  cellBlocked: Uint8Array
  cellNearCover: Uint8Array
  // Preallocated A* scratch
  gScore: Float32Array
  parent: Int32Array
  openStamp: Int32Array
  closedStamp: Int32Array
  heapNode: Int32Array
  heapF: Float32Array
  stamp: number
}

export function buildNavGrid(world: WorldData, maxSlopeDeg: number): NavGrid {
  const minX = Math.floor(world.bounds.minX)
  const minY = Math.floor(world.bounds.minY)
  const nx = Math.max(1, Math.ceil((world.bounds.maxX - minX) / NAV_STEP))
  const ny = Math.max(1, Math.ceil((world.bounds.maxY - minY) / NAV_STEP))
  const total = nx * ny

  const cellZ = new Float32Array(total)
  const cellRoofZ = new Float32Array(total)
  const cellSlope = new Float32Array(total)
  const cellBlocked = new Uint8Array(total)
  const cellNearCover = new Uint8Array(total)

  const { hash, prisms } = world

  for (let gy = 0; gy < ny; gy++) {
    const wy = minY + (gy + 0.5) * NAV_STEP
    const hCy = Math.floor((wy - hash.minY) / hash.cellSize)
    const row = gy * nx

    for (let gx = 0; gx < nx; gx++) {
      const wx = minX + (gx + 0.5) * NAV_STEP
      const idx = row + gx

      let tz = heightAt(world, wx, wy)
      const sl = slopeAt(world, wx, wy)
      let roofZ = tz
      let blocked = 0

      const hCx = Math.floor((wx - hash.minX) / hash.cellSize)
      if (hCx >= 0 && hCx < hash.nx && hCy >= 0 && hCy < hash.ny) {
        const hCell = hCy * hash.nx + hCx
        const start = hash.prismOffsets[hCell]
        const end = hash.prismOffsets[hCell + 1]
        for (let pPtr = start; pPtr < end; pPtr++) {
          const p = prisms[hash.prismIndices[pPtr]]
          if (!pointInPrismXY(wx, wy, p)) continue
          if (p.top > roofZ) roofZ = p.top
          if (p.top <= tz + 1.2 && p.top > tz) {
            tz = p.top
          } else if (p.base <= tz + 9.0 && p.top > tz + 1.2) {
            blocked = 1
          }
        }
      }

      cellZ[idx] = tz
      cellRoofZ[idx] = roofZ
      cellSlope[idx] = sl
      cellBlocked[idx] = blocked
    }
  }

  for (let gy = 1; gy < ny - 1; gy++) {
    const row = gy * nx
    for (let gx = 1; gx < nx - 1; gx++) {
      const idx = row + gx
      if (cellBlocked[idx]) {
        cellNearCover[idx] = 1
        continue
      }
      let hasWall = 0
      for (let d = 0; d < 8; d++) {
        if (cellBlocked[(gy + DY[d]) * nx + (gx + DX[d])]) {
          hasWall = 1
          break
        }
      }
      cellNearCover[idx] = hasWall
    }
  }

  return {
    minX,
    minY,
    step: NAV_STEP,
    nx,
    ny,
    maxSlopeDeg,
    cellZ,
    cellRoofZ,
    cellSlope,
    cellBlocked,
    cellNearCover,
    gScore: new Float32Array(total),
    parent: new Int32Array(total),
    openStamp: new Int32Array(total),
    closedStamp: new Int32Array(total),
    heapNode: new Int32Array(HEAP_CAP),
    heapF: new Float32Array(HEAP_CAP),
    stamp: 0,
  }
}

function worldToGrid(nav: NavGrid, x: number, y: number): [number, number] {
  const gx = Math.max(0, Math.min(nav.nx - 1, Math.floor((x - nav.minX) / nav.step)))
  const gy = Math.max(0, Math.min(nav.ny - 1, Math.floor((y - nav.minY) / nav.step)))
  return [gx, gy]
}

function octileH(gx: number, gy: number, tx: number, ty: number, step: number): number {
  const dx = Math.abs(gx - tx)
  const dy = Math.abs(gy - ty)
  const minD = dx < dy ? dx : dy
  const maxD = dx > dy ? dx : dy
  return (maxD + (Math.SQRT2 - 1) * minD) * step
}

function heapPush(
  heapNode: Int32Array,
  heapF: Float32Array,
  size: number,
  node: number,
  f: number,
): number {
  if (size >= HEAP_CAP) return size
  let i = size
  heapNode[i] = node
  heapF[i] = f
  while (i > 0) {
    const p = (i - 1) >> 1
    if (heapF[p] <= heapF[i]) break
    const tmpN = heapNode[p]
    const tmpF = heapF[p]
    heapNode[p] = heapNode[i]
    heapF[p] = heapF[i]
    heapNode[i] = tmpN
    heapF[i] = tmpF
    i = p
  }
  return size + 1
}

function heapPop(heapNode: Int32Array, heapF: Float32Array, size: number): [number, number] {
  const top = heapNode[0]
  const last = size - 1
  if (last > 0) {
    heapNode[0] = heapNode[last]
    heapF[0] = heapF[last]
    let i = 0
    while (true) {
      const l = (i << 1) + 1
      if (l >= last) break
      const r = l + 1
      let best = l
      if (r < last && heapF[r] < heapF[l]) best = r
      if (heapF[i] <= heapF[best]) break
      const tmpN = heapNode[i]
      const tmpF = heapF[i]
      heapNode[i] = heapNode[best]
      heapF[i] = heapF[best]
      heapNode[best] = tmpN
      heapF[best] = tmpF
      i = best
    }
  }
  return [top, last]
}

export function findPath(nav: NavGrid, from: Vec3, to: Vec3, canJet: boolean): Vec3[] {
  const [sx, sy] = worldToGrid(nav, from[0], from[1])
  const [tx, ty] = worldToGrid(nav, to[0], to[1])
  if (sx === tx && sy === ty) {
    return [[to[0], to[1], to[2]]]
  }

  nav.stamp++
  if (nav.stamp >= 0x7fffffff) {
    nav.openStamp.fill(0)
    nav.closedStamp.fill(0)
    nav.stamp = 1
  }
  const stamp = nav.stamp

  const {
    nx,
    ny,
    step,
    maxSlopeDeg,
    cellZ,
    cellRoofZ,
    cellSlope,
    cellBlocked,
    cellNearCover,
    gScore,
    parent,
    openStamp,
    closedStamp,
    heapNode,
    heapF,
  } = nav

  const startIdx = sy * nx + sx
  const targetIdx = ty * nx + tx

  gScore[startIdx] = 0
  parent[startIdx] = -1
  openStamp[startIdx] = stamp

  const startH = octileH(sx, sy, tx, ty, step)
  let heapSize = heapPush(heapNode, heapF, 0, startIdx, startH)

  let bestNode = startIdx
  let bestH = startH
  let reached = false
  let expansions = 0

  while (heapSize > 0 && expansions < MAX_EXPANSIONS) {
    const [u, nextSize] = heapPop(heapNode, heapF, heapSize)
    heapSize = nextSize
    if (closedStamp[u] === stamp) continue
    closedStamp[u] = stamp

    if (u === targetIdx) {
      reached = true
      bestNode = u
      break
    }

    expansions++
    const ux = u % nx
    const uy = (u / nx) | 0
    const zU = canJet && cellBlocked[u] ? cellRoofZ[u] : cellZ[u]
    const gU = gScore[u]

    for (let d = 0; d < 8; d++) {
      const vx = ux + DX[d]
      const vy = uy + DY[d]
      if (vx < 0 || vx >= nx || vy < 0 || vy >= ny) continue
      const v = vy * nx + vx
      if (closedStamp[v] === stamp) continue

      const blockedV = cellBlocked[v] === 1
      if (!canJet && blockedV) continue

      // Prevent diagonal corner cutting across solid buildings
      if (d >= 4 && !canJet) {
        if (cellBlocked[uy * nx + vx] || cellBlocked[vy * nx + ux]) continue
      }

      let extraCost = 0
      const slopeV = cellSlope[v]
      if (!blockedV && slopeV > maxSlopeDeg) {
        if (!canJet) {
          if (u !== startIdx) continue
          extraCost += STEP_DIST[d] * 4
        } else {
          extraCost += STEP_DIST[d] * 1.5
        }
      }

      const zV = canJet && blockedV ? cellRoofZ[v] : cellZ[v]
      const dz = zV - zU
      if (canJet) {
        if (dz > 50) continue
        if (dz > 1.5) extraCost += dz * 1.5
      } else if (dz > 4.5 && u !== startIdx) {
        continue
      }

      if (cellNearCover[v] === 0) {
        extraCost += STEP_DIST[d] * 0.35
      }

      const tentativeG = gU + STEP_DIST[d] + extraCost
      if (openStamp[v] !== stamp || tentativeG < gScore[v]) {
        gScore[v] = tentativeG
        parent[v] = u
        openStamp[v] = stamp
        const h = octileH(vx, vy, tx, ty, step)
        if (h < bestH) {
          bestH = h
          bestNode = v
        }
        heapSize = heapPush(heapNode, heapF, heapSize, v, tentativeG + h)
      }
    }
  }

  // Reconstruct reversed path
  const rev: Vec3[] = []
  let cur = reached ? targetIdx : bestNode
  while (cur !== -1 && cur !== startIdx) {
    const cx = cur % nx
    const cy = (cur / nx) | 0
    const wx = nav.minX + (cx + 0.5) * step
    const wy = nav.minY + (cy + 0.5) * step
    const wz = canJet && cellBlocked[cur] ? cellRoofZ[cur] : cellZ[cur]
    rev.push([wx, wy, wz])
    cur = parent[cur]
  }
  rev.reverse()

  if (reached && rev.length > 0) {
    rev[rev.length - 1] = [to[0], to[1], to[2]]
  } else if (rev.length === 0) {
    return [[to[0], to[1], to[2]]]
  }

  // Simplify collinear waypoints
  if (rev.length <= 2) return rev
  const out: Vec3[] = [rev[0]]
  for (let i = 1; i < rev.length - 1; i++) {
    const prev = out[out.length - 1]
    const curr = rev[i]
    const next = rev[i + 1]
    const dx1 = curr[0] - prev[0]
    const dy1 = curr[1] - prev[1]
    const dx2 = next[0] - curr[0]
    const dy2 = next[1] - curr[1]
    const cross = Math.abs(dx1 * dy2 - dy1 * dx2)
    const dzDiff = Math.abs(curr[2] - 0.5 * (prev[2] + next[2]))
    if (cross > 0.25 || dzDiff > 1.5) {
      out.push(curr)
    }
  }
  out.push(rev[rev.length - 1])
  return out
}

export function findCover(
  nav: NavGrid,
  world: WorldData,
  scratch: RaycastScratch,
  pos: Vec3,
  threats: Vec3[],
  radius: number,
  canopyBlocks: boolean,
): Vec3 | null {
  if (threats.length === 0) return null

  const [cx, cy] = worldToGrid(nav, pos[0], pos[1])
  const rCells = Math.max(1, Math.ceil(radius / nav.step))
  const rSq = radius * radius

  const candidates: Array<{ idx: number; wx: number; wy: number; wz: number; distSq: number }> = []
  const gx0 = Math.max(0, cx - rCells)
  const gx1 = Math.min(nav.nx - 1, cx + rCells)
  const gy0 = Math.max(0, cy - rCells)
  const gy1 = Math.min(nav.ny - 1, cy + rCells)

  for (let gy = gy0; gy <= gy1; gy++) {
    const wy = nav.minY + (gy + 0.5) * nav.step
    const dy = wy - pos[1]
    const dySq = dy * dy
    const row = gy * nav.nx
    for (let gx = gx0; gx <= gx1; gx++) {
      const idx = row + gx
      if (nav.cellBlocked[idx]) continue
      if (nav.cellSlope[idx] > nav.maxSlopeDeg) continue
      const wx = nav.minX + (gx + 0.5) * nav.step
      const dx = wx - pos[0]
      const distSq = dx * dx + dySq
      if (distSq > rSq || distSq < 4) continue
      candidates.push({ idx, wx, wy, wz: nav.cellZ[idx], distSq })
    }
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.distSq - b.distSq)

  const maxToTest = Math.min(candidates.length, 64)
  let bestCandidate: Vec3 | null = null
  let bestVisible = Infinity

  for (let i = 0; i < maxToTest; i++) {
    const c = candidates[i]
    const candEye: Vec3 = [c.wx, c.wy, c.wz + 6.0]
    let visibleCount = 0

    for (let t = 0; t < threats.length; t++) {
      const th = threats[t]
      const threatEye: Vec3 = [th[0], th[1], th[2] + 6.0]
      if (hasVisionLOS(world, scratch, threatEye, candEye, canopyBlocks)) {
        visibleCount++
        if (visibleCount >= bestVisible) break
      }
    }

    if (visibleCount === 0) {
      return [c.wx, c.wy, c.wz]
    }
    if (visibleCount < bestVisible) {
      bestVisible = visibleCount
      bestCandidate = [c.wx, c.wy, c.wz]
    }
  }

  return bestCandidate
}

/**
 * Local obstacle/slope avoidance helper for smooth movement along a waypoint.
 */
export function computeLocalSteer(
  world: WorldData,
  pos: Vec3,
  target: Vec3,
  maxSlopeDeg: number,
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
    const sz = surfaceZAt(world, fx, fy, pos[2])
    if (sz - pos[2] <= 1.4 && slopeAt(world, fx, fy) <= maxSlopeDeg) {
      return [Math.cos(yaw), Math.sin(yaw)]
    }
  }

  return [dx / dist, dy / dist]
}
