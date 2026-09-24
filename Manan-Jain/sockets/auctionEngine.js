/**
 * auctionEngine.js
 * Core bid validation, state mutation, outbid alerts, anti-snipe logic,
 * room management, and all Socket.io auction event handlers.
 *
 * IMPORTANT — RACE CONDITION PREVENTION:
 * All bid validation and state mutation (steps 1–8) run synchronously
 * within a single event-loop tick. There is NO await/async between
 * validation and state write. This guarantees that two simultaneous
 * bid events for the same amount cannot both succeed — Node.js
 * processes one socket callback at a time on the main thread.
 */

const { startTimer, stopTimer } = require('./timerManager');

// ─── Constants ───────────────────────────────────────────────────────────────
const ANTI_SNIPE_WINDOW_SECONDS = 15; // If bid placed with <= this many seconds left...
const ANTI_SNIPE_RESET_SECONDS = 20;  // ...reset timer to this value
const DEFAULT_WALLET = 500000;        // Each bidder session gets ₹5,00,000
const MAX_BID_HISTORY = 50;           // Cap bid history entries
const MAX_USERNAME_LENGTH = 30;

// ─── In-Memory Auction Data ───────────────────────────────────────────────────
/**
 * Returns the initial duration for an auction.
 * Allows AUCTION_DURATION_OVERRIDE env var for testing short auctions.
 */
function getInitialDuration(defaultSeconds) {
  const override = parseInt(process.env.AUCTION_DURATION_OVERRIDE, 10);
  return Number.isFinite(override) && override > 0 ? override : defaultSeconds;
}

/**
 * Creates the in-memory auctions store.
 * Called once at startup (and re-called on full reset if needed).
 */
function createAuctions() {
  return {
    AUC_VINTAGE_99: {
      id: 'AUC_VINTAGE_99',
      title: '1967 Vintage Fender Stratocaster',
      description:
        'Original condition rare electric guitar. Serial #67-9921. Sunburst finish, all-original hardware, case included.',
      startingPrice: 50000,
      currentBid: 50000,
      highestBidder: null, // { socketId, username }
      minIncrement: 2000,
      reservePrice: 60000,
      timeRemainingSeconds: getInitialDuration(60),
      initialDurationSeconds: 60,
      status: 'active',
      bidHistory: [],
      viewers: new Map(), // socketId -> { username, role }
      timerInterval: null,
    },
    AUC_PATEK_WATCH: {
      id: 'AUC_PATEK_WATCH',
      title: 'Patek Philippe Nautilus Ref. 5711 (2019)',
      description:
        'Unworn, complete set. Stainless steel case, blue sunburst dial. One of the most coveted watches on the planet.',
      startingPrice: 800000,
      currentBid: 800000,
      highestBidder: null,
      minIncrement: 25000,
      reservePrice: 1000000,
      timeRemainingSeconds: getInitialDuration(90),
      initialDurationSeconds: 90,
      status: 'active',
      bidHistory: [],
      viewers: new Map(),
      timerInterval: null,
    },
    AUC_KLIMT_PAINTING: {
      id: 'AUC_KLIMT_PAINTING',
      title: 'Gustav Klimt — "Golden Garden" (1906)',
      description:
        'Authenticated oil-on-canvas, 80×100 cm. Provenance: private European collection. Accompanied by full authentication certificate.',
      startingPrice: 5000000,
      currentBid: 5000000,
      highestBidder: null,
      minIncrement: 100000,
      reservePrice: 7000000,
      timeRemainingSeconds: getInitialDuration(120),
      initialDurationSeconds: 120,
      status: 'active',
      bidHistory: [],
      viewers: new Map(),
      timerInterval: null,
    },
  };
}

// Singleton auctions store
let auctions = createAuctions();

// Per-socket wallet balances: socketId -> balance (number)
const wallets = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format a number as Indian Rupees with ₹ prefix */
function formatCurrency(amount) {
  return '₹' + Number(amount).toLocaleString('en-IN');
}

/** Return only the public-safe fields of an auction (no Map, no timerInterval) */
function getPublicAuctionData(auction) {
  return {
    id: auction.id,
    title: auction.title,
    description: auction.description,
    startingPrice: auction.startingPrice,
    currentBid: auction.currentBid,
    highestBidder: auction.highestBidder ? auction.highestBidder.username : null,
    minIncrement: auction.minIncrement,
    reservePrice: auction.reservePrice,
    status: auction.status,
  };
}

/** Count connected sockets in a room */
function getViewerCount(auction) {
  return auction.viewers.size;
}

/** Check if a username is already taken in an auction (case-insensitive) */
function isUsernameTaken(auction, username, excludeSocketId = null) {
  for (const [sid, info] of auction.viewers) {
    if (sid === excludeSocketId) continue;
    if (info.username.toLowerCase() === username.toLowerCase()) return true;
  }
  return false;
}

// ─── Reset Logic ─────────────────────────────────────────────────────────────

/**
 * Resets an auction to its initial state and restarts the timer.
 * Used by auction:reset socket event and POST /api/auctions/:id/reset.
 */
function resetAuction(io, auctionId) {
  const auction = auctions[auctionId];
  if (!auction) return { success: false, reason: 'Auction not found' };

  // Stop existing timer
  stopTimer(auction);

  // Restore initial state (preserve viewers map — people stay connected)
  auction.currentBid = auction.startingPrice;
  auction.highestBidder = null;
  auction.timeRemainingSeconds = getInitialDuration(auction.initialDurationSeconds);
  auction.status = 'active';
  auction.bidHistory = [];

  // Restart timer
  startTimer(io, auction, auctions);

  io.to(auctionId).emit('auction:reset_done', {
    auctionId,
    item: getPublicAuctionData(auction),
    timeRemaining: auction.timeRemainingSeconds,
  });

  console.log(`[Engine] Auction ${auctionId} reset.`);
  return { success: true };
}

// ─── Socket Event Handlers ────────────────────────────────────────────────────

/**
 * Registers all Socket.io auction event handlers for a connected socket.
 * Called once per socket connection from server.js.
 */
function registerHandlers(io, socket) {
  // ── auction:join ──────────────────────────────────────────────────────────
  socket.on('auction:join', (payload) => {
    try {
      const { auctionId, username, role = 'bidder' } = payload || {};

      // Validate auctionId
      const auction = auctions[auctionId];
      if (!auction) {
        socket.emit('auction:error', { message: `Auction "${auctionId}" does not exist.` });
        return;
      }

      // Validate username
      if (
        !username ||
        typeof username !== 'string' ||
        username.trim().length === 0
      ) {
        socket.emit('auction:error', { message: 'Username cannot be empty.' });
        return;
      }
      const cleanName = username.trim().slice(0, MAX_USERNAME_LENGTH);
      if (cleanName.length === 0) {
        socket.emit('auction:error', { message: 'Username is too short.' });
        return;
      }

      // Validate role
      const validRole = role === 'viewer' ? 'viewer' : 'bidder';

      // Unique username check
      if (isUsernameTaken(auction, cleanName, socket.id)) {
        socket.emit('auction:error', {
          message: `Username "${cleanName}" is already taken in this auction. Choose another.`,
        });
        return;
      }

      // Leave any previous room for this auction (re-join guard)
      if (auction.viewers.has(socket.id)) {
        socket.leave(auctionId);
        auction.viewers.delete(socket.id);
      }

      // Join socket room
      socket.join(auctionId);

      // Register in viewers map
      auction.viewers.set(socket.id, { username: cleanName, role: validRole });

      // Give bidder a wallet (only once per session)
      if (validRole === 'bidder' && !wallets.has(socket.id)) {
        wallets.set(socket.id, DEFAULT_WALLET);
        socket.emit('wallet:update', { balance: DEFAULT_WALLET });
      }

      // Send auction state to joining client
      socket.emit('auction:init', {
        item: getPublicAuctionData(auction),
        bidHistory: auction.bidHistory.slice(0, MAX_BID_HISTORY),
        timeRemaining: auction.timeRemainingSeconds,
        role: validRole,
        wallet: validRole === 'bidder' ? (wallets.get(socket.id) || DEFAULT_WALLET) : null,
      });

      // Notify room of new user
      const totalViewers = getViewerCount(auction);
      io.to(auctionId).emit('user:joined', { username: cleanName, totalViewers, role: validRole });

      console.log(`[Join] ${cleanName} (${validRole}) joined ${auctionId}. Total: ${totalViewers}`);
    } catch (err) {
      console.error('[auction:join] Error:', err);
      socket.emit('auction:error', { message: 'Failed to join auction.' });
    }
  });

  // ── bid:place ─────────────────────────────────────────────────────────────
  //
  // RACE CONDITION PREVENTION:
  // All validation (steps 1–8) runs synchronously in one tick.
  // No await/async between read and write — Node's single-threaded event loop
  // guarantees exactly one bid handler runs at a time, so two simultaneous
  // bids for the same amount cannot both pass validation.
  //
  socket.on('bid:place', (payload) => {
    try {
      const { auctionId, amount } = payload || {};

      // ── Step 1: Payload sanity ──────────────────────────────────────────
      const auction = auctions[auctionId];
      if (!auction) {
        socket.emit('bid:rejected', { reason: 'Auction not found.' });
        return;
      }

      // Must have joined this auction with role "bidder"
      const viewer = auction.viewers.get(socket.id);
      if (!viewer) {
        socket.emit('bid:rejected', { reason: 'You have not joined this auction.' });
        return;
      }
      if (viewer.role !== 'bidder') {
        socket.emit('bid:rejected', { reason: 'Viewers cannot place bids.' });
        return;
      }

      // Amount must be a finite positive integer
      if (
        typeof amount !== 'number' ||
        !Number.isFinite(amount) ||
        amount <= 0 ||
        !Number.isInteger(amount)
      ) {
        socket.emit('bid:rejected', { reason: 'Bid amount must be a positive integer.' });
        return;
      }

      // ── Step 2: Auction must be active ──────────────────────────────────
      if (auction.status !== 'active' || auction.timeRemainingSeconds <= 0) {
        socket.emit('bid:rejected', { reason: 'Auction is closed.' });
        return;
      }

      // ── Step 3: Reject if sender is already highest bidder ──────────────
      if (
        auction.highestBidder &&
        (auction.highestBidder.socketId === socket.id ||
          auction.highestBidder.username.toLowerCase() === viewer.username.toLowerCase())
      ) {
        socket.emit('bid:rejected', { reason: 'You are already the highest bidder.' });
        return;
      }

      // ── Step 4: Minimum increment check ─────────────────────────────────
      const minValidBid = auction.currentBid + auction.minIncrement;
      if (amount < minValidBid) {
        socket.emit('bid:rejected', {
          reason: `Bid too low. Minimum valid bid is ${formatCurrency(minValidBid)}.`,
        });
        return;
      }

      // ── Step 5: Wallet check ─────────────────────────────────────────────
      const balance = wallets.get(socket.id) ?? DEFAULT_WALLET;
      if (amount > balance) {
        socket.emit('bid:rejected', { reason: 'Insufficient wallet balance.' });
        return;
      }

      // ── Steps 6–8: STATE MUTATION (all synchronous, single tick) ─────────

      // Capture previous highest bidder BEFORE mutation
      const previousBidder = auction.highestBidder
        ? { ...auction.highestBidder }
        : null;

      // Update auction state
      auction.currentBid = amount;
      auction.highestBidder = { socketId: socket.id, username: viewer.username };

      // Prepend to bid history (newest first), cap at MAX_BID_HISTORY
      auction.bidHistory.unshift({
        bidder: viewer.username,
        amount,
        timestamp: new Date().toISOString(),
      });
      if (auction.bidHistory.length > MAX_BID_HISTORY) {
        auction.bidHistory = auction.bidHistory.slice(0, MAX_BID_HISTORY);
      }

      // ── Step 7: Anti-snipe ───────────────────────────────────────────────
      let antiSniped = false;
      if (auction.timeRemainingSeconds <= ANTI_SNIPE_WINDOW_SECONDS) {
        auction.timeRemainingSeconds = ANTI_SNIPE_RESET_SECONDS;
        antiSniped = true;
      }

      // ── Step 8: Emit bid:success to the entire room ──────────────────────
      const successPayload = {
        newBid: amount,        // same as currentBid per spec
        currentBid: amount,
        highestBidder: viewer.username,
        bidHistory: auction.bidHistory.slice(0, MAX_BID_HISTORY),
        timeRemaining: auction.timeRemainingSeconds,
        auctionId,
      };
      io.to(auctionId).emit('bid:success', successPayload);

      // ── Anti-snipe notification ──────────────────────────────────────────
      if (antiSniped) {
        io.to(auctionId).emit('auction:extended', {
          message: 'Anti-snipe triggered: +20 seconds added!',
          timeRemaining: auction.timeRemainingSeconds,
          auctionId,
        });
        console.log(`[Anti-Snipe] Timer extended to ${auction.timeRemainingSeconds}s for ${auctionId}`);
      }

      // ── Outbid alert — sent ONLY to the previous highest bidder ──────────
      if (previousBidder && previousBidder.socketId !== socket.id) {
        const prevSocket = io.sockets.sockets.get(previousBidder.socketId);
        if (prevSocket) {
          prevSocket.emit('bid:outbid', {
            message: `You have been outbid by ${viewer.username} at ${formatCurrency(amount)}!`,
          });
        }
      }

      console.log(
        `[Bid] ${viewer.username} bid ${formatCurrency(amount)} on ${auctionId} (${auction.timeRemainingSeconds}s left)`
      );
    } catch (err) {
      console.error('[bid:place] Error:', err);
      socket.emit('bid:rejected', { reason: 'Internal server error.' });
    }
  });

  // ── auction:reset ─────────────────────────────────────────────────────────
  socket.on('auction:reset', (payload) => {
    try {
      const { auctionId } = payload || {};
      const result = resetAuction(io, auctionId);
      if (!result.success) {
        socket.emit('auction:error', { message: result.reason });
      }
    } catch (err) {
      console.error('[auction:reset] Error:', err);
      socket.emit('auction:error', { message: 'Failed to reset auction.' });
    }
  });

  // ── disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    try {
      // Remove socket from every auction it was in
      for (const auction of Object.values(auctions)) {
        if (!auction.viewers.has(socket.id)) continue;

        const { username } = auction.viewers.get(socket.id);
        auction.viewers.delete(socket.id);

        // Clean up wallet
        wallets.delete(socket.id);

        // If this was the highest bidder — KEEP the bid standing (per spec)
        // Just mark them as disconnected (we don't roll back)
        if (
          auction.highestBidder &&
          auction.highestBidder.socketId === socket.id
        ) {
          console.log(
            `[Disconnect] Highest bidder ${username} disconnected from ${auction.id} — bid preserved.`
          );
        }

        const totalViewers = getViewerCount(auction);
        io.to(auction.id).emit('user:left', { username, totalViewers });
        console.log(`[Disconnect] ${username} left ${auction.id}. Total: ${totalViewers}`);
      }
    } catch (err) {
      console.error('[disconnect] Error:', err);
    }
  });
}

module.exports = {
  auctions,
  wallets,
  createAuctions,
  formatCurrency,
  getPublicAuctionData,
  resetAuction,
  registerHandlers,
};
