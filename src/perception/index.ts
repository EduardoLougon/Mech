import type {
  Config,
  Observation,
  ThreatState,
  WorldQuery,
} from "../contracts.ts"
import { createDodge } from "./dodge.ts"
import { createTracker } from "./tracker.ts"

export interface PerceptionModule {
  update(obs: Observation, world: WorldQuery): ThreatState
}

/**
 * Create the perception & threat module for tracking enemies, sound ghosts,
 * incoming projectile/laser dodge vectors, rear-armor threat bearing, and
 * runtime FFA vs 1v15 mode confidence.
 */
export function createPerception(config: Config): PerceptionModule {
  const tracker = createTracker(config)
  const dodge = createDodge(config)

  function update(obs: Observation, world: WorldQuery): ThreatState {
    const tracked = tracker.update(obs, world)
    const dodgeRes = dodge.update(obs, world)

    return {
      enemies: tracked.enemies,
      dodgeVec: dodgeRes.dodgeVec,
      dodgeUrgency: dodgeRes.dodgeUrgency,
      wantJump: dodgeRes.wantJump,
      chargingLaserThreat: dodgeRes.chargingLaserThreat,
      primaryThreatBearing: tracked.primaryThreatBearing,
      spottedByCount: tracked.spottedByCount,
      ffaConfidence: tracked.ffaConfidence,
    }
  }

  return { update }
}

export { createDodge } from "./dodge.ts"
export { createTracker } from "./tracker.ts"
