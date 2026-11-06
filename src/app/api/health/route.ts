import { db } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.query("SELECT 1");
    return Response.json(
      { ok: true },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return Response.json(
      { ok: false },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
