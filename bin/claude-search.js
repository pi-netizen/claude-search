#!/usr/bin/env node
import { program } from 'commander';
import { homedir } from 'os';
import { join } from 'path';
import { search, parseSince, sessionDetails } from '../src/search.js';

const DEFAULT_DIR = join(homedir(), '.claude', 'projects');

// ── session subcommand ──────────────────────────────────────────────────────

program
  .command('session <id>')
  .description('Show details for a specific session and how to resume it')
  .option('-d, --dir <path>', 'Sessions directory', DEFAULT_DIR)
  .action(async (id, opts) => {
    await sessionDetails(id, { sessionsDir: opts.dir });
  });

// ── search (default) ────────────────────────────────────────────────────────

program
  .name('claude-search')
  .description('Search across all your Claude Code session history')
  .argument('[query]', 'Text to search for')
  .option('-d, --dir <path>',     'Sessions directory to search', DEFAULT_DIR)
  .option('-l, --limit <n>',      'Max matches to show', '20')
  .option('-p, --project <name>', 'Filter by project name (partial match)')
  .option('-C, --context <n>',    'Context messages around each match', '1')
  .option('-s, --case-sensitive', 'Case-sensitive search')
  .option('--since <when>',       'Only sessions after this date (e.g. "2 weeks ago", "2024-01-15")')
  .option('--code-only',          'Only show code blocks containing the match')
  .option('--reasoning',          'Show AI reasoning/thinking lines around the match')
  .option('--open',               'Open the first matching session in Claude Code')
  .action(async (query, opts) => {
    if (!query) {
      program.help();
    }

    let since = null;
    if (opts.since) {
      try {
        since = parseSince(opts.since);
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    }

    await search(query, {
      sessionsDir:   opts.dir,
      limit:         parseInt(opts.limit, 10),
      project:       opts.project ?? null,
      context:       parseInt(opts.context, 10),
      caseSensitive: opts.caseSensitive ?? false,
      since,
      codeOnly:      opts.codeOnly ?? false,
      showReasoning: opts.reasoning ?? false,
      open:          opts.open ?? false,
    });
  });

program.parse();
