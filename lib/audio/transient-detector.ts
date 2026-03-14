import type { Chop } from "../types";

interface DetectorOptions {
  frameSize?: number;
  hopSize?: number;
  threshold?: number;
  minInterval?: number;
  maxChops?: number;
  minChops?: number;
}

export function detectTransients(
  audioBuffer: AudioBuffer,
  options: DetectorOptions = {}
): Chop[] {
  const {
    frameSize = 1024,
    hopSize = 512,
    threshold = 1.2,
    minInterval = 0.04,
    maxChops = 64,
    minChops = 16,
  } = options;

  const length = audioBuffer.length;
  const sampleRate = audioBuffer.sampleRate;
  const duration = audioBuffer.duration;

  // Mix to mono
  const mono = new Float32Array(length);
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const channelData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += channelData[i] / audioBuffer.numberOfChannels;
    }
  }

  // Compute energy per frame
  const numFrames = Math.floor((length - frameSize) / hopSize) + 1;
  const energies = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    const offset = f * hopSize;
    let energy = 0;
    for (let i = 0; i < frameSize; i++) {
      const sample = mono[offset + i];
      energy += sample * sample;
    }
    energies[f] = energy / frameSize;
  }

  // Spectral flux
  const flux = new Float32Array(numFrames);
  for (let f = 1; f < numFrames; f++) {
    const diff = energies[f] - energies[f - 1];
    flux[f] = diff > 0 ? diff : 0;
  }

  // Detect ALL onsets across the full audio (no maxChops cap yet)
  let allOnsets: number[] = [];
  const windowSize = 10;

  // Try progressively lower thresholds
  const thresholds = [threshold, threshold * 0.7, threshold * 0.5, threshold * 0.3];
  for (const th of thresholds) {
    allOnsets = [];
    for (let f = 0; f < numFrames; f++) {
      let sum = 0;
      let count = 0;
      for (let w = Math.max(0, f - windowSize); w <= Math.min(numFrames - 1, f + windowSize); w++) {
        sum += flux[w];
        count++;
      }
      const localAvg = sum / count;
      const adaptiveThreshold = localAvg * th + 0.00001;

      if (flux[f] > adaptiveThreshold) {
        const timeSec = (f * hopSize) / sampleRate;
        if (allOnsets.length === 0 || timeSec - allOnsets[allOnsets.length - 1] >= minInterval) {
          allOnsets.push(timeSec);
        }
      }
    }
    if (allOnsets.length >= minChops) break;
  }

  // Ensure onset at 0
  if (allOnsets.length === 0 || allOnsets[0] > 0.01) {
    allOnsets.unshift(0);
  }

  // If too many onsets, thin them EVENLY across the timeline
  // (not just truncating — which would lose the end of the audio)
  if (allOnsets.length > maxChops) {
    const step = allOnsets.length / maxChops;
    const thinned: number[] = [0]; // always keep 0
    for (let i = 1; i < maxChops; i++) {
      const idx = Math.round(i * step);
      if (idx < allOnsets.length) {
        thinned.push(allOnsets[idx]);
      }
    }
    allOnsets = thinned;
  }

  // If too few, subdivide longest gaps
  while (allOnsets.length < minChops) {
    let maxGap = 0;
    let maxIdx = 0;
    for (let i = 0; i < allOnsets.length; i++) {
      const end = i < allOnsets.length - 1 ? allOnsets[i + 1] : duration;
      const gap = end - allOnsets[i];
      if (gap > maxGap) {
        maxGap = gap;
        maxIdx = i;
      }
    }
    if (maxGap < 0.05) break;
    const end = maxIdx < allOnsets.length - 1 ? allOnsets[maxIdx + 1] : duration;
    allOnsets.splice(maxIdx + 1, 0, (allOnsets[maxIdx] + end) / 2);
  }

  // Deduplicate and sort
  allOnsets.sort((a, b) => a - b);
  allOnsets = allOnsets.filter((v, i, arr) => i === 0 || v - arr[i - 1] >= 0.02);

  // Build chops
  const chops: Chop[] = [];
  for (let i = 0; i < allOnsets.length; i++) {
    const start = allOnsets[i];
    const end = i < allOnsets.length - 1 ? allOnsets[i + 1] : duration;
    const startSample = Math.floor(start * sampleRate);
    const endSample = Math.min(Math.floor(end * sampleRate), length);
    const sampleCount = endSample - startSample;

    let chopEnergy = 0;
    for (let s = startSample; s < endSample; s++) {
      chopEnergy += mono[s] * mono[s];
    }
    chopEnergy = sampleCount > 0 ? chopEnergy / sampleCount : 0;

    let zeroCrossings = 0;
    for (let s = startSample + 1; s < endSample; s++) {
      if ((mono[s] >= 0 && mono[s - 1] < 0) || (mono[s] < 0 && mono[s - 1] >= 0)) {
        zeroCrossings++;
      }
    }
    const zcr = sampleCount > 1 ? zeroCrossings / (sampleCount / sampleRate) : 0;

    chops.push({
      index: i,
      start,
      end,
      label: `${i + 1}`,
      energy: Math.min(1, chopEnergy * 100),
      spectralCentroid: zcr,
    });
  }

  return chops;
}

// Equal-interval chopping
export function chopEqual(
  audioBuffer: AudioBuffer,
  numSlices: number = 32
): Chop[] {
  const duration = audioBuffer.duration;
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;
  const sliceLen = duration / numSlices;

  const mono = new Float32Array(length);
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const channelData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += channelData[i] / audioBuffer.numberOfChannels;
    }
  }

  const chops: Chop[] = [];
  for (let i = 0; i < numSlices; i++) {
    const start = i * sliceLen;
    const end = Math.min((i + 1) * sliceLen, duration);
    const startSample = Math.floor(start * sampleRate);
    const endSample = Math.min(Math.floor(end * sampleRate), length);
    const sampleCount = endSample - startSample;

    let chopEnergy = 0;
    for (let s = startSample; s < endSample; s++) {
      chopEnergy += mono[s] * mono[s];
    }
    chopEnergy = sampleCount > 0 ? chopEnergy / sampleCount : 0;

    let zeroCrossings = 0;
    for (let s = startSample + 1; s < endSample; s++) {
      if ((mono[s] >= 0 && mono[s - 1] < 0) || (mono[s] < 0 && mono[s - 1] >= 0)) {
        zeroCrossings++;
      }
    }
    const zcr = sampleCount > 1 ? zeroCrossings / (sampleCount / sampleRate) : 0;

    chops.push({
      index: i,
      start,
      end,
      label: `${i + 1}`,
      energy: Math.min(1, chopEnergy * 100),
      spectralCentroid: zcr,
    });
  }

  return chops;
}

// ── Autocorrelation pitch detection ─────────────────────────────────────────
// Returns frequency in Hz, or 0 if no clear pitch found.
function detectPitch(
  mono: Float32Array,
  offset: number,
  windowSize: number,
  sampleRate: number,
): number {
  // Pitch range: ~60Hz (C2) to ~1000Hz (B5)
  const minLag = Math.floor(sampleRate / 1000);
  const maxLag = Math.floor(sampleRate / 60);
  if (offset + windowSize > mono.length) return 0;

  // Normalized autocorrelation (YIN-style difference function)
  let bestLag = 0;
  let bestVal = Infinity;
  let runningSum = 0;

  for (let lag = minLag; lag <= Math.min(maxLag, windowSize / 2); lag++) {
    let diff = 0;
    for (let i = 0; i < windowSize - maxLag; i++) {
      const d = mono[offset + i] - mono[offset + i + lag];
      diff += d * d;
    }
    runningSum += diff;
    // Cumulative mean normalized difference (YIN step 3)
    const cmnd = lag === minLag ? 1 : (diff * lag) / (runningSum || 1);

    if (cmnd < bestVal) {
      bestVal = cmnd;
      bestLag = lag;
    }
  }

  // Threshold: if best CMND > 0.3, pitch is unreliable (noisy/unpitched)
  if (bestVal > 0.3 || bestLag === 0) return 0;
  return sampleRate / bestLag;
}

// Long notes extraction: finds uninterrupted pitched vowels/tones.
// Uses pitch stability detection — only segments where pitch is stable
// and continuous for > minDuration, with no transients or noise bursts.
export function chopLongNotes(
  audioBuffer: AudioBuffer,
  minDurationSec: number = 1.0,
): Chop[] {
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;
  const duration = audioBuffer.duration;

  // Mix to mono
  const mono = new Float32Array(length);
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const channelData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += channelData[i] / audioBuffer.numberOfChannels;
    }
  }

  // Frame-by-frame analysis
  const frameSize = 2048;
  const hopSize = 1024; // ~23ms at 44.1k
  const numFrames = Math.floor((length - frameSize) / hopSize) + 1;

  // Per-frame: RMS energy, pitch, spectral flatness (noise vs tone)
  const rms = new Float32Array(numFrames);
  const pitches = new Float32Array(numFrames);
  const tonality = new Float32Array(numFrames); // 0 = noise, 1 = pure tone

  for (let f = 0; f < numFrames; f++) {
    const offset = f * hopSize;

    // RMS
    let energy = 0;
    for (let i = 0; i < frameSize; i++) {
      const s = mono[offset + i];
      energy += s * s;
    }
    rms[f] = Math.sqrt(energy / frameSize);

    // Pitch via autocorrelation
    pitches[f] = detectPitch(mono, offset, frameSize, sampleRate);

    // Tonality: ratio of harmonic energy to total
    // Simple proxy: zero-crossing rate — tonal signals have low, stable ZCR
    let zcr = 0;
    for (let i = 1; i < frameSize; i++) {
      if ((mono[offset + i] >= 0) !== (mono[offset + i - 1] >= 0)) zcr++;
    }
    const zcrRate = zcr / (frameSize / sampleRate);
    // Pitched voice is ~100-500 ZCR/sec; noise is >2000
    // Also require that pitch was actually detected
    tonality[f] = pitches[f] > 0 ? Math.max(0, 1 - zcrRate / 3000) : 0;
  }

  // Silence threshold
  const rmsSorted = Float32Array.from(rms).sort();
  const silenceThresh = Math.max(rmsSorted[Math.floor(rmsSorted.length * 0.2)] * 2, 0.005);

  // Find continuous pitched regions:
  // A frame is "pitched" if: energy > silence, pitch detected, tonality > 0.3
  // Pitch must be stable (within ~1 semitone of running average) across consecutive frames.
  // Any transient (energy jump > 3x) breaks the region.

  interface Region { start: number; end: number; avgPitch: number }
  const regions: Region[] = [];
  let regionStart = -1;
  let runningPitch = 0;
  let pitchFrameCount = 0;

  for (let f = 0; f < numFrames; f++) {
    const isPitched = rms[f] > silenceThresh && pitches[f] > 0 && tonality[f] > 0.3;

    // Transient detection: sudden energy spike breaks the region
    const isTransient = f > 0 && rms[f - 1] > 0 && rms[f] / rms[f - 1] > 3;

    if (isPitched && !isTransient) {
      if (regionStart < 0) {
        // Start new region
        regionStart = f;
        runningPitch = pitches[f];
        pitchFrameCount = 1;
      } else {
        // Check pitch stability: within ~2 semitones of running average
        const ratio = pitches[f] / runningPitch;
        if (ratio > 0.89 && ratio < 1.12) {
          // Stable — continue region, update running average
          runningPitch = (runningPitch * pitchFrameCount + pitches[f]) / (pitchFrameCount + 1);
          pitchFrameCount++;
        } else {
          // Pitch jumped — close current region, start new one
          const regionLen = f - regionStart;
          const regionDur = (regionLen * hopSize) / sampleRate;
          if (regionDur >= minDurationSec) {
            regions.push({ start: regionStart, end: f, avgPitch: runningPitch });
          }
          regionStart = f;
          runningPitch = pitches[f];
          pitchFrameCount = 1;
        }
      }
    } else if (regionStart >= 0) {
      // Not pitched or transient — close region
      const regionLen = f - regionStart;
      const regionDur = (regionLen * hopSize) / sampleRate;
      if (regionDur >= minDurationSec) {
        regions.push({ start: regionStart, end: f, avgPitch: runningPitch });
      }
      regionStart = -1;
      pitchFrameCount = 0;
    }
  }
  // Close final region
  if (regionStart >= 0) {
    const regionLen = numFrames - regionStart;
    const regionDur = (regionLen * hopSize) / sampleRate;
    if (regionDur >= minDurationSec) {
      regions.push({ start: regionStart, end: numFrames, avgPitch: runningPitch });
    }
  }

  // Build chops from regions, trimming attack (~50ms fade-in start)
  const attackTrimSamples = Math.floor(0.05 * sampleRate);
  const chops: Chop[] = [];

  for (const region of regions) {
    // Start a bit after the onset to skip any consonant/attack
    const rawStart = (region.start * hopSize) / sampleRate;
    // Find the first frame after start that has high tonality (skip consonant onset)
    let trimmedStart = region.start;
    for (let f = region.start; f < Math.min(region.start + 5, region.end); f++) {
      if (tonality[f] < 0.5) {
        trimmedStart = f + 1;
      } else {
        break;
      }
    }

    const startSec = Math.max(0, (trimmedStart * hopSize + attackTrimSamples) / sampleRate);
    const endSec = Math.min(duration, (region.end * hopSize) / sampleRate);

    if (endSec - startSec < minDurationSec * 0.8) continue; // allow slight tolerance

    const startSample = Math.floor(startSec * sampleRate);
    const endSample = Math.min(Math.floor(endSec * sampleRate), length);
    const sampleCount = endSample - startSample;

    let chopEnergy = 0;
    for (let s = startSample; s < endSample; s++) {
      chopEnergy += mono[s] * mono[s];
    }
    chopEnergy = sampleCount > 0 ? chopEnergy / sampleCount : 0;

    // Note name from average pitch
    const noteNum = Math.round(12 * Math.log2(region.avgPitch / 440) + 69);
    const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const noteName = noteNames[noteNum % 12] + Math.floor(noteNum / 12 - 1);

    chops.push({
      index: chops.length,
      start: startSec,
      end: endSec,
      label: `${noteName} ${(endSec - startSec).toFixed(1)}s`,
      energy: Math.min(1, chopEnergy * 100),
      spectralCentroid: region.avgPitch,
    });
  }

  return chops;
}

export function classifyChop(chop: Chop): "low" | "mid" | "high" {
  if (chop.spectralCentroid > 3000) return "high";
  if (chop.energy > 0.3 && chop.spectralCentroid < 1500) return "low";
  return "mid";
}
