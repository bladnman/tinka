# Tinka

A small, local canvas for trying things. A **Tinka Board** holds experiments, images, prototypes, alternative versions, and comparisons. Keep earlier rounds, leave notes, and return when something new lands.

Each project gets its own instance. You can run `Tinka / Atlas` and `Tinka / Orchard` at the same time, with separate boards, notes, configuration, processes, and saved URLs. There is no master service or shared port allocator.

Tinka uses **Node.js 22 or newer**, has **no runtime npm dependencies**, and binds only to `127.0.0.1`. Managed start/stop uses `ps`, so use macOS or Linux. The package is internally named `board-room` for compatibility with the original installer; the product is Tinka.

## Quick start

No agent skill is required. Use a visible `tinka/` folder for project tooling and
`design/boards/` for durable design work. Existing `.tinka` or external layouts
continue to work; these are placement recommendations, not required names.

Download `tinka-install.mjs` from the [release page](https://github.com/bladnman/tinka/releases/latest), then run:

```sh
node /absolute/tinka-install.mjs --project /absolute/project --label Atlas
node /absolute/project/tinka/app/cli.mjs start \
  --config /absolute/project/tinka/local/config.json
```

For local packages, pass the app ZIP and its matching checksum too:

```sh
node /absolute/tinka-install.mjs --project /absolute/project \
  --zip /absolute/tinka-vVERSION.zip \
  --checksum /absolute/tinka-vVERSION.zip.sha256
```

Setup creates an empty boards folder and this project structure:

```text
AGENTS.md                 Short pointer to TINKA.md; preserves existing guidance
TINKA.md                  Board location, restore and operating instructions
tinka/
  project.json            Version pin, project label, relative boards path
  setup.mjs               Standalone restore helper to commit with the project
  .gitignore              Ignores only replaceable app and machine-local state
  app/                    Replaceable app; ignored by default
  local/                  This machine's config, process record and log; ignored
design/boards/            Commit boards, assets, handoffs and .state/notes.json
```

Commit the instructions, setup helper, version pin and complete boards. On a new
machine, the app and local config can be absent. Run from the checked-out root:

```sh
node tinka/setup.mjs
node tinka/app/cli.mjs start --config tinka/local/config.json
```

Setup restores the pinned version rather than silently choosing a newer release.
It resolves relative project paths on this machine and preserves boards and notes.
For offline restoration, commit the matching `tinka/packages/tinka-vVERSION.zip`
and its `.sha256` sidecar. Setup selects that bundle automatically by version pin.
Without a bundle it needs network access, or `--zip` and `--checksum` for a local package.
Boards and experiment handoffs remain readable without the app. A hidden folder
is not automatically excluded by Git: what travels is what you commit. Check
ignore rules, especially for `.state/notes.json`. You may deliberately vendor an
app copy for offline use; keep its boards and config outside that replaceable copy.

**Open the URL printed by `start`.** A new automatic instance tries 43821, 43921, 44021, and so on, at most 20 candidates. It binds the real socket before choosing a port, saves the actual port in this instance's config, and tries that saved port first on restart. If it is occupied, the same bounded sequence continues from there. A numeric `init --port 43821` means **fixed**: a collision fails clearly without changing any other process. Omit `--label` to use the current project folder's name.

For a source checkout, run `node cli.mjs` directly; keep config and boards outside the app checkout. No build step or `npm install` is needed. `node cli.mjs project init --project /absolute/target-project` prepares portable project instructions and setup, or use `init --config /absolute/config.json --boards /absolute/boards --label Atlas` for a manual layout. The standalone installer also accepts `--install-dir /absolute/app` and `--config` for existing installations.

Create a board:

```sh
node /absolute/project/tinka/app/cli.mjs board create first-ideas \
  --config /absolute/project/tinka/local/config.json --title "A better first step"
```

Or copy [`examples/first-steps`](examples/first-steps) into the external boards root for two small, runnable experiments. The home page's **+ New board** button produces a copyable agent prompt containing this instance's label, URL, and paths.

New workspaces and boards start empty. Reference boards and starter experiments are optional. Use **Remove…** on a board or experiment to copy a prompt for your agent to remove that exact item while keeping it recoverable.

Each board can have its own cover image instead of the default paper artwork. Use **Change cover…** for an agent prompt, or set `"cover": "assets/cover.svg"` in that board's `board.json`. A **1200 × 600** image is recommended; see [cover images](docs/PROTOCOL.md#board-cover-image) for the file and design guidance.

Stop only this instance with `node /absolute/project/tinka/app/cli.mjs stop --config /absolute/project/tinka/local/config.json`. Use `serve` for a foreground process and Ctrl-C to stop it. PID and log files live beside the config. Managed stop checks the recorded PID, CLI path, config path, and unique process token before signaling anything.

## If you're an agent

Read [the agent guide](docs/AGENT.md), [folder protocol](docs/PROTOCOL.md),
the project's `TINKA.md`, and the selected board's `AGENTS.md`. The app includes
all version-specific instructions. Browser prompts identify this installation's
app, config, boards and instruction paths; they do not require a skill.

New boards carry portable instructions. Add them to an older board without
replacing an existing guide:

```sh
node /absolute/app/cli.mjs board guide board-slug --config /absolute/config.json
```

The optional Tinka skill is a small discovery pointer. Install it only if useful;
app upgrades do not require updating it. No global registry is needed for portable
projects. Legacy workspace pointers and external data layouts remain supported.

Browser storage keys include an identity derived from this config's canonical path and boards root. A different project later using the same port cannot inherit its notes or view settings. Note writes also check the workspace identity, so stale tabs cannot write into a project that later takes their old port. Server notes remain in each board's `.state/notes.json`; older unscoped browser caches are left untouched and are not automatically imported. Export any browser-only notes from the old app before upgrading.

## Upgrade one project

```sh
node tinka/setup.mjs --version X.Y.Z
```

Review and commit the updated `tinka/project.json` version pin. With no version
argument, a portable project's setup restores its existing pin. For a manual or
legacy installation, use the app's installer instead:

```sh
node /absolute/app/scripts/install.mjs \
  --install-dir /absolute/app --config /absolute/config.json --version X.Y.Z
```

For a manual installation without a project pin, omit `--version` to choose the latest published release. The installer verifies SHA-256 and archive paths, stages a complete replacement, stops only the owned managed instance, keeps a backup, and restarts it if it was running. Failed replacement or restart restores the backup and attempts to restart the old app. Each installation records its version and archive checksum in `INSTALLATION.json`. Upgrades are explicit and affect only the supplied installation. Keep one installed app copy per project when projects need independent upgrades; do not point multiple configs at an app directory you intend to replace.

Config, boards, notes, logs, and PID state must stay outside the app directory. Existing version 0.1 configs remain fixed-port configurations; add `"projectLabel": "Your project"` and optionally `"portMode": "auto"`. The legacy `title` property remains accepted but project identity comes from `projectLabel`.

See [operations](docs/README.md), [release packaging](docs/RELEASE.md), and [maintainer guidance](AGENTS.md). No open-source license has been selected for this repository.
