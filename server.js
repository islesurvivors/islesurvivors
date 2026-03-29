const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.static(__dirname));

const server = app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor corriendo en puerto", server.address().port);
});

const wss = new WebSocket.Server({ server });

const WORLD_SIZE = 2400;
const WORLD_CENTER = WORLD_SIZE / 2;
const PLAYER_RADIUS = 8;
const ATTACK_COOLDOWN = 0.8;
const ATTACK_DAMAGE_MIN = 10;
const ATTACK_DAMAGE_MAX = 20;
const ZONE_SHRINK_TIME = 180;
const ZONE_START_RADIUS = 1100;
const ZONE_MIN_RADIUS = 150;
const ZONE_DAMAGE_PER_SECOND = 8;

let players = {};
let zoneCenter = { x: WORLD_CENTER, y: WORLD_CENTER };
let zoneRadius = ZONE_START_RADIUS;
let zoneShrinkStartTime = Date.now();
let lastZoneDamageTime = Date.now();

// ==================== PERLIN NOISE MEJORADO (idéntico al cliente) ====================
const grad3 = [
    [1,1,0], [-1,1,0], [1,-1,0], [-1,-1,0],
    [1,0,1], [-1,0,1], [1,0,-1], [-1,0,-1],
    [0,1,1], [0,-1,1], [0,1,-1], [0,-1,-1]
];
const p = [151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,140,36,103,30,69,142,8,99,37,240,21,10,23,
    190,6,148,247,120,234,75,0,26,197,62,94,252,219,203,117,35,11,32,57,177,33,88,237,149,56,87,174,20,125,136,
    171,168,68,175,74,165,71,134,139,48,27,166,77,146,158,231,83,111,229,122,60,211,133,230,220,105,92,41,55,46,
    245,40,244,102,143,54,65,25,63,161,1,216,80,73,209,76,132,187,208,89,18,169,200,196,135,130,116,188,159,86,
    164,100,109,198,173,186,3,64,52,217,226,250,124,123,5,202,38,147,118,126,255,82,85,212,207,206,59,227,47,16,
    58,17,182,189,28,42,223,183,170,213,119,248,152,2,44,154,163,70,221,153,101,155,167,43,172,9,129,22,39,253,19,
    98,108,110,79,113,224,232,178,185,112,104,218,246,97,228,251,34,242,193,238,210,144,12,191,179,162,241,81,51,145,
    235,249,14,239,107,49,192,214,31,181,199,106,157,184,84,204,176,115,121,50,45,127,4,150,254,138,236,205,93,222,
    114,67,29,24,72,243,141,128,195,78,66,215,61,156,180];
let perm = new Array(512);
let gradP = new Array(512);

function seed(seedValue) {
    if (seedValue > 0 && seedValue < 1) seedValue *= 65536;
    seedValue = Math.floor(seedValue);
    let oldp = [...p];
    for (let i = 0; i < 256; i++) {
        let v = (i + seedValue) % 256;
        perm[i] = perm[i+256] = oldp[v];
        gradP[i] = gradP[i+256] = grad3[perm[i] % grad3.length];
    }
}
function dot(g, x, y) { return g[0]*x + g[1]*y; }
function fade(t) { return t*t*t*(t*(t*6 - 15) + 10); }
function lerp(a, b, t) { return a + t*(b - a); }
function perlin2D(x, y) {
    let X = Math.floor(x) & 255;
    let Y = Math.floor(y) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    let u = fade(x);
    let v = fade(y);
    let aa = perm[X] + Y;
    let ab = perm[X] + Y + 1;
    let ba = perm[X+1] + Y;
    let bb = perm[X+1] + Y + 1;
    let g00 = gradP[aa], g10 = gradP[ba];
    let g01 = gradP[ab], g11 = gradP[bb];
    let n00 = dot(g00, x, y);
    let n10 = dot(g10, x-1, y);
    let n01 = dot(g01, x, y-1);
    let n11 = dot(g11, x-1, y-1);
    let nx0 = lerp(n00, n10, u);
    let nx1 = lerp(n01, n11, u);
    return lerp(nx0, nx1, v);
}
seed(42);

function fbm(x, y, octaves, persistence, lacunarity) {
    let value = 0;
    let amplitude = 1;
    let frequency = 1;
    let maxValue = 0;
    for (let i = 0; i < octaves; i++) {
        value += amplitude * perlin2D(x * frequency, y * frequency);
        maxValue += amplitude;
        amplitude *= persistence;
        frequency *= lacunarity;
    }
    return value / maxValue;
}

// ==================== MÁSCARA DE ISLA (CONTINENTE CON BORDES MUY IRREGULARES) ====================
let LAND_MASK = null;

function generateIslandMask() {
    const mask = new Array(WORLD_SIZE);
    const maxDist = WORLD_SIZE / 2 - 40;
    for (let x = 0; x < WORLD_SIZE; x++) {
        mask[x] = new Array(WORLD_SIZE);
        for (let y = 0; y < WORLD_SIZE; y++) {
            const dx = x - WORLD_CENTER;
            const dy = y - WORLD_CENTER;
            const dist = Math.hypot(dx, dy);
            const nx = x / 180;
            const ny = y / 180;
            let noiseVal = fbm(nx, ny, 5, 0.55, 2.1);
            noiseVal += 0.3 * perlin2D(x / 45, y / 45);
            noiseVal = (noiseVal + 1) / 2;
            let radialFactor = 1.0;
            if (dist > maxDist * 0.65) {
                radialFactor = 1.0 - Math.pow((dist - maxDist*0.65) / (maxDist*0.35), 1.5);
                radialFactor = Math.max(0, Math.min(1, radialFactor));
            }
            let centerBias = 1.0;
            if (dist < 200) centerBias = 1.2;
            const landValue = noiseVal * radialFactor * centerBias;
            const isLand = landValue > 0.38 && dist < maxDist - 15;
            mask[x][y] = isLand;
        }
    }
    // Rellenar pequeños agujeros interiores
    for (let i = 0; i < 8; i++) {
        for (let x = 1; x < WORLD_SIZE-1; x++) {
            for (let y = 1; y < WORLD_SIZE-1; y++) {
                if (!mask[x][y]) {
                    let neighbors = 0;
                    for (let dx = -1; dx <= 1; dx++) {
                        for (let dy = -1; dy <= 1; dy++) {
                            if (mask[x+dx][y+dy]) neighbors++;
                        }
                    }
                    if (neighbors >= 7) mask[x][y] = true;
                }
            }
        }
    }
    // Asegurar núcleo central sólido
    for (let dx = -180; dx <= 180; dx++) {
        for (let dy = -180; dy <= 180; dy++) {
            const cx = WORLD_CENTER + dx, cy = WORLD_CENTER + dy;
            if (cx >= 0 && cx < WORLD_SIZE && cy >= 0 && cy < WORLD_SIZE && Math.hypot(dx, dy) < 150) {
                mask[cx][cy] = true;
            }
        }
    }
    return mask;
}

function isLand(x, y) {
    if (!LAND_MASK) return true;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || ix >= WORLD_SIZE || iy < 0 || iy >= WORLD_SIZE) return false;
    return LAND_MASK[ix][iy] === true;
}

function clampToLand(player) {
    if (isLand(player.x, player.y)) return;
    for (let radius = 1; radius <= 80; radius++) {
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -radius; dy <= radius; dy++) {
                const nx = player.x + dx, ny = player.y + dy;
                if (isLand(nx, ny)) { player.x = nx; player.y = ny; return; }
            }
        }
    }
    player.x = WORLD_CENTER; player.y = WORLD_CENTER;
}

function getRandomLandPosition() {
    for (let attempts = 0; attempts < 500; attempts++) {
        const x = Math.random() * (WORLD_SIZE - 200) + 100;
        const y = Math.random() * (WORLD_SIZE - 200) + 100;
        if (isLand(x, y)) return { x, y };
    }
    return { x: WORLD_CENTER, y: WORLD_CENTER };
}

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
        for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash) + id.charCodeAt(i);
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
    canAttack(now) { return this.alive && (now - this.lastAttackTime >= ATTACK_COOLDOWN); }
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
        first = (now - p1.lastAttackTime) > (now - p2.lastAttackTime) ? p1 : p2;
        second = first === p1 ? p2 : p1;
    } else if (p1Can) { first = p1; second = p2; }
    else { first = p2; second = p1; }
    const result = { firstHit: null, secondHit: null };
    const { damage, killed } = first.attack(second, now);
    result.firstHit = { attacker: first.id, target: second.id, damage, killed };
    if (second.alive && second.canAttack(now) && !killed) {
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
        if (isLand(newX, newY)) {
            p.x = newX;
            p.y = newY;
        } else {
            p.dx = 0;
            p.dy = 0;
        }
        clampToLand(p);
    }
}

function handleCollisionsAndCombat(now) {
    const ids = Object.keys(players);
    for (let i = 0; i < ids.length; i++) {
        const p1 = players[ids[i]];
        if (!p1.alive) continue;
        for (let j = i+1; j < ids.length; j++) {
            const p2 = players[ids[j]];
            if (!p2.alive) continue;
            const dx = p1.x - p2.x;
            const dy = p1.y - p2.y;
            const dist = Math.hypot(dx, dy);
            if (dist < PLAYER_RADIUS * 2) {
                const angle = Math.atan2(dy, dx);
                const overlap = (PLAYER_RADIUS * 2) - dist;
                const moveX = Math.cos(angle) * overlap / 2;
                const moveY = Math.sin(angle) * overlap / 2;
                p1.x += moveX; p1.y += moveY;
                p2.x -= moveX; p2.y -= moveY;
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
    if (attacker && attacker.ws.readyState === WebSocket.OPEN) {
        attacker.ws.send(JSON.stringify({ type: 'damage', damage: hit.damage, target: hit.target, killed: hit.killed }));
    }
    if (target && target.ws.readyState === WebSocket.OPEN) {
        target.ws.send(JSON.stringify({ type: 'damage', damage: hit.damage, from: hit.attacker, killed: hit.killed }));
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
        const dist = Math.hypot(p.x - zoneCenter.x, p.y - zoneCenter.y);
        if (dist > zoneRadius) p.takeDamage(ZONE_DAMAGE_PER_SECOND);
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
            p.dx = p.dy = 0;
            let placed = false;
            for (let attempts = 0; attempts < 100; attempts++) {
                const safeRadius = Math.min(zoneRadius, WORLD_SIZE/2);
                const angle = Math.random() * 2 * Math.PI;
                const radius = Math.random() * safeRadius;
                let x = zoneCenter.x + Math.cos(angle) * radius;
                let y = zoneCenter.y + Math.sin(angle) * radius;
                x = Math.min(Math.max(x, PLAYER_RADIUS), WORLD_SIZE - PLAYER_RADIUS);
                y = Math.min(Math.max(y, PLAYER_RADIUS), WORLD_SIZE - PLAYER_RADIUS);
                if (isLand(x, y)) { p.x = x; p.y = y; placed = true; break; }
            }
            if (!placed) { const fallback = getRandomLandPosition(); p.x = fallback.x; p.y = fallback.y; }
            p.respawnTime = null;
        }
    }
}

function removeDeadPlayers() {
    for (let id in players) if (players[id].ws.readyState !== WebSocket.OPEN) delete players[id];
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
        state.players[id] = { id: p.id, x: p.x, y: p.y, health: p.health, alive: p.alive, lastAttackTime: p.lastAttackTime, color: p.color };
    }
    const msg = JSON.stringify(state);
    for (let id in players) if (players[id].ws.readyState === WebSocket.OPEN) players[id].ws.send(msg);
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
        if (data.type === "move" && players[id] && players[id].alive) {
            players[id].dx = data.dx;
            players[id].dy = data.dy;
        }
    });
    ws.on("close", () => delete players[id]);
});
