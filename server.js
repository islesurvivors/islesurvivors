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

// combate
const ATTACK_COOLDOWN = 0.8;
const ATTACK_DAMAGE_MIN = 10;
const ATTACK_DAMAGE_MAX = 20;

// knockback
const KNOCKBACK_FORCE = 120;
const KNOCKBACK_DECAY = 0.85;

// zona segura
const SAFE_ZONE_CENTER_X = WORLD_SIZE / 2;
const SAFE_ZONE_CENTER_Y = WORLD_SIZE / 2;
const SAFE_ZONE_SIZE = 260;
const SAFE_HALF = SAFE_ZONE_SIZE / 2;

function isInsideSafeZone(x, y) {
    return (
        Math.abs(x - SAFE_ZONE_CENTER_X) <= (SAFE_HALF - PLAYER_RADIUS) &&
        Math.abs(y - SAFE_ZONE_CENTER_Y) <= (SAFE_HALF - PLAYER_RADIUS)
    );
}

function getSafeSpawnPosition() {
    const maxOffset = Math.max(0, SAFE_HALF - PLAYER_RADIUS - 12);
    return {
        x: SAFE_ZONE_CENTER_X + (Math.random() * 2 - 1) * maxOffset,
        y: SAFE_ZONE_CENTER_Y + (Math.random() * 2 - 1) * maxOffset
    };
}

function killByWater(p) {
    if (!p.alive) return false;
    p.health = 0;
    p.alive = false;
    p.vx = 0;
    p.vy = 0;
    p.respawnTime = Date.now() + 5000;
    return true;
}

function handleWaterDeaths() {
    for (let id in players) {
        const p = players[id];
        if (p.alive && !isInsideSafeZone(p.x, p.y)) {
            killByWater(p);
        }
    }
}

let players = {};

class Player {
    constructor(id, ws) {
        this.id = id;
        this.ws = ws;

        const spawn = getSafeSpawnPosition();
        this.x = spawn.x;
        this.y = spawn.y;

        this.health = 100;
        this.lastAttackTime = 0;

        this.dx = 0;
        this.dy = 0;
        this.speed = 200;

        this.vx = 0;
        this.vy = 0;

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

        const moveX = p.dx * p.speed;
        const moveY = p.dy * p.speed;

        p.x += (moveX + p.vx) * deltaTime;
        p.y += (moveY + p.vy) * deltaTime;

        p.vx *= KNOCKBACK_DECAY;
        p.vy *= KNOCKBACK_DECAY;

        p.x = Math.min(Math.max(p.x, PLAYER_RADIUS), WORLD_SIZE - PLAYER_RADIUS);
        p.y = Math.min(Math.max(p.y, PLAYER_RADIUS), WORLD_SIZE - PLAYER_RADIUS);
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

                const nx = Math.cos(angle);
                const ny = Math.sin(angle);

                const overlap = minDist - dist;

                const pushX = nx * overlap / 2;
                const pushY = ny * overlap / 2;

                p1.x += pushX;
                p1.y += pushY;
                p2.x -= pushX;
                p2.y -= pushY;

                // 💥 knockback
                p1.vx += nx * KNOCKBACK_FORCE;
                p1.vy += ny * KNOCKBACK_FORCE;

                p2.vx -= nx * KNOCKBACK_FORCE;
                p2.vy -= ny * KNOCKBACK_FORCE;

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

    if (attacker && attacker.ws.readyState === WebSocket.OPEN) {
        attacker.ws.send(JSON.stringify({ type: 'damage', damage: hit.damage }));
    }
    if (target && target.ws.readyState === WebSocket.OPEN) {
        target.ws.send(JSON.stringify({ type: 'damage', damage: hit.damage }));
    }
}

function processRespawns() {
    const now = Date.now();

    for (let id in players) {
        const p = players[id];

        if (!p.alive && p.respawnTime && p.respawnTime <= now) {
            p.alive = true;
            p.health = 100;
            p.dx = 0;
            p.dy = 0;
            p.vx = 0;
            p.vy = 0;

            const spawn = getSafeSpawnPosition();
            p.x = spawn.x;
            p.y = spawn.y;

            p.respawnTime = null;
        }
    }
}

function broadcastGameState() {
    const state = {
        type: 'state',
        players: {}
    };

    for (let id in players) {
        const p = players[id];
        state.players[id] = {
            x: p.x,
            y: p.y,
            health: p.health,
            alive: p.alive
        };
    }

    const msg = JSON.stringify(state);

    for (let id in players) {
        const p = players[id];
        if (p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(msg);
        }
    }
}

setInterval(() => {
    const now = Date.now() / 1000;

    updateMovement(1/20);
    handleWaterDeaths();
    handleCollisionsAndCombat(now);
    handleWaterDeaths();
    processRespawns();
    broadcastGameState();

}, 1000 / 20);

wss.on("connection", (ws) => {
    const id = Math.random().toString(36).substr(2, 9);
    players[id] = new Player(id, ws);

    ws.send(JSON.stringify({ type: "init", id }));

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
