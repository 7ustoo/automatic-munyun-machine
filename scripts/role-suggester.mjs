#!/usr/bin/env node
/**
 * Suggests job titles to search for, based on parsed CV (cv-parsed.json).
 *
 * Strategy: read the user's parsed skills/certs/titles, match against a set of
 * "domain clusters" (each cluster is a group of signal terms + suggested job titles),
 * and rank suggestions by signal density.
 *
 * Used by /jobs suggest bot command and wizard step 5.
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
    suggestions: ['IAM Engineer', 'Cloud IAM Engineer', 'Identity Engineer', 'Identity Architect', 'IAM Administrator', 'Identity Operations Engineer']
  },
  {
    name: 'Cloud Security',
    signals: ['CSPM', 'CWPP', 'Defender for Cloud', 'Security Hub', 'GuardDuty', 'Prisma Cloud', 'Aqua Security', 'AWS Security', 'Azure Security', 'GCP Security'],
    suggestions: ['Cloud Security Engineer', 'Cloud Security Architect', 'Cloud Security IAM Engineer', 'Cloud Engineer', 'AWS Security Engineer', 'Azure Security Engineer']
  },
  {
    name: 'Cybersecurity / SOC',
    signals: ['CrowdStrike', 'SentinelOne', 'Microsoft Sentinel', 'Splunk', 'KQL', 'SOAR', 'Defender for Endpoint', 'EDR', 'XDR', 'Incident Response', 'Threat Detection'],
    suggestions: ['Cybersecurity Engineer', 'Information Security Engineer', 'SOC Analyst', 'SOC Engineer', 'Detection Engineer', 'Security Engineer', 'Incident Response Engineer']
  },
  {
    name: 'PAM / IGA',
    signals: ['CyberArk', 'BeyondTrust', 'SailPoint', 'Saviynt', 'Azure PIM', 'Vault Management', 'Just-in-Time'],
    suggestions: ['PAM Engineer', 'IGA Engineer', 'Privileged Access Engineer', 'Identity Governance Engineer']
  },
  {
    name: 'Microsoft 365',
    signals: ['Microsoft 365', 'M365', 'Purview', 'Intune', 'Defender for Identity', 'SharePoint', 'Exchange', 'Teams Admin', 'Power Automate', 'MS-102', 'SC-300'],
    suggestions: ['Microsoft 365 Engineer', 'M365 Administrator', 'M365 Security Engineer', 'Modern Workplace Engineer', 'Microsoft Endpoint Engineer']
  },
  {
    name: 'Linux / Sysadmin',
    signals: ['RHEL', 'CentOS', 'Ubuntu', 'Linux', 'RHCSA', 'LPIC-1', 'CIS Benchmarks', 'Bash', 'SSH', 'systemd'],
    suggestions: ['Linux Engineer', 'Linux Administrator', 'Linux System Administrator', 'Systems Administrator', 'Site Reliability Engineer']
  },
  {
    name: 'DevOps / Platform',
    signals: ['Kubernetes', 'Docker', 'Helm', 'Terraform', 'Ansible', 'GitHub Actions', 'GitLab CI', 'Jenkins', 'ArgoCD', 'Pulumi', 'Istio'],
    suggestions: ['DevOps Engineer', 'Platform Engineer', 'Site Reliability Engineer', 'Infrastructure Engineer', 'Cloud Operations Engineer']
  },
  {
    name: 'Software Engineering',
    signals: ['React', 'TypeScript', 'JavaScript', 'Node.js', 'Python', 'Go', 'Rust', 'Java', 'PostgreSQL', 'MongoDB', 'GraphQL', 'REST API'],
    suggestions: ['Software Engineer', 'Backend Engineer', 'Full Stack Engineer', 'Senior Software Engineer']
  },
  {
    name: 'Data Engineering',
    signals: ['Spark', 'Airflow', 'dbt', 'Snowflake', 'Redshift', 'BigQuery', 'Databricks', 'Kafka', 'SQL', 'Python', 'ETL'],
    suggestions: ['Data Engineer', 'Senior Data Engineer', 'Analytics Engineer', 'Big Data Engineer']
  },
  {
    name: 'Compliance / GRC',
    signals: ['NIST 800-53', 'ISO 27001', 'HIPAA', 'PCI-DSS', 'SOC 2', 'FedRAMP', 'HITRUST', 'SOX', 'GRC', 'Audit'],
    suggestions: ['GRC Analyst', 'Compliance Analyst', 'Security Compliance Engineer', 'Risk Analyst', 'IT Auditor']
  }
];

export function suggestRoles(parsedCV, opts = {}) {
  const max = opts.max ?? 12;
  const present = new Set([
    ...(parsedCV.titles || []),
    ...(parsedCV.certs || []),
    ...(parsedCV.skills || []),
    ...(parsedCV.compliance || [])
  ].map(s => s.toLowerCase()));

  // Score each cluster by signal density
  const ranked = CLUSTERS.map(c => {
    const hits = c.signals.filter(s => present.has(s.toLowerCase())).length;
    return { cluster: c, hits, density: hits / c.signals.length };
  })
    .filter(r => r.hits >= 2) // need at least 2 signals to be confident
    .sort((a, b) => b.density - a.density);

  // Flatten unique suggestions, weighted by cluster ranking
  const out = [];
  const seen = new Set();
  for (const r of ranked) {
    for (const title of r.cluster.suggestions) {
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        title,
        cluster: r.cluster.name,
        signalsHit: r.cluster.signals.filter(s => present.has(s.toLowerCase()))
      });
      if (out.length >= max) break;
    }
    if (out.length >= max) break;
  }
  return out;
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
