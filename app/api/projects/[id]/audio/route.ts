import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { dbGetAudioUrl, dbSetAudioUrl } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = await dbGetAudioUrl(id);
  if (!url) return NextResponse.json({ error: "No audio" }, { status: 404 });
  // Redirect to the blob URL
  return NextResponse.redirect(url);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No file" }, { status: 400 });
  }

  const blob = await put(`audio/${id}/${file.name || "audio.wav"}`, file, {
    access: "public",
    addRandomSuffix: false,
  });

  await dbSetAudioUrl(id, blob.url);
  return NextResponse.json({ url: blob.url });
}
