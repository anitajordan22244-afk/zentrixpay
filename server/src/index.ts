// Must load before anything else so HTTP/Express/fetch instrumentation can
// patch those modules before they're used (#307). A `node --import` preload
// (see package.json) would guarantee strict ordering; this is the pragmatic
// version for a `tsx`-run dev/prod entrypoint.
import "./tracing.js";
import type { Server } from "node:http";
import { config } from "./config.js";
import { initSentry, captureServerException } from "./lib/sentry.js";
import { createApp } from "./app.js";
import { rootLogger } from "./lib/logger.js";
import {
  beginShutdown,
  whenDrained,
  whenProxyCallsSettled,
  inFlightCount,
  proxyCallCount,
} from "./lib/lifecycle.js";
import { pgClient } from "./db/client.js";
import { startPoolMetrics, stopPoolMetrics } from "./db/client.js";
import { startHealthCheckWorker, stopHealthCheckWorker } from "./workers/healthCheckWorker.js";
import { startPriceChangeWorker, stopPriceChangeWorker } from "./workers/priceChangeWorker.js";
import {
  startWebhookDeliveryWorker,
  stopWebhookDeliveryWorker,
} from "./workers/webhookDeliveryWorker.js";
import {
  startApiCallRetentionWorker,
  stopApiCallRetentionWorker,
} from "./workers/apiCallRetentionWorker.js";
import {
  startApiCallRecoveryWorker,
  stopApiCallRecoveryWorker,
} from "./workers/apiCallRecoveryWorker.js";
import { closeRateLimitStore } from "./lib/rateLimit/index.js";

initSentry();

const app = createApp();

const server: Server = app.listen(config.PORT, () => {
  rootLogger.info(
    {
      event: "server_start",
      port: config.PORT,
      network: config.NETWORK,
      healthUrl: `http://localhost:${config.PORT}/health`,
    },
    "ZentrixPay server started",
  );

  if (config.RUN_BACKGROUND_WORKERS) {
    startHealthCheckWorker();
    startPriceChangeWorker();
    startApiCallRetentionWorker();
    startApiCallRecoveryWorker();
    startWebhookDeliveryWorker();
  } else {
    rootLogger.info(
      { event: "background_workers_disabled" },
      "RUN_BACKGROUND_WORKERS=false; background workers not started on this instance",
    );
  }
  startPoolMetrics();
});

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  stopHealthCheckWorker();
  stopPriceChangeWorker();
  stopApiCallRetentionWorker();
  stopApiCallRecoveryWorker();
  stopWebhookDeliveryWorker();
  stopPoolMetrics();

  // Stop passing readiness checks so load balancers drain us before we close.
  beginShutdown();
  rootLogger.info(
    { event: "shutdown_start", signal, inFlight: inFlightCount() },
    "graceful shutdown started",
  );

  // Stop accepting new connections; existing ones keep being served.
  server.close();

  // Wait for in-flight requests to finish, bounded by the configured grace period.
  let timedOut = false;
  let drainTimer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<void>((resolve) => {
    drainTimer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, config.GRACEFUL_SHUTDOWN_TIMEOUT_MS);
  });

  // Paid calls must finish settling before the pool closes, so wait for them
  // under the same bound as ordinary requests (issue #216).
  await Promise.race([Promise.all([whenDrained(), whenProxyCallsSettled()]), deadline]);
  clearTimeout(drainTimer!);

  const stillRunning = inFlightCount() > 0 || proxyCallCount() > 0;
  if (timedOut && stillRunning) {
    rootLogger.warn(
      { event: "shutdown_drain_timeout", inFlight: inFlightCount(), proxyCalls: proxyCallCount() },
      "drain timed out with requests still in flight; forcing close",
    );
  }

  try {
    await closeRateLimitStore();
    await pgClient.end({ timeout: 5 });
    const forced = timedOut && stillRunning;
    rootLogger.info({ event: "shutdown_complete", signal, forced }, "graceful shutdown complete");
    process.exit(forced ? 1 : 0);
  } catch (err) {
    rootLogger.error({ event: "shutdown_error", err }, "error closing database pool");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  rootLogger.error({ event: "unhandled_rejection", reason }, "unhandled promise rejection");
  captureServerException(reason instanceof Error ? reason : new Error(String(reason)));
});

process.on("uncaughtException", (err) => {
  rootLogger.error({ event: "uncaught_exception", err }, "uncaught exception");
  captureServerException(err);
});
