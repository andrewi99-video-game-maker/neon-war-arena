const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const path = require('path');

app.use(express.static('public'));
app.use('/assets', express.static('assets'));

// Game State
let players = {};
let deadPlayers = {}; // { id: deathTime }
let projectiles = []; // GLOBAL authoritative projectile list
let powerups = []; // { id, x, y, type }
let tethers = []; // { id: 'p1-p2', p1, p2, endTime }

// World Dimensions
const WORLD_WIDTH = 2000;
const WORLD_HEIGHT = 2000;

const WALL_RECTS = [
    // Center Barriers
    { x: 1000 - 150, y: 1000 - 20, w: 300, h: 40 },

    // Four Pillars (scaled more outward)
    { x: 500, y: 500, w: 80, h: 80 },
    { x: 1420, y: 500, w: 80, h: 80 },
    { x: 500, y: 1420, w: 80, h: 80 },
    { x: 1420, y: 1420, w: 80, h: 80 },

    // Edge Barriers (closer to new edges)
    { x: 150, y: 938, w: 60, h: 124 },
    { x: 1790, y: 938, w: 60, h: 124 },
    { x: 938, y: 150, w: 124, h: 60 },
    { x: 938, y: 1790, w: 124, h: 60 },

    // New Middle Barriers for more cover
    { x: 300, y: 950, w: 200, h: 100 },
    { x: 1500, y: 950, w: 200, h: 100 },

    // BOUNDARIES
    { x: 0, y: 0, w: WORLD_WIDTH, h: 40 },           // Top
    { x: 0, y: WORLD_HEIGHT - 40, w: WORLD_WIDTH, h: 40 }, // Bottom
    { x: 0, y: 0, w: 40, h: WORLD_HEIGHT },          // Left
    { x: WORLD_WIDTH - 40, y: 0, w: 40, h: WORLD_HEIGHT } // Right
];

const POWERUP_TYPES = ['speed', 'unlimitedAmmo', 'freeze'];
const POWERUP_RADIUS = 20;
let lastPowerupSpawnTime = Date.now();

function isCollidingWithWalls(x, y, radius) {
    for (const wall of WALL_RECTS) {
        // Find closest point on rect to circle center
        const closestX = Math.max(wall.x, Math.min(x, wall.x + wall.w));
        const closestY = Math.max(wall.y, Math.min(y, wall.y + wall.h));

        const distX = x - closestX;
        const distY = y - closestY;
        const dist = Math.sqrt(distX * distX + distY * distY);

        if (dist < radius + 5) { // 5px buffer
            return true;
        }
    }
    return false;
}

function getSafeSpawn() {
    let x, y;
    let attempts = 0;
    do {
        x = Math.floor(Math.random() * (WORLD_WIDTH - 200)) + 100;
        y = Math.floor(Math.random() * (WORLD_HEIGHT - 200)) + 100;
        attempts++;
        if (attempts > 100) break; // Fallback
    } while (isCollidingWithWalls(x, y, 25));
    return { x, y };
}

function spawnPowerUp() {
    if (powerups.length >= 5) return;
    const { x, y } = getSafeSpawn();

    // Weighted selection: Speed (45%), Ammo (45%), Freeze (10%)
    const rand = Math.random();
    let type;
    if (rand < 0.45) type = 'speed';
    else if (rand < 0.90) type = 'unlimitedAmmo';
    else type = 'freeze';

    powerups.push({
        id: Math.random().toString(36).substr(2, 9),
        x, y, type
    });
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    // Default spawning (as Titus) so health is correct immediately
    const { x, y } = getSafeSpawn();
    players[socket.id] = {
        id: socket.id,
        x: x,
        y: y,
        character: 'titus',
        color: '#ff6600',
        alive: true,
        health: 120,
        maxHealth: 120,
        angle: 0,
        superCharge: 0,
        lastDamageTime: Date.now(),
        ammo: 4,
        maxAmmo: 4,
        reloadTimer: 0,
        reloadDelay: 1800,
        hasShield: false,
        speedMultiplier: 1.0,
        unlimitedAmmoUntil: 0,
        frozenUntil: 0,
        spinningUntil: 0,
        speedUntil: 0,
    };
    socket.emit('init', { id: socket.id, players });

    socket.on('join', (data) => {
        const character = data.character || 'titus';
        const { x, y } = getSafeSpawn();

        players[socket.id] = {
            id: socket.id,
            x: x,
            y: y,
            character: character,
            color: character === 'titus' ? '#ff6600' : '#00ffff',
            alive: true,
            health: character === 'titus' ? 120 : 110,
            maxHealth: character === 'titus' ? 120 : 110,
            angle: 0,
            superCharge: 0,
            lastDamageTime: Date.now(),
            ammo: character === 'titus' ? 4 : 3,
            maxAmmo: character === 'titus' ? 4 : 3,
            reloadTimer: 0,
            reloadDelay: character === 'titus' ? 1800 : 2000,
            hasShield: character === 'drandrew', // Andrew takes no damage from first attack
            speedMultiplier: 1.0,
            unlimitedAmmoUntil: 0,
            frozenUntil: 0,
            spinningUntil: 0,
            speedUntil: 0,
        };

        socket.emit('init', { id: socket.id, players });
    });

    socket.on('update', (data) => {
        const player = players[socket.id];
        if (!player || !player.alive) return;

        // If spinning, randomize angle and reduce movement
        let moveX = data.x;
        let moveY = data.y;
        let moveAngle = data.angle;

        if (Date.now() < player.spinningUntil) {
            moveAngle += 0.2; // Spin
            // Lock position when spinning
            moveX = player.x;
            moveY = player.y;
        }

        player.x = moveX;
        player.y = moveY;
        player.angle = moveAngle;

        if (Date.now() < player.frozenUntil) {
            return;
        }
    });

    socket.on('shoot', (data) => {
        const now = Date.now();
        const player = players[socket.id];
        if (!player || !player.alive) return;

        const isSuper = data.isSuper || false;

        // Validation
        if (isSuper) {
            if (player.superCharge < 100) return;
            player.superCharge = 0;
        } else {
            if (!player.unlimitedAmmo && now > player.unlimitedAmmoUntil) {
                if (player.ammo <= 0) return;
                player.ammo--;
                if (player.reloadTimer === 0) player.reloadTimer = Date.now();
            }
        }

        const dx = Math.cos(player.angle);
        const dy = Math.sin(player.angle);

        if (player.character === 'titus') {
            projectiles.push({
                id: Math.random().toString(36).substr(2, 9),
                type: isSuper ? 'watch' : 'fireloop',
                x: player.x + dx * 40,
                y: player.y + dy * 40,
                vx: dx * (isSuper ? 12 : 10),
                vy: dy * (isSuper ? 12 : 10),
                isSuper: isSuper,
                owner: socket.id,
                color: isSuper ? '#ffff00' : '#ff4400',
                radius: isSuper ? 80 : 35, // Titus attack is big, Super is HUGE
                hitIds: [] // Track players already hit by this projectile
            });
        } else {
            // Dr. Andrew
            if (isSuper) {
                projectiles.push({
                    id: Math.random().toString(36).substr(2, 9),
                    type: 'lightningwave',
                    x: player.x + dx * 40,
                    y: player.y + dy * 40,
                    vx: dx * 18, // Slightly slower for more "wave" presence
                    vy: dy * 18,
                    isSuper: true,
                    owner: socket.id,
                    color: '#ffffff',
                    radius: 200, // MUCH WIDER
                    hitIds: []
                });
            } else {
                projectiles.push({
                    id: Math.random().toString(36).substr(2, 9),
                    type: 'lightning',
                    x: player.x + dx * 40,
                    y: player.y + dy * 40,
                    vx: dx * 30, // Instant-ish
                    vy: dy * 30,
                    isSuper: false,
                    owner: socket.id,
                    color: '#00ffff',
                    radius: 20
                });
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        delete players[socket.id];
        delete deadPlayers[socket.id];
    });
});

// Authoritative Physics Loop (60Hz)
setInterval(() => {
    const now = Date.now();

    // Spawn Powerups
    if (now - lastPowerupSpawnTime > 10000) {
        spawnPowerUp();
        lastPowerupSpawnTime = now;
    }

    // Check Respawns, Ammo Recharge, and Powerups
    for (let id in players) {
        let player = players[id];

        // Respawn check
        if (!player.alive && deadPlayers[id]) {
            if (now - deadPlayers[id] > 5000) {
                const { x, y } = getSafeSpawn();
                player.alive = true;
                player.health = player.maxHealth;
                player.superCharge = 0;
                player.ammo = player.maxAmmo;
                player.lastDamageTime = now;
                player.x = x;
                player.y = y;
                delete deadPlayers[id];
            }
        }

        // Ammo Recharge
        if (player.alive && player.ammo < player.maxAmmo) {
            if (player.reloadTimer === 0) {
                player.reloadTimer = now;
            }
            if (now - player.reloadTimer >= player.reloadDelay) {
                player.ammo++;
                if (player.ammo < player.maxAmmo) {
                    player.reloadTimer = now;
                } else {
                    player.reloadTimer = 0;
                }
            }
        }

        // Auto-healing (No healing if spinning or tethered)
        const isTethered = tethers.some(t => t.p1 === id || t.p2 === id);
        if (player.alive && player.health < player.maxHealth && now > player.spinningUntil && !isTethered) {
            const timeSinceHit = (now - player.lastDamageTime) / 1000;
            if (timeSinceHit > 2.0) {
                const regenSpeed = 2.5 + Math.pow(timeSinceHit - 2.0, 2) * 5;
                player.health = Math.min(player.maxHealth, player.health + regenSpeed * (1 / 60));
            }
        }

        // Spinning DOT (Titus Super)
        if (player.alive && now < player.spinningUntil) {
            const damage = 10 * (1 / 60); // 10 damage per second
            player.health -= damage;

            // CONTAGIOUS: Spread spin to nearby players (only the creator is immune)
            for (let otherId in players) {
                if (otherId !== id && players[otherId].alive && otherId !== player.spinningOwner && now > (players[otherId].spinningUntil || 0)) {
                    const dist = Math.sqrt(Math.pow(player.x - players[otherId].x, 2) + Math.pow(player.y - players[otherId].y, 2));
                    if (dist < 100) { // Spread distance
                        players[otherId].spinningUntil = now + 5000;
                        players[otherId].spinningOwner = player.spinningOwner; // Propagate the original creator
                    }
                }
            }

            // Charge Super from DOT damage
            for (let pid in players) {
                if (players[pid].character === 'titus' && players[pid].alive) {
                    // Check if they own any 'watch' projectile or if we can track owner
                    // Simplified: any Titus alive gets some charge back if anyone is spinning
                    // Better: Titus Super projectiles should track owner if we had a list of active effects
                    // For now, let's assume if anyone is spinning, the Titus who hit them gets charge
                    // This is approximate but better than zero.
                    players[pid].superCharge = Math.min(100, (players[pid].superCharge || 0) + damage * 0.5);
                }
            }

            if (player.health <= 0) {
                player.health = 0;
                player.alive = false;
                deadPlayers[id] = now;
            }
        }

        // Reset temporary buffs/debuffs
        if (player.speedUntil > 0 && now > player.speedUntil) {
            player.speedMultiplier = 1.0;
            player.speedUntil = 0;
        }

        // Powerup Collision
        if (player.alive && now > player.frozenUntil) {
            for (let i = powerups.length - 1; i >= 0; i--) {
                const pu = powerups[i];
                const dist = Math.sqrt(Math.pow(player.x - pu.x, 2) + Math.pow(player.y - pu.y, 2));
                if (dist < 45) { // Player radius (25) + Powerup (~20)
                    applyPowerUp(id, pu.type, now);
                    powerups.splice(i, 1);
                    io.emit('powerupCollected', { id, type: pu.type });
                }
            }
        }
    }

    // Process Tethers
    for (let i = tethers.length - 1; i >= 0; i--) {
        const t = tethers[i];
        const p1 = players[t.p1];
        const p2 = players[t.p2];

        if (!p1 || !p2 || !p1.alive || !p2.alive || now > t.endTime) {
            tethers.splice(i, 1);
            continue;
        }

        const dist = Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
        if (dist > 400) { // Break distance
            tethers.splice(i, 1);
            continue;
        }

        // Persistent DOT (3 damage per 0.25s = 12 damage/sec)
        const damage = 12 * (1 / 60);
        p1.health -= damage;
        p2.health -= damage;
        p1.lastDamageTime = now;
        p2.lastDamageTime = now;

        // Charge Andrew's Super from Chain damage
        for (let pid in players) {
            if (players[pid].character === 'drandrew' && players[pid].alive) {
                players[pid].superCharge = Math.min(100, (players[pid].superCharge || 0) + damage * 0.5);
            }
        }

        // Visual sync
        if (Math.random() < 0.1) {
            io.emit('lightningTether', { p1: t.p1, p2: t.p2 });
        }

        // Check for death from tether
        if (p1.health <= 0) {
            p1.health = 0;
            p1.alive = false;
            deadPlayers[t.p1] = now;
        }
        if (p2.health <= 0) {
            p2.health = 0;
            p2.alive = false;
            deadPlayers[t.p2] = now;
        }
    }

    // Projectile Movement & Collision
    for (let i = projectiles.length - 1; i >= 0; i--) {
        let proj = projectiles[i];
        proj.x += proj.vx;
        proj.y += proj.vy;

        let hitBoundary = false;

        // Wall Collision
        if (!proj.isSuper && isCollidingWithWalls(proj.x, proj.y, 10)) {
            hitBoundary = true;
            io.emit('collision', { x: proj.x, y: proj.y, type: 'wall' });
        }

        // Player Collision
        let hitPlayer = false;
        if (!hitBoundary) {
            for (let pid in players) {
                let p = players[pid];
                if (p.alive && pid !== proj.owner) {
                    // Piercing projectiles (isSuper) only hit once per target
                    if (proj.isSuper && proj.hitIds && proj.hitIds.includes(pid)) continue;

                    const dist = Math.sqrt(Math.pow(proj.x - p.x, 2) + Math.pow(proj.y - p.y, 2));
                    const hitRadius = proj.radius || (proj.isSuper ? 40 : 35);

                    if (dist < hitRadius) {
                        let damage = 0;
                        if (proj.type === 'fireloop') damage = 20;
                        else if (proj.type === 'lightning') damage = 15;
                        else if (proj.type === 'lightningwave') damage = 50;
                        else if (proj.type === 'watch') damage = 10;
                        else damage = proj.isSuper ? 100 : 25;

                        // Titus Passive: -4 damage
                        if (p.character === 'titus') {
                            damage = Math.max(0, damage - 4);
                        }

                        // Dr. Andrew Passive: Shield
                        if (p.hasShield && damage > 0) {
                            damage = 0;
                            p.hasShield = false;
                            io.emit('shieldBreak', { id: pid });
                        }

                        p.health -= damage;
                        p.lastDamageTime = now;

                        // Titus Super effect: Spinning
                        if (proj.type === 'watch') {
                            p.spinningUntil = now + 5000; // 5s spin
                            p.spinningOwner = proj.owner; // Track who created this specific loop
                        }

                        // Dr. Andrew Lightning Chain
                        if (proj.type === 'lightning') {
                            // Breadth-First Search to find all connected enemies
                            let queue = [pid];
                            let visited = new Set([pid]);
                            let maxChain = 5;

                            while (queue.length > 0 && visited.size < maxChain) {
                                let currentId = queue.shift();
                                let currentPos = players[currentId];

                                for (let otherId in players) {
                                    if (!visited.has(otherId) && otherId !== proj.owner && players[otherId].alive) {
                                        const otherDist = Math.sqrt(Math.pow(currentPos.x - players[otherId].x, 2) + Math.pow(currentPos.y - players[otherId].y, 2));
                                        if (otherDist < 250) { // Increased chain range
                                            visited.add(otherId);
                                            queue.push(otherId);

                                            // Create or Refresh Tether
                                            const pA = currentId < otherId ? currentId : otherId;
                                            const pB = currentId < otherId ? otherId : currentId;
                                            const existing = tethers.find(t => t.p1 === pA && t.p2 === pB);
                                            if (existing) {
                                                existing.endTime = now + 5000;
                                            } else {
                                                tethers.push({ p1: pA, p2: pB, endTime: now + 5000 });
                                            }
                                            io.emit('lightningTether', { p1: pA, p2: pB });
                                        }
                                    }
                                }
                            }
                        }

                        io.emit('collision', { x: proj.x, y: proj.y, type: 'player', damage, victim: pid });

                        // Charge Super on hits (including Super hits, per user request)
                        if (players[proj.owner]) {
                            let chargeAmount = 0;
                            if (proj.type === 'fireloop') chargeAmount = 20;
                            else if (proj.type === 'lightning') chargeAmount = 25;
                            else if (proj.type === 'lightningwave') chargeAmount = 15; // Wave hits many, lower charge per hit
                            else if (proj.type === 'watch') chargeAmount = 10;
                            else chargeAmount = 20;

                            players[proj.owner].superCharge = Math.min(100, (players[proj.owner].superCharge || 0) + chargeAmount);
                        }

                        if (p.health <= 0) {
                            p.health = 0;
                            p.alive = false;
                            deadPlayers[pid] = now;
                        }

                        if (proj.isSuper && proj.hitIds) {
                            proj.hitIds.push(pid);
                        }

                        if (!proj.isSuper) hitPlayer = true;
                    }
                }
            }
        }

        const hit = hitBoundary || hitPlayer || Math.abs(proj.x) > 6000 || Math.abs(proj.y) > 4000;
        if (hit) {
            projectiles.splice(i, 1);
        }
    }
}, 1000 / 60);

function applyPowerUp(playerId, type, now) {
    const player = players[playerId];
    if (!player) return;

    if (type === 'speed') {
        player.speedMultiplier = 1.6;
        player.speedUntil = now + 10000; // 10s
    } else if (type === 'unlimitedAmmo') {
        player.unlimitedAmmoUntil = now + 10000; // 10s
    } else if (type === 'freeze') {
        // Freeze everyone ELSE
        for (let id in players) {
            if (id !== playerId) {
                players[id].frozenUntil = now + 5000; // 5s
            }
        }
    }
}

// Broadcast Loop (20Hz) - Reduces bandwidth and congestion
setInterval(() => {
    io.emit('state', { players, projectiles, powerups, ts: Date.now() });
}, 1000 / 20);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    const os = require('os');
    const networkInterfaces = os.networkInterfaces();
    let localIp = 'localhost';

    for (const name of Object.keys(networkInterfaces)) {
        for (const net of networkInterfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                localIp = net.address;
            }
        }
    }

    console.log(`\n=========================================`);
    console.log(`Server running!`);
    console.log(`Local access: http://localhost:${PORT}`);
    console.log(`Network access: http://${localIp}:${PORT}`);
    console.log(`=========================================\n`);
});
