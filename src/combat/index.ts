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
  return {
    act(obs, world, threats, order): Partial<BotAction> {
      const weaponAct = chooseWeaponAction(obs, config, world, threats, order)
      const lootAct = chooseLootAction(obs, config, order)
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
