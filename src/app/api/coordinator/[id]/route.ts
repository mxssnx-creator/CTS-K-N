import { NextResponse } from "next/server";
import { getJob, getSteps } from "@/lib/coordinator";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const jobId = Number(id);
    if (!Number.isInteger(jobId)) {
      return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
    }
    const job = await getJob(jobId);
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    const steps = await getSteps(jobId);
    return NextResponse.json({ job, steps });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
