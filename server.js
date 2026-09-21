const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const ROOMS_FILE = path.join(DATA_DIR, "rooms.json");

/* =========================
   DATA KLASÖRÜ
========================= */

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, {
    recursive: true
  });
}

if (!fs.existsSync(ROOMS_FILE)) {
  fs.writeFileSync(
    ROOMS_FILE,
    JSON.stringify({}, null, 2),
    "utf8"
  );
}

let rooms = {};

try {
  const data = fs.readFileSync(
    ROOMS_FILE,
    "utf8"
  );

  rooms = data ? JSON.parse(data) : {};
} catch (error) {
  console.error(
    "rooms.json okunamadı:",
    error
  );

  rooms = {};
}

/* =========================
   YARDIMCI FONKSİYONLAR
========================= */

function saveRooms() {
  try {
    fs.writeFileSync(
      ROOMS_FILE,
      JSON.stringify(rooms, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error(
      "Odalar kaydedilemedi:",
      error
    );
  }
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
    code = String(
      Math.floor(
        100000 + Math.random() * 900000
      )
    );
  } while (rooms[code]);

  return code;
}

function createPlayerToken() {
  return crypto.randomBytes(18).toString("hex");
}

function publicRoom(roomCode) {
  const room = rooms[roomCode];

  if (!room) {
    return null;
  }

  return {
    code: roomCode,
    createdAt: room.createdAt,

    hearts: room.hearts || 0,
    xp: room.xp || 0,
    hugs: room.hugs || 0,

    chestOpened: !!room.chestOpened,

    memories: room.memories || [],
    messages: room.messages || [],
    achievements: room.achievements || [],

    players: Object.values(
      room.players || {}
    ).map((player) => ({
      id: player.id,
      name: player.name,
      x: player.x,
      y: player.y,
      online: !!player.online
    }))
  };
}

function emitRoom(roomCode) {
  const state = publicRoom(roomCode);

  if (!state) {
    return;
  }

  io.to(roomCode).emit(
    "state",
    state
  );
}

/* =========================
   EXPRESS
========================= */

app.use(
  express.json({
    limit: "1mb"
  })
);

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

/* =========================
   ODA BİLGİSİ
========================= */

app.get(
  "/api/room/:code",
  (req, res) => {
    const code = cleanText(
      req.params.code,
      6
    );

    const room = rooms[code];

    if (!room) {
      return res.status(404).json({
        ok: false,
        error: "Oda bulunamadı."
      });
    }

    return res.json({
      ok: true,
      room: publicRoom(code)
    });
  }
);

/* =========================
   SOCKET.IO
========================= */

io.on("connection", (socket) => {

  console.log(
    "🔵 Oyuncu bağlandı:",
    socket.id
  );

  /* =========================
     ODA OLUŞTUR
  ========================= */

  socket.on(
    "createRoom",
    (data = {}, callback) => {

      try {

        const name = cleanText(
          data.name || "Oyuncu 1",
          30
        );

        const roomCode =
          randomRoomCode();

        const playerId =
          crypto.randomUUID();

        const playerToken =
          createPlayerToken();

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

        rooms[roomCode].players[
          playerId
        ] = {
          id: playerId,
          token: playerToken,
          socketId: socket.id,

          name,

          x: 250,
          y: 250,

          online: true,
          lastSeen: Date.now()
        };

        socket.join(roomCode);

        socket.roomCode =
          roomCode;

        socket.playerId =
          playerId;

        socket.playerToken =
          playerToken;

        saveRooms();

        const state =
          publicRoom(roomCode);

        callback?.({
          ok: true,

          roomCode,
          playerId,
          token: playerToken,

          state
        });

        emitRoom(roomCode);

        console.log(
          "💙 Oda oluşturuldu:",
          roomCode
        );

      } catch (error) {

        console.error(
          "createRoom hatası:",
          error
        );

        callback?.({
          ok: false,
          error:
            "Oda oluşturulurken sunucu hatası oluştu."
        });
      }
    }
  );

  /* =========================
     ODAYA KATIL
  ========================= */

  socket.on(
    "joinRoom",
    (data = {}, callback) => {

      try {

        const roomCode =
          cleanText(
            data.roomCode,
            6
          );

        const name =
          cleanText(
            data.name ||
              "Oyuncu 2",
            30
          );

        const token =
          cleanText(
            data.token || "",
            100
          );

        const room =
          rooms[roomCode];

        if (!room) {
          return callback?.({
            ok: false,
            error:
              "Bu oda bulunamadı."
          });
        }

        let playerId = null;

        /* Eski oyuncuyu bul */
        if (token) {

          for (
            const id of Object.keys(
              room.players
            )
          ) {

            if (
              room.players[id]
                .token === token
            ) {

              playerId = id;

              break;
            }
          }
        }

        /* Yeni oyuncu */
        if (!playerId) {

          const onlinePlayers =
            Object.values(
              room.players
            ).filter(
              (player) =>
                player.online
            );

          if (
            onlinePlayers.length >= 2
          ) {

            return callback?.({
              ok: false,
              error:
                "Oda dolu. En fazla 2 kişi olabilir."
            });
          }

          playerId =
            crypto.randomUUID();

          room.players[
            playerId
          ] = {

            id: playerId,

            token:
              createPlayerToken(),

            socketId:
              socket.id,

            name,

            x: 350,
            y: 250,

            online: true,
            lastSeen:
              Date.now()
          };

        } else {

          /* Eski oyuncu yeniden bağlandı */

          room.players[
            playerId
          ].socketId =
            socket.id;

          room.players[
            playerId
          ].online = true;

          room.players[
            playerId
          ].lastSeen =
            Date.now();

          if (name) {

            room.players[
              playerId
            ].name = name;
          }
        }

        socket.join(roomCode);

        socket.roomCode =
          roomCode;

        socket.playerId =
          playerId;

        socket.playerToken =
          room.players[
            playerId
          ].token;

        saveRooms();

        callback?.({
          ok: true,

          roomCode,

          playerId,

          token:
            socket.playerToken,

          state:
            publicRoom(
              roomCode
            )
        });

        emitRoom(roomCode);

        console.log(
          "👤 Oyuncu odaya girdi:",
          roomCode
        );

      } catch (error) {

        console.error(
          "joinRoom hatası:",
          error
        );

        callback?.({
          ok: false,
          error:
            "Odaya katılırken sunucu hatası oluştu."
        });
      }
    }
  );

  /* =========================
     YENİDEN BAĞLAN
  ========================= */

  socket.on(
    "rejoinRoom",
    (data = {}, callback) => {

      const roomCode =
        cleanText(
          data.roomCode,
          6
        );

      const token =
        cleanText(
          data.token,
          100
        );

      if (!roomCode || !token) {

        return callback?.({
          ok: false,
          error:
            "Odaya yeniden bağlanılamadı."
        });
      }

      const room =
        rooms[roomCode];

      if (!room) {

        return callback?.({
          ok: false,
          error:
            "Oda bulunamadı."
        });
      }

      let playerId = null;

      for (
        const id of Object.keys(
          room.players
        )
      ) {

        if (
          room.players[id].token ===
          token
        ) {

          playerId = id;

          break;
        }
      }

      if (!playerId) {

        return callback?.({
          ok: false,
          error:
            "Oyuncu oturumu bulunamadı."
        });
      }

      const player =
        room.players[
          playerId
        ];

      player.socketId =
        socket.id;

      player.online = true;
      player.lastSeen =
        Date.now();

      socket.join(roomCode);

      socket.roomCode =
        roomCode;

      socket.playerId =
        playerId;

      socket.playerToken =
        token;

      saveRooms();

      callback?.({
        ok: true,

        roomCode,

        playerId,

        token,

        state:
          publicRoom(
            roomCode
          )
      });

      emitRoom(roomCode);
    }
  );

  /* =========================
     HAREKET
  ========================= */

  socket.on(
    "position",
    (data = {}) => {

      if (
        !socket.roomCode ||
        !socket.playerId
      ) {
        return;
      }

      const room =
        rooms[
          socket.roomCode
        ];

      if (!room) {
        return;
      }

      const player =
        room.players[
          socket.playerId
        ];

      if (!player) {
        return;
      }

      const x =
        Number(data.x);

      const y =
        Number(data.y);

      if (Number.isFinite(x)) {

        player.x =
          Math.max(
            20,
            Math.min(
              980,
              x
            )
          );
      }

      if (Number.isFinite(y)) {

        player.y =
          Math.max(
            20,
            Math.min(
              580,
              y
            )
          );
      }

      player.lastSeen =
        Date.now();

      socket
        .to(socket.roomCode)
        .emit(
          "position",
          {
            playerId:
              socket.playerId,

            x: player.x,
            y: player.y
          }
        );
    }
  );

  /* =========================
     KALP
  ========================= */

  socket.on(
    "heart",
    () => {

      if (!socket.roomCode) {
        return;
      }

      const room =
        rooms[
          socket.roomCode
        ];

      if (!room) {
        return;
      }

      room.hearts =
        (room.hearts || 0) + 1;

      room.xp =
        (room.xp || 0) + 2;

      saveRooms();

      io.to(
        socket.roomCode
      ).emit(
        "heart",
        {
          from:
            socket.playerId,

          hearts:
            room.hearts,

          xp:
            room.xp
        }
      );

      emitRoom(
        socket.roomCode
      );
    }
  );

  /* =========================
     SARILMA
  ========================= */

  socket.on(
    "hug",
    () => {

      if (!socket.roomCode) {
        return;
      }

      const room =
        rooms[
          socket.roomCode
        ];

      if (!room) {
        return;
      }

      room.hugs =
        (room.hugs || 0) + 1;

      room.hearts =
        (room.hearts || 0) + 5;

      room.xp =
        (room.xp || 0) + 5;

      saveRooms();

      io.to(
        socket.roomCode
      ).emit(
        "hug",
        {
          from:
            socket.playerId,

          hugs:
            room.hugs,

          hearts:
            room.hearts,

          xp:
            room.xp
        }
      );

      emitRoom(
        socket.roomCode
      );
    }
  );

  /* =========================
     MESAJ
  ========================= */

  socket.on(
    "message",
    (data = {}) => {

      if (!socket.roomCode) {
        return;
      }

      const room =
        rooms[
          socket.roomCode
        ];

      if (!room) {
        return;
      }

      const messageText =
        cleanText(
          data.text,
          300
        );

      if (!messageText) {
        return;
      }

      const message = {
        id:
          crypto.randomUUID(),

        from:
          socket.playerId,

        text:
          messageText,

        time:
          Date.now()
      };

      room.messages.push(
        message
      );

      if (
        room.messages.length >
        100
      ) {
        room.messages.shift();
      }

      room.xp =
        (room.xp || 0) + 1;

      saveRooms();

      io.to(
        socket.roomCode
      ).emit(
        "message",
        message
      );

      emitRoom(
        socket.roomCode
      );
    }
  );

  /* =========================
     ANILAR
  ========================= */

  socket.on(
    "memory",
    (data = {}) => {

      if (!socket.roomCode) {
        return;
      }

      const room =
        rooms[
          socket.roomCode
        ];

      if (!room) {
        return;
      }

      const text =
        cleanText(
          data.text,
          500
        );

      if (!text) {
        return;
      }

      const memory = {
        id:
          crypto.randomUUID(),

        from:
          socket.playerId,

        text,

        time:
          Date.now()
      };

      room.memories.push(
        memory
      );

      if (
        room.memories.length >
        100
      ) {
        room.memories.shift();
      }

      room.hearts =
        (room.hearts || 0) + 10;

      room.xp =
        (room.xp || 0) + 10;

      saveRooms();

      io.to(
        socket.roomCode
      ).emit(
        "memory",
        memory
      );

      emitRoom(
        socket.roomCode
      );
    }
  );

  /* =========================
     KALP SANDIĞI
  ========================= */

  socket.on(
    "openChest",
    () => {

      if (!socket.roomCode) {
        return;
      }

      const room =
        rooms[
          socket.roomCode
        ];

      if (!room) {
        return;
      }

      if (room.chestOpened) {
        return;
      }

      room.chestOpened =
        true;

      room.hearts =
        (room.hearts || 0) + 50;

      room.xp =
        (room.xp || 0) + 50;

      saveRooms();

      io.to(
        socket.roomCode
      ).emit(
        "chestOpened",
        {
          hearts:
            room.hearts,

          xp:
            room.xp
        }
      );

      emitRoom(
        socket.roomCode
      );
    }
  );

  /* =========================
     BAŞARIM
  ========================= */

  socket.on(
    "achievement",
    (data = {}) => {

      if (
        !socket.roomCode ||
        !data.id
      ) {
        return;
      }

      const room =
        rooms[
          socket.roomCode
        ];

      if (!room) {
        return;
      }

      const id =
        cleanText(
          data.id,
          50
        );

      if (!id) {
        return;
      }

      if (
        !room.achievements.includes(
          id
        )
      ) {

        room.achievements.push(
          id
        );

        room.xp =
          (room.xp || 0) + 20;

        saveRooms();

        io.to(
          socket.roomCode
        ).emit(
          "achievement",
          {
            id,
            xp:
              room.xp
          }
        );

        emitRoom(
          socket.roomCode
        );
      }
    }
  );

  /* =========================
     MİNİ OYUN SKORU
  ========================= */

  socket.on(
    "gameScore",
    (data = {}) => {

      if (!socket.roomCode) {
        return;
      }

      const room =
        rooms[
          socket.roomCode
        ];

      if (!room) {
        return;
      }

      const game =
        cleanText(
          data.game,
          30
        );

      let score =
        Math.floor(
          Number(data.score)
        );

      if (
        !Number.isFinite(score)
      ) {
        score = 0;
      }

      score =
        Math.max(
          0,
          Math.min(
            100000,
            score
          )
        );

      const reward =
        Math.min(
          score,
          100
        );

      room.hearts =
        (room.hearts || 0) +
        reward;

      room.xp =
        (room.xp || 0) +
        reward;

      saveRooms();

      io.to(
        socket.roomCode
      ).emit(
        "gameScore",
        {
          from:
            socket.playerId,

          game,

          score,

          hearts:
            room.hearts,

          xp:
            room.xp
        }
      );

      emitRoom(
        socket.roomCode
      );
    }
  );

  /* =========================
     DURUM İSTE
  ========================= */

  socket.on(
    "requestState",
    () => {

      if (!socket.roomCode) {
        return;
      }

      const state =
        publicRoom(
          socket.roomCode
        );

      if (state) {
        socket.emit(
          "state",
          state
        );
      }
    }
  );

  /* =========================
     PROFİL GÜNCELLE
  ========================= */

  socket.on(
    "updateProfile",
    (data = {}) => {

      if (
        !socket.roomCode ||
        !socket.playerId
      ) {
        return;
      }

      const room =
        rooms[
          socket.roomCode
        ];

      if (!room) {
        return;
      }

      const player =
        room.players[
          socket.playerId
        ];

      if (!player) {
        return;
      }

      const name =
        cleanText(
          data.name,
          30
        );

      if (name) {
        player.name =
          name;
      }

      saveRooms();

      emitRoom(
        socket.roomCode
      );
    }
  );

  /* =========================
     BAĞLANTI KESİLDİ
  ========================= */

  socket.on(
    "disconnect",
    () => {

      console.log(
        "🔴 Oyuncu ayrıldı:",
        socket.id
      );

      if (
        !socket.roomCode ||
        !socket.playerId
      ) {
        return;
      }

      const room =
        rooms[
          socket.roomCode
        ];

      if (!room) {
        return;
      }

      const player =
        room.players[
          socket.playerId
        ];

      if (!player) {
        return;
      }

      player.online =
        false;

      player.lastSeen =
        Date.now();

      player.socketId =
        null;

      saveRooms();

      emitRoom(
        socket.roomCode
      );
    }
  );
});

/* =========================
   ESKİ ODALARI TEMİZLE
========================= */

setInterval(
  () => {

    const now =
      Date.now();

    let changed =
      false;

    for (
      const [code, room]
      of Object.entries(rooms)
    ) {

      const players =
        Object.values(
          room.players || {}
        );

      const online =
        players.some(
          (player) =>
            player.online
        );

      if (
        !online &&
        now -
          room.createdAt >
          1000 *
          60 *
          60 *
          24 *
          30
      ) {

        delete rooms[code];

        changed =
          true;
      }
    }

    if (changed) {
      saveRooms();
    }

  },
  1000 *
  60 *
  60
);

/* ==========
