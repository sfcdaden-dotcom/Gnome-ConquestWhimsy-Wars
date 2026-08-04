/**
 * The advanced settings panel on the setup screen.
 *
 * The panel edits a working copy, so what these tests pin is the boundary
 * between it and the game it starts: Cancel changes nothing, Done carries the
 * board size into the preview, a deck edited to nothing is refused before the
 * engine ever sees it, and a raised gnome/wish economy actually reaches play.
 */

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

async function openSetup(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('home-local').click();
}

async function openAdvanced(page: Page): Promise<void> {
  await page.getByTestId('open-advanced').click();
  await expect(page.getByRole('dialog', { name: 'Advanced settings' })).toBeVisible();
}

/** Cells in the setup screen's layout preview (n × n). */
const previewCells = (page: Page) => page.locator('.preset-preview .cell');

test('cancelling leaves the pending game exactly as it was', async ({ page }) => {
  await openSetup(page);
  await page.getByTestId('preset-select').selectOption('few');
  await expect(previewCells(page)).toHaveCount(49);

  await openAdvanced(page);
  await page.getByTestId('board-size-9').click();
  await page.getByTestId('setting-startingWishes').fill('7');
  await page.getByTestId('advanced-cancel').click();

  await expect(previewCells(page)).toHaveCount(49);
  await expect(page.getByTestId('open-advanced')).toHaveText(/Advanced settings$/);
});

test('a new board size reaches the preview and the game', async ({ page }) => {
  await openSetup(page);
  await page.getByTestId('preset-select').selectOption('few');

  await openAdvanced(page);
  await page.getByTestId('board-size-9').click();
  await page.getByTestId('advanced-done').click();

  await expect(previewCells(page)).toHaveCount(81);

  await page.getByTestId('player-count-2').click();
  await page.getByTestId('seat-1-human').click();
  await page.getByTestId('seed-input').fill('4242');
  await page.getByTestId('start-game').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();
  await expect(page.locator('.board').first().locator('button.cell')).toHaveCount(81);
});

test('a layout that no longer fits gives way to one that does', async ({ page }) => {
  await openSetup(page);
  await page.getByTestId('preset-select').selectOption('gauntlet');

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
  await page.getByTestId('preset-select').selectOption('midfield');

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

test('a raised wish economy is what the game starts with', async ({ page }) => {
  await openSetup(page);
  await openAdvanced(page);
  await page.getByTestId('setting-wishLimit').fill('9');
  await page.getByTestId('setting-startingWishes').fill('8');
  await page.getByTestId('advanced-done').click();

  await page.getByTestId('preset-select').selectOption('few');
  await page.getByTestId('player-count-2').click();
  await page.getByTestId('seat-1-human').click();
  await page.getByTestId('seed-input').fill('4242');
  await page.getByTestId('start-game').click();

  await expect(page.getByTestId('game-screen')).toBeVisible();
  await expect(page.locator('.player-panel').first()).toContainText('8');
});
