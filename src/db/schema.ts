import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export type JobStatus = "pending" | "running" | "succeeded" | "failed";
export type StepStatus = "pending" | "running" | "succeeded" | "failed";

export const jobs = sqliteTable("jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  status: text("status", { enum: ["pending", "running", "succeeded", "failed"] })
    .notNull()
    .default("pending"),
  progress: integer("progress").notNull().default(0),
  totalSteps: integer("total_steps").notNull().default(0),
  currentStep: integer("current_step").notNull().default(0),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const jobSteps = sqliteTable("job_steps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("job_id")
    .notNull()
    .references(() => jobs.id, { onDelete: "cascade" }),
  stepIndex: integer("step_index").notNull(),
  name: text("name").notNull(),
  status: text("status", { enum: ["pending", "running", "succeeded", "failed"] })
    .notNull()
    .default("pending"),
  error: text("error"),
  startedAt: integer("started_at", { mode: "timestamp" }),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
});

export type Job = typeof jobs.$inferSelect;
export type JobStep = typeof jobSteps.$inferSelect;
