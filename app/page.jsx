'use client';
import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
// Pure date helpers — no server-only imports, safe in this client component.
import { shortAge } from '../lib/freshness.js';

// Pipeline stages, mirroring lib/pipeline.js. Kept in sync manually — the server
// validates on write, so a drift here surfaces as a rejected update, not bad data.
const STAGE_OPTIONS = [
  { key: 'new', label: 'New' },
  { key: 'shortlisted', label: '★ Shortlisted' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'applied', label: 'Applied' },
  { key: 'screening', label: 'Screening' },
  { key: 'interview', label: 'Interview' },
  { key: 'offer', label: 'Offer' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'skipped', label: 'Skipped' },
];

export default function Dashboard() {
  const [profiles, setProfiles] = useState([]);
  const [connectors, setConnectors] = useState([]);
  const [activeProfile, setActiveProfile] = useState(null);
  const [jobs, setJobs] = useState([]);
  // "Fresh this week" — loaded separately from the table because it must show
  // everything new across ALL sources regardless of the filters above it.
  const [fresh, setFresh] = useState({ jobs: [], counts: null });
  const [freshOpen, setFreshOpen] = useState(true);
  const [freshDays, setFreshDays] = useState(7);
  const [freshStrict, setFreshStrict] = useState(false);
  const [tab, setTab] = useState('jobs');
  // Gmail state lives here, not only inside the Replies tab. Buried one tab deep with
  // no signal anywhere else, the integration was effectively invisible — the first
  // question after building it was "where is it?".
  const [gmail, setGmail] = useState(null);
  const [gmailPending, setGmailPending] = useState(0);

  const loadGmail = useCallback(async () => {
    if (!activeProfile) return;
    const r = await fetch(`/api/gmail?profile_id=${encodeURIComponent(activeProfile.id)}&actionable=1`)
      .then((x) => x.json()).catch(() => null);
    if (r?.ok) { setGmail(r.status); setGmailPending((r.emails || []).length); }
  }, [activeProfile]);
  useEffect(() => { loadGmail(); }, [loadGmail]);
  const [toast, setToast] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [filter, setFilter] = useState({ status: '', connector: '', q: '' });
  const [backend, setBackend] = useState('sqlite');
  const [scoring, setScoring] = useState(false);
  const [tracker, setTracker] = useState(null);
  const [panel, setPanel] = useState(null); // { id, kind: 'gap' | 'intel' }
  const [sortByFit, setSortByFit] = useState(true);
  const [hideDupes, setHideDupes] = useState(true);
  // Applications already sent are hidden by default. Auto-apply can send twenty in a
  // batch, and every one of them stayed in this list looking actionable — the whole
  // point of the list is what is left TO do.
  const [hideApplied, setHideApplied] = useState(true);
  const [minFit, setMinFit] = useState(0);

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(null), 4000); };

  // Are we inside the desktop window rather than a browser tab? Decided after mount,
  // because the server renders this markup too and reading location during render makes
  // the two disagree — React then keeps the server's version and the class never lands.
  const [inDesktop, setInDesktop] = useState(false);
  useEffect(() => {
    setInDesktop(window.location.search.includes('shell=desktop'));
  }, []);

  // Collapse cross-connector duplicates and apply sort/threshold. The same role
  // scraped from three boards is one opportunity — showing it three times inflates
  // every count you look at and wastes triage time.
  const visibleJobs = useMemo(() => {
    let list = jobs.slice();

    if (hideDupes) {
      const byKey = new Map();
      const out = [];
      for (const j of list) {
        if (!j.canonical_key) { out.push(j); continue; }
        const seen = byKey.get(j.canonical_key);
        if (!seen) {
          const copy = { ...j, _dupes: [] };
          byKey.set(j.canonical_key, copy);
          out.push(copy);
        } else {
          seen._dupes.push(j);
          // Keep whichever copy has the richer description as the visible one.
          if ((j.description || '').length > (seen.description || '').length) {
            Object.assign(seen, j, { _dupes: seen._dupes });
          }
        }
      }
      list = out;
    }

    if (hideApplied) {
      // Anything that has reached the employer, however it got there: sent by
      // auto-apply, marked applied by you, or a board telling us you had already
      // applied. Later pipeline stages are hidden too — a job at Interview does not
      // belong in a list of things to apply to. The Tracker still shows all of it.
      const done = new Set(['applied', 'screening', 'interview', 'offer', 'rejected']);
      list = list.filter((j) => !(
        done.has(j.status)
        || j.auto_apply_state === 'applied'
        || j.auto_apply_state === 'already_applied'
        || j.auto_apply_state === 'applied_incomplete'
      ));
    }

    if (minFit > 0) list = list.filter((j) => (j.fit_score ?? -1) >= minFit);

    if (sortByFit) {
      list.sort((a, b) => (b.fit_score ?? -1) - (a.fit_score ?? -1) || (b.discovered_at || 0) - (a.discovered_at || 0));
    }
    return list;
  }, [jobs, hideDupes, hideApplied, sortByFit, minFit]);

  const loadProfiles = useCallback(async () => {
    const r = await fetch('/api/profiles').then((r) => r.json());
    setProfiles(r.profiles || []);
    setBackend(r.backend);
    if (!activeProfile && r.profiles?.[0]) setActiveProfile(r.profiles[0]);
  }, [activeProfile]);

  const loadConnectors = useCallback(async () => {
    const r = await fetch('/api/connectors').then((r) => r.json());
    setConnectors(r.connectors || []);
  }, []);

  const loadJobs = useCallback(async () => {
    if (!activeProfile) return;
    const params = new URLSearchParams({ profile_id: activeProfile.id });
    if (filter.status) params.set('status', filter.status);
    if (filter.connector) params.set('connector', filter.connector);
    if (filter.q) params.set('q', filter.q);
    const r = await fetch(`/api/jobs?${params}`).then((r) => r.json());
    setJobs(r.jobs || []);
  }, [activeProfile, filter]);

  useEffect(() => { loadProfiles(); loadConnectors(); }, [loadProfiles, loadConnectors]);
  useEffect(() => { loadJobs(); }, [loadJobs]);

  // Bookmarklet for the in-page toolbar. Fetched rather than hard-coded because it
  // carries the local token.
  const [bookmarklet, setBookmarklet] = useState('');
  useEffect(() => {
    fetch('/api/toolbar/link').then((r) => r.json())
      .then((r) => setBookmarklet(r.bookmarklet || '')).catch(() => {});
  }, []);

  const loadFresh = useCallback(async () => {
    if (!activeProfile) return;
    const p = new URLSearchParams({ profile_id: activeProfile.id, fresh: String(freshDays) });
    if (freshStrict) p.set('strict', '1');
    const r = await fetch(`/api/jobs?${p}`).then((x) => x.json()).catch(() => ({ jobs: [] }));
    setFresh({ jobs: r.jobs || [], counts: r.counts || null });
  }, [activeProfile, freshDays, freshStrict]);
  useEffect(() => { loadFresh(); }, [loadFresh]);

  const createProfile = async () => {
    const name = prompt('Profile name (e.g. "Alex - Senior Backend")');
    if (!name) return;
    await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, keywords: '', locations: '' }),
    });
    await loadProfiles();
    flash('Profile created');
  };

  const saveProfile = async (p) => {
    await fetch(`/api/profiles/${p.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(p),
    });
    flash('Saved');
    loadProfiles();
  };

  const deleteProfile = async (p) => {
    if (!confirm(`Delete profile "${p.name}" and all its jobs?`)) return;
    await fetch(`/api/profiles/${p.id}`, { method: 'DELETE' });
    setActiveProfile(null);
    loadProfiles();
  };

  const login = async (connectorId) => {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile_id: activeProfile.id, connector: connectorId }),
    }).then((r) => r.json());
    if (r.error) flash(`Error: ${r.error}`);
    else flash(r.message || `Opened ${connectorId}. Log in, LEAVE THE WINDOW OPEN, then hit "Scan this".`);
  };

  const scanAll = async (connectorIds = null) => {
    if (!activeProfile) return;
    setScanning(true);
    flash('Scanning… reusing your open logged-in window(s). Open & log in first if a site blocks you.');
    try {
      const r = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile_id: activeProfile.id, connectors: connectorIds }),
      }).then((r) => r.json());
      const total = (r.results || []).reduce((s, x) => s + (x.found || 0), 0);
      const errs = (r.results || []).filter((x) => x.error).map((x) => `${x.connector}: ${x.error}`).join('; ');
      flash(`Scan done — ${total} new jobs.${errs ? ' Errors: ' + errs : ''}`);
      // Newly scanned jobs are by definition the freshest ones — the Fresh panel is
      // the view that most needs updating after a scan, and it was the one not being
      // refreshed at all.
      await refreshJobViews();
    } finally {
      setScanning(false);
    }
  };

  // Paste any job URL — including sources JobFinder doesn't scan. It opens in your
  // Chrome, gets read into a normal job row, and is filled like any other.
  const [pasteUrl, setPasteUrl] = useState('');
  const [pasting, setPasting] = useState(false);

  const importLink = async (mode) => {
    const url = pasteUrl.trim();
    if (!url || !activeProfile) return;
    setPasting(true);
    flash('Opening the link and reading the posting…');
    const r = await fetch('/api/adhoc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile_id: activeProfile.id, url, autofill: mode }),
    }).then((x) => x.json()).catch((e) => ({ error: String(e?.message || e) }));
    setPasting(false);
    if (r.error) { flash(`Import failed: ${r.error}`); return; }
    setPasteUrl('');
    flash(r.message || 'Imported.');
    await refreshJobViews();
  };

  const apply = async (job) => {
    flash(`Opening ${job.title}…`);
    const r = await fetch('/api/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: job.id }),
    }).then((r) => r.json());
    if (r.error) { flash(`Apply failed: ${r.error}`); return; }
    flash(r.note || 'Apply opened');
    await refreshJobViews();   // status becomes in_progress server-side; show it everywhere
  };

  // Autofill targets the CURRENTLY VISIBLE tab in the browser. Watch the terminal
  // panel at the bottom of the page for per-field progress.
  //   mode = 'llm-fallback' → exact → semantic → LLM for unfilled (default Autofill button)
  //   mode = 'llm-force'    → LLM tries every detected field (LLM Fill button)
  const autofill = async (job, mode = 'llm-fallback') => {
    flash(mode === 'llm-force' ? 'Forcing LLM autofill on the active tab…' : 'Autofilling the active tab…');
    const r = await fetch('/api/autofill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: job.id, mode }),
    }).then((r) => r.json()).catch((e) => ({ error: String(e?.message || e) }));
    if (r.error) flash(`Autofill error: ${r.error}`);
    else {
      const s = r.summary || {};
      const total = (s.filled || 0) + (s.semanticFilled || 0) + (s.llmFilled || 0);
      const where = s.targetUrl ? ` on ${new URL(s.targetUrl).hostname}` : '';
      const kept = s.protected
        ? ` Kept your own text in ${s.protected} field${s.protected === 1 ? '' : 's'} you typed while I worked.`
        : '';
      flash(
        total
          ? `Autofilled ${total} field${total === 1 ? '' : 's'}${where} (${s.filled || 0} bank, ${s.semanticFilled || 0} semantic, ${s.llmFilled || 0} LLM)${s.resumeAttached ? ', résumé attached' : ''}.${kept}`
          : `No fields filled${where}.${kept} Open the terminal panel ↓ to see what happened.`
      );
    }
  };

  // 🛡️ Safe Mode — instantly convert the automated Chrome to plain Chrome (no debug
  // port, no init scripts). Used when a "verify you are human" check is escalating
  // and we don't want any chance of being flagged. Logins persist.
  const safeMode = async () => {
    if (!activeProfile) return;
    flash('Switching to Safe Mode…');
    const r = await fetch('/api/safemode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile_id: activeProfile.id }),
    }).then((r) => r.json()).catch((e) => ({ error: String(e?.message || e) }));
    if (r.error) flash(`Safe Mode error: ${r.error}`);
    else flash(r.note || `Safe Mode active — ${r.restoredTabs || 0} tab(s) reopened in a clean Chrome window.`);
  };

  // Capture whatever is currently typed on the open application into the answer
  // bank. Separate from Autofill because the moment you most want to capture — just
  // before submitting — is the moment you least want anything written to the form.
  const learnPage = async (job) => {
    const pid = job?.profile_id || activeProfile?.id;
    if (!pid) return;
    flash('Reading the open application…');
    const r = await fetch('/api/harvest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile_id: pid }),
    }).then((x) => x.json()).catch((e) => ({ ok: false, reason: String(e?.message || e) }));
    if (!r.ok) flash(r.reason || 'Could not read the page.');
    else if (!r.learned) flash('Nothing new found on the page to learn.');
    else {
      const eg = (r.samples || []).slice(0, 3).map((s) => s.label).filter(Boolean).join(', ');
      flash(
        `Captured ${r.learned} answer${r.learned === 1 ? '' : 's'}${eg ? ` — ${eg}` : ''}. ` +
        `Approve ${r.learned === 1 ? 'it' : 'them'} under Answer bank before autofill will use ${r.learned === 1 ? 'it' : 'them'}` +
        `${r.pending ? ` (${r.pending} awaiting review)` : ''}.`
      );
    }
  };

  // ── Fit scoring + pipeline ────────────────────────────────────────────────
  const scoreFit = async () => {
    if (!activeProfile) return;
    setScoring(true);
    flash('Scoring fit across all jobs…');
    try {
      const r = await fetch('/api/fit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile_id: activeProfile.id }),
      }).then((x) => x.json()).catch((e) => ({ error: String(e?.message || e) }));
      if (r.error) flash(`Fit scoring failed: ${r.error}`);
      else {
        flash(
          `Scored ${r.scored} jobs — ${r.bands?.strong || 0} strong, ${r.bands?.possible || 0} possible` +
          (r.duplicates ? `, ${r.duplicates} duplicates grouped` : '') +
          (r.candidate?.hasCv ? '' : ' · add your CV for accurate scores')
        );
      }
      await refreshJobViews();
    } finally {
      setScoring(false);
    }
  };

  const loadTracker = useCallback(async () => {
    if (!activeProfile) return;
    const r = await fetch(`/api/tracker?profile_id=${encodeURIComponent(activeProfile.id)}`)
      .then((x) => x.json()).catch(() => null);
    if (r?.ok) setTracker(r);
  }, [activeProfile]);

  // Job state is rendered in THREE places: the main table, the Fresh panel, and the
  // pipeline funnel. Anything that changes a job has to refresh all three, and asking
  // every handler to remember that is how the panel went stale — /api/apply correctly
  // set the job to in_progress, but only the table was reloaded, so the Fresh row kept
  // showing the old stage and it looked like Apply had done nothing.
  //
  // One function, called by every mutating handler, so a new handler cannot reintroduce
  // the bug by forgetting one of them.
  const refreshJobViews = useCallback(async () => {
    await Promise.all([loadJobs(), loadFresh(), loadTracker()]);
  }, [loadJobs, loadFresh, loadTracker]);

  useEffect(() => { loadTracker(); }, [loadTracker]);

  // Move a job through the pipeline. The server auto-schedules the next follow-up.
  const setStage = async (job, status) => {
    const r = await fetch('/api/tracker', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: job.id, status }),
    }).then((x) => x.json()).catch((e) => ({ error: String(e?.message || e) }));
    if (r.error) flash(`Could not update: ${r.error}`);
    await refreshJobViews();
  };

  const openPanel = (job, kind) =>
    setPanel(panel?.id === job.id && panel.kind === kind ? null : { id: job.id, kind });

  const setJobStatus = async (job, status) => {
    await fetch('/api/jobs', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: job.id, status }),
    });
    await refreshJobViews();
  };

  return (
    <div className={`container${inDesktop ? ' in-desktop' : ''}`}>
      <div className="header">
        <div className="logo">🎯 JobFinder</div>
        <div className="row" style={{ gap: 12 }}>
          {activeProfile && (
            <button
              onClick={safeMode}
              title="If a 'verify you are human' check is about to fail: closes the automated Chrome and reopens your current tabs in a clean, un-instrumented Chrome window (same logins, no automation attached, can't be flagged). When you close the safe window, the next Scan/Apply resumes automated mode."
              style={{ background: '#1f6feb22', borderColor: '#1f6feb', color: '#58a6ff', fontWeight: 600 }}
            >
              🛡️ Safe Mode
            </button>
          )}
          {activeProfile && (
            <button
              onClick={() => setTab('inbox')}
              title={
                gmail?.connected
                  ? `Gmail connected as ${gmail.email}. Read-only. Click to open Replies.`
                  : 'Connect Gmail (read-only) so recruiter replies land in JobFinder. Click to set it up.'
              }
              style={
                gmail?.connected
                  ? { background: '#23863622', borderColor: '#238636', color: '#3fb950', fontWeight: 600 }
                  : { background: '#d2992222', borderColor: '#d29922', color: '#e3b341', fontWeight: 600 }
              }
            >
              📬 {gmail?.connected ? 'Gmail' : 'Connect Gmail'}
              {gmail?.connected && gmailPending > 0 && (
                <span className="tag" style={{ background: '#d2992233', color: '#e3b341', marginLeft: 2 }}>
                  {gmailPending}
                </span>
              )}
            </button>
          )}
          <div className="muted">storage: {backend} {backend === 'timescale' ? '(TimescaleDB)' : '(local)'} </div>
        </div>
      </div>

      <div className="grid">
        <aside>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <span className="label">Profiles</span>
            <button onClick={createProfile}>+ New</button>
          </div>
          {profiles.map((p) => (
            <div
              key={p.id}
              className={`profile-pill ${activeProfile?.id === p.id ? 'active' : ''}`}
              onClick={() => setActiveProfile(p)}
            >
              {p.name}
            </div>
          ))}
          {profiles.length === 0 && <div className="muted">No profiles yet — create one.</div>}
        </aside>

        <main>
          {!activeProfile && <div className="card">Select or create a profile to begin.</div>}
          {activeProfile && (
            <>
              <div className="tabs">
                <div className={`tab ${tab === 'jobs' ? 'active' : ''}`} onClick={() => setTab('jobs')}>Jobs</div>
                <div className={`tab ${tab === 'sources' ? 'active' : ''}`} onClick={() => setTab('sources')}>Sources</div>
                <div className={`tab ${tab === 'answers' ? 'active' : ''}`} onClick={() => setTab('answers')}>Answer bank</div>
                <div className={`tab ${tab === 'autoapply' ? 'active' : ''}`} onClick={() => setTab('autoapply')}>🤖 Auto-apply</div>
                <div className={`tab ${tab === 'prep' ? 'active' : ''}`} onClick={() => setTab('prep')}>🎓 Interview Prep</div>
                <div className={`tab ${tab === 'inbox' ? 'active' : ''}`} onClick={() => setTab('inbox')}>
                  📧 Replies
                  {gmailPending > 0 && (
                    <span className="tag" style={{ background: '#d2992233', color: '#e3b341', marginLeft: 6 }}>
                      {gmailPending}
                    </span>
                  )}
                </div>
                <div className={`tab ${tab === 'contacts' ? 'active' : ''}`} onClick={() => setTab('contacts')}>📇 Contacts</div>
                <div className={`tab ${tab === 'profile' ? 'active' : ''}`} onClick={() => setTab('profile')}>Profile</div>
              </div>

              {tab === 'jobs' && (
                <>
                  {/* Paste a link from anywhere — a friend, a newsletter, a careers
                      page. Scanning only ever covers the sources we have connectors for. */}
                  <div className="card" style={{ borderColor: '#238636', background: '#2386360d' }}>
                    <div className="label" style={{ color: '#3fb950' }}>🔗 Paste a job link</div>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                      Any posting, from any site — it doesn&apos;t have to be one JobFinder scans.
                      It opens in your browser, gets read into your job list, and fills like the rest.
                    </div>
                    <div className="row">
                      <input
                        value={pasteUrl}
                        onChange={(e) => setPasteUrl(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !pasting) importLink('llm-fallback'); }}
                        placeholder="https://careers.example.com/jobs/senior-engineer"
                        style={{ flex: '1 1 220px' }}
                        disabled={pasting}
                      />
                      <button className="primary" onClick={() => importLink('llm-fallback')} disabled={pasting || !pasteUrl.trim()}>
                        {pasting ? 'Working…' : 'Import + Autofill'}
                      </button>
                      <button
                        onClick={() => importLink('llm-force')}
                        disabled={pasting || !pasteUrl.trim()}
                        title="Import, then let the LLM attempt every field on the page"
                        style={{ background: '#8b5cf622', borderColor: '#8b5cf6', color: '#a78bfa' }}
                      >Import + LLM Fill</button>
                      <button onClick={() => importLink('none')} disabled={pasting || !pasteUrl.trim()} title="Just add it to the list and open it">
                        Import only
                      </button>
                    </div>
                  </div>

                  {/* One-time setup: drag this to the bookmarks bar, then you never
                      have to come back here mid-application. */}
                  <details className="card" style={{ borderColor: '#8b5cf6', background: '#8b5cf60d' }}>
                    <summary style={{ cursor: 'pointer', color: '#a78bfa', fontWeight: 600 }}>
                      🎯 In-page toolbar — fill without leaving the application
                    </summary>
                    <div className="muted" style={{ marginTop: 8, lineHeight: 1.6 }}>
                      Drag this button to your bookmarks bar (⌘⇧B to show it). On any application
                      page, click it once — a floating toolbar appears with <strong>Autofill</strong>,
                      <strong> LLM Fill</strong> and <strong>Learn page</strong>, plus hotkeys.
                      <div style={{ margin: '12px 0' }}>
                        {bookmarklet ? (
                          // eslint-disable-next-line @next/next/no-html-link-for-pages
                          <a
                            href={bookmarklet}
                            onClick={(e) => e.preventDefault()}
                            draggable
                            style={{
                              display: 'inline-block', padding: '9px 16px', borderRadius: 8,
                              background: '#8b5cf622', border: '1px solid #8b5cf6', color: '#a78bfa',
                              fontWeight: 700, textDecoration: 'none', cursor: 'grab',
                            }}
                          >🎯 JobFinder Fill</a>
                        ) : <span className="muted">preparing…</span>}
                      </div>
                      Once it&apos;s open on a page:{' '}
                      <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> autofill ·{' '}
                      <kbd>L</kbd> LLM Fill · <kbd>S</kbd> learn page · <kbd>H</kbd> hide.
                      <div style={{ marginTop: 8, fontSize: 12 }}>
                        No automation stays attached — each click attaches for that step and detaches,
                        so human-verification steps still see a plain browser. Click the bookmark again
                        after a full page reload.
                      </div>
                    </div>
                  </details>

                  <div className="card">
                    <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
                      <div className="row">
                        <button className="primary" disabled={scanning} onClick={() => scanAll(null)}>
                          {scanning ? 'Scanning…' : '🔍 Scan All Sources'}
                        </button>
                        <button
                          onClick={scoreFit}
                          disabled={scoring}
                          title="Rank every job against your CV, skills, level and locations — and collapse the same role scraped from multiple boards. Deterministic and instant; no LLM."
                          style={{ background: '#23863622', borderColor: '#238636', color: '#3fb950', fontWeight: 600 }}
                        >
                          {scoring ? 'Scoring…' : '🎯 Score fit'}
                        </button>
                      </div>
                      <div className="row">
                        <input
                          placeholder="search title/company/location"
                          style={{ width: 240 }}
                          value={filter.q}
                          onChange={(e) => setFilter({ ...filter, q: e.target.value })}
                        />
                        <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
                          <option value="">all stages</option>
                          {STAGE_OPTIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                          <option value="error">error</option>
                        </select>
                        <select value={filter.connector} onChange={(e) => setFilter({ ...filter, connector: e.target.value })}>
                          <option value="">all sources</option>
                          {connectors.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                        </select>
                        <select value={minFit} onChange={(e) => setMinFit(Number(e.target.value))} title="Only show jobs at or above this fit score">
                          <option value={0}>any fit</option>
                          <option value={70}>strong only (70+)</option>
                          <option value={50}>50+</option>
                        </select>
                      </div>
                    </div>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <div className="muted">
                        {visibleJobs.length} shown
                        {jobs.length !== visibleJobs.length && ` · ${jobs.length - visibleJobs.length} hidden (applied / duplicates / below threshold)`}
                      </div>
                      <div className="row" style={{ gap: 14 }}>
                        <label className="muted" style={{ cursor: 'pointer' }}>
                          <input type="checkbox" checked={sortByFit} onChange={(e) => setSortByFit(e.target.checked)} style={{ width: 'auto', marginRight: 5 }} />
                          sort by fit
                        </label>
                        <label className="muted" style={{ cursor: 'pointer' }} title="The same role scraped from several boards counts once">
                          <input type="checkbox" checked={hideDupes} onChange={(e) => setHideDupes(e.target.checked)} style={{ width: 'auto', marginRight: 5 }} />
                          merge duplicates
                        </label>
                        <label className="muted" style={{ cursor: 'pointer' }} title="Jobs you have already applied to — including everything auto-apply sent. They stay in the Tracker.">
                          <input type="checkbox" checked={hideApplied} onChange={(e) => setHideApplied(e.target.checked)} style={{ width: 'auto', marginRight: 5 }} />
                          hide applied
                        </label>
                      </div>
                    </div>
                  </div>

                  {/* ── Fresh this week ───────────────────────────────────────────
                      Newest first, across every source. Applying early measurably
                      matters, and this is the only view that answers "what appeared
                      since I last looked?" without fighting the filters. */}
                  <div className="card" style={{ borderColor: '#1f6feb', background: '#1f6feb0f' }}>
                    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ cursor: 'pointer' }} onClick={() => setFreshOpen(!freshOpen)}>
                        <div className="label" style={{ color: '#58a6ff' }}>
                          {freshOpen ? '▾' : '▸'} 🔥 Fresh — last {freshDays} day{freshDays === 1 ? '' : 's'}
                          {' '}({fresh.jobs.length})
                        </div>
                        <div className="muted">
                          {fresh.counts
                            ? <>
                                {fresh.counts.posted} with a published date from the source
                                {fresh.counts.seen > 0 && <>, {fresh.counts.seen} newly found on sources that don&apos;t publish one</>}
                              </>
                            : 'Loading…'}
                        </div>
                      </div>
                      <div className="row">
                        <select value={freshDays} onChange={(e) => setFreshDays(Number(e.target.value))}>
                          <option value={1}>24 hours</option>
                          <option value={3}>3 days</option>
                          <option value={7}>7 days</option>
                          <option value={14}>14 days</option>
                        </select>
                        <label className="muted" style={{ cursor: 'pointer' }} title="Only jobs where the source actually published a date. Excludes Naukri, Wellfound, Y Combinator and LinkedIn job cards, which don't.">
                          <input type="checkbox" checked={freshStrict} onChange={(e) => setFreshStrict(e.target.checked)} style={{ width: 'auto', marginRight: 5 }} />
                          confirmed dates only
                        </label>
                        <button onClick={loadFresh} title="Refresh this list">↻</button>
                      </div>
                    </div>

                    {freshOpen && (
                      <div className="table-wrap scroll-pane" style={{ marginTop: 10 }}>
                        {fresh.jobs.length === 0 ? (
                          <div className="muted" style={{ padding: 12 }}>
                            Nothing in this window yet. Hit “Scan All Sources”, or widen the range above.
                          </div>
                        ) : (
                          <table>
                            <thead>
                              <tr><th>When</th><th>Role</th><th>Company</th><th>Source</th><th>Stage</th><th></th></tr>
                            </thead>
                            <tbody>
                              {fresh.jobs.map((j) => (
                                <tr key={`fresh-${j.id}`}>
                                  <td data-label="When" style={{ whiteSpace: 'nowrap' }}>
                                    <span style={{ color: j._fresh?.basis === 'posted' ? '#3fb950' : '#8b949e' }}>
                                      {shortAge(j._fresh?.at)}
                                    </span>
                                    <div className="muted" style={{ fontSize: 11 }}>
                                      {j._fresh?.basis === 'posted' ? 'posted' : 'first seen'}
                                    </div>
                                  </td>
                                  <td>
                                    <a href={j.url} target="_blank" rel="noreferrer"><strong>{j.title}</strong></a>
                                    {j.location && <div className="muted" style={{ fontSize: 12 }}>{j.location}</div>}
                                  </td>
                                  <td data-label="Company">{j.company}</td>
                                  <td data-label="Source"><span className="tag">{j.connector}</span></td>
                                  <td data-label="Stage">
                                    <select
                                      className="stage-select"
                                      value={j.status}
                                      onChange={(e) => setStage(j, e.target.value)}
                                    >
                                      {STAGE_OPTIONS.map((st) => (
                                        <option key={st.key} value={st.key}>{st.label}</option>
                                      ))}
                                    </select>
                                    {j.follow_up_at && (
                                      <div className={`muted followup ${j.follow_up_at <= Date.now() ? 'due' : ''}`} style={{ fontSize: 11 }}>
                                        {j.follow_up_at <= Date.now() ? '⏰ follow up now' : `follow up ${new Date(j.follow_up_at).toLocaleDateString()}`}
                                      </div>
                                    )}
                                  </td>
                                  <td data-label="Actions" className="row">
                                    <button className="primary" onClick={() => apply(j)} title="Open the job in Chrome and start the apply flow">Apply</button>
                                    <button onClick={() => autofill(j, 'llm-fallback')} title="Fill from your answer bank first; fall back to the LLM for anything it doesn't cover.">Autofill</button>
                                    <button
                                      onClick={() => autofill(j, 'llm-force')}
                                      title="Ignore the answer bank and ask the LLM to fill EVERY detected field on the current page."
                                      style={{ background: '#8b5cf622', borderColor: '#8b5cf6', color: '#a78bfa' }}
                                    >LLM Fill</button>
                                    <button
                                      onClick={() => learnPage(j)}
                                      title="Save everything currently typed on the open application into your answer bank — best done just before you submit."
                                      style={{ background: '#23863622', borderColor: '#238636', color: '#3fb950' }}
                                    >📚 Learn page</button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Pipeline funnel + overdue follow-ups */}
                  {tracker && <TrackerPanel tracker={tracker} onJump={(status) => setFilter({ ...filter, status })} />}

                  <div className="card" style={{ padding: 0 }}>
                    <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th style={{ width: 58 }}>Fit</th>
                          <th>Title</th><th>Company</th><th>Location</th><th>Source</th><th>Stage</th><th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleJobs.map((j) => {
                          let fit = null;
                          try { fit = j.fit_json ? JSON.parse(j.fit_json) : null; } catch { /* ignore */ }
                          const dupes = j._dupes || [];
                          return (
                            <React.Fragment key={j.id}>
                              <tr>
                                <td>
                                  {j.fit_score == null ? (
                                    <span className="muted">—</span>
                                  ) : (
                                    <span
                                      className={`fit fit-${fit?.band || 'weak'}`}
                                      title={fit ? `${fit.reasons?.join(' · ')}\nconfidence: ${fit.confidence}` : ''}
                                    >
                                      {j.fit_score}
                                    </span>
                                  )}
                                </td>
                                <td>
                                  <a href={j.url} target="_blank" rel="noreferrer">{j.title}</a>
                                  {fit?.missing?.length > 0 && (
                                    <div className="muted" style={{ fontSize: 11 }}>
                                      missing: {fit.missing.slice(0, 4).join(', ')}{fit.missing.length > 4 ? '…' : ''}
                                    </div>
                                  )}
                                </td>
                                <td data-label="Company">{j.company}</td>
                                <td data-label="Location">{j.location}</td>
                                <td>
                                  <span className="tag">{j.connector}</span>
                                  {dupes.length > 0 && (
                                    <span className="muted" style={{ fontSize: 11 }} title={dupes.map((d) => d.connector).join(', ')}>
                                      {' '}+{dupes.length}
                                    </span>
                                  )}
                                </td>
                                <td data-label="Stage">
                                  <select
                                    className="stage-select"
                                    value={j.status}
                                    onChange={(e) => setStage(j, e.target.value)}
                                  >
                                    {STAGE_OPTIONS.map((s) => (
                                      <option key={s.key} value={s.key}>{s.label}</option>
                                    ))}
                                  </select>
                                  {j.follow_up_at && (
                                    <div className={`muted followup ${j.follow_up_at <= Date.now() ? 'due' : ''}`} style={{ fontSize: 11 }}>
                                      {j.follow_up_at <= Date.now() ? '⏰ follow up now' : `follow up ${new Date(j.follow_up_at).toLocaleDateString()}`}
                                    </div>
                                  )}
                                </td>
                                <td data-label="Actions" className="row">
                                  <button className="primary" onClick={() => apply(j)} title="Open the job in Chromium and trigger the apply flow">Apply</button>
                                  <button onClick={() => autofill(j, 'llm-fallback')} title="Fill from your answer bank first; fall back to LLM for any fields the bank doesn't cover.">Autofill</button>
                                  <button
                                    onClick={() => autofill(j, 'llm-force')}
                                    title="Ignore the answer bank and ask the LLM to fill EVERY detected field on the current page."
                                    style={{ background: '#8b5cf622', borderColor: '#8b5cf6', color: '#a78bfa' }}
                                  >LLM Fill</button>
                                  <button
                                    onClick={() => learnPage(j)}
                                    title="Save everything currently typed on the open application into your answer bank. Click this just before you submit — that's when the form is most complete, and those answers get reused on every future application."
                                    style={{ background: '#23863622', borderColor: '#238636', color: '#3fb950' }}
                                  >📚 Learn page</button>
                                  <button
                                    onClick={() => openPanel(j, 'gap')}
                                    title="Compare your CV against this posting: requirements, gaps, ATS risk — then optionally generate a tailored version."
                                    style={{ background: '#1f6feb22', borderColor: '#1f6feb', color: '#58a6ff' }}
                                  >CV fit</button>
                                  <button onClick={() => openPanel(j, 'intel')} title="Company interview brief, salary band, and possible referral contacts">Intel</button>
                                  <button onClick={() => openPanel(j, 'cover')} title="Write a cover letter tailored to this posting, grounded in your CV">✉ Cover</button>
                                  <button onClick={() => window.open(j.url, '_blank')} title="Open the job manually in your own browser">Open</button>
                                  <button onClick={() => setStage(j, 'skipped')} title="Skip / hide">✗</button>
                                </td>
                              </tr>
                              {panel?.id === j.id && (
                                <tr>
                                  <td colSpan={7} style={{ background: '#0d1117' }}>
                                    {panel.kind === 'gap'
                                      ? <CvGapPanel job={j} onClose={() => setPanel(null)} flash={flash} />
                                      : panel.kind === 'cover'
                                      ? <CoverLetterPanel job={j} onClose={() => setPanel(null)} flash={flash} />
                                      : <JobIntelPanel job={j} onClose={() => setPanel(null)} flash={flash} />}
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                        {visibleJobs.length === 0 && <tr><td colSpan={7} className="muted" style={{ padding: 16 }}>No jobs yet. Hit &quot;Scan All Sources&quot;.</td></tr>}
                      </tbody>
                    </table>
                    </div>
                  </div>
                </>
              )}

              {tab === 'sources' && (
                <div>
                  <div className="card" style={{ background: '#1f6feb15', borderColor: '#1f6feb55' }}>
                    <div className="label" style={{ color: '#58a6ff' }}>How to use this tab</div>
                    <div style={{ fontSize: 13, marginTop: 8, lineHeight: 1.6 }}>
                      <strong style={{ color: '#d29924' }}>🔓 Log in manually / Open &amp; verify:</strong> Opens a regular Chrome
                      window with <em>no automation attached</em>. Google sign-in works here (it refuses automated
                      windows), and Cloudflare / "verify you are human" checks pass because the site sees an ordinary
                      browser. <strong>Always do this first for each site</strong> — log in and/or clear the human check,
                      then <strong>close the window</strong>. Your session (including the Cloudflare clearance) is saved.
                      <br />
                      <strong style={{ color: '#3fb950' }}>🔍 Scan this:</strong> Runs the automated scanner, reusing the
                      session you just verified. If it gets blocked again, just re-run "Open &amp; verify" for that site.
                    </div>
                  </div>
                  {connectors.map((c) => (
                    <div className="card" key={c.id}>
                      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <strong style={{ fontSize: 16 }}>{c.label}</strong>
                          <div className="muted">{c.id} {c.requiresAuth ? '· login required' : '· no login needed'}</div>
                        </div>
                        <div className="row">
                          <button
                            onClick={() => login(c.id)}
                            style={{ background: '#d2992422', borderColor: '#d29924', color: '#d29924', fontWeight: 600 }}
                            title="Opens the browser window for this site so you can log in / clear any human-check. LEAVE IT OPEN — Scan reuses this exact window and won't ask you to log in again."
                          >
                            🔓 Open &amp; log in
                          </button>
                          <button className="primary" onClick={() => scanAll([c.id])} disabled={scanning}>
                            🔍 Scan this
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                  <div className="card" style={{ textAlign: 'center' }}>
                    <button onClick={loadConnectors} className="muted">↻ Rescan connector plugins</button>
                  </div>
                </div>
              )}

              {tab === 'answers' && <AnswerBank profileId={activeProfile.id} />}
              {tab === 'autoapply' && <AutoApplyPanel profileId={activeProfile.id} flash={flash} />}

              {tab === 'prep' && (
                <>
                  <InterviewPrep profileId={activeProfile.id} flash={flash} />
                  <MockInterview profileId={activeProfile.id} />
                </>
              )}

              {tab === 'contacts' && <ContactsPanel profileId={activeProfile.id} flash={flash} />}

              {tab === 'inbox' && (
                <>
                <GmailPanel profileId={activeProfile.id} flash={flash} onUpdated={refreshJobViews} onStatus={loadGmail} />
                <InboxParser
                  profileId={activeProfile.id}
                  onUpdated={() => { loadJobs(); loadTracker(); flash('Pipeline updated.'); }}
                />
                </>
              )}
              {/* Live progress terminal — fixed at bottom of viewport, collapsible.
                  Subscribes to /api/logs/stream and shows what autofill/scan are doing. */}
              <TerminalPanel profileId={activeProfile.id} />


              {tab === 'profile' && (
                <ProfileEditor
                  profile={activeProfile}
                  onChange={setActiveProfile}
                  onSave={() => saveProfile(activeProfile)}
                  onDelete={() => deleteProfile(activeProfile)}
                />
              )}
            </>
          )}
        </main>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// Pipeline funnel + overdue follow-ups.
//
// The conversion rates are the point: with a fixed runway you need to know whether
// your problem is volume (apply more) or quality (fix the CV). Those are completely
// different weeks of work, and without numbers people default to "apply harder".
function TrackerPanel({ tracker, onJump }) {
  const [open, setOpen] = useState(true);
  const f = tracker.funnel;
  const due = tracker.dueFollowUps || [];
  if (!f) return null;

  const steps = [
    { key: 'applied', label: 'Applied', n: f.totals.applied },
    { key: 'screening', label: 'Responded', n: f.totals.responded },
    { key: 'interview', label: 'Interviewed', n: f.totals.interviewed },
    { key: 'offer', label: 'Offers', n: f.totals.offers },
  ];

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        <strong>{open ? '▾' : '▸'} Pipeline</strong>
        <span className="muted">
          {f.totals.applied} applied · {f.rates.responseRate ?? '–'}% response
          {due.length > 0 && <span style={{ color: '#d29922' }}> · ⏰ {due.length} follow-up{due.length === 1 ? '' : 's'} due</span>}
        </span>
      </div>

      {open && (
        <>
          <div className="funnel">
            {steps.map((s, i) => (
              <div key={s.key} className="funnel-step" onClick={() => onJump && onJump(s.key)} title={`Filter to ${s.label}`}>
                <div className="funnel-n">{s.n}</div>
                <div className="funnel-label">{s.label}</div>
                {i > 0 && steps[i - 1].n > 0 && (
                  <div className="funnel-pct">{Math.round((s.n / steps[i - 1].n) * 100)}%</div>
                )}
              </div>
            ))}
          </div>

          <div className={`diagnosis diag-${f.diagnosis.level}`}>{f.diagnosis.text}</div>

          {due.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="label" style={{ marginBottom: 4 }}>⏰ Follow up now</div>
              {due.slice(0, 8).map((d) => (
                <div key={d.id} className="ref-item">
                  <span className="ref-n">{d.overdueDays}d</span>
                  <a href={d.url} target="_blank" rel="noreferrer">{d.title}</a>
                  <span className="muted">{d.company}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// CV gap analysis for one job, with optional LLM tailoring.
// The gap analysis is instant and deterministic; tailoring costs a model call, so
// it's behind an explicit button rather than run automatically.
function CvGapPanel({ job, onClose, flash }) {
  const [gap, setGap] = useState(null);
  const [tailored, setTailored] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await fetch(`/api/tailor?job_id=${encodeURIComponent(job.id)}`)
        .then((x) => x.json()).catch(() => null);
      if (alive) { setGap(r?.gap || null); setLoading(false); }
    })();
    return () => { alive = false; };
  }, [job.id]);

  const tailor = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/tailor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ job_id: job.id }),
      }).then((x) => x.json()).catch((e) => ({ ok: false, reason: String(e?.message || e) }));
      if (!r.ok) flash(`Tailoring failed: ${r.reason || r.error}`);
      setTailored(r.ok ? r : null);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="muted" style={{ padding: 12 }}>Analysing your CV against this posting…</div>;
  if (!gap) return <div className="muted" style={{ padding: 12 }}>Could not analyse this posting.</div>;

  return (
    <div style={{ padding: '12px 8px' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <strong>CV fit — {job.title}</strong>
        <button onClick={onClose}>close</button>
      </div>

      {!gap.hasCv ? (
        <div className="evidence">
          No CV text yet. Upload a text-based PDF on the <strong>Profile</strong> tab, or paste your CV there —
          fit scores and this analysis both depend on it.
        </div>
      ) : (
        <>
          <div className="row" style={{ gap: 18, marginBottom: 10 }}>
            <div>
              <div className="label">Coverage</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{gap.coverage ?? '–'}%</div>
            </div>
            <div>
              <div className="label">ATS risk</div>
              <div className={`ats ats-${gap.atsRisk}`}>{gap.atsRisk}</div>
            </div>
            <div className="muted" style={{ maxWidth: 460, fontSize: 12 }}>
              An applicant tracking system scores your CV against this posting before a human reads it.
              Low coverage usually means rejection regardless of whether you can do the job.
            </div>
          </div>

          <div className="gap-cols">
            <div>
              <div className="label" style={{ color: '#3fb950' }}>✓ In your CV ({gap.present.length})</div>
              <div className="muted">{gap.present.join(', ') || '—'}</div>
            </div>
            <div>
              <div className="label" style={{ color: '#d29922' }}>▲ Have it, CV doesn&apos;t say it ({gap.missingButEvidenced.length})</div>
              <div className="muted">{gap.missingButEvidenced.join(', ') || '—'}</div>
              {gap.missingButEvidenced.length > 0 && (
                <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                  From your answer bank / bio. Free wins — add these words.
                </div>
              )}
            </div>
            <div>
              <div className="label" style={{ color: '#ff7b72' }}>✗ Genuine gaps ({gap.missingEntirely.length})</div>
              <div className="muted">{gap.missingEntirely.join(', ') || '—'}</div>
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <button className="primary" onClick={tailor} disabled={busy}>
              {busy ? 'Writing…' : '✎ Generate tailored CV'}
            </button>
            <span className="muted" style={{ marginLeft: 10, fontSize: 12 }}>
              Rewrites your summary and bullets in this posting&apos;s vocabulary. Never claims a genuine gap.
            </span>
          </div>

          {tailored && (
            <div style={{ marginTop: 14, borderTop: '1px solid #30363d', paddingTop: 12 }}>
              {tailored.violations?.length > 0 && (
                <div className="evidence" style={{ borderLeftColor: '#ff7b72', background: '#ff7b7210', marginBottom: 10 }}>
                  ⚠ The draft mentions <strong>{tailored.violations.join(', ')}</strong>, which you have no evidence for.
                  Review and remove before using — claiming a skill you lack fails at interview.
                </div>
              )}

              <div className="label">Tailored summary</div>
              <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, marginBottom: 12 }}>{tailored.summary}</div>

              {tailored.bullets?.length > 0 && (
                <>
                  <div className="label">Bullet rewrites</div>
                  {tailored.bullets.map((b, i) => (
                    <div key={i} className="bullet-rewrite">
                      <div className="muted" style={{ textDecoration: 'line-through' }}>{b.original}</div>
                      <div>{b.rewritten}</div>
                      {b.why && <div className="muted" style={{ fontSize: 11 }}>→ {b.why}</div>}
                    </div>
                  ))}
                </>
              )}

              {tailored.keywords_to_add?.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div className="label">Keywords to add</div>
                  <div>{tailored.keywords_to_add.map((k) => <span key={k} className="tag">{k}</span>)}</div>
                </div>
              )}

              {tailored.gap_strategy && (
                <div style={{ marginTop: 10 }}>
                  <div className="label">Handling the gaps honestly</div>
                  <div className="muted" style={{ lineHeight: 1.6 }}>{tailored.gap_strategy}</div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Multiple CVs per profile. The best match is auto-attached at apply time, so the
// value here is entirely in having genuinely different variants — one CV rewritten
// three ways scores nearly identically and defeats the point.
function CvVariants({ profileId }) {
  const [variants, setVariants] = useState([]);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');
  const [last, setLast] = useState(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/cv?profile_id=${encodeURIComponent(profileId)}`).then((x) => x.json()).catch(() => null);
    if (r?.ok) setVariants(r.variants || []);
  }, [profileId]);

  useEffect(() => { load(); }, [load]);

  const upload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== 'application/pdf') { alert('Please pick a PDF.'); return; }
    setBusy(true);
    const form = new FormData();
    form.append('file', file);
    form.append('profile_id', profileId);
    form.append('label', label || file.name.replace(/\.pdf$/i, ''));
    try {
      const r = await fetch('/api/cv', { method: 'POST', body: form }).then((x) => x.json());
      if (r.error) alert(r.error); else { setLast(r); setLabel(''); await load(); }
    } finally { setBusy(false); e.target.value = ''; }
  };

  const patch = async (body) => {
    const r = await fetch('/api/cv', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId, ...body }),
    }).then((x) => x.json()).catch(() => null);
    if (r?.ok) setVariants(r.variants);
  };

  const remove = async (id) => {
    if (!confirm('Delete this CV variant?')) return;
    const r = await fetch(`/api/cv?profile_id=${encodeURIComponent(profileId)}&id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      .then((x) => x.json()).catch(() => null);
    if (r?.ok) setVariants(r.variants);
  };

  return (
    <div className="col">
      <label className="label">
        CV variants — the best match is attached automatically when you apply
        {variants.length > 0 && <span className="muted"> · {variants.length} stored</span>}
      </label>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        Upload a different CV per role type (e.g. <em>Backend / Platform</em>, <em>AI / ML</em>, <em>Leadership</em>).
        At apply time each is scored against the posting&apos;s requirements and the highest-coverage one is uploaded —
        the Activity panel logs which won and why.
      </div>

      {variants.map((v) => (
        <div key={v.id} className="variant-row">
          <div style={{ flex: '1 1 220px' }}>
            <div>
              <strong>{v.label}</strong>
              {v.isDefault && <span className="tag" style={{ marginLeft: 6 }}>fallback</span>}
              {!v.hasText && <span className="tag" style={{ marginLeft: 6, background: '#da363322', color: '#ff7b72' }}>no text</span>}
            </div>
            <div className="muted" style={{ fontSize: 11 }}>
              {v.filename} · {v.chars.toLocaleString()} chars
              {v.skills.length > 0 && ` · detects: ${v.skills.slice(0, 8).join(', ')}${v.skills.length > 8 ? '…' : ''}`}
            </div>
          </div>
          <div className="row">
            {!v.isDefault && <button onClick={() => patch({ id: v.id, makeDefault: true })} title="Use this when a posting has no recognisable requirements">make fallback</button>}
            <button className="danger" onClick={() => remove(v.id)}>delete</button>
          </div>
        </div>
      ))}

      {last && (
        <div className="evidence" style={last.extracted
          ? { borderLeftColor: '#3fb950', background: '#3fb95010' }
          : { borderLeftColor: '#d29922' }}>
          {last.extracted
            ? `✓ "${last.label || last.filename}" added — ${last.chars.toLocaleString()} chars, detected: ${last.skills.slice(0, 10).join(', ') || 'no known skills'}`
            : `⚠ Added, but no text could be read (${last.reason}). A CV with no text can never win the scoring — re-export it as a text PDF.`}
        </div>
      )}

      <div className="row" style={{ marginTop: 6 }}>
        <input
          placeholder="Label (e.g. Backend / Platform)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          style={{ maxWidth: 260 }}
        />
        <label className="btn-file">
          {busy ? 'Uploading…' : '+ Add CV variant'}
          <input type="file" accept="application/pdf" onChange={upload} disabled={busy} style={{ display: 'none' }} />
        </label>
      </div>
    </div>
  );
}

// Per-job intelligence: company interview brief, salary band, referral contacts.
// Each is loaded on demand — they cost either an LLM call or a browser action.
function JobIntelPanel({ job, onClose, flash }) {
  const [brief, setBrief] = useState(null);
  const [salary, setSalary] = useState(null);
  const [refs, setRefs] = useState(null);
  const [busy, setBusy] = useState('');

  const call = async (what, fn) => {
    setBusy(what);
    try { await fn(); } finally { setBusy(''); }
  };

  const loadBrief = () => call('brief', async () => {
    const r = await fetch('/api/prep/company', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: job.id }),
    }).then((x) => x.json()).catch((e) => ({ ok: false, reason: String(e?.message || e) }));
    if (!r.ok) flash(`Brief failed: ${r.reason}`);
    setBrief(r);
  });

  const loadSalary = () => call('salary', async () => {
    const r = await fetch('/api/intel', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'salary', job_id: job.id }),
    }).then((x) => x.json()).catch((e) => ({ ok: false, reason: String(e?.message || e) }));
    setSalary(r);
  });

  const loadRefs = () => call('refs', async () => {
    const r = await fetch('/api/intel', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'referrals', job_id: job.id }),
    }).then((x) => x.json()).catch((e) => ({ ok: false, reason: String(e?.message || e) }));
    setRefs(r);
  });

  const money = (n) => (n == null ? '–' : n.toLocaleString());

  return (
    <div style={{ padding: '12px 8px' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <strong>Intel — {job.company || job.title}</strong>
        <button onClick={onClose}>close</button>
      </div>

      <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <button onClick={loadBrief} disabled={!!busy}>{busy === 'brief' ? 'Researching…' : '🏢 Company brief'}</button>
        <button onClick={loadSalary} disabled={!!busy}>{busy === 'salary' ? 'Working…' : '💰 Salary & negotiation'}</button>
        <button onClick={loadRefs} disabled={!!busy}>{busy === 'refs' ? 'Searching…' : '🤝 Find referrals'}</button>
      </div>

      {/* Company brief */}
      {brief?.ok && (
        <div className="intel-block">
          <div className="note-body" dangerouslySetInnerHTML={{ __html: renderNoteHtml(brief.body) }} />
          {brief.sources?.length > 0 && (
            <div className="refs">
              <div className="label" style={{ marginBottom: 6 }}>Sources</div>
              {brief.sources.map((s, i) => (
                <div key={i} className="ref-item">
                  <span className="ref-n">[{i + 1}]</span>
                  <span className="ref-kind">{s.kind}</span>
                  <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {brief && !brief.ok && <div className="evidence">{brief.reason}</div>}

      {/* Salary */}
      {salary?.ok && (
        <div className="intel-block">
          <div className="label">Market band — from your own scraped postings</div>
          {salary.market.range ? (
            <>
              <div style={{ fontSize: 20, fontWeight: 700, margin: '4px 0' }}>
                {salary.market.currency || ''} {money(salary.market.range.low)} – {money(salary.market.range.high)}
                <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>
                  {' '}median ~{money(salary.market.range.median)}
                </span>
              </div>
              <div className="muted" style={{ fontSize: 12 }}>{salary.market.note}</div>
              {salary.posted && <div className="muted" style={{ fontSize: 12 }}>This posting states: {salary.posted}</div>}
              {salary.market.comparable?.length > 0 && (
                <details style={{ marginTop: 6 }}>
                  <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                    {salary.market.comparable.length} comparable postings
                  </summary>
                  {salary.market.comparable.map((c, i) => (
                    <div key={i} className="muted" style={{ fontSize: 12 }}>
                      {c.salary} — {c.title} {c.company ? `@ ${c.company}` : ''}
                    </div>
                  ))}
                </details>
              )}
            </>
          ) : (
            <div className="evidence">{salary.market.note}</div>
          )}

          {salary.brief && (
            <div style={{ marginTop: 10 }}>
              {salary.brief.anchor && (<><div className="label">Anchor</div><div style={{ lineHeight: 1.6 }}>{salary.brief.anchor}</div></>)}
              {salary.brief.script && (
                <><div className="label" style={{ marginTop: 8 }}>Say this</div>
                  <div className="script">{salary.brief.script}</div></>
              )}
              {salary.brief.when_asked_first && (
                <><div className="label" style={{ marginTop: 8 }}>If they ask your expectations first</div>
                  <div className="script">{salary.brief.when_asked_first}</div></>
              )}
              {salary.brief.levers?.length > 0 && (
                <><div className="label" style={{ marginTop: 8 }}>Trade for these</div>
                  <div className="muted">{salary.brief.levers.map((l) => <div key={l}>• {l}</div>)}</div></>
              )}
              {salary.brief.mistakes?.length > 0 && (
                <><div className="label" style={{ marginTop: 8 }}>Avoid</div>
                  <div className="muted">{salary.brief.mistakes.map((l) => <div key={l}>• {l}</div>)}</div></>
              )}
            </div>
          )}
        </div>
      )}

      {/* Referrals */}
      {refs && (
        <div className="intel-block">
          <div className="label">Possible contacts at {job.company}</div>
          {refs.ok && refs.people?.length > 0 ? (
            <>
              {refs.people.map((p) => (
                <div key={p.url} className="ref-item">
                  <span className="ref-n">{p.degree || '–'}</span>
                  <a href={p.url} target="_blank" rel="noreferrer">{p.name}</a>
                  <span className="muted">{p.headline}</span>
                </div>
              ))}
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                A 1st-degree contact who&apos;ll refer you is worth more than a perfect CV. Ask them directly.
              </div>
            </>
          ) : (
            <div className="evidence">{refs.reason || 'No contacts found. LinkedIn changes its markup often, so this can also mean the scrape broke.'}</div>
          )}
        </div>
      )}
    </div>
  );
}

// Mock interview: LLM asks, you answer, it grades against your prep material.
function MockInterview({ profileId }) {
  const [q, setQ] = useState(null);
  const [answer, setAnswer] = useState('');
  const [result, setResult] = useState(null);
  const [asked, setAsked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [scores, setScores] = useState([]);

  const getQuestion = async () => {
    setBusy(true); setResult(null); setAnswer('');
    try {
      const r = await fetch('/api/prep/mock', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile_id: profileId, action: 'question', asked }),
      }).then((x) => x.json()).catch((e) => ({ ok: false, reason: String(e?.message || e) }));
      if (r.ok) { setQ(r); setAsked((a) => [...a, r.question]); }
      else setQ({ error: r.reason });
    } finally { setBusy(false); }
  };

  const submit = async () => {
    if (!answer.trim() || !q?.question) return;
    setBusy(true);
    try {
      const r = await fetch('/api/prep/mock', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile_id: profileId, action: 'grade', question: q.question, answer }),
      }).then((x) => x.json()).catch((e) => ({ ok: false, reason: String(e?.message || e) }));
      setResult(r);
      if (r.ok) setScores((s) => [...s, r.score]);
    } finally { setBusy(false); }
  };

  const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : null;

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>🎤 Mock interview</strong>
        {scores.length > 0 && <span className="muted">{scores.length} answered · avg {avg}/5</span>}
      </div>
      <div className="muted" style={{ fontSize: 12, margin: '6px 0 10px' }}>
        Questions come from your prep notes, so you rehearse what your saved job ads actually demand.
        Reading feels like learning; producing an answer is what makes it stick.
      </div>

      {!q && <button className="primary" onClick={getQuestion} disabled={busy}>{busy ? 'Loading…' : 'Start'}</button>}

      {q?.error && <div className="evidence">{q.error}</div>}

      {q?.question && (
        <>
          <div className="mock-q">
            <span className="tag">{q.topic}</span>
            <div style={{ marginTop: 6, fontSize: 15, lineHeight: 1.5 }}>{q.question}</div>
          </div>
          <textarea
            rows={6}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Answer as you would out loud. Aim for 4-8 sentences: what it is, the trade-offs, and a concrete example."
            style={{ marginTop: 8 }}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" onClick={submit} disabled={busy || !answer.trim()}>
              {busy ? 'Grading…' : 'Submit answer'}
            </button>
            <button onClick={getQuestion} disabled={busy}>Skip / next question</button>
          </div>
        </>
      )}

      {result?.ok && (
        <div style={{ marginTop: 14, borderTop: '1px solid #30363d', paddingTop: 12 }}>
          <div className="row" style={{ gap: 10 }}>
            <div className={`mock-score s${result.score}`}>{result.score}/5</div>
            <div style={{ lineHeight: 1.55 }}>{result.verdict}</div>
          </div>
          {result.strengths?.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="label" style={{ color: '#3fb950' }}>Did well</div>
              {result.strengths.map((s, i) => <div key={i} className="muted">• {s}</div>)}
            </div>
          )}
          {result.missing?.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="label" style={{ color: '#d29922' }}>Missing</div>
              {result.missing.map((s, i) => <div key={i} className="muted">• {s}</div>)}
            </div>
          )}
          {result.modelAnswer && (
            <div style={{ marginTop: 8 }}>
              <div className="label">A strong answer</div>
              <div style={{ lineHeight: 1.6 }}>{result.modelAnswer}</div>
            </div>
          )}
          {result.followUp && (
            <div className="evidence" style={{ marginTop: 8 }}>
              They&apos;d follow up with: <strong>{result.followUp}</strong>
            </div>
          )}
          <button className="primary" style={{ marginTop: 10 }} onClick={getQuestion} disabled={busy}>Next question →</button>
        </div>
      )}
      {result && !result.ok && <div className="evidence" style={{ marginTop: 10 }}>{result.reason}</div>}
    </div>
  );
}

// Paste a recruiter reply → it says what the reply means and which application it's
// about, then offers the status change. Never auto-applies: a wrong update silently
// corrupts the funnel numbers you rely on.
function InboxParser({ profileId, onUpdated }) {
  const [text, setText] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);

  const parse = async () => {
    if (!text.trim()) return;
    setBusy(true); setRes(null);
    try {
      const r = await fetch('/api/intel', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'email', profile_id: profileId, text }),
      }).then((x) => x.json()).catch((e) => ({ ok: false, reason: String(e?.message || e) }));
      setRes(r);
    } finally { setBusy(false); }
  };

  const applyUpdate = async (jobId, stage) => {
    await fetch('/api/tracker', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, status: stage }),
    });
    setRes(null); setText('');
    onUpdated && onUpdated();
  };

  return (
    <div className="card">
      <strong>📧 Recruiter reply</strong>
      <div className="muted" style={{ fontSize: 12, margin: '6px 0 8px' }}>
        Paste a reply and it works out which application it&apos;s about and what stage it means.
        Nothing connects to your mailbox — no email password is stored anywhere.
      </div>
      <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)}
        placeholder="Paste the email here…" />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" onClick={parse} disabled={busy || !text.trim()}>
          {busy ? 'Reading…' : 'Parse'}
        </button>
      </div>

      {res?.ok && (
        <div style={{ marginTop: 12, borderTop: '1px solid #30363d', paddingTop: 10 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className={`status ${res.verdict.stage}`}>{res.verdict.stage}</span>
            <span className="muted">confidence: {res.verdict.confidence}</span>
          </div>
          <div style={{ marginTop: 6, lineHeight: 1.55 }}>{res.verdict.summary}</div>
          {res.verdict.action && <div className="evidence" style={{ marginTop: 6 }}>Next: {res.verdict.action}</div>}
          {res.verdict.date && <div className="muted" style={{ marginTop: 4 }}>Date mentioned: {res.verdict.date}</div>}

          <div style={{ marginTop: 10 }}>
            <div className="label">Which application?</div>
            {res.match.candidates?.length > 0 ? res.match.candidates.map((c) => (
              <div key={c.id} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                <span>{c.title} <span className="muted">@ {c.company}</span></span>
                <button onClick={() => applyUpdate(c.id, res.verdict.stage)}
                  disabled={res.verdict.stage === 'unknown'}>
                  set to {res.verdict.stage}
                </button>
              </div>
            )) : <div className="muted">No matching saved job — update it manually on the Jobs tab.</div>}
          </div>
        </div>
      )}
      {res && !res.ok && <div className="evidence" style={{ marginTop: 10 }}>{res.reason}</div>}
    </div>
  );
}

// Minimal markdown renderer for synthesized prep notes. Deliberately tiny — the
// note bodies only ever use ##, **bold**, *italic* and "- " bullets, so pulling in
// a markdown dependency would be overkill. Everything is escaped first, so LLM
// output can never inject HTML.
function renderNoteHtml(md) {
  const esc = String(md || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return esc
    .split('\n')
    .map((line) => {
      if (/^##\s+/.test(line)) return `<h3 class="note-h">${line.replace(/^##\s+/, '')}</h3>`;
      // "> Your angle: …" — the optional personal hook, rendered as a secondary aside
      // so the production-grade answer above it stays the main event.
      if (/^&gt;\s*Your angle:/.test(line)) {
        return `<div class="note-angle">${line.replace(/^&gt;\s*/, '')}</div>`;
      }
      if (/^\d+\.\s+/.test(line)) return `<div class="note-li">${line}</div>`;
      if (/^-\s+/.test(line)) return `<div class="note-li">• ${line.replace(/^-\s+/, '')}</div>`;
      if (line.trim() === '') return '<div class="note-sp"></div>';
      return `<div>${line}</div>`;
    })
    .join('')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

// Interview Prep tab: synthesized study material + a Q&A bot grounded in it.
function InterviewPrep({ profileId, flash }) {
  const [notes, setNotes] = useState([]);
  const [stats, setStats] = useState(null);
  const [vision, setVision] = useState(null);
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [asking, setAsking] = useState(false);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/prep?profile_id=${encodeURIComponent(profileId)}`).then((x) => x.json());
    if (r.error) return;
    setNotes(r.notes || []);
    setStats(r.stats || null);
    setVision(r.vision || null);
    // Open the daily plan by default.
    const daily = (r.notes || []).find((n) => n.kind === 'daily');
    setOpenId((cur) => cur || daily?.id || (r.notes || [])[0]?.id || null);
  }, [profileId]);

  useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    setBusy(true);
    flash('Refreshing prep material — watch the Activity panel below. This takes several minutes.');
    try {
      const r = await fetch('/api/prep', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile_id: profileId }),
      }).then((x) => x.json()).catch((e) => ({ error: String(e?.message || e) }));
      if (r.error) flash(`Prep refresh failed: ${r.error}`);
      else flash(`Prep updated — ${r.synth?.notesWritten || 0} topic(s) from ${r.collected?.collected || 0} sources in ${r.seconds}s.`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  // Ask the bot. If the knowledge base doesn't cover the question, the server
  // researches the topic live, writes a note, and answers from it — so the KB grows
  // with every question. `force` re-researches even if we already have material.
  const ask = async (force = false) => {
    const q = question.trim();
    if (!q) return;
    setAsking(true);
    setAnswer(null);
    try {
      const r = await fetch('/api/prep/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile_id: profileId, question: q, force }),
      }).then((x) => x.json()).catch((e) => ({ error: String(e?.message || e) }));
      setAnswer(r.error ? { answer: `Error: ${r.error}`, sources: [], grounded: false } : r);
      // A newly-learned topic means there's a new note + links to show.
      if (r.newlyLearned) await load();
    } finally {
      setAsking(false);
    }
  };

  const daily = notes.find((n) => n.kind === 'daily');
  const topics = notes.filter((n) => n.kind !== 'daily');

  return (
    <div>
      <div className="card" style={{ background: '#1f6feb15', borderColor: '#1f6feb55' }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="label" style={{ color: '#58a6ff' }}>Your synthesized study material</div>
            <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.6 }}>
              Topics are matched from your saved job descriptions against a curated list of real, studiable
              skills — <strong>never invented and never random words scraped from an ad</strong>. Each one is ranked
              by how many of your ads demand it, then researched for <strong>official docs to learn from</strong> and
              <strong> real interview questions</strong>, with every link shown so you can go read the source.
            </div>
            {stats && (
              <div className="muted" style={{ marginTop: 8 }}>
                {stats.notes} topic{stats.notes === 1 ? '' : 's'} · {stats.sources} source{stats.sources === 1 ? '' : 's'} ·{' '}
                {stats.chunks} indexed chunk{stats.chunks === 1 ? '' : 's'}
                {stats.lastRefreshDay ? ` · last updated ${stats.lastRefreshDay}` : ' · never refreshed'}
              </div>
            )}
          </div>
          <button className="primary" onClick={refresh} disabled={busy}>
            {busy ? 'Refreshing…' : '↻ Refresh prep'}
          </button>
        </div>
        {vision && !vision.available && (
          <div className="muted" style={{ marginTop: 10, borderTop: '1px solid #30363d', paddingTop: 8 }}>
            🖼 Image extraction is off — no vision model installed. Your chat model (qwen2.5) is text-only.
            To read screenshots and diagrams found in posts, run:{' '}
            <code style={{ color: '#d29922' }}>ollama pull moondream</code>
          </div>
        )}
      </div>

      {/* Ask-the-bot */}
      <div className="card">
        <div className="label" style={{ marginBottom: 8 }}>Ask your prep bot</div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          Ask anything — including concepts not in your job ads. If it isn&apos;t in your knowledge base yet,
          it gets researched online, written up, and <strong>added permanently</strong> with links.
        </div>
        <div className="row">
          <input
            placeholder="e.g. explain MCP in detail, or: how do you train a model on proprietary data?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !asking) ask(false); }}
          />
          <button className="primary" onClick={() => ask(false)} disabled={asking || !question.trim()}>
            {asking ? 'Working…' : 'Ask'}
          </button>
          <button
            onClick={() => ask(true)}
            disabled={asking || !question.trim()}
            title="Ignore existing material and research this topic online from scratch, then add it to your knowledge base."
            style={{ background: '#8b5cf622', borderColor: '#8b5cf6', color: '#a78bfa', whiteSpace: 'nowrap' }}
          >
            🔎 Research fresh
          </button>
        </div>
        {asking && (
          <div className="muted" style={{ marginTop: 8 }}>
            If this topic is new it&apos;s being researched and written up now — watch the Activity panel below.
            That takes a couple of minutes on a local model.
          </div>
        )}
        {answer && (
          <div style={{ marginTop: 12, borderTop: '1px solid #30363d', paddingTop: 12 }}>
            {answer.newlyLearned && (
              <div className="evidence" style={{ borderLeftColor: '#3fb950', background: '#3fb95010', marginBottom: 10 }}>
                ✨ New: <strong>{answer.newlyLearned.topic}</strong> researched from{' '}
                {answer.newlyLearned.sources} source{answer.newlyLearned.sources === 1 ? '' : 's'} and added to your
                knowledge base — it now has its own card below.
              </div>
            )}
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: 14 }}>{answer.answer}</div>

            {/* Links from a freshly-researched topic */}
            {answer.references?.length > 0 && (
              <div className="refs">
                <div className="label" style={{ marginBottom: 6 }}>Sources for this answer</div>
                {answer.references.map((r) => (
                  <div key={r.n} className="ref-item">
                    <span className="ref-n">[{r.n}]</span>
                    <span className="ref-kind">{r.kind}</span>
                    <a href={r.url} target="_blank" rel="noopener noreferrer">{r.title || r.url}</a>
                  </div>
                ))}
              </div>
            )}

            {!answer.references?.length && answer.sources?.length > 0 && (
              <div className="muted" style={{ marginTop: 10 }}>
                Grounded in: {answer.sources.map((s, i) => `[${i + 1}] ${s.topic}`).join('  ')}
              </div>
            )}
            {answer.researchFailed && (
              <div className="muted" style={{ marginTop: 8, color: '#d29922' }}>
                ⚠ Couldn&apos;t research that topic: {answer.researchFailed}
              </div>
            )}
          </div>
        )}
      </div>

      {notes.length === 0 && (
        <div className="card muted">
          No study material yet. Make sure you&apos;ve <strong>scanned some jobs first</strong> — prep reads their
          descriptions to work out what to study. Then hit <strong>↻ Refresh prep</strong> above. Expect several
          minutes on an 8B model.
        </div>
      )}

      {/* Today's plan, highlighted */}
      {daily && (
        <div className="card" style={{ borderColor: '#3fb95055' }}>
          <div className="label" style={{ color: '#3fb950' }}>Today&apos;s plan</div>
          <div
            className="note-body"
            style={{ marginTop: 8 }}
            dangerouslySetInnerHTML={{ __html: renderNoteHtml(daily.body) }}
          />
        </div>
      )}

      {/* Skill notes, ranked by how many saved job ads demand them */}
      {topics.map((n) => {
        let refs = [];
        let jobs = [];
        try {
          const parsed = n.sources_json ? JSON.parse(n.sources_json) : {};
          refs = parsed.references || [];
          jobs = parsed.jobs || [];
        } catch { /* malformed — just show no links */ }
        const open = openId === n.id;
        return (
          <div className="card" key={n.id} style={{ paddingBottom: open ? 16 : 12 }}>
            <div
              className="row"
              style={{ justifyContent: 'space-between', cursor: 'pointer', alignItems: 'flex-start' }}
              onClick={() => setOpenId(open ? null : n.id)}
            >
              <div>
                <strong>{open ? '▾' : '▸'} {n.topic}</strong>
                {n.demand > 0 && (
                  <span className="tag" style={{ marginLeft: 8 }}>
                    in {n.demand} job ad{n.demand === 1 ? '' : 's'}
                  </span>
                )}
                {refs.length > 0 && <span className="muted" style={{ marginLeft: 6 }}>· {refs.length} sources</span>}
              </div>
              <span className="muted">{n.day || ''}</span>
            </div>

            {/* Why this topic is here — the verbatim JD requirement */}
            {n.evidence && (
              <div className="evidence">
                <span className="muted">From a job description you saved:</span> “{n.evidence}”
                {jobs.length > 0 && (
                  <div className="muted" style={{ marginTop: 4 }}>
                    Required by: {jobs.slice(0, 4).map((j) => `${j.title}${j.company ? ' @ ' + j.company : ''}`).join(' · ')}
                  </div>
                )}
              </div>
            )}

            {open && (
              <>
                <div
                  className="note-body"
                  style={{ marginTop: 10 }}
                  dangerouslySetInnerHTML={{ __html: renderNoteHtml(n.body) }}
                />
                {refs.length > 0 && (
                  <div className="refs">
                    {[
                      ['learn', '📘 Learn it here', 'Official docs and tutorials — go read these'],
                      ['interview', '🎯 Interview questions', 'Real questions people were asked'],
                      ['discussion', '💬 Practitioner discussion', 'What actually bites people in production'],
                      ['reference', '🔗 Other references', ''],
                    ].map(([purpose, heading, sub]) => {
                      const group = refs.filter((r) => (r.purpose || 'reference') === purpose);
                      if (!group.length) return null;
                      return (
                        <div key={purpose} style={{ marginBottom: 12 }}>
                          <div className="label" style={{ marginBottom: 4 }}>{heading}</div>
                          {sub && <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>{sub}</div>}
                          {group.map((r) => (
                            <div key={r.n} className="ref-item">
                              <span className="ref-n">[{r.n}]</span>
                              <span className="ref-kind">{r.kind}</span>
                              <a href={r.url} target="_blank" rel="noopener noreferrer">{r.title || r.url}</a>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Fixed-bottom terminal panel that subscribes to /api/logs/stream?profile_id=…
// for live progress from autofill / scan / apply flows. Click the bar to collapse
// or expand. Buffer is capped client-side so a long session doesn't bloat memory.
function TerminalPanel({ profileId }) {
  const [lines, setLines] = useState([]);
  const [collapsed, setCollapsed] = useState(false);
  const bodyRef = useRef(null);

  // Tell the page how much room the drawer is taking, so the last card is never
  // stranded underneath it. A fixed element occupies no layout space, so without this
  // the page just appears to end early and no amount of scrolling helps.
  useEffect(() => {
    document.body.classList.toggle('terminal-open', !collapsed);
    return () => document.body.classList.remove('terminal-open');
  }, [collapsed]);

  useEffect(() => {
    if (!profileId) return undefined;
    // Reset on profile switch so we don't show another profile's history.
    setLines([]);
    const es = new EventSource(`/api/logs/stream?profile_id=${encodeURIComponent(profileId)}`);
    es.addEventListener('log', (ev) => {
      try {
        const entry = JSON.parse(ev.data);
        setLines((prev) => {
          const next = prev.concat(entry);
          // Cap client-side buffer at 500 lines.
          return next.length > 500 ? next.slice(next.length - 500) : next;
        });
      } catch { /* malformed event, ignore */ }
    });
    es.onerror = () => {
      // EventSource auto-reconnects; we don't need to do anything here.
    };
    return () => es.close();
  }, [profileId]);

  // Auto-scroll to bottom on new lines, unless the user has scrolled up to read.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || collapsed) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [lines, collapsed]);

  const fmtTime = (ts) => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour12: false });
  };

  return (
    <div className="terminal">
      <div className="terminal-bar" onClick={() => setCollapsed((c) => !c)}>
        <div className="terminal-title">
          {collapsed ? '▸' : '▾'} Activity {lines.length > 0 && <span className="terminal-meta">· {lines.length} line{lines.length === 1 ? '' : 's'}</span>}
        </div>
        <div className="terminal-actions" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => setLines([])} title="Clear the terminal (server buffer is unaffected)">Clear</button>
        </div>
      </div>
      <div ref={bodyRef} className={`terminal-body ${collapsed ? 'collapsed' : ''}`}>
        {lines.length === 0 && <div className="muted">Waiting for activity… hit Autofill, LLM Fill, or Scan to see live progress here.</div>}
        {lines.map((l) => (
          <div key={l.id} className={`terminal-line lvl-${l.level}`}>
            <span className="ts">{fmtTime(l.ts)}</span>{l.message}
          </div>
        ))}
      </div>
    </div>
  );
}

// Base cover letter. Kept on the profile and used two ways: rendered directly with
// {{placeholders}} when there's no LLM, and handed to the tailored writer as the voice
// to match so generated letters still sound like you.
// Per-job letter: generate, edit, copy. Cached on the job so autofill reuses exactly
// what you approved here rather than writing something new into the form.
// Hiring contacts harvested from job ads — the addresses employers print themselves
// next to "send your CV to". Editable, because an inferred name is a guess and a guess
// in an outreach list is worse than a blank.
function ContactsPanel({ profileId, flash }) {
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(null);

  const load = useCallback(async () => {
    const p = new URLSearchParams({ profile_id: profileId, status });
    if (q) p.set('q', q);
    const r = await fetch(`/api/contacts?${p}`).then((x) => x.json()).catch(() => null);
    setRows(r?.contacts || []);
  }, [profileId, status, q]);
  useEffect(() => { load(); }, [load]);

  const backfill = async () => {
    setBusy(true);
    const r = await fetch('/api/contacts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId, action: 'backfill' }),
    }).then((x) => x.json()).catch((e) => ({ error: String(e?.message || e) }));
    setBusy(false);
    if (r.error) { flash(`Failed: ${r.error}`); return; }
    flash(`${r.added} new, ${r.updated} already known — from ${r.scanned} posting(s).`);
    load();
  };

  const patch = async (email, fields) => {
    await fetch('/api/contacts', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId, email, ...fields }),
    }).catch(() => {});
    load();
  };

  const remove = async (email) => {
    if (!confirm(`Remove ${email} from the directory?`)) return;
    await fetch(`/api/contacts?profile_id=${encodeURIComponent(profileId)}&email=${encodeURIComponent(email)}`, { method: 'DELETE' }).catch(() => {});
    load();
  };

  const STATUS_COLOR = { new: '#8b949e', contacted: '#d29922', replied: '#3fb950', ignored: '#6e7681' };

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="label">📇 Hiring contacts ({rows.length})</div>
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.6, maxWidth: 720 }}>
              Addresses that job ads published themselves — “send your CV to …”. Captured
              automatically as you scan. Nothing is crawled to find these and no address is
              ever guessed from a name-and-domain pattern; they come from the posting text.
              Only about 2% of ads include one, so this fills slowly. Hacker News “Who is
              hiring” threads are by far the richest source.
            </div>
          </div>
          <div className="row">
            <button onClick={backfill} disabled={busy} title="Re-read job descriptions already saved">
              {busy ? 'Scanning…' : '↻ Harvest from saved jobs'}
            </button>
            <a
              className="btnlike"
              href={`/api/contacts?profile_id=${encodeURIComponent(profileId)}&format=csv`}
              style={{ display: 'inline-block', padding: '8px 12px', borderRadius: 7, background: '#23863622', border: '1px solid #238636', color: '#3fb950', textDecoration: 'none', fontWeight: 600, fontSize: 13 }}
            >⬇ Export CSV</a>
          </div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <input placeholder="search email / name / company" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 280 }} />
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">all</option>
            <option value="new">new</option>
            <option value="contacted">contacted</option>
            <option value="replied">replied</option>
            <option value="ignored">ignored</option>
          </select>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Email</th><th>Name</th><th>Designation</th><th>Company</th><th>Source</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <React.Fragment key={c.email}>
                <tr>
                  <td data-label="Email">
                    <a href={`mailto:${c.email}`} style={{ fontWeight: 600 }}>{c.email}</a>
                    {c.kind === 'recruiting' && <span className="tag" style={{ marginLeft: 6, fontSize: 10 }}>inbox</span>}
                  </td>
                  <td data-label="Name">{c.name || <span className="muted">—</span>}</td>
                  <td data-label="Designation">{c.designation || <span className="muted">—</span>}</td>
                  <td data-label="Company">{c.company || <span className="muted">—</span>}</td>
                  <td>
                    {c.source_url
                      ? <a href={c.source_url} target="_blank" rel="noreferrer" className="tag">{c.source_connector}</a>
                      : <span className="tag">{c.source_connector || '—'}</span>}
                  </td>
                  <td>
                    <select value={c.status || 'new'} onChange={(e) => patch(c.email, { status: e.target.value })}
                      style={{ color: STATUS_COLOR[c.status] || '#8b949e' }}>
                      {['new', 'contacted', 'replied', 'ignored'].map((sv) => <option key={sv} value={sv}>{sv}</option>)}
                    </select>
                  </td>
                  <td className="row">
                    <button onClick={() => setEdit(edit === c.email ? null : c.email)}>Edit</button>
                    <button className="danger" onClick={() => remove(c.email)}>✗</button>
                  </td>
                </tr>
                {edit === c.email && (
                  <tr>
                    <td colSpan={7} style={{ background: '#0d1117', padding: 12 }}>
                      {c.context && (
                        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                          Found in: “{c.context}”
                        </div>
                      )}
                      <div className="row">
                        {['name', 'designation', 'company'].map((f) => (
                          <input key={f} defaultValue={c[f] || ''} placeholder={f}
                            onBlur={(e) => { if (e.target.value !== (c[f] || '')) patch(c.email, { [f]: e.target.value }); }} />
                        ))}
                      </div>
                      <textarea rows={2} defaultValue={c.notes || ''} placeholder="notes"
                        style={{ marginTop: 6, width: '100%' }}
                        onBlur={(e) => { if (e.target.value !== (c.notes || '')) patch(c.email, { notes: e.target.value }); }} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={7} className="muted" style={{ padding: 16 }}>
                Nothing yet. Scan some jobs, or hit “Harvest from saved jobs” to read the ones you already have.
              </td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </>
  );
}

// Gmail: connect once, then pull job-related mail and see what each message asks for.
//
// The connection is read-only and scoped, and the search is built from your own applied
// companies — so unrelated mail is never requested. Both facts are stated in the UI,
// because "we connected your inbox" is exactly the kind of thing that deserves to be
// explicit rather than buried in a README.
function GmailPanel({ profileId, flash, onUpdated, onStatus }) {
  const [status, setStatus] = useState(null);
  const [emails, setEmails] = useState([]);
  const [busy, setBusy] = useState('');
  // Expanded when unconfigured: hiding first-run instructions behind an extra
  // click is how a feature ends up looking like it was never built.
  const [showSetup, setShowSetup] = useState(false);
  const [showOauth, setShowOauth] = useState(false);
  const [mailUser, setMailUser] = useState('');
  const [mailPass, setMailPass] = useState('');
  const [mailProvider, setMailProvider] = useState('gmail');
  useEffect(() => { if (status && !status.configured) setShowSetup(true); }, [status?.configured]);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [days, setDays] = useState(45);
  const [onlyAction, setOnlyAction] = useState(false);
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/gmail?profile_id=${encodeURIComponent(profileId)}${onlyAction ? '&actionable=1' : ''}`)
      .then((x) => x.json()).catch(() => null);
    if (r?.ok) { setStatus(r.status); setEmails(r.emails || []); onStatus?.(); }
  }, [profileId, onlyAction, onStatus]);
  useEffect(() => { load(); }, [load]);

  const post = async (payload) => {
    const r = await fetch('/api/gmail', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId, ...payload }),
    }).then((x) => x.json()).catch((e) => ({ error: String(e?.message || e) }));
    return r;
  };

  const saveClient = async () => {
    setBusy('saving');
    const r = await post({ action: 'save-client', client_id: clientId.trim(), client_secret: clientSecret.trim() });
    setBusy('');
    if (r.error) { flash(`Could not save: ${r.error}`); return; }
    setClientId(''); setClientSecret('');          // don't keep the secret in component state
    setStatus(r.status);
    flash('Saved. Now click "Connect Gmail".');
  };

  const connectMail = async () => {
    setBusy('mail');
    const r = await post({
      action: 'mail-connect',
      user: mailUser.trim(),
      pass: mailPass,
      provider: mailProvider,
    });
    setBusy('');
    if (!r.ok) { flash(r.error || 'Could not connect.'); return; }
    setMailPass('');                       // don't keep the credential in component state
    flash(`Connected ${r.mail.user}. Hit "Check mail".`);
    load();
  };

  const connect = async () => {
    setBusy('auth');
    const r = await post({ action: 'auth-url' });
    setBusy('');
    if (r.error || !r.url) { flash(r.error || 'Could not build the Google sign-in URL.'); return; }
    window.open(r.url, '_blank', 'noopener');
    flash('Approve access in the new tab, then come back and hit Check mail.');
  };

  const sync = async () => {
    setBusy('sync');
    const r = await post({ action: 'sync', days: Number(days) });
    setBusy('');
    if (r.error) { flash(`Sync failed: ${r.error}`); return; }
    setEmails(r.emails || []);
    await load();
    flash(`${r.added} new · ${r.matched} matched to a job · ${r.needAction} need a reply.`);
  };

  const handled = async (id, v) => { await post({ action: 'handled', id, handled: v }); load(); };

  const applyStage = async (e) => {
    if (!e.job_id || !e.suggested_status) return;
    await fetch('/api/tracker', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: e.job_id, status: e.suggested_status }),
    }).catch(() => {});
    await handled(e.id, true);
    flash(`Moved to ${e.suggested_status}.`);
    onUpdated?.();
  };

  const STAGE_COLOR = {
    rejected: '#f85149', screening: '#d29922', interview: '#58a6ff',
    offer: '#3fb950', applied: '#8b949e', unknown: '#6e7681',
  };

  if (!status) return <div className="card muted">Checking mail connection…</div>;

  return (
    <>
      <div className="card" style={{ borderColor: '#d29922', background: '#d2992209' }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="label" style={{ color: '#e3b341' }}>
              📬 Mailbox {status.connected ? `— ${status.email}` : status.mail?.connected ? `— ${status.mail.user}` : '(not connected)'}
            </div>
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
              {status.connected
                ? <>{status.mail?.connected
                      ? 'Connected over IMAP with an app password (full mailbox access — JobFinder only reads). '
                      : 'Read-only OAuth access, enforced by Google. '}
                    Only messages matching your applied companies and recruiting terms are ever
                    fetched. Revoke at{' '}
                    <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">
                      myaccount.google.com/permissions</a>.
                    {status.lastSync ? ` Last checked ${new Date(status.lastSync).toLocaleString()}.` : ''}</>
                : <>Connect your mailbox so recruiter replies land here automatically, matched to the
                    job they&apos;re about. JobFinder only ever reads, and only messages matching your
                    applied companies — but note the two options below differ: OAuth is read-only
                    <em> enforced by Google</em>, while an app password grants full mailbox access and
                    is trusted not to be misused.</>}
            </div>
          </div>
          <div className="row">
            {(status.connected || status.mail?.connected) ? (
              <>
                <select value={days} onChange={(e) => setDays(e.target.value)} title="How far back to look">
                  <option value={7}>7 days</option>
                  <option value={30}>30 days</option>
                  <option value={45}>45 days</option>
                  <option value={90}>90 days</option>
                </select>
                <button className="primary" onClick={sync} disabled={busy === 'sync'}>
                  {busy === 'sync' ? 'Checking…' : '📥 Check mail'}
                </button>
                <button className="danger" onClick={async () => {
                  if (!confirm('Disconnect the mailbox? Captured messages stay; the stored credential is deleted.')) return;
                  await post({ action: status.mail?.connected ? 'mail-disconnect' : 'disconnect' });
                  flash('Disconnected.');
                  load();
                }}>Disconnect</button>
              </>
            ) : null}
          </div>
        </div>

        {!(status.connected || status.mail?.connected) && (
          <div style={{ marginTop: 12, borderTop: '1px solid #30363d', paddingTop: 12 }}>
            <div className="label" style={{ color: '#3fb950' }}>Recommended — app password (about 2 minutes)</div>
            <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.7, marginBottom: 8 }}>
              This is how mail clients have always connected. No Google Cloud project, nothing
              to verify, and it does not expire.
              <ol style={{ margin: '8px 0 4px 18px', padding: 0 }}>
                <li>Turn on <strong>2-Step Verification</strong> if it is not already —
                  the next step does not appear without it.</li>
                <li>Open <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
                  myaccount.google.com/apppasswords</a> and create one (call it “JobFinder”).</li>
                <li>Paste the 16-character password below. Spaces do not matter.</li>
              </ol>
            </div>
            <div className="row">
              <select value={mailProvider} onChange={(e) => setMailProvider(e.target.value)} style={{ maxWidth: 200 }}>
                {(status.providers || [{ id: 'gmail', label: 'Gmail' }]).map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
              <input
                value={mailUser}
                onChange={(e) => setMailUser(e.target.value)}
                placeholder="you@gmail.com"
                autoComplete="username"
              />
              <input
                value={mailPass}
                onChange={(e) => setMailPass(e.target.value)}
                placeholder="16-character app password"
                type="password"
                autoComplete="current-password"
                onKeyDown={(e) => { if (e.key === 'Enter' && mailUser && mailPass) connectMail(); }}
              />
              <button className="primary" onClick={connectMail} disabled={busy === 'mail' || !mailUser.trim() || !mailPass}>
                {busy === 'mail' ? 'Checking…' : 'Connect'}
              </button>
            </div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
              Verified against the mail server before anything is saved, then stored in
              <code> data/mail.json</code> (mode 0600). It is never sent anywhere but your mail provider.
              Revoke it any time from the same Google page.
            </div>

            <div style={{ marginTop: 14, borderTop: '1px solid #21262d', paddingTop: 10 }}>
              <button onClick={() => setShowOauth(!showOauth)} style={{ background: 'transparent', border: 0, padding: 0, color: '#58a6ff' }}>
                {showOauth ? '▾' : '▸'} Advanced: use Google OAuth instead (no password, but ~10 minutes of setup)
              </button>
              {showOauth && (
                <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.7, marginTop: 8 }}>
                  OAuth needs its own Google Cloud project because Gmail&apos;s read scopes are
                  <strong> restricted</strong> — Google only lets a verified app request them, and
                  verification needs an annual third-party security assessment. A self-hosted tool
                  cannot clear that, so there is no shared “Sign in with Google” button to offer.
                  While the app stays in testing mode the token also expires every 7 days.
                  <ol style={{ margin: '8px 0 8px 18px', padding: 0 }}>
                    <li>Create a project at <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">console.cloud.google.com</a>.</li>
                    <li><strong>APIs &amp; Services → Library</strong> → enable <strong>Gmail API</strong>.</li>
                    <li><strong>OAuth consent screen</strong> → <em>External</em> → add yourself under <strong>Test users</strong>.</li>
                    <li><strong>Credentials → OAuth client ID → Web application</strong>.</li>
                    <li>Authorised redirect URI, exactly:
                      <code style={{ display: 'block', margin: '4px 0', color: '#58a6ff' }}>{status.redirectUri}</code>
                    </li>
                  </ol>
                  <div className="row">
                    <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID (…apps.googleusercontent.com)" />
                    <input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="Client secret" type="password" />
                    <button onClick={saveClient} disabled={!clientId.trim() || !clientSecret.trim() || busy === 'saving'}>Save</button>
                    {status.configured && (
                      <button className="primary" onClick={connect} disabled={busy === 'auth'}>
                        {busy === 'auth' ? 'Opening…' : '🔗 Authorise'}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {(status.connected || status.mail?.connected) && (
        <div className="card" style={{ padding: 0 }}>
          <div className="row" style={{ justifyContent: 'space-between', padding: '10px 12px' }}>
            <div className="label">Captured messages ({emails.length})</div>
            <label className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
              <input type="checkbox" checked={onlyAction} onChange={(e) => setOnlyAction(e.target.checked)} style={{ width: 'auto', marginRight: 5 }} />
              only ones needing a reply
            </label>
          </div>
          <div className="scroll-pane">
            {emails.length === 0 && (
              <div className="muted" style={{ padding: 16 }}>
                Nothing yet — hit “Check mail”.
              </div>
            )}
            {emails.map((e) => (
              <div key={e.id} style={{ borderTop: '1px solid #21262d', padding: '10px 12px', opacity: e.handled ? 0.55 : 1 }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => setOpen(open === e.id ? null : e.id)}>
                    <div>
                      {e.category && (
                        <span className="tag" style={{ color: STAGE_COLOR[e.category] || '#8b949e', marginRight: 6 }}>
                          {e.category}
                        </span>
                      )}
                      <strong>{e.subject || '(no subject)'}</strong>
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {e.from_name || e.from_addr} · {new Date(e.received_at).toLocaleString()}
                      {e.job_title ? ` · → ${e.job_title} @ ${e.job_company}` : ' · no matching job'}
                    </div>
                    {e.summary && <div style={{ fontSize: 13, marginTop: 4 }}>{e.summary}</div>}
                    {e.asks?.length > 0 && (
                      <div style={{ marginTop: 6, background: '#1f6feb14', borderLeft: '3px solid #1f6feb', padding: '6px 10px', borderRadius: 4 }}>
                        <div style={{ fontSize: 11.5, color: '#58a6ff', fontWeight: 600 }}>They&apos;re asking you for</div>
                        <ul style={{ margin: '4px 0 0 16px', padding: 0, fontSize: 13 }}>
                          {e.asks.map((a, i) => <li key={i}>{a}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                  <div className="row">
                    {e.job_id && e.suggested_status && e.job_status !== e.suggested_status && (
                      <button className="primary" onClick={() => applyStage(e)} title={`Move that job to ${e.suggested_status}`}>
                        → {e.suggested_status}
                      </button>
                    )}
                    <button onClick={() => handled(e.id, !e.handled)}>{e.handled ? 'Reopen' : 'Done'}</button>
                  </div>
                </div>
                {open === e.id && (
                  <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, marginTop: 8, maxHeight: 300, overflow: 'auto', background: '#0d1117', padding: 10, borderRadius: 6 }}>
                    {e.bodyPreview}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function CoverLetterPanel({ job, onClose, flash }) {
  const [text, setText] = useState('');
  const [state, setState] = useState('loading');
  const [source, setSource] = useState('');

  const load = useCallback(async () => {
    const r = await fetch(`/api/cover?profile_id=${encodeURIComponent(job.profile_id)}&job_id=${encodeURIComponent(job.id)}`)
      .then((x) => x.json()).catch(() => null);
    if (r?.text) { setText(r.text); setSource('saved'); }
    else if (r?.preview) { setText(r.preview); setSource('your template'); }
    setState('ready');
  }, [job]);
  useEffect(() => { load(); }, [load]);

  const generate = async () => {
    setState('working');
    const r = await fetch('/api/cover', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile_id: job.profile_id, job_id: job.id, mode: 'regenerate' }),
    }).then((x) => x.json()).catch((e) => ({ error: String(e?.message || e) }));
    setState('ready');
    if (r.error) { flash(`Cover letter failed: ${r.error}`); return; }
    setText(r.text || '');
    setSource(r.source || '');
  };

  const save = async () => {
    await fetch('/api/cover', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile_id: job.profile_id, job_id: job.id, text }),
    }).catch(() => {});
    setSource('saved');
    flash('Cover letter saved — autofill will use this exact text.');
  };

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div style={{ padding: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          <div className="label">✉ Cover letter — {job.title}{job.company ? ` @ ${job.company}` : ''}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {state === 'working' ? 'Writing from this job description and your best-matching CV…'
              : `${words} words${source ? ` · ${source}` : ''}. Autofill uses this when a form asks for a cover letter.`}
          </div>
        </div>
        <div className="row">
          <button onClick={generate} disabled={state === 'working'} className="primary">
            {state === 'working' ? 'Writing…' : (text ? 'Regenerate' : 'Write it')}
          </button>
          <button onClick={() => { navigator.clipboard?.writeText(text); flash('Copied.'); }} disabled={!text}>Copy</button>
          <button onClick={save} disabled={!text}>Save</button>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
      <textarea
        rows={14}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="No letter yet — hit “Write it”."
        style={{ width: '100%', fontFamily: 'inherit', lineHeight: 1.6 }}
      />
    </div>
  );
}

function CoverLetterEditor({ profileId }) {
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(true);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    fetch(`/api/cover?profile_id=${encodeURIComponent(profileId)}`)
      .then((r) => r.json())
      .then((r) => { setText(r.template || ''); setSaved(true); })
      .catch(() => {});
  }, [profileId]);

  const save = async () => {
    setMsg('Saving…');
    const r = await fetch('/api/cover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId, template: text }),
    }).then((x) => x.json()).catch((e) => ({ error: String(e?.message || e) }));
    setMsg(r.error ? `Error: ${r.error}` : 'Saved.');
    setSaved(!r.error);
    setTimeout(() => setMsg(''), 2500);
  };

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div className="col" style={{ marginTop: 14 }}>
      <label className="label">Cover letter — your base version</label>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6, lineHeight: 1.55 }}>
        Used verbatim when a form asks for a cover letter and the LLM is unavailable, and used as
        the voice to match when JobFinder tailors one to a specific posting.
        Placeholders get substituted per application:{' '}
        <code>{'{{company}}'}</code> <code>{'{{role}}'}</code> <code>{'{{location}}'}</code>{' '}
        <code>{'{{name}}'}</code> <code>{'{{email}}'}</code>
      </div>
      <textarea
        rows={10}
        value={text}
        onChange={(e) => { setText(e.target.value); setSaved(false); }}
        placeholder={'I am applying for the {{role}} role at {{company}} because…\n\nOver the last N years I have…\n\nI would welcome the chance to discuss how this maps to what your team needs.'}
        style={{ fontFamily: 'inherit', lineHeight: 1.55 }}
      />
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
        <span className="muted" style={{ fontSize: 12 }}>
          {words} words {words > 0 && words < 120 ? '· most postings expect 150–250' : ''}
          {msg ? ` · ${msg}` : ''}
        </span>
        <button className="primary" onClick={save} disabled={saved}>
          {saved ? 'Saved' : 'Save cover letter'}
        </button>
      </div>
    </div>
  );
}

function ResumeUpload({ profileId }) {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [extract, setExtract] = useState(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/profiles/${profileId}/resume`).then((r) => r.json());
    setInfo(r.resume);
  }, [profileId]);

  useEffect(() => { load(); }, [load]);

  const onPick = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== 'application/pdf') { alert('Please pick a PDF.'); return; }
    setBusy(true);
    const form = new FormData();
    form.append('file', file);
    try {
      const r = await fetch(`/api/profiles/${profileId}/resume`, { method: 'POST', body: form }).then((r) => r.json());
      if (r.error) { alert(r.error); return; }
      // Surface whether CV text could be extracted. Silence here would leave fit
      // scoring quietly starved of the one input it depends on.
      setExtract(r.cvText || null);
      await load();
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };

  const onRemove = async () => {
    if (!confirm('Remove resume?')) return;
    await fetch(`/api/profiles/${profileId}/resume`, { method: 'DELETE' });
    await load();
  };

  return (
    <div className="col">
      <label className="label">Resume (PDF — cached in memory for auto-apply)</label>
      {extract && (
        <div className={`evidence`} style={extract.extracted
          ? { borderLeftColor: '#3fb950', background: '#3fb95010' }
          : { borderLeftColor: '#d29922' }}>
          {extract.extracted
            ? `✓ Extracted ${extract.chars.toLocaleString()} characters of CV text — fit scoring and CV gap analysis are now active.`
            : `⚠ Couldn't read text from this PDF (${extract.reason}). Paste your CV into the "CV text" box below so fit scoring works.`}
        </div>
      )}
      {info ? (
        <div className="row" style={{ justifyContent: 'space-between', padding: 10, border: '1px solid #30363d', borderRadius: 6 }}>
          <div>
            📄 <strong>{info.filename}</strong> <span className="muted">({Math.round(info.size / 1024)} KB)</span>
          </div>
          <div className="row">
            <label className="primary" style={{ padding: '6px 12px', borderRadius: 6, background: '#238636', border: '1px solid #238636' }}>
              Replace
              <input type="file" accept="application/pdf" onChange={onPick} style={{ display: 'none' }} />
            </label>
            <button className="danger" onClick={onRemove} disabled={busy}>Remove</button>
          </div>
        </div>
      ) : (
        <label style={{ display: 'inline-block', padding: 12, border: '1px dashed #30363d', borderRadius: 6, cursor: 'pointer', textAlign: 'center' }}>
          {busy ? 'Uploading…' : '⬆️  Click to upload a PDF resume'}
          <input type="file" accept="application/pdf" onChange={onPick} style={{ display: 'none' }} disabled={busy} />
        </label>
      )}
    </div>
  );
}

function ProfileEditor({ profile, onChange, onSave, onDelete }) {
  const filters = (() => { try { return JSON.parse(profile.filters || '{}'); } catch { return {}; } })();
  const setField = (k, v) => onChange({ ...profile, [k]: v });
  const setFilter = (k, v) => onChange({ ...profile, filters: JSON.stringify({ ...filters, [k]: v }) });
  const [llmStatus, setLlmStatus] = useState(null);
  const [pulling, setPulling] = useState(null);

  const checkLLM = async () => {
    setLlmStatus({ checking: true });
    const r = await fetch(`/api/llm?profile_id=${profile.id}`).then((r) => r.json());
    setLlmStatus(r);
  };

  const pullModel = async (modelName) => {
    setPulling(modelName);
    try {
      const r = await fetch('/api/llm/pull', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile_id: profile.id, model: modelName }),
      }).then(r => r.json());
      if (r.error) alert(`Pull failed: ${r.error}`);
      else { alert(`Model ${modelName} pulled successfully!`); await checkLLM(); }
    } catch (e) {
      alert(`Pull error: ${e.message}`);
    } finally {
      setPulling(null);
    }
  };

  return (
    <div className="card">
      <div className="col" style={{ gap: 12 }}>
        <div className="col">
          <label className="label">Name</label>
          <input value={profile.name || ''} onChange={(e) => setField('name', e.target.value)} />
        </div>
        <div className="col">
          <label className="label">Email</label>
          <input value={profile.email || ''} onChange={(e) => setField('email', e.target.value)} />
        </div>
        <ResumeUpload profileId={profile.id} />
        <CoverLetterEditor profileId={profile.id} />
        <CvVariants profileId={profile.id} />

        <div className="col">
          <label className="label">Keywords (comma-separated)</label>
          <input value={profile.keywords || ''} onChange={(e) => setField('keywords', e.target.value)} placeholder="senior backend, golang, distributed systems" />
        </div>
        <div className="col">
          <label className="label">Locations (comma-separated, first is primary)</label>
          <input value={profile.locations || ''} onChange={(e) => setField('locations', e.target.value)} placeholder="Remote, San Francisco, Bangalore" />
        </div>
        <div className="col">
          <label className="label">
            Last working day at your current job
            {(() => {
              const d = filters.last_working_day;
              if (!d) return <span className="muted"> · not set — notice period comes from your answer bank instead</span>;
              const days = Math.max(0, Math.round((new Date(`${d}T00:00:00`) - new Date(new Date().toDateString())) / 86400000));
              return Number.isNaN(days)
                ? <span style={{ color: '#f85149' }}> · not a valid date</span>
                : <span style={{ color: '#3fb950' }}> · notice period answers as <strong>{days} day{days === 1 ? '' : 's'}</strong> today</span>;
            })()}
          </label>
          <input
            type="date"
            value={filters.last_working_day || ''}
            onChange={(e) => setFilter('last_working_day', e.target.value)}
          />
          <div className="muted" style={{ fontSize: 12 }}>
            Set this and &ldquo;notice period&rdquo; is worked out from the date every time a form
            asks, instead of being stored as a number that is wrong tomorrow. Dropdowns get the
            bucket the real figure falls into, always rounding <em>up</em> — claiming you can start
            sooner than you can is the mistake that costs an offer.
          </div>
        </div>

        <div className="col">
          <label className="label">Bio / career summary (used as LLM context for writeups)</label>
          <textarea
            rows={5}
            value={filters.bio || ''}
            onChange={(e) => setFilter('bio', e.target.value)}
            placeholder="Backend engineer with 7 years building distributed systems at scale. Led the payments platform at AcmeCorp..."
          />
        </div>

        <div className="col">
          <label className="label">
            CV text — powers fit scoring and CV gap analysis
            {filters.cv_text
              ? <span style={{ color: '#3fb950' }}> · {filters.cv_text.length.toLocaleString()} chars loaded</span>
              : <span style={{ color: '#d29922' }}> · not set — fit scores will be low-confidence</span>}
          </label>
          <textarea
            rows={8}
            value={filters.cv_text || ''}
            onChange={(e) => setFilter('cv_text', e.target.value)}
            placeholder={
              'Uploading a text-based PDF above fills this automatically.\n\n' +
              'If it stayed empty your PDF is probably a scan (an image), which has no ' +
              'extractable text — open your CV, select all, and paste it here instead.'
            }
          />
          <div className="muted" style={{ fontSize: 12 }}>
            Everything stays on this machine. Fit scoring reads this to work out which of your saved jobs
            actually match, and the CV gap check compares it against each posting&apos;s requirements.
          </div>
        </div>

        <hr style={{ width: '100%', border: 'none', borderTop: '1px solid #30363d' }} />
        <div className="label">Local LLM (Ollama)</div>
        <div className="row" style={{ gap: 12 }}>
          <div className="col" style={{ flex: 2 }}>
            <label className="label">Ollama URL</label>
            <input
              value={filters.llm_url || ''}
              onChange={(e) => setFilter('llm_url', e.target.value)}
              placeholder="http://localhost:11434"
            />
          </div>
          <div className="col" style={{ flex: '1 1 220px' }}>
            <label className="label">Model</label>
            <input
              value={filters.llm_model || ''}
              onChange={(e) => setFilter('llm_model', e.target.value)}
              placeholder="qwen2.5:7b-instruct"
            />
          </div>
          <button onClick={checkLLM} style={{ alignSelf: 'flex-end' }}>Test connection</button>
        </div>
        {llmStatus && (
          <div className="muted" style={{ fontSize: 13 }}>
            {llmStatus.checking
              ? 'Checking…'
              : llmStatus.ok
                ? <>
                    ✅ Ollama @ {llmStatus.url}<br />
                    Chat: <code>{llmStatus.model}</code>{' '}
                    {llmStatus.modelInstalled
                      ? '✓ installed'
                      : <>
                          ✗ NOT installed{' '}
                          <button
                            style={{ fontSize: 12, padding: '2px 8px', marginLeft: 4 }}
                            disabled={!!pulling}
                            onClick={() => pullModel(llmStatus.model)}
                          >
                            {pulling === llmStatus.model ? 'Pulling…' : `Pull ${llmStatus.model}`}
                          </button>
                        </>
                    }<br />
                    Embeddings: <code>{llmStatus.embed_model}</code>{' '}
                    {llmStatus.embedInstalled
                      ? '✓ installed'
                      : <>
                          ✗ NOT installed{' '}
                          <button
                            style={{ fontSize: 12, padding: '2px 8px', marginLeft: 4 }}
                            disabled={!!pulling}
                            onClick={() => pullModel(llmStatus.embed_model)}
                          >
                            {pulling === llmStatus.embed_model ? 'Pulling…' : `Pull ${llmStatus.embed_model}`}
                          </button>
                        </>
                    }
                  </>
                : `❌ ${llmStatus.error || 'unreachable'} (url: ${llmStatus.url}). Start Ollama: ollama serve`}
          </div>
        )}

        <div className="row">
          <button className="primary" onClick={onSave}>Save</button>
          <button className="danger" onClick={onDelete}>Delete profile</button>
        </div>
      </div>
    </div>
  );
}

// Auto-apply: the only screen in this app that can send something to an employer.
//
// Two things are deliberately awkward here, because both protect you:
//   • "Send for real" is a checkbox that resets on every load. It is never remembered,
//     because a persisted arm-switch is precisely the thing that gets left on.
//   • Questions the run could not answer are shown FIRST and block nothing else. The
//     run never guesses at a fact about you; it stops and asks, and one answer
//     unblocks every job waiting on the same question.

function OrchestratorPanel({ profileId, flash }) {
  const [cfg, setCfg] = useState(null);
  const [sched, setSched] = useState(null);
  const [status, setStatus] = useState(null);
  const [sheetInput, setSheetInput] = useState('');
  const [sheetTab, setSheetTab] = useState('Automation Queue');
  const [armed, setArmed] = useState(false);
  const [limit, setLimit] = useState(10);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const load = useCallback(async () => {
    const [config, schedule, state] = await Promise.all([
      fetch('/api/orchestrator-config').then((x) => x.json()).catch(() => null),
      fetch('/api/orchestrator-schedule?profile_id=' + encodeURIComponent(profileId)).then((x) => x.json()).catch(() => null),
      fetch('/api/orchestrator?profile_id=' + encodeURIComponent(profileId)).then((x) => x.json()).catch(() => null),
    ]);
    if (config && !config.error) {
      setCfg(config);
      if (!sheetInput && config.tracker?.spreadsheetId) setSheetInput(config.tracker.spreadsheetId);
      if (config.tracker?.tab) setSheetTab(config.tracker.tab);
    }
    if (schedule && !schedule.error) setSched(schedule);
    if (state && !state.error) setStatus(state);
  }, [profileId, sheetInput]);

  useEffect(() => { load(); }, [profileId]);
  useEffect(() => {
    if (!sched?.enabled) return undefined;
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [sched?.enabled, load]);

  async function saveTracker() {
    setBusy(true);
    try {
      const r = await fetch('/api/orchestrator-config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spreadsheet_url: sheetInput, tab: sheetTab }),
      }).then((x) => x.json());
      if (r.error) return flash?.('Tracker setup failed: ' + r.error);
      setCfg(r);
      if (r.tracker?.spreadsheetId) setSheetInput(r.tracker.spreadsheetId);
      flash?.(r.validated ? 'Tracker connected and validated.' : (r.validationError || 'Tracker saved.'));
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function validateTracker() {
    setBusy(true);
    try {
      const r = await fetch('/api/orchestrator-config', { method: 'POST' }).then((x) => x.json());
      flash?.(r.error ? ('Validation failed: ' + r.error) : 'Tracker connection is healthy.');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function connectGoogle() {
    const r = await fetch('/api/gmail', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'auth-url', profile_id: profileId }),
    }).then((x) => x.json());
    if (r.url) window.open(r.url, '_blank');
    else flash?.(r.error || 'Google OAuth client is not configured yet. Set it in Replies first.');
  }

  async function runQueue() {
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch('/api/orchestrator', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile_id: profileId, armed, limit: Number(limit) || 10 }),
      }).then((x) => x.json());
      setResult(r);
      if (r.error) flash?.('Queue run failed: ' + r.error);
      else flash?.(armed
        ? ('Queue run finished: ' + (r.applied || 0) + ' confirmed application(s).')
        : ('Queue dry run finished: ' + (r.selected || 0) + ' row(s) checked.'));
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function saveSchedule(patch) {
    const r = await fetch('/api/orchestrator-schedule', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId, ...sched, ...patch }),
    }).then((x) => x.json());
    if (r.error) flash?.(r.error);
    else {
      setSched(r.schedule);
      flash?.(r.schedule?.enabled ? '24/7 Sheet scheduler saved.' : '24/7 Sheet scheduler stopped.');
    }
    await load();
  }

  const tracker = cfg?.tracker || {};
  const google = cfg?.google || {};
  const stats = status?.stats || {};

  return (
    <>
      <div className="card" style={{ borderColor: '#58a6ff', background: '#58a6ff0d' }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 420px' }}>
            <div className="label" style={{ color: '#58a6ff' }}>📋 Master 24/7 automation</div>
            <div className="muted">
              The Google Sheet is the source of truth. Newest queued rows run first. LinkedIn/Naukri
              are handled here; company ATS rows move to ATS_QUEUED for the next engine.
            </div>
            <div className="row" style={{ gap: 8, marginTop: 9, flexWrap: 'wrap' }}>
              <span className="tag" style={{ color: tracker.configured ? '#3fb950' : '#d29922' }}>
                Sheet {tracker.configured ? 'configured' : 'not configured'}
              </span>
              <span className="tag" style={{ color: google.connected ? '#3fb950' : '#d29922' }}>
                Google {google.connected ? 'connected' : 'not connected'}
              </span>
              {sched?.enabled && (
                <span className="tag" style={{ color: sched.armed ? '#f85149' : '#3fb950' }}>
                  Scheduler {sched.armed ? 'LIVE' : 'DRY'}
                </span>
              )}
            </div>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button onClick={connectGoogle}>{google.connected ? 'Reconnect Google' : 'Connect Google'}</button>
            {tracker.configured && <button onClick={validateTracker} disabled={busy}>Test tracker</button>}
          </div>
        </div>

        <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <input
            value={sheetInput}
            onChange={(e) => setSheetInput(e.target.value)}
            placeholder="Paste Google Sheet URL or spreadsheet ID"
            style={{ flex: '1 1 420px', minWidth: 260 }}
          />
          <input
            value={sheetTab}
            onChange={(e) => setSheetTab(e.target.value)}
            placeholder="Automation Queue"
            style={{ width: 180 }}
          />
          <button className="primary" onClick={saveTracker} disabled={busy || !sheetInput.trim()}>
            Save + validate
          </button>
        </div>

        {Object.keys(stats).length > 0 && (
          <div className="muted" style={{ marginTop: 10 }}>
            Queue: {Object.entries(stats).map(([k, v]) => k + ': ' + v).join(' · ')}
          </div>
        )}

        <div className="row" style={{ gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="muted">rows
            <input type="number" min="1" max="25" value={limit}
              onChange={(e) => setLimit(e.target.value)} style={{ width: 58, marginLeft: 5 }} />
          </label>
          <label className="row" style={{ gap: 6, alignItems: 'center', padding: '6px 10px', borderRadius: 8,
            border: '1px solid ' + (armed ? '#f85149' : 'var(--border)') }}>
            <input type="checkbox" checked={armed} onChange={(e) => setArmed(e.target.checked)} />
            <span style={{ color: armed ? '#f85149' : 'inherit', fontWeight: 600 }}>Send for real</span>
          </label>
          <button className="primary" disabled={busy || !tracker.configured || !google.connected} onClick={runQueue}>
            {busy ? 'Working…' : armed ? '⚠ Run LIFO queue live' : '🧪 Dry-run LIFO queue'}
          </button>
        </div>

        {result && !result.error && (
          <div className="muted" style={{ marginTop: 8 }}>
            Selected {result.selected || 0} · confirmed {result.applied || 0} ·
            unconfirmed {result.unconfirmed || 0} · action required {result.actionRequired || 0} ·
            ATS queued {result.unsupported || 0}
          </div>
        )}
      </div>

      {sched && (
        <div className="card" style={sched.enabled
          ? { borderColor: sched.armed ? '#f85149' : '#3fb950', background: sched.armed ? '#f8514911' : '#3fb95011' }
          : undefined}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div className="label">🖥️ 24/7 Sheet scheduler</div>
              <div className="muted">
                {sched.enabled
                  ? ('On · ' + (sched.armed ? 'LIVE submissions' : 'dry runs') + (sched.nextRunAt ? ' · next ' + new Date(sched.nextRunAt).toLocaleTimeString() : ''))
                  : 'Off'}
                {sched.running ? ' · run in progress' : ''}
              </div>
              <div className="muted" style={{ marginTop: 4 }}>
                Confirmed today: {sched.sentToday || 0} / {sched.dailyCap || 30}.
                Enabling this disables the old board-driven schedule so both cannot compete.
              </div>
            </div>
            <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <label className="muted">every
                <select value={sched.everyMinutes || 60}
                  onChange={(e) => setSched({ ...sched, everyMinutes: Number(e.target.value) })}
                  style={{ marginLeft: 5 }}>
                  {[15, 20, 30, 60, 120, 240, 480].map((m) => (
                    <option key={m} value={m}>{m < 60 ? m + ' min' : (m / 60) + ' hr'}</option>
                  ))}
                </select>
              </label>
              <label className="muted">rows
                <input type="number" min="1" max="25" value={sched.limit || 10}
                  onChange={(e) => setSched({ ...sched, limit: Number(e.target.value) })}
                  style={{ width: 58, marginLeft: 5 }} />
              </label>
              <label className="muted">cap/day
                <input type="number" min="1" max="200" value={sched.dailyCap || 30}
                  onChange={(e) => setSched({ ...sched, dailyCap: Number(e.target.value) })}
                  style={{ width: 62, marginLeft: 5 }} />
              </label>
              <label className="row" style={{ gap: 5, alignItems: 'center' }}>
                <input type="checkbox" checked={!!sched.armed}
                  onChange={(e) => setSched({ ...sched, armed: e.target.checked })} />
                <span style={{ color: sched.armed ? '#f85149' : 'inherit', fontWeight: 600 }}>Live</span>
              </label>
              {sched.enabled
                ? <button className="danger" onClick={() => saveSchedule({ enabled: false })}>Stop</button>
                : <button className="primary" disabled={!tracker.configured || !google.connected}
                    onClick={() => saveSchedule({ enabled: true })}>Start</button>}
              {sched.enabled && <button onClick={() => saveSchedule({ enabled: true })}>Apply changes</button>}
            </div>
          </div>
          {sched.enabled && sched.armed && (
            <div className="muted" style={{ marginTop: 8, color: '#f85149' }}>
              LIVE mode persists across app restarts and submits from the Sheet without asking each time.
              The daily cap and confirmation checks remain enforced.
            </div>
          )}
        </div>
      )}
    </>
  );
}

function AutoApplyPanel({ profileId, flash }) {
  const [questions, setQuestions] = useState([]);
  const [eligible, setEligible] = useState(0);
  const [byConnector, setByConnector] = useState({});
  const [armed, setArmed] = useState(false);       // never persisted, by design
  const [limit, setLimit] = useState(10);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [sched, setSched] = useState(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/autoapply?profile_id=${profileId}`).then((x) => x.json()).catch(() => ({}));
    setQuestions(r.questions || []);
    setEligible(r.eligible || 0);
    setByConnector(r.byConnector || {});
    const s = await fetch(`/api/autoapply/schedule?profile_id=${profileId}`).then((x) => x.json()).catch(() => null);
    if (s && !s.error) setSched(s);
  }, [profileId]);
  useEffect(() => { load(); }, [load]);
  // While a schedule is on, keep the panel honest about when it next fires.
  useEffect(() => {
    if (!sched?.enabled) return undefined;
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [sched?.enabled, load]);

  async function saveSchedule(patch) {
    const s = await fetch('/api/autoapply/schedule', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId, ...sched, ...patch }),
    }).then((x) => x.json());
    if (!s.error) { setSched(s); flash?.(s.enabled ? 'Schedule saved.' : 'Schedule stopped.'); }
    else flash?.(s.error);
  }

  async function answer(q) {
    const value = (drafts[q.field_key] ?? '').trim();
    if (!value) return;
    await fetch('/api/answers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId, field_key: q.field_key, value, label: q.label }),
    });
    setDrafts((d) => ({ ...d, [q.field_key]: '' }));
    flash?.(`Saved — every job waiting on "${q.field_key}" can go ahead now.`);
    load();
  }

  async function run() {
    setBusy(true); setResult(null);
    try {
      const r = await fetch('/api/autoapply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile_id: profileId, armed, limit: Number(limit) || 10 }),
      }).then((x) => x.json());
      setResult(r);
      flash?.(armed
        ? `Sent ${r.applied || 0} application(s).`
        : `Dry run: ${r.dryRun || 0} form(s) filled and left unsent.`);
      load();
    } catch (e) {
      flash?.(`Auto-apply failed: ${e.message}`);
    } finally { setBusy(false); }
  }

  return (
    <div>
      <OrchestratorPanel profileId={profileId} flash={flash} />
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div className="label">Apply automatically</div>
            <div className="muted">
              Completes LinkedIn <strong>Easy Apply</strong> and Naukri&apos;s <strong>on-site</strong> applications
              using your answer bank. It never invents an answer — anything it does not know
              becomes a question below, and that application waits.
            </div>
            <div className="muted" style={{ marginTop: 6 }}>
              Salary expectations are converted for the employer&apos;s country at equal{' '}
              <strong>purchasing power</strong>, not at the exchange rate — ₹30,00,000 asks for about
              USD 130,000, where a straight conversion would say 36,000 and badly underprice you. Both
              figures go in the log. To fix a figure for one market yourself, add an answer keyed{' '}
              <code>expected salary usd</code> (or <code>gbp</code>, <code>eur</code>, …) in the Answer
              bank — yours always wins.
            </div>
            <div className="muted" style={{ marginTop: 6 }}>
              {eligible} job{eligible === 1 ? '' : 's'} to try
              {Object.keys(byConnector).length
                ? ` (${Object.entries(byConnector).map(([k, v]) => `${k}: ${v}`).join(', ')})`
                : ''}
              {' — '}the two boards run at the same time. Postings past their freshness
              window are left out: they have almost always expired, and trying them is
              where a run&apos;s time used to go.
            </div>
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 5 }}
              title="Per board — 10 means 10 LinkedIn and 10 Naukri, run in parallel">
              max per board
              <input type="number" min="1" max="25" value={limit}
                onChange={(e) => setLimit(e.target.value)} style={{ width: 60 }} />
            </label>
            <label
              className="row"
              style={{ gap: 6, alignItems: 'center', padding: '6px 10px', borderRadius: 8,
                border: `1px solid ${armed ? '#f85149' : 'var(--border)'}`,
                background: armed ? '#f8514915' : 'transparent' }}
              title="Off: fill the forms and stop before Submit. On: actually send them."
            >
              <input type="checkbox" checked={armed} onChange={(e) => setArmed(e.target.checked)} />
              <span style={{ color: armed ? '#f85149' : 'inherit', fontWeight: 600 }}>Send for real</span>
            </label>
            <button className="primary" disabled={busy} onClick={run}>
              {busy ? 'Working…' : armed ? '⚠ Apply for real' : '🧪 Dry run'}
            </button>
          </div>
        </div>
        {armed && (
          <div className="muted" style={{ marginTop: 8, color: '#f85149' }}>
            Applications will be submitted to real employers under your name and cannot be taken back.
          </div>
        )}
      </div>

      {sched && (
        <div
          className="card"
          style={sched.enabled
            ? { borderColor: sched.armed ? '#f85149' : '#3fb950', background: sched.armed ? '#f8514911' : '#3fb95011' }
            : undefined}
        >
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div className="label">
                ⏰ Run on a schedule
                {sched.enabled && (
                  <span style={{ color: sched.armed ? '#f85149' : '#3fb950' }}>
                    {' '}· on, {sched.armed ? 'SENDING FOR REAL' : 'dry runs only'}
                  </span>
                )}
              </div>
              <div className="muted">
                Repeats a batch by itself. {sched.enabled && sched.nextRunAt
                  ? `Next run ${new Date(sched.nextRunAt).toLocaleTimeString()}.`
                  : 'Off.'}
                {sched.running ? ' A run is in progress.' : ''}
              </div>
              {sched.armed && (
                <div className="muted" style={{ marginTop: 4 }}>
                  Sent today: <strong>{sched.sentToday}</strong> of {sched.dailyCap} allowed. The cap counts
                  applications actually sent, so restarting the app cannot reset it.
                </div>
              )}
            </div>
            <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                every
                <select value={sched.everyMinutes} onChange={(e) => setSched({ ...sched, everyMinutes: Number(e.target.value) })}>
                  {[20, 30, 60, 120, 240, 480].map((m) => (
                    <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} hr`}</option>
                  ))}
                </select>
              </label>
              <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                jobs
                <input type="number" min="1" max="25" value={sched.limit}
                  onChange={(e) => setSched({ ...sched, limit: Number(e.target.value) })} style={{ width: 56 }} />
              </label>
              <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                cap/day
                <input type="number" min="1" max="200" value={sched.dailyCap}
                  onChange={(e) => setSched({ ...sched, dailyCap: Number(e.target.value) })} style={{ width: 62 }} />
              </label>
              <label className="muted row" style={{ gap: 5, alignItems: 'center' }}
                title="Scan for new jobs (at most once an hour) before each run. Without this the schedule works through what is already saved and then has nothing left to do.">
                <input type="checkbox" checked={sched.scan !== false} onChange={(e) => setSched({ ...sched, scan: e.target.checked })} />
                also scan
              </label>
              <label className="row" style={{ gap: 6, alignItems: 'center', padding: '6px 10px', borderRadius: 8,
                border: `1px solid ${sched.armed ? '#f85149' : 'var(--border)'}` }}>
                <input type="checkbox" checked={!!sched.armed} onChange={(e) => setSched({ ...sched, armed: e.target.checked })} />
                <span style={{ color: sched.armed ? '#f85149' : 'inherit', fontWeight: 600 }}>Send for real</span>
              </label>
              {sched.enabled
                ? <button className="danger" onClick={() => saveSchedule({ enabled: false })}>Stop</button>
                : <button className="primary" onClick={() => saveSchedule({ enabled: true })}>Start</button>}
              {sched.enabled && <button onClick={() => saveSchedule({ enabled: true })}>Apply changes</button>}
            </div>
          </div>
          {sched.enabled && sched.armed && (
            <div className="muted" style={{ marginTop: 8, color: '#f85149' }}>
              This keeps sending applications while JobFinder is running, without asking again.
              It resumes after a restart — stop it here when you are done.
            </div>
          )}
        </div>
      )}

      {questions.length > 0 && (
        <div className="card" style={{ borderColor: '#d29922', background: '#d2992211' }}>
          <div className="label" style={{ color: '#d29922' }}>
            ❓ {questions.length} question{questions.length === 1 ? '' : 's'} waiting on you
          </div>
          <div className="muted">
            Forms asked these and your answer bank had nothing for them. Rather than guess a fact
            about you, the run stopped. Answer once and every job asking the same thing continues.
          </div>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {questions.map((q) => (
              <div key={q.field_key} style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                <div><strong>{q.label || q.field_key}</strong></div>
                <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{q.field_key}</div>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {q.options && q.options.length ? (
                    <select
                      value={drafts[q.field_key] ?? ''}
                      onChange={(e) => setDrafts((d) => ({ ...d, [q.field_key]: e.target.value }))}
                      style={{ minWidth: 220 }}
                    >
                      <option value="">Pick one…</option>
                      {q.options.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input
                      value={drafts[q.field_key] ?? ''}
                      placeholder="Your answer"
                      onChange={(e) => setDrafts((d) => ({ ...d, [q.field_key]: e.target.value }))}
                      style={{ flex: 1, minWidth: 220 }}
                    />
                  )}
                  <button className="primary" disabled={!(drafts[q.field_key] || '').trim()} onClick={() => answer(q)}>
                    Save
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {result && (
        <div className="card">
          <div className="label">
            Last run — {result.armed ? 'live' : 'dry run'}
            {result.tookSeconds != null ? ` in ${result.tookSeconds}s` : ''}
            {result.byBoard
              ? ` (${Object.entries(result.byBoard)
                .map(([k, v]) => `${k}: ${v.attempts} attempt${v.attempts === 1 ? '' : 's'} from ${v.opened} opened`)
                .join(', ')})`
              : ''}
            : {result.applied || 0} applied ·{' '}
            {result.dryRun || 0} filled &amp; held · {result.needsInput || 0} waiting on you ·{' '}
            {result.skipped || 0} skipped · {result.errors || 0} error(s)
            {result.abandoned ? ` · ${result.abandoned} given up on` : ''}
          </div>
          <div className="table-wrap scroll-pane" style={{ marginTop: 8 }}>
            <table>
              <thead><tr><th>Job</th><th>Outcome</th></tr></thead>
              <tbody>
                {(result.results || []).map((r) => (
                  <tr key={r.job_id}>
                    <td>
                      <div><strong>{r.title || r.job_id}</strong></div>
                      <div className="muted" style={{ fontSize: 12 }}>{r.company} · {r.connector}</div>
                    </td>
                    <td>
                      <div><span className="tag">{r.state}</span></div>
                      <div className="muted" style={{ fontSize: 12 }}>{r.note}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function AnswerBank({ profileId }) {
  const [rows, setRows] = useState([]);
  const [editing, setEditing] = useState(null); // { field_key, value, label }
  // Review queue: everything captured from a page waits here. Nothing in this list is
  // visible to autofill or to the LLM until you approve it.
  const [pending, setPending] = useState([]);
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const [identity, setIdentity] = useState([]);
  const [idDraft, setIdDraft] = useState({});
  const [idError, setIdError] = useState({});

  const load = useCallback(async () => {
    const r = await fetch(`/api/answers?profile_id=${profileId}`).then((r) => r.json());
    // Questions only. Personal details have their own section and their own rules.
    setRows(r.questions || r.answers || []);
    setIdentity(r.identity || []);
    const p = await fetch(`/api/answers/review?profile_id=${profileId}&status=pending`)
      .then((x) => x.json()).catch(() => ({ answers: [] }));
    setPending(p.answers || []);
    setPicked(new Set((p.answers || []).map((a) => a.field_key))); // pre-select all
  }, [profileId]);
  useEffect(() => { load(); }, [load]);

  const review = async (decision, keys) => {
    setBusy(true);
    try {
      await fetch('/api/answers/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile_id: profileId, decision, keys }),
      });
      await load();
    } finally { setBusy(false); }
  };

  const toggle = (key) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const save = async () => {
    if (!editing) return;
    await fetch('/api/answers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId, ...editing }),
    });
    setEditing(null);
    load();
  };

  const remove = async (field_key) => {
    if (!confirm('Delete this answer?')) return;
    await fetch(`/api/answers?profile_id=${profileId}&field_key=${encodeURIComponent(field_key)}`, { method: 'DELETE' });
    load();
  };

  const allPicked = pending.length > 0 && picked.size === pending.length;

  async function saveIdentity(f) {
    const value = (idDraft[f.field_key] ?? f.value ?? '').trim();
    const res = await fetch('/api/answers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId, field_key: f.field_key, value, label: f.label }),
    }).then((x) => x.json());
    if (res.error) { setIdError((e) => ({ ...e, [f.field_key]: res.error })); return; }
    setIdError((e) => ({ ...e, [f.field_key]: '' }));
    setIdDraft((d) => { const n2 = { ...d }; delete n2[f.field_key]; return n2; });
    load();
  }

  const groups = [...new Set(identity.map((f) => f.group))];
  const idMissing = identity.filter((f) => !f.ok).length;

  return (
    <div>
      {/* ── Personal information ─────────────────────────────────────────────
          Separate from the answer bank because it behaves differently: a short
          fixed list, confirmed once, where a wrong value is not a bad answer but
          a wrong fact typed into an employer's form. */}
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div className="label">
              👤 Personal information
              {idMissing > 0 && <span style={{ color: '#d29922' }}> · {idMissing} to fill in</span>}
            </div>
            <div className="muted">
              The facts that do not change. Set them once and they are used everywhere. These are
              kept apart from the answer bank and checked for shape — an email has to look like an
              email, so a stray &ldquo;Yes&rdquo; can never be typed into an employer&apos;s address box.
            </div>
          </div>
        </div>

        {groups.map((g) => (
          <div key={g} style={{ marginTop: 12 }}>
            <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>{g}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
              {identity.filter((f) => f.group === g).map((f) => {
                const dirty = idDraft[f.field_key] !== undefined && idDraft[f.field_key] !== f.value;
                return (
                  <div key={f.field_key}>
                    <label className="label" style={{ fontSize: 12 }}>
                      {f.label}
                      {f.ok
                        ? <span style={{ color: '#3fb950' }}> ✓</span>
                        : <span style={{ color: '#d29922' }}> · {f.status === 'missing' ? 'not set' : 'needs your attention'}</span>}
                    </label>
                    <div className="row" style={{ gap: 6 }}>
                      <input
                        value={idDraft[f.field_key] ?? f.value ?? ''}
                        placeholder={f.placeholder}
                        onChange={(e) => setIdDraft((d) => ({ ...d, [f.field_key]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveIdentity(f); }}
                        style={{ flex: 1, borderColor: idError[f.field_key] ? '#f85149' : undefined }}
                      />
                      {dirty && <button className="primary" onClick={() => saveIdentity(f)}>Save</button>}
                    </div>
                    {idError[f.field_key] && (
                      <div className="muted" style={{ color: '#f85149', fontSize: 12 }}>{idError[f.field_key]}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {pending.length > 0 && (
        <div className="card" style={{ borderColor: '#d29922', background: '#d2992211' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div className="label" style={{ color: '#d29922' }}>
                ⚠ {pending.length} new answer{pending.length === 1 ? '' : 's'} awaiting your review
              </div>
              <div className="muted">
                Captured from pages you filled. Autofill and the LLM <strong>cannot use any of these
                yet</strong>. Approve the ones that are right; reject the rest and they will not be
                captured again.
              </div>
            </div>
            <div className="row">
              <button onClick={() => setPicked(allPicked ? new Set() : new Set(pending.map((a) => a.field_key)))}>
                {allPicked ? 'Select none' : 'Select all'}
              </button>
              <button
                className="primary"
                disabled={busy || !picked.size}
                onClick={() => review('approved', [...picked])}
                style={{ background: '#23863622', borderColor: '#238636', color: '#3fb950' }}
              >✓ Approve {picked.size || ''}</button>
              <button
                className="danger"
                disabled={busy || !picked.size}
                onClick={() => review('rejected', [...picked])}
              >✗ Reject {picked.size || ''}</button>
            </div>
          </div>

          <div className="table-wrap scroll-pane" style={{ marginTop: 10 }}>
            <table>
              <thead>
                <tr><th style={{ width: 30 }}></th><th>Field</th><th>Captured value</th><th></th></tr>
              </thead>
              <tbody>
                {pending.map((a) => (
                  <tr key={a.field_key}>
                    <td>
                      <input
                        type="checkbox"
                        checked={picked.has(a.field_key)}
                        onChange={() => toggle(a.field_key)}
                      />
                    </td>
                    <td>
                      <div><strong>{a.label || a.field_key}</strong></div>
                      <div className="muted" style={{ fontSize: 12 }}>{a.field_key}</div>
                    </td>
                    <td style={{ maxWidth: 480, whiteSpace: 'pre-wrap' }}>{a.value}</td>
                    <td className="row">
                      <button onClick={() => review('approved', [a.field_key])} title="Approve just this one">✓</button>
                      <button className="danger" onClick={() => review('rejected', [a.field_key])} title="Reject just this one">✗</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <div className="label">
              💬 Answer bank
              <span className="muted" style={{ fontWeight: 400 }}> · replies to questions employers asked</span>
            </div>
            <div className="muted">
              {rows.filter((r) => (r.status || 'approved') === 'approved').length} approved
              {rows.some((r) => r.status === 'rejected') ? `, ${rows.filter((r) => r.status === 'rejected').length} rejected` : ''}
              {' '}of {rows.length} captured. Only approved answers are used to fill applications.
            </div>
          </div>
          <div className="row">
            <button onClick={async () => {
              const r = await fetch('/api/llm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile_id: profileId, backfill: true }) }).then((r) => r.json());
              alert(`Re-indexed ${r.backfilled ?? 0} answers for semantic search.`);
              load();
            }} title="Compute embeddings for any answers added before this feature shipped">Reindex bank</button>
            <button className="primary" onClick={() => setEditing({ field_key: '', label: '', value: '' })}>+ Add manually</button>
          </div>
        </div>
      </div>

      {editing && (
        <div className="card">
          <div className="col" style={{ gap: 8 }}>
            <div className="col">
              <label className="label">Field key (normalized — what the autofill matches)</label>
              <input value={editing.field_key} onChange={(e) => setEditing({ ...editing, field_key: e.target.value.toLowerCase() })} placeholder="years of experience" />
            </div>
            <div className="col">
              <label className="label">Label (original)</label>
              <input value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} />
            </div>
            <div className="col">
              <label className="label">Value</label>
              <textarea rows={3} value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} />
            </div>
            <div className="row">
              <button className="primary" onClick={save}>Save</button>
              <button onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Field</th><th>Value</th><th>Status</th><th>Hits</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.field_key}>
                <td>
                  <div><strong>{r.label || r.field_key}</strong></div>
                  <div className="muted" style={{ fontSize: 12 }}>{r.field_key}</div>
                </td>
                <td style={{ maxWidth: 500, whiteSpace: 'pre-wrap' }}>{r.value}</td>
                <td>
                  {r.status === 'rejected' ? <span className="tag" style={{ color: '#f85149' }}>rejected</span>
                    : r.status === 'pending' ? <span className="tag" style={{ color: '#d29922' }}>pending</span>
                    : <span className="tag" style={{ color: '#3fb950' }}>approved</span>}
                </td>
                <td>{r.hit_count}</td>
                <td className="row">
                  <button onClick={() => setEditing({ field_key: r.field_key, label: r.label || '', value: r.value || '' })}>Edit</button>
                  <button className="danger" onClick={() => remove(r.field_key)}>Delete</button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={5} className="muted" style={{ padding: 16 }}>
                No answers yet. Open a job application and start typing — fields are captured automatically.
              </td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}
