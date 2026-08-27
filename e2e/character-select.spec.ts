/**
 * Character select, driven through the DOM.
 *
 * The unit tests cover the catalogue, the derivation and the palette rules.
 * What only a browser can show is that a choice made on the setup screen is
 * the gnome that ends up on the board — the whole chain from a click, through
 * `CreateGameOptions`, through `createGame`, to a token's rendered image.
 */

import { expect, test } from '@playwright/test';

/** The `data-look` a token or avatar is rendering (see gnome.tsx). */
const LOOK = 'data-look';

test.describe('character select', () => {
  test('every seat starts with a complete gnome and its own colour', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('home-local').click();
    await page.getByTestId('player-count-4').click();

    const looks = await page.locator('.seat-list .seat-gnome').evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute('data-look') ?? ''),
    );
    expect(looks).toHaveLength(4);
    for (const look of looks) expect(look).toMatch(/^[a-z]+\/[a-z]+\/[a-z]+\/[a-z]+\/[a-z]+$/);

    // The palette is the first segment, and no two seats may share one.
    const palettes = looks.map((l) => l.split('/')[0]);
    expect(new Set(palettes).size).toBe(4);
  });

  test('picking parts changes the gnome, and the choice reaches the board', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('home-local').click();
    await page.getByTestId('player-count-2').click();
    await page.getByTestId('seat-0-human').click();
    await page.getByTestId('seat-1-human').click();

    await page.getByTestId('seat-0-customise').click();
    await expect(page.getByTestId('character-picker')).toBeVisible();

    await page.getByTestId('cc-palette-green').click();
    await page.getByTestId('cc-cap-wide').click();
    await page.getByTestId('cc-beard-bushy').click();
    await page.getByTestId('cc-weapon-staff').click();
    await page.getByTestId('cc-extra-lantern').click();

    const chosen = 'green/wide/bushy/staff/lantern';
    await expect(page.locator('.seat-list .seat-gnome').first()).toHaveAttribute(LOOK, chosen);

    await page.getByTestId('start-game').click();
    await expect(page.getByTestId('game-screen')).toBeVisible();

    // Seat 0's panel avatar is the gnome that was chosen, not a re-derived one.
    await expect(page.locator('.player-panel').first().locator('.pp-gnome')).toHaveAttribute(LOOK, chosen);
  });

  test('a colour another seat holds cannot be taken', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('home-local').click();
    await page.getByTestId('player-count-2').click();

    await page.getByTestId('seat-0-customise').click();
    await page.getByTestId('cc-palette-orange').click();
    await page.getByTestId('seat-0-customise').click(); // close

    await page.getByTestId('seat-1-customise').click();
    // Seat 0 has orange, so seat 1 is shown it as taken rather than being
    // allowed to pick it and silently reassigned later.
    await expect(page.getByTestId('cc-palette-orange')).toBeDisabled();
  });

  test('🎲 re-rolls the parts but never steals a colour', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('home-local').click();
    await page.getByTestId('player-count-2').click();
    await page.getByTestId('seat-0-customise').click();

    const avatar = page.locator('.seat-list .seat-gnome').first();
    const before = (await avatar.getAttribute(LOOK))!;
    const palette = before.split('/')[0];

    // One roll can legitimately land on the same parts; a few cannot.
    let changed = false;
    for (let i = 0; i < 8 && !changed; i++) {
      await page.getByTestId('cc-random').click();
      changed = (await avatar.getAttribute(LOOK)) !== before;
    }
    expect(changed).toBe(true);
    expect((await avatar.getAttribute(LOOK))!.split('/')[0]).toBe(palette);
  });

  test('an unnamed seat is named for the colour it is wearing', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('home-local').click();
    await page.getByTestId('player-count-2').click();

    const name = page.getByLabel('Seat 1 name');
    await page.getByTestId('seat-0-customise').click();
    await page.getByTestId('cc-palette-pink').click();
    await expect(name).toHaveAttribute('placeholder', 'Pink');

    await page.getByTestId('cc-palette-teal').click();
    await expect(name).toHaveAttribute('placeholder', 'Teal');

    // A name the player typed is theirs, and stops following the palette.
    await name.fill('Bramblewick');
    await page.getByTestId('cc-palette-green').click();
    await expect(name).toHaveValue('Bramblewick');
  });
});
