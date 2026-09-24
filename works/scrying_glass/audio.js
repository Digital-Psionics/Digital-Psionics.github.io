// ==========================================================================
// audio.js — Ambient pad engine for dreamcore/lofi
// Modified for stable keys and reverb‑washed chord changes
// ==========================================================================

let audioCtx = null;
let audioNodes = null;
let audioEnabled = false;
let volumeLevel = 1.0; // 0..1, set by the hover slider; independent of mute state
const MAX_GAIN = 0.28;

// Lite tier for phones / low-core devices: shorter reverb, fewer bowl partials,
// fewer simultaneous strikes. Flip to false to force full quality everywhere.
const LITE = (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches)
    || (navigator.hardwareConcurrency || 8) <= 4;
const activeRimVoices = new Set(); // rim-run voices currently sounding (built on demand)
// Background pad "hum" turned down to 75% of its original level so the
// bowl dings/rim-runs read more clearly above it.
const PAD_HUM_SCALE = 0.4;

// --- Dream‑pop chord library (simplified but lush) ---
// Each chord now has its own root (semitones above the fixed C) plus intervals
// above that root. Previously every chord was built on C, so Fmaj7 == Cmaj7 and
// Am7/Dm7/Em7 all played as Cm7 - i.e. the pad kept flipping between a major and
// minor third over the same drone. G7's tritone is also swapped for a sweeter G6.
const CHORD_LIBRARY = [
    { name: "Cmaj7",  root: 0, offsets: [0, 4, 7, 11] },
    { name: "Am7",    root: 9, offsets: [0, 3, 7, 10] },
    { name: "Fmaj7",  root: 5, offsets: [0, 4, 7, 11] },
    { name: "G6",     root: 7, offsets: [0, 4, 7, 9] },
    { name: "Dm7",    root: 2, offsets: [0, 3, 7, 10] },
    { name: "Em7",    root: 4, offsets: [0, 3, 7, 10] },
    { name: "Fsus2",  root: 5, offsets: [0, 2, 7] },
    { name: "Csus2",  root: 0, offsets: [0, 2, 7] },
    { name: "Asus2",  root: 9, offsets: [0, 2, 7] },
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
    5: 4 / 3,   // perfect fourth (chord roots on F)
    7: 3 / 2,   // perfect fifth
    9: 5 / 3,   // major sixth (roots on A, G6 colour tone)
    10: 16 / 9, // minor seventh
    11: 15 / 8, // major seventh
};
function offsetToRatio(offset) {
    if (USE_JUST_INTONATION && JUST_RATIOS[offset] !== undefined) return JUST_RATIOS[offset];
    return Math.pow(2, offset / 12); // equal-temperament fallback
}

// Chord tones as ratios above the fixed C, folded into [1, 2). Intervals are
// tuned just from the chord's *own* root (so each chord is beat-free), and the
// root sits at its just ratio above C.
function chordRatios(chord) {
    const rootRatio = offsetToRatio(chord.root);
    return chord.offsets.map((off) => {
        let r = rootRatio * offsetToRatio(off);
        while (r >= 2) r /= 2;
        return r;
    });
}

// Slower harmonic motion — "floating at the edge of the universe" instead
// of a lofi loop. Chord changes should feel like they arrive over a long
// stretch of time, not on a beat.
const CHORD_DURATION_S = 45; // baseline seconds per chord
const CHORD_DURATION_JITTER_S = 15; // +/- randomization so changes don't land on a metronome
let chordTimer = null;
let chimeEnabled = true;
let bowlDingEnabled = true;
let starfieldEnabled = true;
let organicTimingEnabled = true;
let breathDepthNode = null; // set once initAudio runs, so we can turn the swell up/down live
let tideDepthNode = null;
let padBusNode = null, noiseSwitchNode = null;
let PAD_LEVEL = 0.5;      // extra multiplier on the whole pad layer (0 = no pad)
let NOISE_BED_ON = true;
const BREATH_DEPTH_ON = 0.035;
const TIDE_DEPTH_ON = 0.0018;

// --- Voices — added a 5th, sub-octave voice for deep-space weight ---
const NUM_PAD_VOICES = 5;
const VOICE_OCTAVE_MULT = [1.0, 1.0, 1.0, 2.0, 2.0]; // no sub/low voices: steady 33-100 Hz tones read as a mains-style hum
const VOICE_PAN = [0, -0.3, -0.5, 0.5, 0.3];

// Drone behaviour: each voice swells/ebbs on its own slow cycle, and chord
// changes are crossfades (fade out -> retune while silent -> fade in) instead of
// pitch slides. Notes shared with the next chord simply keep sounding.
const AMP_SWELL_DEPTH = 0.2;      // +/-50% of a voice's level over its own cycle
const CROSSFADE_OUT_S = 4.0;
const CROSSFADE_IN_S = 5.0;
function makeFadeCurve(rising) {
    const n = 32, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const v = 0.5 - 0.5 * Math.cos(Math.PI * i / (n - 1));
        c[i] = rising ? v : 1 - v;
    }
    return c;
}
const FADE_IN_CURVE = makeFadeCurve(true);
const FADE_OUT_CURVE = makeFadeCurve(false);

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
const IMPULSE_DURATION_S = LITE ? 2.5 : 4.0; // was 6s (16s before that) — the tail is already near-silent
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
function fastPow(t, p) {
    if (p === 4) { const t2 = t * t; return t2 * t2; }
    if (p === 3) return t * t * t;
    return Math.pow(t, p);
}

// Exponentially decaying noise that also darkens along the tail (one-pole
// lowpass whose cutoff falls with time), so the wash is smooth instead of hissy.
function fillImpulse(data, length, decay) {
    let y = 0;
    for (let i = 0; i < length; i++) {
        const x = i / length;
        const k = 0.6 - 0.5 * x;                       // bright -> dark
        y += k * ((Math.random() * 2 - 1) - y);
        data[i] = y * Math.sqrt((2 - k) / k) * fastPow(1 - x, decay); // sqrt term keeps level
    }
}

function buildImpulseData(duration, decay, rate) {
    const length = Math.floor(rate * duration);
    const channels = [new Float32Array(length), new Float32Array(length)];
    for (let ch = 0; ch < 2; ch++) {
        const data = channels[ch];
        fillImpulse(data, length, decay);
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
        data[i] = (Math.random() * 2 - 1) * fastPow(1 - i / length, 3);
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
        fillImpulse(data, length, decay);
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
function voiceLeadingFreqs(currentFreqs, ratios, rootFreq) {
    const newFreqs = new Array(currentFreqs.length);
    const usedIndices = new Set();
    for (let i = 0; i < currentFreqs.length; i++) {
        let bestIndex = 0, bestDist = Infinity;
        const octaveMult = VOICE_OCTAVE_MULT[i];
        for (let j = 0; j < ratios.length; j++) {
            const candidate = rootFreq * ratios[j] * octaveMult;
            const dist = Math.abs(Math.log2(candidate / currentFreqs[i])) + (usedIndices.has(j) ? 0.5 : 0);
            if (dist < bestDist) { bestDist = dist; bestIndex = j; }
        }
        usedIndices.add(bestIndex);
        newFreqs[i] = rootFreq * ratios[bestIndex] * octaveMult;
    }
    return newFreqs;
}

// --- Init ---
function initAudio() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "playback" });

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
    masterFilter.frequency.value = 1200; // was 550: muffled + long reverb read as 'underwater'
    masterFilter.Q.value = 0.4;

    // Gentle saturation
    saturator = audioCtx.createWaveShaper();
    saturator.curve = buildSaturationCurve(0.7);
    saturator.oversample = "none"; // 4x oversampling is costly and the master lowpass hides any aliasing
    saturator.connect(masterFilter);
    const masterHP = audioCtx.createBiquadFilter();
    masterHP.type = "highpass";
    masterHP.frequency.value = 110;
    masterHP.Q.value = 0.7;
    masterFilter.connect(masterHP);
    masterHP.connect(masterGain);
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
    reverbSend.gain.value = 0.7; // more wet
    reverbSend.connect(reverbNode);
    reverbNode.connect(compressor);

    // Stereo delay — longer, slower, barely-there feedback: distant echoes
    delayNode = audioCtx.createDelay(5.0);
    delayNode.delayTime.value = 1.4;
    delayFeedback = audioCtx.createGain();
    delayFeedback.gain.value = 0.2;
    delayFilter = audioCtx.createBiquadFilter();
    delayFilter.type = "lowpass";
    delayFilter.frequency.value = 1200;
    const delaySend = audioCtx.createGain();
    delaySend.gain.value = 0.22;
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
    delayWowGain.gain.value = 0.004; // less 'bending' pitch on echoes
    delayWowLFO.connect(delayWowGain);
    delayWowGain.connect(delayNode.delayTime);
    delayWowLFO.start();

    const dryGain = audioCtx.createGain();
    dryGain.gain.value = 0.35; // drier signal mostly buried under reverb
    dryGain.connect(compressor);

    // Whole-pad level control and noise-bed switch (see window.setPadLevel etc.)
    const padBus = audioCtx.createGain();
    padBus.gain.value = PAD_LEVEL;
    padBus.connect(dryGain);
    padBus.connect(delaySend);
    padBusNode = padBus;
    const noiseSwitch = audioCtx.createGain();
    noiseSwitch.gain.value = NOISE_BED_ON ? 1 : 0;
    noiseSwitch.connect(dryGain);
    noiseSwitch.connect(delaySend);
    noiseSwitchNode = noiseSwitch;

    // Pad LFOs (only for filter modulation, not pitch)
    const filterLFOs = [];

    // --- Pad voices ---
    const padVoices = [];
    for (let i = 0; i < NUM_PAD_VOICES; i++) {
        const osc1 = audioCtx.createOscillator();
        const osc2 = audioCtx.createOscillator();
        osc1.type = "sine";
		// 1. pure sine instead of triangle
		osc2.type = "sine";

		// 2. tighter detune — a few cents, not a chorus
		osc1.detune.value = -1.5 + i * 0.5;   // was -5 + i * 0.8
		osc2.detune.value =  1.5 - i * 0.5;   // was  5 - i * 0.8

		// 3. calmer amplitude sway
		const AMP_SWELL_DEPTH = 0.2;          // was 0.5

        const gainNode = audioCtx.createGain();
        // sub voice (i===0) carries more energy but sits low in the spectrum
        gainNode.gain.value = 0.013 * PAD_HUM_SCALE;

        // Crossfade envelope (0..1) used only for chord changes
        const swell = audioCtx.createGain();
        swell.gain.value = 1;

        // Independent slow swell per voice so the pad is a shifting texture,
        // not one flat constant tone.
        const ampLFO = audioCtx.createOscillator();
        ampLFO.type = "sine";
        ampLFO.frequency.value = 0.035 + i * 0.011 + Math.random() * 0.01;
        const ampDepth = audioCtx.createGain();
        ampDepth.gain.value = gainNode.gain.value * AMP_SWELL_DEPTH;
        ampLFO.connect(ampDepth);
        ampDepth.connect(gainNode.gain);
        ampLFO.start();

        const filter = audioCtx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = 900 + i * 80;
        filter.Q.value = 0.3;

        // Very slow LFO on filter — movement so slow it reads as breathing,
        // not modulation
        const lfo = audioCtx.createOscillator();
        lfo.type = "sine";
        lfo.frequency.value = 0.015 + i * 0.008;
        const lfoGain = audioCtx.createGain();
        lfoGain.gain.value = i === 0 ? 6 : 8 + i * 5;
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
        filter.connect(swell);
        swell.connect(gainNode);
        gainNode.connect(panner);
        panner.connect(padBus);

        osc1.start();
        osc2.start();

        padVoices.push({
            osc1, osc2, filter, gainNode, swell, panner,
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
    noiseGain.connect(noiseSwitch);
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

    // Modal model of a struck bowl. Ratios follow typical singing-bowl modes
    // (~1 : 2.7 : 5.2 : 8.4). Each mode is really a *pair* split by ~0.3-0.4%
    // (bowls are never perfectly symmetric), which gives the slow wah-wah beat.
    // `dm` scales the ring-down time: upper modes die much faster than the
    // fundamental, so a strike starts bright and mellows as it decays.
    const BOWL_PARTIALS = [
        { mult: 1.000, gain: 1.00, dm: 1.00 },
        { mult: 1.004, gain: 0.60, dm: 1.00 },
        { mult: 2.710, gain: 0.38, dm: 0.50 },
        { mult: 2.730, gain: 0.24, dm: 0.50 },
        { mult: 5.150, gain: 0.16, dm: 0.22 },
        { mult: 8.400, gain: 0.07, dm: 0.10 },
    ];
    const ACTIVE_PARTIALS = LITE ? BOWL_PARTIALS.slice(0, 4) : BOWL_PARTIALS;

    // Cap simultaneous strikes; extras are skipped.
    let activeStrikes = 0;
    const MAX_ACTIVE_STRIKES = LITE ? 4 : 8;

    

    // --- Starfield shimmer: sparse, quantum-timed high "twinkles" sent
    // mostly to reverb, so each one blooms and dissolves like a distant
    // star. Pitch and timing both draw on lastQuantumBytes when available,
    // falling back to Math.random(). ---
    function pluckStar() {
        if (!audioEnabled || !starfieldEnabled) return;
        const now = audioCtx.currentTime;
        const offsets = audioNodes ? audioNodes.currentChordRatios : [1, 5 / 4, 3 / 2, 15 / 8];

        let byteA = null, byteB = null;
        if (lastQuantumBytes && lastQuantumBytes.length) {
            byteA = lastQuantumBytes[Math.floor(Math.random() * lastQuantumBytes.length)];
            byteB = lastQuantumBytes[Math.floor(Math.random() * lastQuantumBytes.length)];
        }
        const off = offsets[(byteA !== null ? byteA : Math.floor(Math.random() * 256)) % offsets.length];
        const octave = 2 + ((byteB !== null ? byteB : Math.floor(Math.random() * 256)) % 2);
        const freq = currentRootFreq * off * Math.pow(2, octave);

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
        starGain.gain.setTargetAtTime(0.012, now, 1.2);
        starGain.gain.setTargetAtTime(0, now + 1.5, 3.0);
        osc.stop(now + 12);
        osc.onended = () => { osc.disconnect(); starGain.disconnect(); starPan.disconnect(); };

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
        const offsets = audioNodes ? audioNodes.currentChordRatios : [1, 5 / 4, 3 / 2, 15 / 8];

        let byteA = null, byteB = null, byteC = null;
        if (lastQuantumBytes && lastQuantumBytes.length) {
            byteA = lastQuantumBytes[Math.floor(Math.random() * lastQuantumBytes.length)];
            byteB = lastQuantumBytes[Math.floor(Math.random() * lastQuantumBytes.length)];
            byteC = lastQuantumBytes[Math.floor(Math.random() * lastQuantumBytes.length)];
        }
        const off = offsets[(byteA !== null ? byteA : Math.floor(Math.random() * 256)) % offsets.length];
        const octave = 1 + ((byteB !== null ? byteB : Math.floor(Math.random() * 256)) % 3); // spread across 3 octaves
        const freq = currentRootFreq * off * Math.pow(2, octave);
        const pan = ((byteC !== null ? byteC : Math.floor(Math.random() * 256)) / 255) * 1.4 - 0.7;



        // "More singing bowls": roughly a third of the time, layer a second
        // bowl a few hundred ms later at a different chord tone/octave/pan
        // so strikes occasionally overlap into a small cluster instead of
        // always being single isolated dings.
        const wantsLayer = (byteC !== null ? byteC : Math.floor(Math.random() * 256)) < 85; // ~1/3
        if (wantsLayer) {
            const off2 = offsets[(byteB !== null ? byteB : Math.floor(Math.random() * 256)) % offsets.length];
            const octave2 = 1 + (((byteA !== null ? byteA : Math.floor(Math.random() * 256)) + 1) % 3);
            const freq2 = currentRootFreq * off2 * Math.pow(2, octave2);
            const pan2 = -pan; // opposite side of the stereo field
            const layerDelayMs = 220 + Math.random() * 380;

        }

        // Next ding at a random interval, 5-10s — quantum-influenced
        // when bytes are available
        const jitter = byteA !== null ? (byteA / 255) : Math.random();
        bowlDingTimer = setTimeout(bowlDing, 4000 + jitter * 10000);
    }

    // --- Periodic bowl rim-runs (voice built on demand) ---------------------
    // Real behaviour modelled here: the tone starts slowly and accelerates as
    // stick-slip locks in (ease-in-out, not an exponential jump); the
    // fundamental speaks first and upper modes join later; when the mallet
    // stops the bowl rings down naturally (long, upper modes fastest); the
    // wavering is a fast beat/pressure wobble (~0.4-0.9 Hz), not a 20s drift.
    function bowlRimRun() {
        if (!audioEnabled || !bowlRimRunEnabled || !audioNodes) return;
        const now = audioCtx.currentTime;

        let byteA = null;
        if (lastQuantumBytes && lastQuantumBytes.length) {
            byteA = lastQuantumBytes[Math.floor(Math.random() * lastQuantumBytes.length)];
        }
        const idx = (byteA !== null ? byteA : Math.floor(Math.random() * 256)) % 3;

        const offsets = audioNodes.currentChordRatios;
        const freq = currentRootFreq * offsets[idx % offsets.length] * [2, 4, 3][idx];
        const targetGain = idx === 0 ? 0.008 : 0.006;

        const buildTime = 3.0 + Math.random() * 2.0;
        const sustainTime = 4.5 + Math.random() * 5.0;
        const relTau = 2.5 + Math.random() * 2.0;      // ~17-31s to fall 60 dB
        const releaseAt = now + buildTime + sustainTime;
        const stopAt = releaseAt + relTau * 5 + 0.5;

        const voiceGain = audioCtx.createGain();
        voiceGain.gain.value = 0;
        const panner = audioCtx.createStereoPanner();
        panner.pan.value = [-0.4, 0.45, -0.1][idx];

        const shimmerLFO = audioCtx.createOscillator();
        shimmerLFO.frequency.value = 0.4 + idx * 0.17;
        const shimmerDepth = audioCtx.createGain();
        shimmerDepth.gain.value = 0;
        shimmerLFO.connect(shimmerDepth);
        shimmerDepth.connect(voiceGain.gain);

        const panLFO = audioCtx.createOscillator();
        panLFO.frequency.value = 0.007 + idx * 0.004;
        const panLFOGain = audioCtx.createGain();
        panLFOGain.gain.value = 0.2;
        panLFO.connect(panLFOGain);
        panLFOGain.connect(panner.pan);

        const all = [voiceGain, panner, shimmerLFO, shimmerDepth, panLFO, panLFOGain];
        const sources = [shimmerLFO, panLFO];
        const stagger = [0, 0, 0.3, 0.5]; // upper modes join later
        BOWL_PARTIALS.slice(0, 4).forEach((pt, j) => {
            const osc = audioCtx.createOscillator();
            osc.type = "sine";
            osc.frequency.value = freq * pt.mult;
            const g = audioCtx.createGain();
            g.gain.value = 0;
            g.gain.setTargetAtTime(pt.gain, now + buildTime * stagger[j], buildTime * 0.35);
            g.gain.setTargetAtTime(0, releaseAt, relTau * pt.dm); // upper modes die first
            osc.connect(g);
            g.connect(voiceGain);
            all.push(osc, g);
            sources.push(osc);
        });

        voiceGain.connect(panner);
        panner.connect(dryGain);
        panner.connect(reverbSend);

        // Ease-in-out build (smoothstep), then hold, then natural ring-down.
        const N = 48;
        const curve = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            const x = i / (N - 1);
            curve[i] = targetGain * x * x * (3 - 2 * x);
        }
        voiceGain.gain.setValueCurveAtTime(curve, now, buildTime);
        voiceGain.gain.setTargetAtTime(0, releaseAt, relTau);
        shimmerDepth.gain.setTargetAtTime(targetGain * 0.3, now, buildTime * 0.4);
        shimmerDepth.gain.setTargetAtTime(0, releaseAt, relTau);

        const voice = { voiceGain, shimmerDepth };
        activeRimVoices.add(voice);
        sources.forEach((o) => { o.start(now); o.stop(stopAt); });
        panLFO.onended = () => {
            all.forEach((n) => n.disconnect());
            activeRimVoices.delete(voice);
        };

        const totalRunTime = buildTime + sustainTime + relTau * 2.5;
        const jitter = byteA !== null ? (byteA / 255) : Math.random();
        bowlRimRunTimer = setTimeout(bowlRimRun, (totalRunTime + 14 + jitter * 26) * 1000);
    }

    audioNodes = {
        master: masterGain,
        padVoices,
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
        currentChordRatios: chordRatios(CHORD_LIBRARY[0]),
        pluckStar,
        bowlDing,
        bowlRimRun,
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
    if (chimeEnabled) setTimeout(() => ringChime(CHORD_LIBRARY[chordIndex].root), 4500);
}

function applyChord(now, isInit) {
    if (!audioNodes) return;
    const root = currentRootFreq;
    const ratios = chordRatios(CHORD_LIBRARY[chordIndex]);
    audioNodes.currentChordRatios = ratios;

    const voices = audioNodes.padVoices;
    const currentFreqs = voices.map(v => v.currentFreq);
    const newFreqs = voiceLeadingFreqs(currentFreqs, ratios, root);

    let moveIndex = 0;
    for (let i = 0; i < voices.length; i++) {
        const freq = newFreqs[i];
        voices[i].currentFreq = freq;

        if (isInit) {
            // Startup: jump directly to the chord tone.
            //
            // Web Audio oscillators default to 440 Hz, and setTargetAtTime
            // starts from wherever the param currently sits — so gliding
            // here sweeps every voice down from 440 Hz to its chord tone
            // in ~0.1 s. The sub voice (octave mult 0.25) drops from
            // 440 Hz to ~50 Hz in that window, and that fast downward
            // sweep is the "boom" you hear right before the hum settles.
            // Writing .value directly, in the same JS tick as osc.start(),
            // means the oscillators are already on their chord tone by the
            // first render quantum — they never emit 440 Hz at all.
            voices[i].osc1.frequency.value = freq;
            voices[i].osc2.frequency.value = freq * 1.001;
        } else {
            // Chord change = crossfade, not a pitch slide (sliding through
            // in-between notes is a classic uncanny-drone effect). Voices whose
            // note is unchanged just keep sounding; the others fade out, retune
            // while silent, and fade in on the new note - staggered so the pad
            // never drops out completely.
            const v = voices[i];
            const oldFreq = currentFreqs[i];
            if (Math.abs(freq - oldFreq) / oldFreq < 0.002) continue;
            const t0 = now + moveIndex * 1.6;
            moveIndex++;
            const tSilent = t0 + CROSSFADE_OUT_S + 0.05;
            v.swell.gain.setValueCurveAtTime(FADE_OUT_CURVE, t0, CROSSFADE_OUT_S);
            v.osc1.frequency.setValueAtTime(freq, tSilent);
            v.osc2.frequency.setValueAtTime(freq * 1.001, tSilent);
            v.swell.gain.setValueCurveAtTime(FADE_IN_CURVE, tSilent + 0.05, CROSSFADE_IN_S);
        }
    }
}

// --- Update audio parameters from quantum (no more root changes) ---
// If animation.js calls this every frame, the un-throttled version queued ~14
// automation events per call. Now it applies at most twice a second.
let lastAudioParamUpdate = 0;
const AUDIO_PARAM_MIN_INTERVAL_MS = 500;

function updateAudioFromTarget(t, bytes) {
    if (!audioCtx || !audioNodes) return;
    if (!bytes || !bytes.length) return;
    lastQuantumBytes = bytes; // always keep the freshest bytes

    const nowMs = performance.now();
    if (nowMs - lastAudioParamUpdate < AUDIO_PARAM_MIN_INTERVAL_MS) return;
    lastAudioParamUpdate = nowMs;

    const now = audioCtx.currentTime;
    const glide = 1.2;
    const intensity = (t && t.intensity) || 0.3; // baseline stays calm
    const cutoffBase = 650 + intensity * 350;
    for (let i = 0; i < audioNodes.padVoices.length; i++) {
        const v = audioNodes.padVoices[i];
        v.filter.frequency.setTargetAtTime(cutoffBase + i * 50, now, glide * 1.5);
        const base = 0.013 * PAD_HUM_SCALE;
        const gainVal = base + intensity * 0.02 * PAD_HUM_SCALE;
        v.targetGain = gainVal;
        v.gainNode.gain.setTargetAtTime(gainVal, now, glide * 0.8);
    }
    audioNodes.noiseFilter.frequency.setTargetAtTime(350 + intensity * 400, now, glide * 1.2);
    audioNodes.noiseGain.gain.setTargetAtTime(0.004 + intensity * 0.006, now, glide * 1.2);
    audioNodes.reverbSend.gain.setTargetAtTime(Math.min(0.55 + intensity * 0.2, 0.75), now, glide * 1.2);
    audioNodes.delayFeedback.gain.setTargetAtTime(Math.min(0.12 + intensity * 0.12, 0.3), now, glide * 1.2);
}

// Muting only faded the master gain — every oscillator, the convolver and the
// filters kept burning CPU. Suspend the context once the fade has finished.
let suspendTimer = null;
function scheduleSuspend(delayMs) {
    clearTimeout(suspendTimer);
    suspendTimer = setTimeout(() => {
        if (!audioEnabled && audioCtx && audioCtx.state === "running") audioCtx.suspend();
    }, delayMs);
}
function cancelSuspend() {
    clearTimeout(suspendTimer);
    if (audioCtx && audioCtx.state !== "running") audioCtx.resume();
}

// Also stop processing while the tab is hidden (saves battery on phones).
const PAUSE_WHEN_HIDDEN = true;
document.addEventListener("visibilitychange", () => {
    if (!PAUSE_WHEN_HIDDEN || !audioCtx) return;
    if (document.hidden) audioCtx.suspend();
    else if (audioEnabled) audioCtx.resume();
});
// iOS sometimes refuses to resume outside a gesture; retry on the next touch.
window.addEventListener("pointerdown", () => {
    if (audioCtx && audioEnabled && audioCtx.state !== "running") audioCtx.resume();
}, { passive: true });

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
        scheduleSuspend(13000);
        audioEnabled = false;
        audioToggleBtn.classList.remove("on");
        if (starfieldTimer) clearTimeout(starfieldTimer);
        if (bowlDingTimer) clearTimeout(bowlDingTimer);
        if (bowlRimRunTimer) clearTimeout(bowlRimRunTimer);
        syncSliderDisplay(); // drops to 0
    } else {
        cancelSuspend();
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
                scheduleSuspend(2500);
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
            cancelSuspend();
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
    if (!on && audioCtx) {
        // Fade any currently-sounding rim-run down cleanly.
        const t = audioCtx.currentTime;
        activeRimVoices.forEach((v) => {
            [v.voiceGain.gain, v.shimmerDepth.gain].forEach((prm) => {
                prm.cancelScheduledValues(t);
                prm.setTargetAtTime(0, t, 1.2);
            });
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

// Isolate / tune the constant background layers from the console:
//   setPadLevel(0)            -> no pad at all (bowls, chimes, stars, noise bed remain)
//   setNoiseBedEnabled(false) -> no filtered-noise bed
window.setPadLevel = (x) => {
    PAD_LEVEL = Math.max(0, Math.min(1, x));
    if (padBusNode && audioCtx) padBusNode.gain.setTargetAtTime(PAD_LEVEL, audioCtx.currentTime, 1.5);
};
window.setNoiseBedEnabled = (on) => {
    NOISE_BED_ON = !!on;
    if (noiseSwitchNode && audioCtx) noiseSwitchNode.gain.setTargetAtTime(NOISE_BED_ON ? 1 : 0, audioCtx.currentTime, 1.5);
};

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