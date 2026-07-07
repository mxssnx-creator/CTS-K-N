import CoordinatorDashboard from "@/components/CoordinatorDashboard";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main className="min-h-screen bg-neutral-900 text-neutral-100">
      <div className="max-w-5xl mx-auto px-4 py-10">
        <header className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight">Coordinator</h1>
          <p className="mt-2 text-neutral-400">
            Orchestrates multi-step jobs with reliable progression tracking. Runs
            identically in development and production.
          </p>
        </header>
        <CoordinatorDashboard />
      </div>
    </main>
  );
}
