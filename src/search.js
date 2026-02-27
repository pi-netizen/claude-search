import { readFile, readdir, access } from 'fs/promises';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';

const execFileAsync = promisify(execFile);

// ── helpers ────────────────────────────────────────────────────────────────

export function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
    .trim();
}

/**
 * Extract fenced code blocks from message content.
 * Returns array of { lang, code } objects.
 */
export function extractCodeBlocks(content) {
  const text = extractText(content);
  const blocks = [];
  const fence = /```(\w*)\n([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(text)) !== null) {
    blocks.push({ lang: m[1] || 'text', code: m[2].trimEnd() });
  }
  return blocks;
}

/**
 * Convert a project directory slug back to a readable name.
 * e.g. "-Users-piyushk-toptal-maestro" → "toptal-maestro"
 */
export function projectName(sessionsDir, filePath) {
  const rel = filePath.slice(sessionsDir.length + 1);
  const dir = rel.split('/')[0];
  const homePrefix = '-' + homedir().slice(1).replace(/\//g, '-') + '-';
  return dir.startsWith(homePrefix) ? dir.slice(homePrefix.length) : dir;
}

/**
 * Try to resolve the git remote URL for a project directory slug.
 *
 * Slugs are absolute paths with every '/' replaced by '-', e.g.:
 *   "-Users-piyushk-Projects-my-app"  →  /Users/piyushk/Projects/my-app
 *
 * The ambiguity: we can't tell a path separator from a literal hyphen in a
 * directory name.  Strategy: strip the known home-dir prefix, then walk the
 * remaining slug character-by-character, checking each possible split against
 * the real filesystem.  First existing directory wins.
 */
async function resolveGitRemote(sessionsDir, filePath) {
  const rel  = filePath.slice(sessionsDir.length + 1);
  const slug = rel.split('/')[0];
  const home = homedir();

  // The slug starts with the home dir encoded as '-Users-name-...-'
  const homeSlug = home.slice(1).replace(/\//g, '-'); // e.g. 'Users/piyushk' → 'Users-piyushk'
  const prefix   = '-' + homeSlug + '-';

  if (!slug.startsWith(prefix)) return null;

  // Remainder after the home prefix: e.g. 'Projects-my-app'
  const remainder = slug.slice(prefix.length);
  const parts     = remainder.split('-');

  // Try every possible grouping of parts as path segments (greedy, depth-first).
  // For 'Projects-my-app': try ['Projects/my-app'], ['Projects', 'my-app'], etc.
  const candidate = await findExistingPath(home, parts);
  if (!candidate) return null;

  try {
    await access(join(candidate, '.git'));
    const { stdout } = await execFileAsync('git', [
      '-C', candidate, 'remote', 'get-url', 'origin',
    ], { timeout: 2000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Given a base directory and an array of slug parts (split on '-'),
 * reconstruct the real filesystem path by trying all ways to group
 * consecutive parts into a single directory name.
 *
 * Returns the first path (deepest match) that exists on disk, or null.
 */
async function findExistingPath(base, parts) {
  if (parts.length === 0) return base;

  // Build progressively longer first-segment candidates
  for (let take = 1; take <= parts.length; take++) {
    const segment   = parts.slice(0, take).join('-');
    const candidate = join(base, segment);

    let exists = false;
    try { await access(candidate); exists = true; } catch { /* noop */ }

    if (exists) {
      // Recurse into the remaining parts
      const deeper = await findExistingPath(candidate, parts.slice(take));
      if (deeper !== null) return deeper;
    }
  }
  return null;
}

/**
 * Parse a human-friendly "since" string into a Date.
 * Supports: "2 weeks ago", "3 days ago", "1 month ago", "2024-01-15"
 */
export function parseSince(since) {
  if (!since) return null;

  // ISO / locale date literal
  const asDate = new Date(since);
  if (!isNaN(asDate.getTime()) && since.includes('-')) return asDate;

  // "N unit ago"
  const relative = since.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i);
  if (!relative) throw new Error(`Cannot parse --since value: "${since}"`);

  const [, n, unit] = relative;
  const now = new Date();
  const amount = parseInt(n, 10);
  const u = unit.toLowerCase();

  if (u === 'second') now.setSeconds(now.getSeconds() - amount);
  else if (u === 'minute') now.setMinutes(now.getMinutes() - amount);
  else if (u === 'hour')   now.setHours(now.getHours() - amount);
  else if (u === 'day')    now.setDate(now.getDate() - amount);
  else if (u === 'week')   now.setDate(now.getDate() - amount * 7);
  else if (u === 'month')  now.setMonth(now.getMonth() - amount);
  else if (u === 'year')   now.setFullYear(now.getFullYear() - amount);

  return now;
}

/**
 * Return a short snippet of `text` centred around the first occurrence
 * of `query`, with ellipses where text was trimmed.
 */
function snippet(text, query, radius = 120) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end   = Math.min(text.length, idx + query.length + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

/** Wrap every case-insensitive occurrence of query in yellow bold. */
function highlight(text, query) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'gi'), (m) => chalk.yellow.bold(m));
}

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

// ── reasoning extraction ───────────────────────────────────────────────────

/**
 * Extract lines around the match from a thinking/reasoning block.
 * Claude session records sometimes contain { type: 'thinking', thinking: '...' }
 * content blocks. We grab `lineContext` lines before+after the query hit.
 */
function extractReasoningSnippet(content, query, lineContext = 3) {
  if (!Array.isArray(content)) return null;

  const thinkingBlock = content.find((b) => b.type === 'thinking' && b.thinking);
  if (!thinkingBlock) return null;

  const lines = thinkingBlock.thinking.split('\n');
  const needle = query.toLowerCase();
  const hitIdx = lines.findIndex((l) => l.toLowerCase().includes(needle));
  if (hitIdx === -1) return null;

  const from = Math.max(0, hitIdx - lineContext);
  const to   = Math.min(lines.length - 1, hitIdx + lineContext);
  const slice = lines.slice(from, to + 1);

  return {
    lines:  slice,
    hitLine: hitIdx - from,
    trimmedTop: from > 0,
    trimmedBottom: to < lines.length - 1,
  };
}

// ── file loading ───────────────────────────────────────────────────────────

export async function loadMessages(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const records = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // skip corrupt / truncated lines (common when Claude crashes mid-write)
    }
  }
  return {
    records,
    messages: records.filter((r) => r.type === 'user' || r.type === 'assistant'),
  };
}

/**
 * Find a session file by its ID (UUID filename without .jsonl).
 * Searches recursively under sessionsDir.
 */
async function findSessionFile(sessionsDir, sessionId) {
  const entries = await readdir(sessionsDir, { recursive: true });
  const rel = entries.find((e) => e === `${sessionId}.jsonl` || e.endsWith(`/${sessionId}.jsonl`));
  return rel ? join(sessionsDir, rel) : null;
}

// ── session details ────────────────────────────────────────────────────────

export async function sessionDetails(sessionId, {
  sessionsDir = join(homedir(), '.claude', 'projects'),
} = {}) {
  const filePath = await findSessionFile(sessionsDir, sessionId);
  if (!filePath) {
    console.error(chalk.red(`Session not found: ${sessionId}`));
    process.exit(1);
  }

  const { records, messages } = await loadMessages(filePath);
  const proj       = projectName(sessionsDir, filePath);
  const firstTs    = records[0]?.timestamp;
  const lastTs     = records[records.length - 1]?.timestamp;
  const userMsgs   = messages.filter((m) => (m.message?.role ?? m.type) === 'user');
  const asstMsgs   = messages.filter((m) => (m.message?.role ?? m.type) === 'assistant');
  const firstPrompt = extractText(userMsgs[0]?.message?.content ?? '');
  const lastPrompt  = extractText(userMsgs[userMsgs.length - 1]?.message?.content ?? '');
  const gitRemote   = await resolveGitRemote(sessionsDir, filePath);

  console.log('\n' + chalk.cyan.bold(proj));
  if (gitRemote) console.log(chalk.dim(`  repo    `) + gitRemote.replace(/\.git$/, ''));
  console.log(chalk.dim(`  session `) + sessionId);
  console.log(chalk.dim(`  file    `) + filePath);
  console.log(chalk.dim(`  started `) + formatDate(firstTs) + (firstTs ? chalk.dim(` at ${new Date(firstTs).toLocaleTimeString()}`) : ''));
  console.log(chalk.dim(`  ended   `) + formatDate(lastTs)  + (lastTs  ? chalk.dim(` at ${new Date(lastTs).toLocaleTimeString()}`)  : ''));
  console.log(chalk.dim(`  turns   `) + `${userMsgs.length} user  ·  ${asstMsgs.length} assistant  ·  ${records.length} total records`);
  console.log(chalk.dim(`  resume  `) + chalk.yellow(`claude --resume ${sessionId}`));

  if (firstPrompt) {
    console.log('\n' + chalk.dim('── first prompt ') + chalk.dim('─'.repeat(53)));
    console.log('  ' + firstPrompt.slice(0, 300) + (firstPrompt.length > 300 ? '…' : ''));
  }
  if (lastPrompt && lastPrompt !== firstPrompt) {
    console.log('\n' + chalk.dim('── last prompt ') + chalk.dim('─'.repeat(54)));
    console.log('  ' + lastPrompt.slice(0, 300) + (lastPrompt.length > 300 ? '…' : ''));
  }
  console.log('');
}

// ── core search ────────────────────────────────────────────────────────────

export async function search(query, {
  sessionsDir   = join(homedir(), '.claude', 'projects'),
  limit         = 20,
  project       = null,
  context       = 1,
  caseSensitive = false,
  since         = null,    // Date | null
  codeOnly      = false,   // boolean
  showReasoning = false,   // boolean
  open          = false,   // boolean — launch first match in claude
} = {}) {
  let entries;
  try {
    entries = await readdir(sessionsDir, { recursive: true });
  } catch {
    console.error(`Cannot read sessions directory: ${sessionsDir}`);
    process.exit(1);
  }
  const files = entries.filter((e) => e.endsWith('.jsonl')).map((e) => join(sessionsDir, e));
  process.stderr.write(chalk.dim(`Scanning ${files.length} session files…\n`));

  const needle = caseSensitive ? query : query.toLowerCase();
  const matches = [];

  // Cache git remotes per project dir — keyed by dir, resolved lazily once.
  const remoteCache = new Map();

  // Scan files in parallel with a concurrency cap to avoid fd exhaustion.
  const CONCURRENCY = 20;
  const queue = [...files];

  async function worker() {
    while (queue.length > 0) {
      const filePath = queue.shift();
      const proj = projectName(sessionsDir, filePath);
      if (project && !proj.toLowerCase().includes(project.toLowerCase())) continue;

      let messages, records;
      try {
        ({ messages, records } = await loadMessages(filePath));
      } catch {
        continue;
      }

      // ── temporal filter ────────────────────────────────────────────────
      const sessionTs = records[0]?.timestamp;
      if (since && sessionTs && new Date(sessionTs) < since) continue;

      // ── project scoping: resolve git remote once per project dir ───────
      const projDir = dirname(filePath);
      if (!remoteCache.has(projDir)) {
        remoteCache.set(projDir, resolveGitRemote(sessionsDir, filePath));
      }
      const gitRemote = await remoteCache.get(projDir);

      for (let i = 0; i < messages.length; i++) {
        const msg     = messages[i];
        const content = msg.message?.content;
        const text    = extractText(content);
        const haystack = caseSensitive ? text : text.toLowerCase();

        if (!haystack.includes(needle)) continue;

        // ── code-only filter ─────────────────────────────────────────────
        const codeBlocks = extractCodeBlocks(content);
        if (codeOnly) {
          const codeMatches = codeBlocks.filter((b) => {
            const h = caseSensitive ? b.code : b.code.toLowerCase();
            return h.includes(needle);
          });
          if (codeMatches.length === 0) continue;
        }

        // ── reasoning snapshot ───────────────────────────────────────────
        const reasoning = showReasoning
          ? extractReasoningSnippet(content, query)
          : null;

        matches.push({
          filePath,
          project:    proj,
          gitRemote,
          sessionId:  basename(filePath, '.jsonl'),
          timestamp:  msg.timestamp ?? sessionTs,
          role:       msg.message?.role ?? msg.type,
          text,
          codeBlocks,
          reasoning,
          before: messages.slice(Math.max(0, i - context), i),
          after:  messages.slice(i + 1, i + 1 + context),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  matches.sort((a, b) => {
    if (!a.timestamp && !b.timestamp) return 0;
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  const displayed = matches.slice(0, limit);
  printResults(displayed, query, matches.length, { codeOnly, showReasoning });

  // ── --open: launch first match in Claude Code ────────────────────────────
  if (open && displayed.length > 0) {
    const firstId = displayed[0].sessionId;
    console.log(chalk.dim(`Opening session ${firstId.slice(0, 8)}… (claude --resume ${firstId})\n`));
    try {
      const { spawn } = await import('child_process');
      spawn('claude', ['--resume', firstId], { stdio: 'inherit', detached: true }).unref();
    } catch {
      console.error(chalk.red('Could not launch claude. Make sure it is in your PATH.'));
    }
  }
}

// ── output formatting ──────────────────────────────────────────────────────

function printCtxMsg(msg) {
  const role  = msg.message?.role ?? msg.type;
  const label = role === 'assistant'
    ? chalk.dim('  Assistant  ')
    : chalk.dim('  User       ');
  const text  = extractText(msg.message?.content);
  console.log(label + chalk.dim(text.slice(0, 140) + (text.length > 140 ? '…' : '')));
}

function printMatchMsg(role, text, query) {
  const label = role === 'assistant'
    ? chalk.blue('  Assistant  ')
    : chalk.green('  User       ');
  console.log(label + highlight(snippet(text, query), query));
}

function printCodeBlocks(blocks, query) {
  for (const { lang, code } of blocks) {
    const header = chalk.magenta(`  ┌─ ${lang || 'code'} `);
    console.log(header);
    const lines = code.split('\n');
    for (const line of lines) {
      console.log(chalk.dim('  │ ') + highlight(line, query));
    }
    console.log(chalk.dim('  └' + '─'.repeat(36)));
  }
}

function printReasoning(reasoning) {
  if (!reasoning) return;
  if (reasoning.trimmedTop) console.log(chalk.dim('  ⋮ (reasoning truncated)'));
  for (let i = 0; i < reasoning.lines.length; i++) {
    const line = reasoning.lines[i];
    const isHit = i === reasoning.hitLine;
    const prefix = isHit ? chalk.yellow('  ▶ ') : chalk.dim('    ');
    console.log(prefix + chalk.dim(line.slice(0, 160) + (line.length > 160 ? '…' : '')));
  }
  if (reasoning.trimmedBottom) console.log(chalk.dim('  ⋮ (reasoning truncated)'));
}

function printResults(matches, query, totalFound, { codeOnly, showReasoning }) {
  if (matches.length === 0) {
    console.log(chalk.yellow(`\nNo matches found for "${query}"`));
    return;
  }

  const extra = totalFound > matches.length ? chalk.dim(` — showing first ${matches.length}`) : '';
  console.log(chalk.dim(`\n${totalFound} match${totalFound === 1 ? '' : 'es'} found${extra}\n`));

  let lastFile = null;

  for (const m of matches) {
    if (m.filePath !== lastFile) {
      const date = formatDate(m.timestamp);

      // ── project header with optional git remote ───────────────────────
      const remoteTag = m.gitRemote
        ? chalk.dim(`  [${m.gitRemote.replace(/^https?:\/\//, '').replace(/\.git$/, '')}]`)
        : '';
      const resumeHint = chalk.dim(`  · claude --resume ${m.sessionId}`);
      console.log(
        chalk.cyan.bold(m.project) +
        chalk.dim(`  ›  ${m.sessionId.slice(0, 8)}  ·  ${date}`) +
        remoteTag
      );
      console.log(resumeHint);
      console.log(chalk.dim('─'.repeat(70)));
      lastFile = m.filePath;
    }

    for (const ctx of m.before) printCtxMsg(ctx);

    if (codeOnly) {
      // Only print code blocks that contain the query
      const relevant = m.codeBlocks.filter((b) => {
        const h = b.code.toLowerCase();
        return h.includes(query.toLowerCase());
      });
      printCodeBlocks(relevant, query);
    } else {
      printMatchMsg(m.role, m.text, query);
      if (m.codeBlocks.length > 0) printCodeBlocks(m.codeBlocks, query);
    }

    if (showReasoning && m.reasoning) {
      console.log(chalk.dim('  · reasoning:'));
      printReasoning(m.reasoning);
    }

    for (const ctx of m.after) printCtxMsg(ctx);
    console.log(chalk.dim('  ' + '╌'.repeat(34)));
  }

  console.log('');
}
