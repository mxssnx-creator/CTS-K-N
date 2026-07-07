import { db, ensureDatabase } from "@/db";
import { jobs, jobSteps, type Job, type JobStep, type JobStatus, type StepStatus } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export class CoordinatorError extends Error {
  constructor(message: string, readonly step?: string) {
    super(message);
    this.name = "CoordinatorError";
  }
}

export interface StepContext {
  jobId: number;
  jobName: string;
}

export type StepHandler = (ctx: StepContext) => Promise<void>;

/**
 * The coordinator plans are named sequences of steps. Each step is a registered
 * handler. The coordinator runs them in order, persisting progression so a
 * crashed/hung request can be observed and resumed from the database.
 */
const STEP_REGISTRY: Record<string, StepHandler> = {
  async validate(ctx) {
    const ok = typeof ctx.jobName === "string" && ctx.jobName.length > 0;
    if (!ok) throw new CoordinatorError("Validation failed: job name is empty", "validate");
  },

  async transform(ctx) {
    const rows = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.id, ctx.jobId))
      .limit(1);
    if (!rows.length) throw new CoordinatorError("Transform failed: job record missing", "transform");
  },

  async aggregate() {
    await db.select({ id: jobs.id }).from(jobs).limit(1);
  },

  async finalize(ctx) {
    const recent = await db
      .select({ id: jobs.id })
      .from(jobs)
      .orderBy(desc(jobs.createdAt))
      .limit(5);
    if (!recent.some((r: { id: number }) => r.id === ctx.jobId)) {
      throw new CoordinatorError("Finalize failed: job not found in recent set", "finalize");
    }
  },
};

export interface Plan {
  name: string;
  steps: string[];
}

async function patchJob(jobId: number, values: Partial<Job>): Promise<void> {
  await db
    .update(jobs)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(jobs.id, jobId));
}

async function patchStep(stepId: number, status: StepStatus, error?: string): Promise<void> {
  await db
    .update(jobSteps)
    .set({
      status,
      error,
      startedAt: status === "running" ? new Date() : undefined,
      finishedAt: status === "succeeded" || status === "failed" ? new Date() : undefined,
    })
    .where(eq(jobSteps.id, stepId));
}

export function listPlans(): Plan[] {
  return [
    { name: "Standard pipeline", steps: ["validate", "transform", "aggregate", "finalize"] },
    { name: "Quick pipeline", steps: ["validate", "finalize"] },
  ];
}

export async function createJob(planName: string): Promise<Job> {
  await ensureDatabase();
  const plan = listPlans().find((p) => p.name === planName) ?? listPlans()[0];

  const [job] = await db
    .insert(jobs)
    .values({
      name: plan.name,
      status: "pending",
      progress: 0,
      totalSteps: plan.steps.length,
      currentStep: 0,
    })
    .returning();

  await db.insert(jobSteps).values(
    plan.steps.map((name, index) => ({
      jobId: job.id,
      stepIndex: index,
      name,
      status: "pending" as StepStatus,
    })),
  );

  return job;
}

/**
 * Runs a job to completion. Any failure is recorded against the job and its
 * current step rather than thrown to the caller, so the coordinator never
 * crashes the server process. Safe to run detached in the background.
 */
export async function runJob(jobId: number): Promise<void> {
  await ensureDatabase();

  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) {
    console.error(`[coordinator] job ${jobId} not found`);
    return;
  }

  const steps = await db
    .select()
    .from(jobSteps)
    .where(eq(jobSteps.jobId, jobId))
    .orderBy(jobSteps.stepIndex);

  try {
    await patchJob(jobId, { status: "running" });

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const handler = STEP_REGISTRY[step.name];

      if (!handler) {
        throw new CoordinatorError(`Unknown step: ${step.name}`, step.name);
      }

      await patchStep(step.id, "running");

      try {
        await handler({ jobId, jobName: job.name });
        await patchStep(step.id, "succeeded");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await patchStep(step.id, "failed", message);
        throw new CoordinatorError(`Step "${step.name}" failed: ${message}`, step.name);
      }

      const completed = i + 1;
      const progress = Math.round((completed / steps.length) * 100);
      await patchJob(jobId, { currentStep: completed, progress });
    }

    await patchJob(jobId, { status: "succeeded", progress: 100 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[coordinator] job ${jobId} failed: ${message}`);
    const current = await db
      .select()
      .from(jobSteps)
      .where(eq(jobSteps.jobId, jobId))
      .orderBy(jobSteps.stepIndex);
    const lastRunning = [...current].reverse().find((s) => s.status === "failed");
    await patchJob(jobId, {
      status: "failed",
      error: lastRunning?.error ?? message,
    });
  }
}

export async function getJob(jobId: number): Promise<Job | undefined> {
  await ensureDatabase();
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  return job;
}

export async function getSteps(jobId: number) {
  await ensureDatabase();
  return db
    .select()
    .from(jobSteps)
    .where(eq(jobSteps.jobId, jobId))
    .orderBy(jobSteps.stepIndex);
}

export async function listJobs(limit = 20): Promise<Job[]> {
  await ensureDatabase();
  return db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(limit);
}

export type { Job, JobStep, JobStatus, StepStatus };
