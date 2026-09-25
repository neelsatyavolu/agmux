# Release Notes

User-facing delta since the **last public GitHub release** (currently v4.2.0). This is the source of truth for `/release` — not a session diary.

**Audience (hard rule)**
- Write for a **non-technical person who has never coded**. They only care what they **see or experience** in the app.
- Use plain language. Describe the product change, not the implementation.
- **Never** use engineering jargon or internals: PTY, SDK, sidecar, JSONL, hooks, ring buffer, invoke, worktree, process tree, SIGWINCH, app-server, event mapper, migration, etc.
- **Never** explain “how we fixed it” or name code paths — only what the user notices (a button works, a spinner clears, a model appears in the picker, chat looks different).

**What belongs here**
- Net product change a user of the last shipped build would notice: new capability, behavior improvement, or bug that exists in the public release.
- Format: `- **Title** — one-line description` under `### New` / `### Improved` / `### Fixed`.

**What does NOT belong here**
- Fixes or polish for work that only exists in unreleased commits (never shipped). Fold those into the New/Improved bullet for the feature as it will ship.
- Purely internal work: refactors, tests, tooling, docs, dependency bumps with no user-visible effect.
- Intermediate local iterations (“fixed the alignment again”, “terminal no longer has the emerald bar we added yesterday”). Update the existing feature bullet instead of stacking Fixed entries.
- Technical changelogs, PR descriptions, or developer-facing notes.

When in doubt: would a non-technical user who installed the last public release notice this and understand the bullet without coding knowledge? If no, skip, fold, or rewrite in plain language.

See `/release` (`.claude/commands/release.md`) for how this file is consumed and reset.

## Unreleased

### New
- **Focus** — An optional group at the top of the sidebar that gathers the threads you've been working on lately from every project, so you don't need to keep every project open. Threads leave it after a while without activity (you choose how long), and ones that are still working or have unread replies stay put. Starting a new session from Focus asks which project it belongs to. Turn it on in Settings → General.

### Improved
- A cleaner look that matches agmux.dev and the phone app everywhere in the app: new type, flat panels and cards, clearer labels, and calmer status colors, plus a bolder new app icon that fills its tile on the Mac and on your phone. Prefer the old frosted look? Choose Settings → Appearance → Surfaces → Glass. The previous font, Geist, is still in Settings → Typography.
- **Redesigned phone remote** — The phone and browser remote has a cleaner new look that matches agmux.dev, with a light mode that follows your system. The session list is compact, with the time beside each title. Headers stay clear of the iPhone status bar and never crowd the session name. Replies are easier to read: headings, quotes and tables look right, code blocks have a Copy button, and tool activity is grouped into tidy cards. The message box stays on one line on small phones.
- **Clearer account settings** — In Settings, Agent accounts is now just **Accounts**, and the old Accounts tab (Git identities and connected services) is now **Git & Connections**.
- **Simpler Accounts** — Settings → Accounts now has a "Your accounts" section and a section for each of your teams, so it's clear which is which. Add a team account from the team's own section. Anyone on a team can see and use its accounts without signing in to them. When a usage check is rate limited, it now says so and keeps showing the last reading. Less-used actions sit behind each account's ⋯ menu, and "Add to switching" is gone because your current login is already used first when accounts switch automatically.
- **Use this account** — Pick any Codex or Grok account and choose Use this account to sign your CLI into it, for agmux and your terminal alike. The login it replaces stays in your accounts. A team account stays checked out to you while your CLI uses it, so your team can see it's in use. Its usage stays up to date while your CLI uses it. If an account can't be switched to, the reason shows right on that account.
- **See who's using a team account** — Team accounts show who is using them right now, and whether it's their CLI. If your CLI is signed into a team account, agmux recognizes it and lists it under that team, not as your own.
- **Every usage limit** — Accounts show each limit separately, like the 5-hour and weekly limits, and team accounts show them too. Old readings show when they were taken instead of "Status unknown", and a Claude Team plan now reads "Team plan".
- **See how busy each account is** — Accounts show how many people on your team are using them right now, and automatic switching picks the account fewer people are using. Team owners can turn on Shared Claude accounts to see how many people use each Claude login. A Claude account's email is only shown once two or more people are using it.
- **Rename accounts** — Rename an account from its ⋯ menu. Sharing a login with a team again no longer replaces the team's name for it.
- **Move accounts to a team** — Team owners and managers can move a Codex or Grok account from their personal accounts to a team from its ⋯ menu. Moving your current login shares it with the team and lists it under the team, and you stay signed in.
- **Subscription tiers** — Accounts now show the exact tier where the provider reports it, like Max 20x for Claude and SuperGrok Heavy for Grok.
- **Newer local models** — Settings → Local Models now recommends Qwen 3.8 27B, the strongest coding model you can run on your Mac, for Macs with 24 GB of memory or more. Older models it outperforms were removed from the recommendations. Models you already downloaded keep working.
- **Cleaner Local Models page** — Settings → Local Models is reorganized into clear sections: your Mac and setup, recommended models (pick a memory size to see other options), everything you've downloaded, HuggingFace search, and agent tools. Removing a model now asks before deleting its files, and it works in light mode too.
- **Claude terminals in light mode** — Claude terminals now use Claude's light colors when agmux is in light mode, and switch between light and dark as soon as you change modes. If you chose a colorblind-friendly or custom theme in Claude, it's kept.
- **Account usage** — Settings → Accounts now checks usage on its own, so a newly added account shows its limits without clicking Check usage. Team accounts have a Check usage button too, and keep showing their last reading, with when it was checked, instead of going blank. When the account you're using is nearly out (5% or less left), agmux checks your other accounts so you can see which one to switch to.
- **Phone remote works with every agent** — Droid, Kimi, Cline, Hermes, OpenCode and Gemini terminals now show their full conversation on your phone, not just what you typed. Saved Kimi, Pi and Grok sessions from your Mac's sidebar appear on the phone too, and every agent has its own icon.
- **Approve terminal requests from your phone** — When a Claude or Kimi terminal asks for permission, Allow and Deny now appear on your phone.
- **Lighter on battery** — agmux uses less CPU and graphics power, especially when its window is in the background or sitting idle. Spinners and status animations pause while you're in another app, and background checks run less often or wait until you come back.
- **Commit message model** — GPT-6 Luna Low replaces GPT-5.6 Luna for writing commit messages, both when you pick it in Settings and in Auto.
- **Phone remote polish** — The phone shows when it's loading or your Mac is offline, shows errors instead of failing silently, keeps the current model visible on small screens, no longer zooms in while you type on iPhone, and signs out right away if you revoke it on your Mac. Pairing no longer hangs, and pairing links from the iPhone app now work.

### Fixed
- **Phone shows sent messages as sent** — A command you typed into a Claude terminal while it was working no longer stays marked Queued on your phone after it runs.
- **Stopping from your phone** — Tapping Stop on a terminal session from your phone no longer risks closing Claude or Codex.
- **Phone remote history for Claude Desktop Cowork** — Cowork sessions from Claude Desktop now show their full history on your phone.
- **Pairing code in Settings** — After a phone pairs, Settings → Remote Control no longer keeps showing a code that has already been used.
- **Local model switch prompt** — The "switch your local model" popup can now be closed (Not now, the X, or Esc), and Open Settings actually takes you to Settings instead of leaving the popup stuck on top. It's also readable in light mode, and it lets you switch to a model you've already downloaded without downloading it again. Setup no longer offers the retired Qwen2.5 models.
- **Debug Mode and Cleanup settings** — These two Settings pages no longer show bright white outlines, and now look like the rest of Settings.
- **Teams session counts** — Teams now shows how many sessions each person actually started. Before, one long session was counted again for every hour it ran, and automatic reviews and helper agents counted as sessions too. Their usage still counts toward tokens, cost and active time.
- **Grok usage after resuming** — Grok work done after reopening an earlier session is no longer occasionally left out of Teams and the Usage panel.
- **Home and Memory in split view** — Clicking Home or Memory in the sidebar now opens them while split view is on, instead of doing nothing. Your split sessions are still there when you pick one again.
- **Setup steps no longer jump around** — Moving between setup steps keeps the window steady instead of resizing it each time, and every step now starts at the top.
- **Recommended local models answer again** — Models downloaded from Settings → Local Models could sit on "working" and never reply in local chats and the local terminal. They now load and answer. On Macs with 8, 12, 16 or 24 GB of memory, the models recommended for your Mac also no longer get refused for lack of memory.
- **Local models remember the whole conversation** — Long local chats no longer quietly forget their instructions and the start of the conversation. When a chat gets long, it is summarized to make room, the way cloud models do, instead of cutting off replies.
- **Faster local replies** — Follow-up messages in a local chat or terminal reuse the work already done on the conversation, so they start answering in about a second instead of rereading everything. Using one local model for chat and another for the terminal no longer makes each reload every few minutes.
- **Local models fit your Mac** — agmux now works out how much memory each local model really needs for a long conversation, and sets it up to fit your Mac. When there's room, it uses the faster setup that remembers text more accurately. A model too big for your Mac is turned away with a clear message, instead of loading and slowing the whole Mac down. Settings → Local Models shows the memory each model will really use on your Mac, and warns before you download one that's too big.
- **Terminals stay in light or dark mode** — With Color mode set to System on a light Mac, terminal sessions briefly turned dark each time they were opened or switched to, and a Codex terminal that started during that moment could keep dark colors. Terminals now open in the right mode. Switching Color mode to System also follows your Mac's appearance again.
- **Downloading a local model no longer interrupts other chats** — Installing a new local model used to cut off any chat that was answering at the time, and could leave other chats unable to continue. Chats now finish what they're doing and carry on as normal.
- **Hiding and deleting sessions on long-used installs** — When agmux's saved sidebar data was full, choosing Hide on a session did nothing and deleting a thread could leave it in the list. They now leave the list right away.
- **Claude terminal sessions missing from the sidebar** — If you use Claude Code plugins or startup hooks, many Claude sessions you started outside agmux never appeared in the sidebar. They now show up with their first message as the title.
- **Droid listed agmux twice** — On Macs that used agmux before it was renamed, Droid ran agmux's status updates twice after every message and listed them twice. It now runs them once.

## v4.2.0 — 2026-09-23

### New

- **GPT-6 Sol and Luna** — Choose the new models in Codex and OpenCode chats, tasks and the phone remote, with usage costs shown at their published prices.

- **Claude Opus 5.5** — Select Opus 5.5 in Claude chat and see usage costs at its published price. The model menu refreshes when opened so newly installed Claude models appear without restarting agmux.

- **Grok 4.7 in xAI chat** — New Grok chats use Grok 4.7, xAI’s latest model, by default. Extra High reasoning is available. Grok 4.6 and 4.5 stay in the list, and a chat you already set to one of those stays on that model.

- **Agent accounts** — See your existing Codex and Grok login alongside added accounts in Settings → Agent accounts, with Codex plan labels and account limits on Home and in Usage. Your current login stays primary; when its allowance runs out, agmux checks Codex model compatibility before switching to another personal or team account.

- **Personal Claude accounts** — Your existing Claude login appears automatically in Agent accounts. Add personal accounts through Claude’s browser sign-in, view their limits on Home and in Usage, and switch accounts when allowance runs out and the conversation is safe to resume. Claude accounts cannot be shared with a team.

- **Direct support** — Send bugs, crashes, questions and feedback from Settings, with screenshots or other attachments, an optional reply email and a confirmation number. Support is also available when the app cannot open your data.
- **Data recovery** — Before an update changes saved app records, agmux keeps a backup. If those records cannot open, you can restart, contact Support or restore a saved copy while keeping the failed files.
- **agmux is open source** — The full source code is now public on GitHub under the MIT license.


### Improved

- **Refresh change counts** — Right-click a sidebar thread and choose Recalculate diff to refresh its saved change counts without reopening the conversation. Empty results stay visible, and missing measurements show as unavailable or partial instead of silently disappearing.
- **Claude change counts include script edits** — When Claude edits files by running a command instead of its edit tool, those added and removed lines now appear in the sidebar counts.

- **Faster first setup** — Choose an agent, review permissions and open your first project. Appearance and local models are optional, with installation and sign-in help available along the way.


- **Task mode refresh** — All supported agents and local models are available, with the same session controls as Agent mode. Phone remote control now shows tasks and their branches, and uses the selected task’s workspace for model choices.

- **Simpler sidebar** — Removed the Issues tab from sidebar navigation.

- **Cloud command suggestions need your own key** — Terminal command suggestions and Ask with OpenRouter now use your own Groq or OpenRouter key. Without one, suggestions come from a local model or stay off.

### Fixed

- **Older chats reopen again** — Chats started before the previous update open in chat view again instead of showing “This session is not known to have been created in agmux.” Teams usage still counts only sessions started in agmux.

- **New Claude terminals no longer disappear** — On long-used installs, a newly created Claude terminal could vanish from the sidebar before you typed into it, and titles for new sessions were not kept after a restart. agmux now keeps its saved title history compact so there is always room, and a new terminal stays in the list even if saving fails. Terminals that already disappeared come back once you have sent them a message.

- **Project memory in new projects** — Agents started in a brand-new project get shared project memory from their very first session, not only from the second one.

- **Home usage card** — Provider usage rows, including Gemini, stay fully visible instead of getting cut off at the bottom.

- **Codex conversations** — Tool results remain visible when commands run in batches or use unfamiliar formats. Expanded commands retain their full text with Show more for long output, missing or unfinished results no longer look successful, repeated patch reports count once, and more bulk file edits contribute to change counts.

- **Search stability** — Unusual formatting in a conversation no longer crashes the app while preparing search results.


- **Codex change counts** — Older conversations show counts from their saved edits automatically, and parent chats include their subagents’ edits. More scripted edits and file copies between projects count correctly, including commands that finish after a reply. Deleted and similarly named files no longer count twice, formatting-only edits count correctly, and unavailable history is clearly marked.

## v4.1.3 — 2026-09-12

### New

- **Team restrictions** — Owners and managers can limit agents, models, reasoning effort, and chat or terminal access in an organized settings panel. Everything is allowed by default; agmux enforces explicitly configured rules and explains blocked choices.

- **Debug Mode** — Record recent performance in Settings and let your coding agent inspect CPU spikes and slowdowns. Captures stay on your Mac and remain available after restarting.

- **App cleanup** — Settings → Cleanup lets you review and remove old generated thread names and disposable cached files older than 90 days, while keeping conversations, manual names, project memory, active threads, and Teams data.

### Improved

- **Major performance improvements** — With many sessions open, agmux stays more responsive: hidden sessions pause extra refreshes, repeated status checks are combined, and Teams sync uses less memory on large histories. Approval and completion tracking stay active.

- **Subagent conversations** — OpenCode now has the same subagent cards and conversation panel as Codex. Claude and Cursor child replies and tool details are more complete; Gemini and local chats show available launch details and explain when child history is unavailable.

- **Commit message model** — GPT-5.6 Luna replaces Codex Spark in Settings and automatic commit message generation.

### Fixed

- **Teams accounting** — Corrected duplicated Codex child usage, recovered newer response reports, and stopped signing out from giving the same desktop a second accounting identity.
- **Teams coverage** — Unverified older history stays local, missing coverage is explained, and session activity is clearly distinguished from unique conversations.

- **Codex change counts** — More edits across a list of files, in linked worktrees, and from applied patch files contribute to terminal change counts. Old commands no longer leave counts blocked after a Mac restart, and new terminal sessions track when their commands can safely stop blocking later edits.

- **Terminal scrolling** — Returning to a terminal keeps you at the latest output if you were at the bottom when you switched away.

- **Steadier session titles** — “Continue,” approvals, and command-only follow-ups keep the task title intact. Queued and steering messages in terminal and chat retain context when updating titles. Resummarize follows the same rules, including for older saved conversations.

## v4.1.2 — 2026-09-11

### New

- **Reconnect Codex** — After signing in again, right-click a Codex terminal in the sidebar and choose Reconnect Codex to continue the same conversation with your refreshed login.

### Improved

- **Many open sessions** — Codex terminals in background tabs no longer process every line of output while hidden, so switching between several busy sessions stays responsive. Permission prompts in hidden Codex terminals are still noticed.

### Fixed

- **Sidebar status colors** — Completion pulses stay green and permission or question pulses stay amber, regardless of your accent color.
- **Blank or frozen terminals** — A terminal that had once been open as a split-view tab could stop updating, or show nothing, after split view was turned off. Terminals now follow what is actually on screen.
- **Closing the window** — Closing the main window now hides it instead of asking to quit. Click agmux in the Dock to bring it back with all sessions intact, and Quit still asks for confirmation.

## v4.1.1 — 2026-09-11

### Improved

- **Smoother session switching** — Returning to a running terminal catches up on new output without unnecessarily rebuilding its history. Unchanged background change counts no longer refresh every open session.

### Fixed

- **Commit button colors** — Commit and push buttons, including the thread toolbar’s change badge, now match your chosen accent instead of mixing it with yellow backgrounds.
- **Light mode readability** — Terminal text and input boxes stay readable, and Home project and thread names, composer selectors, settings toggles, forms, menus, editor panels, and status colors follow the selected appearance more consistently.
- **Codex change counts** — Background commands no longer leave later change counts stuck, including after restarting the app. Sidebar counts recognize more edits in chats and terminals (including Python edits followed by parallel checks), tool discovery no longer hides changes, and restored edits are counted once even when Codex reports them different ways.
- **Codex status** — Chats stop showing “starting MCP” once Codex begins responding or using tools, even if another server is still starting.
- **Computer-use approvals** — Codex app-access prompts recover if a chat misses them, and helper-agent prompts appear in the parent chat.
- **Stopping Codex** — Stopped chats recover from a stuck “Stopping…” indicator when Codex has already ended the turn.
- **Split-view tab labels** — Session tabs show the correct Terminal or Chat label and model across providers, including Codex terminals, discovered Claude sessions, OpenCode chats, and local models.
- **Closing the app window** — Closing the main window now keeps it visible for the quit confirmation, instead of leaving agmux running with no window.
- **Terminal scrollback** — Switching away and back preserves earlier output and your reading position when all new output is still available.

## v4.1.0 — 2026-09-09

### New
- **Phone session timeline** — Browse prompts and outcome summaries, then jump to a turn in web and iOS conversations.
- **Subagent conversations** — Open a subagent’s conversation in a smoothly sliding panel beside your chat in Claude, Codex, Cursor and Grok, with the subagent’s own messages, readable tool names, task details and progress states styled like your main chat. Stacked Tasks and Subagents cards float below the thread toolbar and show only this conversation’s agents, with readable names and status even when launch messages are out of view. Running agents stay visible even after the parent replies; completed agents appear newest first, with an always-visible arrow to open their conversation. Codex subagent rows align with neighboring tool rows. Resumed agents show their current status, and large conversations refresh with less background work.
- **Anonymous usage stats** — agmux can send a once-a-day anonymous ping (app version and Mac version only, plus which agent you start) so we can see how many people use the app. It’s on by default. Turn it off anytime under Settings → General → Privacy.
- **Gemini chat** — Start a Gemini conversation from the draft composer (same style as Grok/Claude chat). Your selected model and thinking level apply when the chat starts or restarts. You can switch Plan or Chat, and choose whether it asks before running commands. The first message stays on screen and is sent once the chat is ready, instead of vanishing. Thinking text sits tight under the Thought row instead of leaving a blank gap. The New menu Gemini tile still opens the terminal. First chat asks you to sign in with Google, and signing in after a failed start retries the chat automatically. Apple Silicon only. Same chats work from the phone.

### Improved

- **Attach any file** — Use the chat’s + button to select PDFs, documents, and other files. Images appear as previews when available; other files are added as local paths.

- **Lighter background Codex sessions** — Keeping several Codex conversations open does less background work while messages, questions and completion status stay up to date. OpenCode background conversations preserve the order of replies, tool activity and errors.

- **Compact tool groups** — Claude, Cursor and similar chats show grouped and nested tools as compact rows like Codex. Open a grouped tool’s details directly in the conversation.

- **Reliable Teams tracking** — Conversations retain their creation details across restarts. New Grok, Pi and Cline conversations keep their tracking even if their first update is missed. Opening or switching to an outside Claude conversation does not add it to team usage. Leaderboard ties keep ranked members ahead of unranked members.

- **Codex questions** — Answer choices or type a reply directly above the chat composer, with separate answers for each question. Answering while Codex works keeps its ongoing work visible instead of prematurely collapsing it into a completed summary. Internal polling no longer clutters the conversation.
- **Faster Codex startup** — Previously loaded Codex threads appear immediately when you reopen agmux, while the list refreshes in the background.
- **Quick Open providers** — Choose Pi, Cline, Gemini, Hermes, or Local terminal for the compose button and ⌘N, including Gemini chat.
- **Codex terminal refresh** — Refresh the terminal layout from the thread’s top bar, just like in Claude and Grok.
- **Cleaner chats** — Conversation scrollbars are hidden across chat views, including subagent conversations. Scrolling still works as usual.
- **Phone permission mode** — Changing Supervised / Auto / Full access on the phone now applies to every chat (Claude, Codex, Grok, Gemini, OpenCode, Cursor), including after you’ve already sent a message, and is remembered when you reopen that chat or start a new one. Messages from other agents preserve your existing chat permissions.
- **Gemini change counts** — Gemini terminal and chat threads now show added and removed line counts in the sidebar and completion notifications.
- **Model picker** — The agent list remembers which providers you used recently and shows about four at a time, so the one you want is usually at the top.
- **Local terminal** — The New menu’s **local** option now opens a Pi terminal already pointed at a model on your Mac, instead of Grok.
- **Cursor chat diffs** — Cursor chats now show green + and red − line counts in the sidebar and on each edit in the thread. Expanding an edit opens a numbered diff instead of a dump of the tool result. Restored counts exclude failed and unfinished edits and are not added again when chats reopen.
- **Gemini sidebar names** — Gemini chats in the sidebar now show the model name only, without High / Medium / Low.
- **Gemini usage limits** — Home and the Usage tab now show your Gemini weekly limit (and the 5-hour limit when Google reports one), using the same Antigravity sign-in as Gemini chats.
- **Gemini icon** — Gemini chats, the sidebar, and the New menu now use Google’s colorful 2025 sparkle instead of a white star.

### Fixed

- **Codex completion status** — Finished chats now clear the header’s running badge, including conversations that used subagents.

- **Remember Codex effort** — New chats keep your last effort selection, including Medium, even if you changed it before sending a message.
- **Cursor context meter** — Removed misleading context-full warnings based on total tokens processed. Cursor chats hide the meter when current context usage is unavailable.

- **Codex permission alerts** — Computer-use permission prompts now show an amber pulse and notification, including in background terminals.
- **Codex Stop and follow-up** — Stop now shows “Stopping…” until Codex finishes cancelling. Your next message waits in the queue, avoiding “turn is already active” errors and conflicting activity indicators. Failed cancellations show an error and keep Stop available to retry.

- **Agent token totals** — Includes Claude helper-agent work, corrects duplicated usage in copied conversations and cached input, and reads Gemini’s reported tokens. Recorded Teams usage stays available if an agent removes its old logs.

- **Clearer cost estimates** — Corrected model prices and cache charges. Teams labels and explains partial estimates in plain text when an agent leaves out needed usage details or a price is unavailable.
- **Fairer leaderboards** — Thinking tokens are no longer counted twice, and incomplete cost estimates no longer rank as free usage.

- **Remote conversations** — Message inputs stay fully readable when opening a session, and internal Claude task notifications no longer appear as queued messages.

- **Teams provider breakdown** — Agents you use occasionally stay visible by name instead of disappearing into “Other”. Claude conversations created in agmux also recover their missing history, while outside conversations remain excluded.

- **Unexpected quits on macOS 26/27** — A glitch in the system's hover popover could close agmux without warning. The app now shrugs it off and keeps running.

- **Teams provider tracking** — Codex chats and other agents now contribute to team activity. Past retained history syncs automatically, and large updates preserve earlier usage totals even when the Mac’s clock is ahead.

- **Codex terminal questions** — Questions now show a notification and an amber sidebar pulse until you reply.
- **Session timelines** — Codex turns now describe the outcome, saved chats can recover missing timelines, and jumping handles repeated prompts and partial histories more accurately.

- **Teams agent policies** — Team owners can choose from every app provider when setting allowed agents.
- **Codex completion and prompts** — Finished background terminals show the sidebar pulse, and repeated chat updates no longer duplicate your prompt.
- **Codex terminal spinner** — Adding a newline with Option+Enter no longer starts the sidebar spinner. It waits until Codex actually starts the submitted prompt.
- **Sidebar change counts** — Verified Python and shell edits contribute to totals, including fast Codex edits and commands that keep running tests. Codex chat and terminal counts update while other conversations are open, and recorded patch changes restore from saved history without counting the same edit twice. Ambiguous overlapping edits are skipped to avoid crediting the wrong agent, including long-running commands and commands whose file targets cannot be determined.
- **Codex terminal timeline** — Saved turns now appear in the session timeline, with jumps to their prompts in terminal scrollback.
- **Codex chat scrolling** — Chat stays with new messages and tool updates, including when you switch back from another app. Jump to latest moves straight to the bottom instead of sometimes stopping partway. Scrolling up or opening tool details keeps your reading position; sending a new prompt takes you back to the bottom.
- **Unexpected crashes** — Fixed crashes caused by damaged saved chat-title data or Claude settings, malformed agent questions or Gemini conversation data, and non-English startup diagnostics. OpenCode now reports a missing executable instead of abruptly closing its connection.
- **Codex chat stuck on Working** — After Codex launches helper agents, the chat no longer stays on Working (and “May be unresponsive”) after the reply is actually finished. Missed messages now appear from the session file without quitting the app, even if extra command rows were already on screen. A follow-up you queued while it was working is sent when that turn finishes, instead of sitting in the queue.
- **Codex hidden commands** — When Codex runs several commands or lookups inside one code step, those now show as the usual command and tool rows (collapsed in a group when there are a few), so you can see what it actually did. Repeated calls keep their separate results. Finished commands stay Ran when you reopen a chat, instead of spinning as Running. A command that keeps running in the background (like a local preview server) is labeled Serving or Running with the actual command, instead of a blank Ran row.
- **Phone message delivery** — Queued messages wait for the previous turn, including when reopening a terminal. Drafts and photos stay with the right conversation when you switch chats, and a new chat keeps its first message if you navigate away. Failed or uncertain sends remain available to review and retry. Creating chats from two phones no longer mixes up their first messages. New phone chats also work with Macs still running 4.0.2.
- **Phone questions and approvals** — Choose an answer or write your own when an agent asks a question. Pending prompts return after reconnecting, prompts already answered on the Mac clear, answering one session no longer dismisses a different session's prompt, and tapping outside the sheet no longer drops the request.
- **Remote settings tab** — Opening Settings → Remote no longer briefly disconnects your phone.
- **Phone chat controls** — Claude and Codex model choices now come from the Mac. Claude and Grok effort changes reach the running chat, and Codex fast mode is applied when sending.
- **Phone tool output** — OpenCode replies and tool results appear on the phone, Cursor edits show the actual diff, and Codex results stay attached to their tools. Failed edits show the error instead of changes that never happened. Expanded tools stay open as new output arrives, and diff lines resembling file headers remain visible.
- **Large phone histories** — Long conversations and large session lists load without getting stuck. Exceptionally large individual messages clearly indicate when the full content needs to be viewed on your Mac.
- **More phone terminals** — Existing Cline, Hermes, and Droid terminals appear in remote control. Pi conversations include saved messages, thinking, and tools. Codex terminals keep their own controls when another Codex chat is open.
- **iOS remote updates** — The native app now builds from the current remote interface instead of an older website checkout.

- **Phone Allow on a finished terminal prompt** — Tapping Allow or Deny on the phone after you already answered on the Mac (or after the prompt is gone) no longer types Y or N into whatever is running in that terminal. If the terminal is unavailable, the request stays open for retry.
- **Revoking a phone disconnects it right away** — Turning off a paired phone, or disabling remote, now drops that phone even if it was idle in the background.
- **Cursor model name** — Cursor chats now show Fable 5.1 instead of “Fable 5 1”.
- **Cursor last model** — Starting a new Cursor chat remembers the last model you picked, instead of jumping back to Composer.
- **Teams Knowledge disclosure** — The “Before you share” notice on the Knowledge tab now shows as a real panel with an accept button, instead of a block of raw HTML.
- **Gemini chat sign-in** — The first Gemini chat no longer sits on “Starting session…” while Google sign-in opens in a browser. The chat now says to finish signing in there.
- **Gemini context ring** — Gemini chats now show how much of the context window a turn used, instead of staying at 0%.
- **Gemini stop** — The Stop button in a Gemini chat actually cancels the reply instead of only clearing the spinner.
- **Gemini tool rows** — File search and read tools in Gemini chats show as Search / Read instead of “Tool Running find_file”. File reads clear the spinner once the file is opened, instead of spinning for the rest of the reply.
- **Gemini model picker** — In a Gemini chat, the model menu only lists Gemini models (not Claude, Codex, or Cursor).
- **Gemini permission prompts** — When Gemini asks you to allow a command or file change, the sidebar now pulses amber and the approval toast appears, even if you’re looking at a different chat.
- **Renaming a sidebar chat switches to it** — Renaming a chat in the sidebar (for example a Grok terminal) no longer jumps you into that chat while you’re typing.
- **Grok terminal clicks miss buttons** — Clicking Cancel, Send now, or pop-out on a subagent in a Grok terminal should register instead of doing nothing, including after switching away and back.
- **New Grok chat from the phone shows no messages** — Starting a Grok chat on your phone no longer leaves the Mac on “Starting session…” with an empty thread. Your first message shows up right away.
- **Phone photos in Grok chat** — Pictures you send from the phone now show up as pictures Grok can see, instead of a file it tries to read as text.
- **Grok queued follow-ups** — Messages you queue while Grok is working now send when it finishes, instead of sometimes vanishing.
- **Grok chats reopen** — Reopening a Grok chat more reliably shows the conversation and continues it, instead of a blank or forgetful thread.
- **Phone-started Grok chat on the Mac** — Opening a Grok chat you started on your phone no longer leaves the Mac stuck on “Starting session…” while Grok is already working.
- **Claude terminal starts faster after switching chats** — Switching away from a Claude terminal and back no longer restarts Claude from scratch every time.
- **Chat toolbar** — The bar above a chat is less busy: Commit and your editor are icons.
- **Chat Local and branch** — Gemini and Cursor chats keep the Local and branch pickers under the composer, like Codex.
- **Gemini and Cursor “Starting session…”** — Opening a Gemini or Cursor chat no longer stays stuck on “Starting session…” after the chat is actually ready.
- **Phone file edits** — Edited files on remote now show green + and red − counts on the row. Tapping the file opens a numbered diff (additions in green, removals in red) instead of a gold-tinted dump.
- **Grok “finished” toast while still working** — When a helper agent inside a Grok terminal finishes, you no longer get a “finished” toast if the main Grok agent is still going.
- **Codex Stop vanished while still working** — When Codex launches helper agents, the Stop button and spinner stay until Codex itself is done, not when one helper finishes.
- **Phone Codex list** — Helper agents Codex launches no longer show up as extra chats with the same name as the original conversation.
- **Phone Claude history after compact** — When Claude shortens a long terminal chat, the phone no longer shows the hidden “session continued” dump as a message.
- **Codex chat after Stop** — Stopping a Codex chat and sending another message no longer fails with a “thread not found” error.
- **Edit and copy on a prompt** — Hovering your own message in Gemini, Claude, Grok, or Cursor chat no longer stacks the edit and copy buttons on top of each other.
- **Hide and info on a tool row** — Hovering a helper-agent or tool row in chat no longer stacks Hide, the info button, and the expand arrow on top of each other. Result / Show on neighboring rows stay lined up.
- **Chat text lines up with the message box** — In Cursor, Claude, Gemini, and Grok chats, replies and tool lines now sit on the same left edge as Codex — inside the message box, not hanging past it.
- **Cursor context usage** — Cursor chats no longer show more of the context window used than the model actually holds (for example 100% with a used count bigger than the window). The ring now matches the real conversation size.

## v4.0.2 — 2026-08-26

### New
- **More terminal agents in New** — The New menu’s terminal chips now sit on two rows of five: Claude, Codex, Pi, OpenCode, and Grok; then Local, Kimi, Cline, Gemini, and Hermes. Each opens in this project’s folder, keeps working/done indicators, names the thread from your first prompt, and can resume the same conversation when you reopen it. The sidebar shows the model and +/− line counts when files change, like the other terminals. Existing Droid chats still open. If macOS blocks one of these CLIs from starting, the error now says so instead of a blank message. Gemini now opens Google’s Antigravity terminal, because Google sign-in on the old Gemini terminal no longer works for personal accounts.

### Improved
- **Claude and Codex model lists stay current** — The model picker now reads the models your Claude and Codex apps already know about, so new ones show up without waiting for an agmux update.
- **New menu** — The extra “Plain shell” row is gone. Start a terminal with the Terminal row or an agent chip.
- **Home lists more recent projects** — On a tall window, Home shows more of your recent projects instead of leaving a blank gap under usage.
- **Cooler when idle or with several chats running** — The app uses less of the computer’s processor and graphics when you’re in another app, when a terminal is sitting still, or when extra chats are working in the background while you look at a different one.
- **Time spent on models and providers** — Usage and Teams now show how long agents were actually working on each model and provider, next to tokens. Idle time is left out, same as the active-hours chart.
- **Usage and Teams token counts** — Codex cache hits and Claude replies that stream in pieces are counted the same way other usage tools do, so the totals should look right. Estimated cost follows each provider’s list prices, including long-context and 1-hour cache, and duplicate sub-agent / forked-session copies are not counted twice.
- **Teams only counts agmux sessions** — Team usage no longer includes Claude, Codex, or Grok work you did in those apps or in a regular terminal. Only sessions you started in agmux are counted. A sync after this update drops the extra history without clearing the in-app numbers.
- **Phone remote tool rows** — On remote, file edits stay visible with the actual diff and line numbers (and +/− counts), instead of collapsing into a group or showing “file updated.” Expanding a group of reads or commands still lets you open each tool’s output.

### Fixed
- **Grok looks scrambled when switching chats** — Switching from one Grok terminal to another no longer leaves the screen garbled so you have to hit Refresh.
- **Cline working indicator and chat names** — Cline chats now show the working spinner while a reply is in progress, and the sidebar names the thread from what you typed.
- **App quitting while a window is loading** — On the latest macOS, the app could close itself while a chat or the window was loading. That should no longer happen.
- **Grok terminal white strip** — Grok’s conversation no longer shows a bright white bar along the right edge. Other terminals were not affected.

## v4.0.1 — 2026-08-14

### Improved
- **Local models stay lighter in long chats** — On smaller Macs, a long local chat now keeps its working memory within the size Settings already showed, so it is less likely to fill the machine as the conversation grows.

### Fixed
- **Grok project memory on a new Mac** — Opening a Grok terminal now connects project memory right away, instead of skipping it until you trusted the folder. Grok should use the memory tools instead of rewriting the memory files by hand.

## v4.0.0 — 2026-08-14

### New
- **Cowork mode** — A briefcase button next to Task opens Cowork, a place for everyday work chats instead of coding terminals, with a short “Opening Cowork” screen so the switch never looks frozen. Cowork keeps its own list of folders: it starts empty, you add the ones you care about, and your Claude Cowork and ChatGPT Work chats for those folders — including chats started in the Claude and ChatGPT desktop apps — appear there with their earlier history. Refreshing picks up new desktop chats, New always starts a chat in a folder you added, and hiding or deleting a chat keeps it gone.
- **Cowork folders and file previews** — Rename a folder in Cowork by double-clicking it (or right-click → Rename) and drag folders into the order you want; nothing moves on your Mac. Clicking a file name inside a Cowork chat opens just that file — markdown in the reading preview — with the file tree closed for more room, and the file-explorer button still opens the tree when you want it.
- **ChatGPT Work and Grok Cowork chats** — ChatGPT Work is a Codex chat tuned for everyday work, with the same connected tools and plugins Codex already uses on your Mac. Grok Cowork is a regular Grok chat with the same everyday-work focus.
- **Beta program** — Apply at agmux.dev/beta. If you’re approved, you can download upcoming builds others don’t get, and paste a tester token under Settings → About → Updates so the app can install later betas for you.
- **Grok 4.6 in xAI chat** — New Grok chats use Grok 4.6, xAI’s latest model, by default, and Extra High reasoning is available. Grok 4.5 stays in the list, and a chat you set to 4.5 stays on 4.5.
- **Chat with AI models that run on your own Mac** — Start a new chat and pick a local model from the model list. Nothing you type, and nothing the model reads, leaves your computer, and it keeps working with no internet connection. New local chats respect your Local or Worktree choice and accept photos on the first message. The New menu also has a **local** option alongside Claude, Codex, and the rest, which opens the familiar terminal already pointed at one of your installed models.
- **Local Models page in Settings** — Browse models suited to your Mac, see how much space and memory each one needs, and download or remove them with one click. The one-time setup local models need sits at the top of the page with an Install button, so you can get ready before downloading anything. Recommended Speed, Balanced, and Quality picks are listed for every Mac size from 8 GB to 256 GB — switch the memory tier to see the picks for any machine, not only your own — and models that cannot read or change files are left out, so anything you can pick can genuinely help you code. You can paste an Exa key so local models can search the web, and turn native tool calling on or off.
- **Local models manage their own memory** — agmux loads a model when you start using it, unloads it once it goes idle, and shuts everything down when you quit, so several models can be available without filling up your Mac’s memory. To free memory sooner, use the Eject button in the chat composer, or right-click a local chat or terminal in the sidebar and choose **Eject model**.
- **Sign in to Cursor from Settings** — On Accounts, one click opens Cursor sign-in in your browser. After that, Cursor chat can use every model on your plan (including Ultra) without pasting an API key.
- **Team Knowledge (Teams plan)** — Paid teams (or an active trial) can keep shared decisions and short session summaries on teams.agmux.dev; free teams get analytics only. Owners turn it on after accepting the privacy note, and sharing anything — or letting agents read it — always requires accepting that note first. Members can add decisions and promote session notes, and the Memory tab can share a decision or summary straight to the team. When the owner allows it, agents can look up official team decisions, never full conversations. Owners can export Knowledge from the web.
- **PR Leaderboard (Teams plan)** — Weekly cost and GitHub pull-request ranking is part of the Teams plan (or trial), not Free. Owners connect a GitHub App and pick repositories in Settings.
- **Help tab on Teams** — Every team on teams.agmux.dev now has a Help tab covering setup, what is collected, roles, each page, budgets, leaderboard, knowledge, billing, and common problems, in plain language.

### Improved
- **Yellow and black look to match the website** — The default Midnight theme uses the same gold accent and dark surfaces as agmux.dev. The other Appearance themes (Forest, Indigo, Golden, and the rest) keep their own colors but now look cleaner in both dark and light mode — softer tints, readable text, and accents that stay clear on light backgrounds.
- **Home, Usage, and Issues look cleaner** — Those screens use the same quieter cards and headers as the rest of the app.
- **Cleaner terminal panel** — The slide-up terminal drops the yellow-tinted wash across its top bar. Tabs, the folder path, and the buttons now sit on one calm strip that matches the terminal below, with gold kept for the small dot that shows a shell is alive.
- **Cleaner chat scrolling** — The thin scrollbar along the right edge of Cursor and Claude chat is gone; you can still scroll with the trackpad or mouse wheel.
- **Cursor chat controls and model names** — Cursor chats show Chat/Plan, model, and Supervised / Auto / Full tool modes, and list friendly model names like **Composer 2.5** and **Sonnet 4.6 Thinking** instead of raw codes. Thinking is Off or On (or Low / High) instead of true/false, and only appears when the model supports it. Tool rows for shell, edit, and search render like other chats, and replies no longer leave stray status labels (like “FINISHED”) under the answer.
- **Faster, clearer app updates** — Update checks start as soon as you open the app, the update prompt sits larger in the bottom-right corner, and it shows again every time you open the app if an update is still waiting. Settings → About has an **Automatic updates** switch to download and install on open without a click.
- **Richer first-run setup** — Onboarding now covers project memory, whether new chats start with full permissions, phone remote, finish and approval alerts, keep-awake while agents run, automatic updates, and Claude vs Codex chat-or-terminal defaults — not only theme and fonts. Existing installs that already finished setup get a short “new options” pass for the new choices.
- **Clearer, safer project memory** — Memory shows who wrote each entry and a compact health summary. Editing a fact can mark older entries as replaced, so agents stop treating stale notes as truth.
- **Memory rules are set by agents, not a review queue** — A rule agents must follow is marked by the agent that verified it, rather than by you clicking through a queue, and important stars stay sparse attention markers. The Memory screen shows both counts without a confirm step and warns when either piles up. **Clean memories** clears important flags and archives replaced entries and resolved issues; binding rules stay, and nothing is permanently deleted.
- **More reliable shared memory** — When several chats save memory at once, their changes no longer overwrite each other. Memory saves recover after an interruption, and agmux warns you if its local readable copy needs repair.
- **Photos on Remote** — On your phone, the + button next to the message box attaches images (only after this app update — older Macs hide the button so photos don’t vanish). Chat sessions receive them like on the Mac; terminal sessions get a file path on your computer so the agent can open the image. The button stays put when the phone reconnects while your Mac is still online, and the temporary “sending” bubble clears once the photo lands in the conversation.
- **More agents on remote** — Phone remote can see and control OpenCode, Cursor, Kimi, and local-model sessions as well as Claude, Codex, and Grok. You can start a new Cursor chat from the phone (pick any model on your Cursor plan, send messages, and stop a turn) without opening it on the Mac first, and changing OpenCode or Cursor models from the phone works.
- **Phone remote at remote.agmux.dev** — The phone remote site is now at **remote.agmux.dev**. Older links to agmux.dev/remote still work, so you don’t need to re-pair if you already use remote.
- **Connect this Mac from the remote website** — On a Mac browser at remote.agmux.dev, tap **Connect this Mac** to open the app and pair that browser automatically, with no code typing. For safety, if Remote control is switched off, the app takes you to Settings to turn it on yourself — a web page can never quietly switch on phone access to your Mac.
- **Phone alert when an agent is waiting on you** — If you leave the remote phone app in the background, it can show a system notification when an agent needs approval or an answer, so you can jump back in without watching the screen.
- **Team agent policy** — Team owners can set which coding agents members may start and a default permission mode (Teams → Settings → Agent policy). Linked Macs pick that up on sync.
- **Teams: how long agents wait on people** — Team dashboards can show how many approvals happened and how long agents spent blocked waiting for a human (counts only — never what you typed).
- **Codex usage shows weekly correctly** — When Codex only has a weekly limit (the 5-hour one is off), the home and usage cards show it as Weekly instead of mislabeling it as 5-hour.
- **Kimi model name and context meter** — Kimi terminal sessions now show the active model (for example K2.7 Coding) and how full the context window is in the sidebar and top bar, same as the other agents.
- **Grok chat first message looks clean** — The long project-memory instructions Grok needs on the first turn no longer fill the yellow user bubble; you only see what you typed.
- **Task mode catches up** — You can start Grok or OpenCode as a terminal agent on a task (not only as chat), status badges only show “running” when an agent is actually working, and empty Task mode has a clear New Task button (⌘N).
- **Quieter background sessions** — Grok sessions you leave open release their heavy helpers when you switch away, and unused Codex project connections stop hanging around, so the app uses less memory with many projects open.
- **Window size remembered** — If you resize or move the app window, that size and place come back the next time you open agmux.
- **App data folder renamed to match agmux** — Your projects, settings, and history move automatically from the old private folder name into **`.agmux`** on first open after update. Nothing to do by hand.
- **Built-in browser removed** — The Browser button in the chat top bar and the side browser panel are gone. Web links still open in your normal system browser.
- **No “Rec” badges on model lists** — The model picker no longer marks some Claude, OpenCode, or Grok models as recommended; every model is listed the same way.
- **Settings cleanup** — Removed the Agentic terminal control; Issues dispatch instructions live on their own Issues page; chat summaries are local-only, and older Qwen2.5 models must be replaced with Qwen3 or Phi-4. Claude Auto mode is labeled as available on every plan, and Settings pages use tighter padding.
- **Friendlier tips and settings wording** — Home-screen tips and several Settings descriptions drop engineering jargon so the product reads more clearly for everyday use.

### Fixed
- **Light mode is readable again on Teams, updates, and the file editor** — Settings → Teams headings, the update prompt, editor tabs, the file filter, and ask/approval banners no longer go white-on-white when Appearance is Light. The update prompt also stays put when you click back into the app.
- **“Manual download needed” no longer pops up over and over** — Closing that update notice keeps it closed for the rest of the session, and a failed background update check no longer claims you need a full reinstall from the website.
- **Automatic updates recover from a failed install** — If an auto-update fails, you see an error and can retry instead of a stuck “installing…” state.
- **What’s New no longer covers Welcome** — On a first install, and when existing installs see the short “new options” pass, the What’s New sheet and notification prompt wait until you finish setup.
- **Finish and approval alerts honor setup** — Turning off “Notify when an agent finishes” or “Notify when approval is needed” in first-run setup (or Settings → Notifications) actually stops those Mac notifications.
- **App no longer quits when dragging a file onto a terminal** — Dragging a file from Finder into a Claude (or other) terminal session no longer closes the whole app mid-drag. You can drop the file to paste its path into the prompt as before.
- **New Codex terminal sessions open cleanly** — Starting a fresh Codex terminal no longer fails with a “failed to resume session” error, so it loads as usual and you can type right away.
- **Chats no longer appear twice in the sidebar** — Starting a Grok chat, or a Claude or Codex chat from remote.agmux.dev, shows one entry on the Mac instead of the chat plus a matching terminal session with a messy model name.
- **Home no longer lists the same Codex chat twice** — Codex chats show once on the home Recents list, matching the sidebar.
- **Idle terminals no longer sit in Active** — The top-strip Active group only includes chats that are actually working, not every open terminal.
- **Cursor chats behave like every other chat** — Cursor sessions show the Cursor app icon instead of a plain letter “C”, spin the same working indicator in the sidebar while answering (and clear it when the turn ends), and show how full the context window is in the top bar after a turn.
- **Cursor remembers Local vs Worktree** — The Local / Worktree control under a new Cursor chat no longer snaps back to Worktree every time you open the composer. Pick Local once and new Cursor drafts stay on Local until you change it.
- **OpenCode model and context in the sidebar and top bar** — OpenCode terminal sessions now show which model is running under the session name and a context-window meter in the top bar, same as Claude, Kimi, and Grok, instead of only “Terminal · now” with an empty row.
- **Grok chats stay on Grok models** — The model menu in a Grok chat lists Grok models instead of Claude and Codex, and a new Grok draft no longer starts on a Cursor or Claude model.
- **Grok chats keep their reasoning after reopen** — Prior thinking is shown again when you reopen a Grok chat, not only the reply text.
- **Grok terminal no longer double-notifies when done** — When a Grok terminal session finishes in the background, you get one completion notice instead of two stacked ones.
- **Grok helpers stay out of the sidebar** — Reviewers, writers, and other helpers Grok launches in the background, and one-off commands, no longer appear as extra chats in the project list on desktop or phone.
- **Jumping to an older prompt in Grok** — Picking a past turn from the Timeline works with short prompts and can be repeated in the same session, and if a turn really is gone the terminal returns you to where you were instead of stopping part-way up.
- **Task mode keeps working agents and your last task** — Opening Task mode no longer marks a live Grok or OpenCode terminal as failed, and your last selected task comes back even if you have more than one project.
- **“Worktree” from a project’s New menu** — Choosing Worktree switches to Task mode and opens a new task for that project (its own branch for parallel work), instead of a dialog that often left the chat hard to find or never set up the branch at all.
- **Hidden task folders rediscovered with custom settings** — Tasks you made with a custom folder location or “branch first” layout show up again when you reopen Task mode.
- **New Task keeps the error on screen** — If the task folder is created but the agent fails to start, the dialog stays open with the error so you can fix it instead of closing silently.
- **Extra Codex agents on multi-folder tasks** — Starting another Codex agent on a task that spans several folders no longer fails to open.
- **Commit works when design docs are part of the change** — Creating a commit no longer fails with a red “git add failed / paths are ignored” error when a tracked file under an ignored folder (like `docs`) is included. Those files stage and commit as usual.
- **Phone send shows the Mac as working** — Starting a Cursor or Claude chat from your phone keeps the desktop sidebar spinner going until the turn actually finishes.
- **Phone Cursor chats follow Supervised / Auto / Full** — New Cursor chats from your phone use the permission you pick, not unrestricted tools.
- **Codex chats started from your phone stay clean** — Starting a Codex chat from remote no longer dumps project instructions into the conversation.
- **Remote session status matches the Mac** — A small spinner shows while an agent is working, an amber pulse means it needs your attention, and a green pulse means it finished and you have not looked yet. Green clears as soon as you open the session, including when you are already sitting in the chat.
- **Chat titles match between phone and Mac** — Chats started from your phone get a normal short title on the Mac sidebar and on remote after the first message, instead of staying “New Grok Chat” or showing a temporary file path when a photo was attached. Grok chats are named while they are still working, sessions that were only named on the Mac now show that name on the phone, and renaming a session updates the title at the top of the open chat right away.
- **Remote model picker on web and phone** — Choosing a different provider (Claude, Codex, Grok, OpenCode, Cursor) in the new-chat model menu opens that provider’s models instead of closing the menu. OpenCode and Cursor load the same full catalog from your Mac as the desktop app (with search), Grok no longer lists Composer, the OpenCode logo appears correctly, and a fresh chat defaults to Claude Opus 5.
- **New chat from a project on Remote** — Each project in the remote session list has a + next to the count; tap it to open a draft chat already set to that project. The folder picker lists projects in the same order as the Mac sidebar, not by when each was created.
- **Tables in replies on your phone** — Tables in agent replies render as real tables on the phone (with bold and code inside cells), instead of one long line of pipes.
- **Remote terminal no longer shows blank user lines for control keys** — Clearing the prompt or interrupting a run does not leave empty yellow bubbles in the phone timeline.
- **Phone remote matches the app’s colors** — Phone remote uses the same gold accent and black backdrop as the Mac app and website.
- **Remote control after site updates** — If the remote service is briefly updated while your phone is connected, the phone and Mac reconnect on their own and keep your pairing.
- **Teams upload keeps going after a Codex approval** — Approving a Codex tool no longer blocks that Mac’s Teams upload.
- **Linking a Mac asks you to confirm** — Linking a Mac to a team from the browser now asks for confirmation first, so a link cannot be triggered silently.
- **Project memory tools on other people’s Macs** — Shared project memory (the tools agents use to remember decisions) starts correctly when you install agmux from the app package, including Codex and Grok terminals — not only on a developer machine that still has the source folder.
- **Safer file tools** — Deleting or renaming files cannot reach outside your project folder, image attach only reads allowed paths, and @-mention file browsing stays inside the project too.

## v3.1.4 — 2026-08-08

### Improved
- **Teams leaderboard drill-down** — Click a person on the PR leaderboard to open their metrics for that same week (model mix, token composition, cache hit) so you can see why TOK/pt or $/pt is high.
- **Teams site on phones** — On a narrow screen the top nav wraps instead of clipping, wide tables scroll sideways, and the PR leaderboard shows as cards instead of a cut-off table.

### Fixed
- **Grok timeline jump** — Clicking an older prompt in the Session timeline scrolls the Grok terminal back to that turn (Grok’s full-screen UI has no terminal scrollback, so jump now searches and scrolls inside Grok itself).
- **App freezes during long chats** — The window should stay responsive while agents run many tool steps; session timeline no longer overloads the app when updating the turn badge.
- **Blank frozen window after long sessions** — If the built-in browser view stops responding, the app reloads it automatically so you do not have to quit and reopen.
- **Sluggish app after very large chat history cleanup** — On launch, agmux reclaims wasted space left behind after old oversized logs were removed so the app stays snappy.

## v3.1.3 — 2026-08-07

### New
- **Kimi Code** — Start a **Kimi** terminal chat from the provider picker (replaces the older Droid option). Existing chats still open normally.
- **Teams PR leaderboard** — On teams.agmux.dev, owners can turn on a leaderboard that ranks people by merged pull requests and usage after linking a GitHub organization.
- **On-device model for titles** — Chat titles and short summaries use a small model that runs on your Mac (one-time download, no API key). First launch asks you to install it; you can upgrade later to newer options like Qwen3.

### Improved
- **Up-to-date cost estimates for new models** — When a model isn’t in agmux’s built-in price list, estimated cost uses live public rates (OpenRouter) instead of guessing. If no price is known, cost shows as zero rather than a made-up number.
- **Cursor chat model list** — Starting a Cursor chat shows every model available on your Cursor plan (not only Composer), so you can pick the same models Cursor itself offers for your account.
- **Teams member profile photos** — Team people lists show each person’s GitHub or Google profile picture instead of only colored initials.
- **Smarter chat titles as you keep talking** — After each new message in a long chat, the sidebar title updates from the whole conversation (with more weight on what you just asked). Short “go ahead” / “do it” replies no longer rename the chat. Right-click a chat and choose **Resummarize** anytime to refresh the title.
- **Teams leaderboard table** — Member names line up cleanly (no more right-aligned handles), GitHub-style logins show as readable names, and you can click any column header to sort by merged PRs, tokens, tokens per PR, $/pt, and more.
- **Teams leaderboard for Nenu** — When a team links the NenuAI GitHub organization, ranks use complexity points from each pull request’s Project Size (XS through XXL) instead of only small/medium/large by lines changed.
- **Teams groups and manager views** — On teams.agmux.dev, owners can create groups and limit what each manager sees to specific groups or people.
- **Select text in terminals** — Hold Shift while dragging, or use Shift+arrow keys, to select and copy text in agent terminals—even when the agent is using full-screen or mouse mode.
- **Terminal links open in your browser** — Web links in agent terminals open in your system browser (not the in-app side panel).

### Fixed
- **Session timeline jump** — Clicking a turn in the Session timeline scrolls the chat or terminal back to that prompt (with a brief highlight in chat). Works for Claude, Grok, Codex, Kimi, and OpenCode sessions.
- **Usage and Teams cost estimates** — Estimated spend for Codex, Grok, and Claude models is much more accurate. Codex no longer double-counts cached prompt tokens (which inflated costs by several times), Grok now uses real token and cache numbers from sessions instead of rough guesses, and model rates match current public pricing (including Fable, Sonnet 5 intro pricing, and the July GPT-5.6 Terra/Luna cuts). The same numbers feed the Usage tab, Settings → Your Data, and Teams.
- **Composer removed from xAI chat** — New Grok chats no longer offer Composer as a model under xAI. Composer stays available under Cursor chat.
- **Grok slash-skill chat titles** — Starting a Grok terminal chat with only a slash skill (like `/checkagentsdk` or `/commit`) now gets a real sidebar title instead of staying “New Grok Thread” or showing the raw command.
- **Search for hyphenated words** — Searching for phrases like “multi-prompt titles” in global search (⌘⇧F) finds matching chats again. Hyphenated terms were treated as “exclude this word,” so results came back empty.
- **Sessions stuck on “Loading… / Fetching history from your Mac” on your phone** — Opening a session from your phone now shows the conversation right away instead of hanging on the loading screen. Your Mac was re-sending the whole session list and every open conversation every couple of seconds even when nothing had changed, which clogged the connection; it now sends updates only when something actually changes, and it stays quiet entirely when no phone is connected. This also cuts the data agmux uploads in the background to a small fraction of what it was.
- **Remote Control stuck on “Online” after the connection died** — If the link to your phone silently broke, your Mac kept reporting Online while nothing actually reached the phone until you restarted the app. It now notices within about a minute and reconnects on its own.
- **What's New logo** — After an update, the release notes popup shows the agmux app icon instead of a generic X mark.
- **Multi-Agent option removed** — Starting a new chat no longer lists Multi-Agent in the provider picker. Use Claude, Codex, Grok, or another provider as usual.
- **App freeze with blank windows** — Long Grok/Claude terminal sessions no longer fill the local database with huge terminal scrapes, which could make the app hang and leave windows blank. Old oversized scrapes are cleaned up on launch.
- **Thread name summaries** — Auto-generated chat titles work again with the on-device model (they were failing with “No title returned”).

## v3.1.2 — 2026-08-04

### New
- **Teams budgets and exports** — Managers can set a monthly spend budget with a month-end projection, download usage as a spreadsheet, and review a simple log of team changes (joins, budget edits, exports).
- **Tool activity on Teams** — See work broken down by kind (terminal, edits, reads, search, web, helpers) plus how many files changed and lines added or removed — counts only, never your code or paths.

### Improved
- **Teams charts show real activity** — Usage now comes from your actual Claude, Codex, and Grok sessions so dashboards fill in as you work instead of staying empty.
- **Friendlier Teams labels** — Providers and models show as readable names (Claude Code, Claude Opus 4.6, Grok Code Fast) instead of raw codes.
- **Grok cost estimates** — Usage and Teams cost figures for Grok use real rates instead of showing $0.

### Fixed
- **Grok terminal refresh** — The refresh control next to the branch name redraws the Grok terminal again (including in split view).
- **Smoother Grok trackpad scroll** — Scrolling a Grok conversation moves line by line instead of jumping by whole pages.
- **Teams Sync now** — Syncing from Settings always rechecks and tells you whether something uploaded or you were already up to date.

## v3.1.1 — 2026-08-03

### New
- **Multi-Agent chats** — When starting a new chat, pick **Multi-Agent** and choose a main model (Claude, Codex, Grok, and others). You talk to that main agent like a normal chat; it can bring other agents in behind the scenes to help.
- **agmux Teams** — Under Settings → **Teams**, sign in and join a team. See simple team usage in the app and on **teams.agmux.dev**. Only hourly summaries are shared — never your prompts, code, or file paths — and you review what is shared before joining.
- **Built-in browser** — Open a browser from the chat top bar to view pages beside your work (back, forward, reload, or open in your system browser).

### Improved
- **Multi-Agent model picker** — Main models show the right logos, and effort and permission controls match a normal chat for that model.
- **Grok terminal scrolling** — Trackpad and mouse wheel scroll the Grok conversation instead of moving the cursor in the prompt.

### Fixed
- **Grok after /clear** — Starting a fresh Grok session with `/clear` no longer gets stuck on the old session when you return to the tab.

## v3.1.0 — 2026-07-16

### New
- **Phone remote control** — Turn on **Remote control** under Settings to manage Claude, Codex, and Grok chats and terminals from your phone at **remote.agmux.dev**. Pair with a short code (QR link), see your sessions, read the conversation, send messages, stop a run, and approve or deny tool requests. While remote is on, the Mac can stay awake with the lid closed so agents keep going when you’re away. Turn remote off anytime to disconnect phones (even if the Mac was offline when you turned it off).
- **Session timeline** — On any agent chat or terminal, open **Timeline** in the top bar to see past turns in this session (what you asked, a short summary of what the agent did, done/running status, and how long ago). Click a turn to jump back to that point in the conversation.
- **Issues tab** — Browse open GitHub issues for your project (uses your existing GitHub login from the terminal). Pick an issue and **Dispatch to agent** to start a new chat on it, with the issue title and description filled in. Add extra repos to track if you like.
- **Orchestrator tab** — See every active agent as a tile: who’s working, who needs your OK, last action, and approve/deny without hunting through the sidebar. The full agent list stays in the sidebar while you’re there. Message or launch agents from the composer at the bottom, including pasting or dropping images into the prompt (same as normal chat).
- **Horizontal agent tabs** — In Settings → Appearance, switch Agent tabs to **Horizontal** for a browser-style top bar: project pills, sessions in a strip (active ones first), compact + / compose to start new agents, and full-width chat. **Vertical** (sidebar) stays the default. Includes **Running** (live sessions across projects) and **Your Threads** (opened sessions stay until you close them with × — like multi-view tabs for the top bar).
- **Smarter chat search** — Search finds text inside past messages and notes (not just chat titles), with short previews of the match.
- **Claude Cowork chat** — When starting a new Claude chat, toggle **Code** / **Cowork** on the composer. Cowork is for everyday work (docs, files, research) instead of coding, still using your Claude subscription.
- **Shared project memory** — Every chat and terminal in a project shares one memory (Claude, Grok, Codex, and others — including terminal mode). Agents can save decisions and facts so the next model or terminal session still knows them. Browse everything in the sidebar **Memory** tab (replaces the old Agents tab): durable memory, session history, and archived items now have separate views, with clear labels showing whether an entry was recorded by you, an agent, or an automatic summary. You can edit, archive, restore, resolve, and reopen entries there. Agents can **search** past memory and sessions, open a summary, then pull a short slice of the chat log if they need more — without pasting whole histories. If an agent forgets to write a session note, a **local model** can fill a short handoff (only then — never overwrites what the agent wrote). New sessions can get a tiny **recent session list** (titles only; optional under Settings → Behavior). Turn project memory off anytime under Settings → Behavior → **Project memory** (on by default).
- **Update project path & move threads** — Right-click a project to **Update project path…** when the folder moved on disk (the sidebar name follows the folder, and chats that still used the old path come along). Or **Move all threads…** to another project if you reorganized folders.

### Improved
- **Richer first-time setup** — Setup walks through visual themes, fonts, vertical vs horizontal session tabs, what ⌘N / compose opens, which AI drafts commit messages, notifications, chat vs terminal defaults, and an optional local AI model download. Re-run anytime from Settings → About → Run setup. After updates that add new setup choices, a short refresh may appear once.
- **Tasks on the right of chat** — To-do lists and plans (Claude, Cowork, Codex, Grok, OpenCode, and local models) show as a floating checklist on the right of the chat, with progress and a collapse chip — no longer a bar above the message box. Chat text and tool lines stay lined up with the left edge of the message box.
- **View commit after you push** — When a commit finishes, use **View commit** (bottom left of the success dialog) to open that commit on GitHub.
- **Click a notification to open that chat** — When an agent finishes or needs your OK while you’re in another app, clicking the macOS notification brings you straight to that conversation. You can also click a row in the in-app notification list to jump there.
- **Codex says when tools are still starting** — If Codex is still connecting its tools at the start of a turn, the status line shows **starting MCP** (with the tool name) instead of a silent “thinking.”
- **Finish toast clears when you open the chat** — Opening a finished agent’s chat (from the sidebar, a tab, or split view) dismisses its “Finished” toast so it doesn’t linger.

### Fixed
- **Grok helper workers stay out of the sidebar** — When Grok Terminal spins up short helper workers for a task, those no longer show up as extra chats in the project list (and the list rows stay lined up).
- **Grok token history in Usage** — Past Grok chats (including terminal ones) now show up in the token charts and totals, not only the SuperGrok credit bar.
- **Selected items readable in light mode** — The highlighted Settings tab and the selected chat in the sidebar no longer use pale text on a pale background.
- **Smarter Grok approval pings** — While Grok’s Auto mode is still deciding (classifying), the sidebar no longer flashes amber early. You only get the amber “needs approval” pulse and Mac notification when the Yes/No menu is actually on screen — not for silent auto-approves, and not during the wait. After you approve or deny, the amber clears right away (not only when the command finishes).
- **Codex terminal model label** — When you switch models inside a Codex Terminal session, the sidebar and top bar update to the new model instead of staying on the old name.
- **Codex terminal context meter** — The top bar shows how full the context window is for Codex Terminal sessions (same as Codex chat), and it updates as the session continues.

## v3.0.0 — 2026-07-10

### New
- **GPT-5.6 models** — Codex and OpenCode now include Sol (default), Terra, and Luna. Sol and Terra also offer **Max** and **Ultra** reasoning levels.
- **Grok 4.5** — New default Grok model. Existing threads keep their old model names.
- **Codex Auto Review** — A new permission option that lets Codex auto-review approval requests for you (alongside Default and Full Permissions).
- **Grok usage on Home & Usage** — See SuperGrok credit use (how much is left and when it resets), plus Grok session history in the same charts as Claude and Codex.
- **Show only running threads** — Right-click a project in the sidebar to hide idle history and keep only threads that are working, need your attention, or are open.
- **Keep running with the lid closed** — Under Settings → General, allow agents to keep going with the MacBook lid shut (works on power and battery). Uses Touch ID once to set up; normal sleep returns when the agent finishes or you quit the app.

### Improved
- **Fresh glass look throughout** — Chat, Home, Usage, Settings, the sidebar, and the slide-out terminal share the same soft emerald frosted-glass style: translucent panels, quiet dividers, and a calmer overall surface.
- **Cleaner chat for every agent** — Claude, Grok, OpenCode, and Codex chats now share the same layout: plain agent replies (not speech bubbles), short one-line tool rows you can expand for details, and finished turns that fold into a simple “Thought for …” summary. Click to expand the full step-by-step again.
- **Smarter message composer** — Model, reasoning effort, permissions, and send sit on one row. Effort is a Faster ↔ Smarter slider (same control everywhere), the context meter is a clear ring, and menus match the glass look.
- **Smoother chat** — Replies stream more naturally, expansions animate instead of snapping, and tables/code blocks match the glass style (with a copy button on code).
- **Smarter commit messages** — The commit dialog drafts a message automatically (and you can pick which model does it under Settings → General).
- **Clearer agent-done sound** — The default finish chime is a soft double-hit instead of a low hum.
- **Lighter on memory when terminals sit unused** — Idle background terminals free memory after a couple of minutes and come back when you open them again. Grok also releases heavy helper tools it started, so long sessions use less RAM.
- **Simpler Settings** — Removed tabs that didn’t do anything. Models is now **Summaries**; terminal history length lives under General. Quick Open can start any agent type, not just a few.
- **Keep-awake while waiting on you** — The Mac stays awake not only while the agent is working, but also while it’s waiting for your approval.
- **Tidier project menu** — Removed the unused “Edit conventions” item from the project right-click menu.

### Fixed
- **Settings and sidebar look right in light mode** — Text, cards, and +/− line counts stay readable on a bright theme.
- **Codex model list is cleaner** — Retired models are gone; GPT-5.3 Codex no longer appears twice.
- **Context meter stays accurate for Grok** — Updates while the agent is working, and no longer sticks after you compact a long chat.
- **Codex sub-agents read clearly** — Launching helpers shows one stable “Launched … Agent” line (not a clutter of internal steps), live and when you reopen the chat.
- **Codex Terminal starts cleanly** — No more frozen “Fitting terminal…”, sudden window crash, “session not found,” or an extra Chat thread appearing in the sidebar.
- **Codex working spinner clears on time** — Stops soon after the agent finishes, and clears right away if you press Escape. Stray red “/” badge next to the title is gone.
- **Grok (and similar) terminals are more reliable** — No endless “Fitting terminal…,” no garbled layout when you return to a resting session, correct +/− counts in the sidebar and completion toast, and the working spinner clears when you press Escape.
- **Grok asks for attention properly** — When Grok asks you a question, the sidebar pulses amber and you get a Mac notification.
- **Terminal refresh button works again** — Clicking refresh next to the branch name resizes the terminal instead of dragging the window.
- **Reopening a terminal doesn’t reset its time to “now”** — Last activity stays honest when you open an existing Grok, Droid, or OpenCode terminal.
- **Home shows friendly model names** — e.g. **Grok 4.5** instead of a raw code like `grok-4.5`.
- **In-app updates after the rename** — Auto-update works again after the Xanom → agmux name change. If an update still can’t install, a banner points you to [agmux.dev](https://agmux.dev/#download).

## v2.2.0 — 2026-07-05

### New
- **New name: agmux** — Xanom is now agmux, with a refreshed logo and app icons across macOS, Windows, iOS, and Android.

### Improved
- **Much lower CPU with many terminals open** — Running several Claude terminal sessions at once no longer heats up the machine. Idle terminal sessions no longer wake the CPU on a timer, background sessions stop polling git and decoding output they aren't showing, and only the visible session refreshes its branch/status — so CPU now stays flat as you open more sessions instead of climbing with each one.
- **Home screen no longer keeps the GPU busy** — A background Codex or shell terminal that was still streaming would keep repainting off-screen while you were on the Home screen (or any other tab), holding CPU/GPU usage up. Off-screen terminals now pause rendering whenever they aren't the visible view.

### Fixed
- **Dropping a non-image file now pastes its path** — Dragging a PDF, document, or any non-image file from Finder into a chat composer or terminal now inserts its full path (quoted when it contains spaces); previously only images were handled and other files did nothing. Images continue to attach as before. Drop targeting also covers the full terminal/chat pane (not just a center-ish hit region on Retina).
- **Terminals no longer unload while an agent is waiting on you** — A backgrounded Claude session with a pending permission prompt, or a shell terminal running a full-screen interactive agent, now stays loaded instead of being offloaded after inactivity, so the question isn't torn down out from under you.

## v2.1.4 — 2026-07-02

### New
- **Claude Sonnet 5** — Added to the model picker with proper display-name formatting.

### Improved
- **Smoother chat streaming** — Markdown rendering is now memoized and streaming updates are batched, cutting redraw overhead during long responses across Claude, Codex, and OpenCode sessions.
- **Snappier sidebar and project list** — Zustand store subscriptions are scoped more precisely and background polling pauses while the window is hidden, so the sidebar re-renders far less during heavy activity.
- **Faster app launch** — The settings dialog and CodeMirror language modes now load on demand instead of bundling upfront, shrinking the startup bundle.
- **Codex sidebar loads instantly** — The thread list no longer waits on reading every session's model from disk; model labels backfill in the background as they resolve, and app startup no longer blocks on this fetch.
- **Refreshed app icon** — New icon artwork across macOS, Windows, iOS, and Android.

### Fixed
- **Codex thread rename, compaction, and rate-limit status work again** — Updated to match a Codex app-server protocol rename that had silently broken these actions.
- **Model labels in the thread header show proper names** — Claude and Codex model slugs are now prettified (e.g. "claude-sonnet-5" → "Sonnet 5") instead of raw slugs.
- **Streaming updates no longer stall** — Fixed a timing edge case where coalesced streaming deltas could be delayed past their flush deadline.
