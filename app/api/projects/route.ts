import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { dbGetProjectList, dbCreateProject } from "@/lib/db";

export async function GET() {
  const list = await dbGetProjectList();
  return NextResponse.json(list);
}

export async function POST(req: Request) {
  const { name, mode } = await req.json();
  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "Name required" }, { status: 400 });
  }
  const id = nanoid(10);
  const project = await dbCreateProject(id, name.trim(), mode === "advanced" ? "advanced" : "basic");
  return NextResponse.json(project);
}
