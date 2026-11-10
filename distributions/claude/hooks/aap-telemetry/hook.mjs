#!/usr/bin/env node
// Elephant-Goldfish Model → Intelligence Hub telemetry hook (egm.telemetry.contract = 1).
//
//   node hook.mjs <sessionStart|userPromptSubmit|postToolUse|sessionEnd>   (event JSON on stdin)
//
// Runs as a Claude Code hook (hooks/hooks.json of this plugin, or the user
// settings the installer writes) or a GitHub Copilot hook (Copilot CLI and
// VS Code agent hooks, .github/hooks/aap-telemetry.json in a repository).
// It never blocks the agent: no output, always exit 0, 3 s network timeout.
//
// Sends OTLP/HTTP JSON logs to {OTEL_EXPORTER_OTLP_ENDPOINT}/v1/logs with the
// Authorization header of OTEL_EXPORTER_OTLP_HEADERS, which the Intelligence
// Hub IDE setup script already sets for Copilot and Claude Code (the dtl_
// token). Without them it does nothing. Opt out with AAP_EGM_TELEMETRY=off.
//
// Privacy: no prompt, path, file name or text leaves the machine. Sessions
// and design documents are SHA-256 hashes (with the repository) cut to 32 hex;
// skills and reviewers only when they are EGM catalog names; artifacts as a
// kind; a Goldfish review report as its count of findings per severity.

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_VERSION = '0.1.0';
const CONTRACT = 1;
const TIMEOUT_MS = 3000;
const OUTBOX_MAX = 1000;
const HOME = process.env.AAP_EGM_HOME || path.join(homedir(), '.aap-egm');
/** Review reports are read to count findings; larger files are not EGM reports. */
const MAX_REPORT_BYTES = 2 * 1024 * 1024;

const SKILLS = new Set(['egm-brainstorm', 'egm-draft', 'egm-review', 'egm-resolve', 'egm-review-loop', 'egm-bootstrap', 'egm-drift-report']);
const AGENTS = new Set([
  'egm-zoom-out', 'egm-comprehension', 'egm-design', 'egm-implementation-readiness', 'egm-structural', 'egm-style',
  'egm-codebase-details', 'egm-inventive-catalyst', 'egm-synthesizer', 'egm-bootstrap-orchestrator',
]);
// Persona file names (agents/<name>.md) other harnesses pass as the subagent.
const AGENT_ALIASES = {
  'design-critic': 'egm-design', 'zoom-out': 'egm-zoom-out', comprehension: 'egm-comprehension',
  'implementation-readiness': 'egm-implementation-readiness', structural: 'egm-structural', style: 'egm-style',
  'codebase-details': 'egm-codebase-details', 'inventive-catalyst': 'egm-inventive-catalyst', synthesizer: 'egm-synthesizer',
  'bootstrap-orchestrator': 'egm-bootstrap-orchestrator',
};
// File names EGM writes, as a kind. Nothing else is classified.
const FILE_KINDS = {
  'concepts_brief.md': 'concepts-brief',
  'discussion_summary.md': 'discussion-summary',
  'design_draft.md': 'design-draft',
  'zoom_out_report.md': 'reviewer-report',
  'intermediate_zoom_out_report.md': 'reviewer-report',
  'comprehension_report.md': 'reviewer-report',
  'critic_report.md': 'reviewer-report',
  'implementation_readiness_report.md': 'reviewer-report',
  'goldfish_review_report.md': 'review-report',
  'consolidated_review_report.md': 'review-report',
};

// ---------------------------------------------------------------------------

function quietly(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function sha(...parts) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

function readJson(file, fallback) {
  return quietly(() => JSON.parse(readFileSync(file, 'utf8')), fallback);
}

function writeJson(file, value) {
  quietly(() => {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, file);
  });
}

async function readStdin() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return quietly(() => JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'), {});
}

/** `export KEY='value'` lines of the Copilot env file the setup script writes on macOS and Linux. */
function shellEnv(file) {
  const out = {};
  const text = quietly(() => readFileSync(file, 'utf8'), '') ?? '';
  for (const line of text.split('\n')) {
    const m = /^\s*export\s+([A-Z_][A-Z0-9_]*)=(?:'([^']*)'|"([^"]*)"|(\S*))\s*$/.exec(line);
    if (m) out[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

/**
 * Endpoint and headers, from where the Intelligence Hub setup script puts them:
 * the environment, ~/.claude/settings.json (Claude Code) and
 * ~/.claude/aap-copilot-env.sh (Copilot on macOS/Linux).
 */
function exporterConfig() {
  const claudeDir = path.join(homedir(), '.claude');
  const settingsEnv = readJson(path.join(claudeDir, 'settings.json'), {})?.env ?? {};
  const copilotEnv = shellEnv(path.join(claudeDir, 'aap-copilot-env.sh'));
  const pick = (key) => process.env[key] || settingsEnv[key] || copilotEnv[key] || '';
  const endpoint = (pick('AAP_EGM_ENDPOINT') || pick('OTEL_EXPORTER_OTLP_ENDPOINT') || pick('COPILOT_OTEL_ENDPOINT')).replace(/\/+$/, '');
  const headers = {};
  for (const pair of pick('OTEL_EXPORTER_OTLP_HEADERS').split(',')) {
    const at = pair.indexOf('=');
    if (at > 0) headers[decodeURIComponent(pair.slice(0, at).trim())] = decodeURIComponent(pair.slice(at + 1).trim());
  }
  const auth = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? '';
  return endpoint && /^Bearer\s+dtl_/i.test(auth) ? { url: `${endpoint}/v1/logs`, auth } : null;
}

function gitRoot(cwd) {
  return quietly(() => execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(), null);
}

function repositoryOf(cwd) {
  const url = quietly(() => execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(), '');
  const m = /[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url ?? '');
  return m ? `${m[1]}/${m[2]}` : null;
}

function hostOf(input) {
  if (process.env.AAP_EGM_HOST) return process.env.AAP_EGM_HOST;
  if ('hook_event_name' in input || 'tool_name' in input || 'session_id' in input) {
    return process.env.VSCODE_PID || process.env.TERM_PROGRAM === 'vscode' ? 'vscode' : 'claude-code';
  }
  return 'copilot-cli';
}

/** The EGM plugin version, from the manifest next to this hook (plugin install) or none. */
function egmVersion() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const dir of [path.join(here, '..'), path.join(here, '..', '..')]) {
    for (const file of [path.join(dir, '.claude-plugin', 'plugin.json'), path.join(dir, 'plugin.json')]) {
      const manifest = readJson(file, null);
      if (manifest?.name === 'egm' && typeof manifest.version === 'string') return manifest.version;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// OTLP

function attr(key, value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number') return { key, value: { intValue: Math.max(0, Math.trunc(value)) } };
  return { key, value: { stringValue: String(value) } };
}

function record(eventName, sessionId, attrs) {
  return {
    timeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
    eventName,
    attributes: Object.entries({ 'egm.event.id': randomUUID(), 'egm.session.id': sessionId, ...attrs })
      .map(([k, v]) => attr(k, v))
      .filter(Boolean),
  };
}

function requestOf(records, resource) {
  return {
    resourceLogs: [
      {
        resource: { attributes: Object.entries(resource).map(([k, v]) => attr(k, v)).filter(Boolean) },
        scopeLogs: [{ scope: { name: 'avanade.egm', version: '1' }, logRecords: records }],
      },
    ],
  };
}

async function send(config, body) {
  const res = await fetch(config.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: config.auth },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // 4xx other than 429 will not get better on a retry: drop.
  return res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429);
}

/** Sends the new records plus whatever is queued; on failure everything goes back to the outbox. */
async function flush(config, resource, records) {
  const outbox = path.join(HOME, 'outbox.jsonl');
  const queued = quietly(() => readFileSync(outbox, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)), []);
  const all = [...queued, ...records].slice(-OUTBOX_MAX);
  if (all.length === 0) return;
  const ok = await send(config, requestOf(all, resource)).catch(() => false);
  quietly(() => {
    mkdirSync(HOME, { recursive: true });
    writeFileSync(outbox, ok ? '' : all.map((r) => JSON.stringify(r)).join('\n') + '\n');
  });
}

// ---------------------------------------------------------------------------
// Sessions (Copilot CLI sends no session id: one is kept per working folder).
// The session file also remembers which artifacts were already reported, so a
// design drafted section by section counts once per session.

function sessionFile(key) {
  return path.join(HOME, 'sessions', `${sha(key)}.json`);
}

function sessionOf(input, cwd, repository, start) {
  const external = typeof input.session_id === 'string' && input.session_id ? input.session_id : null;
  const file = sessionFile(external ?? cwd);
  const known = readJson(file, null);
  if (known?.id && !(start && !external)) return { ...known, file };
  const fresh = { id: sha(repository ?? cwd, external ?? randomUUID()), startedAt: Date.now(), seen: [] };
  writeJson(file, fresh);
  return { ...fresh, file };
}

function remember(session, key) {
  const seen = new Set(session.seen ?? []);
  if (seen.has(key)) return false;
  seen.add(key);
  const { file, ...rest } = session;
  writeJson(file, { ...rest, seen: [...seen].slice(-500) });
  session.seen = [...seen];
  return true;
}

// ---------------------------------------------------------------------------
// Names, artifacts, findings

function normalizeName(raw) {
  if (typeof raw !== 'string') return null;
  let name = raw.trim().toLowerCase().replace(/^\/+/, '');
  name = name.slice(name.lastIndexOf(':') + 1).replaceAll(/[.:_\s]+/g, '-');
  name = name.replace(/-agent-md$|-md$/, '');
  return /^[a-z0-9-]{1,80}$/.test(name) ? name : null;
}

function skillOf(raw) {
  const name = normalizeName(raw);
  return name && SKILLS.has(name) ? name : null;
}

function agentOf(raw) {
  const name = normalizeName(raw);
  const mapped = name ? (AGENT_ALIASES[name] ?? name) : null;
  return mapped && AGENTS.has(mapped) ? mapped : null;
}

/** `/egm:egm-review design.md` → egm-review. Only the command name is read; the prompt is never kept. */
function promptSkill(input) {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const m = /^\s*\/((?:egm:)?egm-[a-z-]+)/i.exec(prompt);
  return m ? skillOf(m[1]) : null;
}

function toolArgs(input) {
  const raw = input.toolArgs ?? input.tool_input ?? {};
  return typeof raw === 'string' ? quietly(() => JSON.parse(raw), {}) : raw;
}

function writtenPath(args) {
  for (const key of ['path', 'filePath', 'file_path', 'target_file', 'filename']) {
    if (typeof args?.[key] === 'string') return args[key];
  }
  return null;
}

function artifactKindOf(file) {
  const parts = file.replaceAll('\\', '/').split('/');
  const base = parts.at(-1) ?? '';
  if (FILE_KINDS[base]) return FILE_KINDS[base];
  if (/_DRIFT_REPORT\.md$/i.test(base)) return 'drift-report';
  const designs = parts.lastIndexOf('designs');
  if (designs > 0 && parts[designs - 1] === 'docs' && base.endsWith('.md')) return base === 'SITEMAP.md' ? 'sitemap' : 'design-doc';
  return null;
}

/** Findings of a synthesized report by severity ("### [Issue] - Severity: Blocker"); counts only. */
function findingsOf(file) {
  const text = quietly(() => {
    const data = readFileSync(file);
    return data.length > MAX_REPORT_BYTES ? '' : data.toString('utf8');
  }, '') ?? '';
  const counts = { blocker: 0, major: 0, nit: 0 };
  for (const m of text.matchAll(/Severity:\s*[*_`[]*\s*(Blocker|Major|Nit)\b/gi)) counts[m[1].toLowerCase()] += 1;
  return counts;
}

function artifactRecord(session, cwd, repository, file) {
  const kind = artifactKindOf(file);
  if (!kind) return null;
  const absolute = path.resolve(cwd, file);
  const root = gitRoot(path.dirname(absolute)) ?? cwd;
  const relative = path.relative(root, absolute).replaceAll('\\', '/');
  // One event per file and session: a draft written section by section, or a report edited while resolving, counts once.
  if (!remember(session, `${kind}:${relative}`)) return null;
  const attrs = { 'egm.artifact.kind': kind };
  if (kind === 'design-draft' || kind === 'design-doc') attrs['egm.doc.id'] = sha(repository ?? root, relative);
  if (kind === 'review-report' || kind === 'reviewer-report') {
    const findings = findingsOf(absolute);
    attrs['egm.findings.blocker'] = findings.blocker;
    attrs['egm.findings.major'] = findings.major;
    attrs['egm.findings.nit'] = findings.nit;
  }
  return record('egm.artifact.write', session.id, attrs);
}

// ---------------------------------------------------------------------------

async function main() {
  if ((process.env.AAP_EGM_TELEMETRY ?? '').toLowerCase() === 'off') return;
  const event = String(process.argv[2] ?? '').toLowerCase();
  const input = await readStdin();
  const config = exporterConfig();
  if (!config) return;

  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const repository = repositoryOf(cwd);
  const resource = {
    'service.name': 'egm-telemetry',
    'service.version': HOOK_VERSION,
    'egm.telemetry.contract': CONTRACT,
    'egm.version': egmVersion(),
    'egm.host': hostOf(input),
    'vcs.repository.name': repository,
  };
  const records = [];

  if (event === 'sessionstart') {
    const session = sessionOf(input, cwd, repository, true);
    records.push(record('egm.session.start', session.id, {}));
  } else if (event === 'sessionend' || event === 'stop') {
    const session = sessionOf(input, cwd, repository, false);
    const duration = session.startedAt ? Math.round((Date.now() - session.startedAt) / 1000) : null;
    const reason = ['complete', 'error', 'abort', 'timeout', 'user_exit'].includes(input.reason) ? input.reason : 'other';
    records.push(record('egm.session.end', session.id, { 'egm.session.duration_s': duration, 'egm.session.end_reason': reason }));
  } else if (event === 'userpromptsubmit' || event === 'userpromptsubmitted') {
    const skill = promptSkill(input);
    if (skill) records.push(record('egm.skill.invoke', sessionOf(input, cwd, repository, false).id, { 'egm.skill.name': skill }));
  } else if (event === 'posttooluse') {
    const session = sessionOf(input, cwd, repository, false);
    const args = toolArgs(input);
    const tool = String(input.toolName ?? input.tool_name ?? '').toLowerCase();
    if (tool === 'skill') {
      const skill = skillOf(args.skill ?? args.name);
      if (skill) records.push(record('egm.skill.invoke', session.id, { 'egm.skill.name': skill }));
    } else if (tool === 'task' || tool === 'agent' || tool === 'runsubagent') {
      const agent = agentOf(args.subagent_type ?? args.agent_type ?? args.agentName ?? args.agent);
      if (agent) records.push(record('egm.goldfish.invoke', session.id, { 'egm.agent.name': agent }));
    }
    const file = writtenPath(args);
    const artifact = file ? artifactRecord(session, cwd, repository, file) : null;
    if (artifact) records.push(artifact);
  }

  if (records.length > 0 || existsSync(path.join(HOME, 'outbox.jsonl'))) await flush(config, resource, records);
}

main()
  .catch((err) => quietly(() => appendFileSync(path.join(HOME, 'errors.log'), `${new Date().toISOString()} ${String(err?.message ?? err)}\n`)))
  .finally(() => process.exit(0));
