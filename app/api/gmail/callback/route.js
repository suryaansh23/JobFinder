// Where Google sends the browser back after you approve access.
//
// Renders a small self-contained page rather than redirecting into the dashboard, so
// the result is legible even if this opened in a stray tab. The authorisation code is
// exchanged server-side and never reaches the page.

import { exchangeCode } from '../../../../lib/gmail.js';

export const dynamic = 'force-dynamic';

function page(title, message, ok) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>
     <body style="font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
       <div style="max-width:460px;padding:28px;border:1px solid #30363d;border-radius:12px;background:#161b22">
         <div style="font-size:34px">${ok ? '✅' : '⚠️'}</div>
         <h2 style="margin:10px 0 6px;color:${ok ? '#3fb950' : '#f85149'}">${title}</h2>
         <p style="color:#8b949e;margin:0 0 18px">${message}</p>
         <a href="/" style="color:#58a6ff">← Back to JobFinder</a>
       </div>
     </body>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

export async function GET(req) {
  const { searchParams, origin } = new URL(req.url);
  const err = searchParams.get('error');
  if (err) return page('Gmail not connected', `Google returned: ${err}. Nothing was saved.`, false);

  const code = searchParams.get('code');
  if (!code) return page('Gmail not connected', 'No authorisation code came back from Google.', false);

  try {
    const status = await exchangeCode(code, `${origin}/api/gmail/callback`);
    return page(
      'Gmail connected',
      `Google connected for ${status.email || 'your account'}. Gmail remains read-only; JobFinder can also read and update only the tracker Sheet you configure. Revoke any time at myaccount.google.com/permissions.`,
      true
    );
  } catch (e) {
    return page('Gmail not connected', String(e?.message || e).slice(0, 220), false);
  }
}
