/**
 * The main human gameplay path, played through the browser:
 * start a game → roll off → first turn → harvest → move → plant → fight →
 * respond window → end turn.
 */

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { Game, setSeed, stepToward } from './helpers';

const SEED = 4242;

test('starts a two-player game and reaches the first playable turn', async ({ page }) => {
  const g = new Game(page);
  await g.startTwoPlayer(SEED);

  // Roll-off is the opening decision.
  expect(await g.status()).toBe('rolloff');
  await g.completeRollOff();

  // First turn belongs to the roll-off winner and opens in the Harvest Phase.
  expect(await g.status()).toBe('playing');
  expect(await g.turn()).toBe(1);

  await g.resolveHarvest('wish');
  expect(await g.phase()).toBe('action');
  await expect(page.getByTestId('action-bar')).toBeVisible();
});

test('harvests the Home Garden for a Wish and for a Gnome', async ({ page }) => {
  const g = new Game(page);
  await g.startTwoPlayer(SEED);
  await g.completeRollOff();

  // Turn 1: take the Wish. Starting Wishes (3) already sit at the wish cap (3),
  // so the harvest is clamped — the count holds at the cap rather than rising.
  expect(await g.decision()).toBe('homeHarvest');
  const before = await g.wishes(await g.playerToAct());
  await page.getByTestId('home-harvest-wish').click();
  await g.ready();
  const active = await g.activePlayer();
  expect(await g.wishes(active)).toBe(before);

  // Turn 2 (the other seat): take the Gnome instead — a second unit appears.
  await g.endTurn();
  await g.ready();
  const seat = await g.playerToAct();
  const gnomesBefore = (await g.unitsOf(seat)).reduce((n, u) => n + u.count, 0);
  expect(await g.decision()).toBe('homeHarvest');
  await page.getByTestId('home-harvest-gnome').click();
  await g.ready();
  const gnomesAfter = (await g.unitsOf(seat)).reduce((n, u) => n + u.count, 0);
  expect(gnomesAfter).toBe(gnomesBefore + 1);
});

test('moves a gnome and plants a garden after moving', async ({ page }) => {
  const g = new Game(page);
  await g.startTwoPlayer(SEED);
  await g.completeRollOff();
  // Players start with 0 gnomes (RULES.md setup ruling) — the Home Garden
  // harvest is how you bootstrap one.
  await g.resolveHarvest('gnome');

  const me = await g.activePlayer();
  const [gnome] = await g.unitsOf(me);
  expect(gnome).toBeTruthy();

  // Selecting shows the legal destinations the engine enumerated.
  await g.select(gnome.pos);
  const targets = await g.moveTargets();
  expect(targets.length).toBeGreaterThan(0);

  const to = targets[0];
  await g.cell(to).click();
  await g.ready();
  expect((await g.unitsOf(me)).some((u) => u.pos === to)).toBe(true);

  // Planting AFTER moving is legal (the gnome's move is spent, planting is
  // not) — this is the regression the plant-after-move fix covered.
  expect(await g.gardenAt(to)).toBeNull();
  await g.select(to);
  // Planting is one entry that expands into the garden list (counts included).
  await page.getByTestId('open-plant-menu').click();
  const plantButton = page.locator('[data-testid^="plant-"]:not([disabled])').first();
  await expect(plantButton).toBeVisible();
  const type = ((await plantButton.getAttribute('data-testid')) ?? '').replace('plant-', '');
  await expect(plantButton).toContainText('×');
  await plantButton.click();
  await g.ready();
  expect(await g.gardenAt(to)).toBe(type);
  // Picking a garden closes the submenu — the action list is back.
  await expect(page.getByTestId('end-turn')).toBeVisible();
});

test('the plant submenu lists every garden with its supply and can be backed out of', async ({
  page,
}) => {
  const g = new Game(page);
  await g.startTwoPlayer(SEED);
  await g.completeRollOff();
  await g.resolveHarvest('gnome');

  const me = await g.activePlayer();
  const [gnome] = await g.unitsOf(me);
  // Step off the Home Garden: planting needs an empty space.
  await g.select(gnome.pos);
  const to = (await g.moveTargets())[0];
  await g.cell(to).click();
  await g.ready();
  await g.select(to);

  await page.getByTestId('open-plant-menu').click();
  // One row per plantable type, each showing the remaining count.
  const rows = page.locator('[data-testid^="plant-"]');
  await expect(rows).toHaveCount(6);
  await expect(rows.first()).toContainText(/×\d/);
  // The rest of the action list is hidden while the submenu is open.
  await expect(page.getByTestId('end-turn')).toHaveCount(0);

  await page.getByTestId('submenu-back').click();
  await expect(page.getByTestId('end-turn')).toBeVisible();
  await expect(page.getByTestId('open-plant-menu')).toBeVisible();
});

test('preserves a valid unit selection and drops it once it is spent', async ({ page }) => {
  const g = new Game(page);
  await g.startTwoPlayer(SEED);
  await g.completeRollOff();
  await g.resolveHarvest('gnome');

  const me = await g.activePlayer();
  const [gnome] = await g.unitsOf(me);
  await g.select(gnome.pos);
  expect(await g.selectedCell()).toBe(gnome.pos);

  // Move it: the selection follows the unit to its new space, because the
  // gnome can still plant there (it is still an actionable selection).
  const to = (await g.moveTargets())[0];
  await g.cell(to).click();
  await g.ready();
  expect(await g.selectedCell()).toBe(to);

  // End the turn: the selection belongs to a seat that is no longer acting,
  // so it must be gone.
  await g.endTurn();
  expect(await g.selectedCell()).toBeNull();
});

test('picks a specific gnome out of a stack by name', async ({ page }) => {
  const g = new Game(page);
  await g.startTwoPlayer(SEED);
  await g.completeRollOff();

  // Stack two gnomes on the Home Garden: the gnome harvest spawns at homePos,
  // so taking it on two of this seat's turns (leaving the first where it is)
  // puts two units on one square — the case that used to be selectable only by
  // clicking the cell repeatedly with no feedback about which one you had.
  await g.resolveHarvest('gnome');
  const me = await g.activePlayer();
  const [first] = await g.unitsOf(me);
  const home = first.pos;
  await g.endTurn(); // opponent's turn
  await g.resolveHarvest('wish');
  await g.endTurn(); // back to us
  await g.resolveHarvest('gnome');

  expect(await g.activePlayer()).toBe(me);
  const stack = (await g.unitsOf(me)).find((u) => u.pos === home);
  expect(stack?.count, 'two gnomes should share the home square').toBe(2);

  // Selecting the square offers one chip per gnome, and names the selection.
  await g.select(home);
  await expect(page.getByTestId('selected-unit-name')).toBeVisible();
  const chips = await g.selectChips();
  expect(chips).toHaveLength(2);
  expect(chips.every((c) => c.label.length > 0)).toBe(true);

  // Exactly one chip is pressed, and it is the selected unit.
  const selected = await g.selectedUnit();
  expect(chips.filter((c) => c.pressed).map((c) => c.unitId)).toEqual([selected]);

  // Clicking the other chip switches the selection to THAT unit — asserted on
  // the id directly, not inferred from a changed highlight set.
  const other = chips.find((c) => c.unitId !== selected)!;
  await g.clickChip(other.unitId);
  expect(await g.selectedUnit()).toBe(other.unitId);
  expect((await g.selectChips()).filter((c) => c.pressed).map((c) => c.unitId)).toEqual([
    other.unitId,
  ]);

  // Moving proves the RIGHT unit moved: the stack drops to one, the chips are
  // gone (no stack left to disambiguate), and the selection follows the mover.
  const to = (await g.moveTargets())[0];
  expect(to).toBeTruthy();
  await g.cell(to).click();
  await g.ready();
  expect(await g.selectedUnit()).toBe(other.unitId);
  expect((await g.unitsOf(me)).find((u) => u.pos === home)?.count).toBe(1);
  expect((await g.unitsOf(me)).some((u) => u.pos === to)).toBe(true);
  expect(await g.selectChips()).toHaveLength(0);
});

test('cycles the same ordered stack when the cell itself is clicked', async ({ page }) => {
  const g = new Game(page);
  await g.startTwoPlayer(SEED);
  await g.completeRollOff();

  await g.resolveHarvest('gnome');
  const me = await g.activePlayer();
  const home = (await g.unitsOf(me))[0].pos;
  await g.endTurn();
  await g.resolveHarvest('wish');
  await g.endTurn();
  await g.resolveHarvest('gnome');

  await g.select(home);
  const order = (await g.selectChips()).map((c) => c.unitId);
  expect(order).toHaveLength(2);

  // Clicking the cell walks the chip order and wraps — the click path and the
  // chip row read the same list, so they can never disagree.
  const startAt = order.indexOf(await g.selectedUnit());
  expect(startAt).toBeGreaterThanOrEqual(0);
  for (let i = 1; i <= order.length; i++) {
    await g.cell(home).click();
    expect(await g.selectedUnit()).toBe(order[(startAt + i) % order.length]);
  }
});

test('marches gnomes together and resolves a fight', async ({ page }) => {
  const g = new Game(page);
  await g.startTwoPlayer(SEED);
  await g.completeRollOff();

  let fought = false;

  // Both seats bootstrap a gnome, then walk them at each other until they
  // collide. Each iteration is one full turn: harvest, one move, end turn.
  for (let turn = 0; turn < 24 && !fought; turn++) {
    const me = await g.activePlayer();
    const foe = me === 0 ? 1 : 0;
    // Take a gnome while we have none, otherwise bank the Wish.
    const haveGnome = (await g.unitsOf(me)).some((u) => u.kind === 'gnome');
    await g.resolveHarvest(haveGnome ? 'wish' : 'gnome');
    if ((await g.status()) === 'finished') break;

    const mine = (await g.unitsOf(me)).filter((u) => u.kind === 'gnome');
    const theirs = (await g.unitsOf(foe)).filter((u) => u.kind === 'gnome');
    if (mine.length > 0 && theirs.length > 0) {
      const from = mine[0];
      const to = stepToward(from, theirs[0]);
      const gnomesBefore = (await g.units()).reduce((n, u) => n + u.count, 0);

      await g.select(from.pos);
      if ((await g.moveTargets()).includes(to)) {
        await g.cell(to).click();

        // Stepping onto an enemy starts a fight. The Respond window only
        // opens for a player holding playable Sudden Magic — with the empty
        // hands of an opening march the engine auto-passes it, so handle both.
        const fightPanel = page.getByTestId('fight-panel');
        if (await fightPanel.isVisible().catch(() => false)) {
          const respondPass = page.getByTestId('fight-respond-pass');
          if (await respondPass.isVisible().catch(() => false)) await respondPass.click();
        }
        await g.ready();

        // A resolved fight always destroys exactly one gnome, so the board's
        // gnome count is the reliable signal that a fight actually happened.
        const gnomesAfter = (await g.units()).reduce((n, u) => n + u.count, 0);
        if (gnomesAfter < gnomesBefore) fought = true;
      }
    }

    if ((await g.status()) === 'finished') break;
    if (!fought) await g.endTurn();
  }

  expect(fought, 'the two gnomes should have met and fought').toBe(true);
  // The game survived the fight and is still coherent.
  expect(['playing', 'finished']).toContain(await g.status());
});

test('plays a card and lets the opponent answer the response window', async ({ page }) => {
  const g = new Game(page);
  await g.startTwoPlayer(SEED);
  await g.completeRollOff();

  // Build hands: each seat draws whenever it can afford to (1 Wish a card).
  // A response window opens as soon as one seat plays a card while the other
  // holds a playable Sudden card.
  let sawResponseWindow = false;

  for (let turn = 0; turn < 16 && !sawResponseWindow; turn++) {
    const me = await g.activePlayer();
    // A gnome on the board first: most Sudden cards need one to be playable.
    const haveGnome = (await g.unitsOf(me)).some((u) => u.kind === 'gnome');
    await g.resolveHarvest(haveGnome ? 'wish' : 'gnome');
    if ((await g.status()) === 'finished') break;

    // Draw as much as affordable this turn.
    for (let i = 0; i < 3; i++) {
      const draw = page.getByTestId('draw-card');
      if (!(await draw.isEnabled().catch(() => false))) break;
      await draw.click();
      await g.ready();
    }

    // Play the first playable card in hand, if any.
    const playable = page.locator('[data-testid^="play-card-"]:not([disabled])');
    if ((await playable.count()) > 0) {
      await playable.first().click();
      // Targeted cards enter targeting mode: click the offered candidates.
      for (let i = 0; i < 4; i++) {
        if (!(await page.getByTestId('targeting-banner').isVisible().catch(() => false))) break;
        const cand = page.locator('.board button[data-highlight="target"]').first();
        const chip = page.locator('[data-testid="targeting-banner"] .btn.small').first();
        if ((await cand.count()) > 0) await cand.click();
        else if ((await chip.count()) > 0) await chip.click();
        else {
          await page.getByTestId('targeting-cancel').click();
          break;
        }
      }
      // With two human seats the opponent's response window sits behind the
      // pass-the-device overlay; ready() clears it before we look.
      await g.ready();
      if ((await g.decision()) === 'cardResponse') {
        sawResponseWindow = true;
        await expect(page.getByTestId('respond-pass')).toBeVisible();
        await page.getByTestId('respond-pass').click();
        await g.ready();
      }
    }

    if ((await g.status()) === 'finished') break;
    await g.endTurn();
  }

  expect(sawResponseWindow, 'a card response window should have opened').toBe(true);
  expect(['playing', 'finished']).toContain(await g.status());
});

// This seed lets the roll-off winner draw a playable Plot Twist within their
// first-turn Wish budget — a two-step (space, then adjacent space) targeted
// card, so it exercises the phased narrowing end to end.
const TWO_STEP_SEED = 7;

/** Roll off, take the Home Wish, and draw until Plot Twist is playable. */
async function reachPlayablePlotTwist(g: Game) {
  const page = g.page;
  await g.startTwoPlayer(TWO_STEP_SEED);
  await g.completeRollOff();
  await g.resolveHarvest('wish');
  const playBtn = page.getByTestId('play-card-plot-twist');
  for (let i = 0; i < 6; i++) {
    if ((await playBtn.count()) > 0 && (await playBtn.isEnabled())) break;
    const draw = page.getByTestId('draw-card');
    await expect(draw).toBeEnabled(); // auto-waits for the action bar to paint
    await draw.click();
    await g.ready();
  }
  await expect(playBtn).toBeEnabled();
}

test('phased targeting narrows the second target after the first pick (Plot Twist)', async ({ page }) => {
  const g = new Game(page);
  await reachPlayablePlotTwist(g);
  const targets = page.locator('.board button[data-highlight="target"]');
  const banner = page.getByTestId('targeting-banner');

  // Play the card: the engine opens phased targeting, step 1 of 2.
  await page.getByTestId('play-card-plot-twist').click();
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('1/2');
  expect(await g.decision()).toBe('cardTargeting');

  // Step 1 offers every board space; more than a single-cell neighbourhood.
  const step1Count = await targets.count();
  expect(step1Count).toBeGreaterThan(4);

  // Pick the first target; the banner advances and the set NARROWS to the
  // chosen cell's orthogonal neighbours (at most 4), with the pick marked.
  await targets.first().click();
  await expect(banner).toContainText('2/2');
  const step2Count = await targets.count();
  expect(step2Count).toBeLessThan(step1Count);
  expect(step2Count).toBeLessThanOrEqual(4);
  await expect(page.locator('.board button[data-highlight="picked"]')).toHaveCount(1);

  // Pick the second target: the card resolves and targeting closes.
  await targets.first().click();
  await g.ready();
  await expect(banner).toBeHidden();
  expect(await g.decision()).not.toBe('cardTargeting');
});

test('cancelling phased targeting returns the card to the hand', async ({ page }) => {
  const g = new Game(page);
  await reachPlayablePlotTwist(g);
  const banner = page.getByTestId('targeting-banner');

  await page.getByTestId('play-card-plot-twist').click();
  await expect(banner).toBeVisible();

  // Back out: the banner closes, no card was played, and Plot Twist is still
  // in hand and playable again.
  await page.getByTestId('targeting-cancel').click();
  await g.ready();
  await expect(banner).toBeHidden();
  expect(await g.decision()).not.toBe('cardTargeting');
  await expect(page.getByTestId('play-card-plot-twist')).toBeEnabled();
});

// ---------------------------------------------------------------------------
// The True Random mode (the shipping default)
// ---------------------------------------------------------------------------

/** Row-major indices of the cells carrying each kind of marker, read off the DOM. */
async function readLayout(page: import('@playwright/test').Page, root: string) {
  return page.$$eval(`${root} .cell`, (cells) => {
    const gardens: string[] = [];
    const homes: number[] = [];
    cells.forEach((cell, i) => {
      const type = [...cell.classList].find((c) => c.startsWith('g-') && c !== 'g-home');
      if (type) gardens.push(`${i}:${type}`);
      // The live board marks homes with g-home; the setup preview uses
      // editor-home, and dims the seats a 2-player game won't fill.
      const isHome = cell.classList.contains('g-home') || cell.classList.contains('editor-home');
      if (isHome && !cell.classList.contains('unseated')) homes.push(i);
    });
    return { gardens, homes };
  });
}

/** Home → local setup. The setup screen is no longer the landing page. */
async function openSetup(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('home-local').click();
}

test('True Random is the default mode and previews a symmetric map', async ({ page }) => {
  await openSetup(page);
  await expect(page.getByLabel('Extra-garden preset')).toHaveValue('random');

  const { gardens, homes } = await readLayout(page, '.preset-preview');
  // 2 to 4 orbits of 4, plus the 2 seated homes of a default 2-player game.
  expect(gardens.length).toBeGreaterThanOrEqual(8);
  expect(gardens.length).toBeLessThanOrEqual(16);
  expect(gardens.length % 4).toBe(0);
  expect(homes).toHaveLength(2);
});

test('re-rolling the map changes the preview', async ({ page }) => {
  await openSetup(page);
  const label = page.getByText(/^Map #/);
  const before = await label.textContent();
  const first = await readLayout(page, '.preset-preview');

  // A re-roll could in principle repeat a map; a few attempts makes that moot.
  let changed = false;
  for (let i = 0; i < 5 && !changed; i++) {
    await page.getByTestId('reroll-layout').click();
    const next = await readLayout(page, '.preset-preview');
    changed = JSON.stringify(next) !== JSON.stringify(first);
  }
  expect(changed).toBe(true);
  expect(await label.textContent()).not.toBe(before);
});

test('plays exactly the map the setup screen previewed', async ({ page }) => {
  await openSetup(page);
  await page.getByTestId('reroll-layout').click();
  const previewed = await readLayout(page, '.preset-preview');

  await page.getByTestId('player-count-2').click();
  await page.getByTestId('seat-0-human').click();
  await page.getByTestId('seat-1-human').click();
  await setSeed(page, SEED);
  await page.getByTestId('start-game').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();

  expect(await readLayout(page, '[data-testid="game-screen"] .board')).toEqual(previewed);
});

test('quick chat sends fixed phrases only, and runs out for the turn', async ({ page }) => {
  const g = new Game(page);
  await g.startTwoPlayer(SEED);
  await g.completeRollOff();
  await g.resolveHarvest('wish');

  const panel = page.getByTestId('chat-panel');
  await expect(panel).toBeVisible();
  // The whole point of quick chat: there is nowhere to type.
  expect(await panel.locator('input, textarea, [contenteditable="true"]').count()).toBe(0);
  await expect(page.getByTestId('quickchat-left')).toHaveText('4/4');

  // Two steps: the wheel of categories, then that category's phrases.
  await page.getByTestId('quickchat-open').click();
  await expect(page.getByTestId('quickchat-group-manners')).toBeVisible();
  await expect(page.getByTestId('quickchat-say-sorry')).toBeHidden(); // not until a category is picked
  await page.getByTestId('quickchat-group-manners').click();
  await page.getByTestId('quickchat-say-sorry').click();

  // It shows up as a bubble over the board and as a line in the transcript.
  await expect(page.getByTestId('quickchat-bubble-sorry')).toBeVisible();
  await expect(page.getByTestId('chat-transcript')).toContainText('Sorry!');
  await expect(page.getByTestId('quickchat-left')).toHaveText('3/4');
  // The picker closes after a pick, so chat never blocks the board.
  await expect(page.getByTestId('quickchat-menu')).toBeHidden();

  // Spend the rest of the allowance: the button locks until the next turn.
  for (const [group, phrase] of [
    ['greetings', 'hi'],
    ['compliments', 'wow'],
    ['musings', 'why-the-hats'],
  ]) {
    await page.getByTestId('quickchat-open').click();
    await page.getByTestId(`quickchat-group-${group}`).click();
    await page.getByTestId(`quickchat-say-${phrase}`).click();
  }
  await expect(page.getByTestId('quickchat-left')).toHaveText('0/4');
  await expect(page.getByTestId('quickchat-open')).toBeDisabled();

  // A new turn refills it (and the next seat can chat too).
  await g.endTurn();
  await expect(page.getByTestId('quickchat-left')).toHaveText('4/4');
});

test('the phrase picker steps back out of a category and closes', async ({ page }) => {
  const g = new Game(page);
  await g.startTwoPlayer(SEED);
  await g.completeRollOff();
  await g.resolveHarvest('wish');

  await page.getByTestId('quickchat-open').click();
  await page.getByTestId('quickchat-group-tactics').click();
  await expect(page.getByTestId('quickchat-say-watch-the-flytrap')).toBeVisible();

  // Back returns to the wheel without spending anything.
  await page.getByTestId('quickchat-back').click();
  await expect(page.getByTestId('quickchat-group-tactics')).toBeVisible();
  await page.getByTestId('quickchat-close').click();
  await expect(page.getByTestId('quickchat-menu')).toBeHidden();
  await expect(page.getByTestId('quickchat-left')).toHaveText('4/4');
});

test('chat and game log share one window, and unread chat is badged', async ({ page }) => {
  const g = new Game(page);
  await g.startTwoPlayer(SEED);
  await g.completeRollOff();
  await g.resolveHarvest('wish');

  // Chat tab first: the transcript is shown, the event log is not.
  await expect(page.getByTestId('chat-transcript')).toBeVisible();
  await expect(page.getByTestId('game-log')).toBeHidden();

  // Switch to the log tab, then say something: the chat tab badges it.
  await page.getByTestId('chat-tab-log').click();
  await expect(page.getByTestId('game-log')).toBeVisible();
  await expect(page.getByTestId('chat-transcript')).toBeHidden();
  await expect(page.getByTestId('chat-unread')).toBeHidden();

  await page.getByTestId('quickchat-open').click();
  await page.getByTestId('quickchat-group-greetings').click();
  await page.getByTestId('quickchat-say-good-luck').click();
  await expect(page.getByTestId('chat-unread')).toHaveText('1');

  // Reading the chat clears the badge.
  await page.getByTestId('chat-tab-chat').click();
  await expect(page.getByTestId('chat-transcript')).toContainText('Good luck!');
  await expect(page.getByTestId('chat-unread')).toBeHidden();

  // Collapsing hides both bodies but keeps the composer reachable.
  await page.getByTestId('chat-collapse').click();
  await expect(page.getByTestId('chat-transcript')).toBeHidden();
  await expect(page.getByTestId('quickchat-open')).toBeVisible();
});

test('muting hides chat bubbles but keeps the transcript honest', async ({ page }) => {
  const g = new Game(page);
  await g.startTwoPlayer(SEED);
  await g.completeRollOff();
  await g.resolveHarvest('wish');

  await page.getByTestId('quickchat-mute').click();
  await page.getByTestId('quickchat-open').click();
  await page.getByTestId('quickchat-group-greetings').click();
  await page.getByTestId('quickchat-say-hi').click();

  await expect(page.getByTestId('quickchat-feed')).toBeHidden();
  await expect(page.getByTestId('chat-transcript')).toContainText('Hi!');
});

test('the home screen routes to local play, the rules, and the online menu', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('home-screen')).toBeVisible();

  // Rules: the canonical spec, rendered in-app, and a way back.
  await page.getByTestId('home-rules').click();
  await expect(page.getByTestId('rules-screen')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Turn structure/i })).toBeVisible();
  await page.getByTestId('rules-back').click();
  await expect(page.getByTestId('home-screen')).toBeVisible();

  // Online: host or join, without opening a socket until one is chosen.
  await page.getByTestId('home-online').click();
  await expect(page.getByTestId('online-menu')).toBeVisible();
  await expect(page.getByTestId('online-host')).toBeVisible();
  await page.getByTestId('online-join').click();
  const code = page.getByTestId('online-join-code');
  // Codes are normalized as typed: uppercase, and no junk characters.
  await code.fill('ab2-cd');
  await expect(code).toHaveValue('AB2CD');
  await expect(page.getByTestId('online-join-go')).toBeDisabled();
  await code.fill('AB2CD4');
  await expect(page.getByTestId('online-join-go')).toBeEnabled();
  await page.getByTestId('online-back').click();
  await expect(page.getByTestId('home-screen')).toBeVisible();

  // Local: the pre-existing setup screen, reachable and reversible.
  await page.getByTestId('home-local').click();
  await expect(page.getByTestId('start-game')).toBeVisible();
  await page.getByTestId('setup-back').click();
  await expect(page.getByTestId('home-screen')).toBeVisible();
});
