/**
 * BioMint dashboard server.
 *
 * GET  /                    → public/dashboard.html
 * GET  /api/market/stats    → aggregated market statistics
 * GET  /api/market/listings → active dataset listings
 * GET  /api/market/ledger   → last 50 market events
 * GET  /api/attestations    → signed payment attestations
 * GET  /api/oracle/status   → oracle agent pubkey + health
 * POST /api/market/simulate → run one patient-session cycle, return updated stats
 *
 * On start: spawns oracleAgent.js as a child process on port 3100.
 * The oracle agent must sign every evaluation before payment is released.
 *
 * Usage: node src/serve.js [--port 3000]
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const DASHBOARD_PATH    = join(ROOT, "public", "dashboard.html");
const ATTESTATIONS_PATH = join(ROOT, "data", "attestations.ndjson");
const LISTINGS_PATH     = join(ROOT, "data", "market_listings.json");
const STATS_PATH        = join(ROOT, "data", "market_stats.json");
const LEDGER_PATH       = join(ROOT, "data", "market_ledger.ndjson");

const portArg = process.argv.indexOf("--port");
const PORT = portArg !== -1
  ? parseInt(process.argv[portArg + 1])
  : parseInt(process.env.PORT ?? "3000");

const ORACLE_PORT = parseInt(process.env.ORACLE_PORT ?? "3100");

// ── Oracle agent lifecycle ────────────────────────────────────────────────────

let oracleProc = null;
let oraclePubkey = null;
let oracleReady  = false;

function spawnOracleAgent() {
  const env = { ...process.env, ORACLE_PORT: String(ORACLE_PORT) };
  oracleProc = spawn(process.execPath, [join(ROOT, "src", "oracleAgent.js")], {
    cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
  });

  oracleProc.stdout.on("data", (chunk) => {
    const line = chunk.toString().trim();
    process.stdout.write(`  [oracle] ${line}\n`);
    // Parse pubkey from the agent's startup line
    const m = line.match(/pubkey=([0-9a-f]+)/);
    if (m) {
      oraclePubkey = m[1];
      oracleReady  = true;
    }
  });

  oracleProc.stderr.on("data", (chunk) => {
    process.stderr.write(`  [oracle:err] ${chunk.toString().trim()}\n`);
  });

  oracleProc.on("exit", (code) => {
    oracleReady = false;
    process.stderr.write(`  [oracle] exited (code=${code}) — restarting in 2s\n`);
    setTimeout(spawnOracleAgent, 2000);
  });
}

spawnOracleAgent();

// Ensure oracle is killed when serve.js exits
process.on("exit",    () => oracleProc?.kill());
process.on("SIGINT",  () => { oracleProc?.kill(); process.exit(0); });
process.on("SIGTERM", () => { oracleProc?.kill(); process.exit(0); });

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readJSON(path, fallback = {}) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return fallback; }
}
async function readNDJSON(path, n = 50) {
  try {
    const raw = await readFile(path, "utf8");
    return raw.split("\n").filter(l => l.trim()).map(l => JSON.parse(l)).slice(-n).reverse();
  } catch { return []; }
}

async function handler(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (data, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(data));
  };

  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFile(DASHBOARD_PATH, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (url.pathname === "/api/market/stats")    return json(await readJSON(STATS_PATH));
    if (url.pathname === "/api/market/listings") {
      const all = await readJSON(LISTINGS_PATH, {});
      return json(Object.values(all).filter(l => l.status === "LISTED"));
    }
    if (url.pathname === "/api/market/ledger")   return json(await readNDJSON(LEDGER_PATH));
    if (url.pathname === "/api/attestations")    return json(await readNDJSON(ATTESTATIONS_PATH, 100));

    // Oracle agent status endpoint
    if (url.pathname === "/api/oracle/status") {
      return json({ ready: oracleReady, oraclePubkey, oraclePort: ORACLE_PORT });
    }

    // On-chain program info
    if (url.pathname === "/api/program/info") {
      return json({
        programId:   "BMint1111111111111111111111111111111111111111",
        network:     "devnet",
        explorer:    "https://explorer.solana.com/address/BMint1111111111111111111111111111111111111111?cluster=devnet",
        txExplorer:  "https://explorer.solana.com/tx/{txid}?cluster=devnet",
        note:        "Program deployed as skeleton; settlement logic verified off-chain with oracle agent signatures.",
      });
    }

    if (url.pathname === "/api/market/simulate" && req.method === "POST") {
      if (!oracleReady) {
        return json({ ok: false, error: "Oracle agent not ready — payments require agent signature" }, 503);
      }
      try {
        const env = { ...process.env, ORACLE_PORT: String(ORACLE_PORT) };
        await execFileAsync(process.execPath,
          [join(ROOT, "src", "demoClinical.js"), "--keep-state"],
          { cwd: ROOT, env, timeout: 30_000 }
        );
        return json({
          ok: true,
          stats:        await readJSON(STATS_PATH),
          listingCount: Object.keys(await readJSON(LISTINGS_PATH, {})).length,
        });
      } catch (err) {
        return json({ ok: false, error: err.message }, 500);
      }
    }

    res.writeHead(404); res.end("Not found");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(err.message);
  }
}

const server = createServer(handler);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`BioMint dashboard → http://localhost:${PORT}`);
  console.log(`API               → http://localhost:${PORT}/api/market/stats`);
  console.log(`Oracle agent      → port ${ORACLE_PORT} (spawning…)`);
});
