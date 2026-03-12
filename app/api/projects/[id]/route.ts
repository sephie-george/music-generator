import { NextResponse } from "next/server";
import { dbGetProject, dbSaveProject, dbDeleteProject, dbGetAudioUrl } from "@/lib/db";
import { del } from "@vercel/blob";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await dbGetProject(id);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(project);
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  body.id = id;
  await dbSaveProject(body);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Delete audio blob if exists
  const audioUrl = await dbGetAudioUrl(id);
  if (audioUrl) {
    try { await del(audioUrl); } catch {}
  }
  await dbDeleteProject(id);
  return NextResponse.json({ ok: true });
}
