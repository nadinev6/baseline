"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const electronBinary = require("electron");
const environment = { ...process.env };

delete environment.ELECTRON_RUN_AS_NODE;

// Launch-time .env loader. Values already present in the real process
// environment always win. Fingerprinting PRESAGE_API_KEY (never the value)
// makes a stale .env copy visible against the portal's active key at launch.
const presageKeyFromProcessEnv = process.env.PRESAGE_API_KEY;
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  let loadedCount = 0;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const name = match[1];
    if (environment[name] !== undefined) continue;
    environment[name] = match[2].replace(/^["'](.*)["']$/, "$1");
    loadedCount += 1;
  }
  console.info(`[launch] loaded ${loadedCount} variable(s) from .env`);
} else {
  console.info("[launch] no .env file found");
}

const presageApiKey = environment.PRESAGE_API_KEY;
if (typeof presageApiKey === "string" && presageApiKey.length > 0) {
  const source = presageKeyFromProcessEnv !== undefined ? "process environment" : ".env";
  console.info(
    `[launch] PRESAGE_API_KEY fingerprint (${source}): ` +
      `${presageApiKey.slice(0, 2)}…${presageApiKey.slice(-2)} (${presageApiKey.length} chars)`,
  );
} else {
  console.warn(
    "[launch] PRESAGE_API_KEY is absent or empty in both the process environment and .env; " +
      "SmartSpectra telemetry will show api_key_required until a key is provided and the app is restarted. " +
      "Note: an empty \"$env:PRESAGE_API_KEY = ''\" assignment deletes the variable in PowerShell 5.1.",
  );
  delete environment.PRESAGE_API_KEY;
}

const child = spawn(electronBinary, [".", ...process.argv.slice(2)], {
  env: environment,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Could not launch Electron: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
