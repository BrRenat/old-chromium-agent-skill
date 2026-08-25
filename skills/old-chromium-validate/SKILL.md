---
name: old-chromium-validate
description: Validate that a web build parses, boots, and runs on an old Chromium (Chromium 53 by default, any build that exposes a DevTools port) running in a CrossOver bottle on macOS. Use whenever work touches legacy browser-engine compatibility — ES5/ES2015 transpile targets, babel or browserslist config, polyfills, bundle output — or whenever the user mentions an old Chrome/Chromium version, a legacy engine, a legacy target, CrossOver, or asks whether a build still works on an old runtime. Also use after any dependency upgrade or bundler change on a project with a legacy engine target, since those silently reintroduce modern syntax. Prefer this over guessing whether syntax is supported.
---

# Old Chromium build validation

Validates a build against a real old Chromium running under CrossOver on macOS.
The tested default is Chromium 53.0.2785 (2016), but any build that exposes a
DevTools port works — see "Using a different Chromium version" below. Chromium
predates headless mode until 59, so on a build that old there is no Puppeteer
path: the browser runs windowed inside a Wine bottle and is driven over the
DevTools Protocol from native macOS. Wine does not virtualize the network, so a
port bound inside the bottle is reachable at plain `localhost`.

Paths below are relative to this skill directory.

## The failure mode this exists to catch

One unsupported token anywhere in the bundle is a `SyntaxError` that takes down
the entire file, not one feature. So the default outcome of a regression is a
blank white page — which is indistinguishable, by eye, from a slow feed, a 404 on
the bundle, or a Wine graphics glitch. Screenshots are therefore a weak signal
here. The console and a boot flag are the real signals; the screenshot is an
artifact for the human, not the pass/fail gate.

## Two tiers — use them in this order

**Tier 0, static.** `scripts/static-check.sh` runs in about a second. Run it on
every edit. It catches the parse-level breakages that account for most failures.

**Tier 1, browser.** `launch.sh` + `validate.mjs`. Run once per batch of edits,
or when Tier 0 is clean but the page still misbehaves. This is ground truth for
runtime behaviour but it is slow and needs a GUI session.

Do not skip Tier 0 and go straight to the browser. Iterating against a 30-second
loop when a 1-second loop would answer the same question wastes the user's time.

## Usage

The scripts are marked executable, so `./scripts/launch.sh` works. Prefer the
`bash` / `node` form shown below anyway: it survives a copy that drops the mode
bit (which is how skills usually reach `.claude/skills/`), and it fails the same
way on every machine.

```bash
# 1. static gate
bash scripts/static-check.sh 'dist/**/*.js'

# 2. bring up the browser (idempotent — kills any stale instance first)
bash scripts/launch.sh

# 3. validate
node scripts/validate.mjs \
  --url http://localhost:5173 \
  --sentinel 'window.__APP_BOOTED === true' \
  --screenshot ./cx-artifacts/shot.png
```

### Exit codes

| Code | Meaning                               | What to do                                                                               |
| ---- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| 0    | Clean boot, no errors                 | Done                                                                                     |
| 1    | Harness failure — no CDP, no navigate | Infrastructure, not the build. Check the bottle is running                               |
| 2    | Page errors detected                  | Read `findings[]` in the report. `counts.syntax > 0` means a transpile target regression |
| 3    | No errors but sentinel never fired    | Parsed fine, died during init, or the sentinel is wrong                                  |

Exit 3 with zero findings usually means the sentinel expression is wrong rather
than the build being broken — but check the entry `<script>` tag first. Chromium
before 61 has no native ES module support, so it does not merely fail on
`<script type="module">`, it **ignores the tag entirely**: the bundle is never
requested, nothing is parsed, and the console stays silent. The signature is
exit 3, `findings: []`, and a `bodyLength` equal to the empty mount point. Rule
out a module entry point before suspecting the sentinel. Confirm it by checking
the dev server's access log for the bundle — a request that never arrived is
proof.

### Environment overrides

`CX_BOTTLE` (default `old-chromium`), `CX_EXE` (default `C:\chrome-win32 2\chrome.exe`),
`CDP_PORT` (9222), `CX_PROFILE`, `CX_BIN`, `CX_UA`, `CX_LOG`.

`CX_BIN` matters most — CrossOver moves `cxstart` between versions. If launch
fails, find it with:

```bash
find /Applications/CrossOver.app -name cxstart
```

## The boot sentinel

`validate.mjs` polls a JS expression until it is true. Have the app set a flag at
the end of its init path:

```js
window.__APP_BOOTED = true // last line of app init
```

This is worth adding to the source. It is the one check that cleanly separates
"never parsed" from "parsed but threw during init", and it does not depend on
which CDP domains this particular Chromium build implements. Without it, fall
back to something app-specific and observable — `--sentinel
'document.querySelector("#app").children.length > 0'` — but a real flag is
better.

## Interpreting findings

- `kind: "console"` containing `SyntaxError` or `Unexpected token` — transpile
  target regression. Check `browserslist` / babel targets before anything else.
  A dependency shipping untranspiled modern ESM is the usual culprit, not the
  app's own source.
- `kind: "network"` with a 404 or `loadingFailed` — the bundle never arrived.
  Not a compatibility problem.
- `kind: "exception"` with a `TypeError: undefined is not a function` — a missing
  API rather than missing syntax. `Object.values`, `Object.entries` (both Chrome
  54), `Promise.finally` (63), `Array.flat` (69) are the common ones. Needs a
  polyfill, not a transpile change.

Use `--ignore` with comma-separated substrings to suppress known-noisy messages
(analytics beacons, favicon 404s) rather than lowering the bar for everything.

## Chromium 53 quirks worth knowing

These are specific to that era of the engine (roughly 2015–2017). On a different
snapshot, re-check them rather than assuming they still hold.

- **No headless.** Headless mode arrives in 59, so on 53 the window must be
  visible for `Page.captureScreenshot` to work. A minimized window yields a
  screenshot failure, not a black image.
- **`--disable-gpu` is not optional.** Wine's D3D translation on a 2016 Chromium
  produces blank renders unrelated to the build. Leaving it on means a bad
  screenshot implicates the code rather than the graphics stack.
- **Module scripts are ignored, not rejected.** Native ES modules land in 61, so
  53 skips a `<script type="module">` tag silently — see the exit 3 note above.
- **Console/Runtime/Log domain overlap.** 53 sits on the boundary where error
  reporting was being reshuffled between these domains. `validate.mjs` subscribes
  to all three and dedupes; do not "simplify" it down to one.
- **`GET /json/new` works.** Newer Chrome requires PUT. The harness falls back to
  reusing an existing tab if that ever changes.

## Using a different Chromium version

Nothing here is pinned to 53; it is the version this was built and tested
against. To point it at another build:

1. Pick a snapshot you can actually get hold of, and unpack it into a bottle.
2. Set `CX_BOTTLE` and `CX_EXE` to match.
3. Change the `es-check es6` target in `scripts/static-check.sh` to your
   target's ES level, and `settings.browsers` in the compat eslint config to the
   matching `chrome NN`.

Navigation and `Runtime.evaluate` are the oldest, most stable parts of the
protocol and usually survive going further back. The two likely breakage points
are the CDP domain list (`Runtime` / `Console` / `Log` / `Network` / `Page` —
`softSend` already tolerates a missing domain, but a build may report errors
somewhere this does not listen) and the `Page.captureScreenshot` call, whose
parameters changed over time. Expect to touch those two places in
`validate.mjs`, not the rest of it.

There is no known minimum version — how far back this works has not been
established.

## Scope limit — state this when reporting results

This validates syntax, JS APIs, and boot behaviour of the **browser engine**. It
does **not** reproduce the environment that engine ships inside: memory ceilings,
storage APIs that are stubbed or return null in an embedded webview, media
element behaviour, input handling, or vendor patches applied on top of the
upstream build. A pass here means the bundle parses and boots on an engine of
that vintage. Whether it works on the actual target runtime is still a separate
question — do not report a green run as confidence in the target device.

## Adding the compat eslint config

`static-check.sh` looks for `.eslintrc.compat.json` in the working directory.
Copy `examples/.eslintrc.compat.json` from this repo, or create it:

```json
{
  "plugins": ["compat"],
  "rules": { "compat/compat": "error" },
  "settings": { "browsers": ["chrome 53"] },
  "env": { "browser": true }
}
```

Set `browsers` to your target version. Keep this separate from the project's
main eslint config so the compat gate can run against build output independently
of source linting.
