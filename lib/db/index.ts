import { sql } from "@vercel/postgres";
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

export async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      bpm INTEGER NOT NULL DEFAULT 120,
      steps INTEGER NOT NULL DEFAULT 32,
      tracks JSONB NOT NULL DEFAULT '[]',
      pattern JSONB NOT NULL DEFAULT '[]',
      chop_boundaries JSONB NOT NULL DEFAULT '[]',
      audio_url TEXT
    )
  `;
}

export async function dbGetProjectList(): Promise<ProjectMeta[]> {
  await ensureTable();
  const { rows } = await sql`
    SELECT id, name, created_at, updated_at,
           jsonb_array_length(chop_boundaries) as chop_count
    FROM projects
    ORDER BY updated_at DESC
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    chopCount: Number(r.chop_count),
  }));
}

export async function dbGetProject(id: string): Promise<ProjectData | null> {
  await ensureTable();
  const { rows } = await sql`SELECT * FROM projects WHERE id = ${id}`;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    name: r.name,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    bpm: r.bpm,
    steps: r.steps,
    tracks: r.tracks,
    pattern: r.pattern,
    chopBoundaries: r.chop_boundaries,
  };
}

export async function dbCreateProject(id: string, name: string): Promise<ProjectData> {
  await ensureTable();
  const tracks = defaultTracks();
  const pattern = emptyPattern();
  const now = new Date();
  await sql`
    INSERT INTO projects (id, name, created_at, updated_at, bpm, steps, tracks, pattern, chop_boundaries)
    VALUES (${id}, ${name}, ${now.toISOString()}, ${now.toISOString()}, 120, 32, ${JSON.stringify(tracks)}, ${JSON.stringify(pattern)}, '[]')
  `;
  return {
    id,
    name,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    bpm: 120,
    steps: 32,
    tracks,
    pattern,
    chopBoundaries: [],
  };
}

export async function dbSaveProject(project: ProjectData): Promise<void> {
  await ensureTable();
  const now = new Date().toISOString();
  await sql`
    INSERT INTO projects (id, name, created_at, updated_at, bpm, steps, tracks, pattern, chop_boundaries)
    VALUES (${project.id}, ${project.name}, ${project.createdAt}, ${now}, ${project.bpm}, ${project.steps},
            ${JSON.stringify(project.tracks)}, ${JSON.stringify(project.pattern)}, ${JSON.stringify(project.chopBoundaries)})
    ON CONFLICT (id) DO UPDATE SET
      name = ${project.name},
      updated_at = ${now},
      bpm = ${project.bpm},
      steps = ${project.steps},
      tracks = ${JSON.stringify(project.tracks)},
      pattern = ${JSON.stringify(project.pattern)},
      chop_boundaries = ${JSON.stringify(project.chopBoundaries)}
  `;
}

export async function dbDeleteProject(id: string): Promise<void> {
  await ensureTable();
  await sql`DELETE FROM projects WHERE id = ${id}`;
}

export async function dbSetAudioUrl(id: string, url: string): Promise<void> {
  await sql`UPDATE projects SET audio_url = ${url} WHERE id = ${id}`;
}

export async function dbGetAudioUrl(id: string): Promise<string | null> {
  const { rows } = await sql`SELECT audio_url FROM projects WHERE id = ${id}`;
  return rows[0]?.audio_url ?? null;
}
