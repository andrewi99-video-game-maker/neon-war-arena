const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const socket = io();

// UI Elements
const uiAlive = document.getElementById('alive-count');
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
let myId = null;
let players = {};
let projectiles = []; // Client-side projectile simulation for local responsiveness
let camera = { x: 0, y: 0 };
let input = {
    w: false, a: false, s: false, d: false,
    mouseX: 0, mouseY: 0, mouseDown: false
};
let lastShootTime = 0;

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

    // For other players, update normally
    for (let id in serverPlayers) {
        if (id !== myId) {
            players[id] = serverPlayers[id];
        } else if (players[id]) {
            // FOR MY PLAYER: Only update health, ammo, super, alive status
            // TRUST LOCAL POSITION (simple prediction)
            const me = players[id];
            const serverMe = serverPlayers[id];
            me.health = serverMe.health;
            me.alive = serverMe.alive;
            me.ammo = serverMe.ammo;
            me.superCharge = serverMe.superCharge;
            me.maxAmmo = serverMe.maxAmmo;
        } else {
            // First time receiving my data
            players[id] = serverPlayers[id];
        }
    }

    // Clean up players who left
    for (let id in players) {
        if (!serverPlayers[id]) delete players[id];
    }

    // Global projectiles from server
    projectiles = serverProjectiles;

    // Update UI
    if (myId && players[myId]) {
        const me = players[myId];
        uiHealthBar.style.width = `${me.health}%`;
        uiHealthText.innerText = `${Math.ceil(me.health)}/100`;

        uiSuperBar.style.width = `${me.superCharge}%`;
        uiSuperText.innerText = `${Math.floor(me.superCharge)}%`;


        if (me.alive) {
            deathScreen.classList.add('hidden');
        } else {
            if (!deathScreen.classList.contains('hidden') === false) Sound.death(); // Play once on death
            deathScreen.classList.remove('hidden');
        }

        // Update Ammo HUD
        const slots = uiAmmoContainer.children;
        for (let i = 0; i < slots.length; i++) {
            if (i < me.ammo) {
                slots[i].classList.add('filled');
            } else {
                slots[i].classList.remove('filled');
            }
        }
    }

    // Alive count tracking
    let aliveCount = 0;
    for (let id in players) {
        if (players[id].alive) {
            aliveCount++;
        }
    }
    if (uiAlive) {
        uiAlive.innerText = aliveCount;
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
    if (!myId || !players[myId] || !players[myId].alive) return;

    const me = players[myId];
    const speed = 5; // Pixels per frame
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

    // Client-side prediction (very basics)
    const newX = me.x + dx;
    const newY = me.y + dy;

    // Wall Collision Check (Client Side)
    // Uses global WALL_RECTS

    let collided = false;
    for (const wall of WALL_RECTS) {
        const closestX = Math.max(wall.x, Math.min(newX, wall.x + wall.w));
        const closestY = Math.max(wall.y, Math.min(newY, wall.y + wall.h));
        const dist = Math.sqrt(Math.pow(newX - closestX, 2) + Math.pow(newY - closestY, 2));
        if (dist < 30) { // Radius 25 + 5 buffer
            collided = true;
            break;
        }
    }

    if (!collided) {
        me.x = newX;
        me.y = newY;
    }

    // Only calculate angle from mouse if NOT using touch joysticks
    if (!TouchControls.right.active && !TouchControls.super.active) {
        const screenCX = VIRTUAL_WIDTH / 2;
        const screenCY = VIRTUAL_HEIGHT / 2;
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
    if (isSuper) Sound.super(); else Sound.shoot();
    socket.emit('shoot', { isSuper });
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

    // Camera follows player
    camera.x = me.x - canvas.width / 2;
    camera.y = me.y - canvas.height / 2;

    // Draw Ground Pattern
    // Tiled background
    if (assets.ground.complete) {
        const ptrn = ctx.createPattern(assets.ground, 'repeat');
        ctx.fillStyle = ptrn;
        // We need to translate pattern to match camera to avoid "sliding" feel
        // The pattern origin is 0,0. We want it to be fixed in World.
        ctx.save();
        ctx.translate(-camera.x, -camera.y);
        ctx.fillRect(camera.x, camera.y, canvas.width, canvas.height);
        ctx.restore();
    }

    ctx.save();
    ctx.translate(-camera.x, -camera.y);

    // Draw Walls
    for (const wall of WALL_RECTS) {
        ctx.save();
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#00ff44';
        ctx.strokeStyle = '#00ff44';
        ctx.lineWidth = 2;

        // Outer Rect
        ctx.strokeRect(wall.x, wall.y, wall.w, wall.h);

        // Inner Pattern (X)
        ctx.beginPath();
        ctx.moveTo(wall.x, wall.y);
        ctx.lineTo(wall.x + wall.w, wall.y + wall.h);
        ctx.moveTo(wall.x + wall.w, wall.y);
        ctx.lineTo(wall.x, wall.y + wall.h);
        ctx.stroke();

        ctx.restore();
    }

    // Draw Players
    for (const id in players) {
        if (!players[id].alive) continue;

        const p = players[id];
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);

        // Procedural Drawing: Geometric Art Style
        const isMe = (id === myId);
        const primaryColor = isMe ? '#00ffff' : '#ff3300';
        const secondaryColor = isMe ? '#0088ff' : '#991100';

        ctx.shadowBlur = 15;
        ctx.shadowColor = primaryColor;

        // Body Circle
        ctx.strokeStyle = primaryColor;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, 25, 0, Math.PI * 2);
        ctx.stroke();

        // Inner Detail (Triangular Core)
        ctx.fillStyle = secondaryColor;
        ctx.beginPath();
        ctx.moveTo(10, 0);
        ctx.lineTo(-10, -8);
        ctx.lineTo(-10, 8);
        ctx.closePath();
        ctx.fill();

        // Directional Indicator / "Gun"
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(25, 0);
        ctx.lineTo(40, 0);
        if (me.ammo > 0 && (TouchControls.right.active || !isMobile)) { // Only draw trajectory if aiming or on PC (mouse assumed aiming)
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(40, 0); // Slightly longer aim line
            ctx.stroke();
        }

        ctx.shadowBlur = 0;
        ctx.restore();

        // Super Trajectory (for Mobile Super Stick)
        if (isMobile && TouchControls.super.active && id === myId && me.superCharge >= 100) {
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(TouchControls.super.angle);
            ctx.strokeStyle = '#ff00ff';
            ctx.lineWidth = 4;
            ctx.setLineDash([10, 5]);
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(80, 0); // Slightly longer super line
            ctx.stroke();
            ctx.restore();
        }

        // World-Space UI (Above head)
        const barWidth = 60;
        const barHeight = 8;
        const barY = p.y - 50;

        // Health Bar
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(p.x - barWidth / 2, barY, barWidth, barHeight);
        ctx.fillStyle = id === myId ? '#00ff00' : '#ff0000';
        ctx.fillRect(p.x - barWidth / 2, barY, barWidth * (p.health / 100), barHeight);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.strokeRect(p.x - barWidth / 2, barY, barWidth, barHeight);

        // Ammo Bar (Only for local player)
        if (id === myId) {
            const ammoBarY = barY - 12;
            const ammoSegmentWidth = barWidth / p.maxAmmo;
            for (let i = 0; i < p.maxAmmo; i++) {
                ctx.fillStyle = i < p.ammo ? '#ffcc00' : 'rgba(100, 100, 100, 0.5)';
                ctx.fillRect(p.x - barWidth / 2 + i * ammoSegmentWidth, ammoBarY, ammoSegmentWidth - 1, 6);
            }
            ctx.strokeRect(p.x - barWidth / 2, ammoBarY, barWidth, 6);
        }
    }

    projectiles.forEach(proj => {
        ctx.save();
        ctx.translate(proj.x, proj.y);

        const isSuper = proj.isSuper;
        const color = isSuper ? '#ff00ff' : (proj.owner === myId ? '#00ffff' : '#ff0000');

        ctx.shadowBlur = isSuper ? 20 : 10;
        ctx.shadowColor = color;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;

        if (isSuper) {
            // Drawn as a star/pulsing diamond
            ctx.beginPath();
            for (let i = 0; i < 8; i++) {
                const angle = (i * Math.PI) / 4;
                const r = i % 2 === 0 ? 25 : 10;
                ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
            }
            ctx.closePath();
            ctx.stroke();
            ctx.fillStyle = 'rgba(255, 0, 255, 0.2)';
            ctx.fill();
        } else {
            // Drawn as a glowing orb with a trail line
            ctx.beginPath();
            ctx.arc(0, 0, 8, 0, Math.PI * 2);
            ctx.stroke();

            // Short trail
            ctx.beginPath();
            ctx.moveTo(0, 0);
            const dx = proj.vx / 5;
            const dy = proj.vy / 5;
            ctx.lineTo(-dx * 10, -dy * 10);
            ctx.stroke();
        }
        ctx.restore();
    });
    ctx.shadowBlur = 0;

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
