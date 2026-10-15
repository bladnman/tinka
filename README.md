# Tinka

A small, local canvas for trying things. A **Tinka Board** holds experiments, images, prototypes, alternative versions, and comparisons. Keep earlier rounds, leave notes, and return when something new lands.

Each project gets its own instance. You can run `Tinka / Atlas` and `Tinka / Orchard` at the same time, with separate boards, notes, configuration, processes, and saved URLs. There is no master service or shared port allocator.

Tinka uses **Node.js 22 or newer**, has **no runtime npm dependencies**, and binds only to `127.0.0.1`. Managed start/stop uses `ps`, so use macOS or Linux. The package is internally named `board-room` for compatibility with the original installer; the product is Tinka.

## Quick start

Download the [latest application and lightweight agent skill](https://github.com/bladnman/tinka/releases/latest). Extract `tinka-skill.zip`, then use its installer with the application ZIP and matching checksum:

```sh
node /absolute/tinka/scripts/install.mjs \
  --zip /absolute/tinka-v0.2.0.zip \
  --checksum /absolute/tinka-v0.2.0.zip.sha256 \
  --install-dir /absolute/project/.tinka/app
```

Or let the installer retrieve the latest release from `bladnman/tinka`:

```sh
node /absolute/tinka/scripts/install.mjs --install-dir /absolute/project/.tinka/app
```

From your project folder, initialize external data and start Tinka:

```sh
node /absolute/project/.tinka/app/cli.mjs init \
  --config /absolute/project/tinka.config.json \
  --boards /absolute/project/design/boards \
  --label Atlas
node /absolute/project/.tinka/app/cli.mjs start \
  --config /absolute/project/tinka.config.json
```

**Open the URL printed by `start`.** A new automatic instance tries 43821, 43921, 44021, and so on, at most 20 candidates. It binds the real socket before choosing a port, saves the actual port in this instance's config, and tries that saved port first on restart. If it is occupied, the same bounded sequence continues from there. A numeric `init --port 43821` means **fixed**: a collision fails clearly without changing any other process. Omit `--label` to use the current project folder's name.

For a source checkout, run `node cli.mjs` directly; keep config and boards outside the checkout. No build step or `npm install` is needed.

Create a board:

```sh
node /absolute/project/.tinka/app/cli.mjs board create first-ideas \
  --config /absolute/project/tinka.config.json --title "A better first step"
```

Or copy [`examples/first-steps`](examples/first-steps) into the external boards root for two small, runnable experiments. The home page's **+ New board** button produces a copyable agent prompt containing this instance's label, URL, and paths.

Stop only this instance with `node /absolute/project/.tinka/app/cli.mjs stop --config /absolute/project/tinka.config.json`. Use `serve` for a foreground process and Ctrl-C to stop it. PID and log files live beside the config. Managed stop checks the recorded PID, CLI path, config path, and unique process token before signaling anything.

## If you're an agent

1. Read this project's instructions for its config path. An optional `~/.config/tinka/workspaces.json` contains `{projectRoot, appPath, configPath}` pointers. Match the project explicitly. The registry is only an agent lookup aid; the app never reads it or discovers other instances.
2. Reuse a matching installation, or install a project copy with the lightweight [Tinka skill](skill/tinka/SKILL.md). Keep the replaceable app, external config, and boards in separate locations. Initialize with the project label and automatic ports unless a fixed port was requested.
3. Read [the folder protocol](docs/PROTOCOL.md). Create the board and register every experiment slot in `rounds.json` before building. Set truthful `reserved`, `building`, `review`, and `ready` states. Keep previous rounds, revisions, stable IDs, and notes.
4. Give each experiment an independent entry point, assets, run instructions, and a README describing real versus simulated behavior, dependencies, and transfer guidance. Use the target product's styling. Tinka supports HTML, independently running framework previews, images, Markdown, video, and PDF; it never executes experiment start commands.
5. Check the actual interaction before marking a slot ready. Files and manifests update automatically; an active preview offers a reload instead of interrupting the user. Use the home breadcrumb, exploration picker, zoom, overview, and reset controls to navigate. On narrow screens the collapsed bar scrolls horizontally to retain its controls.
6. Verify `GET /api/health` against the selected config and project label. Report the actual printed/saved URL, version, and what you checked. A registry entry or PID alone is not proof of a healthy app.

Browser storage keys include an identity derived from this config's canonical path and boards root. A different project later using the same port cannot inherit its notes or view settings. Note writes also check the workspace identity, so stale tabs cannot write into a project that later takes their old port. Server notes remain in each board's `.state/notes.json`; older unscoped browser caches are left untouched and are not automatically imported. Export any browser-only notes from the old app before upgrading.

## Upgrade one project

```sh
node /absolute/tinka/scripts/install.mjs \
  --install-dir /absolute/project/.tinka/app \
  --config /absolute/project/tinka.config.json \
  --version 0.2.0
```

Omit `--version` to choose the latest published release. The installer verifies SHA-256 and archive paths, stages a complete replacement, stops only the owned managed instance, keeps a backup, and restarts it if it was running. Failed replacement or restart restores the backup and attempts to restart the old app. Each installation records its version and archive checksum in `INSTALLATION.json`. Upgrades are explicit and affect only the supplied installation. Keep one installed app copy per project when projects need independent upgrades; do not point multiple configs at an app directory you intend to replace.

Config, boards, notes, logs, and PID state must stay outside the app directory. Existing version 0.1 configs remain fixed-port configurations; add `"projectLabel": "Your project"` and optionally `"portMode": "auto"`. The legacy `title` property remains accepted but project identity comes from `projectLabel`.

See [operations](docs/README.md), [release packaging](docs/RELEASE.md), and [maintainer guidance](AGENTS.md). No open-source license has been selected for this repository.
