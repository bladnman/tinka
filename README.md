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

Tinka uses **Node.js 22 or newer**, has **no runtime npm dependencies**, and binds only to `127.0.0.1`. It answers only requests addressed to `127.0.0.1` or `localhost` at its own port, so a web page cannot reach it through a DNS name that resolves to this computer, and board links open only on this computer. Managed start/stop uses `ps`, so use macOS or Linux. The package is internally named `board-room` for compatibility with the original installer; the product is Tinka.

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
AGENTS.md                 Short Tinka section: visual work also goes on boards; see TINKA.md
TINKA.md                  Board location, restore and operating instructions
tinka/
  project.json            Version pin, project label, relative boards path
  setup.mjs               Standalone restore helper to commit with the project
  .gitignore              Ignores only replaceable app and machine-local state
  app/                    Replaceable app; ignored by default
  local/                  This machine's config, process record and log; ignored
design/boards/            Commit boards, assets, handoffs and .state/notes.json
```

Tinka keeps that section current in the project-root `AGENTS.md` (read by Codex,
Claude Code and other agents), creating the file if needed. The section sits
between `<!-- tinka:start … -->` and `<!-- tinka:end -->` markers: setup, every
install and update, and each start of a portable project replace what is between
them and never change anything outside. Earlier unmarked Tinka text is converted
in place. No other instruction file is written.

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

On a schema-2 nested board, select representative items and choose **Show on
parent…** to place the same work beside its round on a parent board. The source
items, notes and stars remain shared; the original placements stay in place.
Position and resize the parent placements independently, and open their source
link to return to the round. Tinka's Appearance control offers System, Light and
Dark; it changes Tinka's surfaces without recoloring the work inside previews.
The installed [agent guide](docs/AGENT.md#make-the-work-visible) explains how to
build boards that show their work at a useful scale.

### One image of a board

To send a whole board as one picture, for a phone or a chat that cannot open a
board link, save an overview while the project's Tinka is running:

```sh
node /absolute/project/tinka/app/cli.mjs board overview looks \
  --config /absolute/project/tinka/local/config.json --out /absolute/project/design/looks-overview.png
```

It shows the board as it looks at its saved geometry, with only its title above
it, fitted to one PNG at most 2400 pixels wide (`--width` from 400 to 8000; a
small board is not enlarged past 125%) and as tall as the board's shape needs. It
is light by default; use `--appearance dark` for the dark look. It drives an
installed Chrome, Chromium, Edge or Brave in headless mode with a throwaway
profile (set `CHROMIUM_EXECUTABLE` to choose one) and never overwrites an existing
file. It usually takes about ten seconds, during which other Tinka commands for
this app wait; it gives up after 45 seconds, and saves nothing if the board page
fails to load. Without a browser, open `URL/boards/BOARD_ID/?overview` and take a
screenshot; that view changes nothing in the browser or the project.

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

Numbers carry through: when a tile shows a number (for example 07 from the board's manifest or an item's `number`), the reader, browser title and a child board's top bar show it too, and it follows Previous/Next. Leaving an item or child board by any route lands back on its tile with a short pan and a green pulse (no movement with reduced motion).

Version 0.7.0 uses one calm visual language: a single green (the Tinka mark's)
means on, selected or primary; neutrals are warm, dark mode is a softer warm
graphite, and tiles sit on the canvas with real elevation. The top bar has
**where** on the left — Navigator, Home, a parent return when applicable and the
current title — and **what** on the right: Find (⌘K), Undo/Redo, the Inspector and
the single primary **+ Add** (Text, Colored region, Arrow, shapes, items and
boards). The Inspector opens on demand at the right edge: with nothing chosen it
holds Grid/Canvas, the canvas background, Appearance, filters, editing, comments,
details, help, shortcuts and notes export; a tile's ⋯ (or ⌘/Ctrl-I with one tile
selected) shows that item's notes, feedback, appearance and paper, created/edited
dates and actions. Click-away or Escape closes any temporary panel or menu. Zoom
lives in one floating pill at the lower right: −, the zoom percentage (a menu with
50/100/125%, a precise slider, Fit board, Fit selection and Dots / Grid / Plain),
+ and Fit. The background choice is a per-board view preference kept in this
browser; it never changes board data. The reader keeps its containing-board return
beside Home, with comparison settings and item actions in View.

Tiles rest quietly, showing only state badges (favorite, notes, your vote). On
hover, keyboard focus or a single selection a small floating toolbar offers Open,
Comments, Vote, Favorite and ⋯ Details, and a selection circle appears at the
top-left corner. Board-tiles are places: stacked sheets, a recessed window onto
their contents, a serif name, "Board · N items · edited …" and an **Open board**
cue on hover. Dates everywhere use one readable format — "just now", "5 min ago",
"2 hours ago", "Yesterday, 3:40 PM", "Sat, 9:12 AM", "Oct 21", "Oct 28, 2025" —
with the exact time on hover.

Open **Navigator** (⌘/Ctrl-K, /, the left top-bar button or Find) from Home or any
board to explore the project’s board tree and find named items. It floats beside
the work at the left without locking the board; click-away or Escape closes it,
and **Keep open** docks it (remembered in this browser). Search comes first, then
recently visited boards, the board tree and an outline of the current board's
items grouped by region. Current ancestors expand automatically and the current
board is marked once. Boards and On this board are separate, collapsible sections; selecting tiles on
the board lights their rows in the outline and scrolls the first into view. Shared boards retain their separate parent references. Search names
and descriptions across **Whole project**, **This board**, or **This board and
descendants**. Results show the item type and board path; choose a location to
open that exact board and reveal its placement at a useful zoom. Search does not
hide cards on the canvas. The Inspector's Filter remains a separate view filter.
Legacy boards appear in the tree and can be found by board name; legacy experiment
contents are not included in project search. Escape clears the search, then closes
Navigator and returns focus.

New visual items use Full preview automatically, with a 720 × 560 placement;
title-only ideas use Compact card. Agents and the Add form use the same defaults.
Compact cards keep clear titles above uncropped images and readable build status.
Saved layouts and explicit appearance choices stay as authored; use an item's
Inspector → Appearance → Full when you want to change an existing placement.

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
Select without checkboxes: Shift-, ⌘- or Ctrl-click a tile (a plain click still
opens it), click its corner selection circle, or drag a box. Selected tiles get a
green ring and check, and one floating selection bar at the bottom acts on them.
The toolbar, selection circle and resize controls keep their separate actions.
Right-click a native card for a short menu: Open, Details…, Favorite, Move to
board…, Duplicate and Remove from board.

Use ⌘D / Ctrl-D to duplicate the visible selection without changing the clipboard.
The independent copies retain arrangement, dimensions, appearance and feedback,
share existing resource files, and appear 32 canvas units diagonally from the
originals. They become selected and are one Undo/Redo step. ⌘A / Ctrl-A selects
all rendered cards; Enter opens the sole selected item; ⌘/Ctrl-K or / opens
Navigator; ⌘/Ctrl-I opens the Inspector; Shift-1 fits the board, Shift-2 fits the
selection and Shift-0 zooms to 100%. ? or Inspector → Keyboard shortcuts shows the
shortcut sheet.
Editing fields, readers, iframes and dialogs keep their native keys.

Press Delete or Backspace to remove selected Tinkas from this board immediately.
⌘Z / Ctrl-Z restores the exact placements and arrangement; Redo removes them
again. Notes, stars, child boards, resource files and references on other boards
stay available. The toolbar’s Remove from board action is also undoable and
retains its confirmation. Editing fields, readers, dialogs and active gestures
keep their normal keys. A successful removal cancels any pending Cut intent.

Use ⌘Z / Ctrl-Z to undo a move and ⇧⌘Z / Ctrl-Shift-Z to redo it. The top bar and Inspector also have
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
stay in place. The Inspector also offers Copy selection and a Paste shortcut reminder.
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

## Draw, read and discuss

+ Add includes Sticky note, Process (rounded box), Decision (diamond)
and Start / end (ellipse) alongside text, colored regions and arrows. Select an object to move, resize, recolor or
edit its text. Drag between the connection ports on cards and shapes to attach
an arrow; its endpoints follow the targets during movement and resizing. Drag an
endpoint to reconnect it or leave a free point. The exact-geometry control uses
logical board units and shows free, attached or detached endpoints. Dragging an attached arrow’s body keeps its attachments. Use endpoint handles
to reconnect, or More → Detach start/end/both to make resolved endpoints free.
Reverse swaps the complete endpoints while keeping the arrow identity. Arrow text appears at its midpoint. Escape
cancels a gesture. Focus a decoration and press Enter for exact geometry or F2
to edit its text. Decoration edits do not join card movement Undo/Redo.
Sticky and label text use plain Enter for a newline and Cmd/Ctrl+Enter to finish.
Notes and conversation composers use the same scoped shortcut, with a platform
hint. Failed saves preserve drafts; click-away never posts a comment. Small saved
cards keep their size and expose hidden actions through More and selection controls.

A linked local Markdown item uses its actual named-root file in both its full
preview panel and reader. The reader offers Contents, the root-relative source
link and Reload source. Select text in the current document to comment on that
passage or save a persistent Highlight without a comment. Comments and replies
open in a compact conversation inside the existing reader, keeping the passage
visible. Highlights retain source-match status after edits. Raw HTML is displayed as text. Documents are limited to
2 MiB. Simple pipe tables support up to 16 columns and 200 rows. Source edits retain comment history and report uncertain or unlocated
quotes instead of silently moving a highlight. Historical document versions
remain readable; open the current version to comment.

Open Comments for a board-wide note or use an item's comment button for
its discussion. Add point can attach a note within a card or shape so it follows
that target; old fixed points keep their original position. A missing target
retains an explicitly detached original point. Show/hide pins, unresolved-only
filtering and resolve/reopen keep discussions recoverable. Yes, No and Abstain
replace your own prior vote; Clear removes it. No vote and Abstain are distinct.
Actor names are self-reported local labels.

Open views receive local server push updates from browser, CLI and project-file
changes. Reconnecting resynchronizes current state. Incoming changes preserve
review drafts and defer reconciliation through active gestures; an open preview
gets a reload offer when its source changes. Each project retains its independent
stream and runtime identity. Healthy connections do not poll workspace documents.

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
explicitly retries. In a portable project, the newly installed app refreshes the
managed Tinka section in `AGENTS.md` when it starts, for manual and automatic
updates alike; review and commit that change with the pin. `off` disables automatic checks. `update check` explicitly
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

Boards on Home appear newest-created first, including graph and legacy boards
together. Nested board cards in Grid use the child board’s creation date within
each retained round, sorting only among board-card slots. Other items, Canvas
geometry, saved review order and reader comparison order stay intact. Renames,
notes and edits do not change this display order. Equal dates retain source order;
boards with missing or invalid dates follow dated boards in source order.
Each Home card's window is a miniature of the board — its regions and tiles at their real positions, with saved images and a few live HTML thumbnails — or, for boards too sprawling to read that small, a collage of four items; the same window appears on board-tiles inside boards. Select Home cards the same way as tiles: the corner circle, Shift/⌘/Ctrl-click or a drag box on empty space, then act from the floating selection bar. Every Home card shows when the board was created ("Created 2 hours ago"), a
quieter "edited …" line when it changed later, and a neutral **New** marker for
boards created in the last 24 hours. Find filters the cards by name or
description (/ focuses it), and the sort control offers **Newest** (the default),
**Recently edited** and **A–Z**; the choice is remembered in this browser and the
primary date always matches it.
