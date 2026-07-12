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

// ---------- FIRST-VISIT HINT ("hold to channel energy") ----------
// Shown once, a beat after load so it doesn't compete with the initial
// chrome fade-in, and dismissed for good the moment the user first
// touches/holds the glass (or after a generous timeout, in case they never
// interact at all).
const hintEl = document.getElementById('hint');
let hintDismissed = false;
let hintShowTimer = null;
let hintAutoHideTimer = null;

function dismissHint() {
    if (hintDismissed) return;
    hintDismissed = true;
    clearTimeout(hintShowTimer);
    clearTimeout(hintAutoHideTimer);
    hintEl.classList.remove('visible');
}

hintShowTimer = setTimeout(() => {
    if (hintDismissed) return;
    hintEl.classList.add('visible');
    hintAutoHideTimer = setTimeout(dismissHint, 6000);
}, 1400);

// any charge start (pointerdown/touchstart on the glass) ends the hint
container.addEventListener('pointerdown', dismissHint);
container.addEventListener('touchstart', dismissHint, { passive: true });

// ---------- CHARGE RING (built entirely in JS — no HTML changes needed) ----------
// A small SVG progress ring that follows the pointer while the user holds
// down, filling up as the charge builds toward release.
const CHARGE_RING_SIZE = 120;
const CHARGE_RING_RADIUS = 48;
const CHARGE_RING_CIRC = 2 * Math.PI * CHARGE_RING_RADIUS;
// Lift the ring above the fingertip so a thumb resting on the glass doesn't
// block the view of it while charging.
const CHARGE_RING_LIFT = 0;

const chargeRingEl = document.createElement('div');
chargeRingEl.id = 'charge-ring';
chargeRingEl.style.cssText = `
    position: fixed;
    top: 0; left: 0;
    width: ${CHARGE_RING_SIZE}px; height: ${CHARGE_RING_SIZE}px;
    pointer-events: none;
    transform: translate(-9999px, -9999px);
    opacity: 0;
    z-index: 9999;
    transition: opacity 0.25s ease;
`;
chargeRingEl.innerHTML = `
    <div id="charge-ring-glow" style="
        position: absolute; top: 50%; left: 50%;
        width: ${CHARGE_RING_SIZE * 1.6}px; height: ${CHARGE_RING_SIZE * 1.6}px;
        transform: translate(-50%, -50%) scale(0.6);
        border-radius: 50%;
        background: radial-gradient(circle, rgba(255,255,255,0.9) 0%, rgba(255,220,150,0.35) 40%, rgba(255,220,150,0) 70%);
        opacity: 0;
        pointer-events: none;
        filter: blur(2px);
    "></div>
    <svg width="${CHARGE_RING_SIZE}" height="${CHARGE_RING_SIZE}" viewBox="0 0 ${CHARGE_RING_SIZE} ${CHARGE_RING_SIZE}" style="position: relative;">
        <circle cx="${CHARGE_RING_SIZE/2}" cy="${CHARGE_RING_SIZE/2}" r="${CHARGE_RING_RADIUS}"
            fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="4"></circle>
        <circle id="charge-ring-fill" cx="${CHARGE_RING_SIZE/2}" cy="${CHARGE_RING_SIZE/2}" r="${CHARGE_RING_RADIUS}"
            fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="5"
            stroke-linecap="round"
            stroke-dasharray="${CHARGE_RING_CIRC}"
            stroke-dashoffset="${CHARGE_RING_CIRC}"
            transform="rotate(-90 ${CHARGE_RING_SIZE/2} ${CHARGE_RING_SIZE/2})"></circle>
        <circle id="charge-ring-core" cx="${CHARGE_RING_SIZE/2}" cy="${CHARGE_RING_SIZE/2}" r="6"
            fill="rgba(255,255,255,0.8)"></circle>
    </svg>
`;
document.body.appendChild(chargeRingEl);
const chargeRingFill = chargeRingEl.querySelector('#charge-ring-fill');
const chargeRingCore = chargeRingEl.querySelector('#charge-ring-core');
const chargeRingGlow = chargeRingEl.querySelector('#charge-ring-glow');

function positionChargeRing(x, y) {
    chargeRingEl.style.transform = `translate(${x - CHARGE_RING_SIZE/2}px, ${y - CHARGE_RING_SIZE/2 - CHARGE_RING_LIFT}px)`;
}

// Caps how bright the glow behind the ring can get — keeps it from blowing
// out the screen once fully charged, while still reading as "maxed out".
const CHARGE_GLOW_MAX_OPACITY = 0.85;

function setChargeRingProgress(p) {
    // p: 0..1
    p = Math.max(0, Math.min(1, p));
    const full = p >= 1;

    const offset = CHARGE_RING_CIRC * (1 - p);
    chargeRingFill.setAttribute('stroke-dashoffset', String(offset));
    const coreScale = 1 + p * 1.4;
    chargeRingCore.setAttribute('r', String(6 * coreScale));

    // Ring + core brighten steadily as charge builds, then settle into a
    // warm gold once the limit is hit — the glow behind it caps out at
    // CHARGE_GLOW_MAX_OPACITY rather than climbing forever.
    const ringColor = full ? 'rgba(255,240,200,1)' : 'rgba(255,255,255,0.9)';
    chargeRingFill.setAttribute('stroke', ringColor);
    chargeRingFill.style.filter = `drop-shadow(0 0 ${2 + p * 10}px rgba(255,230,180,${0.3 + p * 0.6}))`;
    chargeRingCore.setAttribute('fill', full ? 'rgba(255,245,210,1)' : 'rgba(255,255,255,0.8)');

    const glowOpacity = Math.min(CHARGE_GLOW_MAX_OPACITY, p * p * CHARGE_GLOW_MAX_OPACITY);
    chargeRingGlow.style.opacity = String(glowOpacity);
    chargeRingGlow.style.transform = `translate(-50%, -50%) scale(${0.6 + p * 0.55})`;

    // A slow, gentle pulse once fully charged — signals "ready" without
    // ever exceeding the brightness cap.
    if (full) {
        chargeRingGlow.style.animation = 'charge-ring-pulse 0.9s ease-in-out infinite';
    } else {
        chargeRingGlow.style.animation = 'none';
    }
}

// Pulse keyframes for the fully-charged glow (injected once).
const chargeRingPulseStyle = document.createElement('style');
chargeRingPulseStyle.textContent = `
@keyframes charge-ring-pulse {
    0%, 100% { opacity: ${CHARGE_GLOW_MAX_OPACITY}; }
    50% { opacity: ${CHARGE_GLOW_MAX_OPACITY * 0.7}; }
}
`;
document.head.appendChild(chargeRingPulseStyle);

// ---------- ATTUNEMENT (user speed & luminance control) ----------
let userSpeedMult = 1.0;
let userIntensityMult = 1.0; // now user-adjustable via the Luminance slider

const speedSlider = document.getElementById('s-speed');
const vSpeed = document.getElementById('v-speed');

speedSlider.addEventListener('input', () => {
    userSpeedMult = parseFloat(speedSlider.value);
    vSpeed.textContent = userSpeedMult.toFixed(2) + '×';
});

const lumSlider = document.getElementById('s-lum');
const vLum = document.getElementById('v-lum');

lumSlider.addEventListener('input', () => {
    userIntensityMult = parseFloat(lumSlider.value);
    vLum.textContent = userIntensityMult.toFixed(2) + '×';
});

function flashSigil() {
    const peak = Math.min(1, 0.55 * userIntensityMult);
    sigilFlash.style.opacity = String(peak);
    setTimeout(() => { sigilFlash.style.opacity = '0'; }, 900);
}

// A brighter, harder flash used when a charge is released — scales with
// how far the charge built up (0..1).
function flashRelease(charge) {
    const peak = Math.min(1, 0.65 + 0.35 * charge);
    sigilFlash.style.transition = 'opacity 0.05s ease-out';
    sigilFlash.style.opacity = String(peak);
    setTimeout(() => {
        sigilFlash.style.transition = 'opacity 1.1s ease';
        sigilFlash.style.opacity = '0';
    }, 90);
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
    target.speed       = 0.03 + (b(2) / 255) * 0.57;             // 0.03 - 0.6 (same calm floor, but now the draw can occasionally land much faster)
    target.intensity  = 1.0;                                      // no longer drawn from entropy — luminance is now purely the user's Luminance slider (userIntensityMult)
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
    document.getElementById('f-speed').style.width = ((target.speed - 0.03) / 0.57 * 100) + '%';

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

// ---------- CHARGE & RELEASE (hold on the glass to build power) ----------
// Holding down on the glass (not on any UI chrome) charges up over
// CHARGE_MAX_MS. `chargeBoost` (0..1) is read each frame in animate() to
// brighten/tighten the pattern smoothly on top of whatever the tween is
// already doing. Releasing snaps everything forward: a hard flash, a
// fresh quantum draw, and the boost drains back to 0.
const CHARGE_MAX_MS = 2600;   // time to reach full charge
const CHARGE_MIN_MS = 180;    // below this, treat it as a simple tap/cast
const CHARGE_LUMINANCE_MAX = 3.2; // hard ceiling on extra brightness from charging — full charge reads as blindingly bright
const RELEASE_SPEED_BURST = 4.5;  // extra speed multiplier right at release, decaying back to normal
const RELEASE_DECAY_RATE = 2.5;   // how fast the release burst dies off (higher = snappier)

let chargePointerId = null;
let chargeStartTime = 0;
let charging = false;
let chargeBoost = 0; // smoothed 0..1, read by animate()
let releaseBoost = 0; // spikes on release, decays back to 0 — the "speed up to the end" burst

function chargeProgress() {
    if (!charging) return 0;
    return Math.min(1, (performance.now() - chargeStartTime) / CHARGE_MAX_MS);
}

function onChargeStart(e) {
    if (holding) return; // don't fight with "Hold Vision" freeze mode
    if (chargePointerId !== null) return;

    chargePointerId = e.pointerId !== undefined ? e.pointerId : 'touch';
    charging = true;
    chargeStartTime = performance.now();

    const x = e.clientX ?? (e.touches && e.touches[0].clientX);
    const y = e.clientY ?? (e.touches && e.touches[0].clientY);
    positionChargeRing(x, y);
    chargeRingEl.style.opacity = '1';
    setChargeRingProgress(0);
}

function onChargeMove(e) {
    if (!charging) return;
    const x = e.clientX ?? (e.touches && e.touches[0].clientX);
    const y = e.clientY ?? (e.touches && e.touches[0].clientY);
    if (x !== undefined && y !== undefined) positionChargeRing(x, y);
}

function onChargeEnd() {
    if (!charging) return;
    const elapsed = performance.now() - chargeStartTime;
    const progress = Math.min(1, elapsed / CHARGE_MAX_MS);
    charging = false;
    chargePointerId = null;
    chargeRingEl.style.opacity = '0';

    if (elapsed < CHARGE_MIN_MS) {
        // Quick tap — treat like a light cast, no dramatic release.
        if (!holding) refreshEntropy();
        return;
    }

    // Full release: hard flash scaled by how charged it got, then draw a
    // fresh reading — the charge "pays off" as a new vision. The pattern,
    // which held still while charging, now surges forward fast and eases
    // back to its normal speed.
    releaseBoost = RELEASE_SPEED_BURST * progress;
    flashRelease(progress);
    if (!holding) refreshEntropy();
    // chargeBoost itself decays smoothly to 0 inside animate().
}

const chargeSurface = container; // #canvas-container
chargeSurface.addEventListener('pointerdown', onChargeStart);
window.addEventListener('pointermove', onChargeMove, { passive: true });
window.addEventListener('pointerup', onChargeEnd);
window.addEventListener('pointercancel', onChargeEnd);
chargeSurface.addEventListener('touchstart', onChargeStart, { passive: true });
window.addEventListener('touchmove', onChargeMove, { passive: true });
window.addEventListener('touchend', onChargeEnd);
window.addEventListener('touchcancel', onChargeEnd);

const holdBtn = document.getElementById('btn-hold');
holdBtn.addEventListener('click', () => {
    holding = !holding;
    holdBtn.classList.toggle('active', holding);
    holdBtn.textContent = holding ? 'Release' : 'Hold Vision';
});

// ---------- ANIMATION LOOP ----------
const MAX_SHADER_SPEED = 0.2; // hard cap so the kaleidoscope motion never races or strobes, even with the slider maxed

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

    // Charge boost: rises toward the live charge progress while holding,
    // and relaxes back to 0 on its own after release (or if interrupted) —
    // smoothed rather than snapped so it never pops.
    const targetBoost = charging ? chargeProgress() : 0;
    const boostRate = charging ? 6.0 : 3.0; // charge climbs slower than release settles
    chargeBoost += (targetBoost - chargeBoost) * Math.min(1, dt * boostRate);
    if (Math.abs(chargeBoost) < 0.001) chargeBoost = 0;

    // Keep the ring's own fill/glow in sync every frame — not just on
    // pointer move — so it fills smoothly even if the user holds still.
    if (charging) {
        setChargeRingProgress(chargeProgress());
    }

    uniforms.uLevel.value      = visual.level + chargeBoost * 1.2;
    uniforms.uSymmetry.value   = Math.max(2, visual.symmetry + chargeBoost * 4); // shader crossfades between floor/ceil for a seamless shape

    // While charging, the pattern holds still — all motion pauses so the
    // charging feels like concentration/gathering rather than churning.
    // On release, a speed burst fires and eases back down to normal,
    // reading as the built-up energy surging forward.
    releaseBoost += (0 - releaseBoost) * Math.min(1, dt * RELEASE_DECAY_RATE);
    if (Math.abs(releaseBoost) < 0.001) releaseBoost = 0;

    if (!charging) {
        const currentSpeed = Math.min(visual.speed * userSpeedMult * (1 + releaseBoost), MAX_SHADER_SPEED * 3.0);
        shaderClock += dt * currentSpeed;
    }
    uniforms.uTime.value       = shaderClock; // accumulated clock, not raw elapsed time — see note above

    // Luminance climbs with charge on an ease-in curve (starts slow, builds
    // fast) so the buildup reads as "gathering light" rather than a flat
    // ramp, then hard-caps at CHARGE_LUMINANCE_MAX — full charge is
    // deliberately blown-out bright as the peak payoff moment.
    const luminanceBoost = Math.min(CHARGE_LUMINANCE_MAX, chargeBoost * chargeBoost * CHARGE_LUMINANCE_MAX);
    uniforms.uIntensity.value  = (visual.intensity * userIntensityMult) + luminanceBoost;
    uniforms.uIterations.value = visual.iterations;
    uniforms.uHueShift.value   = visual.hueShift + chargeBoost * 0.8;
    uniforms.uNegative.value   = 0.0; // color inversion disabled — the reading stays a positive image

    renderer.render(scene, camera);
}
animate();