const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.static(__dirname));

const server = app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor corriendo en puerto", server.address().port);
});

const wss = new WebSocket.Server({ server });

const WORLD_SIZE = 1600;
const WORLD_CENTER = WORLD_SIZE / 2;
const ISLAND_BASE_RADIUS = 720;
const PLAYER_RADIUS = 8;
const ATTACK_COOLDOWN = 0.8;
const ATTACK_DAMAGE_MIN = 10;
const ATTACK_DAMAGE_MAX = 20;
const ZONE_SHRINK_TIME = 180;
const ZONE_START_RADIUS = 700;
const ZONE_MIN_RADIUS = 100;
const ZONE_DAMAGE_PER_SECOND = 8;

let players = {};
let zoneCenter = { x: WORLD_CENTER, y: WORLD_CENTER };
let zoneRadius = ZONE_START_RADIUS;
let zoneShrinkStartTime = Date.now();
let lastZoneDamageTime = Date.now();

// ==================== MÁSCARA DE ISLA (ARENA vs AGUA) ====================
let LAND_MASK = null;

function generateIslandMask() {
  const mask = new Array(WORLD_SIZE);
  for (let i = 0; i < WORLD_SIZE; i++) {
    mask[i] = new Array(WORLD_SIZE);
    for (let j = 0; j < WORLD_SIZE; j++) {
      const dx = i - WORLD_CENTER;
      const dy = j - WORLD_CENTER;
      const dist = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      // Perturbaciones para forma orgánica de continente
      const variation = Math.sin(angle * 5) * 45 + Math.cos(angle * 3) * 35 + Math.sin(angle * 7) * 25;
      const radiusAtAngle = ISLAND_BASE_RADIUS + variation;
      let isLand = dist < radiusAtAngle;
      // Bordes exteriores siempre agua
      if (i < 60 || i > WORLD_SIZE - 60 || j < 60 || j > WORLD_SIZE - 60) isLand = false;
      mask[i][j] = isLand;
    }
  }
  // Pequeños lagos internos (opcional)
  for (let i = 0; i < 300; i++) {
    const x = Math.floor(Math.random() * WORLD_SIZE);
    const y = Math.floor(Math.random() * WORLD_SIZE);
    if (mask[x] && mask[x][y] === true && Math.random() < 0.15) {
      for (let dx = -6; dx <= 6; dx++) {
        for (let dy = -6; dy <= 6; dy++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < WORLD_SIZE && ny >= 0 && ny < WORLD_SIZE && Math.hypot(dx, dy) < 5) {
            mask[nx][ny] = false;
          }
        }
      }
    }
  }
  return mask;
}

function isLand(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || ix >= WORLD_SIZE || iy < 0 || iy >= WORLD_SIZE) return false;
  return LAND_MASK[ix][iy] === true;
}

function clampToLand(player) {
  if (isLand(player.x, player.y)) return;
  // Buscar la celda de tierra más cercana (búsqueda espiral)
  for (let radius = 1; radius <= 80; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const nx = player.x + dx;
        const ny = player.y + dy;
        if (isLand(nx, ny)) {
          player.x = nx;
          player.y = ny;
          return;
        }
      }
    }
  }
  // Fallback: centro del mundo (que es tierra)
  player.x = WORLD_CENTER;
  player.y = WORLD_CENTER;
}

function getRandomLandPosition() {
  let attempts = 0;
  while (attempts < 500) {
    const x = Math.random() * (WORLD_SIZE - 200) + 100;
    const y = Math.random() * (WORLD_SIZE - 200) + 100;
    if (isLand(x, y)) return { x, y };
    attempts++;
  }
  // fallback centro
  return { x: WORLD_CENTER, y: WORLD_CENTER };
}

// Inicializar máscara
LAND_MASK = generateIslandMask();

// ==================== FIN SISTEMA DE TERRENO ====================

class Player {
    constructor(id, ws) {
        this.id = id;
        this.ws = ws;
        const spawn = getRandomLandPosition();
        this.x = spawn.x;
        this.y = spawn.y;
        this.health = 100;
        this.lastAttackTime = 0;
        this.dx = 0;
        this.dy = 0;
        this.speed = 200;
        this.alive = true;
        this.color = this.generateColor(id);
        this.respawnTime = null;
    }

    generateColor(id) {
        let hash = 0;
        for (let i = 0; i < id.length; i++) {
            hash = ((hash << 5) - hash) + id.charCodeAt(i);
            hash |= 0;
        }
        const hue = Math.abs(hash % 360);
        return `hsl(${hue}, 70%, 55%)`;
    }

    takeDamage(amount) {
        if (!this.alive) return false;
        this.health = Math.max(0, this.health - amount);
        if (this.health <= 0) {
            this.alive = false;
            this.respawnTime = Date.now() + 5000;
            return true;
        }
        return false;
    }

    canAttack(now) {
        return this.alive && (now - this.lastAttackTime >= ATTACK_COOLDOWN);
    }

    attack(target, now) {
        if (!this.canAttack(now)) return false;
        const damage = Math.floor(Math.random() * (ATTACK_DAMAGE_MAX - ATTACK_DAMAGE_MIN + 1) + ATTACK_DAMAGE_MIN);
        const killed = target.takeDamage(damage);
        this.lastAttackTime = now;
        return { damage, killed };
    }
}

function resolveCombat(p1, p2, now) {
    if (!p1.alive || !p2.alive) return null;
    
    const p1Can = p1.canAttack(now);
    const p2Can = p2.canAttack(now);
    if (!p1Can && !p2Can) return null;
    
    let first, second;
    if (p1Can && p2Can) {
        if ((now - p1.lastAttackTime) > (now - p2.lastAttackTime)) {
            first = p1; second = p2;
        } else {
            first = p2; second = p1;
        }
    } else if (p1Can) {
        first = p1; second = p2;
    } else {
        first = p2; second = p1;
    }
    
    const result = { firstHit: null, secondHit: null };
    const { damage, killed } = first.attack(second, now);
    result.firstHit = { attacker: first.id, target: second.id, damage, killed };
    
    if (second && second.alive && second.canAttack(now) && !killed) {
        const { damage: d2, killed: k2 } = second.attack(first, now);
        result.secondHit = { attacker: second.id, target: first.id, damage: d2, killed: k2 };
    }
    return result;
}

function updateMovement(deltaTime) {
    for (let id in players) {
        const p = players[id];
        if (!p.alive) continue;
        let newX = p.x + p.dx * p.speed * deltaTime;
        let newY = p.y + p.dy * p.speed * deltaTime;
        // Validar que el nuevo punto esté sobre arena (isla)
        if (isLand(newX, newY)) {
            p.x = newX;
            p.y = newY;
        } else {
            // Si el movimiento lo lleva al agua, no se mueve y se frena
            p.dx = 0;
            p.dy = 0;
        }
        // Clamp adicional por seguridad
        clampToLand(p);
    }
}

function handleCollisionsAndCombat(now) {
    const ids = Object.keys(players);
    for (let i = 0; i < ids.length; i++) {
        const p1 = players[ids[i]];
        if (!p1.alive) continue;
        for (let j = i + 1; j < ids.length; j++) {
            const p2 = players[ids[j]];
            if (!p2.alive) continue;
            const dx = p1.x - p2.x;
            const dy = p1.y - p2.y;
            const dist = Math.hypot(dx, dy);
            const minDist = PLAYER_RADIUS * 2;
            if (dist < minDist) {
                const angle = Math.atan2(dy, dx);
                const overlap = minDist - dist;
                const moveX = Math.cos(angle) * overlap / 2;
                const moveY = Math.sin(angle) * overlap / 2;
                let newX1 = p1.x + moveX;
                let newY1 = p1.y + moveY;
                let newX2 = p2.x - moveX;
                let newY2 = p2.y - moveY;
                // Solo aplicar si no se salen de la isla (si se salen, se clampa después)
                p1.x = newX1;
                p1.y = newY1;
                p2.x = newX2;
                p2.y = newY2;
                clampToLand(p1);
                clampToLand(p2);
                
                const combat = resolveCombat(p1, p2, now);
                if (combat) {
                    if (combat.firstHit) sendDamageEvent(combat.firstHit);
                    if (combat.secondHit) sendDamageEvent(combat.secondHit);
                }
            }
        }
    }
}

function sendDamageEvent(hit) {
    const attacker = players[hit.attacker];
    const target = players[hit.target];
    if (attacker && attacker.ws && attacker.ws.readyState === WebSocket.OPEN) {
        attacker.ws.send(JSON.stringify({
            type: 'damage',
            damage: hit.damage,
            target: hit.target,
            killed: hit.killed
        }));
    }
    if (target && target.ws && target.ws.readyState === WebSocket.OPEN) {
        target.ws.send(JSON.stringify({
            type: 'damage',
            damage: hit.damage,
            from: hit.attacker,
            killed: hit.killed
        }));
    }
}

function updateZone(now) {
    const elapsed = (now - zoneShrinkStartTime) / 1000;
    const progress = Math.min(1, elapsed / ZONE_SHRINK_TIME);
    zoneRadius = ZONE_START_RADIUS - (ZONE_START_RADIUS - ZONE_MIN_RADIUS) * progress;
    zoneRadius = Math.max(ZONE_MIN_RADIUS, zoneRadius);
}

function applyZoneDamage(now) {
    if (now - lastZoneDamageTime < 1) return;
    lastZoneDamageTime = now;
    for (let id in players) {
        const p = players[id];
        if (!p.alive) continue;
        const dx = p.x - zoneCenter.x;
        const dy = p.y - zoneCenter.y;
        const dist = Math.hypot(dx, dy);
        if (dist > zoneRadius) {
            p.takeDamage(ZONE_DAMAGE_PER_SECOND);
        }
    }
}

function processRespawns() {
    const now = Date.now();
    for (let id in players) {
        const p = players[id];
        if (!p.alive && p.respawnTime && p.respawnTime <= now) {
            p.alive = true;
            p.health = 100;
            p.lastAttackTime = 0;
            p.dx = 0;
            p.dy = 0;
            // Respawnea en un punto aleatorio de arena dentro de la zona segura actual
            let attempts = 0;
            let placed = false;
            while (attempts < 100 && !placed) {
                const safeRadius = Math.min(zoneRadius, WORLD_SIZE / 2);
                const angle = Math.random() * 2 * Math.PI;
                const radius = Math.random() * safeRadius;
                let x = zoneCenter.x + Math.cos(angle) * radius;
                let y = zoneCenter.y + Math.sin(angle) * radius;
                x = Math.min(Math.max(x, PLAYER_RADIUS), WORLD_SIZE - PLAYER_RADIUS);
                y = Math.min(Math.max(y, PLAYER_RADIUS), WORLD_SIZE - PLAYER_RADIUS);
                if (isLand(x, y)) {
                    p.x = x;
                    p.y = y;
                    placed = true;
                }
                attempts++;
            }
            if (!placed) {
                const fallback = getRandomLandPosition();
                p.x = fallback.x;
                p.y = fallback.y;
            }
            p.respawnTime = null;
        }
    }
}

function removeDeadPlayers() {
    for (let id in players) {
        if (players[id].ws.readyState !== WebSocket.OPEN) {
            delete players[id];
        }
    }
}

function broadcastGameState() {
    const state = {
        type: 'state',
        players: {},
        zone: { x: zoneCenter.x, y: zoneCenter.y, radius: zoneRadius },
        aliveCount: Object.values(players).filter(p => p.alive).length,
        timestamp: Date.now()
    };
    for (let id in players) {
        const p = players[id];
        state.players[id] = {
            id: p.id,
            x: p.x,
            y: p.y,
            health: p.health,
            alive: p.alive,
            lastAttackTime: p.lastAttackTime,
            color: p.color
        };
    }
    const msg = JSON.stringify(state);
    for (let id in players) {
        const p = players[id];
        if (p.ws && p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(msg);
        }
    }
}

let lastTimestamp = Date.now() / 1000;
setInterval(() => {
    const now = Date.now() / 1000;
    const delta = Math.min(0.033, now - lastTimestamp);
    lastTimestamp = now;
    updateMovement(delta);
    handleCollisionsAndCombat(now);
    updateZone(now);
    applyZoneDamage(now);
    processRespawns();
    removeDeadPlayers();
    broadcastGameState();
}, 1000 / 20);

wss.on("connection", (ws) => {
    const id = Math.random().toString(36).substr(2, 9);
    const player = new Player(id, ws);
    players[id] = player;
    ws.send(JSON.stringify({ type: 'init', id: id }));
    ws.on("message", (msg) => {
        const data = JSON.parse(msg);
        if (data.type === "move") {
            const p = players[id];
            if (p && p.alive) {
                p.dx = data.dx;
                p.dy = data.dy;
            }
        }
    });
    ws.on("close", () => {
        delete players[id];
    });
});
