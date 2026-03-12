import type { ProjectData, ProjectMeta } from "./types";

export async function getProjectList(): Promise<ProjectMeta[]> {
  const res = await fetch("/api/projects");
  if (!res.ok) return [];
  return res.json();
}

export async function getProject(id: string): Promise<ProjectData | null> {
  const res = await fetch(`/api/projects/${id}`);
  if (!res.ok) return null;
  return res.json();
}

export async function createProject(name: string): Promise<ProjectData> {
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return res.json();
}

export async function saveProject(project: ProjectData): Promise<void> {
  await fetch(`/api/projects/${project.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(project),
  });
}

export async function deleteProject(id: string): Promise<void> {
  await fetch(`/api/projects/${id}`, { method: "DELETE" });
}

export async function renameProject(id: string, name: string): Promise<void> {
  const project = await getProject(id);
  if (project) {
    project.name = name;
    await saveProject(project);
  }
}

export async function saveAudioBlob(projectId: string, blob: Blob): Promise<void> {
  const formData = new FormData();
  formData.append("file", blob);
  await fetch(`/api/projects/${projectId}/audio`, {
    method: "POST",
    body: formData,
  });
}

export async function getAudioBlob(projectId: string): Promise<Blob | undefined> {
  const res = await fetch(`/api/projects/${projectId}/audio`);
  if (!res.ok) return undefined;
  return res.blob();
}
