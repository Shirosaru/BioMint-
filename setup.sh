#!/usr/bin/env bash
# =============================================================================
# agentic-mint-guard — one-command judge / developer setup
#
# Usage:
#   ./setup.sh            # install deps + generate keypair + airdrop + run demo
#   ./setup.sh --deploy   # also install Solana+Anchor CLI, build + deploy program
#   ./setup.sh --loop     # after setup, start the autonomous loop (dry-run)
#   ./setup.sh --full     # deploy + loop with swaps + wormhole enabled
#
# Environment overrides:
#   SOLANA_RPC_URL        default: https://api.devnet.solana.com
#   ANCHOR_SKIP_BUILD     set to skip anchor build (use if already compiled)
# =============================================================================
set -euo pipefail

DEPLOY=false
LOOP=false
FULL=false
for arg in "$@"; do
  [[ "$arg" == "--deploy" ]] && DEPLOY=true
  [[ "$arg" == "--loop"   ]] && LOOP=true
  [[ "$arg" == "--full"   ]] && FULL=true && DEPLOY=true && LOOP=true
done

YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'
RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}[setup]${NC} $*"; }
success() { echo -e "${GREEN}[ok]${NC} $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC} $*"; }
die()     { echo -e "${RED}[err]${NC} $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

echo ""
echo -e "${BOLD}${YELLOW}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${YELLOW}║   agentic-mint-guard — hackathon setup           ║${NC}"
echo -e "${BOLD}${YELLOW}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# ── 1. Node deps ──────────────────────────────────────────────────────────────
info "Installing Node.js dependencies..."
npm install --silent 2>/dev/null || npm install
success "npm install done"

# ── 2. Solana CLI (only if --deploy) ──────────────────────────────────────────
if [[ "$DEPLOY" == "true" ]]; then
  if ! command -v solana &>/dev/null; then
    info "Installing Solana CLI..."
    if sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)" 2>&1 | grep -q "Update successful\|already"; then
      export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
      success "Solana CLI installed: $(solana --version 2>/dev/null || echo '(reload shell to use)')"
    else
      warn "Solana CLI install may still be running — check manually with 'solana --version'"
    fi
  else
    success "Solana CLI: $(solana --version)"
  fi

  # ── 3. Anchor CLI ───────────────────────────────────────────────────────────
  if ! command -v anchor &>/dev/null; then
    info "Installing Anchor CLI via cargo (this may take several minutes)..."
    if command -v cargo &>/dev/null; then
      # Ensure stable Rust is installed — required for edition2024 manifests
      # (cargo build-sbf fails on nightly < 1.85 due to toml_edit 0.25+)
      if rustup toolchain list 2>/dev/null | grep -q "^stable"; then
        rustup default stable 2>/dev/null || true
      else
        warn "Installing stable Rust toolchain (required for Anchor build)..."
        rustup toolchain install stable --no-self-update 2>/dev/null || true
        rustup default stable 2>/dev/null || true
      fi
      # Install anchor-cli using stable toolchain
      if cargo +stable install --git https://github.com/coral-xyz/anchor --tag v0.30.1 anchor-cli --locked 2>&1 | grep -q "Installed\|warning:\|Finished"; then
        export PATH="$HOME/.cargo/bin:$PATH"
      fi
      if command -v anchor &>/dev/null; then
        success "Anchor CLI: $(anchor --version)"
      else
        warn "Anchor CLI not on PATH. Try: cargo +stable install --git https://github.com/coral-xyz/anchor --tag v0.30.1 anchor-cli --locked"
      fi
    else
      warn "cargo not found — install Rust first: https://rustup.rs"
      warn "Then re-run: ./setup.sh --deploy"
    fi
  else
    success "Anchor CLI: $(anchor --version)"
  fi
fi

# ── 4. Keypair ────────────────────────────────────────────────────────────────
KEYPAIR_FILE="$SCRIPT_DIR/data/admin-keypair.json"
mkdir -p "$SCRIPT_DIR/data"

if [[ ! -f "$KEYPAIR_FILE" ]]; then
  info "Generating admin keypair at $KEYPAIR_FILE..."
  if command -v solana-keygen &>/dev/null; then
    solana-keygen new --outfile "$KEYPAIR_FILE" --no-bip39-passphrase --silent
    success "Keypair generated (solana-keygen)"
  else
    # Node.js fallback — no solana-keygen required
    node --input-type=module <<'NODEEOF'
import { Keypair } from "@solana/web3.js";
import { writeFileSync } from "node:fs";
const kp = Keypair.generate();
writeFileSync(process.env.KEYPAIR_FILE_PATH, JSON.stringify(Array.from(kp.secretKey)));
console.log("Generated keypair. Public key:", kp.publicKey.toBase58());
NODEEOF
    success "Keypair generated (node fallback)"
  fi
else
  info "Using existing keypair: $KEYPAIR_FILE"
fi

# Read public key
ADMIN_PUBKEY=$(KEYPAIR_FILE_PATH="$KEYPAIR_FILE" node --input-type=module <<'NODEEOF'
import { Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.KEYPAIR_FILE_PATH, "utf8"))));
process.stdout.write(kp.publicKey.toBase58());
NODEEOF
)
info "Admin pubkey: $ADMIN_PUBKEY"
export ADMIN_KEYPAIR_JSON="$(cat "$KEYPAIR_FILE")"
export SOLANA_RPC_URL="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"

# ── 5. Airdrop SOL (devnet only) ──────────────────────────────────────────────
if [[ "$SOLANA_RPC_URL" == *"devnet"* ]]; then
  info "Requesting devnet airdrop for $ADMIN_PUBKEY..."
  if command -v solana &>/dev/null; then
    solana airdrop 2 "$ADMIN_PUBKEY" --url "$SOLANA_RPC_URL" 2>/dev/null && \
      success "Airdrop: 2 SOL received" || warn "Airdrop failed (rate-limited) — retry: solana airdrop 2 $ADMIN_PUBKEY --url devnet"
  else
    # JSON-RPC fallback
    AIRDROP_RESP=$(curl -s -X POST "$SOLANA_RPC_URL" \
      -H "Content-Type: application/json" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"requestAirdrop\",\"params\":[\"$ADMIN_PUBKEY\",2000000000]}" 2>/dev/null || echo "")
    if echo "$AIRDROP_RESP" | grep -q '"result"'; then
      success "Airdrop requested"
    else
      warn "Airdrop unavailable — fund manually: https://faucet.solana.com/?wallet=$ADMIN_PUBKEY"
    fi
  fi
fi

# ── 6. Build + deploy Anchor program ─────────────────────────────────────────
POLICY_STATE_ADDRESS=""
if [[ "$DEPLOY" == "true" ]] && [[ -z "${ANCHOR_SKIP_BUILD:-}" ]]; then
  echo ""
  info "Building Anchor program..."

  if ! command -v anchor &>/dev/null; then
    warn "anchor not found — skipping on-chain deploy."
    warn "Install: cargo install --git https://github.com/coral-xyz/anchor avm --locked"
    warn "Then:    avm install latest && avm use latest"
  elif [[ ! -f "Anchor.toml" ]]; then
    warn "Anchor.toml not found — skipping deploy."
  else
    # Ensure program keypair is set
    PROG_KEYPAIR="programs/policy-registry/keypair.json"
    if [[ ! -f "$PROG_KEYPAIR" ]]; then
      if command -v solana-keygen &>/dev/null; then
        solana-keygen new --outfile "$PROG_KEYPAIR" --no-bip39-passphrase --silent
      else
        KEYPAIR_FILE_PATH="$PROG_KEYPAIR" node --input-type=module <<'NODEEOF'
import { Keypair } from "@solana/web3.js";
import { writeFileSync } from "node:fs";
const kp = Keypair.generate();
writeFileSync(process.env.KEYPAIR_FILE_PATH, JSON.stringify(Array.from(kp.secretKey)));
NODEEOF
      fi
    fi

    ANCHOR_CMD="anchor"
    if rustup toolchain list 2>/dev/null | grep -q "^stable"; then
      ANCHOR_CMD="rustup run stable anchor"
      info "Using stable Rust toolchain for Anchor build/deploy"
    fi

    if eval "$ANCHOR_CMD build" 2>&1 | tail -4; then
      success "Anchor build complete"

      CLUSTER="${SOLANA_RPC_URL:-devnet}"
      [[ "$CLUSTER" == *"127.0.0.1"* || "$CLUSTER" == *"localhost"* ]] && CLUSTER="localnet" || CLUSTER="devnet"

      if eval "$ANCHOR_CMD deploy --provider.cluster \"$CLUSTER\" --program-keypair \"$PROG_KEYPAIR\"" 2>&1 | tee /tmp/anchor_deploy.txt | tail -8; then
        PROGRAM_ID=$(grep -oP 'Program Id: \K\S+' /tmp/anchor_deploy.txt || echo "")
        if [[ -n "$PROGRAM_ID" ]]; then
          POLICY_STATE_ADDRESS="$PROGRAM_ID"
          export POLICY_STATE_ADDRESS
          echo "POLICY_STATE_ADDRESS=$PROGRAM_ID" >> "$SCRIPT_DIR/.env.deploy"
          success "Program deployed: $PROGRAM_ID"
          [[ "$CLUSTER" == "devnet" ]] && success "Explorer: https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet"
        fi
      else
        warn "anchor deploy failed — check balance and Anchor.toml"
      fi
    else
      warn "anchor build failed — check Rust toolchain + anchor-lang version"
    fi
  fi
fi

# ── 7. Run JS smoke test (on-chain if deployed, else offline) ─────────────────
echo ""
if [[ -n "$POLICY_STATE_ADDRESS" ]]; then
  info "Running on-chain integration tests..."
  POLICY_PROGRAM_ID="$POLICY_STATE_ADDRESS" node tests/policy_registry.test.js && \
    success "On-chain tests passed" || warn "Some on-chain tests failed — see output above"
fi

# ── 8. Run demo (always) ──────────────────────────────────────────────────────
info "Running 4-scenario stress demo..."
node src/demo.js
echo ""

# ── 9. Print summary ──────────────────────────────────────────────────────────
echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
echo -e "${GREEN} Setup complete!${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
echo ""
echo "  Admin pubkey:    $ADMIN_PUBKEY"
echo "  RPC:             $SOLANA_RPC_URL"
[[ -n "$POLICY_STATE_ADDRESS" ]] && echo "  Policy program:  $POLICY_STATE_ADDRESS"
echo ""
echo "  Commands:"
echo "    npm run demo            — 4-scenario offline stress test"
echo "    npm run agent:loop:dry  — live oracle loop, no on-chain tx"
echo "    npm run agent:loop:full — live oracle + swaps + wormhole"
echo "    npm run dashboard       — attestation dashboard on :3000"
echo "    npm run mcp             — MCP stdio server"
[[ -n "$POLICY_STATE_ADDRESS" ]] && \
echo "    node tests/policy_registry.test.js  — on-chain integration tests"
echo ""
[[ -n "$POLICY_STATE_ADDRESS" ]] && \
echo "  Full-mode env vars (copy into your shell):"
[[ -n "$POLICY_STATE_ADDRESS" ]] && \
cat <<ENV
    export ADMIN_KEYPAIR_JSON='$(cat "$KEYPAIR_FILE" | head -c 120)...'
    export POLICY_STATE_ADDRESS='$POLICY_STATE_ADDRESS'
    export SOLANA_RPC_URL='$SOLANA_RPC_URL'
    export USE_WORMHOLE_COLLATERAL=true
    export USE_SWAPS=true
ENV

# ── 10. Start loop (optional) ─────────────────────────────────────────────────
if [[ "$FULL" == "true" ]]; then
  info "Starting full autonomous loop (USE_WORMHOLE + USE_SWAPS)..."
  USE_WORMHOLE_COLLATERAL=true USE_SWAPS=true node src/loop.js --reset
elif [[ "$LOOP" == "true" ]]; then
  info "Starting dry-run loop (Ctrl-C to stop)..."
  node src/loop.js --dry-run --reset
fi


