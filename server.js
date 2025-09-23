const path = require("path");
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");
const io = new Server(http, {
  cors: { origin: "*" }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let nextItemId = 1;
const items = []; 
// each item = { id, title, description, openingBid, currentBid, currentWinner, bidHistory: [{name, amount, time}] }

io.on("connection", (socket) => {
  // Send current items immediately
  socket.emit("items", items);

  // Optional: store user's display name for bid history
  socket.on("join", (name) => {
    socket.data.displayName = String(name || "Anonymous").slice(0, 40);
  });

  // Admin creates an item (no auth in MVP)
  socket.on("createItem", (payload, cb) => {
    try {
      const title = String(payload?.title || "").trim();
      const description = String(payload?.description || "").trim();
      const openingBid = Number(payload?.openingBid);

      if (!title) throw new Error("Title is required");
      if (!Number.isFinite(openingBid) || openingBid < 0) throw new Error("Opening bid must be a number ≥ 0");

      const item = {
        id: nextItemId++,
        title,
        description,
        openingBid,
        currentBid: openingBid,
        currentWinner: null,
        bidHistory: []
      };
      items.push(item);
      io.emit("items", items);
      cb && cb({ ok: true, item });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  // Place a bid
  socket.on("placeBid", (payload, cb) => {
    try {
      const itemId = Number(payload?.itemId);
      const amount = Number(payload?.amount);
      const name = socket.data.displayName || String(payload?.name || "Anonymous").slice(0, 40);

      const item = items.find(i => i.id === itemId);
      if (!item) throw new Error("Item not found");

      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Bid amount must be a positive number");

      const minAcceptable = Math.max(item.openingBid, item.currentBid);
      if (amount <= minAcceptable) {
        throw new Error(`Bid must be greater than current bid (R${minAcceptable.toFixed(2)})`);
      }

      // Update item
      item.currentBid = amount;
      item.currentWinner = name;
      item.bidHistory.push({ name, amount, time: Date.now() });

      // Notify everyone about updated item
      io.emit("bidUpdate", { itemId: item.id, currentBid: item.currentBid, currentWinner: item.currentWinner });

      cb && cb({ ok: true, item });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  // Client may request a fresh list
  socket.on("getItems", () => socket.emit("items", items));
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Auction server listening on http://localhost:${PORT}`);
});
