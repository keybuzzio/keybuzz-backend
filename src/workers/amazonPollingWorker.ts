// src/workers/amazonPollingWorker.ts

import { pollAmazonForAllTenants } from "../modules/marketplaces/amazon/amazon.poller";

const POLL_INTERVAL_SECONDS = Number(
  process.env.KEYBUZZ_AMAZON_POLL_INTERVAL_SECONDS || "60"
);

/**
 * Run polling once
 */
async function runOnce() {
  console.log(
    `[Amazon Polling Worker] Starting poll at ${new Date().toISOString()}`
  );

  try {
    await pollAmazonForAllTenants();
    console.log(
      `[Amazon Polling Worker] Poll completed successfully at ${new Date().toISOString()}`
    );
  } catch (error) {
    console.error("[Amazon Polling Worker] Poll failed:", error);
  }
}

/**
 * Run polling in loop
 */
async function runLoop() {
  console.log(
    `[Amazon Polling Worker] Starting continuous polling every ${POLL_INTERVAL_SECONDS}s`
  );

  while (true) {
    await runOnce();
    console.log(
      `[Amazon Polling Worker] Waiting ${POLL_INTERVAL_SECONDS}s before next poll...`
    );
    // eslint-disable-next-line no-undef
    await new Promise((resolve) =>
      setTimeout(resolve, POLL_INTERVAL_SECONDS * 1000)
    );
  }
}

/**
 * Main entry point
 */
async function main() {
  const isOnceMode = process.argv.includes("--once");

  if (isOnceMode) {
    console.log("[Amazon Polling Worker] Running in ONCE mode");
    await runOnce();
    process.exit(0);
  } else {
    console.log("[Amazon Polling Worker] Running in LOOP mode");
    await runLoop();
  }
}

// Handle graceful shutdown
process.on("SIGTERM", () => {
  console.log("[Amazon Polling Worker] SIGTERM received, shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[Amazon Polling Worker] SIGINT received, shutting down...");
  process.exit(0);
});

// Run
main().catch((err) => {
  console.error("[Amazon Polling Worker] Fatal error:", err);
  process.exit(1);
});

