// Shared polling loop for any Fabric job-instance-shaped status object
// ({ is_running, status, failure_reason, ... }) - used for both pipeline runs
// (PipelinesPage's own activeRun polling predates this file and isn't
// rewired to it) and the newer Fabric notebook insert jobs, which can sit at
// "InProgress" for a couple of minutes while Fabric spins up a Spark session
// before the actual work even starts.
export async function pollJob(fetchStatus, { intervalMs = 4000, onTick, maxAttempts = 150 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const run = await fetchStatus();
    onTick?.(run);
    if (!run.is_running) return run;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for the Fabric job to finish - check the Fabric portal directly.');
}
