/**
 * Layouts, driven through the DOM.
 *
 * The setup screen shows the board: its preview, a menu of what will be
 * played (the three generated modes, this session's own layouts, and any
 * classic already used), its size and a re-roll. Managing layouts lives on
 * the Layouts page of Customize game: the classic layouts, drawing your own,
 * editing, exporting, importing, removing, and the map number. The editor has
 * two exits that use a layout — playing it, and saving a file first — and
 * these tests pin the difference between them.
 */

import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { openLayouts, selectLayout, setController, setSeed } from './helpers';

const SEED = 4242;

/** Home → local setup. The setup screen is not the landing page. */
async function openSetup(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('home-local').click();
}

const select = (page: Page) => page.getByTestId('preset-select');

/** Open the editor on a blank board: Customize game → Layouts → Draw your own. */
async function openEditor(page: Page): Promise<void> {
  await openLayouts(page);
  await page.getByTestId('draw-layout').click();
  await expect(page.getByTestId('preset-play')).toBeVisible();
}

/** Open the editor on the selected layout: Customize game → Layouts → Edit. */
async function editSelected(page: Page): Promise<void> {
  await openLayouts(page);
  await page.getByTestId('edit-preset').click();
  await expect(page.getByTestId('preset-play')).toBeVisible();
}

/** Set the board size from the advanced panel. */
async function setBoardSize(page: Page, size: number): Promise<void> {
  await page.getByTestId('open-advanced').click();
  await page.getByTestId(`board-size-${size}`).click();
  await page.getByTestId('advanced-done').click();
}

/** Pick one of the classic fixed layouts (through the Layouts page on first use). */
async function selectClassic(page: Page, id: string): Promise<void> {
  await selectLayout(page, id);
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

test('the setup screen keeps layout management off the default screen', async ({ page }) => {
  await openSetup(page);
  const section = page.getByTestId('preset-section');

  // What an ordinary game needs is here: the menu, the board's size, a re-roll
  // and one line about the layout.
  await expect(select(page)).toBeVisible();
  await expect(page.getByTestId('board-dims')).toHaveText('7×7');
  await expect(page.getByTestId('reroll-layout')).toBeVisible();
  await expect(page.getByTestId('layout-summary')).toBeVisible();

  // Management is not: it is all on the Layouts page.
  for (const id of ['draw-layout', 'edit-preset', 'export-preset', 'import-preset', 'remove-preset', 'layout-map-number']) {
    await expect(page.getByTestId(id)).toHaveCount(0);
  }
  await expect(section).not.toContainText('Map #');
  await expect(page.getByTestId('toggle-classic-presets')).toHaveCount(0);
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

test('the menu names what will be played; classics come from the Layouts page', async ({ page }) => {
  await openSetup(page);

  // What a player sees on arrival: the three modes, and no commands.
  const labels = async () => (await select(page).locator('option').allTextContents()).map((l) => l.trim());
  expect(await labels()).toEqual(['Fresh', 'Bare Essentials', 'True Random']);
  await expect(select(page)).toHaveValue('random');

  // Every classic is on the Layouts page, and choosing one takes effect at once.
  await openLayouts(page);
  await expect(page.getByTestId('layout-option-gauntlet')).toBeVisible();
  await page.getByTestId('layout-option-few').click();
  await expect(page.getByTestId('layout-option-few')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('advanced-done').click();

  // The main screen then names it, and the menu keeps it for the session —
  // switching away and back needs no second trip to the Layouts page.
  await expect(select(page)).toHaveValue('few');
  await expect(select(page).locator('option:checked')).toHaveText('Few (tunnels)');
  await select(page).selectOption('fresh');
  expect(await labels()).toContain('Few (tunnels)');
  await select(page).selectOption('few');
  await expect(select(page)).toHaveValue('few');
  // A fixed layout has nothing to re-roll.
  await expect(page.getByTestId('reroll-layout')).toHaveCount(0);
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
  expect(await gardens().count()).toBeGreaterThan(0);
  expect(before).toBeGreaterThan(0);

  // The rolled map's number is on the Layouts page.
  await openLayouts(page);
  await expect(page.getByTestId('layout-map-number')).toHaveText(/Map #\d+/);
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

test('Draw your own opens the editor; cancelling keeps the previous layout', async ({ page }) => {
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
  await setController(page, 0, 'human');
  await setController(page, 1, 'human');
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
  await editSelected(page);
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
  await editSelected(page);
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
  await setController(page, 0, 'human');
  await setController(page, 1, 'human');
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

  // …and a fresh session can import it back, from the Layouts page.
  await openSetup(page);
  await openLayouts(page);
  await page.getByLabel('Import a garden preset file').setInputFiles(file!);
  await expect(page.getByTestId('layouts-page').locator('.layout-option.on')).toContainText('Twin Rivers');
  await page.getByTestId('advanced-done').click();
  await expect(select(page).locator('option:checked')).toHaveText('Twin Rivers');
});

test('the Layouts page exports the selected layout as a file', async ({ page }) => {
  await openSetup(page);
  await selectClassic(page, 'few');
  await openLayouts(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-preset').click()]);
  expect(download.suggestedFilename()).toMatch(/\.whimsy-preset\.json$/);
  const saved = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(saved).toMatchObject({ kind: 'whimsy-wars-garden-preset', boardSize: 7 });
  expect(saved.gardens).toHaveLength(4);
});

test('removing a session layout drops it from the menu and falls back to the default', async ({ page }) => {
  await openSetup(page);
  await openEditor(page);
  await paint(page, 'Space 1,1');
  await page.getByTestId('preset-play').click();
  await expect(select(page).locator('option:checked')).toHaveText('Unnamed preset 1');

  // Only a layout made this session can be removed; a stock one cannot.
  await openLayouts(page);
  await page.getByTestId('remove-preset').click();
  await expect(page.getByTestId('remove-preset')).toHaveCount(0);
  await page.getByTestId('advanced-done').click();

  await expect(select(page)).toHaveValue('random');
  await expect(select(page).locator('option', { hasText: 'Unnamed preset' })).toHaveCount(0);
});

test('the editor draws the board the game is set up to play, not a fixed 7×7', async ({ page }) => {
  await openSetup(page);
  await select(page).selectOption('fresh');

  // Board size chosen in the dialog and carried straight into Draw your own,
  // without pressing Done first: leaving for the editor applies it.
  await page.getByTestId('open-advanced').click();
  await page.getByTestId('board-size-13').click();
  await page.getByTestId('open-layouts').click();
  await page.getByTestId('draw-layout').click();
  await expect(page.getByTestId('preset-play')).toBeVisible();
  const board = page.getByLabel('Preset editor board');
  await expect(board.locator('.cell')).toHaveCount(13 * 13);
  // Homes sit on the 13×13 edge midpoints, which do not exist on a 7×7 grid.
  await expect(page.getByRole('button', { name: 'Space 0,6, Home 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Space 12,6, Home 3' })).toBeVisible();

  // A garden painted out past the old grid survives the round trip.
  await paint(page, 'Space 11,11');
  await page.getByTestId('preset-play').click();
  await expect(page.locator('.preset-preview .cell')).toHaveCount(13 * 13);
  await expect(page.locator('.preset-preview .cell.g-tunnel')).toHaveCount(1);
});

test('the board zooms and pans under the HUD, which keeps its own size', async ({ page }) => {
  await openSetup(page);
  await setBoardSize(page, 13);
  await openEditor(page);

  const content = page.locator('.panzoom-content');
  const hud = page.locator('.editor-panel-top');
  // The rendered scale, read in the page (DOMMatrix is a browser API).
  const scaleOf = () => content.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);

  // A 13×13 board opens fitted: all of it on screen, at less than full size.
  const fitted = await scaleOf();
  expect(fitted).toBeLessThan(1);
  const hudBefore = await hud.boundingBox();

  await page.getByRole('button', { name: 'Zoom in' }).click();
  const zoomed = await scaleOf();
  expect(zoomed).toBeGreaterThan(fitted);

  // The HUD is a sibling of the viewport, so zooming the board leaves it alone.
  expect(await hud.boundingBox()).toEqual(hudBefore);

  // Zoom in far enough that the board outgrows the screen and has somewhere
  // to be panned to.
  for (let i = 0; i < 8; i += 1) await page.getByRole('button', { name: 'Zoom in' }).click();

  // Dragging the board pans it rather than painting the cell it starts on.
  const before = await content.boundingBox();
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
  await page.mouse.down();
  await page.mouse.move(before!.x + before!.width / 2 - 80, before!.y + before!.height / 2, { steps: 6 });
  await page.mouse.up();
  const after = await content.boundingBox();
  expect(after!.x).toBeLessThan(before!.x);
  await expect(page.locator('.editor-board .cell[class*=" g-"]')).toHaveCount(0);

  // Fit puts it back.
  await page.getByRole('button', { name: 'Fit board to screen' }).click();
  expect(await scaleOf()).toBeCloseTo(fitted, 3);
});
