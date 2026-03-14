import { NextResponse } from "next/server";
import { dbListRawBlobs, dbDeleteBlobByUrl } from "@/lib/db";

// GET: list all raw project blobs
export async function GET() {
  const blobs = await dbListRawBlobs();
  return NextResponse.json(blobs);
}

// DELETE: delete a blob by url (pass ?url=...)
export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get("url");
  if (!url) return NextResponse.json({ error: "url param required" }, { status: 400 });
  await dbDeleteBlobByUrl(url);
  return NextResponse.json({ ok: true });
}
