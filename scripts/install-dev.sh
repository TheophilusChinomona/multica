#!/usr/bin/env bash
# Multica local development installer
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/TheophilusChinomona/multica/main/scripts/install-dev.sh | bash
#
# Options:
#   --dir <path>         Install directory (default: ~/multica)
#   --branch <name>      Branch to check out (default: main)
#   --no-start           Install only, don't start services
#   --skip-deps          Skip prerequisite checks (if you know they're installed)
#   --port <port>        Backend port (default: 8080)
#   --frontend-port <p>  Frontend port (default: 3000)
#   --postgres-port <p>  Postgres port (default: 5432)
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
REPO_URL="https://github.com/TheophilusChinomona/multica.git"
INSTALL_DIR="${MULTICA_INSTALL_DIR:-$HOME/multica}"
BRANCH="main"
START_SERVICES=true
SKIP_DEPS=false
PORT=8080
FRONTEND_PORT=3000
POSTGRES_PORT=5432

# Colors
if [ -t 1 ] || [ -t 2 ]; then
  BOLD='\033[1m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  RED='\033[0;31m'
  CYAN='\033[0;36m'
  DIM='\033[2m'
  RESET='\033[0m'
else
  BOLD='' GREEN='' YELLOW='' RED='' CYAN='' DIM='' RESET=''
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { printf "${BOLD}${CYAN}==> %s${RESET}\n" "$*"; }
ok()    { printf "${BOLD}${GREEN}  ✓ %s${RESET}\n" "$*"; }
warn()  { printf "${BOLD}${YELLOW}  ⚠ %s${RESET}\n" "$*" >&2; }
fail()  { printf "${BOLD}${RED}  ✗ %s${RESET}\n" "$*" >&2; exit 1; }
step()  { printf "${BOLD}  %s${RESET}\n" "$*"; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)           INSTALL_DIR="$2"; shift 2 ;;
    --branch)        BRANCH="$2"; shift 2 ;;
    --no-start)      START_SERVICES=false; shift ;;
    --skip-deps)     SKIP_DEPS=true; shift ;;
    --port)          PORT="$2"; shift 2 ;;
    --frontend-port) FRONTEND_PORT="$2"; shift 2 ;;
    --postgres-port) POSTGRES_PORT="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: install-dev.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --dir <path>         Install directory (default: ~/multica)"
      echo "  --branch <name>      Branch to check out (default: main)"
      echo "  --no-start           Install only, don't start services"
      echo "  --skip-deps          Skip prerequisite checks"
      echo "  --port <port>        Backend port (default: 8080)"
      echo "  --frontend-port <p>  Frontend port (default: 3000)"
      echo "  --postgres-port <p>  Postgres port (default: 5432)"
      exit 0
      ;;
    *) warn "Unknown option: $1"; shift ;;
  esac
done

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
check_prerequisites() {
  info "Checking prerequisites..."

  local missing=()

  if ! command_exists node; then
    missing+=("node (v20+)")
  else
    local node_ver
    node_ver=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$node_ver" -lt 20 ]; then
      missing+=("node v20+ (found v$(node -v))")
    else
      ok "Node.js $(node -v)"
    fi
  fi

  if ! command_exists pnpm; then
    missing+=("pnpm (v10.28+)")
  else
    ok "pnpm $(pnpm -v)"
  fi

  if ! command_exists go; then
    missing+=("go (v1.26+)")
  else
    ok "Go $(go version | awk '{print $3}')"
  fi

  if ! command_exists docker; then
    missing+=("docker")
  else
    if docker info >/dev/null 2>&1; then
      ok "Docker (running)"
    else
      missing+=("docker (installed but not running — start Docker first)")
    fi
  fi

  if ! command_exists git; then
    missing+=("git")
  else
    ok "Git $(git --version | awk '{print $3}')"
  fi

  if [ ${#missing[@]} -gt 0 ]; then
    echo ""
    fail "Missing prerequisites:
$(printf '    - %s\n' "${missing[@]}")

  Install instructions:
    Node.js:  https://nodejs.org/
    pnpm:     npm install -g pnpm
    Go:       https://go.dev/dl/
    Docker:   https://docs.docker.com/engine/install/
    Git:      https://git-scm.com/"
  fi

  ok "All prerequisites met"
}

# ---------------------------------------------------------------------------
# Clone / update repository
# ---------------------------------------------------------------------------
setup_repo() {
  info "Setting up repository..."

  if [ -d "$INSTALL_DIR/.git" ]; then
    step "Updating existing installation at $INSTALL_DIR"
    cd "$INSTALL_DIR"
    local current_branch
    current_branch=$(git branch --show-current 2>/dev/null || echo "")

    git fetch origin "$BRANCH" --depth 1 2>/dev/null || true

    if [ "$current_branch" = "$BRANCH" ]; then
      git reset --hard "origin/$BRANCH" 2>/dev/null || true
    else
      git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
    fi
  else
    if [ -d "$INSTALL_DIR" ]; then
      warn "Removing incomplete installation at $INSTALL_DIR"
      rm -rf "$INSTALL_DIR"
    fi
    step "Cloning $REPO_URL → $INSTALL_DIR"
    git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi

  ok "Repository ready ($(git log --oneline -1 | cut -c1-8))"
}

# ---------------------------------------------------------------------------
# Environment file
# ---------------------------------------------------------------------------
setup_env() {
  info "Configuring environment..."

  if [ ! -f .env ]; then
    if [ ! -f .env.example ]; then
      fail ".env.example not found — repo may be corrupted"
    fi

    cp .env.example .env

    # Generate random JWT_SECRET
    if command_exists openssl; then
      local jwt
      jwt=$(openssl rand -hex 32)
      if [ "$(uname -s)" = "Darwin" ]; then
        sed -i '' "s/^JWT_SECRET=.*/JWT_SECRET=$jwt/" .env
      else
        sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$jwt/" .env
      fi
    fi

    # Set ports from arguments
    if [ "$PORT" != "8080" ]; then
      sed -i.bak "s/^PORT=.*/PORT=$PORT/" .env 2>/dev/null || true
      rm -f .env.bak
    fi
    if [ "$FRONTEND_PORT" != "3000" ]; then
      sed -i.bak "s/^FRONTEND_PORT=.*/FRONTEND_PORT=$FRONTEND_PORT/" .env 2>/dev/null || true
      rm -f .env.bak
    fi
    if [ "$POSTGRES_PORT" != "5432" ]; then
      sed -i.bak "s/^POSTGRES_PORT=.*/POSTGRES_PORT=$POSTGRES_PORT/" .env 2>/dev/null || true
      rm -f .env.bak
    fi

    ok "Created .env with random JWT_SECRET"
  else
    ok "Using existing .env"
  fi
}

# ---------------------------------------------------------------------------
# Install dependencies
# ---------------------------------------------------------------------------
install_deps() {
  info "Installing dependencies..."

  step "Running pnpm install (this may take a minute)..."
  pnpm install

  ok "Dependencies installed"
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
setup_database() {
  info "Setting up database..."

  step "Starting Postgres via Docker..."
  bash scripts/ensure-postgres.sh ".env"

  step "Running migrations..."
  (cd server && go run ./cmd/migrate up)

  ok "Database ready"
}

# ---------------------------------------------------------------------------
# Start services
# ---------------------------------------------------------------------------
start_services() {
  info "Starting Multica services..."

  echo ""
  step "Backend:  http://localhost:$PORT"
  step "Frontend: http://localhost:$FRONTEND_PORT"
  echo ""

  # Run in background and show logs
  trap 'kill 0' EXIT
  (cd server && go run ./cmd/server) &
  pnpm dev:web &
  wait
}

# ---------------------------------------------------------------------------
# Summary (when --no-start)
# ---------------------------------------------------------------------------
print_summary() {
  echo ""
  printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
  printf "${BOLD}${GREEN}  ✓ Multica installed successfully!${RESET}\n"
  printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
  echo ""
  printf "  ${BOLD}Location:${RESET}  $INSTALL_DIR\n"
  printf "  ${BOLD}Branch:${RESET}    $BRANCH\n"
  echo ""
  printf "  ${BOLD}Start services:${RESET}\n"
  printf "    ${CYAN}cd $INSTALL_DIR && make dev${RESET}\n"
  echo ""
  printf "  ${BOLD}Or start individually:${RESET}\n"
  printf "    ${DIM}cd server && go run ./cmd/server${RESET}    ${DIM}# backend :$PORT${RESET}\n"
  printf "    ${DIM}pnpm dev:web${RESET}                         ${DIM}# frontend :$FRONTEND_PORT${RESET}\n"
  echo ""
  printf "  ${BOLD}Useful commands:${RESET}\n"
  printf "    ${CYAN}make check${RESET}     Run full verification (typecheck + tests)\n"
  printf "    ${CYAN}pnpm typecheck${RESET}  TypeScript check\n"
  printf "    ${CYAN}make test${RESET}      Go tests\n"
  printf "    ${CYAN}pnpm test${RESET}      TS tests (Vitest)\n"
  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  echo ""
  printf "${BOLD}  Multica — Local Dev Installer${RESET}\n"
  echo ""

  if [ "$SKIP_DEPS" = false ]; then
    check_prerequisites
  fi

  setup_repo
  setup_env
  install_deps
  setup_database

  if [ "$START_SERVICES" = true ]; then
    start_services
  else
    print_summary
  fi
}

main "$@"
