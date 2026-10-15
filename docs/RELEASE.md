# Release packaging

1. Update `package.json` and version examples as appropriate. Run `npm test`, then `node tests/browser.mjs` for UI changes. Use external fixtures and inspect screenshots.
2. Run `node scripts/package.mjs --out /absolute/external/output`. It refuses existing output files and writes `tinka-vVERSION.zip`, `tinka-skill.zip`, and a matching `.sha256` sidecar for each.
3. Install the app ZIP using the skill installer into a temporary directory. Start two independent fixtures, check labels/URLs and notes, replace one installation, and verify the other stays healthy. Automated tests cover these cases; visual checks separately cover header, collapsed/narrow layout, and preview interactions. Stop only these temporary processes.
4. Review the source and archives for private content. The explicit app allowlist is `README.md`, `AGENTS.md`, `IMPLEMENTATION_CONTRACT.md`, `package.json`, `cli.mjs`, `server.mjs`, `public/`, `lib/`, public docs, and generic `examples/`. The app ZIP extracts to `board-room/` for installer compatibility. The separate skill ZIP extracts to `tinka/` and contains only `SKILL.md` and `scripts/install.mjs`. Neither includes personal boards, notes, configs, runtime state, registry, test output, or screenshots.
5. With publication authorized, commit and push the reviewed source to https://github.com/bladnman/tinka. Create a version tag and GitHub release with both ZIPs and checksums. Use a release-notes file with `gh release create vVERSION ... --notes-file PATH`.
6. Verify the published asset digests, then exercise a fresh installation with `node skill/tinka/scripts/install.mjs --install-dir /absolute/temporary/app`. This uses the actual latest release. `--version VERSION` selects a specific tag instead. Confirm package/receipt version and health, then stop the temporary instance.

There is no updater daemon. Each project's explicit install path and package/receipt pin its installed version. Replacing one app directory does not update another. Public repository visibility does not select an open-source license.

## Rollback

The installer retains an adjacent `.app.backup-TIMESTAMP-ID` directory. If the new install starts but a later manual review finds a problem, stop it with its own CLI and config. Move the new directory aside and move the selected backup into the original app path. Start the restored CLI using the unchanged external config. Retain both directories until verified. The installer performs this swap automatically when installation or restart fails, reporting any failed recovery step.
