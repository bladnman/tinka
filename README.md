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
Drag a box on empty Canvas space with a mouse or pen to select cards; any touched
part of a card counts. Hold Shift when starting the box to add to your selection.
An empty click clears it, while Shift-click on empty space preserves it. Escape
cancels the box. Unused colored-region interiors also work; their labels and
borders remain available for moving and editing the region. Touch keeps swiping
and pinching. The selection box only changes this browser’s selection.
Select several cards, then drag any selected card to move the visible selection
together. Their arrangement stays intact on the canvas, inside a destination
board, or when dropping onto Parent. Dragging an unselected card, resizing a card,
or deliberately holding a cover child still acts on that one item. Group drags
save together; a rejected move leaves the entire selection in place.
The card’s bottom name bar also drags; clicking its title still opens the item.
Checkboxes, stars, ⋯ and resize controls keep their separate actions. Right-click
a native card to open the same notes-and-appearance popup as its ⋯ button.

Use ⌘D / Ctrl-D to duplicate the visible selection without changing the clipboard.
The independent copies retain arrangement, dimensions, appearance and feedback,
share existing resource files, and appear 32 canvas units diagonally from the
originals. They become selected and are one Undo/Redo step. ⌘A / Ctrl-A selects
all rendered cards; Enter opens the sole selected item; / opens Tools search;
Shift-1 fits the board. ? or Tools → Keyboard shortcuts shows the shortcut sheet.
Editing fields, readers, iframes and dialogs keep their native keys.

Press Delete or Backspace to remove selected Tinkas from this board immediately.
⌘Z / Ctrl-Z restores the exact placements and arrangement; Redo removes them
again. Notes, stars, child boards, resource files and references on other boards
stay available. The toolbar’s Remove from board action is also undoable and
retains its confirmation. Editing fields, readers, dialogs and active gestures
keep their normal keys. A successful removal cancels any pending Cut intent.

Use ⌘Z / Ctrl-Z to undo a move and ⇧⌘Z / Ctrl-Shift-Z to redo it. Tools also has
Undo and Redo. This tab remembers up to 50 successful movement, paste or board-removal steps for this
workspace, including across Parent/child navigation: card positioning, resizing,
selected-card nudges, and moves into or out of existing boards. A selection moves
as one step, with exact placement identities and arrangement restored. Movement undo keeps notes,
titles and content; paste undo removes only the copies that paste created. New-board creation and canonical item deletion are outside
movement history. Text fields keep their own undo, and replay is available after
gestures and writes finish. A conflicting arrangement is never overwritten; review the
latest board before retrying. New successful movement clears the redo branch.

Select Tinkas and use ⌘C / Ctrl-C, then ⌘V / Ctrl-V on the same board or another
board in this workspace. Copies keep their relative arrangement, size, appearance,
notes and stars. They have independent identities but use the same resource files.
A copied board keeps its layout and references its existing children. Originals
stay in place. Tools also offers Copy selection and a Paste shortcut reminder.
The clipboard carries the selection itself, including across tabs; unrelated text
never pastes a stale selection. Another workspace's Tinkas are rejected.

Use ⌘X / Ctrl-X on selected Tinkas to mark them for moving, then paste on another
board in this workspace. Cut leaves originals in place until paste succeeds. The
move keeps the same items, notes, stars, resources, children and relative layout;
Undo restores the original source placements. Pasting back onto the source board
makes no change and keeps the pending cut. Escape, Copy or a new Cut cancels it;
Undo first cancels a pending cut before replaying movement history. Cut is usable
once across tabs in the same browser profile. Browsers without Web Locks keep
Copy available but decline board Cut. Editing fields and readers retain native Cut.
If source placement layout/order changed, paste rejects the entire move; later
item content or feedback edits remain current. An uncertain response can retry the
same destination without creating a second move.

Paste a single HTTP(S) link to make a link Tinka with a title, description and image
when available, including public tweet metadata. Unavailable pages retain the
original address and a recognizable fallback. This explicit paste looks up bounded
public metadata; it never runs the page's HTML. Paste other text to make a document,
with a readable card excerpt and its complete text in the reader. Newlines are
preserved. Oversized pastes are rejected without truncating text. Paste selects the
new cards and clears filters so they are visible; large layouts are revealed without
changing card geometry. Each paste is one undo step. Editing fields and the reader
keep their ordinary clipboard behavior.

Paste clipboard PNG, JPEG, GIF or WebP images directly onto a board, or drop image
and PDF files onto it. Canvas imports begin at the logical cursor position; Grid
arranges them automatically. Image panels show the complete uncropped image and
open the original in the reader. PDF panels and collection covers show the first
page using the browser PDF viewer when available, with a filename/open fallback
when it is unsupported. Each batch accepts up to 20 files, at most 20 MiB each
and 50 MiB total, and becomes one undo/redo step. Undo removes the placements,
while original imported files stay available. Commit `design/boards/imports/`
(or your configured boards root’s `imports/`) with the other durable board data;
these files stay outside the replaceable app and workspace metadata.

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

## Updates for one project

Run the normal start command whenever returning to a project's boards, even if
its server is already running:

```sh
node tinka/app/cli.mjs start --config tinka/local/config.json
```

Start verifies and returns the existing instance's URL, or starts it when stopped.
Installed copies check the published latest release at most once per 24 hours per
instance. Failed/offline checks are cached too and have a short bounded timeout.
The default is **notify**: one concise agent-readable notice per new release,
with commands for the following choices:

```sh
node tinka/app/cli.mjs update now --config tinka/local/config.json
node tinka/app/cli.mjs update later --config tinka/local/config.json
node tinka/app/cli.mjs update policy auto --config tinka/local/config.json
node tinka/app/cli.mjs update policy notify --config tinka/local/config.json
node tinka/app/cli.mjs update policy off --config tinka/local/config.json
node tinka/app/cli.mjs update status --config tinka/local/config.json
```

`later` reminds again after 24 hours; it does not change the daily check interval.
`auto` is this machine's explicit consent to install compatible updates before
starting a stopped instance. A running board is left running, with the update
deferred. Failed automatic installs are attempted once per release; `update now`
explicitly retries. `off` disables automatic checks. `update check` explicitly
refreshes release information without downloading or installing an app.

Preferences/cache stay in ignored `tinka/local/updates.json`. Manual and dotfolder
layouts retain their config locations and use `CONFIG_PATH.updates.json` beside
each config, so different configs never silently share consent. No background
service, scheduler, model or registry is involved. Source checkouts do not perform
automatic release checks.

Automatic eligibility requires explicit published compatibility from the installed
version, stable releases within the same app major, supported Node/platform and
workspace/config schemas, and no migration. Version numbers alone grant nothing,
including within 0.x. The updater revalidates metadata against the checksum-verified
package. Locally modified app files or an older installation receipt without file
baselines require review. An ordinary app update never migrates workspace data.

`update now` deliberately replaces this app (including reviewed local changes),
and may restart its verified owned instance. It uses the standalone installer's
checksum, staging and backup path. A temporary health probe verifies a stopped
candidate before acceptance; its original config bytes are restored after the
probe. Failure restores the prior app/config and attempts to recover its running
service. The project pin changes only after successful health verification; review
and commit `tinka/project.json` yourself. No Git commit is created automatically.

Existing installations receive these commands through a deliberate upgrade:

```sh
node tinka/setup.mjs --version X.Y.Z
```

With no version argument, setup always restores its existing pin. Custom existing
`setup.mjs` and `TINKA.md` are preserved. Older setup helpers can install the new
feature but write receipts without file baselines. To enable future automatic
replacement safely, review local app modifications, download the **current**
`tinka-install.mjs` from the release page, and deliberately reinstall the current
version with it:

```sh
node /absolute/tinka-install.mjs --install-dir /absolute/project/tinka/app \
  --config /absolute/project/tinka/local/config.json --version X.Y.Z
```

This also works when already on the latest version and preserves custom project
instructions and setup helpers. Default policy remains notify. Keep one installed
app copy per project when projects need independent upgrades; never share an app
copy among configs you intend to update independently.

Config, boards, notes, logs, and PID state must stay outside the app directory. Existing version 0.1 configs remain fixed-port configurations; add `"projectLabel": "Your project"` and optionally `"portMode": "auto"`. The legacy `title` property remains accepted but project identity comes from `projectLabel`.

See [operations](docs/README.md), [release packaging](docs/RELEASE.md), and [maintainer guidance](AGENTS.md). No open-source license has been selected for this repository.
