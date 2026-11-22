import * as fs from "node:fs"
import * as path from "node:path"

export interface Prism {
  kind: string
  base: number
  top: number
  /** Flat [x0, y0, x1, y1, ...] */
  ring: Float64Array
  holes: Float64Array[]
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface TreeStore {
  count: number
  x: Float64Array
  y: Float64Array
  z: Float64Array
  height: Float64Array
  crownR: Float64Array
  crownBase: Float64Array
  trunkR: Float64Array
  crownX: Float64Array
  crownY: Float64Array
}

export interface TerrainGrid {
  minX: number
  minY: number
  step: number
  nx: number
  ny: number
  scale: number
  data: Int16Array
}

export interface SpatialHash {
  minX: number
  minY: number
  cellSize: number
  nx: number
  ny: number
  /** CSR offsets into prismIndices, length = nx * ny + 1 */
  prismOffsets: Int32Array
  prismIndices: Int32Array
  /** CSR offsets into treeIndices, length = nx * ny + 1 */
  treeOffsets: Int32Array
  treeIndices: Int32Array
}

export interface WorldRules {
  maxStep: number
  maxSlopeDeg: number
  canopyDensity: number
  canopyBlockT: number
}

export interface WorldBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface WorldData {
  bounds: WorldBounds
  rules: WorldRules
  terrain: TerrainGrid
  prisms: Prism[]
  trees: TreeStore
  hash: SpatialHash
}

interface RawWorldJson {
  bounds?: Partial<WorldBounds>
  rules?: Partial<WorldRules>
  terrain: {
    file?: string
    minX: number
    minY: number
    step: number
    nx: number
    ny: number
    scale?: number
  }
  prisms?: Array<{
    kind?: string
    base: number
    top: number
    ring: number[]
    holes?: number[][]
  }>
  trees?: {
    fields: string[]
    data: number[]
  }
}

const CELL_SIZE = 16

function computeRingBounds(ring: Float64Array): [number, number, number, number] {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < ring.length; i += 2) {
    const x = ring[i]
    const y = ring[i + 1]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return [minX, maxX, minY, maxY]
}

function loadTerrain(v2Dir: string, meta: RawWorldJson["terrain"]): TerrainGrid {
  const fileName = meta.file ?? "terrain.i16"
  const buf = fs.readFileSync(path.join(v2Dir, fileName))
  const expectedCount = meta.nx * meta.ny
  let data: Int16Array

  // Fast zero-copy path on little-endian hosts when buffer is 2-byte aligned.
  const isLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1
  if (isLittleEndian && buf.byteOffset % 2 === 0 && buf.byteLength >= expectedCount * 2) {
    data = new Int16Array(buf.buffer, buf.byteOffset, expectedCount)
  } else {
    data = new Int16Array(expectedCount)
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    for (let i = 0; i < expectedCount; i++) {
      data[i] = view.getInt16(i * 2, true)
    }
  }

  return {
    minX: meta.minX,
    minY: meta.minY,
    step: meta.step,
    nx: meta.nx,
    ny: meta.ny,
    scale: meta.scale ?? 0.01,
    data,
  }
}

function loadPrisms(rawPrisms: RawWorldJson["prisms"]): Prism[] {
  if (!rawPrisms || rawPrisms.length === 0) return []
  const prisms: Prism[] = new Array(rawPrisms.length)
  for (let i = 0; i < rawPrisms.length; i++) {
    const rp = rawPrisms[i]
    const ring = Float64Array.from(rp.ring)
    const [minX, maxX, minY, maxY] = computeRingBounds(ring)
    const holes = (rp.holes ?? []).map((h) => Float64Array.from(h))
    prisms[i] = {
      kind: rp.kind ?? "building",
      base: rp.base,
      top: rp.top,
      ring,
      holes,
      minX,
      maxX,
      minY,
      maxY,
    }
  }
  return prisms
}

function loadTrees(rawTrees: RawWorldJson["trees"]): TreeStore {
  if (!rawTrees || !rawTrees.fields.length || !rawTrees.data.length) {
    const empty = new Float64Array(0)
    return {
      count: 0,
      x: empty,
      y: empty,
      z: empty,
      height: empty,
      crownR: empty,
      crownBase: empty,
      trunkR: empty,
      crownX: empty,
      crownY: empty,
    }
  }

  const fields = rawTrees.fields
  const stride = fields.length
  const data = rawTrees.data
  const count = Math.floor(data.length / stride)

  const iX = fields.indexOf("x")
  const iY = fields.indexOf("y")
  const iZ = fields.indexOf("z")
  const iH = fields.indexOf("height")
  const iCR = fields.indexOf("crownR")
  const iCB = fields.indexOf("crownBase")
  const iTR = fields.indexOf("trunkR")
  const iCX = fields.indexOf("crownX")
  const iCY = fields.indexOf("crownY")

  const x = new Float64Array(count)
  const y = new Float64Array(count)
  const z = new Float64Array(count)
  const height = new Float64Array(count)
  const crownR = new Float64Array(count)
  const crownBase = new Float64Array(count)
  const trunkR = new Float64Array(count)
  const crownX = new Float64Array(count)
  const crownY = new Float64Array(count)

  for (let t = 0; t < count; t++) {
    const b = t * stride
    const tx = iX >= 0 ? data[b + iX] : 0
    const ty = iY >= 0 ? data[b + iY] : 0
    x[t] = tx
    y[t] = ty
    z[t] = iZ >= 0 ? data[b + iZ] : 0
    height[t] = iH >= 0 ? data[b + iH] : 0
    crownR[t] = iCR >= 0 ? data[b + iCR] : 0
    crownBase[t] = iCB >= 0 ? data[b + iCB] : 0
    trunkR[t] = iTR >= 0 ? data[b + iTR] : 0.5
    crownX[t] = iCX >= 0 ? data[b + iCX] : tx
    crownY[t] = iCY >= 0 ? data[b + iCY] : ty
  }

  return { count, x, y, z, height, crownR, crownBase, trunkR, crownX, crownY }
}

function buildSpatialHash(
  bounds: WorldBounds,
  prisms: Prism[],
  trees: TreeStore,
): SpatialHash {
  const minX = Math.floor(bounds.minX) - 16
  const minY = Math.floor(bounds.minY) - 16
  const maxX = Math.ceil(bounds.maxX) + 16
  const maxY = Math.ceil(bounds.maxY) + 16
  const nx = Math.max(1, Math.ceil((maxX - minX) / CELL_SIZE))
  const ny = Math.max(1, Math.ceil((maxY - minY) / CELL_SIZE))
  const totalCells = nx * ny
  const invCell = 1 / CELL_SIZE

  // Build prism CSR
  const prismCounts = new Int32Array(totalCells)
  for (let i = 0; i < prisms.length; i++) {
    const p = prisms[i]
    const cx0 = Math.max(0, Math.floor((p.minX - minX) * invCell))
    const cy0 = Math.max(0, Math.floor((p.minY - minY) * invCell))
    const cx1 = Math.min(nx - 1, Math.floor((p.maxX - minX) * invCell))
    const cy1 = Math.min(ny - 1, Math.floor((p.maxY - minY) * invCell))
    for (let cy = cy0; cy <= cy1; cy++) {
      const row = cy * nx
      for (let cx = cx0; cx <= cx1; cx++) {
        prismCounts[row + cx]++
      }
    }
  }

  const prismOffsets = new Int32Array(totalCells + 1)
  for (let c = 0; c < totalCells; c++) {
    prismOffsets[c + 1] = prismOffsets[c] + prismCounts[c]
  }
  const prismIndices = new Int32Array(prismOffsets[totalCells])
  const prismCursor = new Int32Array(prismOffsets)
  for (let i = 0; i < prisms.length; i++) {
    const p = prisms[i]
    const cx0 = Math.max(0, Math.floor((p.minX - minX) * invCell))
    const cy0 = Math.max(0, Math.floor((p.minY - minY) * invCell))
    const cx1 = Math.min(nx - 1, Math.floor((p.maxX - minX) * invCell))
    const cy1 = Math.min(ny - 1, Math.floor((p.maxY - minY) * invCell))
    for (let cy = cy0; cy <= cy1; cy++) {
      const row = cy * nx
      for (let cx = cx0; cx <= cx1; cx++) {
        const cell = row + cx
        prismIndices[prismCursor[cell]++] = i
      }
    }
  }

  // Build tree CSR
  const treeCounts = new Int32Array(totalCells)
  for (let i = 0; i < trees.count; i++) {
    const r = Math.max(trees.crownR[i], trees.trunkR[i])
    const tMinX = Math.min(trees.x[i] - trees.trunkR[i], trees.crownX[i] - r)
    const tMaxX = Math.max(trees.x[i] + trees.trunkR[i], trees.crownX[i] + r)
    const tMinY = Math.min(trees.y[i] - trees.trunkR[i], trees.crownY[i] - r)
    const tMaxY = Math.max(trees.y[i] + trees.trunkR[i], trees.crownY[i] + r)

    const cx0 = Math.max(0, Math.floor((tMinX - minX) * invCell))
    const cy0 = Math.max(0, Math.floor((tMinY - minY) * invCell))
    const cx1 = Math.min(nx - 1, Math.floor((tMaxX - minX) * invCell))
    const cy1 = Math.min(ny - 1, Math.floor((tMaxY - minY) * invCell))
    for (let cy = cy0; cy <= cy1; cy++) {
      const row = cy * nx
      for (let cx = cx0; cx <= cx1; cx++) {
        treeCounts[row + cx]++
      }
    }
  }

  const treeOffsets = new Int32Array(totalCells + 1)
  for (let c = 0; c < totalCells; c++) {
    treeOffsets[c + 1] = treeOffsets[c] + treeCounts[c]
  }
  const treeIndices = new Int32Array(treeOffsets[totalCells])
  const treeCursor = new Int32Array(treeOffsets)
  for (let i = 0; i < trees.count; i++) {
    const r = Math.max(trees.crownR[i], trees.trunkR[i])
    const tMinX = Math.min(trees.x[i] - trees.trunkR[i], trees.crownX[i] - r)
    const tMaxX = Math.max(trees.x[i] + trees.trunkR[i], trees.crownX[i] + r)
    const tMinY = Math.min(trees.y[i] - trees.trunkR[i], trees.crownY[i] - r)
    const tMaxY = Math.max(trees.y[i] + trees.trunkR[i], trees.crownY[i] + r)

    const cx0 = Math.max(0, Math.floor((tMinX - minX) * invCell))
    const cy0 = Math.max(0, Math.floor((tMinY - minY) * invCell))
    const cx1 = Math.min(nx - 1, Math.floor((tMaxX - minX) * invCell))
    const cy1 = Math.min(ny - 1, Math.floor((tMaxY - minY) * invCell))
    for (let cy = cy0; cy <= cy1; cy++) {
      const row = cy * nx
      for (let cx = cx0; cx <= cx1; cx++) {
        const cell = row + cx
        treeIndices[treeCursor[cell]++] = i
      }
    }
  }

  return {
    minX,
    minY,
    cellSize: CELL_SIZE,
    nx,
    ny,
    prismOffsets,
    prismIndices,
    treeOffsets,
    treeIndices,
  }
}

export function loadWorldData(mapDir: string): WorldData {
  const v2Dir = path.join(mapDir, "v2")
  const rawJson = fs.readFileSync(path.join(v2Dir, "world.json"), "utf8")
  const raw: RawWorldJson = JSON.parse(rawJson)

  const terrain = loadTerrain(v2Dir, raw.terrain)
  const prisms = loadPrisms(raw.prisms)
  const trees = loadTrees(raw.trees)

  const bounds: WorldBounds = {
    minX: raw.bounds?.minX ?? terrain.minX,
    maxX: raw.bounds?.maxX ?? terrain.minX + (terrain.nx - 1) * terrain.step,
    minY: raw.bounds?.minY ?? terrain.minY,
    maxY: raw.bounds?.maxY ?? terrain.minY + (terrain.ny - 1) * terrain.step,
  }

  const rules: WorldRules = {
    maxStep: raw.rules?.maxStep ?? 1.5,
    maxSlopeDeg: raw.rules?.maxSlopeDeg ?? 50,
    canopyDensity: raw.rules?.canopyDensity ?? 0.35,
    canopyBlockT: raw.rules?.canopyBlockT ?? 0.25,
  }

  const hash = buildSpatialHash(bounds, prisms, trees)
  return { bounds, rules, terrain, prisms, trees, hash }
}
