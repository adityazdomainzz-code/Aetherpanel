#!/usr/bin/env bash
# AetherPanel updater - pulls the latest code from your GitHub repo and applies it step by step.
# Keeps .env, data/ (database, ssh keys) and node_modules. Rolls back if the build fails.
# Usage:  sudo bash update.sh            (default folder /opt/aetherpanel)
#         sudo bash update.sh /path/to/panel
set -uo pipefail

REPO_URL="https://github.com/adityazdomainzz-code/Aetherpanel.git"
BRANCH="main"
DIR="${1:-/opt/aetherpanel}"
SERVICE="aetherpanel"
BACKUP_DIR="/opt/aetherpanel-backups"
LOG="/var/log/aetherpanel-update.log"

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; C='\033[0;36m'; B='\033[1m'; N='\033[0m'
step() { echo -e "\n${Y}[$1/10] $2${N}"; echo "[$(date '+%F %T')] $2" >> "$LOG"; }
ok()   { echo -e "${G}  ✓ $*${N}"; }
warn() { echo -e "${Y}  ! $*${N}"; }
die()  { echo -e "${R}  ✗ $*${N}"; echo "FAILED: $*" >> "$LOG"; exit 1; }

echo -e "${C}${B}=== AetherPanel Update ===${N}  repo: ${REPO_URL} (${BRANCH})  folder: ${DIR}"
touch "$LOG" 2>/dev/null || LOG=/tmp/aetherpanel-update.log

# 1. checks
step 1 "Checking system"
[ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash update.sh"
[ -d "$DIR" ] || die "Folder $DIR not found"
cd "$DIR" || die "Cannot enter $DIR"
for c in git node npm curl tar; do command -v "$c" >/dev/null || die "'$c' is not installed"; done
[ -d .git ] || die "$DIR is not a git folder (run: git init && git remote add origin $REPO_URL)"
ok "root, git, node $(node -v), npm $(npm -v)"

# 2. backup
step 2 "Backing up .env + data/ (+ current build)"
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
BK="$BACKUP_DIR/aetherpanel-$STAMP.tar.gz"
BK_LIST=(); for f in .env data; do [ -e "$f" ] && BK_LIST+=("$f"); done
if [ ${#BK_LIST[@]} -gt 0 ]; then
  tar -czf "$BK" "${BK_LIST[@]}" || die "Backup failed"
  ok "Backup: $BK"
else warn "No .env / data found to back up"; fi
rm -rf /tmp/aetherpanel-dist-old; [ -d dist ] && cp -a dist /tmp/aetherpanel-dist-old
ls -1t "$BACKUP_DIR"/aetherpanel-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f   # keep last 10
PREV=$(git rev-parse HEAD 2>/dev/null || echo "")

# 3. .gitignore (secrets / big folders never go to GitHub)
step 3 "Making sure secrets are never pushed (.gitignore)"
for p in node_modules/ dist/ data/ .env .env.local '*.log' 'data/ssh_host_*' bin/playit; do
  grep -qxF "$p" .gitignore 2>/dev/null || echo "$p" >> .gitignore
done
for p in node_modules dist data .env; do
  git ls-files --error-unmatch "$p" >/dev/null 2>&1 && git rm -r -q --cached "$p" && warn "Removed $p from git tracking (files stay on disk)"
done
ok ".gitignore OK"

# 4. remote
step 4 "Setting repo to $REPO_URL"
if git remote get-url origin >/dev/null 2>&1; then git remote set-url origin "$REPO_URL"; else git remote add origin "$REPO_URL"; fi
ok "origin = $(git remote get-url origin)"

# 5. fetch
step 5 "Downloading latest code from GitHub"
git fetch origin "$BRANCH" >> "$LOG" 2>&1 || die "git fetch failed (internet / repo private?)"
NEW=$(git rev-parse "origin/$BRANCH")
if [ "$PREV" = "$NEW" ]; then warn "Already on the latest commit ($(git log -1 --format='%h %s' "$NEW")) - rebuilding anyway"
else ok "New commits:"; git log --oneline "${PREV:+$PREV..}$NEW" 2>/dev/null | head -15 | sed 's/^/     /'; fi

# 6. apply code (tracked files = GitHub version; .env, data/, node_modules are untouched)
step 6 "Applying code"
git reset -q --hard "origin/$BRANCH" || die "git reset failed"
git checkout -q -B "$BRANCH" "origin/$BRANCH" 2>/dev/null || true
if [ -f "$BK" ]; then tar -xzf "$BK" -C "$DIR" && ok "Restored .env + data/ from backup"; fi
ok "Now at $(git log -1 --format='%h %s')"

# 7. required files check
step 7 "Checking all update files are in the repo"
MISSING=0
for f in package.json server.ts src/types.ts src/pages/public/Status.tsx src/pages/server/ServerManage.tsx \
         server/services/fundingPolicy.ts src/lib/policy.ts src/components/SelfServiceLocked.tsx src/lib/serverNav.ts; do
  if [ -e "$f" ]; then ok "$f"; else echo -e "${R}  ✗ missing: $f${N}"; MISSING=1; fi
done
grep -q "adityazdomainzz-code" server/updateService.ts 2>/dev/null && ok "Update Panel button -> your repo" || warn "server/updateService.ts still points to the old repo"
[ $MISSING -eq 0 ] || warn "Some files are missing in GitHub - upload them, otherwise the build may fail"

rollback() {
  echo -e "${R}  Rolling back...${N}"
  [ -n "$PREV" ] && git reset -q --hard "$PREV"
  [ -f "$BK" ] && tar -xzf "$BK" -C "$DIR"
  if [ -d /tmp/aetherpanel-dist-old ]; then rm -rf dist && cp -a /tmp/aetherpanel-dist-old dist; fi
  systemctl restart "$SERVICE" 2>/dev/null
  die "$1 - old version restored, panel still runs. Details: $LOG"
}

# 8. packages
step 8 "Installing packages (npm install)"
npm install --no-audit --no-fund >> "$LOG" 2>&1 || { tail -20 "$LOG"; rollback "npm install failed"; }
ok "Packages OK"

# 9. build
step 9 "Building panel (npm run build)"
if ! npm run build >> "$LOG" 2>&1; then tail -25 "$LOG"; rollback "Build failed"; fi
[ -f dist/server.cjs ] || rollback "dist/server.cjs not created"
grep -q SELF_FUNDING_DISABLED dist/server.cjs && ok "Admin-only credits/deploy is in the build" || warn "Admin-only funding code not found in build"
ok "Build OK"

# 10. restart + health check
step 10 "Restarting panel"
systemctl daemon-reload 2>/dev/null
systemctl restart "$SERVICE" || rollback "systemctl restart $SERVICE failed"
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '"'\'' '); PORT=${PORT:-3000}
UP=0; for i in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && { UP=1; break; }; sleep 1; done
if [ $UP -eq 1 ] && systemctl is-active --quiet "$SERVICE"; then
  ok "Panel is running on port $PORT"
else
  journalctl -u "$SERVICE" -n 20 --no-pager
  rollback "Panel did not start"
fi
rm -rf /tmp/aetherpanel-dist-old

echo -e "\n${G}${B}=== Update done! ===${N}  $(git log -1 --format='%h %s')"
echo -e "Backup: ${BK}   Log: ${LOG}"
echo -e "Browser mein ${B}Ctrl+F5${N} daba ke panel refresh kar."
