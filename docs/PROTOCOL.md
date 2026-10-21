# Tinka board protocol

Tinka is a review surface. An experiment belongs to the product it is exploring, not to this review app. The app reads a board manifest and files; an experiment must remain runnable without the Tinka server, browser messages, or a host SDK.

## Schema 2 workspace

Schema 2 separates canonical items from board placements. It is explicitly enabled through `workspace init --apply` or `workspace migrate --apply`; merely installing the app does not convert a project. The metadata directory is `config.workspaceRoot` or `boardsRoot/.tinka`. Resource files remain outside that metadata and outside the replaceable app. Node 22+, ordinary JSON and files are sufficient; no SDK, dependency install, global registry or master process is required.

### Initialize, migrate and recover

```sh
node /absolute/app/cli.mjs workspace migrate --config /absolute/config.json --dry-run
node /absolute/app/cli.mjs workspace migrate --config /absolute/config.json --apply
node /absolute/app/cli.mjs workspace show --config /absolute/config.json
```

Dry-run is the default; only `--apply` writes. `workspace init` is an alias that also initializes a project with zero legacy boards. Back up the external boards, complete workspace metadata and resource folders before applying. Conversion retains original manifests, files, review notes and build history, including orphan feedback and revision lineage. It preserves legacy board IDs and records original round/concept keys on migrated items. Repeated conversion is safe and does not create duplicate migrated identities. Inspect the migration report before accepting it. After conversion, the canonical store owns organization, revisions, build state and feedback. Original board manifests, notes and AGENTS guides are preserved historical sources; editing them does not update migrated metadata. Detect the enabled workspace with GET `/api/workspace` or `workspace show`, then follow this schema 2 contract even when an older board guide says to edit rounds or notes directly. Prototype HTML/assets remain live editable resources.

CLI and HTTP share a locked transaction store, journal recovery and revision checks. Reopening the store rolls an interrupted journal forward after lock ownership is established. A lock is reclaimed automatically only when its recorded owner is provably dead. A crash before owner metadata is written, unverifiable ownership, or an orphan recovery guard fails closed with 409 instead of breaking a lock after a timeout. Stop and verify all server/CLI writers for this workspace before manual recovery; inspect and archive or rename only the orphan lock/guard metadata, preserving the complete workspace and `pending.json`, then reopen to apply the journal. This is redo recovery, not a guarantee against every crash or power-loss scenario. Back up and restore the complete metadata directory, rather than selected JSON files. For rollback to the unchanged legacy folders, stop only this instance, move the metadata directory to a recoverable archive outside its configured workspaceRoot, and restart. Graph-only items and later canonical feedback reappear when that metadata archive is restored. App replacement and data conversion are separate actions.

### Items, resources and children

An item has a stable `id`, `title`, `description`, optional `content`, optional `preview`, `revisions`, `review:{note,star,updatedAt}`, and `build:{state,message,updatedAt}`. It can have a `childBoardId` as well as content. Boards have an `ownerItemId`, `placements`, `reviewOrder`, `rounds`, `decorations` and optional `background`. A placement has `id,itemId,x,y,width,height,z`; archive/removal timestamps are local to it. Canonical archive/delete timestamps affect the item across references. Dates and original legacy records remain available for inspection.

Run operations from an agent with JSON or a file:

```sh
node /absolute/app/cli.mjs workspace op --config /absolute/config.json \
  --json '{"type":"createBoard","id":"ideas","title":"Ideas"}'
node /absolute/app/cli.mjs workspace op --config /absolute/config.json \
  --json '{"type":"createItem","boardId":"ideas","item":{"id":"opening-idea","title":"A better opening"}}'
node /absolute/app/cli.mjs workspace op --config /absolute/config.json --file /absolute/operation.json
```

Register named roots with `updateWorkspace`. Paths are relative to the workspace metadata directory, so projects can retain their existing folders. For example, if the metadata is `design/boards/.tinka` and the payload folder is `design/boards/experiments`, the registration is:

```json
{"type":"updateWorkspace","patch":{"resourceRoots":{"experiments":{"path":"../experiments"}}}}
```

An HTML item references its canonical entry point; ordinary relative assets resolve under the same named root:

```json
{"type":"createItem","boardId":"ideas","item":{"title":"Quiet opening","content":{"kind":"html","resource":{"rootId":"experiments","path":"quiet/index.html"}},"preview":{"resource":{"rootId":"experiments","path":"quiet/preview.png"}}}}
```

Other local kinds are `image`, `video`, `audio`, `pdf`, `markdown` and `file`. Inline notes use `{"kind":"note","text":"The thought to retain."}` or `text`. A title-only idea needs no image or content. File payloads never go into board JSON. Named-root serving rejects dotfiles, unsafe paths and symlink escapes and supports byte ranges for media. Declare only the project folders intended for this workspace.

An external document can open separately:

```json
{"type":"createItem","boardId":"ideas","item":{"title":"Research document","content":{"kind":"url","url":"https://example.org/document","openMode":"external"}}}
```

A local server may retain a screenshot and declarative start instructions:

```json
{"type":"createItem","boardId":"ideas","item":{"title":"Interactive prototype","content":{"kind":"html","url":"http://127.0.0.1:5173/","openMode":"preview","startInstructions":"In the prototype folder run its documented development command, then retry."},"preview":{"resource":{"rootId":"experiments","path":"prototype/preview.png"}}}}
```

The independently managed app owns startup, shutdown and hot updates. Tinka supplies a representation, instructions and retry/open actions when it is offline; it never executes instructions or fetches arbitrary URLs server-side. Embedding may depend on the target server's headers; external opening remains available. Each experiment retains its own README, assets and run instructions and can run without Tinka.

Attach children to an existing item with `{"type":"createBoard","itemId":"opening-idea","title":"Opening details","parentBoardId":"ideas"}`. The item keeps its content while gaining a Board view. Creating a board without `parentBoardId` adds it to home. Board containment is a directed acyclic graph; references that create a cycle fail.

### Organization and review

`reference` adds placements for the same canonical items; notes, stars and build state are shared. `move` changes memberships without moving files. Use `sourceBoardId` plus `placementIds`, or `itemIds`; supply `targetBoardId` or `newBoard:{title,parentBoardId?,id?}`. To group selected placements inside their current board atomically, set `newBoard.parentBoardId` to `sourceBoardId`; board creation, owner placement and move/reference commit in one revision, with source geometry retained inside the new board. With no target, only board-owner items can move/reference onto home. Moving a board owner into another board removes its home membership; referencing it keeps home membership.

```json
{"type":"reference","sourceBoardId":"ideas","placementIds":["PLACEMENT_ID"],"targetBoardId":"shortlist"}
```

```json
{"type":"move","sourceBoardId":"ideas","placementIds":["PLACEMENT_ID"],"newBoard":{"title":"Next round"}}
```

`duplicate` takes `itemId` and optional `targetBoardId` and creates an independent canonical item pointing at the same files. A board duplicate copies its arrangement while retaining references to its children. `archive` takes `boardId,placementIds,archived`; `archiveItem` takes `itemIds,archived`. `remove` detaches placements. `deleteItem` marks canonical items deleted across placements. None deletes resource files. Restore archives with `archived:false`; removal/deletion remains recoverable in metadata backups/history and the resource payload remains intact.

Canvas also submits `move` when a dragged placement is released inside a valid,
visible board card. An outline and “Move into…” hint identify the destination;
ordinary card overlap is still freeform arrangement. The existing selection
toolbar’s Move… action provides a keyboard alternative. A successful drop
refreshes the automatic collection cover without creating a new item or preview.
The resolved Parent header link is also a drop destination; multiple parents
require an existing valid entry context or a unique parent. Dropping there keeps
the current board open and places the item in a clear spot beside its containing
board. Holding a direct visible collection-cover tile for 450 ms lifts that child
as a labelled proxy. Immediate movement instead drags the collection. A lifted
child can move from its collection to the current canvas, another board or the
resolved parent. Release without movement, return to its source collection,
Escape, cancellation, loss of focus or a second pointer makes no mutation.

For a single moved source placement and an existing `targetBoardId`, `move` may
include `targetPosition:{x,y}`. Both coordinates must be finite numbers within
±10000000. Membership and destination geometry commit together in one revision;
the new placement retains source dimensions/presentation and appears above
existing destination placements. References, multi-placement moves and new-board
moves omit this option. Canvas pull-outs use the logical release point as the
new placement’s top-left corner.

`updatePlacement` patches `x,y,width,height,z,presentation`. Presentation is local to a placement: omit it or use `{"mode":"card"}` for the original card; use `{"mode":"icon"}` for a compact icon, or `{"mode":"panel","viewport":{"width":360,"height":650}}` to show a full HTML/image design viewport, fitted without cropping. Viewport dimensions are integers from 40 to 10000; the default is 1000×720. Placement width/height include the compact caption. For a 360×650 design at natural size, use width 362 and height 696 (borders plus caption). Canvas starts at 100% and scrolls naturally; Grid retains panel dimensions for comparison. The item footer’s ⋯ (Item details) control opens an attached, nonmodal popup with canonical notes, Full preview / Compact card / Icon appearance choices and paper swatches. Appearance is placement-local. The optional `presentation.paper` is a hexadecimal color (`#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`); omission retains the default paper. When changing appearance, preserve existing `viewport` and `paper` values as appropriate: `updatePlacement` replaces the supplied presentation object. The popup does not expose geometry fields. Full preview uses a supplied preview image when available, with the same uncropped sizing as an HTML fallback; the primary content and canonical identity stay unchanged. The same canonical item may have a card reference elsewhere; notes, stars, revisions and reader behavior stay shared. `createItem.placement` accepts the same presentation field. `updateBoard` patches `title,description,reviewOrder,decorations,background`; `background.resource` is a named-root reference. Decorations are board-local presentation metadata. Text, region and line decorations retain `id,type,x,y,width,height,color,text`. A line may additionally set boolean `endArrow`, `flipX` and `flipY`: `endArrow:true` adds the arrowhead at its end, while the flips reverse the horizontal and vertical start/end orientation within its positive-size bounding box. Absent flags preserve ordinary lines. The Add menu offers Text, Colored region and Arrow, with direct on-board editing controls. Ordinary lines remain supported decoration metadata. `updateItem` changes title, description, content, preview, revisions or build metadata. Review is `{"type":"review","itemId":"opening-idea","patch":{"note":"Try a shorter introduction.","star":true}}`. `status --board BOARD ITEM_ID reserved|building|review|ready [MESSAGE]` also updates canonical build state; migrated `ROUND/CONCEPT` keys remain accepted.

A board-only item’s primary cover/title action opens its child board directly. An item with both content and children keeps the content action and an explicit Open board choice. Comparison-reader stepping remains available.

Collection covers are derived at read time from up to four visible placements in review order, with a quiet remaining count for larger boards. Saved item preview images take priority, followed by local image content and local HTML fitted to the placement's complete viewport. Unsupported, unavailable and board-only children use title tiles; nested collections do not recursively embed their descendants. An explicit owner preview retains priority over the automatic cover. Composites retain their own primary content. Covers require no stored preview type, metadata write, migration or generated file and apply to existing collections after upgrade.

Local HTML cover thumbnails use an inert sandbox with an opaque origin. Local render scripts and styles can draw the design; parent access, storage, forms, nested frames, network APIs and remote assets are unavailable. Applications requiring those capabilities should supply a saved preview image. Relative local static assets are fingerprinted within their declared resource root with a bounded dependency walk (64 files, eight levels); content changes update the affected thumbnail while ordinary placement and review edits retain existing media documents.

Grid and Canvas use the same placements. Review order is separate from freeform geometry and remains suitable for comparison. Graph boards retain the comparison reader's previous/next, dots, revisions, notes/star, sizing, standalone opening and browser Back/Forward behavior. The compact header shows Home, an explicit parent return when applicable, one current title and Tools. Tools contains + Add, Grid/Canvas, search, recent, starred and archive views, board details, export and help. A valid `?from=BOARD_ID` retains the entry parent; ambiguous parents without entry context open a chooser. The reader uses Home, a containing-board return and one current item title; View holds comparison settings and item actions. Search, recent, starred and archive views operate on canonical items; a shared reference does not create another source of truth.

### HTTP and concurrent agents

GET `/api/workspace` returns `{enabled:false,revision:0}` before initialization, or the schema 2 snapshot with `enabled:true`, `items:[]`, `boards:[]`, `homeBoardIds` and `resourceRoots`. GET `/api/boards` lists home graph boards and unmigrated legacy boards; the complete destination catalog is in `/api/workspace.boards`. GET `/api/boards/:id` returns the schema 2 board snapshot with canonical `items` keyed by ID, or the legacy response for an unmigrated board. Workspace and board responses add derived `boardCovers` keyed by represented board ID, with `count` and at most four `tiles`; these are response data, not stored metadata. GET `/api/items/:id` returns one canonical item. GET `/api/items/:id/cover-thumbnail` returns a confined local HTML cover representation. `/resources/:rootId/PATH` serves declared local resources and preserves relative HTML asset URLs.

POST `/api/operations` accepts one operation as its JSON body. PATCH `/api/items/:id/review` accepts `{patch:{note,star},expectedRevision?,operationId?}`. POST `/api/workspace/migrate` requires explicit `{dryRun:true}` or `{dryRun:false}`. Legacy notes endpoints remain supported for legacy boards.

Every HTTP write requires `Content-Type: application/json` and `x-tinka-workspace` equal to the **live `/api/config.workspaceId`**. That machine identity preserves the existing config/boards namespace for the default metadata location, and additionally scopes a genuinely custom workspaceRoot. It is distinct from the durable `/api/workspace.workspaceId`. Same-origin Host/Origin checks and a 1 MB request limit apply. A stale tab or changed live config cannot save into a different project. CLI operations address their explicit config and use the same locks.

Each operation may include `expectedRevision` and a unique `operationId`. A stale revision returns 409; reload and reconcile the intended edit before retrying. A repeated operation ID with identical payload replays its result; reuse with different input fails. Idempotence receipts retain the most recent 64 operations. Successful operations return `{revision,result}` with created IDs. Invalid operations return 400, unknown targets 404, cycles/conflicts 409; no partial metadata change is committed.

## Legacy boards

The sections below describe schema 1 folders. They remain readable without migration. For schema 2 items and direct organization operations, see the workspace contract above.

## Start a board

Create a board with `node cli.mjs board create SLUG --config /absolute/config.json --title "Title"`. Its immediate folder under `boardsRoot` contains `AGENTS.md`, `board.json`, `rounds.json`, `build-state.json`, and `.state/notes.json`. The portable guide stays with the board. Use `board guide SLUG --config PATH` to add it to an older board without overwriting an existing guide. No installed skill is required. The app never executes a manifest or an experiment start command. Keep source and evidence in that external board folder; keep the application installation replaceable.

Keep durable boards in project version control, including assets, experiment handoffs and `.state/notes.json`. A portable project records its relative boards path and version pin in `tinka/project.json`; the checked-in `tinka/setup.mjs` restores the app and rebuilds machine-local config after checkout. See the [root README](../README.md) and [agent guide](AGENT.md). Existing external boards remain supported and need their own explicit backup or transfer; they are not automatically included by checking out a product repository.

New workspaces have no boards, and new boards have no experiments. Create only what the owner requests. Do not add a reference board, workspace guide, sample or starter experiment unless requested. Reference material is ordinary optional content and can be removed like any other item.

Before assigning work, add the dated round and every reserved concept slot to `rounds.json`. Give each concept a stable `id`, visible `number`, name, category, description, question, hint, and tone. Keep earlier rounds and revisions; add a new round or revision record instead of overwriting an accepted exploration. Mark each reserved slot with `node cli.mjs status --config /absolute/config.json --board SLUG ROUND/CONCEPT reserved "Owner and intended result"`. Change it to `building`, `review`, or `ready` as observed work progresses. A named owner or a status entry alone does not prove a runnable prototype. The reviewer should see the slot and truthful status before delegation starts.

## Board cover image

Each board owns the large image at the top of its card on the home page. The two sheets of paper are fallback artwork. The project's agent can create a simple, distinctive graphic that represents the board's actual subject, then save it with the board and set the optional `cover` field in `board.json`:

```json
{
  "schemaVersion": 1,
  "title": "A better first step",
  "description": "Different ways to begin.",
  "createdAt": "2026-10-15T00:00:00Z",
  "cover": "assets/cover.svg"
}
```

- Recommended canvas: **1200 × 600 pixels (2:1)**, or an SVG with `viewBox="0 0 1200 600"`. PNG, JPEG, WebP and SVG work. Aim for a small file, ideally under 300 KB.
- Use a board-relative file path, usually `assets/cover.svg` or `assets/cover.png`. The file lives inside this board's folder, outside the replaceable app. Absolute paths, URLs and paths escaping the board are not accepted.
- Prefer a clear visual idea, diagram or illustration. The board title is already below it; avoid tiny text, private information and important details near the edges. The image scales to the card; the title supplies its accessible name.
- Edit the image or change `cover` to update the card automatically. Omit `cover` to use the default paper artwork. Each board can use its own image; no image service or Tinka SDK is required.

The home page's **Change cover…** action prepares a prompt with the board's exact workspace, file location and image specification for its agent.

## Each experiment stands alone

- Give every experiment its own entry point and run instructions. Plain HTML can be served by any static HTTP server rooted at the board, or from its experiment directory if all referenced files are local. A framework experiment runs through its own documented start command and URL.
- Design with the target product's vocabulary, layout, and behavior. Do not copy the Tinka canvas appearance unless that is the product being explored.
- Keep the implementation free of required imports from `public/`, host-only globals, and required `postMessage` responses. Optional host preference messages must safely do nothing when the experiment runs alone.
- Put an `README.md` beside the entry point. Record the concept's purpose, exact command and working directory, required files and external dependencies, what is real, what is simulated, and what should transfer to the target product. This is the handoff; a screenshot or a board status is not enough.
- If shared assets or data are required, name their paths and explain how to carry them with the experiment. Keep user data out of release ZIPs.

The manifest is an adapter. For a static experiment, omit `kind` (defaults to `html`) and `path` (defaults to `rounds/<round>/<concept>/index.html`) when those defaults are correct. Explicit `kind` values are `html`, `image`, `markdown`, `video`, and `pdf`; `path` is board-relative. A framework preview can declare an explicit HTTP(S) `url` and a board-relative `handoff` README path. The URL is a preview location, not a command for Tinka to run. Document how to start and stop that framework yourself.

Custom entry paths can use any folder layout. Tinka watches their containing directory. Declare additional shared files or directories in `dependencies` so edits outside that directory refresh the preview too. The conventional board `shared/` and `assets/` directories are also watched. A separate framework server owns its own hot updates; Tinka does not execute its start command.

Minimal `rounds.json` example (valid even before the prototype exists):

```json
{
  "rounds": [{
    "id": "2026-10-14", "number": "01", "date": "October 14, 2026",
    "title": "A different starting point", "description": "Three directions to compare.",
    "concepts": [{
      "id": "quiet", "number": "01", "name": "Quiet",
      "category": "LESS TO LEARN", "description": "A focused first step.",
      "question": "Is the next action clear?", "hint": "Try the primary action.",
      "tone": "paper", "kind": "html", "path": "experiments/quiet/index.html",
      "dependencies": ["shared"], "handoff": "experiments/quiet/README.md"
    }]
  }],
  "revisions": {}
}
```

After adding the slot, record its state with `node cli.mjs status --config /absolute/config.json --board board-slug 2026-10-14/quiet building "Building the quiet direction."`. Updates to files and manifests appear automatically; a currently open experiment offers a reload instead of interrupting the reader. Preserve its ID when changing its label or path.

To offer a comparison, add `"2026-10-14/quiet": [{"id":"second","name":"Second version","path":"experiments/quiet-v2/index.html","hint":"Compare the first action."}]` inside `revisions`. Revisions can declare their own `kind` and `dependencies` as well.

## Review and transfer

Use `building` while implementation is active, `review` when the artifact is runnable and needs evaluation, and `ready` only after that evaluation. Compare behavior in the experiment and, when relevant, in the target product. Preserve the distinction between a concept, a tested prototype, a product implementation, and a release. Notes and review decisions live in the external board's `.state/notes.json` through the UI; installation and upgrades must not edit them.

## Remove an item

Each experiment and board has a **Remove…** action that prepares a copyable agent prompt. In legacy boards, the browser does not delete or move files. The prompt identifies the project, workspace, config, board and, for an experiment, its round and stable ID. Verify that identity against `/api/health` before editing.

When the owner supplies a removal prompt, remove exactly that target. For an experiment, save a recoverable manifest copy in the board's `.state` folder, then remove its concept and revision entries from `rounds.json`. Keep its files, shared dependencies, notes and build history; leave other IDs, numbering and rounds intact. For a board, move its complete folder to a recoverable archive outside `boardsRoot`, preserving all contents. Report the archive or snapshot location and verify that the target has disappeared from the review surface. Do not recreate removed reference material. An already absent target is a completed removal, not permission to choose a substitute.
