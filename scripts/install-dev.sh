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
detect_pkg_manager() {
  if command_exists apt-get; then
    echo "apt"
  elif command_exists brew; then
    echo "brew"
  elif command_exists dnf; then
    echo "dnf"
  elif command_exists yum; then
    echo "yum"
  elif command_exists pacman; then
    echo "pacman"
  else
    echo "unknown"
  fi
}

install_go() {
  local pkg_manager
  pkg_manager=$(detect_pkg_manager)

  info "Installing Go..."
  case "$pkg_manager" in
    apt)
      # Ubuntu/Debian/WSL — install from official tarball with checksum verification
      local go_version="1.24.1"
      local go_tarball="go${go_version}.linux-amd64.tar.gz"
      local go_url="https://go.dev/dl/${go_tarball}"
      local go_sha256="cb23b46df49e52a0ceaf0f4b1f31e8c8df4b780b9b327899c8e9839d3db4e574"
      local tmp_dir
      tmp_dir=$(mktemp -d)

      step "Downloading Go ${go_version}..."
      curl -fsSL "$go_url" -o "$tmp_dir/$go_tarball"

      # Verify checksum
      step "Verifying checksum..."
      local actual_sha
      actual_sha=$(sha256sum "$tmp_dir/$go_tarball" | awk '{print $1}')
      if [ "$actual_sha" != "$go_sha256" ]; then
        rm -rf "$tmp_dir"
        fail "Go tarball checksum mismatch! Expected $go_sha256, got $actual_sha"
      fi

      step "Installing to /usr/local/go..."
      if [ -d /usr/local/go ]; then
        sudo rm -rf /usr/local/go
      fi
      sudo tar -C /usr/local -xzf "$tmp_dir/$go_tarball"
      rm -rf "$tmp_dir"

      # Add to PATH if not already there
      if ! echo "$PATH" | tr ':' '\n' | grep -q "^/usr/local/go/bin$"; then
        export PATH="/usr/local/go/bin:$PATH"
        # Persist for future shells
        local go_line='export PATH="/usr/local/go/bin:$PATH"'
        for rc in "$HOME/.bashrc" "$HOME/.profile" "$HOME/.zshrc"; do
          if [ -f "$rc" ] && ! grep -qF "/usr/local/go/bin" "$rc"; then
            echo "" >> "$rc"
            echo "# Go" >> "$rc"
            echo "$go_line" >> "$rc"
          fi
        done
      fi
      ;;
    brew)
      step "Installing via Homebrew..."
      brew install go
      ;;
    dnf)
      sudo dnf install -y golang
      ;;
    yum)
      sudo yum install -y golang
      ;;
    pacman)
      sudo pacman -S --noconfirm go
      ;;
    *)
      fail "Cannot auto-install Go. Please install manually: https://go.dev/dl/"
      ;;
  esac

  # Verify
  if command_exists go; then
    ok "Go $(go version | awk '{print $3}') installed"
  else
    fail "Go installation failed. Please install manually: https://go.dev/dl/"
  fi
}

install_pnpm() {
  info "Installing pnpm..."
  if command_exists npm; then
    npm install -g pnpm
  elif command_exists corepack; then
    corepack enable
    corepack prepare pnpm@latest --activate
  else
    # Download first, inspect, then execute — don't pipe curl to sh
    local tmp_script
    tmp_script=$(mktemp)
    curl -fsSL https://get.pnpm.io/install.sh -o "$tmp_script"
    sh "$tmp_script"
    rm -f "$tmp_script"
  fi

  if command_exists pnpm; then
    ok "pnpm $(pnpm -v) installed"
  else
    fail "pnpm installation failed. Please install manually: npm install -g pnpm"
  fi
}

install_node() {
  local pkg_manager
  pkg_manager=$(detect_pkg_manager)

  info "Installing Node.js v20..."
  case "$pkg_manager" in
    apt)
      # Download setup script first, then execute — don't pipe curl to sudo bash
      local tmp_script
      tmp_script=$(mktemp)
      curl -fsSL https://deb.nodesource.com/setup_20.x -o "$tmp_script"
      sudo -E bash "$tmp_script"
      rm -f "$tmp_script"
      sudo apt-get install -y nodejs
      ;;
    brew)
      brew install node@20
      ;;
    dnf)
      sudo dnf install -y nodejs
      ;;
    yum)
      local tmp_script
      tmp_script=$(mktemp)
      curl -fsSL https://rpm.nodesource.com/setup_20.x -o "$tmp_script"
      sudo bash "$tmp_script"
      rm -f "$tmp_script"
      sudo yum install -y nodejs
      ;;
    pacman)
      sudo pacman -S --noconfirm nodejs npm
      ;;
    *)
      fail "Cannot auto-install Node.js. Please install manually: https://nodejs.org/"
      ;;
  esac

  if command_exists node; then
    ok "Node.js $(node -v) installed"
  else
    fail "Node.js installation failed. Please install manually: https://nodejs.org/"
  fi
}

install_git() {
  local pkg_manager
  pkg_manager=$(detect_pkg_manager)

  info "Installing Git..."
  case "$pkg_manager" in
    apt)    sudo apt-get install -y git ;;
    brew)   brew install git ;;
    dnf)    sudo dnf install -y git ;;
    yum)    sudo yum install -y git ;;
    pacman) sudo pacman -S --noconfirm git ;;
    *)      fail "Cannot auto-install Git. Please install manually: https://git-scm.com/" ;;
  esac

  if command_exists git; then
    ok "Git $(git --version | awk '{print $3}') installed"
  fi
}

check_prerequisites() {
  info "Checking prerequisites..."

  local missing=()
  local to_install=()

  # Git
  if ! command_exists git; then
    missing+=("git")
    to_install+=("git")
  else
    ok "Git $(git --version | awk '{print $3}')"
  fi

  # Node
  if ! command_exists node; then
    missing+=("node (v20+)")
    to_install+=("node")
  else
    local node_ver
    node_ver=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$node_ver" -lt 20 ]; then
      missing+=("node v20+ (found v$(node -v))")
      to_install+=("node")
    else
      ok "Node.js $(node -v)"
    fi
  fi

  # pnpm
  if ! command_exists pnpm; then
    missing+=("pnpm (v10.28+)")
    to_install+=("pnpm")
  else
    ok "pnpm $(pnpm -v)"
  fi

  # Go
  if ! command_exists go; then
    missing+=("go (v1.26+)")
    to_install+=("go")
  else
    ok "Go $(go version | awk '{print $3}')"
  fi

  # Docker
  if ! command_exists docker; then
    missing+=("docker")
  else
    if docker info >/dev/null 2>&1; then
      ok "Docker (running)"
    else
      missing+=("docker (installed but not running — start Docker first)")
    fi
  fi

  # If nothing missing, we're done
  if [ ${#missing[@]} -eq 0 ]; then
    ok "All prerequisites met"
    return 0
  fi

  # Separate auto-installable from manual
  local auto_installable=()
  local manual_only=()

  for item in "${missing[@]}"; do
    case "$item" in
      docker*)
        manual_only+=("$item")
        ;;
      *)
        auto_installable+=("$item")
        ;;
    esac
  done

  # Show what's missing
  echo ""
  if [ ${#auto_installable[@]} -gt 0 ]; then
    printf "${YELLOW}  Missing prerequisites:${RESET}\n"
    printf "    - %s\n" "${auto_installable[@]}"
  fi

  if [ ${#manual_only[@]} -gt 0 ]; then
    printf "${RED}  Manual install required:${RESET}\n"
    printf "    - %s\n" "${manual_only[@]}"
    printf "${DIM}      → https://docs.docker.com/engine/install/${RESET}\n"
  fi

  # Auto-install what we can
  if [ ${#auto_installable[@]} -gt 0 ]; then
    echo ""
    printf "${BOLD}  Installing missing prerequisites automatically...${RESET}\n"
    echo ""

    for item in "${to_install[@]}"; do
      case "$item" in
        git)   install_git ;;
        node)  install_node ;;
        pnpm)  install_pnpm ;;
        go)    install_go ;;
      esac
    done

    # Re-check after install
    local still_missing=()
    if ! command_exists git;   then still_missing+=("git"); fi
    if ! command_exists node;  then still_missing+=("node"); fi
    if ! command_exists pnpm;  then still_missing+=("pnpm"); fi
    if ! command_exists go;    then still_missing+=("go"); fi
    if ! command_exists docker; then still_missing+=("docker"); fi

    if [ ${#still_missing[@]} -gt 0 ]; then
      echo ""
      fail "Still missing after install attempt: ${still_missing[*]}"
    fi
  fi

  # If only Docker is missing, warn but continue (Postgres can use existing)
  if [ ${#manual_only[@]} -gt 0 ]; then
    echo ""
    warn "Docker not available. You'll need to provide your own Postgres instance."
    warn "Set DATABASE_URL in .env before running 'make dev'."
    echo ""
  fi
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
        sed -i '' "s|^JWT_SECRET=.*|JWT_SECRET=$jwt|" .env
      else
        sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$jwt|" .env
      fi
    fi

    # Set ports from arguments
    if [ "$PORT" != "8080" ]; then
      sed -i "s/^PORT=.*/PORT=$PORT/" .env
    fi
    if [ "$FRONTEND_PORT" != "3000" ]; then
      sed -i "s/^FRONTEND_PORT=.*/FRONTEND_PORT=$FRONTEND_PORT/" .env
    fi
    if [ "$POSTGRES_PORT" != "5432" ]; then
      sed -i "s/^POSTGRES_PORT=.*/POSTGRES_PORT=$POSTGRES_PORT/" .env
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

  # Load .env so Go server picks up JWT_SECRET and other vars
  if [ -f .env ]; then
    set -a
    # shellcheck source=/dev/null
    source .env
    set +a
  fi

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
