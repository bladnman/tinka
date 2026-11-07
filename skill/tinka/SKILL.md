---
name: tinka
description: Show visual work on this project's Tinka boards. Use when creating or showing designs, mockups, images, illustrations, diagrams, prototypes, visual comparisons or screenshots in a project that has Tinka (a TINKA.md or tinka/project.json), and whenever the user mentions Tinka. Tinka also works without this optional skill.
---

# Tinka

In a project with Tinka, visual work for the user goes on a board: add it there
and give the user the board link rather than a separate file, hosted page or
browser preview, unless the user asks for a particular file or destination.

Read the project's `AGENTS.md` and `TINKA.md` to locate its boards and
installation. Follow the selected app's `docs/AGENT.md` (or its README on older
installs) and `docs/PROTOCOL.md`, plus the board's own instructions. Those files carry the guidance for that installed version.

If the app is missing, follow the project's checked-in `tinka/setup.mjs` and
`tinka/project.json` to restore its pinned release. Existing installations may
use other paths; an optional `~/.config/tinka/workspaces.json` has legacy
`{projectRoot, appPath, configPath}` pointers. Match the project explicitly.

If no setup exists, use https://github.com/bladnman/tinka for installation.
Preserve existing boards, earlier rounds, stable IDs and notes. Keep durable
project content outside the replaceable app. No skill is required by Tinka.
