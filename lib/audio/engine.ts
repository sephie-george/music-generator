"use client";

import type {
  DelayPreset,
  ReverbPreset,
  DELAY_PRESETS as DelayPresetsType,
  REVERB_PRESETS as ReverbPresetsType,
} from "../types";

// Dynamically import Tone.js to avoid SSR issues
let Tone: typeof import("tone") | null = null;

async function getTone() {
  if (!Tone) {
    Tone = await import("tone");
  }
  return Tone;
}

export interface EngineTrack {
  player: any; // Tone.Player or Tone.GrainPlayer
  delay: any; // Tone.FeedbackDelay
  reverb: any; // Tone.Reverb
  gain: any; // Tone.Gain
  buffer: any; // Tone.ToneAudioBuffer
  pitch: number; // semitones offset
  halfSpeed: boolean;
  isGranular?: boolean;
  grainSize?: number;
  overlap?: number;
  reverse?: boolean;
}

export class AudioEngine {
  private tracks: (EngineTrack | null)[] = Array(16).fill(null);
  private chopBuffers: any[] = []; // Tone.ToneAudioBuffer[]
  private sourceBuffer: AudioBuffer | null = null;
  private sequence: any = null; // Tone.Sequence
  private isPlaying = false;
  private _bpm = 120;
  private _steps = 64;
  private pattern: number[][] = Array.from({ length: 16 }, () => Array(64).fill(-1));
  private currentStep = -1;
  private onStepCallback: ((step: number) => void) | null = null;
  private initialized = false;

  // Master channel
  private masterGain: any = null;
  private masterDelay: any = null;
  private masterReverb: any = null;
  private masterCrusher: any = null;
  private masterPitch: any = null;

  async init() {
    const T = await getTone();
    await T.start();
    T.getTransport().bpm.value = this._bpm;

    // Setup master chain: masterDelay → masterReverb → masterGain → destination
    this.masterDelay = new T.FeedbackDelay(0, 0);
    this.masterDelay.wet.value = 0;
    this.masterReverb = new T.Reverb(0.01);
    this.masterReverb.wet.value = 0;
    this.masterCrusher = new T.BitCrusher(16);
    this.masterCrusher.wet.value = 0;
    this.masterPitch = new T.PitchShift(0);
    this.masterPitch.wet.value = 0;
    this.masterGain = new T.Gain(1);
    this.masterDelay.connect(this.masterReverb);
    this.masterReverb.connect(this.masterCrusher);
    this.masterCrusher.connect(this.masterPitch);
    this.masterPitch.connect(this.masterGain);
    this.masterGain.connect(T.getDestination());

    this.initialized = true;
  }

  async loadSourceBuffer(audioBuffer: AudioBuffer) {
    const T = await getTone();
    this.sourceBuffer = audioBuffer;
    // Create a Tone buffer from the AudioBuffer
    const toneBuffer = new T.ToneAudioBuffer();
    // Copy data
    const float32Arrays: Float32Array[] = [];
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      float32Arrays.push(audioBuffer.getChannelData(ch));
    }
    // Use fromArray for mono, or create manually
    if (audioBuffer.numberOfChannels === 1) {
      toneBuffer.fromArray(float32Arrays[0]);
    } else {
      // Mix to mono for simplicity in chopping
      const mono = new Float32Array(audioBuffer.length);
      for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
        const data = audioBuffer.getChannelData(ch);
        for (let i = 0; i < audioBuffer.length; i++) {
          mono[i] += data[i] / audioBuffer.numberOfChannels;
        }
      }
      toneBuffer.fromArray(mono);
    }
    this.chopBuffers = [];
  }

  async createChopBuffers(chops: { start: number; end: number }[]) {
    const T = await getTone();
    if (!this.sourceBuffer) return;

    this.chopBuffers = [];
    const sr = this.sourceBuffer.sampleRate;
    const numChannels = this.sourceBuffer.numberOfChannels;

    for (const chop of chops) {
      const startSample = Math.floor(chop.start * sr);
      const endSample = Math.min(Math.floor(chop.end * sr), this.sourceBuffer.length);
      const length = endSample - startSample;

      if (length <= 0) continue;

      // Create an offline context to build the buffer
      const offlineCtx = new OfflineAudioContext(numChannels, length, sr);
      const newBuffer = offlineCtx.createBuffer(numChannels, length, sr);

      // Fade samples: 64 samples (~1.5ms at 44100) fade in/out to avoid clicks
      const fadeSamples = Math.min(64, Math.floor(length / 4));

      for (let ch = 0; ch < numChannels; ch++) {
        const sourceData = this.sourceBuffer.getChannelData(ch);
        const targetData = newBuffer.getChannelData(ch);
        for (let i = 0; i < length; i++) {
          let sample = sourceData[startSample + i] || 0;
          // Fade in
          if (i < fadeSamples) {
            sample *= i / fadeSamples;
          }
          // Fade out
          if (i >= length - fadeSamples) {
            sample *= (length - i) / fadeSamples;
          }
          targetData[i] = sample;
        }
      }

      const toneBuffer = new T.ToneAudioBuffer();
      if (numChannels === 1) {
        toneBuffer.fromArray(newBuffer.getChannelData(0));
      } else {
        // Store as mono for Tone.Player
        const mono = new Float32Array(length);
        for (let ch = 0; ch < numChannels; ch++) {
          const data = newBuffer.getChannelData(ch);
          for (let i = 0; i < length; i++) {
            mono[i] += data[i] / numChannels;
          }
        }
        toneBuffer.fromArray(mono);
      }

      this.chopBuffers.push(toneBuffer);
    }
  }

  async setupTrack(trackIndex: number, chopIndex: number) {
    const T = await getTone();
    if (chopIndex < 0 || chopIndex >= this.chopBuffers.length) return;

    // Dispose existing track
    this.disposeTrack(trackIndex);

    const buffer = this.chopBuffers[chopIndex];
    const player = new T.Player(buffer);
    player.fadeIn = 0.003;
    player.fadeOut = 0.01;
    const delay = new T.FeedbackDelay(0, 0);
    delay.wet.value = 0;
    const reverb = new T.Reverb(0.01);
    reverb.wet.value = 0;
    const gain = new T.Gain(0.8);

    // Chain: player → delay → reverb → gain → master chain (or destination if no master)
    const dest = this.masterDelay || T.getDestination();
    player.chain(delay, reverb, gain, dest);

    this.tracks[trackIndex] = { player, delay, reverb, gain, buffer, pitch: 0, halfSpeed: false };
  }

  private disposeTrack(trackIndex: number) {
    const track = this.tracks[trackIndex];
    if (track) {
      try {
        track.player.dispose();
        track.delay.dispose();
        track.reverb.dispose();
        track.gain.dispose();
      } catch {}
      this.tracks[trackIndex] = null;
    }
  }

  async setTrackDelay(trackIndex: number, preset: DelayPreset) {
    const { DELAY_PRESETS } = await import("../types");
    const track = this.tracks[trackIndex];
    if (!track) return;
    const config = DELAY_PRESETS[preset];
    track.delay.delayTime.value = config.time;
    track.delay.feedback.value = config.feedback;
    track.delay.wet.value = config.wet;
  }

  async setTrackReverb(trackIndex: number, preset: ReverbPreset) {
    const T = await getTone();
    const { REVERB_PRESETS } = await import("../types");
    const track = this.tracks[trackIndex];
    if (!track) return;
    const config = REVERB_PRESETS[preset];

    // Reverb decay can't be changed after creation, so recreate
    const oldReverb = track.reverb;
    const newReverb = new T.Reverb(config.decay);
    newReverb.wet.value = config.wet;

    // Rewire: disconnect old, connect new
    track.delay.disconnect();
    oldReverb.dispose();
    track.delay.connect(newReverb);
    newReverb.connect(track.gain);
    track.reverb = newReverb;
  }

  setTrackVolume(trackIndex: number, volume: number) {
    const track = this.tracks[trackIndex];
    if (track) track.gain.gain.value = volume;
  }

  setTrackMute(trackIndex: number, muted: boolean) {
    const track = this.tracks[trackIndex];
    if (track) track.gain.gain.value = muted ? 0 : 0.8;
  }

  setTrackPitch(trackIndex: number, semitones: number) {
    const track = this.tracks[trackIndex];
    if (!track) return;
    track.pitch = semitones;
    this.applyPlaybackRate(trackIndex);
  }

  setTrackHalfSpeed(trackIndex: number, half: boolean) {
    const track = this.tracks[trackIndex];
    if (!track) return;
    track.halfSpeed = half;
    this.applyPlaybackRate(trackIndex);
  }

  private applyPlaybackRate(trackIndex: number) {
    const track = this.tracks[trackIndex];
    if (!track) return;
    const pitchRate = Math.pow(2, track.pitch / 12);
    const speedRate = track.halfSpeed ? 0.5 : 1;
    track.player.playbackRate = pitchRate * speedRate;
  }

  setPattern(pattern: number[][]) {
    this.pattern = pattern;
  }

  set bpm(value: number) {
    this._bpm = value;
    if (this.initialized && Tone) {
      Tone.getTransport().bpm.value = value;
    }
  }

  get bpm() {
    return this._bpm;
  }

  set steps(value: number) {
    this._steps = value;
  }

  onStep(callback: (step: number) => void) {
    this.onStepCallback = callback;
  }

  async play() {
    const T = await getTone();
    if (this.isPlaying) return;

    await T.start();
    T.getTransport().bpm.value = this._bpm;

    // Dispose existing sequence
    if (this.sequence) {
      this.sequence.dispose();
    }

    const stepIndices = Array.from({ length: this._steps }, (_, i) => i);

    this.sequence = new T.Sequence(
      (time: number, step: number) => {
        this.currentStep = step;
        this.onStepCallback?.(step);

        // Trigger all active tracks for this step
        for (let t = 0; t < 16; t++) {
          if (this.pattern[t] && this.pattern[t][step] >= 0) {
            const track = this.tracks[t];
            if (track && track.player) {
              try {
                track.player.stop(time);
                track.player.start(time);
              } catch {}
            }
          }
        }
      },
      stepIndices,
      "16n"
    );

    this.sequence.loop = true;
    this.sequence.start(0);
    T.getTransport().start();
    this.isPlaying = true;
  }

  stop() {
    if (!Tone) return;
    const T = Tone;
    T.getTransport().stop();
    T.getTransport().position = 0;
    if (this.sequence) {
      this.sequence.stop();
    }
    // Stop all track players immediately
    for (let i = 0; i < 16; i++) {
      const track = this.tracks[i];
      if (track?.player) {
        try { track.player.stop(); } catch {}
      }
    }
    this.isPlaying = false;
    this.currentStep = -1;
    this.onStepCallback?.(-1);
  }

  async pause() {
    if (!Tone) return;
    Tone.getTransport().pause();
    this.isPlaying = false;
  }

  // Start sequence only (for multi-engine sync — transport managed externally)
  async startSequence() {
    const T = await getTone();
    if (this.isPlaying) return;
    await T.start();

    if (this.sequence) this.sequence.dispose();

    const stepIndices = Array.from({ length: this._steps }, (_, i) => i);
    this.sequence = new T.Sequence(
      (time: number, step: number) => {
        this.currentStep = step;
        this.onStepCallback?.(step);
        for (let t = 0; t < 16; t++) {
          if (this.pattern[t] && this.pattern[t][step] >= 0) {
            const track = this.tracks[t];
            if (track?.player) {
              try { track.player.stop(time); track.player.start(time); } catch {}
            }
          }
        }
      },
      stepIndices,
      "16n"
    );
    this.sequence.loop = true;
    this.sequence.start(0);
    this.isPlaying = true;
  }

  // Stop sequence only (transport managed externally)
  stopSequence() {
    if (this.sequence) this.sequence.stop();
    for (let i = 0; i < 16; i++) {
      const track = this.tracks[i];
      if (track?.player) {
        try { track.player.stop(); } catch {}
      }
    }
    this.isPlaying = false;
    this.currentStep = -1;
    this.onStepCallback?.(-1);
  }

  get playing() {
    return this.isPlaying;
  }

  // Trigger a single track's chop (for note preview)
  triggerTrack(trackIndex: number) {
    const track = this.tracks[trackIndex];
    if (!track?.player || !Tone) return;
    try {
      track.player.stop();
      track.player.start();
    } catch {}
  }

  // Render piano roll pattern to an AudioBuffer (offline)
  async renderToBuffer(): Promise<AudioBuffer> {
    if (!this.sourceBuffer) throw new Error("No audio loaded");

    const sampleRate = 44100;
    const stepDuration = 60 / this._bpm / 4; // 16th note duration
    const totalDuration = this._steps * stepDuration;
    const totalSamples = Math.ceil(totalDuration * sampleRate);

    const offlineCtx = new OfflineAudioContext(2, totalSamples, sampleRate);

    for (let t = 0; t < 16; t++) {
      const track = this.tracks[t];
      if (!track) continue;

      for (let s = 0; s < this._steps; s++) {
        if (this.pattern[t][s] < 0) continue;

        const chopIdx = this.pattern[t][s];
        if (chopIdx >= this.chopBuffers.length) continue;

        const toneBuffer = this.chopBuffers[chopIdx];
        if (!toneBuffer || !toneBuffer.length) continue;

        const time = s * stepDuration;

        const bufferSource = offlineCtx.createBufferSource();
        const srcLength = toneBuffer.length;
        const buffer = offlineCtx.createBuffer(1, srcLength, toneBuffer.sampleRate || sampleRate);
        const channelData = buffer.getChannelData(0);
        const srcData = toneBuffer.toArray() as Float32Array;
        channelData.set(srcData);

        bufferSource.buffer = buffer;
        const gainNode = offlineCtx.createGain();
        gainNode.gain.value = 0.8;
        bufferSource.connect(gainNode);
        gainNode.connect(offlineCtx.destination);
        bufferSource.start(time);
      }
    }

    return offlineCtx.startRendering();
  }

  // Export piano roll to WAV
  async exportWAV(): Promise<Blob> {
    const renderedBuffer = await this.renderToBuffer();
    return audioBufferToWav(renderedBuffer);
  }

  // Export magic soundscape to WAV
  async exportMagicWAV(): Promise<Blob> {
    if (!this._magicBuffer) throw new Error("No magic buffer — generate first");
    return audioBufferToWav(this._magicBuffer);
  }

  // Merge two AudioBuffers into one (static utility)
  static mergeBuffers(a: AudioBuffer, b: AudioBuffer): AudioBuffer {
    const sampleRate = a.sampleRate;
    const length = Math.max(a.length, b.length);
    const ctx = new OfflineAudioContext(2, length, sampleRate);
    const buffer = ctx.createBuffer(2, length, sampleRate);

    // Mix both to stereo channels
    for (let ch = 0; ch < 2; ch++) {
      const out = buffer.getChannelData(ch);
      const aCh = ch < a.numberOfChannels ? a.getChannelData(ch) : a.getChannelData(0);
      const bCh = ch < b.numberOfChannels ? b.getChannelData(ch) : b.getChannelData(0);
      for (let i = 0; i < length; i++) {
        const va = i < a.length ? aCh[i] : 0;
        const vb = i < b.length ? bCh[i] : 0;
        out[i] = Math.max(-1, Math.min(1, va * 0.7 + vb * 0.7));
      }
    }
    return buffer;
  }

  // Master effects
  async setMasterDelay(preset: DelayPreset) {
    const { DELAY_PRESETS } = await import("../types");
    if (!this.masterDelay) return;
    const config = DELAY_PRESETS[preset];
    this.masterDelay.delayTime.value = config.time;
    this.masterDelay.feedback.value = config.feedback;
    this.masterDelay.wet.value = config.wet;
  }

  async setMasterReverb(preset: ReverbPreset) {
    const T = await getTone();
    const { REVERB_PRESETS } = await import("../types");
    if (!this.masterReverb) return;
    const config = REVERB_PRESETS[preset];
    const oldReverb = this.masterReverb;
    const newReverb = new T.Reverb(config.decay);
    newReverb.wet.value = config.wet;
    this.masterDelay.disconnect();
    oldReverb.disconnect();
    oldReverb.dispose();
    this.masterDelay.connect(newReverb);
    newReverb.connect(this.masterCrusher);
    this.masterReverb = newReverb;

  }

  // BitCrusher: bits = 1-16 (lower = more crushed), wet 0-1
  setMasterCrusher(bits: number, wet: number) {
    if (!this.masterCrusher) return;
    this.masterCrusher.bits.value = bits;
    this.masterCrusher.wet.value = wet;
  }

  // Master pitch in semitones
  setMasterPitch(semitones: number) {
    if (!this.masterPitch) return;
    this.masterPitch.pitch = semitones;
    this.masterPitch.wet.value = semitones === 0 ? 0 : 1;
  }

  setMasterVolume(volume: number) {
    if (this.masterGain) this.masterGain.gain.value = volume;
  }

  // Magic soundscape
  private _magicPlayer: any = null;
  private _magicBuffer: AudioBuffer | null = null;

  async generateMagic(params: { stretchFactor: number; windowSize: number; layers: boolean; reverbTail: number }): Promise<AudioBuffer> {
    if (!this.sourceBuffer) throw new Error("No audio loaded");

    // Collect unique chop indices used in the current pattern
    const usedChopSet = new Set<number>();
    for (let t = 0; t < 16; t++) {
      for (let s = 0; s < this._steps; s++) {
        const v = this.pattern[t][s];
        if (v >= 0 && v < this.chopBuffers.length) {
          usedChopSet.add(v);
        }
      }
    }
    const usedChops = Array.from(usedChopSet).sort((a, b) => a - b);
    if (usedChops.length === 0) throw new Error("No chops in pattern");

    // Build a continuous, dense buffer from the used chops with crossfades
    const crossfadeSamples = 512;
    const chopArrays: Float32Array[] = usedChops.map(
      (idx) => this.chopBuffers[idx].toArray() as Float32Array
    );

    // Calculate total length (each chop overlaps with next by crossfadeSamples)
    let totalLength = 0;
    for (const arr of chopArrays) totalLength += arr.length;
    if (chopArrays.length > 1) {
      totalLength -= crossfadeSamples * (chopArrays.length - 1);
    }
    // Repeat the sequence a few times for longer source material
    const repeats = Math.max(1, Math.min(4, Math.ceil(2.0 / (totalLength / this.sourceBuffer.sampleRate))));
    const singlePassLength = totalLength;
    totalLength *= repeats;

    const continuous = new Float32Array(totalLength);

    for (let rep = 0; rep < repeats; rep++) {
      let offset = rep * singlePassLength;
      for (let i = 0; i < chopArrays.length; i++) {
        const chopData = chopArrays[i];
        for (let s = 0; s < chopData.length; s++) {
          const pos = offset + s;
          if (pos >= 0 && pos < totalLength) {
            // Crossfade: fade in at the start of each chop (except first), fade out at end
            let gain = 1;
            if (i > 0 && s < crossfadeSamples) {
              gain = s / crossfadeSamples; // fade in
            }
            if (i < chopArrays.length - 1 && s >= chopData.length - crossfadeSamples) {
              gain = (chopData.length - s) / crossfadeSamples; // fade out
            }
            continuous[pos] += chopData[s] * gain;
          }
        }
        offset += chopData.length - (i < chopArrays.length - 1 ? crossfadeSamples : 0);
      }
    }

    // Normalize
    let peak = 0;
    for (let i = 0; i < totalLength; i++) {
      const v = Math.abs(continuous[i]);
      if (v > peak) peak = v;
    }
    if (peak > 0) {
      const scale = 0.95 / peak;
      for (let i = 0; i < totalLength; i++) continuous[i] *= scale;
    }

    // Create AudioBuffer from continuous data
    const sr = this.sourceBuffer.sampleRate;
    const offCtx = new OfflineAudioContext(1, totalLength, sr);
    const denseBuffer = offCtx.createBuffer(1, totalLength, sr);
    denseBuffer.getChannelData(0).set(continuous);

    // Now Paulstretch the dense, tonal material
    const { MagicSoundscape } = await import("./magic");
    const magic = new MagicSoundscape(denseBuffer, params);
    const result = await magic.generate();
    this._magicBuffer = result;
    return result;
  }

  async playMagic(): Promise<void> {
    const T = await getTone();
    this.stopMagic();
    if (!this._magicBuffer) return;

    const toneBuffer = new T.ToneAudioBuffer();
    const mono = new Float32Array(this._magicBuffer.length);
    for (let ch = 0; ch < this._magicBuffer.numberOfChannels; ch++) {
      const data = this._magicBuffer.getChannelData(ch);
      for (let i = 0; i < this._magicBuffer.length; i++) {
        mono[i] += data[i] / this._magicBuffer.numberOfChannels;
      }
    }
    toneBuffer.fromArray(mono);

    this._magicPlayer = new T.Player(toneBuffer).toDestination();
    this._magicPlayer.loop = true;
    this._magicPlayer.fadeIn = 2;
    this._magicPlayer.fadeOut = 2;
    this._magicPlayer.start();
  }

  stopMagic() {
    if (this._magicPlayer) {
      try { this._magicPlayer.stop(); this._magicPlayer.dispose(); } catch {}
      this._magicPlayer = null;
    }
  }

  get hasMagicBuffer(): boolean {
    return this._magicBuffer !== null;
  }

  getSourceBuffer(): AudioBuffer | null {
    return this.sourceBuffer;
  }

  // Play original source audio
  private _sourcePlayer: any = null;
  private _sourceStopCallback: (() => void) | null = null;

  onSourceStop(cb: () => void) {
    this._sourceStopCallback = cb;
  }

  get isSourcePlaying(): boolean {
    return this._sourcePlayer?.state === "started";
  }

  async playSource() {
    const T = await getTone();
    if (!this.sourceBuffer) return;
    await T.start();

    // Stop any existing source playback
    this.stopSource();

    const toneBuffer = new T.ToneAudioBuffer();
    const mono = new Float32Array(this.sourceBuffer.length);
    for (let ch = 0; ch < this.sourceBuffer.numberOfChannels; ch++) {
      const data = this.sourceBuffer.getChannelData(ch);
      for (let i = 0; i < this.sourceBuffer.length; i++) {
        mono[i] += data[i] / this.sourceBuffer.numberOfChannels;
      }
    }
    toneBuffer.fromArray(mono);

    this._sourcePlayer = new T.Player(toneBuffer).toDestination();
    this._sourcePlayer.fadeIn = 0.005;
    this._sourcePlayer.fadeOut = 0.01;
    this._sourcePlayer.onstop = () => {
      this._sourceStopCallback?.();
    };
    this._sourcePlayer.start();
  }

  stopSource() {
    if (this._sourcePlayer) {
      try {
        this._sourcePlayer.stop();
        this._sourcePlayer.dispose();
      } catch {}
      this._sourcePlayer = null;
    }
  }

  // Stop everything — transport + source
  stopAll() {
    this.stop();
    this.stopSource();
  }

  // ── Advanced vocal effects ──

  // Switch a track to granular playback mode (GrainPlayer)
  async setTrackGranular(trackIndex: number, enabled: boolean, grainSize: number = 0.05, overlap: number = 0.5) {
    const T = await getTone();
    const track = this.tracks[trackIndex];
    if (!track) return;

    if (enabled && !track.isGranular) {
      // Replace Player with GrainPlayer
      const oldPlayer = track.player;
      const grainPlayer = new T.GrainPlayer(track.buffer);
      grainPlayer.grainSize = grainSize;
      grainPlayer.overlap = overlap;
      grainPlayer.loop = false;

      // Rewire chain
      oldPlayer.disconnect();
      oldPlayer.dispose();
      grainPlayer.connect(track.delay);
      track.player = grainPlayer;
      track.isGranular = true;
      track.grainSize = grainSize;
      track.overlap = overlap;
      this.applyPlaybackRate(trackIndex);
    } else if (!enabled && track.isGranular) {
      // Replace GrainPlayer back with Player
      const oldPlayer = track.player;
      const player = new T.Player(track.buffer);
      player.fadeIn = 0.003;
      player.fadeOut = 0.01;

      oldPlayer.disconnect();
      oldPlayer.dispose();
      player.connect(track.delay);
      track.player = player;
      track.isGranular = false;
      this.applyPlaybackRate(trackIndex);
    } else if (enabled && track.isGranular) {
      // Just update parameters
      track.player.grainSize = grainSize;
      track.player.overlap = overlap;
      track.grainSize = grainSize;
      track.overlap = overlap;
    }
  }

  // Reverse a track's buffer
  async setTrackReverse(trackIndex: number, reversed: boolean) {
    const T = await getTone();
    const track = this.tracks[trackIndex];
    if (!track) return;
    track.reverse = reversed;
    track.player.reverse = reversed;
  }

  // Create a "freeze" buffer from a track — loop a tiny slice of the chop
  async setTrackFreeze(trackIndex: number, enabled: boolean, position: number = 0.5, windowMs: number = 80) {
    const T = await getTone();
    const track = this.tracks[trackIndex];
    if (!track) return;

    if (enabled) {
      // Switch to GrainPlayer with tiny grains for freeze effect
      if (!track.isGranular) {
        await this.setTrackGranular(trackIndex, true, windowMs / 1000, 0.5);
      }
      // Set playback rate to near-zero to "freeze" at a position
      track.player.grainSize = windowMs / 1000;
      track.player.overlap = 0.8;
      track.player.loop = true;
      track.player.loopStart = position * (track.buffer.duration || 0.1);
      track.player.loopEnd = track.player.loopStart + windowMs / 1000;
    } else {
      track.player.loop = false;
      // Restore normal grain settings or switch back to Player
      await this.setTrackGranular(trackIndex, false);
    }
  }

  // Filter (LP/HP/BP)
  async setTrackFilter(trackIndex: number, type: "lowpass" | "highpass" | "bandpass" | "off", frequency: number, Q: number) {
    const T = await getTone();
    const track = this.tracks[trackIndex];
    if (!track) return;

    if (type === "off") {
      if ((track as any)._filter) {
        track.player.disconnect();
        (track as any)._filter.dispose();
        (track as any)._filter = null;
        track.player.connect(track.delay);
      }
      return;
    }

    if (!(track as any)._filter) {
      const filter = new T.Filter(frequency, type);
      filter.Q.value = Q;
      track.player.disconnect();
      track.player.connect(filter);
      filter.connect(track.delay);
      (track as any)._filter = filter;
    } else {
      (track as any)._filter.type = type;
      (track as any)._filter.frequency.value = frequency;
      (track as any)._filter.Q.value = Q;
    }
  }

  // Stutter (tremolo-based amplitude modulation)
  async setTrackStutter(trackIndex: number, enabled: boolean, rate: number = 16, depth: number = 1) {
    const T = await getTone();
    const track = this.tracks[trackIndex];
    if (!track) return;

    if (enabled) {
      if (!(track as any)._tremolo) {
        const tremolo = new T.Tremolo(rate, depth).start();
        track.reverb.disconnect();
        track.reverb.connect(tremolo);
        tremolo.connect(track.gain);
        (track as any)._tremolo = tremolo;
      } else {
        (track as any)._tremolo.frequency.value = rate;
        (track as any)._tremolo.depth.value = depth;
      }
    } else {
      if ((track as any)._tremolo) {
        track.reverb.disconnect();
        (track as any)._tremolo.dispose();
        (track as any)._tremolo = null;
        track.reverb.connect(track.gain);
      }
    }
  }

  // Time stretch (granular playback rate)
  setTrackTimeStretch(trackIndex: number, rate: number) {
    const track = this.tracks[trackIndex];
    if (!track) return;
    if (track.isGranular) {
      track.player.playbackRate = rate;
    }
  }

  // Get reversed chop buffers (for reverse stacking)
  async createReversedChopBuffer(chopIndex: number): Promise<any> {
    const T = await getTone();
    if (chopIndex < 0 || chopIndex >= this.chopBuffers.length) return null;
    const original = this.chopBuffers[chopIndex];
    const srcData = original.toArray() as Float32Array;
    const reversed = new Float32Array(srcData.length);
    for (let i = 0; i < srcData.length; i++) {
      reversed[i] = srcData[srcData.length - 1 - i];
    }
    const buf = new T.ToneAudioBuffer();
    buf.fromArray(reversed);
    return buf;
  }

  dispose() {
    this.stop();
    this.stopSource();
    this.stopMagic();
    if (this._sourcePlayer) {
      try { this._sourcePlayer.dispose(); } catch {}
      this._sourcePlayer = null;
    }
    if (this.sequence) {
      this.sequence.dispose();
      this.sequence = null;
    }
    for (let i = 0; i < 16; i++) {
      this.disposeTrack(i);
    }
    this.chopBuffers = [];
    this.sourceBuffer = null;
  }
}

export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataLength = buffer.length * blockAlign;
  const headerLength = 44;
  const totalLength = headerLength + dataLength;

  const arrayBuffer = new ArrayBuffer(totalLength);
  const view = new DataView(arrayBuffer);

  // WAV header
  writeString(view, 0, "RIFF");
  view.setUint32(4, totalLength - 8, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataLength, true);

  // Interleave channel data
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(buffer.getChannelData(ch));
  }

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, int16, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
