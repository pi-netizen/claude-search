import { readFile, readdir } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';

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
  sessionsDir = join(homedir(), '.claude', 'projects'),
  limit       = 20,
  project     = null,
  context     = 1,
  caseSensitive = false,
} = {}) {
  // Discover all session files
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

  for (const filePath of files) {
    const proj = projectName(sessionsDir, filePath);
    if (project && !proj.toLowerCase().includes(project.toLowerCase())) continue;

    let messages, records;
    try {
      ({ messages, records } = await loadMessages(filePath));
    } catch {
      continue; // skip unreadable/corrupt files
    }

    for (let i = 0; i < messages.length; i++) {
      const msg  = messages[i];
      const text = extractText(msg.message?.content);
      const haystack = caseSensitive ? text : text.toLowerCase();

      if (!haystack.includes(needle)) continue;

      matches.push({
        filePath,
        project:   proj,
        sessionId: basename(filePath, '.jsonl'),
        timestamp: msg.timestamp ?? records[0]?.timestamp,
        role:      msg.message?.role ?? msg.type,
        text,
        before:    messages.slice(Math.max(0, i - context), i),
        after:     messages.slice(i + 1, i + 1 + context),
      });
    }
  }

  // Newest matches first
  matches.sort((a, b) => {
    if (!a.timestamp && !b.timestamp) return 0;
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  printResults(matches.slice(0, limit), query, matches.length);
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

function printResults(matches, query, totalFound) {
  if (matches.length === 0) {
    console.log(chalk.yellow(`\nNo matches found for "${query}"`));
    return;
  }

  const extra = totalFound > matches.length ? chalk.dim(` — showing first ${matches.length}`) : '';
  console.log(chalk.dim(`\n${totalFound} match${totalFound === 1 ? '' : 'es'} found${extra}\n`));

  let lastFile = null;

  for (const m of matches) {
    // Print session header when entering a new file
    if (m.filePath !== lastFile) {
      const date = formatDate(m.timestamp);
      console.log(
        chalk.cyan.bold(m.project) +
        chalk.dim(`  ›  ${m.sessionId.slice(0, 8)}  ·  ${date}`)
      );
      console.log(chalk.dim('─'.repeat(70)));
      lastFile = m.filePath;
    }

    for (const ctx of m.before) printCtxMsg(ctx);
    printMatchMsg(m.role, m.text, query);
    for (const ctx of m.after) printCtxMsg(ctx);
    console.log(chalk.dim('  ' + '╌'.repeat(34)));
  }

  console.log('');
}
