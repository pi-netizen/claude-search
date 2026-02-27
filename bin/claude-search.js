#!/usr/bin/env node
import { program } from 'commander';
import { homedir } from 'os';
import { join } from 'path';
import { search } from '../src/search.js';

const DEFAULT_DIR = join(homedir(), '.claude', 'projects');

program
  .name('claude-search')
  .description('Search across all your Claude Code session history')
  .argument('<query>', 'Text to search for')
  .option('-d, --dir <path>', 'Sessions directory to search', DEFAULT_DIR)
  .option('-l, --limit <n>', 'Max matches to show', '20')
  .option('-p, --project <name>', 'Filter by project name (partial match)')
  .option('-C, --context <n>', 'Context messages around each match', '1')
  .option('-s, --case-sensitive', 'Case-sensitive search')
  .parse();

const [query] = program.args;
const opts = program.opts();

await search(query, {
  sessionsDir: opts.dir,
  limit: parseInt(opts.limit, 10),
  project: opts.project ?? null,
  context: parseInt(opts.context, 10),
  caseSensitive: opts.caseSensitive ?? false,
});
