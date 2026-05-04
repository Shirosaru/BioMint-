import fs from "node:fs";
import path from "node:path";
import { createDefaultState } from "./types.js";
import { CONFIG } from "./config.js";

const statePath = path.resolve(new URL("policy_state.json", CONFIG.dataDir).pathname);

export function loadState() {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    return JSON.parse(raw);
  } catch {
    const initial = createDefaultState();
    saveState(initial);
    return initial;
  }
}

export function saveState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function getStatePath() {
  return statePath;
}

export function resetState() {
  const initial = createDefaultState();
  saveState(initial);
  return initial;
}
