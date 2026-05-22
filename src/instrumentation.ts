export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Prevent duplicate startup during Next.js dev server hot-reloads
    const globalAny = globalThis as any;
    if (!globalAny.backgroundRunnerStarted) {
      globalAny.backgroundRunnerStarted = true;
      try {
        const { BackgroundRunner } = await import("@/server/background-runner");
        await BackgroundRunner.getInstance().start();
        console.log("[INSTRUMENTATION] Background runner started successfully.");
      } catch (error) {
        console.error("[INSTRUMENTATION] Failed to start Background runner:", error);
      }
    } else {
      console.log("[INSTRUMENTATION] Background runner already initialized. Skipping duplicate startup.");
    }
  }
}
