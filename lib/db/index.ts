import { put, del, list, head } from "@vercel/blob";
import type { ProjectData, ProjectMeta, TrackState } from "../types";

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
        chopCount: data.chopBoundaries?.length ?? 0,
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
    const blobInfo = await head(`${PROJECT_PREFIX}${id}.json`);
    const res = await fetch(blobInfo.url);
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
    tracks: defaultTracks(),
    pattern: emptyPattern(),
    chopBoundaries: [],
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
    const projectBlob = await head(`${PROJECT_PREFIX}${id}.json`);
    await del(projectBlob.url);
  } catch {}
  try {
    const { blobs } = await list({ prefix: `${AUDIO_PREFIX}${id}/` });
    for (const blob of blobs) {
      await del(blob.url);
    }
  } catch {}
}

export async function dbSaveAudio(id: string, file: File | Blob, filename: string): Promise<string> {
  const blob = await put(`${AUDIO_PREFIX}${id}/${filename}`, file, {
    access: "public",
    addRandomSuffix: false,
  });
  return blob.url;
}

export async function dbGetAudioUrl(id: string): Promise<string | null> {
  try {
    const { blobs } = await list({ prefix: `${AUDIO_PREFIX}${id}/` });
    return blobs.length > 0 ? blobs[0].url : null;
  } catch {
    return null;
  }
}
