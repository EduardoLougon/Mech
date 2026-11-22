import type { Config, Observation, UpgradeDef, WeaponKind } from "../mechfight.ts"

const BASE_UPGRADE_SCORES: Record<string, number> = {
  nanites: 145,
  armor: 122,
  plating: 121,
  servos: 108,
  sensors: 106,
  gyros: 96,
  reactor: 92,
  jets: 90,
  capacitor: 82,
}

const WEAPON_UPGRADE_SCORES: Record<string, { weapon: WeaponKind; score: number }> = {
  laser_charge: { weapon: "laser", score: 124 },
  laser_damage: { weapon: "laser", score: 119 },
  laser_pierce: { weapon: "laser", score: 95 },
  lightning_range: { weapon: "lightning", score: 120 },
  lightning_chain: { weapon: "lightning", score: 108 },
  lightning_efficiency: { weapon: "lightning", score: 106 },
  gun_damage: { weapon: "gun", score: 112 },
  gun_rate: { weapon: "gun", score: 102 },
  gun_mag: { weapon: "gun", score: 99 },
  gun_velocity: { weapon: "gun", score: 93 },
  mortar_reload: { weapon: "mortar", score: 96 },
  mortar_splash: { weapon: "mortar", score: 95 },
  mortar_velocity: { weapon: "mortar", score: 91 },
}

const WEAPON_FALLBACK_BONUS: Record<WeaponKind, number> = {
  laser: 18,
  lightning: 16,
  gun: 10,
  mortar: 8,
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

  let score = 50
  const weaponEntry = WEAPON_UPGRADE_SCORES[choiceId]

  if (weaponEntry) {
    const reqWeapon = def?.requires ?? weaponEntry.weapon
    score = heldWeapons.has(reqWeapon) ? weaponEntry.score : 20
  } else if (def?.requires) {
    score = heldWeapons.has(def.requires) ? 84 + WEAPON_FALLBACK_BONUS[def.requires] : 20
  } else if (choiceId in BASE_UPGRADE_SCORES) {
    score = BASE_UPGRADE_SCORES[choiceId]
  } else if (def) {
    // Score unknown general upgrades by their effect paths
    for (const eff of def.effects) {
      if (eff.path.includes("regen")) score += 55
      else if (eff.path.includes("armor") || eff.path.includes("damage_taken")) score += 45
      else if (eff.path.includes("hp")) score += 38
      else if (eff.path.includes("speed")) score += 30
      else if (eff.path.includes("turn")) score += 24
      else if (eff.path.includes("vision") || eff.path.includes("sensor")) score += 22
      else if (eff.path.includes("energy") || eff.path.includes("jet")) score += 20
    }
  } else {
    // Fallback heuristic on id/name/desc if not in config.upgrades
    const text = `${choiceId} ${choiceName} ${choiceDesc}`.toLowerCase()
    if (text.includes("nanite") || text.includes("regen")) score = 145
    else if (text.includes("armor") || text.includes("damage taken")) score = 122
    else if (text.includes("plating") || text.includes("hp") || text.includes("health")) score = 121
    else if (text.includes("servo") || text.includes("speed") || text.includes("move")) score = 108
    else if (text.includes("sensor") || text.includes("vision") || text.includes("proximity")) score = 106
    else if (text.includes("gyro") || text.includes("turn")) score = 96
    else if (text.includes("reactor")) score = 92
    else if (text.includes("jet")) score = 90
    else if (text.includes("capacitor") || text.includes("energy")) score = 82
    else {
      for (const w of heldWeapons) {
        if (text.includes(w)) {
          score = 84 + WEAPON_FALLBACK_BONUS[w]
          break
        }
      }
    }
  }

  // S+ tier first-stack bonus for nanites (2 stacks -> 2.0s regen delay at 115 HP/s)
  if (choiceId === "nanites" && taken === 0) {
    score += 5
  }

  // Armor multiplies EHP of rapid nanite healing (+6 if already holding nanites -> 128)
  if (choiceId === "armor" && (takenCounts.get("nanites") ?? 0) > 0) {
    score += 6
  }

  // First stack of sensors unlocks huge early-warning vision & proximity detection (+6 -> 112)
  if (choiceId === "sensors" && taken === 0) {
    score += 6
  }

  // Never pick an already-maxed upgrade over an available one
  if (def && def.max > 0 && taken >= def.max) {
    score -= 1000
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
