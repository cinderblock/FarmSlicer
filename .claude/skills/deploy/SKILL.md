---
name: deploy
description: Deploy and manage FarmSlicer on a remote Linux server via SSH
user_invocable: true
---

# Deploy Skill

Manage FarmSlicer on a remote Linux server. All remote interaction goes through
`deploy.sh` in this directory, which loads SSH target config from `.env`.

## Script location

```
.claude/skills/deploy/deploy.sh
```

## Available commands

| Command | Description |
|---|---|
| `setup-tools` | Install build prerequisites (apt packages, rustup, nvm/node) |
| `clone` | Clone the repo on the remote server (first-time) |
| `pull` | Pull latest code and update submodules |
| `setup-deps` | Build OrcaSlicer C++ dependencies (slow, one-time) |
| `build` | Build frontend + cargo release binary |
| `setup-service` | Install/update the systemd unit file and enable it |
| `start` | Start the systemd service |
| `stop` | Stop the systemd service |
| `restart` | Restart the systemd service |
| `status` | Show service status |
| `logs [-f]` | View service logs (`-f` to follow) |
| `deploy` | Full redeploy: pull + build + restart |
| `ssh` | Open an interactive shell on the remote, cd'd to the project |

## First-time server setup (in order)

```bash
bash .claude/skills/deploy/deploy.sh setup-tools
bash .claude/skills/deploy/deploy.sh clone
bash .claude/skills/deploy/deploy.sh setup-deps
bash .claude/skills/deploy/deploy.sh build
bash .claude/skills/deploy/deploy.sh setup-service
bash .claude/skills/deploy/deploy.sh start
```

## Routine deploy

```bash
bash .claude/skills/deploy/deploy.sh deploy
```

## Configuration

Copy `.env.example` to `.env` and fill in your SSH target. The `.env` file is
gitignored. Available variables:

- `DEPLOY_USER` — SSH username (required)
- `DEPLOY_HOST` — SSH hostname or IP (required)
- `REPO_URL` — Git clone URL (default: `git@github.com:cinderblock/FarmSlicer.git`)
- `REMOTE_DIR` — Install path on server (default: `/opt/farmslicer`)
- `SERVICE_NAME` — systemd unit name (default: `farmslicer`)
- `SERVICE_PORT` — Port the server listens on (default: `9337`)
- `BUILD_JOBS` — Parallel make jobs (default: `nproc`)

## How to use from Claude

Run commands via bash:

```bash
bash .claude/skills/deploy/deploy.sh <command>
```

For long-running commands (`setup-deps`, `build`, `deploy`), consider running
them in the background and monitoring output. For `logs -f`, use an interactive
terminal or run with a timeout.
