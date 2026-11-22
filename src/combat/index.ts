import type { Config, MacroOrder, Observation, ThreatState, WorldQuery } from "../contracts.ts"
import type { BotAction } from "../mechfight.ts"
import { chooseLootAction } from "./loot.ts"
import { chooseWeaponAction } from "./weapons.ts"

export interface CombatController {
  act(
    obs: Observation,
    world: WorldQuery,
    threats: ThreatState,
    order: MacroOrder,
  ): Partial<BotAction>
}

export function createCombat(config: Config): CombatController {
  const cookoffDroppedIds = new Set<number>()
  let lastCookoffDropTick = -100

  return {
    act(obs, world, threats, order): Partial<BotAction> {
      // Record the pickup ID of a mortar we just dropped due to cookoff so we don't immediately re-take it
      for (const ev of obs.events) {
        if (
          ev.type === "dropped" &&
          ev.kind === "mortar" &&
          obs.tick - lastCookoffDropTick <= 4
        ) {
          cookoffDroppedIds.add(ev.id)
        }
      }

      const weaponAct = chooseWeaponAction(obs, config, world, threats, order)
      const lootAct = chooseLootAction(obs, config, threats, order, cookoffDroppedIds)

      if (
        lootAct.drop !== undefined &&
        lootAct.take === undefined &&
        obs.self.weapons[lootAct.drop]?.kind === "mortar"
      ) {
        lastCookoffDropTick = obs.tick
      }

      if (lootAct.drop !== undefined && weaponAct.fire) {
        weaponAct.fire[lootAct.drop] = false
      }
      return {
        ...weaponAct,
        ...lootAct,
      }
    },
  }
}

export { chooseLootAction } from "./loot.ts"
export { chooseWeaponAction } from "./weapons.ts"
export {
  aimDiff,
  idleAim,
  isAligned,
  muzzlePos,
  normalizeAngle,
  solveDirectAim,
  solveGunIntercept,
  solveMortarArc,
} from "./aim.ts"
