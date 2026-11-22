import type { Vec2, Vec3 } from "./contracts.ts"
import { createCombat } from "./combat/index.ts"
import { type BotAction, draw, log, type Observation, run } from "./mechfight.ts"
import { createPerception } from "./perception/index.ts"
import { createStrategy } from "./strategy/index.ts"
import { computeLocalSteer, createWorld } from "./world/index.ts"

const ASTAR_SOFT_BUDGET_MS = 20
const PATH_RECOMPUTE_TICKS = 5

run((hello) => {
  const tStart = performance.now()
  const cfg = hello.config
  const world = createWorld(hello.map.dir, cfg)
  const perception = createPerception(cfg)
  const strategy = createStrategy(cfg)
  const combat = createCombat(cfg)

  // Pre-warm JIT during hello budget
  const warmZ = world.heightAt(0, 0)
  world.hasShotLOS([0, 0, warmZ + 7], [40, 40, warmZ + 7])
  world.findPath([0, 0, warmZ], [40, 40, warmZ], 0)

  const maxSlopeDeg = cfg.mech.max_slope_deg ?? 50
  const baseRadius = cfg.mech.radius ?? 2.5
  const baseHeight = cfg.mech.height ?? 9.0
  const sizePerCube = (cfg.cubes.size_per_cube as number) ?? 0.05

  let cachedPath: Vec3[] = []
  let cachedGoal: Vec3 | null = null
  let lastPathTick = -100
  let stuckTicks = 0
  let stuckSide = 1
  let anchorPos: Vec3 | null = null
  let anchorTick = 0
  let climbingTargetZ: number | null = null
  let eaveStallTicks = 0
  let eaveBackoffTicks = 0
  let eaveBackoffDir: Vec2 = [0, 0]

  log(
    `mech-hydra-v4 ready in ${(performance.now() - tStart).toFixed(1)} ms (slot=${hello.slot})`,
  )

  return {
    name: "mech-hydra-v4",
    act(obs: Observation): BotAction {
      const t0 = performance.now()
      const me = obs.self
      const [x, y, z] = me.pos
      const sizeScale = 1 + sizePerCube * me.cubes
      const mechRadius = me.stats.radius ?? baseRadius * sizeScale
      const mechHeight = me.stats.height ?? baseHeight * sizeScale

      // 1. Perception & Threats
      const threats = perception.update(obs, world)

      // 2. Macro Strategy & Upgrades
      const { order, pick } = strategy.decide(obs, world, threats)

      // 3. Combat & Loot
      const combatAct = combat.act(obs, world, threats, order)

      // 4. Navigation, Roof-Climb State Machine, Dodge & Wall-Safe Steering
      let move: Vec2 = [0, 0]
      let boost = false
      let jump = false
      let activeClimb = false

      const goal = order.moveTarget
      let waypoint: Vec3 | null = goal
      if (goal) {
        const goalDist2 = Math.hypot(goal[0] - x, goal[1] - y)
        const goalDz = Math.abs(goal[2] - z)
        const goalMoved =
          !cachedGoal ||
          Math.hypot(goal[0] - cachedGoal[0], goal[1] - cachedGoal[1]) > 8 ||
          Math.abs(goal[2] - cachedGoal[2]) > 3

        // Only bypass A* if goal is close, same elevation, AND has verified wall-free direct line!
        if (
          goalDist2 < 18 &&
          goalDz < 1.2 &&
          world.hasDirectWalkLine(me.pos, goal, mechRadius, mechHeight)
        ) {
          waypoint = goal
          cachedPath = []
          cachedGoal = goal
        } else {
          const elapsed = performance.now() - t0
          if (
            elapsed < ASTAR_SOFT_BUDGET_MS &&
            (goalMoved ||
              obs.tick - lastPathTick >= PATH_RECOMPUTE_TICKS ||
              cachedPath.length === 0)
          ) {
            const maxClimb = Math.max(0, Math.min(48, (me.energy - 16) / 1.5))
            const wantRoof = goal[2] > world.heightAt(goal[0], goal[1]) + 2.5
            cachedPath = world.findPath(me.pos, goal, maxClimb, wantRoof)
            cachedGoal = goal
            lastPathTick = obs.tick
          }

          // Pop waypoints only when horizontally close AND feet actually cleared roof Z
          while (cachedPath.length > 1) {
            const wp = cachedPath[0]
            const wpDist2 = Math.hypot(wp[0] - x, wp[1] - y)
            const wpDz = wp[2] - z
            const zCleared = wpDz <= 0.3 && wpDz >= -2.5
            if (wpDist2 < 3.5 && zCleared) {
              cachedPath.shift()
            } else {
              break
            }
          }
          waypoint = cachedPath[0] ?? goal
        }

        const dx = waypoint[0] - x
        const dy = waypoint[1] - y
        const d2 = Math.hypot(dx, dy)
        if (d2 > 1e-4) move = [dx / d2, dy / d2]

        // Dedicated Roof Climb Controller (Approach -> Launch -> Clear Edge -> Mantle -> Eave Escape)
        const wpDz = waypoint[2] - z
        if (eaveBackoffTicks > 0) {
          eaveBackoffTicks--
          move = eaveBackoffDir
          boost = false
          activeClimb = true
        } else if (
          climbingTargetZ !== null &&
          z < climbingTargetZ + 0.5 &&
          me.energy > 5 &&
          d2 < 10
        ) {
          // Continue climbing until feet clear roof edge (+0.5m)
          activeClimb = true
          if (me.grounded) jump = true
          else boost = true
          // Eave/overhang stall detection (protocol.md §7)
          if (!me.grounded && me.vel[2] < 1.5) {
            eaveStallTicks++
            if (eaveStallTicks >= 3) {
              eaveBackoffTicks = 3
              eaveBackoffDir = d2 > 1e-4 ? [-dx / d2, -dy / d2] : [1, 0]
              eaveStallTicks = 0
              climbingTargetZ = null
            }
          } else {
            eaveStallTicks = 0
          }
        } else if (
          wpDz > 1.2 &&
          d2 <= 7.5 &&
          me.energy >= 1.5 * wpDz + 14
        ) {
          // Start roof climb only once horizontally close to the edge
          climbingTargetZ = waypoint[2]
          activeClimb = true
          eaveStallTicks = 0
          if (me.grounded) jump = true
          else boost = true
        } else {
          // Clear climb latch once landed on/above target or moved away
          if (
            climbingTargetZ !== null &&
            (z >= climbingTargetZ - 0.2 || d2 >= 10 || me.energy <= 5)
          ) {
            climbingTargetZ = null
            eaveStallTicks = 0
          }
        }
      } else {
        climbingTargetZ = null
        eaveStallTicks = 0
      }

      // Blend or override with projectile/laser dodge BEFORE local wall-avoidance steering
      if (!activeClimb) {
        if (threats.dodgeUrgency > 0.55) {
          move = threats.dodgeVec
          if (me.grounded && me.energy > 15) boost = true
        } else if (threats.dodgeUrgency > 0.2) {
          const w = Math.min(0.85, threats.dodgeUrgency)
          const mx = move[0] * (1 - w) + threats.dodgeVec[0] * w
          const my = move[1] * (1 - w) + threats.dodgeVec[1] * w
          const mag = Math.hypot(mx, my)
          if (mag > 1e-4) move = [mx / mag, my / mag]
          else move = threats.dodgeVec
        }
      }

      if (threats.wantJump && me.grounded) {
        jump = true
      }

      // Wall-safe local steering applied AFTER dodge blending (bypassed during intentional roof mantle)
      const moveMagPreSteer = Math.hypot(move[0], move[1])
      if (!activeClimb && moveMagPreSteer > 1e-4) {
        const steerTarget: Vec3 = [
          x + move[0] * 6,
          y + move[1] * 6,
          waypoint ? waypoint[2] : z,
        ]
        move = computeLocalSteer(
          world,
          me.pos,
          steerTarget,
          maxSlopeDeg,
          mechRadius,
          mechHeight,
        )
      }

      // Stuck detection & recovery via actual net displacement (catches wall-grinding & steer oscillation)
      const moveMag = Math.hypot(move[0], move[1])
      const speed2d = Math.hypot(me.vel[0], me.vel[1])
      const goalDistForStuck = goal ? Math.hypot(goal[0] - x, goal[1] - y) : 0
      if (!activeClimb && moveMag > 0.3 && goalDistForStuck > 4.0) {
        if (!anchorPos) {
          anchorPos = [x, y, z]
          anchorTick = obs.tick
        }
        const netMoved = Math.hypot(x - anchorPos[0], y - anchorPos[1])
        const elapsedTicks = obs.tick - anchorTick
        if (netMoved >= 3.0) {
          anchorPos = [x, y, z]
          anchorTick = obs.tick
          stuckTicks = 0
        } else if (speed2d < 1.2 || elapsedTicks >= 24) {
          stuckTicks++
          if (stuckTicks === 6) {
            stuckSide = obs.tick % 2 === 0 ? 1 : -1
            cachedPath = []
          }
          if (stuckTicks >= 6) {
            const ang = Math.atan2(move[1], move[0]) + stuckSide * 1.35
            move = [Math.cos(ang), Math.sin(ang)]
            if (stuckTicks >= 12) {
              // If lateral slide failed for 0.6s (e.g. courtyard hole / sunken ledge), jump-jet out!
              if (me.grounded) jump = true
              else if (me.energy > 15) boost = true
            } else if (me.grounded && me.energy > 25) {
              boost = true
            }
            if (stuckTicks >= 24) {
              anchorPos = [x, y, z]
              anchorTick = obs.tick
              stuckSide = -stuckSide
              stuckTicks = 6
            }
          }
        }
      } else {
        anchorPos = null
        stuckTicks = 0
      }

      // Smart boost policy: ALWAYS gate sprint boost on `me.grounded` so we never accidentally sky-jet!
      if (!activeClimb && me.grounded) {
        if (!me.in_zone && me.energy > 12) {
          boost = true
        } else if (order.mode === "zone_sprint" && me.energy > 35) {
          boost = true
        } else if (
          order.mode === "regen_hide" &&
          threats.spottedByCount > 0 &&
          me.energy > 18
        ) {
          boost = true
        } else if (
          threats.chargingLaserThreat &&
          me.energy > 18
        ) {
          boost = true
        } else if (
          (order.mode === "contest_drop" || order.mode === "farm_crate") &&
          goal &&
          Math.hypot(goal[0] - x, goal[1] - y) > 25 &&
          me.energy > 65
        ) {
          boost = true
        }
      }

      const act: BotAction = {
        ...combatAct,
        move,
        boost,
        jump,
        ...(pick !== undefined ? { pick } : {}),
      }

      if (goal) {
        draw.point(goal, "#40c0ff", 5)
      }
      draw.label(
        `v4 ${order.mode} c=${me.cubes} hp=${me.hp.toFixed(0)}`,
      )

      return act
    },
  }
})
