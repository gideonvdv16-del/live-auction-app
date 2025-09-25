const path = require("path");
const fs = require("fs");
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");
const multer = require("multer");

const io = new Server(http, { cors: { origin: "*" } });

// ====== Site-wide admin password (for creating/managing events) ======
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "1234";

// ====== File uploads (per-event images saved under /public/uploads/) ======
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
Event shape:
{
  id, name, isProtected, password,
  items: [item],               // items scoped to this event
  minIncrement: number,        // 0 means disabled
  currentLotId: number|null,
  participants: Set<string>,   // bidder names currently in event
  active: boolean              // reserved for future use
}

Item shape:
{
  id, title, description, openingBid,
  currentBid, currentWinner,
  bidHistory: [{name, amount, time}],
  status: "open"|"sold"|"closed",
  endTime: number|null,  // epoch ms
  imageUrl: string|null
}
*/
const events = [];

// ====== Helpers ======
function getEvent(id) {
  return events.find(e => e.id === Number(id));
}
function getItem(event, itemId) {
  return event?.items.find(i => i.id === Number(itemId));
}
function isSiteAdmin(token) {
  return ADMIN_TOKEN && String(token) === String(ADMIN_TOKEN);
}

// ====== CSV Export (per event) ======
app.get("/export.csv", (req, res) => {
  const eventId = Number(req.query.eventId);
  const ev = getEvent(eventId);
  if (!ev) return res.status(404).send("Event not found");
  const header = [
    "eventId","eventName","id","title","description","openingBid",
    "currentBid","currentWinner","status","totalBids"
  ].join(",");
  const lines = ev.items.map(it => {
    const cols = [
      ev.id,
      `"${(ev.name||"").replace(/"/g,'""')}"`,
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
  res.setHeader("Content-Disposition", `attachment; filename=auction_event_${ev.id}.csv`);
  res.send(csv);
});

// ====== Image upload (Admin only, site-wide admin token) ======
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
  socket.data.role = "bidder";            // "admin" or "bidder"
  socket.data.eventId = null;             // which event joined
  socket.data.nameLocked = false;         // lock bidder name during active event
  socket.data.displayName = null;

  // --- Public: list events (never exposes passwords) ---
  socket.on("events:list", (_, cb) => {
    const listing = events.map(e => ({
      id: e.id,
      name: e.name,
      isProtected: !!e.isProtected,
      active: e.active,
      itemCount: e.items.length
    }));
    cb && cb({ ok: true, events: listing });
  });

  // --- Site admin login (for creating/managing events) ---
  socket.on("auth", ({ role, password } = {}, cb) => {
    try {
      role = String(role || "").toLowerCase();
      if (role === "admin") {
        if (!isSiteAdmin(password)) throw new Error("Invalid admin password");
        socket.data.role = "admin";
      } else {
        socket.data.role = "bidder";
      }
      cb && cb({ ok: true, role: socket.data.role });
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  // --- Bidder joins an event (with optional event password) & sets unique name ---
  socket.on("event:join", ({ eventId, name, password } = {}, cb) => {
    try {
      const ev = getEvent(eventId);
      if (!ev) throw new Error("Event not found");
      if (ev.isProtected && String(password || "") !== String(ev.password)) {
        throw new Error("Wrong event password");
      }

      name = String(name || "").trim();
      if (!name) throw new Error("Please enter a name");

      // Block renaming while active
      if (socket.data.nameLocked && socket.data.displayName && socket.data.eventId === ev.id) {
        if (name !== socket.data.displayName) throw new Error("Name cannot be changed during an active event");
      }

      // Enforce unique name within the event
      if (!socket.data.nameLocked || socket.data.eventId !== ev.id || !socket.data.displayName) {
        if (ev.participants.has(name)) throw new Error("That name is already taken in this event");
      }

      // Join room, register name
      if (socket.data.eventId && socket.data.eventId !== ev.id) {
        // leaving previous event room: remove old name
        const prev = getEvent(socket.data.eventId);
        if (prev && socket.data.displayName) prev.participants.delete(socket.data.displayName);
        socket.leave("event_" + socket.data.eventId);
      }

      socket.join("event_" + ev.id);
      socket.data.eventId = ev.id;
      socket.data.displayName = name;
      socket.data.nameLocked = true;  // lock now
      ev.participants.add(name);

      // Send scoped state
      const payload = {
        event: {
          id: ev.id,
          name: ev.name,
          isProtected: ev.isProtected,
          active: ev.active,
          minIncrement: ev.minIncrement,
          currentLotId: ev.currentLotId,
        },
        items: ev.items
      };
      cb && cb({ ok: true, ...payload });
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  // Release name on disconnect
  socket.on("disconnect", () => {
    const ev = getEvent(socket.data.eventId);
    if (ev && socket.data.displayName) {
      ev.participants.delete(socket.data.displayName);
    }
  });

  // --- Admin: create event ---
  socket.on("admin:createEvent", (payload, cb) => {
    try {
      if (socket.data.role !== "admin") throw new Error("Admin only");
      const name = String(payload?.name || "").trim();
      const isProtected = !!payload?.isProtected;
      const password = isProtected ? String(payload?.password || "") : "";
      if (!name) throw new Error("Event name is required");
      if (isProtected && !password) throw new Error("Password required for protected event");

      const ev = {
        id: nextEventId++,
        name,
        isProtected,
        password,
        items: [],
        minIncrement: 0,
        currentLotId: null,
        participants: new Set(),
        active: true
      };
      events.push(ev);

      // broadcast event list update to all
      io.emit("eventsUpdated", {
        events: events.map(e => ({ id: e.id, name: e.name, isProtected: e.isProtected, active: e.active, itemCount: e.items.length }))
      });

      cb && cb({ ok: true, event: { id: ev.id, name: ev.name, isProtected: ev.isProtected } });
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  // --- Admin: set per-event min increment ---
  socket.on("admin:setMinIncrement", ({ eventId, value } = {}, cb) => {
    try {
      if (socket.data.role !== "admin") throw new Error("Admin only");
      const ev = getEvent(eventId);
      if (!ev) throw new Error("Event not found");
      const v = Number(value);
      if (!Number.isFinite(v) || v < 0) throw new Error("Value must be >= 0");
      ev.minIncrement = v;
      io.to("event_" + ev.id).emit("eventConfigUpdated", {
        eventId: ev.id,
        minIncrement: ev.minIncrement,
        currentLotId: ev.currentLotId
      });
      cb && cb({ ok: true, minIncrement: ev.minIncrement });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  // --- Admin: create item (with optional image) ---
  socket.on("admin:createItem", ({ eventId, title, description, openingBid, imageUrl } = {}, cb) => {
    try {
      if (socket.data.role !== "admin") throw new Error("Admin only");
      const ev = getEvent(eventId);
      if (!ev) throw new Error("Event not found");

      title = String(title || "").trim();
      description = String(description || "").trim();
      const open = Number(openingBid);

      if (!title) throw new Error("Title is required");
      if (!Number.isFinite(open) || open < 0) throw new Error("Opening bid must be a number ≥ 0");

      const item = {
        id: nextItemId++,
        title,
        description,
        openingBid: open,
        currentBid: open,
        currentWinner: null,
        bidHistory: [],
        status: "open",
        endTime: null,
        imageUrl: imageUrl || null
      };

      ev.items.push(item);
      io.to("event_" + ev.id).emit("items", ev.items);
      cb && cb({ ok: true, item });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  // --- Admin: timers & status per item ---
  socket.on("admin:startTimer", ({ eventId, itemId, durationSeconds } = {}, cb) => {
    try {
      if (socket.data.role !== "admin") throw new Error("Admin only");
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

  socket.on("admin:stopTimer", ({ eventId, itemId } = {}, cb) => {
    try {
      if (socket.data.role !== "admin") throw new Error("Admin only");
      const ev = getEvent(eventId);
      const item = getItem(ev, itemId);
      if (!ev || !item) throw new Error("Not found");
      item.endTime = null;
      io.to("event_" + ev.id).emit("itemUpdated", item);
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  socket.on("admin:markSold", ({ eventId, itemId } = {}, cb) => {
    try {
      if (socket.data.role !== "admin") throw new Error("Admin only");
      const ev = getEvent(eventId);
      const item = getItem(ev, itemId);
      if (!ev || !item) throw new Error("Not found");
      item.status = "sold";
      item.endTime = null;
      io.to("event_" + ev.id).emit("itemUpdated", item);
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  socket.on("admin:reopen", ({ eventId, itemId } = {}, cb) => {
    try {
      if (socket.data.role !== "admin") throw new Error("Admin only");
      const ev = getEvent(eventId);
      const item = getItem(ev, itemId);
      if (!ev || !item) throw new Error("Not found");
      item.status = "open";
      if (item.endTime && Date.now() >= item.endTime) item.endTime = null;
      io.to("event_" + ev.id).emit("itemUpdated", item);
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  socket.on("admin:setCurrentLot", ({ eventId, itemId } = {}, cb) => {
    try {
      if (socket.data.role !== "admin") throw new Error("Admin only");
      const ev = getEvent(eventId);
      if (!ev) throw new Error("Event not found");
      if (itemId && !getItem(ev, itemId)) throw new Error("Item not found");
      ev.currentLotId = itemId || null;
      io.to("event_" + ev.id).emit("eventConfigUpdated", {
        eventId: ev.id,
        minIncrement: ev.minIncrement,
        currentLotId: ev.currentLotId
      });
      cb && cb({ ok: true, currentLotId: ev.currentLotId });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  // --- Bidders: place bid (event-scoped) ---
  socket.on("placeBid", ({ eventId, itemId, amount, name } = {}, cb) => {
    try {
      // Must be bidder
      if (socket.data.role !== "bidder") throw new Error("Only bidders can place bids");
      const ev = getEvent(eventId);
      const item = getItem(ev, itemId);
      if (!ev || !item) throw new Error("Not found");

      // Must be joined to the event
      if (socket.data.eventId !== ev.id) throw new Error("Join the event first");

      // Enforce locked name
      const effectiveName = socket.data.displayName || String(name || "Anonymous").slice(0, 40);
      if (!socket.data.nameLocked || effectiveName !== socket.data.displayName) {
        throw new Error("Your name is locked for this event");
      }

      if (item.status !== "open") throw new Error(`Bidding is closed (${item.status}).`);
      if (item.endTime && Date.now() >= item.endTime) {
        item.status = "closed";
        io.to("event_" + ev.id).emit("itemUpdated", item);
        throw new Error("Time is up—bidding closed.");
      }

      amount = Number(amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Bid amount must be a positive number");

      const minAcceptable = Math.max(item.openingBid, item.currentBid);
      let required = minAcceptable + (ev.minIncrement || 0);
      if (ev.minIncrement === 0) required = minAcceptable + Number.EPSILON;
      if (amount < required) {
        if (ev.minIncrement > 0) throw new Error(`Bid must be at least R${ev.minIncrement.toFixed(2)} higher (>= R${required.toFixed(2)}).`);
        else throw new Error(`Bid must be greater than current bid (R${minAcceptable.toFixed(2)}).`);
      }

      // Update
      item.currentBid = amount;
      item.currentWinner = effectiveName;
      item.bidHistory.push({ name: effectiveName, amount, time: Date.now() });

      io.to("event_" + ev.id).emit("itemUpdated", item);
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });
});

// ====== Timer expiry per event ======
setInterval(() => {
  const now = Date.now();
  for (const ev of events) {
    let changed = false;
    for (const item of ev.items) {
      if (item.status === "open" && item.endTime && now >= item.endTime) {
        item.status = "closed";
        item.endTime = null;
        changed = true;
      }
    }
    if (changed) io.to("event_" + ev.id).emit("items", ev.items);
  }
}, 1000);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Auction server listening on http://localhost:${PORT}`);
});

