import { NextResponse } from "next/server";
import { dbSaveAudio, dbGetAudioUrl } from "@/lib/db";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const lane = Number(searchParams.get("lane") || "0");
  const url = await dbGetAudioUrl(id, lane);
  if (!url) return NextResponse.json({ error: "No audio" }, { status: 404 });
  return NextResponse.redirect(url);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const lane = Number(searchParams.get("lane") || "0");
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No file" }, { status: 400 });
  }

  const url = await dbSaveAudio(id, file, file.name || "audio.wav", lane);
  return NextResponse.json({ url });
}
