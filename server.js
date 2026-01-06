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

// World Dimensions
const WORLD_WIDTH = 5760;
const WORLD_HEIGHT = 3240;

const WALL_RECTS = [
    // Interior Obstacles (Original Cluster at Center)
    { x: 2880 - 300, y: 1620 - 250, w: 120, h: 150 },
    { x: 2880 + 180, y: 1620 - 250, w: 120, h: 150 },
    { x: 2880 - 300, y: 1620 + 100, w: 120, h: 150 },
    { x: 2880 + 180, y: 1620 + 100, w: 120, h: 150 },
    { x: 2880 - 80, y: 1620 - 120, w: 160, h: 80 },
    { x: 2880 - 80, y: 1620 + 40, w: 160, h: 80 },

    // Top-Left Cluster
    { x: 500, y: 500, w: 300, h: 40 },
    { x: 500, y: 500, w: 40, h: 300 },
    { x: 1000, y: 800, w: 200, h: 200 },

    // Top-Right Cluster
    { x: 4500, y: 600, w: 400, h: 40 },
    { x: 4700, y: 300, w: 40, h: 600 },

    // Bottom-Left Cluster
    { x: 600, y: 2500, w: 100, h: 500 },
    { x: 1200, y: 2400, w: 400, h: 100 },

    // Bottom-Right Cluster
    { x: 4800, y: 2500, w: 300, h: 300 },
    { x: 4200, y: 2800, w: 500, h: 50 },

    // Middle-Edge Clusters
    { x: 100, y: 1500, w: 300, h: 100 },
    { x: 5360, y: 1500, w: 300, h: 100 },
    { x: 2700, y: 100, w: 400, h: 100 },
    { x: 2700, y: 3040, w: 400, h: 100 },

    // Scattered Pillars
    { x: 1500, y: 1500, w: 60, h: 60 },
    { x: 4000, y: 1500, w: 60, h: 60 },
    { x: 1500, y: 2000, w: 60, h: 60 },
    { x: 4000, y: 2000, w: 60, h: 60 },

    // BOUNDARIES
    { x: 0, y: 0, w: WORLD_WIDTH, h: 40 },           // Top
    { x: 0, y: WORLD_HEIGHT - 40, w: WORLD_WIDTH, h: 40 }, // Bottom
    { x: 0, y: 0, w: 40, h: WORLD_HEIGHT },          // Left
    { x: WORLD_WIDTH - 40, y: 0, w: 40, h: WORLD_HEIGHT } // Right
];

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

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    const { x, y } = getSafeSpawn();

    players[socket.id] = {
        x: x,
        y: y,
        color: `rgb(${Math.floor(Math.random() * 255)}, ${Math.floor(Math.random() * 255)}, ${Math.floor(Math.random() * 255)})`,
        alive: true,
        health: 100,
        id: socket.id,
        angle: 0,
        superCharge: 0,
        lastDamageTime: Date.now(),
        ammo: 3,
        maxAmmo: 3,
        reloadTimer: 0,
        reloadDelay: 2000, // 2 seconds
    };

    socket.emit('init', { id: socket.id, players });

    socket.on('update', (data) => {
        const player = players[socket.id];
        if (!player || !player.alive) return;

        // Update Position & Angle
        player.x = data.x;
        player.y = data.y;
        player.angle = data.angle;

        // Healing logic...
        if (player.health < 100) {
            const timeSinceHit = (Date.now() - player.lastDamageTime) / 1000;
            if (timeSinceHit > 2.0) {
                const regenSpeed = 2.5 + Math.pow(timeSinceHit - 2.0, 2) * 5;
                player.health = Math.min(100, player.health + regenSpeed * (1 / 60));
            }
        }
    });

    socket.on('shoot', (data) => {
        const player = players[socket.id];
        if (!player || !player.alive) return;

        const isSuper = data.isSuper || false;

        // Validation
        if (isSuper) {
            if (player.superCharge < 100) return;
            player.superCharge = 0;
        } else {
            if (player.ammo <= 0) return;
            player.ammo--;
            if (player.reloadTimer === 0) player.reloadTimer = Date.now();
        }

        const dx = Math.cos(player.angle);
        const dy = Math.sin(player.angle);

        projectiles.push({
            id: Math.random().toString(36).substr(2, 9),
            x: player.x + dx * 40,
            y: player.y + dy * 40,
            vx: dx * (isSuper ? 25 : 15),
            vy: dy * (isSuper ? 25 : 15),
            isSuper: isSuper,
            owner: socket.id,
            color: isSuper ? '#ff00ff' : '#00ffff'
        });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        delete players[socket.id];
        delete deadPlayers[socket.id];
    });
});

// Server Loop for Respawn and Broadcast
setInterval(() => {
    const now = Date.now();

    // Check Respawns and Ammo Recharge
    for (let id in players) {
        let player = players[id];

        // Respawn check
        if (!player.alive && deadPlayers[id]) {
            if (now - deadPlayers[id] > 5000) {
                const { x, y } = getSafeSpawn();
                player.alive = true;
                player.health = 100;
                player.superCharge = 0;
                player.ammo = 3; // Reset ammo
                player.lastDamageTime = now;
                player.x = x;
                player.y = y;
                delete deadPlayers[id];
            }
        }

        // Ammo Recharge (Global Tick)
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
    }

    // Authoritative Physics Segment
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
                    const dist = Math.sqrt(Math.pow(proj.x - p.x, 2) + Math.pow(proj.y - p.y, 2));
                    const hitRadius = proj.isSuper ? 40 : 35;

                    if (dist < hitRadius) {
                        const damage = proj.isSuper ? 100 : 25;
                        p.health -= damage;
                        p.lastDamageTime = now;

                        io.emit('collision', { x: proj.x, y: proj.y, type: 'player', damage, victim: pid });

                        // Charge super for owner
                        if (!proj.isSuper && players[proj.owner]) {
                            players[proj.owner].superCharge = Math.min(100, (players[proj.owner].superCharge || 0) + 25);
                        }

                        if (p.health <= 0) {
                            p.health = 0;
                            p.alive = false;
                            deadPlayers[pid] = now;
                        }

                        if (!proj.isSuper) hitPlayer = true;
                    }
                }
            }
        }

        // Out of bounds cleanup
        const hit = hitBoundary || hitPlayer || Math.abs(proj.x) > 5000 || Math.abs(proj.y) > 5000;

        if (hit) {
            projectiles.splice(i, 1);
        }
    }

    io.emit('state', { players, projectiles });
}, 1000 / 60);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
