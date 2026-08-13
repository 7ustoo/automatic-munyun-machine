import test from 'node:test';
import assert from 'node:assert/strict';
import { excludedTitleCategory, isManagementTitle, isSalesTitle } from '../job-title-filters.mjs';

test('management filter recognizes managers, executives, and technical leads', () => {
  for (const title of [
    'Engineering Manager', 'Director of Security', 'Head of Platform',
    'Chief Technology Officer', 'VP, Engineering', 'Technical Lead',
    'Data Team Lead', 'Lead Software Engineer', 'Security Engineering Lead'
  ]) assert.equal(isManagementTitle(title), true, title);
});

test('management filter keeps senior individual-contributor and unrelated lead-word titles', () => {
  for (const title of [
    'Senior Software Engineer', 'Staff Security Engineer', 'Principal Architect',
    'Lead Generation Specialist', 'Salesforce Administrator'
  ]) assert.equal(isManagementTitle(title), false, title);
});

test('sales filter recognizes common sales title families without matching Salesforce', () => {
  for (const title of [
    'Enterprise Sales Executive', 'Account Executive', 'Account Manager',
    'Business Development Representative', 'SDR', 'Customer Success Specialist',
    'Revenue Operations Analyst', 'Lead Generation Specialist'
  ]) assert.equal(isSalesTitle(title), true, title);
  assert.equal(isSalesTitle('Salesforce Engineer'), false);
  assert.equal(isSalesTitle('Business Analyst'), false);
});

test('category filters are independently opt-in', () => {
  assert.equal(excludedTitleCategory('Engineering Manager', {}), null);
  assert.equal(excludedTitleCategory('Engineering Manager', { filterManagementTitles: true }), 'management');
  assert.equal(excludedTitleCategory('Account Executive', { filterManagementTitles: true }), null);
  assert.equal(excludedTitleCategory('Account Executive', { filterSalesTitles: true }), 'sales');
});
