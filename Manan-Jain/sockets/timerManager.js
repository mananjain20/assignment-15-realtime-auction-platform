/**
 * timerManager.js
 * Manages server-side countdown timers for all auctions.
 * One setInterval (1000ms) per auction — never two at once.
 * Timers run independently; zero viewers doesn't pause them.
 */

/** Format a number as Indian Rupees — duplicated here to avoid circular require */
function formatCurrency(amount) {
  return '₹' + Number(amount).toLocaleString('en-IN');
}

/**
 * Starts a 1-second countdown interval for an auction.
 * Clears any existing interval first (prevents duplicates).
 *
 * @param {object} io         - Socket.io server instance
 * @param {object} auction    - Auction state object (mutated in place)
 * @param {object} auctions   - All auctions map (for sold logic reference)
 */
function startTimer(io, auction, auctions) {
  // SAFETY: Never allow two intervals for the same auction
  if (auction.timerInterval !== null) {
    clearInterval(auction.timerInterval);
    auction.timerInterval = null;
  }

  auction.timerInterval = setInterval(() => {
    // Decrement time
    auction.timeRemainingSeconds -= 1;

    // Emit tick to the room every second
    io.to(auction.id).emit('auction:time_tick', {
      auctionId: auction.id,
      timeRemaining: auction.timeRemainingSeconds,
    });

    // When countdown reaches zero, end the auction
    if (auction.timeRemainingSeconds <= 0) {
      clearInterval(auction.timerInterval);
      auction.timerInterval = null;
      auction.status = 'ended';

      // Determine sold or unsold:
      // Sold only if there is a highestBidder AND currentBid >= reservePrice
      const hasBidder = auction.highestBidder !== null;
      const reserveMet = auction.currentBid >= auction.reservePrice;
      const sold = hasBidder && reserveMet;

      const soldPayload = {
        winner: sold ? auction.highestBidder.username : null,
        finalPrice: sold ? auction.currentBid : null,
        status: sold ? 'sold' : 'unsold',
        auctionId: auction.id,
        title: auction.title,
        message: sold
          ? `🎉 SOLD! ${auction.highestBidder.username} wins for ${formatCurrency(auction.currentBid)}!`
          : '❌ Auction ended unsold. Reserve price not met or no bids.',
      };

      io.to(auction.id).emit('auction:sold', soldPayload);
      console.log(`[Timer] Auction ${auction.id} ended. Status: ${soldPayload.status}`);
    }
  }, 1000);

  console.log(`[Timer] Started timer for auction ${auction.id} (${auction.timeRemainingSeconds}s remaining)`);
}

/**
 * Stops the timer for an auction (e.g., on reset or server shutdown).
 * @param {object} auction - Auction state object
 */
function stopTimer(auction) {
  if (auction.timerInterval !== null) {
    clearInterval(auction.timerInterval);
    auction.timerInterval = null;
    console.log(`[Timer] Stopped timer for auction ${auction.id}`);
  }
}

/**
 * Stops ALL auction timers — called on graceful server shutdown.
 * @param {object} auctions - All auctions map
 */
function stopAllTimers(auctions) {
  Object.values(auctions).forEach((auction) => stopTimer(auction));
  console.log('[Timer] All timers cleared.');
}

module.exports = { startTimer, stopTimer, stopAllTimers };
