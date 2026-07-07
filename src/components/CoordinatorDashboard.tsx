"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type StepStatus = "pending" | "running" | "succeeded" | "failed";
type JobStatus = "pending" | "running" | "succeeded" | "failed";

interface JobStep {
  id: number;
  jobId: number;
  stepIndex: number;
  name: string;
  status: StepStatus;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

interface Job {
  id: number;
  name: string;
  status: JobStatus;
  progress: number;
  totalSteps: number;
  currentStep: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface JobDetail extends Job {
  steps: JobStep[];
}

const STATUS_STYLES: Record<JobStatus, string> = {
  pending: "bg-neutral-700 text-neutral-200",
  running: "bg-blue-600 text-white",
  succeeded: "bg-green-600 text-white",
  failed: "bg-red-600 text-white",
};

const STEP_STYLES: Record<StepStatus, string> = {
  pending: "text-neutral-500",
  running: "text-blue-400",
  succeeded: "text-green-400",
  failed: "text-red-400",
};

export default function CoordinatorDashboard() {
  const [plans, setPlans] = useState<string[]>([]);
  const [jobs, setJobs] = useState<JobDetail[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/coordinator", { cache: "no-store" });
      if (!res.ok) throw new Error(`List failed: ${res.status}`);
      const data = await res.json();
      setPlans(data.plans?.map((p: { name: string }) => p.name) ?? []);
      setJobs(data.jobs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadJob = useCallback(async (id: number) => {
    try {
      const res = await fetch(`/api/coordinator/${id}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setJobs((prev) => {
        const next = prev.filter((j) => j.id !== id);
        return [data.job as JobDetail, ...next].sort((a, b) => b.id - a.id);
      });
    } catch {
      /* ignore transient poll errors */
    }
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    const anyActive = jobs.some((j) => j.status === "running" || j.status === "pending");
    if (anyActive) {
      if (!timer.current) {
        timer.current = setInterval(() => {
          jobs.forEach((j) => {
            if (j.status === "running" || j.status === "pending") loadJob(j.id);
          });
        }, 800);
      }
    } else if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
    return () => {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, [jobs, loadJob]);

  const startJob = async (plan: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/coordinator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      if (!res.ok) throw new Error(`Start failed: ${res.status}`);
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-lg font-medium mb-3">Start a job</h2>
        <div className="flex flex-wrap gap-3">
          {plans.map((plan) => (
            <button
              key={plan}
              disabled={busy}
              onClick={() => startJob(plan)}
              className="rounded-md bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 px-4 py-2 text-sm font-medium border border-neutral-700"
            >
              {plan}
            </button>
          ))}
          {plans.length === 0 && (
            <span className="text-neutral-500 text-sm">Loading plans…</span>
          )}
        </div>
        {error && (
          <p className="mt-3 text-sm text-red-400" role="alert">
            {error}
          </p>
        )}
      </section>

      <section>
        <h2 className="text-lg font-medium mb-3">Jobs</h2>
        {jobs.length === 0 ? (
          <p className="text-neutral-500 text-sm">No jobs yet. Start one above.</p>
        ) : (
          <ul className="space-y-4">
            {jobs.map((job) => (
              <li
                key={job.id}
                className="rounded-lg border border-neutral-800 bg-neutral-800/40 p-4"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">#{job.id}</span>{" "}
                    <span className="text-neutral-300">{job.name}</span>
                  </div>
                  <span
                    className={`text-xs px-2 py-1 rounded-full font-medium ${STATUS_STYLES[job.status]}`}
                  >
                    {job.status}
                  </span>
                </div>

                <div className="mt-3 h-2 w-full rounded-full bg-neutral-700 overflow-hidden">
                  <div
                    className="h-full bg-blue-500 transition-all duration-500"
                    style={{ width: `${job.progress}%` }}
                  />
                </div>
                <div className="mt-1 text-xs text-neutral-400">
                  {job.progress}% · step {job.currentStep}/{job.totalSteps}
                </div>

                {job.error && (
                  <p className="mt-2 text-xs text-red-400">Error: {job.error}</p>
                )}

                {job.steps.length > 0 && (
                  <ul className="mt-3 space-y-1">
                    {job.steps.map((step) => (
                      <li
                        key={step.id}
                        className="flex items-center justify-between text-sm"
                      >
                        <span className={STEP_STYLES[step.status]}>
                          {step.status === "running" ? "▸ " : ""}
                          {step.name}
                        </span>
                        <span className={STEP_STYLES[step.status]}>{step.status}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
