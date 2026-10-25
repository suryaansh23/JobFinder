// Conservative guard for broad third-party feeds that do not support
// server-side geographic targeting. "Remote" is not a universal work permit:
// a role explicitly located in France/Switzerland is not a worldwide remote job.
const ALIASES = {
  'delhi ncr': ['delhi', 'new delhi', 'gurugram', 'gurgaon', 'noida', 'greater noida', 'faridabad', 'ghaziabad'],
  delhi: ['delhi', 'new delhi'],
  gurugram: ['gurugram', 'gurgaon'],
  noida: ['noida', 'greater noida'],
  jaipur: ['jaipur'],
  chandigarh: ['chandigarh', 'mohali', 'panchkula'],
  ludhiana: ['ludhiana'],
  dubai: ['dubai'],
  'abu dhabi': ['abu dhabi'],
  riyadh: ['riyadh'],
  jeddah: ['jeddah'],
  doha: ['doha'],
  muscat: ['muscat'],
  manama: ['manama'],
  'kuwait city': ['kuwait city'],
};
const normalize = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const hasPhrase = (text, term) => (' ' + text + ' ').includes(' ' + term + ' ');

export function locationMatchesProfile(location, profileLocations) {
  const wants = String(profileLocations || '').split(',').map(normalize).filter(Boolean);
  if (!wants.length) return true;
  const loc = normalize(location);
  if (!loc) return false;

  // Only unqualified remote/anywhere is provisionally within scope. Remote
  // plus a country/city remains region-bound unless it matches user locations.
  if (wants.includes('remote') && /^(remote|worldwide|anywhere|work from anywhere|global remote|remote worldwide)$/.test(loc)) return true;

  const geographic = wants.filter((x) => x !== 'remote' && x !== 'hybrid');
  for (const preference of geographic) {
    const terms = ALIASES[preference] || [preference];
    if (terms.some((alias) => hasPhrase(loc, alias))) return true;
  }
  return false;
}

export function likelyMarketingConsultingTitle(title) {
  const t = normalize(title);
  // Broad enough for the profile's marketing/GTM/strategy/consultancy remit,
  // but not "AI Engineer (growth team)" with marketing mentioned only in a JD.
  return /\b(marketing|marketeer|marketeers|brand|growth|strategic|strategy|consultant|consulting|consultancy|crm|lifecycle|marcom|demand generation|demand gen|market research|consumer insights|customer insights|campaign|category|commercial|go to market|gtm|media planning|media strategy|partnerships|trade marketing)\b/.test(t);
}

export function relevantArbeitnowJob(job, profile) {
  return likelyMarketingConsultingTitle(job?.title)
    && locationMatchesProfile(job?.location || (job?.remote ? 'Remote' : ''), profile?.locations);
}
