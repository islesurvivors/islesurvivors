const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.static(__dirname));

const server = app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor corriendo en puerto", server.address().port);
});

const wss = new WebSocket.Server({ server });

const WORLD_SIZE = 4000;
const PLAYER_RADIUS = 8;
const ATTACK_COOLDOWN = 0.8;
const ATTACK_DAMAGE_MIN = 10;
const ATTACK_DAMAGE_MAX = 20;
const ZONE_SHRINK_TIME = 180;
const ZONE_START_RADIUS = 1800;   // Ajustado para la isla grande
const ZONE_MIN_RADIUS = 100;
const ZONE_DAMAGE_PER_SECOND = 8;

let players = {};
let zoneCenter = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
let zoneRadius = ZONE_START_RADIUS;
let zoneShrinkStartTime = Date.now();
let lastZoneDamageTime = Date.now();

// ---------- Definición de la isla (misma que en el cliente) ----------
const CENTER = WORLD_SIZE / 2;

function isWalkable(x, y) {
  let dx = x - CENTER;
  let dy = y - CENTER;
  let dist = Math.hypot(dx, dy);
  let baseRadius = 1800;
  
  // Penínsulas
  let peninsulas = [
    { cx: CENTER + 600, cy: CENTER - 400, r: 400 },
    { cx: CENTER - 500, cy: CENTER + 300, r: 350 },
    { cx: CENTER + 200, cy: CENTER + 700, r: 300 },
    { cx: CENTER - 700, cy: CENTER - 200, r: 300 }
  ];
  for (let p of peninsulas) {
    if (Math.hypot(x - p.cx, y - p.cy) < p.r) return true;
  }
  
  let angle = Math.atan2(dy, dx);
  let ripple = Math.sin(angle * 5) * 50;
  if (dist < baseRadius + ripple) return true;
  
  return false;
}
// ----------------------------------------------------------------

class Player {
    constructor(id, ws) {
        this.id = id;
        this.ws = ws;
        // Posición inicial dentro de la isla
        let placed = false;
        let tries = 0;
        while (!placed && tries < 100) {
            let x = Math.random() * (WORLD_SIZE - 200) + 100;
            let y = Math.random() * (WORLD_SIZE - 200) + 100;
            if (isWalkable(x, y)) {
                this.x = x;
                this.y = y;
                placed = true;
            }
            tries++;
        }
        if (!placed) {
            this.x = CENTER;
            this.y = CENTER;
        }
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
        // Restringir movimiento a la isla
        if (isWalkable(newX, newY)) {
            p.x = newX;
            p.y = newY;
        }
        // Asegurar que nunca quede fuera por redondeo
        if (!isWalkable(p.x, p.y)) {
            // Si por algún motivo está fuera, lo colocamos en el punto más cercano dentro
            // (búsqueda simple: reducimos hacia el centro hasta encontrar punto válido)
            let fallbackX = p.x, fallbackY = p.y;
            for (let step = 0; step < 20; step++) {
                fallbackX = (fallbackX + CENTER) / 2;
                fallbackY = (fallbackY + CENTER) / 2;
                if (isWalkable(fallbackX, fallbackY)) {
                    p.x = fallbackX;
                    p.y = fallbackY;
                    break;
                }
            }
        }
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
                // Validar que las nuevas posiciones estén dentro de la isla
                if (isWalkable(newX1, newY1)) {
                    p1.x = newX1;
                    p1.y = newY1;
                }
                if (isWalkable(newX2, newY2)) {
                    p2.x = newX2;
                    p2.y = newY2;
                }
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
            // Buscar posición dentro de la zona actual y dentro de la isla
            let placed = false;
            let tries = 0;
            while (!placed && tries < 100) {
                const angle = Math.random() * 2 * Math.PI;
                const radius = Math.random() * Math.min(zoneRadius, 1800);
                let x = zoneCenter.x + Math.cos(angle) * radius;
                let y = zoneCenter.y + Math.sin(angle) * radius;
                x = Math.min(Math.max(x, PLAYER_RADIUS), WORLD_SIZE - PLAYER_RADIUS);
                y = Math.min(Math.max(y, PLAYER_RADIUS), WORLD_SIZE - PLAYER_RADIUS);
                if (isWalkable(x, y)) {
                    p.x = x;
                    p.y = y;
                    placed = true;
                }
                tries++;
            }
            if (!placed) {
                p.x = CENTER;
                p.y = CENTER;
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
