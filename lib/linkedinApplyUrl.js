// Accept only the LinkedIn apply route for the selected posting. Never
// navigate to a different job, a redirected employer or an attacker URL.
export function linkedinOwnApplyUrl(jobId, href) {
  try {
    if (!/^\d{6,}$/.test(String(jobId || ''))) return null;
    const url = new URL(String(href || ''), 'https://www.linkedin.com');
    const host = url.hostname.toLowerCase();
    if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;
    if (url.pathname.replace(/\/+$/, '') !== '/jobs/view/' + jobId + '/apply') return null;
    return url.href;
  } catch {
    return null;
  }
}
