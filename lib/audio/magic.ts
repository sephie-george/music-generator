/**
 * MagicSoundscape (A2) — Granular cloud + gentle phase vocoder.
 *
 * Instead of fully randomizing FFT phases (which destroys tonal content),
 * this version uses:
 *   1. Granular cloud synthesis — hundreds of overlapping grains from the source
 *      at random positions, with Hann envelopes, creating a dense texture that
 *      preserves the original timbre.
 *   2. Phase vocoder time-stretch — keeps phase coherence between frames,
 *      only adding a small random drift for smoothness.
 *   3. Layered at octave intervals with convolution reverb.
 */

// ── Radix-2 in-place FFT ────────────────────────────────────────────────────

function fft(re: Float32Array, im: Float32Array, inverse: boolean = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len *= 2) {
    const halfLen = len / 2;
    const angle = (inverse ? 2 : -2) * Math.PI / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const tRe = curRe * re[i + j + halfLen] - curIm * im[i + j + halfLen];
        const tIm = curRe * im[i + j + halfLen] + curIm * re[i + j + halfLen];
        re[i + j + halfLen] = re[i + j] - tRe;
        im[i + j + halfLen] = im[i + j] - tIm;
        re[i + j] += tRe;
        im[i + j] += tIm;
        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

// ── Granular cloud synthesis ────────────────────────────────────────────────

function granularCloud(
  inputData: Float32Array,
  sampleRate: number,
  outputDurationSec: number,
  grainSizeSec: number = 0.08,    // 80ms grains
  grainDensity: number = 60,       // grains per second
): Float32Array {
  const outputLength = Math.floor(outputDurationSec * sampleRate);
  const output = new Float32Array(outputLength);
  const grainSamples = Math.floor(grainSizeSec * sampleRate);
  const totalGrains = Math.floor(outputDurationSec * grainDensity);

  // Hann window for grain envelope
  const envelope = new Float32Array(grainSamples);
  for (let i = 0; i < grainSamples; i++) {
    envelope[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / grainSamples));
  }

  const maxSrcStart = Math.max(0, inputData.length - grainSamples);

  for (let g = 0; g < totalGrains; g++) {
    // Random position in source
    const srcStart = Math.floor(Math.random() * maxSrcStart);
    // Random position in output (spread evenly with some jitter)
    const baseOutPos = (g / totalGrains) * outputLength;
    const jitter = (Math.random() - 0.5) * (outputLength / totalGrains) * 2;
    const outStart = Math.max(0, Math.min(outputLength - grainSamples, Math.floor(baseOutPos + jitter)));

    // Random gain variation for texture
    const gain = 0.3 + Math.random() * 0.7;

    for (let i = 0; i < grainSamples; i++) {
      const srcIdx = srcStart + i;
      if (srcIdx < inputData.length && outStart + i < outputLength) {
        output[outStart + i] += inputData[srcIdx] * envelope[i] * gain;
      }
    }
  }

  return output;
}

// ── Phase vocoder time-stretch (preserves phase coherence) ──────────────────

function phaseVocoderStretch(
  inputData: Float32Array,
  sampleRate: number,
  stretchFactor: number,
  windowSize: number,
  phaseDrift: number = 0.15,  // 0 = perfect preservation, 1 = full randomization
): Float32Array {
  const halfWin = windowSize / 2;
  const hopOut = halfWin;
  const hopIn = halfWin / stretchFactor;

  const hannWindow = new Float32Array(windowSize);
  for (let i = 0; i < windowSize; i++) {
    hannWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / windowSize));
  }

  const numFrames = Math.max(1, Math.floor((inputData.length - windowSize) / hopIn));
  const outputLength = Math.min(numFrames * hopOut + windowSize, sampleRate * 60);
  const maxFrames = Math.min(numFrames, Math.floor((outputLength - windowSize) / hopOut) + 1);

  const output = new Float32Array(outputLength);
  const windowSum = new Float32Array(outputLength);

  const re = new Float32Array(windowSize);
  const im = new Float32Array(windowSize);

  // Phase accumulator for phase vocoder coherence
  const phaseAccum = new Float32Array(windowSize);
  const prevPhase = new Float32Array(windowSize);
  let firstFrame = true;

  for (let frame = 0; frame < maxFrames; frame++) {
    const inputOffset = Math.floor(frame * hopIn);

    for (let i = 0; i < windowSize; i++) {
      const idx = inputOffset + i;
      re[i] = (idx < inputData.length ? inputData[idx] : 0) * hannWindow[i];
      im[i] = 0;
    }

    fft(re, im, false);

    // Phase vocoder: preserve phase relationships with small drift
    for (let i = 0; i < windowSize; i++) {
      const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
      const phase = Math.atan2(im[i], re[i]);

      if (firstFrame) {
        phaseAccum[i] = phase;
      } else {
        // Expected phase advance based on bin frequency and hop
        const expectedPhaseAdv = (2 * Math.PI * i * hopIn) / windowSize;
        // Actual phase difference
        let phaseDiff = phase - prevPhase[i] - expectedPhaseAdv;
        // Wrap to [-pi, pi]
        phaseDiff = phaseDiff - Math.round(phaseDiff / (2 * Math.PI)) * 2 * Math.PI;
        // Accumulate with stretch ratio
        const stretchedAdv = expectedPhaseAdv * (hopOut / hopIn) + phaseDiff;
        phaseAccum[i] += stretchedAdv;
        // Add small random drift for smoothness
        phaseAccum[i] += (Math.random() - 0.5) * 2 * Math.PI * phaseDrift;
      }

      prevPhase[i] = phase;
      re[i] = mag * Math.cos(phaseAccum[i]);
      im[i] = mag * Math.sin(phaseAccum[i]);
    }

    firstFrame = false;

    fft(re, im, true);

    const outputOffset = frame * hopOut;
    for (let i = 0; i < windowSize; i++) {
      const pos = outputOffset + i;
      if (pos < outputLength) {
        output[pos] += re[i] * hannWindow[i];
        windowSum[pos] += hannWindow[i] * hannWindow[i];
      }
    }
  }

  for (let i = 0; i < outputLength; i++) {
    if (windowSum[i] > 1e-6) output[i] /= windowSum[i];
  }

  // Normalize
  let maxVal = 0;
  for (let i = 0; i < outputLength; i++) {
    const v = Math.abs(output[i]);
    if (v > maxVal) maxVal = v;
  }
  if (maxVal > 0) {
    const scale = 0.9 / maxVal;
    for (let i = 0; i < outputLength; i++) output[i] *= scale;
  }

  return output;
}

// ── Resampling (linear interpolation) for pitch-shifting ────────────────────

function resample(input: Float32Array, ratio: number): Float32Array {
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const a = idx < input.length ? input[idx] : 0;
    const b = idx + 1 < input.length ? input[idx + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

// ── Impulse response generation (exponentially decaying noise) ─────────────

function generateImpulseResponse(sampleRate: number, durationSeconds: number): AudioBuffer {
  const length = Math.floor(sampleRate * durationSeconds);
  const ctx = new OfflineAudioContext(1, length, sampleRate);
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  const decayRate = -3.0 / durationSeconds;
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    data[i] = (Math.random() * 2 - 1) * Math.exp(decayRate * t);
  }
  return buffer;
}

// ── Normalize helper ────────────────────────────────────────────────────────

function normalize(data: Float32Array, peak: number = 0.9): void {
  let maxVal = 0;
  for (let i = 0; i < data.length; i++) {
    const v = Math.abs(data[i]);
    if (v > maxVal) maxVal = v;
  }
  if (maxVal > 0) {
    const scale = peak / maxVal;
    for (let i = 0; i < data.length; i++) data[i] *= scale;
  }
}

// ── MagicSoundscape class ───────────────────────────────────────────────────

export type MagicCharacter = "mystical" | "somna" | "vertigo";

export interface MagicParams {
  stretchFactor: number;
  windowSize: number;
  reverbTail: number;
  grainSize: number;
  grainDensity: number;
  phaseDrift: number;
  character: MagicCharacter;
}

export class MagicSoundscape {
  private sourceBuffer: AudioBuffer;
  private params: MagicParams;

  constructor(sourceBuffer: AudioBuffer, params: Partial<MagicParams> = {}) {
    this.sourceBuffer = sourceBuffer;
    this.params = {
      stretchFactor: Math.max(2, Math.min(100, params.stretchFactor ?? 20)),
      windowSize: params.windowSize ?? 4096,
      reverbTail: Math.max(3, Math.min(15, params.reverbTail ?? 8)),
      grainSize: params.grainSize ?? 0.12,
      grainDensity: params.grainDensity ?? 80,
      phaseDrift: params.phaseDrift ?? 0.1,
      character: params.character ?? "mystical",
    };
  }

  async generate(): Promise<AudioBuffer> {
    const sr = this.sourceBuffer.sampleRate;
    const ch = this.params.character;

    // Mix source to mono
    const mono = new Float32Array(this.sourceBuffer.length);
    const numCh = this.sourceBuffer.numberOfChannels;
    for (let c = 0; c < numCh; c++) {
      const chData = this.sourceBuffer.getChannelData(c);
      for (let i = 0; i < this.sourceBuffer.length; i++) {
        mono[i] += chData[i] / numCh;
      }
    }

    const srcDuration = mono.length / sr;
    const targetDuration = Math.min(srcDuration * this.params.stretchFactor, 60);

    // ── Phase vocoder stretch ────
    const pvWindowSize = ch === "somna" ? this.params.windowSize * 2 : this.params.windowSize;
    const pvDrift = ch === "somna" ? Math.min(1, this.params.phaseDrift * 4)
                  : ch === "vertigo" ? Math.min(1, this.params.phaseDrift * 6)
                  : this.params.phaseDrift;
    const pvLayer = phaseVocoderStretch(mono, sr, this.params.stretchFactor, pvWindowSize, pvDrift);

    // ── Granular cloud ────
    const grainSize = ch === "somna" ? this.params.grainSize * 0.4
                    : ch === "vertigo" ? this.params.grainSize * 0.25
                    : this.params.grainSize;
    const grainDens = ch === "somna" ? this.params.grainDensity * 4
                    : ch === "vertigo" ? this.params.grainDensity * 6
                    : this.params.grainDensity;
    const grainLayer = granularCloud(mono, sr, targetDuration, grainSize, grainDens);

    // ── Detuned granular (somna & vertigo) ────
    let grainLayer2: Float32Array | null = null;
    if (ch === "somna") {
      const detuned = resample(mono, Math.pow(2, -5 / 12));
      grainLayer2 = granularCloud(detuned, sr, targetDuration, this.params.grainSize * 0.6, this.params.grainDensity * 2);
    } else if (ch === "vertigo") {
      // Tritone (+6 semitones) — eerie dissonance
      const tritone = resample(mono, Math.pow(2, 6 / 12));
      grainLayer2 = granularCloud(tritone, sr, targetDuration, this.params.grainSize * 0.3, this.params.grainDensity * 3);
    }

    // ── Mix layers ────
    const lens = [pvLayer.length, grainLayer.length];
    if (grainLayer2) lens.push(grainLayer2.length);
    const mixLength = Math.min(Math.max(...lens), Math.floor(sr * 60));
    const mixed = new Float32Array(mixLength);

    if (ch === "mystical") {
      // PV dominant — voice clear, ethereal
      for (let i = 0; i < mixLength; i++) {
        mixed[i] = (i < pvLayer.length ? pvLayer[i] : 0) * 0.65
                 + (i < grainLayer.length ? grainLayer[i] : 0) * 0.35;
      }
    } else if (ch === "somna") {
      // Grain dominant — voice hidden, textural, somnambulistic
      for (let i = 0; i < mixLength; i++) {
        mixed[i] = (i < pvLayer.length ? pvLayer[i] : 0) * 0.2
                 + (i < grainLayer.length ? grainLayer[i] : 0) * 0.5
                 + (grainLayer2 && i < grainLayer2.length ? grainLayer2[i] : 0) * 0.3;
      }
    } else {
      // Vertigo — balanced but with aggressive pitch-shifted content
      for (let i = 0; i < mixLength; i++) {
        mixed[i] = (i < pvLayer.length ? pvLayer[i] : 0) * 0.35
                 + (i < grainLayer.length ? grainLayer[i] : 0) * 0.35
                 + (grainLayer2 && i < grainLayer2.length ? grainLayer2[i] : 0) * 0.3;
      }
    }

    // ── Octave layers ────
    if (ch === "somna") {
      // Heavy sub drone
      const lowPV = phaseVocoderStretch(resample(mono, 0.5), sr, this.params.stretchFactor, this.params.windowSize * 2, 0.3);
      for (let i = 0; i < mixLength; i++) if (i < lowPV.length) mixed[i] += lowPV[i] * 0.35;
      // Ghostly octave-up whisper
      const highGrain = granularCloud(resample(mono, 2.0), sr, targetDuration, 0.025, 100);
      for (let i = 0; i < mixLength; i++) if (i < highGrain.length) mixed[i] += highGrain[i] * 0.08;
    } else if (ch === "vertigo") {
      // Minor 2nd shimmer (+1 semitone) — unsettling
      const m2Grain = granularCloud(resample(mono, Math.pow(2, 1 / 12)), sr, targetDuration, 0.04, 80);
      for (let i = 0; i < mixLength; i++) if (i < m2Grain.length) mixed[i] += m2Grain[i] * 0.2;
      // Octave below, fast grains
      const lowGrain = granularCloud(resample(mono, 0.5), sr, targetDuration, 0.03, 120);
      for (let i = 0; i < mixLength; i++) if (i < lowGrain.length) mixed[i] += lowGrain[i] * 0.15;
    } else {
      // Mystical — gentle octave layers
      const lowPV = phaseVocoderStretch(resample(mono, 0.5), sr, this.params.stretchFactor, this.params.windowSize, 0.12);
      for (let i = 0; i < mixLength; i++) if (i < lowPV.length) mixed[i] += lowPV[i] * 0.25;
      const highGrain = granularCloud(resample(mono, Math.pow(2, 7 / 12)), sr, targetDuration, 0.06, 40);
      for (let i = 0; i < mixLength; i++) if (i < highGrain.length) mixed[i] += highGrain[i] * 0.15;
    }

    normalize(mixed, 0.85);

    // ── Apply convolution reverb ────
    const reverbTail = ch === "somna" ? Math.max(this.params.reverbTail, 10) : this.params.reverbTail;
    const reverbTailSamples = Math.floor(reverbTail * sr);
    const totalLength = mixLength + reverbTailSamples;
    const offlineCtx = new OfflineAudioContext(1, totalLength, sr);

    const mixBuffer = offlineCtx.createBuffer(1, mixLength, sr);
    mixBuffer.getChannelData(0).set(mixed);

    const irBuffer = generateImpulseResponse(sr, reverbTail);
    const offlineIR = offlineCtx.createBuffer(1, irBuffer.getChannelData(0).length, sr);
    offlineIR.getChannelData(0).set(irBuffer.getChannelData(0));

    const source = offlineCtx.createBufferSource();
    source.buffer = mixBuffer;
    const convolver = offlineCtx.createConvolver();
    convolver.buffer = offlineIR;
    const dryGain = offlineCtx.createGain();
    const wetGain = offlineCtx.createGain();

    dryGain.gain.value = ch === "somna" ? 0.3 : ch === "vertigo" ? 0.45 : 0.6;
    wetGain.gain.value = ch === "somna" ? 0.7 : ch === "vertigo" ? 0.55 : 0.4;

    source.connect(dryGain);
    dryGain.connect(offlineCtx.destination);
    source.connect(convolver);
    convolver.connect(wetGain);
    wetGain.connect(offlineCtx.destination);
    source.start(0);

    return offlineCtx.startRendering();
  }
}
