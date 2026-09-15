/**
 * Whimsy Wars — app shell and screen router.
 *
 * Home is the entry point: local play, online play, or the rules. The local
 * path is unchanged (setup → game, "play again" remounts with a fresh seed);
 * the online path hands off to OnlineScreen, which owns its own room socket.
 *
 * The one address the app answers to is a room: `?room=CODE` opens straight
 * into online play, which is what makes an invite link work and what lets a
 * player reload the page without losing the table (see netClient.ts). Adding
 * `&view=board` opens the same room as the screen in the MIDDLE of the room —
 * a TV or a projector with no hand and no controls (see BoardView.tsx). It is
 * checked before anything else because it is the one screen nobody is standing
 * at: a reload must put the board back, not a menu.
 */

import { useState } from 'react';
import { isBoardView, roomCodeFromSearch } from './ui/netClient';
import { BoardView } from './ui/BoardView';
import type { CreateGameOptions } from './engine';
import { GameScreen } from './ui/GameScreen';
import { HomeScreen } from './ui/HomeScreen';
import type { HomeChoice } from './ui/HomeScreen';
import { OnlineScreen } from './ui/OnlineScreen';
import { RulesScreen } from './ui/RulesScreen';
import { SetupScreen } from './ui/SetupScreen';
import { useGame } from './ui/useGame';
import { GnomeLooksContext } from './ui/gnomeLooks';
import type { GnomeLook } from './ui/gnomeLook';
import { randomSeed } from './ui/meta';

type Screen = 'home' | 'local' | 'online' | 'rules';

interface Session {
  options: CreateGameOptions;
  seed: number;
  run: number;
  /** Each seat's gnome, by seat index. Survives "play again" — rebuilding
   *  four characters between rounds is not what anyone wants. */
  looks: GnomeLook[];
}

export default function App() {
  const [screen, setScreen] = useState<Screen>(() =>
    roomCodeFromSearch(window.location.search) ? 'online' : 'home',
  );
  const [session, setSession] = useState<Session | null>(null);

  // Settled from the address once, on the way in. A board view has no menu to
  // go back to and no way to leave — it is a screen on a wall, and the way to
  // close it is to close the tab.
  const [boardRoom] = useState<string | null>(() =>
    isBoardView(window.location.search) ? roomCodeFromSearch(window.location.search) : null,
  );
  if (boardRoom) return <BoardView code={boardRoom} />;

  if (screen === 'rules') return <RulesScreen onBack={() => setScreen('home')} />;
  if (screen === 'online') return <OnlineScreen onBack={() => setScreen('home')} />;

  if (screen === 'local') {
    if (!session) {
      return (
        <SetupScreen
          onStart={({ options, seed, looks }) => setSession({ options, seed, looks, run: 0 })}
          onBack={() => setScreen('home')}
        />
      );
    }
    return (
      <LocalGame
        key={`${session.run}-${session.seed}`}
        options={session.options}
        seed={session.seed}
        looks={session.looks}
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
  looks,
  onPlayAgain,
  onQuit,
}: {
  options: CreateGameOptions;
  seed: number;
  looks: GnomeLook[];
  onPlayAgain: () => void;
  onQuit: () => void;
}) {
  const game = useGame(options, seed);
  return (
    <GnomeLooksContext value={looks}>
      <GameScreen game={game} onPlayAgain={onPlayAgain} onQuit={onQuit} />
    </GnomeLooksContext>
  );
}
