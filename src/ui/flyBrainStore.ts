/**
 * The Fly's cross-game memory for this tab.
 *
 * The brain starts as the one shipped with the game
 * (engine/ai/trainedFlyBrain.ts) and learns from each finished game's review.
 * Alongside it the fly keeps its read of each opponent's habits (do they rush
 * its Home, raid its gardens?). Both carry across the games in this tab.
 * Nothing is written to the device, in keeping with DEPLOYMENT.md's
 * no-local-storage posture: a reload forgets them.
 */

import type { FlyBrain, OpponentProfiles } from '../engine';
import { trainedFlyBrain } from '../engine';

let brain: FlyBrain | null = null;
const opponents: OpponentProfiles = new Map();

/** This tab's fly brain, shared by every game played in it. */
export function tabFlyBrain(): FlyBrain {
  brain ??= trainedFlyBrain();
  return brain;
}

/** What the fly has read of each opponent's habits this tab. */
export function tabFlyOpponents(): OpponentProfiles {
  return opponents;
}
