import type { Config, MacroOrder, Observation, ThreatState, WorldQuery } from "../contracts.ts"
import type { BotAction } from "../mechfight.ts"
import { chooseLootAction } from "./loot.ts"
import { chooseWeaponAction, createCombatWeaponState } from "./weapons.ts"

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
  const weaponState = createCombatWeaponState()

  return {
    act(obs, world, threats, order): Partial<BotAction> {
      // Record the pickup ID of a mortar we just dropped due to cookoff/proactive guard so we don't re-take it
      for (const ev of obs.events) {
        if (
          ev.type === "dropped" &&
          ev.kind === "mortar" &&
          obs.tick - lastCookoffDropTick <= 6
        ) {
          cookoffDroppedIds.add(ev.id)
        }
      }

      const weaponAct = chooseWeaponAction(obs, config, world, threats, order, weaponState)
      const lootAct = chooseLootAction(obs, config, threats, order, cookoffDroppedIds, world)

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
export { chooseWeaponAction, createCombatWeaponState } from "./weapons.ts"
export type { CombatWeaponState } from "./weapons.ts"
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
