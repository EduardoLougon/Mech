import { type BotAction, draw, log, type Observation, run } from "./mechfight.ts"

const dist2 = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(b[0] - a[0], b[1] - a[1])

const UPGRADE_PRIORITY = [
  "armor",
  "sensors",
  "hp",
  "speed",
  "energy",
  "laser_damage",
  "laser_charge",
  "mortar_damage",
  "lightning_damage",
  "gun_rate",
  "gun_damage",
]

run((hello) => {
  const cfg = hello.config
  log(`Anchor bot initialized on slot ${hello.slot}, map=${hello.map.dir}`)

  return {
    name: "mech-hydra-v0",
    act(obs: Observation): BotAction {
      const me = obs.self
      const [x, y, z] = me.pos
      const goal = obs.zone.next_center
      const yawToGoal = Math.atan2(goal[1] - y, goal[0] - x)

      const act: BotAction = {
        move: [Math.cos(yawToGoal), Math.sin(yawToGoal)],
        aim: [yawToGoal, 0],
        boost: !me.in_zone && me.energy > 20,
        jump: false,
      }

      if (obs.offer) {
        let bestIdx = 0
        let bestRank = Infinity
        for (let i = 0; i < obs.offer.choices.length; i++) {
          const rank = UPGRADE_PRIORITY.indexOf(obs.offer.choices[i].id)
          const score = rank === -1 ? 99 : rank
          if (score < bestRank) {
            bestRank = score
            bestIdx = i
          }
        }
        act.pick = bestIdx
      }

      const nearPickup = obs.pickups.find(
        (p) =>
          dist2(p.pos, me.pos) < cfg.loot.pickup_radius &&
          Math.abs(p.pos[2] - z) < 4 &&
          p.kind !== "gun",
      )
      if (!me.weapons[1] && nearPickup) {
        act.take = nearPickup.id
      }

      const enemy = obs.mechs
        .filter((m) => m.kind === "mech")
        .sort((a, b) => dist2(a.pos, me.pos) - dist2(b.pos, me.pos))[0]

      if (enemy) {
        const t = enemy.pos
        const d = dist2(t, me.pos)
        act.aim = [
          Math.atan2(t[1] - y, t[0] - x),
          Math.atan2(t[2] + 4.5 - (z + 7), Math.max(1, d)),
        ]
        act.fire = [true, true]
        draw.line([x, y, z + 7], [t[0], t[1], t[2] + 4.5], "#ff5040")
      }

      draw.label(`v0 hp=${me.hp.toFixed(0)}`)
      return act
    },
  }
})
