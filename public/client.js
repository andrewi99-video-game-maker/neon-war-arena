const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const socket = io();

// UI Elements
const uiAlive = document.getElementById('alive-count');
const uiKills = document.getElementById('kill-count');
const uiHealthBar = document.getElementById('health-bar');
const uiHealthText = document.getElementById('health-text');
const uiSuperBar = document.getElementById('super-bar');
const uiSuperText = document.getElementById('super-text');
const uiAmmoContainer = document.getElementById('ammo-container');
const uiSuperZone = document.getElementById('super-btn-zone'); // Mobile Super Zone
const minimapCanvas = document.getElementById('minimapCanvas');
const minimapCtx = minimapCanvas ? minimapCanvas.getContext('2d') : null;
const deathScreen = document.getElementById('death-screen');
const respawnTimer = document.getElementById('respawn-timer');
const selectionScreen = document.getElementById('selection-screen');
const uiLayer = document.getElementById('ui-layer');
const btnTitus = document.getElementById('select-titus');
const btnAndrew = document.getElementById('select-andrew');

// Virtual Resolution for Fair Scaling
const VIRTUAL_WIDTH = 1920;
const VIRTUAL_HEIGHT = 1080;
let gameScale = 1;
let gameOffsetX = 0;
let gameOffsetY = 0;

// Assets (Deprecated in favor of geometric art, keeping for ground if needed)
const assets = {
    ground: new Image()
};
assets.ground.src = '/assets/ground.png';

// Sound Manager (Procedural Audio)
const Sound = {
    ctx: null,
    init() {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    },
    play(freq, type, duration, volume) {
        if (!this.ctx) return;
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(10, this.ctx.currentTime + duration);
        gain.gain.setValueAtTime(volume, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start();
        osc.stop(this.ctx.currentTime + duration);
    },
    shoot() { this.play(800, 'square', 0.1, 0.1); },
    super() { this.play(400, 'sawtooth', 0.3, 0.2); },
    wave() {
        this.play(150, 'sine', 0.8, 0.3); // Low rumbing wave
        setTimeout(() => this.play(400, 'sawtooth', 0.4, 0.1), 50); // Lightning crackle
    },
    hit() { this.play(200, 'sine', 0.05, 0.1); },
    death() { this.play(100, 'sawtooth', 0.5, 0.3); },
    wallHit() { this.play(150, 'sine', 0.1, 0.05); }
};

// Particles / Impact Effects
const Effects = {
    particles: [],
    spawn(x, y, color, count = 8) {
        for (let i = 0; i < count; i++) {
            this.particles.push({
                x, y,
                vx: (Math.random() - 0.5) * 10,
                vy: (Math.random() - 0.5) * 10,
                life: 1.0,
                color: color
            });
        }
    },
    update() {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx;
            p.y += p.vy;
            p.life -= 0.05;
            if (p.life <= 0) this.particles.splice(i, 1);
        }
    },
    draw(ctx) {
        this.particles.forEach(p => {
            ctx.globalAlpha = p.life;
            ctx.strokeStyle = p.color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x + p.vx * 2, p.y + p.vy * 2);
            ctx.stroke();
        });
        ctx.globalAlpha = 1.0;
    }
};

window.addEventListener('mousedown', () => Sound.init(), { once: true });
window.addEventListener('keydown', () => Sound.init(), { once: true });

// Game State
const input = {
    w: false, a: false, s: false, d: false,
    mouseX: 0, mouseY: 0, mouseDown: false
};

let myId = null;
let myCharacter = null;
let players = {};
let powerups = [];
let lightningTethers = []; // { p1, p2, life }
let iceTrails = []; // { x, y, owner, life }
let projectiles = []; // Client-side projectile simulation for local responsiveness
let camera = { x: 0, y: 0 };
let lastShootTime = 0;

// Interpolation state
let networkState = {
    prev: null,
    current: null,
    lastTime: 0
};
const INTERP_OFFSET = 100; // ms of buffer

// Mobile State
let isMobile = false;
// Simple check: if touch events supported
if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
    isMobile = true;
    document.getElementById('mobile-controls').classList.add('visible');
}

const TouchControls = {
    left: { active: false, id: null, startX: 0, startY: 0, dx: 0, dy: 0 },
    right: { active: false, id: null, startX: 0, startY: 0, dx: 0, dy: 0, angle: 0 },
    super: { active: false, id: null, startX: 0, startY: 0, dx: 0, dy: 0, angle: 0 }
};

function handleJoystick(touch, type, stickEl, baseEl) {
    const rect = baseEl.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const maxDist = rect.width / 2;
    let dx = touch.clientX - centerX;
    let dy = touch.clientY - centerY;

    const dist = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);

    // Clamp visual
    let visualDist = Math.min(dist, maxDist);
    stickEl.style.transform = `translate(calc(-50% + ${Math.cos(angle) * visualDist}px), calc(-50% + ${Math.sin(angle) * visualDist}px))`;

    // Normalize for input (0 to 1)
    if (dist > 10) { // Deadzone
        if (type === 'left') {
            input.w = dy < -20;
            input.s = dy > 20;
            input.a = dx < -20;
            input.d = dx > 20;
            // Also store normalized vector for smoother movement if we supported analog
        } else if (type === 'right') {
            TouchControls.right.angle = angle;
            if (myId && players[myId]) players[myId].angle = angle;
            // Shoot on release, so just tracking aim now
        } else if (type === 'super') {
            TouchControls.super.angle = angle;
            if (myId && players[myId]) players[myId].angle = angle;
        }
    }
}

function resetJoystick(stickEl) {
    stickEl.style.transform = `translate(-50%, -50%)`;
}

// Mobile Handlers
if (isMobile) {
    const zoneLeft = document.getElementById('joystick-zone-left');
    const stickLeft = document.getElementById('joystick-move').querySelector('.stick');
    const zoneRight = document.getElementById('joystick-zone-right');
    const stickRight = document.getElementById('joystick-aim').querySelector('.stick');
    const zoneSuper = document.getElementById('super-btn-zone');
    const stickSuper = document.getElementById('super-btn').querySelector('.stick');

    // Left Stick (Move)
    zoneLeft.addEventListener('touchstart', e => {
        e.preventDefault();
        const t = e.changedTouches[0];
        TouchControls.left.id = t.identifier;
        TouchControls.left.active = true;
        handleJoystick(t, 'left', stickLeft, document.getElementById('joystick-move'));
    });
    zoneLeft.addEventListener('touchmove', e => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier === TouchControls.left.id) {
                handleJoystick(e.changedTouches[i], 'left', stickLeft, document.getElementById('joystick-move'));
            }
        }
    });
    zoneLeft.addEventListener('touchend', e => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier === TouchControls.left.id) {
                TouchControls.left.active = false;
                resetJoystick(stickLeft);
                input.w = input.s = input.a = input.d = false;
            }
        }
    });

    // Right Stick (Aim & Shoot)
    zoneRight.addEventListener('touchstart', e => {
        e.preventDefault();
        const t = e.changedTouches[0];
        TouchControls.right.id = t.identifier;
        TouchControls.right.active = true;
        handleJoystick(t, 'right', stickRight, document.getElementById('joystick-aim'));
    });
    zoneRight.addEventListener('touchmove', e => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier === TouchControls.right.id) {
                handleJoystick(e.changedTouches[i], 'right', stickRight, document.getElementById('joystick-aim'));
            }
        }
    });
    zoneRight.addEventListener('touchend', e => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier === TouchControls.right.id) {
                // FIRE ON RELEASE
                if (players[myId].ammo > 0 && Date.now() - lastShootTime > 300) {
                    shoot(false);
                    players[myId].ammo--;
                    lastShootTime = Date.now();
                }
                TouchControls.right.active = false;
                resetJoystick(stickRight);
            }
        }
    });

    // Super Stick
    zoneSuper.addEventListener('touchstart', e => {
        e.preventDefault();
        const t = e.changedTouches[0];
        TouchControls.super.id = t.identifier;
        TouchControls.super.active = true;
        handleJoystick(t, 'super', stickSuper, document.getElementById('super-btn'));
    });
    zoneSuper.addEventListener('touchmove', e => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier === TouchControls.super.id) {
                handleJoystick(e.changedTouches[i], 'super', stickSuper, document.getElementById('super-btn'));
            }
        }
    });
    zoneSuper.addEventListener('touchend', e => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier === TouchControls.super.id) {
                // FIRE SUPER ON RELEASE
                if (players[myId].superCharge >= 100) {
                    shoot(true);
                    players[myId].superCharge = 0;
                }
                TouchControls.super.active = false;
                resetJoystick(stickSuper);
            }
        }
    });
}

const WORLD_WIDTH = 2000;
const WORLD_HEIGHT = 2000;

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

// Resize Canvas
function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

// Input Handling
window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (input.hasOwnProperty(key)) input[key] = true;
});
window.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    if (input.hasOwnProperty(key)) input[key] = false;
    if (key === 't') {
        socket.emit('toggleUnlimitedAmmo');
    }
});
window.addEventListener('mousemove', (e) => {
    input.mouseX = e.clientX;
    input.mouseY = e.clientY;
});
window.addEventListener('mousedown', () => input.mouseDown = true);
window.addEventListener('mouseup', () => input.mouseDown = false);
window.addEventListener('contextmenu', (e) => e.preventDefault()); // Disable right-click menu

// Networking
socket.on('init', (data) => {
    myId = data.id;
    players = data.players;
});

socket.on('state', (data) => {
    const serverPlayers = data.players;
    const serverProjectiles = data.projectiles;

    // Interpolation Setup
    networkState.prev = networkState.current;
    networkState.current = serverPlayers;
    networkState.lastTime = Date.now();

    // Immediate updates for non-positional data
    if (myId && serverPlayers[myId]) {
        const me = players[myId]; // Local player (predicted)
        const sMe = serverPlayers[myId];
        me.health = sMe.health;
        me.maxHealth = sMe.maxHealth;
        me.alive = sMe.alive;
        me.ammo = sMe.ammo;
        me.superCharge = sMe.superCharge;
        me.maxAmmo = sMe.maxAmmo;
        me.character = sMe.character;
        me.speedMultiplier = sMe.speedMultiplier;
        me.frozenUntil = sMe.frozenUntil;
        me.unlimitedAmmoUntil = sMe.unlimitedAmmoUntil;
        me.kills = sMe.kills || 0;

        // UI Updates
        if (uiKills) uiKills.innerText = me.kills;
        uiHealthBar.style.width = `${(me.health / me.maxHealth) * 100}%`;
        uiHealthText.innerText = `${Math.ceil(me.health)}/${me.maxHealth}`;
        uiSuperBar.style.width = `${me.superCharge}%`;
        uiSuperText.innerText = `${Math.floor(me.superCharge)}%`;

        // Update ammo clips
        uiAmmoContainer.innerHTML = '';
        const maxAmmoSlots = me.maxAmmo || 3;
        for (let i = 0; i < maxAmmoSlots; i++) {
            const slot = document.createElement('div');
            let className = 'ammo-slot';
            if (sMe.unlimitedAmmo || (me.unlimitedAmmoUntil && Date.now() < me.unlimitedAmmoUntil)) {
                className += ' filled unlimited';
            } else if (i < me.ammo) {
                className += ' filled';
            }
            slot.className = className;
            uiAmmoContainer.appendChild(slot);
        }

        if (me.alive) {
            deathScreen.classList.add('hidden');
        } else {
            if (deathScreen.classList.contains('hidden')) Sound.death();
            deathScreen.classList.remove('hidden');
        }

        // Mobile Super Button State
        if (isMobile && uiSuperZone) {
            if (me.superCharge >= 100) {
                uiSuperZone.style.opacity = '1';
                uiSuperZone.style.pointerEvents = 'auto';
            } else {
                uiSuperZone.style.opacity = '0.3';
                uiSuperZone.style.pointerEvents = 'none';
            }
        }
    }

    // Process other players and projectiles
    projectiles = serverProjectiles;
    powerups = data.powerups || [];
    iceTrails = data.iceTrails || [];

    let aliveCount = 0;
    for (let id in serverPlayers) {
        if (serverPlayers[id].alive) aliveCount++;
        // If we don't have this player yet, add them
        if (!players[id]) {
            players[id] = { ...serverPlayers[id] };
        } else {
            // SYNC properties
            if (id !== myId) {
                players[id].x = serverPlayers[id].x;
                players[id].y = serverPlayers[id].y;
                players[id].angle = serverPlayers[id].angle;
            }
            players[id].health = serverPlayers[id].health;
            players[id].maxHealth = serverPlayers[id].maxHealth;
            players[id].alive = serverPlayers[id].alive;
            players[id].character = serverPlayers[id].character;
            players[id].superCharge = serverPlayers[id].superCharge;
            players[id].speedMultiplier = serverPlayers[id].speedMultiplier;
            players[id].frozenUntil = serverPlayers[id].frozenUntil;
            players[id].unlimitedAmmoUntil = serverPlayers[id].unlimitedAmmoUntil;
            players[id].spinningUntil = serverPlayers[id].spinningUntil;
            players[id].hasShield = serverPlayers[id].hasShield;
            players[id].dashingUntil = serverPlayers[id].dashingUntil;
            players[id].dashDx = serverPlayers[id].dashDx;
            players[id].dashDy = serverPlayers[id].dashDy;
        }
    }
    // Clean up
    for (let id in players) {
        if (!serverPlayers[id] && id !== myId) delete players[id];
    }

    if (uiAlive) uiAlive.innerText = aliveCount;
});

socket.on('collision', (data) => {
    if (data.type === 'wall') {
        Sound.wallHit();
        Effects.spawn(data.x, data.y, '#00ff44', 10);
    } else if (data.type === 'player') {
        Sound.hit();
        Effects.spawn(data.x, data.y, '#ff0000', 15);
        if (data.victim === myId) {
            // Shake or subtle visual when hit?
        }
    }
});

socket.on('hitConfirm', (data) => {
    Sound.hit();
    // Spooky: we don't know the exact coords from hitConfirm in current server,
    // but we can assume it hit near our aim or where bullets are.
    // Actually, let's just use Sound for now.
});

socket.on('state', (data) => {
    const serverProjectiles = data.projectiles;

    // Check for "removed" projectiles to show impact
    // (Simple hack: if a projectile exists in old state but not new, it hit something)
    // Actually, better to send a 'collision' event from server.
});

// Game Loop
function update() {
    if (!myId || !players[myId]) return;

    const me = players[myId];
    if (!me.alive || Date.now() < (me.frozenUntil || 0) || Date.now() < (me.spinningUntil || 0)) return;

    // CLIENT-SIDE DASH PREDICTION
    if (Date.now() < (me.dashingUntil || 0)) {
        const dashSpeed = 25;
        const dx = me.dashDx || 0;
        const dy = me.dashDy || 0;

        let nextX = me.x + dx * dashSpeed;
        let nextY = me.y + dy * dashSpeed;

        // Visual collision check (rough)
        let collided = false;
        for (const wall of WALL_RECTS) {
            const closestX = Math.max(wall.x, Math.min(nextX, wall.x + wall.w));
            const closestY = Math.max(wall.y, Math.min(nextY, wall.y + wall.h));
            const dist = Math.sqrt(Math.pow(nextX - closestX, 2) + Math.pow(nextY - closestY, 2));
            if (dist < 30) {
                collided = true;
                break;
            }
        }
        if (!collided) {
            me.x = nextX;
            me.y = nextY;
        }
        return; // Skip manual movement while dashing
    }

    const speed = 5 * (me.speedMultiplier || 1.0); // Pixels per frame
    let dx = 0;
    let dy = 0;

    if (input.w) dy -= speed;
    if (input.s) dy += speed;
    if (input.a) dx -= speed;
    if (input.d) dx += speed;

    // Normalize diagonal
    if (dx !== 0 && dy !== 0) {
        const factor = 1 / Math.sqrt(2);
        dx *= factor;
        dy *= factor;
    }

    // Client-side prediction with Sliding Collisions
    const collisionRadius = 30; // Radius 25 + 5 buffer

    // Try X movement independently
    let newX = me.x + dx;
    let xCollided = false;
    for (const wall of WALL_RECTS) {
        const closestX = Math.max(wall.x, Math.min(newX, wall.x + wall.w));
        const closestY = Math.max(wall.y, Math.min(me.y, wall.y + wall.h));
        const dist = Math.sqrt(Math.pow(newX - closestX, 2) + Math.pow(me.y - closestY, 2));
        if (dist < collisionRadius) {
            xCollided = true;
            break;
        }
    }
    if (!xCollided) me.x = newX;

    // Try Y movement independently
    let newY = me.y + dy;
    let yCollided = false;
    for (const wall of WALL_RECTS) {
        const closestX = Math.max(wall.x, Math.min(me.x, wall.x + wall.w));
        const closestY = Math.max(wall.y, Math.min(newY, wall.y + wall.h));
        const dist = Math.sqrt(Math.pow(me.x - closestX, 2) + Math.pow(newY - closestY, 2));
        if (dist < collisionRadius) {
            yCollided = true;
            break;
        }
    }
    if (!yCollided) me.y = newY;

    // Only calculate angle from mouse if NOT using touch joysticks
    if (!TouchControls.right.active && !TouchControls.super.active) {
        const screenCX = canvas.width / 2;
        const screenCY = canvas.height / 2;
        me.angle = Math.atan2(input.mouseY - screenCY, input.mouseX - screenCX);
    }
}

// Shooting Listener separate from loop to handle single clicks/keys better
window.addEventListener('keydown', (e) => {
    if ((e.code === 'Space' || e.key === ' ') && myId && players[myId] && players[myId].alive) {
        if (players[myId].superCharge >= 100) {
            shoot(true);
        }
    }
});

let lastSuperTime = 0;

window.addEventListener('mousedown', (e) => {
    if (myId && players[myId] && players[myId].alive) {
        if (Date.now() < (players[myId].frozenUntil || 0)) return;
        if (e.button === 0) { // Left Click - Shoot
            if (players[myId].ammo > 0 && Date.now() - lastShootTime > 300) {
                shoot(false);
                players[myId].ammo--;
                lastShootTime = Date.now();
            }
        } else if (e.button === 2) { // Right Click - Super
            const now = Date.now();
            if (players[myId].superCharge >= 100 && now - lastSuperTime > 1000) {
                shoot(true);
                players[myId].superCharge = 0;
                lastSuperTime = now;
            }
        }
    }
});

function shoot(isSuper) {
    let payload = { isSuper };

    if (isSuper) {
        const me = players[myId];
        if (me) {
            if (me.character === 'drandrew') Sound.wave();
            else Sound.super();

            // HyperSwag Super: Send Target Coordinates
            if (me.character === 'hyperswag') {
                // Calculate World Coordinates from Mouse/Camera
                // camera.x is top-left of screen in world coords
                // input.mouseX is screen coords
                payload.targetX = camera.x + input.mouseX;
                payload.targetY = camera.y + input.mouseY;

                // Mobile override (approximate direction -> distance)
                if (TouchControls.super.active) {
                    const range = 400; // Fixed dash range for mobile stick
                    payload.targetX = me.x + Math.cos(TouchControls.super.angle) * range;
                    payload.targetY = me.y + Math.sin(TouchControls.super.angle) * range;
                }
            }
        }
    } else {
        Sound.shoot();
    }
    socket.emit('shoot', payload);
}

// Update Loop Frequency
setInterval(() => {
    update();
    Effects.update();

    if (myId && players[myId]) {
        // Send state to server
        socket.emit('update', {
            x: players[myId].x,
            y: players[myId].y,
            angle: players[myId].angle
        });
    }
}, 1000 / 60);

// Rendering Loop
function draw() {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!myId || !players[myId]) {
        requestAnimationFrame(draw);
        return;
    }

    const me = players[myId];
    const renderTime = Date.now() - INTERP_OFFSET;

    // Camera follows player
    camera.x = me.x - canvas.width / 2;
    camera.y = me.y - canvas.height / 2;

    // Optimized Background Drawing
    if (assets.ground.complete) {
        ctx.save();
        const ptrn = ctx.createPattern(assets.ground, 'repeat');
        ctx.fillStyle = ptrn;
        ctx.translate(-camera.x, -camera.y);
        ctx.fillRect(camera.x, camera.y, canvas.width, canvas.height);
        ctx.restore();
    }

    ctx.save();
    ctx.translate(-camera.x, -camera.y);

    // Draw Walls (Simplified rendering)
    ctx.strokeStyle = '#00ff44';
    ctx.lineWidth = 2;
    for (const wall of WALL_RECTS) {
        ctx.strokeRect(wall.x, wall.y, wall.w, wall.h);
        ctx.beginPath();
        ctx.moveTo(wall.x, wall.y); ctx.lineTo(wall.x + wall.w, wall.y + wall.h);
        ctx.moveTo(wall.x + wall.w, wall.y); ctx.lineTo(wall.x, wall.y + wall.h);
        ctx.stroke();
    }

    // Draw Bushes
    ctx.save();
    for (const bush of BUSH_RECTS) {
        ctx.fillStyle = 'rgba(20, 60, 20, 0.7)';
        ctx.strokeStyle = '#228822';
        ctx.lineWidth = 2;

        // Main Bush Box
        ctx.fillRect(bush.x, bush.y, bush.w, bush.h);
        ctx.strokeRect(bush.x, bush.y, bush.w, bush.h);

        // Clumpy Leaf Details
        ctx.fillStyle = 'rgba(30, 100, 30, 0.8)';
        const count = Math.floor((bush.w * bush.h) / 3000); // Scale with size
        for (let i = 0; i < count; i++) {
            const rx = bush.x + (i * 37 % bush.w);
            const ry = bush.y + (i * 23 % bush.h);
            ctx.beginPath();
            ctx.arc(rx, ry, 15, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    ctx.restore();

    // Draw Ice Trails
    iceTrails.forEach(trail => {
        ctx.save();
        ctx.translate(trail.x, trail.y);
        ctx.fillStyle = 'rgba(0, 255, 255, 0.3)';
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#00ffff';
        ctx.beginPath();
        ctx.arc(0, 0, 40, 0, Math.PI * 2);
        ctx.fill();
        // Add some "ice" sparkles
        ctx.fillStyle = '#fff';
        for (let i = 0; i < 3; i++) {
            ctx.fillRect((Math.random() - 0.5) * 40, (Math.random() - 0.5) * 40, 2, 2);
        }
        ctx.restore();
    });

    // Draw Players with Interpolation
    for (const id in players) {
        if (!players[id].alive) continue;

        const p = players[id];
        let drawX = p.x;
        let drawY = p.y;
        let drawAngle = p.angle;

        // Interpolate others
        if (id !== myId && networkState.prev && networkState.current) {
            const pStart = networkState.prev[id];
            const pEnd = networkState.current[id];
            if (pStart && pEnd) {
                const total = networkState.lastTime - (networkState.lastTime - 50); // Rough interval
                const t = Math.min(1, Math.max(0, (renderTime - (networkState.lastTime - INTERP_OFFSET)) / 50));
                drawX = pStart.x + (pEnd.x - pStart.x) * t;
                drawY = pStart.y + (pEnd.y - pStart.y) * t;
                // Simple angle lerp
                let diff = pEnd.angle - pStart.angle;
                if (diff > Math.PI) diff -= Math.PI * 2;
                if (diff < -Math.PI) diff += Math.PI * 2;
                drawAngle = pStart.angle + diff * t;
            }
        }

        ctx.save();
        ctx.translate(drawX, drawY);
        ctx.rotate(drawAngle);

        const isMe = (id === myId);
        let primaryColor = isMe ? '#00ffff' : '#ff3300';
        let secondaryColor = isMe ? '#0088ff' : '#991100';

        if (p.character === 'titus') {
            primaryColor = isMe ? '#ffbb00' : '#ff6600';
            secondaryColor = isMe ? '#ff8800' : '#aa4400';
        } else if (p.character === 'hyperswag') {
            primaryColor = isMe ? '#00ffff' : '#88ffff';
            secondaryColor = isMe ? '#ffffff' : '#ccffff';
        }

        // Optimized Body Drawing (reduced shadowBlur)
        if (isMe) {
            ctx.shadowBlur = 15;
            ctx.shadowColor = primaryColor;
        }

        ctx.strokeStyle = primaryColor;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, 25, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = secondaryColor;
        ctx.beginPath();
        ctx.moveTo(10, 0); ctx.lineTo(-10, -8); ctx.lineTo(-10, 8); ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(25, 0); ctx.lineTo(40, 0);
        ctx.stroke();

        // TITUS WATCH (If spinning)
        if (Date.now() < p.spinningUntil) {
            ctx.rotate(Date.now() / 100);
            ctx.strokeStyle = '#ffff00';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(0, 0, 80, 0, Math.PI * 2); // Match server radius 80
            ctx.stroke();
            // Clock hands
            ctx.moveTo(0, 0); ctx.lineTo(0, -70);
            ctx.moveTo(0, 0); ctx.lineTo(50, 0);
            ctx.stroke();
        }

        // DR ANDREW SHIELD
        if (p.hasShield) {
            ctx.strokeStyle = '#00ffff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(0, 0, 35, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 0.2;
            ctx.fillStyle = '#00ffff';
            ctx.fill();
            ctx.globalAlpha = 1.0;
        }

        ctx.restore();

        // UI Above Head
        const barWidth = 60;
        const barHeight = 8;
        const barY = drawY - 50;

        // Health Bar Background & Border
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(drawX - barWidth / 2, barY, barWidth, barHeight);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.strokeRect(drawX - barWidth / 2, barY, barWidth, barHeight);

        // Health Fill
        ctx.fillStyle = id === myId ? '#00ff44' : '#ff3300';
        if (p.character === 'titus') ctx.fillStyle = '#ffbb00';
        if (p.character === 'drandrew') ctx.fillStyle = '#00ffff';
        if (p.character === 'hyperswag') ctx.fillStyle = '#ffffff';
        ctx.fillRect(drawX - barWidth / 2, barY, barWidth * (p.health / (p.maxHealth || 100)), barHeight);

        // Character Name & Health Text Above Bar
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px Arial';
        ctx.textAlign = 'center';
        const name = p.character === 'titus' ? 'Titus' : (p.character === 'drandrew' ? 'Dr. Andrew' : (p.character === 'hyperswag' ? 'HyperSwag' : 'Player'));
        ctx.fillText(`${name} ${Math.ceil(p.health)}/${p.maxHealth || 100}`, drawX, barY - 5);

        // Ammo Bar (Local Player Only)
        if (id === myId) {
            const ammoBarY = barY + barHeight + 5;
            const ammoGap = 4;
            const maxAmmo = p.maxAmmo || 3;
            const segWidth = (barWidth - (ammoGap * (maxAmmo - 1))) / maxAmmo;

            for (let i = 0; i < maxAmmo; i++) {
                const segX = (drawX - barWidth / 2) + (i * (segWidth + ammoGap));

                // Background & Border
                ctx.fillStyle = 'rgba(0,0,0,0.7)';
                ctx.fillRect(segX, ammoBarY, segWidth, 6);
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1;
                ctx.strokeRect(segX, ammoBarY, segWidth, 6);

                // Fill if ammo exists
                if (i < p.ammo) {
                    ctx.fillStyle = '#ffff00';
                    ctx.fillRect(segX, ammoBarY, segWidth, 6);
                }
            }
        }
    }

    // Projectiles
    projectiles.forEach(proj => {
        ctx.save();
        ctx.translate(proj.x, proj.y);

        if (proj.type === 'fireloop') {
            ctx.rotate(Date.now() / 100);
            ctx.strokeStyle = '#ffbb00';
            ctx.lineWidth = 4;
            ctx.shadowBlur = 10;
            ctx.shadowColor = '#ff4400';

            // Rings
            ctx.beginPath();
            ctx.arc(0, 0, 12, 0, Math.PI * 2);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(0, 0, 18, 0, Math.PI * 2);
            ctx.strokeStyle = '#ff4400';
            ctx.stroke();

            // Rotating Fire Orbit
            for (let i = 0; i < 3; i++) {
                ctx.rotate(Math.PI * 2 / 3);
                ctx.fillStyle = '#ffcc00';
                ctx.beginPath();
                ctx.arc(20, 0, 4, 0, Math.PI * 2);
                ctx.fill();
            }
        } else if (proj.type === 'watch') {
            ctx.strokeStyle = '#ffff00';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.arc(0, 0, 80, 0, Math.PI * 2); // Match server radius 80
            ctx.stroke();
            ctx.moveTo(0, 0); ctx.lineTo(0, -60);
            ctx.rotate(Date.now() / 50);
            ctx.lineTo(40, 0);
            ctx.stroke();
        } else if (proj.type === 'lightning' || proj.type === 'lightningwave') {
            const angle = Math.atan2(proj.vy, proj.vx);
            ctx.rotate(angle);
            ctx.strokeStyle = '#ffffff';
            ctx.shadowBlur = 15;
            ctx.shadowColor = '#00ffff';
            ctx.lineWidth = proj.type === 'lightningwave' ? 8 : 9;
            ctx.beginPath();

            if (proj.type === 'lightningwave') {
                // Draw a wide curved wave
                const width = 200; // Radius from server
                const segments = 20;
                const curve = 40; // How much it bends forward in the middle

                ctx.moveTo(0, -width);
                for (let i = -width; i <= width; i += width * 2 / segments) {
                    const offset = (1 - Math.pow(i / width, 2)) * curve;
                    const jitter = (Math.random() - 0.5) * 15;
                    ctx.lineTo(offset + jitter, i);
                }
            } else {
                // Draw along X axis (direction of travel)
                // Length of visual bolt
                const len = 100;
                ctx.moveTo(-len / 2, 0);

                // Jagged segments along X
                for (let x = -len / 2; x < len / 2; x += 5) {
                    ctx.lineTo(x, (Math.random() - 0.5) * 10);
                }
                ctx.lineTo(len / 2, 0);
            }
            ctx.stroke();
        } else if (proj.type === 'punch') {
            ctx.strokeStyle = '#00ffff';
            ctx.lineWidth = 3;
            ctx.shadowBlur = 10;
            ctx.shadowColor = '#ffffff';
            ctx.beginPath();
            ctx.arc(0, 0, 30, -Math.PI / 4, Math.PI / 4); // Fist arc
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(0, 0, 20, -Math.PI / 4, Math.PI / 4);
            ctx.stroke();
        } else {
            const color = proj.isSuper ? '#ff00ff' : (proj.owner === myId ? '#00ffff' : '#ff0000');
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(0, 0, proj.isSuper ? 15 : 6, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.restore();
    });

    // Lightning Tethers
    for (let i = lightningTethers.length - 1; i >= 0; i--) {
        const t = lightningTethers[i];
        const p1 = players[t.p1];
        const p2 = players[t.p2];
        if (p1 && p2 && p1.alive && p2.alive) {
            ctx.strokeStyle = '#00ffff';
            ctx.lineWidth = 2;
            ctx.globalAlpha = t.life;
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            // Jagged line
            let dx = p2.x - p1.x;
            let dy = p2.y - p1.y;
            let dist = Math.sqrt(dx * dx + dy * dy);
            for (let j = 0; j < dist; j += 20) {
                let tx = p1.x + (dx * j / dist) + (Math.random() - 0.5) * 20;
                let ty = p1.y + (dy * j / dist) + (Math.random() - 0.5) * 20;
                ctx.lineTo(tx, ty);
            }
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
        }
        t.life -= 0.05;
        if (t.life <= 0) lightningTethers.splice(i, 1);
    }
    ctx.globalAlpha = 1.0;

    // Draw Power-ups
    powerups.forEach(pu => {
        ctx.save();
        ctx.translate(pu.x, pu.y);

        let color = '#fff';
        let label = '';
        if (pu.type === 'speed') { color = '#ffff00'; label = 'S'; }
        if (pu.type === 'unlimitedAmmo') { color = '#00ffff'; label = 'A'; }
        if (pu.type === 'freeze') { color = '#3366ff'; label = 'F'; }

        // Glow
        ctx.shadowBlur = 15;
        ctx.shadowColor = color;

        // Box
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.strokeRect(-20, -20, 40, 40);

        // Symbol
        ctx.fillStyle = color;
        ctx.font = 'bold 20px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, 0, 0);

        ctx.restore();
    });

    Effects.draw(ctx);
    drawMinimap();
    ctx.restore();
    requestAnimationFrame(draw);
}

draw();

function drawMinimap() {
    if (!minimapCtx) return;

    minimapCtx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);

    const scaleX = minimapCanvas.width / WORLD_WIDTH;
    const scaleY = minimapCanvas.height / WORLD_HEIGHT;

    // Draw Walls
    minimapCtx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    for (const wall of WALL_RECTS) {
        minimapCtx.fillRect(wall.x * scaleX, wall.y * scaleY, wall.w * scaleX, wall.h * scaleY);
    }

    // Draw Players
    for (const id in players) {
        if (!players[id].alive) continue;
        const p = players[id];
        const isMe = (id === myId);

        minimapCtx.fillStyle = isMe ? '#00ffff' : '#ff3300';
        minimapCtx.beginPath();
        minimapCtx.arc(p.x * scaleX, p.y * scaleY, 3, 0, Math.PI * 2);
        minimapCtx.fill();
    }
}

socket.on('lightningTether', (data) => {
    lightningTethers.push({ ...data, life: 1.0 });
});

// Selection Screen Handlers
function joinGame(character) {
    myCharacter = character;
    selectionScreen.classList.add('hidden');
    uiLayer.classList.remove('hidden');
    socket.emit('join', { character });
}

if (btnTitus) btnTitus.onclick = () => joinGame('titus');
if (btnAndrew) btnAndrew.onclick = () => joinGame('drandrew');
const btnHyperSwag = document.getElementById('select-hyperswag');
if (btnHyperSwag) btnHyperSwag.onclick = () => joinGame('hyperswag');
