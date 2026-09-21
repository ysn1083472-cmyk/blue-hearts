const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const ROOMS_FILE = path.join(DATA_DIR, "rooms.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(ROOMS_FILE)) {
  fs.writeFileSync(ROOMS_FILE, JSON.stringify({}, null, 2));
}

let rooms = {};

try {
  rooms = JSON.parse(fs.readFileSync(ROOMS_FILE, "utf8"));
} catch {
  rooms = {};
}

function saveRooms() {
  fs.writeFileSync(
    ROOMS_FILE,
    JSON.stringify(rooms, null, 2),
    "utf8"
  );
}

function cleanText(value, max = 500) {
  return String(value ?? "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, max);
}

function randomRoomCode() {
  let code;

  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms[code]);

  return code;
}

function publicRoom(roomCode) {
  const room = rooms[roomCode];

  if (!room) return null;

  return {
    code: roomCode,
    createdAt: room.createdAt,
    hearts: room.hearts,
    xp: room.xp,
    hugs: room.hugs,
    chestOpened: room.chestOpened,
    memories: room.memories,
    messages: room.messages,
    achievements: room.achievements,
    players: Object.values(room.players).map((p) => ({
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      online: p.online
    }))
  };
}

function emitRoom(roomCode) {
  io.to(roomCode).emit("state", publicRoom(roomCode));
}

function findPlayer(roomCode, socketId) {
  const room = rooms[roomCode];
  if (!room) return null;

  for (const playerId of Object.keys(room.players)) {
    if (room.players[playerId].socketId === socketId) {
      return playerId;
    }
  }

  return null;
}

function createPlayerToken() {
  return crypto.randomBytes(18).toString("hex");
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/room/:code", (req, res) => {
  const code = cleanText(req.params.code, 6);

  if (!rooms[code]) {
    return res.status(404).json({
      ok: false,
      error: "Oda bulunamadı."
    });
  }

  res.json({
    ok: true,
    room: publicRoom(code)
  });
});

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name, token } = {}, callback) => {
    const roomCode = randomRoomCode();

    const playerId = crypto.randomUUID();
    const playerToken = token || createPlayerToken();

    rooms[roomCode] = {
      createdAt: Date.now(),

      hearts: 0,
      xp: 0,
      hugs: 0,

      chestOpened: false,

      memories: [],
      messages: [],
      achievements: [],

      players: {}
    };

    rooms[roomCode].players[playerId] = {
      id: playerId,
      token: playerToken,
      socketId: socket.id,
      name: cleanText(name || "Oyuncu 1", 30),
      x: 250,
      y: 250,
      online: true,
      lastSeen: Date.now()
    };

    socket.join(roomCode);

    socket.roomCode = roomCode;
    socket.playerId = playerId;
    socket.playerToken = playerToken;

    saveRooms();

    callback?.({
      ok: true,
      roomCode,
      playerId,
      token: playerToken,
      state: publicRoom(roomCode)
    });

    emitRoom(roomCode);
  });

  socket.on(
    "joinRoom",
    ({ roomCode, name, token } = {}, callback) => {
      roomCode = cleanText(roomCode, 6);

      const room = rooms[roomCode];

      if (!room) {
        return callback?.({
          ok: false,
          error: "Bu oda bulunamadı."
        });
      }

      let playerId = null;

      if (token) {
        for (const id of Object.keys(room.players)) {
          if (room.players[id].token === token) {
            playerId = id;
            break;
          }
        }
      }

      if (!playerId) {
        const onlinePlayers = Object.values(room.players)
          .filter((p) => p.online);

        if (onlinePlayers.length >= 2) {
          return callback?.({
            ok: false,
            error: "Oda dolu. En fazla 2 kişi olabilir."
          });
        }

        playerId = crypto.randomUUID();

        room.players[playerId] = {
          id: playerId,
          token: createPlayerToken(),
          socketId: socket.id,
          name: cleanText(name || "Oyuncu 2", 30),
          x: 350,
          y: 250,
          online: true,
          lastSeen: Date.now()
        };
      } else {
        room.players[playerId].socketId = socket.id;
        room.players[playerId].online = true;
        room.players[playerId].lastSeen = Date.now();

        if (name) {
          room.players[playerId].name = cleanText(name, 30);
        }
      }

      socket.join(roomCode);

      socket.roomCode = roomCode;
      socket.playerId = playerId;
      socket.playerToken = room.players[playerId].token;

      saveRooms();

      callback?.({
        ok: true,
        roomCode,
        playerId,
        token: room.players[playerId].token,
        state: publicRoom(roomCode)
      });

      emitRoom(roomCode);
    }
  );

  socket.on("rejoinRoom", ({ roomCode, token } = {}, callback) => {
    roomCode = cleanText(roomCode, 6);

    const room = rooms[roomCode];

    if (!room || !token) {
      return callback?.({
        ok: false,
        error: "Odaya yeniden bağlanılamadı."
      });
    }

    let playerId = null;

    for (const id of Object.keys(room.players)) {
      if (room.players[id].token === token) {
        playerId = id;
        break;
      }
    }

    if (!playerId) {
      return callback?.({
        ok: false,
        error: "Oyuncu oturumu bulunamadı."
      });
    }

    room.players[playerId].socketId = socket.id;
    room.players[playerId].online = true;
    room.players[playerId].lastSeen = Date.now();

    socket.join(roomCode);

    socket.roomCode = roomCode;
    socket.playerId = playerId;
    socket.playerToken = token;

    saveRooms();

    callback?.({
      ok: true,
      roomCode,
      playerId,
      token,
      state: publicRoom(roomCode)
    });

    emitRoom(roomCode);
  });

  socket.on("position", ({ x, y } = {}) => {
    if (!socket.roomCode || !socket.playerId) return;

    const room = rooms[socket.roomCode];
    const player = room?.players[socket.playerId];

    if (!player) return;

    player.x = Math.max(
      20,
      Math.min(980, Number(x) || player.x)
    );

    player.y = Math.max(
      20,
      Math.min(580, Number(y) || player.y)
    );

    player.lastSeen = Date.now();

    socket.to(socket.roomCode).emit("position", {
      playerId: socket.playerId,
      x: player.x,
      y: player.y
    });
  });

  socket.on("heart", () => {
    if (!socket.roomCode) return;

    const room = rooms[socket.roomCode];
    if (!room) return;

    room.hearts += 1;
    room.xp += 2;

    saveRooms();

    io.to(socket.roomCode).emit("heart", {
      from: socket.playerId,
      hearts: room.hearts,
      xp: room.xp
    });

    emitRoom(socket.roomCode);
  });

  socket.on("hug", () => {
    if (!socket.roomCode) return;

    const room = rooms[socket.roomCode];
    if (!room) return;

    room.hugs += 1;
    room.hearts += 5;
    room.xp += 5;

    saveRooms();

    io.to(socket.roomCode).emit("hug", {
      from: socket.playerId,
      hugs: room.hugs,
      hearts: room.hearts,
      xp: room.xp
    });

    emitRoom(socket.roomCode);
  });

  socket.on("message", ({ text: messageText } = {}) => {
    if (!socket.roomCode) return;

    const room = rooms[socket.roomCode];
    if (!room) return;

    const text = cleanText(messageText, 300);

    if (!text) return;

    const message = {
      id: crypto.randomUUID(),
      from: socket.playerId,
      text,
      time: Date.now()
    };

    room.messages.push(message);

    if (room.messages.length > 100) {
      room.messages.shift();
    }

    room.xp += 1;

    saveRooms();

    io.to(socket.roomCode).emit("message", message);

    emitRoom(socket.roomCode);
  });

  socket.on("memory", ({ text: memoryText } = {}) => {
    if (!socket.roomCode) return;

    const room = rooms[socket.roomCode];
    if (!room) return;

    const text = cleanText(memoryText, 500);

    if (!text) return;

    const memory = {
      id: crypto.randomUUID(),
      from: socket.playerId,
      text,
      time: Date.now()
    };

    room.memories.push(memory);

    if (room.memories.length > 100) {
      room.memories.shift();
    }

    room.hearts += 10;
    room.xp += 10;

    saveRooms();

    io.to(socket.roomCode).emit("memory", memory);

    emitRoom(socket.roomCode);
  });

  socket.on("openChest", () => {
    if (!socket.roomCode) return;

    const room = rooms[socket.roomCode];

    if (!room || room.chestOpened) {
      return;
    }

    room.chestOpened = true;
    room.hearts += 50;
    room.xp += 50;

    saveRooms();

    io.to(socket.roomCode).emit("chestOpened", {
      hearts: room.hearts,
      xp: room.xp
    });

    emitRoom(socket.roomCode);
  });

  socket.on("achievement", ({ id } = {}) => {
    if (!socket.roomCode || !id) return;

    const room = rooms[socket.roomCode];

    if (!room) return;

    id = cleanText(id, 50);

    if (!room.achievements.includes(id)) {
      room.achievements.push(id);
      room.xp += 20;

      saveRooms();

      io.to(socket.roomCode).emit("achievement", {
        id,
        xp: room.xp
      });

      emitRoom(socket.roomCode);
    }
  });

  socket.on("gameScore", ({ game, score } = {}) => {
    if (!socket.roomCode) return;

    const room = rooms[socket.roomCode];

    if (!room) return;

    game = cleanText(game, 30);

    score = Math.max(
      0,
      Math.min(100000, Math.floor(Number(score) || 0))
    );

    const reward = Math.min(score, 100);

    room.hearts += reward;
    room.xp += reward;

    saveRooms();

    io.to(socket.roomCode).emit("gameScore", {
      from: socket.playerId,
      game,
      score,
      hearts: room.hearts,
      xp: room.xp
    });

    emitRoom(socket.roomCode);
  });

  socket.on("requestState", () => {
    if (!socket.roomCode) return;

    socket.emit(
      "state",
      publicRoom(socket.roomCode)
    );
  });

  socket.on("updateProfile", ({ name } = {}) => {
    if (!socket.roomCode || !socket.playerId) return;

    const room = rooms[socket.roomCode];
    const player = room?.players[socket.playerId];

    if (!player) return;

    player.name = cleanText(name || player.name, 30);

    saveRooms();

    emitRoom(socket.roomCode);
  });

  socket.on("disconnect", () => {
    if (!socket.roomCode || !socket.playerId) {
      return;
    }

    const room = rooms[socket.roomCode];

    if (!room) return;

    const player = room.players[socket.playerId];

    if (player) {
      player.online = false;
      player.lastSeen = Date.now();
      player.socketId = null;
    }

    saveRooms();

    emitRoom(socket.roomCode);
  });
});

setInterval(() => {
  const now = Date.now();
  let changed = false;

  for (const [code, room] of Object.entries(rooms)) {
    const players = Object.values(room.players);

    const online = players.some((p) => p.online);

    if (
      !online &&
      now - room.createdAt > 1000 * 60 * 60 * 24 * 30
    ) {
      delete rooms[code];
      changed = true;
    }
  }

  if (changed) {
    saveRooms();
  }
}, 1000 * 60 * 60);

app.get("*", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

server.listen(PORT, () => {
  console.log(
    `💙 Blue Hearts server çalışıyor: http://localhost:${PORT}`
  );
});
