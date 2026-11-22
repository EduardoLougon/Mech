import type {
  ActorObs,
  Config,
  Observation,
  TrackedEnemy,
  Vec3,
  WeaponKind,
  WorldQuery,
} from "../contracts.ts"

export interface TrackerOutput {
  enemies: TrackedEnemy[]
  primaryThreatBearing: number | null
  spottedByCount: number
  ffaConfidence: number
}

const MECH_EYE_Z = 4.5
const SOUND_MATCH_RAD = (15 * Math.PI) / 180
const SOUND_GHOST_TTL_S = 2.5
const DAMAGED_MEMORY_S = 2.0

const TRACKED_SOUND_KINDS = new Set([
  "gun",
  "mortar",
  "laser",
  "laser_charge",
  "lightning",
  "step",
  "boost",
  "jet",
])

const COMBAT_SOUND_KINDS = new Set([
  "gun",
  "mortar",
  "laser",
  "laser_charge",
  "lightning",
])

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function normalizeAngle(rad: number): number {
  let a = rad % (2 * Math.PI)
  if (a > Math.PI) a -= 2 * Math.PI
  if (a < -Math.PI) a += 2 * Math.PI
  return a
}

function angleDiff(a: number, b: number): number {
  return Math.abs(normalizeAngle(a - b))
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function bearing2d(from: Vec3, to: Vec3): number {
  return Math.atan2(to[1] - from[1], to[0] - from[0])
}

function isWeaponKind(w: string): w is WeaponKind {
  return w === "gun" || w === "mortar" || w === "laser" || w === "lightning"
}

function soundDistMeters(dist: "near" | "mid" | "far"): number {
  if (dist === "near") return 35
  if (dist === "mid") return 100
  return 200
}

function addWeapon(weapons: WeaponKind[], kind: WeaponKind): WeaponKind[] {
  return weapons.includes(kind) ? weapons : [...weapons, kind]
}

interface SoundGhost {
  id: number
  bearing: number
  enemy: TrackedEnemy
}

interface RecentDamage {
  bearing: number
  t: number
  by: number | null
  rear: boolean
}

export function createTracker(config: Config) {
  const tracked = new Map<number, TrackedEnemy>()
  const ghosts: SoundGhost[] = []
  let nextGhostId = -1
  let prevAlive: number | null = null
  let prevT: number | null = null
  let ffaConfidence = 0.35
  let recentDamaged: RecentDamage | null = null

  const memoryS = config.vision.memory_s ?? 5
  const visionRange = config.vision.range ?? 200
  const nearRange = config.vision.near_range ?? 45

  function updateVisibleActors(obs: Observation): Set<number> {
    const visibleIds = new Set<number>()
    for (const m of obs.mechs) {
      visibleIds.add(m.id)
      const prev = tracked.get(m.id)
      const defaultMaxHp = m.kind === "npc" ? 60 : 100
      const enemy: TrackedEnemy = {
        id: m.id,
        kind: m.kind,
        pos: [m.pos[0], m.pos[1], m.pos[2]],
        vel: [m.vel[0], m.vel[1], m.vel[2]],
        aim: [m.aim[0], m.aim[1]],
        hp: m.hp ?? prev?.hp ?? m.max_hp ?? defaultMaxHp,
        maxHp: m.max_hp ?? prev?.maxHp ?? defaultMaxHp,
        cubes: m.cubes ?? prev?.cubes ?? 0,
        weapons: m.weapons ? [...m.weapons] : prev?.weapons ?? [],
        charging: Boolean(m.charging),
        lastSeenT: obs.t,
        confidence: 1.0,
      }
      tracked.set(m.id, enemy)
    }
    return visibleIds
  }

  function decayUnseenActors(
    obs: Observation,
    visibleIds: Set<number>,
    tickDt: number,
  ): void {
    const stepDt = clamp(tickDt, 0, 0.5)
    for (const [id, enemy] of tracked) {
      if (visibleIds.has(id)) continue
      const age = obs.t - enemy.lastSeenT
      if (age > memoryS || age < 0) {
        tracked.delete(id)
        continue
      }
      const damp = age <= 0.5 ? 1.0 : 0.85
      enemy.vel = [
        enemy.vel[0] * damp,
        enemy.vel[1] * damp,
        enemy.vel[2] * damp,
      ]
      enemy.pos = [
        enemy.pos[0] + enemy.vel[0] * stepDt,
        enemy.pos[1] + enemy.vel[1] * stepDt,
        enemy.pos[2] + enemy.vel[2] * stepDt,
      ]
      if (age > 0.5) {
        enemy.charging = false
      }
      enemy.confidence = Math.max(0.05, 1.0 - (age / memoryS) * 0.85)
    }
  }

  function processEventsAndBeams(obs: Observation): number {
    let killsThisTick = 0
    for (const ev of obs.events) {
      if (ev.type === "kill") {
        killsThisTick++
        tracked.delete(ev.target)
      } else if (ev.type === "damaged") {
        if (ev.bearing !== null) {
          recentDamaged = {
            bearing: ev.bearing,
            t: obs.t,
            by: ev.by,
            rear: Boolean(ev.rear),
          }
        }
        if (ev.by !== null && isWeaponKind(ev.weapon)) {
          const attacker = tracked.get(ev.by)
          if (attacker) {
            attacker.weapons = addWeapon(attacker.weapons, ev.weapon)
          }
        }
      }
    }

    for (const beam of obs.beams) {
      if (beam.by === obs.self.id) continue
      const shooter = tracked.get(beam.by)
      if (shooter) {
        shooter.weapons = addWeapon(shooter.weapons, beam.kind)
        shooter.charging = false
      } else if (beam.path.length > 0) {
        const origin = beam.path[0]
        const aimYaw =
          beam.path.length > 1
            ? bearing2d(origin, beam.path[beam.path.length - 1])
            : bearing2d(origin, obs.self.pos)
        tracked.set(beam.by, {
          id: beam.by,
          kind: "mech",
          pos: [origin[0], origin[1], origin[2]],
          vel: [0, 0, 0],
          aim: [aimYaw, 0],
          hp: 100,
          maxHp: 100,
          cubes: 0,
          weapons: [beam.kind],
          charging: false,
          lastSeenT: obs.t - beam.age,
          confidence: 0.7,
        })
      }
    }

    return killsThisTick
  }

  function updateSoundGhosts(obs: Observation): void {
    const selfPos = obs.self.pos
    // Expire old ghosts or ghosts now covered by visible mechs
    for (let i = ghosts.length - 1; i >= 0; i--) {
      const g = ghosts[i]
      const age = obs.t - g.enemy.lastSeenT
      if (age > SOUND_GHOST_TTL_S || age < 0) {
        ghosts.splice(i, 1)
        continue
      }
      const matchesVisible = obs.mechs.some(
        (m) => angleDiff(bearing2d(selfPos, m.pos), g.bearing) <= SOUND_MATCH_RAD,
      )
      if (matchesVisible) {
        ghosts.splice(i, 1)
        continue
      }
      g.enemy.confidence = Math.max(0.1, 0.4 * (1 - age / SOUND_GHOST_TTL_S))
    }

    for (const s of obs.sounds) {
      if (!TRACKED_SOUND_KINDS.has(s.kind)) continue
      const matchesVisible = obs.mechs.some(
        (m) => angleDiff(bearing2d(selfPos, m.pos), s.bearing) <= SOUND_MATCH_RAD,
      )
      if (matchesVisible) continue

      const distM = soundDistMeters(s.dist)
      const ghostPos: Vec3 = [
        selfPos[0] + Math.cos(s.bearing) * distM,
        selfPos[1] + Math.sin(s.bearing) * distM,
        selfPos[2],
      ]
      const inferredWeapon: WeaponKind[] = isWeaponKind(s.kind)
        ? [s.kind]
        : s.kind === "laser_charge"
          ? ["laser"]
          : []
      const soundT = obs.t - s.age

      const existing = ghosts.find(
        (g) => angleDiff(g.bearing, s.bearing) <= SOUND_MATCH_RAD,
      )
      if (existing) {
        existing.bearing = s.bearing
        existing.enemy.pos = ghostPos
        existing.enemy.aim = [normalizeAngle(s.bearing + Math.PI), 0]
        existing.enemy.lastSeenT = soundT
        existing.enemy.confidence = 0.4
        existing.enemy.charging = s.kind === "laser_charge"
        for (const w of inferredWeapon) {
          existing.enemy.weapons = addWeapon(existing.enemy.weapons, w)
        }
      } else {
        const id = nextGhostId--
        ghosts.push({
          id,
          bearing: s.bearing,
          enemy: {
            id,
            kind: "mech",
            pos: ghostPos,
            vel: [0, 0, 0],
            aim: [normalizeAngle(s.bearing + Math.PI), 0],
            hp: 100,
            maxHp: 100,
            cubes: 0,
            weapons: inferredWeapon,
            charging: s.kind === "laser_charge",
            lastSeenT: soundT,
            confidence: 0.4,
          },
        })
      }
    }
  }

  function computeSpottedByCount(
    obs: Observation,
    world: WorldQuery,
  ): number {
    const selfEye: Vec3 = [
      obs.self.pos[0],
      obs.self.pos[1],
      obs.self.pos[2] + MECH_EYE_Z,
    ]
    let count = 0
    for (const enemy of tracked.values()) {
      if (enemy.kind !== "mech" || enemy.confidence < 0.5) continue
      const d = dist3(enemy.pos, obs.self.pos)
      if (d <= nearRange) {
        count++
      } else if (d <= visionRange) {
        const enemyEye: Vec3 = [
          enemy.pos[0],
          enemy.pos[1],
          enemy.pos[2] + MECH_EYE_Z,
        ]
        if (world.hasVisionLOS(enemyEye, selfEye)) {
          count++
        }
      }
    }
    return count
  }

  function updateFfaConfidence(
    obs: Observation,
    killsThisTick: number,
    spottedByCount: number,
    tickDt: number,
  ): void {
    const dt = clamp(tickDt, 0.05, 0.5)

    // 1. Alive count dropped without our kill
    if (prevAlive !== null && obs.alive < prevAlive) {
      const otherDeaths = Math.max(0, prevAlive - obs.alive - killsThisTick)
      if (otherDeaths > 0) {
        ffaConfidence = clamp(ffaConfidence + 0.25 * otherDeaths, 0, 1)
      }
    }

    // 2. >= 2 distinct distant combat bearings (> 35 deg apart) while unspotted
    const recentlyHit =
      recentDamaged !== null && obs.t - recentDamaged.t <= 1.5
    if (spottedByCount === 0 && !recentlyHit) {
      const distantBearings = obs.sounds
        .filter(
          (s) =>
            (s.dist === "far" || s.dist === "mid") &&
            COMBAT_SOUND_KINDS.has(s.kind),
        )
        .map((s) => s.bearing)
      const minSep = (35 * Math.PI) / 180
      let hasDistinctPair = false
      for (let i = 0; i < distantBearings.length && !hasDistinctPair; i++) {
        for (let j = i + 1; j < distantBearings.length; j++) {
          if (angleDiff(distantBearings[i], distantBearings[j]) > minSep) {
            hasDistinctPair = true
            break
          }
        }
      }
      if (hasDistinctPair) {
        ffaConfidence = clamp(ffaConfidence + 0.15 * dt, 0, 1)
      }
    }

    // 3. Visible mechs fighting each other vs converging on us
    const visibleMechs: ActorObs[] = obs.mechs.filter((m) => m.kind === "mech")
    const beamShooters = new Set(
      obs.beams.filter((b) => b.by !== obs.self.id).map((b) => b.by),
    )
    let fightingEachOther = false
    let convergingOnUsCount = 0
    const aimTol = (28 * Math.PI) / 180

    for (const a of visibleMechs) {
      const toUs = bearing2d(a.pos, obs.self.pos)
      const aimingAtUs = angleDiff(a.aim[0], toUs) <= aimTol
      const hasCombatEvidence = Boolean(a.charging) || beamShooters.has(a.id)
      let aimingAtOther = false
      if (hasCombatEvidence && !aimingAtUs) {
        for (const b of visibleMechs) {
          if (a.id === b.id) continue
          if (dist3(a.pos, b.pos) > 120) continue
          const toB = bearing2d(a.pos, b.pos)
          if (angleDiff(a.aim[0], toB) <= aimTol) {
            aimingAtOther = true
            break
          }
        }
      }
      if (aimingAtOther) fightingEachOther = true
      if (aimingAtUs && dist3(a.pos, obs.self.pos) <= 130) {
        convergingOnUsCount++
      }
    }

    // Also check beams hitting near another mech (not us)
    for (const beam of obs.beams) {
      if (beam.by === obs.self.id || beam.path.length < 2) continue
      const endPt = beam.path[beam.path.length - 1]
      if (dist3(endPt, obs.self.pos) > 12) {
        const nearOther = visibleMechs.some(
          (m) => m.id !== beam.by && dist3(endPt, m.pos) < 12,
        )
        if (nearOther) fightingEachOther = true
      }
    }

    if (fightingEachOther) {
      ffaConfidence = clamp(ffaConfidence + 0.35 * dt, 0, 1)
    } else if (convergingOnUsCount >= 2) {
      ffaConfidence = clamp(ffaConfidence - 0.12 * dt, 0, 1)
    }

    // 4. High alive count past t >= 30s -> 1v15 Practice
    if (obs.t >= 30 && obs.alive >= 15) {
      ffaConfidence = clamp(ffaConfidence - 0.08 * dt, 0, 1)
    }
  }

  function computePrimaryThreatBearing(
    obs: Observation,
    enemies: TrackedEnemy[],
    world: WorldQuery,
  ): number | null {
    const selfPos = obs.self.pos
    const selfEye: Vec3 = [selfPos[0], selfPos[1], selfPos[2] + MECH_EYE_Z]

    // If hit recently from unseen/behind, immediately orient toward that bearing
    if (recentDamaged !== null && obs.t - recentDamaged.t <= 1.5) {
      const attackerVisible =
        recentDamaged.by !== null &&
        obs.mechs.some((m) => m.id === recentDamaged!.by)
      if (!attackerVisible || recentDamaged.rear) {
        return recentDamaged.bearing
      }
    }

    let bestScore = -1
    let bestBearing: number | null = null

    for (const e of enemies) {
      const d = Math.max(10, dist3(selfPos, e.pos))
      let score = (e.kind === "mech" ? 1.0 : 0.35) * (100 / d) * e.confidence
      if (e.charging) score *= 2.5

      const toUs = bearing2d(e.pos, selfPos)
      if (e.confidence >= 0.7 && angleDiff(e.aim[0], toUs) <= (35 * Math.PI) / 180) {
        score *= 1.6
      }

      if (e.confidence >= 0.5) {
        const enemyEye: Vec3 = [e.pos[0], e.pos[1], e.pos[2] + MECH_EYE_Z]
        if (world.hasShotLOS(enemyEye, selfEye)) {
          score *= 1.4
        }
      }

      if (score > bestScore) {
        bestScore = score
        bestBearing = bearing2d(selfPos, e.pos)
      }
    }

    if (bestBearing !== null) return bestBearing
    if (recentDamaged !== null && obs.t - recentDamaged.t <= DAMAGED_MEMORY_S) {
      return recentDamaged.bearing
    }
    return null
  }

  function update(obs: Observation, world: WorldQuery): TrackerOutput {
    const tickDt = prevT !== null ? Math.max(0, obs.t - prevT) : 0.05

    const visibleIds = updateVisibleActors(obs)
    decayUnseenActors(obs, visibleIds, tickDt)
    const killsThisTick = processEventsAndBeams(obs)
    updateSoundGhosts(obs)

    const spottedByCount = computeSpottedByCount(obs, world)
    updateFfaConfidence(obs, killsThisTick, spottedByCount, tickDt)

    const enemies: TrackedEnemy[] = [
      ...tracked.values(),
      ...ghosts.map((g) => g.enemy),
    ]
    const primaryThreatBearing = computePrimaryThreatBearing(
      obs,
      enemies,
      world,
    )

    prevAlive = obs.alive
    prevT = obs.t

    return {
      enemies,
      primaryThreatBearing,
      spottedByCount,
      ffaConfidence,
    }
  }

  return { update }
}
