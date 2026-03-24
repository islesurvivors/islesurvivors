const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configuración del mundo
const WORLD_SIZE = 1600;
const PLAYER_RADIUS = 15;
const ATTACK_COOLDOWN = 0.8; // segundos
const ATTACK_DAMAGE_MIN = 10;
const ATTACK_DAMAGE_MAX = 20;
const ZONE_SHRINK_TIME = 180; // 3 minutos para encogerse completamente
const ZONE_START_RADIUS = 700;
const ZONE_MIN_RADIUS = 100;
const ZONE_DAMAGE_PER_SECOND = 8;

let players = {};
let nextPlayerId = 1;
let gameLoopInterval;
let lastTimestamp = Date.now();
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
    }

    takeDamage(amount) {
        this.health = Math.max(0, this.health - amount);
        if (this.health <= 0) {
            this.alive = false;
        }
        return this.health <= 0;
    }

    canAttack(now) {
        return now - this.lastAttackTime >= ATTACK_COOLDOWN;
    }

    attack(target, now) {
        if (!this.canAttack(now)) return false;
        const damage = Math.floor(Math.random() * (ATTACK_DAMAGE_MAX - ATTACK_DAMAGE_MIN + 1) + ATTACK_DAMAGE_MIN);
        const killed = target.takeDamage(damage);
        this.lastAttackTime = now;
        return { damage, killed };
    }
}

// Resolver combate entre dos jugadores
function resolveCombat(p1, p2, now) {
    if (!p1.alive || !p2.alive) return null;
    
    const p1CanAttack = p1.canAttack(now);
    const p2CanAttack = p2.canAttack(now);
    
    if (!p1CanAttack && !p2CanAttack) return null;
    
    let first, second;
    // Determinar quién ataca primero (el que lleva más tiempo sin atacar)
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
    
    // Primer golpe
    if (first) {
        const { damage, killed } = first.attack(second || (first === p1 ? p2 : p1), now);
        result.firstHit = { attacker: first.id, target: (first === p1 ? p2.id : p1.id), damage, killed };
    }
    
    // Segundo golpe (solo si ambos podían atacar y el primero no mató al segundo)
    if (second && result.firstHit && !result.firstHit.killed) {
        const { damage, killed } = second.attack(first, now);
        result.secondHit = { attacker: second.id, target: first.id, damage, killed };
    }
    
    return result;
}

// Mover jugadores
function updateMovement(deltaTime) {
    for (let id in players) {
        const p = players[id];
        if (!p.alive) continue;
        
        p.x += p.dx * p.speed * deltaTime;
        p.y += p.dy * p.speed * deltaTime;
        
        // Límites del mundo
        p.x = Math.min(Math.max(p.x, PLAYER_RADIUS), WORLD_SIZE - PLAYER_RADIUS);
        p.y = Math.min(Math.max(p.y, PLAYER_RADIUS), WORLD_SIZE - PLAYER_RADIUS);
    }
}

// Separar jugadores y detectar combates
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
                // Separar físicamente
                const angle = Math.atan2(dy, dx);
                const overlap = minDist - dist;
                const moveX = Math.cos(angle) * overlap / 2;
                const moveY = Math.sin(angle) * overlap / 2;
                p1.x += moveX;
                p1.y += moveY;
                p2.x -= moveX;
                p2.y -= moveY;
                
                // Resolver combate
                const combatResult = resolveCombat(p1, p2, now);
                if (combatResult && (combatResult.firstHit || combatResult.secondHit)) {
                    // Enviar evento de daño a los clientes afectados
                    if (combatResult.firstHit) {
                        sendDamageEvent(combatResult.firstHit);
                    }
                    if (combatResult.secondHit) {
                        sendDamageEvent(combatResult.secondHit);
                    }
                }
            }
        }
    }
}

// Enviar evento de daño a los clientes relevantes
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

// Actualizar zona segura
function updateZone(now) {
    const elapsed = (now - zoneShrinkStartTime) / 1000;
    const shrinkProgress = Math.min(1, elapsed / ZONE_SHRINK_TIME);
    zoneRadius = ZONE_START_RADIUS - (ZONE_START_RADIUS - ZONE_MIN_RADIUS) * shrinkProgress;
    zoneRadius = Math.max(ZONE_MIN_RADIUS, zoneRadius);
}

// Daño por estar fuera de la zona
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
            if (killed) {
                // Notificar muerte
                broadcastDeath(p.id);
            }
        }
    }
}

function broadcastDeath(playerId) {
    for (let id in players) {
        const p = players[id];
        if (p.ws && p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(JSON.stringify({
                type: 'death',
                playerId: playerId
            }));
        }
    }
}

// Eliminar jugadores muertos
function removeDeadPlayers() {
    for (let id in players) {
        if (!players[id].alive) {
            players[id].ws.close();
            delete players[id];
        }
    }
}

// Broadcast del estado del juego
function broadcastGameState() {
    const state = {
        type: 'state',
        players: {},
        zone: { x: zoneCenter.x, y: zoneCenter.y, radius: zoneRadius },
        aliveCount: Object.values(players).filter(p => p.alive).length
    };
    
    for (let id in players) {
        const p = players[id];
        state.players[id] = {
            id: p.id,
            x: p.x,
            y: p.y,
            health: p.health,
            alive: p.alive,
            lastAttackTime: p.lastAttackTime
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

// Bucle principal del juego
function gameLoop() {
    const now = Date.now() / 1000;
    const deltaTime = Math.min(0.033, now - lastTimestamp);
    lastTimestamp = now;
    
    updateMovement(deltaTime);
    handleCollisionsAndCombat(now);
    updateZone(now);
    applyZoneDamage(now);
    removeDeadPlayers();
    broadcastGameState();
}

// WebSocket connection handling
wss.on('connection', (ws) => {
    const playerId = nextPlayerId++;
    const player = new Player(playerId, ws);
    players[playerId] = player;
    
    console.log(`Player ${playerId} connected`);
    
    ws.on('message', (message) => {
        const data = JSON.parse(message);
        if (data.type === 'move') {
            const p = players[playerId];
            if (p && p.alive) {
                p.dx = data.dx;
                p.dy = data.dy;
            }
        }
    });
    
    ws.on('close', () => {
        console.log(`Player ${playerId} disconnected`);
        delete players[playerId];
    });
    
    // Enviar ID inicial
    ws.send(JSON.stringify({ type: 'init', id: playerId }));
});

// Iniciar servidor y bucle de juego
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    lastTimestamp = Date.now() / 1000;
    setInterval(gameLoop, 1000 / 20); // 20 updates per second
});
