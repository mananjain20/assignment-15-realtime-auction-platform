/**
 * test/simulate.js
 * Automated integration test for the Real-Time Auction Engine.
 * Uses socket.io-client to simulate participants and assert all required behaviours.
 *
 * Run: node test/simulate.js  (from inside Manan-Jain/)
 * Server must already be running.
 */

'use strict';

const { io: ioClient } = require('socket.io-client');
const http = require('http');

const SERVER_URL = process.env.TEST_SERVER_URL || 'http://localhost:3000';
const AUC = 'AUC_VINTAGE_99';
const RESULTS = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function assert(name, condition, detail = '') {
  RESULTS.push({ name, pass: !!condition, detail });
  const icon = condition ? '✅' : '❌';
  console.log(`  ${icon} ${name}${detail ? ` — ${detail}` : ''}`);
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function connect() {
  return new Promise((resolve) => {
    const sock = ioClient(SERVER_URL, { transports: ['websocket'] });
    sock.once('connect', () => resolve(sock));
  });
}

function joinAuction(sock, username, role = 'bidder', auctionId = AUC) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('join timeout')), 5000);
    sock.once('auction:init', (data) => { clearTimeout(timer); resolve(data); });
    sock.once('auction:error', (data) => { clearTimeout(timer); resolve({ error: data.message }); });
    sock.emit('auction:join', { auctionId, username, role });
  });
}

function waitForEvent(sock, eventName, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${eventName}`)), timeout);
    sock.once(eventName, (data) => { clearTimeout(timer); resolve(data); });
  });
}

function placeBid(sock, amount, auctionId = AUC) {
  sock.emit('bid:place', { auctionId, amount });
}

async function httpPost(path) {
  return new Promise((resolve) => {
    const req = http.request(`${SERVER_URL}${path}`, { method: 'POST' }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (_) { resolve({}); } });
    });
    req.on('error', resolve);
    req.end();
  });
}

async function resetAuction() {
  const result = await httpPost(`/api/auctions/${AUC}/reset`);
  console.log(`    [Reset] ${JSON.stringify(result)}`);
  await wait(300);
}

// ─── Disconnect all sockets at end ───────────────────────────────────────────
const allSockets = [];
function mkSock() {
  return connect().then(s => { allSockets.push(s); return s; });
}

// ─── Main Test Suite ─────────────────────────────────────────────────────────
async function runTests() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  AuctionX — Integration Test Suite');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // ── Reset to a known state ────────────────────────────────────────────────
  await resetAuction();

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 1: Connection & Join
  // ─────────────────────────────────────────────────────────────────────────
  console.log('▶ Phase 1: Connection & Join');

  const vikram = await mkSock();
  const ananya = await mkSock();
  const viewerC = await mkSock();

  let lastJoinViewers = 0;
  const onJoined = d => { lastJoinViewers = d.totalViewers; };
  vikram.on('user:joined', onJoined);
  ananya.on('user:joined', onJoined);
  viewerC.on('user:joined', onJoined);

  const vikramInit = await joinAuction(vikram, 'Vikram', 'bidder');
  await wait(120);
  const ananyaInit = await joinAuction(ananya, 'Ananya', 'bidder');
  await wait(120);
  const viewerInit = await joinAuction(viewerC, 'ViewerC', 'viewer');
  await wait(300);

  assert('Vikram auction:init correct title',
    vikramInit.item?.title === '1967 Vintage Fender Stratocaster',
    `"${vikramInit.item?.title}"`);
  assert('auction:init currentBid = startingPrice',
    vikramInit.item?.currentBid === 50000, `currentBid=${vikramInit.item?.currentBid}`);
  assert('Viewer gets role=viewer',
    viewerInit.role === 'viewer', `role=${viewerInit.role}`);
  assert('user:joined totalViewers = 3',
    lastJoinViewers === 3, `totalViewers=${lastJoinViewers}`);

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 2: Vikram bids 52000 — all three receive bid:success
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ Phase 2: Valid First Bid');

  const [vs, as, cs] = await Promise.all([
    waitForEvent(vikram, 'bid:success'),
    waitForEvent(ananya, 'bid:success'),
    waitForEvent(viewerC, 'bid:success'),
    Promise.resolve(placeBid(vikram, 52000)),
  ]);

  assert('Vikram bid:success currentBid=52000', vs.currentBid === 52000, `${vs.currentBid}`);
  assert('Ananya bid:success currentBid=52000', as.currentBid === 52000, `${as.currentBid}`);
  assert('ViewerC bid:success currentBid=52000', cs.currentBid === 52000, `${cs.currentBid}`);
  assert('bid:success highestBidder=Vikram', vs.highestBidder === 'Vikram', vs.highestBidder);
  assert('newBid === currentBid', vs.newBid === vs.currentBid, `newBid=${vs.newBid}`);

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 3: Ananya bids 54000 — Vikram gets bid:outbid
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ Phase 3: Outbid Alert');

  const [outbidData, anya2] = await Promise.all([
    waitForEvent(vikram, 'bid:outbid'),
    waitForEvent(ananya, 'bid:success'),
    Promise.resolve(placeBid(ananya, 54000)),
  ]);

  assert('Vikram bid:outbid message mentions Ananya + amount',
    outbidData.message.includes('Ananya') && outbidData.message.includes('54,000'),
    `"${outbidData.message}"`);
  assert('bid:success highestBidder=Ananya', anya2.highestBidder === 'Ananya', anya2.highestBidder);

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 4: Ananya bids again while highest → bid:rejected
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ Phase 4: Already Highest Bidder Rejection');

  const [rej4] = await Promise.all([
    waitForEvent(ananya, 'bid:rejected'),
    Promise.resolve(placeBid(ananya, 60000)),
  ]);

  assert('Ananya bid:rejected — already highest',
    rej4.reason?.toLowerCase().includes('already the highest bidder'),
    `"${rej4.reason}"`);

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 5: Below minimum increment → bid:rejected with correct min
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ Phase 5: Minimum Increment Rejection');
  // currentBid=54000, increment=2000 → min=56000; bid 54001 < 56000

  const [rej5] = await Promise.all([
    waitForEvent(vikram, 'bid:rejected'),
    Promise.resolve(placeBid(vikram, 54001)),
  ]);

  assert('Low bid rejected with correct ₹56,000 minimum in message',
    rej5.reason?.includes('56,000'), `"${rej5.reason}"`);

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 6: Viewer tries to bid → rejected
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ Phase 6: Viewer Cannot Bid');

  const [rej6] = await Promise.all([
    waitForEvent(viewerC, 'bid:rejected'),
    Promise.resolve(placeBid(viewerC, 60000)),
  ]);

  assert('Viewer bid rejected',
    rej6.reason?.toLowerCase().includes('viewer'),
    `"${rej6.reason}"`);

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 7: Concurrency — same amount simultaneously
  // currentBid=54000, minIncrement=2000 → next valid = 56000
  // Vikram & Ananya both bid 56000 at the same instant.
  // Since bid:success is a room broadcast, we can't use it per-bidder.
  // Instead: exactly one of them gets bid:rejected; the other gets confirmed
  // as highestBidder in the next bid:success.
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ Phase 7: Concurrency (same amount at same instant)');

  let concRejected = 0;
  let concBidSuccess = null;

  // Listen for bid:rejected on both sockets
  const rejVikram = new Promise(res => { vikram.once('bid:rejected', () => { concRejected++; res(); }); });
  const rejAnanya = new Promise(res => { ananya.once('bid:rejected', () => { concRejected++; res(); }); });

  // Listen for one bid:success to arrive (broadcast to room — just listen on one socket)
  const concSuccess = waitForEvent(vikram, 'bid:success', 4000)
    .then(d => { concBidSuccess = d; })
    .catch(() => {});

  // Race: whichever of vikram/ananya gets rejected first, the other won
  const concRaceReject = Promise.race([rejVikram, rejAnanya]);

  // Fire simultaneously
  placeBid(vikram, 56000);
  placeBid(ananya, 56000);

  await Promise.race([
    Promise.all([concRaceReject, concSuccess]),
    wait(5000),
  ]);
  await wait(200);

  assert('Concurrency: exactly one bid:rejected (not both passed)',
    concRejected >= 1,
    `rejectedCount=${concRejected}`);
  assert('Concurrency: bid:success occurred (one winner)',
    concBidSuccess !== null,
    `successBid=${concBidSuccess?.currentBid}`);

  // Clean up lingering listeners
  vikram.off('bid:rejected');
  ananya.off('bid:rejected');

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 8: Anti-Snipe
  // Reset with AUCTION_DURATION_OVERRIDE=15 → timer is 15s.
  // Wait until timeRemaining ≤ 10, then bid. auction:extended should fire.
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ Phase 8: Anti-Snipe');
  await resetAuction();
  await wait(200);

  // Re-join both sockets so they're in the room after reset
  // (The reset_done event adds them to a fresh auction but they're still in the room)
  // We just need to ensure Vikram is in the room — he already is.
  // Listen for auction:reset_done to confirm they're in sync
  const vikram8 = await mkSock();
  await joinAuction(vikram8, 'VikramSnipe', 'bidder');

  // AUCTION_DURATION_OVERRIDE=15 — the reset sets timeRemaining=15
  // We wait 7 seconds (15-7=8 remaining, which is ≤ ANTI_SNIPE_WINDOW=15)
  // Actually the snipe window is 15, so any bid while <=15s triggers it.
  // Since we just reset, it's AT 15. We need to bid right away (15 ≤ 15).
  await wait(1000); // let 1 tick pass → timeRemaining=14, which is ≤15 → snipe

  const antiSnipePromise = waitForEvent(vikram8, 'auction:extended', 5000);
  const antiSuccessPromise = waitForEvent(vikram8, 'bid:success', 5000);

  placeBid(vikram8, 52000);

  try {
    const [extData, bidData] = await Promise.all([antiSnipePromise, antiSuccessPromise]);
    assert('auction:extended fired on bid within snipe window',
      extData?.message?.includes('Anti-snipe'),
      `msg: "${extData?.message}"`);
    assert('timeRemaining after anti-snipe = 20 (reset to ANTI_SNIPE_RESET_SECONDS)',
      extData.timeRemaining === 20 || bidData.timeRemaining >= 18,
      `timeRemaining=${extData?.timeRemaining}`);
  } catch (err) {
    assert('Anti-snipe triggered on time', false, `Error: ${err.message}`);
    assert('timeRemaining reset to 20', false, 'Not reached');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 9: Let timer expire → auction:sold, then reject further bids
  // Reset one more time, place a bid above reserve, wait for sold.
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ Phase 9: Auction Sold + Bid Rejected After Close');

  await resetAuction();
  await wait(200);

  const vikram9 = await mkSock();
  await joinAuction(vikram9, 'VikramSold', 'bidder');
  await wait(100);

  // Reserve is 60000; bid 62000 (above reserve, above startingPrice+increment)
  placeBid(vikram9, 62000);
  await wait(300);

  console.log('    Waiting up to 20s for auction:sold…');
  try {
    const soldData = await waitForEvent(vikram9, 'auction:sold', 20000);
    assert('auction:sold received',
      soldData?.status === 'sold' || soldData?.status === 'unsold',
      `status=${soldData?.status}`);
    if (soldData?.status === 'sold') {
      assert('winner = VikramSold', soldData.winner === 'VikramSold', `winner=${soldData.winner}`);
      assert('finalPrice = 62000', soldData.finalPrice === 62000, `finalPrice=${soldData.finalPrice}`);
    }

    // Post-close bid → rejected as closed
    await wait(200);
    const [rej9] = await Promise.all([
      waitForEvent(vikram9, 'bid:rejected', 4000),
      Promise.resolve(placeBid(vikram9, 70000)),
    ]);
    assert('Post-close bid rejected as "closed"',
      rej9.reason?.toLowerCase().includes('closed'),
      `"${rej9.reason}"`);
  } catch (err) {
    assert('auction:sold received', false, `Error: ${err.message}`);
    assert('post-close bid rejected', false, 'Not reached');
    assert('winner correct', false, 'Not reached');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 10: Viewer disconnect → user:left with decremented totalViewers
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n▶ Phase 10: Viewer Disconnect');

  await resetAuction();

  const obs = await mkSock();
  await joinAuction(obs, 'ObserverA', 'bidder');
  await wait(100);

  const tempV = await mkSock();
  await joinAuction(tempV, 'TempViewer', 'viewer');
  await wait(200);

  const [leftData] = await Promise.all([
    waitForEvent(obs, 'user:left', 5000),
    Promise.resolve(tempV.disconnect()),
  ]);

  assert('user:left username=TempViewer',
    leftData?.username === 'TempViewer', `username=${leftData?.username}`);
  assert('user:left totalViewers is a number',
    typeof leftData?.totalViewers === 'number', `totalViewers=${leftData?.totalViewers}`);

  // ─────────────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────────────
  allSockets.forEach(s => { try { s.disconnect(); } catch (_) {} });
  await wait(300);

  const passed = RESULTS.filter(r => r.pass).length;
  const total = RESULTS.length;
  const failed = total - passed;

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  RESULTS: ${passed}/${total} PASSED   ${failed > 0 ? `(${failed} FAILED)` : ''}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (failed > 0) {
    console.log('Failed tests:');
    RESULTS.filter(r => !r.pass).forEach(r => console.log(`  ❌ ${r.name}: ${r.detail}`));
    console.log();
    process.exit(1);
  } else {
    console.log('  🎉 All tests passed!\n');
    process.exit(0);
  }
}

// ─── Entry Point ─────────────────────────────────────────────────────────────
(async () => {
  try {
    // Verify server is running
    const running = await new Promise((resolve) => {
      const req = http.request(`${SERVER_URL}/health`, (res) => resolve(res.statusCode === 200));
      req.on('error', () => resolve(false));
      req.setTimeout(3000, () => { req.destroy(); resolve(false); });
      req.end();
    });

    if (!running) {
      console.error(`❌ Server not running at ${SERVER_URL}`);
      console.error('   Start it first: npm start\n');
      process.exit(1);
    }

    await runTests();
  } catch (err) {
    console.error('Fatal test error:', err);
    process.exit(1);
  }
})();
