/**
 * Kamori HTTP client.
 * Sends log events to a Kamori ingest server with automatic retry and backoff.
 */

export interface KamoriClientOptions {
  /** Base URL of your Kamori ingest server, e.g. https://kamori.yourserver.io */
  url: string;
  /** Auth token — must match INGEST_TOKEN set on the server */
  token?: string;
  /** Max events to buffer before flushing (default: 50) */
  batchSize?: number;
  /** Max ms to wait before flushing buffer (default: 2000) */
  flushInterval?: number;
  /**
   * When true, registers process exit / signal handlers (Node.js) or a
   * beforeunload listener (browser) so buffered events are flushed before
   * the runtime shuts down. Default: false.
   */
  flushOnExit?: boolean;
  /**
   * Controls automatic call-site capture appended as `_source` on each event.
   * - false (default): disabled
   * - true: always capture
   * - 'auto': capture when NODE_ENV !== 'production'
   */
  captureSource?: boolean | "auto";
  /**
   * When true, batches that fail all retries are spooled to localStorage
   * (browser only) and retried on the next successful send or when the
   * browser fires the `online` event (i.e. connectivity is restored).
   * Silently ignored in Node.js. Default: false.
   */
  offlineQueue?: boolean;
}

/** Delays in ms between successive retry attempts: 250ms → 1s → 4s */
const RETRY_DELAYS = [250, 1000, 4000] as const;

/**
 * Total byte cap for the localStorage offline queue (~40 % of the typical
 * 5 MB quota). The batch count cap (100) limits the number of entries but not
 * their size; without a byte guard a large backlog exhausts the quota and
 * subsequent writes throw silently.
 */
const QUEUE_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

type DropHandler = (events: Record<string, unknown>[]) => void;

/**
 * All KamoriClient instances that opted into flushOnExit.
 * Handlers are registered once and iterate over every registered client,
 * so multiple instances all get flushed on exit.
 */
const exitClients = new Set<KamoriClient>();
let exitHandlersRegistered = false;

export class KamoriClient {
  private readonly url: string;
  private readonly token?: string;
  private readonly batchSize: number;
  private readonly flushInterval: number;
  private readonly flushOnExit: boolean;
  private readonly captureSource: boolean | "auto";
  private readonly offlineQueue: boolean;
  private readonly QUEUE_KEY = "kamori_offline_queue";
  /** Internal event buffer; drained on every flush. */
  private buffer: Record<string, unknown>[] = [];
  /** Active debounce timer handle. */
  private timer?: ReturnType<typeof setTimeout>;
  private dropHandlers: DropHandler[] = [];

  constructor(opts: KamoriClientOptions) {
    // Validate URL eagerly — relative paths and non-HTTP protocols produce
    // cryptic fetch errors at flush time, far from the construction site.
    try {
      const parsed = new URL(opts.url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(
          `KamoriClient: url must use http or https, got "${parsed.protocol.slice(0, -1)}"`,
        );
      }
    } catch (err) {
      if (err instanceof TypeError) {
        throw new TypeError(
          `KamoriClient: invalid url "${opts.url}" — must be an absolute http/https URL`,
        );
      }
      throw err;
    }
    this.url = opts.url.replace(/\/$/, "");
    this.token = opts.token;
    this.batchSize = opts.batchSize ?? 50;
    this.flushInterval = opts.flushInterval ?? 2000;
    this.flushOnExit = opts.flushOnExit ?? false;
    this.captureSource = opts.captureSource ?? false;
    this.offlineQueue = opts.offlineQueue ?? false;

    if (this.flushOnExit) {
      this.registerExitHandlers();
    }

    if (this.offlineQueue && typeof window !== "undefined") {
      window.addEventListener("online", () => this.flushOfflineQueue());
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to the 'drop' event, fired when a batch is permanently
   * abandoned after all retry attempts are exhausted.
   */
  on(event: "drop", handler: DropHandler): this {
    if (event === "drop") this.dropHandlers.push(handler);
    return this;
  }

  /**
   * Queue a log event. Flushes automatically when the buffer is full or the
   * flush interval fires. If captureSource is enabled the call-site file and
   * line number are appended as `_source`.
   */
  log(event: Record<string, unknown>): void {
    // Optionally annotate the event with the call-site location.
    const eventToBuffer = this.shouldCaptureSource()
      ? { ...event, _source: this.getSource() }
      : event;

    this.buffer.push(eventToBuffer);

    if (this.buffer.length >= this.batchSize) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushInterval);
    }
  }

  /** Flush buffered events immediately. Fire-and-forget — never throws. */
  flush(): void {
    if (this.buffer.length === 0) return;
    const events = this.buffer.splice(0);
    clearTimeout(this.timer);
    this.timer = undefined;

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;

    this.sendWithRetry(events, headers, 0);
  }

  /**
   * Create a scoped client that merges default fields into every event.
   * The scoped client shares the same buffer and flush timer as the parent.
   * It does not create a new HTTP connection or retry queue.
   *
   * @example
   * const apiClient = client.scoped({ service: "api", tags: ["prod"] });
   * apiClient.log({ message: "request handled" });
   * // Logs: { service: "api", tags: ["prod"], message: "request handled" }
   */
  scoped(defaults: Record<string, unknown>): ScopedKamoriClient {
    return new ScopedKamoriClient(this, defaults);
  }

  /**
   * Flush remaining events and deregister this client from the module-level
   * exit handler set. Call this when a dynamically-created client is no longer
   * needed (e.g. after hot-module replacement or in test teardown) to prevent
   * the exitClients Set from accumulating stale references.
   */
  destroy(): void {
    this.flush();
    exitClients.delete(this);
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  // ---------------------------------------------------------------------------
  // captureSource helpers
  // ---------------------------------------------------------------------------

  /**
   * Determine whether source capture is active for the current environment.
   * Returns true when captureSource is `true`, or when it is `'auto'` and
   * NODE_ENV is not 'production'.
   */
  private shouldCaptureSource(): boolean {
    if (this.captureSource === false) return false;
    if (this.captureSource === true) return true;
    // 'auto' — capture outside of production
    const env =
      (typeof process !== "undefined" ? process.env?.NODE_ENV : undefined) ??
      "development";
    return env !== "production";
  }

  /**
   * Walk the current call stack and return the first frame that originates
   * outside KamoriClient (i.e. the actual call-site of `log()`).
   * Returns a string in the form "file:line", or null if parsing fails.
   */
  private getSource(): string | null {
    try {
      const stack = new Error().stack ?? "";
      const lines = stack.split("\n");
      // Skip frames that belong to this class or the Error constructor itself.
      for (const line of lines) {
        if (line.includes("KamoriClient") || line.includes("at new Error"))
          continue;
        // Match V8/Node.js formats:
        //   "    at functionName (file:line:col)"
        //   "    at file:line:col"
        const match =
          line.match(/\((.+):(\d+):\d+\)/) || line.match(/at (.+):(\d+):\d+/);
        if (match) {
          return `${match[1]}:${match[2]}`;
        }
      }
    } catch {
      // Stack trace parsing is best-effort — never let it break the caller.
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // flushOnExit helpers
  // ---------------------------------------------------------------------------

  /**
   * Register process-level (Node.js) or window-level (browser) handlers that
   * flush buffered events before the runtime exits.
   *
   * Handlers are registered once at the module level and iterate over all
   * registered clients, so every KamoriClient with flushOnExit:true is flushed
   * regardless of how many instances exist.
   */
  private registerExitHandlers(): void {
    exitClients.add(this);
    if (exitHandlersRegistered) return;
    exitHandlersRegistered = true;

    // ---- Node.js ----
    if (typeof process !== "undefined") {
      // 'exit' is synchronous; flush all clients best-effort.
      process.on("exit", () => {
        for (const client of exitClients) client.flushSync();
      });

      // SIGINT (Ctrl-C) — flush all clients, then exit after a 2 s grace period.
      process.on("SIGINT", () => {
        for (const client of exitClients) client.flush();
        setTimeout(() => process.exit(0), exitClients.size > 0 ? 2000 : 0);
      });

      // SIGTERM (e.g. docker stop) — same pattern as SIGINT.
      process.on("SIGTERM", () => {
        for (const client of exitClients) client.flush();
        setTimeout(() => process.exit(0), exitClients.size > 0 ? 2000 : 0);
      });
    }

    // ---- Browser ----
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => {
        for (const client of exitClients) client.flushSync();
      });
    }
  }

  /**
   * Synchronously flush buffered events (best-effort, for process.on('exit')
   * which is synchronous). In Node.js there is no true synchronous HTTP call,
   * so this method uses navigator.sendBeacon when available (browser) and
   * accepts potential data loss in Node.js on the synchronous 'exit' event.
   * The async SIGINT/SIGTERM handlers cover the common Node.js use-case.
   */
  private flushSync(): void {
    if (this.buffer.length === 0) return;
    const events = this.buffer.splice(0);
    clearTimeout(this.timer);
    this.timer = undefined;

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;

    // navigator.sendBeacon is the only sync-compatible network call in browsers.
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon(
        `${this.url}/v1/ingest`,
        new Blob([JSON.stringify(events)], { type: "application/json" }),
      );
    }
    // In Node.js: no true sync HTTP. Best-effort — data may be lost on 'exit'.
    // The SIGINT/SIGTERM handlers provide a better guarantee for Node.js.
  }

  // ---------------------------------------------------------------------------
  // Internal send / retry
  // ---------------------------------------------------------------------------

  private sendWithRetry(
    events: Record<string, unknown>[],
    headers: Record<string, string>,
    attempt: number,
  ): void {
    fetch(`${this.url}/v1/ingest`, {
      method: "POST",
      headers,
      body: JSON.stringify(events),
    })
      .then((res) => {
        if (res.ok) {
          // On success, drain any batches that were spooled while offline
          if (this.offlineQueue) this.flushOfflineQueue();
          return;
        }

        // 4xx — client error, retrying won't help
        if (res.status >= 400 && res.status < 500) {
          this.drop(events);
          return;
        }

        // 5xx — server error, retry if attempts remain
        this.scheduleRetry(events, headers, attempt);
      })
      .catch(() => {
        // Network error — retry if attempts remain
        this.scheduleRetry(events, headers, attempt);
      });
  }

  private scheduleRetry(
    events: Record<string, unknown>[],
    headers: Record<string, string>,
    attempt: number,
  ): void {
    if (attempt < RETRY_DELAYS.length) {
      setTimeout(
        () => this.sendWithRetry(events, headers, attempt + 1),
        RETRY_DELAYS[attempt],
      );
    } else {
      this.drop(events);
    }
  }

  private drop(events: Record<string, unknown>[]): void {
    if (this.offlineQueue) {
      this.spoolToLocalStorage(events);
    } else {
      for (const h of this.dropHandlers) h(events);
    }
  }

  // ---------------------------------------------------------------------------
  // MKR-78: Offline queue (browser localStorage)
  // ---------------------------------------------------------------------------

  /** Spool a failed batch to localStorage for retry on next successful send. */
  private spoolToLocalStorage(events: Record<string, unknown>[]): void {
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(this.QUEUE_KEY);
      const existing: Record<string, unknown>[][] = raw ? JSON.parse(raw) : [];
      existing.push(events);
      // First cap by count, then trim oldest batches until total bytes ≤ QUEUE_MAX_BYTES.
      // The count cap alone is insufficient — each batch can be large, and exceeding
      // the ~5 MB localStorage quota causes subsequent writes to throw silently.
      const batches = existing.slice(-100);
      let payload = JSON.stringify(batches);
      while (batches.length > 0 && payload.length > QUEUE_MAX_BYTES) {
        batches.shift();
        payload = JSON.stringify(batches);
      }
      if (batches.length > 0) {
        localStorage.setItem(this.QUEUE_KEY, payload);
      }
    } catch {
      // localStorage may be full or unavailable — silently ignore
    }
  }

  /**
   * Attempt to flush batches previously spooled to localStorage.
   * Called automatically after each successful send.
   */
  private flushOfflineQueue(): void {
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(this.QUEUE_KEY);
      if (!raw) return;
      const batches: Record<string, unknown>[][] = JSON.parse(raw);
      if (batches.length === 0) return;
      // Clear before retrying to prevent double-send on partial failure
      localStorage.removeItem(this.QUEUE_KEY);
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
      for (const batch of batches) {
        this.sendWithRetry(batch, headers, 0);
      }
    } catch {
      // Corrupted queue — clear it
      try {
        localStorage.removeItem(this.QUEUE_KEY);
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ScopedKamoriClient
// ---------------------------------------------------------------------------

/** A thin wrapper around KamoriClient that prepends default fields to every event. */
export class ScopedKamoriClient {
  /**
   * @param parent   The KamoriClient instance that owns the buffer and transport.
   * @param defaults Fields merged into every event logged through this scope.
   */
  constructor(
    private readonly parent: KamoriClient,
    private readonly defaults: Record<string, unknown>,
  ) {}

  /**
   * Log an event, merging parent defaults first. Fields passed directly to
   * this call override any matching default keys.
   */
  log(event: Record<string, unknown>): void {
    this.parent.log({ ...this.defaults, ...event });
  }

  /**
   * Create a nested scope, merging additional defaults on top of this scope's
   * defaults. The returned client still shares the same underlying KamoriClient
   * buffer and transport.
   */
  scoped(extraDefaults: Record<string, unknown>): ScopedKamoriClient {
    return new ScopedKamoriClient(this.parent, {
      ...this.defaults,
      ...extraDefaults,
    });
  }
}
