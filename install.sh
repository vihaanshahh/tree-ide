#!/usr/bin/env bash
# Tree IDE — one-line installer for macOS and Linux.
# Clones the repo, installs npm deps (which native-rebuilds node-pty for
# Electron), then launches the app. Windows users: use WSL2 or run the
# manual git + npm commands from the landing page in PowerShell.

set -euo pipefail

REPO="vihaanshahh/tree-ide"
REPO_URL="https://github.com/${REPO}.git"
INSTALL_DIR_DEFAULT="${TREE_IDE_DIR:-$HOME/.tree-ide}"
TAG="${TREE_IDE_VERSION:-latest}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

info()    { printf "${BLUE}info${NC}  %s\n" "$*"; }
success() { printf "${GREEN}done${NC}  %s\n" "$*"; }
warn()    { printf "${YELLOW}warn${NC}  %s\n" "$*"; }
error()   { printf "${RED}error${NC} %s\n" "$*" >&2; exit 1; }

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux)  echo "linux" ;;
    *)      error "Unsupported OS: $(uname -s). On Windows use WSL2 or run: git clone $REPO_URL && cd tree-ide && npm install && npm start" ;;
  esac
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || error "Missing required command: $1. Please install it and re-run."
}

check_node_version() {
  local v
  v=$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
  [ -z "$v" ] && error "Node.js is not installed."
  [ "$v" -lt 18 ] && error "Node.js 18+ required (found v$v)."
  return 0
}

resolve_tag() {
  if [ "$TAG" != "latest" ]; then
    echo "$TAG"
    return
  fi
  local resolved
  resolved=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
    | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/' || true)
  echo "${resolved:-main}"
}

main() {
  printf "\n  Installing Tree IDE...\n\n"

  local os install_dir tag
  os=$(detect_os)

  info "OS:       $os"
  require_cmd git
  require_cmd node
  require_cmd npm
  check_node_version

  install_dir="${INSTALL_DIR_DEFAULT}"
  tag=$(resolve_tag)

  info "Version:  $tag"
  info "Install:  $install_dir"
  printf "\n"

  # Clone or pull
  if [ -d "$install_dir/.git" ]; then
    info "Existing checkout found — pulling latest..."
    git -C "$install_dir" fetch --tags --quiet
    if [ "$tag" != "main" ]; then
      git -C "$install_dir" checkout --quiet "$tag" || git -C "$install_dir" checkout --quiet "main"
    else
      git -C "$install_dir" checkout --quiet main
      git -C "$install_dir" pull --quiet --ff-only
    fi
  else
    info "Cloning $REPO_URL → $install_dir"
    git clone --quiet "$REPO_URL" "$install_dir"
    if [ "$tag" != "main" ]; then
      git -C "$install_dir" checkout --quiet "$tag" || warn "Tag $tag not found; staying on main."
    fi
  fi

  info "Installing dependencies (this includes a native rebuild of node-pty)..."
  ( cd "$install_dir" && npm install )

  install_launcher "$install_dir"

  success "Tree IDE installed at $install_dir"
  printf "\n  Launch with:\n    ${GREEN}%s${NC}\n\n" "${LAUNCH_HINT:-cd $install_dir && npm start}"

  # Auto-launch unless the user opted out.
  if [ "${TREE_IDE_NO_LAUNCH:-0}" = "1" ]; then
    info "TREE_IDE_NO_LAUNCH=1 set — not launching."
  else
    info "Starting Tree IDE..."
    ( cd "$install_dir" && npm start )
  fi
}

install_launcher() {
  local app_dir="$1"
  local app_bin="$app_dir/bin/tree-ide.js"
  chmod +x "$app_bin" 2>/dev/null || true

  local target_dir=""
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) target_dir="$HOME/.local/bin" ;;
    *":/usr/local/bin:"*)   target_dir="/usr/local/bin" ;;
  esac

  if [ -z "$target_dir" ]; then
    mkdir -p "$HOME/.local/bin"
    target_dir="$HOME/.local/bin"
    warn "$target_dir is not on your PATH. Add this to your shell profile:"
    printf "    ${GREEN}export PATH=\"\$HOME/.local/bin:\$PATH\"${NC}\n"
  fi

  local sudo_cmd=""
  if [ ! -w "$target_dir" ]; then
    if command -v sudo >/dev/null 2>&1; then
      sudo_cmd="sudo"
    else
      warn "$target_dir is not writable. Skipping launcher install."
      return 0
    fi
  fi

  $sudo_cmd ln -sf "$app_bin" "$target_dir/tree-ide"
  success "Installed command: tree-ide → $target_dir/tree-ide"
  LAUNCH_HINT="tree-ide ."

  # Also expose as `tree` if nothing else owns that name.
  local existing
  existing=$(command -v tree 2>/dev/null || true)
  if [ -z "$existing" ]; then
    $sudo_cmd ln -sf "$app_bin" "$target_dir/tree"
    success "Installed command: tree → $target_dir/tree"
    LAUNCH_HINT="tree ."
  elif [ -L "$existing" ] && [ "$(readlink "$existing")" = "$app_bin" ]; then
    LAUNCH_HINT="tree ."
  else
    warn "Not aliasing 'tree' — $existing already exists. Use 'tree-ide' instead."
  fi
}

main "$@"
