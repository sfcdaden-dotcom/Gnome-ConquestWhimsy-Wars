/**
 * Online play through two real browsers against the real Worker.
 *
 * `vite preview` (the webServer in playwright.config.ts) runs the Cloudflare
 * plugin's miniflare, so the room Durable Object is live here — these are not
 * mocks. They cover the seam the unit tests cannot reach: the WebSocket
 * client, the lobby, and the fact that one player's action lands on the
 * other's screen without them touching anything.
 */

import { expect, test } from '@playwright/test';

/** Two real browser contexts against the real Worker: host, join, play. */
test('two browsers meet in a room and play a networked turn', async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  await host.goto('/');
  await host.getByTestId('home-online').click();
  await host.getByTestId('online-name').fill('Ada');
  await host.getByTestId('online-host').click();

  await expect(host.getByTestId('room-lobby')).toBeVisible();
  const code = (await host.getByTestId('lobby-code').textContent())!.trim();
  expect(code).toHaveLength(6);

  // Seat 1 is open for a person by default — the guest just joins with the
  // code and is sat down in it.
  await expect(host.getByTestId('lobby-start')).toBeDisabled();
  await guest.goto('/');
  await guest.getByTestId('home-online').click();
  await guest.getByTestId('online-name').fill('Bo');
  await guest.getByTestId('online-join').click();
  await guest.getByTestId('online-join-code').fill(code);
  await guest.getByTestId('online-join-go').click();
  await expect(guest.getByTestId('room-lobby')).toBeVisible();

  // The guest is not the host: no start button for them.
  await expect(guest.getByTestId('lobby-waiting')).toBeVisible();
  await expect(host.getByTestId('lobby-start')).toBeEnabled();
  await host.getByTestId('lobby-start').click();

  // Both land on the board, and both see the room code as the game tag.
  await expect(host.getByTestId('game-screen')).toBeVisible();
  await expect(guest.getByTestId('game-screen')).toBeVisible();
  await expect(host.getByText(`room ${code}`)).toBeVisible();

  // The roll-off runs in seat order, so the host (seat 0) is on the clock.
  const rollBtn = host.getByTestId('roll-off');
  await expect(rollBtn).toBeVisible();
  // The guest cannot act for a seat that is not theirs — no button for them.
  await expect(guest.getByTestId('roll-off')).toHaveCount(0);

  // ...and the shot clock says so, on both screens: the same seat is named,
  // and only the seat that owns it is told it is theirs.
  await expect(host.getByTestId('shot-clock')).toContainText('you');
  await expect(guest.getByTestId('shot-clock')).toContainText('Ada');
  await expect(guest.getByTestId('shot-clock')).toHaveAttribute('data-yours', 'false');

  await rollBtn.click();

  // It follows the turn: the guest is on the clock now.
  await expect(guest.getByTestId('shot-clock')).toContainText('you');

  // The guest's board advanced without the guest touching anything: the room
  // applied the host's action and broadcast the new state to both seats.
  await expect(guest.getByTestId('banner')).toContainText('Bo');
  await expect(guest.getByTestId('roll-off')).toBeVisible();

  await hostCtx.close();
  await guestCtx.close();
});

/** The seat a guest is watching from becomes theirs the moment it opens. */
test('a spectator is seated when the host frees up a seat', async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  await host.goto('/');
  await host.getByTestId('home-online').click();
  await host.getByTestId('online-name').fill('Ada');
  await host.getByTestId('online-host').click();
  await expect(host.getByTestId('room-lobby')).toBeVisible();
  const code = (await host.getByTestId('lobby-code').textContent())!.trim();

  // Host fills the other seat with a bot first, so the guest arrives to a
  // table with nowhere to sit.
  await host.getByTestId('lobby-seat-1-cpu').click();
  await guest.goto('/');
  await guest.getByTestId('home-online').click();
  await guest.getByTestId('online-name').fill('Bo');
  await guest.getByTestId('online-join').click();
  await guest.getByTestId('online-join-code').fill(code);
  await guest.getByTestId('online-join-go').click();
  await expect(guest.getByTestId('lobby-spectator')).toBeVisible();

  // The host makes room. Nobody re-joins, nobody refreshes.
  await host.getByTestId('lobby-seat-1-human').click();

  await expect(guest.getByTestId('lobby-seat-1')).toContainText('(you)');
  await expect(guest.getByTestId('lobby-spectator')).toHaveCount(0);
  await expect(host.getByTestId('lobby-start')).toBeEnabled();
  await host.getByTestId('lobby-start').click();
  await expect(guest.getByTestId('game-screen')).toBeVisible();

  await hostCtx.close();
  await guestCtx.close();
});

test('a refresh keeps your seat and your hand', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('home-online').click();
  await page.getByTestId('online-name').fill('Ada');
  await page.getByTestId('online-host').click();
  await expect(page.getByTestId('room-lobby')).toBeVisible();
  const code = (await page.getByTestId('lobby-code').textContent())!.trim();

  // Playing alone: the other seat is a person's until the host says otherwise.
  await page.getByTestId('lobby-seat-1-cpu').click();
  await expect(page.getByTestId('lobby-start')).toBeEnabled();
  await page.getByTestId('lobby-start').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();

  // Reload: a new socket, presenting the stored token for this room.
  await page.reload();
  await page.getByTestId('home-online').click();
  await page.getByTestId('online-join').click();
  await page.getByTestId('online-join-code').fill(code);
  await page.getByTestId('online-join-go').click();

  // Straight back into the running game, in the same seat — not a spectator,
  // and not a fresh lobby.
  await expect(page.getByTestId('game-screen')).toBeVisible();
  await expect(page.getByText(`room ${code}`)).toBeVisible();
  await expect(page.locator('.hand-panel .panel-title')).toContainText('Ada', { timeout: 10_000 });
});
