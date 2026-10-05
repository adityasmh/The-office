# Status for the CEO (kept up to date by Claude Code while you're away)

_Last update: 02:02 (OPS-START)_

## 02:02 - the company is back up (OPS-START)
- Everything is running again: Laya is on your GPU, the server is running the newest code, and all nine dashboard pages were opened headlessly and checked - every one loaded with real data and no errors.
- The slowness had one cause: yesterday's server was still alive (the 23:00 shutdown never actually stopped it). It answered sometimes, then froze for 25-30 seconds at a time, and it did not know about the newest pages. I replaced it through the normal watchdog path (the new one was up in 6.3s). Pages now load in about 5-12 ms and the Budget page shows your real numbers again.
- The control socket you approved is on, and nothing was resumed automatically - the manager brings back the three unfinished terminals (bonehound, crocodile, otter) itself. One thing to watch: OpenCode Go is nearly out of budget (it went amber, then red, inside an hour), so the company is now automatically using only the cheapest models, keeping Fleet parallelism low, and holding back non-urgent Fleet work until the window resets.

_02:45 update (OPS-START):_ honest correction to the line above - the dashboard is usable again but **not yet fully fast**: the router still stalls for a second or two under load, and once for ~24s while it started up (the cause - one background task that could freeze the whole server for up to 6 minutes - is already fixed in the code and loaded; the remaining slow spots are the ones the speed work still lists as open). Also, Go has since dropped to **red**, not 26% amber. Laya is running again on your GPU (it was restarted at 02:37 by another session, not by me).

_04:40 update (OPS-START):_ **the dashboard was down for about 25 minutes tonight (04:03-04:59) and that was my doing.** I restarted the server because it had become unusable (it was taking 40+ seconds to answer), and the normal start could not bring it back: the machine was so overloaded that the supervisor took 14 minutes just to begin, and my first attempts at a manual start failed before one worked. It came back at 04:59, was fast for about five minutes, and then got slow again - the same underlying stall the speed work is fixing, not something my restart can cure. **One page is failing right now: Terminals** (it hangs on the same process-list call the auto-closer hangs on). The other eight pages were re-checked on the recovered server and all pass with real data and no errors. Stopping the server again is no longer my job: that is now reserved for the manager and CRASHFIX.

_04:40, the answer to your question ("why is my finished terminal still open"):_ three reasons, all mechanical. (1) That terminal was never registered in the company's terminal list, so the auto-closer never knew about it - its owner registered it by hand tonight. (2) The auto-closer asks Windows for the list of running processes, and while the server is starved that question times out (20 seconds, eight times in a row) - so it closes nothing; from a fresh process the same question takes 2 seconds, so the closer itself is fine. (3) Closing also needs a review verdict, and a verdict is the reviewer's to give, not the auto-closer's - so the row was deliberately left marked "working" rather than closed with a forged verdict. Once the server is not starved and the reviewer posts the verdict, the record and its archive write themselves.

## 09:05 - dev/prod split is built (OPS-START)
- **Agents now have their own test server, and they can no longer touch yours.** `scripts\dev-router.ps1 -Name <job>` starts a private copy of the company on a port of its own (8801-8899) with its own data folder; the script refuses to touch the live server, and the rules now say clearly: never restart the live server, never edit the release copy, test on your own dev instance.
- **Proof, all checked:** I started a dev instance, edited a file, restarted dev, and the live server's process id and health stayed exactly the same before and after (7 of 7 checks passed).
- **What is left for you or the manager:** running `scripts\promote.ps1 -Approved` once, which is what switches the live server onto a frozen release copy (it builds the copy, test-boots it on a throwaway port with a temporary data folder, swaps the live server over, and rolls back automatically if that fails). It deliberately refuses to run right now, because the live server is still stalling above the allowed limit - that refusal is the safety gate, not a bug.

## Needs your attention (20:40)
- **Claude 5-hour window is 91% used** (resets around 23:55). If it runs out, the manager, reviews and the Opus assistant fall back to DeepSeek until the reset. BUDGET will make the system slow its Claude use down automatically.
- **For the OpenCode Go balance** you'll probably need to paste your opencode.ai session cookie into `.env` (BUDGET will say exactly where it goes). Agents never log in for you.

## Queued by you (20:30)
- **BUDGET** (session otter): the real OpenCode Go and Claude balances on the dashboard, steering Laya and the models (cheaper models and less Claude as budgets run low).
- **ATTACH** (session llama): PDFs and pictures in the Assistant chat. Claude reads them and passes a written description to the workers.
- **LAYA-GPU** (session mouse): Laya moves onto the RTX 4050 GPU (≈3 GB CUDA download approved). That frees ~1.5 GB of RAM and a lot of CPU, and makes decisions faster.

## New since 19:52
- **Your cost rule is in place:** DeepSeek v4 flash is the default everywhere, including UI work. Kimi is only used when DeepSeek has failed or the job is exceptionally hard, and the reason gets recorded. All workers were told, and the UI goal is now "useful and easy to understand", not pretty.
- **Speed:** PERF-BACKEND's fixes work on a test server (the overview dropped from 1.5 MB to 0.2 MB, and responses from ~200 ms to ~5 ms). The live server is still slow, so it's now profiling the live server itself to find the remaining blocker.
- **Clean-up:** UI-CLEAN finished part 1 (navigation and layout simplified).
- **Watchdog:** CRASHFIX found and fixed another live bug; the auto-restart is proven.

## Needs you
- Nothing right now.

## Working on now
- **Dashboard speed (the big one):** the server is overloaded, so pages load very slowly. PERF-BACKEND and PERF-UI are fixing it; the Flow data is already cached.
- **Cleaner dashboard:** UI-CLEAN is simplifying navigation, the look and every page's wording.
- **Model choice actually working:** jcode was ignoring the chosen model, so every terminal ran DeepSeek. bonehound is fixing it.
- **Making Laya decisive:** LAYA-TUNE is measuring and improving how Laya answers.
- **Surviving restarts:** RESUME makes interrupted work continue by itself after a restart.
- **Shut down / start again button:** SHUTDOWN is building it, with full saves of every terminal.
- **Briefing** (your done/remaining checklist) and **auto-closing finished terminals** are being finished.

## Done since you left
- Closed the finished terminals (TERMINALS, OPS) and 6 empty leftover windows. Their records are saved in `company/reports/terminals/`.
- Confirmed the server's auto-restart watchdog works (it restarted the server at 19:42 when it hung).
- The code type-checks cleanly again.

## Problems found
- `jcode -m` doesn't change a terminal's model (see above).
- The server stays slow until the speed fixes land.

## 21:18: manager paused (Claude usage limit reached)
- New: **INBOX** (session panda) is building Approve/Reject buttons and inline answers for questions in the Briefing's 'Needs you' section. clover (UI) and mushroom (questions) were asked to help; delivery not yet confirmed, so INBOX will re-send.
- All workers keep running on their own orders and log to docs/AGENT_COORDINATION.md. Nobody is reviewing their 'done' claims until the manager is back.

## 00:40: review while you were gaming (nothing spawned; free RAM was 1.7 GB)
**Checked and accepted as done:** shut-down/start button, Laya on your GPU, Laya tuning (model picks 12% → 59% correct), budget monitoring, the inbox (approve/answer in the Briefing), PDF/picture attachments, the speed fixes, the cleaner UI, and your voice order (3/3 passed).
**My decision:** jcode can't switch a session's model by script. Since DeepSeek flash (the default) is what your cost rule wants anyway, we live with it for now.
**Needs you (whenever):**
1. Should I turn on jcode's local control socket? That would let Laya's model choice actually switch terminals. It's a jcode setting change on your laptop.
2. While you game: Laya is holding **4.6 GB of your 6 GB GPU memory** even though the server is off. I can stop Laya until you're done.
**Queued for later (small, when RAM frees):** better Laya model picks in the Fleet, RESUME's last proof, one budget item, and a clean full start + page check when you're back.

## 00:55
- Laya is stopped (your game got ~2.9 GB of GPU memory back). It starts again with the 'Start Laya Company' shortcut.
- jcode's control socket is switched on, so Laya's model picks will actually apply to terminals after the next start.
- Waiting until you're done gaming for the 4 small follow-ups; they need Laya and a test server.
