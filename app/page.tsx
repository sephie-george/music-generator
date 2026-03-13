"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Pencil,
  Trash2,
  Music2,
  AudioWaveform,
  MoreVertical,
  X,
  Check,
  Sun,
  Moon,
} from "lucide-react";
import type { ProjectMeta } from "@/lib/types";
import {
  getProjectList,
  createProject,
  deleteProject,
  renameProject,
} from "@/lib/store";
import { formatDate } from "@/lib/utils";
import { useTheme } from "./theme-provider";

export default function LobbyPage() {
  const router = useRouter();
  const { theme, toggleTheme } = useTheme();
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getProjectList().then((list) => {
      setProjects(list);
      setLoading(false);
    });
  }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const project = await createProject(newName.trim());
    setNewName("");
    setShowCreate(false);
    router.push(`/editor/${project.id}`);
  };

  const handleRename = async (id: string) => {
    if (!editName.trim()) return;
    await renameProject(id, editName.trim());
    const list = await getProjectList();
    setProjects(list);
    setEditingId(null);
  };

  const handleDelete = async (id: string) => {
    await deleteProject(id);
    const list = await getProjectList();
    setProjects(list);
    setDeleteConfirm(null);
    setMenuOpen(null);
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-border/50 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
              <AudioWaveform className="w-4 h-4 text-primary" />
            </div>
            <h1
              className="text-lg font-semibold tracking-tight"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              CHOP
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleTheme}
              className="p-2 rounded-md border border-border hover:bg-secondary transition-colors"
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Project
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 px-6 py-8">
        <div className="max-w-5xl mx-auto">
          {/* Create dialog */}
          {showCreate && (
            <div className="mb-6 p-4 border border-border rounded-lg bg-card">
              <p className="text-sm text-muted-foreground mb-3">
                Project name
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleCreate();
                }}
                className="flex gap-2"
              >
                <input
                  autoFocus
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Lo-fi flip, Jungle break, Ambient chops..."
                  className="flex-1 px-3 py-2 rounded-md bg-secondary border border-border text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <button
                  type="submit"
                  className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowCreate(false);
                    setNewName("");
                  }}
                  className="px-3 py-2 rounded-md border border-border text-sm hover:bg-secondary"
                >
                  Cancel
                </button>
              </form>
            </div>
          )}

          {/* Loading state */}
          {loading && (
            <div className="flex items-center justify-center py-32">
              <span className="text-sm text-muted-foreground">Loading...</span>
            </div>
          )}

          {/* Empty state */}
          {!loading && projects.length === 0 && !showCreate && (
            <div className="flex flex-col items-center justify-center py-32 text-center">
              <div className="w-16 h-16 rounded-2xl bg-card border border-border flex items-center justify-center mb-6">
                <Music2 className="w-8 h-8 text-muted-foreground" />
              </div>
              <h2 className="text-xl font-medium mb-2">No projects yet</h2>
              <p className="text-muted-foreground text-sm mb-6 max-w-sm">
                Upload audio, chop it into samples, arrange them on a piano
                roll, and generate beats.
              </p>
              <button
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                <Plus className="w-4 h-4" />
                Create your first project
              </button>
            </div>
          )}

          {/* Project grid */}
          {!loading && projects.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {projects.map((project) => (
                <div
                  key={project.id}
                  className="group relative border border-border rounded-lg bg-card hover:border-primary/30 transition-colors cursor-pointer"
                  onClick={() => {
                    if (editingId !== project.id && deleteConfirm !== project.id)
                      router.push(`/editor/${project.id}`);
                  }}
                >
                  <div className="p-4">
                    {/* Header row */}
                    <div className="flex items-start justify-between mb-3">
                      {editingId === project.id ? (
                        <div className="flex items-center gap-1.5 flex-1 mr-2">
                          <input
                            autoFocus
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleRename(project.id);
                              if (e.key === "Escape") setEditingId(null);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="flex-1 px-2 py-1 rounded bg-secondary border border-border text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                          />
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRename(project.id);
                            }}
                            className="p-1 rounded hover:bg-secondary"
                          >
                            <Check className="w-3.5 h-3.5 text-primary" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingId(null);
                            }}
                            className="p-1 rounded hover:bg-secondary"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <h3
                          className="font-medium text-sm truncate"
                          style={{ fontFamily: "var(--font-mono)" }}
                        >
                          {project.name}
                        </h3>
                      )}

                      {editingId !== project.id && (
                        <div className="relative">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setMenuOpen(
                                menuOpen === project.id ? null : project.id
                              );
                            }}
                            className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-secondary transition-opacity"
                          >
                            <MoreVertical className="w-4 h-4 text-muted-foreground" />
                          </button>

                          {menuOpen === project.id && (
                            <div className="absolute right-0 top-8 z-10 w-36 py-1 bg-card border border-border rounded-lg shadow-xl">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditingId(project.id);
                                  setEditName(project.name);
                                  setMenuOpen(null);
                                }}
                                className="w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 hover:bg-secondary"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                                Rename
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDeleteConfirm(project.id);
                                  setMenuOpen(null);
                                }}
                                className="w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 hover:bg-secondary text-destructive"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                Delete
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Delete confirmation */}
                    {deleteConfirm === project.id && (
                      <div
                        className="mb-3 p-2.5 rounded-md bg-destructive/10 border border-destructive/20"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <p className="text-xs text-destructive mb-2">
                          Delete this project?
                        </p>
                        <div className="flex gap-2">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDelete(project.id);
                            }}
                            className="px-3 py-1 rounded text-xs bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Delete
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteConfirm(null);
                            }}
                            className="px-3 py-1 rounded text-xs border border-border hover:bg-secondary"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Meta info */}
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{formatDate(project.createdAt)}</span>
                      <span className="w-px h-3 bg-border" />
                      <span>
                        {project.chopCount}{" "}
                        {project.chopCount === 1 ? "chop" : "chops"}
                      </span>
                    </div>
                  </div>

                  {/* Bottom accent line */}
                  <div className="h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border/30 px-6 py-3">
        <div className="max-w-5xl mx-auto flex items-center justify-between text-xs text-muted-foreground">
          <span style={{ fontFamily: "var(--font-mono)" }}>
            CHOP v0.1
          </span>
          <span>Sample-based music generator</span>
        </div>
      </footer>

      {/* Click outside to close menus */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-0"
          onClick={() => setMenuOpen(null)}
        />
      )}
    </div>
  );
}
