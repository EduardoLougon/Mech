import type { Config, Observation, UpgradeDef, WeaponKind } from "../mechfight.ts"

const BASE_UPGRADE_SCORES: Record<string, number> = {
  armor: 110,
  sensors: 98,
  hp: 94,
  speed: 90,
  energy: 76,
}

const WEAPON_TIER_BONUS: Record<WeaponKind, number> = {
  laser: 10,
  mortar: 8,
  lightning: 8,
  gun: 4,
}

/**
 * Score a single upgrade choice given the bot config, held weapons, and already-taken upgrades.
 */
function scoreChoice(
  choiceId: string,
  choiceName: string,
  choiceDesc: string,
  heldWeapons: Set<WeaponKind>,
  upgradeDefs: Map<string, UpgradeDef>,
  takenCounts: Map<string, number>,
): number {
  const def = upgradeDefs.get(choiceId)
  const taken = takenCounts.get(choiceId) ?? 0

  // Start with explicit base tier score if known
  let score = BASE_UPGRADE_SCORES[choiceId] ?? 50

  if (def) {
    // Penalize slightly if near max stacks so we diversify when tied, though strong stats remain strong
    if (def.max > 0 && taken >= def.max) {
      score -= 1000
    }

    if (def.requires) {
      if (heldWeapons.has(def.requires)) {
        // Weapon-specific upgrade for a weapon we actually hold
        score = 78 + WEAPON_TIER_BONUS[def.requires]
      } else {
        // We don't hold the required weapon right now
        score = 20
      }
    } else if (!(choiceId in BASE_UPGRADE_SCORES)) {
      // Score unknown general upgrades by their effect paths
      for (const eff of def.effects) {
        if (eff.path.includes("armor") || eff.path.includes("damage_taken")) score += 40
        else if (eff.path.includes("vision") || eff.path.includes("sensor")) score += 32
        else if (eff.path.includes("hp")) score += 28
        else if (eff.path.includes("speed")) score += 24
        else if (eff.path.includes("energy")) score += 18
      }
    }
  } else {
    // Fallback heuristic on id/name/desc if not in config.upgrades
    const text = `${choiceId} ${choiceName} ${choiceDesc}`.toLowerCase()
    if (text.includes("armor") || text.includes("damage taken")) score = 110
    else if (text.includes("sensor") || text.includes("vision") || text.includes("proximity")) score = 98
    else if (text.includes("hp") || text.includes("health")) score = 94
    else if (text.includes("speed") || text.includes("move")) score = 90
    else if (text.includes("energy")) score = 76
    else {
      for (const w of heldWeapons) {
        if (text.includes(w)) {
          score = 78 + WEAPON_TIER_BONUS[w]
          break
        }
      }
    }
  }

  // Slight preference for first stack of top-tier utility upgrades (e.g., sensors)
  if (choiceId === "sensors" && taken === 0) {
    score += 4
  }

  return score
}

/**
 * Select the best upgrade index from `obs.offer` if an offer is currently active.
 */
export function pickUpgrade(obs: Observation, config: Config): number | undefined {
  if (!obs.offer || obs.offer.choices.length === 0) {
    return undefined
  }

  const upgradeDefs = new Map<string, UpgradeDef>()
  for (const def of config.upgrades) {
    upgradeDefs.set(def.id, def)
  }

  const heldWeapons = new Set<WeaponKind>()
  for (const w of obs.self.weapons) {
    if (w) heldWeapons.add(w.kind)
  }

  const takenCounts = new Map<string, number>()
  for (const id of obs.self.upgrades) {
    takenCounts.set(id, (takenCounts.get(id) ?? 0) + 1)
  }

  let bestIdx = 0
  let bestScore = -Infinity

  for (let i = 0; i < obs.offer.choices.length; i++) {
    const choice = obs.offer.choices[i]
    const score = scoreChoice(
      choice.id,
      choice.name,
      choice.desc,
      heldWeapons,
      upgradeDefs,
      takenCounts,
    )
    if (score > bestScore) {
      bestScore = score
      bestIdx = i
    }
  }

  return bestIdx
}
