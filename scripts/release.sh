#!/usr/bin/env bash
set -euo pipefail

# release.sh — orchestrate a full Tree IDE release end-to-end.
#
# 1. Validate working tree + git state
# 2. Resolve target version (from package.json, or --version, or --bump)
# 3. Tag + push  (triggers .github/workflows/release.yml which builds
#    arm64 + x64 dmgs on macOS and an .exe installer on Windows)
# 4. Poll the workflow run until done
# 5. Verify the GH release contains every expected asset
# 6. POST fs-code-landing /api/releases/revalidate

usage() {
  cat <<'USAGE'
Usage: scripts/release.sh [options]

Options:
  --version X.Y.Z    Target version. Defaults to package.json "version".
  --bump             Bump patch component of package.json (0.2.0 -> 0.2.1).
  --dry-run          Validate everything, print what *would* happen,
                     but do not edit package.json, tag, push, or call
                     any external API.
  --skip-revalidate  Skip the landing-site cache flush.
  --no-poll          Tag + push, then exit (do not wait for CI).
  --landing-url URL  Override landing base URL. Default: https://www.fluidstate.ai
  --timeout SECONDS  Workflow poll timeout. Default: 2400 (40 min — electron
                     builds are heavier than the fs-code Rust ones).
  -h, --help         Show this message.

Environment:
  GH_TOKEN / GITHUB_TOKEN  Used by `gh` (already required).
  FS_LANDING_REVALIDATE_SECRET
                           Shared secret POSTed to the landing's
                           /api/releases/revalidate endpoint. On macOS,
                           falls back to keychain entry of the same name.

Exit codes:
  0  success
  1  validation failure
  2  workflow failed, timed out, or assets missing
  3  landing revalidate failed
USAGE
}

# ─── parsing ──────────────────────────────────────────────────────────────────

dry_run=0
do_bump=0
no_poll=0
skip_revalidate=0
explicit_version=""
landing_url="${FS_LANDING_URL:-https://www.fluidstate.ai}"
timeout_secs=2400

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      explicit_version="${2:-}"
      [ -z "$explicit_version" ] && { echo "release.sh: --version requires an argument" >&2; exit 2; }
      shift 2 ;;
    --bump)             do_bump=1; shift ;;
    --dry-run)          dry_run=1; shift ;;
    --no-poll)          no_poll=1; shift ;;
    --skip-revalidate)  skip_revalidate=1; shift ;;
    --landing-url)
      landing_url="${2:-}"
      [ -z "$landing_url" ] && { echo "release.sh: --landing-url requires an argument" >&2; exit 2; }
      shift 2 ;;
    --timeout)
      timeout_secs="${2:-}"
      [ -z "$timeout_secs" ] && { echo "release.sh: --timeout requires an argument" >&2; exit 2; }
      shift 2 ;;
    -h|--help)          usage; exit 0 ;;
    *)                  echo "release.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# Keychain fallback for the landing secret (macOS only).
if [ -z "${FS_LANDING_REVALIDATE_SECRET:-}" ] && command -v security >/dev/null 2>&1; then
  kc_secret="$(security find-generic-password -a "$USER" -s "FS_LANDING_REVALIDATE_SECRET" -w 2>/dev/null || true)"
  [ -n "$kc_secret" ] && export FS_LANDING_REVALIDATE_SECRET="$kc_secret"
  unset kc_secret
fi

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

[ -f package.json ] || { fail "package.json not found"; exit 1; }
ok "repo: $(basename "$repo_root")"

for bin in node git gh curl; do
  command -v "$bin" >/dev/null 2>&1 || { fail "required binary not found: $bin"; exit 1; }
done
ok "node, git, gh, curl available"

gh auth status >/dev/null 2>&1 || { fail "gh not authenticated"; exit 1; }
ok "gh authenticated"

repo_slug="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
ok "github: $repo_slug"

# Workflow file must exist or the tag push triggers nothing.
if [ ! -f .github/workflows/release.yml ]; then
  fail ".github/workflows/release.yml missing — tag push would do nothing"
  exit 1
fi
ok ".github/workflows/release.yml present"

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
  local v; v="$(read_pkg_version)"
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
    dry "git commit + push (origin/$current_branch)"
  else
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      pkg.version = '$target_version';
      fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
    "
    git add package.json
    git commit -m "chore: bump version to v${target_version}" >/dev/null
    git push origin "$current_branch"
    ok "bumped + committed + pushed $current_version → $target_version"
    # Refresh local_sha for the tag.
    local_sha="$(git rev-parse HEAD)"
  fi
fi

# ─── tag + push ───────────────────────────────────────────────────────────────

step "Tag + push"

if [ "$dry_run" -eq 1 ]; then
  dry "git tag -a $tag -m \"$tag\""
  dry "git push origin $tag"
else
  git tag -a "$tag" -m "$tag"
  ok "created tag $tag at $local_sha"
  git push origin "$tag"
  ok "pushed $tag (this triggers .github/workflows/release.yml)"
fi

# ─── poll workflow ────────────────────────────────────────────────────────────

if [ "$no_poll" -eq 1 ]; then
  step "Workflow poll skipped (--no-poll)"
else
  step "Polling Release workflow"

  if [ "$dry_run" -eq 1 ]; then
    dry "gh run watch (release.yml @ $tag)"
  else
    deadline=$(( $(date +%s) + timeout_secs ))
    run_id=""
    while [ -z "$run_id" ]; do
      if [ "$(date +%s)" -ge "$deadline" ]; then
        fail "timed out waiting for workflow to start"
        exit 2
      fi
      # Filter out completed runs so we don't latch onto a previous
      # failed attempt with the same tag.
      run_id="$(gh run list \
        --workflow=release.yml \
        --event=push \
        --limit 20 \
        --json databaseId,headBranch,status \
        -q "[.[] | select(.headBranch == \"$tag\" and .status != \"completed\")] | .[0].databaseId" 2>/dev/null || true)"
      [ -z "$run_id" ] && sleep 5
    done
    ok "run $run_id queued (https://github.com/$repo_slug/actions/runs/$run_id)"

    if gh run watch "$run_id" --exit-status; then
      ok "workflow succeeded"
    else
      fail "workflow failed (run $run_id)"
      exit 2
    fi
  fi
fi

# ─── verify release assets ────────────────────────────────────────────────────

step "Verify release assets"

expected_assets=(
  "Tree-${target_version}-arm64.dmg"
  "Tree-${target_version}.dmg"
  "Tree-arm64.dmg"
  "Tree-x64.dmg"
  "Tree-Setup-${target_version}.exe"
  "Tree-Setup.exe"
)

if [ "$dry_run" -eq 1 ]; then
  dry "gh release view $tag --json assets"
  for a in "${expected_assets[@]}"; do
    printf "    ${C_DIM}• %s${C_RESET}\n" "$a" >&2
  done
else
  release_deadline=$(( $(date +%s) + 180 ))
  while ! gh release view "$tag" >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$release_deadline" ]; then
      fail "release $tag never appeared after workflow success"
      exit 2
    fi
    sleep 3
  done

  asset_list="$(gh release view "$tag" --json assets -q '.assets[].name')"
  missing=()
  for a in "${expected_assets[@]}"; do
    grep -Fxq "$a" <<<"$asset_list" || missing+=("$a")
  done

  if [ "${#missing[@]}" -gt 0 ]; then
    fail "release $tag is missing assets:"
    for m in "${missing[@]}"; do printf "       %s\n" "$m" >&2; done
    exit 2
  fi
  ok "all ${#expected_assets[@]} expected assets present"
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
  fail "  (release is published; rerun with the env var to notify the site)"
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
