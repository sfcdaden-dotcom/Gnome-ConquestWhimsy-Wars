/**
 * The Customize game dialog on the setup screen (its settings; the Layouts
 * page is covered in presets.spec.ts).
 *
 * The panel edits a working copy, so what these tests pin is the boundary
 * between it and the game it starts: Cancel changes nothing, Done carries the
 * board size into the preview, a deck (or a garden budget) edited to nothing is
 * refused before the engine ever sees it, and a raised gnome/wish economy — or
 * a Center Star boon — actually reaches play.
 */

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { selectLayout, setController, setSeed } from './helpers';

async function openSetup(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('home-local').click();
}

async function openAdvanced(page: Page): Promise<void> {
  await page.getByTestId('open-advanced').click();
  await expect(page.getByRole('dialog', { name: 'Customize game' })).toBeVisible();
}

/** Cells in the setup screen's layout preview (n × n). */
const previewCells = (page: Page) => page.locator('.preset-preview .cell');

test('cancelling leaves the pending game exactly as it was', async ({ page }) => {
  await openSetup(page);
  await selectLayout(page, 'few');
  await expect(previewCells(page)).toHaveCount(49);

  await openAdvanced(page);
  await page.getByTestId('board-size-9').click();
  await page.getByTestId('setting-startingWishes').fill('7');
  await page.getByTestId('advanced-cancel').click();

  await expect(previewCells(page)).toHaveCount(49);
  // Nothing was applied, so the screen does not claim a customised game.
  await expect(page.getByTestId('customised-tag')).toHaveCount(0);
});

test('a new board size reaches the preview and the game', async ({ page }) => {
  await openSetup(page);
  await selectLayout(page, 'few');

  await openAdvanced(page);
  await page.getByTestId('board-size-9').click();
  await page.getByTestId('advanced-done').click();

  await expect(previewCells(page)).toHaveCount(81);
  // Applied settings are owned up to, quietly, beside the door that set them.
  await expect(page.getByTestId('customised-tag')).toBeVisible();
  await expect(page.getByTestId('board-dims')).toHaveText('9×9');

  await page.getByTestId('player-count-2').click();
  await setController(page, 1, 'human');
  await setSeed(page, 4242);
  await page.getByTestId('start-game').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();
  await expect(page.locator('.board').first().locator('button.cell')).toHaveCount(81);
});

test('a layout that no longer fits gives way to one that does', async ({ page }) => {
  await openSetup(page);
  await selectLayout(page, 'gauntlet');

  await openAdvanced(page);
  await page.getByTestId('board-size-5').click();
  await page.getByTestId('advanced-done').click();

  // Gauntlet needs 7×7; the setup screen says what it switched to.
  await expect(page.getByTestId('preset-select')).not.toHaveValue('gauntlet');
  await expect(page.getByTestId('preset-section')).toContainText('needs a 7×7 board');
  await expect(previewCells(page)).toHaveCount(25);
});

test('a player-drawn layout pins the board size, and says so', async ({ page }) => {
  await openSetup(page);
  // Every file-backed built-in is drawn on a fixed board, like an edited one.
  await selectLayout(page, 'midfield');

  await openAdvanced(page);
  await expect(page.getByTestId('board-size-9')).toBeDisabled();
  await expect(page.getByRole('dialog')).toContainText('fixed 7×7 board');
});

test('the deck editor changes card counts, and refuses an empty deck', async ({ page }) => {
  await openSetup(page);
  await openAdvanced(page);
  await page.getByTestId('open-deck-editor').click();
  const editor = page.getByTestId('deck-editor');
  await expect(editor).toContainText('51 cards');

  // Drop both copies of one card: the running total follows.
  await page.getByTestId('deck-count-snake-eyes').fill('0');
  await expect(editor).toContainText('49 cards');

  // Nothing but curses is not a deck — Done is blocked with the reason shown.
  const counts = page.locator('[data-testid^="deck-count-"]');
  for (const box of await counts.all()) await box.fill('0');
  await expect(page.getByTestId('advanced-done')).toBeDisabled();
  await expect(page.getByRole('dialog')).toContainText('at least one Whimsy card');

  // The stock-deck button puts every count back.
  await page.getByTestId('deck-reset').click();
  await expect(editor).toContainText('51 cards');
  await expect(page.getByTestId('advanced-done')).toBeEnabled();
});

test('the seed lives in the panel, and a bad one is refused', async ({ page }) => {
  await openSetup(page);
  // It is no longer a row on the setup screen itself.
  await expect(page.getByTestId('seed-input')).toBeHidden();

  await openAdvanced(page);
  await page.getByTestId('seed-input').fill('banana');
  await expect(page.getByTestId('advanced-done')).toBeDisabled();
  await expect(page.getByRole('dialog')).toContainText('Seed must be a number');

  await page.getByTestId('seed-input').fill('4242');
  await expect(page.getByTestId('advanced-done')).toBeEnabled();
  await page.getByTestId('advanced-done').click();

  // A pinned seed is owned up to without reopening the panel: the screen says
  // the game is customised, and the tag's tooltip says how.
  await expect(page.getByTestId('preset-section')).toBeVisible();
  await expect(page.getByTestId('customised-tag')).toHaveAttribute('title', /Seed 4242/);

  await selectLayout(page, 'few');
  await setController(page, 1, 'human');
  await page.getByTestId('start-game').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();
});

test('a raised wish economy is what the game starts with', async ({ page }) => {
  await openSetup(page);
  await openAdvanced(page);
  await page.getByTestId('setting-wishLimit').fill('9');
  await page.getByTestId('setting-startingWishes').fill('8');
  await page.getByTestId('advanced-done').click();

  await selectLayout(page, 'few');
  await page.getByTestId('player-count-2').click();
  await setController(page, 1, 'human');
  await setSeed(page, 4242);
  await page.getByTestId('start-game').click();

  await expect(page.getByTestId('game-screen')).toBeVisible();
  await expect(page.locator('.player-panel').first()).toContainText('8');
});

test('a big game board zooms and pans under the panels, which keep their size', async ({ page }) => {
  await openSetup(page);
  await selectLayout(page, 'few');
  await openAdvanced(page);
  await page.getByTestId('board-size-13').click();
  await page.getByTestId('advanced-done').click();

  await page.getByTestId('player-count-2').click();
  await setController(page, 1, 'human');
  await setSeed(page, 4242);
  await page.getByTestId('start-game').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();

  const board = page.locator('.board-stage .board');
  const content = page.locator('.board-stage .panzoom-content');
  const panels = page.locator('.right-col');
  const scaleOf = () => content.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);

  await expect(board.locator('button.cell')).toHaveCount(169);

  // It opens fitted into the gap the panels leave: fully on screen, and clear
  // of both columns rather than tucked under one.
  const fitted = await scaleOf();
  const [boardBox, leftBox, rightBox] = [
    await board.boundingBox(),
    await page.locator('.left-col').boundingBox(),
    await panels.boundingBox(),
  ];
  expect(boardBox!.x).toBeGreaterThanOrEqual(leftBox!.x + leftBox!.width);
  expect(boardBox!.x + boardBox!.width).toBeLessThanOrEqual(rightBox!.x + 1);

  // Zooming magnifies the board alone — the panels are siblings of the stage.
  const panelsBefore = await panels.boundingBox();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  expect(await scaleOf()).toBeGreaterThan(fitted);
  expect(await panels.boundingBox()).toEqual(panelsBefore);

  // Dragging pans the board rather than selecting the space it started on.
  for (let i = 0; i < 6; i += 1) await page.getByRole('button', { name: 'Zoom in' }).click();
  const before = await content.boundingBox();
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
  await page.mouse.down();
  await page.mouse.move(before!.x + before!.width / 2 - 90, before!.y + before!.height / 2, { steps: 6 });
  await page.mouse.up();
  expect((await content.boundingBox())!.x).toBeLessThan(before!.x);
  await expect(page.locator('.board .cell[data-selected="true"]')).toHaveCount(0);

  // Fit puts it back.
  await page.getByRole('button', { name: 'Fit board to screen' }).click();
  expect(await scaleOf()).toBeCloseTo(fitted, 3);
});

test('the garden editor changes tile budgets, and refuses an empty supply', async ({ page }) => {
  await openSetup(page);
  await openAdvanced(page);
  await page.getByTestId('open-garden-editor').click();
  const editor = page.getByTestId('garden-editor');
  // Six plantable types × 4 tiles each.
  await expect(editor).toContainText('24 tiles per player');

  await page.getByTestId('tile-count-mushroom').fill('9');
  await expect(editor).toContainText('29 tiles per player');

  // Nothing to plant at all is not a supply — Done is blocked with the reason.
  const counts = page.locator('[data-testid^="tile-count-"]');
  for (const box of await counts.all()) await box.fill('0');
  await expect(page.getByTestId('advanced-done')).toBeDisabled();
  await expect(page.getByRole('dialog')).toContainText('at least one garden tile');

  // The stock-supply button puts every count back.
  await page.getByTestId('garden-reset').click();
  await expect(editor).toContainText('24 tiles per player');
  await expect(page.getByTestId('advanced-done')).toBeEnabled();
});

test('a garden budget survives the panel and starts a game', async ({ page }) => {
  await openSetup(page);
  await openAdvanced(page);
  await page.getByTestId('open-garden-editor').click();
  await page.getByTestId('tile-count-mushroom').fill('7');
  await page.getByTestId('tile-count-flytrap').fill('0');
  await page.getByTestId('garden-back').click();
  // 24 stock − 4 flytraps + 3 extra mushrooms.
  await expect(page.getByTestId('open-garden-editor')).toContainText('23 tiles');
  await page.getByTestId('advanced-done').click();

  await selectLayout(page, 'few');
  await page.getByTestId('player-count-2').click();
  await setController(page, 1, 'human');
  await setSeed(page, 4242);
  await page.getByTestId('start-game').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();
});

test('the Center Star is a boon menu in the panel, not a toggle on the screen', async ({ page }) => {
  await openSetup(page);
  // It is no longer a row on the setup screen itself.
  await expect(page.getByTestId('center-star-boon')).toBeHidden();

  await openAdvanced(page);
  const boon = page.getByTestId('center-star-boon');
  await expect(boon).toHaveValue('wishCap');
  await expect(page.getByRole('dialog')).toContainText('your wish limit is one higher');

  await boon.selectOption('freeUpgrade');
  await expect(page.getByRole('dialog')).toContainText('upgraded for free');
  await page.getByTestId('advanced-done').click();

  // The choice is visible without reopening the panel (the Customised tag's tooltip).
  await expect(page.getByTestId('customised-tag')).toHaveAttribute('title', /Free upgrade on the star/);

  await selectLayout(page, 'few');
  await page.getByTestId('player-count-2').click();
  await setController(page, 1, 'human');
  await setSeed(page, 4242);
  await page.getByTestId('start-game').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();
});

test('switching the Center Star off clears it from the layout preview', async ({ page }) => {
  await openSetup(page);
  await selectLayout(page, 'few');
  const preview = page.locator('.preset-preview');
  await expect(preview.locator('[title="Center Star"]')).toHaveCount(1);

  await openAdvanced(page);
  await page.getByTestId('center-star-boon').selectOption('off');
  await page.getByTestId('advanced-done').click();

  await expect(preview.locator('[title="Center Star"]')).toHaveCount(0);
  await expect(page.getByTestId('customised-tag')).toHaveAttribute('title', /No Center Star/);
});
