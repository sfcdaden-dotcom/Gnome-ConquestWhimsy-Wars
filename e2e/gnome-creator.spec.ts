/**
 * The character creator, driven through the browser.
 *
 * The parts worth pinning here are the ones no unit test can reach: the
 * compositing actually produces a picture, a choice made in the modal survives
 * Done and reaches the board, Cancel throws it away, and every seat ends up
 * with a gnome of its own.
 */

import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { Game } from './helpers';

async function openSetup(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('home-local').click();
}

async function openCreator(page: Page, seat: number): Promise<void> {
  await page.getByTestId(`seat-${seat}-gnome`).click();
  await expect(page.getByTestId('gnome-creator')).toBeVisible();
}

/**
 * The composited sprite as a data URL. Two gnomes are the same gnome exactly
 * when these match, which is what makes it a usable identity in a test.
 */
async function spriteOf(chip: Locator): Promise<string> {
  const img = chip.locator('img.gnome-portrait');
  await expect(img).toHaveAttribute('src', /^data:image\/png/, { timeout: 10_000 });
  return (await img.getAttribute('src')) ?? '';
}

test('a gnome is composited and shown on the seat', async ({ page }) => {
  await openSetup(page);
  const sprite = await spriteOf(page.getByTestId('seat-0-gnome'));
  // A blank canvas encodes to a very short data URL; a drawn one does not.
  expect(sprite.length).toBeGreaterThan(500);
});

test('every seat gets a different gnome', async ({ page }) => {
  await openSetup(page);
  await page.getByTestId('player-count-4').click();
  const sprites = await Promise.all(
    [0, 1, 2, 3].map((i) => spriteOf(page.getByTestId(`seat-${i}-gnome`))),
  );
  expect(new Set(sprites).size).toBe(4);
});

test('a cap chosen in the creator reaches the seat and the board', async ({ page }) => {
  await openSetup(page);
  const chip = page.getByTestId('seat-0-gnome');
  const before = await spriteOf(chip);

  await openCreator(page, 0);
  const capBefore = await page.getByTestId('gnome-cap-value').textContent();
  await page.getByTestId('gnome-cap-next').click();
  await expect(page.getByTestId('gnome-cap-value')).not.toHaveText(capBefore ?? '');
  await page.getByTestId('gnome-save').click();

  await expect(page.getByTestId('gnome-creator')).toHaveCount(0);
  const after = await spriteOf(chip);
  expect(after).not.toBe(before);

  // And it is that same picture on the board, not merely a different one.
  // Players start with no gnomes out, so one has to be harvested first — and
  // the roll-off decides who moves first, so seat 0 may need to wait a turn.
  await page.getByTestId('seat-1-human').click();
  await page.getByTestId('start-game').click();

  const g = new Game(page);
  await g.completeRollOff();
  const token = page.locator('.token.gnome[data-owner="0"] img');
  for (let turn = 0; turn < 4 && (await token.count()) === 0; turn++) {
    await g.resolveHarvest('gnome');
    if ((await token.count()) > 0) break;
    await g.endTurn();
    await g.ready();
  }

  await expect(token.first()).toBeVisible({ timeout: 15_000 });
  expect(await token.first().getAttribute('src')).toBe(after);
});

test('cancelling keeps the gnome the seat already had', async ({ page }) => {
  await openSetup(page);
  const chip = page.getByTestId('seat-0-gnome');
  const before = await spriteOf(chip);

  await openCreator(page, 0);
  await page.getByTestId('gnome-cap-next').click();
  await page.getByTestId('gnome-skin-5').click();
  await page.getByTestId('gnome-cancel').click();

  await expect(page.getByTestId('gnome-creator')).toHaveCount(0);
  expect(await spriteOf(chip)).toBe(before);
});

test('an optional layer can be taken off and put back', async ({ page }) => {
  await openSetup(page);
  await openCreator(page, 0);

  // Cycling a layer that offers "None" must reach it, and come back.
  const value = page.getByTestId('gnome-beard-value');
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) {
    seen.push(((await value.textContent()) ?? '').trim());
    await page.getByTestId('gnome-beard-next').click();
  }
  expect(seen.some((t) => t.startsWith('None'))).toBe(true);
  expect(seen.filter((t) => !t.startsWith('None')).length).toBeGreaterThan(0);
});

test('the clothes swatches are the seat’s colour, not a free choice', async ({ page }) => {
  await openSetup(page);
  await page.getByTestId('player-count-4').click();

  // Seat 0 is red and seat 1 is blue, so their clothes rows must not offer
  // the same colours — that is the whole ownership signal on the board.
  await openCreator(page, 0);
  const red = await page.getByTestId('gnome-garment-0').evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.getByTestId('gnome-cancel').click();

  await openCreator(page, 1);
  const blue = await page.getByTestId('gnome-garment-0').evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.getByTestId('gnome-cancel').click();

  expect(red).not.toBe(blue);
});

test('the hair colour reaches the eyebrows, even on a gnome with no hair', async ({ page }) => {
  await openSetup(page);
  await openCreator(page, 0);

  // Strip the hair and the beard, so the only hair-coloured pixels left on the
  // gnome are the eyebrows. Changing the hair colour must still redraw it.
  const clear = async (layer: 'hair' | 'beard') => {
    const value = page.getByTestId(`gnome-${layer}-value`);
    for (let i = 0; i < 8; i++) {
      if (((await value.textContent()) ?? '').trim().startsWith('None')) return;
      await page.getByTestId(`gnome-${layer}-next`).click();
    }
    throw new Error(`could not clear the ${layer}`);
  };
  await clear('hair');
  await clear('beard');

  const stage = page.locator('.gnome-portrait.big');
  await expect(stage).toHaveAttribute('src', /^data:image\/png/, { timeout: 10_000 });
  const bald = await stage.getAttribute('src');

  await page.getByTestId('gnome-hair-color-5').click();
  await expect(stage).not.toHaveAttribute('src', bald ?? '', { timeout: 10_000 });
});

test('surprise me changes the gnome', async ({ page }) => {
  await openSetup(page);
  await openCreator(page, 0);
  const stage = page.locator('.gnome-portrait.big');
  const before = await spriteOf(page.getByTestId('seat-0-gnome'));

  // Random can land on what was already there; a couple of rolls makes that
  // vanishingly unlikely without making the test depend on luck.
  for (let i = 0; i < 5; i++) {
    await page.getByTestId('gnome-randomize').click();
    await expect(stage).toHaveAttribute('src', /^data:image\/png/, { timeout: 10_000 });
    if ((await stage.getAttribute('src')) !== before) return;
  }
  throw new Error('five random gnomes in a row were identical to the starting one');
});
