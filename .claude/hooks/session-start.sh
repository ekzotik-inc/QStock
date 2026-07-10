#!/bin/bash
# SessionStart hook for Claude Code on the web: install project deps + rtk.
# Container state is cached after the hook completes, so heavy steps (cargo
# build of rtk) only pay their cost once per environment.
set -euo pipefail

# Only needed in remote (web) sessions — local machines manage their own setup.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# --- project dependencies (browsers are pre-installed at /opt/pw-browsers) ---
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm install --no-audit --no-fund

# --- rtk (Rust Token Killer): compact command output, 60-90% token savings ---
# Optional: never fail the session because of it.
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
if ! command -v rtk >/dev/null 2>&1; then
  echo "[hook] installing rtk…"
  installed=false
  # 1) prebuilt binary (fast) — may be blocked by the network policy
  if curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh -o /tmp/rtk-install.sh 2>/dev/null; then
    if RTK_VERSION=v0.43.0 sh /tmp/rtk-install.sh >/dev/null 2>&1 || sh /tmp/rtk-install.sh >/dev/null 2>&1; then
      installed=true
    fi
  fi
  # 2) fall back to building from source when cargo is available
  if [ "$installed" != "true" ] && command -v cargo >/dev/null 2>&1; then
    cargo install --git https://github.com/rtk-ai/rtk >/dev/null 2>&1 || true
  fi
fi

if command -v rtk >/dev/null 2>&1; then
  # auto-rewrite hook (git status -> rtk git status) for this container
  rtk init -g >/dev/null 2>&1 || true
  echo "[hook] rtk $(rtk --version) ready"
else
  echo "[hook] rtk unavailable (install blocked) — continuing without it"
fi

# make rtk visible to the session's shell
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
  echo 'export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1' >> "$CLAUDE_ENV_FILE"
fi

echo "[hook] session setup complete"
