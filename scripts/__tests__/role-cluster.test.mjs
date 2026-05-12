// node --test scripts/__tests__/role-cluster.test.mjs
// Validates that the role-cluster auto-detection picks the right primary
// clusters for shaped CVs: an IAM-heavy CV maps to {iam, ...}, a backend
// CV to {softwareEng, ...}, etc. Without this, the engine continues to
// IAM-bias backend/data-leaning users.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreClusters, pickPrimaryClusters } from '../resume-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dict = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cv-keywords.json'), 'utf8'));

const IAM_CV = `
Senior IAM Engineer with 6 years experience implementing Okta, CyberArk,
SailPoint, and Entra ID across enterprise environments. Designed
Conditional Access policies and PIM workflows. SC-300 certified.
Expert in OIDC, SAML, and SCIM provisioning.
`;

const BACKEND_CV = `
Backend Engineer (Senior, 5y) shipping Node.js + TypeScript services.
Strong with PostgreSQL, Redis, REST APIs, GraphQL. Microservices on
Kubernetes (Helm, ArgoCD). Some Python for data pipelines.
`;

const DATA_CV = `
Senior Data Scientist. Built ML pipelines with PyTorch and scikit-learn,
analytics on Snowflake + dbt + BigQuery. Productionized models via
Databricks and Airflow. Strong Pandas, NumPy. Some Spark.
`;

const SOC_CV = `
Detection Engineer. Splunk ES, KQL, Microsoft Sentinel, SOAR playbooks
in Phantom. Incident response on-call. GCFA certified.
`;

test('IAM-heavy CV → primary cluster includes "iam"', () => {
  const scores = scoreClusters(IAM_CV, dict.clusters);
  const primary = pickPrimaryClusters(scores, 2);
  assert.ok(primary.includes('iam'), `expected 'iam' in primary, got ${JSON.stringify(primary)}`);
});

test('Backend CV → primary cluster includes "softwareEng"', () => {
  const scores = scoreClusters(BACKEND_CV, dict.clusters);
  const primary = pickPrimaryClusters(scores, 2);
  assert.ok(primary.includes('softwareEng'), `expected 'softwareEng' in primary, got ${JSON.stringify(primary)}`);
  // Critical: backend CV should NOT be IAM-classified
  assert.ok(!primary.includes('iam'), `unexpected 'iam' for backend CV: ${JSON.stringify(primary)}`);
});

test('Data CV → primary cluster includes "data"', () => {
  const scores = scoreClusters(DATA_CV, dict.clusters);
  const primary = pickPrimaryClusters(scores, 2);
  assert.ok(primary.includes('data'), `expected 'data' in primary, got ${JSON.stringify(primary)}`);
});

test('SOC CV → primary cluster includes "soc"', () => {
  const scores = scoreClusters(SOC_CV, dict.clusters);
  const primary = pickPrimaryClusters(scores, 2);
  assert.ok(primary.includes('soc'), `expected 'soc' in primary, got ${JSON.stringify(primary)}`);
});

test('empty text yields no primary clusters', () => {
  const scores = scoreClusters('', dict.clusters);
  assert.deepEqual(pickPrimaryClusters(scores, 2), []);
});

test('pickPrimaryClusters drops zeros even within top-N', () => {
  const fakeScores = { iam: 5, soc: 0, data: 0 };
  const primary = pickPrimaryClusters(fakeScores, 3);
  assert.deepEqual(primary, ['iam']);
});
