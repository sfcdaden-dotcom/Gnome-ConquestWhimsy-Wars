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
import { setLobbyController } from './helpers';

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

  // The guest is not the host: no start button for them, but the same
  // description of what the room is waiting for.
  await expect(guest.getByTestId('lobby-start')).toHaveCount(0);
  await expect(guest.getByTestId('lobby-blocker')).toHaveText(
    /Waiting for Ada to start the game/,
  );
  await expect(host.getByTestId('lobby-start')).toBeEnabled();
  // The host is waiting on nobody but themselves, and is told so directly.
  await expect(host.getByTestId('lobby-blocker')).toHaveText('Everyone is here. Start the game when you are ready.');
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
  await setLobbyController(host, 1, 'cpu');
  await guest.goto('/');
  await guest.getByTestId('home-online').click();
  await guest.getByTestId('online-name').fill('Bo');
  await guest.getByTestId('online-join').click();
  await guest.getByTestId('online-join-code').fill(code);
  await guest.getByTestId('online-join-go').click();
  await expect(guest.getByTestId('lobby-spectator')).toBeVisible();

  // The host makes room. Nobody re-joins, nobody refreshes.
  await setLobbyController(host, 1, 'human');

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
  await setLobbyController(page, 1, 'cpu');
  await expect(page.getByTestId('lobby-start')).toBeEnabled();
  await page.getByTestId('lobby-start').click();
  await expect(page.getByTestId('game-screen')).toBeVisible();

  // Say something first, so there is a transcript for the reload to rebuild.
  await page.getByTestId('quickchat-open').click();
  await page.getByTestId('quickchat-group-greetings').click();
  await page.getByTestId('quickchat-say-hi').click();

  // Reload, and nothing else: the room is the page's address now, so this is
  // a new socket presenting this tab's token for a room it never left.
  await page.reload();

  // Straight back into the running game, in the same seat — not a spectator,
  // not a fresh lobby, and not the home screen.
  await expect(page.getByTestId('game-screen')).toBeVisible();
  await expect(page.getByText(`room ${code}`)).toBeVisible();
  await expect(page.locator('.hand-panel .panel-title')).toContainText('Ada', { timeout: 10_000 });

  // The transcript came back with it — as history, not as unread news.
  await expect(page.getByTestId('chat-unread')).toHaveCount(0);
  await page.getByTestId('chat-tab-chat').click();
  await expect(page.getByTestId('chat-transcript')).toContainText('Hi!');
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
  await expect(guest.getByTestId('lobby-start')).toHaveCount(0);

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

/**
 * Closing the tab and coming back to the app — with no link and no code in
 * hand — used to be the end of a room, even though the credentials to walk
 * straight back in were sitting in storage the whole time.
 */
test('the menu offers a way back into the room you just left', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto('/');
  await page.getByTestId('home-online').click();
  await page.getByTestId('online-name').fill('Ada');
  await page.getByTestId('online-host').click();
  await expect(page.getByTestId('room-lobby')).toBeVisible();
  const code = (await page.getByTestId('lobby-code').textContent())!.trim();

  // Back to the app with no room in the URL at all — the bookmark, not the
  // invite link.
  await page.goto('/');
  await page.getByTestId('home-online').click();

  const rejoin = page.getByTestId('online-rejoin');
  await expect(rejoin).toContainText(code);
  await rejoin.click();

  // Same room, same seat, still the host.
  await expect(page.getByTestId('room-lobby')).toBeVisible();
  await expect(page.getByTestId('lobby-code')).toHaveText(code);
  await expect(page.getByTestId('lobby-start')).toBeVisible();

  await ctx.close();
});

/**
 * The living-room setup: a board view on the TV, opened BEFORE anybody
 * arrives, and two phones joining it.
 *
 * The order is the whole point. The screen in the middle of the room is the
 * one people set up first, and it used to be the screen that claimed the
 * lobby — leaving the start button on a projector with no keyboard in front of
 * it. It now opens the room and hands it to the first person who sits down.
 */
test('a board view opens a room and hands the lobby to the first player', async ({ browser }) => {
  const tvCtx = await browser.newContext();
  const p1Ctx = await browser.newContext();
  const p2Ctx = await browser.newContext();
  const tv = await tvCtx.newPage();
  const p1 = await p1Ctx.newPage();
  const p2 = await p2Ctx.newPage();

  // The TV goes on first, with nobody in the room.
  await tv.goto('/');
  await tv.getByTestId('home-online').click();
  await tv.getByTestId('online-board-view').click();

  await expect(tv.getByTestId('board-view')).toBeVisible();
  const code = (await tv.getByTestId('bv-code').textContent())!.trim();
  expect(code).toHaveLength(6);
  // It is the room's screen, not a player's: the address says so, and survives.
  expect(new URL(tv.url()).searchParams.get('view')).toBe('board');
  await expect(tv.getByTestId('bv-status')).toHaveText(/First player to sit down/);

  // Every seat is still empty — the TV took none of them.
  await expect(tv.getByTestId('bv-seats').locator('.bv-seat.here')).toHaveCount(0);

  // First player in gets the lobby.
  await p1.goto('/');
  await p1.getByTestId('home-online').click();
  await p1.getByTestId('online-name').fill('Ada');
  await p1.getByTestId('online-join').click();
  await p1.getByTestId('online-join-code').fill(code);
  await p1.getByTestId('online-join-go').click();
  await expect(p1.getByTestId('room-lobby')).toBeVisible();
  await expect(p1.getByTestId('lobby-start')).toBeVisible();

  // Second player is an ordinary guest, and the TV shows both of them.
  await p2.goto('/');
  await p2.getByTestId('home-online').click();
  await p2.getByTestId('online-name').fill('Bo');
  await p2.getByTestId('online-join').click();
  await p2.getByTestId('online-join-code').fill(code);
  await p2.getByTestId('online-join-go').click();
  await expect(p2.getByTestId('room-lobby')).toBeVisible();
  await expect(p2.getByTestId('lobby-start')).toHaveCount(0);
  await expect(tv.getByTestId('bv-seats').locator('.bv-seat.here')).toHaveCount(2);

  // The start button is on a phone, which is where somebody can reach it.
  await expect(p1.getByTestId('lobby-start')).toBeEnabled();
  await p1.getByTestId('lobby-start').click();

  // The TV follows the game without being dealt into it: a board, and no hand.
  await expect(tv.getByTestId('board-view')).toBeVisible();
  await expect(tv.getByTestId('bv-turn')).toBeVisible();
  await expect(tv.getByTestId('hand-cards')).toHaveCount(0);
  await expect(tv.getByTestId('roll-off')).toHaveCount(0);
  // The players are playing, on their own screens.
  await expect(p1.getByTestId('game-screen')).toBeVisible();
  await expect(p1.getByTestId('roll-off')).toBeVisible();

  // A reload of the TV comes back as the TV — not as a menu, and not as a
  // player holding a seat. Nobody is standing at it to fix that.
  await tv.reload();
  await expect(tv.getByTestId('board-view')).toBeVisible();
  await expect(tv.getByTestId('hand-cards')).toHaveCount(0);

  await tvCtx.close();
  await p1Ctx.close();
  await p2Ctx.close();
});

/**
 * A player whose page is older than the room.
 *
 * Protocol versions are bumped when the wire changes, so this happens for real
 * every time a build ships while somebody has a tab open. The old behaviour was
 * the bad kind of broken: the room hung up, the client treated it as a dropped
 * tunnel and redialled forever, and the player got an error toast every few
 * seconds on a game whose buttons quietly did nothing.
 *
 * The mismatch is forced by rewriting the version on the way out of the socket,
 * which is as close to a stale bundle as a single build can get.
 */
test('a page older than the room is told to reload, not left redialling', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.addInitScript(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data: string) {
      if (typeof data === 'string' && data.includes('"t":"hello"')) {
        const msg = JSON.parse(data);
        (window as unknown as { dials: number }).dials =
          ((window as unknown as { dials?: number }).dials ?? 0) + 1;
        msg.protocol = 1; // an older build than any room speaks
        return send.call(this, JSON.stringify(msg));
      }
      return send.call(this, data);
    };
  });

  await page.goto('/');
  await page.getByTestId('home-online').click();
  await page.getByTestId('online-host').click();

  // One screen, naming the one thing that fixes it.
  await expect(page.getByTestId('room-stale')).toBeVisible();
  await expect(page.getByTestId('room-stale-reload')).toBeVisible();
  await expect(page.getByTestId('room-stale')).toContainText(/[Rr]eload/);

  // And it STAYS down. The old build redialled on a 10s ceiling, so this window
  // would have carried several more attempts and an error toast for each.
  const dialsAfterFirst = await page.evaluate(() => (window as unknown as { dials: number }).dials);
  await page.waitForTimeout(12_000);
  const dialsLater = await page.evaluate(() => (window as unknown as { dials: number }).dials);
  expect(dialsLater).toBe(dialsAfterFirst);
  await expect(page.locator('.toast')).toHaveCount(0);

  await ctx.close();
});

/**
 * Chat on the projector.
 *
 * The phones show chat as bubbles that fade, which suits a screen you are
 * already looking at. A TV is the opposite: nobody watches it continuously, and
 * the reason to glance up is to catch what was missed — so the board view keeps
 * the last few lines standing until they are pushed off.
 */
test('the board view keeps recent chat on screen', async ({ browser }) => {
  const tvCtx = await browser.newContext();
  const p1Ctx = await browser.newContext();
  const p2Ctx = await browser.newContext();
  const tv = await tvCtx.newPage();
  const p1 = await p1Ctx.newPage();
  const p2 = await p2Ctx.newPage();

  await tv.goto('/');
  await tv.getByTestId('home-online').click();
  await tv.getByTestId('online-board-view').click();
  const code = (await tv.getByTestId('bv-code').textContent())!.trim();

  for (const [page, name] of [[p1, 'Ada'], [p2, 'Bo']] as const) {
    await page.goto('/');
    await page.getByTestId('home-online').click();
    await page.getByTestId('online-name').fill(name);
    await page.getByTestId('online-join').click();
    await page.getByTestId('online-join-code').fill(code);
    await page.getByTestId('online-join-go').click();
    await expect(page.getByTestId('room-lobby')).toBeVisible();
  }
  await p1.getByTestId('lobby-start').click();
  await expect(tv.getByTestId('bv-turn')).toBeVisible();

  // Nothing said yet, so nothing in the way of the board.
  await expect(tv.getByTestId('bv-chat')).toHaveCount(0);

  async function say(page: typeof p1, group: string, index: number) {
    await page.getByTestId('quickchat-open').click();
    await page.getByTestId(`quickchat-group-${group}`).click();
    await page.locator('[data-testid^="quickchat-say-"]').nth(index).click();
  }

  await say(p1, 'greetings', 0);
  await expect(tv.getByTestId('bv-chat')).toContainText('Ada');

  await say(p2, 'greetings', 1);
  await expect(tv.getByTestId('bv-chat')).toContainText('Bo');

  // Both lines are still standing — this is the difference from the phones,
  // where the first would already have faded out.
  await expect(tv.locator('.bv-chat-line')).toHaveCount(2);

  // And the screen is still a screen: no composer, nothing to press.
  await expect(tv.getByTestId('quickchat-open')).toHaveCount(0);

  await tvCtx.close();
  await p1Ctx.close();
  await p2Ctx.close();
});
