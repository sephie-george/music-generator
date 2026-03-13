import { put, del, list } from "@vercel/blob";
import type { ProjectData, ProjectMeta, TrackState, LaneState } from "../types";

function defaultTracks(): TrackState[] {
  return Array.from({ length: 16 }, () => ({
    chopIndex: -1,
    delay: "none" as const,
    reverb: "none" as const,
    volume: 0.8,
    muted: false,
    pitch: 0,
    halfSpeed: false,
  }));
}

function emptyPattern(): number[][] {
  return Array.from({ length: 16 }, () => Array(32).fill(-1));
}

function defaultLane(): LaneState {
  return { tracks: defaultTracks(), pattern: emptyPattern(), chopBoundaries: [] };
}

const PROJECT_PREFIX = "projects/";
const AUDIO_PREFIX = "audio/";

export async function dbGetProjectList(): Promise<ProjectMeta[]> {
  const { blobs } = await list({ prefix: PROJECT_PREFIX });
  const projects: ProjectMeta[] = [];

  for (const blob of blobs) {
    try {
      const res = await fetch(blob.url);
      const data: ProjectData = await res.json();
      projects.push({
        id: data.id,
        name: data.name,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        chopCount: data.lanes
          ? (data.lanes[0]?.chopBoundaries?.length ?? 0) + (data.lanes[1]?.chopBoundaries?.length ?? 0)
          : data.chopBoundaries?.length ?? 0,
      });
    } catch {
      // skip corrupted blobs
    }
  }

  projects.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return projects;
}

export async function dbGetProject(id: string): Promise<ProjectData | null> {
  try {
    const { blobs } = await list({ prefix: `${PROJECT_PREFIX}${id}.json` });
    if (blobs.length === 0) return null;
    const res = await fetch(blobs[0].url);
    return await res.json();
  } catch {
    return null;
  }
}

export async function dbCreateProject(id: string, name: string): Promise<ProjectData> {
  const now = new Date().toISOString();
  const project: ProjectData = {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    bpm: 120,
    steps: 32,
    lanes: [defaultLane(), defaultLane()],
  };
  await put(`${PROJECT_PREFIX}${id}.json`, JSON.stringify(project), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
  });
  return project;
}

export async function dbSaveProject(project: ProjectData): Promise<void> {
  project.updatedAt = new Date().toISOString();
  await put(`${PROJECT_PREFIX}${project.id}.json`, JSON.stringify(project), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
  });
}

export async function dbDeleteProject(id: string): Promise<void> {
  try {
    const { blobs } = await list({ prefix: `${PROJECT_PREFIX}${id}.json` });
    for (const blob of blobs) await del(blob.url);
  } catch {}
  try {
    const { blobs } = await list({ prefix: `${AUDIO_PREFIX}${id}/` });
    for (const blob of blobs) await del(blob.url);
  } catch {}
}

export async function dbSaveAudio(id: string, file: File | Blob, filename: string, lane: number = 0): Promise<string> {
  const blob = await put(`${AUDIO_PREFIX}${id}/lane${lane}/${filename}`, file, {
    access: "public",
    addRandomSuffix: false,
  });
  return blob.url;
}

export async function dbGetAudioUrl(id: string, lane: number = 0): Promise<string | null> {
  try {
    const { blobs } = await list({ prefix: `${AUDIO_PREFIX}${id}/lane${lane}/` });
    if (blobs.length > 0) return blobs[0].url;
    // Fallback: check legacy path (no lane prefix)
    if (lane === 0) {
      const { blobs: legacy } = await list({ prefix: `${AUDIO_PREFIX}${id}/` });
      const legacyBlob = legacy.find(b => !b.pathname.includes("/lane"));
      if (legacyBlob) return legacyBlob.url;
    }
    return null;
  } catch {
    return null;
  }
}
