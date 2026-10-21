# Tinka

Tinka is a **free, project-local workspace for ideas, resources and experiments created with your AI agent**. Keep title-only ideas, notes, HTML, images, videos, documents, external links and live applications together. Arrange the same item on several boards, open its content or children, and collect review notes without moving its files. Existing design rounds and comparison readers remain supported.

Each project gets its own instance. You can run `Tinka / Atlas` and `Tinka / Orchard` at the same time, with separate boards, notes, configuration, processes, and saved URLs. There is no master service or shared port allocator.

[See Tinka](https://tinka.metal-sole.com/) · [Try the working examples](https://tinka.metal-sole.com/#example) · [Agent setup guide](https://tinka.metal-sole.com/install.md)

![A Tinka board comparing three Glade reading designs, with a sample essay and example feedback.](https://tinka.metal-sole.com/shared/board.webp?v=glade-20261016)

## Quick start

Tell the agent you already use for your project:

```text
Add Tinka to this project:
https://tinka.metal-sole.com
```

Your agent can read the setup instructions, install Tinka and start this project's
local canvas. No separate agent skill is required. Agents should read the
[agent guide](docs/AGENT.md) and the manual setup below.

Open an experiment, try its interactions, and leave a note for the next round.
These public examples use sample content.

![The Open book reading design open in Tinka, with the other reading alternatives still on its board.](https://tinka.metal-sole.com/shared/experiment.webp?v=glade-20261016)

### Manual setup

Tinka uses **Node.js 22 or newer**, has **no runtime npm dependencies**, and binds only to `127.0.0.1`. Managed start/stop uses `ps`, so use macOS or Linux. The package is internally named `board-room` for compatibility with the original installer; the product is Tinka.

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

New workspaces and boards start empty. Reference boards and starter experiments are optional. Legacy boards retain their copyable removal prompts. In schema 2 workspaces, removal changes metadata and keeps resource files.

Each board can have its own cover image instead of the default paper artwork. Use **Change cover…** for an agent prompt, or set `"cover": "assets/cover.svg"` in that board's `board.json`. A **1200 × 600** image is recommended; see [cover images](docs/PROTOCOL.md#board-cover-image) for the file and design guidance.

Stop only this instance with `node /absolute/project/tinka/app/cli.mjs stop --config /absolute/project/tinka/local/config.json`. Use `serve` for a foreground process and Ctrl-C to stop it. PID and log files live beside the config. Managed stop checks the recorded PID, CLI path, config path, and unique process token before signaling anything.

## Initialize the flexible workspace

Version 0.5.0 adds a schema 2 workspace while preserving legacy board folders.
Initialization and migration are explicit; an app upgrade alone changes no project data.

```sh
node /absolute/app/cli.mjs workspace migrate --config /absolute/config.json --dry-run
node /absolute/app/cli.mjs workspace migrate --config /absolute/config.json --apply
node /absolute/app/cli.mjs workspace show --config /absolute/config.json
```

With no legacy boards, `workspace init --apply` initializes an empty workspace.
Metadata lives in `boardsRoot/.tinka` unless the external config specifies an
absolute `workspaceRoot`. Keep this durable directory, original board folders,
and named resource folders in project version control or an explicit backup.
App replacement never includes them. Default metadata under boardsRoot travels with committed boards; a custom absolute workspaceRoot needs deliberate backup and restoration on another machine. A copied workspace retains stable graph IDs;
this machine's config identity remains separate.

An item may have content, a child board, both, or only a title. Collection boards
automatically show up to four of their current items as an uncropped cover grid,
using saved previews, local images or local HTML. Existing covers take priority;
no cover image or extra agent task is required. References share
notes, stars and status. Each placement has its own position and size. Grid and
Canvas show the same board; moving or removing a placement does not move or delete
files. An external URL can open in a separate tab. A stopped local app retains its
preview and start instructions, with retry when its independently managed server
returns. Tinka does not run commands from item metadata.

The header keeps Home, a parent return when applicable, the current title and Tools. Open Tools for + Add (Text, Colored region, Arrow, items and boards), Grid/Canvas, search, filters, details, notes export and help. Item details and appearance are in the card’s ⋯ menu. The reader keeps its containing-board return beside Home, with comparison settings and item actions in View.

New graph boards open in Canvas unless you have already chosen Grid. Scroll with
a mouse or trackpad to pan; Shift-scroll moves sideways. On a touch screen, swipe
the background. Pinch or Control/⌘-scroll zooms. Drag a card’s body to move it;
a click opens its preview, while notes, links and buttons keep their normal
behavior. Drag onto the interior of a board card to move the item inside it;
the destination outline and “Move into…” hint confirm the target. Its automatic
cover updates after the move. Escape cancels a drag. Move / resize and the
selection toolbar’s Move… action provide keyboard and touch alternatives.
To bring an item back out, drag it onto the Parent link in the header; the hint
names that destination. A parent is available when the entry path or a unique
containing board identifies it. On a collection cover, hold a visible child tile
briefly to lift that child, then drag it onto the current canvas or another board.
Moving immediately still drags the entire collection. Releasing a held child
without moving, or returning it to its original collection, cancels the gesture.
Select several cards, then drag any selected card to move the visible selection
together. Their arrangement stays intact on the canvas, inside a destination
board, or when dropping onto Parent. Dragging an unselected card, resizing a card,
or deliberately holding a cover child still acts on that one item. Group drags
save together; a rejected move leaves the entire selection in place.

Agents use the same operations as the browser through HTTP or
`workspace op --json JSON` / `workspace op --file PATH`. See the
[schema 2 protocol](docs/PROTOCOL.md#schema-2-workspace) for resource declarations,
content examples, shared references, conflicts and migration rollback.

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

Browser storage keys include an identity derived from this config's canonical path and boards root, adding a custom workspace metadata root when it differs from the default. A different project later using the same port cannot inherit its notes or view settings. Note writes also check the workspace identity, so stale tabs cannot write into a project that later takes their old port. Legacy server notes remain in each board's `.state/notes.json`; schema 2 review notes are canonical item metadata. Older unscoped browser caches are left untouched and are not automatically imported. Export any browser-only notes from the old app before upgrading.

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
