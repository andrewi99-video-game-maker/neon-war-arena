const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const socket = io();

// UI Elements
const uiAlive = document.getElementById('alive-count');
const uiKills = document.getElementById('kill-count');
const uiLives = document.getElementById('lives-count');
const uiHealthBar = document.getElementById('health-bar');
const uiHealthText = document.getElementById('health-text');
const uiSuperBar = document.getElementById('super-bar');
const uiSuperText = document.getElementById('super-text');
const uiAmmoContainer = document.getElementById('ammo-container');
const deathScreen = document.getElementById('death-screen');
const selectionScreen = document.getElementById('selection-screen');
const lobbyScreen = document.getElementById('lobby-screen');
const playerList = document.getElementById('player-list');
const readyBtn = document.getElementById('ready-btn');
const uiLayer = document.getElementById('ui-layer');
const resultsScreen = document.getElementById('results-screen');
const modeSelection = document.getElementById('mode-selection');
const btnDeathmatch = document.getElementById('mode-deathmatch');
const btnSoccer = document.getElementById('mode-soccer');
const winnerText = document.getElementById('winner-text');
const matchStats = document.getElementById('match-stats');
const backToLobbyBtn = document.getElementById('back-to-lobby');
const waitingMessage = document.getElementById('waiting-message');
const respawnTimer = document.getElementById('respawn-timer');
const uiSuperZone = document.getElementById('super-btn-zone');
const minimapCanvas = document.getElementById('minimapCanvas');
const minimapCtx = minimapCanvas ? minimapCanvas.getContext('2d') : null;
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
let gameState = 'LOBBY';
let gameMode = 'deathmatch';
let isReady = false;
let spectatingId = null;
let ball = null; // Soccer ball state

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

socket.on('lobbyUpdate', (data) => {
    players = data.players;
    updateLobbyUI();

    if (myId && players[myId]) {
        if (players[myId].isWaiting) {
            waitingMessage.classList.remove('hidden');
            readyBtn.classList.add('hidden');
        } else {
            waitingMessage.classList.add('hidden');
            readyBtn.classList.remove('hidden');
        }
    }
});

socket.on('pickMode', () => {
    lobbyScreen.classList.add('hidden');
    modeSelection.classList.remove('hidden');
});

socket.on('gameStart', (data) => {
    lobbyScreen.classList.add('hidden');
    modeSelection.classList.add('hidden');
    resultsScreen.classList.add('hidden');
    uiLayer.classList.remove('hidden');
    gameState = 'PLAYING';
    gameMode = data.mode || 'deathmatch';
});

btnDeathmatch.onclick = () => {
    socket.emit('selectMode', { mode: 'deathmatch' });
};

btnSoccer.onclick = () => {
    socket.emit('selectMode', { mode: 'soccer' });
};

socket.on('matchResults', (data) => {
    gameState = 'LOBBY';
    uiLayer.classList.add('hidden');
    resultsScreen.classList.remove('hidden');
    winnerText.innerText = data.winner + (data.winner === 'No one' ? '...' : " WINS!");

    matchStats.innerHTML = `<div class="player-item" style="color: #aaa; border: none;">Mode: ${data.mode.toUpperCase()}</div>`;
    data.results.forEach(res => {
        const item = document.createElement('div');
        item.className = 'player-item';
        item.innerHTML = `<span>${res.nickname}</span> <span>Kills: ${res.kills} | Deaths: ${res.deaths}</span>`;
        if (res.isWinner) {
            item.style.color = '#00ff00';
            item.style.borderColor = '#00ff00';
        }
        matchStats.appendChild(item);
    });
});

backToLobbyBtn.onclick = () => {
    resultsScreen.classList.add('hidden');
    lobbyScreen.classList.remove('hidden');
};

function updateLobbyUI() {
    playerList.innerHTML = '';
    for (let id in players) {
        const p = players[id];
        const item = document.createElement('div');
        item.className = 'player-item';

        const name = document.createElement('span');
        name.innerText = p.nickname || 'Unknown Player';

        const status = document.createElement('span');
        status.className = 'player-status ' + (p.isReady ? 'ready' : 'waiting');
        status.innerText = p.isReady ? 'Ready' : 'Waiting...';

        item.appendChild(name);
        item.appendChild(status);
        playerList.appendChild(item);
    }
}

readyBtn.onclick = () => {
    isReady = !isReady;
    readyBtn.classList.toggle('is-ready', isReady);
    readyBtn.innerText = isReady ? 'READY!' : 'READY UP';
    socket.emit('readyUp', { isReady });
};

socket.on('state', (data) => {
    const serverPlayers = data.players;
    const serverProjectiles = data.projectiles;
    ball = data.ball; // Sync ball state
    if (data.mode) gameMode = data.mode; // Robust mode sync
    currentGameState = data.state; // Robust state sync

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
        me.lives = sMe.lives;

        // UI Updates
        if (uiKills) uiKills.innerText = me.kills;
        if (uiLives) uiLives.innerText = me.lives;
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
            if (me.lives > 0) {
                if (deathScreen.classList.contains('hidden')) Sound.death();
                deathScreen.classList.remove('hidden');
                deathScreen.querySelector('h1').innerText = 'YOU DIED';
                deathScreen.querySelector('p').innerHTML = `Respawning in <span id="respawn-timer">${Math.ceil((5000 - (Date.now() - (networkState.lastTime - INTERP_OFFSET))) / 1000)}</span>...`;
            } else {
                deathScreen.classList.remove('hidden');
                deathScreen.querySelector('h1').innerText = 'GAME OVER';
                deathScreen.querySelector('p').innerText = 'Out of lives. Spectating...';
            }
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
            players[id].respawnShieldUntil = serverPlayers[id].respawnShieldUntil;
            players[id].respawnSpeedUntil = serverPlayers[id].respawnSpeedUntil;
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


// Game Loop
function update() {
    if (!myId || !players[myId]) return;

    const me = players[myId];
    if (!me.alive || me.lives <= 0 || Date.now() < (me.frozenUntil || 0) || Date.now() < (me.spinningUntil || 0)) return;

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

    let multiplier = me.speedMultiplier || 1.0;
    if (Date.now() < (me.respawnSpeedUntil || 0)) {
        multiplier *= 1.5;
    }
    const speed = 5 * multiplier; // Pixels per frame
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

    if (gameMode !== 'soccer') {
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
    } else {
        // Clean movement in Soccer
        me.x += dx;
        me.y += dy;

        // Manual Map Bounds for Soccer
        me.x = Math.max(0, Math.min(2000, me.x));
        me.y = Math.max(0, Math.min(2000, me.y));
    }

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
    // Fill background with a base green color to avoid "black map"
    ctx.fillStyle = gameMode === 'soccer' ? '#2e7d32' : '#1a1a1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!myId || !players[myId]) {
        requestAnimationFrame(draw);
        return;
    }

    const me = players[myId];
    const renderTime = Date.now() - INTERP_OFFSET;

    // Camera follow logic
    let target = me;
    if (!me.alive && me.lives === 0) {
        // Find someone to spectate
        if (!spectatingId || !players[spectatingId] || !players[spectatingId].alive) {
            const alivePlayers = Object.keys(players).filter(id => players[id].alive);
            if (alivePlayers.length > 0) {
                spectatingId = alivePlayers[0];
            } else {
                spectatingId = null;
            }
        }
        if (spectatingId && players[spectatingId]) {
            target = players[spectatingId];
        }
    }

    camera.x = target.x - canvas.width / 2;
    camera.y = target.y - canvas.height / 2;

    // Soccer Field Rendering
    if (gameMode === 'soccer') {
        renderSoccerField(ctx);
    }

    // Optimized Background Drawing (Deathmatch only or fallback)
    if (gameMode !== 'soccer' && assets.ground.complete) {
        ctx.save();
        const ptrn = ctx.createPattern(assets.ground, 'repeat');
        ctx.fillStyle = ptrn;
        ctx.translate(-camera.x, -camera.y);
        ctx.fillRect(camera.x, camera.y, canvas.width, canvas.height);
        ctx.restore();
    } else if (gameMode === 'soccer') {
        // Subtle grid for grass
        ctx.save();
        ctx.translate(-camera.x, -camera.y);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.05)';
        ctx.lineWidth = 2;
        for (let x = 0; x <= 2000; x += 100) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 2000); ctx.stroke();
        }
        for (let y = 0; y <= 2000; y += 100) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(2000, y); ctx.stroke();
        }
        ctx.restore();
    }

    ctx.save();
    ctx.translate(-camera.x, -camera.y);

    // Draw Walls (Simplified rendering - Deathmatch only)
    if (gameMode !== 'soccer') {
        ctx.strokeStyle = '#00ff44';
        ctx.lineWidth = 2;
        for (const wall of WALL_RECTS) {
            ctx.strokeRect(wall.x, wall.y, wall.w, wall.h);
            ctx.beginPath();
            ctx.moveTo(wall.x, wall.y); ctx.lineTo(wall.x + wall.w, wall.y + wall.h);
            ctx.moveTo(wall.x + wall.w, wall.y); ctx.lineTo(wall.x, wall.y + wall.h);
            ctx.stroke();
        }
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
        } else if (p.character === 'one') {
            primaryColor = isMe ? '#deb887' : '#8b4513';
            secondaryColor = isMe ? '#8b4513' : '#5d2e0d';
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

        if (p.character === 'one') {
            // Wooden body detail
            ctx.fillStyle = secondaryColor;
            ctx.beginPath();
            ctx.arc(0, 0, 20, 0, Math.PI * 2);
            ctx.fill();
            // Mask eyes
            ctx.fillStyle = '#000';
            ctx.beginPath();
            ctx.arc(-8, -5, 4, 0, Math.PI * 2);
            ctx.arc(8, -5, 4, 0, Math.PI * 2);
            ctx.fill();
            // Leaf detail
            ctx.fillStyle = '#32cd32';
            ctx.beginPath();
            ctx.ellipse(0, -28, 5, 8, 0, 0, Math.PI * 2);
            ctx.fill();
        } else if (p.character === 'titus') {
            // BLUE HOOD
            ctx.fillStyle = '#0044aa';
            ctx.beginPath();
            ctx.arc(0, 5, 22, Math.PI, 0); // Hood top
            ctx.lineTo(22, 25);
            ctx.lineTo(-22, 25);
            ctx.closePath();
            ctx.fill();

            // FACE
            ctx.fillStyle = '#ffdbac';
            ctx.beginPath();
            ctx.arc(0, 0, 15, 0, Math.PI * 2);
            ctx.fill();

            // DETERMINED EYES
            ctx.fillStyle = '#333';
            ctx.beginPath();
            ctx.moveTo(-8, -4); ctx.lineTo(-2, -2); // Left brow style
            ctx.moveTo(8, -4); ctx.lineTo(2, -2);   // Right brow style
            ctx.stroke();
            ctx.fillRect(-6, 0, 3, 2);
            ctx.fillRect(3, 0, 3, 2);

            // FLAMING WATCH (Small detail in front)
            ctx.save();
            ctx.translate(15, 10);
            ctx.fillStyle = '#ffff00';
            ctx.beginPath();
            ctx.arc(0, 0, 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#ff6600';
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (let i = 0; i < 8; i++) {
                let a = i * Math.PI / 4 + Date.now() / 200;
                ctx.moveTo(Math.cos(a) * 6, Math.sin(a) * 6);
                ctx.lineTo(Math.cos(a) * 9, Math.sin(a) * 9);
            }
            ctx.stroke();
            ctx.restore();

        } else if (p.character === 'drandrew') {
            // LIGHTNING SPARKS (Body aura)
            ctx.strokeStyle = '#00ffff';
            ctx.lineWidth = 1;
            for (let i = 0; i < 3; i++) {
                const ang = Date.now() / 100 + i;
                const r = 25 + Math.random() * 10;
                ctx.beginPath();
                ctx.moveTo(Math.cos(ang) * r, Math.sin(ang) * r);
                ctx.lineTo(Math.cos(ang + 0.2) * r * 1.2, Math.sin(ang + 0.2) * r * 1.2);
                ctx.stroke();
            }

            // BUFF BODY (Shoulders)
            ctx.fillStyle = '#1a237e'; // Dark vest
            ctx.beginPath();
            ctx.ellipse(0, 5, 28, 18, 0, 0, Math.PI * 2);
            ctx.fill();

            // Arms / Muscles (Circles to represent shoulders)
            ctx.beginPath();
            ctx.arc(-22, 0, 10, 0, Math.PI * 2);
            ctx.arc(22, 0, 10, 0, Math.PI * 2);
            ctx.fill();

            // FACE
            ctx.fillStyle = '#ffdbac';
            ctx.beginPath();
            ctx.arc(0, 0, 20, 0, Math.PI * 2);
            ctx.fill();

            // PROFESSIONAL SHORT HAIR (Smart brown)
            ctx.fillStyle = '#5d2e0d';
            // Back hair
            ctx.beginPath();
            ctx.arc(0, 0, 21, Math.PI * 1.1, Math.PI * 1.9);
            ctx.fill();
            // Sharp bangs/style
            ctx.beginPath();
            ctx.moveTo(-21, -5);
            ctx.quadraticCurveTo(-15, -25, 0, -22);
            ctx.quadraticCurveTo(15, -25, 21, -5);
            ctx.lineTo(10, -15);
            ctx.lineTo(-10, -15);
            ctx.fill();

            // Blue Highlight
            ctx.fillStyle = '#00b0ff';
            ctx.beginPath();
            ctx.moveTo(5, -22);
            ctx.lineTo(15, -15);
            ctx.lineTo(10, -25);
            ctx.fill();

            // STRONG JAW / SMIRK
            ctx.strokeStyle = '#a67c52';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(-10, 8);
            ctx.quadraticCurveTo(0, 12, 10, 8);
            ctx.stroke();

            // LIGHTNING EYES (Glow)
            ctx.shadowBlur = 10;
            ctx.shadowColor = '#00ffff';
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(-8, 0, 4, 0, Math.PI * 2);
            ctx.arc(8, 0, 4, 0, Math.PI * 2);
            ctx.fill();

            // Lightning Trails from eyes
            ctx.strokeStyle = '#00ffff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(-10, 0); ctx.lineTo(-20, -10);
            ctx.moveTo(10, 0); ctx.lineTo(20, -10);
            ctx.stroke();
            ctx.shadowBlur = 0;

        } else if (p.character === 'hyperswag') {
            // SHARK BODY / HEAD (Blue circle with point)
            ctx.fillStyle = '#0088ff';
            ctx.beginPath();
            ctx.arc(0, 0, 23, 0, Math.PI * 2);
            ctx.fill();

            // SHARK FIN (top view representation)
            ctx.beginPath();
            ctx.moveTo(0, -20);
            ctx.lineTo(-5, 0);
            ctx.lineTo(5, 0);
            ctx.fill();

            // WHITE BELLY AREA
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.arc(0, 10, 15, 0, Math.PI * 2);
            ctx.fill();

            // EYES (Cute large eyes)
            ctx.fillStyle = '#333';
            ctx.beginPath();
            ctx.arc(-8, -2, 5, 0, Math.PI * 2);
            ctx.arc(8, -2, 5, 0, Math.PI * 2);
            ctx.fill();
            // Eye shine
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.arc(-9, -3, 1.5, 0, Math.PI * 2);
            ctx.arc(7, -3, 1.5, 0, Math.PI * 2);
            ctx.fill();

            // PINK BLUSH CHEEKS
            ctx.fillStyle = 'rgba(255, 105, 180, 0.6)';
            ctx.beginPath();
            ctx.arc(-14, 8, 5, 0, Math.PI * 2);
            ctx.arc(14, 8, 5, 0, Math.PI * 2);
            ctx.fill();

            // COLLAR and BELL
            ctx.strokeStyle = '#333';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.arc(0, 15, 10, 0.2, Math.PI - 0.2);
            ctx.stroke();

            ctx.fillStyle = '#ffd700'; // GOLD
            ctx.beginPath();
            ctx.arc(0, 24, 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#aa8800';
            ctx.lineWidth = 1;
            ctx.stroke();

        } else {
            ctx.fillStyle = secondaryColor;
            ctx.beginPath();
            ctx.moveTo(10, 0); ctx.lineTo(-10, -8); ctx.lineTo(-10, 8); ctx.closePath();
            ctx.fill();
        }

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

        // DR ANDREW SHIELD OR RESPAWN SHIELD
        if (p.hasShield || Date.now() < (p.respawnShieldUntil || 0)) {
            const isRespawn = Date.now() < (p.respawnShieldUntil || 0);
            ctx.strokeStyle = isRespawn ? '#ffff00' : '#00ffff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(0, 0, 35, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 0.2;
            ctx.fillStyle = isRespawn ? 'rgba(255, 255, 0, 0.3)' : '#00ffff';
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
        if (p.character === 'one') ctx.fillStyle = '#deb887';
        ctx.fillRect(drawX - barWidth / 2, barY, barWidth * (p.health / (p.maxHealth || 100)), barHeight);

        // Character Name & Health Text Above Bar
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px Arial';
        ctx.textAlign = 'center';
        const displayName = p.nickname || (p.character === 'titus' ? 'Titus' : (p.character === 'drandrew' ? 'Dr. Andrew' : (p.character === 'hyperswag' ? 'HyperSwag' : (p.character === 'one' ? 'One' : 'Player'))));
        ctx.fillText(`${displayName} ${Math.ceil(p.health)}/${p.maxHealth || 100}`, drawX, barY - 5);

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
            ctx.save();
            ctx.rotate(proj.angle || 0);
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
            ctx.restore();
        } else if (proj.type === 'hammer') {
            // BAT SWING ARC
            const age = Date.now() - proj.startTime;
            const duration = 300;
            const progress = Math.min(1, age / duration);

            // Swing from -PI/2 to PI/2 relative to aim
            const swingRange = Math.PI * 0.8; // 144 degrees
            const startAngle = -swingRange / 2;
            const currentAngle = startAngle + swingRange * progress;

            ctx.save();
            ctx.rotate(proj.angle || 0);

            ctx.strokeStyle = 'rgba(210, 180, 140, 0.8)';
            ctx.lineWidth = 15;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.arc(0, 0, 100, startAngle, currentAngle);
            ctx.stroke();

            // Hammer Head at leading edge
            ctx.save();
            ctx.rotate(currentAngle);
            ctx.fillStyle = '#8b4513';
            ctx.fillRect(80, -20, 40, 40);
            ctx.restore();

            // Fade-out shockwave
            ctx.strokeStyle = `rgba(139, 69, 19, ${0.4 * (1 - progress)})`;
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.arc(0, 0, 130 * progress, -swingRange / 2, swingRange / 2);
            ctx.stroke();

            ctx.restore();

        } else if (proj.type === 'storm') {
            const age = Date.now() - proj.startTime;
            ctx.rotate(age / 500); // Slower visual rotation

            ctx.fillStyle = 'rgba(160, 82, 45, 0.3)';
            ctx.beginPath();
            ctx.arc(0, 0, 150, 0, Math.PI * 2);
            ctx.fill();

            // Rising dust swirl
            ctx.strokeStyle = 'rgba(139, 69, 19, 0.4)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (let i = 0; i < 5; i++) {
                const r = 30 + i * 25;
                ctx.arc(0, 0, r, age / 400 + i, age / 400 + i + Math.PI / 2);
            }
            ctx.stroke();

            // Heavy debris
            ctx.fillStyle = '#5d2e0d';
            for (let i = 0; i < 15; i++) {
                const angle = (i * 1.3 + age / 300);
                const r = (30 + (i * 7) % 120);
                ctx.beginPath();
                ctx.arc(Math.cos(angle) * r, Math.sin(angle) * r, 4, 0, Math.PI * 2);
                ctx.fill();
            }
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

    // Soccer Ball Rendering
    if (gameMode === 'soccer' && ball) {
        ctx.save();
        ctx.translate(ball.x, ball.y);

        // Ball Shadow
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.ellipse(0, 20, 15, 8, 0, 0, Math.PI * 2);
        ctx.fill();

        // Ball Body
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, ball.radius || 20, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Classic soccer pentagon patterns (simple representation)
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        for (let i = 0; i < 5; i++) {
            const angle = (i * Math.PI * 2) / 5 + Date.now() / 1000;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(angle) * 20, Math.sin(angle) * 20);
            ctx.stroke();

            // Inner pentagons
            ctx.fillStyle = '#111';
            ctx.beginPath();
            ctx.arc(Math.cos(angle + 0.3) * 12, Math.sin(angle + 0.3) * 12, 4, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

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

    // Draw Ball if soccer
    if (gameMode === 'soccer' && ball) {
        minimapCtx.fillStyle = '#fff';
        minimapCtx.beginPath();
        minimapCtx.arc(ball.x * scaleX, ball.y * scaleY, 4, 0, Math.PI * 2);
        minimapCtx.fill();
    }
}

socket.on('lightningTether', (data) => {
    lightningTethers.push({ ...data, life: 1.0 });
});

// Selection Screen Handlers
function joinGame(character) {
    const nicknameInput = document.getElementById('nickname-input');
    const nickname = nicknameInput ? nicknameInput.value.trim() : "";
    myCharacter = character;
    selectionScreen.classList.add('hidden');
    lobbyScreen.classList.remove('hidden'); // Go to lobby first
    socket.emit('join', { character, nickname });
}

if (btnTitus) btnTitus.onclick = () => joinGame('titus');
if (btnAndrew) btnAndrew.onclick = () => joinGame('drandrew');
const btnHyperSwag = document.getElementById('select-hyperswag');
if (btnHyperSwag) btnHyperSwag.onclick = () => joinGame('hyperswag');
const btnOne = document.getElementById('select-one');
if (btnOne) btnOne.onclick = () => joinGame('one');

draw();

function renderSoccerField(ctx) {
    ctx.save();
    ctx.translate(-camera.x, -camera.y);

    // Pitch base (already filled by draw() but we add a nice border here)
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, 1990, 1990);

    // Markings
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 8;

    // Center line
    ctx.beginPath();
    ctx.moveTo(1000, 0);
    ctx.lineTo(1000, 2000);
    ctx.stroke();

    // Center circle
    ctx.beginPath();
    ctx.arc(1000, 1000, 200, 0, Math.PI * 2);
    ctx.stroke();

    // Goals
    const goalY = 800;
    const goalH = 400;

    // Left goal (Player 1)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(0, goalY, 50, goalH);
    ctx.strokeStyle = '#00ffff';
    ctx.lineWidth = 5;
    ctx.strokeRect(0, goalY, 50, goalH);

    ctx.fillStyle = '#00ffff';
    ctx.font = 'bold 30px Arial';
    ctx.textAlign = 'center';
    ctx.fillText("GOAL", 120, goalY + goalH / 2);

    // Right goal (Player 2)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(1950, goalY, 50, goalH);
    ctx.strokeStyle = '#ff3300';
    ctx.lineWidth = 5;
    ctx.strokeRect(1950, goalY, 50, goalH);

    ctx.fillStyle = '#ff3300';
    ctx.fillText("GOAL", 1880, goalY + goalH / 2);

    ctx.restore();
}
