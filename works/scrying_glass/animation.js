// ==========================================================================
// animation.js — Scene, shader, quantum-entropy polling, and UI chrome for
// The Scrying Glass
//
// Depends on globals defined in audio.js (loaded before this file):
//   - `audioEnabled`, `updateAudioFromTarget(target)`
//
// Exposes globals used by audio.js:
//   - `target`, `tweenDuration()`, and passes the raw quantum byte array to
//     `updateAudioFromTarget(target, bytes)` on each new reading
// ==========================================================================

// ---------- THREE.JS SETUP ----------
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera( -1, 1, 1, -1, 0, 1 );

const renderer = new THREE.WebGLRenderer();
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setPixelRatio( Math.min(window.devicePixelRatio, 2) );
container.appendChild( renderer.domElement );

const uniforms = {
    uTime: { value: 0.0 },
    uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
    uLevel: { value: 3.0 },
    uSymmetry: { value: 6.0 },
    uIntensity: { value: 1.0 },
    uIterations: { value: 1.0 },
    uNegative: { value: 0.0 },
    uHueShift: { value: 0.0 }
};

const clock = new THREE.Clock();

const geometry = new THREE.PlaneGeometry( 2, 2 );
const material = new THREE.ShaderMaterial( {
    uniforms: uniforms,
    vertexShader: document.getElementById( 'vertexShader' ).textContent,
    fragmentShader: document.getElementById( 'fragmentShader' ).textContent
} );
const plane = new THREE.Mesh( geometry, material );
scene.add( plane );

window.addEventListener( 'resize', onWindowResize, false );
function onWindowResize() {
    renderer.setSize( window.innerWidth, window.innerHeight );
    uniforms.uResolution.value.x = renderer.domElement.width;
    uniforms.uResolution.value.y = renderer.domElement.height;
}

// ---------- UI CHROME ----------
const grimoire = document.getElementById('grimoire');
const toggle = document.getElementById('toggle');
const markEl = document.getElementById('mark');
const audioToggleEl = document.getElementById('audio-toggle');

// The title mark, the settings gear, and the volume toggle all live on the
// same "chrome" — they should appear together when the mouse moves and fade
// together after a moment of stillness.
const chromeEls = [markEl, toggle, audioToggleEl];

let markHideTimer = null;
const MARK_IDLE_MS = 2200;

function showMark() {
    chromeEls.forEach(el => el.classList.add('visible'));
    clearTimeout(markHideTimer);
    markHideTimer = null;
}

function scheduleMarkHide() {
    clearTimeout(markHideTimer);
    if (grimoire.classList.contains('open')) return; // stays visible while settings are open
    markHideTimer = setTimeout(() => {
        chromeEls.forEach(el => el.classList.remove('visible'));
    }, MARK_IDLE_MS);
}

toggle.addEventListener('click', () => {
    grimoire.classList.toggle('open');
    toggle.classList.toggle('open');
    if (grimoire.classList.contains('open')) {
        showMark();
    } else {
        scheduleMarkHide();
    }
});

// touching / moving over the glass reveals the mark; releasing lets it fade
['pointerdown', 'pointermove', 'touchstart', 'touchmove'].forEach(evt => {
    window.addEventListener(evt, () => {
        showMark();
        scheduleMarkHide();
    }, { passive: true });
});
['pointerup', 'touchend', 'touchcancel'].forEach(evt => {
    window.addEventListener(evt, () => scheduleMarkHide(), { passive: true });
});

// reveal the chrome on load, then let it fade after the idle delay like normal
showMark();
scheduleMarkHide();

const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const tickerEl = document.getElementById('ticker');
const sigilFlash = document.getElementById('sigil-flash');

// ---------- ATTUNEMENT (user speed control) ----------
let userSpeedMult = 1.0;
const userIntensityMult = 1.0; // fixed — no longer user-adjustable

const speedSlider = document.getElementById('s-speed');
const vSpeed = document.getElementById('v-speed');

speedSlider.addEventListener('input', () => {
    userSpeedMult = parseFloat(speedSlider.value);
    vSpeed.textContent = userSpeedMult.toFixed(2) + '×';
});

function flashSigil() {
    const peak = Math.min(1, 0.55 * userIntensityMult);
    sigilFlash.style.opacity = String(peak);
    setTimeout(() => { sigilFlash.style.opacity = '0'; }, 900);
}

function setStatus(source) {
    if (source === 'quantum') {
        statusDot.classList.add('quantum');
        statusText.innerHTML = 'Bound to the <b>Quantum Oracle</b> — live quantum entropy';
    } else if (source === 'local') {
        statusDot.classList.remove('quantum');
        statusText.innerHTML = 'Oracle unreachable — drawing on <b>local entropy</b>';
    } else {
        statusDot.classList.remove('quantum');
        statusText.innerHTML = 'Seeking the oracle&hellip;';
    }
}

// ---------- ENTROPY SOURCES ----------
// The quantum data is fetched via a small Cloudflare Worker relay (which calls
// qrandom.io server-side and adds the CORS header browsers need). If the relay
// or qrandom.io itself is unavailable, we fall back to local crypto entropy.
const RELAY_URL = 'https://scrying-relay.digital-psionics.workers.dev/';

async function fetchQuantumHexOnce() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
        const res = await fetch(RELAY_URL, { signal: controller.signal, cache: 'no-store' });
        clearTimeout(timeout);
        if (!res.ok) throw new Error('bad status ' + res.status);
        const json = await res.json();
        if (!json || !json.string || !json.string.length || !json.string[0]) throw new Error('empty/failed payload');
        return json.string[0];
    } catch (e) {
        clearTimeout(timeout);
        throw e;
    }
}

async function fetchQuantumHex(len = 128, attempts = 2) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fetchQuantumHexOnce();
        } catch (e) {
            lastErr = e;
            if (i < attempts - 1) await new Promise(r => setTimeout(r, 400));
        }
    }
    throw lastErr;
}

function localEntropyHex(len = 128) {
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- TARGET STATE (the true reading straight from the quantum bytes) ----------
// `target` is what's shown in the panel and is always faithful to the actual draw.
const target = {
    level: 3.0, symmetry: 6, speed: 0.12, intensity: 1.0, iterations: 1, hueShift: 0
};

function byteAt(bytes, i) { return bytes[i % bytes.length]; }

// ---------- SMOOTH TRANSITION (single pattern, eased tween) ----------
// Only one pattern is ever rendered — no second layer, no crossfade. Instead,
// whenever a new reading comes in, the visible parameters ease from wherever
// they currently sit to the new target over a fixed span. Because the ease has
// a fixed duration (rather than the old exponential decay, which only ever
// approached the target and technically never finished), it actually settles
// cleanly instead of snapping or drifting forever.
const visual = { level: 3.0, symmetry: 6, speed: 0.12, intensity: 1.0, iterations: 1, hueShift: 0 };
let tween = null; // { from, to, hueDelta, startClockTime, duration }

const BASE_TWEEN_S = 3.5;  // how long an ease takes at 1.0x speed
const MIN_TWEEN_S = 1.2;
const MAX_TWEEN_S = 8.0;

function tweenDuration() {
    // Fixed — no longer tied to the "Speed of Change" slider, which now only
    // controls how fast the fractal itself drifts (see uSpeed / shaderClock below).
    return BASE_TWEEN_S;
}

// Hue wraps every 2π — take the shortest angular path so a big jump in the
// reading doesn't spin the palette through several extra full turns first.
function shortestHueDelta(from, to) {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
}

function beginTween(targetParams, now) {
    tween = {
        from: { ...visual },
        to: { ...targetParams },
        hueDelta: shortestHueDelta(visual.hueShift, targetParams.hueShift),
        startClockTime: now,
        duration: tweenDuration()
    };
}

function applyHex(hex) {
    tickerEl.textContent = hex;

    const bytes = [];
    for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
    if (bytes.length < 8) return;

    const b = (i) => byteAt(bytes, i);

    target.level      = 2.5 + (b(0) / 255) * 5.5;                // 2.5 - 8 (floor keeps the fractal from thinning to near-black)
    target.symmetry   = 2 + Math.floor((b(1) / 255) * 22);      // 2 - 24
    target.speed       = 0.03 + (b(2) / 255) * 0.09;             // 0.03 - 0.12 (calm base drift, capped below strobe threshold)
    target.intensity  = 0.85 + (b(3) / 255) * 0.55;               // 0.85 - 1.4 (floor keeps luminance from dipping too dark)
    target.iterations = 1 + Math.floor((b(4) / 255) * 2.999);   // 1 - 3
    target.hueShift   = (b(6) / 255) * Math.PI * 8;               // wraps several cycles

    updateReadingsUI();
    flashSigil();
    // A genuinely new, non-held reading — ease toward it rather than snapping.
    beginTween({ ...target }, clock.getElapsedTime());
    if (audioEnabled) updateAudioFromTarget(target, bytes);
}

function updateReadingsUI() {
    document.getElementById('r-level').textContent = target.level.toFixed(2);
    document.getElementById('f-level').style.width = ((target.level - 2.5) / 5.5 * 100) + '%';

    document.getElementById('r-sym').textContent = target.symmetry;
    document.getElementById('f-sym').style.width = ((target.symmetry - 2) / 22 * 100) + '%';

    document.getElementById('r-speed').textContent = target.speed.toFixed(2);
    document.getElementById('f-speed').style.width = ((target.speed - 0.03) / 0.09 * 100) + '%';

    document.getElementById('r-lum').textContent = target.intensity.toFixed(2);
    document.getElementById('f-lum').style.width = ((target.intensity - 0.85) / 0.55 * 100) + '%';

    const forms = ['—', 'Glow', 'Laser', 'Wave'];
    document.getElementById('r-form').textContent = forms[target.iterations] || target.iterations;
    document.getElementById('f-form').style.width = (target.iterations / 3 * 100) + '%';
}

// ---------- POLLING LOOP ----------
let holding = false;
let pollTimer = null;
const POLL_INTERVAL_MS = 30000;

async function refreshEntropy() {
    if (holding) return;
    try {
        const hex = await fetchQuantumHex(128);
        setStatus('quantum');
        applyHex(hex);
    } catch (e) {
        console.warn('[Scrying Glass] quantum source failed, falling back to local entropy:', e);
        setStatus('local');
        applyHex(localEntropyHex(128));
    }
}

function startPolling() {
    refreshEntropy();
    pollTimer = setInterval(refreshEntropy, POLL_INTERVAL_MS);
}
startPolling();

// ---------- RITE BUTTONS ----------
document.getElementById('btn-cast').addEventListener('click', () => {
    if (!holding) refreshEntropy();
});

const holdBtn = document.getElementById('btn-hold');
holdBtn.addEventListener('click', () => {
    holding = !holding;
    holdBtn.classList.toggle('active', holding);
    holdBtn.textContent = holding ? 'Release' : 'Hold Vision';
});

// ---------- ANIMATION LOOP ----------
const MAX_SHADER_SPEED = 0.12; // hard cap so the kaleidoscope motion never races or strobes, even with the slider maxed

// The shader now receives an ACCUMULATED clock rather than raw elapsed time.
// Each frame we advance it by (deltaTime * currentSpeed), so changing speed
// changes the rate the clock ticks going forward — no jump/teleport in the
// pattern when the slider moves, unlike multiplying uTime * uSpeed directly.
let shaderClock = 0;
let lastFrameTime = 0;

function animate() {
    requestAnimationFrame(animate);
    const now = clock.getElapsedTime();
    const dt = lastFrameTime === 0 ? 0 : (now - lastFrameTime);
    lastFrameTime = now;

    if (tween) {
        const t = Math.min(1, (now - tween.startClockTime) / tween.duration);
        // Linear throughout — smoothstep's eased curve barely moves near t=0/1 and
        // rushes through most of the change in a short middle window, which reads
        // as the pattern "snapping" fast mid-transition instead of moving at a
        // steady pace. A constant rate of change keeps the transition feeling the
        // same speed as the idle animation, the same reasoning already applied to
        // `speed` below.
        const e = t;

        visual.level      = tween.from.level      + (tween.to.level      - tween.from.level) * e;
        visual.symmetry   = tween.from.symmetry   + (tween.to.symmetry   - tween.from.symmetry) * e;
        // `speed` isn't a static display value — it's fed straight into shaderClock
        // accumulation below (dt * currentSpeed), so it's a *rate*, not a position.
        visual.speed       = tween.from.speed       + (tween.to.speed       - tween.from.speed) * t;
        visual.intensity  = tween.from.intensity  + (tween.to.intensity  - tween.from.intensity) * e;
        visual.iterations = tween.from.iterations + (tween.to.iterations - tween.from.iterations) * e;
        visual.hueShift   = tween.from.hueShift   + tween.hueDelta * e;

        if (t >= 1) tween = null;
    }

    uniforms.uLevel.value      = visual.level;
    uniforms.uSymmetry.value   = Math.max(2, visual.symmetry); // shader crossfades between floor/ceil for a seamless shape

    const currentSpeed = Math.min(visual.speed * userSpeedMult, MAX_SHADER_SPEED);
    shaderClock += dt * currentSpeed;
    uniforms.uTime.value       = shaderClock; // accumulated clock, not raw elapsed time — see note above

    uniforms.uIntensity.value  = visual.intensity * userIntensityMult;
    uniforms.uIterations.value = visual.iterations;
    uniforms.uHueShift.value   = visual.hueShift;
    uniforms.uNegative.value   = 0.0; // color inversion disabled — the reading stays a positive image

    renderer.render(scene, camera);
}
animate();
