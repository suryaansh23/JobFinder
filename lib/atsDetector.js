const RULES = [
  { key: 'workday', hosts: ['myworkdayjobs.com', 'workday.com'], re: /\/wd\d+\/|\/job\//i },
  { key: 'greenhouse', hosts: ['greenhouse.io', 'boards.greenhouse.io'], re: /\/jobs\//i },
  { key: 'lever', hosts: ['lever.co', 'jobs.lever.co'], re: /\/[^/]+\/[a-f0-9-]{8,}/i },
  { key: 'smartrecruiters', hosts: ['smartrecruiters.com', 'jobs.smartrecruiters.com'], re: /\/[^/]+\/\d+/i },
  { key: 'successfactors', hosts: ['successfactors.com'], re: /career|job/i },
  { key: 'icims', hosts: ['icims.com'], re: /jobs\/\d+/i },
];

function hostOf(url='') {
  try { return new URL(url).hostname.toLowerCase(); }
  catch { return ''; }
}

export function detectAts(url='') {
  const host = hostOf(url);
  if (!host) return { key: 'unknown', supported: false, host: '' };

  for (const rule of RULES) {
    if (rule.hosts.some((h) => host === h || host.endsWith('.' + h))) {
      return {
        key: rule.key,
        supported: true,
        host,
        confidence: rule.re.test(String(url)) ? 'high' : 'medium',
      };
    }
  }

  return { key: 'generic', supported: false, host, confidence: 'low' };
}

export function isSupportedAts(url='') {
  return detectAts(url).supported;
}
