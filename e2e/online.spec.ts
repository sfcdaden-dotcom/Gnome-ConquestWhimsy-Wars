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

  await rollBtn.click();

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

  // Reload, and nothing else: the room is the page's address now, so this is
  // a new socket presenting this tab's token for a room it never left.
  await page.reload();

  // Straight back into the running game, in the same seat — not a spectator,
  // not a fresh lobby, and not the home screen.
  await expect(page.getByTestId('game-screen')).toBeVisible();
  await expect(page.getByText(`room ${code}`)).toBeVisible();
  await expect(page.locator('.hand-panel .panel-title')).toContainText('Ada', { timeout: 10_000 });
});

/**
 * Reloading the LOBBY is the thing a host actually does — it is how you check
 * whether your friend has turned up. It used to drop you on the home screen
 * with no way back but retyping the code, and it moved the start button to the
 * guest on the way out.
 */
test('a host can reload the lobby while waiting, and still be the host', async ({ browser }) => {
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

  // The guest arrives while the host is looking the other way.
  await guest.goto(`/?room=${code}`);
  await expect(guest.getByTestId('room-lobby')).toBeVisible();

  await host.reload();

  // Same room, no retyping — and the start button did not emigrate.
  await expect(host.getByTestId('room-lobby')).toBeVisible();
  await expect(host.getByTestId('lobby-code')).toHaveText(code);
  await expect(host.getByTestId('lobby-start')).toBeEnabled();
  await expect(guest.getByTestId('lobby-waiting')).toBeVisible();

  await host.getByTestId('lobby-start').click();
  await expect(host.getByTestId('game-screen')).toBeVisible();
  await expect(guest.getByTestId('game-screen')).toBeVisible();

  await hostCtx.close();
  await guestCtx.close();
});

/** An invite link needs no code typed at either end. */
test('an invite link drops a friend straight into the room', async ({ browser }) => {
  const ctx = await browser.newContext();
  const host = await ctx.newPage();

  await host.goto('/');
  await host.getByTestId('home-online').click();
  await host.getByTestId('online-host').click();
  await expect(host.getByTestId('room-lobby')).toBeVisible();
  const code = (await host.getByTestId('lobby-code').textContent())!.trim();

  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await guest.goto(`/?room=${code}`);

  // No home screen, no join form: the link IS the room.
  await expect(guest.getByTestId('room-lobby')).toBeVisible();
  await expect(guest.getByTestId('lobby-code')).toHaveText(code);
  await expect(host.getByTestId('lobby-start')).toBeEnabled();

  await ctx.close();
  await guestCtx.close();
});

/**
 * Two tabs of ONE browser are two players. This is how anyone tries the game
 * out alone, and it was the thing that made a room impossible to start: both
 * tabs shared a seat token through localStorage, so the second tab evicted the
 * first, the room only ever saw one player, and the start button stayed grey.
 */
test('two tabs in one browser are two players, not one seat fought over', async ({ browser }) => {
  const ctx = await browser.newContext();
  const host = await ctx.newPage();
  const guest = await ctx.newPage();

  await host.goto('/');
  await host.getByTestId('home-online').click();
  await host.getByTestId('online-name').fill('Ada');
  await host.getByTestId('online-host').click();
  await expect(host.getByTestId('room-lobby')).toBeVisible();
  const code = (await host.getByTestId('lobby-code').textContent())!.trim();

  // Same browser, same localStorage, second tab.
  await guest.goto(`/?room=${code}`);
  await expect(guest.getByTestId('room-lobby')).toBeVisible();

  // Neither tab was evicted, and the table has two people at it.
  await expect(host.getByTestId('lobby-taken-over')).toHaveCount(0);
  await expect(guest.getByTestId('lobby-taken-over')).toHaveCount(0);
  await expect(host.getByTestId('lobby-seat-0')).toContainText('(you)');
  await expect(guest.getByTestId('lobby-seat-1')).toContainText('(you)');

  await expect(host.getByTestId('lobby-start')).toBeEnabled();
  await host.getByTestId('lobby-start').click();
  await expect(host.getByTestId('game-screen')).toBeVisible();
  await expect(guest.getByTestId('game-screen')).toBeVisible();

  await ctx.close();
});
