---
name: tinka
description: Create, extend, review, install, or upgrade Tinka boards, the local folder-driven canvas for portable experiments, images, designs, and versions. Trigger when the user explicitly says Tinka or Tinka board. Do not trigger merely for ordinary design, prototype, or board requests that do not refer to Tinka.
---

# Tinka

A Tinka workspace contains independent boards. Each board is a folder under a configured boards root; dated explorations contain portable experiments. The application is replaceable. The user's boards, notes, configuration, and runtime state live outside its installation directory.

## Find the workspace

First inspect project instructions for a Tinka config path. If present, `~/.config/tinka/workspaces.json` is a local registry with entries `{projectRoot, appPath, configPath}`. Match the current project or the board the user named; do not silently use another project's board. Read the external config and confirm `/api/health` matches its canonical config path and project label on its saved loopback port before claiming the server is running. A registry entry is a pointer, not proof of service health.

If a trusted app installation or source checkout already exists, reuse it and initialize only the external config and boards; no download is needed. If no app is available, install below from the actual repository `bladnman/tinka` or a supplied application ZIP. Use a separate app copy for each project that needs independent upgrades. Never attach to another project to resolve a port collision. Choose or ask for the board folder if the project gives no location. A typical project keeps the app in `.tinka/app`, config in `tinka.config.json`, and boards in `design/boards`; the user may place all three elsewhere. Never put boards or config inside the disposable app directory.

## Create or extend a board

Read `<appPath>/docs/PROTOCOL.md` before writing. Reuse the existing app and config. Create a board with:

```bash
node /absolute/app/cli.mjs board create board-slug --config /absolute/config.json --title "Board title" --description "What we are exploring"
```

Add a dated round to the external board's `rounds.json`, retaining previous rounds and stable IDs. Register all experiment slots and truthful `reserved` or `building` states before delegating. Assign each worker its own experiment folder; the coordinator owns manifest integration and review. Keep the preview visible as sources land. Mark runnable work `review`, then `ready` only after checking the actual interaction.

Experiments are for the target product, not for Tinka's visual style. Require independent entry points and run instructions, no host SDK, and a README describing dependencies, real versus simulated behavior, and product handoff. Support images, Markdown, video, PDFs, static HTML, or independently running framework apps through the manifest. Keep generated files and critique notes in the external board. Report its local browser URL when ready.

## Install or upgrade

This skill contains the installer, not the application. The package and archive root remain `board-room` for compatibility; the user-facing name is **Tinka**. The public release source is https://github.com/bladnman/tinka/releases/latest.

Use [scripts/install.mjs](scripts/install.mjs) with Node 22 or newer. For a user's local package, require both `--zip` and its matching `--checksum`. With no ZIP specified, the installer downloads the latest release from `bladnman/tinka`. Use `--version X.Y.Z` to pin a published version. An explicit `--repo OWNER/REPO` can select a user-supplied fork; do not invent repository URLs. The helper verifies SHA-256, rejects unsafe ZIP entries, stages a complete app, and retains a backup when replacing an installation.

```bash
node scripts/install.mjs --zip /absolute/tinka-v0.2.1.zip --checksum /absolute/tinka-v0.2.1.zip.sha256 --install-dir /absolute/app
node scripts/install.mjs --install-dir /absolute/project/.tinka/app --version 0.2.1
```

Keep config, boards, notes, and PID/log files outside `--install-dir`. The install path can be visible or a dotfolder. An upgrade requires `--config /absolute/config.json`; the installer uses the old CLI to stop only its verified managed process, swaps the app, and restarts it through the new CLI if it was running. On a fresh install, use `node /absolute/app/cli.mjs init --config /absolute/config.json --boards /absolute/boards --label "Project name"`. Do not overwrite an existing config or board.

Omitting `--port` uses automatic selection: 43821, 43921, 44021, up to 20 candidates, with the actual bound port saved per config. Restarts try the saved port first. A numeric `--port` is fixed and fails clearly if occupied. Never kill, adopt, or reconfigure another instance. The registry is only an agent lookup aid; Tinka does not read it at runtime.

After a fresh initialization, start with `node /absolute/app/cli.mjs start --config /absolute/config.json`. Record the workspace's actual project, installation, and config paths in the local registry if the project uses it. Verify `/api/health` and the front page show the right project label, version, and config; report the URL actually returned by start, which may differ from 43821. Each installation records its version and SHA-256 in `INSTALLATION.json`; upgrades only affect the specified app copy. Before upgrading an older app, export any browser-only notes; disk notes are preserved and old unscoped browser caches are left untouched. Installing or upgrading does not publish a release or authorize changes to a user's board content.
