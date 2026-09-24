/**
 * app.js — AuctionX Client
 * Handles Socket.io events, UI updates, audio cues, confetti, and interactions.
 *
 * Socket connects to the SAME ORIGIN so it works on both localhost and Render.
 */

'use strict';

// ─── Connect to same origin (no hardcoded URL) ───────────────────────────────
const socket = io();

// ─── State ───────────────────────────────────────────────────────────────────
let currentAuction = null;   // id string
let myRole = 'bidder';       // 'bidder' | 'viewer'
let myUsername = '';
let walletBalance = 0;
let minIncrement = 0;
let currentBid = 0;
let initialDuration = 60;    // for progress bar
let auctionStatus = 'active';
let selectedRole = 'bidder'; // tracks join-screen toggle

// ─── DOM Refs ─────────────────────────────────────────────────────────────────
const joinScreen      = document.getElementById('join-screen');
const appEl           = document.getElementById('app');
const usernameInput   = document.getElementById('username-input');
const auctionSelect   = document.getElementById('auction-select');
const roleBidder      = document.getElementById('role-bidder');
const roleViewer      = document.getElementById('role-viewer');
const joinBtn         = document.getElementById('join-btn');
const joinError       = document.getElementById('join-error');

const hdrUsername     = document.getElementById('hdr-username');
const hdrWallet       = document.getElementById('hdr-wallet');
const hdrViewers      = document.getElementById('hdr-viewers');

const itemTitle       = document.getElementById('item-title');
const itemDescription = document.getElementById('item-description');
const statusChip      = document.getElementById('status-chip');
const statStarting    = document.getElementById('stat-starting');
const statIncrement   = document.getElementById('stat-increment');
const statReserve     = document.getElementById('stat-reserve');

const currentBidDisplay = document.getElementById('current-bid-display');
const highestBidderName = document.getElementById('highest-bidder-name');
const minBidAmount      = document.getElementById('min-bid-amount');
const countdownDisplay  = document.getElementById('countdown-display');
const countdownFill     = document.getElementById('countdown-fill');

const viewerNotice    = document.getElementById('viewer-notice');
const bidControls     = document.getElementById('bid-controls');
const quickBidsRow    = document.getElementById('quick-bids');
const qb1             = document.getElementById('qb-1');
const qb2             = document.getElementById('qb-2');
const qb5             = document.getElementById('qb-5');
const bidAmountInput  = document.getElementById('bid-amount-input');
const placeBidBtn     = document.getElementById('place-bid-btn');
const rejectionMsg    = document.getElementById('rejection-msg');

const historyList     = document.getElementById('history-list');
const historyCount    = document.getElementById('history-count');
const toastContainer  = document.getElementById('toast-container');

const soldOverlay     = document.getElementById('sold-overlay');
const soldIcon        = document.getElementById('sold-icon');
const soldTitle       = document.getElementById('sold-title');
const soldSubtitle    = document.getElementById('sold-subtitle');
const soldWinner      = document.getElementById('sold-winner');
const soldPrice       = document.getElementById('sold-price');
const restartBtn      = document.getElementById('restart-btn');
const confettiCanvas  = document.getElementById('confetti-canvas');

// ─── Currency Format ─────────────────────────────────────────────────────────
function fmt(amount) {
  return '₹' + Number(amount).toLocaleString('en-IN');
}

// ─── Audio Engine (Web Audio API — no files) ─────────────────────────────────
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
  }
  return audioCtx;
}

function playTone(freq, type = 'sine', duration = 0.15, vol = 0.15, delay = 0) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
    gain.gain.setValueAtTime(vol, ctx.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + duration);
    osc.start(ctx.currentTime + delay);
    osc.stop(ctx.currentTime + delay + duration + 0.05);
  } catch (_) {}
}

const Audio = {
  bidPlaced:  () => { playTone(880, 'sine', 0.12, 0.18); playTone(1100, 'sine', 0.1, 0.12, 0.1); },
  outbid:     () => { playTone(440, 'sawtooth', 0.15, 0.2); playTone(330, 'sawtooth', 0.2, 0.2, 0.15); },
  antiSnipe:  () => { [0, 0.12, 0.24].forEach((d, i) => playTone(660 + i * 110, 'square', 0.1, 0.15, d)); },
  urgentTick: () => { playTone(1200, 'sine', 0.07, 0.1); },
  sold:       () => { [0, 0.15, 0.3, 0.5].forEach((d, i) => playTone(523 * Math.pow(1.25, i), 'sine', 0.25, 0.2, d)); },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function setRejection(msg) {
  rejectionMsg.textContent = msg;
  if (msg) setTimeout(() => { if (rejectionMsg.textContent === msg) rejectionMsg.textContent = ''; }, 4000);
}

function toast(msg, type = 'info') {
  const div = document.createElement('div');
  div.className = `toast toast-${type}`;
  div.textContent = msg;
  toastContainer.prepend(div);
  setTimeout(() => div.remove(), 3200);
}

function updateCountdown(seconds) {
  const s = Math.max(0, seconds);
  const mins = String(Math.floor(s / 60)).padStart(2, '0');
  const secs = String(s % 60).padStart(2, '0');
  countdownDisplay.textContent = s >= 60 ? `${mins}:${secs}` : `${s}s`;

  const urgent = s <= 10;
  countdownDisplay.classList.toggle('urgent', urgent);
  countdownFill.classList.toggle('urgent', urgent);

  const pct = initialDuration > 0 ? (s / initialDuration) * 100 : 0;
  countdownFill.style.width = `${Math.max(0, pct)}%`;

  if (urgent && s > 0 && auctionStatus === 'active') Audio.urgentTick();
}

function updateBidDisplay(amount) {
  currentBid = amount;
  currentBidDisplay.textContent = fmt(amount);
  currentBidDisplay.classList.remove('flash');
  void currentBidDisplay.offsetWidth; // reflow to restart animation
  currentBidDisplay.classList.add('flash');
  updateMinBid();
}

function updateMinBid() {
  const min = currentBid + minIncrement;
  minBidAmount.textContent = fmt(min);
  updateQuickBids(min);
}

function updateQuickBids(minNext) {
  qb1.textContent = `+Min  ${fmt(minNext)}`;
  qb2.textContent = `+2×  ${fmt(currentBid + minIncrement * 2)}`;
  qb5.textContent = `+5×  ${fmt(currentBid + minIncrement * 5)}`;
}

function updateHistory(bidHistory) {
  if (!bidHistory || bidHistory.length === 0) {
    historyList.innerHTML = '<div class="history-empty">No bids yet. Be the first! 🎯</div>';
    historyCount.textContent = '0 bids';
    return;
  }
  historyCount.textContent = `${bidHistory.length} bid${bidHistory.length !== 1 ? 's' : ''}`;
  historyList.innerHTML = bidHistory.map((b, i) => `
    <div class="history-item" style="animation-delay:${i * 0.04}s">
      <div>
        <div class="history-bidder">👤 ${escHtml(b.bidder)}</div>
        <div class="history-time">${formatTime(b.timestamp)}</div>
      </div>
      <div class="history-amount">${fmt(b.amount)}</div>
    </div>
  `).join('');
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  } catch (_) { return '—'; }
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function setAuctionEnded() {
  auctionStatus = 'ended';
  statusChip.textContent = '● Ended';
  statusChip.className = 'status-chip status-ended';
  setControlsEnabled(false);
  updateCountdown(0);
}

function setControlsEnabled(enabled) {
  const disabled = !enabled || myRole !== 'bidder';
  placeBidBtn.disabled = disabled;
  bidAmountInput.disabled = disabled;
  [qb1, qb2, qb5].forEach(b => b.disabled = disabled);
}

// ─── Join Screen ──────────────────────────────────────────────────────────────
[roleBidder, roleViewer].forEach(btn => {
  btn.addEventListener('click', () => {
    selectedRole = btn.dataset.role;
    roleBidder.classList.toggle('active', selectedRole === 'bidder');
    roleViewer.classList.toggle('active', selectedRole === 'viewer');
  });
});

joinBtn.addEventListener('click', () => {
  const name = usernameInput.value.trim();
  const aid = auctionSelect.value;
  if (!name) { joinError.textContent = 'Please enter a username.'; return; }
  joinError.textContent = '';
  joinBtn.disabled = true;
  joinBtn.textContent = 'Joining…';
  myUsername = name;
  myRole = selectedRole;
  currentAuction = aid;
  socket.emit('auction:join', { auctionId: aid, username: name, role: selectedRole });
});

usernameInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click(); });

// ─── Socket Events ────────────────────────────────────────────────────────────

// Successful join — server sends auction state
socket.on('auction:init', (data) => {
  // Transition from join screen to app
  joinScreen.style.display = 'none';
  appEl.classList.add('visible');

  const item = data.item;
  auctionStatus = item.status;
  minIncrement = item.minIncrement;
  initialDuration = item.status === 'active' ? Math.max(data.timeRemaining, 1) : 1;

  // Header
  hdrUsername.textContent = `👤 ${myUsername} (${myRole})`;
  if (myRole === 'bidder') {
    hdrWallet.style.display = '';
    walletBalance = data.wallet || 500000;
    hdrWallet.textContent = `💰 ${fmt(walletBalance)}`;
  }

  // Item card
  itemTitle.textContent = item.title;
  itemDescription.textContent = item.description;
  statStarting.textContent = fmt(item.startingPrice);
  statIncrement.textContent = fmt(item.minIncrement);
  statReserve.textContent = fmt(item.reservePrice);

  // Status chip
  if (item.status === 'active') {
    statusChip.textContent = '● Live';
    statusChip.className = 'status-chip status-active';
  } else {
    setAuctionEnded();
  }

  // Bid display
  currentBid = item.currentBid;
  updateBidDisplay(item.currentBid);
  highestBidderName.textContent = item.highestBidder || '—';

  // Countdown
  updateCountdown(data.timeRemaining);

  // History
  updateHistory(data.bidHistory);

  // Controls
  if (myRole === 'viewer') {
    viewerNotice.classList.add('show');
    bidControls.style.display = 'none';
  } else {
    viewerNotice.classList.remove('show');
    bidControls.style.display = '';
    setControlsEnabled(item.status === 'active');
  }
});

// Error from server (bad join, etc.)
socket.on('auction:error', (data) => {
  joinError.textContent = data.message || 'An error occurred.';
  joinBtn.disabled = false;
  joinBtn.textContent = 'Enter Auction Floor →';
});

// Timer tick every second
socket.on('auction:time_tick', (data) => {
  if (data.auctionId !== currentAuction) return;
  updateCountdown(data.timeRemaining);
});

// Successful bid — broadcast to room
socket.on('bid:success', (data) => {
  if (data.auctionId !== currentAuction) return;
  updateBidDisplay(data.currentBid);
  highestBidderName.textContent = data.highestBidder;
  updateHistory(data.bidHistory);
  updateCountdown(data.timeRemaining);
  setRejection('');
  Audio.bidPlaced();
  toast(`🔨 ${data.highestBidder} bid ${fmt(data.currentBid)}!`, 'success');
});

// Outbid alert — only this socket receives it
socket.on('bid:outbid', (data) => {
  Audio.outbid();
  toast(`⚠️ ${data.message}`, 'outbid');
  // Screen shake
  document.body.classList.remove('shake');
  void document.body.offsetWidth;
  document.body.classList.add('shake');
  setTimeout(() => document.body.classList.remove('shake'), 600);
});

// Bid rejected
socket.on('bid:rejected', (data) => {
  setRejection(data.reason || 'Bid rejected.');
});

// Anti-snipe extension
socket.on('auction:extended', (data) => {
  if (data.auctionId !== currentAuction) return;
  Audio.antiSnipe();
  updateCountdown(data.timeRemaining);
  toast('⚡ Anti-Snipe Triggered: +20 seconds added!', 'antsnipe');
  // Flash the countdown display
  countdownDisplay.style.color = 'var(--neon-orange)';
  setTimeout(() => {
    countdownDisplay.style.color = '';
    countdownDisplay.classList.toggle('urgent', data.timeRemaining <= 10);
  }, 1000);
});

// Auction sold / unsold
socket.on('auction:sold', (data) => {
  if (data.auctionId !== currentAuction) return;
  setAuctionEnded();
  Audio.sold();

  if (data.status === 'sold') {
    soldIcon.textContent = '🏆';
    soldTitle.textContent = 'SOLD!';
    soldTitle.className = 'sold-title won';
    soldSubtitle.textContent = `Congratulations to the winner of "${data.title || currentAuction}"`;
    soldWinner.textContent = data.winner;
    soldPrice.textContent = fmt(data.finalPrice);
    launchConfetti();
  } else {
    soldIcon.textContent = '❌';
    soldTitle.textContent = 'UNSOLD';
    soldTitle.className = 'sold-title unsold';
    soldSubtitle.textContent = 'Reserve price not met or no bids received.';
    soldWinner.textContent = '—';
    soldPrice.textContent = '—';
  }

  soldOverlay.classList.add('show');
});

// Auction reset (demo restart)
socket.on('auction:reset_done', (data) => {
  soldOverlay.classList.remove('show');
  stopConfetti();
  const item = data.item;
  auctionStatus = 'active';
  minIncrement = item.minIncrement;
  initialDuration = data.timeRemaining;
  statusChip.textContent = '● Live';
  statusChip.className = 'status-chip status-active';
  updateBidDisplay(item.currentBid);
  highestBidderName.textContent = item.highestBidder || '—';
  updateHistory([]);
  updateCountdown(data.timeRemaining);
  if (myRole === 'bidder') setControlsEnabled(true);
  toast('🔄 Auction reset! Bidding reopened.', 'info');
});

// User joined
socket.on('user:joined', (data) => {
  hdrViewers.textContent = `👥 ${data.totalViewers}`;
  if (data.username !== myUsername) {
    toast(`${data.username} joined as ${data.role || 'bidder'}.`, 'info');
  }
});

// User left
socket.on('user:left', (data) => {
  hdrViewers.textContent = `👥 ${data.totalViewers}`;
});

// Wallet update
socket.on('wallet:update', (data) => {
  walletBalance = data.balance;
  hdrWallet.textContent = `💰 ${fmt(walletBalance)}`;
});

// ─── Bid Controls ─────────────────────────────────────────────────────────────
function placeBid(amount) {
  if (auctionStatus !== 'active') {
    setRejection('Auction is closed.');
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
    setRejection('Please enter a valid whole number amount.');
    return;
  }
  socket.emit('bid:place', { auctionId: currentAuction, amount });
}

placeBidBtn.addEventListener('click', () => {
  const val = parseInt(bidAmountInput.value, 10);
  placeBid(val);
});

bidAmountInput.addEventListener('keydown', e => { if (e.key === 'Enter') placeBidBtn.click(); });

qb1.addEventListener('click', () => { placeBid(currentBid + minIncrement); });
qb2.addEventListener('click', () => { placeBid(currentBid + minIncrement * 2); });
qb5.addEventListener('click', () => { placeBid(currentBid + minIncrement * 5); });

// ─── Restart Button ───────────────────────────────────────────────────────────
restartBtn.addEventListener('click', () => {
  socket.emit('auction:reset', { auctionId: currentAuction });
});

// ─── Confetti (Pure Canvas — no libraries) ───────────────────────────────────
let confettiAnimFrame = null;
let confettiParticles = [];

function launchConfetti() {
  const canvas = confettiCanvas;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx = canvas.getContext('2d');
  const colors = ['#00ff88', '#00b4ff', '#ffd700', '#ff3366', '#ff8c00', '#a855f7'];
  confettiParticles = Array.from({ length: 150 }, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * -canvas.height,
    w: Math.random() * 12 + 5,
    h: Math.random() * 6 + 3,
    color: colors[Math.floor(Math.random() * colors.length)],
    rot: Math.random() * Math.PI * 2,
    vx: (Math.random() - 0.5) * 4,
    vy: Math.random() * 3 + 2,
    vr: (Math.random() - 0.5) * 0.15,
    opacity: Math.random() * 0.5 + 0.5,
  }));

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    confettiParticles.forEach(p => {
      ctx.save();
      ctx.globalAlpha = p.opacity;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      if (p.y > canvas.height) { p.y = -20; p.x = Math.random() * canvas.width; }
    });
    confettiAnimFrame = requestAnimationFrame(draw);
  }

  stopConfetti();
  draw();
  // Auto-stop after 6 seconds
  setTimeout(stopConfetti, 6000);
}

function stopConfetti() {
  if (confettiAnimFrame) {
    cancelAnimationFrame(confettiAnimFrame);
    confettiAnimFrame = null;
  }
  const ctx = confettiCanvas.getContext('2d');
  ctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
  confettiParticles = [];
}

window.addEventListener('resize', () => {
  if (confettiAnimFrame) {
    confettiCanvas.width = window.innerWidth;
    confettiCanvas.height = window.innerHeight;
  }
});
