import { NextResponse } from "next/server";
import { createJob, listJobs, runJob, listPlans } from "@/lib/coordinator";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const items = await listJobs();
    return NextResponse.json({ jobs: items, plans: listPlans() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { plan?: string };
    const job = await createJob(body.plan ?? "");
    void runJob(job.id).catch((err) => {
      console.error(`[coordinator] background run for job ${job.id} failed`, err);
    });
    return NextResponse.json({ job }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
