export interface Chop {
  index: number;
  start: number; // seconds
  end: number;   // seconds
  label: string;
  energy: number; // 0-1, used for classification
  spectralCentroid: number; // Hz, used for classification
}

export type DelayPreset = "none" | "slap" | "eighth" | "quarter" | "dotted";
export type ReverbPreset = "none" | "room" | "hall" | "cathedral" | "infinite";

export interface TrackState {
  chopIndex: number; // -1 = none
  delay: DelayPreset;
  reverb: ReverbPreset;
  volume: number; // 0-1
  muted: boolean;
  pitch: number; // semitones (-24 to 24)
  halfSpeed: boolean;
}

export interface ProjectData {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  bpm: number;
  steps: number;
  tracks: TrackState[];
  pattern: number[][]; // 16 tracks × 32 steps, value = chopIndex or -1
  chopBoundaries: { start: number; end: number }[];
}

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  chopCount: number;
}

export const DELAY_PRESETS: Record<DelayPreset, { label: string; time: number; feedback: number; wet: number }> = {
  none:    { label: "No Delay",      time: 0,      feedback: 0,   wet: 0 },
  slap:    { label: "Slap (50ms)",   time: 0.05,   feedback: 0.2, wet: 0.3 },
  eighth:  { label: "Eighth Note",   time: 0.25,   feedback: 0.35, wet: 0.3 },
  quarter: { label: "Quarter Note",  time: 0.5,    feedback: 0.3, wet: 0.25 },
  dotted:  { label: "Dotted Ping",   time: 0.375,  feedback: 0.45, wet: 0.35 },
};

export const REVERB_PRESETS: Record<ReverbPreset, { label: string; decay: number; wet: number }> = {
  none:       { label: "No Reverb",   decay: 0.01, wet: 0 },
  room:       { label: "Small Room",  decay: 1.2,  wet: 0.25 },
  hall:       { label: "Large Hall",  decay: 3.5,  wet: 0.35 },
  cathedral:  { label: "Cathedral",   decay: 6.0,  wet: 0.45 },
  infinite:   { label: "Infinite",    decay: 15.0, wet: 0.55 },
};

export const PATTERN_TEMPLATES = ["basic", "syncopated", "breakbeat", "halftime", "random"] as const;
export type PatternTemplate = typeof PATTERN_TEMPLATES[number];

export const TRACK_COLORS = [
  "#f97316", "#fb923c", "#f59e0b", "#eab308",
  "#84cc16", "#22c55e", "#14b8a6", "#06b6d4",
  "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7",
  "#d946ef", "#ec4899", "#f43f5e", "#ef4444",
];
