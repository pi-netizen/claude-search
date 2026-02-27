# claude-search

Full-text search across all your [Claude Code](https://claude.ai/code) session history — find past conversations, extract code snippets, inspect session metadata, and jump straight back into any session.

```
claude-search "redis connection error" --since "2 weeks ago"
```

---

## How it works

Claude Code stores every conversation as a `.jsonl` file under `~/.claude/projects/`. Each line is a JSON record — a user message, assistant reply, tool call, or metadata event. `claude-search` reads those files directly, no server required.

---

## Requirements

- Node.js 18+
- Claude Code CLI installed (`claude` in your PATH)

---

## Installation

```bash
git clone https://github.com/pi-netizen/claude-search.git
cd claude-search
npm install
npm link        # makes `claude-search` available globally
```

> **Permission error on `npm link`?** Run this once to fix it:
> ```bash
> mkdir -p ~/.npm-global
> npm config set prefix '~/.npm-global'
> echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
> source ~/.zshrc
> ```

Verify it works:

```bash
claude-search --help
```

---

## User Journeys

### 1. "I remember solving this problem — where did I do it?"

You recall discussing a tricky bug but can't remember which project or session.

```bash
claude-search "segmentation fault"
```

Output groups matches by session, newest first, with the project name and date:

```
myapp  ›  a1b2c3d4  ·  Feb 20, 2026
  · claude --resume a1b2c3d4-...full-uuid...
──────────────────────────────────────────────────────────
  User       what's causing this segmentation fault in the C extension?
  Assistant  The issue is a dangling pointer in line 42 of ext.c — you're
             freeing `buf` before the callback fires…
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
```

Each session header includes the exact `claude --resume` command — copy it to jump straight back in.

---

### 2. "Find code I wrote for this, not just the discussion"

You want the actual implementation, not surrounding chat.

```bash
claude-search "rate limiter" --code-only
```

Only messages whose fenced code blocks contain the query are shown, rendered with language labels:

```
api-service  ›  f3e2d1c0  ·  Feb 18, 2026
  · claude --resume f3e2d1c0-...
──────────────────────────────────────────────────────────
  ┌─ python
  │ class RateLimiter:
  │     def __init__(self, max_calls, period):
  │         self.calls = deque()
  │         self.max_calls = max_calls
  │         self.period = period
  └──────────────────────────────────────
```

---

### 3. "Only show me recent sessions — I don't need old noise"

Your search returns 40 matches. Most are from months ago and irrelevant.

```bash
claude-search "authentication" --since "2 weeks ago" --limit 10
```

`--since` accepts natural language or ISO dates:

| Value | Meaning |
|---|---|
| `"3 days ago"` | Last 3 days |
| `"1 week ago"` | Last 7 days |
| `"2 months ago"` | Last ~60 days |
| `"2024-01-15"` | On or after Jan 15 2024 |

---

### 4. "I want to jump straight back into that session"

You find the session you were looking for and want to resume it immediately.

```bash
claude-search "docker compose" --open
```

Shows search results as normal, then automatically runs `claude --resume <session-id>` on the top match, opening it in your terminal.

Or use the resume command printed under every session header:

```bash
claude --resume a1b2c3d4-3307-4fc4-992a-42ba0ca49246
```

---

### 5. "Give me a summary of what happened in that session"

You have a session ID (from search results or `~/.claude/projects/`) and want metadata before deciding whether to resume.

```bash
claude-search session a1b2c3d4-3307-4fc4-992a-42ba0ca49246
```

```
myapp
  repo    github.com/you/myapp
  session a1b2c3d4-3307-4fc4-992a-42ba0ca49246
  file    ~/.claude/projects/-Users-you-myapp/a1b2c3d4-....jsonl
  started Feb 20, 2026 at 9:12:04 AM
  ended   Feb 20, 2026 at 11:45:30 AM
  turns   42 user  ·  43 assistant  ·  187 total records
  resume  claude --resume a1b2c3d4-3307-4fc4-992a-42ba0ca49246

── first prompt ─────────────────────────────────────────────────────
  Help me debug the rate limiter — it's allowing twice the configured
  requests per second under load…

── last prompt ──────────────────────────────────────────────────────
  Great, now write tests for the token bucket implementation.
```

---

### 6. "Search only within a specific project"

```bash
claude-search "migration" --project myapp
```

`--project` does a partial, case-insensitive match on the directory name Claude Code uses for that project.

---

### 7. "Show me more surrounding context"

By default, 1 message before and after each match is shown. Increase it:

```bash
claude-search "the fix" --context 3
```

---

### 8. "Was this AI reasoning correct? Show me its thinking"

When Claude uses extended thinking, reasoning blocks are stored in the session. Surface them:

```bash
claude-search "O(n²)" --reasoning
```

Shows up to 3 lines of the thinking block before and after the matched line, with the hit line highlighted with `▶`.

---

## All Options

```
claude-search [options] <query>
claude-search session <session-id>
```

### Search options

| Flag | Default | Description |
|---|---|---|
| `-d, --dir <path>` | `~/.claude/projects` | Sessions directory to search |
| `-l, --limit <n>` | `20` | Max matches to show |
| `-p, --project <name>` | — | Filter by project name (partial match) |
| `-C, --context <n>` | `1` | Context messages around each match |
| `-s, --case-sensitive` | `false` | Case-sensitive search |
| `--since <when>` | — | Only sessions after this date |
| `--code-only` | `false` | Only show code blocks containing the match |
| `--reasoning` | `false` | Show AI reasoning/thinking around the match |
| `--open` | `false` | Open the top matching session in Claude Code |

### Subcommands

| Command | Description |
|---|---|
| `session <id>` | Show metadata and first/last prompts for a session |

---

## Output anatomy

```
myapp  ›  a1b2c3d4  ·  Feb 20, 2026  [github.com/you/myapp]
  · claude --resume a1b2c3d4-3307-4fc4-992a-42ba0ca49246
──────────────────────────────────────────────────────────────────────
  User       (context message before the match)
  Assistant  …matched text with the query highlighted…
  ┌─ typescript
  │ // code block found in that message
  └────────────────────────────────────
  User       (context message after the match)
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
```

- **Project name** — decoded from Claude's directory slug
- **Session ID** — first 8 chars shown in header; full UUID in the resume command
- **Git remote** — auto-detected if the project directory is a git repo
- **Resume command** — printed under every session header; paste directly into your terminal

---

## License

MIT
