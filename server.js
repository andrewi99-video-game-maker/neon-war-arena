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
let iceTrails = []; // { id, x, y, owner, endTime }

// World Dimensions
const WORLD_WIDTH = 2000;
const WORLD_HEIGHT = 2000;

let gameState = 'LOBBY'; // 'LOBBY', 'PLAYING'
let gameMode = 'deathmatch'; // 'deathmatch', 'soccer'

let ball = {
    x: 1000,
    y: 1000,
    vx: 0,
    vy: 0,
    radius: 20,
    mass: 1.0,
    friction: 0.98
};

const SOCCER_GOALS = {
    left: { x: 0, y: 800, w: 50, h: 400, owner: null },
    right: { x: 1950, y: 800, w: 50, h: 400, owner: null }
};

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

const BUSH_RECTS = [
    // Corner Thickets
    { x: 100, y: 100, w: 300, h: 300 },
    { x: 1600, y: 100, w: 300, h: 300 },
    { x: 100, y: 1600, w: 300, h: 300 },
    { x: 1600, y: 1600, w: 300, h: 300 },

    // Side Thickets
    { x: 50, y: 800, w: 150, h: 400 },
    { x: 1800, y: 800, w: 150, h: 400 },
    { x: 800, y: 50, w: 400, h: 150 },
    { x: 800, y: 1800, w: 400, h: 150 },

    // Middle/Pillar Clusters
    { x: 450, y: 450, w: 200, h: 200 },
    { x: 1350, y: 450, w: 200, h: 200 },
    { x: 450, y: 1350, w: 200, h: 200 },
    { x: 1350, y: 1350, w: 200, h: 200 },

    // Central Ambush
    { x: 925, y: 925, w: 150, h: 150 }
];

const POWERUP_TYPES = ['speed', 'unlimitedAmmo', 'freeze'];
const POWERUP_RADIUS = 20;
let lastPowerupSpawnTime = Date.now();

function isCollidingWithWalls(x, y, radius) {
    if (gameMode === 'soccer') return false; // Clean pitch for soccer
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

function handleDeath(victimId, killerId) {
    const victim = players[victimId];
    if (!victim || !victim.alive) return;

    victim.health = 0;
    victim.alive = false;

    // In Soccer mode, lives are ONLY lost on goals
    if (gameMode !== 'soccer') {
        victim.lives--;
    }

    deadPlayers[victimId] = Date.now();

    if (killerId && players[killerId] && killerId !== victimId) {
        players[killerId].kills = (players[killerId].kills || 0) + 1;
        io.emit('killNotification', { killer: killerId, victim: victimId });
    }
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
        kills: 0,
        lastShootTime: 0,
        lives: 3,
        isReady: false,
        respawnShieldUntil: 0,
        respawnSpeedUntil: 0
    };
    socket.emit('init', { id: socket.id, players });
    io.emit('lobbyUpdate', { players });

    socket.on('join', (data) => {
        const character = data.character || 'titus';
        const nickname = data.nickname || "";
        const { x, y } = getSafeSpawn();

        players[socket.id] = {
            id: socket.id,
            nickname: nickname,
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
            dashingUntil: 0,
            dashDx: 0,
            dashDx: 0,
            dashDy: 0,
            dashHitIds: [], // Track unique hits per dash
            kills: 0,
            lastShootTime: 0,
            lives: 3,
            isReady: false,
            isWaiting: gameState === 'PLAYING', // New players must wait if game is in progress
            respawnShieldUntil: 0,
            respawnSpeedUntil: 0
        };

        if (character === 'hyperswag') {
            players[socket.id].health = 150;
            players[socket.id].maxHealth = 150;
            players[socket.id].color = '#00ffff';
            players[socket.id].ammo = 3;
            players[socket.id].maxAmmo = 3;
            players[socket.id].reloadDelay = 1500;
        }

        if (character === 'one') {
            players[socket.id].health = 130;
            players[socket.id].maxHealth = 130;
            players[socket.id].color = '#8b4513';
            players[socket.id].ammo = 1;
            players[socket.id].maxAmmo = 1;
            players[socket.id].reloadDelay = 1500;
            players[socket.id].speedMultiplier = 1.33;
        }

        socket.emit('init', { id: socket.id, players });
        io.emit('lobbyUpdate', { players });
    });

    socket.on('readyUp', (data) => {
        if (players[socket.id]) {
            players[socket.id].isReady = data.isReady;
            io.emit('lobbyUpdate', { players });

            // Check if all players are ready
            const allReady = Object.values(players).every(p => p.isReady);
            if (allReady && Object.keys(players).length > 0) {
                io.emit('pickMode');
            }
        }
    });

    socket.on('selectMode', (data) => {
        if (gameState === 'LOBBY') {
            gameMode = data.mode || 'deathmatch';
            startMatch();
        }
    });

    function startMatch() {
        gameState = 'PLAYING';

        // Reset ball if soccer
        if (gameMode === 'soccer') {
            ball.x = 1000;
            ball.y = 1000;
            ball.vx = 0;
            ball.vy = 0;

            // Assign goals for 1v1 soccer (simple assignment for now)
            const ids = Object.keys(players);
            if (ids.length >= 1) SOCCER_GOALS.left.owner = ids[0];
            if (ids.length >= 2) SOCCER_GOALS.right.owner = ids[1];

            // Set 2 lives for soccer
            for (let id in players) {
                players[id].lives = 2;
                // Spawn at goals
                if (id === SOCCER_GOALS.left.owner) {
                    players[id].x = 100;
                    players[id].y = 1000;
                } else if (id === SOCCER_GOALS.right.owner) {
                    players[id].x = 1900;
                    players[id].y = 1000;
                }
            }
        } else {
            // Reset for deathmatch
            for (let id in players) {
                players[id].lives = 3;
                const { x, y } = getSafeSpawn();
                players[id].x = x;
                players[id].y = y;
            }
        }

        io.emit('gameStart', { mode: gameMode });
    }

    socket.on('update', (data) => {
        const player = players[socket.id];
        if (!player || !player.alive || player.isWaiting) return; // Prevent movement if dead or waiting

        // If spinning, randomize angle and reduce movement
        let moveX = data.x;
        let moveY = data.y;
        let moveAngle = data.angle;

        if (Date.now() < (player.frozenUntil || 0)) {
            return;
        }

        // Only update position from client if NOT dashing
        if (Date.now() > (player.dashingUntil || 0)) {
            player.x = moveX;
            player.y = moveY;
        }
        player.angle = moveAngle;
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

        player.lastShootTime = now;

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
        } else if (player.character === 'drandrew') {
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
                    vx: dx * 90, // 3x faster (was 30)
                    vy: dy * 90,
                    isSuper: false,
                    owner: socket.id,
                    color: '#00ffff',
                    radius: 60 // 3x wider (was 20)
                });
            }
        } else if (player.character === 'hyperswag') {
            if (isSuper) {
                // Dash to Target
                const tx = data.targetX || (player.x + dx * 300); // Fallback to current direction if no target
                const ty = data.targetY || (player.y + dy * 300);

                // Calculate distance
                const dist = Math.sqrt(Math.pow(tx - player.x, 2) + Math.pow(ty - player.y, 2));

                // Speed of dash (pixels per millisecond? No, pixels per frame is handled in update, but here we set dashDx/Dy which are per frame)
                // Actually update loop says: let nextX = player.x + player.dashDx * 25;
                // So dashDx/Dy should be normalized direction vector.
                // 25 pixels/frame = 1500 pixels/sec.

                const angle = Math.atan2(ty - player.y, tx - player.x);
                player.dashDx = Math.cos(angle);
                player.dashDy = Math.sin(angle);

                // Duration = Distance / Speed
                // Speed = 25 px/frame = 1.5 px/ms (at 60fps, 25 * 60 = 1500px/s = 1.5px/ms)
                const speedPerMs = 1.5;
                const duration = Math.min(3000, dist / speedPerMs); // Cap at 3s (3x longer)

                player.dashingUntil = now + duration;
                player.dashDx = Math.cos(angle);
                player.dashDy = Math.sin(angle);

                // Reset Hit List
                player.dashHitIds = [];
            } else {
                // Two punch attack
                // First punch
                projectiles.push({
                    id: Math.random().toString(36).substr(2, 9),
                    type: 'punch',
                    x: player.x + dx * 30,
                    y: player.y + dy * 30,
                    vx: 0, // Stationary
                    vy: 0,
                    startTime: Date.now(),
                    owner: socket.id,
                    color: '#00ffff',
                    radius: 40, // Slightly larger hit area for melee
                    duration: 150 // Short lived
                });
                // Second punch delayed
                setTimeout(() => {
                    if (players[socket.id] && players[socket.id].alive) {
                        const me = players[socket.id];
                        const mdx = Math.cos(me.angle);
                        const mdy = Math.sin(me.angle);
                        projectiles.push({
                            id: Math.random().toString(36).substr(2, 9),
                            type: 'punch',
                            x: me.x + mdx * 50, // Slightly further out
                            y: me.y + mdy * 50,
                            vx: 0,
                            vy: 0,
                            startTime: Date.now(),
                            owner: socket.id,
                            color: '#00ffff',
                            radius: 40,
                            duration: 150
                        });
                    }
                }, 150);
            }
        } else if (player.character === 'one') {
            if (isSuper) {
                projectiles.push({
                    id: Math.random().toString(36).substr(2, 9),
                    type: 'storm',
                    x: player.x + dx * 40,
                    y: player.y + dy * 40,
                    vx: dx * 1.5, // Slowed down from 3
                    vy: dy * 1.5,
                    isSuper: true,
                    owner: socket.id,
                    color: '#a0522d',
                    radius: 150,
                    duration: 5000,
                    startTime: Date.now(),
                    hitIds: []
                });
            } else {
                projectiles.push({
                    id: Math.random().toString(36).substr(2, 9),
                    type: 'hammer',
                    x: player.x, // Center on player for arc check
                    y: player.y,
                    vx: 0,
                    vy: 0,
                    angle: player.angle, // Store swing direction
                    isSuper: false,
                    owner: socket.id,
                    color: '#8b4513',
                    radius: 130, // Slightly larger for better "swing" distance
                    duration: 300,
                    startTime: Date.now(),
                    hitIds: [] // Track hits to prevent multi-hit
                });
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        delete players[socket.id];
        delete deadPlayers[socket.id];
        checkWinCondition(); // Check if someone won because of disconnect
    });
});

function checkWinCondition() {
    if (gameState !== 'PLAYING') return;

    const alivePlayers = Object.values(players).filter(p => !p.isWaiting && (p.lives > 0 || p.alive));

    // If only 1 player remains with lives
    if (alivePlayers.length <= 1) {
        const winner = alivePlayers.length === 1 ? alivePlayers[0] : null;
        const maxLives = gameMode === 'soccer' ? 2 : 3;
        const results = Object.values(players).map(p => ({
            nickname: p.nickname,
            kills: p.kills,
            deaths: maxLives - (p.lives || 0),
            isWinner: winner && p.id === winner.id
        }));

        io.emit('matchResults', {
            winner: winner ? winner.nickname : 'No one',
            results,
            mode: gameMode
        });

        // Return to Lobby state
        gameState = 'LOBBY';
        for (let id in players) {
            players[id].isReady = false;
            players[id].isWaiting = false;
            players[id].alive = true;
            players[id].health = players[id].maxHealth;
            // lives will be reset in startMatch
        }
        io.emit('lobbyUpdate', { players });
    }
}

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
            if (player.lives > 0 && now - deadPlayers[id] > 5000) {
                player.alive = true;
                player.health = player.maxHealth;
                player.superCharge = 0;
                player.ammo = player.maxAmmo;
                player.lastDamageTime = now;
                player.respawnShieldUntil = now + 3000;
                player.respawnSpeedUntil = now + 3000;
                // Position stays where they died as per user request
                delete deadPlayers[id];
            }
        }

        // DASHING PHYSICS (Authoritative)
        if (player.alive && now < player.dashingUntil) {
            const dashSpeed = 25; // Pixels per frame
            let nextX = player.x + player.dashDx * dashSpeed;
            let nextY = player.y + player.dashDy * dashSpeed;

            // Wall Collision
            if (!isCollidingWithWalls(nextX, nextY, 25)) {
                player.x = nextX;
                player.y = nextY;
            } else {
                // Cancel dash if stuck on wall? 
                player.dashingUntil = 0;
            }

            // Leave Ice Trail
            if (player.character === 'hyperswag') {
                iceTrails.push({
                    id: Math.random().toString(36).substr(2, 9),
                    x: player.x,
                    y: player.y,
                    owner: id,
                    endTime: now + 5000
                });
            }

            // Dash Collision Detection
            for (let pid in players) {
                let p = players[pid];
                if (pid !== id && p.alive) {
                    const dist = Math.sqrt(Math.pow(player.x - p.x, 2) + Math.pow(player.y - p.y, 2));
                    if (dist < 60) {
                        if (!player.dashHitIds.includes(pid)) {
                            let damage = 20;
                            if (now < (p.respawnShieldUntil || 0)) {
                                damage = 0;
                            }
                            if (damage > 0) {
                                p.health -= damage;
                                p.lastDamageTime = now;
                                player.superCharge = 100;
                                io.emit('collision', { x: player.x, y: player.y, type: 'player', damage: 20, victim: pid });
                                if (p.health <= 0) {
                                    handleDeath(pid, id);
                                }
                            }
                            player.dashHitIds.push(pid);
                        }
                    }
                }
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
        if (player.alive && now < player.spinningUntil && now > (player.respawnShieldUntil || 0)) {
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
                handleDeath(id, player.spinningOwner);
            }
        }

        // Reset temporary buffs/debuffs
        if (player.speedUntil > 0 && now > player.speedUntil) {
            player.speedMultiplier = 1.0;
            player.speedUntil = 0;
        }

        // Apply Respawn Speed Boost
        let currentSpeedMultiplier = player.speedMultiplier || 1.0;
        if (now < (player.respawnSpeedUntil || 0)) {
            currentSpeedMultiplier *= 1.5;
        }

        // HyperSwag Ice Trail Interaction
        let onIce = false;
        let isOwnIce = false;
        for (let i = iceTrails.length - 1; i >= 0; i--) {
            let trail = iceTrails[i];
            if (now > trail.endTime) {
                iceTrails.splice(i, 1);
                continue;
            }
            const dist = Math.sqrt(Math.pow(player.x - trail.x, 2) + Math.pow(player.y - trail.y, 2));
            if (dist < 40) {
                onIce = true;
                if (trail.owner === id) isOwnIce = true;
            }
        }

        if (onIce) {
            if (isOwnIce) {
                player.speedMultiplier = 2.0;
                player.speedUntil = now + 100; // Keep it active as long as on ice
            } else {
                player.speedMultiplier = 0.5;
                player.speedUntil = now + 100;
            }
        }

        // Abduction by Storm
        for (let proj of projectiles) {
            if (proj.type === 'storm' && proj.owner !== id) {
                const dist = Math.sqrt(Math.pow(player.x - proj.x, 2) + Math.pow(player.y - proj.y, 2));
                if (dist < proj.radius) {
                    // Abduct: Move player with storm
                    player.x += proj.vx;
                    player.y += proj.vy;

                    // Continuous damage (5 DPS)
                    const damage = 5 * (1 / 60);
                    if (now > (player.respawnShieldUntil || 0)) {
                        player.health -= damage;
                        player.lastDamageTime = now;
                    }

                    if (player.health <= 0) {
                        handleDeath(id, proj.owner);
                    }
                }
            }
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

        // P1 Damage
        if (now > (p1.respawnShieldUntil || 0)) {
            p1.health -= damage;
            p1.lastDamageTime = now;
        }

        // P2 Damage
        if (now > (p2.respawnShieldUntil || 0)) {
            p2.health -= damage;
            p2.lastDamageTime = now;
        }

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
            handleDeath(t.p1, null); // Tether kills are currently unattributed or shared
        }
        if (p2.health <= 0) {
            handleDeath(t.p2, null);
        }
    }

    // Projectile Movement & Collision
    for (let i = projectiles.length - 1; i >= 0; i--) {
        let proj = projectiles[i];

        // Attack Attachment: Hammers and Punches follow their owner
        if (proj.type === 'hammer' || proj.type === 'punch') {
            const owner = players[proj.owner];
            if (owner && owner.alive) {
                proj.x = owner.x;
                proj.y = owner.y;
                proj.angle = owner.angle;
            }
        } else {
            proj.x += proj.vx;
            proj.y += proj.vy;
        }

        let hitBoundary = false;

        // Wall Collision
        if (!proj.isSuper && isCollidingWithWalls(proj.x, proj.y, 10)) {
            hitBoundary = true;
            io.emit('collision', { x: proj.x, y: proj.y, type: 'wall' });
        }

        // Ball Interaction (Prioritized in Soccer Mode)
        if (gameMode === 'soccer' && !hitBoundary) {
            const dist = Math.sqrt(Math.pow(proj.x - ball.x, 2) + Math.pow(proj.y - ball.y, 2));
            const collisionRadius = ball.radius + (proj.radius || 20) + 15;

            if (dist < collisionRadius) {
                const impulseAngle = (proj.vx !== 0 || proj.vy !== 0)
                    ? Math.atan2(proj.vy, proj.vx)
                    : (proj.angle || 0);

                const power = (proj.damage || 10) / 2;
                ball.vx += Math.cos(impulseAngle) * power;
                ball.vy += Math.sin(impulseAngle) * power;

                if (proj.type !== 'hammer' && proj.type !== 'storm') {
                    projectiles.splice(i, 1);
                    continue;
                }
            }
        }

        // Player Collision
        let hitPlayer = false;
        if (!hitBoundary) {
            for (let pid in players) {
                let p = players[pid];
                if (p.alive && pid !== proj.owner) {
                    // Piercing projectiles (isSuper) only hit once per target
                    if (proj.hitIds && proj.hitIds.includes(pid)) continue;

                    const dist = Math.sqrt(Math.pow(proj.x - p.x, 2) + Math.pow(proj.y - p.y, 2));
                    const hitRadius = proj.radius || (proj.isSuper ? 40 : 35);

                    if (dist < hitRadius) {
                        // Special Check for Hammer (Arc Attack)
                        if (proj.type === 'hammer') {
                            const angleToPlayer = Math.atan2(p.y - proj.y, p.x - proj.x);
                            let angleDiff = angleToPlayer - proj.angle;
                            while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
                            while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

                            // 150 degree arc (approx half-way around)
                            if (Math.abs(angleDiff) > Math.PI * 0.4) continue;
                        }
                        let damage = 0;
                        if (proj.type === 'fireloop') damage = 20;
                        else if (proj.type === 'lightning') damage = 20;
                        else if (proj.type === 'lightningwave') damage = 50;
                        else if (proj.type === 'watch') damage = 10;
                        else if (proj.type === 'punch') damage = 17; // Nerfed from generic 25
                        else if (proj.type === 'hammer') damage = 30;
                        else if (proj.type === 'storm') damage = 30; // Burst damage per hit
                        else damage = proj.isSuper ? 100 : 25;

                        // Titus Passive: -4 damage
                        if (p.character === 'titus') {
                            damage = Math.max(0, damage - 4);
                        }

                        // Respawn Shield
                        if (now < (p.respawnShieldUntil || 0)) {
                            damage = 0;
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
                            else if (proj.type === 'lightning') chargeAmount = 50;
                            else if (proj.type === 'lightningwave') chargeAmount = 15; // Wave hits many, lower charge per hit
                            else if (proj.type === 'watch') chargeAmount = 10;
                            else if (proj.type === 'punch') chargeAmount = 12.5; // 8 punches (4 full attacks) for 100%
                            else if (proj.type === 'hammer') chargeAmount = 50; // 2 hits for 100%
                            else if (proj.type === 'storm') chargeAmount = 2; // Low charge from storm ticks
                            else chargeAmount = 20;

                            players[proj.owner].superCharge = Math.min(100, (players[proj.owner].superCharge || 0) + chargeAmount);
                        }

                        if (p.health <= 0) {
                            handleDeath(pid, proj.owner);
                        }

                        // Burst damage projectiles only hit once
                        if (proj.hitIds) {
                            proj.hitIds.push(pid);
                        }

                        if (!proj.isSuper && proj.type !== 'hammer') hitPlayer = true;
                    }
                }
            }
        }

        const hit = hitBoundary || hitPlayer || Math.abs(proj.x) > 6000 || Math.abs(proj.y) > 4000 || (proj.duration && now > (proj.startTime + proj.duration));

        if (hit) {
            projectiles.splice(i, 1);
        }
    }

    // Periodically check win condition
    checkWinCondition();

    // Soccer Ball Physics
    if (gameState === 'PLAYING' && gameMode === 'soccer') {
        updateBallPhysics(now);
    }
}, 1000 / 60);

function updateBallPhysics(now) {
    ball.x += ball.vx;
    ball.y += ball.vy;

    // Friction
    ball.vx *= ball.friction;
    ball.vy *= ball.friction;

    if (Math.abs(ball.vx) < 0.1) ball.vx = 0;
    if (Math.abs(ball.vy) < 0.1) ball.vy = 0;

    // Wall Collisions (Modified for Goals)
    let leftBound = 0;
    let rightBound = 2000;

    // If ball is within goal Y range, allow it to pass X boundaries
    const inGoalY = ball.y > 800 && ball.y < 1200;

    if (ball.x - ball.radius < 0) {
        if (!inGoalY) {
            ball.x = ball.radius;
            ball.vx *= -0.5;
        }
    }
    if (ball.x + ball.radius > 2000) {
        if (!inGoalY) {
            ball.x = 2000 - ball.radius;
            ball.vx *= -0.5;
        }
    }

    // Floor/Ceiling
    if (ball.y - ball.radius < 0) {
        ball.y = ball.radius;
        ball.vy *= -0.5;
    }
    if (ball.y + ball.radius > 2000) {
        ball.y = 2000 - ball.radius;
        ball.vy *= -0.5;
    }

    // Reset if it goes too far out of bounds (just in case)
    if (ball.x < -100 || ball.x > 2100) {
        ball.x = 1000;
        ball.y = 1000;
        ball.vx = 0;
        ball.vy = 0;
    }

    // Scoring
    checkSoccerGoal(now);
}

function checkSoccerGoal(now) {
    // Check left goal
    if (ball.x < 50 && ball.y > 800 && ball.y < 1200) {
        scorePoint('left');
    }
    // Check right goal
    if (ball.x > 1950 && ball.y > 800 && ball.y < 1200) {
        scorePoint('right');
    }
}

function scorePoint(side) {
    const ownerId = SOCCER_GOALS[side].owner;
    if (ownerId && players[ownerId]) {
        players[ownerId].lives--;
        io.emit('killNotification', { killer: 'GOAL', victim: ownerId });

        // Reset ball
        ball.x = 1000;
        ball.y = 1000;
        ball.vx = 0;
        ball.vy = 0;

        if (players[ownerId].lives <= 0) {
            players[ownerId].alive = false;
        }
    }
}

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

const NEAR_RADIUS = 150;

function isVisible(viewer, target, now) {
    if (viewer.id === target.id) return true;

    // Check if target is in a bush
    let inBush = false;
    for (const bush of BUSH_RECTS) {
        if (target.x >= bush.x && target.x <= bush.x + bush.w &&
            target.y >= bush.y && target.y <= bush.y + bush.h) {
            inBush = true;
            break;
        }
    }

    if (!inBush) return true;

    // Target is in a bush. Check proximity or if they shot recently.
    const dist = Math.sqrt(Math.pow(viewer.x - target.x, 2) + Math.pow(viewer.y - target.y, 2));
    if (dist < NEAR_RADIUS) return true;

    if (now - (target.lastShootTime || 0) < 2000) return true;

    return false;
}

// Broadcast Loop (20Hz) - Reduces bandwidth and congestion
setInterval(() => {
    const now = Date.now();
    for (let viewerId in players) {
        let viewer = players[viewerId];
        // Dead players still need state updates to see their health at 0 and spectator updates

        let visiblePlayers = {};
        for (let tid in players) {
            if (isVisible(viewer, players[tid], now)) {
                visiblePlayers[tid] = players[tid];
            }
        }

        io.to(viewerId).emit('state', {
            players: visiblePlayers,
            projectiles,
            powerups,
            iceTrails,
            ball: (gameMode === 'soccer') ? ball : null,
            mode: gameMode,
            state: gameState,
            ts: now
        });
    }
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
