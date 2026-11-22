import type { Vec2, Vec3 } from "../contracts.ts"
import type { WorldData } from "./loader.ts"
import {
  hasShotLOS,
  heightAt,
  pointInPrismXY,
  slopeAt,
  type RaycastScratch,
} from "./raycast.ts"

const NAV_STEP = 4
const MAX_EXPANSIONS = 2500
const HEAP_CAP = 32768
const MAX_BFS_RADIUS = 40
const MAX_BFS_CELLS = 320

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

export interface RooftopSpot {
  x: number
  y: number
  z: number
  relH: number
  areaCells: number
  edgeDist: number
  hasPenthouse: boolean
}

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
  rooftops: RooftopSpot[]
  // Preallocated A* scratch
  gScore: Float32Array
  nodeZ: Float32Array
  parent: Int32Array
  openStamp: Int32Array
  closedStamp: Int32Array
  heapNode: Int32Array
  heapF: Float32Array
  stamp: number
  // Preallocated Local BFS scratch
  bfsDist: Float32Array
  bfsZ: Float32Array
  bfsOpenStamp: Int32Array
  bfsClosedStamp: Int32Array
  bfsVisited: Int32Array
  bfsStamp: number
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
  z: number,
): boolean {
  const { hash, prisms } = world
  const cx0 = Math.max(0, Math.floor((wx - 2.5 - hash.minX) / hash.cellSize))
  const cx1 = Math.min(hash.nx - 1, Math.floor((wx + 2.5 - hash.minX) / hash.cellSize))
  const cy0 = Math.max(0, Math.floor((wy - 2.5 - hash.minY) / hash.cellSize))
  const cy1 = Math.min(hash.ny - 1, Math.floor((wy + 2.5 - hash.minY) / hash.cellSize))
  const maxReachable = z + 1.2
  const maxBase = z + 9.0

  for (let cy = cy0; cy <= cy1; cy++) {
    const hRow = cy * hash.nx
    for (let cx = cx0; cx <= cx1; cx++) {
      const hCell = hRow + cx
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

function buildRooftopCatalog(
  world: WorldData,
  minX: number,
  minY: number,
  nx: number,
  ny: number,
  cellZ: Float32Array,
  cellRoofZ: Float32Array,
): RooftopSpot[] {
  const total = nx * ny
  const isRoof = new Uint8Array(total)
  let roofCount = 0

  for (let i = 0; i < total; i++) {
    const relH = cellRoofZ[i] - cellZ[i]
    if (relH >= 8 && relH <= 28) {
      isRoof[i] = 1
      roofCount++
    }
  }
  if (roofCount < 25) return []

  const compId = new Int32Array(total)
  compId.fill(-1)
  const queue = new Int32Array(total)
  const compSize: number[] = []

  // Connected roof components (4-connected, delta Z <= 1.5m)
  for (let i = 0; i < total; i++) {
    if (isRoof[i] === 0 || compId[i] !== -1) continue
    const cid = compSize.length
    let head = 0
    let tail = 0
    compId[i] = cid
    queue[tail++] = i

    while (head < tail) {
      const u = queue[head++]
      const ux = u % nx
      const uy = (u / nx) | 0
      const zU = cellRoofZ[u]

      for (let d = 0; d < 4; d++) {
        const vx = ux + DX[d]
        const vy = uy + DY[d]
        if (vx < 0 || vx >= nx || vy < 0 || vy >= ny) continue
        const v = vy * nx + vx
        if (isRoof[v] === 0 || compId[v] !== -1) continue
        if (Math.abs(cellRoofZ[v] - zU) <= 1.5) {
          compId[v] = cid
          queue[tail++] = v
        }
      }
    }
    compSize.push(tail)
  }

  // Multi-source BFS for roofEdgeDist (distance to roof drop-off / courtyard hole)
  const roofEdgeDist = new Uint8Array(total)
  let head = 0
  let tail = 0

  for (let i = 0; i < total; i++) {
    const cid = compId[i]
    if (cid < 0 || compSize[cid] < 25) continue
    const ux = i % nx
    const uy = (i / nx) | 0
    const zU = cellRoofZ[i]

    let isEdge = false
    for (let d = 0; d < 8; d++) {
      const vx = ux + DX[d]
      const vy = uy + DY[d]
      if (vx < 0 || vx >= nx || vy < 0 || vy >= ny) {
        isEdge = true
        break
      }
      const v = vy * nx + vx
      if (cellRoofZ[v] < zU - 1.5) {
        isEdge = true
        break
      }
    }

    if (isEdge) {
      roofEdgeDist[i] = 1
      queue[tail++] = i
    } else {
      roofEdgeDist[i] = 255
    }
  }

  while (head < tail) {
    const u = queue[head++]
    const nextD = roofEdgeDist[u] + 1
    if (nextD > 12) continue
    const ux = u % nx
    const uy = (u / nx) | 0
    const cid = compId[u]

    for (let d = 0; d < 4; d++) {
      const vx = ux + DX[d]
      const vy = uy + DY[d]
      if (vx < 0 || vx >= nx || vy < 0 || vy >= ny) continue
      const v = vy * nx + vx
      if (compId[v] === cid && roofEdgeDist[v] > nextD) {
        roofEdgeDist[v] = nextD
        queue[tail++] = v
      }
    }
  }

  const rooftops: RooftopSpot[] = []
  const compAdded = new Uint8Array(compSize.length)
  const compFallbackIdx = new Int32Array(compSize.length)
  compFallbackIdx.fill(-1)
  const compFallbackDist = new Uint8Array(compSize.length)

  for (let gy = 0; gy < ny; gy++) {
    const wy = minY + (gy + 0.5) * NAV_STEP
    const row = gy * nx
    for (let gx = 0; gx < nx; gx++) {
      const idx = row + gx
      const cid = compId[idx]
      if (cid < 0 || compSize[cid] < 25) continue
      let edgeD = roofEdgeDist[idx]
      if (edgeD < 2) continue
      if (edgeD === 255) edgeD = 12

      const roofZ = cellRoofZ[idx]
      const wx = minX + (gx + 0.5) * NAV_STEP

      // Check for adjacent penthouse (taller prism by >= 4.5m within 2 cells)
      let hasPenthouse = false
      const y0 = Math.max(0, gy - 2)
      const y1 = Math.min(ny - 1, gy + 2)
      const x0 = Math.max(0, gx - 2)
      const x1 = Math.min(nx - 1, gx + 2)
      for (let py = y0; py <= y1 && !hasPenthouse; py++) {
        const pRow = py * nx
        for (let px = x0; px <= x1; px++) {
          if (cellRoofZ[pRow + px] >= roofZ + 4.5) {
            hasPenthouse = true
            break
          }
        }
      }

      const strideKeep = (gx & 1) === 0 && (gy & 1) === 0
      if (!hasPenthouse && !strideKeep) {
        if (edgeD > compFallbackDist[cid]) {
          compFallbackDist[cid] = edgeD
          compFallbackIdx[cid] = idx
        }
        continue
      }

      if (hasBlockingPrismWithin(world, wx, wy, roofZ)) continue

      rooftops.push({
        x: wx,
        y: wy,
        z: roofZ,
        relH: roofZ - cellZ[idx],
        areaCells: compSize[cid],
        edgeDist: edgeD,
        hasPenthouse,
      })
      compAdded[cid] = 1
    }
  }

  // Ensure every qualifying roof component with edgeDist >= 2 has at least one catalog entry
  for (let cid = 0; cid < compSize.length; cid++) {
    if (compAdded[cid] === 1 || compFallbackIdx[cid] < 0) continue
    const idx = compFallbackIdx[cid]
    const gx = idx % nx
    const gy = (idx / nx) | 0
    const wx = minX + (gx + 0.5) * NAV_STEP
    const wy = minY + (gy + 0.5) * NAV_STEP
    const roofZ = cellRoofZ[idx]
    if (hasBlockingPrismWithin(world, wx, wy, roofZ)) continue
    rooftops.push({
      x: wx,
      y: wy,
      z: roofZ,
      relH: roofZ - cellZ[idx],
      areaCells: compSize[cid],
      edgeDist: compFallbackDist[cid],
      hasPenthouse: false,
    })
  }

  return rooftops
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

  // Compute cellTight across ALL unblocked cells (2.5m prism clearance) and cellNearCover (within 8m)
  for (let gy = 0; gy < ny; gy++) {
    const wy = minY + (gy + 0.5) * NAV_STEP
    const row = gy * nx
    const y0 = Math.max(0, gy - 2)
    const y1 = Math.min(ny - 1, gy + 2)
    for (let gx = 0; gx < nx; gx++) {
      const idx = row + gx
      if (cellBlocked[idx]) {
        cellNearCover[idx] = 1
        cellTight[idx] = 1
        continue
      }

      const wx = minX + (gx + 0.5) * NAV_STEP
      if (hasBlockingPrismWithin(world, wx, wy, cellZ[idx])) {
        cellTight[idx] = 1
        cellNearCover[idx] = 1
        continue
      }

      let hasNearWall = 0
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

  const rooftops = buildRooftopCatalog(world, minX, minY, nx, ny, cellZ, cellRoofZ)

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
    rooftops,
    gScore: new Float32Array(total),
    nodeZ: new Float32Array(total),
    parent: new Int32Array(total),
    openStamp: new Int32Array(total),
    closedStamp: new Int32Array(total),
    heapNode: new Int32Array(HEAP_CAP),
    heapF: new Float32Array(HEAP_CAP),
    stamp: 0,
    bfsDist: new Float32Array(total),
    bfsZ: new Float32Array(total),
    bfsOpenStamp: new Int32Array(total),
    bfsClosedStamp: new Int32Array(total),
    bfsVisited: new Int32Array(MAX_BFS_CELLS + 16),
    bfsStamp: 0,
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

export function findPath(
  nav: NavGrid,
  from: Vec3,
  to: Vec3,
  canJetOrMaxClimb: boolean | number,
  wantRoof = false,
): Vec3[] {
  const maxClimb =
    typeof canJetOrMaxClimb === "number" ? canJetOrMaxClimb : canJetOrMaxClimb ? 25 : 0
  const canJet = maxClimb > 1.5

  const [sx, sy] = worldToGrid(nav, from[0], from[1])
  const [tx, ty] = worldToGrid(nav, to[0], to[1])
  const startIdx = sy * nav.nx + sx
  const targetIdx = ty * nav.nx + tx

  if (sx === tx && sy === ty) {
    const roofZ = nav.cellRoofZ[targetIdx]
    const baseZ = nav.cellZ[targetIdx]
    const keepRoof =
      from[2] > baseZ + 1.5 && roofZ > baseZ + 1.5 && to[2] < roofZ - 1.5
    return [[to[0], to[1], keepRoof ? roofZ : to[2]]]
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
  let heapSize = heapPush(heapNode, heapF, 0, startIdx, 1.15 * startH)

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

      // Always block ground-to-ground diagonal corner cuts across cellBlocked regardless of canJet
      if (d >= 4 && !canWalkElevatedV) {
        const c1 = uy * nx + vx
        const c2 = vy * nx + ux
        if (!blockedV) {
          if (cellBlocked[c1] || cellBlocked[c2]) continue
        } else if (
          (cellBlocked[c1] && cellRoofZ[c1] > roofV + 1.5) ||
          (cellBlocked[c2] && cellRoofZ[c2] > roofV + 1.5)
        ) {
          continue
        }
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

      const climbToRoofV = canJet && (blockedV || (wantRoof && hasRoofV && !canWalkElevatedV))
      const zV = canWalkElevatedV ? roofV : climbToRoofV ? roofV : cellZ[v]
      const dz = zV - zU

      if (canJet) {
        if (dz > maxClimb) continue
        const isJetClimb =
          climbToRoofV || slopeV > maxSlopeDeg || dz > 4.5 || (!onElevatedU && zV > cellZ[v] + 1.5)
        if (dz > 1.5 && isJetClimb) {
          extraCost += wantRoof ? dz * 1.5 : dz * 3.5 + 35
        }
      } else if (dz > 4.5 && u !== startIdx) {
        continue
      }

      if (cellNearCover[v] === 0) {
        extraCost += STEP_DIST[d] * 0.25
      }
      if (!blockedV && !canWalkElevatedV && cellTight[v] === 1) {
        extraCost += 12.0
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
        heapSize = heapPush(heapNode, heapF, heapSize, v, tentativeG + 1.15 * h)
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
    // Do not overwrite A* roof Z if to[2] was ground Z inside a roof footprint
    const targetNodeZ = nodeZ[targetIdx]
    const finalZ =
      targetNodeZ > cellZ[targetIdx] + 1.5 && to[2] < targetNodeZ - 1.5
        ? targetNodeZ
        : to[2]
    rev[rev.length - 1] = [to[0], to[1], finalZ]
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

function runLocalBfs(
  nav: NavGrid,
  pos: Vec3,
  radius: number,
): { count: number; onRoof: boolean; startZ: number } {
  const effRadius = Math.min(Math.max(0, radius), MAX_BFS_RADIUS)
  const [sx, sy] = worldToGrid(nav, pos[0], pos[1])
  const {
    nx,
    ny,
    maxSlopeDeg,
    cellZ,
    cellRoofZ,
    cellSlope,
    cellBlocked,
    bfsDist,
    bfsZ,
    bfsOpenStamp,
    bfsClosedStamp,
    bfsVisited,
    heapNode,
    heapF,
  } = nav

  const startIdx = sy * nx + sx
  const terrainZ = cellZ[startIdx]
  const onRoof = pos[2] > terrainZ + 2.0
  const startZ = onRoof
    ? cellRoofZ[startIdx] > terrainZ + 1.5 && Math.abs(cellRoofZ[startIdx] - pos[2]) <= 3.0
      ? cellRoofZ[startIdx]
      : pos[2]
    : terrainZ

  nav.bfsStamp++
  if (nav.bfsStamp >= 0x7fffffff) {
    bfsOpenStamp.fill(0)
    bfsClosedStamp.fill(0)
    nav.bfsStamp = 1
  }
  const stamp = nav.bfsStamp

  let seedIdx = startIdx
  let seedDist = 0
  let seedZ = startZ
  if (!onRoof && cellBlocked[startIdx] === 1) {
    const maxRing = Math.min(6, Math.ceil(effRadius / nav.step))
    let bestSeed = -1
    let bestDistSq = Infinity
    for (let r = 1; r <= maxRing && bestSeed === -1; r++) {
      const x0 = Math.max(0, sx - r)
      const x1 = Math.min(nx - 1, sx + r)
      const y0 = Math.max(0, sy - r)
      const y1 = Math.min(ny - 1, sy + r)
      for (let gy = y0; gy <= y1; gy++) {
        const row = gy * nx
        for (let gx = x0; gx <= x1; gx++) {
          if (Math.abs(gx - sx) !== r && Math.abs(gy - sy) !== r) continue
          const cand = row + gx
          if (cellBlocked[cand] === 0 && cellSlope[cand] <= maxSlopeDeg) {
            const ddx = gx - sx
            const ddy = gy - sy
            const dSq = ddx * ddx + ddy * ddy
            if (dSq < bestDistSq) {
              bestDistSq = dSq
              bestSeed = cand
            }
          }
        }
      }
    }
    if (bestSeed !== -1) {
      seedIdx = bestSeed
      seedDist = Math.sqrt(bestDistSq) * nav.step
      seedZ = cellZ[bestSeed]
    }
  }

  bfsDist[seedIdx] = seedDist
  bfsZ[seedIdx] = seedZ
  bfsOpenStamp[seedIdx] = stamp
  let heapSize = heapPush(heapNode, heapF, 0, seedIdx, seedDist)
  let count = 0

  while (heapSize > 0 && count < MAX_BFS_CELLS) {
    const [u, nextSize] = heapPop(heapNode, heapF, heapSize)
    heapSize = nextSize
    if (bfsClosedStamp[u] === stamp) continue
    bfsClosedStamp[u] = stamp

    const distU = bfsDist[u]
    if (distU > effRadius) break

    bfsVisited[count++] = u
    const ux = u % nx
    const uy = (u / nx) | 0
    const zU = bfsZ[u]

    for (let d = 0; d < 8; d++) {
      const vx = ux + DX[d]
      const vy = uy + DY[d]
      if (vx < 0 || vx >= nx || vy < 0 || vy >= ny) continue
      const v = vy * nx + vx
      if (bfsClosedStamp[v] === stamp) continue

      let zV: number
      if (onRoof) {
        const roofV = cellRoofZ[v]
        if (roofV <= cellZ[v] + 1.5 || Math.abs(roofV - zU) > 1.5) continue
        if (d >= 4) {
          const c1 = uy * nx + vx
          const c2 = vy * nx + ux
          if (cellRoofZ[c1] <= cellZ[c1] + 1.5 || Math.abs(cellRoofZ[c1] - zU) > 1.5) continue
          if (cellRoofZ[c2] <= cellZ[c2] + 1.5 || Math.abs(cellRoofZ[c2] - zU) > 1.5) continue
        }
        zV = roofV
      } else {
        if (cellBlocked[v] === 1) continue
        if (cellSlope[v] > maxSlopeDeg) continue
        if (d >= 4) {
          if (cellBlocked[uy * nx + vx] === 1 || cellBlocked[vy * nx + ux] === 1) continue
        }
        zV = cellZ[v]
        if (u !== seedIdx && Math.abs(zV - zU) > 4.5) continue
      }

      const nd = distU + STEP_DIST[d]
      if (nd > effRadius) continue

      if (bfsOpenStamp[v] !== stamp || nd < bfsDist[v]) {
        bfsOpenStamp[v] = stamp
        bfsDist[v] = nd
        bfsZ[v] = zV
        heapSize = heapPush(heapNode, heapF, heapSize, v, nd)
      }
    }
  }

  return { count, onRoof, startZ }
}

function isExposedToThreat(
  world: WorldData,
  scratch: RaycastScratch,
  wx: number,
  wy: number,
  wz: number,
  th: Vec3,
  eyeHeight: number,
  shoulderOff: number,
  threatEye: Vec3,
  candEye: Vec3,
): boolean {
  threatEye[0] = th[0]
  threatEye[1] = th[1]
  threatEye[2] = th[2] + eyeHeight

  candEye[0] = wx
  candEye[1] = wy
  candEye[2] = wz + eyeHeight
  if (hasShotLOS(world, scratch, threatEye, candEye)) return true

  if (shoulderOff > 0.1) {
    const tdx = wx - th[0]
    const tdy = wy - th[1]
    const tDist = Math.hypot(tdx, tdy)
    if (tDist > 1e-3) {
      const px = (-tdy / tDist) * shoulderOff
      const py = (tdx / tDist) * shoulderOff

      candEye[0] = wx + px
      candEye[1] = wy + py
      if (hasShotLOS(world, scratch, threatEye, candEye)) return true

      candEye[0] = wx - px
      candEye[1] = wy - py
      if (hasShotLOS(world, scratch, threatEye, candEye)) return true
    }
  }
  return false
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
  prevCover?: Vec3 | null,
  mechRadius = 2.5,
): Vec3 | null {
  const threatCount = threats.length
  if (threatCount === 0 || radius <= 0) return null

  const { count, onRoof, startZ } = runLocalBfs(nav, pos, radius)
  if (count === 0) return null

  const shoulderOff = Math.max(0, mechRadius - 0.6)
  const candEye: Vec3 = [0, 0, 0]
  const threatEye: Vec3 = [0, 0, 0]
  const { nx, minX, minY, step, maxSlopeDeg, cellZ, cellRoofZ, cellSlope, cellBlocked, cellTight, bfsVisited, bfsDist, bfsZ } = nav

  const evalPass = (allowTight: boolean): Vec3 | null => {
    let bestCandidate: Vec3 | null = null
    let bestExposed = threatCount
    let bestScore = Infinity
    let tested = 0
    const maxToTest = allowTight ? 80 : 180

    for (let i = 0; i < count && tested < maxToTest; i++) {
      const idx = bfsVisited[i]
      if (onRoof) {
        if (cellRoofZ[idx] <= cellZ[idx] + 1.5 || Math.abs(cellRoofZ[idx] - startZ) > 3.0) {
          continue
        }
      } else {
        if (cellBlocked[idx] === 1 || cellSlope[idx] > maxSlopeDeg) continue
        const isTight = cellTight[idx] === 1
        if (allowTight !== isTight) continue
      }

      const gx = idx % nx
      const gy = (idx / nx) | 0
      const wx = minX + (gx + 0.5) * step
      const wy = minY + (gy + 0.5) * step
      if (isSafe && !isSafe(wx, wy)) continue

      const wz = bfsZ[idx]
      const pathDist = bfsDist[idx]
      tested++

      let exposed = 0
      let minThreatDistSq = Infinity

      for (let t = 0; t < threatCount; t++) {
        const th = threats[t]
        const tdx = wx - th[0]
        const tdy = wy - th[1]
        const tDistSq = tdx * tdx + tdy * tdy
        if (tDistSq < minThreatDistSq) minThreatDistSq = tDistSq

        if (
          isExposedToThreat(
            world,
            scratch,
            wx,
            wy,
            wz,
            th,
            eyeHeight,
            shoulderOff,
            threatEye,
            candEye,
          )
        ) {
          exposed++
          if (exposed > bestExposed || exposed >= threatCount) break
        }
      }

      if (exposed >= threatCount || exposed > bestExposed) continue

      let score = pathDist - 0.5 * Math.sqrt(minThreatDistSq)
      if (prevCover != null) {
        const pdx = wx - prevCover[0]
        const pdy = wy - prevCover[1]
        if (pdx * pdx + pdy * pdy <= 9) {
          score -= 10
        }
      }

      if (exposed < bestExposed || score < bestScore) {
        bestExposed = exposed
        bestScore = score
        bestCandidate = [wx, wy, wz]
      }
    }

    return bestCandidate
  }

  const primary = evalPass(false)
  if (primary !== null || onRoof) return primary
  return evalPass(true)
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
  prevCover?: Vec3 | null,
  mechRadius = 2.5,
): Vec3 | null {
  const threatCount = otherThreats.length
  if (threatCount === 0 || radius <= 0) return null

  const { count, onRoof, startZ } = runLocalBfs(nav, pos, radius)
  if (count === 0) return null

  const shoulderOff = Math.max(0, mechRadius - 0.6)
  const muzzleOffset = Math.max(6, eyeHeight - 1)
  const targetCenter: Vec3 = [targetPos[0], targetPos[1], targetPos[2] + 4.5]
  const candMuzzle: Vec3 = [0, 0, 0]
  const candEye: Vec3 = [0, 0, 0]
  const threatEye: Vec3 = [0, 0, 0]
  const {
    nx,
    minX,
    minY,
    step,
    maxSlopeDeg,
    cellZ,
    cellRoofZ,
    cellSlope,
    cellBlocked,
    cellNearCover,
    cellTight,
    bfsVisited,
    bfsDist,
    bfsZ,
  } = nav

  const evalPass = (allowTight: boolean): Vec3 | null => {
    let bestCandidate: Vec3 | null = null
    let bestExposed = threatCount
    let bestScore = Infinity
    let tested = 0
    const maxToTest = allowTight ? 80 : 180

    for (let i = 0; i < count && tested < maxToTest; i++) {
      const idx = bfsVisited[i]
      if (onRoof) {
        if (cellRoofZ[idx] <= cellZ[idx] + 1.5 || Math.abs(cellRoofZ[idx] - startZ) > 3.0) {
          continue
        }
      } else {
        if (cellBlocked[idx] === 1 || cellSlope[idx] > maxSlopeDeg) continue
        const isTight = cellTight[idx] === 1
        if (allowTight !== isTight) continue
      }

      const gx = idx % nx
      const gy = (idx / nx) | 0
      const wx = minX + (gx + 0.5) * step
      const wy = minY + (gy + 0.5) * step
      if (isSafe && !isSafe(wx, wy)) continue

      const wz = bfsZ[idx]
      const pathDist = bfsDist[idx]
      tested++

      candMuzzle[0] = wx
      candMuzzle[1] = wy
      candMuzzle[2] = wz + muzzleOffset
      if (!hasShotLOS(world, scratch, candMuzzle, targetCenter)) {
        continue
      }

      let exposed = 0
      let minThreatDistSq = Infinity

      for (let t = 0; t < threatCount; t++) {
        const th = otherThreats[t]
        const tdx = wx - th[0]
        const tdy = wy - th[1]
        const tDistSq = tdx * tdx + tdy * tdy
        if (tDistSq < minThreatDistSq) minThreatDistSq = tDistSq

        if (
          isExposedToThreat(
            world,
            scratch,
            wx,
            wy,
            wz,
            th,
            eyeHeight,
            shoulderOff,
            threatEye,
            candEye,
          )
        ) {
          exposed++
          if (exposed > bestExposed || exposed >= threatCount) break
        }
      }

      if (exposed >= threatCount || exposed > bestExposed) continue

      let score = pathDist - 0.5 * Math.sqrt(minThreatDistSq)
      if (cellNearCover[idx] === 1) {
        score -= 4
      }
      if (prevCover != null) {
        const pdx = wx - prevCover[0]
        const pdy = wy - prevCover[1]
        if (pdx * pdx + pdy * pdy <= 9) {
          score -= 10
        }
      }

      if (exposed < bestExposed || score < bestScore) {
        bestExposed = exposed
        bestScore = score
        bestCandidate = [wx, wy, wz]
      }
    }

    return bestCandidate
  }

  const primary = evalPass(false)
  if (primary !== null || onRoof) return primary
  return evalPass(true)
}

export function findRooftopSpot(
  nav: NavGrid,
  pos: Vec3,
  zoneCenter: Vec2,
  zoneRadius: number,
  maxDist: number,
  threats: Vec3[],
): Vec3 | null {
  const { rooftops } = nav
  if (rooftops.length === 0 || maxDist <= 0) return null

  const safeR = Math.max(0, zoneRadius - 12)
  const safeRSq = safeR * safeR
  const maxDistSq = maxDist * maxDist

  let best: RooftopSpot | null = null
  let bestScore = -Infinity

  for (let i = 0; i < rooftops.length; i++) {
    const r = rooftops[i]
    const dx = r.x - pos[0]
    const dy = r.y - pos[1]
    const distSq = dx * dx + dy * dy
    if (distSq > maxDistSq) continue

    const zdx = r.x - zoneCenter[0]
    const zdy = r.y - zoneCenter[1]
    const zDistSq = zdx * zdx + zdy * zdy
    if (zDistSq > safeRSq) continue

    // Height sweet spot: prefer 12-24m
    let score = 20
    if (r.relH < 12) {
      score -= (12 - r.relH) * 3.0
    } else if (r.relH > 24) {
      score -= (r.relH - 24) * 3.0
    }

    if (r.hasPenthouse) {
      score += 18
    }

    // Wide area & roof interior safety bonus
    score += Math.min(18, Math.sqrt(r.areaCells) * 1.8)
    score += Math.min(8, (r.edgeDist - 1) * 3.0)

    // Distance & zone centrality
    score -= Math.sqrt(distSq) * 0.25
    score -= Math.sqrt(zDistSq) * 0.08

    // Low threat density preference
    for (let t = 0; t < threats.length; t++) {
      const th = threats[t]
      const td = Math.hypot(r.x - th[0], r.y - th[1])
      if (td < 80) {
        score -= (80 - td) * 0.45
        if (td < 35) score -= 20
      }
    }

    if (score > bestScore) {
      bestScore = score
      best = r
    }
  }

  return best ? [best.x, best.y, best.z] : null
}
