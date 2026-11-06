# Recording the demo GIF

Status: **not recorded yet.** These are the commands that were run and verified while preparing this
document, so the capture is a mechanical follow-up rather than an open question. Nothing here is
invented: the server boots, the login flow works, and the screenshot in the README came from step 3.

## 1. Build, then boot an isolated instance

```bash
npm ci && npm run build
rm -rf /tmp/piweb-demo && mkdir -p /tmp/piweb-demo/{ws,state,agent,frames}
npx tsx -e 'import {generateFixtures} from "./e2e/fixtures.ts"; generateFixtures("/tmp/piweb-demo/ws")'
./packages/server/bin/pi-web.mjs serve --port 4477 --data-dir /tmp/piweb-demo/state --agent-dir /tmp/piweb-demo/agent
# the banner prints a one-use login code; or mint one at the moment of use:
./packages/server/bin/pi-web.mjs allow /tmp/piweb-demo/ws --data-dir /tmp/piweb-demo/state
./packages/server/bin/pi-web.mjs mint-code --data-dir /tmp/piweb-demo/state
```

Codes expire after 120 seconds, so mint immediately before the browser step, not before the setup.

A fixture workspace shows the *shell* only. For a transcript worth watching, record against a real
project you are willing to publish, or against the deterministic mock provider used by
`npm run smoke`, which drives a genuine managed `pi` child process end to end and produces real
streamed tool calls with no external API involved. **Do not record your own day-to-day sessions** for a
public demo: session paths, project names and prompt text leak into the frames.

## 2. Frames to capture

Record at 1280×800, deviceScaleFactor 1, dark theme, cursor visible, nothing typed that is private.

| # | Frame | Why it is worth watching |
| --- | --- | --- |
| 1 | login card with a real code being pasted | makes the security model visible in one second |
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
agent-browser --session $S fill @<code-input> "<minted code>"
agent-browser --session $S click @<sign-in>
agent-browser --session $S screenshot frames/02.png
# re-snapshot after every navigation; click a session row, then capture 03..05
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
![pi-web demo: log in with a one-use code, browse a session, send a follow-up prompt](docs/assets/demo.gif)
```

and delete this section's status note. Do not ship a GIF stitched from still screenshots of states the
application cannot reach.
