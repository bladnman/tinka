# Working on Tinka

Read `README.md`, `docs/PROTOCOL.md`, `docs/RELEASE.md`, and `IMPLEMENTATION_CONTRACT.md` before changing behavior. This is a small Node >=22 ESM app with no runtime dependencies. Keep it simple.

- One instance per project is normal. No runtime registry lookup, master service, shared notes, or cross-project process discovery. Claim this config before binding; handle EADDRINUSE at bind time; persist the chosen port and report its actual URL.
- Preserve the `board-room` archive root/package identity until installer compatibility is deliberately migrated. Version comes from package.json.
- App code is disposable. Never put personal boards, notes, config, process state, private paths, screenshots, or workspace registry in this repo or the release. `examples/` is generic public content.
- Preserve prior rounds and stable IDs. Experiments own their assets and run instructions, use target-product styling, and require no Tinka SDK.
- Preserve unrelated local changes. Stop only owned temporary QA processes. Use a headless browser for QA; do not open or disrupt the user's browser or other apps.
- Validate with `npm test`. This covers backend boundaries, collision/concurrent startup, independent instances, isolated notes, and replacement installs. Run `node tests/browser.mjs` when UI changes (install Playwright separately or set `PLAYWRIGHT_MODULE` to its absolute entry point; `CHROMIUM_EXECUTABLE` can select an existing headless Chromium). Browser fixtures and screenshots are external temporary files.
- Package with `node scripts/package.mjs --out /absolute/external/release-dir`. Inspect its contents; test the packaged install before publishing. The app and skill ZIPs are separate artifacts. Release source is https://github.com/bladnman/tinka.
- See `docs/RELEASE.md` for publish and rollback checks. Public visibility is intentional; no license grant has been chosen. Do not add a license without the owner's direction.
