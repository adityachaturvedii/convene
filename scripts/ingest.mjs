#!/usr/bin/env node
// scripts/ingest.mjs
// Zero-dependency ingest worker for poll/vote repository_dispatch events.
// Runs on the 'poll-data' branch checkout. Reads the dispatch client_payload
// from the POLL_PAYLOAD env var (JSON), mutates the on-disk JSON "database",
// and exits 0 on success. Non-zero exit ONLY on malformed input so the
// workflow can surface real errors while ignoring benign no-ops.
//
// Uses only the Node standard library: node:crypto, node:fs, node:path.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const POLLS_DIR = join(ROOT, 'polls');

// Path component safety: a pollId / rosterId must be slug-safe. This prevents
// path traversal ('..', '/') and any other surprising filesystem behaviour.
const ID_RE = /^[A-Za-z0-9_-]+$/;

function fail(msg) {
  console.error(`[ingest] ERROR: ${msg}`);
  process.exit(1);
}

function isValidId(id) {
  return typeof id === 'string' && id.length > 0 && ID_RE.test(id);
}

// lowercase hex SHA-256 of a UTF-8 string — must match the in-browser
// crypto.subtle.digest('SHA-256', utf8Bytes) computation exactly.
function sha256hex(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`could not parse JSON at ${file}: ${e.message}`);
  }
}

function writeJson(file, obj) {
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function nowIso() {
  // ISO-8601 UTC timestamp string, e.g. 2026-06-27T12:34:56.789Z
  return new Date().toISOString();
}

function slugifyName(name) {
  const slug = String(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'guest'; // MUST match the fallback in slugify() in index.html
}

const ANSWERS = new Set(['yes', 'maybe', 'no']);

// ---------------------------------------------------------------------------
// load payload
// ---------------------------------------------------------------------------

const raw = process.env.POLL_PAYLOAD;
if (!raw || !raw.trim()) {
  fail('POLL_PAYLOAD env var is empty');
}

let payload;
try {
  payload = JSON.parse(raw);
} catch (e) {
  fail(`POLL_PAYLOAD is not valid JSON: ${e.message}`);
}

if (!payload || typeof payload !== 'object') {
  fail('payload is not an object');
}

const op = payload.op;
if (typeof op !== 'string') {
  fail('payload.op missing or not a string');
}

// ---------------------------------------------------------------------------
// ops
// ---------------------------------------------------------------------------

function pollDir(pollId) {
  return join(POLLS_DIR, pollId);
}
function pollJsonPath(pollId) {
  return join(pollDir(pollId), 'poll.json');
}
function votesJsonPath(pollId) {
  return join(pollDir(pollId), 'votes.json');
}

function opSavePoll() {
  const poll = payload.poll;
  if (!poll || typeof poll !== 'object') {
    fail('save-poll: payload.poll missing or not an object');
  }
  if (!isValidId(poll.id)) {
    fail(`save-poll: poll.id missing or not slug-safe: ${JSON.stringify(poll.id)}`);
  }

  // Validate required top-level fields.
  const required = [
    'title',
    'meetingDateISO',
    'refTz',
    'weekday',
    'duration',
    'zones',
    'roster',
    'slots',
  ];
  for (const k of required) {
    if (!(k in poll)) {
      fail(`save-poll: poll.${k} is required`);
    }
  }
  if (!Array.isArray(poll.zones)) fail('save-poll: poll.zones must be an array');
  if (!Array.isArray(poll.roster)) fail('save-poll: poll.roster must be an array');
  if (!Array.isArray(poll.slots)) fail('save-poll: poll.slots must be an array');

  // Roster entries must carry a tokenHash and never a raw token / email.
  for (const r of poll.roster) {
    if (!r || typeof r !== 'object') {
      fail('save-poll: each roster entry must be an object');
    }
    if (!isValidId(r.rosterId)) {
      fail(`save-poll: roster entry has invalid rosterId: ${JSON.stringify(r.rosterId)}`);
    }
    if ('token' in r) {
      fail('save-poll: roster entry must NOT contain a raw token');
    }
    if ('email' in r) {
      fail('save-poll: roster entry must NOT contain an email');
    }
  }

  const dir = pollDir(poll.id);
  mkdirSync(dir, { recursive: true });

  // Write poll.json verbatim (the save-poll 'poll' object).
  writeJson(pollJsonPath(poll.id), poll);

  // Initialize an empty votes.json if absent (never clobber existing votes).
  const vpath = votesJsonPath(poll.id);
  const createdVotes = !existsSync(vpath);
  if (createdVotes) {
    writeJson(vpath, {});
  }

  console.log(
    `[ingest] save-poll: wrote polls/${poll.id}/poll.json ` +
      `(${poll.roster.length} roster, ${poll.slots.length} slots)` +
      (createdVotes ? ' + empty votes.json' : ''),
  );
}

function opCastVote() {
  const pollId = payload.pollId;
  if (!isValidId(pollId)) {
    fail(`cast-vote: pollId missing or not slug-safe: ${JSON.stringify(pollId)}`);
  }

  const ppath = pollJsonPath(pollId);
  if (!existsSync(ppath)) {
    fail(`cast-vote: poll ${pollId} does not exist`);
  }
  const poll = readJson(ppath, null);
  if (!poll || typeof poll !== 'object') {
    fail(`cast-vote: poll.json for ${pollId} is invalid`);
  }

  const guest = payload.guest === true;
  const name = payload.name;
  if (typeof name !== 'string' || !name.trim()) {
    fail('cast-vote: name is required');
  }

  const zoneId = payload.zoneId ?? null;

  // Validate responses: every value yes|maybe|no, every slotId real.
  const responses = payload.responses;
  if (!responses || typeof responses !== 'object' || Array.isArray(responses)) {
    fail('cast-vote: responses must be an object');
  }
  const slotIds = new Set((poll.slots || []).map((s) => s && s.id));
  for (const [slotId, answer] of Object.entries(responses)) {
    if (!slotIds.has(slotId)) {
      fail(`cast-vote: unknown slotId in responses: ${slotId}`);
    }
    if (!ANSWERS.has(answer)) {
      fail(`cast-vote: invalid answer "${answer}" for slot ${slotId}`);
    }
  }

  let voterKey;
  if (guest) {
    // Guest fallback: skip token check, store separately under guest:<slug>.
    voterKey = `guest:${slugifyName(name)}`;
  } else {
    const rosterId = payload.rosterId;
    if (!isValidId(rosterId)) {
      fail(`cast-vote: non-guest vote requires a slug-safe rosterId: ${JSON.stringify(rosterId)}`);
    }
    const entry = (poll.roster || []).find((r) => r && r.rosterId === rosterId);
    if (!entry) {
      fail(`cast-vote: rosterId ${rosterId} not in poll roster`);
    }
    const token = payload.token;
    if (typeof token !== 'string' || !token) {
      fail('cast-vote: non-guest vote requires a token');
    }
    const computed = sha256hex(token);
    if (computed !== entry.tokenHash) {
      fail(`cast-vote: token hash mismatch for rosterId ${rosterId}`);
    }
    voterKey = rosterId;
  }

  // Read-modify-write upsert of exactly this voter's entry.
  const vpath = votesJsonPath(pollId);
  const votes = readJson(vpath, {});

  votes[voterKey] = {
    name,
    zoneId,
    responses,
    guest,
    updatedAt: nowIso(),
  };

  writeJson(vpath, votes);

  console.log(
    `[ingest] cast-vote: upserted voter "${voterKey}" in polls/${pollId}/votes.json ` +
      `(${Object.keys(responses).length} responses, guest=${guest})`,
  );
}

function opDeletePoll() {
  const pollId = payload.pollId;
  if (!isValidId(pollId)) {
    fail(`delete-poll: pollId missing or not slug-safe: ${JSON.stringify(pollId)}`);
  }
  const dir = pollDir(pollId);
  if (!existsSync(dir)) {
    // Nothing to do — clean no-op.
    console.log(`[ingest] delete-poll: polls/${pollId} did not exist (no-op)`);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(`[ingest] delete-poll: removed polls/${pollId}/`);
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

switch (op) {
  case 'save-poll':
    opSavePoll();
    break;
  case 'cast-vote':
    opCastVote();
    break;
  case 'delete-poll':
    opDeletePoll();
    break;
  default:
    fail(`unknown op: ${op}`);
}

process.exit(0);
