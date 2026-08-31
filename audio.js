// ==========================================================================
// audio.js — Ambient pad engine for dreamcore/lofi
// Modified for stable keys and reverb‑washed chord changes
// ==========================================================================

let audioCtx = null;
let audioNodes = null;
let audioEnabled = false;
let volumeLevel = 1.0; // 0..1, set by the hover slider; independent of mute state
const MAX_GAIN = 0.28;
// Background pad "hum" turned down to 75% of its original level so the
// bowl dings/rim-runs read more clearly above it.
const PAD_HUM_SCALE = 0.5;

// --- Dream‑pop chord library (simplified but lush) ---
const CHORD_LIBRARY = [
    { name: "Cmaj7",  offsets: [0, 4, 7, 11] },
    { name: "Am7",    offsets: [0, 3, 7, 10] },
    { name: "Fmaj7",  offsets: [0, 4, 7, 11] },
    { name: "G7",     offsets: [0, 4, 7, 10] },
    { name: "Dm7",    offsets: [0, 3, 7, 10] },
    { name: "Em7",    offsets: [0, 3, 7, 10] },
    { name: "Fsus2",  offsets: [0, 2, 7] },
    { name: "Csus2",  offsets: [0, 2, 7] },
    { name: "Asus2",  offsets: [0, 2, 7] },
];

// Functional harmony transitions (smooth voice leading)
const CHORD_TRANSITIONS = {
    0: [1, 2, 4, 7, 0],
    7: [1, 2, 4, 0, 7],
    1: [2, 4, 3, 0, 8],
    8: [2, 4, 3, 1, 0],
    2: [3, 4, 0, 6, 2],
    6: [3, 4, 0, 2, 6],
    4: [3, 5, 0, 2, 4],
    5: [0, 4, 3, 1, 5],
    3: [0, 1, 5, 7, 3],
};

let chordIndex = 0;
let lastQuantumBytes = null;

// --- Tuning system ---
// Equal temperament (12-TET) is what almost all software synths use by
// default, but every interval except the octave is very slightly "out of
// tune" relative to the natural harmonic series — that's what causes the
// faint beating/roughness you hear in sustained ET chords. Just intonation
// uses small-integer frequency ratios instead, so intervals lock together
// with no beating at all. For a resting/meditative drone this reads as
// noticeably calmer and more resonant, at the cost of the chord no longer
// being transposable to an arbitrary root without re-tuning (fine here,
// since the root is fixed anyway).
let USE_JUST_INTONATION = true;
const JUST_RATIOS = {
    0: 1 / 1,   // unison
    2: 9 / 8,   // major second   (sus2)
    3: 6 / 5,   // minor third
    4: 5 / 4,   // major third
    7: 3 / 2,   // perfect fifth
    10: 16 / 9, // minor seventh
    11: 15 / 8, // major seventh
};
function offsetToRatio(offset) {
    if (USE_JUST_INTONATION && JUST_RATIOS[offset] !== undefined) return JUST_RATIOS[offset];
    return Math.pow(2, offset / 12); // equal-temperament fallback
}

// Slower harmonic motion — "floating at the edge of the universe" instead
// of a lofi loop. Chord changes should feel like they arrive over a long
// stretch of time, not on a beat.
const CHORD_DURATION_S = 55; // baseline seconds per chord
const CHORD_DURATION_JITTER_S = 18; // +/- randomization so changes don't land on a metronome
let chordTimer = null;
let chimeEnabled = true;
let bowlDingEnabled = true;
let starfieldEnabled = true;
let organicTimingEnabled = true;
let breathDepthNode = null; // set once initAudio runs, so we can turn the swell up/down live
let tideDepthNode = null;
const BREATH_DEPTH_ON = 0.035;
const TIDE_DEPTH_ON = 0.0018;

// --- Voices — added a 5th, sub-octave voice for deep-space weight ---
const NUM_PAD_VOICES = 5;
const VOICE_OCTAVE_MULT = [0.25, 0.5, 1.0, 1.0, 2.0];
const VOICE_PAN = [0, -0.3, -0.5, 0.5, 0.3];

// --- Fixed root (C3) — we never change it ---
const BASE_ROOT_FREQ = 130.81; // C3
let currentRootFreq = BASE_ROOT_FREQ;

// --- Effects nodes ---
let delayNode, delayFeedback, delayFilter, reverbNode;
let masterGain, compressor, saturator;

// --- Starfield shimmer (quantum-driven) ---
let starfieldTimer = null;
// --- Bowl dings (quantum-driven, independent of chord changes) ---
let bowlDingTimer = null;
// --- Bowl rim-runs (mallet circling the rim — a distinct technique from a
// struck ding: friction-driven, builds gradually, sustains with a wavering
// "singing" tone, then fades as contact eases off) ---
let bowlRimRunTimer = null;
let bowlRimRunEnabled = true;

// --- Utility ---
// Reverb impulse-response data is heavy to generate (seconds of stereo
// noise with a per-sample decay envelope) so we precompute the raw
// Float32Arrays eagerly at script load — well before the user's first
// interaction — instead of doing it synchronously inside initAudio().
// That first interaction is also when the WebGL loop and UI are getting
// set up, so doing ~1M+ Math.pow calls at that exact moment was the
// source of the audio-start stutter. Building the arrays doesn't need
// an AudioContext, only sampleRate, so we can do it immediately; we just
// wrap the finished arrays in a real AudioBuffer once the context exists.
const IMPULSE_DURATION_S = 6.0; // was 16s — the tail is already near-silent
                                  // well before that, so this sounds the same
                                  // while cutting the precompute ~3x
const IMPULSE_DECAY = 4.0;
const IMPULSE_SAMPLE_RATE = 44100; // generated ahead of time at a fixed rate;
                                     // AudioContext sample rate is almost
                                     // always 44100/48000 and a slight
                                     // mismatch here is inaudible for noise

const NOISE_DURATION_S = 4.0;

// Build the raw sample data synchronously, but eagerly at script-load time —
// before the user's first interaction — rather than inside initAudio(). The
// animation loop's continuous requestAnimationFrame calls (started at the
// bottom of animation.js on page load) leave the browser very little true
// "idle" time, so an earlier requestIdleCallback-based version of this could
// stall for a long time and leave the fast path unready — worth avoiding
// that whole class of timing bug. Running it once, synchronously, right as
// the script parses (before Three.js/animation.js even run, since audio.js
// loads first) still gets this off the moment sound actually starts.
function buildImpulseData(duration, decay, rate) {
    const length = Math.floor(rate * duration);
    const channels = [new Float32Array(length), new Float32Array(length)];
    for (let ch = 0; ch < 2; ch++) {
        const data = channels[ch];
        for (let i = 0; i < length; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
        }
    }
    return { rate, channels };
}

function buildNoiseData(duration, rate) {
    const data = new Float32Array(Math.floor(rate * duration));
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.15;
    return data;
}

let precomputedImpulseData = buildImpulseData(IMPULSE_DURATION_S, IMPULSE_DECAY, IMPULSE_SAMPLE_RATE);
let precomputedNoiseData = buildNoiseData(NOISE_DURATION_S, IMPULSE_SAMPLE_RATE);

// Short burst of noise for the mallet "strike" transient at the start of
// each bowl ding — real singing bowls have a soft thonk of the mallet
// hitting the rim before the metal rings out. Shaped with its own fast
// decay so it reads as a strike, not a click.
const STRIKE_NOISE_DURATION_S = 0.4;
function buildStrikeNoiseData(duration, rate) {
    const length = Math.floor(rate * duration);
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3.0);
    }
    return data;
}
let precomputedStrikeNoiseData = buildStrikeNoiseData(STRIKE_NOISE_DURATION_S, IMPULSE_SAMPLE_RATE);

function buildImpulse(duration, decay) {
    // Fast path: reuse the eagerly-computed sample data, but wrap it in an
    // AudioBuffer at the *real* context sample rate. ConvolverNode.buffer
    // requires an exact sample-rate match with the AudioContext (unlike
    // AudioBufferSourceNode, which resamples automatically) — using the
    // assumed 44.1kHz generation rate here throws on any 48kHz system,
    // which is most of them, and aborts initAudio() partway through with
    // no audible symptom besides "no sound." The sample data itself is
    // shaped noise, so playing it back at a slightly different rate than
    // it was generated for just changes the reverb tail length by a few
    // hundred ms — inaudible for this use.
    if (precomputedImpulseData) {
        const { channels } = precomputedImpulseData;
        const impulse = audioCtx.createBuffer(2, channels[0].length, audioCtx.sampleRate);
        impulse.getChannelData(0).set(channels[0]);
        impulse.getChannelData(1).set(channels[1]);
        precomputedImpulseData = null; // one-shot; free the reference
        return impulse;
    }
    // Fallback: build synchronously (e.g. initAudio somehow ran before
    // the module finished evaluating, or buildImpulse is called again).
    const rate = audioCtx.sampleRate;
    const length = Math.floor(rate * duration);
    const impulse = audioCtx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
        const data = impulse.getChannelData(ch);
        for (let i = 0; i < length; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
        }
    }
    return impulse;
}

function buildSaturationCurve(drive) {
    const n = 1024;
    const curve = new Float32Array(n);
    const k = Math.max(0.001, drive);
    const norm = Math.tanh(k);
    for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(k * x) / norm;
    }
    return curve;
}

// Voice leading — unchanged (already good)
function voiceLeadingFreqs(currentFreqs, chordOffsets, rootFreq) {
    const newFreqs = new Array(currentFreqs.length);
    const usedIndices = new Set();
    for (let i = 0; i < currentFreqs.length; i++) {
        let bestIndex = 0, bestDist = Infinity;
        const octaveMult = VOICE_OCTAVE_MULT[i];
        for (let j = 0; j < chordOffsets.length; j++) {
            const off = chordOffsets[j];
            const candidate = rootFreq * offsetToRatio(off) * octaveMult;
            const dist = Math.abs(Math.log2(candidate / currentFreqs[i])) + (usedIndices.has(j) ? 0.5 : 0);
            if (dist < bestDist) { bestDist = dist; bestIndex = j; }
        }
        usedIndices.add(bestIndex);
        newFreqs[i] = rootFreq * offsetToRatio(chordOffsets[bestIndex]) * octaveMult;
    }
    return newFreqs;
}

// --- Init ---
function initAudio() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // Master gain
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0;

    // Coherence-breathing swell — ~0.09Hz is ~5.5 cycles/minute, the range
    // used in slow-breathing/HRV-coherence work. Applied as a small signal
    // added on top of the master gain's intrinsic value, so it rides along
    // under the fade-in/out and doesn't fight them.
    const breathLFO = audioCtx.createOscillator();
    breathLFO.type = "sine";
    breathLFO.frequency.value = 0.09;
    const breathDepth = audioCtx.createGain();
    breathDepth.gain.value = BREATH_DEPTH_ON; // subtle — should read as "alive", not "pumping"
    breathLFO.connect(breathDepth);
    breathDepth.connect(masterGain.gain);
    breathLFO.start();
    breathDepthNode = breathDepth;

    // Additional low‑pass on master to darken everything — even darker,
    // for a muffled, far-away feeling.
    const masterFilter = audioCtx.createBiquadFilter();
    masterFilter.type = "lowpass";
    masterFilter.frequency.value = 550;
    masterFilter.Q.value = 0.4;

    // Gentle saturation
    saturator = audioCtx.createWaveShaper();
    saturator.curve = buildSaturationCurve(0.7);
    saturator.oversample = "4x";
    saturator.connect(masterFilter);
    masterFilter.connect(masterGain);
    masterGain.connect(audioCtx.destination);

    // Soft compressor
    compressor = audioCtx.createDynamicsCompressor();
    compressor.threshold.value = -32;
    compressor.knee.value = 34;
    compressor.ratio.value = 2.2;
    compressor.attack.value = 1.2;
    compressor.release.value = 3.0;
    compressor.connect(saturator);

    // Reverb — much longer & darker: a cathedral the size of a galaxy
    reverbNode = audioCtx.createConvolver();
    reverbNode.buffer = buildImpulse(IMPULSE_DURATION_S, IMPULSE_DECAY); // longer decay
    const reverbSend = audioCtx.createGain();
    reverbSend.gain.value = 0.85; // more wet
    reverbSend.connect(reverbNode);
    reverbNode.connect(compressor);

    // Stereo delay — longer, slower, barely-there feedback: distant echoes
    delayNode = audioCtx.createDelay(5.0);
    delayNode.delayTime.value = 1.4;
    delayFeedback = audioCtx.createGain();
    delayFeedback.gain.value = 0.25;
    delayFilter = audioCtx.createBiquadFilter();
    delayFilter.type = "lowpass";
    delayFilter.frequency.value = 1200;
    const delaySend = audioCtx.createGain();
    delaySend.gain.value = 0.35;
    delaySend.connect(delayNode);
    delayNode.connect(delayFilter);
    delayFilter.connect(delayFeedback);
    delayFeedback.connect(delayNode);
    delayFilter.connect(compressor);
    delayFilter.connect(reverbSend);

    // Slow wow on delay — gentle pitch instability, like sound bending
    // across huge distances
    const delayWowLFO = audioCtx.createOscillator();
    delayWowLFO.type = "sine";
    delayWowLFO.frequency.value = 0.05;
    const delayWowGain = audioCtx.createGain();
    delayWowGain.gain.value = 0.01;
    delayWowLFO.connect(delayWowGain);
    delayWowGain.connect(delayNode.delayTime);
    delayWowLFO.start();

    const dryGain = audioCtx.createGain();
    dryGain.gain.value = 0.35; // drier signal mostly buried under reverb
    dryGain.connect(compressor);

    // Pad LFOs (only for filter modulation, not pitch)
    const filterLFOs = [];

    // --- Pad voices ---
    const padVoices = [];
    for (let i = 0; i < NUM_PAD_VOICES; i++) {
        const osc1 = audioCtx.createOscillator();
        const osc2 = audioCtx.createOscillator();
        osc1.type = "sine";
        osc2.type = "triangle";
        osc1.detune.value = -1.5 + i * 0.6;
        osc2.detune.value = 1.5 - i * 0.6;

        const gainNode = audioCtx.createGain();
        // sub voice (i===0) carries more energy but sits low in the spectrum
        gainNode.gain.value = (i === 0 ? 0.05 : 0.013) * PAD_HUM_SCALE;

        const filter = audioCtx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = i === 0 ? 260 : 550 + i * 70;
        filter.Q.value = 0.3;

        // Very slow LFO on filter — movement so slow it reads as breathing,
        // not modulation
        const lfo = audioCtx.createOscillator();
        lfo.type = "sine";
        lfo.frequency.value = 0.015 + i * 0.008;
        const lfoGain = audioCtx.createGain();
        lfoGain.gain.value = i === 0 ? 15 : 25 + i * 15;
        lfo.connect(lfoGain);
        lfoGain.connect(filter.frequency);
        lfo.start();
        filterLFOs.push(lfo);

        const panner = audioCtx.createStereoPanner();
        panner.pan.value = VOICE_PAN[i % VOICE_PAN.length];

        // Slow stereo drift — sound gently orbiting instead of sitting static
        const panLFO = audioCtx.createOscillator();
        panLFO.type = "sine";
        panLFO.frequency.value = 0.006 + i * 0.003;
        const panLFOGain = audioCtx.createGain();
        panLFOGain.gain.value = 0.15;
        panLFO.connect(panLFOGain);
        panLFOGain.connect(panner.pan);
        panLFO.start();

        osc1.connect(filter);
        osc2.connect(filter);
        filter.connect(gainNode);
        gainNode.connect(panner);
        panner.connect(dryGain);
        panner.connect(delaySend);

        osc1.start();
        osc2.start();

        padVoices.push({
            osc1, osc2, filter, gainNode, panner,
            currentFreq: 110 / VOICE_OCTAVE_MULT[i],
            targetGain: gainNode.gain.value,
        });
    }

    // --- Soft noise bed — quieter, darker: cosmic background hiss ---
    // Same chunked-precompute trick as the reverb impulse. Fall back to a
    // synchronous build only in the unlikely case the user interacts before
    // the idle-time precompute has finished.
    let noiseData = precomputedNoiseData;
    if (!noiseData) {
        noiseData = new Float32Array(Math.floor(audioCtx.sampleRate * NOISE_DURATION_S));
        for (let i = 0; i < noiseData.length; i++) noiseData[i] = (Math.random() * 2 - 1) * 0.15;
    }
    const noiseBuffer = audioCtx.createBuffer(1, noiseData.length, audioCtx.sampleRate);
    noiseBuffer.getChannelData(0).set(noiseData);
    const noise = audioCtx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;
    const noiseFilter = audioCtx.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = 500;
    noiseFilter.Q.value = 0.5;
    const noiseGain = audioCtx.createGain();
    noiseGain.gain.value = 0.005;
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(dryGain);
    noiseGain.connect(delaySend);
    noise.start();

    // Slow "tide" — the noise bed swells and recedes on its own unhurried
    // cycle (~90s) instead of sitting at a constant level, so it reads as
    // distant surf/atmosphere rather than tape hiss.
    const tideLFO = audioCtx.createOscillator();
    tideLFO.type = "sine";
    tideLFO.frequency.value = 0.011;
    const tideDepth = audioCtx.createGain();
    tideDepth.gain.value = TIDE_DEPTH_ON; // small — layers additively on noiseGain's intrinsic value
    tideLFO.connect(tideDepth);
    tideDepth.connect(noiseGain.gain);
    tideLFO.start();
    tideDepthNode = tideDepth;

    // --- Bowl-strike synthesis --------------------------------------------
    // Shared by the chord-change chime and the periodic bowl dings below.
    // A real struck singing bowl has two ingredients this was missing
    // before: (1) a soft "thonk" of the mallet hitting the rim — modeled
    // here as a short bandpassed noise burst — and (2) several *inharmonic*
    // ringing partials (not clean octaves) that beat slowly against each
    // other, which is what gives a struck bowl its shimmering, "alive"
    // quality instead of a plain sine ping.
    const strikeNoiseBuffer = audioCtx.createBuffer(
        1, precomputedStrikeNoiseData.length, audioCtx.sampleRate
    );
    strikeNoiseBuffer.getChannelData(0).set(precomputedStrikeNoiseData);

    const BOWL_PARTIALS = [
        { mult: 1.000, detune: 0, gain: 1.00 },
        { mult: 1.003, detune: 0, gain: 0.55 }, // near-unison pair -> slow natural beating
        { mult: 2.76,  detune: 0, gain: 0.34 }, // inharmonic overtone (typical of bowls)
        { mult: 2.79,  detune: 0, gain: 0.20 },
        { mult: 4.12,  detune: 0, gain: 0.14 },
        { mult: 5.40,  detune: 0, gain: 0.08 },
    ];

    function playBowlStrike(freq, opts = {}) {
        if (!audioCtx || !audioNodes) return;
        const now = audioCtx.currentTime;
        const {
            peak = 0.03,      // overall loudness of the ring
            attack = 0.045,   // fast — this is a strike, not a swell
            decay = 5.0,      // ring-out time constant
            pan = 0,
            strikeLevel = 0.16, // loudness of the mallet-hit transient
        } = opts;

        // Mallet strike transient
        const strikeSrc = audioCtx.createBufferSource();
        strikeSrc.buffer = strikeNoiseBuffer;
        const strikeFilter = audioCtx.createBiquadFilter();
        strikeFilter.type = "bandpass";
        strikeFilter.frequency.value = freq * 1.5;
        strikeFilter.Q.value = 0.8;
        const strikeGain = audioCtx.createGain();
        strikeGain.gain.value = 0;
        const strikePan = audioCtx.createStereoPanner();
        strikePan.pan.value = pan;

        strikeSrc.connect(strikeFilter);
        strikeFilter.connect(strikeGain);
        strikeGain.connect(strikePan);
        strikePan.connect(audioNodes.dryGain);
        strikePan.connect(audioNodes.reverbSend);

        strikeSrc.start(now);
        strikeGain.gain.setTargetAtTime(strikeLevel, now, 0.006);
        strikeGain.gain.setTargetAtTime(0, now + 0.02, 0.09);
        strikeSrc.stop(now + STRIKE_NOISE_DURATION_S);

        // Ringing partials
        BOWL_PARTIALS.forEach((p) => {
            const osc = audioCtx.createOscillator();
            osc.type = "sine";
            osc.frequency.value = freq * p.mult;
            if (p.detune) osc.detune.value = p.detune;

            const g = audioCtx.createGain();
            g.gain.value = 0;
            const pn = audioCtx.createStereoPanner();
            pn.pan.value = Math.max(-1, Math.min(1, pan + (Math.random() * 2 - 1) * 0.08));

            osc.connect(g);
            g.connect(pn);
            pn.connect(audioNodes.reverbSend);
            pn.connect(audioNodes.dryGain);
            pn.connect(audioNodes.delaySend);

            osc.start(now);
            g.gain.setTargetAtTime(peak * p.gain, now, attack);
            g.gain.setTargetAtTime(0, now + attack + 0.15, decay);
            osc.stop(now + attack + decay * 6 + 1);
        });
    }

    // --- Starfield shimmer: sparse, quantum-timed high "twinkles" sent
    // mostly to reverb, so each one blooms and dissolves like a distant
    // star. Pitch and timing both draw on lastQuantumBytes when available,
    // falling back to Math.random(). ---
    function pluckStar() {
        if (!audioEnabled || !starfieldEnabled) return;
        const now = audioCtx.currentTime;
        const offsets = audioNodes ? audioNodes.currentChordOffsets : [0, 4, 7, 11];

        let byteA = null, byteB = null;
        if (lastQuantumBytes && lastQuantumBytes.length) {
            byteA = lastQuantumBytes[Math.floor(Math.random() * lastQuantumBytes.length)];
            byteB = lastQuantumBytes[Math.floor(Math.random() * lastQuantumBytes.length)];
        }
        const off = offsets[(byteA !== null ? byteA : Math.floor(Math.random() * 256)) % offsets.length];
        const octave = 3 + ((byteB !== null ? byteB : Math.floor(Math.random() * 256)) % 2);
        const freq = currentRootFreq * offsetToRatio(off) * Math.pow(2, octave);

        const osc = audioCtx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;

        const starGain = audioCtx.createGain();
        starGain.gain.value = 0;
        const starPan = audioCtx.createStereoPanner();
        starPan.pan.value = (Math.random() * 2 - 1) * 0.7;

        osc.connect(starGain);
        starGain.connect(starPan);
        starPan.connect(reverbSend);
        starPan.connect(delaySend);
        starPan.connect(dryGain);

        osc.start(now);
        starGain.gain.setTargetAtTime(0.02, now, 1.2);
        starGain.gain.setTargetAtTime(0, now + 1.5, 3.0);
        osc.stop(now + 12);

        // Next star at a random, unhurried interval — quantum-influenced
        // when bytes are available
        const jitter = byteA !== null ? (byteA / 255) : Math.random();
        starfieldTimer = setTimeout(pluckStar, 6000 + jitter * 14000);
    }

    // --- Periodic bowl dings: short, percussive singing-bowl strikes that
    // recur on their own unhurried schedule, independent of the much-slower
    // chord changes — this is the "ding" texture from the reference track,
    // layered on top of the pad instead of only marking harmony shifts. ---
    function bowlDing() {
        if (!audioEnabled || !bowlDingEnabled) return;
        const offsets = audioNodes ? audioNodes.currentChordOffsets : [0, 4, 7, 11];

        let byteA = null, byteB = null, byteC = null;
        if (lastQuantumBytes && lastQuantumBytes.length) {
            byteA = lastQuantumBytes[Math.floor(Math.random() * lastQuantumBytes.length)];
            byteB = lastQuantumBytes[Math.floor(Math.random() * lastQuantumBytes.length)];
            byteC = lastQuantumBytes[Math.floor(Math.random() * lastQuantumBytes.length)];
        }
        const off = offsets[(byteA !== null ? byteA : Math.floor(Math.random() * 256)) % offsets.length];
        const octave = 2 + ((byteB !== null ? byteB : Math.floor(Math.random() * 256)) % 3); // spread across 3 octaves
        const freq = currentRootFreq * offsetToRatio(off) * Math.pow(2, octave);
        const pan = ((byteC !== null ? byteC : Math.floor(Math.random() * 256)) / 255) * 1.4 - 0.7;

        playBowlStrike(freq, {
            peak: 0.026,
            attack: 0.04,
            decay: 3.2,
            pan,
            strikeLevel: 0.14,
        });

        // "More singing bowls": roughly a third of the time, layer a second
        // bowl a few hundred ms later at a different chord tone/octave/pan
        // so strikes occasionally overlap into a small cluster instead of
        // always being single isolated dings.
        const wantsLayer = (byteC !== null ? byteC : Math.floor(Math.random() * 256)) < 85; // ~1/3
        if (wantsLayer) {
            const off2 = offsets[(byteB !== null ? byteB : Math.floor(Math.random() * 256)) % offsets.length];
            const octave2 = 2 + (((byteA !== null ? byteA : Math.floor(Math.random() * 256)) + 1) % 3);
            const freq2 = currentRootFreq * offsetToRatio(off2) * Math.pow(2, octave2);
            const pan2 = -pan; // opposite side of the stereo field
            const layerDelayMs = 220 + Math.random() * 380;
            setTimeout(() => {
                if (!audioEnabled || !bowlDingEnabled) return;
                playBowlStrike(freq2, {
                    peak: 0.02,
                    attack: 0.04,
                    decay: 2.8,
                    pan: pan2,
                    strikeLevel: 0.11,
                });
            }, layerDelayMs);
        }

        // Next ding at a random interval, 5-10s — quantum-influenced
        // when bytes are available
        const jitter = byteA !== null ? (byteA / 255) : Math.random();
        bowlDingTimer = setTimeout(bowlDing, 1000 + jitter * 9000);
    }

    // --- Periodic bowl rim-runs: a mallet circled around the rim, not
    // struck against it. Real rim-running is friction-driven, so unlike a
    // ding it can't just snap on — the tone has to build as the mallet
    // finds speed, hold with a slight wavering "singing" quality while
    // contact is sustained, then fade as the player eases off. This picks
    // one of the sustained bowl voices (built below) and drives its own
    // gain through that build → sustain(waver) → release arc, then goes
    // silent again until the next run — it is an occasional event, not a
    // drone that's always on. ---
    function bowlRimRun() {
        if (!audioEnabled || !bowlRimRunEnabled || !audioNodes || !audioNodes.bowlDroneVoices) return;
        const now = audioCtx.currentTime;
        const voices = audioNodes.bowlDroneVoices;

        let byteA = null;
        if (lastQuantumBytes && lastQuantumBytes.length) {
            byteA = lastQuantumBytes[Math.floor(Math.random() * lastQuantumBytes.length)];
        }
        const idx = (byteA !== null ? byteA : Math.floor(Math.random() * 256)) % voices.length;
        const v = voices[idx];

        // Build: the mallet is finding friction against the rim, tone
        // gradually catches and rises — slower than any struck attack.
        const buildTime = 2.5 + Math.random() * 1.8;
        // Sustain: contact is steady, the shimmer LFO already wired to
        // this voice's gain gives the natural waver of a running rim.
        const sustainTime = 4.5 + Math.random() * 5.0;
        // Release: contact eases off, the ring dies away.
        const releaseTime = 3.0 + Math.random() * 2.5;

        v.voiceGain.gain.cancelScheduledValues(now);
        v.voiceGain.gain.setTargetAtTime(v.targetGain, now, buildTime * 0.4);
        v.voiceGain.gain.setTargetAtTime(0, now + buildTime + sustainTime, releaseTime * 0.4);

        // Next rim-run after this one has fully died away, plus a long,
        // unhurried gap — this is a rarer event than a ding.
        const totalRunTime = buildTime + sustainTime + releaseTime;
        const jitter = byteA !== null ? (byteA / 255) : Math.random();
        bowlRimRunTimer = setTimeout(bowlRimRun, (totalRunTime + 14 + jitter * 26) * 1000);
    }

    // --- Sustained singing-bowl voices --------------------------------------
    // The bowlDing() strikes above are periodic and percussive. This is
    // different: a few bowl voices, built from the same near-unison beating
    // pair + inharmonic overtones as playBowlStrike, that stay silent by
    // default and are driven by bowlRimRun() above into an occasional
    // friction-run swell — so it reads as the same instrument played a
    // different way, not a second continuous layer.
    const NUM_BOWL_DRONE_VOICES = 3;
    const bowlDroneVoices = [];
    for (let i = 0; i < NUM_BOWL_DRONE_VOICES; i++) {
        const voiceGain = audioCtx.createGain();
        voiceGain.gain.value = 0; // faded up below, after everything is wired

        const panner = audioCtx.createStereoPanner();
        panner.pan.value = [-0.4, 0.45, -0.1][i % 3];

        // Slow amplitude shimmer so the sustained bowl still feels alive
        // rather than a static drone — mimics the way a real bowl's ring
        // slowly swells and thins.
        const shimmerLFO = audioCtx.createOscillator();
        shimmerLFO.type = "sine";
        shimmerLFO.frequency.value = 0.035 + i * 0.014;
        const shimmerDepth = audioCtx.createGain();
        shimmerDepth.gain.value = 0; // scaled to target gain once known
        shimmerLFO.connect(shimmerDepth);
        shimmerDepth.connect(voiceGain.gain);
        shimmerLFO.start();

        // Slow stereo drift, same idea as the pad voices
        const panLFO = audioCtx.createOscillator();
        panLFO.type = "sine";
        panLFO.frequency.value = 0.007 + i * 0.004;
        const panLFOGain = audioCtx.createGain();
        panLFOGain.gain.value = 0.2;
        panLFO.connect(panLFOGain);
        panLFOGain.connect(panner.pan);
        panLFO.start();

        // Reuse the same inharmonic partial ratios as the struck bowl
        // (near-unison pair for slow beating, plus two higher overtones)
        const oscs = BOWL_PARTIALS.slice(0, 4).map((p) => {
            const osc = audioCtx.createOscillator();
            osc.type = "sine";
            osc.frequency.value = 440 * p.mult; // real pitch set by applyChord
            const g = audioCtx.createGain();
            g.gain.value = p.gain;
            osc.connect(g);
            g.connect(voiceGain);
            osc.start();
            return { osc, mult: p.mult };
        });

        voiceGain.connect(panner);
        panner.connect(dryGain);
        panner.connect(reverbSend); // bowls should bloom into the reverb

        const targetGain = i === 0 ? 0.018 : 0.012;
        bowlDroneVoices.push({
            oscs, voiceGain, panner, shimmerDepth,
            currentFreq: 440,
            targetGain,
        });
        // Shimmer swings the gain by roughly +/-35% around its target
        shimmerDepth.gain.value = targetGain * 0.35;
    }

    audioNodes = {
        master: masterGain,
        padVoices,
        bowlDroneVoices,
        noiseFilter,
        noiseGain,
        reverbSend,
        delaySend,
        dryGain,
        delayNode,
        delayFeedback,
        delayFilter,
        compressor,
        reverbNode,
        currentRoot: BASE_ROOT_FREQ,
        currentChordOffsets: CHORD_LIBRARY[0].offsets,
        pluckStar,
        bowlDing,
        bowlRimRun,
        playBowlStrike,
    };

    // Start first chord
    chordIndex = 0;
    applyChord(audioCtx.currentTime, true);

    // Schedule chord changes — jittered rather than metronomic, so the
    // piece never settles into a predictable pulse the ear can count.
    scheduleNextChord();

    // Long, slow fade in — nothing here should arrive suddenly
    masterGain.gain.setTargetAtTime(MAX_GAIN * volumeLevel, audioCtx.currentTime, 3.0);

    // Kick off the starfield shimmer
    starfieldTimer = setTimeout(pluckStar, 4000 + Math.random() * 6000);

    // Kick off the periodic bowl dings
    bowlDingTimer = setTimeout(bowlDing, 3000 + Math.random() * 5000);

    // Kick off the periodic bowl rim-runs (rarer, slower arc than a ding)
    bowlRimRunTimer = setTimeout(bowlRimRun, 8000 + Math.random() * 12000);
}

function scheduleNextChord() {
    if (chordTimer) clearTimeout(chordTimer);
    let durationS = CHORD_DURATION_S;
    if (organicTimingEnabled) {
        const jitter = lastQuantumBytes && lastQuantumBytes.length
            ? (lastQuantumBytes[chordIndex % lastQuantumBytes.length] / 255)
            : Math.random();
        durationS = CHORD_DURATION_S + (jitter * 2 - 1) * CHORD_DURATION_JITTER_S;
    }
    chordTimer = setTimeout(() => {
        if (!audioEnabled) { scheduleNextChord(); return; }
        advanceChord();
        scheduleNextChord();
    }, durationS * 1000);
}

// --- Resonant chime — marks a chord change with a single long-decaying
// tone, like a singing bowl struck at the moment of transition. Gives the
// ear something to follow into the next chord instead of just noticing
// the pads moved. ---
function ringChime(rootOffset) {
    if (!audioCtx || !audioNodes || !audioEnabled) return;
    const freq = currentRootFreq * offsetToRatio(rootOffset) * 2; // one octave up
    // Full bowl-strike synthesis (mallet transient + inharmonic ringing
    // partials), shared with the periodic bowl dings below — this one's
    // louder and longer-ringing since it's marking a chord change.
    audioNodes.playBowlStrike(freq, {
        peak: 0.038,
        attack: 0.05,
        decay: 8.0,
        pan: 0,
        strikeLevel: 0.2,
    });
}

// --- Chord advancement (now also updates the root only here) ---
function advanceChord() {
    if (!audioCtx || !audioNodes) return;
    const candidates = CHORD_TRANSITIONS[chordIndex] || [0, 1, 2, 4];
    let pickIdx;
    if (lastQuantumBytes && lastQuantumBytes.length) {
        const b = lastQuantumBytes[(chordIndex * 7 + 3) % lastQuantumBytes.length];
        pickIdx = b % candidates.length;
    } else {
        pickIdx = Math.floor(Math.random() * candidates.length);
    }
    chordIndex = candidates[pickIdx];
    // Optionally nudge the root by a tiny amount when chord changes (but stay near C)
    // We'll keep it fixed to avoid pitch drift.
    currentRootFreq = BASE_ROOT_FREQ;
    audioNodes.currentRoot = currentRootFreq;
    applyChord(audioCtx.currentTime, false);
    if (chimeEnabled) ringChime(CHORD_LIBRARY[chordIndex].offsets[0]);
}

function applyChord(now, isInit) {
    if (!audioNodes) return;
    const root = currentRootFreq;
    const offsets = CHORD_LIBRARY[chordIndex].offsets;
    audioNodes.currentChordOffsets = offsets;

    const voices = audioNodes.padVoices;
    const currentFreqs = voices.map(v => v.currentFreq);
    const newFreqs = voiceLeadingFreqs(currentFreqs, offsets, root);

    for (let i = 0; i < voices.length; i++) {
        const freq = newFreqs[i];
        voices[i].currentFreq = freq;

        // Long, slow glide — chords should drift into place over several
        // seconds, not "change"
        const glideTime = isInit ? 0.1 : 6.0;
        voices[i].osc1.frequency.setTargetAtTime(freq, now, glideTime);
        voices[i].osc2.frequency.setTargetAtTime(freq * 1.001, now, glideTime);

        // Gentle envelope: dip then recover, slower and softer
        if (!isInit) {
            const v = voices[i];
            const currentGain = v.gainNode.gain.value;
            v.gainNode.gain.setTargetAtTime(currentGain * 0.5, now, 1.0);
            v.gainNode.gain.setTargetAtTime(v.targetGain, now + 2.0, 4.0);
        }
    }

    // Keep the continuous bowl-drone voices on chord tones too, up in the
    // bowl's own register (a couple octaves above the pad), gliding right
    // along with the chord change.
    const droneVoices = audioNodes.bowlDroneVoices;
    if (droneVoices) {
        const droneOctaveMult = [4, 8, 6]; // spread across ~2-2.5 octaves above root
        for (let i = 0; i < droneVoices.length; i++) {
            const off = offsets[i % offsets.length];
            const freq = root * offsetToRatio(off) * droneOctaveMult[i % droneOctaveMult.length];
            droneVoices[i].currentFreq = freq;
            const glideTime = isInit ? 0.1 : 6.0;
            droneVoices[i].oscs.forEach((o) => {
                o.osc.frequency.setTargetAtTime(freq * o.mult, now, glideTime);
            });
            // No fade-in here — these voices stay silent until bowlRimRun()
            // drives one through its build/sustain/release arc.
        }
    }
}

// --- Update audio parameters from quantum (no more root changes) ---
function updateAudioFromTarget(t, bytes) {
    if (!audioCtx || !audioNodes) return;
    const now = audioCtx.currentTime;
    const glide = 1.2;

    if (bytes && bytes.length) {
        lastQuantumBytes = bytes;
        // Optional: use bytes to influence filter or reverb, but not pitch
        const intensity = t.intensity || 0.3; // baseline stays calm
        // Slightly adjust filter cutoff based on intensity (still dark)
        const cutoffBase = 400 + intensity * 300;
        for (let i = 0; i < audioNodes.padVoices.length; i++) {
            const v = audioNodes.padVoices[i];
            v.filter.frequency.setTargetAtTime(cutoffBase + i * 50, now, glide * 1.5);
            // Target gain based on intensity, respecting each voice's own baseline
            const base = (i === 0 ? 0.05 : 0.013) * PAD_HUM_SCALE;
            const gainVal = base + intensity * 0.02 * PAD_HUM_SCALE;
            v.targetGain = gainVal;
            v.gainNode.gain.setTargetAtTime(gainVal, now, glide * 0.8);
        }
        // Noise and reverb respond slightly
        audioNodes.noiseFilter.frequency.setTargetAtTime(350 + intensity * 400, now, glide * 1.2);
        audioNodes.noiseGain.gain.setTargetAtTime(0.004 + intensity * 0.006, now, glide * 1.2);
        const reverbAmount = 0.7 + intensity * 0.2;
        audioNodes.reverbSend.gain.setTargetAtTime(Math.min(reverbAmount, 0.9), now, glide * 1.2);
        // Delay feedback
        const fb = 0.15 + intensity * 0.2;
        audioNodes.delayFeedback.gain.setTargetAtTime(Math.min(fb, 0.4), now, glide * 1.2);
    }
}

// --- Audio toggle ---
const audioToggleBtn = document.getElementById("audio-toggle");
const volumeSlider = document.getElementById("volume-slider");

// volumeLevel is 0..2 (100 = the original baseline volume, 200 = double it).
// The slider always shows 0 while muted/inactive; volumeLevel itself keeps
// the last non-zero level so unmuting restores it.
function syncSliderDisplay() {
    if (!volumeSlider) return;
    volumeSlider.value = audioEnabled ? Math.round(volumeLevel * 100) : 0;
}

audioToggleBtn.addEventListener("click", () => {
    if (!audioCtx) {
        initAudio();
        audioEnabled = true;
        updateAudioFromTarget(target);
        audioToggleBtn.classList.add("on");
        syncSliderDisplay(); // lands on the 100% midpoint the first time
        return;
    }
    if (audioEnabled) {
        audioNodes.master.gain.setTargetAtTime(0, audioCtx.currentTime, 2.5);
        audioEnabled = false;
        audioToggleBtn.classList.remove("on");
        if (starfieldTimer) clearTimeout(starfieldTimer);
        if (bowlDingTimer) clearTimeout(bowlDingTimer);
        if (bowlRimRunTimer) clearTimeout(bowlRimRunTimer);
        syncSliderDisplay(); // drops to 0
    } else {
        if (audioCtx.state === "suspended") audioCtx.resume();
        audioNodes.master.gain.setTargetAtTime(MAX_GAIN * volumeLevel, audioCtx.currentTime, 3.0);
        audioEnabled = true;
        updateAudioFromTarget(target);
        audioToggleBtn.classList.add("on");
        starfieldTimer = setTimeout(audioNodes.pluckStar, 3000 + Math.random() * 5000);
        bowlDingTimer = setTimeout(audioNodes.bowlDing, 3000 + Math.random() * 5000);
        bowlRimRunTimer = setTimeout(audioNodes.bowlRimRun, 8000 + Math.random() * 12000);
        syncSliderDisplay(); // restores last level
    }
});

// --- Volume slider (hover popup) ---
if (volumeSlider) {
    volumeSlider.min = "0";
    volumeSlider.max = "200";
    volumeSlider.value = "0"; // muted/inactive at first

    volumeSlider.addEventListener("input", () => {
        const v = Math.min(2, Math.max(0, volumeSlider.value / 100));

        if (v === 0) {
            // Dragged down to zero: mute, but remember the level we came from.
            if (audioCtx && audioNodes && audioEnabled) {
                audioNodes.master.gain.setTargetAtTime(0, audioCtx.currentTime, 0.3);
                audioEnabled = false;
                audioToggleBtn.classList.remove("on");
                if (starfieldTimer) clearTimeout(starfieldTimer);
                if (bowlDingTimer) clearTimeout(bowlDingTimer);
                if (bowlRimRunTimer) clearTimeout(bowlRimRunTimer);
            }
            return;
        }

        volumeLevel = v;

        if (!audioCtx) {
            // First interaction is via the slider — start the engine.
            initAudio();
            audioEnabled = true;
            updateAudioFromTarget(target);
            audioToggleBtn.classList.add("on");
        } else if (!audioEnabled) {
            // Was muted — dragging above zero unmutes at the dragged level.
            if (audioCtx.state === "suspended") audioCtx.resume();
            audioEnabled = true;
            updateAudioFromTarget(target);
            audioToggleBtn.classList.add("on");
            starfieldTimer = setTimeout(audioNodes.pluckStar, 3000 + Math.random() * 5000);
            bowlDingTimer = setTimeout(audioNodes.bowlDing, 3000 + Math.random() * 5000);
            bowlRimRunTimer = setTimeout(audioNodes.bowlRimRun, 8000 + Math.random() * 12000);
        }

        audioNodes.master.gain.setTargetAtTime(MAX_GAIN * volumeLevel, audioCtx.currentTime, 0.3);
    });

    // Dragging the slider shouldn't also drag/click the mute button underneath it,
    // and shouldn't collapse the surrounding chrome UI while adjusting.
    volumeSlider.addEventListener("click", (e) => e.stopPropagation());
    volumeSlider.addEventListener("pointerdown", (e) => e.stopPropagation());
}

// Expose globals (for animation.js)
window.audioEnabled = audioEnabled;
window.updateAudioFromTarget = updateAudioFromTarget;

// --- Live feature toggles (for a settings UI / A-B listening) ---
window.setBreathingEnabled = (on) => {
    if (breathDepthNode && audioCtx) breathDepthNode.gain.setTargetAtTime(on ? BREATH_DEPTH_ON : 0, audioCtx.currentTime, 1.5);
};
window.setTideEnabled = (on) => {
    if (tideDepthNode && audioCtx) tideDepthNode.gain.setTargetAtTime(on ? TIDE_DEPTH_ON : 0, audioCtx.currentTime, 1.5);
};
window.setChimeEnabled = (on) => { chimeEnabled = on; };
window.setBowlDingEnabled = (on) => {
    bowlDingEnabled = on;
    if (on && audioEnabled && audioNodes && !bowlDingTimer) {
        bowlDingTimer = setTimeout(audioNodes.bowlDing, 1000 + Math.random() * 3000);
    }
};
window.setBowlRimRunEnabled = (on) => {
    bowlRimRunEnabled = on;
    if (on && audioEnabled && audioNodes && !bowlRimRunTimer) {
        bowlRimRunTimer = setTimeout(audioNodes.bowlRimRun, 3000 + Math.random() * 6000);
    }
    if (!on && audioNodes && audioNodes.bowlDroneVoices && audioCtx) {
        // Fade any currently-running rim-run down cleanly rather than
        // cutting it off mid-swell.
        audioNodes.bowlDroneVoices.forEach((v) => {
            v.voiceGain.gain.cancelScheduledValues(audioCtx.currentTime);
            v.voiceGain.gain.setTargetAtTime(0, audioCtx.currentTime, 1.2);
        });
    }
};
window.setStarfieldEnabled = (on) => {
    starfieldEnabled = on;
    if (on && audioEnabled && audioNodes && !starfieldTimer) {
        starfieldTimer = setTimeout(audioNodes.pluckStar, 1000 + Math.random() * 3000);
    }
};
window.setJustIntonationEnabled = (on) => { USE_JUST_INTONATION = on; };
window.setOrganicTimingEnabled = (on) => { organicTimingEnabled = on; };

// --- Start audio on the very first interaction anywhere on the page ---
// so people don't have to find/press the volume button before anything happens.
// The volume control itself already starts audio on its own first click/drag
// (see audioToggleBtn / volumeSlider handlers above), so this listener steps
// aside for interactions that land on it and lets those handlers do the work.
let firstInteractionArmed = true;
const FIRST_INTERACTION_EVENTS = ["pointerdown", "keydown", "touchstart"];

function startAudioFromFirstInteraction() {
    if (audioCtx) return; // already running — nothing to do
    initAudio();
    audioEnabled = true;
    updateAudioFromTarget(typeof target !== "undefined" ? target : undefined);
    audioToggleBtn.classList.add("on");
    syncSliderDisplay();
    starfieldTimer = setTimeout(audioNodes.pluckStar, 3000 + Math.random() * 5000);
    bowlDingTimer = setTimeout(audioNodes.bowlDing, 3000 + Math.random() * 5000);
    bowlRimRunTimer = setTimeout(audioNodes.bowlRimRun, 8000 + Math.random() * 12000);
}

function handleFirstInteraction(e) {
    if (!firstInteractionArmed) return;
    // Let the volume control manage its own first interaction instead of
    // double-triggering (which would immediately re-toggle audio off).
    if (e.target && e.target.closest && e.target.closest("#volume-control")) return;

    firstInteractionArmed = false;
    FIRST_INTERACTION_EVENTS.forEach((evt) =>
        window.removeEventListener(evt, handleFirstInteraction, true)
    );
    startAudioFromFirstInteraction();
}

FIRST_INTERACTION_EVENTS.forEach((evt) =>
    window.addEventListener(evt, handleFirstInteraction, true)
);