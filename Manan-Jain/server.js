/**
 * server.js
 * Entry point — sets up Express + Socket.io, wires auction handlers,
 * starts per-auction timers, and serves static files from /public.
 *
 * This file intentionally contains ONLY wiring. All auction logic
 * lives in sockets/auctionEngine.js and sockets/timerManager.js.
 */

require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const { auctions, registerHandlers, resetAuction, getPublicAuctionData } = require('./sockets/auctionEngine');
const { startTimer, stopAllTimers } = require('./sockets/timerManager');

// ─── Configuration ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

// Serve static frontend from /public
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint (for Render)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// REST: GET /api/auctions — list all auctions (public info only)
app.get('/api/auctions', (_req, res) => {
  const list = Object.values(auctions).map((a) => ({
    ...getPublicAuctionData(a),
    timeRemaining: a.timeRemainingSeconds,
    viewerCount: a.viewers.size,
  }));
  res.json({ auctions: list });
});

// REST: GET /api/auctions/:id — single auction info
app.get('/api/auctions/:id', (req, res) => {
  const auction = auctions[req.params.id];
  if (!auction) return res.status(404).json({ error: 'Auction not found' });
  res.json({
    ...getPublicAuctionData(auction),
    timeRemaining: auction.timeRemainingSeconds,
    viewerCount: auction.viewers.size,
    bidHistory: auction.bidHistory,
  });
});

// REST: POST /api/auctions/:id/reset — reset auction (for demos / tests)
app.post('/api/auctions/:id/reset', (req, res) => {
  const result = resetAuction(io, req.params.id);
  if (!result.success) return res.status(404).json({ error: result.reason });
  res.json({ status: 'reset', auctionId: req.params.id });
});

// ─── HTTP Server & Socket.io ──────────────────────────────────────────────────
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] },
});

// Wire Socket.io handlers — one call per connected socket
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);
  registerHandlers(io, socket);
});

// ─── Start Server ─────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔨 Auction Engine running on http://0.0.0.0:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Frontend: http://localhost:${PORT}/\n`);

  // Start all auction timers immediately on server boot
  // io is defined above before listen() is called synchronously
  Object.values(auctions).forEach((auction) => {
    startTimer(io, auction, auctions);
  });
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
function shutdown() {
  console.log('\n[Server] Shutting down gracefully...');
  stopAllTimers(auctions);
  server.close(() => {
    console.log('[Server] HTTP server closed.');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Export io for use in route handlers defined before io is created
// (resetAuction needs io — we assign it after creation)
module.exports = { app, server, io };
