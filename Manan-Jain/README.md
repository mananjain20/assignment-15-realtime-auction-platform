# 🔨 AuctionX — Real-Time Live Auction & Bidding Engine

> Built with **Node.js · Express · Socket.io**  
> Dark trading-floor UI · Anti-snipe protection · In-memory state · Render-ready

---

## Table of Contents
1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Project Structure](#project-structure)
4. [Socket Event Protocol](#socket-event-protocol)
5. [Bid Validation Order](#bid-validation-order)
6. [Anti-Snipe Rules](#anti-snipe-rules)
7. [Manual Testing (3 Browser Tabs)](#manual-testing-3-browser-tabs)
8. [Automated Tests](#automated-tests)
9. [Render Deployment](#render-deployment)
10. [Grading Coverage Summary](#grading-coverage-summary)
11. [State Storage Note](#state-storage-note)

---

## Overview

AuctionX is a complete real-time bidding engine. Three seeded auctions run on server-side countdown timers the moment the server boots. Any number of clients (bidders or viewers) can join any auction room via Socket.io. Bids are validated synchronously to prevent race conditions, and anti-snipe logic automatically extends the timer when a bid arrives in the final 15 seconds.

**Stack:**
| Layer | Technology |
|---|---|
| Runtime | Node.js (v18+) |
| Framework | Express.js |
| Real-Time | Socket.io v4 |
| Frontend | Vanilla HTML / CSS / JS |
| State | In-memory (no database) |

---

## Quick Start

```bash
# 1. Clone & enter project directory
cd assignment-15/Manan-Jain/

# 2. Install dependencies
npm install

# 3. Copy environment template
cp .env.example .env

# 4. Start the server (production)
npm start

# OR start in development mode with auto-reload
npm run dev

# 5. Open the UI
open http://localhost:5000
```

---

## Project Structure

```
Manan-Jain/
├── public/
│   ├── index.html          # Bidding floor UI (dark trading theme)
│   ├── app.js              # Client socket handlers, bid buttons, audio
│   └── style.css           # Neon dark theme, animations, responsive layout
├── sockets/
│   ├── auctionEngine.js    # Bid validation, anti-snipe, wallet, outbid alerts
│   └── timerManager.js     # Per-auction setInterval countdown
├── test/
│   └── simulate.js         # 10-phase socket.io-client integration tests
├── server.js               # Express + Socket.io wiring only
├── package.json
├── .env / .env.example
├── .gitignore
└── README.md
```

---

## Socket Event Protocol

### Room & Stream

| Event | Direction | Payload | Description |
|---|---|---|---|
| `auction:join` | Client → Server | `{ auctionId, username, role? }` | Join an auction room as bidder or viewer |
| `auction:init` | Server → Client | `{ item, bidHistory, timeRemaining, role, wallet }` | Full auction state sent to joining client |
| `auction:time_tick` | Server → Room | `{ auctionId, timeRemaining }` | Every 1 second |
| `user:joined` | Server → Room | `{ username, totalViewers, role }` | When any socket joins |
| `user:left` | Server → Room | `{ username, totalViewers }` | On disconnect or leave |

### Bidding

| Event | Direction | Payload | Description |
|---|---|---|---|
| `bid:place` | Client → Server | `{ auctionId, amount }` | Place a bid |
| `bid:success` | Server → Room | `{ newBid, currentBid, highestBidder, bidHistory, timeRemaining, auctionId }` | Bid accepted — sent to everyone in room |
| `bid:outbid` | Server → Client | `{ message }` | Private alert to previous highest bidder only |
| `bid:rejected` | Server → Client | `{ reason }` | Private rejection with reason |
| `auction:extended` | Server → Room | `{ message, timeRemaining, auctionId }` | Anti-snipe trigger |
| `auction:sold` | Server → Room | `{ winner, finalPrice, status, auctionId, title, message }` | Auction result (sold / unsold) |

### Helpers

| Event | Direction | Payload | Description |
|---|---|---|---|
| `auction:error` | Server → Client | `{ message }` | General errors (bad join, etc.) |
| `wallet:update` | Server → Client | `{ balance }` | Sent after join and after a win |
| `auction:reset` | Client → Server | `{ auctionId }` | Demo reset via socket |
| `auction:reset_done` | Server → Room | `{ auctionId, item, timeRemaining }` | Broadcast on reset |

### REST Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Render health check → `{ status: "ok" }` |
| `GET` | `/api/auctions` | List all auctions (public fields) |
| `GET` | `/api/auctions/:id` | Single auction detail with bid history |
| `POST` | `/api/auctions/:id/reset` | Reset auction to initial state |

---

## Bid Validation Order

Validation runs **synchronously** in a single event-loop tick (no await between read and write). This prevents two concurrent bids for the same amount from both succeeding.

| Step | Check | Rejection Message |
|---|---|---|
| 1 | `auctionId` exists, `amount` is a finite positive integer, socket has joined as **bidder** | Various |
| 2 | Auction `status === "active"` and `timeRemainingSeconds > 0` | `"Auction is closed."` |
| 3 | Sender is NOT already the highest bidder | `"You are already the highest bidder."` |
| 4 | `amount >= currentBid + minIncrement` | `"Bid too low. Minimum valid bid is ₹<min>."` |
| 5 | `amount <= walletBalance` | `"Insufficient wallet balance."` |
| 6 | **Mutate state**: update `currentBid`, `highestBidder`, prepend `bidHistory` | — |
| 7 | **Anti-snipe**: if `timeRemaining <= 15`, reset to `20` | Emits `auction:extended` |
| 8 | Emit `bid:success` to room; emit `bid:outbid` privately to previous highest bidder | — |

---

## Anti-Snipe Rules

| Constant | Value |
|---|---|
| `ANTI_SNIPE_WINDOW_SECONDS` | 15 |
| `ANTI_SNIPE_RESET_SECONDS` | 20 |

**Trigger condition:** A valid bid is placed when `timeRemainingSeconds <= 15`.  
**Effect:** `timeRemainingSeconds` is set to `20`, and `auction:extended` is broadcast to the room.  
**Client effect:** Orange flash on countdown, toast notification, and an audio cue.

---

## Manual Testing (3 Browser Tabs)

1. Start the server: `npm start`
2. Open **3 browser tabs** at `http://localhost:5000`

| Tab | Username | Role |
|---|---|---|
| Tab 1 | Vikram | Bidder |
| Tab 2 | Ananya | Bidder |
| Tab 3 | Priya | Viewer |

**Scenarios to try:**
- Vikram bids → all three tabs update instantly
- Ananya outbids Vikram → only Vikram's tab shows the outbid alert + screen shake
- Priya clicks "Place Bid" → instantly rejected (viewer mode)
- Wait until timer is < 15s, then place a bid → watch the countdown jump to ~20s
- Let the timer reach 0 → Sold screen appears with confetti (or Unsold)
- Click "Restart Demo Auction" → all three tabs reset simultaneously

---

## Automated Tests

```bash
# Terminal 1 — start server
npm start

# Terminal 2 — run tests
npm test
```

The test suite (`test/simulate.js`) uses `socket.io-client` to connect 3 virtual participants and asserts 10 phases:

1. `auction:init` with correct state; `user:joined` viewer count = 3
2. Vikram bids 52,000 → all three receive `bid:success`
3. Ananya bids 54,000 → only Vikram gets `bid:outbid`
4. Ananya bids again while highest → `bid:rejected` (already highest)
5. Bid below minimum increment → `bid:rejected` with correct minimum
6. Viewer attempts to bid → rejected
7. Concurrency: both emit same valid amount → exactly 1 success + 1 rejected
8. Anti-snipe: bid near end of timer → `auction:extended` fires, timeRemaining ≥ 18s
9. Timer hits 0 → `auction:sold` emitted; further bids rejected as "closed"
10. Viewer disconnect → `user:left` with decremented `totalViewers`

---

## Render Deployment

1. Push the **entire repository** to GitHub (the root of the repo should contain `assignment-15/`).
2. Create a new **Web Service** on [Render](https://render.com).
3. Set **Root Directory** to `assignment-15/Manan-Jain/`
4. Set **Build Command** to `npm install`
5. Set **Start Command** to `npm start`
6. Add environment variables:
   - `PORT` = `10000` (Render assigns this automatically via `process.env.PORT`)
   - `CLIENT_ORIGIN` = `*` (or your Render domain for tighter CORS)
7. Render will hit `/health` for health checks — this endpoint returns `{ status: "ok" }`.

> ⚠️ The client connects using `io()` with no hardcoded URL, so it will automatically use the Render domain in production.

---

## Grading Coverage Summary

| Area | Points | Implementation |
|---|---|---|
| **Bid Engine** | 30 | 8-step synchronous validation in `auctionEngine.js`; atomic state mutation; wallet simulation; `bid:success` / `bid:rejected` events |
| **Timer & Anti-Snipe** | 25 | `timerManager.js` runs one `setInterval` per auction; anti-snipe window (15s) extends to 20s; `auction:sold` / `auction:unsold` at t=0; reserve-price check |
| **Outbid Alerts & Broadcasting** | 20 | `bid:success` → entire room; `bid:outbid` → previous highest bidder's socket only; `auction:extended` broadcast |
| **Bid History & Viewer Counter** | 15 | `bidHistory` (newest-first, capped at 50); `user:joined` / `user:left` with `totalViewers`; viewers Map per auction |
| **UI / Audio / Architecture** | 10 | Dark trading-floor theme; animated bid ticker; urgent countdown; toast/screen-shake; Web Audio API beeps; confetti; `server.js` is wiring-only |

---

## State Storage Note

> **All auction state is held in-memory on the server.** There is no database.  
> Restarting the server resets all auctions to their initial seeded state.  
> This is intentional — the project is a real-time engine demo, not a persistent production system.
