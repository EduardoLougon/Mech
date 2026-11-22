import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { createWorld } from "../src/world/index.ts"
import { createPerception } from "../src/perception/index.ts"
import { chooseWeaponAction, createCombat, solveDirectAim } from "../src/combat/index.ts"
import { pickUpgrade } from "../src/strategy/upgrades.ts"
import {
  DEFAULT_CONFIG,
  computeActiveHunterIds,
  getHouseBotProfile,
} from "../sim/arena_sim.ts"
import type {
  MacroOrder,
  Observation,
  ThreatState,
  Vec2,
  Vec3,
  WorldQuery,
} from "../src/contracts.ts"

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

  // Near western exterior of a 15.2m building (prism 65: base -1.35, top 15.23, x in [-10.3, 26.5], y in [-126, -91]):
  // Target is visible to the west; secondary threat is on the eastern side behind the 15.2m building.
  const pos: Vec3 = [-18.3, -108.5, world.heightAt(-18.3, -108.5)]
  const targetPos: Vec3 = [-42, -108.5, world.heightAt(-42, -108.5)]
  const otherThreat: Vec3 = [34.5, -108.5, world.heightAt(34.5, -108.5)]

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

// --- v4 Regression Tests ---

test("v4 WorldQuery isPointWalkable & hasDirectWalkLine reject building interiors/walls and accept Oval ground + flat rooftops", () => {
  const world = getWorld()

  // 1. Open Oval ground is walkable and has a direct walk line
  const ovalA: Vec3 = [250, -100, world.heightAt(250, -100)]
  const ovalMid: Vec3 = [275, -100, world.heightAt(275, -100)]
  const ovalB: Vec3 = [290, -100, world.heightAt(290, -100)]
  assert.equal(
    world.isPointWalkable(ovalMid[0], ovalMid[1], ovalMid[2]),
    true,
    "Open Oval ground should be walkable"
  )
  assert.equal(
    world.hasDirectWalkLine(ovalA, ovalB),
    true,
    "Open Oval straight line should have direct walk clearance"
  )

  // 2. Solid building interior & walls are rejected (prism 65: x in [-10.3, 26.5], y in [-126, -91], base -1.35, top 15.23)
  const bldgGroundZ = world.heightAt(8.1, -108.5)
  assert.equal(
    world.isPointWalkable(8.1, -108.5, bldgGroundZ),
    false,
    "Solid building interior at ground level must not be walkable"
  )
  const westExt: Vec3 = [-18.3, -108.5, world.heightAt(-18.3, -108.5)]
  const eastExt: Vec3 = [34.5, -108.5, world.heightAt(34.5, -108.5)]
  assert.equal(
    world.hasDirectWalkLine(westExt, eastExt),
    false,
    "Walk line piercing a solid building must be rejected"
  )

  // 3. Flat rooftop (prism 65, top 15.23) is accepted for both point and direct walk line
  assert.equal(
    world.isPointWalkable(8.1, -108.5, 15.23),
    true,
    "Wide flat rooftop center should be walkable"
  )
  assert.equal(
    world.hasDirectWalkLine([4, -108.5, 15.23], [12, -108.5, 15.23]),
    true,
    "Walk line across flat rooftop should be accepted"
  )

  // 4. Flat rooftop over steep underlying terrain bypasses slopeAt (prism 57 at (-137, -60), top 14.71, terrain slope ~54 deg > 50 deg)
  const underlyingSlope = world.slopeAt(-137, -60)
  assert.ok(
    underlyingSlope > 50,
    `Expected underlying terrain slope at (-137, -60) to exceed 50 deg, got ${underlyingSlope.toFixed(1)}`
  )
  assert.equal(
    world.isPointWalkable(-137, -60, 14.71),
    true,
    "Flat rooftop must remain walkable even when underlying terrain slopeAt exceeds max_slope_deg"
  )
  assert.equal(
    world.hasDirectWalkLine([-137, -66, 14.71], [-137, -56, 14.71]),
    true,
    "Direct walk line across flat rooftop must bypass underlying steep terrain slopeAt"
  )
})

test("v4 WorldQuery findCover allows distSq === 0 when already hidden and returns null in open terrain", () => {
  const world = getWorld()

  // 1. Already hidden behind prism 65 (top 15.23) from east-side threat -> stay put (no ping-pong)
  const hiddenPos: Vec3 = [-18.3, -108.5, world.heightAt(-18.3, -108.5)]
  const eastThreat: Vec3 = [34.5, -108.5, world.heightAt(34.5, -108.5)]
  assert.equal(
    world.hasShotLOS(
      [eastThreat[0], eastThreat[1], eastThreat[2] + 8],
      [hiddenPos[0], hiddenPos[1], hiddenPos[2] + 8]
    ),
    false,
    "Test setup: hiddenPos must already be blocked from eastThreat by prism 65"
  )

  const cover1 = world.findCover(hiddenPos, [eastThreat], 20)
  assert.ok(cover1 !== null, "findCover should return a valid cover cell when already hidden")
  if (cover1 !== null) {
    assert.ok(
      Math.hypot(cover1[0] - hiddenPos[0], cover1[1] - hiddenPos[1]) < 4,
      `Expected already-hidden cover cell near start (< 4m), got ${Math.hypot(cover1[0] - hiddenPos[0], cover1[1] - hiddenPos[1]).toFixed(2)}m`
    )
    assert.equal(
      world.hasShotLOS(
        [eastThreat[0], eastThreat[1], eastThreat[2] + 8],
        [cover1[0], cover1[1], cover1[2] + 8]
      ),
      false,
      "Returned cover cell must remain blocked from threat"
    )

    // Re-querying from the returned navgrid cell center must select distSq === 0 (zero ping-pong)
    const cover2 = world.findCover(cover1, [eastThreat], 20)
    assert.ok(cover2 !== null, "Re-querying findCover from already-hidden cell should not return null")
    if (cover2 !== null) {
      const shift = Math.hypot(cover2[0] - cover1[0], cover2[1] - cover1[1])
      assert.ok(
        shift < 0.5,
        `findCover ping-ponged by ${shift.toFixed(2)}m instead of allowing distSq === 0`
      )
    }
  }

  // 2. Wide-open Oval terrain where no reachable cell reduces exposure -> must return null
  const openPos: Vec3 = [275, -100, world.heightAt(275, -100)]
  const openThreat: Vec3 = [295, -100, world.heightAt(295, -100)]
  assert.equal(
    world.hasShotLOS(
      [openThreat[0], openThreat[1], openThreat[2] + 8],
      [openPos[0], openPos[1], openPos[2] + 8]
    ),
    true,
    "Test setup: openPos must be exposed to openThreat in the Oval"
  )
  assert.equal(
    world.findCover(openPos, [openThreat], 16),
    null,
    "findCover must return null in open terrain when no cell reduces exposure"
  )
})

test("v4 WorldQuery findRooftopSpot finds a valid wide safe-zone rooftop (10-28m above terrain)", () => {
  const world = getWorld()

  const zoneCenter: Vec2 = [41.3, -72.8]
  const zoneRadius = 250
  const maxDist = 180
  const startPos: Vec3 = [zoneCenter[0], zoneCenter[1], world.heightAt(zoneCenter[0], zoneCenter[1])]

  const spot = world.findRooftopSpot(startPos, zoneCenter, zoneRadius, maxDist, [])
  assert.ok(spot !== null, "Expected findRooftopSpot to locate a wide safe-zone rooftop on the real arena")
  if (spot !== null) {
    assert.ok(
      Number.isFinite(spot[0]) && Number.isFinite(spot[1]) && Number.isFinite(spot[2]),
      "Rooftop spot coordinates must be finite"
    )
    const distFromZone = Math.hypot(spot[0] - zoneCenter[0], spot[1] - zoneCenter[1])
    assert.ok(
      distFromZone <= zoneRadius,
      `Rooftop spot (${spot[0]}, ${spot[1]}) is outside safe zone (dist ${distFromZone.toFixed(1)} > ${zoneRadius})`
    )
    const distFromStart = Math.hypot(spot[0] - startPos[0], spot[1] - startPos[1])
    assert.ok(
      distFromStart <= maxDist + 4,
      `Rooftop spot exceeded maxDist (${distFromStart.toFixed(1)} > ${maxDist})`
    )

    const terrainZ = world.heightAt(spot[0], spot[1])
    const heightAboveTerrain = spot[2] - terrainZ
    assert.ok(
      heightAboveTerrain >= 10 && heightAboveTerrain <= 28,
      `Expected rooftop height 10-28m above terrain, got ${heightAboveTerrain.toFixed(2)}m`
    )
    assert.equal(
      world.isPointWalkable(spot[0], spot[1], spot[2]),
      true,
      "Returned rooftop spot must be walkable"
    )
  }

  // Open Oval with tiny safe zone (no buildings within 35m) returns null cleanly
  const ovalPos: Vec3 = [275, -100, world.heightAt(275, -100)]
  assert.equal(
    world.findRooftopSpot(ovalPos, [275, -100], 25, 25, []),
    null,
    "findRooftopSpot should return null when no rooftop exists in the safe zone"
  )
})

test("v4 createPerception initializes sound ghosts with hp === 1400 (not 100)", () => {
  const world = getWorld()
  const perception = createPerception(DEFAULT_CONFIG)

  const obs = makeUpgradeObs(null)
  obs.self.pos = [275, -100, world.heightAt(275, -100)]
  obs.mechs = []
  obs.sounds = [
    { kind: "gun", bearing: 0.5, dist: "mid", age: 0.05 },
    { kind: "step", bearing: -1.8, dist: "near", age: 0.05 },
  ]

  const threats = perception.update(obs, world)
  const ghosts = threats.enemies.filter((e) => e.id < 0)
  assert.equal(ghosts.length, 2, `Expected 2 sound ghosts, got ${ghosts.length}`)
  for (const ghost of ghosts) {
    assert.equal(
      ghost.hp,
      1400,
      `Sound ghost hp should initialize to 1400 (not 100), got ${ghost.hp}`
    )
    assert.equal(
      ghost.maxHp,
      1400,
      `Sound ghost maxHp should initialize to 1400, got ${ghost.maxHp}`
    )
  }
})

test("v4 createCombat fires gun at cooldown === 0.09 and does not force-reload at ammo === 3 with LOS enemy", () => {
  const world = getWorld()
  const combat = createCombat(DEFAULT_CONFIG)

  const selfPos: Vec3 = [250, -100, world.heightAt(250, -100)]
  const enemyPos: Vec3 = [310, -100, world.heightAt(310, -100)]
  const muzzle: Vec3 = [selfPos[0], selfPos[1], selfPos[2] + 7]
  const enemyCenter: Vec3 = [enemyPos[0], enemyPos[1], enemyPos[2] + 4.5]
  assert.equal(world.hasShotLOS(muzzle, enemyCenter), true, "Test setup: enemy must be in clear LOS")

  const alignedAim = solveDirectAim(muzzle, enemyCenter)

  const makeCombatObs = (cooldown: number, ammo: number): Observation => {
    const obs = makeUpgradeObs(null)
    obs.self.pos = selfPos
    obs.self.aim = [alignedAim[0], alignedAim[1]]
    obs.self.weapons = [
      {
        kind: "gun",
        cooldown,
        ammo,
        reload: 0,
        stats: { ...DEFAULT_CONFIG.weapons.gun },
      },
      null,
    ]
    obs.mechs = [
      {
        id: 2,
        kind: "mech",
        pos: enemyPos,
        vel: [0, 0, 0],
        aim: [Math.PI, 0],
        hp: 1400,
        max_hp: 1400,
        cubes: 0,
        weapons: ["gun"],
        charging: false,
      },
    ]
    return obs
  }

  const threats: ThreatState = {
    enemies: [
      {
        id: 2,
        kind: "mech",
        pos: enemyPos,
        vel: [0, 0, 0],
        aim: [Math.PI, 0],
        hp: 1400,
        maxHp: 1400,
        cubes: 0,
        weapons: ["gun"],
        charging: false,
        lastSeenT: 5.0,
        confidence: 1.0,
      },
    ],
    dodgeVec: [0, 0],
    dodgeUrgency: 0,
    wantJump: false,
    chargingLaserThreat: false,
    primaryThreatBearing: alignedAim[0],
    spottedByCount: 1,
    ffaConfidence: 0.5,
  }

  const order: MacroOrder = {
    mode: "engage",
    moveTarget: enemyPos,
    primaryTargetId: 2,
    desiredLoadout: ["laser", "gun"],
    preferSilent: false,
    holdFireForRegen: false,
  }

  // 1. Tick quantization fix: fires when cooldown === 0.09 (<= 0.10)
  const obsTickQuant = makeCombatObs(0.09, 8)
  const actTickQuant = combat.act(obsTickQuant, world, threats, order)
  assert.equal(
    actTickQuant.fire?.[0],
    true,
    "Gun should fire when w.cooldown === 0.09 (<= 0.10 tick quantization threshold)"
  )
  assert.equal(Boolean(actTickQuant.reload), false, "Gun should not reload at ammo === 8")

  // 2. Must NOT force-reload at ammo === 3 when enemy target is in LOS (60m away) and cooldown === 0.09
  const obsAmmo3Ready = makeCombatObs(0.09, 3)
  const actAmmo3Ready = combat.act(obsAmmo3Ready, world, threats, order)
  assert.equal(
    actAmmo3Ready.fire?.[0],
    true,
    "Gun should fire at ammo === 3 with LOS enemy and cooldown === 0.09"
  )
  assert.equal(
    Boolean(actAmmo3Ready.reload),
    false,
    "Gun must NOT force-reload at ammo === 3 when an enemy target is in LOS"
  )

  // Also verify chooseWeaponAction directly
  const weaponAct = chooseWeaponAction(obsAmmo3Ready, DEFAULT_CONFIG, world, threats, order)
  assert.equal(weaponAct.fire[0], true, "chooseWeaponAction should fire gun at cooldown === 0.09, ammo === 3")
  assert.equal(Boolean(weaponAct.reload), false, "chooseWeaponAction must not force-reload at ammo === 3 with LOS enemy")

  // 3. Even while mid-cooldown (0.18s > 0.10s), must NOT force-reload at ammo === 3 when enemy is in LOS
  const obsAmmo3Cooling = makeCombatObs(0.18, 3)
  const actAmmo3Cooling = combat.act(obsAmmo3Cooling, world, threats, order)
  assert.equal(
    Boolean(actAmmo3Cooling.reload),
    false,
    "Gun must NOT force-reload during cooldown at ammo === 3 when an enemy target is in LOS"
  )
})
