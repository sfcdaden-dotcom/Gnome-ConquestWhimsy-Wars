/**
 * The launch screen: pick how you're playing before anything else loads.
 *
 * Three doors. Local goes to the setup screen the game has always had
 * (hot-seat and CPU, no network at all). Online goes to the room menu. Rules
 * is here rather than buried in a menu because the people most likely to want
 * it are the ones who have not started a game yet.
 *
 * Credits are the one thing here that is not a door: a line of small print
 * that opens a card in place, since this is the only screen that is always
 * on the way in and nobody should have to start a game to find out who made
 * it. Everyone whose work ships in the build belongs in CREDITS below.
 */

import { useEffect, useState } from 'react';
import { GardenIcon, UnitIcon } from './art';

export type HomeChoice = 'local' | 'online' | 'rules';

/** Who made what. One line per credit, in the order they should be read. */
const CREDITS: readonly { what: string; who: string }[] = [
  { what: 'Game', who: 'Daden' },
  { what: 'Poof FX', who: 'BDragon1727' },
];

export function HomeScreen({ onChoose }: { onChoose: (choice: HomeChoice) => void }) {
  const [creditsOpen, setCreditsOpen] = useState(false);
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
            className="btn big primary home-choice"
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

        <button
          type="button"
          className="btn ghost small home-credits-link"
          data-testid="home-credits"
          onClick={() => setCreditsOpen(true)}
        >
          Credits
        </button>
      </div>

      {creditsOpen && <CreditsCard onClose={() => setCreditsOpen(false)} />}
    </div>
  );
}

/**
 * The credits, over the home screen. Escape and the backdrop close it as well
 * as the button does — it answers nothing, so there is no reason to make
 * dismissing it a hunt for the one live control.
 */
function CreditsCard({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    // The backdrop closes on its own clicks only — a click that started inside
    // the card and drifted out (selecting a name) must not count as one.
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Credits"
      data-testid="credits-card"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="overlay-card credits-card">
        <h2 className="credits-title">
          <UnitIcon className="title-art" /> Credits
        </h2>
        <dl className="credits-list">
          {CREDITS.map((c) => (
            <div key={c.what} className="credits-row">
              <dt>{c.what}</dt>
              <dd>{c.who}</dd>
            </div>
          ))}
        </dl>
        <button
          type="button"
          className="btn primary"
          data-testid="credits-close"
          onClick={onClose}
          autoFocus
        >
          Close
        </button>
      </div>
    </div>
  );
}
