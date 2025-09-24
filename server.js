const path = require("path");
const fs = require("fs");
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");
const multer = require("multer");

// ====== Config ======
const io = new Server(http, { cors: { origin: "*" } });

// IMPORTANT: admin password default = 1234 (can override in Render env var)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "1234";
// Global minimum increment in R (0 to disable)
let MIN_INCREMENT = Number(process.env.MIN_INCREMENT || 0);

// Create uploads directory (ephemeral on Render, OK for MVP)
const uploadDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safeBase = String(file.originalname || "photo").replace(/[^\w.\-]+/g, "_");
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e6);
    const ext = path.extname(safeBase) || ".jpg";
    cb(null, unique + ext);
  }
});
const upload = multer({ storage });

// ====== App & Static ======
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ====== In-memory data ======
let nextItemId = 1;
const items = [];
/*
each item = {
  id, title, description, openingBid,
  currentBid, currentWinner,
  bidHistory: [{name, amount, time}],
  status: "open" | "sold" | "closed",
  endTime: null | number, // epoch ms
  imageUrl: null | string  // /uploads/filename.jpg
}
*/
let currentLotId = null; // projector "current lot"

// ====== Helpers ======
function getItem(id) {
  return items.find(i => i.id === Number(id));
}

function isAuthedAdminToken(token) {
  return ADMIN_TOKEN && token && String(token) === String(ADMIN_TOKEN);
}

// CSV export
app.get("/export.csv", (_req, res) => {
  const header = [
    "id","title","description","openingBid",
    "currentBid","currentWinner","status","totalBids"
  ].join(",");
  const lines = items.map(it => {
    const cols = [
      it.id,
      `"${(it.title||"").replace(/"/g,'""')}"`,
      `"${(it.description||"").replace(/"/g,'""')}"`,
      it.openingBid,
      it.currentBid,
      `"${(it.currentWinner||"").replace(/"/g,'""')}"`,
      it.status,
      it.bidHistory.length
    ];
    return cols.join(",");
  });
  const csv = [header, ...lines].join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=auction_export.csv");
  res.send(csv);
});

// Simple health
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ========= Image upload (Admin only) =========
app.post("/api/upload", upload.single("photo"), (req, res) => {
  const token = req.body?.adminToken;
  if (!isAuthedAdminToken(token)) {
    // clean up uploaded file if any
    if (req.file && req.file.path) try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  if (!req.file) return res.status(400).json({ ok: false, error: "No file" });
  const rel = "/uploads/" + path.basename(req.file.path);
  return res.json({ ok: true, url: rel });
});

// ========= Socket.IO =========
io.on("connection", (socket) => {
  // role: 'admin' or 'bidder'
  socket.data.role = "bidder"; // default

  // Clients must call 'auth' after load
  socket.on("auth", ({ role, password } = {}, cb) => {
    try {
      role = String(role || "").toLowerCase();
      if (role === "admin") {
        if (!isAuthedAdminToken(password)) {
          socket.data.role = "bidder";
          throw new Error("Invalid admin password");
        }
        socket.data.role = "admin";
      } else {
        socket.data.role = "bidder";
      }
      cb && cb({ ok: true, role: socket.data.role });
      // On auth, send state
      socket.emit("items", items);
      socket.emit("configUpdated", { MIN_INCREMENT, currentLotId });
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  socket.on("join", (name) => {
    socket.data.displayName = String(name || "Anonymous").slice(0, 40);
  });

  // ===== Admin-only Actions =====
  function requireAdmin(cb, tokenFromPayload) {
    if (socket.data.role === "admin") return true;
    // also allow admin token on payload for redundancy
    if (isAuthedAdminToken(tokenFromPayload)) return true;
    cb && cb({ ok: false, error: "Admin only" });
    return false;
  }

  socket.on("createItem", (payload, cb) => {
    if (!requireAdmin(cb, payload?.adminToken)) return;
    try {
      const title = String(payload?.title || "").trim();
      const description = String(payload?.description || "").trim();
      const openingBid = Number(payload?.openingBid);
      const imageUrl = payload?.imageUrl ? String(payload.imageUrl) : null;

      if (!title) throw new Error("Title is required");
      if (!Number.isFinite(openingBid) || openingBid < 0) throw new Error("Opening bid must be a number ≥ 0");

      const item = {
        id: nextItemId++,
        title,
        description,
        openingBid,
        currentBid: openingBid,
        currentWinner: null,
        bidHistory: [],
        status: "open",
        endTime: null,
        imageUrl
      };
      items.push(item);
      io.emit("items", items);
      cb && cb({ ok: true, item });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on("admin:setMinIncrement", (payload, cb) => {
    if (!requireAdmin(cb, payload?.adminToken)) return;
    const v = Number(payload?.value);
    if (!Number.isFinite(v) || v < 0) return cb && cb({ ok: false, error: "Value must be >= 0" });
    MIN_INCREMENT = v;
    io.emit("configUpdated", { MIN_INCREMENT, currentLotId });
    cb && cb({ ok: true, MIN_INCREMENT });
  });

  socket.on("admin:startTimer", (payload, cb) => {
    if (!requireAdmin(cb, payload?.adminToken)) return;
    const item = getItem(payload?.itemId);
    const duration = Number(payload?.durationSeconds || 60);
    if (!item) return cb && cb({ ok: false, error: "Item not found" });
    if (item.status !== "open") return cb && cb({ ok: false, error: "Item not open" });
    if (!Number.isFinite(duration) || duration <= 0) return cb && cb({ ok: false, error: "Bad duration" });
    item.endTime = Date.now() + duration * 1000;
    io.emit("itemUpdated", item);
    cb && cb({ ok: true, item });
  });

  socket.on("admin:stopTimer", (payload, cb) => {
    if (!requireAdmin(cb, payload?.adminToken)) return;
    const item = getItem(payload?.itemId);
    if (!item) return cb && cb({ ok: false, error: "Item not found" });
    item.endTime = null;
    io.emit("itemUpdated", item);
    cb && cb({ ok: true, item });
  });

  socket.on("admin:markSold", (payload, cb) => {
    if (!requireAdmin(cb, payload?.adminToken)) return;
    const item = getItem(payload?.itemId);
    if (!item) return cb && cb({ ok: false, error: "Item not found" });
    item.status = "sold";
    item.endTime = null;
    io.emit("itemUpdated", item);
    cb && cb({ ok: true, item });
  });

  socket.on("admin:reopen", (payload, cb) => {
    if (!requireAdmin(cb, payload?.adminToken)) return;
    const item = getItem(payload?.itemId);
    if (!item) return cb && cb({ ok: false, error: "Item not found" });
    item.status = "open";
    if (item.endTime && Date.now() >= item.endTime) item.endTime = null;
    io.emit("itemUpdated", item);
    cb && cb({ ok: true, item });
  });

  socket.on("admin:setCurrentLot", (payload, cb) => {
    if (!requireAdmin(cb, payload?.adminToken)) return;
    const id = Number(payload?.itemId) || null;
    if (id && !getItem(id)) return cb && cb({ ok: false, error: "Item not found" });
    currentLotId = id;
    io.emit("configUpdated", { MIN_INCREMENT, currentLotId });
    cb && cb({ ok: true, currentLotId });
  });

  // ===== Public / Bidder actions =====
  socket.on("getItems", () => socket.emit("items", items));

  socket.on("placeBid", (payload, cb) => {
    try {
      // Only bidders can bid
      if (socket.data.role !== "bidder") {
        throw new Error("Only bidders can place bids.");
      }
      const itemId = Number(payload?.itemId);
      const amount = Number(payload?.amount);
      const name = socket.data.displayName || String(payload?.name || "Anonymous").slice(0, 40);

      const item = getItem(itemId);
      if (!item) throw new Error("Item not found");

      if (item.status !== "open") {
        throw new Error(`Bidding is closed (${item.status}).`);
      }

      if (item.endTime && Date.now() >= item.endTime) {
        item.status = "closed";
        io.emit("itemUpdated", item);
        throw new Error("Time is up—bidding closed.");
      }

      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Bid amount must be a positive number");

      const minAcceptable = Math.max(item.openingBid, item.currentBid);
      let required = minAcceptable + (MIN_INCREMENT || 0);
      if (MIN_INCREMENT === 0) required = minAcceptable + Number.EPSILON;

      if (amount < required) {
        if (MIN_INCREMENT > 0) {
          throw new Error(`Bid must be at least R${MIN_INCREMENT.toFixed(2)} higher (>= R${required.toFixed(2)}).`);
        } else {
          throw new Error(`Bid must be greater than current bid (R${minAcceptable.toFixed(2)}).`);
        }
      }

      item.currentBid = amount;
      item.currentWinner = name;
      item.bidHistory.push({ name, amount, time: Date.now() });

      io.emit("itemUpdated", item);
      cb && cb({ ok: true, item });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });
});

// Timer expiry loop
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const item of items) {
    if (item.status === "open" && item.endTime && now >= item.endTime) {
      item.status = "closed";
      item.endTime = null;
      changed = true;
    }
  }
  if (changed) io.emit("items", items);
}, 1000);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Auction server listening on http://localhost:${PORT}`);
});

