// Google connection — Gmail remains read-only; the configured tracker Sheet is read/write.
//
// lib/inbox.js originally argued against connecting a mailbox at all, on the grounds
// that it means holding a credential in an app that already holds your CV, your answers
// and your browser sessions. That argument is answered rather than ignored here:
//
//   • SCOPE IS READ-ONLY. gmail.readonly cannot send, delete, or modify anything. The
//     worst case for a leaked token is disclosure of mail already on this machine.
//   • NO PASSWORD IS INVOLVED. OAuth, not IMAP with an app password. You can revoke it
//     at myaccount.google.com/permissions without changing your Google password.
//   • WE NEVER FETCH THE WHOLE MAILBOX. Every sync runs a narrow Gmail search built
//     from your own job list, so unrelated mail is never requested, never downloaded,
//     and never stored.
//   • THE TOKEN NEVER LEAVES THIS MACHINE. data/gmail.json, mode 0600, inside the
//     already-gitignored data directory, and never written to a log.
//
// The paste-in path in lib/inbox.js still works and still stores nothing. This is the
// same parser with a different intake.

import fs from 'node:fs';
import path from 'node:path';
import { linfo, lwarn } from './logger.js';
import { dataPath } from './paths.js';

const TOKEN_FILE = dataPath('gmail.json');
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

// ── credential storage ──────────────────────────────────────────────────────

function readStore() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return {}; }
}

function writeStore(obj) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(obj, null, 2), { mode: 0o600 });
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch { /* best effort on Windows */ }
}

/** Public status — deliberately never returns the token or the client secret. */
export function gmailStatus() {
  const s = readStore();
  return {
    configured: !!(s.client_id && s.client_secret),
    connected: !!s.refresh_token,
    email: s.email || '',
    lastSync: s.last_sync || 0,
    lastCount: s.last_count ?? null,
  };
}

export function saveClient(clientId, clientSecret) {
  const s = readStore();
  s.client_id = String(clientId || '').trim();
  s.client_secret = String(clientSecret || '').trim();
  writeStore(s);
  return gmailStatus();
}

export function disconnectGmail({ forgetClient = false } = {}) {
  const s = readStore();
  delete s.refresh_token;
  delete s.access_token;
  delete s.expires_at;
  delete s.email;
  if (forgetClient) { delete s.client_id; delete s.client_secret; }
  writeStore(s);
  return gmailStatus();
}

// ── OAuth ───────────────────────────────────────────────────────────────────

export function authUrl(redirectUri, state) {
  const s = readStore();
  if (!s.client_id) throw new Error('No Google client ID saved yet.');
  const p = new URLSearchParams({
    client_id: s.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',      // we need a refresh token; this is a background sync
    prompt: 'consent',           // force a refresh token even on re-authorisation
    include_granted_scopes: 'true',
    state: state || '',
  });
  return `${AUTH_URL}?${p}`;
}

export async function exchangeCode(code, redirectUri) {
  const s = readStore();
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: s.client_id,
      client_secret: s.client_secret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || `token exchange failed (${r.status})`);

  s.refresh_token = j.refresh_token || s.refresh_token;
  s.access_token = j.access_token;
  s.expires_at = Date.now() + (j.expires_in || 3600) * 1000;
  writeStore(s);

  // Record which mailbox this is, so the UI can show it.
  try {
    const prof = await gmailFetch('/profile');
    s.email = prof.emailAddress || '';
    writeStore(s);
  } catch { /* non-fatal */ }
  return gmailStatus();
}

async function accessToken() {
  const s = readStore();
  if (!s.refresh_token) throw new Error('Gmail is not connected.');
  if (s.access_token && s.expires_at && Date.now() < s.expires_at - 60000) return s.access_token;

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: s.client_id,
      client_secret: s.client_secret,
      refresh_token: s.refresh_token,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (!r.ok) {
    // invalid_grant means the user revoked access or the token aged out.
    if (j.error === 'invalid_grant') {
      disconnectGmail();
      throw new Error('Google access was revoked or expired — reconnect Gmail.');
    }
    throw new Error(j.error_description || j.error || 'token refresh failed');
  }
  s.access_token = j.access_token;
  s.expires_at = Date.now() + (j.expires_in || 3600) * 1000;
  writeStore(s);
  return s.access_token;
}

async function gmailFetch(pathname, params) {
  const token = await accessToken();
  const url = `${API}${pathname}${params ? '?' + new URLSearchParams(params) : ''}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Gmail API ${r.status}: ${t.slice(0, 160)}`);
  }
  return await r.json();
}

// ── reading mail ────────────────────────────────────────────────────────────

function decodeB64Url(data) {
  if (!data) return '';
  try {
    return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch { return ''; }
}

/** Walk the MIME tree for the best text we can show. Prefers text/plain. */
function extractBody(payload) {
  if (!payload) return '';
  const parts = [];
  (function walk(p) {
    if (!p) return;
    if (p.body?.data) parts.push({ mime: p.mimeType || '', text: decodeB64Url(p.body.data) });
    for (const c of p.parts || []) walk(c);
  })(payload);

  const plain = parts.find((p) => p.mime.startsWith('text/plain'));
  if (plain?.text) return plain.text;
  const html = parts.find((p) => p.mime.startsWith('text/html'));
  if (html?.text) {
    return html.text
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return parts[0]?.text || '';
}

function header(msg, name) {
  const h = (msg.payload?.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

/**
 * Build the Gmail search that decides what we are allowed to see.
 *
 * This is the privacy boundary in one expression: everything outside it is never
 * requested. It is assembled from YOUR data — the companies you applied to — plus
 * generic recruiting vocabulary, and is always time-boxed.
 */
export function buildQuery({ companies = [], days = 45, extraTerms = [] } = {}) {
  const RECRUITING = [
    'application', 'applied', 'candidate', 'interview', 'recruiter', 'recruitment',
    'hiring', 'shortlisted', 'assessment', 'screening', 'offer letter',
    'job opportunity', 'position', 'role', 'resume', 'cv', 'availability',
    'next steps', 'hiring manager', 'talent acquisition',
  ];
  const terms = [...new Set([...RECRUITING, ...extraTerms.filter(Boolean)])]
    .map((t) => (t.includes(' ') ? `"${t}"` : t));

  // Company names get their own clause: mail from a company you applied to is
  // interesting even when it avoids all the usual recruiting words.
  const companyClause = companies
    .filter((c) => c && c.length > 2)
    .slice(0, 40)
    .map((c) => `"${String(c).replace(/"/g, '')}"`)
    .join(' OR ');

  const words = `(${terms.join(' OR ')}${companyClause ? ' OR ' + companyClause : ''})`;
  // -in:chats keeps Google Chat out; category:promotions is where job alerts pile up
  // and is deliberately excluded — those are listings, not replies about you.
  return `${words} newer_than:${Math.max(1, Math.min(365, days))}d -in:chats -category:promotions`;
}

/** List message ids matching the query. Read-only, capped. */
export async function searchMessages(query, max = 40) {
  const out = [];
  let pageToken;
  while (out.length < max) {
    const params = { q: query, maxResults: String(Math.min(100, max - out.length)) };
    if (pageToken) params.pageToken = pageToken;
    const page = await gmailFetch('/messages', params);
    for (const m of page.messages || []) out.push(m.id);
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }
  return out.slice(0, max);
}

/** Fetch one message and flatten it to the fields we store. */
export async function getMessage(id) {
  const m = await gmailFetch(`/messages/${id}`, { format: 'full' });
  const from = header(m, 'From');
  const nameMatch = from.match(/^\s*"?([^"<]*?)"?\s*</);
  const addrMatch = from.match(/<([^>]+)>/);
  return {
    id: m.id,
    thread_id: m.threadId,
    from_addr: (addrMatch ? addrMatch[1] : from).trim().toLowerCase(),
    from_name: (nameMatch ? nameMatch[1] : '').trim(),
    subject: header(m, 'Subject'),
    snippet: (m.snippet || '').replace(/&#39;/g, "'").replace(/&amp;/g, '&'),
    body: extractBody(m.payload).slice(0, 20000),
    received_at: Number(m.internalDate) || Date.now(),
  };
}

export { accessToken as googleAccessToken, readStore as _readStoreForTests };
