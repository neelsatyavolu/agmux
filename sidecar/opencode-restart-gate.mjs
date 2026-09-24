/**
 * Coordinates restarting the shared `opencode serve` with the turns running
 * on it.
 *
 * Local models are baked into serve's config at spawn, so installing one
 * means a restart. Every OpenCode chat shares that one server, and killing it
 * mid-turn ends those turns. The gate defers the restart until no turn is in
 * flight. Only a turn that needs the new config waits for it; other turns
 * keep using the running server.
 */
export function createRestartGate(restart) {
  let inFlight = 0;
  /** Waiters for a requested restart that hasn't started yet. */
  let pending = null;
  /** The restart currently running, if any. */
  let running = null;

  function maybeRun() {
    if (!pending || running || inFlight > 0) return;
    const waiters = pending;
    pending = null;
    running = (async () => {
      try {
        await restart();
        for (const w of waiters) w.resolve();
      } catch (err) {
        for (const w of waiters) w.reject(err);
      } finally {
        running = null;
        // A request that arrived mid-restart gets its own run.
        maybeRun();
      }
    })();
  }

  function join() {
    return new Promise((resolve, reject) => {
      if (!pending) pending = [];
      pending.push({ resolve, reject });
      maybeRun();
    });
  }

  return {
    /** Ask for a restart; resolves once it has completed. */
    request() {
      return join();
    },

    /** Resolves once no restart is running. Never rejects. */
    async settled() {
      while (running) await running.catch(() => {});
    },

    /**
     * Start a turn. With `needsRestart`, waits for the pending (or a new)
     * restart first; otherwise only for one already running.
     */
    async beginTurn(needsRestart = false) {
      if (needsRestart) await join();
      await this.settled();
      inFlight += 1;
    },

    endTurn() {
      inFlight = Math.max(0, inFlight - 1);
      maybeRun();
    },

    get inFlight() {
      return inFlight;
    },

    get restartPending() {
      return pending !== null || running !== null;
    },
  };
}
