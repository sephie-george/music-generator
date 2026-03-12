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
  ChevronDown,
  AudioWaveform,
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
import { AudioEngine } from "@/lib/audio/engine";

export default function EditorPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [project, setProject] = useState<ProjectData | null>(null);
  const [chops, setChops] = useState<Chop[]>([]);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentStep, setCurrentStep] = useState(-1);
  const [bpm, setBpm] = useState(120);
  const [pattern, setPattern] = useState<number[][]>(
    Array.from({ length: 16 }, () => Array(32).fill(-1))
  );
  const [trackEffects, setTrackEffects] = useState<
    { delay: DelayPreset; reverb: ReverbPreset }[]
  >(Array.from({ length: 16 }, () => ({ delay: "none" as DelayPreset, reverb: "none" as ReverbPreset })));
  const [trackChops, setTrackChops] = useState<number[]>(Array(16).fill(-1));
  const [trackMutes, setTrackMutes] = useState<boolean[]>(Array(16).fill(false));
  const [trackSolos, setTrackSolos] = useState<boolean[]>(Array(16).fill(false));
  const [trackPitches, setTrackPitches] = useState<number[]>(Array(16).fill(0));
  const [trackHalfSpeed, setTrackHalfSpeed] = useState<boolean[]>(Array(16).fill(false));
  const [selectedTemplate, setSelectedTemplate] = useState<PatternTemplate>("basic");
  const [promptText, setPromptText] = useState("");
  const [masterDelay, setMasterDelay] = useState<DelayPreset>("none");
  const [masterReverb, setMasterReverb] = useState<ReverbPreset>("none");
  const [sensitivity, setSensitivity] = useState<"soft" | "medium" | "hard">("medium");
  const [chopMode, setChopMode] = useState<"transient" | "equal" | "fine">("transient");
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [playingSource, setPlayingSource] = useState(false);

  // Mouse drag painting state
  const [isPainting, setIsPainting] = useState(false);
  const paintModeRef = useRef<"add" | "remove">("add");
  const paintedCellsRef = useRef<Set<string>>(new Set());

  const engineRef = useRef<AudioEngine | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
    setPattern(p.pattern);
    setTrackChops(p.tracks.map((t) => t.chopIndex));
    setTrackEffects(p.tracks.map((t) => ({ delay: t.delay, reverb: t.reverb })));
    setTrackMutes(p.tracks.map((t) => t.muted));
    setTrackPitches(p.tracks.map((t) => (t as any).pitch ?? 0));
    setTrackHalfSpeed(p.tracks.map((t) => (t as any).halfSpeed ?? false));

    // Try to reload audio from server
    getAudioBlob(projectId).then(async (blob) => {
      if (blob) {
        const arrayBuffer = await blob.arrayBuffer();
        const audioCtx = new AudioContext();
        const buffer = await audioCtx.decodeAudioData(arrayBuffer);
        setAudioBuffer(buffer);
        setFileName("(saved audio)");

        // Rechop if boundaries exist
        if (p.chopBoundaries.length > 0) {
          const detectedChops = detectTransients(buffer);
          setChops(detectedChops);
          await initEngine(buffer, detectedChops, p);
        }
      }
    });
    })();

    return () => {
      engineRef.current?.dispose();
    };
  }, [projectId]);

  // Autosave: debounced save on any change
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!project) return;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(async () => {
      const updated: ProjectData = {
        ...project,
        bpm,
        pattern,
        tracks: Array.from({ length: 16 }, (_, i) => ({
          chopIndex: trackChops[i],
          delay: trackEffects[i].delay,
          reverb: trackEffects[i].reverb,
          volume: 0.8,
          muted: trackMutes[i],
          pitch: trackPitches[i],
          halfSpeed: trackHalfSpeed[i],
        })),
        chopBoundaries: chops.map((c) => ({ start: c.start, end: c.end })),
      };
      await saveProject(updated);
      setProject(updated);
    }, 2000);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [bpm, pattern, trackChops, trackEffects, trackMutes, trackPitches, trackHalfSpeed, chops]);

  // Draw waveform
  useEffect(() => {
    if (!audioBuffer || !canvasRef.current) return;
    drawWaveform(canvasRef.current, audioBuffer, chops);
  }, [audioBuffer, chops]);

  const initEngine = async (
    buffer: AudioBuffer,
    chopList: Chop[],
    proj?: ProjectData
  ) => {
    const engine = new AudioEngine();
    await engine.init();
    await engine.loadSourceBuffer(buffer);
    await engine.createChopBuffers(
      chopList.map((c) => ({ start: c.start, end: c.end }))
    );

    // Setup tracks
    const tChops = proj?.tracks.map((t) => t.chopIndex) || trackChops;
    for (let i = 0; i < 16; i++) {
      if (tChops[i] >= 0 && tChops[i] < chopList.length) {
        await engine.setupTrack(i, tChops[i]);
        if (proj?.tracks[i]) {
          await engine.setTrackDelay(i, proj.tracks[i].delay);
          await engine.setTrackReverb(i, proj.tracks[i].reverb);
          engine.setTrackPitch(i, (proj.tracks[i] as any).pitch ?? 0);
          engine.setTrackHalfSpeed(i, (proj.tracks[i] as any).halfSpeed ?? false);
        }
      }
    }

    const pat = proj?.pattern || pattern;
    engine.setPattern(pat);
    engine.bpm = proj?.bpm || bpm;
    engine.onStep((step) => setCurrentStep(step));

    engineRef.current?.dispose();
    engineRef.current = engine;
  };

  // Handle file upload
  const handleFile = async (file: File) => {
    if (!file.type.startsWith("audio/")) return;
    setIsLoading(true);
    setFileName(file.name);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioCtx = new AudioContext();
      const buffer = await audioCtx.decodeAudioData(arrayBuffer);
      setAudioBuffer(buffer);

      // Save audio blob
      await saveAudioBlob(projectId, file);

      // Detect transients
      const detectedChops = detectTransients(buffer);
      setChops(detectedChops);

      // Auto-assign chops to all 16 tracks (wrap around if fewer chops)
      const newTrackChops = Array(16).fill(-1);
      for (let i = 0; i < 16; i++) {
        newTrackChops[i] = detectedChops.length > 0 ? i % detectedChops.length : -1;
      }
      setTrackChops(newTrackChops);

      await initEngine(buffer, detectedChops);

      // Update track assignments in engine
      for (let i = 0; i < 16; i++) {
        if (newTrackChops[i] >= 0) {
          await engineRef.current?.setupTrack(i, newTrackChops[i]);
        }
      }
    } catch (err) {
      console.error("Error loading audio:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  // Piano roll cell toggle
  const toggleCell = (track: number, step: number) => {
    const chopIdx = trackChops[track];
    if (chopIdx < 0) return;

    const newPattern = pattern.map((row) => [...row]);
    const wasActive = newPattern[track][step] >= 0;
    newPattern[track][step] = wasActive ? -1 : chopIdx;
    setPattern(newPattern);
    engineRef.current?.setPattern(newPattern);

    // Preview sound when adding a note
    if (!wasActive) {
      engineRef.current?.triggerTrack(track);
    }
  };

  // Mouse drag painting
  const handleCellMouseDown = (track: number, step: number) => {
    const chopIdx = trackChops[track];
    if (chopIdx < 0) return;

    const isActive = pattern[track][step] >= 0;
    paintModeRef.current = isActive ? "remove" : "add";
    paintedCellsRef.current = new Set([`${track}-${step}`]);
    setIsPainting(true);
    toggleCell(track, step);
  };

  const handleCellMouseEnter = (track: number, step: number) => {
    if (!isPainting) return;
    const chopIdx = trackChops[track];
    if (chopIdx < 0) return;
    const key = `${track}-${step}`;
    if (paintedCellsRef.current.has(key)) return;
    paintedCellsRef.current.add(key);

    const isActive = pattern[track][step] >= 0;
    const shouldBeActive = paintModeRef.current === "add";
    if (isActive !== shouldBeActive) {
      toggleCell(track, step);
    }
  };

  const handleMouseUp = useCallback(() => {
    setIsPainting(false);
    paintedCellsRef.current.clear();
  }, []);

  useEffect(() => {
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, [handleMouseUp]);

  // Track chop assignment
  const assignChop = async (track: number, chopIndex: number) => {
    const newTrackChops = [...trackChops];
    newTrackChops[track] = chopIndex;
    setTrackChops(newTrackChops);

    if (chopIndex >= 0) {
      await engineRef.current?.setupTrack(track, chopIndex);
      // Apply current effects
      await engineRef.current?.setTrackDelay(track, trackEffects[track].delay);
      await engineRef.current?.setTrackReverb(track, trackEffects[track].reverb);
    }

    // Update pattern cells for this track
    const newPattern = pattern.map((row) => [...row]);
    for (let s = 0; s < 32; s++) {
      if (newPattern[track][s] >= 0) {
        newPattern[track][s] = chopIndex;
      }
    }
    setPattern(newPattern);
    engineRef.current?.setPattern(newPattern);
  };

  // Effects
  const setDelay = async (track: number, preset: DelayPreset) => {
    const newEffects = [...trackEffects];
    newEffects[track] = { ...newEffects[track], delay: preset };
    setTrackEffects(newEffects);
    await engineRef.current?.setTrackDelay(track, preset);
  };

  const setReverb = async (track: number, preset: ReverbPreset) => {
    const newEffects = [...trackEffects];
    newEffects[track] = { ...newEffects[track], reverb: preset };
    setTrackEffects(newEffects);
    await engineRef.current?.setTrackReverb(track, preset);
  };

  const toggleMute = (track: number) => {
    const newMutes = [...trackMutes];
    newMutes[track] = !newMutes[track];
    setTrackMutes(newMutes);
    applyMuteSolo(newMutes, trackSolos);
  };

  const toggleSolo = (track: number) => {
    const newSolos = [...trackSolos];
    newSolos[track] = !newSolos[track];
    setTrackSolos(newSolos);
    applyMuteSolo(trackMutes, newSolos);
  };

  const applyMuteSolo = (mutes: boolean[], solos: boolean[]) => {
    const anySolo = solos.some(Boolean);
    for (let i = 0; i < 16; i++) {
      const shouldMute = mutes[i] || (anySolo && !solos[i]);
      engineRef.current?.setTrackMute(i, shouldMute);
    }
  };

  const setPitch = (track: number, semitones: number) => {
    const clamped = Math.max(-24, Math.min(24, semitones));
    const newPitches = [...trackPitches];
    newPitches[track] = clamped;
    setTrackPitches(newPitches);
    engineRef.current?.setTrackPitch(track, clamped);
  };

  const toggleHalfSpeed = (track: number) => {
    const newHalf = [...trackHalfSpeed];
    newHalf[track] = !newHalf[track];
    setTrackHalfSpeed(newHalf);
    engineRef.current?.setTrackHalfSpeed(track, newHalf[track]);
  };

  // Transport
  const handlePlay = async () => {
    if (!engineRef.current) return;
    engineRef.current.setPattern(pattern);
    engineRef.current.bpm = bpm;
    await engineRef.current.play();
    setIsPlaying(true);
  };

  const handlePause = async () => {
    await engineRef.current?.pause();
    setIsPlaying(false);
  };

  const handleStop = async () => {
    engineRef.current?.stopAll();
    setIsPlaying(false);
    setPlayingSource(false);
    setCurrentStep(-1);
  };

  // BPM change
  const handleBpmChange = (newBpm: number) => {
    setBpm(newBpm);
    if (engineRef.current) {
      engineRef.current.bpm = newBpm;
    }
  };

  // Generate
  const handleGenerate = async () => {
    if (chops.length === 0) return;
    if (engineRef.current) {
      engineRef.current.stopAll();
      setIsPlaying(false);
      setPlayingSource(false);
      setCurrentStep(-1);
    }
    const { pattern: newPattern, trackAssignments, bpm: newBpm } = generatePattern(
      chops,
      selectedTemplate,
      32
    );

    setBpm(newBpm);
    if (engineRef.current) engineRef.current.bpm = newBpm;

    // Merge: keep existing track chop assignments, only overwrite tracks the generator used
    const mergedChops = [...trackChops];
    for (let i = 0; i < 16; i++) {
      if (trackAssignments[i] >= 0) {
        mergedChops[i] = trackAssignments[i];
      }
    }
    // Also update pattern cells to use merged chop indices
    for (let i = 0; i < 16; i++) {
      for (let s = 0; s < 32; s++) {
        if (newPattern[i][s] >= 0) {
          newPattern[i][s] = mergedChops[i];
        }
      }
    }

    setPattern(newPattern);
    setTrackChops(mergedChops);
    engineRef.current?.setPattern(newPattern);

    for (let i = 0; i < 16; i++) {
      if (mergedChops[i] >= 0) {
        await engineRef.current?.setupTrack(i, mergedChops[i]);
        await engineRef.current?.setTrackDelay(i, trackEffects[i].delay);
        await engineRef.current?.setTrackReverb(i, trackEffects[i].reverb);
        engineRef.current?.setTrackPitch(i, trackPitches[i]);
        engineRef.current?.setTrackHalfSpeed(i, trackHalfSpeed[i]);
      }
    }
  };

  // Generate from text prompt
  const handlePromptGenerate = async () => {
    if (chops.length === 0 || !promptText.trim()) return;
    if (engineRef.current) {
      engineRef.current.stopAll();
      setIsPlaying(false);
      setPlayingSource(false);
      setCurrentStep(-1);
    }
    const { pattern: newPattern, trackAssignments, bpm: newBpm } = generateFromPrompt(
      chops,
      promptText,
      32
    );

    setBpm(newBpm);
    if (engineRef.current) engineRef.current.bpm = newBpm;

    const mergedChops = [...trackChops];
    for (let i = 0; i < 16; i++) {
      if (trackAssignments[i] >= 0) {
        mergedChops[i] = trackAssignments[i];
      }
    }
    for (let i = 0; i < 16; i++) {
      for (let s = 0; s < 32; s++) {
        if (newPattern[i][s] >= 0) {
          newPattern[i][s] = mergedChops[i];
        }
      }
    }

    setPattern(newPattern);
    setTrackChops(mergedChops);
    engineRef.current?.setPattern(newPattern);
    for (let i = 0; i < 16; i++) {
      if (mergedChops[i] >= 0) {
        await engineRef.current?.setupTrack(i, mergedChops[i]);
        await engineRef.current?.setTrackDelay(i, trackEffects[i].delay);
        await engineRef.current?.setTrackReverb(i, trackEffects[i].reverb);
        engineRef.current?.setTrackPitch(i, trackPitches[i]);
        engineRef.current?.setTrackHalfSpeed(i, trackHalfSpeed[i]);
      }
    }
  };

  // Clear pattern
  const handleClear = () => {
    const empty = Array.from({ length: 16 }, () => Array(32).fill(-1));
    setPattern(empty);
    engineRef.current?.setPattern(empty);
  };

  // Save
  const handleSave = async () => {
    if (!project) return;
    setSaving(true);
    const updated: ProjectData = {
      ...project,
      bpm,
      pattern,
      tracks: Array.from({ length: 16 }, (_, i) => ({
        chopIndex: trackChops[i],
        delay: trackEffects[i].delay,
        reverb: trackEffects[i].reverb,
        volume: 0.8,
        muted: trackMutes[i],
        pitch: trackPitches[i],
        halfSpeed: trackHalfSpeed[i],
      })),
      chopBoundaries: chops.map((c) => ({ start: c.start, end: c.end })),
    };
    await saveProject(updated);
    setProject(updated);
    setTimeout(() => setSaving(false), 800);
  };

  // Re-chop helper
  const doRechop = async (mode: "transient" | "equal" | "fine", sens: "soft" | "medium" | "hard") => {
    if (!audioBuffer) return;

    let newChops;
    if (mode === "equal") {
      const sliceMap = { soft: 16, medium: 32, hard: 64 };
      newChops = chopEqual(audioBuffer, sliceMap[sens]);
    } else if (mode === "fine") {
      // Fine: very sensitive transient detection, one sound per chop, no gap-filling
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
    setChops(newChops);

    const newTrackChops = Array(16).fill(-1);
    for (let i = 0; i < 16; i++) {
      newTrackChops[i] = newChops.length > 0 ? i % newChops.length : -1;
    }
    setTrackChops(newTrackChops);

    const empty = Array.from({ length: 16 }, () => Array(32).fill(-1));
    setPattern(empty);

    await initEngine(audioBuffer, newChops);
    for (let i = 0; i < 16; i++) {
      if (newTrackChops[i] >= 0) {
        await engineRef.current?.setupTrack(i, newTrackChops[i]);
      }
    }
    engineRef.current?.setPattern(empty);
  };

  const handleRechop = async (sens: "soft" | "medium" | "hard") => {
    setSensitivity(sens);
    await doRechop(chopMode, sens);
  };

  const handleChopModeChange = async (mode: "transient" | "equal" | "fine") => {
    setChopMode(mode);
    await doRechop(mode, sensitivity);
  };

  // Play original source
  const handlePlaySource = async () => {
    if (!engineRef.current) return;
    if (playingSource || engineRef.current.isSourcePlaying) {
      engineRef.current.stopSource();
      setPlayingSource(false);
    } else {
      // Stop transport if playing
      if (isPlaying) {
        await engineRef.current.stop();
        setIsPlaying(false);
        setCurrentStep(-1);
      }
      engineRef.current.onSourceStop(() => setPlayingSource(false));
      await engineRef.current.playSource();
      setPlayingSource(true);
    }
  };

  // Export WAV
  const handleExport = async () => {
    if (!engineRef.current) return;
    setExporting(true);
    try {
      const blob = await engineRef.current.exportWAV();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project?.name || "export"}.wav`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export error:", err);
    } finally {
      setExporting(false);
    }
  };

  if (!project) return null;

  return (
    <div className="min-h-screen flex flex-col">
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
            onClick={handleSave}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs hover:bg-secondary transition-colors"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? "Saved" : "Save"}
          </button>
          <button
            onClick={handleExport}
            disabled={exporting || chops.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs hover:bg-secondary transition-colors disabled:opacity-40"
          >
            <Download className="w-3.5 h-3.5" />
            {exporting ? "Exporting..." : "Export WAV"}
          </button>
        </div>
      </header>

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Upload zone (shown when no audio) */}
        {!audioBuffer && (
          <div className="flex-1 flex items-center justify-center p-8">
            <div
              className={`drop-zone w-full max-w-lg border-2 border-dashed rounded-xl p-12 text-center transition-all ${
                isDragging
                  ? "dragging border-primary bg-primary/5"
                  : "border-border hover:border-muted-foreground/30"
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
            >
              <Upload className="w-10 h-10 text-muted-foreground mx-auto mb-4" />
              <p className="text-sm text-muted-foreground mb-1">
                Drag & drop an audio file here
              </p>
              <p className="text-xs text-muted-foreground/60 mb-4">
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
                    if (file) handleFile(file);
                  }}
                />
              </label>
            </div>
          </div>
        )}

        {/* Loading state */}
        {isLoading && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">
                Detecting transients...
              </p>
            </div>
          </div>
        )}

        {/* Editor */}
        {audioBuffer && !isLoading && (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Waveform + chops info */}
            <div className="border-b border-border/50 px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">
                    {fileName}
                  </span>
                  <span className="text-xs text-muted-foreground/50">|</span>
                  <span
                    className="text-xs text-primary"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    {chops.length} chops
                  </span>
                  <span className="text-xs text-muted-foreground/50">|</span>
                  {/* Chop mode toggle */}
                  <div className="flex items-center gap-0.5">
                    {(["transient", "equal", "fine"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => handleChopModeChange(m)}
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
                        onClick={() => handleRechop(s)}
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
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handlePlaySource}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs border hover:bg-secondary ${
                      playingSource
                        ? "border-primary text-primary"
                        : "border-border"
                    }`}
                  >
                    {playingSource ? (
                      <Square className="w-3 h-3" />
                    ) : (
                      <Play className="w-3 h-3" />
                    )}
                    {playingSource ? "Stop" : "Preview"}
                  </button>
                  <label className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs border border-border hover:bg-secondary cursor-pointer">
                    <Upload className="w-3 h-3" />
                    Replace
                    <input
                      type="file"
                      accept="audio/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleFile(file);
                      }}
                    />
                  </label>
                </div>
              </div>
              <canvas
                ref={canvasRef}
                className="w-full h-16 rounded bg-secondary/50"
              />
            </div>

            {/* Toolbar: Transport + BPM + Generate */}
            <div className="border-b border-border/50 px-4 py-2.5 flex items-center gap-4 flex-shrink-0">
              {/* Transport */}
              <div className="flex items-center gap-1">
                {!isPlaying ? (
                  <button
                    onClick={handlePlay}
                    disabled={chops.length === 0}
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

              <div className="w-px h-6 bg-border" />

              {/* BPM */}
              <div className="flex items-center gap-2">
                <span
                  className="text-xs text-muted-foreground"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  BPM
                </span>
                <input
                  type="number"
                  min={60}
                  max={200}
                  value={bpm}
                  onChange={(e) => handleBpmChange(Number(e.target.value))}
                  className="w-16 px-2 py-1 rounded bg-secondary border border-border text-sm text-center focus:outline-none focus:ring-1 focus:ring-ring"
                  style={{ fontFamily: "var(--font-mono)" }}
                />
              </div>

              <div className="w-px h-6 bg-border" />

              {/* Generate */}
              <div className="flex items-center gap-2">
                <select
                  value={selectedTemplate}
                  onChange={(e) =>
                    setSelectedTemplate(e.target.value as PatternTemplate)
                  }
                  className="px-2 py-1 rounded bg-secondary border border-border text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {PATTERN_TEMPLATES.map((t) => (
                    <option key={t} value={t}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </option>
                  ))}
                </select>
                <button
                  onClick={handleGenerate}
                  disabled={chops.length === 0}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 border border-primary/20 text-primary text-xs hover:bg-primary/20 disabled:opacity-40"
                >
                  <Shuffle className="w-3.5 h-3.5" />
                  Generate
                </button>
              </div>

              <div className="w-px h-6 bg-border" />

              {/* Text prompt */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handlePromptGenerate();
                }}
                className="flex items-center gap-1.5"
              >
                <input
                  type="text"
                  value={promptText}
                  onChange={(e) => setPromptText(e.target.value)}
                  placeholder="слыш"
                  className="w-52 px-2 py-1 rounded bg-secondary border border-border text-xs placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <button
                  type="submit"
                  disabled={chops.length === 0 || !promptText.trim()}
                  className="px-2.5 py-1.5 rounded-md bg-primary/10 border border-primary/20 text-primary text-xs hover:bg-primary/20 disabled:opacity-40"
                >
                  Go
                </button>
              </form>

              <div className="w-px h-6 bg-border" />

              <button
                onClick={handleClear}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs hover:bg-secondary text-muted-foreground"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear
              </button>

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
                  /32
                </span>
              </div>
            </div>

            {/* Piano Roll + Track Controls */}
            <div className="flex-1 overflow-auto">
              <div className="flex min-w-fit">
                {/* Track controls column */}
                <div className="w-72 flex-shrink-0 border-r border-border/50">
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
                        onChange={(e) => assignChop(t, Number(e.target.value))}
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
                          onClick={() => setDelay(t, trackEffects[t].delay === "none" ? "eighth" : "none")}
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
                            onChange={(e) =>
                              setDelay(t, e.target.value as DelayPreset)
                            }
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
                          onClick={() => setReverb(t, trackEffects[t].reverb === "none" ? "room" : "none")}
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
                            onChange={(e) =>
                              setReverb(t, e.target.value as ReverbPreset)
                            }
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
                        onChange={(e) => setPitch(t, Number(e.target.value))}
                        title="Pitch (semitones)"
                        className="w-[32px] px-0.5 py-0.5 rounded bg-transparent border border-transparent hover:border-border text-[10px] text-center focus:outline-none focus:ring-1 focus:ring-ring"
                        style={{ fontFamily: "var(--font-mono)" }}
                      />
                      {/* Half speed */}
                      <button
                        onClick={() => toggleHalfSpeed(t)}
                        title="Half speed"
                        className={`px-1 py-0.5 rounded text-[9px] font-medium ${
                          trackHalfSpeed[t]
                            ? "bg-primary/20 text-primary border border-primary/30"
                            : "text-muted-foreground hover:text-foreground border border-transparent hover:border-border"
                        }`}
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        ½
                      </button>
                      {/* Mute */}
                      <button
                        onClick={() => toggleMute(t)}
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
                        onClick={() => toggleSolo(t)}
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
                  {/* Master channel */}
                  <div className="h-9 border-t border-primary/20 border-b border-b-border/20 px-2 flex items-center gap-1.5 bg-primary/[0.03]">
                    <div
                      className="w-2 h-2 rounded-full flex-shrink-0 bg-primary"
                    />
                    <span
                      className="text-[10px] font-bold text-primary w-[60px]"
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
                          engineRef.current?.setMasterDelay(v);
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
                            engineRef.current?.setMasterDelay(v);
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
                          engineRef.current?.setMasterReverb(v);
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
                            engineRef.current?.setMasterReverb(v);
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
                  </div>
                </div>

                {/* Grid area */}
                <div className="flex-1 overflow-x-auto">
                  {/* Step numbers header */}
                  <div className="h-7 border-b border-border/30 flex">
                    {Array.from({ length: 32 }, (_, s) => (
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
                      {Array.from({ length: 32 }, (_, s) => {
                        const isActive = pattern[t][s] >= 0;
                        const isCurrentStep = currentStep === s;
                        const isBeat = s % 8 === 0;
                        const isHalfBeat = s % 4 === 0;

                        return (
                          <div
                            key={s}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              handleCellMouseDown(t, s);
                            }}
                            onMouseEnter={() => handleCellMouseEnter(t, s)}
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
                              <div
                                className="w-full h-full flex items-center justify-center"
                              >
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

  // Background
  ctx.fillStyle = "hsl(0 0% 8%)";
  ctx.fillRect(0, 0, width, height);

  // Draw chop boundaries
  const duration = buffer.duration;
  for (const chop of chops) {
    const x = (chop.start / duration) * width;
    ctx.strokeStyle = "hsla(24, 95%, 53%, 0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  // Waveform
  ctx.strokeStyle = "hsl(24, 95%, 53%)";
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
