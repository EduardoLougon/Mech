import type { Vec3 } from "../contracts.ts"
import type { WorldData } from "./loader.ts"
import {
  hasShotLOS,
  heightAt,
  pointInPrismXY,
  slopeAt,
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
  cellTight: Uint8Array
  // Preallocated A* scratch
  gScore: Float32Array
  nodeZ: Float32Array
  parent: Int32Array
  openStamp: Int32Array
  closedStamp: Int32Array
  heapNode: Int32Array
  heapF: Float32Array
  stamp: number
}

const CLEARANCE_OFFSETS = [
  [2.5, 0],
  [-2.5, 0],
  [0, 2.5],
  [0, -2.5],
  [1.77, 1.77],
  [1.77, -1.77],
  [-1.77, 1.77],
  [-1.77, -1.77],
] as const

function hasBlockingPrismWithin(
  world: WorldData,
  wx: number,
  wy: number,
  tz: number,
): boolean {
  const { hash, prisms } = world
  const hCx = Math.floor((wx - hash.minX) / hash.cellSize)
  const hCy = Math.floor((wy - hash.minY) / hash.cellSize)
  const maxReachable = tz + 1.2
  const maxBase = tz + 9.0

  for (let dy = -1; dy <= 1; dy++) {
    const cy = hCy + dy
    if (cy < 0 || cy >= hash.ny) continue
    for (let dx = -1; dx <= 1; dx++) {
      const cx = hCx + dx
      if (cx < 0 || cx >= hash.nx) continue
      const hCell = cy * hash.nx + cx
      const start = hash.prismOffsets[hCell]
      const end = hash.prismOffsets[hCell + 1]
      for (let pPtr = start; pPtr < end; pPtr++) {
        const p = prisms[hash.prismIndices[pPtr]]
        if (p.base > maxBase || p.top <= maxReachable) continue
        if (
          wx < p.minX - 2.5 ||
          wx > p.maxX + 2.5 ||
          wy < p.minY - 2.5 ||
          wy > p.maxY + 2.5
        ) {
          continue
        }
        for (let k = 0; k < CLEARANCE_OFFSETS.length; k++) {
          const ox = wx + CLEARANCE_OFFSETS[k][0]
          const oy = wy + CLEARANCE_OFFSETS[k][1]
          if (pointInPrismXY(ox, oy, p)) return true
        }
      }
    }
  }
  return false
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
  const cellTight = new Uint8Array(total)

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
    const wy = minY + (gy + 0.5) * NAV_STEP
    const row = gy * nx
    for (let gx = 1; gx < nx - 1; gx++) {
      const idx = row + gx
      if (cellBlocked[idx]) {
        cellNearCover[idx] = 1
        cellTight[idx] = 1
        continue
      }
      let hasAdjWall = 0
      for (let d = 0; d < 8; d++) {
        if (cellBlocked[(gy + DY[d]) * nx + (gx + DX[d])]) {
          hasAdjWall = 1
          break
        }
      }
      if (hasAdjWall) {
        cellNearCover[idx] = 1
        const wx = minX + (gx + 0.5) * NAV_STEP
        if (hasBlockingPrismWithin(world, wx, wy, cellZ[idx])) {
          cellTight[idx] = 1
        }
        continue
      }
      // Also mark cells within 2 cells (8m) of a blocked cell as near cover
      let hasNearWall = 0
      const y0 = Math.max(0, gy - 2)
      const y1 = Math.min(ny - 1, gy + 2)
      const x0 = Math.max(0, gx - 2)
      const x1 = Math.min(nx - 1, gx + 2)
      for (let ny2 = y0; ny2 <= y1 && !hasNearWall; ny2++) {
        const r2 = ny2 * nx
        for (let nx2 = x0; nx2 <= x1; nx2++) {
          if (cellBlocked[r2 + nx2]) {
            hasNearWall = 1
            break
          }
        }
      }
      cellNearCover[idx] = hasNearWall
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
    cellTight,
    gScore: new Float32Array(total),
    nodeZ: new Float32Array(total),
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
    cellTight,
    gScore,
    nodeZ,
    parent,
    openStamp,
    closedStamp,
    heapNode,
    heapF,
  } = nav

  const startIdx = sy * nx + sx
  const targetIdx = ty * nx + tx

  gScore[startIdx] = 0
  nodeZ[startIdx] =
    from[2] > cellZ[startIdx] + 1.5
      ? cellRoofZ[startIdx] > cellZ[startIdx] + 1.5
        ? cellRoofZ[startIdx]
        : from[2]
      : cellZ[startIdx]
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
    const zU = nodeZ[u]
    const onElevatedU = zU > cellZ[u] + 1.5
    const gU = gScore[u]

    for (let d = 0; d < 8; d++) {
      const vx = ux + DX[d]
      const vy = uy + DY[d]
      if (vx < 0 || vx >= nx || vy < 0 || vy >= ny) continue
      const v = vy * nx + vx
      if (closedStamp[v] === stamp) continue

      const blockedV = cellBlocked[v] === 1
      const roofV = cellRoofZ[v]
      const hasRoofV = roofV > cellZ[v] + 1.5
      const canWalkElevatedV = onElevatedU && hasRoofV && roofV - zU <= 1.5

      if (!canJet && blockedV && !canWalkElevatedV) continue

      // Prevent diagonal corner cutting across solid buildings
      if (d >= 4 && !canJet && !canWalkElevatedV) {
        if (cellBlocked[uy * nx + vx] || cellBlocked[vy * nx + ux]) continue
      }

      let extraCost = 0
      const slopeV = cellSlope[v]
      if (!blockedV && !canWalkElevatedV && slopeV > maxSlopeDeg) {
        if (!canJet) {
          if (u !== startIdx) continue
          extraCost += STEP_DIST[d] * 4
        } else {
          extraCost += STEP_DIST[d] * 1.5
        }
      }

      const zV = canWalkElevatedV
        ? roofV
        : canJet && blockedV
          ? roofV
          : cellZ[v]
      const dz = zV - zU
      if (canJet) {
        if (dz > 25) continue
        if (dz > 1.5) extraCost += dz * 1.5
      } else if (dz > 4.5 && u !== startIdx) {
        continue
      }

      if (cellNearCover[v] === 0) {
        extraCost += STEP_DIST[d] * 1.2
      } else if (!blockedV && cellTight[v] === 1) {
        extraCost += STEP_DIST[d] * 0.8
      }

      const tentativeG = gU + STEP_DIST[d] + extraCost
      if (openStamp[v] !== stamp || tentativeG < gScore[v]) {
        gScore[v] = tentativeG
        nodeZ[v] = zV
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
    const wz = nodeZ[cur]
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
  isSafe?: (x: number, y: number) => boolean,
  eyeHeight = 8,
): Vec3 | null {
  if (threats.length === 0) return null

  const [cx, cy] = worldToGrid(nav, pos[0], pos[1])
  const rCells = Math.max(1, Math.ceil(radius / nav.step))
  const rSq = radius * radius
  const innerRSq = 16 * 16

  const candidates: Array<{ wx: number; wy: number; wz: number; distSq: number }> = []
  const gx0 = Math.max(0, cx - rCells)
  const gx1 = Math.min(nav.nx - 1, cx + rCells)
  const gy0 = Math.max(0, cy - rCells)
  const gy1 = Math.min(nav.ny - 1, cy + rCells)

  for (let gy = gy0; gy <= gy1; gy++) {
    const wy = nav.minY + (gy + 0.5) * nav.step
    const dy = wy - pos[1]
    const dySq = dy * dy
    const row = gy * nav.nx
    const oddY = ((gy - cy) & 1) !== 0
    for (let gx = gx0; gx <= gx1; gx++) {
      const idx = row + gx
      if (nav.cellBlocked[idx]) continue
      if (nav.cellSlope[idx] > nav.maxSlopeDeg) continue
      const wx = nav.minX + (gx + 0.5) * nav.step
      const dx = wx - pos[0]
      const distSq = dx * dx + dySq
      if (distSq > rSq || distSq < 4) continue
      if (distSq > innerRSq && (oddY || ((gx - cx) & 1) !== 0)) continue
      if (isSafe && !isSafe(wx, wy)) continue
      candidates.push({ wx, wy, wz: nav.cellZ[idx], distSq })
    }
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.distSq - b.distSq)

  const maxToTest = Math.min(candidates.length, 160)
  let bestCandidate: Vec3 | null = null
  let bestExposed = Infinity
  let bestScore = Infinity

  for (let i = 0; i < maxToTest; i++) {
    const c = candidates[i]
    const candEye: Vec3 = [c.wx, c.wy, c.wz + eyeHeight]
    let exposed = 0
    let minThreatDistSq = Infinity

    for (let t = 0; t < threats.length; t++) {
      const th = threats[t]
      const tdx = c.wx - th[0]
      const tdy = c.wy - th[1]
      const tDistSq = tdx * tdx + tdy * tdy
      if (tDistSq < minThreatDistSq) minThreatDistSq = tDistSq

      const threatEye: Vec3 = [th[0], th[1], th[2] + eyeHeight]
      if (hasShotLOS(world, scratch, threatEye, candEye)) {
        exposed++
        if (exposed > bestExposed) break
      }
    }

    if (exposed > bestExposed) continue

    const score = Math.sqrt(c.distSq) - 0.5 * Math.sqrt(minThreatDistSq)
    if (exposed < bestExposed || score < bestScore) {
      bestExposed = exposed
      bestScore = score
      bestCandidate = [c.wx, c.wy, c.wz]
    }
  }

  return bestCandidate
}

export function findPeekCover(
  nav: NavGrid,
  world: WorldData,
  scratch: RaycastScratch,
  pos: Vec3,
  targetPos: Vec3,
  otherThreats: Vec3[],
  radius: number,
  isSafe?: (x: number, y: number) => boolean,
  eyeHeight = 8,
): Vec3 | null {
  const threatCount = otherThreats.length
  if (threatCount === 0 || radius <= 0) return null

  const [cx, cy] = worldToGrid(nav, pos[0], pos[1])
  const startIdx = cy * nav.nx + cx
  const onRoof = pos[2] > nav.cellZ[startIdx] + 1.5

  const rCells = Math.max(1, Math.ceil(radius / nav.step))
  const rSq = radius * radius
  const innerRSq = 16 * 16

  const candidates: Array<{ wx: number; wy: number; wz: number; distSq: number }> = []
  const gx0 = Math.max(0, cx - rCells)
  const gx1 = Math.min(nav.nx - 1, cx + rCells)
  const gy0 = Math.max(0, cy - rCells)
  const gy1 = Math.min(nav.ny - 1, cy + rCells)

  for (let gy = gy0; gy <= gy1; gy++) {
    const wy = nav.minY + (gy + 0.5) * nav.step
    const dy = wy - pos[1]
    const dySq = dy * dy
    const row = gy * nav.nx
    const oddY = ((gy - cy) & 1) !== 0
    for (let gx = gx0; gx <= gx1; gx++) {
      const idx = row + gx
      let wz: number
      if (nav.cellBlocked[idx] === 1) {
        if (!onRoof) continue
        const roofZ = nav.cellRoofZ[idx]
        if (roofZ <= nav.cellZ[idx] + 1.5 || roofZ > pos[2] + 1.5 || pos[2] - roofZ > 4.5) {
          continue
        }
        wz = roofZ
      } else if (
        onRoof &&
        nav.cellRoofZ[idx] > nav.cellZ[idx] + 1.5 &&
        nav.cellRoofZ[idx] <= pos[2] + 1.5 &&
        pos[2] - nav.cellRoofZ[idx] <= 4.5
      ) {
        wz = nav.cellRoofZ[idx]
      } else {
        if (nav.cellSlope[idx] > nav.maxSlopeDeg) continue
        wz = nav.cellZ[idx]
      }

      const wx = nav.minX + (gx + 0.5) * nav.step
      const dx = wx - pos[0]
      const distSq = dx * dx + dySq
      if (distSq > rSq) continue
      if (distSq > innerRSq && (oddY || ((gx - cx) & 1) !== 0)) continue
      if (isSafe && !isSafe(wx, wy)) continue
      candidates.push({ wx, wy, wz, distSq })
    }
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.distSq - b.distSq)

  const maxToTest = Math.min(candidates.length, 160)
  const muzzleOffset = Math.max(6, eyeHeight - 1)
  const targetCenter: Vec3 = [targetPos[0], targetPos[1], targetPos[2] + 4.5]
  const candMuzzle: Vec3 = [0, 0, 0]
  const candEye: Vec3 = [0, 0, 0]
  const threatEye: Vec3 = [0, 0, 0]

  let bestCandidate: Vec3 | null = null
  let bestExposed = threatCount
  let bestScore = Infinity

  for (let i = 0; i < maxToTest; i++) {
    const c = candidates[i]
    candMuzzle[0] = c.wx
    candMuzzle[1] = c.wy
    candMuzzle[2] = c.wz + muzzleOffset

    if (!hasShotLOS(world, scratch, candMuzzle, targetCenter)) {
      continue
    }

    candEye[0] = c.wx
    candEye[1] = c.wy
    candEye[2] = c.wz + eyeHeight

    let exposed = 0
    let minThreatDistSq = Infinity

    for (let t = 0; t < threatCount; t++) {
      const th = otherThreats[t]
      const tdx = c.wx - th[0]
      const tdy = c.wy - th[1]
      const tDistSq = tdx * tdx + tdy * tdy
      if (tDistSq < minThreatDistSq) minThreatDistSq = tDistSq

      threatEye[0] = th[0]
      threatEye[1] = th[1]
      threatEye[2] = th[2] + eyeHeight
      if (hasShotLOS(world, scratch, threatEye, candEye)) {
        exposed++
        if (exposed > bestExposed || exposed >= threatCount) break
      }
    }

    if (exposed > bestExposed || exposed >= threatCount) continue

    const score = Math.sqrt(c.distSq) - 0.5 * Math.sqrt(minThreatDistSq)
    if (exposed < bestExposed || score < bestScore) {
      bestExposed = exposed
      bestScore = score
      bestCandidate = [c.wx, c.wy, c.wz]
    }
  }

  return bestCandidate
}
