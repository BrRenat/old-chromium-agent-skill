# old-chromium-agent-skill

Let a coding agent launch, test and debug your build in a real old Chromium via
CrossOver and DevTools Protocol.

## What it is

A harness that runs a real old Chromium (Chromium 53.0.2785, 2016, by default)
inside a CrossOver bottle on macOS and drives it over the DevTools Protocol from
Node, packaged as a Claude skill. It exists because one unsupported token
anywhere in a bundle is a `SyntaxError` that takes down the entire file, not one
feature — so the default outcome of a transpile-target regression is a blank
white page, indistinguishable by eye from a slow feed, a 404 on the bundle, or a
graphics glitch. The harness reads the console and polls a boot flag instead of
looking at pixels, and it reports a machine-readable JSON verdict plus an exit
code an agent can branch on. There are two tiers: a ~1s static gate (`es-check`
plus `eslint-plugin-compat`) to run on every edit, and the real browser for
ground truth once the static gate is clean.

## Requirements

- **macOS** with a GUI session. Chromium predates headless mode until 59, so on
  a build that old the window has to be visible for screenshots to work — this
  will not run on a headless CI box.
- **[CrossOver](https://www.codeweavers.com/crossover)** (commercial, trial
  available), with a Windows bottle.
- **Node >= 22** — `validate.mjs` uses the global `WebSocket` and has zero
  dependencies.
- **`npx`** for the static gate (`es-check`, `eslint`, `eslint-plugin-compat`).

### CrossOver version caveat

CrossOver 27 is **Apple Silicon and macOS Sonoma or later only, and drops
support for 32-bit bottles** — see [What's in and what's out for CrossOver
27](https://www.codeweavers.com/blog/mjohnson/2026/6/11/whats-in-and-whats-out-for-crossover-27).

That matters here, because Chromium's `Win` snapshot channel is 32-bit
(`chrome-win32.zip`); `Win_x64` is the 64-bit one. If you are on an Intel Mac,
on macOS older than Sonoma, or you want to use a 32-bit snapshot, stay on
CrossOver 26 or earlier. On CrossOver 27, use a 64-bit snapshot and a 64-bit
bottle.

`cxstart` also moves between CrossOver versions. If launch fails, find it and
set `CX_BIN`:

```bash
find /Applications/CrossOver.app -name cxstart
```

## Getting a Chromium snapshot

Chromium publishes per-revision builds at the [Chromium browser snapshots
index](https://commondatastorage.googleapis.com/chromium-browser-snapshots/index.html).
Browse to the platform directory you need (`Win` for 32-bit, `Win_x64` for
64-bit), find the revision that corresponds to the version you want, and take
the `chrome-win32.zip` / `chrome-win-x64.zip` from it.

Old snapshots are best-effort archives, not releases: some revisions are missing
and there is no guarantee any particular one is still there. Pick a snapshot you
can actually get hold of rather than insisting on an exact build number.

This repo does not host, mirror, or link binaries — get them from the snapshot
index above.

## Bottle setup

1. Create a Windows bottle in CrossOver. The scripts default to a bottle named
   `old-chromium`; use any name and set `CX_BOTTLE` to match.
2. Unzip the snapshot into the bottle's C: drive, i.e. under
   `~/Library/Application Support/CrossOver/Bottles/<bottle>/drive_c/`.
3. Point `CX_EXE` at the executable, as a Windows path. The default is
   `C:\chrome-win32 2\chrome.exe`, which is just the folder name the reference
   setup ended up with — set it to wherever yours actually landed.

Wine does not virtualize the network, so a dev server bound inside the bottle,
or on the host, is reachable at plain `localhost` from either side. No port
forwarding needed.

Check the bottle works before involving the harness:

```bash
bash skills/old-chromium-validate/scripts/launch.sh
curl -s http://localhost:9222/json/version
```

## Install as a Claude skill

Copy or symlink the skill directory into your project's (or your user's)
`.claude/skills/`:

```bash
# per project
mkdir -p .claude/skills
cp -R /path/to/old-chromium-agent-skill/skills/old-chromium-validate .claude/skills/

# or symlink, to track this repo
ln -s /path/to/old-chromium-agent-skill/skills/old-chromium-validate \
      .claude/skills/old-chromium-validate
```

Claude picks it up from `SKILL.md`'s front matter and invokes the scripts by the
relative paths under `scripts/`.

For the static gate, copy the example compat config into the project root, where
`static-check.sh` looks for it:

```bash
cp /path/to/old-chromium-agent-skill/examples/.eslintrc.compat.json .
```

Change `chrome 53` in `settings.browsers` to whatever version you are actually
targeting. Keep this file separate from the project's main eslint config so the
compat gate can run against build output independently of source linting.

## Usage

Three commands, in this order. Paths are relative to the skill directory.

```bash
# 1. static gate (~1s — run on every edit)
bash scripts/static-check.sh 'dist/**/*.js'

# 2. bring up the browser (idempotent — kills any stale instance first)
bash scripts/launch.sh

# 3. validate
node scripts/validate.mjs \
  --url http://localhost:5173 \
  --sentinel 'window.__APP_BOOTED === true' \
  --screenshot ./cx-artifacts/shot.png
```

`validate.mjs` writes a JSON report to stdout and to `./cx-artifacts/report.json`,
and progress to stderr. The screenshot is an artifact for the human, not the
pass/fail gate — the console and the boot flag are the real signals.

The sentinel is a JS expression polled until it is true. Have the app set a flag
at the end of its init path (`window.__APP_BOOTED = true`) — it is the one check
that cleanly separates "never parsed" from "parsed but threw during init".

Use `--ignore` with comma-separated substrings to suppress known-noisy messages
(analytics beacons, favicon 404s) rather than lowering the bar for everything.

### Environment overrides

`CX_BOTTLE` (default `old-chromium`), `CX_EXE` (default `C:\chrome-win32 2\chrome.exe`),
`CDP_PORT` (9222), `CX_PROFILE`, `CX_BIN`, `CX_UA`, `CX_LOG`.

`CX_UA` defaults to a plain desktop Chrome 53 user agent. Override it when the
build sniffs for a particular device or the server serves per-UA bundles — for
example, to present as a 2018-era TV browser:

```bash
CX_UA='Mozilla/5.0 (SMART-TV; Linux; Tizen 4.0) AppleWebKit/537.36 (KHTML, like Gecko) 53.0.2785.34/4.0 TV Safari/537.36' \
  bash scripts/launch.sh
```

This changes what the page is told, not what the engine is. See "Scope limit".

## Exit codes

`validate.mjs`:

| Code | Meaning                               | What to do                                                                               |
| ---- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| 0    | Clean boot, no errors                 | Done                                                                                     |
| 1    | Harness failure — no CDP, no navigate | Infrastructure, not the build. Check the bottle is running                               |
| 2    | Page errors detected                  | Read `findings[]` in the report. `counts.syntax > 0` means a transpile target regression |
| 3    | No errors but sentinel never fired    | Parsed fine, died during init, or the sentinel is wrong                                  |

Exit 3 with zero findings usually means the sentinel expression is wrong rather
than the build being broken — but check the entry `<script>` tag first. Chromium
before 61 has no native ES module support, so it does not merely fail on
`<script type="module">`, it ignores the tag entirely: the bundle is never
requested, nothing is parsed, and the console stays silent.

`static-check.sh` exits 2 when either gate fails, 0 when clean. `launch.sh`
exits 1 if `cxstart` is missing or CDP never came up.

## Using a different Chromium version

Nothing here is pinned to 53; it is the version this was built and tested
against. To point it at another build:

1. Pick a snapshot you can actually get hold of, and unpack it into a bottle.
2. Set `CX_BOTTLE` and `CX_EXE` to match.
3. Change the `es-check es6` target in `scripts/static-check.sh` to your
   target's ES level, and `settings.browsers` in `.eslintrc.compat.json` to the
   matching `chrome NN`.

Navigation and `Runtime.evaluate` are the oldest, most stable parts of the
protocol and usually survive going further back. The two likely breakage points
are the CDP domain list (`Runtime` / `Console` / `Log` / `Network` / `Page` —
the harness already tolerates a missing domain, but a build may report errors
somewhere it does not listen) and the `Page.captureScreenshot` call, whose
parameters changed over time. Expect to touch those two places in
`validate.mjs`, not the rest of it.

There is no known minimum version — how far back this works has not been
established.

The quirks documented in `SKILL.md` (no headless, module scripts ignored rather
than rejected, Console/Runtime/Log domain overlap, `GET /json/new`) are specific
to the 53 era, roughly 2015–2017. On a different snapshot, re-check them rather
than assuming they still hold.

## Scope limit

This validates syntax, JS APIs, and boot behaviour of the **browser engine**. It
does **not** reproduce the environment that engine ships inside: memory
ceilings, storage APIs that are stubbed or return null in an embedded webview,
media element behaviour, input handling, or vendor patches applied on top of the
upstream build. A pass here means the bundle parses and boots on an engine of
that vintage. Whether it works on the actual target runtime is still a separate
question — do not read a green run as confidence in the target device.

## License

MIT — see [LICENSE](LICENSE).
