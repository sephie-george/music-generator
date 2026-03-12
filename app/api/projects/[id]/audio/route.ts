import { NextResponse } from "next/server";
import { dbSaveAudio, dbGetAudioUrl } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = await dbGetAudioUrl(id);
  if (!url) return NextResponse.json({ error: "No audio" }, { status: 404 });
  return NextResponse.redirect(url);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No file" }, { status: 400 });
  }

  const url = await dbSaveAudio(id, file, file.name || "audio.wav");
  return NextResponse.json({ url });
}
