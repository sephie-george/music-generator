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

export function classifyChop(chop: Chop): "low" | "mid" | "high" {
  if (chop.spectralCentroid > 3000) return "high";
  if (chop.energy > 0.3 && chop.spectralCentroid < 1500) return "low";
  return "mid";
}
