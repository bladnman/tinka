# Tinka board protocol

Tinka is a review surface. An experiment belongs to the product it is exploring, not to this review app. The app reads a board manifest and files; an experiment must remain runnable without the Tinka server, browser messages, or a host SDK.

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

Each experiment and board has a **Remove…** action that prepares a copyable agent prompt. The browser does not delete or move files. The prompt identifies the project, workspace, config, board and, for an experiment, its round and stable ID. Verify that identity against `/api/health` before editing.

When the owner supplies a removal prompt, remove exactly that target. For an experiment, save a recoverable manifest copy in the board's `.state` folder, then remove its concept and revision entries from `rounds.json`. Keep its files, shared dependencies, notes and build history; leave other IDs, numbering and rounds intact. For a board, move its complete folder to a recoverable archive outside `boardsRoot`, preserving all contents. Report the archive or snapshot location and verify that the target has disappeared from the review surface. Do not recreate removed reference material. An already absent target is a completed removal, not permission to choose a substitute.
