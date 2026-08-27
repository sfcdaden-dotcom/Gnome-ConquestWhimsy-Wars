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
    await page.getByTestId('cc-accessory-lantern').click();

    // `data-look` is palette then the layers in DRAW order (weapon, beard,
    // cap, accessory) — see lookKey in gnomeImage.ts.
    const chosen = 'green/staff/bushy/wide/lantern';
    await expect(page.locator('.seat-list .seat-gnome').first()).toHaveAttribute(LOOK, chosen);

    await page.getByTestId('start-game').click();
    await expect(page.getByTestId('game-screen')).toBeVisible();

    // Seat 0's panel avatar is the gnome that was chosen, not a re-derived one.
    await expect(page.locator('.player-panel').first().locator('.pp-gnome')).toHaveAttribute(LOOK, chosen);
  });

  test('sharing a colour makes a team, and the board says who with', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('home-local').click();
    await page.getByTestId('player-count-4').click();

    // Seats 0 and 2 both take orange: that is the whole team-up gesture.
    await page.getByTestId('seat-0-customise').click();
    await page.getByTestId('cc-palette-orange').click();
    await page.getByTestId('seat-0-customise').click();

    await page.getByTestId('seat-2-customise').click();
    // Not disabled — picking a colour somebody has is how you join them.
    await expect(page.getByTestId('cc-palette-orange')).toBeEnabled();
    await page.getByTestId('cc-palette-orange').click();
    await page.getByTestId('seat-2-customise').click();

    const palettes = await page.locator('.seat-list .seat-gnome').evaluateAll((n) =>
      n.map((x) => (x.getAttribute('data-look') ?? '').split('/')[0]),
    );
    expect(palettes[0]).toBe('orange');
    expect(palettes[2]).toBe('orange');

    await page.getByTestId('start-game').click();
    await expect(page.getByTestId('game-screen')).toBeVisible();

    // Each partner's panel names the other.
    const panels = page.locator('.player-panel');
    await expect(panels.nth(0).locator('.pp-team')).toContainText(await panels.nth(2).locator('.pp-name').innerText());
    await expect(panels.nth(2).locator('.pp-team')).toContainText(await panels.nth(0).locator('.pp-name').innerText());
    // The free-for-all seats have no partner line.
    await expect(panels.nth(1).locator('.pp-team')).toHaveCount(0);
  });

  test('everyone on one colour is refused with a reason', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('home-local').click();
    await page.getByTestId('player-count-2').click();

    for (const seat of [0, 1]) {
      await page.getByTestId(`seat-${seat}-customise`).click();
      await page.getByTestId('cc-palette-pink').click();
      await page.getByTestId(`seat-${seat}-customise`).click();
    }
    await page.getByTestId('start-game').click();

    await expect(page.getByTestId('game-screen')).toHaveCount(0);
    await expect(page.getByText(/same colour/i)).toBeVisible();
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
