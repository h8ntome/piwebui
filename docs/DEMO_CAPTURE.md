# Recording the demo GIF

Status: **not recorded yet.** These are the commands that were run and verified while preparing this
document, so the capture is a mechanical follow-up rather than an open question. Nothing here is
invented: the server boots, and the UI opens straight onto the sessions. The README currently leads with
a still of the main UI instead — §0 reproduces it. No login-card image is checked in any more (there is
no login card any more).

## 0. The README stills (currently shipped)

`docs/assets/screenshot-hero.png` (start screen), `screenshot-main.png` (a session in the light theme)
and `screenshot-dark.png` (the same session mid-turn in the dark theme) are the real application at
1600x1000, viewing a **synthetic** workspace: a small invented project under `/tmp/lightlog` (a README,
two `src/` files, one test) that a **managed `pi`** was asked to read, extend and run. No one's real
prompts, paths or project names appear in these images. `screenshot-diff.png` is a spare close-up of an
expanded Edit card; the README does not reference it.

```bash
npm ci && npm run build
mkdir -p /tmp/lightlog/src /tmp/lightlog/tests   # write a few small invented files (README.md, src/*.ts, tests/*.test.ts)
rm -rf /tmp/piweb-demo/state && mkdir -p /tmp/piweb-demo/state
npx pi-web serve --port 4477 --data-dir /tmp/piweb-demo/state --no-open
npx pi-web allow /tmp/lightlog --data-dir /tmp/piweb-demo/state
```

Then drive these prompts from the hero composer (or `POST /api/v1/sessions` + a `prompt` command per
session): "List the files in this project and explain what each one does", "Add a `warns()` helper to
`src/query.ts` that mirrors `errors()`, then run the test file and tell me the result", "How large is
this project and what would you improve first?", "Add a `count()` helper to `src/query.ts` that returns
the number of parsed log lines, then run the tests and tell me the result", and — in its own session —
"Add a `levels()` helper to `src/query.ts` that returns the distinct levels present in the parsed lines,
then run the tests and tell me the result". The helper prompts are what put Edit cards with real diffs
in the shot; the `levels()` session also gets two follow-ups ("Add a short "Query helpers" section to
README.md documenting `errors()`, `warns()` and `count()`, then run the tests and report the result",
"Add a usage example to README.md showing how to import and call the query helpers, then run the tests")
so there is a turn in flight to shoot the dark still during.

```bash
agent-browser --session piweb-shot set viewport 1600 1000
agent-browser --session piweb-shot open http://127.0.0.1:4477/    # no login: the page lands on the start screen
agent-browser --session piweb-shot screenshot docs/assets/screenshot-hero.png
# main still: open the session, expand the src/query.ts Edit card, then put the first user bubble 90px
# below the header so the diff and the composer are both in frame
agent-browser --session piweb-shot eval "[...document.querySelectorAll('[class*=sessionRow]')].find(e=>/levels\\(\\)/.test(e.innerText)).click()"
agent-browser --session piweb-shot eval "(()=>{const t=[...document.querySelectorAll('.pw-tool')].find(e=>/^Edit/.test(e.innerText.trim())&&/query\\.ts/.test(e.innerText));if(t.getBoundingClientRect().height<60)(t.querySelector('button')||t).click()})()"
agent-browser --session piweb-shot eval "(()=>{const s=document.querySelector('.pw-main__scroll'),f=document.querySelector('.pw-msg');s.scrollTop=Math.max(0,f.getBoundingClientRect().top-s.getBoundingClientRect().top+s.scrollTop-90)})()"
agent-browser --session piweb-shot screenshot docs/assets/screenshot-main.png
```

For the dark still, set `{"theme":"dark"}` in the `piweb:settings:v1` localStorage key and reload — the
`theme` default is `system`, and headless Chromium reports light, so an unset key silently yields a
light-theme "dark" screenshot. Then send a follow-up and shoot while the turn is still running: that is
the only moment the composer shows `Steer` and `Follow-up`, and a turn on this fixture settles in
~30 seconds (`agent-browser eval /Steer/.test(document.body.innerText)` polls cheaply).

Notes that cost time to learn: session rows re-render with new refs on every navigation, so match a row
by its text rather than a stored ref; **New Session** starts a managed `pi` immediately, so clicking it
without sending a prompt leaves an untitled empty row in the sidebar (restart the server to clear it,
and shoot the hero still from a plain page load instead of from New Session); the composer's model chip
shows the raw `provider/modelId` until the runtime's catalogue arrives, so reload once before the shot
that should read "Qwen 3.8 Flash-Next"; and do **not** pass `--agent-dir` for this capture — a managed `pi`
child still writes its sessions under the default agent directory, and the read worker then refuses them
as "path outside registered session roots".


## 1. Build, then boot an isolated instance

```bash
npm ci && npm run build
rm -rf /tmp/piweb-demo && mkdir -p /tmp/piweb-demo/{ws,state,agent,frames}
npx tsx -e 'import {generateFixtures} from "./e2e/fixtures.ts"; generateFixtures("/tmp/piweb-demo/ws")'
npx pi-web serve --port 4477 --data-dir /tmp/piweb-demo/state --agent-dir /tmp/piweb-demo/agent --no-open
# --no-open keeps the desktop browser from opening mid-setup; the UI needs no login either way.
npx pi-web allow /tmp/piweb-demo/ws --data-dir /tmp/piweb-demo/state
```

A fixture workspace shows the *shell* only. For a transcript worth watching, record against a real
project you are willing to publish, or against the deterministic mock provider used by
`npm run smoke`, which drives a genuine managed `pi` child process end to end and produces real
streamed tool calls with no external API involved. **Do not record your own day-to-day sessions** for a
public demo: session paths, project names and prompt text leak into the frames.

## 2. Frames to capture

Record at 1280×800, deviceScaleFactor 1, dark theme, cursor visible, nothing typed that is private.

| # | Frame | Why it is worth watching |
| --- | --- | --- |
| 1 | the UI opening straight onto a workspace's session list | shows there is no login step to sit through |
| 2 | session list for an allowlisted workspace | shows the tool actually finds pi's own files |
| 3 | transcript opening, scrolling through user/assistant/tool blocks | the core value |
| 4 | a tool call expanding its output, then the run finishing | proves live streaming, not a static view |
| 5 | typing a follow-up prompt and hitting send, ack appears | proves it is a control surface, not a viewer |

Target 6–9 seconds total; trim the waiting between 5 and the streamed reply rather than playing it out.

## 3. Driving and encoding

```bash
export AGENT_BROWSER_IDLE_TIMEOUT_MS=600000 S=piweb-demo
agent-browser --session $S open http://127.0.0.1:4477/
agent-browser --session $S snapshot -i              # read refs; do not hardcode them
agent-browser --session $S screenshot frames/02.png
# no login to shoot any more: 02 is the session list, then click a session row and capture 03..05
agent-browser --session $S close
```

A tool chain must be installed to assemble frames (none is present on the machine used for this audit:
no `ffmpeg`, `gifski`, `gifsicle` or ImageMagick). Either capture a video with
`ffmpeg -f avfoundation` / the browser's own recorder and cut it, or encode frames:

```bash
ffmpeg -framerate 2 -i frames/%02d.png -vf "scale=960:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" -loop 0 demo.gif
```

Keep it under ~2 MB and under 10 seconds. GitHub renders GIFs in READMEs inline; a large file makes the
landing page slow, which defeats the purpose.

## 4. When the GIF exists

Save it as `docs/assets/demo.gif`, replace the pending block near the top of `README.md` with:

```markdown
![pi-web demo: open the session list, browse a session, send a follow-up prompt](docs/assets/demo.gif)
```

and delete this section's status note. Do not ship a GIF stitched from still screenshots of states the
application cannot reach.
