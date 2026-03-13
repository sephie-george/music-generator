/**
 * MagicSoundscape — Paulstretch-based ambient soundscape generator.
 *
 * Takes an AudioBuffer, applies extreme FFT-based time-stretching with phase
 * randomization (Paulstretch algorithm), layers octave-shifted copies, and
 * adds a massive convolution reverb to produce a long, blurred ambient texture.
 */

// ── Radix-2 in-place FFT ────────────────────────────────────────────────────

function fft(re: Float32Array, im: Float32Array, inverse: boolean = false) {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // Butterfly stages
  for (let len = 2; len <= n; len *= 2) {
    const halfLen = len / 2;
    const angle = (inverse ? 2 : -2) * Math.PI / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1,
        curIm = 0;
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
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

// ── Paulstretch core ────────────────────────────────────────────────────────

function paulstretch(
  inputData: Float32Array,
  sampleRate: number,
  stretchFactor: number,
  windowSize: number
): Float32Array {
  const halfWin = windowSize / 2;

  // Key fix: output hop is FIXED at halfWin for 50% overlap (dense output).
  // Stretching is achieved by advancing through the input slowly.
  const hopOut = halfWin;
  const hopIn = halfWin / stretchFactor; // slow crawl through input

  // Hann window
  const hannWindow = new Float32Array(windowSize);
  for (let i = 0; i < windowSize; i++) {
    hannWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / windowSize));
  }

  // Number of output frames = how many times we can read from input
  const numFrames = Math.max(
    1,
    Math.floor((inputData.length - windowSize) / hopIn)
  );

  const outputLength = Math.min(
    numFrames * hopOut + windowSize,
    sampleRate * 60 // cap at 60 seconds
  );
  const maxFrames = Math.min(
    numFrames,
    Math.floor((outputLength - windowSize) / hopOut) + 1
  );

  const output = new Float32Array(outputLength);
  const windowSum = new Float32Array(outputLength);

  const re = new Float32Array(windowSize);
  const im = new Float32Array(windowSize);

  for (let frame = 0; frame < maxFrames; frame++) {
    // Input position advances slowly
    const inputOffset = Math.floor(frame * hopIn);

    // Extract and window the frame
    for (let i = 0; i < windowSize; i++) {
      const idx = inputOffset + i;
      re[i] =
        (idx < inputData.length ? inputData[idx] : 0) * hannWindow[i];
      im[i] = 0;
    }

    // Forward FFT
    fft(re, im, false);

    // Randomise phases, keep magnitudes
    for (let i = 0; i < windowSize; i++) {
      const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
      const phase = Math.random() * 2 * Math.PI;
      re[i] = mag * Math.cos(phase);
      im[i] = mag * Math.sin(phase);
    }

    // Inverse FFT
    fft(re, im, true);

    // Window again and overlap-add at dense output position
    const outputOffset = frame * hopOut;
    for (let i = 0; i < windowSize; i++) {
      const pos = outputOffset + i;
      if (pos < outputLength) {
        output[pos] += re[i] * hannWindow[i];
        windowSum[pos] += hannWindow[i] * hannWindow[i];
      }
    }
  }

  // Normalise by the window sum to compensate for overlap
  for (let i = 0; i < outputLength; i++) {
    if (windowSum[i] > 1e-6) {
      output[i] /= windowSum[i];
    }
  }

  // Peak-normalise to 0.9
  let maxVal = 0;
  for (let i = 0; i < outputLength; i++) {
    const v = Math.abs(output[i]);
    if (v > maxVal) maxVal = v;
  }
  if (maxVal > 0) {
    const scale = 0.9 / maxVal;
    for (let i = 0; i < outputLength; i++) {
      output[i] *= scale;
    }
  }

  return output;
}

// ── Resampling (linear interpolation) for pitch-shifting before stretch ────

function resample(input: Float32Array, ratio: number): Float32Array {
  // ratio > 1 → fewer output samples → pitched up
  // ratio < 1 → more output samples → pitched down
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

function generateImpulseResponse(
  sampleRate: number,
  durationSeconds: number
): AudioBuffer {
  const length = Math.floor(sampleRate * durationSeconds);
  const ctx = new OfflineAudioContext(1, length, sampleRate);
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  const decayRate = -3.0 / durationSeconds; // ~60 dB decay over duration
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    data[i] = (Math.random() * 2 - 1) * Math.exp(decayRate * t);
  }
  return buffer;
}

// ── MagicSoundscape class ───────────────────────────────────────────────────

export interface MagicParams {
  stretchFactor: number; // 5–50, default 20
  windowSize: number; // 4096 | 8192 | 16384, default 8192
  layers: boolean; // octave stacking, default true
  reverbTail: number; // seconds, 3–15, default 8
}

export class MagicSoundscape {
  private sourceBuffer: AudioBuffer;
  private params: MagicParams;

  constructor(sourceBuffer: AudioBuffer, params: Partial<MagicParams> = {}) {
    this.sourceBuffer = sourceBuffer;
    this.params = {
      stretchFactor: Math.max(5, Math.min(50, params.stretchFactor ?? 20)),
      windowSize: params.windowSize ?? 8192,
      layers: params.layers ?? true,
      reverbTail: Math.max(3, Math.min(15, params.reverbTail ?? 8)),
    };
  }

  async generate(): Promise<AudioBuffer> {
    const sr = this.sourceBuffer.sampleRate;

    // Mix source to mono
    const mono = new Float32Array(this.sourceBuffer.length);
    const numCh = this.sourceBuffer.numberOfChannels;
    for (let ch = 0; ch < numCh; ch++) {
      const chData = this.sourceBuffer.getChannelData(ch);
      for (let i = 0; i < this.sourceBuffer.length; i++) {
        mono[i] += chData[i] / numCh;
      }
    }

    // Base layer: Paulstretch at original pitch
    const baseLayer = paulstretch(
      mono,
      sr,
      this.params.stretchFactor,
      this.params.windowSize
    );

    let mixLength = baseLayer.length;
    let lowLayer: Float32Array | null = null;
    let highLayer: Float32Array | null = null;

    if (this.params.layers) {
      // Low layer: pitched down 1 octave (resample ratio 0.5 → half the pitch)
      const lowResampled = resample(mono, 0.5);
      lowLayer = paulstretch(
        lowResampled,
        sr,
        this.params.stretchFactor,
        this.params.windowSize
      );

      // High layer: pitched up 7 semitones (a fifth)
      const highRatio = Math.pow(2, 7 / 12); // ~1.498
      const highResampled = resample(mono, highRatio);
      highLayer = paulstretch(
        highResampled,
        sr,
        this.params.stretchFactor,
        this.params.windowSize
      );

      mixLength = Math.max(
        baseLayer.length,
        lowLayer.length,
        highLayer.length
      );
    }

    // Cap at 60 seconds
    const maxSamples = sr * 60;
    mixLength = Math.min(mixLength, maxSamples);

    // Mix layers together
    const mixed = new Float32Array(mixLength);
    for (let i = 0; i < mixLength; i++) {
      let val = i < baseLayer.length ? baseLayer[i] : 0;
      if (lowLayer) {
        val += (i < lowLayer.length ? lowLayer[i] : 0) * 0.6; // lower volume
      }
      if (highLayer) {
        val += (i < highLayer.length ? highLayer[i] : 0) * 0.3; // much lower volume
      }
      mixed[i] = val;
    }

    // Peak-normalise the mix
    let maxVal = 0;
    for (let i = 0; i < mixLength; i++) {
      const v = Math.abs(mixed[i]);
      if (v > maxVal) maxVal = v;
    }
    if (maxVal > 0) {
      const scale = 0.85 / maxVal;
      for (let i = 0; i < mixLength; i++) {
        mixed[i] *= scale;
      }
    }

    // Apply convolution reverb using OfflineAudioContext
    const reverbTailSamples = Math.floor(this.params.reverbTail * sr);
    const totalLength = mixLength + reverbTailSamples;
    const offlineCtx = new OfflineAudioContext(1, totalLength, sr);

    // Create an AudioBuffer from the mixed data
    const mixBuffer = offlineCtx.createBuffer(1, mixLength, sr);
    mixBuffer.getChannelData(0).set(mixed);

    // Generate impulse response
    const irBuffer = generateImpulseResponse(sr, this.params.reverbTail);
    // Re-create IR in the offline context
    const offlineIR = offlineCtx.createBuffer(
      1,
      irBuffer.getChannelData(0).length,
      sr
    );
    offlineIR.getChannelData(0).set(irBuffer.getChannelData(0));

    // Source → convolver → destination (wet)
    // Source → destination (dry)
    const source = offlineCtx.createBufferSource();
    source.buffer = mixBuffer;

    const convolver = offlineCtx.createConvolver();
    convolver.buffer = offlineIR;

    const dryGain = offlineCtx.createGain();
    dryGain.gain.value = 0.5;

    const wetGain = offlineCtx.createGain();
    wetGain.gain.value = 0.5;

    source.connect(dryGain);
    dryGain.connect(offlineCtx.destination);

    source.connect(convolver);
    convolver.connect(wetGain);
    wetGain.connect(offlineCtx.destination);

    source.start(0);

    const rendered = await offlineCtx.startRendering();
    return rendered;
  }
}
