// A login/challenge redirect must never be classified as an external job.
// Keep the check intentionally narrow: normal LinkedIn job pages can include
// sign-in banners while still exposing usable Easy Apply controls.
export function isLinkedInAuthWallUrl(url) {
  try {
    const page = new URL(String(url || ''));
    if (!/(^|\.)linkedin\.com$/i.test(page.hostname)) return false;
    return /^\/(?:uas\/)?(?:login|checkpoint|authwall)(?:\/|$)/i.test(page.pathname);
  } catch {
    return false;
  }
}
