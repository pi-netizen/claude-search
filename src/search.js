import { readFile, readdir, access } from 'fs/promises';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';

const execFileAsync = promisify(execFile);

// ── helpers ────────────────────────────────────────────────────────────────

function extractText(content) {
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
function extractCodeBlocks(content) {
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
function projectName(sessionsDir, filePath) {
  const rel = filePath.slice(sessionsDir.length + 1);
  const dir = rel.split('/')[0];
  const homePrefix = '-' + homedir().slice(1).replace(/\//g, '-') + '-';
  return dir.startsWith(homePrefix) ? dir.slice(homePrefix.length) : dir;
}

/**
 * Convert the project slug back to the filesystem path it encodes.
 * e.g. "-Users-piyushk-Projects-myapp" → "/Users/piyushk/Projects/myapp"
 */
function slugToPath(dir) {
  // Slugs replace '/' with '-'; they start with '-' because the path
  // starts with '/'. Re-join by replacing '-' with '/' carefully:
  // only the first char is a guaranteed separator.
  return dir.replace(/-/g, '/');
}

/**
 * Try to resolve the git remote URL for a project directory slug.
 * Returns the remote URL string, or null if the directory isn't a git repo.
 */
async function resolveGitRemote(sessionsDir, filePath) {
  const rel = filePath.slice(sessionsDir.length + 1);
  const slug = rel.split('/')[0];
  const repoPath = slugToPath(slug);

  try {
    await access(join(repoPath, '.git'));
    const { stdout } = await execFileAsync('git', [
      '-C', repoPath, 'remote', 'get-url', 'origin',
    ], { timeout: 2000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
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

async function loadMessages(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const records = raw.split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return {
    records,
    messages: records.filter((r) => r.type === 'user' || r.type === 'assistant'),
  };
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

  // Cache git remotes per project dir to avoid repeated git calls
  const remoteCache = new Map();

  for (const filePath of files) {
    const proj = projectName(sessionsDir, filePath);
    if (project && !proj.toLowerCase().includes(project.toLowerCase())) continue;

    let messages, records;
    try {
      ({ messages, records } = await loadMessages(filePath));
    } catch {
      continue;
    }

    // ── temporal filter ──────────────────────────────────────────────────
    const sessionTs = records[0]?.timestamp;
    if (since && sessionTs && new Date(sessionTs) < since) continue;

    // ── project scoping: resolve git remote once per project dir ─────────
    const projDir = dirname(filePath);
    if (!remoteCache.has(projDir)) {
      remoteCache.set(projDir, await resolveGitRemote(sessionsDir, filePath));
    }
    const gitRemote = remoteCache.get(projDir);

    for (let i = 0; i < messages.length; i++) {
      const msg     = messages[i];
      const content = msg.message?.content;
      const text    = extractText(content);
      const haystack = caseSensitive ? text : text.toLowerCase();

      if (!haystack.includes(needle)) continue;

      // ── code-only filter ───────────────────────────────────────────────
      const codeBlocks = extractCodeBlocks(content);
      if (codeOnly) {
        const codeMatches = codeBlocks.filter((b) => {
          const h = caseSensitive ? b.code : b.code.toLowerCase();
          return h.includes(needle);
        });
        if (codeMatches.length === 0) continue;
      }

      // ── reasoning snapshot ─────────────────────────────────────────────
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

  matches.sort((a, b) => {
    if (!a.timestamp && !b.timestamp) return 0;
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  printResults(matches.slice(0, limit), query, matches.length, { codeOnly, showReasoning });
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
      console.log(
        chalk.cyan.bold(m.project) +
        chalk.dim(`  ›  ${m.sessionId.slice(0, 8)}  ·  ${date}`) +
        remoteTag
      );
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
