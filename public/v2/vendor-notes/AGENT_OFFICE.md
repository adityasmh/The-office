# Vendor study: harishkotra/agent-office

Notes for the v2 **Office** view (`public/v2/views/office.js`).
Written by the UI-OFFICE session after the CEO asked for "its look" (docs/UI_V2_SPEC.md, Office brief).

## What was cloned, and where

| Item | Value |
|---|---|
| URL | https://github.com/harishkotra/agent-office |
| Clone target | `%TEMP%\uioffice\agent-office` (a scratch folder OUTSIDE this repo) |
| Commit read | `58f11f9b31770c10bcf3d7a0618325d22bd0ee9e`, 2026-09-24 ("Enhance README with images and video link") |
| Method | `git clone --depth 1`, read only. No install, no build, no scripts run. |
| Files read | README.md, LICENSE, CHANGELOG.md, package.json, docs/docs/architecture.md, packages/core/src/office/{Office,Grid}.ts, packages/server/src/schema/OfficeState.ts, packages/ui/src/game/Game.ts, packages/ui/src/components/{AgentPulseBoard,AgentInspector}.tsx, pixel-agents-repo/LICENSE + package.json |
| Deleted afterwards? | No. The clone still lives in `%TEMP%\uioffice` if anyone wants to look. It is outside the repo, so it cannot ship. |

Nothing from the clone was executed. No `npm install`, no `npm run`, no dev server.

## License

The repository is **MIT**, Copyright (c) 2026 Harish Kotra:

```
MIT License

Copyright (c) 2026 Harish Kotra

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**Second licence in the tree.** The repo also vendors an entire copy of
[pablodelucca/pixel-agents](https://github.com/pablodelucca/pixel-agents) (v1.3.0) under
`pixel-agents-repo/`, which is where the *pixel art* (character sprites, floors, walls, furniture
PNGs) and the sprite/emote conventions actually come from. That copy is also **MIT**, Copyright (c)
2026 Pablo De Lucca, same wording as above. The agent-office README credits it at the bottom.

**So: MIT allows copying, with the copyright notice kept.** Two conditions on us if we ever paste
code or ship their assets: keep the notice, and keep the credit.

**What this build actually did about that: we copied no code and no assets.**
`office.js` is original DOM/CSS written against our own API shapes; the borrowings are *ideas*
(zone-as-room layout, desk-per-agent, action->emoji bubbles, click-to-focus, inspector panel) which
MIT does not restrict anyway. Section "What we adopted" below is precise about which idea came from
where. The MIT notice is reproduced above and the credit line is in the header comment of
`office.js` and in the view footer, so attribution is visible even though we did not need it.

## What agent-office is (so the look makes sense)

A TypeScript monorepo, 5 packages, all npm-installed and built with a bundler:

- `core` - agent state machine (perceive -> think -> act -> remember), Office grid, tasks, memory.
- `adapters` - Ollama / OpenAI-compatible inference adapters, prompt builder.
- `server` - Colyseus room (`OfficeRoom`) running the ~15s think loop per agent, `ToolExecutor`
  (sandboxed JS, web search, notes, file read), `MemoryStore` (SQLite + embeddings), and
  `OfficeState` (a Colyseus `Schema`: `agents[] {id,name,x,y,direction,action,currentTask,thought,
  mood,reputation,riskLevel,momentum}`, `officeTime`, `timeScale`).
- `ui` - **Phaser.js** game scene (tilemap, sprites, walk animations, camera) plus a **React**
  overlay (Chat, TaskBoard, SystemLog, Inspector, LayoutEditor), and a bare `index.html` canvas.
- `cli` - scaffolding (`create-agent-office`, `add-agent`).

Runtime needs Ollama + a build step + websockets. **None of that is compatible with our v2
constraints** (no build step, plain ES modules, no npm deps, our data already lives in the router on
:8787). So the adoptable part is the *presentation model*, not the stack.

## The look, decoded from the source

Concrete values from `packages/ui/src/game/Game.ts` (Phaser graphics calls):

- Floor base `0x2d2d3d` (warm dark grey), inner work area `0x33334a` (lighter rectangle, so the room
  reads as inset), zone carpets tinted per zone: meeting `0x352a45` (purple), collab `0x3d3025`
  (orange), pantry a 16px checkerboard in greens.
- Zone borders: 3px strokes, one accent per zone - `0x6c5ce7` purple, `0xe17055` orange,
  `0x00b894` teal - each with a **door gap** drawn by painting a floor-coloured rectangle over the
  border, and a small centred label with an emoji ("Meeting Room", "Collab Area", "Coffee & Pantry").
- Furniture is drawn as flat pixel rectangles with a lighter top face plus a highlight inset
  (`0x6d4c2e` body / `0x7d5c3e` top) and circles for chairs.
- Each agent = a `container` at `(x*16, y*16)` holding, in this z-order: focus ring (a 1px stroked
  circle, hidden by default), sprite (or a coloured rectangle fallback), thought bubble, emote
  bubble, name label.
- **Emote bubble**: one emoji above the head, keyed by action - `work: laptop`, `talk: speech`,
  `idle: relaxed`, `use_tool: wrench`, `move: walking`, `think: bulb` - shown when the action
  *changes* and auto-hidden after 3s.
- **Thought bubble**: the agent's last thought, 9px, word-wrapped at 130px, `#1a1a3e` translucent
  background, auto-hidden after 6s.
- **Name label**: 10px white text on a translucent black plate, below the sprite.
- **Click to focus**: clicking a sprite sets a follow target, shows the focus ring, and the camera
  lerps to it clamped to the grid bounds; clicking again unfollows. Zoom is mouse-wheel, clamped
  1..3.
- Reflected in React: `AgentInspector` is a small dark panel - name, role, status, current task;
  `AgentPulseBoard` sorts agents by momentum and prints a 2x2 metric grid per agent.

## What we adopted, and how it maps onto our data

| agent-office idea | In `office.js` | Our data |
|---|---|---|
| Zone = a bordered, tinted floor area with a label and a door gap | One room per **department**, first-letter accent colour, dashed name plate, door notch | `GET /company/org` departments; agent rows carry `departmentId`/`departmentName` |
| A desk per agent, agents walk to their desk to work | A desk card per agent, monitor + chair drawn in CSS; the desk lights up while the agent works | `GET /company/agents` roster |
| Live state: `action`, `currentTask`, `thought` | state pill + emote bubble (working/waiting/error/idle/no budget) + the current task title as a link | `GET /company/sessions` polled every 4s (`status`, `taskId`, `taskTitle`, `lastText`, `costUsd`) |
| Emote auto-hides after 3s on action change | Emote is shown while the state persists and pulses on a state *change* | same idea, different trigger |
| Click a sprite to focus (ring + camera follow) | Click a desk to focus it (ring, inspector, `scrollIntoView`); click again to unfocus | local view state |
| Name label on a translucent plate | Name + role + model plate under each desk | `name`, `roleName`, `modelId` |
| `AgentInspector` (name/role/status/current task) | The right-hand detail card, extended with project, department, model, budget bar, last activity, last message | roster + sessions fields |
| `AgentPulseBoard` 2x2 metric grid | 2x2 mini-grid per desk (spend, sessions run, state, last activity) instead of personality stats | `budget.allocatedUsd/spentUsd/sessionsRun` |
| Click-through from the inspector | Clicking a **working** desk goes straight to `#/flow/:taskId` | `session.taskId` |
| Camera zoom clamp 1..3, bounds clamp | Not applicable (DOM). Replaced by a compact/roomy desk density toggle. | - |

## What we deliberately did NOT adopt

- **Phaser, Colyseus, React, easystarjs, SQLite, Ollama**: dependencies, a bundler and a websocket
  server. Our v2 must stay a no-build, no-dependency page served by the existing router.
- **Their sprite sheets and furniture PNGs** (`characters.png`, `assets/characters/char_*.png`,
  `assets/furniture/*`). Free to use under MIT, but they need a canvas, a tileset and a layout
  editor's worth of furniture metadata to look right; and shipping third-party art into our company
  dashboard is a bigger call than a UI session should make alone. We draw desks, monitors and
  chairs with CSS instead, and use emoji for emotes.
- **Walk animations / pathing / mood / reputation / risk / momentum / hiring / layout editor**:
  those are a simulation, not a dashboard. Our agents are real processes we must observe, not
  sprites we control. Faking motion would be a lie about state.
- **Their SVG/CSS-free "viral showrunner" panels** (CHANGELOG 0.0.2): a different product.

## Compliance summary

- Licence permits adoption: MIT (both agent-office and the vendored pixel-agents).
- We copied **no code**, so no notice is legally required; we still credit in the file header, in the
  view footer and here, and we reproduce the licence text above.
- If a later session *does* copy a snippet (say the emote map), it must keep the MIT notice and the
  `Copyright (c) 2026 Harish Kotra` line next to it, and mention it in this file.
- Footnote, not a problem for us: the repo README's quick start says
  `git clone .../AjStraworern/agent-office.git` (a stale fork URL) while `LICENSE`, `package.json`
  and the CEO's link all say `harishkotra/agent-office`. We used the latter.
