import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeConsultantSlop,
  normalizeConsultantSlopMode,
} from '../consultant-slop-filter.mjs';

test('mode normalization is safe and backwards-compatible', () => {
  assert.equal(normalizeConsultantSlopMode('balanced'), 'balanced');
  assert.equal(normalizeConsultantSlopMode('STRICT'), 'strict');
  assert.equal(normalizeConsultantSlopMode(true), 'balanced');
  assert.equal(normalizeConsultantSlopMode('garbage'), 'off');
});

test('balanced removes an obvious implementation consultant role', () => {
  const result = analyzeConsultantSlop({
    title: 'Senior Implementation Consultant',
    text: 'Lead customer workshops, manage statements of work, and configure the platform for clients.',
  }, 'balanced');
  assert.equal(result.excluded, true);
  assert.equal(result.customerFacing, true);
  assert.equal(result.consulting, true);
});

test('balanced removes professional-services work hidden behind an engineer title', () => {
  const result = analyzeConsultantSlop({
    title: 'Identity Engineer',
    text: 'Join our professional services team. Work directly with enterprise customers across multiple engagements and maintain billable utilization.',
  }, 'balanced');
  assert.equal(result.excluded, true);
  assert.ok(result.reasons.includes('professional services'));
});

test('balanced removes a role that explicitly says it is customer-facing', () => {
  const result = analyzeConsultantSlop({
    title: 'Platform Engineer',
    text: 'This is a customer-facing role working with external engineering teams.',
  }, 'balanced');
  assert.equal(result.excluded, true);
  assert.equal(result.customerFacing, true);
});

test('balanced keeps a real backend ticket-and-production role', () => {
  const result = analyzeConsultantSlop({
    title: 'Backend Software Engineer',
    text: 'Build backend services and REST APIs. Own production systems, complete Jira tickets, review pull requests, deploy through CI/CD, debug incidents, and join on-call.',
  }, 'balanced');
  assert.equal(result.excluded, false);
  assert.ok(result.engineeringScore >= 8);
});

test('customer-facing product language alone does not sink an engineering role', () => {
  const result = analyzeConsultantSlop({
    title: 'Backend Engineer',
    text: 'Build and own production backend services for a customer-facing product. Review code, ship deployments, and resolve engineering tickets.',
  }, 'balanced');
  assert.equal(result.excluded, false);
  assert.equal(result.customerFacing, false);
});

test('strict removes explicit customer-facing work and travel', () => {
  const customer = analyzeConsultantSlop({
    title: 'Platform Engineer',
    text: 'This is a customer-facing role. You will present solutions to clients.',
  }, 'strict');
  const travel = analyzeConsultantSlop({
    title: 'Systems Engineer',
    text: 'Ability to travel up to 25% to customer sites is required.',
  }, 'strict');
  assert.equal(customer.excluded, true);
  assert.equal(travel.excluded, true);
  assert.equal(travel.travelRequired, true);
});

test('strict catches natural customer-facing and travel wording', () => {
  const result = analyzeConsultantSlop({
    title: 'Cloud Engineer',
    text: 'You will be client-facing and serve as the primary technical point of contact. Candidates must be willing to travel.',
  }, 'strict');
  assert.equal(result.excluded, true);
  assert.equal(result.customerFacing, true);
  assert.equal(result.travelRequired, true);
});

test('travel negation is respected', () => {
  const result = analyzeConsultantSlop({
    title: 'Systems Engineer',
    text: 'This role is fully remote. No travel is required.',
  }, 'strict');
  assert.equal(result.travelRequired, false);
  assert.equal(result.excluded, false);
});

test('off never filters but still returns diagnostics', () => {
  const result = analyzeConsultantSlop({
    title: 'Solutions Consultant',
    text: 'Travel required. Work directly with customers.',
  }, 'off');
  assert.equal(result.excluded, false);
  assert.ok(result.consultingScore > 0);
});

test('the daily batch replaces filtered candidates before Smart Match', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(testDir, '..', 'daily-batch.mjs'), 'utf8');
  assert.match(source, /const acceptedChunk = \[\]/);
  assert.match(source, /applySmartMatch\(acceptedChunk\)/);
  assert.match(source, /candidatePool\.length - cursor/);
});
