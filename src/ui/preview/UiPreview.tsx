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
import { CARD_DEFINITIONS, CLASSIC_PRESETS, CURSE_DEFINITIONS, MODE_PRESETS, PLANTABLE_GARDEN_TYPES } from '../../engine';
import { Board } from '../Board';
import { boardPixelSize } from '../boardGeometry';
import { CursePanel } from '../GameScreen';
import { PanZoom } from '../PanZoom';
import { DecisionPanel } from '../DecisionPanel';
import { FightPanel, GameLogView, HandPanel, PlayerPanels } from '../panels';
import { ChatPanel } from '../QuickChat';
import { AdvancedSettings } from '../AdvancedSettings';
import { SetupScreen } from '../SetupScreen';
import { DEFAULT_ADVANCED_SETTINGS } from '../advancedSettings';
import { GardenIcon, UiIcon, UnitIcon } from '../art';
import { UI_ICON_GLYPH, UI_ICON_KINDS, UI_ICON_LABEL } from '../uiIcons';
import { GARDEN_META, PLAYER_COLOR_NAMES } from '../meta';
import { unitNameLive } from '../gnomeNames';
import { unitChipLabels } from '../selection';
import { GnomeLooksContext } from '../gnomeLooks';
import {
  PREVIEW_SELECTED_KEY,
  cursedFixture,
  decisionFixtures,
  emptyHandFixture,
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
  ['tokens', 'Colour tokens'],
  ['space', 'Spacing & radius'],
  ['type', 'Typography'],
  ['buttons', 'Buttons'],
  ['surfaces', 'Surfaces'],
  ['sidebar', 'Sidebar'],
  ['setup', 'Setup screen'],
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
    // `data-measure` marks the element the label is about when it has to sit
    // inside a wrapper to get its real style (a title inside its panel);
    // otherwise the sample's own root is measured.
    const root = ref.current;
    const el = (root?.querySelector('[data-measure]') ?? root?.firstElementChild) as HTMLElement | null;
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

/**
 * `?ui=preview&frame=setup` renders the real setup screen and nothing else,
 * for the Setup section's iframes: a phone layout is a VIEWPORT width, which
 * only a frame of that width can give it. `&theme=light|dark` pins the theme.
 */
export function UiPreview() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('frame') === 'setup') return <SetupFrame theme={params.get('theme')} />;
  return <UiLab />;
}

function SetupFrame({ theme }: { theme: string | null }) {
  useEffect(() => {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  }, [theme]);
  return <SetupScreen onStart={() => {}} onBack={() => {}} />;
}

/** Real device sizes for the setup screen frames. */
const SETUP_FRAMES: Array<{ label: string; w: number; h: number; scale: number }> = [
  { label: 'Desktop 1440×900', w: 1440, h: 900, scale: 0.5 },
  { label: 'Phone 390×844', w: 390, h: 844, scale: 0.75 },
  { label: 'Small phone 360×640', w: 360, h: 640, scale: 0.75 },
];

function UiLab() {
  const looks = previewLooks();
  const state = previewState();
  const fight = fightFixture();
  const cursed = cursedFixture();
  const decisions = decisionFixtures();
  const boardPx = boardPixelSize(state.config.boardSize);
  const emptyHand = emptyHandFixture();
  // The seat-0 stack on (3,5): what the action bar shows for a selected gnome.
  const stack = Object.values(state.units).filter((u) => u.pos.x === 3 && u.pos.y === 5);
  const stackChips = unitChipLabels(state, stack);

  const [modalOpen, setModalOpen] = useState(false);
  const [labLayout, setLabLayout] = useState('random');
  const [theme, setTheme] = useState<Theme>('auto');
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = theme;
    return () => {
      delete root.dataset.theme;
    };
  }, [theme]);
  useForcedStates();
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
              restyled: this is the current visual system exactly as the game draws it. The theme switch
              pins <code>data-theme</code> on the page so both palettes can be judged without changing the OS
              setting. Dev build only.
            </p>
          </div>
          <div className="uip-theme" role="group" aria-label="Theme">
            {(['auto', 'light', 'dark'] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={`btn small${theme === t ? ' on' : ''}`}
                aria-pressed={theme === t}
                onClick={() => setTheme(t)}
              >
                {t === 'auto' ? 'Theme: system' : t === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
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
          id="tokens"
          title="Colour tokens"
          note="The semantic palette from :root in index.css, read back off the page so the swatches are whatever the current theme resolves them to. Components use these names, never raw colours."
        >
          <div className="uip-panel">
            {TOKEN_GROUPS.map(([group, tokens]) => (
              <div key={group}>
                <h3 className="uip-h3">{group}</h3>
                <div className="uip-swatches">
                  {tokens.map((t) => (
                    <TokenSwatch key={t} token={t} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* --------------------------------------------------------------- */}
        <Section
          id="space"
          title="Spacing & radius"
          note="The spacing scale and the four radii. Not every component has moved onto them yet — that is Phase 2 — but nothing new should use a value outside them."
        >
          <div className="uip-panel">
            <h3 className="uip-h3">Spacing</h3>
            <div className="uip-space-list">
              {SPACE_TOKENS.map((t) => (
                <div key={t} className="uip-space-row">
                  <code className="uip-label">{t}</code>
                  <span className="uip-space-bar" style={{ width: `var(${t})` }} />
                  <TokenValue token={t} />
                </div>
              ))}
            </div>
            <h3 className="uip-h3">Radius</h3>
            <div className="uip-row">
              {RADIUS_TOKENS.map((t) => (
                <div key={t} className="uip-field">
                  <span className="uip-radius" style={{ borderRadius: `var(${t})` }} />
                  <code className="uip-label">{t}</code>
                  <TokenValue token={t} />
                </div>
              ))}
            </div>
          </div>
        </Section>

        {/* --------------------------------------------------------------- */}
        <Section
          id="type"
          title="Typography"
          note="The eight roles of the type scale, then the production classes that use them. Each specimen's computed size is read back off the DOM."
        >
          <div className="uip-panel">
            <h3 className="uip-h3">The scale</h3>
            <TypeSpec label="--text-display · .t-display, h1">
              <div className="t-display">Whimsy Wars</div>
            </TypeSpec>
            <TypeSpec label="--text-title · .t-title, h2">
              <div className="t-title">Game over — Red wins</div>
            </TypeSpec>
            <TypeSpec label="--text-decision · .t-decision">
              <div className="t-decision">Red: choose the next harvest</div>
            </TypeSpec>
            <TypeSpec label="--text-section · .t-section, h3">
              <div className="t-section">Active Curses</div>
            </TypeSpec>
            <TypeSpec label="--text-body · body">
              <p>Body text — the default the whole interface is set in.</p>
            </TypeSpec>
            <TypeSpec label="--text-label · .small (400), .btn (600)">
              <p className="small">Labels, buttons and explanatory copy under a decision.</p>
            </TypeSpec>
            <TypeSpec label="--text-meta · .meta">
              <p className="meta">Supporting information — the log, card text, deck counts.</p>
            </TypeSpec>
            <TypeSpec label="--text-tiny · .pp-act">
              <span className="pp-act">acting</span>
            </TypeSpec>

            <h3 className="uip-h3">Production classes</h3>
            <TypeSpec label=".game-title">
              <h1 className="game-title">Whimsy Wars</h1>
            </TypeSpec>
            <TypeSpec label=".tagline">
              <p className="tagline">Harvest gardens, hoard wishes, and gnome your enemies into the compost.</p>
            </TypeSpec>
            <TypeSpec label=".banner (current turn)">
              <span className="banner">Turn 4 · Red — Action Phase</span>
            </TypeSpec>
            <TypeSpec label=".decision-panel .panel-title">
              <div className="decision-panel">
                <div className="panel-title" data-measure>
                  Red: roll for turn order
                </div>
                <div className="small muted">Highest roll goes first; ties reroll.</div>
              </div>
            </TypeSpec>
            <TypeSpec label=".decision-panel.waiting .panel-title">
              <div className="decision-panel waiting">
                <div className="panel-title" data-measure>
                  Blue is deciding…
                </div>
              </div>
            </TypeSpec>
            <TypeSpec label=".panel-title">
              <div className="panel-title">Hand</div>
            </TypeSpec>
            <TypeSpec label=".muted.small">
              <p className="muted small">Muted small — explanatory lines under a title.</p>
            </TypeSpec>
            <TypeSpec label=".card-text">
              <div className="card-text">Move one of your gnomes up to 2 extra spaces this turn.</div>
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
        <Section
          id="buttons"
          title="Buttons"
          note="Four treatments — primary, secondary, danger, ghost — in every state. Hover, pressed and focus are forced with a copy of the real :hover / :active / :focus-visible rules (see useForcedStates), so they cannot drift from the stylesheet; the live buttons respond to the mouse and keyboard as well."
        >
          <div className="uip-panel">
            <table className="uip-table uip-btn-table">
              <thead>
                <tr>
                  <th>Treatment</th>
                  {BUTTON_STATES.map((st) => (
                    <th key={st}>{st}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {BUTTON_KINDS.map(([name, cls]) => (
                  <tr key={name}>
                    <td>
                      <code className="uip-label">{name}</code>
                    </td>
                    {BUTTON_STATES.map((st) => (
                      <td key={st}>
                        <button
                          type="button"
                          className={`btn${cls}`}
                          disabled={st === 'disabled'}
                          data-uip-state={st === 'default' || st === 'disabled' ? undefined : st}
                        >
                          {name === 'ghost' ? 'Cancel' : name === 'danger' ? 'Abandon game' : name === 'primary' ? 'Roll the d6' : 'Pass'}
                        </button>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>

            <h3 className="uip-h3">Sizes</h3>
            <div className="uip-row">
              <button type="button" className="btn small">
                .small
              </button>
              <button type="button" className="btn">
                default
              </button>
              <button type="button" className="btn big">
                .big
              </button>
              <button type="button" className="btn primary small">
                .primary.small
              </button>
              <button type="button" className="btn primary big">
                .primary.big
              </button>
            </div>

            <h3 className="uip-h3">Selected (toggle groups)</h3>
            <div className="uip-row">
              <div className="btn-row" role="group" aria-label="Players">
                <button type="button" className="btn on" aria-pressed="true">
                  2 players
                </button>
                <button type="button" className="btn" aria-pressed="false">
                  4 players
                </button>
              </div>
              <div className="btn-row" role="group" aria-label="Board size">
                <button type="button" className="btn small" aria-pressed="false">
                  5×5
                </button>
                <button type="button" className="btn small on" aria-pressed="true">
                  7×7
                </button>
                <button type="button" className="btn small" aria-pressed="false">
                  9×9
                </button>
              </div>
              <div className="btn-row">
                <button type="button" className="btn small chip">
                  Chip
                </button>
                <button type="button" className="btn small chip on" aria-pressed="true">
                  Chip selected
                </button>
              </div>
            </div>

            <h3 className="uip-h3">A decision area: one primary</h3>
            <div className="uip-row">
              <div className="btn-row">
                <button type="button" className="btn ghost">
                  ← Back
                </button>
                <button type="button" className="btn">
                  Stay put
                </button>
                <button type="button" className="btn primary">
                  🐌 Eat the Maize Maze
                </button>
              </div>
            </div>

            <h3 className="uip-h3">Icon labels</h3>
            <div className="uip-row">
              <button type="button" className="btn">
                <UiIcon kind="card" /> Draw card (1 <UiIcon kind="wish" label="Wish" />)
              </button>
              <button type="button" className="btn">
                <UiIcon kind="plant" /> Plant Garden
              </button>
              <button type="button" className="btn small">
                <UiIcon kind="card" /> Edit the deck (40 cards)
              </button>
              <button type="button" className="btn big primary">
                <UiIcon kind="wish" /> Take 1 Wish
              </button>
            </div>
          </div>
        </Section>

        {/* --------------------------------------------------------------- */}
        <Section
          id="surfaces"
          title="Surfaces"
          note="The three kinds of container, as index.css defines them (see the head of its Panels section). The sections below show each kind in its real component; this one pairs a region with a state side by side."
        >
          <div className="uip-panel uip-legend">
            <p>
              <b>A · Strong boundary</b> — kept where the outline says something: cards, a fighter&rsquo;s
              roll, board cells, modals, popovers, inputs, and states (a curse in force, a fight under way,
              targeting, selected).
            </p>
            <p>
              <b>B · Subtle surface</b> — the decision, the hand, the chat window, the action bar, setup and
              lobby rows: a fill against the page, no outline, no shadow.
            </p>
            <p>
              <b>C · No container</b> — headings with their copy, stat rows, button groups (the chat
              window&rsquo;s tabs), metadata, the scroll wells inside the chat window, target tags.
            </p>
          </div>

          <div className="uip-cols">
            <Item label="B · the action bar (a region: fill only)">
              <div className="uip-stage">
                <div className="action-bar">
                  <button type="button" className="btn">
                    <UiIcon kind="card" /> Draw card (1 <UiIcon kind="wish" label="Wish" />)
                  </button>
                  <button type="button" className="btn" aria-haspopup="true">
                    <UiIcon kind="plant" /> Plant Garden<span className="submenu-caret" aria-hidden="true">▸</span>
                  </button>
                  <button type="button" className="btn">
                    End turn ⏹
                  </button>
                </div>
              </div>
            </Item>
            <Item label="A · the targeting banner (a mode: it keeps its edge)">
              <div className="uip-stage">
                <div className="targeting-banner">
                  <span>
                    🎯 <b>Rocket Propelled Gnome</b>: pick a gnome.
                  </span>
                  <button type="button" className="btn small ghost">
                    Cancel
                  </button>
                </div>
              </div>
            </Item>
          </div>
        </Section>

        {/* --------------------------------------------------------------- */}
        <Section
          id="sidebar"
          title="Sidebar"
          note="The right-hand column in the states that matter, each in the production .right-col at a real desktop height (720px). The ranking: what the game needs from you now, then your hand, then chat and the log — which start folded and, open, take a bounded height rather than the rest of the column."
        >
          <div className="uip-cols">
            <Item label="Decision + hand + folded chat">
              <div className="right-col uip-sidebar">
                <DecisionPanel
                  state={decisions[1].state}
                  decision={decisions[1].decision}
                  legal={[]}
                  interactive
                  act={noop}
                  onRespondCard={noop}
                />
                <HandPanel
                  state={state}
                  seat={0}
                  playable={new Set<CardId>(['nope-gnome', 'wild-growth'])}
                  onPlay={noop}
                  blocked={null}
                />
                <ChatPanel state={state} seat={0} disabled={false} muted={false} onToggleMute={noop} onSay={noop} />
              </div>
            </Item>
            <Item label="No decision + hand">
              <div className="right-col uip-sidebar">
                <HandPanel
                  state={state}
                  seat={0}
                  playable={new Set<CardId>(['nope-gnome', 'wild-growth'])}
                  onPlay={noop}
                  blocked={null}
                />
                <ChatPanel state={state} seat={0} disabled={false} muted={false} onToggleMute={noop} onSay={noop} />
              </div>
            </Item>
            <Item label="Empty hand — one line, not a box">
              <div className="right-col uip-sidebar">
                <DecisionPanel
                  state={decisions[0].state}
                  decision={decisions[0].decision}
                  legal={[]}
                  interactive={false}
                  act={noop}
                  onRespondCard={noop}
                />
                <HandPanel state={emptyHand} seat={0} playable={new Set<CardId>()} onPlay={noop} blocked={null} />
                <ChatPanel state={emptyHand} seat={0} disabled={false} muted={false} onToggleMute={noop} onSay={noop} />
              </div>
            </Item>
            <Item label="Chat open">
              <div className="right-col uip-sidebar">
                <HandPanel
                  state={state}
                  seat={0}
                  playable={new Set<CardId>(['nope-gnome', 'wild-growth'])}
                  onPlay={noop}
                  blocked={null}
                />
                <ChatPanel
                  state={state}
                  seat={0}
                  disabled={false}
                  muted={false}
                  onToggleMute={noop}
                  onSay={noop}
                  initialView="chat"
                />
              </div>
            </Item>
            <Item label="Game log open">
              <div className="right-col uip-sidebar">
                <HandPanel
                  state={state}
                  seat={0}
                  playable={new Set<CardId>(['nope-gnome', 'wild-growth'])}
                  onPlay={noop}
                  blocked={null}
                />
                <ChatPanel
                  state={state}
                  seat={0}
                  disabled={false}
                  muted={false}
                  onToggleMute={noop}
                  onSay={noop}
                  initialView="log"
                />
              </div>
            </Item>
          </div>

          <div className="uip-cols">
            <Item
              label="Selected-object context today: a selected gnome is shown in the ACTION BAR under the board (name, stack chips, the actions for its space). Gardens and tiles cannot be selected; their details live only in the cell's hover tooltip."
              wide
            >
              <div className="action-bar">
                <span className="selected-unit">
                  <UnitIcon owner={0} className="inline-art" /> {unitNameLive(state, stack[0].id)}
                </span>
                <span className="stack-chips">
                  {stackChips.map((c, i) => (
                    <button
                      key={c.unitId}
                      type="button"
                      className={`btn small chip${i === 0 ? ' on' : ''}`}
                      aria-pressed={i === 0}
                      title={c.full}
                    >
                      {c.short}
                    </button>
                  ))}
                </span>
                <button type="button" className="btn">
                  <UiIcon kind="card" /> Draw card (1 <UiIcon kind="wish" label="Wish" />)
                </button>
                <button type="button" className="btn" aria-haspopup="true">
                  <UiIcon kind="plant" /> Plant Garden<span className="submenu-caret" aria-hidden="true">▸</span>
                </button>
                <button type="button" className="btn small">
                  Deselect
                </button>
                <button type="button" className="btn">
                  End turn ⏹
                </button>
              </div>
            </Item>
          </div>
        </Section>

        {/* --------------------------------------------------------------- */}
        <Section
          id="setup"
          title="Setup screen"
          note="The real local-game setup screen in frames at real device sizes (scaled to fit), so its phone layout — which responds to the viewport, not to a box — is the one a phone gets. The red line is the bottom of the screen: Start the war should sit above it. Layout management is behind Customize game → Layouts (the Modal section below opens it)."
        >
          <div className="uip-cols">
            {SETUP_FRAMES.map((f) => (
              <Item key={f.label} label={f.label}>
                <div className="uip-frame" style={{ width: f.w * f.scale, height: f.h * f.scale }}>
                  <iframe
                    title={`Setup screen, ${f.label}`}
                    src={`?ui=preview&frame=setup${theme === 'auto' ? '' : `&theme=${theme}`}`}
                    style={{ width: f.w, height: f.h, transform: `scale(${f.scale})` }}
                  />
                </div>
              </Item>
            ))}
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
          note="The four custom interface icons (artAssets.ts → UI_ICON_ART, drawn by <UiIcon>) at the sizes the game actually draws them: one em-relative size that tracks the text around it, and .lg for an icon on its own. Then the emoji that are still glyphs, and why."
        >
          <div className="uip-panel">
            <table className="uip-table">
              <thead>
                <tr>
                  <th>Icon</th>
                  <th>Means</th>
                  <th>In a stat (13px)</th>
                  <th>In a button (13px)</th>
                  <th>In a title (18px)</th>
                  <th>.lg</th>
                  <th>Text fallback</th>
                </tr>
              </thead>
              <tbody>
                {UI_ICON_KINDS.map((k) => (
                  <tr key={k}>
                    <td>
                      <code className="uip-label">{k}</code>
                    </td>
                    <td>{UI_ICON_LABEL[k]}</td>
                    <td>
                      <span className="pp-stats">
                        <span>
                          <UiIcon kind={k} label={UI_ICON_LABEL[k]} /> 3/5
                        </span>
                      </span>
                    </td>
                    <td>
                      <button type="button" className="btn">
                        <UiIcon kind={k} /> {UI_ICON_LABEL[k]}
                      </button>
                    </td>
                    <td>
                      <span className="t-decision">
                        <UiIcon kind={k} /> Title
                      </span>
                    </td>
                    <td>
                      <UiIcon kind={k} size="lg" label={UI_ICON_LABEL[k]} />
                    </td>
                    <td className="uip-glyph">{UI_ICON_GLYPH[k]}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3 className="uip-h3">Still emoji</h3>
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
          note="One window with two tabs. It starts folded (tabs and the phrase button only); a tab opens its body at a bounded height, and the open tab or Hide folds it again. Unread chat is badged on the Chat tab whenever the chat is not on screen."
        >
          <div className="uip-cols">
            <Item label="<ChatPanel> — folded (the default); click a tab">
              <div className="uip-rightcol">
                <ChatPanel state={state} seat={0} disabled={false} muted={false} onToggleMute={noop} onSay={noop} />
              </div>
            </Item>
            <Item label="<ChatPanel> — read-only (no seat), muted, chat open">
              <div className="uip-rightcol">
                <ChatPanel state={state} seat={null} disabled muted onToggleMute={noop} onSay={noop} initialView="chat" />
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
          note="The game's one modal pattern (.overlay + .overlay-card), shown by the real Customize game dialog — which also holds the Layouts page and the deck and garden-budget editors. Choosing a layout here only moves the selection inside the specimen."
        >
          <div className="uip-panel uip-row">
            <button type="button" className="btn primary" onClick={() => setModalOpen(true)}>
              Open the Customize game dialog
            </button>
          </div>
        </Section>

        {modalOpen && (
          <AdvancedSettings
            value={DEFAULT_ADVANCED_SETTINGS}
            onApply={() => setModalOpen(false)}
            onCancel={() => setModalOpen(false)}
            layouts={{
              selected: [...MODE_PRESETS, ...CLASSIC_PRESETS].find((p) => p.id === labLayout) ?? MODE_PRESETS[0],
              boardSize: 7,
              mapNumber: MODE_PRESETS.some((p) => p.id === labLayout) ? 1975371893 : null,
              classics: CLASSIC_PRESETS,
              session: [],
              fits: (def, size) => def.minBoardSize <= size,
              error: null,
              onSelect: setLabLayout,
              onImport: noop,
              onExport: noop,
              onRemove: noop,
            }}
            onDrawLayout={noop}
            onEditLayout={noop}
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
  { glyph: '✨', meaning: 'Wishes — plain-text fallback only (log lines, generated action labels)', kind: 'fallback', where: 'meta' },
  { glyph: '⭐', meaning: 'Centre Star, and an upgraded garden’s badge', kind: 'game object', where: 'Board, meta, SetupScreen' },
  { glyph: '💫', meaning: 'Flytrap stunned', kind: 'game object', where: 'Board' },
  { glyph: '🌱', meaning: '“Start the war” — decoration, not planting, so it did not become the Plant icon', kind: 'decorative', where: 'SetupScreen' },
  { glyph: '⚡', meaning: 'Sudden Magic (card timing)', kind: 'category', where: 'panels' },
  { glyph: '🕯️', meaning: 'Ritual Magic (card timing)', kind: 'category', where: 'panels' },
  { glyph: '⚔️', meaning: 'Fight', kind: 'status', where: 'panels, meta' },
  { glyph: '💀', meaning: 'Eliminated', kind: 'status', where: 'panels, meta, DecisionPanel' },
  { glyph: '☠️', meaning: 'Curse revealed / Magic Drain', kind: 'status', where: 'GameScreen, meta, DecisionPanel' },
  { glyph: '🏆', meaning: 'Winner', kind: 'status', where: 'GameScreen, meta' },
  { glyph: '🍂', meaning: 'Draw — no winner', kind: 'status', where: 'GameScreen' },
  { glyph: '🧑', meaning: 'Human seat (setup and lobby now say “Human” in words)', kind: 'interface', where: 'panels' },
  { glyph: '🤖', meaning: 'CPU seat (setup and lobby now say “CPU” in words)', kind: 'interface', where: 'panels, useNetGame' },
  { glyph: '🎲', meaning: 'Roll / re-roll, and online “Start the game”', kind: 'interface', where: 'DecisionPanel, SetupScreen, GnomeCreator, OnlineScreen, meta, interaction' },
  { glyph: '⏩', meaning: 'Fast-forward the CPU', kind: 'interface', where: 'GameScreen' },
  { glyph: '⚙️', meaning: 'Customize game', kind: 'interface', where: 'SetupScreen' },
];

/**
 * A gnome on the board is NOT in the table above: `PlayerPanels` already draws
 * it with `<UnitIcon>`, i.e. the seat's own composited art. Gardens, units and
 * the death poofs went custom the same way (see `artAssets.ts` / `fxAssets.ts`
 * and the Art section of README.md). What is left here is everything that
 * never made that move.
 */

// ---------------------------------------------------------------------------
// Tokens, button states, theme
// ---------------------------------------------------------------------------

type Theme = 'auto' | 'light' | 'dark';

const TOKEN_GROUPS: Array<[string, string[]]> = [
  [
    'Surfaces',
    ['--color-bg', '--color-surface', '--color-surface-raised', '--color-surface-subtle', '--color-surface-tint'],
  ],
  ['Brand / action', ['--color-primary', '--color-primary-hover', '--color-primary-pressed', '--color-on-primary']],
  ['Text & borders', ['--color-text', '--color-text-muted', '--color-border', '--color-border-strong']],
  ['Meaning', ['--color-wish', '--color-warning', '--color-danger']],
  ['Players', ['--color-player-red', '--color-player-blue', '--color-player-yellow', '--color-player-purple']],
  ['Board', ['--color-cell', '--color-cell-alt', '--color-bloom-eye']],
  [
    'Board highlights',
    ['--color-highlight-move', '--color-highlight-decision', '--color-highlight-target', '--color-highlight-picked'],
  ],
];

const SPACE_TOKENS = [
  '--space-2xs',
  '--space-xs',
  '--space-sm',
  '--space-md',
  '--space-lg',
  '--space-xl',
  '--space-2xl',
  '--space-3xl',
];
const RADIUS_TOKENS = ['--radius-sm', '--radius-md', '--radius-lg', '--radius-pill'];

/** A custom property's resolved value, re-read whenever the theme flips. */
function useTokenValue(token: string): string {
  const [value, setValue] = useState('');
  useEffect(() => {
    const read = () => setValue(getComputedStyle(document.documentElement).getPropertyValue(token).trim());
    read();
    // The theme switch and the OS setting both change what a token resolves to.
    const attr = new MutationObserver(read);
    attr.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', read);
    return () => {
      attr.disconnect();
      mq.removeEventListener('change', read);
    };
  }, [token]);
  return value;
}

function TokenValue({ token }: { token: string }) {
  return <span className="uip-spec uip-label">{useTokenValue(token)}</span>;
}

function TokenSwatch({ token }: { token: string }) {
  return (
    <div className="uip-swatch">
      <span className="uip-swatch-chip" style={{ background: `var(${token})` }} />
      <code className="uip-label">{token.replace('--color-', '')}</code>
      <TokenValue token={token} />
    </div>
  );
}

const BUTTON_KINDS: Array<[string, string]> = [
  ['primary', ' primary'],
  ['secondary', ''],
  ['danger', ' danger'],
  ['ghost', ' ghost'],
];
const BUTTON_STATES = ['default', 'hover', 'pressed', 'focus', 'disabled'] as const;

const FORCED: Array<[pseudo: string, state: string]> = [
  [':hover', 'hover'],
  [':active', 'pressed'],
  [':focus-visible', 'focus'],
];

/**
 * Makes `data-uip-state="hover|pressed|focus"` show a button's hover, pressed
 * or focus style without a pointer or keyboard.
 *
 * It does not describe those styles itself — that would be a second copy of
 * the button CSS, free to drift. It reads the page's own stylesheet, and for
 * every `.btn` rule with one of those pseudo-classes adds the same declarations
 * under an attribute selector instead. Change the real rule and the forced
 * specimen changes with it.
 */
function useForcedStates() {
  useEffect(() => {
    const out: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // a cross-origin sheet; none of ours
      }
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSStyleRule) || !rule.selectorText.includes('.btn')) continue;
        for (const [pseudo, state] of FORCED) {
          if (!rule.selectorText.includes(pseudo)) continue;
          const selector = rule.selectorText.split(pseudo).join(`[data-uip-state='${state}']`);
          out.push(`${selector} { ${rule.style.cssText} }`);
        }
      }
    }
    const el = document.createElement('style');
    el.dataset.uip = 'forced-states';
    el.textContent = out.join('\n');
    document.head.appendChild(el);
    return () => el.remove();
  }, []);
}
