import type {
  Config,
  Observation,
  ThreatState,
  WorldQuery,
} from "../contracts.ts"
import { computeDodge } from "./dodge.ts"
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

  function update(obs: Observation, world: WorldQuery): ThreatState {
    const tracked = tracker.update(obs, world)
    const dodge = computeDodge(obs, config, world)

    return {
      enemies: tracked.enemies,
      dodgeVec: dodge.dodgeVec,
      dodgeUrgency: dodge.dodgeUrgency,
      wantJump: false,
      chargingLaserThreat: false,
      primaryThreatBearing: tracked.primaryThreatBearing,
      spottedByCount: tracked.spottedByCount,
      ffaConfidence: tracked.ffaConfidence,
    }
  }

  return { update }
}

export { computeDodge } from "./dodge.ts"
export { createTracker } from "./tracker.ts"

