"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Upload,
  Play,
  Square,
  Pause,
  Download,
  Save,
  Shuffle,
  Trash2,
  AudioWaveform,
  Sun,
  Moon,
  CopyCheck,
} from "lucide-react";
import type {
  ProjectData,
  Chop,
  DelayPreset,
  ReverbPreset,
  PatternTemplate,
} from "@/lib/types";
import {
  DELAY_PRESETS,
  REVERB_PRESETS,
  PATTERN_TEMPLATES,
  TRACK_COLORS,
} from "@/lib/types";
import { getProject, saveProject, saveAudioBlob, getAudioBlob } from "@/lib/store";
import { detectTransients, chopEqual } from "@/lib/audio/transient-detector";
import { generatePattern, generateFromPrompt } from "@/lib/audio/pattern-generator";
import { AudioEngine, audioBufferToWav as audioBufferToWavLocal } from "@/lib/audio/engine";
import { useTheme } from "@/app/theme-provider";

function emptyPattern(): number[][] {
  return Array.from({ length: 16 }, () => Array(64).fill(-1));
}

function defaultEffects(): { delay: DelayPreset; reverb: ReverbPreset }[] {
  return Array.from({ length: 16 }, () => ({ delay: "none" as DelayPreset, reverb: "none" as ReverbPreset }));
}

// Helper to update one lane in a tuple
function updateLane<T>(setter: React.Dispatch<React.SetStateAction<[T, T]>>, idx: number, value: NoInfer<T>) {
  setter((prev: [T, T]) => {
    const next: [T, T] = [prev[0], prev[1]];
    next[idx] = value;
    return next;
  });
}

// Helper to update one lane using a functional updater
function updateLaneFn<T>(setter: React.Dispatch<React.SetStateAction<[T, T]>>, idx: number, fn: (prev: T) => T) {
  setter((prev: [T, T]) => {
    const next: [T, T] = [prev[0], prev[1]];
    next[idx] = fn(prev[idx]);
    return next;
  });
}

export default function EditorPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const { theme, toggleTheme } = useTheme();

  const [project, setProject] = useState<ProjectData | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [lanePlaying, setLanePlaying] = useState<[boolean, boolean]>([false, false]);
  const [currentStep, setCurrentStep] = useState(-1);
  const [bpm, setBpm] = useState(120);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportMode, setExportMode] = useState<"lanes" | "merged" | "magic">("lanes");
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [playMode, setPlayMode] = useState<"both" | 0 | 1>("both");

  // Resizable divider
  const [laneSplit, setLaneSplit] = useState(50); // percentage for lane 0
  const dividerDragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Master effects (shared)
  const [masterDelay, setMasterDelay] = useState<DelayPreset>("none");
  const [masterReverb, setMasterReverb] = useState<ReverbPreset>("none");
  const [masterCrusherOn, setMasterCrusherOn] = useState(false);
  const [masterCrusherBits, setMasterCrusherBits] = useState(8);
  const [masterPitch, setMasterPitchState] = useState(0);

  // Per-lane state arrays
  const [laneChops, setLaneChops] = useState<[Chop[], Chop[]]>([[], []]);
  const [lanePatterns, setLanePatterns] = useState<[number[][], number[][]]>([emptyPattern(), emptyPattern()]);
  const [laneBuffers, setLaneBuffers] = useState<[AudioBuffer | null, AudioBuffer | null]>([null, null]);
  const [laneFileNames, setLaneFileNames] = useState<[string, string]>(["", ""]);
  const [laneTrackChops, setLaneTrackChops] = useState<[number[], number[]]>([Array(16).fill(-1), Array(16).fill(-1)]);
  const [laneTrackEffects, setLaneTrackEffects] = useState<[{ delay: DelayPreset; reverb: ReverbPreset }[], { delay: DelayPreset; reverb: ReverbPreset }[]]>([defaultEffects(), defaultEffects()]);
  const [laneTrackMutes, setLaneTrackMutes] = useState<[boolean[], boolean[]]>([Array(16).fill(false), Array(16).fill(false)]);
  const [laneTrackSolos, setLaneTrackSolos] = useState<[boolean[], boolean[]]>([Array(16).fill(false), Array(16).fill(false)]);
  const [laneTrackPitches, setLaneTrackPitches] = useState<[number[], number[]]>([Array(16).fill(0), Array(16).fill(0)]);
  const [laneTrackHalfSpeed, setLaneTrackHalfSpeed] = useState<[boolean[], boolean[]]>([Array(16).fill(false), Array(16).fill(false)]);
  const [laneChopModes, setLaneChopModes] = useState<["transient" | "equal" | "fine", "transient" | "equal" | "fine"]>(["transient", "transient"]);
  const [laneSensitivities, setLaneSensitivities] = useState<["soft" | "medium" | "hard", "soft" | "medium" | "hard"]>(["medium", "medium"]);
  const [laneSelectedTemplates, setLaneSelectedTemplates] = useState<[PatternTemplate, PatternTemplate]>(["basic", "basic"]);
  const [lanePromptTexts, setLanePromptTexts] = useState<[string, string]>(["", ""]);
  const [laneLoadings, setLaneLoadings] = useState<[boolean, boolean]>([false, false]);
  const [lanePlayingSources, setLanePlayingSources] = useState<[boolean, boolean]>([false, false]);
  const [laneDragging, setLaneDragging] = useState<[boolean, boolean]>([false, false]);

  // Advanced mode per-track state
  interface AdvTrackState {
    granular: boolean;
    grainSize: number; // seconds
    overlap: number; // 0-1
    reverse: boolean;
    freeze: boolean;
    freezePos: number; // 0-1
    freezeWindow: number; // ms
    detune: number; // cents (fine pitch, -50 to 50)
    filterType: "off" | "lowpass" | "highpass" | "bandpass";
    filterFreq: number; // Hz, 20-20000
    filterQ: number; // 0.1-20
    stutter: boolean;
    stutterRate: number; // Hz, 2-64
    stutterDepth: number; // 0-1
    timeStretch: number; // 0.25-2.0, 1.0 = normal
  }
  const defaultAdvTrack = (): AdvTrackState => ({
    granular: false, grainSize: 0.05, overlap: 0.5,
    reverse: false,
    freeze: false, freezePos: 0.5, freezeWindow: 80,
    detune: 0,
    filterType: "off", filterFreq: 1000, filterQ: 1,
    stutter: false, stutterRate: 16, stutterDepth: 1,
    timeStretch: 1.0,
  });
  const [laneAdvTracks, setLaneAdvTracks] = useState<[AdvTrackState[], AdvTrackState[]]>([
    Array.from({ length: 16 }, defaultAdvTrack),
    Array.from({ length: 16 }, defaultAdvTrack),
  ]);
  const [selectedAdvTrack, setSelectedAdvTrack] = useState<[number, number]>([0, 0]);

  // Magic soundscape state
  const [magicGenerating, setMagicGenerating] = useState<[boolean, boolean]>([false, false]);
  const [magicReady, setMagicReady] = useState<[boolean, boolean]>([false, false]);
  const [magicPlaying, setMagicPlaying] = useState<[boolean, boolean]>([false, false]);
  const [magicStretch, setMagicStretch] = useState(20);
  const [magicLayers, setMagicLayers] = useState(true);
  const [magicReverb, setMagicReverb] = useState(8);

  // Mouse drag painting state
  const [isPainting, setIsPainting] = useState(false);
  const paintModeRef = useRef<"add" | "remove">("add");
  const paintedCellsRef = useRef<Set<string>>(new Set());
  const paintingLaneRef = useRef<number>(-1);

  const engineRefs = [useRef<AudioEngine | null>(null), useRef<AudioEngine | null>(null)];
  const canvasRefs = [useRef<HTMLCanvasElement>(null), useRef<HTMLCanvasElement>(null)];
  const loadedRef = useRef(false);

  // Build a LaneState (for persistence) from indexed state
  const buildLaneState = (idx: number) => ({
    tracks: Array.from({ length: 16 }, (_, i) => ({
      chopIndex: laneTrackChops[idx][i],
      delay: laneTrackEffects[idx][i].delay,
      reverb: laneTrackEffects[idx][i].reverb,
      volume: 0.8,
      muted: laneTrackMutes[idx][i],
      pitch: laneTrackPitches[idx][i],
      halfSpeed: laneTrackHalfSpeed[idx][i],
    })),
    pattern: lanePatterns[idx],
    chopBoundaries: laneChops[idx].map((c) => ({ start: c.start, end: c.end })),
  });

  // Load project
  useEffect(() => {
    (async () => {
      const p = await getProject(projectId);
      if (!p) {
        router.push("/");
        return;
      }
      setProject(p);
      setBpm(p.bpm);

      // Determine lane data (backward compat)
      const lane0Data = p.lanes?.[0] ?? (p.tracks ? { tracks: p.tracks, pattern: p.pattern || emptyPattern(), chopBoundaries: p.chopBoundaries || [] } : null);
      const lane1Data = p.lanes?.[1] ?? null;

      // Load lane 0
      if (lane0Data) {
        updateLane(setLanePatterns, 0, lane0Data.pattern);
        updateLane(setLaneTrackChops, 0, lane0Data.tracks.map((t) => t.chopIndex));
        updateLane(setLaneTrackEffects, 0, lane0Data.tracks.map((t) => ({ delay: t.delay, reverb: t.reverb })));
        updateLane(setLaneTrackMutes, 0, lane0Data.tracks.map((t) => t.muted));
        updateLane(setLaneTrackPitches, 0, lane0Data.tracks.map((t) => (t as any).pitch ?? 0));
        updateLane(setLaneTrackHalfSpeed, 0, lane0Data.tracks.map((t) => (t as any).halfSpeed ?? false));
      }

      // Load lane 1
      if (lane1Data) {
        updateLane(setLanePatterns, 1, lane1Data.pattern);
        updateLane(setLaneTrackChops, 1, lane1Data.tracks.map((t) => t.chopIndex));
        updateLane(setLaneTrackEffects, 1, lane1Data.tracks.map((t) => ({ delay: t.delay, reverb: t.reverb })));
        updateLane(setLaneTrackMutes, 1, lane1Data.tracks.map((t) => t.muted));
        updateLane(setLaneTrackPitches, 1, lane1Data.tracks.map((t) => (t as any).pitch ?? 0));
        updateLane(setLaneTrackHalfSpeed, 1, lane1Data.tracks.map((t) => (t as any).halfSpeed ?? false));
      }

      loadedRef.current = true;

      // Try to reload audio for lane 0
      getAudioBlob(projectId, 0).then(async (blob) => {
        if (blob) {
          const arrayBuffer = await blob.arrayBuffer();
          const audioCtx = new AudioContext();
          const buffer = await audioCtx.decodeAudioData(arrayBuffer);
          updateLane(setLaneBuffers, 0, buffer);
          updateLane(setLaneFileNames, 0, "(saved audio)");

          if (lane0Data && lane0Data.chopBoundaries.length > 0) {
            const detectedChops = detectTransients(buffer);
            updateLane(setLaneChops, 0, detectedChops);
            await initEngine(buffer, detectedChops, 0, p, lane0Data);
          }
        }
      });

      // Try to reload audio for lane 1
      getAudioBlob(projectId, 1).then(async (blob) => {
        if (blob) {
          const arrayBuffer = await blob.arrayBuffer();
          const audioCtx = new AudioContext();
          const buffer = await audioCtx.decodeAudioData(arrayBuffer);
          updateLane(setLaneBuffers, 1, buffer);
          updateLane(setLaneFileNames, 1, "(saved audio)");

          if (lane1Data && lane1Data.chopBoundaries.length > 0) {
            const detectedChops = detectTransients(buffer);
            updateLane(setLaneChops, 1, detectedChops);
            await initEngine(buffer, detectedChops, 1, p, lane1Data);
          }
        }
      });
    })();

    return () => {
      engineRefs[0].current?.dispose();
      engineRefs[1].current?.dispose();
    };
  }, [projectId]);

  // Autosave
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!project || !loadedRef.current) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(async () => {
      const updated: ProjectData = {
        ...project,
        bpm,
        lanes: [
          buildLaneState(0),
          buildLaneState(1),
        ],
      };
      await saveProject(updated);
      setProject(updated);
    }, 2000);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [bpm, lanePatterns, laneTrackChops, laneTrackEffects, laneTrackMutes, laneTrackPitches, laneTrackHalfSpeed, laneChops]);

  // Draw waveforms
  useEffect(() => {
    if (!laneBuffers[0] || !canvasRefs[0].current) return;
    drawWaveform(canvasRefs[0].current, laneBuffers[0], laneChops[0]);
  }, [laneBuffers[0], laneChops[0], theme]);

  useEffect(() => {
    if (!laneBuffers[1] || !canvasRefs[1].current) return;
    drawWaveform(canvasRefs[1].current, laneBuffers[1], laneChops[1]);
  }, [laneBuffers[1], laneChops[1], theme]);

  const initEngine = async (
    buffer: AudioBuffer,
    chopList: Chop[],
    laneIdx: number,
    proj?: ProjectData,
    laneData?: { tracks: any[]; pattern: number[][]; chopBoundaries: { start: number; end: number }[] }
  ) => {
    const engine = new AudioEngine();
    await engine.init();
    await engine.loadSourceBuffer(buffer);
    await engine.createChopBuffers(
      chopList.map((c) => ({ start: c.start, end: c.end }))
    );

    const tracks = laneData?.tracks ?? proj?.lanes?.[laneIdx]?.tracks;
    const tChops = tracks?.map((t: any) => t.chopIndex) || laneTrackChops[laneIdx];

    for (let i = 0; i < 16; i++) {
      if (tChops[i] >= 0 && tChops[i] < chopList.length) {
        await engine.setupTrack(i, tChops[i]);
        if (tracks?.[i]) {
          await engine.setTrackDelay(i, tracks[i].delay);
          await engine.setTrackReverb(i, tracks[i].reverb);
          engine.setTrackPitch(i, (tracks[i] as any).pitch ?? 0);
          engine.setTrackHalfSpeed(i, (tracks[i] as any).halfSpeed ?? false);
        }
      }
    }

    const pat = laneData?.pattern ?? proj?.lanes?.[laneIdx]?.pattern ?? lanePatterns[laneIdx];
    engine.setPattern(pat);
    engine.bpm = proj?.bpm || bpm;

    engine.onStep((step) => setCurrentStep(step));

    engineRefs[laneIdx].current?.dispose();
    engineRefs[laneIdx].current = engine;
  };

  // Handle file upload
  const handleFile = async (file: File, laneIdx: number) => {
    if (!file.type.startsWith("audio/")) return;
    updateLane(setLaneLoadings, laneIdx, true);
    updateLane(setLaneFileNames, laneIdx, file.name);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioCtx = new AudioContext();
      const buffer = await audioCtx.decodeAudioData(arrayBuffer);
      updateLane(setLaneBuffers, laneIdx, buffer);

      await saveAudioBlob(projectId, file, laneIdx);

      const detectedChops = detectTransients(buffer);
      updateLane(setLaneChops, laneIdx, detectedChops);

      const newTrackChops = Array(16).fill(-1);
      for (let i = 0; i < 16; i++) {
        newTrackChops[i] = detectedChops.length > 0 ? i % detectedChops.length : -1;
      }
      updateLane(setLaneTrackChops, laneIdx, newTrackChops);

      await initEngine(buffer, detectedChops, laneIdx);

      for (let i = 0; i < 16; i++) {
        if (newTrackChops[i] >= 0) {
          await engineRefs[laneIdx].current?.setupTrack(i, newTrackChops[i]);
        }
      }
    } catch (err) {
      console.error("Error loading audio:", err);
    } finally {
      updateLane(setLaneLoadings, laneIdx, false);
    }
  };

  const handleDrop = (e: React.DragEvent, laneIdx: number) => {
    e.preventDefault();
    updateLane(setLaneDragging, laneIdx, false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file, laneIdx);
  };

  // Piano roll cell toggle
  const toggleCell = (track: number, step: number, laneIdx: number) => {
    const chopIdx = laneTrackChops[laneIdx][track];
    if (chopIdx < 0) return;

    const newPattern = lanePatterns[laneIdx].map((row) => [...row]);
    const wasActive = newPattern[track][step] >= 0;
    newPattern[track][step] = wasActive ? -1 : chopIdx;
    updateLane(setLanePatterns, laneIdx, newPattern);
    engineRefs[laneIdx].current?.setPattern(newPattern);

    if (!wasActive) {
      engineRefs[laneIdx].current?.triggerTrack(track);
    }
  };

  // Mouse drag painting
  const handleCellMouseDown = (track: number, step: number, laneIdx: number) => {
    const chopIdx = laneTrackChops[laneIdx][track];
    if (chopIdx < 0) return;

    const isActive = lanePatterns[laneIdx][track][step] >= 0;
    paintModeRef.current = isActive ? "remove" : "add";
    paintedCellsRef.current = new Set([`${track}-${step}`]);
    paintingLaneRef.current = laneIdx;
    setIsPainting(true);
    toggleCell(track, step, laneIdx);
  };

  const handleCellMouseEnter = (track: number, step: number, laneIdx: number) => {
    if (!isPainting || paintingLaneRef.current !== laneIdx) return;
    const chopIdx = laneTrackChops[laneIdx][track];
    if (chopIdx < 0) return;
    const key = `${track}-${step}`;
    if (paintedCellsRef.current.has(key)) return;
    paintedCellsRef.current.add(key);

    const isActive = lanePatterns[laneIdx][track][step] >= 0;
    const shouldBeActive = paintModeRef.current === "add";
    if (isActive !== shouldBeActive) {
      toggleCell(track, step, laneIdx);
    }
  };

  const handleMouseUp = useCallback(() => {
    setIsPainting(false);
    paintedCellsRef.current.clear();
    paintingLaneRef.current = -1;
  }, []);

  useEffect(() => {
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, [handleMouseUp]);

  // Track chop assignment
  const assignChop = async (track: number, chopIndex: number, laneIdx: number) => {
    const newTrackChops = [...laneTrackChops[laneIdx]];
    newTrackChops[track] = chopIndex;
    updateLane(setLaneTrackChops, laneIdx, newTrackChops);

    if (chopIndex >= 0) {
      await engineRefs[laneIdx].current?.setupTrack(track, chopIndex);
      await engineRefs[laneIdx].current?.setTrackDelay(track, laneTrackEffects[laneIdx][track].delay);
      await engineRefs[laneIdx].current?.setTrackReverb(track, laneTrackEffects[laneIdx][track].reverb);
    }

    const newPattern = lanePatterns[laneIdx].map((row) => [...row]);
    for (let s = 0; s < 64; s++) {
      if (newPattern[track][s] >= 0) {
        newPattern[track][s] = chopIndex;
      }
    }
    updateLane(setLanePatterns, laneIdx, newPattern);
    engineRefs[laneIdx].current?.setPattern(newPattern);
  };

  // Effects
  const setDelay = async (track: number, preset: DelayPreset, laneIdx: number) => {
    const newEffects = [...laneTrackEffects[laneIdx]];
    newEffects[track] = { ...newEffects[track], delay: preset };
    updateLane(setLaneTrackEffects, laneIdx, newEffects);
    await engineRefs[laneIdx].current?.setTrackDelay(track, preset);
  };

  const setReverb = async (track: number, preset: ReverbPreset, laneIdx: number) => {
    const newEffects = [...laneTrackEffects[laneIdx]];
    newEffects[track] = { ...newEffects[track], reverb: preset };
    updateLane(setLaneTrackEffects, laneIdx, newEffects);
    await engineRefs[laneIdx].current?.setTrackReverb(track, preset);
  };

  const toggleMute = (track: number, laneIdx: number) => {
    const newMutes = [...laneTrackMutes[laneIdx]];
    newMutes[track] = !newMutes[track];
    updateLane(setLaneTrackMutes, laneIdx, newMutes);
    applyMuteSolo(newMutes, laneTrackSolos[laneIdx], laneIdx);
  };

  const toggleSolo = (track: number, laneIdx: number) => {
    const newSolos = [...laneTrackSolos[laneIdx]];
    newSolos[track] = !newSolos[track];
    updateLane(setLaneTrackSolos, laneIdx, newSolos);
    applyMuteSolo(laneTrackMutes[laneIdx], newSolos, laneIdx);
  };

  const applyMuteSolo = (mutes: boolean[], solos: boolean[], laneIdx: number) => {
    const anySolo = solos.some(Boolean);
    for (let i = 0; i < 16; i++) {
      const shouldMute = mutes[i] || (anySolo && !solos[i]);
      engineRefs[laneIdx].current?.setTrackMute(i, shouldMute);
    }
  };

  const setPitch = (track: number, semitones: number, laneIdx: number) => {
    const clamped = Math.max(-24, Math.min(24, semitones));
    const newPitches = [...laneTrackPitches[laneIdx]];
    newPitches[track] = clamped;
    updateLane(setLaneTrackPitches, laneIdx, newPitches);
    engineRefs[laneIdx].current?.setTrackPitch(track, clamped);
  };

  const toggleHalfSpeed = (track: number, laneIdx: number) => {
    const newHalf = [...laneTrackHalfSpeed[laneIdx]];
    newHalf[track] = !newHalf[track];
    updateLane(setLaneTrackHalfSpeed, laneIdx, newHalf);
    engineRefs[laneIdx].current?.setTrackHalfSpeed(track, newHalf[track]);
  };

  // Advanced effect handlers
  const setAdvTrackProp = async (laneIdx: number, trackIdx: number, prop: Partial<AdvTrackState>) => {
    const newTracks = [...laneAdvTracks[laneIdx]].map((t, i) => i === trackIdx ? { ...t, ...prop } : t);
    updateLane(setLaneAdvTracks, laneIdx, newTracks);
    const updated = { ...laneAdvTracks[laneIdx][trackIdx], ...prop };
    const engine = engineRefs[laneIdx].current;
    if (!engine) return;

    if ('granular' in prop || 'grainSize' in prop || 'overlap' in prop) {
      await engine.setTrackGranular(trackIdx, updated.granular, updated.grainSize, updated.overlap);
    }
    if ('reverse' in prop) {
      await engine.setTrackReverse(trackIdx, updated.reverse);
    }
    if ('freeze' in prop || 'freezePos' in prop || 'freezeWindow' in prop) {
      await engine.setTrackFreeze(trackIdx, updated.freeze, updated.freezePos, updated.freezeWindow);
    }
    if ('detune' in prop) {
      // Detune in cents — convert to semitones offset on top of existing pitch
      const basePitch = laneTrackPitches[laneIdx][trackIdx];
      engine.setTrackPitch(trackIdx, basePitch + updated.detune / 100);
    }
    if ('filterType' in prop || 'filterFreq' in prop || 'filterQ' in prop) {
      await engine.setTrackFilter(trackIdx, updated.filterType === "off" ? "off" : updated.filterType, updated.filterFreq, updated.filterQ);
    }
    if ('stutter' in prop || 'stutterRate' in prop || 'stutterDepth' in prop) {
      await engine.setTrackStutter(trackIdx, updated.stutter, updated.stutterRate, updated.stutterDepth);
    }
    if ('timeStretch' in prop) {
      // Automatically enable granular mode if timeStretch != 1.0
      if (updated.timeStretch !== 1.0 && !updated.granular) {
        await engine.setTrackGranular(trackIdx, true, updated.grainSize, updated.overlap);
        const newTracks2 = [...laneAdvTracks[laneIdx]].map((t, i) => i === trackIdx ? { ...t, ...prop, granular: true } : t);
        updateLane(setLaneAdvTracks, laneIdx, newTracks2);
      }
      engine.setTrackTimeStretch(trackIdx, updated.timeStretch);
    }
  };

  // Apply advanced prop to ALL tracks in a lane
  const setAdvAllTracks = async (laneIdx: number, prop: Partial<AdvTrackState>) => {
    const newTracks = laneAdvTracks[laneIdx].map((t) => ({ ...t, ...prop }));
    updateLane(setLaneAdvTracks, laneIdx, newTracks);
    const engine = engineRefs[laneIdx].current;
    if (!engine) return;

    for (let i = 0; i < 16; i++) {
      const updated = { ...laneAdvTracks[laneIdx][i], ...prop };
      if ('granular' in prop || 'grainSize' in prop || 'overlap' in prop) {
        await engine.setTrackGranular(i, updated.granular, updated.grainSize, updated.overlap);
      }
      if ('reverse' in prop) {
        await engine.setTrackReverse(i, updated.reverse);
      }
      if ('freeze' in prop || 'freezePos' in prop || 'freezeWindow' in prop) {
        await engine.setTrackFreeze(i, updated.freeze, updated.freezePos, updated.freezeWindow);
      }
      if ('detune' in prop) {
        const basePitch = laneTrackPitches[laneIdx][i];
        engine.setTrackPitch(i, basePitch + updated.detune / 100);
      }
      if ('filterType' in prop || 'filterFreq' in prop || 'filterQ' in prop) {
        await engine.setTrackFilter(i, updated.filterType === "off" ? "off" : updated.filterType, updated.filterFreq, updated.filterQ);
      }
      if ('stutter' in prop || 'stutterRate' in prop || 'stutterDepth' in prop) {
        await engine.setTrackStutter(i, updated.stutter, updated.stutterRate, updated.stutterDepth);
      }
      if ('timeStretch' in prop) {
        if (updated.timeStretch !== 1.0 && !updated.granular) {
          await engine.setTrackGranular(i, true, updated.grainSize, updated.overlap);
        }
        engine.setTrackTimeStretch(i, updated.timeStretch);
      }
    }
    // If timeStretch changed, also update granular state for all tracks
    if ('timeStretch' in prop) {
      const ts = (prop as any).timeStretch;
      if (ts !== 1.0) {
        const updatedTracks = laneAdvTracks[laneIdx].map((t) => ({ ...t, ...prop, granular: true }));
        updateLane(setLaneAdvTracks, laneIdx, updatedTracks);
      }
    }
  };

  // Spread: copy a group of 8 steps to all other groups for all tracks in a lane
  const handleSpread = (laneIdx: number, groupIdx: number) => {
    const pattern = lanePatterns[laneIdx].map(row => [...row]);
    const srcStart = groupIdx * 8;
    for (let t = 0; t < 16; t++) {
      const srcSlice = pattern[t].slice(srcStart, srcStart + 8);
      for (let g = 0; g < 8; g++) {
        if (g === groupIdx) continue;
        const destStart = g * 8;
        for (let s = 0; s < 8; s++) {
          pattern[t][destStart + s] = srcSlice[s];
        }
      }
    }
    updateLane(setLanePatterns, laneIdx, pattern);
    engineRefs[laneIdx].current?.setPattern(pattern);
  };

  // Chorus: duplicate current track's chop to next 3 empty tracks with micro-detune
  const handleChorus = async (laneIdx: number, trackIdx: number) => {
    const chopIdx = laneTrackChops[laneIdx][trackIdx];
    if (chopIdx < 0) return;
    const detuneValues = [-15, 8, 20];
    let filled = 0;
    for (let i = 0; i < 16 && filled < 3; i++) {
      if (i === trackIdx) continue;
      if (laneTrackChops[laneIdx][i] >= 0) continue;
      // Assign chop
      await assignChop(i, chopIdx, laneIdx);
      // Copy pattern from source track
      const newPattern = lanePatterns[laneIdx].map(row => [...row]);
      for (let s = 0; s < 64; s++) {
        newPattern[i][s] = newPattern[trackIdx][s];
      }
      updateLane(setLanePatterns, laneIdx, newPattern);
      engineRefs[laneIdx].current?.setPattern(newPattern);
      // Apply detune
      await setAdvTrackProp(laneIdx, i, { detune: detuneValues[filled] });
      filled++;
    }
  };

  // Transport
  const handlePlay = async () => {
    const T = await import("tone");
    T.getTransport().bpm.value = bpm;

    if (playMode === "both" || playMode === 0) {
      if (engineRefs[0].current) {
        engineRefs[0].current.bpm = bpm;
        engineRefs[0].current.setPattern(lanePatterns[0]);
        await engineRefs[0].current.startSequence();
      }
    }
    if (playMode === "both" || playMode === 1) {
      if (engineRefs[1].current) {
        engineRefs[1].current.bpm = bpm;
        engineRefs[1].current.setPattern(lanePatterns[1]);
        await engineRefs[1].current.startSequence();
      }
    }

    T.getTransport().start();
    setIsPlaying(true);
    setLanePlaying([
      playMode === "both" || playMode === 0,
      playMode === "both" || playMode === 1,
    ]);
  };

  const handlePause = async () => {
    const T = await import("tone");
    engineRefs[0].current?.stopSequence();
    engineRefs[1].current?.stopSequence();
    T.getTransport().pause();
    setIsPlaying(false);
    setLanePlaying([false, false]);
  };

  const handleStop = async () => {
    const T = await import("tone");
    engineRefs[0].current?.stopSequence();
    engineRefs[1].current?.stopSequence();
    engineRefs[0].current?.stopSource();
    engineRefs[1].current?.stopSource();
    T.getTransport().stop();
    T.getTransport().position = 0;
    setIsPlaying(false);
    setLanePlaying([false, false]);
    setLanePlayingSources([false, false]);
    setCurrentStep(-1);
  };

  // Per-lane play/stop
  const handleLanePlay = async (laneIdx: number) => {
    const T = await import("tone");
    T.getTransport().bpm.value = bpm;
    const engine = engineRefs[laneIdx].current;
    if (!engine) return;
    engine.bpm = bpm;
    engine.setPattern(lanePatterns[laneIdx]);
    await engine.startSequence();
    // Ensure transport is running
    if (T.getTransport().state !== "started") {
      T.getTransport().start();
    }
    setIsPlaying(true);
    updateLane(setLanePlaying, laneIdx, true);
  };

  const handleLaneStop = async (laneIdx: number) => {
    const engine = engineRefs[laneIdx].current;
    if (engine) {
      engine.stopSequence();
      engine.stopSource();
    }
    updateLane(setLanePlaying, laneIdx, false);
    updateLane(setLanePlayingSources, laneIdx, false);
    // If neither lane is playing, stop transport
    const otherPlaying = lanePlaying[laneIdx === 0 ? 1 : 0];
    if (!otherPlaying) {
      const T = await import("tone");
      T.getTransport().stop();
      T.getTransport().position = 0;
      setIsPlaying(false);
      setCurrentStep(-1);
    }
  };

  // Divider drag handlers
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dividerDragging.current = true;
  }, []);

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!dividerDragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientY - rect.top) / rect.height) * 100;
      setLaneSplit(Math.max(15, Math.min(85, pct)));
    };
    const handleUp = () => { dividerDragging.current = false; };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, []);

  // BPM change
  const handleBpmChange = (newBpm: number) => {
    setBpm(newBpm);
    if (engineRefs[0].current) engineRefs[0].current.bpm = newBpm;
    if (engineRefs[1].current) engineRefs[1].current.bpm = newBpm;
  };

  // Generate
  const handleGenerate = async (laneIdx: number) => {
    if (laneChops[laneIdx].length === 0) return;
    if (engineRefs[laneIdx].current) {
      engineRefs[laneIdx].current!.stopAll();
      setIsPlaying(false);
      updateLane(setLanePlayingSources, laneIdx, false);
      setCurrentStep(-1);
    }
    const { pattern: newPattern, trackAssignments } = generatePattern(
      laneChops[laneIdx],
      laneSelectedTemplates[laneIdx],
      64
    );

    const mergedChops = [...laneTrackChops[laneIdx]];
    for (let i = 0; i < 16; i++) {
      if (trackAssignments[i] >= 0) {
        mergedChops[i] = trackAssignments[i];
      }
    }
    for (let i = 0; i < 16; i++) {
      for (let s = 0; s < 64; s++) {
        if (newPattern[i][s] >= 0) {
          newPattern[i][s] = mergedChops[i];
        }
      }
    }

    updateLane(setLanePatterns, laneIdx, newPattern);
    updateLane(setLaneTrackChops, laneIdx, mergedChops);
    engineRefs[laneIdx].current?.setPattern(newPattern);

    for (let i = 0; i < 16; i++) {
      if (mergedChops[i] >= 0) {
        await engineRefs[laneIdx].current?.setupTrack(i, mergedChops[i]);
        await engineRefs[laneIdx].current?.setTrackDelay(i, laneTrackEffects[laneIdx][i].delay);
        await engineRefs[laneIdx].current?.setTrackReverb(i, laneTrackEffects[laneIdx][i].reverb);
        engineRefs[laneIdx].current?.setTrackPitch(i, laneTrackPitches[laneIdx][i]);
        engineRefs[laneIdx].current?.setTrackHalfSpeed(i, laneTrackHalfSpeed[laneIdx][i]);
      }
    }
  };

  // Generate from text prompt
  const handlePromptGenerate = async (laneIdx: number) => {
    if (laneChops[laneIdx].length === 0 || !lanePromptTexts[laneIdx].trim()) return;
    if (engineRefs[laneIdx].current) {
      engineRefs[laneIdx].current!.stopAll();
      setIsPlaying(false);
      updateLane(setLanePlayingSources, laneIdx, false);
      setCurrentStep(-1);
    }
    const { pattern: newPattern, trackAssignments } = generateFromPrompt(
      laneChops[laneIdx],
      lanePromptTexts[laneIdx],
      64
    );

    const mergedChops = [...laneTrackChops[laneIdx]];
    for (let i = 0; i < 16; i++) {
      if (trackAssignments[i] >= 0) {
        mergedChops[i] = trackAssignments[i];
      }
    }
    for (let i = 0; i < 16; i++) {
      for (let s = 0; s < 64; s++) {
        if (newPattern[i][s] >= 0) {
          newPattern[i][s] = mergedChops[i];
        }
      }
    }

    updateLane(setLanePatterns, laneIdx, newPattern);
    updateLane(setLaneTrackChops, laneIdx, mergedChops);
    engineRefs[laneIdx].current?.setPattern(newPattern);
    for (let i = 0; i < 16; i++) {
      if (mergedChops[i] >= 0) {
        await engineRefs[laneIdx].current?.setupTrack(i, mergedChops[i]);
        await engineRefs[laneIdx].current?.setTrackDelay(i, laneTrackEffects[laneIdx][i].delay);
        await engineRefs[laneIdx].current?.setTrackReverb(i, laneTrackEffects[laneIdx][i].reverb);
        engineRefs[laneIdx].current?.setTrackPitch(i, laneTrackPitches[laneIdx][i]);
        engineRefs[laneIdx].current?.setTrackHalfSpeed(i, laneTrackHalfSpeed[laneIdx][i]);
      }
    }
  };

  // Clear pattern
  const handleClear = (laneIdx: number) => {
    const empty = emptyPattern();
    updateLane(setLanePatterns, laneIdx, empty);
    engineRefs[laneIdx].current?.setPattern(empty);
  };

  // Save
  const handleSave = async () => {
    if (!project) return;
    setSaving(true);
    const updated: ProjectData = {
      ...project,
      bpm,
      lanes: [
        buildLaneState(0),
        buildLaneState(1),
      ],
    };
    await saveProject(updated);
    setProject(updated);
    setTimeout(() => setSaving(false), 800);
  };

  // Re-chop helper
  const doRechop = async (mode: "transient" | "equal" | "fine", sens: "soft" | "medium" | "hard", laneIdx: number) => {
    if (!laneBuffers[laneIdx]) return;
    const audioBuffer = laneBuffers[laneIdx]!;

    let newChops;
    if (mode === "equal") {
      const sliceMap = { soft: 16, medium: 32, hard: 64 };
      newChops = chopEqual(audioBuffer, sliceMap[sens]);
    } else if (mode === "fine") {
      const threshMap = { soft: 0.5, medium: 0.3, hard: 0.15 };
      const maxMap = { soft: 64, medium: 128, hard: 256 };
      newChops = detectTransients(audioBuffer, {
        threshold: threshMap[sens],
        minInterval: 0.015,
        maxChops: maxMap[sens],
        minChops: 0,
      });
    } else {
      const thresholdMap = { soft: 2.0, medium: 1.2, hard: 0.5 };
      const minChopsMap = { soft: 8, medium: 16, hard: 32 };
      newChops = detectTransients(audioBuffer, {
        threshold: thresholdMap[sens],
        minChops: minChopsMap[sens],
      });
    }
    updateLane(setLaneChops, laneIdx, newChops);

    const newTrackChops = Array(16).fill(-1);
    for (let i = 0; i < 16; i++) {
      newTrackChops[i] = newChops.length > 0 ? i % newChops.length : -1;
    }
    updateLane(setLaneTrackChops, laneIdx, newTrackChops);

    const empty = emptyPattern();
    updateLane(setLanePatterns, laneIdx, empty);

    await initEngine(audioBuffer, newChops, laneIdx);
    for (let i = 0; i < 16; i++) {
      if (newTrackChops[i] >= 0) {
        await engineRefs[laneIdx].current?.setupTrack(i, newTrackChops[i]);
      }
    }
    engineRefs[laneIdx].current?.setPattern(empty);
  };

  const handleRechop = async (sens: "soft" | "medium" | "hard", laneIdx: number) => {
    updateLane(setLaneSensitivities, laneIdx, sens);
    await doRechop(laneChopModes[laneIdx], sens, laneIdx);
  };

  const handleChopModeChange = async (mode: "transient" | "equal" | "fine", laneIdx: number) => {
    updateLane(setLaneChopModes, laneIdx, mode);
    await doRechop(mode, laneSensitivities[laneIdx], laneIdx);
  };

  // Play original source
  const handlePlaySource = async (laneIdx: number) => {
    if (!engineRefs[laneIdx].current) return;
    if (lanePlayingSources[laneIdx] || engineRefs[laneIdx].current!.isSourcePlaying) {
      engineRefs[laneIdx].current!.stopSource();
      updateLane(setLanePlayingSources, laneIdx, false);
    } else {
      if (isPlaying) {
        await handleStop();
      }
      engineRefs[laneIdx].current!.onSourceStop(() => updateLane(setLanePlayingSources, laneIdx, false));
      await engineRefs[laneIdx].current!.playSource();
      updateLane(setLanePlayingSources, laneIdx, true);
    }
  };

  // Export WAV
  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExport = async (mode: "lanes" | "merged" | "magic") => {
    setExporting(true);
    setShowExportMenu(false);
    const name = project?.name || "export";
    try {
      if (mode === "lanes") {
        // Export each lane separately
        for (const idx of [0, 1]) {
          if (engineRefs[idx].current) {
            const blob = await engineRefs[idx].current!.exportWAV();
            downloadBlob(blob, `${name}-lane${idx + 1}.wav`);
          }
        }
      } else if (mode === "merged") {
        // Render both lanes and merge into one file
        const buffers: AudioBuffer[] = [];
        for (const idx of [0, 1]) {
          if (engineRefs[idx].current) {
            buffers.push(await engineRefs[idx].current!.renderToBuffer());
          }
        }
        if (buffers.length === 2) {
          const { AudioEngine } = await import("@/lib/audio/engine");
          const merged = AudioEngine.mergeBuffers(buffers[0], buffers[1]);
          downloadBlob(audioBufferToWavLocal(merged), `${name}-merged.wav`);
        } else if (buffers.length === 1) {
          downloadBlob(audioBufferToWavLocal(buffers[0]), `${name}-merged.wav`);
        }
      } else if (mode === "magic") {
        // Export magic soundscape for each lane that has one
        for (const idx of [0, 1]) {
          if (engineRefs[idx].current?.hasMagicBuffer) {
            const blob = await engineRefs[idx].current!.exportMagicWAV();
            downloadBlob(blob, `${name}-magic-lane${idx + 1}.wav`);
          }
        }
      }
    } catch (err) {
      console.error("Export error:", err);
    } finally {
      setExporting(false);
    }
  };

  // Sync master effects to both engines
  const syncMasterToBothEngines = (action: (engine: AudioEngine) => void) => {
    if (engineRefs[0].current) action(engineRefs[0].current);
    if (engineRefs[1].current) action(engineRefs[1].current);
  };

  if (!project) return null;

  const hasAnyAudio = laneBuffers[0] !== null || laneBuffers[1] !== null;
  const hasAnyChops = laneChops[0].length > 0 || laneChops[1].length > 0;

  // Render a lane section
  const renderLane = (laneIdx: number) => {
    const buffer = laneBuffers[laneIdx];
    const loading = laneLoadings[laneIdx];
    const chops = laneChops[laneIdx];
    const fileName = laneFileNames[laneIdx];
    const pattern = lanePatterns[laneIdx];
    const trackChops = laneTrackChops[laneIdx];
    const trackEffects = laneTrackEffects[laneIdx];
    const trackMutes = laneTrackMutes[laneIdx];
    const trackSolos = laneTrackSolos[laneIdx];
    const trackPitches = laneTrackPitches[laneIdx];
    const trackHalfSpd = laneTrackHalfSpeed[laneIdx];
    const chopMode = laneChopModes[laneIdx];
    const sensitivity = laneSensitivities[laneIdx];
    const selectedTemplate = laneSelectedTemplates[laneIdx];
    const promptText = lanePromptTexts[laneIdx];
    const playingSource = lanePlayingSources[laneIdx];
    const isDragging = laneDragging[laneIdx];

    const isLanePlaying = lanePlaying[laneIdx];

    return (
      <div className="min-h-0 flex flex-col overflow-hidden" style={{ height: `${laneIdx === 0 ? laneSplit : 100 - laneSplit}%` }}>
        {/* Lane header */}
        <div className="px-4 py-1 flex items-center gap-2 border-b border-border/50 bg-card/50 flex-shrink-0">
          {/* Per-lane play/stop */}
          {laneChops[laneIdx].length > 0 && (
            <div className="flex items-center gap-0.5">
              {!isLanePlaying ? (
                <button
                  onClick={() => handleLanePlay(laneIdx)}
                  className="p-1 rounded bg-primary/15 text-primary hover:bg-primary/25"
                  title={`Play Lane ${laneIdx + 1}`}
                >
                  <Play className="w-3 h-3" />
                </button>
              ) : (
                <button
                  onClick={() => handleLaneStop(laneIdx)}
                  className="p-1 rounded bg-primary/15 text-primary hover:bg-primary/25"
                  title={`Stop Lane ${laneIdx + 1}`}
                >
                  <Square className="w-3 h-3" />
                </button>
              )}
            </div>
          )}
          <span className="text-[10px] font-bold" style={{ fontFamily: "var(--font-mono)" }}>
            LANE {laneIdx + 1}
          </span>
          {buffer && !loading && (
            <>
              <span className="text-xs text-muted-foreground/50">|</span>
              <span className="text-xs text-muted-foreground">{fileName}</span>
              <span className="text-xs text-muted-foreground/50">|</span>
              <span className="text-xs text-primary" style={{ fontFamily: "var(--font-mono)" }}>
                {chops.length} chops
              </span>
              <span className="text-xs text-muted-foreground/50">|</span>
              {/* Chop mode toggle */}
              <div className="flex items-center gap-0.5">
                {(["transient", "equal", "fine"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => handleChopModeChange(m, laneIdx)}
                    className={`px-1.5 py-0.5 rounded text-[10px] ${
                      chopMode === m
                        ? "bg-primary/15 text-primary border border-primary/25"
                        : "text-muted-foreground hover:text-foreground border border-transparent"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <span className="text-xs text-muted-foreground/50">|</span>
              {/* Sensitivity */}
              <div className="flex items-center gap-0.5">
                {(["soft", "medium", "hard"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => handleRechop(s, laneIdx)}
                    className={`px-1.5 py-0.5 rounded text-[10px] ${
                      sensitivity === s
                        ? "bg-primary/15 text-primary border border-primary/25"
                        : "text-muted-foreground hover:text-foreground border border-transparent"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <span className="text-xs text-muted-foreground/50">|</span>
              <button
                onClick={() => handlePlaySource(laneIdx)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-xs border hover:bg-secondary ${
                  playingSource ? "border-primary text-primary" : "border-border"
                }`}
              >
                {playingSource ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                {playingSource ? "Stop" : "Preview"}
              </button>
              <label className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-xs border border-border hover:bg-secondary cursor-pointer">
                <Upload className="w-3 h-3" />
                Replace
                <input
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFile(file, laneIdx);
                  }}
                />
              </label>
              <span className="text-xs text-muted-foreground/50">|</span>
              {/* Generate controls */}
              <select
                value={selectedTemplate}
                onChange={(e) => updateLane(setLaneSelectedTemplates, laneIdx, e.target.value as PatternTemplate)}
                className="px-2 py-0.5 rounded bg-secondary border border-border text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {PATTERN_TEMPLATES.map((t) => (
                  <option key={t} value={t}>
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </select>
              <button
                onClick={() => handleGenerate(laneIdx)}
                disabled={chops.length === 0}
                className="flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-primary/10 border border-primary/20 text-primary text-xs hover:bg-primary/20 disabled:opacity-40"
              >
                <Shuffle className="w-3 h-3" />
                Generate
              </button>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handlePromptGenerate(laneIdx);
                }}
                className="flex items-center gap-1"
              >
                <input
                  type="text"
                  value={promptText}
                  onChange={(e) => updateLane(setLanePromptTexts, laneIdx, e.target.value)}
                  placeholder="слыш"
                  className="w-36 px-2 py-0.5 rounded bg-secondary border border-border text-xs placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <button
                  type="submit"
                  disabled={chops.length === 0 || !promptText.trim()}
                  className="px-2 py-0.5 rounded-md bg-primary/10 border border-primary/20 text-primary text-xs hover:bg-primary/20 disabled:opacity-40"
                >
                  Go
                </button>
              </form>
              <button
                onClick={() => handleClear(laneIdx)}
                className="flex items-center gap-1 px-2.5 py-0.5 rounded-md border border-border text-xs hover:bg-secondary text-muted-foreground"
              >
                <Trash2 className="w-3 h-3" />
                Clear
              </button>
            </>
          )}
        </div>

        {/* Upload zone if no audio */}
        {!buffer && !loading && (
          <div className="flex-1 flex items-center justify-center p-4">
            <div
              className={`drop-zone w-full max-w-lg border-2 border-dashed rounded-xl p-8 text-center transition-all ${
                isDragging
                  ? "dragging border-primary bg-primary/5"
                  : "border-border hover:border-muted-foreground/30"
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                updateLane(setLaneDragging, laneIdx, true);
              }}
              onDragLeave={() => updateLane(setLaneDragging, laneIdx, false)}
              onDrop={(e) => handleDrop(e, laneIdx)}
            >
              <Upload className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground mb-1">
                Drag & drop an audio file here
              </p>
              <p className="text-xs text-muted-foreground/60 mb-3">
                WAV, MP3, OGG, FLAC
              </p>
              <label className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-secondary border border-border text-sm cursor-pointer hover:bg-secondary/80">
                <Upload className="w-3.5 h-3.5" />
                Browse files
                <input
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFile(file, laneIdx);
                  }}
                />
              </label>
            </div>
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">Detecting transients...</p>
            </div>
          </div>
        )}

        {/* Editor content */}
        {buffer && !loading && (
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            {/* Waveform */}
            <div className="px-4 py-1 flex-shrink-0">
              <canvas
                ref={canvasRefs[laneIdx]}
                className="w-full h-12 rounded bg-secondary/50"
              />
            </div>

            {/* Piano Roll + Track Controls */}
            <div className="flex-1 overflow-auto min-h-0">
              <div className="flex min-w-fit">
                {/* Track controls column */}
                <div className="w-72 flex-shrink-0 border-r border-border/50">
                  {/* Spacer for spread buttons row */}
                  <div className="h-5 border-b border-border/20" />
                  {/* Header */}
                  <div className="h-7 border-b border-border/30 px-2 flex items-center">
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                      Tracks
                    </span>
                  </div>
                  {/* Track rows */}
                  {Array.from({ length: 16 }, (_, t) => (
                    <div
                      key={t}
                      className="h-8 border-b border-border/20 px-2 flex items-center gap-1.5"
                    >
                      {/* Color dot */}
                      <div
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{
                          backgroundColor:
                            trackChops[t] >= 0 ? TRACK_COLORS[t] : "hsl(var(--muted))",
                        }}
                      />
                      {/* Chop selector */}
                      <select
                        value={trackChops[t]}
                        onChange={(e) => assignChop(t, Number(e.target.value), laneIdx)}
                        className="w-[60px] px-1 py-0.5 rounded bg-transparent border border-transparent hover:border-border text-[10px] focus:outline-none focus:ring-1 focus:ring-ring truncate"
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        <option value={-1}>---</option>
                        {chops.map((c) => (
                          <option key={c.index} value={c.index}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                      {/* Delay toggle + dropdown */}
                      <div className="flex items-center gap-0">
                        <button
                          onClick={() => setDelay(t, trackEffects[t].delay === "none" ? "eighth" : "none", laneIdx)}
                          title="Toggle delay"
                          className={`px-1 py-0.5 rounded-l text-[9px] font-bold border ${
                            trackEffects[t].delay !== "none"
                              ? "bg-blue-500/20 text-blue-400 border-blue-500/30"
                              : "text-muted-foreground hover:text-foreground border-transparent hover:border-border"
                          }`}
                          style={{ fontFamily: "var(--font-mono)" }}
                        >
                          D
                        </button>
                        {trackEffects[t].delay !== "none" && (
                          <select
                            value={trackEffects[t].delay}
                            onChange={(e) => setDelay(t, e.target.value as DelayPreset, laneIdx)}
                            className="w-[44px] px-0 py-0.5 rounded-r bg-blue-500/10 border border-l-0 border-blue-500/20 text-[9px] text-blue-400 focus:outline-none truncate"
                          >
                            {Object.entries(DELAY_PRESETS)
                              .filter(([key]) => key !== "none")
                              .map(([key, val]) => (
                                <option key={key} value={key}>
                                  {key === "slap" ? "Slap" : key === "eighth" ? "8th" : key === "quarter" ? "1/4" : "Dot"}
                                </option>
                              ))}
                          </select>
                        )}
                      </div>
                      {/* Reverb toggle + dropdown */}
                      <div className="flex items-center gap-0">
                        <button
                          onClick={() => setReverb(t, trackEffects[t].reverb === "none" ? "room" : "none", laneIdx)}
                          title="Toggle reverb"
                          className={`px-1 py-0.5 rounded-l text-[9px] font-bold border ${
                            trackEffects[t].reverb !== "none"
                              ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                              : "text-muted-foreground hover:text-foreground border-transparent hover:border-border"
                          }`}
                          style={{ fontFamily: "var(--font-mono)" }}
                        >
                          R
                        </button>
                        {trackEffects[t].reverb !== "none" && (
                          <select
                            value={trackEffects[t].reverb}
                            onChange={(e) => setReverb(t, e.target.value as ReverbPreset, laneIdx)}
                            className="w-[44px] px-0 py-0.5 rounded-r bg-emerald-500/10 border border-l-0 border-emerald-500/20 text-[9px] text-emerald-400 focus:outline-none truncate"
                          >
                            {Object.entries(REVERB_PRESETS)
                              .filter(([key]) => key !== "none")
                              .map(([key]) => (
                                <option key={key} value={key}>
                                  {key === "room" ? "Room" : key === "hall" ? "Hall" : key === "cathedral" ? "Cath" : "Inf"}
                                </option>
                              ))}
                          </select>
                        )}
                      </div>
                      {/* Pitch (semitones) */}
                      <input
                        type="number"
                        value={trackPitches[t]}
                        onChange={(e) => setPitch(t, Number(e.target.value), laneIdx)}
                        title="Pitch (semitones)"
                        className="w-[32px] px-0.5 py-0.5 rounded bg-transparent border border-transparent hover:border-border text-[10px] text-center focus:outline-none focus:ring-1 focus:ring-ring"
                        style={{ fontFamily: "var(--font-mono)" }}
                      />
                      {/* Half speed */}
                      <button
                        onClick={() => toggleHalfSpeed(t, laneIdx)}
                        title="Half speed"
                        className={`px-1 py-0.5 rounded text-[9px] font-medium ${
                          trackHalfSpd[t]
                            ? "bg-primary/20 text-primary border border-primary/30"
                            : "text-muted-foreground hover:text-foreground border border-transparent hover:border-border"
                        }`}
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        ½
                      </button>
                      {/* Mute */}
                      <button
                        onClick={() => toggleMute(t, laneIdx)}
                        title="Mute"
                        className={`w-5 h-5 rounded text-[9px] font-bold flex items-center justify-center ${
                          trackMutes[t]
                            ? "bg-destructive/20 text-destructive border border-destructive/30"
                            : "text-muted-foreground hover:text-foreground border border-transparent hover:border-border"
                        }`}
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        M
                      </button>
                      {/* Solo */}
                      <button
                        onClick={() => toggleSolo(t, laneIdx)}
                        title="Solo"
                        className={`w-5 h-5 rounded text-[9px] font-bold flex items-center justify-center ${
                          trackSolos[t]
                            ? "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30"
                            : "text-muted-foreground hover:text-foreground border border-transparent hover:border-border"
                        }`}
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        S
                      </button>
                    </div>
                  ))}
                </div>

                {/* Grid area */}
                <div className="flex-1 overflow-x-auto">
                  {/* Spread buttons row */}
                  <div className="h-5 border-b border-border/20 flex">
                    {Array.from({ length: 8 }, (_, g) => (
                      <button
                        key={g}
                        onClick={() => handleSpread(laneIdx, g)}
                        className="flex-shrink-0 flex items-center justify-center gap-0.5 text-[8px] text-muted-foreground/60 hover:text-primary hover:bg-primary/10 transition-colors border-r border-border/20"
                        style={{ width: "256px", fontFamily: "var(--font-mono)" }}
                        title={`Copy group ${g + 1} to all other groups`}
                      >
                        <CopyCheck className="w-2.5 h-2.5" />
                        {g + 1}
                      </button>
                    ))}
                  </div>
                  {/* Step numbers header */}
                  <div className="h-7 border-b border-border/30 flex">
                    {Array.from({ length: 64 }, (_, s) => (
                      <div
                        key={s}
                        className={`w-8 flex-shrink-0 flex items-center justify-center text-[9px] tabular-nums ${
                          s % 8 === 0
                            ? "text-muted-foreground font-medium"
                            : "text-muted-foreground/40"
                        } ${
                          currentStep === s
                            ? "text-primary font-bold"
                            : ""
                        }`}
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {s + 1}
                      </div>
                    ))}
                  </div>

                  {/* Grid rows */}
                  {Array.from({ length: 16 }, (_, t) => (
                    <div key={t} className="h-8 border-b border-border/20 flex">
                      {Array.from({ length: 64 }, (_, s) => {
                        const isActive = pattern[t][s] >= 0;
                        const isCurrentStep = currentStep === s;
                        const isBeat = s % 8 === 0;
                        const isHalfBeat = s % 4 === 0;

                        return (
                          <div
                            key={s}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              handleCellMouseDown(t, s, laneIdx);
                            }}
                            onMouseEnter={() => handleCellMouseEnter(t, s, laneIdx)}
                            className={`w-8 h-full flex-shrink-0 border-r grid-cell cursor-pointer select-none ${
                              isBeat
                                ? "border-r-border/40"
                                : isHalfBeat
                                ? "border-r-border/25"
                                : "border-r-border/10"
                            } ${isActive ? "active" : ""} ${
                              isCurrentStep && !isActive ? "playing" : ""
                            }`}
                            style={
                              isActive
                                ? {
                                    backgroundColor: `${TRACK_COLORS[t]}33`,
                                    boxShadow: `inset 0 0 8px ${TRACK_COLORS[t]}22`,
                                  }
                                : undefined
                            }
                          >
                            {isActive && (
                              <div className="w-full h-full flex items-center justify-center">
                                <div
                                  className="w-3 h-3 rounded-sm"
                                  style={{
                                    backgroundColor: TRACK_COLORS[t],
                                    opacity: 0.8,
                                  }}
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Top bar */}
      <header className="border-b border-border/50 px-4 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/")}
            className="p-1.5 rounded-md hover:bg-secondary transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-2">
            <AudioWaveform className="w-4 h-4 text-primary" />
            <span
              className="text-sm font-medium"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {project.name}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={toggleTheme}
            className="p-1.5 rounded-md border border-border hover:bg-secondary transition-colors"
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={handleSave}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs hover:bg-secondary transition-colors"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? "Saved" : "Save"}
          </button>
          <div className="relative">
            <button
              onClick={() => setShowExportMenu(!showExportMenu)}
              disabled={exporting || !hasAnyChops}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs hover:bg-secondary transition-colors disabled:opacity-40"
            >
              <Download className="w-3.5 h-3.5" />
              {exporting ? "Exporting..." : "Export"}
            </button>
            {showExportMenu && (
              <>
              <div className="fixed inset-0 z-10" onClick={() => setShowExportMenu(false)} />
              <div className="absolute right-0 top-9 z-20 w-48 py-1 bg-card border border-border rounded-lg shadow-xl">
                <button
                  onClick={() => handleExport("lanes")}
                  className="w-full px-3 py-1.5 text-left text-xs hover:bg-secondary flex flex-col"
                >
                  <span className="font-medium">Lanes (separate)</span>
                  <span className="text-[10px] text-muted-foreground">Each lane as its own WAV</span>
                </button>
                <button
                  onClick={() => handleExport("merged")}
                  className="w-full px-3 py-1.5 text-left text-xs hover:bg-secondary flex flex-col"
                >
                  <span className="font-medium">Merged</span>
                  <span className="text-[10px] text-muted-foreground">Both lanes mixed into one WAV</span>
                </button>
                {project.mode === "advanced" && (magicReady[0] || magicReady[1]) && (
                  <button
                    onClick={() => handleExport("magic")}
                    className="w-full px-3 py-1.5 text-left text-xs hover:bg-secondary flex flex-col"
                  >
                    <span className="font-medium" style={{ background: "linear-gradient(90deg, #a855f7, #ec4899)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Magic Soundscape</span>
                    <span className="text-[10px] text-muted-foreground">Paulstretch-processed WAV</span>
                  </button>
                )}
              </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Shared toolbar: Transport, play mode, BPM, step indicator, master channel */}
      <div className="border-b border-border/50 px-4 py-2.5 flex items-center gap-4 flex-shrink-0">
        {/* Transport */}
        <div className="flex items-center gap-1">
          {!isPlaying ? (
            <button
              onClick={handlePlay}
              disabled={!hasAnyChops}
              className="p-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              <Play className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={handlePause}
              className="p-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Pause className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={handleStop}
            className="p-2 rounded-md hover:bg-secondary"
          >
            <Square className="w-4 h-4" />
          </button>
        </div>

        {/* Play mode selector */}
        <div className="flex items-center gap-0.5 border border-border rounded-md">
          {([0, "both", 1] as const).map((mode) => (
            <button
              key={String(mode)}
              onClick={() => setPlayMode(mode)}
              className={`px-2 py-1 text-[10px] font-medium ${
                playMode === mode
                  ? "bg-primary/20 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {mode === "both" ? "1+2" : `L${(mode as number) + 1}`}
            </button>
          ))}
        </div>

        <div className="w-px h-6 bg-border" />

        {/* BPM */}
        <div className="flex items-center gap-1.5">
          <span
            className="text-xs text-muted-foreground"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            BPM
          </span>
          {[40, 60, 80, 100, 120].map((v) => (
            <button
              key={v}
              onClick={() => handleBpmChange(v)}
              className={`px-1.5 py-0.5 rounded text-[10px] ${
                bpm === v
                  ? "bg-primary/15 text-primary border border-primary/25"
                  : "text-muted-foreground hover:text-foreground border border-transparent hover:border-border"
              }`}
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {v}
            </button>
          ))}
          <input
            type="number"
            min={20}
            max={300}
            value={bpm}
            onChange={(e) => handleBpmChange(Number(e.target.value))}
            className="w-14 px-1.5 py-0.5 rounded bg-secondary border border-border text-xs text-center focus:outline-none focus:ring-1 focus:ring-ring"
            style={{ fontFamily: "var(--font-mono)" }}
          />
        </div>

        <div className="w-px h-6 bg-border" />

        {/* Master channel */}
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full flex-shrink-0 bg-primary" />
          <span
            className="text-[10px] font-bold text-primary"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            MASTER
          </span>
          {/* Master Delay toggle + dropdown */}
          <div className="flex items-center gap-0">
            <button
              onClick={() => {
                const v = masterDelay === "none" ? "eighth" : "none";
                setMasterDelay(v);
                syncMasterToBothEngines((e) => e.setMasterDelay(v));
              }}
              title="Toggle master delay"
              className={`px-1 py-0.5 rounded-l text-[9px] font-bold border ${
                masterDelay !== "none"
                  ? "bg-blue-500/20 text-blue-400 border-blue-500/30"
                  : "text-muted-foreground hover:text-foreground border-transparent hover:border-border"
              }`}
              style={{ fontFamily: "var(--font-mono)" }}
            >
              D
            </button>
            {masterDelay !== "none" && (
              <select
                value={masterDelay}
                onChange={(e) => {
                  const v = e.target.value as DelayPreset;
                  setMasterDelay(v);
                  syncMasterToBothEngines((eng) => eng.setMasterDelay(v));
                }}
                className="w-[44px] px-0 py-0.5 rounded-r bg-blue-500/10 border border-l-0 border-blue-500/20 text-[9px] text-blue-400 focus:outline-none truncate"
              >
                {Object.entries(DELAY_PRESETS)
                  .filter(([key]) => key !== "none")
                  .map(([key]) => (
                    <option key={key} value={key}>
                      {key === "slap" ? "Slap" : key === "eighth" ? "8th" : key === "quarter" ? "1/4" : "Dot"}
                    </option>
                  ))}
              </select>
            )}
          </div>
          {/* Master Reverb toggle + dropdown */}
          <div className="flex items-center gap-0">
            <button
              onClick={() => {
                const v = masterReverb === "none" ? "hall" : "none";
                setMasterReverb(v);
                syncMasterToBothEngines((e) => e.setMasterReverb(v));
              }}
              title="Toggle master reverb"
              className={`px-1 py-0.5 rounded-l text-[9px] font-bold border ${
                masterReverb !== "none"
                  ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                  : "text-muted-foreground hover:text-foreground border-transparent hover:border-border"
              }`}
              style={{ fontFamily: "var(--font-mono)" }}
            >
              R
            </button>
            {masterReverb !== "none" && (
              <select
                value={masterReverb}
                onChange={(e) => {
                  const v = e.target.value as ReverbPreset;
                  setMasterReverb(v);
                  syncMasterToBothEngines((eng) => eng.setMasterReverb(v));
                }}
                className="w-[44px] px-0 py-0.5 rounded-r bg-emerald-500/10 border border-l-0 border-emerald-500/20 text-[9px] text-emerald-400 focus:outline-none truncate"
              >
                {Object.entries(REVERB_PRESETS)
                  .filter(([key]) => key !== "none")
                  .map(([key]) => (
                    <option key={key} value={key}>
                      {key === "room" ? "Room" : key === "hall" ? "Hall" : key === "cathedral" ? "Cath" : "Inf"}
                    </option>
                  ))}
              </select>
            )}
          </div>
          {/* Bitcrusher toggle + bits */}
          <div className="flex items-center gap-0">
            <button
              onClick={() => {
                const on = !masterCrusherOn;
                setMasterCrusherOn(on);
                syncMasterToBothEngines((e) => e.setMasterCrusher(on ? masterCrusherBits : 16, on ? 1 : 0));
              }}
              title="Toggle bitcrusher"
              className={`px-1 py-0.5 rounded-l text-[9px] font-bold border ${
                masterCrusherOn
                  ? "bg-rose-500/20 text-rose-400 border-rose-500/30"
                  : "text-muted-foreground hover:text-foreground border-transparent hover:border-border"
              }`}
              style={{ fontFamily: "var(--font-mono)" }}
            >
              B
            </button>
            {masterCrusherOn && (
              <select
                value={masterCrusherBits}
                onChange={(e) => {
                  const b = Number(e.target.value);
                  setMasterCrusherBits(b);
                  syncMasterToBothEngines((eng) => eng.setMasterCrusher(b, 1));
                }}
                className="w-[38px] px-0 py-0.5 rounded-r bg-rose-500/10 border border-l-0 border-rose-500/20 text-[9px] text-rose-400 focus:outline-none"
              >
                {[1, 2, 3, 4, 5, 6, 8, 10, 12].map((b) => (
                  <option key={b} value={b}>{b}bit</option>
                ))}
              </select>
            )}
          </div>
          {/* Master Pitch */}
          <input
            type="number"
            value={masterPitch}
            onChange={(e) => {
              const v = Number(e.target.value);
              setMasterPitchState(v);
              syncMasterToBothEngines((eng) => eng.setMasterPitch(v));
            }}
            title="Master pitch (semitones)"
            className="w-[32px] px-0.5 py-0.5 rounded bg-transparent border border-transparent hover:border-border text-[10px] text-center focus:outline-none focus:ring-1 focus:ring-ring"
            style={{ fontFamily: "var(--font-mono)" }}
          />
        </div>

        {/* Step indicator */}
        <div className="ml-auto">
          <span
            className="text-xs text-muted-foreground tabular-nums"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            Step{" "}
            <span className="text-foreground">
              {currentStep >= 0 ? currentStep + 1 : "-"}
            </span>
            /64
          </span>
        </div>
      </div>

      {/* Main content area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Lanes area */}
        <div ref={containerRef} className="flex-1 flex flex-col overflow-hidden relative">
          {renderLane(0)}
          {/* Draggable divider */}
          <div
            onMouseDown={handleDividerMouseDown}
            className="h-1.5 flex-shrink-0 cursor-row-resize bg-border/50 hover:bg-primary/30 active:bg-primary/50 transition-colors relative group"
          >
            <div className="absolute inset-x-0 -top-1 -bottom-1" />
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-0.5 rounded-full bg-muted-foreground/30 group-hover:bg-primary/50" />
          </div>
          {renderLane(1)}
        </div>

        {/* Advanced panel (right sidebar) */}
        {project.mode === "advanced" && (
          <div className="w-64 flex-shrink-0 border-l border-border overflow-y-auto bg-card/30">
            <div className="p-3 border-b border-border/50">
              <span className="text-[10px] font-bold text-primary uppercase tracking-wider" style={{ fontFamily: "var(--font-mono)" }}>
                Advanced
              </span>
            </div>

            {/* MAGIC soundscape section — per lane */}
            {[0, 1].map((laneIdx) => {
              const hasPattern = laneChops[laneIdx].length > 0 && lanePatterns[laneIdx].some(row => row.some(v => v >= 0));
              const generating = magicGenerating[laneIdx];
              const ready = magicReady[laneIdx];
              const playing = magicPlaying[laneIdx];

              return (
                <div key={`magic-${laneIdx}`} className="border-b border-border/30">
                  <div className="px-3 py-2">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-bold" style={{ fontFamily: "var(--font-mono)", background: "linear-gradient(90deg, #a855f7, #ec4899)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                        MAGIC
                      </span>
                      <span className="text-[10px] text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                        L{laneIdx + 1}
                      </span>
                    </div>
                    <p className="text-[8px] text-muted-foreground/50 mb-2">
                      Renders piano roll → Paulstretch → soundscape
                    </p>

                    {!hasPattern ? (
                      <span className="text-[10px] text-muted-foreground/50">Create a pattern first</span>
                    ) : (
                      <div className="space-y-2">
                        {/* Stretch factor */}
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] text-muted-foreground w-12">stretch</span>
                          <input
                            type="range"
                            min={5}
                            max={50}
                            value={magicStretch}
                            onChange={(e) => setMagicStretch(Number(e.target.value))}
                            className="flex-1 h-1 accent-purple-400"
                          />
                          <span className="text-[9px] text-muted-foreground w-8 text-right" style={{ fontFamily: "var(--font-mono)" }}>
                            {magicStretch}x
                          </span>
                        </div>

                        {/* Reverb tail */}
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] text-muted-foreground w-12">reverb</span>
                          <input
                            type="range"
                            min={3}
                            max={15}
                            value={magicReverb}
                            onChange={(e) => setMagicReverb(Number(e.target.value))}
                            className="flex-1 h-1 accent-purple-400"
                          />
                          <span className="text-[9px] text-muted-foreground w-8 text-right" style={{ fontFamily: "var(--font-mono)" }}>
                            {magicReverb}s
                          </span>
                        </div>

                        {/* Layers toggle */}
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setMagicLayers(!magicLayers)}
                            className={`text-[9px] px-1.5 py-0.5 rounded border ${
                              magicLayers
                                ? "bg-purple-500/20 text-purple-400 border-purple-500/30"
                                : "text-muted-foreground border-transparent hover:border-border"
                            }`}
                            style={{ fontFamily: "var(--font-mono)" }}
                          >
                            octave layers
                          </button>
                        </div>

                        {/* Generate button */}
                        <button
                          onClick={async () => {
                            updateLane(setMagicGenerating, laneIdx, true);
                            try {
                              const engine = engineRefs[laneIdx].current;
                              if (engine) {
                                engine.setPattern(lanePatterns[laneIdx]);
                                await engine.generateMagic({
                                  stretchFactor: magicStretch,
                                  windowSize: 8192,
                                  layers: magicLayers,
                                  reverbTail: magicReverb,
                                });
                                updateLane(setMagicReady, laneIdx, true);
                              }
                            } catch (err) {
                              console.error("Magic generation error:", err);
                            } finally {
                              updateLane(setMagicGenerating, laneIdx, false);
                            }
                          }}
                          disabled={generating}
                          className="w-full py-1.5 rounded text-[10px] font-bold border transition-all disabled:opacity-40"
                          style={{
                            fontFamily: "var(--font-mono)",
                            background: generating ? undefined : "linear-gradient(135deg, rgba(168,85,247,0.15), rgba(236,72,153,0.15))",
                            borderColor: "rgba(168,85,247,0.3)",
                            color: generating ? undefined : "#c084fc",
                          }}
                        >
                          {generating ? "Generating..." : "Generate Soundscape"}
                        </button>

                        {/* Play/Stop */}
                        {ready && (
                          <div className="flex gap-1.5">
                            <button
                              onClick={async () => {
                                const engine = engineRefs[laneIdx].current;
                                if (!engine) return;
                                if (playing) {
                                  engine.stopMagic();
                                  updateLane(setMagicPlaying, laneIdx, false);
                                } else {
                                  await engine.playMagic();
                                  updateLane(setMagicPlaying, laneIdx, true);
                                }
                              }}
                              className={`flex-1 py-1 rounded text-[10px] font-bold border ${
                                playing
                                  ? "bg-pink-500/20 text-pink-400 border-pink-500/30"
                                  : "bg-purple-500/10 text-purple-400 border-purple-500/20 hover:bg-purple-500/20"
                              }`}
                              style={{ fontFamily: "var(--font-mono)" }}
                            >
                              {playing ? "Stop" : "Play Soundscape"}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Per-lane Voice FX sections */}
            {[0, 1].map((laneIdx) => {
              const advTracks = laneAdvTracks[laneIdx];
              const selTrack = selectedAdvTrack[laneIdx];
              const adv = advTracks[selTrack];
              const hasAudio = laneChops[laneIdx].length > 0;

              return (
                <div key={laneIdx} className="border-b border-border/30">
                  <div className="px-3 py-2 flex items-center justify-between">
                    <span className="text-[10px] font-bold text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                      LANE {laneIdx + 1}
                    </span>
                    {hasAudio && (
                      <select
                        value={selTrack}
                        onChange={(e) => updateLane(setSelectedAdvTrack, laneIdx, Number(e.target.value))}
                        className="w-20 px-1 py-0.5 rounded bg-secondary border border-border text-[10px] focus:outline-none"
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {Array.from({ length: 16 }, (_, i) => (
                          <option key={i} value={i}>Track {i + 1}</option>
                        ))}
                      </select>
                    )}
                  </div>

                  {!hasAudio ? (
                    <div className="px-3 pb-3">
                      <span className="text-[10px] text-muted-foreground/50">No audio loaded</span>
                    </div>
                  ) : (
                    <div className="px-3 pb-3 space-y-2.5">
                      {/* Granular */}
                      <div>
                        <div className="flex items-center gap-1.5 mb-1">
                          <button
                            onClick={() => setAdvTrackProp(laneIdx, selTrack, { granular: !adv.granular })}
                            className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                              adv.granular
                                ? "bg-violet-500/20 text-violet-400 border-violet-500/30"
                                : "text-muted-foreground border-transparent hover:border-border"
                            }`}
                            style={{ fontFamily: "var(--font-mono)" }}
                          >
                            GRANULAR
                          </button>
                          <button
                            onClick={() => setAdvAllTracks(laneIdx, { granular: !adv.granular, grainSize: adv.grainSize, overlap: adv.overlap })}
                            className="text-[8px] px-1 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                            style={{ fontFamily: "var(--font-mono)" }}
                            title="Apply to all tracks"
                          >
                            ALL
                          </button>
                        </div>
                        {adv.granular && (
                          <div className="space-y-1.5 pl-1">
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] text-muted-foreground w-10">grain</span>
                              <input
                                type="range"
                                min={10}
                                max={200}
                                value={adv.grainSize * 1000}
                                onChange={(e) => setAdvTrackProp(laneIdx, selTrack, { grainSize: Number(e.target.value) / 1000 })}
                                className="flex-1 h-1 accent-violet-400"
                              />
                              <span className="text-[9px] text-muted-foreground w-8 text-right" style={{ fontFamily: "var(--font-mono)" }}>
                                {Math.round(adv.grainSize * 1000)}ms
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] text-muted-foreground w-10">overlap</span>
                              <input
                                type="range"
                                min={0}
                                max={100}
                                value={adv.overlap * 100}
                                onChange={(e) => setAdvTrackProp(laneIdx, selTrack, { overlap: Number(e.target.value) / 100 })}
                                className="flex-1 h-1 accent-violet-400"
                              />
                              <span className="text-[9px] text-muted-foreground w-8 text-right" style={{ fontFamily: "var(--font-mono)" }}>
                                {Math.round(adv.overlap * 100)}%
                              </span>
                            </div>
                            <button
                              onClick={() => setAdvAllTracks(laneIdx, { grainSize: adv.grainSize, overlap: adv.overlap })}
                              className="text-[8px] px-1.5 py-0.5 rounded border border-violet-500/20 text-violet-400/60 hover:text-violet-400 hover:border-violet-500/40"
                              style={{ fontFamily: "var(--font-mono)" }}
                            >
                              apply values to all
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Reverse */}
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => setAdvTrackProp(laneIdx, selTrack, { reverse: !adv.reverse })}
                          className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                            adv.reverse
                              ? "bg-cyan-500/20 text-cyan-400 border-cyan-500/30"
                              : "text-muted-foreground border-transparent hover:border-border"
                          }`}
                          style={{ fontFamily: "var(--font-mono)" }}
                        >
                          REVERSE
                        </button>
                        <button
                          onClick={() => setAdvAllTracks(laneIdx, { reverse: !adv.reverse })}
                          className="text-[8px] px-1 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                          style={{ fontFamily: "var(--font-mono)" }}
                          title="Apply to all tracks"
                        >
                          ALL
                        </button>
                      </div>

                      {/* Freeze */}
                      <div>
                        <div className="flex items-center gap-1.5 mb-1">
                          <button
                            onClick={() => setAdvTrackProp(laneIdx, selTrack, { freeze: !adv.freeze })}
                            className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                              adv.freeze
                                ? "bg-amber-500/20 text-amber-400 border-amber-500/30"
                                : "text-muted-foreground border-transparent hover:border-border"
                            }`}
                            style={{ fontFamily: "var(--font-mono)" }}
                          >
                            FREEZE
                          </button>
                          <button
                            onClick={() => setAdvAllTracks(laneIdx, { freeze: !adv.freeze, freezePos: adv.freezePos, freezeWindow: adv.freezeWindow })}
                            className="text-[8px] px-1 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                            style={{ fontFamily: "var(--font-mono)" }}
                            title="Apply to all tracks"
                          >
                            ALL
                          </button>
                        </div>
                        {adv.freeze && (
                          <div className="space-y-1.5 pl-1">
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] text-muted-foreground w-10">pos</span>
                              <input
                                type="range"
                                min={0}
                                max={100}
                                value={adv.freezePos * 100}
                                onChange={(e) => setAdvTrackProp(laneIdx, selTrack, { freezePos: Number(e.target.value) / 100 })}
                                className="flex-1 h-1 accent-amber-400"
                              />
                              <span className="text-[9px] text-muted-foreground w-8 text-right" style={{ fontFamily: "var(--font-mono)" }}>
                                {Math.round(adv.freezePos * 100)}%
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] text-muted-foreground w-10">win</span>
                              <input
                                type="range"
                                min={10}
                                max={500}
                                value={adv.freezeWindow}
                                onChange={(e) => setAdvTrackProp(laneIdx, selTrack, { freezeWindow: Number(e.target.value) })}
                                className="flex-1 h-1 accent-amber-400"
                              />
                              <span className="text-[9px] text-muted-foreground w-8 text-right" style={{ fontFamily: "var(--font-mono)" }}>
                                {adv.freezeWindow}ms
                              </span>
                            </div>
                            <button
                              onClick={() => setAdvAllTracks(laneIdx, { freezePos: adv.freezePos, freezeWindow: adv.freezeWindow })}
                              className="text-[8px] px-1.5 py-0.5 rounded border border-amber-500/20 text-amber-400/60 hover:text-amber-400 hover:border-amber-500/40"
                              style={{ fontFamily: "var(--font-mono)" }}
                            >
                              apply values to all
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Detune */}
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-bold text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                            DETUNE
                          </span>
                          <input
                            type="range"
                            min={-50}
                            max={50}
                            value={adv.detune}
                            onChange={(e) => setAdvTrackProp(laneIdx, selTrack, { detune: Number(e.target.value) })}
                            className="flex-1 h-1 accent-primary"
                          />
                          <span className="text-[9px] text-muted-foreground w-10 text-right" style={{ fontFamily: "var(--font-mono)" }}>
                            {adv.detune > 0 ? "+" : ""}{adv.detune}ct
                          </span>
                        </div>
                        <button
                          onClick={() => setAdvAllTracks(laneIdx, { detune: adv.detune })}
                          className="text-[8px] px-1.5 py-0.5 rounded border border-border text-muted-foreground/60 hover:text-foreground hover:border-foreground/30"
                          style={{ fontFamily: "var(--font-mono)" }}
                        >
                          apply to all
                        </button>
                      </div>

                      {/* Filter */}
                      <div>
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="text-[10px] font-bold text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                            FILTER
                          </span>
                          {(["lowpass", "highpass", "bandpass"] as const).map((ft) => (
                            <button
                              key={ft}
                              onClick={() => setAdvTrackProp(laneIdx, selTrack, { filterType: adv.filterType === ft ? "off" : ft })}
                              className={`text-[9px] font-bold px-1 py-0.5 rounded border ${
                                adv.filterType === ft
                                  ? "bg-sky-500/20 text-sky-400 border-sky-500/30"
                                  : "text-muted-foreground border-transparent hover:border-border"
                              }`}
                              style={{ fontFamily: "var(--font-mono)" }}
                            >
                              {ft === "lowpass" ? "LP" : ft === "highpass" ? "HP" : "BP"}
                            </button>
                          ))}
                          <button
                            onClick={() => setAdvAllTracks(laneIdx, { filterType: adv.filterType, filterFreq: adv.filterFreq, filterQ: adv.filterQ })}
                            className="text-[8px] px-1 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                            style={{ fontFamily: "var(--font-mono)" }}
                            title="Apply to all tracks"
                          >
                            ALL
                          </button>
                        </div>
                        {adv.filterType !== "off" && (
                          <div className="space-y-1.5 pl-1">
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] text-muted-foreground w-10">cutoff</span>
                              <input
                                type="range"
                                min={0}
                                max={100}
                                value={Math.round(Math.log(adv.filterFreq / 20) / Math.log(1000) * 100)}
                                onChange={(e) => {
                                  const freq = Math.round(20 * Math.pow(1000, Number(e.target.value) / 100));
                                  setAdvTrackProp(laneIdx, selTrack, { filterFreq: freq });
                                }}
                                className="flex-1 h-1 accent-sky-400"
                              />
                              <span className="text-[9px] text-muted-foreground w-12 text-right" style={{ fontFamily: "var(--font-mono)" }}>
                                {adv.filterFreq >= 1000 ? `${(adv.filterFreq / 1000).toFixed(1)}k` : `${adv.filterFreq}`}Hz
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] text-muted-foreground w-10">Q</span>
                              <input
                                type="range"
                                min={1}
                                max={200}
                                value={Math.round(adv.filterQ * 10)}
                                onChange={(e) => setAdvTrackProp(laneIdx, selTrack, { filterQ: Number(e.target.value) / 10 })}
                                className="flex-1 h-1 accent-sky-400"
                              />
                              <span className="text-[9px] text-muted-foreground w-8 text-right" style={{ fontFamily: "var(--font-mono)" }}>
                                {adv.filterQ.toFixed(1)}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Stutter */}
                      <div>
                        <div className="flex items-center gap-1.5 mb-1">
                          <button
                            onClick={() => setAdvTrackProp(laneIdx, selTrack, { stutter: !adv.stutter })}
                            className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                              adv.stutter
                                ? "bg-pink-500/20 text-pink-400 border-pink-500/30"
                                : "text-muted-foreground border-transparent hover:border-border"
                            }`}
                            style={{ fontFamily: "var(--font-mono)" }}
                          >
                            STUTTER
                          </button>
                          <button
                            onClick={() => setAdvAllTracks(laneIdx, { stutter: !adv.stutter, stutterRate: adv.stutterRate, stutterDepth: adv.stutterDepth })}
                            className="text-[8px] px-1 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                            style={{ fontFamily: "var(--font-mono)" }}
                            title="Apply to all tracks"
                          >
                            ALL
                          </button>
                        </div>
                        {adv.stutter && (
                          <div className="space-y-1.5 pl-1">
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] text-muted-foreground w-10">rate</span>
                              <input
                                type="range"
                                min={2}
                                max={64}
                                value={adv.stutterRate}
                                onChange={(e) => setAdvTrackProp(laneIdx, selTrack, { stutterRate: Number(e.target.value) })}
                                className="flex-1 h-1 accent-pink-400"
                              />
                              <span className="text-[9px] text-muted-foreground w-8 text-right" style={{ fontFamily: "var(--font-mono)" }}>
                                {adv.stutterRate}Hz
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] text-muted-foreground w-10">depth</span>
                              <input
                                type="range"
                                min={0}
                                max={100}
                                value={Math.round(adv.stutterDepth * 100)}
                                onChange={(e) => setAdvTrackProp(laneIdx, selTrack, { stutterDepth: Number(e.target.value) / 100 })}
                                className="flex-1 h-1 accent-pink-400"
                              />
                              <span className="text-[9px] text-muted-foreground w-8 text-right" style={{ fontFamily: "var(--font-mono)" }}>
                                {Math.round(adv.stutterDepth * 100)}%
                              </span>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Chorus */}
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => handleChorus(laneIdx, selTrack)}
                          className="text-[10px] font-bold px-1.5 py-0.5 rounded border text-muted-foreground border-transparent hover:border-border hover:bg-indigo-500/10 hover:text-indigo-400"
                          style={{ fontFamily: "var(--font-mono)" }}
                          title="Duplicate chop to 3 empty tracks with micro-detune"
                        >
                          CHORUS
                        </button>
                        <span className="text-[8px] text-muted-foreground/50">one-shot</span>
                      </div>

                      {/* Time Stretch */}
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-bold text-muted-foreground" style={{ fontFamily: "var(--font-mono)" }}>
                            STRETCH
                          </span>
                          <input
                            type="range"
                            min={25}
                            max={200}
                            value={Math.round(adv.timeStretch * 100)}
                            onChange={(e) => setAdvTrackProp(laneIdx, selTrack, { timeStretch: Number(e.target.value) / 100 })}
                            className="flex-1 h-1 accent-teal-400"
                          />
                          <span className="text-[9px] text-muted-foreground w-10 text-right" style={{ fontFamily: "var(--font-mono)" }}>
                            {adv.timeStretch.toFixed(2)}x
                          </span>
                        </div>
                        <button
                          onClick={() => setAdvAllTracks(laneIdx, { timeStretch: adv.timeStretch })}
                          className="text-[8px] px-1.5 py-0.5 rounded border border-border text-muted-foreground/60 hover:text-foreground hover:border-foreground/30"
                          style={{ fontFamily: "var(--font-mono)" }}
                        >
                          apply to all
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// Waveform drawing
function drawWaveform(
  canvas: HTMLCanvasElement,
  buffer: AudioBuffer,
  chops: Chop[]
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;
  const data = buffer.getChannelData(0);
  const step = Math.ceil(data.length / width);
  const mid = height / 2;

  // Read theme-aware colors from CSS variables
  const style = getComputedStyle(document.documentElement);
  const bgHsl = style.getPropertyValue("--waveform-bg").trim() || "0 0% 8%";
  const fgHsl = style.getPropertyValue("--waveform-fg").trim() || "24 95% 53%";
  const markHsl = style.getPropertyValue("--waveform-mark").trim() || "24 95% 53%";

  // Background
  ctx.fillStyle = `hsl(${bgHsl})`;
  ctx.fillRect(0, 0, width, height);

  // Draw chop boundaries
  const duration = buffer.duration;
  for (const chop of chops) {
    const x = (chop.start / duration) * width;
    ctx.strokeStyle = `hsla(${markHsl} / 0.25)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  // Waveform
  ctx.strokeStyle = `hsl(${fgHsl})`;
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (let i = 0; i < width; i++) {
    let min = 1.0;
    let max = -1.0;
    const offset = i * step;
    for (let j = 0; j < step && offset + j < data.length; j++) {
      const val = data[offset + j];
      if (val < min) min = val;
      if (val > max) max = val;
    }
    const yMin = mid + min * mid * 0.9;
    const yMax = mid + max * mid * 0.9;
    ctx.moveTo(i, yMin);
    ctx.lineTo(i, yMax);
  }

  ctx.stroke();
}
