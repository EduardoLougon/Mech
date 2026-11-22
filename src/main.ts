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

  const stepSpeed = cfg.sound.step_speed ?? 5
  const maxSlopeDeg = cfg.mech.max_slope_deg ?? 50

  let cachedPath: Vec3[] = []
  let cachedGoal: Vec3 | null = null
  let lastPathTick = -100
  let stuckTicks = 0
  let stuckSide = 1

  log(
    `mech-hydra-v2 ready in ${(performance.now() - tStart).toFixed(1)} ms (slot=${hello.slot})`,
  )

  return {
    name: "mech-hydra-v2",
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
        const goalMoved =
          !cachedGoal ||
          Math.hypot(goal[0] - cachedGoal[0], goal[1] - cachedGoal[1]) > 8 ||
          Math.abs(goal[2] - cachedGoal[2]) > 3

        const elapsed = performance.now() - t0
        if (
          elapsed < ASTAR_SOFT_BUDGET_MS &&
          (goalMoved ||
            obs.tick - lastPathTick >= PATH_RECOMPUTE_TICKS ||
            cachedPath.length === 0)
        ) {
          const canJet = me.energy > 35 && !order.preferSilent
          cachedPath = world.findPath(me.pos, goal, canJet)
          cachedGoal = goal
          lastPathTick = obs.tick
        }

        // Advance along 3D-verified waypoints (check Z for rooftops/bridges)
        while (
          cachedPath.length > 1 &&
          Math.hypot(cachedPath[0][0] - x, cachedPath[0][1] - y) < 3.5 &&
          Math.abs(cachedPath[0][2] - z) < 2.0
        ) {
          cachedPath.shift()
        }

        waypoint = cachedPath[0] ?? goal
        const dx = waypoint[0] - x
        const dy = waypoint[1] - y
        const d = Math.hypot(dx, dy)
        if (d > 1e-4) move = [dx / d, dy / d]

        // Ledge/roof jump-jetting when energy can cover the climb
        const dz = waypoint[2] - z
        if (
          dz > 1.3 &&
          me.energy >= Math.max(25, dz / 0.5 + 10) &&
          !order.preferSilent
        ) {
          if (me.grounded) jump = true
          else boost = true
        }
      }

      // Blend or override with projectile/laser dodge BEFORE local wall-avoidance steering
      if (threats.dodgeUrgency > 0.6) {
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
        const steerTarget: Vec3 = [x + move[0] * 6, y + move[1] * 6, waypoint ? waypoint[2] : z]
        move = computeLocalSteer(world, me.pos, steerTarget, maxSlopeDeg)
      }

      // Stuck detection & recovery (works even during preferSilent; latches escape side)
      const moveMag = Math.hypot(move[0], move[1])
      const speed2d = Math.hypot(me.vel[0], me.vel[1])
      if (moveMag > 0.25 && speed2d < 1.2) {
        stuckTicks++
        if (stuckTicks === 6) {
          stuckSide = obs.tick % 2 === 0 ? 1 : -1
          cachedPath = []
        }
        if (stuckTicks >= 6) {
          if (me.grounded && !order.preferSilent) jump = true
          if (me.energy > 20 && !order.preferSilent) boost = true
          const ang = Math.atan2(move[1], move[0]) + stuckSide * 1.15
          move = [Math.cos(ang), Math.sin(ang)]
        }
      } else {
        stuckTicks = 0
      }

      // Silent movement cap in 1v15 Practice ONLY when unspotted & not dodging
      if (
        order.preferSilent &&
        threats.dodgeUrgency < 0.2 &&
        me.in_zone &&
        moveMag > 1e-4
      ) {
        const walkSpeed = me.stats.walk_speed ?? 11.7
        const silentFrac = Math.min(1, (stepSpeed * 0.88) / Math.max(1, walkSpeed))
        move = [(move[0] / moveMag) * silentFrac, (move[1] / moveMag) * silentFrac]
        boost = false
      } else if (
        !order.preferSilent &&
        (!me.in_zone || (order.mode === "zone_sprint" && me.energy > 45)) &&
        me.energy > 18
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
        `v2 ${order.mode} ffa=${threats.ffaConfidence.toFixed(2)} hp=${me.hp.toFixed(0)}`,
      )

      return act
    },
  }
})
