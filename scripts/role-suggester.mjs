#!/usr/bin/env node
/**
 * Suggests hiring.cafe search terms based on the parsed CV (cv-parsed.json).
 *
 * Two flavors (v2.0.3 — config search.mode picks which one drives /jobs
 * suggest and wizard step 5):
 *   - suggestRoles()    → full job titles ("IAM Engineer"). Precise, but a
 *     title the poster didn't use exactly can miss good jobs.
 *   - suggestKeywords() → short domain keywords ("iam", "m365", "linux").
 *     Broader nets; the CV-match scorer + match floor do the precision work.
 *
 * Strategy for both: read the user's parsed skills/certs/titles, match
 * against "domain clusters" (each cluster = signal terms + suggested titles
 * + suggested keywords), and rank by signal density.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Each cluster: if these signals appear in the CV, suggest these titles.
const CLUSTERS = [
  {
    name: 'IAM / Identity',
    signals: ['Okta', 'Auth0', 'CyberArk', 'SailPoint', 'Saviynt', 'BeyondTrust', 'Entra ID', 'Azure AD', 'AWS IAM', 'Ping Identity', 'SCIM', 'JML', 'OIDC', 'SAML', 'OAuth'],
    suggestions: ['IAM Engineer', 'Cloud IAM Engineer', 'Identity Engineer', 'Identity Architect', 'IAM Administrator', 'Identity Operations Engineer'],
    keywords: ['iam', 'identity', 'okta', 'sailpoint']
  },
  {
    name: 'Cloud Security',
    signals: ['CSPM', 'CWPP', 'Defender for Cloud', 'Security Hub', 'GuardDuty', 'Prisma Cloud', 'Aqua Security', 'AWS Security', 'Azure Security', 'GCP Security'],
    suggestions: ['Cloud Security Engineer', 'Cloud Security Architect', 'Cloud Security IAM Engineer', 'Cloud Engineer', 'AWS Security Engineer', 'Azure Security Engineer'],
    keywords: ['cloud security', 'cloud', 'aws security', 'azure security']
  },
  {
    name: 'Cybersecurity / SOC',
    signals: ['CrowdStrike', 'SentinelOne', 'Microsoft Sentinel', 'Splunk', 'KQL', 'SOAR', 'Defender for Endpoint', 'EDR', 'XDR', 'Incident Response', 'Threat Detection'],
    suggestions: ['Cybersecurity Engineer', 'Information Security Engineer', 'SOC Analyst', 'SOC Engineer', 'Detection Engineer', 'Security Engineer', 'Incident Response Engineer'],
    keywords: ['cybersecurity', 'soc', 'incident response', 'threat detection']
  },
  {
    name: 'PAM / IGA',
    signals: ['CyberArk', 'BeyondTrust', 'SailPoint', 'Saviynt', 'Azure PIM', 'Vault Management', 'Just-in-Time'],
    suggestions: ['PAM Engineer', 'IGA Engineer', 'Privileged Access Engineer', 'Identity Governance Engineer'],
    keywords: ['pam', 'iga', 'cyberark', 'privileged access']
  },
  {
    name: 'Microsoft 365',
    signals: ['Microsoft 365', 'M365', 'Purview', 'Intune', 'Defender for Identity', 'SharePoint', 'Exchange', 'Teams Admin', 'Power Automate', 'MS-102', 'SC-300'],
    suggestions: ['Microsoft 365 Engineer', 'M365 Administrator', 'M365 Security Engineer', 'Modern Workplace Engineer', 'Microsoft Endpoint Engineer'],
    keywords: ['m365', 'microsoft 365', 'intune', 'azure']
  },
  {
    name: 'Linux / Sysadmin',
    signals: ['RHEL', 'CentOS', 'Ubuntu', 'Linux', 'RHCSA', 'LPIC-1', 'CIS Benchmarks', 'Bash', 'SSH', 'systemd'],
    suggestions: ['Linux Engineer', 'Linux Administrator', 'Linux System Administrator', 'Systems Administrator', 'Site Reliability Engineer'],
    keywords: ['linux', 'rhel', 'sysadmin']
  },
  {
    name: 'DevOps / Platform',
    signals: ['Kubernetes', 'Docker', 'Helm', 'Terraform', 'Ansible', 'GitHub Actions', 'GitLab CI', 'Jenkins', 'ArgoCD', 'Pulumi', 'Istio'],
    suggestions: ['DevOps Engineer', 'Platform Engineer', 'Site Reliability Engineer', 'Infrastructure Engineer', 'Cloud Operations Engineer'],
    keywords: ['devops', 'kubernetes', 'terraform', 'sre']
  },
  {
    name: 'Software Engineering',
    signals: ['React', 'TypeScript', 'JavaScript', 'Node.js', 'Python', 'Go', 'Rust', 'Java', 'PostgreSQL', 'MongoDB', 'GraphQL', 'REST API'],
    suggestions: ['Software Engineer', 'Backend Engineer', 'Full Stack Engineer', 'Senior Software Engineer'],
    keywords: ['backend', 'full stack', 'node.js', 'python']
  },
  {
    name: 'Data Engineering',
    signals: ['Spark', 'Airflow', 'dbt', 'Snowflake', 'Redshift', 'BigQuery', 'Databricks', 'Kafka', 'SQL', 'Python', 'ETL'],
    suggestions: ['Data Engineer', 'Senior Data Engineer', 'Analytics Engineer', 'Big Data Engineer'],
    keywords: ['data engineering', 'etl', 'snowflake', 'databricks']
  },
  {
    name: 'Compliance / GRC',
    signals: ['NIST 800-53', 'ISO 27001', 'HIPAA', 'PCI-DSS', 'SOC 2', 'FedRAMP', 'HITRUST', 'SOX', 'GRC', 'Audit'],
    suggestions: ['GRC Analyst', 'Compliance Analyst', 'Security Compliance Engineer', 'Risk Analyst', 'IT Auditor'],
    keywords: ['grc', 'compliance', 'audit', 'risk']
  }
];

// Rank clusters by signal density against the parsed CV, then flatten one
// of each cluster's term lists (`suggestions` for titles, `keywords` for
// keywords) into a unique, capped list. Shared core of both suggesters.
function suggestFromClusters(parsedCV, field, max) {
  const present = new Set([
    ...(parsedCV.titles || []),
    ...(parsedCV.certs || []),
    ...(parsedCV.skills || []),
    ...(parsedCV.compliance || [])
  ].map(s => s.toLowerCase()));

  const ranked = CLUSTERS.map(c => {
    const hits = c.signals.filter(s => present.has(s.toLowerCase())).length;
    return { cluster: c, hits, density: hits / c.signals.length };
  })
    .filter(r => r.hits >= 2) // need at least 2 signals to be confident
    .sort((a, b) => b.density - a.density);

  const out = [];
  const seen = new Set();
  for (const r of ranked) {
    for (const term of (r.cluster[field] || [])) {
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        title: term, // kept as `title` for both flavors — callers render .title
        cluster: r.cluster.name,
        signalsHit: r.cluster.signals.filter(s => present.has(s.toLowerCase()))
      });
      if (out.length >= max) break;
    }
    if (out.length >= max) break;
  }
  return out;
}

// Full job titles ("IAM Engineer") — the original suggester.
export function suggestRoles(parsedCV, opts = {}) {
  return suggestFromClusters(parsedCV, 'suggestions', opts.max ?? 12);
}

// Short domain keywords ("iam", "m365", "linux") — v2.0.3 keywords mode.
// Broader searches; precision comes from CV-match scoring + the match floor.
export function suggestKeywords(parsedCV, opts = {}) {
  return suggestFromClusters(parsedCV, 'keywords', opts.max ?? 12);
}

// CLI test
const file = process.argv[1] ? process.argv[1].replace(/\\/g, '/') : '';
if (file.endsWith('role-suggester.mjs')) {
  const cvPath = path.join(ROOT, 'data', 'cv-parsed.json');
  if (!fs.existsSync(cvPath)) {
    console.error('No data/cv-parsed.json. Run: node scripts/resume-parser.mjs <resume>');
    process.exit(2);
  }
  const cv = JSON.parse(fs.readFileSync(cvPath, 'utf8'));
  const out = suggestRoles(cv);
  for (const s of out) {
    console.log(`${s.title}  (${s.cluster}, signals: ${s.signalsHit.slice(0, 4).join(', ')}${s.signalsHit.length > 4 ? '…' : ''})`);
  }
}
