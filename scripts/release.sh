#!/usr/bin/env bash
set -euo pipefail

# release.sh — orchestrate a full Tree IDE release end-to-end.
#
# 1. Validate working tree + git state
# 2. Resolve target version (from package.json, or --version, or --bump)
# 3. npm run dist (electron-builder, both arm64 + x64 dmg)
# 4. Verify dist/ contains the four expected dmg artifacts
# 5. Bump package.json + commit + tag + push
# 6. gh release create with all dmgs uploaded
# 7. POST fs-code-landing /api/releases/revalidate
#
# Unlike fs-code, the build runs locally — electron-builder needs a Mac
# host with code-signing disabled (already configured in package.json's
# `mac.identity: null`). No GitHub Actions in the loop.

usage() {
  cat <<'USAGE'
Usage: scripts/release.sh [options]

Options:
  --version X.Y.Z    Target version. Defaults to package.json's "version".
  --bump             Bump patch component of package.json (0.2.0 -> 0.2.1).
  --dry-run          Validate everything, print what *would* happen,
                     but do not edit package.json, tag, push, build, or
                     call any external API.
  --skip-build       Skip `npm run dist` (assume dist/ already has dmgs).
  --skip-revalidate  Skip the landing-site cache flush.
  --landing-url URL  Override landing site base URL.
                     Default: https://www.fluidstate.ai
  -h, --help         Show this message.

Environment:
  GH_TOKEN / GITHUB_TOKEN  Used by `gh` (already required).
  FS_LANDING_REVALIDATE_SECRET
                           Shared secret POSTed to the landing's
                           /api/releases/revalidate endpoint.

Exit codes:
  0  success
  1  validation failure
  2  build failed or assets missing
  3  landing revalidate failed
USAGE
}

# ─── parsing ──────────────────────────────────────────────────────────────────

dry_run=0
do_bump=0
skip_build=0
skip_revalidate=0
explicit_version=""
landing_url="${FS_LANDING_URL:-https://www.fluidstate.ai}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      explicit_version="${2:-}"
      [ -z "$explicit_version" ] && { echo "release.sh: --version requires an argument" >&2; exit 2; }
      shift 2 ;;
    --bump)             do_bump=1; shift ;;
    --dry-run)          dry_run=1; shift ;;
    --skip-build)       skip_build=1; shift ;;
    --skip-revalidate)  skip_revalidate=1; shift ;;
    --landing-url)
      landing_url="${2:-}"
      [ -z "$landing_url" ] && { echo "release.sh: --landing-url requires an argument" >&2; exit 2; }
      shift 2 ;;
    -h|--help)          usage; exit 0 ;;
    *)                  echo "release.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# ─── output ───────────────────────────────────────────────────────────────────

if [ -t 2 ]; then
  C_DIM='\033[2m'; C_BOLD='\033[1m'
  C_BLUE='\033[34m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_RED='\033[31m'
  C_RESET='\033[0m'
else
  C_DIM=''; C_BOLD=''; C_BLUE=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_RESET=''
fi

step()  { printf "\n${C_BOLD}${C_BLUE}▸${C_RESET} ${C_BOLD}%s${C_RESET}\n" "$*" >&2; }
ok()    { printf "  ${C_GREEN}✓${C_RESET} %s\n" "$*" >&2; }
warn()  { printf "  ${C_YELLOW}⚠${C_RESET} %s\n" "$*" >&2; }
fail()  { printf "  ${C_RED}✗${C_RESET} %s\n" "$*" >&2; }
dry()   {
  if [ "$dry_run" -eq 1 ]; then
    printf "  ${C_YELLOW}↳ dry-run:${C_RESET} %s\n" "$*" >&2
  fi
}

# ─── prerequisites ────────────────────────────────────────────────────────────

step "Prerequisites"

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [ ! -f package.json ]; then
  fail "package.json not found — wrong repo?"
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "electron-builder mac dmg target requires macOS host"
  exit 1
fi
ok "repo: $(basename "$repo_root")"
ok "host: macOS ($(uname -m))"

for bin in node npm git gh curl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    fail "required binary not found: $bin"
    exit 1
  fi
done
ok "node, npm, git, gh, curl available"

if ! gh auth status >/dev/null 2>&1; then
  fail "gh is not authenticated. Run: gh auth login"
  exit 1
fi
ok "gh authenticated"

repo_slug="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
ok "github: $repo_slug"

# ─── working tree ─────────────────────────────────────────────────────────────

step "Working tree"

current_branch="$(git symbolic-ref --short HEAD 2>/dev/null || echo "detached")"
ok "branch: $current_branch"
[ "$current_branch" != "main" ] && warn "not on main"

if ! git diff --quiet || ! git diff --cached --quiet; then
  warn "working tree has uncommitted changes"
  if [ "$do_bump" -eq 1 ] && [ "$dry_run" -eq 0 ]; then
    fail "--bump requires a clean working tree (it commits the bump)"
    exit 1
  fi
else
  ok "working tree clean"
fi

git fetch --tags --quiet origin "$current_branch" 2>/dev/null || true
local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse "origin/$current_branch" 2>/dev/null || echo "")"
if [ -n "$remote_sha" ] && [ "$local_sha" != "$remote_sha" ]; then
  warn "local HEAD differs from origin/$current_branch"
else
  ok "in sync with origin/$current_branch"
fi

# ─── version resolution ───────────────────────────────────────────────────────

step "Version"

read_pkg_version() {
  node -p "require('./package.json').version"
}

bump_patch() {
  local v
  v="$(read_pkg_version)"
  if ! [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    fail "package.json version '$v' is not x.y.z"
    return 1
  fi
  IFS=. read -r maj min pat <<<"$v"
  echo "$maj.$min.$((pat + 1))"
}

current_version="$(read_pkg_version)"
ok "package.json version: $current_version"

if [ "$do_bump" -eq 1 ]; then
  target_version="$(bump_patch)"
  ok "would bump → $target_version"
elif [ -n "$explicit_version" ]; then
  target_version="${explicit_version#v}"
  ok "explicit version: $target_version"
else
  target_version="$current_version"
fi

if ! [[ "$target_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "expected x.y.z version, got '$target_version'"
  exit 1
fi

tag="v$target_version"

if git rev-parse "$tag" >/dev/null 2>&1; then
  fail "tag $tag already exists locally"
  exit 1
fi
if git ls-remote --tags origin "refs/tags/$tag" | grep -q "$tag"; then
  fail "tag $tag already exists on origin"
  exit 1
fi
if gh release view "$tag" >/dev/null 2>&1; then
  fail "release $tag already exists on GitHub"
  exit 1
fi
ok "tag $tag is available"

# ─── package.json bump ────────────────────────────────────────────────────────

if [ "$target_version" != "$current_version" ]; then
  step "Bump package.json"
  if [ "$dry_run" -eq 1 ]; then
    dry "rewrite package.json version: $current_version → $target_version"
    dry "git add package.json && git commit -m 'chore: bump version to v${target_version}'"
  else
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      pkg.version = '$target_version';
      fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    "
    git add package.json
    git commit -m "chore: bump version to v${target_version}" >/dev/null
    ok "bumped + committed $current_version → $target_version"
  fi
fi

# ─── build ────────────────────────────────────────────────────────────────────

step "Build"

expected_dmgs=(
  "Tree-${target_version}-arm64.dmg"
  "Tree-${target_version}.dmg"
)
alias_dmgs=(
  "Tree-arm64.dmg"
  "Tree-x64.dmg"
)

if [ "$skip_build" -eq 1 ]; then
  warn "--skip-build set; assuming dist/ is current"
elif [ "$dry_run" -eq 1 ]; then
  dry "npm run dist (electron-builder --mac dmg --arm64 --x64)"
  for d in "${expected_dmgs[@]}" "${alias_dmgs[@]}"; do
    printf "    ${C_DIM}• dist/%s${C_RESET}\n" "$d" >&2
  done
else
  ok "running: npm run dist"
  if ! npm run dist 1>&2; then
    fail "npm run dist failed"
    exit 2
  fi
  ok "build complete"
fi

# ─── verify + create aliases ──────────────────────────────────────────────────

step "Verify artifacts"

if [ "$dry_run" -eq 1 ]; then
  dry "verify all four dmgs exist in dist/"
else
  for d in "${expected_dmgs[@]}"; do
    if [ ! -f "dist/$d" ]; then
      fail "missing build artifact: dist/$d"
      exit 2
    fi
    ok "dist/$d ($(du -h "dist/$d" | awk '{print $1}'))"
  done

  # Refresh the version-less aliases the landing site downloads. cp
  # over any stale aliases from previous builds.
  cp "dist/Tree-${target_version}-arm64.dmg" "dist/Tree-arm64.dmg"
  cp "dist/Tree-${target_version}.dmg"        "dist/Tree-x64.dmg"
  ok "refreshed Tree-arm64.dmg + Tree-x64.dmg aliases"
fi

# ─── tag + push ───────────────────────────────────────────────────────────────

step "Tag + push"

if [ "$dry_run" -eq 1 ]; then
  dry "git tag -a $tag -m \"$tag\""
  dry "git push origin $current_branch"
  dry "git push origin $tag"
else
  git tag -a "$tag" -m "$tag"
  ok "created tag $tag"

  # Push the bump commit first (if there is one), then the tag.
  if [ "$target_version" != "$current_version" ]; then
    git push origin "$current_branch"
    ok "pushed bump commit to origin/$current_branch"
  fi
  git push origin "$tag"
  ok "pushed $tag to origin"
fi

# ─── create GH release ────────────────────────────────────────────────────────

step "Create GitHub release"

if [ "$dry_run" -eq 1 ]; then
  dry "gh release create $tag --title \"Tree IDE $tag\" --generate-notes \\"
  for d in "${expected_dmgs[@]}" "${alias_dmgs[@]}"; do
    dry "  dist/$d"
  done
else
  upload_args=()
  for d in "${expected_dmgs[@]}" "${alias_dmgs[@]}"; do
    upload_args+=("dist/$d")
  done

  if gh release create "$tag" \
       --title "Tree IDE $tag" \
       --generate-notes \
       "${upload_args[@]}" >/dev/null; then
    ok "released $tag with ${#upload_args[@]} dmg assets"
  else
    fail "gh release create failed"
    exit 2
  fi
fi

# ─── notify landing ───────────────────────────────────────────────────────────

step "Notify landing"

if [ "$skip_revalidate" -eq 1 ]; then
  warn "skipped (--skip-revalidate)"
elif [ "$dry_run" -eq 1 ]; then
  dry "POST $landing_url/api/releases/revalidate  body={\"tag\":\"$tag\"}"
  if curl -fsLI --max-time 5 "$landing_url" >/dev/null 2>&1; then
    ok "landing $landing_url reachable"
  else
    warn "landing $landing_url not reachable from here (ok in dry-run)"
  fi
elif [ -z "${FS_LANDING_REVALIDATE_SECRET:-}" ]; then
  fail "FS_LANDING_REVALIDATE_SECRET not set — cannot flush landing cache"
  fail "  (release is published; just rerun with the env var to notify the site)"
  exit 3
else
  http_code="$(curl -sSL -o /tmp/tree-release-revalidate.out -w '%{http_code}' \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${FS_LANDING_REVALIDATE_SECRET}" \
    --data "{\"tag\":\"$tag\"}" \
    --max-time 15 \
    "$landing_url/api/releases/revalidate" || true)"

  if [ "$http_code" = "200" ]; then
    ok "landing revalidated (HTTP $http_code)"
    body="$(cat /tmp/tree-release-revalidate.out 2>/dev/null || true)"
    [ -n "$body" ] && printf "    ${C_DIM}%s${C_RESET}\n" "$body" >&2
  else
    fail "landing revalidate failed (HTTP $http_code)"
    cat /tmp/tree-release-revalidate.out >&2 || true
    exit 3
  fi
fi

# ─── done ─────────────────────────────────────────────────────────────────────

step "Done"
if [ "$dry_run" -eq 1 ]; then
  printf "  ${C_YELLOW}dry-run complete — nothing was published.${C_RESET}\n" >&2
  printf "  Re-run without ${C_BOLD}--dry-run${C_RESET} to release ${C_BOLD}%s${C_RESET}.\n" "$tag" >&2
else
  printf "  ${C_GREEN}released ${C_BOLD}%s${C_RESET} ${C_GREEN}— https://github.com/%s/releases/tag/%s${C_RESET}\n" \
    "$tag" "$repo_slug" "$tag" >&2
fi
