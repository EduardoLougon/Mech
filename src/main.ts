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
  world.findPath([0, 0, warmZ], [40, 40, warmZ], false)

  const maxSlopeDeg = cfg.mech.max_slope_deg ?? 50

  let cachedPath: Vec3[] = []
  let cachedGoal: Vec3 | null = null
  let lastPathTick = -100
  let stuckTicks = 0
  let stuckSide = 1

  log(
    `mech-hydra-v3 ready in ${(performance.now() - tStart).toFixed(1)} ms (slot=${hello.slot})`,
  )

  return {
    name: "mech-hydra-v3",
    act(obs: Observation): BotAction {
      const t0 = performance.now()
      const me = obs.self
      const [x, y, z] = me.pos

      // 1. Perception & Threats
      const threats = perception.update(obs, world)

      // 2. Macro Strategy & Upgrades
      const { order, pick } = strategy.decide(obs, world, threats)

      // 3. Combat & Loot
      const combatAct = combat.act(obs, world, threats, order)

      // 4. Navigation, Dodge Blending & Wall-Safe Local Steering
      let move: Vec2 = [0, 0]
      let boost = false
      let jump = false

      const goal = order.moveTarget
      let waypoint: Vec3 | null = goal
      if (goal) {
        const goalDist2 = Math.hypot(goal[0] - x, goal[1] - y)
        const goalMoved =
          !cachedGoal ||
          Math.hypot(goal[0] - cachedGoal[0], goal[1] - cachedGoal[1]) > 8 ||
          Math.abs(goal[2] - cachedGoal[2]) > 3

        // For short local strafe/peek targets (< 18m) with direct line, skip A* overhead
        if (goalDist2 < 18 && Math.abs(goal[2] - z) < 2.0) {
          waypoint = goal
          cachedPath = []
        } else {
          const elapsed = performance.now() - t0
          if (
            elapsed < ASTAR_SOFT_BUDGET_MS &&
            (goalMoved ||
              obs.tick - lastPathTick >= PATH_RECOMPUTE_TICKS ||
              cachedPath.length === 0)
          ) {
            const canJet = me.energy > 35
            cachedPath = world.findPath(me.pos, goal, canJet)
            cachedGoal = goal
            lastPathTick = obs.tick
          }

          while (
            cachedPath.length > 1 &&
            Math.hypot(cachedPath[0][0] - x, cachedPath[0][1] - y) < 3.5 &&
            Math.abs(cachedPath[0][2] - z) < 2.0
          ) {
            cachedPath.shift()
          }
          waypoint = cachedPath[0] ?? goal
        }

        const dx = waypoint[0] - x
        const dy = waypoint[1] - y
        const d = Math.hypot(dx, dy)
        if (d > 1e-4) move = [dx / d, dy / d]

        // Ledge/roof jump-jetting when energy can cover the climb
        const dz = waypoint[2] - z
        if (dz > 1.3 && me.energy >= Math.max(25, dz / 0.5 + 10)) {
          if (me.grounded) jump = true
          else boost = true
        }
      }

      // Blend or override with projectile/laser dodge BEFORE local wall-avoidance steering
      if (threats.dodgeUrgency > 0.55) {
        move = threats.dodgeVec
        if (me.energy > 15) boost = true
      } else if (threats.dodgeUrgency > 0.2) {
        const w = Math.min(0.85, threats.dodgeUrgency)
        const mx = move[0] * (1 - w) + threats.dodgeVec[0] * w
        const my = move[1] * (1 - w) + threats.dodgeVec[1] * w
        const mag = Math.hypot(mx, my)
        if (mag > 1e-4) move = [mx / mag, my / mag]
        else move = threats.dodgeVec
      }

      // Wall-safe local steering applied to the combined move vector
      const moveMagPreSteer = Math.hypot(move[0], move[1])
      if (moveMagPreSteer > 1e-4) {
        const steerTarget: Vec3 = [
          x + move[0] * 6,
          y + move[1] * 6,
          waypoint ? waypoint[2] : z,
        ]
        move = computeLocalSteer(world, me.pos, steerTarget, maxSlopeDeg)
      }

      // Stuck detection & recovery (latches escape side cleanly)
      const moveMag = Math.hypot(move[0], move[1])
      const speed2d = Math.hypot(me.vel[0], me.vel[1])
      if (moveMag > 0.3 && speed2d < 1.2) {
        stuckTicks++
        if (stuckTicks === 6) {
          stuckSide = obs.tick % 2 === 0 ? 1 : -1
          cachedPath = []
        }
        if (stuckTicks >= 6) {
          if (me.grounded) jump = true
          if (me.energy > 20) boost = true
          const ang = Math.atan2(move[1], move[0]) + stuckSide * 1.15
          move = [Math.cos(ang), Math.sin(ang)]
        }
      } else {
        stuckTicks = 0
      }

      // Smart boost policy: sprint when out of zone, retreating to cover, or contesting drop
      if (!me.in_zone && me.energy > 12) {
        boost = true
      } else if (order.mode === "zone_sprint" && me.energy > 35) {
        boost = true
      } else if (
        order.mode === "regen_hide" &&
        threats.spottedByCount > 0 &&
        me.energy > 20
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
        `v3 ${order.mode} cubes=${me.cubes} hp=${me.hp.toFixed(0)}`,
      )

      return act
    },
  }
})
