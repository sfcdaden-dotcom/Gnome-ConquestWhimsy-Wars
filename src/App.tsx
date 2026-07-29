/**
 * Whimsy Wars — app shell and screen router.
 *
 * Home is the entry point: local play, online play, or the rules. The local
 * path is unchanged (setup → game, "play again" remounts with a fresh seed);
 * the online path hands off to OnlineScreen, which owns its own room socket.
 */

import { useState } from 'react';
import type { CreateGameOptions } from './engine';
import { GameScreen } from './ui/GameScreen';
import { HomeScreen } from './ui/HomeScreen';
import type { HomeChoice } from './ui/HomeScreen';
import { OnlineScreen } from './ui/OnlineScreen';
import { RulesScreen } from './ui/RulesScreen';
import { SetupScreen } from './ui/SetupScreen';
import { useGame } from './ui/useGame';
import { randomSeed } from './ui/meta';

type Screen = 'home' | 'local' | 'online' | 'rules';

interface Session {
  options: CreateGameOptions;
  seed: number;
  run: number;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [session, setSession] = useState<Session | null>(null);

  if (screen === 'rules') return <RulesScreen onBack={() => setScreen('home')} />;
  if (screen === 'online') return <OnlineScreen onBack={() => setScreen('home')} />;

  if (screen === 'local') {
    if (!session) {
      return (
        <SetupScreen
          onStart={({ options, seed }) => setSession({ options, seed, run: 0 })}
          onBack={() => setScreen('home')}
        />
      );
    }
    return (
      <LocalGame
        key={`${session.run}-${session.seed}`}
        options={session.options}
        seed={session.seed}
        onPlayAgain={() =>
          setSession((s) => (s ? { ...s, seed: randomSeed(), run: s.run + 1 } : s))
        }
        onQuit={() => setSession(null)}
      />
    );
  }

  return (
    <HomeScreen
      onChoose={(choice: HomeChoice) => {
        setSession(null);
        setScreen(choice);
      }}
    />
  );
}

/**
 * A local session: `useGame` must be called from a component, and remounting
 * this one (via `key`) is what "play again" means — a fresh engine state
 * rather than a reset of the old one.
 */
function LocalGame({
  options,
  seed,
  onPlayAgain,
  onQuit,
}: {
  options: CreateGameOptions;
  seed: number;
  onPlayAgain: () => void;
  onQuit: () => void;
}) {
  const game = useGame(options, seed);
  return <GameScreen game={game} onPlayAgain={onPlayAgain} onQuit={onQuit} />;
}
