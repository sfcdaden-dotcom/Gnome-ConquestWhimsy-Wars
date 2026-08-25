/**
 * The preset area of the setup screen, driven through the DOM.
 *
 * Everything preset-related lives in one block below the board preview: the
 * layout dropdown (three generated modes, then this session's own layouts, a
 * "Custom" entry that opens the editor, and the classic fixed layouts behind a
 * toggle), re-roll, and import/export. The editor has two exits that use a
 * layout — playing it, and saving a file first — and these tests pin the
 * difference between them.
 */

import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { setSeed, showClassicPresets } from './helpers';

const SEED = 4242;

/** Home → local setup. The setup screen is not the landing page. */
async function openSetup(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('home-local').click();
}

const select = (page: Page) => page.getByTestId('preset-select');

/** Open the editor the only way there is: the dropdown's Custom entry. */
async function openEditor(page: Page): Promise<void> {
  await select(page).selectOption('__custom__');
  await expect(page.getByTestId('preset-play')).toBeVisible();
}

/** Pick one of the classic fixed layouts, revealing that group first. */
async function selectClassic(page: Page, id: string): Promise<void> {
  await showClassicPresets(page);
  await select(page).selectOption(id);
}

/** Paint one garden of the current tool on an empty space. */
async function paint(page: Page, cellLabel: string): Promise<void> {
  await page.getByRole('button', { name: cellLabel, exact: true }).click();
}

test('the preset dropdown sits below the preview with the other preset controls', async ({ page }) => {
  await openSetup(page);

  const section = page.getByTestId('preset-section');
  await expect(section.locator('.preset-preview')).toBeVisible();
  await expect(section.getByTestId('preset-select')).toBeVisible();
  await expect(section.getByTestId('reroll-layout')).toBeVisible();

  // DOM order inside the block: preview first, controls after it.
  const previewFirst = await section.evaluate((el) => {
    const preview = el.querySelector('.preset-preview')!;
    const dropdown = el.querySelector('[data-testid="preset-select"]')!;
    return !!(preview.compareDocumentPosition(dropdown) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(previewFirst).toBe(true);
});

test('every preset previews, not just the procedural one', async ({ page }) => {
  await openSetup(page);
  const preview = page.locator('.preset-preview');
  const gardens = () => preview.locator('.cell[class*=" g-"]');

  // A fixed built-in preset draws its own layout…
  await selectClassic(page, 'few');
  await expect(preview).toBeVisible();
  await expect(gardens()).toHaveCount(4); // four tunnel corners
  await expect(page.getByTestId('reroll-layout')).toHaveCount(0); // nothing to re-roll

  // …including the empty one, which is homes only.
  await selectClassic(page, 'none');
  await expect(preview).toBeVisible();
  await expect(gardens()).toHaveCount(0);
  await expect(preview.locator('.cell.editor-home')).toHaveCount(4);

  await selectClassic(page, 'many');
  await expect(gardens()).toHaveCount(16);

  // …and so does a layout drawn in the editor.
  await openEditor(page);
  await paint(page, 'Space 1,1');
  await page.getByTestId('preset-play').click();
  await expect(gardens()).toHaveCount(1);
});

test('two seats dim the homes they will not use, four light them all', async ({ page }) => {
  await openSetup(page);
  await selectClassic(page, 'orchard');
  const preview = page.locator('.preset-preview');

  await page.getByTestId('player-count-2').click();
  await expect(preview.locator('.cell.editor-home')).toHaveCount(4);
  await expect(preview.locator('.cell.editor-home.unseated')).toHaveCount(2);

  await page.getByTestId('player-count-4').click();
  await expect(preview.locator('.cell.editor-home.unseated')).toHaveCount(0);
});

test('the old standalone labels and buttons are gone', async ({ page }) => {
  await openSetup(page);

  // No "Extra gardens" (or any other) label beside the dropdown — the
  // selected value says what the control is. `.preset-description` text is
  // prose about the chosen layout, not a label, so it may still mention
  // gardens.
  await expect(page.locator('.setup-label', { hasText: /garden/i })).toHaveCount(0);
  await expect(page.getByTestId('preset-section').locator('.setup-label')).toHaveCount(0);
  // …and no standalone custom-preset button: the dropdown is the only door.
  await expect(page.getByRole('button', { name: /New preset|Edit this preset|Custom Preset/i })).toHaveCount(0);
});

test('the menu leads with the three modes and folds the classic layouts away', async ({ page }) => {
  await openSetup(page);

  // What a player sees on arrival: the modes, then the door to the editor.
  const labels = async () => (await select(page).locator('option').allTextContents()).map((l) => l.trim());
  expect(await labels()).toEqual(['Fresh', 'Bare Essentials', 'True Random', 'Custom — draw your own…']);
  await expect(select(page)).toHaveValue('random');

  // The classics are one click away, and every one of them still plays.
  await showClassicPresets(page);
  expect(await labels()).toContain('Gauntlet');
  await select(page).selectOption('few');
  await expect(select(page)).toHaveValue('few');

  // While a classic is selected the group cannot be folded back away — the
  // menu would otherwise show a blank selection.
  await expect(page.getByTestId('toggle-classic-presets')).toBeDisabled();
  await select(page).selectOption('fresh');
  await expect(page.getByTestId('toggle-classic-presets')).toBeEnabled();
});

test('each mode previews the board it promises', async ({ page }) => {
  await openSetup(page);
  const preview = page.locator('.preset-preview');
  const gardens = () => preview.locator('.cell[class*=" g-"]');

  // Fresh: homes and nothing else.
  await select(page).selectOption('fresh');
  await expect(preview.locator('.cell.editor-home')).toHaveCount(4);
  await expect(gardens()).toHaveCount(0);

  // Bare Essentials: one mushroom and one dandelion orbit, on the doorsteps.
  await select(page).selectOption('essentials');
  await expect(preview.locator('.cell.g-mushroom')).toHaveCount(4);
  await expect(preview.locator('.cell.g-dandelion')).toHaveCount(4);
  await expect(gardens()).toHaveCount(8);

  // True Random: a full map, and a new one on every re-roll.
  await select(page).selectOption('random');
  await expect(gardens().first()).toBeVisible();
  const before = await gardens().count();
  await page.getByTestId('reroll-layout').click();
  await expect(page.getByTestId('preset-section')).toContainText('Map #');
  expect(await gardens().count()).toBeGreaterThan(0);
  expect(before).toBeGreaterThan(0);
});

test('the sparse modes fit a 5×5 board, where the full random map does not', async ({ page }) => {
  await openSetup(page);
  await select(page).selectOption('fresh');

  await page.getByTestId('open-advanced').click();
  await page.getByTestId('board-size-5').click();
  await page.getByTestId('advanced-done').click();

  await expect(page.locator('.preset-preview .cell')).toHaveCount(25);
  await expect(select(page)).toHaveValue('fresh');
  await select(page).selectOption('essentials');
  await expect(page.locator('.preset-preview .cell')).toHaveCount(25);
  // True Random needs a 7×7, and says so rather than offering itself.
  await expect(select(page).locator('option[value="random"]')).toBeDisabled();
});

test('choosing Custom opens the editor; cancelling keeps the previous preset', async ({ page }) => {
  await openSetup(page);
  await selectClassic(page, 'gauntlet');

  await openEditor(page);
  await expect(page.getByLabel('Preset editor board')).toBeVisible();

  await page.getByTestId('preset-cancel').click();
  await expect(page.getByTestId('preset-select')).toBeVisible();
  await expect(select(page)).toHaveValue('gauntlet');
});

test('plays a custom preset without saving: no download, no filename, and the map is used', async ({ page }) => {
  await openSetup(page);
  await openEditor(page);

  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));

  // Paint two tunnels. The name field is left blank on purpose: playing an
  // unsaved layout must not demand one.
  await paint(page, 'Space 1,1');
  await paint(page, 'Space 5,5');
  await page.getByTestId('preset-play').click();

  // Back on setup, with the unsaved layout selected and no file written.
  await expect(page.getByTestId('preset-select')).toBeVisible();
  await expect(select(page)).toHaveValue(/^custom:/);
  await expect(select(page).locator('option:checked')).toHaveText('Unnamed preset 1');
  expect(downloads).toEqual([]);

  // And it is the layout that actually gets played.
  await page.getByTestId('player-count-2').click();
  await page.getByTestId('seat-0-human').click();
  await page.getByTestId('seat-1-human').click();
  await setSeed(page, SEED);
  await page.getByTestId('start-game').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();

  const tunnels = await page.$$eval('[data-testid="game-screen"] .board .cell.g-tunnel', (cells) =>
    cells.map((c) => (c.getAttribute('data-testid') ?? '').replace('cell-', '')).sort(),
  );
  expect(tunnels).toEqual(['1,1', '5,5']);
  expect(downloads).toEqual([]);
});

test('unnamed layouts are numbered, and Edit reopens the selected one', async ({ page }) => {
  await openSetup(page);

  await openEditor(page);
  await paint(page, 'Space 1,1');
  await page.getByTestId('preset-play').click();
  await expect(select(page).locator('option:checked')).toHaveText('Unnamed preset 1');

  // "Custom" always starts a new layout, so a second unnamed one gets its own
  // number rather than replacing the first.
  await openEditor(page);
  await paint(page, 'Space 5,5');
  await page.getByTestId('preset-play').click();
  await expect(select(page).locator('option:checked')).toHaveText('Unnamed preset 2');
  await expect(select(page).locator('option')).toContainText([/Unnamed preset 1/, /Unnamed preset 2/]);

  // Edit reopens the SELECTED layout, keeping its number and its board.
  await page.getByTestId('edit-preset').click();
  await expect(page.getByLabel('Preset name')).toHaveValue('Unnamed preset 2');
  await expect(page.getByRole('button', { name: 'Space 5,5, Tunnel' })).toBeVisible();
  await page.getByTestId('preset-play').click();
  await expect(select(page).locator('option:checked')).toHaveText('Unnamed preset 2');
  await expect(select(page).locator('option', { hasText: 'Unnamed preset' })).toHaveCount(2);
});

test('a built-in preset can be edited and exported, which is how it becomes a file', async ({ page }) => {
  await openSetup(page);
  await selectClassic(page, 'few');

  // Edit opens the built-in's own map, as a copy — the registry is fixed at
  // build time, so the way to change a stock preset is to fork, export, and
  // drop the .json into src/engine/presets/.
  await page.getByTestId('edit-preset').click();
  await expect(page.getByLabel('Preset name')).toHaveValue('Few (tunnels) (copy)');
  await expect(page.getByRole('button', { name: 'Space 1,1, Tunnel' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Space 5,5, Tunnel' })).toBeVisible();

  // Move a home off its edge midpoint: pick it up, drop it on a free space.
  await page.getByRole('button', { name: 'Home 1' }).click();
  await page.getByRole('button', { name: 'Space 1,3', exact: true }).click();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('preset-save').click()]);
  expect(download.suggestedFilename()).toBe('few-tunnels-copy.whimsy-preset.json');
  const saved = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(saved.homes).toContainEqual({ x: 1, y: 3 });
  expect(saved.gardens).toHaveLength(4);
});

test('a preset shipped as a file plays its own home positions', async ({ page }) => {
  await openSetup(page);
  // src/engine/presets/midfield.whimsy-preset.json — registered by filename.
  await selectClassic(page, 'midfield');

  const preview = page.locator('.preset-preview');
  await expect(preview.locator('.cell.editor-home')).toHaveCount(4);

  await page.getByTestId('player-count-2').click();
  await page.getByTestId('seat-0-human').click();
  await page.getByTestId('seat-1-human').click();
  await setSeed(page, SEED);
  await page.getByTestId('start-game').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();

  const homes = await page.$$eval('[data-testid="game-screen"] .board .cell.g-home', (cells) =>
    cells.map((c) => (c.getAttribute('data-testid') ?? '').replace('cell-', '')).sort(),
  );
  expect(homes).toEqual(['1,3', '5,3']);
});

test('saving still exports a file, and the export imports back in', async ({ page }) => {
  await openSetup(page);
  await openEditor(page);

  // Saving keeps its name requirement — a file needs a filename.
  await page.getByTestId('preset-save').click();
  await expect(page.locator('.setup-error')).toHaveText(/name/i);
  await expect(page.getByTestId('preset-play')).toBeVisible(); // still in the editor

  await page.getByLabel('Preset name').fill('Twin Rivers');
  await paint(page, 'Space 2,2');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('preset-save').click()]);
  expect(download.suggestedFilename()).toBe('twin-rivers.whimsy-preset.json');
  const file = await download.path();
  await expect(select(page).locator('option:checked')).toHaveText('Twin Rivers');

  // The serialized file is still the documented v2 shape…
  const saved = JSON.parse(await readFile(file!, 'utf8'));
  expect(saved).toMatchObject({ kind: 'whimsy-wars-garden-preset', version: 2, label: 'Twin Rivers', boardSize: 7 });
  expect(saved.homes).toHaveLength(4);
  expect(saved.gardens).toEqual([{ pos: { x: 2, y: 2 }, type: 'tunnel' }]);

  // …and a fresh session can import it back.
  await openSetup(page);
  await page.getByLabel('Import a garden preset file').setInputFiles(file!);
  await expect(select(page).locator('option:checked')).toHaveText('Twin Rivers');
});
