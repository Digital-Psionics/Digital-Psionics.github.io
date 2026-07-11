// ==========================================================================
// audio.js — Ambient pad engine for dreamcore/lofi
// Modified for stable keys and reverb‑washed chord changes
// ==========================================================================

let audioCtx = null;
let audioNodes = null;
let audioEnabled = false;

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
// Slower harmonic motion — "floating at the edge of the universe" instead
// of a lofi loop. Chord changes should feel like they arrive over a long
// stretch of time, not on a beat.
const CHORD_DURATION_S = 55; // seconds per chord

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

// --- Utility ---
function buildImpulse(duration, decay) {
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
            const candidate = rootFreq * Math.pow(2, off / 12) * octaveMult;
            const dist = Math.abs(Math.log2(candidate / currentFreqs[i])) + (usedIndices.has(j) ? 0.5 : 0);
            if (dist < bestDist) { bestDist = dist; bestIndex = j; }
        }
        usedIndices.add(bestIndex);
        newFreqs[i] = rootFreq * Math.pow(2, chordOffsets[bestIndex] / 12) * octaveMult;
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
    reverbNode.buffer = buildImpulse(16.0, 4.0); // longer decay
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
        gainNode.gain.value = i === 0 ? 0.05 : 0.013;

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
    const noiseBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 4, audioCtx.sampleRate);
    const nd = noiseBuffer.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * 0.15;
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

    // --- Starfield shimmer: sparse, quantum-timed high "twinkles" sent
    // mostly to reverb, so each one blooms and dissolves like a distant
    // star. Pitch and timing both draw on lastQuantumBytes when available,
    // falling back to Math.random(). ---
    function pluckStar() {
        if (!audioEnabled) return;
        const now = audioCtx.currentTime;
        const offsets = audioNodes ? audioNodes.currentChordOffsets : [0, 4, 7, 11];

        let byteA = null, byteB = null;
        if (lastQuantumBytes && lastQuantumBytes.length) {
            byteA = lastQuantumBytes[Math.floor(Math.random() * lastQuantumBytes.length)];
            byteB = lastQuantumBytes[Math.floor(Math.random() * lastQuantumBytes.length)];
        }
        const off = offsets[(byteA !== null ? byteA : Math.floor(Math.random() * 256)) % offsets.length];
        const octave = 3 + ((byteB !== null ? byteB : Math.floor(Math.random() * 256)) % 2);
        const freq = currentRootFreq * Math.pow(2, off / 12) * Math.pow(2, octave);

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
        currentChordOffsets: CHORD_LIBRARY[0].offsets,
        pluckStar,
    };

    // Start first chord
    chordIndex = 0;
    applyChord(audioCtx.currentTime, true);

    // Schedule chord changes
    setInterval(() => {
        if (!audioEnabled) return;
        advanceChord();
    }, CHORD_DURATION_S * 1000);

    // Long, slow fade in — nothing here should arrive suddenly
    masterGain.gain.setTargetAtTime(0.28, audioCtx.currentTime, 3.0);

    // Kick off the starfield shimmer
    starfieldTimer = setTimeout(pluckStar, 4000 + Math.random() * 6000);
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
            const base = i === 0 ? 0.05 : 0.013;
            const gainVal = base + intensity * 0.02;
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
audioToggleBtn.addEventListener("click", () => {
    if (!audioCtx) {
        initAudio();
        audioEnabled = true;
        updateAudioFromTarget(target);
        audioToggleBtn.classList.add("on");
        return;
    }
    if (audioEnabled) {
        audioNodes.master.gain.setTargetAtTime(0, audioCtx.currentTime, 2.5);
        audioEnabled = false;
        audioToggleBtn.classList.remove("on");
        if (starfieldTimer) clearTimeout(starfieldTimer);
    } else {
        if (audioCtx.state === "suspended") audioCtx.resume();
        audioNodes.master.gain.setTargetAtTime(0.28, audioCtx.currentTime, 3.0);
        audioEnabled = true;
        updateAudioFromTarget(target);
        audioToggleBtn.classList.add("on");
        starfieldTimer = setTimeout(audioNodes.pluckStar, 3000 + Math.random() * 5000);
    }
});

// Expose globals (for animation.js)
window.audioEnabled = audioEnabled;
window.updateAudioFromTarget = updateAudioFromTarget;