import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { createWorld } from "../src/world/index.ts"
import { DEFAULT_CONFIG } from "../sim/arena_sim.ts"
import type { Vec2, Vec3, WorldQuery } from "../src/contracts.ts"

const ARENA_DIR = resolve("mechfight-kit/arena")

// --- Pure math helpers for gun intercept & mortar ballistics ---

/**
 * Solve quadratic intercept time t > 0 for a constant-velocity target:
 * |pRel + vRel * t| = speed * t
 */
function solveGunIntercept(
  shooterPos: Vec3,
  targetPos: Vec3,
  targetVel: Vec3,
  projectileSpeed: number
): { t: number; aimPoint: Vec3; yaw: number; pitch: number } | null {
  const rx = targetPos[0] - shooterPos[0]
  const ry = targetPos[1] - shooterPos[1]
  const rz = targetPos[2] - shooterPos[2]

  const vx = targetVel[0]
  const vy = targetVel[1]
  const vz = targetVel[2]

  const a = vx * vx + vy * vy + vz * vz - projectileSpeed * projectileSpeed
  const b = 2 * (rx * vx + ry * vy + rz * vz)
  const c = rx * rx + ry * ry + rz * rz

  let t: number | null = null
  if (Math.abs(a) < 1e-8) {
    if (Math.abs(b) > 1e-8) {
      const tLin = -c / b
      if (tLin > 0) t = tLin
    }
  } else {
    const disc = b * b - 4 * a * c
    if (disc >= 0) {
      const sqrtDisc = Math.sqrt(disc)
      const t1 = (-b - sqrtDisc) / (2 * a)
      const t2 = (-b + sqrtDisc) / (2 * a)
      const candidates = [t1, t2].filter((x) => x > 0)
      if (candidates.length > 0) t = Math.min(...candidates)
    }
  }

  if (t === null || !Number.isFinite(t)) return null
  const aimPoint: Vec3 = [
    targetPos[0] + vx * t,
    targetPos[1] + vy * t,
    targetPos[2] + vz * t,
  ]
  const dx = aimPoint[0] - shooterPos[0]
  const dy = aimPoint[1] - shooterPos[1]
  const dz = aimPoint[2] - shooterPos[2]
  const horiz = Math.hypot(dx, dy)
  const yaw = Math.atan2(dy, dx)
  const pitch = Math.atan2(dz, horiz)
  return { t, aimPoint, yaw, pitch }
}

/**
 * Solve mortar launch pitch (low or high arc) for speed v, gravity g,
 * horizontal distance d, and vertical delta dz.
 */
function solveMortarPitch(
  d: number,
  dz: number,
  speed: number,
  gravity: number,
  highArc = false
): number | null {
  if (d < 1e-3) return dz >= 0 ? Math.PI / 2 : -Math.PI / 2
  const v2 = speed * speed
  const v4 = v2 * v2
  const disc = v4 - gravity * (gravity * d * d + 2 * dz * v2)
  if (disc < 0) return null
  const sqrtDisc = Math.sqrt(disc)
  const tanTheta = highArc ? (v2 + sqrtDisc) / (gravity * d) : (v2 - sqrtDisc) / (gravity * d)
  return Math.atan(tanTheta)
}

function deterministicRng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

// --- Tests ---

let cachedWorld: WorldQuery | null = null
function getWorld(): WorldQuery {
  if (!cachedWorld) {
    cachedWorld = createWorld(ARENA_DIR, DEFAULT_CONFIG)
  }
  return cachedWorld
}

test("WorldQuery loads mechfight-kit/arena and queries terrain height & slope", () => {
  const world = getWorld()

  // Map origin is ground elevation 0 in relative frame
  const hOrigin = world.heightAt(0, 0)
  assert.ok(Number.isFinite(hOrigin), `heightAt(0,0) should be finite, got ${hOrigin}`)
  assert.ok(Math.abs(hOrigin) < 15, `heightAt(0,0) should be near 0, got ${hOrigin}`)

  // Open Oval area should be relatively flat
  const hOval = world.heightAt(275, -100)
  const sOval = world.slopeAt(275, -100)
  assert.ok(Number.isFinite(hOval), "Oval height should be finite")
  assert.ok(Number.isFinite(sOval) && sOval >= 0 && sOval <= 90, `Slope out of range: ${sOval}`)
  assert.ok(sOval < 25, `Expected Oval slope < 25 deg, got ${sOval}`)
})

test("WorldQuery hasShotLOS distinguishes blocked building vs open Oval", () => {
  const world = getWorld()

  // Known building from v2/world.json: block 0, base -5.64, top 5.82,
  // x in [-139.5, -86.3], y in [-203.4, -184.5]
  const blockedA: Vec3 = [-150, -194, 2]
  const blockedB: Vec3 = [-75, -194, 2]
  assert.equal(
    world.hasShotLOS(blockedA, blockedB),
    false,
    "Shot through building block 0 should be blocked"
  )

  // Open Oval (no prisms within 35m of [250, -100] .. [300, -100])
  const zA = world.heightAt(250, -100) + 7
  const zB = world.heightAt(300, -100) + 7
  const openA: Vec3 = [250, -100, zA]
  const openB: Vec3 = [300, -100, zB]
  assert.equal(
    world.hasShotLOS(openA, openB),
    true,
    "Shot across open Oval should have clear LOS"
  )
})

test("WorldQuery findPath & findCover return valid results on real arena", () => {
  const world = getWorld()

  // Path across open Oval
  const from: Vec3 = [250, -100, world.heightAt(250, -100)]
  const to: Vec3 = [300, -70, world.heightAt(300, -70)]
  const path = world.findPath(from, to, true)
  assert.ok(Array.isArray(path) && path.length > 0, "findPath should return waypoints")
  const last = path[path.length - 1]
  assert.ok(
    Math.hypot(last[0] - to[0], last[1] - to[1]) < 12,
    `Path end (${last[0]}, ${last[1]}) should be near target (${to[0]}, ${to[1]})`
  )

  // Cover near building block 0 against a threat on the opposite side
  const posNearBuilding: Vec3 = [-78, -194, world.heightAt(-78, -194)]
  const threatOpposite: Vec3 = [-150, -194, world.heightAt(-150, -194) + 8]
  const cover = world.findCover(posNearBuilding, [threatOpposite], 35)
  if (cover !== null) {
    const dist = Math.hypot(cover[0] - posNearBuilding[0], cover[1] - posNearBuilding[1])
    assert.ok(dist <= 36, `Cover distance ${dist} exceeded search radius`)
    const coverCenter: Vec3 = [cover[0], cover[1], cover[2] + 4.5]
    assert.equal(
      world.hasShotLOS(threatOpposite, coverCenter),
      false,
      "Returned cover should block shot LOS from threat"
    )
  }
})

test("Gun intercept math accurately leads moving targets", () => {
  const gunSpeed = 252
  const shooter: Vec3 = [0, 0, 7]
  const targetStart: Vec3 = [80, 40, 4.5]
  const targetVel: Vec3 = [-10, 15, 0]

  const sol = solveGunIntercept(shooter, targetStart, targetVel, gunSpeed)
  assert.ok(sol !== null, "Intercept solution should exist")

  // Simulate bullet along solved yaw/pitch for sol.t seconds
  const vx = gunSpeed * Math.cos(sol.pitch) * Math.cos(sol.yaw)
  const vy = gunSpeed * Math.cos(sol.pitch) * Math.sin(sol.yaw)
  const vz = gunSpeed * Math.sin(sol.pitch)

  const bulletEnd: Vec3 = [
    shooter[0] + vx * sol.t,
    shooter[1] + vy * sol.t,
    shooter[2] + vz * sol.t,
  ]
  const targetEnd: Vec3 = [
    targetStart[0] + targetVel[0] * sol.t,
    targetStart[1] + targetVel[1] * sol.t,
    targetStart[2] + targetVel[2] * sol.t,
  ]

  const err = Math.hypot(
    bulletEnd[0] - targetEnd[0],
    bulletEnd[1] - targetEnd[1],
    bulletEnd[2] - targetEnd[2]
  )
  assert.ok(err < 1e-4, `Gun intercept error too large: ${err}`)
})

test("Mortar ballistic arc math hits target at range with gravity", () => {
  const speed = 72
  const gravity = 22
  const d = 140
  const dz = -3.5

  const pitchLow = solveMortarPitch(d, dz, speed, gravity, false)
  const pitchHigh = solveMortarPitch(d, dz, speed, gravity, true)
  assert.ok(pitchLow !== null && pitchHigh !== null, "Both low and high mortar arcs should exist")
  assert.ok(pitchHigh > pitchLow, "High arc pitch should exceed low arc pitch")

  for (const pitch of [pitchLow, pitchHigh]) {
    const vx = speed * Math.cos(pitch)
    const vz = speed * Math.sin(pitch)
    const tFlight = d / vx
    const zAtTarget = vz * tFlight - 0.5 * gravity * tFlight * tFlight
    assert.ok(
      Math.abs(zAtTarget - dz) < 1e-4,
      `Mortar trajectory z=${zAtTarget} missed dz=${dz}`
    )
  }

  // Beyond max range (~235m at flat ground) should return null
  const outOfRange = solveMortarPitch(260, 0, speed, gravity, false)
  assert.equal(outOfRange, null, "Out-of-range mortar shot should return null")
})

test("Performance benchmark: 1,000 WorldQuery operations stay well under 15ms/tick", () => {
  const world = getWorld()
  const rng = deterministicRng(42)

  // Read bounds from world.json so random points stay in the playable arena
  const worldJson = JSON.parse(readFileSync(resolve(ARENA_DIR, "v2/world.json"), "utf8")) as {
    bounds: { minX: number; maxX: number; minY: number; maxY: number }
  }
  const { minX, maxX, minY, maxY } = worldJson.bounds
  const spanX = (maxX - minX) * 0.7
  const spanY = (maxY - minY) * 0.7
  const baseX = minX + (maxX - minX) * 0.15
  const baseY = minY + (maxY - minY) * 0.15

  const randPt = (): Vec2 => [baseX + rng() * spanX, baseY + rng() * spanY]

  // 1) 1,000 hasShotLOS queries
  const losTimes: number[] = []
  for (let i = 0; i < 1000; i++) {
    const p1 = randPt()
    const p2 = randPt()
    const a: Vec3 = [p1[0], p1[1], world.heightAt(p1[0], p1[1]) + 7]
    const b: Vec3 = [p2[0], p2[1], world.heightAt(p2[0], p2[1]) + 4.5]
    const t0 = performance.now()
    world.hasShotLOS(a, b)
    losTimes.push(performance.now() - t0)
  }
  losTimes.sort((a, b) => a - b)
  const losP99 = percentile(losTimes, 99)

  // 2) 100 findPath queries (100m-250m paths)
  const pathTimes: number[] = []
  for (let i = 0; i < 100; i++) {
    const p1 = randPt()
    const ang = rng() * Math.PI * 2
    const dist = 60 + rng() * 140
    const p2: Vec2 = [p1[0] + Math.cos(ang) * dist, p1[1] + Math.sin(ang) * dist]
    const a: Vec3 = [p1[0], p1[1], world.heightAt(p1[0], p1[1])]
    const b: Vec3 = [p2[0], p2[1], world.heightAt(p2[0], p2[1])]
    const t0 = performance.now()
    world.findPath(a, b, true)
    pathTimes.push(performance.now() - t0)
  }
  pathTimes.sort((a, b) => a - b)
  const pathP99 = percentile(pathTimes, 99)

  // 3) 200 findCover queries
  const coverTimes: number[] = []
  for (let i = 0; i < 200; i++) {
    const p1 = randPt()
    const p2 = randPt()
    const pos: Vec3 = [p1[0], p1[1], world.heightAt(p1[0], p1[1])]
    const threat: Vec3 = [p2[0], p2[1], world.heightAt(p2[0], p2[1]) + 8]
    const t0 = performance.now()
    world.findCover(pos, [threat], 30)
    coverTimes.push(performance.now() - t0)
  }
  coverTimes.sort((a, b) => a - b)
  const coverP99 = percentile(coverTimes, 99)

  // Simulated per-tick budget: 8 hasShotLOS + 1 findPath + 1 findCover
  const estTickP99 = 8 * losP99 + pathP99 + coverP99
  assert.ok(
    estTickP99 < 15,
    `Estimated p99 tick WorldQuery cost (${estTickP99.toFixed(2)} ms) exceeded 15 ms`
  )
})
