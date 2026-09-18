/**
 * The UI laboratory — every piece of Whimsy Wars' visual vocabulary on one
 * page, reached at `?ui=preview` in a dev build.
 *
 * WHY: evaluating a CSS or art change used to mean starting a four-player game
 * and navigating to whichever screen showed the thing you changed. Half the
 * states worth looking at (a fight mid-round, an eliminated seat, five active
 * curses) took real effort to reach at all. This page puts all of them side by
 * side so a change can be judged in one refresh.
 *
 * TWO RULES, both deliberate:
 *
 *  1. It renders PRODUCTION components and PRODUCTION classes — never a
 *     look-alike. A mock-up would drift from the real thing and quietly start
 *     lying, which would make it worse than nothing. Where a component needs
 *     game state, it gets a fixture (`fixtures.ts`), not a modified component.
 *
 *  2. It restyles NOTHING. Its own chrome is prefixed `uip-` and is kept as
 *     plain as it can be, because the page's job is to show the current visual
 *     system honestly — inconsistencies very much included. Anything on this
 *     page that looks wrong IS wrong, and that is the point.
 *
 * Dev-only: App.tsx reaches it behind `import.meta.env.DEV`, so the branch is
 * dead code in a production build and this module is dropped from the bundle.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { CardId, CardTiming, GardenType } from '../../engine';
import { CARD_DEFINITIONS, CURSE_DEFINITIONS, PLANTABLE_GARDEN_TYPES } from '../../engine';
import { Board } from '../Board';
import { boardPixelSize } from '../boardGeometry';
import { CursePanel } from '../GameScreen';
import { PanZoom } from '../PanZoom';
import { DecisionPanel } from '../DecisionPanel';
import { FightPanel, GameLogView, HandPanel, PlayerPanels } from '../panels';
import { ChatPanel } from '../QuickChat';
import { AdvancedSettings } from '../AdvancedSettings';
import { DEFAULT_ADVANCED_SETTINGS } from '../advancedSettings';
import { GardenIcon, UnitIcon } from '../art';
import { GARDEN_META, PLAYER_COLOR_NAMES } from '../meta';
import { GnomeLooksContext } from '../gnomeLooks';
import {
  PREVIEW_SELECTED_KEY,
  cursedFixture,
  decisionFixtures,
  fightFixture,
  previewHighlights,
  previewLooks,
  previewState,
} from './fixtures';
// The page's own chrome, pulled in as a STRING rather than as a stylesheet.
//
// `import './preview.css'` would work in dev and then quietly ship: a CSS
// import is a side effect, so Rollup keeps it in the production stylesheet
// even once this module itself has been tree-shaken away (measured — it put 37
// dead `uip-` rules in the bundle). As `?raw` it is just a string in a module
// nothing reachable imports, so it goes when the module goes.
import previewCss from './preview.css?raw';

// ---------------------------------------------------------------------------
// Page chrome
// ---------------------------------------------------------------------------

const SECTIONS = [
  ['type', 'Typography'],
  ['buttons', 'Buttons'],
  ['controls', 'Form controls'],
  ['icons', 'Icons & resources'],
  ['gardens', 'Garden art'],
  ['board', 'Board & zoom'],
  ['players', 'Player panels'],
  ['hand', 'Hand & cards'],
  ['decisions', 'Decision panels'],
  ['fight', 'Fight panel'],
  ['curses', 'Curses & tooltip'],
  ['chat', 'Chat & game log'],
  ['modal', 'Modal'],
] as const;

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section className="uip-section" id={id}>
      <h2 className="uip-h2">{title}</h2>
      {note && <p className="uip-note">{note}</p>}
      {children}
    </section>
  );
}

/** A labelled specimen. The label is preview chrome; the content is the game. */
function Item({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`uip-item${wide ? ' wide' : ''}`}>
      <div className="uip-label">{label}</div>
      <div className="uip-stage">{children}</div>
    </div>
  );
}

/**
 * A type specimen that reads its own computed style back off the DOM.
 *
 * This is the one place the preview goes beyond "render it and look" — the
 * whole point of the typography section is to expose that the game currently
 * has ~25 distinct font sizes with no scale behind them, and that is far
 * easier to see as a column of numbers than by squinting.
 */
function TypeSpec({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [spec, setSpec] = useState('');
  useEffect(() => {
    const el = ref.current?.firstElementChild as HTMLElement | null;
    if (!el) return;
    const cs = getComputedStyle(el);
    setSpec(`${cs.fontSize} · weight ${cs.fontWeight} · lh ${cs.lineHeight}`);
  }, []);
  return (
    <div className="uip-type-row">
      <div className="uip-type-sample" ref={ref}>
        {children}
      </div>
      <div className="uip-type-meta">
        <code>{label}</code>
        <span className="uip-spec">{spec}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function UiPreview() {
  const looks = previewLooks();
  const state = previewState();
  const fight = fightFixture();
  const cursed = cursedFixture();
  const decisions = decisionFixtures();
  const boardPx = boardPixelSize(state.config.boardSize);

  const [modalOpen, setModalOpen] = useState(false);
  const [stepper, setStepper] = useState(3);
  const [checked, setChecked] = useState(true);
  const noop = () => {};

  return (
    <GnomeLooksContext value={looks}>
      <style>{previewCss}</style>
      <div className="uip">
        <header className="uip-head">
          <div>
            <h1 className="uip-h1">Whimsy Wars — UI laboratory</h1>
            <p className="uip-note">
              Every production component and class in one place, rendered from fixtures. Nothing here is
              restyled: this is the current visual system exactly as the game draws it. Dev build only.
            </p>
          </div>
          <nav className="uip-nav">
            {SECTIONS.map(([id, label]) => (
              <a key={id} href={`#${id}`}>
                {label}
              </a>
            ))}
          </nav>
        </header>

        {/* --------------------------------------------------------------- */}
        <Section
          id="type"
          title="Typography"
          note="Each specimen is the real class from index.css, with its computed size read back off the DOM."
        >
          <div className="uip-panel">
            <TypeSpec label=".game-title">
              <h1 className="game-title">Whimsy Wars</h1>
            </TypeSpec>
            <TypeSpec label=".tagline">
              <p className="tagline">Harvest gardens, hoard wishes, and gnome your enemies into the compost.</p>
            </TypeSpec>
            <TypeSpec label="h1">
              <h1>Heading level 1</h1>
            </TypeSpec>
            <TypeSpec label="h2">
              <h2>Heading level 2</h2>
            </TypeSpec>
            <TypeSpec label=".panel-title">
              <div className="panel-title">Panel title</div>
            </TypeSpec>
            <TypeSpec label=".decision-panel .panel-title">
              <div className="decision-panel">
                <div className="panel-title">Decision panel title (overrides the rule above)</div>
              </div>
            </TypeSpec>
            <TypeSpec label="body">
              <p>Body text — the default the whole interface is set in.</p>
            </TypeSpec>
            <TypeSpec label=".small">
              <p className="small">Small text, used for secondary controls and captions.</p>
            </TypeSpec>
            <TypeSpec label=".muted">
              <p className="muted">Muted text — descriptions and explanatory lines.</p>
            </TypeSpec>
            <TypeSpec label=".muted.small">
              <p className="muted small">Muted small — by far the most-used secondary style.</p>
            </TypeSpec>
            <TypeSpec label=".seed-tag">
              <span className="seed-tag">seed 40213 · monospace</span>
            </TypeSpec>
            <TypeSpec label=".setup-label">
              <span className="setup-label">Setup row label</span>
            </TypeSpec>
          </div>
        </Section>

        {/* --------------------------------------------------------------- */}
        <Section id="buttons" title="Buttons" note="Every .btn modifier and state that index.css defines.">
          <div className="uip-panel uip-row">
            <button type="button" className="btn">
              Default
            </button>
            <button type="button" className="btn accent">
              Accent (primary)
            </button>
            <button type="button" className="btn accent big">
              Accent big
            </button>
            <button type="button" className="btn ghost">
              Ghost
            </button>
            <button type="button" className="btn warn">
              Warn (destructive)
            </button>
            <button type="button" className="btn small">
              Small
            </button>
            <button type="button" className="btn" disabled>
              Disabled
            </button>
            <button type="button" className="btn accent" disabled>
              Accent disabled
            </button>
            <button type="button" className="btn small chip">
              Chip
            </button>
            <button type="button" className="btn small chip on" aria-pressed="true">
              Chip selected
            </button>
            <button type="button" className="btn btn-icon" aria-label="Icon button">
              ⚙️
            </button>
          </div>
        </Section>

        {/* --------------------------------------------------------------- */}
        <Section
          id="controls"
          title="Form controls"
          note="Inputs, selects, the numeric stepper and a checkbox — each with the class its real screen uses."
        >
          <div className="uip-panel uip-row">
            <label className="uip-field">
              <span className="uip-label">.seed-input</span>
              <input className="seed-input" defaultValue="gnome-town" aria-label="Seed" />
            </label>
            <label className="uip-field">
              <span className="uip-label">.preset-select</span>
              <select className="preset-select" defaultValue="a" aria-label="Preset">
                <option value="a">Scattered gardens</option>
                <option value="b">Orchard</option>
              </select>
            </label>
            <label className="uip-field">
              <span className="uip-label">.field input</span>
              <div className="field">
                <input defaultValue="Bramblewick" aria-label="Name" />
              </div>
            </label>
            <div className="uip-field">
              <span className="uip-label">.stepper</span>
              <div className="stepper">
                <button type="button" className="btn small" onClick={() => setStepper((n) => n - 1)}>
                  −
                </button>
                <input
                  className="stepper-input"
                  type="number"
                  value={stepper}
                  aria-label="Starting wishes"
                  onChange={(e) => setStepper(Number(e.target.value))}
                />
                <button type="button" className="btn small" onClick={() => setStepper((n) => n + 1)}>
                  +
                </button>
              </div>
            </div>
            <div className="uip-field">
              <span className="uip-label">checkbox (.ff-toggle)</span>
              <label className="ff-toggle">
                <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
                Fast CPU
              </label>
            </div>
          </div>
        </Section>

        {/* --------------------------------------------------------------- */}
        <Section
          id="icons"
          title="Icons & resources"
          note="The emoji still standing in for resource and status symbols, and where each one is used. These are the candidates for a custom icon set — the board art below is already custom."
        >
          <div className="uip-panel">
            <table className="uip-table">
              <thead>
                <tr>
                  <th>Glyph</th>
                  <th>Means</th>
                  <th>Kind</th>
                  <th>Appears in</th>
                </tr>
              </thead>
              <tbody>
                {RESOURCE_ICONS.map((r) => (
                  <tr key={r.glyph + r.meaning}>
                    <td className="uip-glyph">{r.glyph}</td>
                    <td>{r.meaning}</td>
                    <td className="muted small">{r.kind}</td>
                    <td className="muted small">{r.where}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* --------------------------------------------------------------- */}
        <Section
          id="gardens"
          title="Garden art"
          note="The hand-drawn assets from src/assets/art/Gardens, at review size and at the size the board actually draws them. Swapping any of these is a one-file drop — artAssets.ts is the only place a type is tied to a filename."
        >
          <div className="uip-panel">
            <div className="uip-art-row">
              {(['home', ...PLANTABLE_GARDEN_TYPES] as GardenType[]).map((type) => (
                <figure key={type} className="uip-art">
                  <GardenIcon type={type} className="garden-icon" />
                  <figcaption>
                    <strong>{GARDEN_META[type].label}</strong>
                    <span className="muted small">{GARDEN_META[type].upgradeLabel}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
            <div className="uip-art-row">
              <figure className="uip-art">
                <UnitIcon />
                <figcaption>
                  <strong>Gnome (stock)</strong>
                  <span className="muted small">no seat</span>
                </figcaption>
              </figure>
              <figure className="uip-art">
                <UnitIcon kind="snail" />
                <figcaption>
                  <strong>Snail</strong>
                  <span className="muted small">no custom art</span>
                </figcaption>
              </figure>
              {[0, 1, 2, 3].map((seat) => (
                <figure key={seat} className="uip-art">
                  <UnitIcon owner={seat} />
                  <figcaption>
                    <strong>{PLAYER_COLOR_NAMES[seat]}</strong>
                    <span className="muted small">composited</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        </Section>

        {/* --------------------------------------------------------------- */}
        <Section
          id="board"
          title="Board & zoom"
          note="The real Board on the real PanZoom stage. Every garden type and its upgraded form, all four homes, the centre star, a freshly-planted (faded) garden, a moved (dimmed) gnome, a 3-gnome stack, a two-seat standoff, a snail, all four highlight kinds and the selection ring. The zoom cluster is PanZoom's own."
        >
          <div className="uip-board-frame">
            <PanZoom className="uip-stage" label="Preview board" contentWidth={boardPx} contentHeight={boardPx} maxFitScale={1.4}>
              <Board
                state={state}
                highlights={previewHighlights()}
                selectedKey={PREVIEW_SELECTED_KEY}
                sizePx={boardPx}
                onCellClick={noop}
              />
            </PanZoom>
          </div>
        </Section>

        {/* --------------------------------------------------------------- */}
        <Section
          id="players"
          title="Player panels"
          note="All four seat colours at once: Red is the active turn, Yellow is down to its last reinforcement, Purple is eliminated, Blue is ordinary. Marigold is also flagged as CPU-taken-over."
        >
          <div className="uip-cols">
            <Item label="<PlayerPanels> — left column width">
              <div className="uip-leftcol">
                <PlayerPanels state={state} takenOverSeats={[2]} />
              </div>
            </Item>
          </div>
        </Section>

        {/* --------------------------------------------------------------- */}
        <Section
          id="hand"
          title="Hand & cards"
          note="The real HandPanel in three states, then every card the deck can hold, by category."
        >
          <div className="uip-cols">
            <Item label="<HandPanel> — live, 2 of 3 playable">
              <div className="uip-rightcol">
                <HandPanel
                  state={state}
                  seat={0}
                  playable={new Set<CardId>(['nope-gnome', 'wild-growth'])}
                  onPlay={noop}
                  blocked={null}
                />
              </div>
            </Item>
            <Item label="<HandPanel> — blocked">
              <div className="uip-rightcol">
                <HandPanel
                  state={state}
                  seat={0}
                  playable={new Set<CardId>()}
                  onPlay={noop}
                  blocked="Waiting for the fight to finish."
                />
              </div>
            </Item>
            <Item label="<HandPanel> — hidden (CPU seat)">
              <div className="uip-rightcol">
                <HandPanel state={state} seat={null} playable={new Set<CardId>()} onPlay={noop} blocked={null} />
              </div>
            </Item>
          </div>

          <div className="uip-panel">
            <h3 className="uip-h3">Sudden Magic ({CARD_DEFINITIONS.filter((c) => c.timing === 'sudden').length})</h3>
            <div className="uip-cards">
              {CARD_DEFINITIONS.filter((c) => c.timing === 'sudden').map((c) => (
                <CardSpecimen key={c.id} name={c.name} text={c.text} timing={c.timing} />
              ))}
            </div>
            <h3 className="uip-h3">Ritual Magic ({CARD_DEFINITIONS.filter((c) => c.timing === 'ritual').length})</h3>
            <div className="uip-cards">
              {CARD_DEFINITIONS.filter((c) => c.timing === 'ritual').map((c) => (
                <CardSpecimen key={c.id} name={c.name} text={c.text} timing={c.timing} />
              ))}
            </div>
            <h3 className="uip-h3">Curses ({CURSE_DEFINITIONS.length})</h3>
            <p className="uip-note">
              Curses are never held in hand, so there is no card markup for one — they are revealed straight
              into the Curses panel above.
            </p>
          </div>
        </Section>

        {/* --------------------------------------------------------------- */}
        <Section
          id="decisions"
          title="Decision panels"
          note="The panel that should dominate the sidebar — it is what tells a player what the game is waiting for."
        >
          <div className="uip-cols">
            {decisions.map((d) => (
              <Item key={d.label} label={`${d.label} — ${d.note}`}>
                <div className="uip-rightcol">
                  <DecisionPanel
                    state={d.state}
                    decision={d.decision}
                    legal={[]}
                    interactive={d.interactive}
                    act={noop}
                    onRespondCard={noop}
                  />
                </div>
              </Item>
            ))}
          </div>
        </Section>

        {/* --------------------------------------------------------------- */}
        <Section
          id="fight"
          title="Fight panel"
          note="Round 2 of a live fight, with a response window open for Blue. The clash shows each side's own art and the roll each of them made."
        >
          <div className="uip-cols">
            <Item label="<FightPanel> — interactive">
              <div className="uip-rightcol">
                <FightPanel state={fight} interactive poofs={[]} onPass={noop} onPlayCard={noop} />
              </div>
            </Item>
            <Item label="<FightPanel> — watching">
              <div className="uip-rightcol">
                <FightPanel state={fight} interactive={false} poofs={[]} onPass={noop} onPlayCard={noop} />
              </div>
            </Item>
          </div>
        </Section>

        {/* --------------------------------------------------------------- */}
        <Section
          id="curses"
          title="Curses & tooltip"
          note="All five curses revealed. Hover or focus a row for the game's only real tooltip — it is position: fixed and placed from the row's rect."
        >
          <div className="uip-cols">
            <Item label="<CursePanel> + tooltip">
              <div className="uip-leftcol">
                <CursePanel state={cursed} />
              </div>
            </Item>
          </div>
        </Section>

        {/* --------------------------------------------------------------- */}
        <Section
          id="chat"
          title="Chat & game log"
          note="One window with two tabs. It defaults to expanded and takes the rest of the sidebar's height — click Hide ▾ to see the collapsed form, and the Game Log tab for the transcript beside it."
        >
          <div className="uip-cols">
            <Item label="<ChatPanel> — click Hide ▾ / the Game Log tab">
              <div className="uip-rightcol tall">
                <ChatPanel state={state} seat={0} disabled={false} muted={false} onToggleMute={noop} onSay={noop} />
              </div>
            </Item>
            <Item label="<ChatPanel> — read-only (no seat), muted">
              <div className="uip-rightcol tall">
                <ChatPanel state={state} seat={null} disabled muted onToggleMute={noop} onSay={noop} />
              </div>
            </Item>
            <Item label="<GameLogView> on its own">
              <div className="uip-rightcol tall">
                <GameLogView state={state} />
              </div>
            </Item>
          </div>
        </Section>

        {/* --------------------------------------------------------------- */}
        <Section
          id="modal"
          title="Modal"
          note="The game's one modal pattern (.overlay + .overlay-card), shown by the real Advanced settings screen — which also holds the deck and garden-budget editors."
        >
          <div className="uip-panel uip-row">
            <button type="button" className="btn accent" onClick={() => setModalOpen(true)}>
              Open the advanced-settings modal
            </button>
          </div>
        </Section>

        {modalOpen && (
          <AdvancedSettings
            value={DEFAULT_ADVANCED_SETTINGS}
            onApply={() => setModalOpen(false)}
            onCancel={() => setModalOpen(false)}
          />
        )}

        <footer className="uip-foot">
          <p className="muted small">
            Dev-only page. Add <code>?ui=preview</code> to the dev server's address to reach it; it is not built
            into a production bundle.
          </p>
        </footer>
      </div>
    </GnomeLooksContext>
  );
}

/**
 * One card, in exactly the markup `HandPanel` gives it — the timing class on
 * the root, the head row with its name and timing tag, the rules text and the
 * Play button — so the gallery and a real hand cannot drift apart.
 */
function CardSpecimen({ name, text, timing }: { name: string; text: string; timing: CardTiming }) {
  return (
    <div className={`card ${timing}`}>
      <div className="card-head">
        <span className="card-name">{name}</span>
        <span className="card-timing">{timing === 'sudden' ? '⚡ Sudden' : '🕯️ Ritual'}</span>
      </div>
      <div className="card-text">{text}</div>
      <button type="button" className="btn small">
        Play
      </button>
    </div>
  );
}

/**
 * The emoji inventory, written down rather than derived: the point of the
 * table is the EDITORIAL judgement in the last two columns — which of these
 * are game objects wanting custom art, and which are interface symbols that a
 * custom drawing would only make harder to recognise.
 */
const RESOURCE_ICONS: Array<{ glyph: string; meaning: string; kind: string; where: string }> = [
  { glyph: '✨', meaning: 'Wishes', kind: 'resource', where: 'panels, meta, GameScreen, DecisionPanel (10 sites)' },
  { glyph: '📦', meaning: 'Reserve gnomes (reinforcements)', kind: 'resource', where: 'panels' },
  { glyph: '🃏', meaning: 'Cards in hand', kind: 'resource', where: 'panels, GameScreen' },
  { glyph: '⭐', meaning: 'Centre Star, and an upgraded garden’s badge', kind: 'game object', where: 'Board, meta, SetupScreen' },
  { glyph: '💫', meaning: 'Flytrap stunned', kind: 'game object', where: 'Board' },
  { glyph: '🌱', meaning: 'Plant a garden — but also “Start the war” and the garden-budget editor', kind: 'overloaded', where: 'GameScreen, SetupScreen, DecisionPanel, AdvancedSettings' },
  { glyph: '⚡', meaning: 'Sudden Magic (card timing)', kind: 'category', where: 'panels' },
  { glyph: '🕯️', meaning: 'Ritual Magic (card timing)', kind: 'category', where: 'panels' },
  { glyph: '⚔️', meaning: 'Fight', kind: 'status', where: 'panels, meta' },
  { glyph: '💀', meaning: 'Eliminated', kind: 'status', where: 'panels, meta, DecisionPanel' },
  { glyph: '☠️', meaning: 'Curse revealed / Magic Drain', kind: 'status', where: 'GameScreen, meta, DecisionPanel' },
  { glyph: '🏆', meaning: 'Winner', kind: 'status', where: 'GameScreen, meta' },
  { glyph: '🍂', meaning: 'Draw — no winner', kind: 'status', where: 'GameScreen' },
  { glyph: '🧑', meaning: 'Human seat', kind: 'interface', where: 'panels, SetupScreen' },
  { glyph: '🤖', meaning: 'CPU seat', kind: 'interface', where: 'panels, SetupScreen, useNetGame' },
  { glyph: '🎲', meaning: 'Roll / re-roll', kind: 'interface', where: 'DecisionPanel, SetupScreen, GnomeCreator' },
  { glyph: '⏩', meaning: 'Fast-forward the CPU', kind: 'interface', where: 'GameScreen' },
  { glyph: '⚙️', meaning: 'Advanced settings', kind: 'interface', where: 'SetupScreen, AdvancedSettings' },
];

/**
 * A gnome on the board is NOT in the table above: `PlayerPanels` already draws
 * it with `<UnitIcon>`, i.e. the seat's own composited art. Gardens, units and
 * the death poofs went custom the same way (see `artAssets.ts` / `fxAssets.ts`
 * and the Art section of README.md). What is left here is everything that
 * never made that move.
 */
