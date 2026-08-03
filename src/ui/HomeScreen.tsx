/**
 * The launch screen: pick how you're playing before anything else loads.
 *
 * Three doors. Local goes to the setup screen the game has always had
 * (hot-seat and CPU, no network at all). Online goes to the room menu. Rules
 * is here rather than buried in a menu because the people most likely to want
 * it are the ones who have not started a game yet.
 */

import { GardenIcon, UnitIcon } from './art';

export type HomeChoice = 'local' | 'online' | 'rules';

export function HomeScreen({ onChoose }: { onChoose: (choice: HomeChoice) => void }) {
  return (
    <div className="home-screen" data-testid="home-screen">
      <div className="home-card">
        <h1 className="home-title">
          <UnitIcon className="title-art" />
          Whimsy Wars
          <GardenIcon type="dandelion" className="title-art" />
        </h1>
        <p className="home-tagline">
          Harvest gardens, hoard Wishes, and gnome your enemies into the compost.
        </p>

        <div className="home-choices">
          <button
            type="button"
            className="btn big accent home-choice"
            data-testid="home-local"
            onClick={() => onChoose('local')}
          >
            <span className="home-choice-icon">🛋️</span>
            <span className="home-choice-label">Local game</span>
            <span className="home-choice-sub">One device — pass and play, or take on the CPU</span>
          </button>

          <button
            type="button"
            className="btn big home-choice"
            data-testid="home-online"
            onClick={() => onChoose('online')}
          >
            <span className="home-choice-icon">🌐</span>
            <span className="home-choice-label">Online game</span>
            <span className="home-choice-sub">Host a private room, or join a friend's with a code</span>
          </button>

          <button
            type="button"
            className="btn ghost home-choice compact"
            data-testid="home-rules"
            onClick={() => onChoose('rules')}
          >
            <span className="home-choice-icon">📖</span>
            <span className="home-choice-label">How to play</span>
            <span className="home-choice-sub">The full rules, cards and rulings</span>
          </button>
        </div>
      </div>
    </div>
  );
}
