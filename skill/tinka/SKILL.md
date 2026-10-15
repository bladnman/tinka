---
name: tinka
description: Find and use this project's Tinka boards when the user mentions Tinka. Tinka also works without this optional discovery skill.
---

# Tinka

Read the project's `AGENTS.md` and `TINKA.md` to locate its boards and installation.
Follow the selected app's `docs/AGENT.md` (or its README on older installs) and
`docs/PROTOCOL.md`, plus the board's own instructions. Those files carry the
guidance for that installed version.

If the app is missing, follow the project's checked-in `tinka/setup.mjs` and
`tinka/project.json` to restore its pinned release. Existing installations may
use other paths; an optional `~/.config/tinka/workspaces.json` has legacy
`{projectRoot, appPath, configPath}` pointers. Match the project explicitly.

If no setup exists, use https://github.com/bladnman/tinka for installation.
Preserve existing boards, earlier rounds, stable IDs and notes. Keep durable
project content outside the replaceable app. No skill is required by Tinka.
