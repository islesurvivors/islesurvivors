const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.static(__dirname));

const server = app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});

const wss = new WebSocket.Server({ server });

const WORLD_SIZE = 1600;
const PLAYER_RADIUS = 15;
const ATTACK_COOLDOWN = 0.8;
const ATTACK_DAMAGE_MIN = 10;
const ATTACK_DAMAGE_MAX = 20;
const ZONE_SHRINK_TIME = 180;
const ZONE_START_RADIUS = 700;
const ZONE_MIN_RADIUS = 100;
const ZONE_DAMAGE_PER_SECOND = 8;

let players = {};
let zoneCenter = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
let zoneRadius = ZONE_START_RADIUS;
let zoneShrinkStartTime = Date.now();
let lastZoneDamageTime = Date.now();

class Player {
    constructor(id, ws) {
        this.id = id;
        this.ws = ws;
        this.x = Math.random() * (WORLD_SIZE - 200) + 100;
        this.y = Math.random() * (WORLD_SIZE - 200) + 100;
        this.health = 100;
        this.lastAttackTime = 0;
        this.dx = 0;
        this.dy = 0;
        this.speed = 200;
        this.alive = true;
        this.color = this.generateColor(id);
        this.respawnTime = null; // tiempo en ms para respawn
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
            this.respawnTime = Date.now() + 5000; // 5 segundos
            return true; // killed
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
    
    const p1CanAttack = p1.canAttack(now);
    const p2CanAttack = p2.canAttack(now);
    
    if (!p1CanAttack && !p2CanAttack) return null;
    
    let first, second;
    if (p1CanAttack && p2CanAttack) {
        if ((now - p1.lastAttackTime) > (now - p2.lastAttackTime)) {
            first = p1; second = p2;
        } else {
            first = p2; second = p1;
        }
    } else if (p1CanAttack) {
        first = p1; second = null;
    } else {
        first = p2; second = null;
    }
    
    const result = { firstHit: null, secondHit: null };
    
    if (first) {
        const { damage, killed } = first.attack(second || (first === p1 ? p2 : p1), now);
        result.firstHit = { attacker: first.id, target: (first === p1 ? p2.id : p1.id), damage, killed };
    }
    
    if (second && result.firstHit && !result.firstHit.killed) {
        const { damage, killed } = second.attack(first, now);
        result.secondHit = { attacker: second.id, target: first.id, damage, killed };
    }
    
    return result;
}

function updateMovement(deltaTime) {
    for (let id in players) {
        const p = players[id];
        if (!p.alive) continue;
        p.x += p.dx * p.speed * deltaTime;
        p.y += p.dy * p.speed * deltaTime;
        p.x = Math.min(Math.max(p.x, PLAYER_RADIUS), WORLD_SIZE - PLAYER_RADIUS);
        p.y = Math.min(Math.max(p.y, PLAYER_RADIUS), WORLD_SIZE - PLAYER_RADIUS);
    }
}

function handleCollisionsAndCombat(now) {
    const playerIds = Object.keys(players);
    for (let i = 0; i < playerIds.length; i++) {
        const p1 = players[playerIds[i]];
        if (!p1.alive) continue;
        for (let j = i + 1; j < playerIds.length; j++) {
            const p2 = players[playerIds[j]];
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
                p1.x = Math.min(Math.max(newX1, PLAYER_RADIUS), WORLD_SIZE - PLAYER_RADIUS);
                p1.y = Math.min(Math.max(newY1, PLAYER_RADIUS), WORLD_SIZE - PLAYER_RADIUS);
                p2.x = Math.min(Math.max(newX2, PLAYER_RADIUS), WORLD_SIZE - PLAYER_RADIUS);
                p2.y = Math.min(Math.max(newY2, PLAYER_RADIUS), WORLD_SIZE - PLAYER_RADIUS);
                
                const combatResult = resolveCombat(p1, p2, now);
                if (combatResult && (combatResult.firstHit || combatResult.secondHit)) {
                    if (combatResult.firstHit) sendDamageEvent(combatResult.firstHit);
                    if (combatResult.secondHit) sendDamageEvent(combatResult.secondHit);
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
    const shrinkProgress = Math.min(1, elapsed / ZONE_SHRINK_TIME);
    zoneRadius = ZONE_START_RADIUS - (ZONE_START_RADIUS - ZONE_MIN_RADIUS) * shrinkProgress;
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
        const distToCenter = Math.hypot(dx, dy);
        if (distToCenter > zoneRadius) {
            const killed = p.takeDamage(ZONE_DAMAGE_PER_SECOND);
            if (killed) broadcastDeath(p.id);
        }
    }
}

function broadcastDeath(playerId) {
    for (let id in players) {
        const p = players[id];
        if (p.ws && p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(JSON.stringify({ type: 'death', playerId: playerId }));
        }
    }
}

// Nueva función: procesa los respawns de jugadores muertos
function processRespawns() {
    const now = Date.now();
    for (let id in players) {
        const p = players[id];
        if (!p.alive && p.respawnTime && p.respawnTime <= now) {
            // Revivir jugador
            p.alive = true;
            p.health = 100;
            p.lastAttackTime = 0;
            p.dx = 0;
            p.dy = 0;
            
            // Generar posición aleatoria dentro de la zona segura actual
            let safeRadius = Math.min(zoneRadius, WORLD_SIZE / 2);
            let angle = Math.random() * 2 * Math.PI;
            let radius = Math.random() * safeRadius;
            let x = zoneCenter.x + Math.cos(angle) * radius;
            let y = zoneCenter.y + Math.sin(angle) * radius;
            x = Math.min(Math.max(x, PLAYER_RADIUS), WORLD_SIZE - PLAYER_RADIUS);
            y = Math.min(Math.max(y, PLAYER_RADIUS), WORLD_SIZE - PLAYER_RADIUS);
            p.x = x;
            p.y = y;
            p.respawnTime = null;
            
            // Opcional: enviar evento de respawn al cliente
            // El broadcastGameState ya lo reflejará
        }
    }
}

// Limpia jugadores con conexión cerrada
function removeDeadPlayers() {
    for (let id in players) {
        const p = players[id];
        if (p.ws.readyState !== WebSocket.OPEN) {
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
    const message = JSON.stringify(state);
    for (let id in players) {
        const p = players[id];
        if (p.ws && p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(message);
        }
    }
}

let lastTimestamp = Date.now() / 1000;
setInterval(() => {
    const now = Date.now() / 1000;
    const deltaTime = Math.min(0.033, now - lastTimestamp);
    lastTimestamp = now;
    updateMovement(deltaTime);
    handleCollisionsAndCombat(now);
    updateZone(now);
    applyZoneDamage(now);
    processRespawns();      // Revisar respawns después de posibles muertes
    removeDeadPlayers();    // Eliminar solo desconectados
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
