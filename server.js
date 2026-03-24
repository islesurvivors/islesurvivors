const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.static(__dirname));

const server = app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});

const wss = new WebSocket.Server({ server });

let players = {};

wss.on("connection", (ws) => {
  const id = Math.random().toString(36).substr(2, 9);

  players[id] = {
    x: 200,
    y: 200,
    dx: 0,
    dy: 0
  };

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.type === "move") {
      players[id].dx = data.dx;
      players[id].dy = data.dy;
    }
  });

  ws.on("close", () => {
    delete players[id];
  });
});

// GAME LOOP
setInterval(() => {
  for (let id in players) {
    let p = players[id];
    p.x += p.dx * 3;
    p.y += p.dy * 3;
  }

  const state = JSON.stringify(players);

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(state);
    }
  });

}, 1000 / 20);