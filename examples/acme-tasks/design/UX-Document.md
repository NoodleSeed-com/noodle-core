# Acme Tasks ChatGPT App — User Flow & Experience Document

**Prepared by:** Noodle Seed
**Scope:** Capture, prioritize, and complete today's tasks entirely inside ChatGPT — a two-way (read + write) task manager. There is no handoff; the value is doing the work in place.
**Status:** Design specification (v1)
**Two-way scope & auth stance:** IN-APP (in chat) — read today's list, capture new tasks, re-prioritize, and complete them, each write confirmed in-chat. OFF-APP — nothing transactional; the only boundary crossing is a **one-time scoped account connection** (`customerAuth` end-user OAuth: read + write, connected once). Every scope debate resolves here: if a request is "see, add, re-order, or finish a task," it stays in chat; the account link is the single, revocable off-app moment.

> This document is the master spec. The wireframes (`wireframe.html`), the widget code (`src/views/task-list.tsx`), and the server (`src/server.ts`) are all derivable from it. Acme Tasks is a fictional productivity app; all data below is sample content.

---

## Section 0 — The One-Paragraph Thesis

A person mid-conversation in ChatGPT says *"remind me to email the vendor about the Q3 quote"* — and today that intent evaporates, because acting on it means leaving the conversation for a separate app. Acme Tasks closes that gap: the moment a task is spoken it is **captured, prioritized, and completed without ever leaving chat**. This is deliberately **not** a top-of-funnel handoff app — there is no cart to check out, no site to open, no "continue in the app." The task manager *is* the conversation. We own the in-chat experience end to end (read the live list, add by natural language, re-prioritize, complete); the user owns their account, connected once through a scoped, revocable link. The strategic kicker: a to-do app is the highest-frequency surface a person touches, and the app that lets them clear their list *in the same window where the work is being discussed* becomes the one they never close. **In-chat completion is the product.**

---

## 1. Acme Tasks Product Overview (Knowledge Base)

**What the company is.** Acme Tasks is a personal + small-team task manager: a single prioritized list per user, each task carrying a **title**, a **priority** (`high` / `medium` / `low`), and a **done** state. It is intentionally minimal — no projects, no assignees, no sub-tasks in v1 — so the model can reason about the whole list in one turn.

**The data domain the app must know.** The user's *today* list. In this flagship the list is **seeded** so the design can focus on the flows; the three seed items are the canonical fixtures every downstream artifact reuses:

| id | title | priority |
| :--- | :--- | :--- |
| `email_vendor` | Email the vendor about the Q3 quote | `high` |
| `review_pr` | Review the analytics pull request | `medium` |
| `book_offsite` | Book flights for the team offsite | `low` |

**The highest-value / highest-risk domain** is the account write. Because the app can *complete* and *re-prioritize* real tasks, every mutation must be legible and confirmed — a silently-checked-off task is the worst possible failure.

**What lives after any boundary crossing.** Nothing transactional. Unlike a discovery funnel, Acme Tasks has no off-app destination it hands users to; the only off-app step is the one-time `customerAuth` consent screen (§9). After that, everything is in chat.

**Business model / why this matters.** Frequency and retention. A task app is opened many times a day; the version that removes the app-switch tax — "I thought of it, I said it, it's on my list, it's done" — wins the habit. The bottleneck the app removes is **context-switching**, not data entry.

---

## 2. Competitive Landscape — Task Managers on ChatGPT

Most task integrations on assistant platforms are **read-only or one-way**: they can list what's due but push the user to a separate app to actually change anything, or they capture a task into a black box with no confirmation. The generic model can *talk about* a to-do list but has no grounded state — it will happily invent tasks that don't exist.

**Acme Tasks' unique position** is the *closed two-way loop in one surface*: a grounded read (the real list, never guessed), natural-language writes (capture, re-prioritize, complete), and an in-chat confirmation for every mutation. The differentiator is not the widget — it is that the widget's actions **commit** and the user **sees what changed** without a tab switch.

---

## 3. Target User Personas

- **The Quick Capturer** — *"add: book flights for the offsite, low priority."* Thinks of a task mid-conversation and wants it on the list before the thought is gone. Values zero-friction capture.
- **The Morning Triager** — *"what's on my plate today?"* Opens the day, scans the list, and re-orders priorities before starting. Values a fast, grounded read plus one-tap re-prioritize.
- **The Closer** — *"mark the vendor email done."* Finishes work and wants the satisfaction of checking it off without leaving the thread. Values instant, confirmed completion.

All three are the **same user at different moments of the day** — capture in the morning stand-up, triage before lunch, close out at end of day. The app is designed so one connected session serves all three.

---

## 4. Conversational User Flow

### 4.1 Entry points (natural triggers)

- **Capture:** "remind me to…", "add a task…", "put X on my list", "I need to email the vendor."
- **Prioritize / read:** "what's on my list today?", "what's due?", "show my tasks", "make the PR review high priority."
- **Complete:** "mark X done", "I finished the vendor email", "check off the offsite booking."

### 4.2 Flow architecture

```
                       ┌─────────────────────────────┐
   first run ─────────▶│  Connect Acme Tasks (once)  │  §9 · customerAuth, scoped R/W
                       └──────────────┬──────────────┘
                                      │ connection live thereafter
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                             ▼
   ① CAPTURE                    ② PRIORITIZE                   ③ COMPLETE
   add_task                     list_today  →  TaskList        complete_task
   "add X, high"                (render widget)                "mark X done"
        │                        set_priority (in widget)           │
        └──────────────▶  TaskList reflects the change  ◀───────────┘
                          (grounded read, always current)
```

`list_today` is the hub — it renders the `TaskList` widget the other two flows write into. Every flow returns a spoken-ready status so the model confirms in one turn.

### 4.3 Detailed conversational scenarios (playscripts)

**Scenario A — Capture (The Quick Capturer)**

```
User:      Add "book flights for the team offsite", low priority.
Tool call: add_task { title: "Book flights for the team offsite", priority: "low" }
Returns:   { status: "Added “Book flights for the team offsite” (low).", title, priority }
Assistant: Added "Book flights for the team offsite" at low priority. Want to see the full list?
```

**Scenario B — Prioritize / read + re-order (The Morning Triager)**

```
User:      What's on my plate today?
Tool call: list_today { focus: "today" }          ← renders TaskList widget
Returns:   { status: "Acme Tasks for today: 3 open items, highest priority first.", focus, tasks:[…] }
Widget:    TaskList — Email the vendor (high) · Review the analytics PR (medium) · Book offsite (low)

User:      Bump the PR review to high.
Tool call: set_priority { task: "review_pr", priority: "high" }   ← widget-only helper
Returns:   { status: "Set review_pr to high priority.", task, priority }
Widget:    TaskList re-orders — Review the analytics PR now sits with the high group.
```

**Scenario C — Complete (The Closer)**

```
User:      I finished the vendor email — mark it done.
Tool call: complete_task { task: "email_vendor", title: "Email the vendor about the Q3 quote" }
Returns:   { status: "Completed “Email the vendor about the Q3 quote”.", task }
Widget:    TaskList strikes the row through; open count drops from 3 → 2.
Assistant: Done — "Email the vendor about the Q3 quote" is checked off. Two left today.
```

---

## 5. UI Widget Specifications (Noodle Seed Apps Compliant)

### 5.1 Design system compliance

Widgets render inside the host (ChatGPT) via Noodle Seed's `view` component model and **CSS Cascade Layers**, so they inherit the host's light/dark surface and typography rather than shipping an app theme. Compliance rules, all enforceable via `noodle check --target chatgpt`:

- **Tokens, not hard-coded chrome.** Text, surface, and border come from host/Noodle Seed semantic tokens. The **brand accent is declared once** in the server `branding` block — `accent: #7C3AED`, `surface: #F5F3FF`, `surfaceDark: #161228`, `radius: lg`, `density: comfortable` — and is restricted to the **primary CTA, the logo/check mark, and the "high" priority emphasis only**. It is never a background wash.
- **Priority palette (semantic, fixed):** `high` = red `#DC2626`, `medium` = amber `#D97706`, `low` = slate `#6B7280`. These map 1:1 to the `priority` enum so the widget and the model share one vocabulary.
- **System fonts, outlined monochrome icons, WCAG AA contrast, no nested scroll**, and every mutation shows a confirmable result. The widget exposes a single flat `data-llm` summary line ("N open of M; K completed this session") so the model can narrate state without re-reading the DOM.

### 5.2 Display mode strategy

| User intent | Display mode | Why |
| :--- | :--- | :--- |
| "What's on my list?" | **Inline card** | The whole list fits; the answer is the list. |
| Triage a long list | **Fullscreen** (expand) | Density without nested scroll when items exceed the card. |
| Capture / complete / re-prioritize | **Inline card (in place)** | The write updates the same card; no new surface. |

**Deliberately NOT used:** *Carousel* (there is one list, not a set of peers) and *Picture-in-Picture* (nothing runs in the background). Stating the omissions is part of the compliance story.

### 5.3 Widget specifications

**★ `TaskList`** — the single widget; the hub all three flows read and write.
- **Purpose:** show today's prioritized list and let the user capture, re-prioritize, and complete in place.
- **Content fields:** header (logo, "Acme Tasks", status subtitle, open-count chip); a **capture input** ("Add a task…"); a **task row** per item = complete check + title + priority `<select>`; a footer note ("Two-way in chat: read, capture, re-prioritize, complete").
- **Actions (≤2 primary):** **Add** (capture) and the per-row **complete check**; re-prioritize is a lightweight inline `<select>`, not a primary CTA.
- **States:** *default* (seeded list), *captured* (new row appears immediately, then `add_task` records it), *re-prioritized* (row moves priority group), *completed* (row struck through, check filled, count decremented), *all-clear* (empty-state celebration + nudge to capture the next thing).
- **Grounding flag:** the list only ever shows tasks that exist in state — the app never invents a task.

---

## 6. Tool Definitions (App Backend)

All tools are atomic, model-fillable from natural language, and each returns a spoken-ready `status`.

**★ `list_today`** *(read-only · renders `TaskList`)*
- **Input:** `{ focus: string = "today" }`
- **Output:** `{ status, focus, tasks: [{ id, title, priority, done }] }`
- **Notes:** `tool` — the one tool that opens the widget. Host status copy: invoking "Loading your tasks…", invoked "Tasks ready".

**★ `add_task`** *(local write, non-destructive · model-visible)*
- **Input:** `{ title: string, priority: "high"|"medium"|"low" = "medium" }`
- **Output:** `{ status, title, priority }`
- **Notes:** capture from natural language; "high priority" fills `priority: "high"`.

**`complete_task`** *(local write, non-destructive · model-visible)*
- **Input:** `{ task: string (id), title: string = "" }`
- **Output:** `{ status, task }`
- **Notes:** model-visible so the user can complete by voice ("mark the vendor email done") without touching the widget.

**`set_priority`** *(local write, non-destructive · widget-only)*
- **Input:** `{ task: string (id), priority: "high"|"medium"|"low" }`
- **Output:** `{ status, task, priority }`
- **Notes:** `tool` — hidden from the model; the `<select>` in `TaskList` is its only caller, keeping the model's tool surface to the three it should reason about.

---

## 7. Conversation Design Principles

**Tone.** Brisk, confirming, never chatty. A task app earns trust by getting out of the way; every reply names *what changed* and offers the obvious next move.

**Guardrails (non-negotiable):**
- **Never invent a task.** The list is grounded in `list_today`'s returned state; if the app hasn't read a list, it says so rather than guessing.
- **Never mutate silently.** Capture, re-prioritize, and complete each return a visible confirmation and update the widget — the user always sees the new state.
- **Confirm completion explicitly.** "Done — *X* is checked off" plus the remaining count; completion is irreversible-feeling, so it is always narrated.
- **Priority is the user's, not the model's.** The model may *suggest* a priority when capturing ("this sounds high?") but sets what the user says; it does not silently re-rank the list.

**Memory strategy.** Session-scoped: captured tasks and completions persist across turns within the conversation (`added`/`done`/`priority` state layered over the seeded read). A production deployment persists to the connected account (§9).

**Multi-turn intelligence.** The model **infers** structured fields from prose ("book flights for the offsite, low" → title + `priority: low`) and **asks** only when a title is genuinely missing. It never asks the user to restate a task it can already see in `TaskList`.

---

## 8. End-to-End User Journey Map

| Phase | Time budget | What happens |
| :--- | :--- | :--- |
| **First run — Connect** | one-time, ~10s | Scoped `customerAuth` consent (read + write); dismissed forever after (§9). |
| **Read (grounded)** | first 3–5s | "What's on my plate?" → `list_today` renders `TaskList` with the real list. |
| **Capture** | ~2s per task | "Add X, high" → row appears instantly, `add_task` records it. |
| **Prioritize** | ~2s per change | Inline `<select>` or "bump the PR to high" → `set_priority`, list re-orders. |
| **Complete** | ~2s per task | Check the row or "mark X done" → `complete_task`, struck through, count drops. |
| **Close-out** | end of day | All-clear empty state; nudge to capture tomorrow's first task. |

---

## 9. Account-Connection / Auth Architecture (Deep Dive)

Because Acme Tasks **writes** to the user's tasks, the first interaction is a **scoped, one-time connection** — Noodle Seed's `customerAuth` end-user OAuth pattern (see the `customer-auth` example). This replaces the "handoff" a top-of-funnel app would have: there is no destination to send the user to, only an account to link.

**What must be true of the connection:**
- **Plain-language scope.** The consent card names *read* (your tasks and priorities) and *write* (add, re-prioritize, complete tasks you ask me to) in the user's words — not buried in an OAuth redirect.
- **Held by the connector, never the model.** The delegated credential is exchanged and stored by the credential broker; it is never surfaced in tool payloads, the widget, logs, or the model's context.
- **Connected once, revocable anytime.** One connection powers all three flows; the consent card links the revoke path.
- **The request resumes automatically.** After the user approves, the original ask ("what's on my plate?") continues without re-typing.

**Flagship simplification (honest note):** this example ships with a **seeded** `today` list rather than a live account, so the design can stay focused on the three flows. The connect screen is wireframed as step 1 because it is the production pattern; the seed list stands in for the connected account's read. A real deployment swaps the seed for `customerAuth`-brokered account reads/writes — the tool signatures and widget do not change.

**Edge cases at the boundary:** connection declined (app degrades to a read-only explanation, no writes attempted); token revoked mid-session (next write returns a re-connect prompt, never a silent failure); scope mismatch (write attempted without write scope → explicit "reconnect to allow changes").

---

## 10. Demo Scope Recommendation

**MVP (build these, defer the rest):** the three flows against the seeded list, in one `TaskList` widget — Capture (`add_task`), Prioritize (`list_today` + `set_priority`), Complete (`complete_task`).

**2-minute demo script:**
1. **0:00** — "What's on my plate today?" → `TaskList` renders the three seed tasks, highest priority first. *(grounded read)*
2. **0:25** — "Add 'draft the board update', high priority." → new row appears at the top instantly. *(capture)*
3. **0:50** — Open the PR review's priority `<select>`, set **high** → list re-orders. *(prioritize, in-widget)*
4. **1:15** — "I finished the vendor email — mark it done." → row strikes through, count 4 → 3. *(complete by voice)*
5. **1:40** — Check the last row in the widget → all-clear empty state + "capture tomorrow's first task?" *(close the loop)*

---

## 11. Technical Architecture (High Level)

- **Server:** one `server('acme_tasks', …)` in `src/server.ts` (Noodle Seed authoring SDK), four tools, `branding` tokens, per-tool CSP allowlist.
- **Widget:** `TaskList` (`src/views/task-list.tsx`), a React `view` using `useCallTool` / `useToolInfo` / `useLayout` / `useViewState`; local session state (`added` / `done` / `priority`) layered over the `list_today` read, each change recorded through a tool call.
- **State:** session-scoped in the flagship (seed list + local overlay). Production: `customerAuth`-brokered reads/writes to the account.
- **Validation loop:** `noodle validate` → `noodle test` → `noodle dev`; compliance via `noodle check --target chatgpt`.

---

## 12. Success Metrics

| Metric | Maps to |
| :--- | :--- |
| **Connect completion rate** | % of first-runs that finish the `customerAuth` consent (§9). |
| **In-chat write rate** | writes (`add_task` + `set_priority` + `complete_task`) per session — the core "work done in chat" signal. |
| **Capture-to-list latency** | time from utterance to the row appearing in `TaskList` (target < 1s optimistic). |
| **Completion rate** | % of read sessions that end with at least one `complete_task` — the retention-driving "closed the loop" event. |
| **Return frequency** | sessions per user per day — the habit metric a task app lives or dies on. |

**Attribution:** each tool call carries the connected account identity (server identity + tenant), so writes are traceable to the session without exposing the credential.

---

## 13. Future Enhancements (Post-Launch)

- **Live account** via `customerAuth` replacing the seed list (the natural first step out of the flagship).
- **Due dates & scheduling** ("email the vendor by Friday") once the model can be trusted to parse relative dates.
- **Bulk triage** ("move everything low to tomorrow") — a batched, previewed, reversible write.
- **Projects / grouping** beyond a single flat list, once the single-list flows are proven.
- **Undo** as a first-class in-chat verb for every write.

---

## Appendix — Two-Way Scope Cheat-Sheet

| User request | In chat (in-app) | Off-app |
| :--- | :---: | :---: |
| "What's on my list?" | ✓ `list_today` → `TaskList` | — |
| "Add a task…" | ✓ `add_task` | — |
| "Make X high priority" | ✓ `set_priority` | — |
| "Mark X done" | ✓ `complete_task` | — |
| First-run account link | — | ✓ `customerAuth` consent (once, scoped, revocable) |
| Anything transactional | — | *(none — the app has no transactional off-app step)* |
