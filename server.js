const path = require("path");
const fs = require("fs");
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");
const multer = require("multer");

const io = new Server(http, { cors: { origin: "*" } });

// ====== Site-wide admin password (for Host role) ======
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "1234";

// ====== File uploads ======
const uploadDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safeBase = String(file.originalname || "photo").replace(/[^\w.\-]+/g, "_");
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e6);
    const ext = path.extname(safeBase) || ".jpg";
    cb(null, unique + ext);
  }
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ====== In-memory store ======
let nextEventId = 1;
let nextItemId = 1;

/*
Event:
{
  id, name, isProtected, password,
  location,                // NEW: required by host
  items: [Item],
  minIncrement: number,    // 0 disables increment rule
  currentLotId: number|null,
  participants: Set<string>,
  active: boolean
}

Item:
{
  id, title, description, openingBid,
  currentBid, currentWinner,
  bidHistory: [{name, amount, time}],
  status: "open"|"sold"|"closed",
  endTime: number|null,
  imageUrl: string|null,
  // Payment window (2 min) for winner after SOLD:
  paymentStatus: "none"|"pending"|"confirmed"|"expired",
  paymentDueAt: number|null,   // epoch ms
  paymentWinnerName: string|null,
}
*/
const events = [];

// ====== Helpers ======
function getEvent(id) { return events.find(e => e.id === Number(id)); }
function getItem(event, itemId) { return event?.items.find(i => i.id === Number(itemId)); }
function isSiteAdmin(token) { return ADMIN_TOKEN && String(token) === String(ADMIN_TOKEN); }

// ====== CSV Export (per event) ======
app.get("/export.csv", (req, res) => {
  const eventId = Number(req.query.eventId);
  const ev = getEvent(eventId);
  if (!ev) return res.status(404).send("Event not found");
  const header = [
    "eventId","eventName","location","id","title","description","openingBid",
    "currentBid","currentWinner","status","paymentStatus","totalBids"
  ].join(",");
  const lines = ev.items.map(it => {
    const cols = [
      ev.id,
      `"${(ev.name||"").replace(/"/g,'""')}"`,
      `"${(ev.location||"").replace(/"/g,'""')}"`,
      it.id,
      `"${(it.title||"").replace(/"/g,'""')}"`,
      `"${(it.description||"").replace(/"/g,'""')}"`,
      it.openingBid,
      it.currentBid,
      `"${(it.currentWinner||"").replace(/"/g,'""')}"`,
      it.status,
      it.paymentStatus || "none",
      it.bidHistory.length
    ];
    return cols.join(",");
  });
  const csv = [header, ...lines].join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=auction_event_${ev.id}.csv`);
  res.send(csv);
});

// ====== Image upload (Admin only) ======
app.post("/api/upload", upload.single("photo"), (req, res) => {
  const token = req.body?.adminToken;
  if (!isSiteAdmin(token)) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  if (!req.file) return res.status(400).json({ ok: false, error: "No file" });
  return res.json({ ok: true, url: "/uploads/" + path.basename(req.file.path) });
});

// ====== Health ======
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ====== Socket.IO ======
io.on("connection", (socket) => {
  // connection metadata
  socket.data.role = "guest";                // "host" | "bidder" | "guest"
  socket.data.eventId = null;               // which event joined
  socket.data.nameLocked = false;           // lock bidder name during event
  socket.data.displayName = null;
  // mock payment profile (NO real cards stored)
  socket.data.paymentProfile = null;        // { name, email, last4, deliveryAddress? }

  // ---- Landing: role & auth ----
  socket.on("auth", ({ role, password } = {}, cb) => {
    try {
      role = String(role || "").toLowerCase();
      if (role === "host") {
        if (!isSiteAdmin(password)) throw new Error("Invalid host password");
        socket.data.role = "host";
      } else if (role === "bidder") {
        socket.data.role = "bidder";
      } else {
        socket.data.role = "guest";
      }
      cb && cb({ ok: true, role: socket.data.role });
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  // ---- Landing: collect payment profile (placeholder only) ----
  // We store only non-sensitive & masked fields.
  socket.on("profile:setup", ({ name, email, cardLast4, deliveryAddress } = {}, cb) => {
    try {
      name = String(name || "").trim();
      email = String(email || "").trim();
      const last4 = String(cardLast4 || "").trim().slice(-4);
      if (!name) throw new Error("Name is required");
      if (!email) throw new Error("Email is required");
      socket.data.displayName = name;
      socket.data.paymentProfile = { name, email, last4, deliveryAddress: deliveryAddress || "" };
      cb && cb({ ok: true, profile: socket.data.paymentProfile });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  // ---- Events: public listing ----
  socket.on("events:list", (_payload, cb) => {
    const listing = events.map(e => ({
      id: e.id, name: e.name, isProtected: !!e.isProtected,
      active: !!e.active, itemCount: e.items.length, location: e.location || ""
    }));
    cb && cb({ ok: true, events: listing });
  });

  // ---- Host: create event (requires location) ----
  socket.on("host:createEvent", (payload, cb) => {
    try {
      if (socket.data.role !== "host") throw new Error("Host only");
      const name = String(payload?.name || "").trim();
      const location = String(payload?.location || "").trim();
      const isProtected = !!payload?.isProtected;
      const password = isProtected ? String(payload?.password || "") : "";
      if (!name) throw new Error("Event name is required");
      if (!location) throw new Error("Event location is required");
      if (isProtected && !password) throw new Error("Password required for protected event");

      const ev = {
        id: nextEventId++,
        name, location, isProtected, password,
        items: [],
        minIncrement: 0,
        currentLotId: null,
        participants: new Set(),
        active: true
      };
      events.push(ev);

      io.emit("eventsUpdated", {
        events: events.map(e => ({
          id: e.id, name: e.name, isProtected: e.isProtected, active: e.active, itemCount: e.items.length, location: e.location
        }))
      });

      cb && cb({ ok: true, event: { id: ev.id, name: ev.name, isProtected: ev.isProtected, location: ev.location } });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  // ---- Bidder joins an event (password if required) ----
  socket.on("event:join", ({ eventId, name, password } = {}, cb) => {
    try {
      if (!socket.data.paymentProfile) throw new Error("Complete payment profile first");
      if (socket.data.role !== "bidder") throw new Error("Switch to Bidder to join");
      const ev = getEvent(eventId);
      if (!ev) throw new Error("Event not found");
      if (ev.isProtected && String(password || "") !== String(ev.password)) throw new Error("Wrong event password");

      name = String(name || "").trim() || socket.data.displayName;
      if (!name) throw new Error("Please enter a name");

      // Lock name while in event; must be unique
      if (socket.data.nameLocked && socket.data.displayName && socket.data.eventId === ev.id) {
        if (name !== socket.data.displayName) throw new Error("Name cannot be changed during an active event");
      }
      if (!socket.data.nameLocked || socket.data.eventId !== ev.id || !socket.data.displayName) {
        if (ev.participants.has(name)) throw new Error("That name is already taken in this event");
      }

      // Move rooms if needed
      if (socket.data.eventId && socket.data.eventId !== ev.id) {
        const prev = getEvent(socket.data.eventId);
        if (prev && socket.data.displayName) prev.participants.delete(socket.data.displayName);
        socket.leave("event_" + socket.data.eventId);
      }

      socket.join("event_" + ev.id);
      socket.data.eventId = ev.id;
      socket.data.displayName = name;
      socket.data.nameLocked = true;
      ev.participants.add(name);

      cb && cb({
        ok: true,
        event: { id: ev.id, name: ev.name, isProtected: ev.isProtected, active: ev.active, minIncrement: ev.minIncrement, currentLotId: ev.currentLotId, location: ev.location },
        items: ev.items
      });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  // Release name when leaving
  socket.on("disconnect", () => {
    const ev = getEvent(socket.data.eventId);
    if (ev && socket.data.displayName) ev.participants.delete(socket.data.displayName);
  });

  // ---- Host: per-event settings & items ----
  socket.on("host:setMinIncrement", ({ eventId, value } = {}, cb) => {
    try {
      if (socket.data.role !== "host") throw new Error("Host only");
      const ev = getEvent(eventId);
      if (!ev) throw new Error("Event not found");
      const v = Number(value);
      if (!Number.isFinite(v) || v < 0) throw new Error("Value must be >= 0");
      ev.minIncrement = v;
      io.to("event_" + ev.id).emit("eventConfigUpdated", { eventId: ev.id, minIncrement: ev.minIncrement, currentLotId: ev.currentLotId });
      cb && cb({ ok: true, minIncrement: ev.minIncrement });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  socket.on("host:createItem", ({ eventId, title, description, openingBid, imageUrl } = {}, cb) => {
    try {
      if (socket.data.role !== "host") throw new Error("Host only");
      const ev = getEvent(eventId);
      if (!ev) throw new Error("Event not found");

      title = String(title || "").trim();
      description = String(description || "").trim();
      const open = Number(openingBid);

      if (!title) throw new Error("Title is required");
      if (!Number.isFinite(open) || open < 0) throw new Error("Opening bid must be a number ≥ 0");

      const item = {
        id: nextItemId++,
        title, description,
        openingBid: open,
        currentBid: open,
        currentWinner: null,
        bidHistory: [],
        status: "open",
        endTime: null,
        imageUrl: imageUrl || null,
        paymentStatus: "none",
        paymentDueAt: null,
        paymentWinnerName: null
      };

      ev.items.push(item);
      io.to("event_" + ev.id).emit("items", ev.items);
      cb && cb({ ok: true, item });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  socket.on("host:startTimer", ({ eventId, itemId, durationSeconds } = {}, cb) => {
    try {
      if (socket.data.role !== "host") throw new Error("Host only");
      const ev = getEvent(eventId);
      const item = getItem(ev, itemId);
      if (!ev || !item) throw new Error("Not found");
      if (item.status !== "open") throw new Error("Item not open");
      const dur = Number(durationSeconds || 60);
      if (!Number.isFinite(dur) || dur <= 0) throw new Error("Bad duration");
      item.endTime = Date.now() + dur * 1000;
      io.to("event_" + ev.id).emit("itemUpdated", item);
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  socket.on("host:stopTimer", ({ eventId, itemId } = {}, cb) => {
    try {
      if (socket.data.role !== "host") throw new Error("Host only");
      const ev = getEvent(eventId);
      const item = getItem(ev, itemId);
      if (!ev || !item) throw new Error("Not found");
      item.endTime = null;
      io.to("event_" + ev.id).emit("itemUpdated", item);
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  socket.on("host:markSold", ({ eventId, itemId } = {}, cb) => {
    try {
      if (socket.data.role !== "host") throw new Error("Host only");
      const ev = getEvent(eventId);
      const item = getItem(ev, itemId);
      if (!ev || !item) throw new Error("Not found");
      item.status = "sold";
      item.endTime = null;
      // Start 2-minute payment window for the winning bidder
      if (item.currentWinner) {
        item.paymentStatus = "pending";
        item.paymentWinnerName = item.currentWinner;
        item.paymentDueAt = Date.now() + 2 * 60 * 1000; // 2 minutes
      }
      io.to("event_" + ev.id).emit("itemUpdated", item);
      cb && cb({ ok: true, item });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  socket.on("host:reopen", ({ eventId, itemId } = {}, cb) => {
    try {
      if (socket.data.role !== "host") throw new Error("Host only");
      const ev = getEvent(eventId);
      const item = getItem(ev, itemId);
      if (!ev || !item) throw new Error("Not found");
      item.status = "open";
      if (item.endTime && Date.now() >= item.endTime) item.endTime = null;
      // reset payment window
      item.paymentStatus = "none";
      item.paymentDueAt = null;
      item.paymentWinnerName = null;
      io.to("event_" + ev.id).emit("itemUpdated", item);
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  socket.on("host:setCurrentLot", ({ eventId, itemId } = {}, cb) => {
    try {
      if (socket.data.role !== "host") throw new Error("Host only");
      const ev = getEvent(eventId);
      if (!ev) throw new Error("Event not found");
      if (itemId && !getItem(ev, itemId)) throw new Error("Item not found");
      ev.currentLotId = itemId || null;
      io.to("event_" + ev.id).emit("eventConfigUpdated", { eventId: ev.id, minIncrement: ev.minIncrement, currentLotId: ev.currentLotId });
      cb && cb({ ok: true, currentLotId: ev.currentLotId });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  // ---- Bids (bidder only) ----
  socket.on("placeBid", ({ eventId, itemId, amount, name } = {}, cb) => {
    try {
      if (socket.data.role !== "bidder") throw new Error("Only bidders can place bids");
      const ev = getEvent(eventId);
      const item = getItem(ev, itemId);
      if (!ev || !item) throw new Error("Not found");
      if (socket.data.eventId !== ev.id) throw new Error("Join the event first");

      const effectiveName = socket.data.displayName || String(name || "Anonymous").slice(0, 40);
      if (!socket.data.nameLocked || effectiveName !== socket.data.displayName) {
        throw new Error("Your name is locked for this event");
      }

      if (item.status !== "open") throw new Error(`Bidding is closed (${item.status}).`);
      if (item.endTime && Date.now() >= item.endTime) {
        item.status = "closed"; item.endTime = null;
        io.to("event_" + ev.id).emit("itemUpdated", item);
        throw new Error("Time is up—bidding closed.");
      }

      amount = Number(amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Bid amount must be positive");

      const minAcceptable = Math.max(item.openingBid, item.currentBid);
      let required = minAcceptable + (ev.minIncrement || 0);
      if (ev.minIncrement === 0) required = minAcceptable + Number.EPSILON;
      if (amount < required) {
        if (ev.minIncrement > 0) throw new Error(`Bid must be at least R${ev.minIncrement.toFixed(2)} higher (>= R${required.toFixed(2)}).`);
        else throw new Error(`Bid must be greater than current bid (R${minAcceptable.toFixed(2)}).`);
      }

      item.currentBid = amount;
      item.currentWinner = effectiveName;
      item.bidHistory.push({ name: effectiveName, amount, time: Date.now() });

      // If it had a pending/expired payment (from a previous sale), clear payment fields on new bids
      if (item.paymentStatus !== "none") {
        item.paymentStatus = "none";
        item.paymentDueAt = null;
        item.paymentWinnerName = null;
      }

      io.to("event_" + ev.id).emit("itemUpdated", item);
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  // ---- Winner confirms payment (mock) ----
  socket.on("payment:confirm", ({ eventId, itemId } = {}, cb) => {
    try {
      const ev = getEvent(eventId);
      const item = getItem(ev, itemId);
      if (!ev || !item) throw new Error("Not found");
      if (item.status !== "sold") throw new Error("Item not sold");
      if (item.paymentStatus !== "pending") throw new Error("No pending payment");
      if (!socket.data.paymentProfile) throw new Error("Setup payment profile first");
      if (socket.data.displayName !== item.paymentWinnerName) throw new Error("Only the winning bidder can confirm");

      const now = Date.now();
      if (item.paymentDueAt && now > item.paymentDueAt) {
        item.paymentStatus = "expired";
        io.to("event_" + ev.id).emit("itemUpdated", item);
        throw new Error("Payment window expired");
      }

      // Mark as confirmed (no real payment processing)
      item.paymentStatus = "confirmed";
      item.paymentDueAt = null;
      io.to("event_" + ev.id).emit("itemUpdated", item);
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });
});

// ====== Timer expiry (bidding + payment windows) ======
setInterval(() => {
  const now = Date.now();
  for (const ev of events) {
    let changedAny = false;

    for (const item of ev.items) {
      // Close bidding if time ended
      if (item.status === "open" && item.endTime && now >= item.endTime) {
        item.status = "closed";
        item.endTime = null;
        changedAny = true;
      }
      // Expire payment window
      if (item.status === "sold" && item.paymentStatus === "pending" && item.paymentDueAt && now > item.paymentDueAt) {
        item.paymentStatus = "expired";
        changedAny = true;
      }
    }

    if (changedAny) io.to("event_" + ev.id).emit("items", ev.items);
  }
}, 1000);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Auction server listening on http://localhost:${PORT}`);
});

