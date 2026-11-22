import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { createWorld } from "../src/world/index.ts"
import { pickUpgrade } from "../src/strategy/upgrades.ts"
import {
  DEFAULT_CONFIG,
  computeActiveHunterIds,
  getHouseBotProfile,
} from "../sim/arena_sim.ts"
import type { Observation, Vec2, Vec3, WorldQuery } from "../src/contracts.ts"

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

test("WorldQuery findPeekCover returns valid peek position (or null cleanly) and stays fast", () => {
  const world = getWorld()

  // Edge cases: no other threats or zero radius return null cleanly
  const origin: Vec3 = [250, -100, world.heightAt(250, -100)]
  const dummyTarget: Vec3 = [280, -100, world.heightAt(280, -100)]
  assert.equal(world.findPeekCover(origin, dummyTarget, [], 30), null)
  assert.equal(world.findPeekCover(origin, dummyTarget, [[220, -100, world.heightAt(220, -100)]], 0), null)

  // Near eastern side of a tall building (base -0.33, top 22.12, x in [301.4, 313.6], y in [-245, -236.8]):
  // Target is visible to the east; secondary threat is on the western side behind the 22m building.
  const pos: Vec3 = [320, -241, world.heightAt(320, -241)]
  const targetPos: Vec3 = [350, -241, world.heightAt(350, -241)]
  const otherThreat: Vec3 = [290, -241, world.heightAt(290, -241)]

  const peek = world.findPeekCover(pos, targetPos, [otherThreat], 35)
  assert.ok(peek !== null, "Expected findPeekCover to find a valid peek position behind tall building")
  if (peek !== null) {
    assert.ok(
      Number.isFinite(peek[0]) && Number.isFinite(peek[1]) && Number.isFinite(peek[2]),
      "Peek position coordinates should be finite"
    )
    const dist = Math.hypot(peek[0] - pos[0], peek[1] - pos[1])
    assert.ok(dist <= 36, `Peek distance ${dist} exceeded search radius`)

    const peekMuzzle: Vec3 = [peek[0], peek[1], peek[2] + 7]
    const targetCenter: Vec3 = [targetPos[0], targetPos[1], targetPos[2] + 4.5]
    assert.equal(
      world.hasShotLOS(peekMuzzle, targetCenter),
      true,
      "Peek position must retain shot LOS to target"
    )

    const threatEye: Vec3 = [otherThreat[0], otherThreat[1], otherThreat[2] + 8]
    const peekEye: Vec3 = [peek[0], peek[1], peek[2] + 8]
    assert.equal(
      world.hasShotLOS(threatEye, peekEye),
      false,
      "Peek position must block shot LOS from secondary threat"
    )
  }

  // Speed benchmark: 100 random findPeekCover queries on real arena
  const rng = deterministicRng(1337)
  const worldJson = JSON.parse(readFileSync(resolve(ARENA_DIR, "v2/world.json"), "utf8")) as {
    bounds: { minX: number; maxX: number; minY: number; maxY: number }
  }
  const { minX, maxX, minY, maxY } = worldJson.bounds
  const randPt = (): Vec3 => {
    const x = minX + (0.15 + rng() * 0.7) * (maxX - minX)
    const y = minY + (0.15 + rng() * 0.7) * (maxY - minY)
    return [x, y, world.heightAt(x, y)]
  }

  const peekTimes: number[] = []
  for (let i = 0; i < 100; i++) {
    const p = randPt()
    const ang1 = rng() * Math.PI * 2
    const ang2 = ang1 + Math.PI * 0.65
    const tx = p[0] + Math.cos(ang1) * 45
    const ty = p[1] + Math.sin(ang1) * 45
    const ox = p[0] + Math.cos(ang2) * 55
    const oy = p[1] + Math.sin(ang2) * 55
    const tPos: Vec3 = [tx, ty, world.heightAt(tx, ty)]
    const oPos: Vec3 = [ox, oy, world.heightAt(ox, oy)]
    const t0 = performance.now()
    const res = world.findPeekCover(p, tPos, [oPos], 28)
    peekTimes.push(performance.now() - t0)
    if (res !== null) {
      assert.ok(Math.hypot(res[0] - p[0], res[1] - p[1]) <= 29)
    }
  }
  peekTimes.sort((a, b) => a - b)
  const peekP99 = percentile(peekTimes, 99)
  assert.ok(peekP99 < 10, `findPeekCover p99 (${peekP99.toFixed(2)} ms) exceeded 10 ms`)
})

function makeUpgradeObs(
  choiceIds: string[] | null,
  takenUpgrades: string[] = [],
  includeLaser = false,
): Observation {
  const choices =
    choiceIds?.map((id) => {
      const def = DEFAULT_CONFIG.upgrades.find((u) => u.id === id)
      return {
        id,
        name: def?.name ?? id,
        desc: def?.desc ?? id,
      }
    }) ?? null

  return {
    type: "obs",
    tick: 100,
    t: 5.0,
    alive: 16,
    self: {
      id: 0,
      pos: [0, 0, 0],
      vel: [0, 0, 0],
      aim: [0, 0],
      hp: 1400,
      max_hp: 1400,
      energy: 100,
      max_energy: 100,
      grounded: true,
      cubes: 3,
      upgrades: takenUpgrades,
      weapons: [
        {
          kind: "gun",
          cooldown: 0,
          ammo: 12,
          reload: 0,
          stats: { ...DEFAULT_CONFIG.weapons.gun },
        },
        includeLaser
          ? {
              kind: "laser",
              cooldown: 0,
              charge: 0,
              stats: { ...DEFAULT_CONFIG.weapons.laser },
            }
          : null,
      ],
      in_zone: true,
      stats: { ...DEFAULT_CONFIG.mech },
    },
    mechs: [],
    projectiles: [],
    crates: [],
    cubes: [],
    pickups: [],
    sounds: [],
    beams: [],
    events: [],
    zone: {
      center: [41.3, -72.8],
      radius: 560,
      next_center: [41.3, -72.8],
      next_radius: 380,
      shrink_start: 60,
      shrink_end: 110,
      dps: 20,
    },
    offer: choices ? { id: 1, expires: 10.0, choices } : null,
    drops: [],
  }
}

test("pickUpgrade selects nanites (Repair nanites) over lower-tier upgrades", () => {
  // No offer -> undefined
  assert.equal(pickUpgrade(makeUpgradeObs(null), DEFAULT_CONFIG), undefined)

  // nanites vs capacitor & sensors
  const obs1 = makeUpgradeObs(["capacitor", "nanites", "sensors"])
  assert.equal(pickUpgrade(obs1, DEFAULT_CONFIG), 1, "Should pick nanites over capacitor and sensors")

  // nanites vs armor & plating
  const obs2 = makeUpgradeObs(["armor", "plating", "nanites"])
  assert.equal(pickUpgrade(obs2, DEFAULT_CONFIG), 2, "Should pick nanites over armor and plating")

  // nanites vs held weapon upgrades (gun_rate, laser_damage)
  const obs3 = makeUpgradeObs(["gun_rate", "laser_damage", "nanites"], [], true)
  assert.equal(pickUpgrade(obs3, DEFAULT_CONFIG), 2, "Should pick nanites over weapon upgrades")

  // Once nanites is maxed (2 stacks), fall back to armor over capacitor
  const obsMaxed = makeUpgradeObs(["nanites", "capacitor", "armor"], ["nanites", "nanites"])
  assert.equal(pickUpgrade(obsMaxed, DEFAULT_CONFIG), 2, "Should avoid maxed nanites and pick armor")
})

test("DEFAULT_CONFIG upgrades and 1v15 Practice hunter activation match v3 rules", () => {
  const upgIds = new Set(DEFAULT_CONFIG.upgrades.map((u) => u.id))
  for (const required of [
    "nanites",
    "armor",
    "plating",
    "servos",
    "gyros",
    "reactor",
    "jets",
    "sensors",
    "capacitor",
    "gun_damage",
    "gun_rate",
    "gun_velocity",
    "gun_mag",
    "laser_charge",
    "laser_damage",
    "laser_pierce",
    "lightning_chain",
    "lightning_range",
    "lightning_efficiency",
    "mortar_splash",
    "mortar_reload",
    "mortar_velocity",
  ]) {
    assert.ok(upgIds.has(required), `Missing real upgrade id: ${required}`)
  }

  // Tier assignment: 4 easy (1-4), 4 medium (5-8), 4 hard (9-12), 3 expert (13-15)
  assert.equal(getHouseBotProfile(1).tier, "easy")
  assert.equal(getHouseBotProfile(4).tier, "easy")
  assert.equal(getHouseBotProfile(5).tier, "medium")
  assert.equal(getHouseBotProfile(8).tier, "medium")
  assert.equal(getHouseBotProfile(9).tier, "hard")
  assert.equal(getHouseBotProfile(12).tier, "hard")
  assert.equal(getHouseBotProfile(13).tier, "expert")
  assert.equal(getHouseBotProfile(15).tier, "expert")

  const all15 = Array.from({ length: 15 }, (_, i) => i + 1)

  // Early game: killedCount === 0 && t < 35 -> only 1 easy bot (id 1) hunts
  const early = computeActiveHunterIds(all15, 0, 10, 560)
  assert.deepEqual([...early], [1])

  // Mid game progression: killed 4 (ids 1-4 dead), t = 90 -> 1 + floor(3.2) + floor(2) = 6 hunters (ids 5-10)
  const midAlive = all15.slice(4)
  const mid = computeActiveHunterIds(midAlive, 4, 90, 380)
  assert.deepEqual([...mid], [5, 6, 7, 8, 9, 10])

  // Late game: t >= 180 or zoneRadius <= 140 -> all remaining bots hunt
  const lateTime = computeActiveHunterIds(midAlive, 4, 180, 240)
  assert.deepEqual([...lateTime], midAlive)
  const lateZone = computeActiveHunterIds(midAlive, 4, 100, 140)
  assert.deepEqual([...lateZone], midAlive)
})
