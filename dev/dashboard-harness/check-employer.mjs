import assert from 'node:assert/strict';
import { extractEmployerDescription } from '../../scripts/employer-description.mjs';

export async function verifyEmployerExtraction(browser) {
  const page = await browser.newPage();
  const jd = '<p>Responsibilities include operating Linux servers, writing Terraform automation and supporting production CI/CD pipelines.</p><p>Requirements: hands-on infrastructure engineering, monitoring, incident response and collaborative software delivery. This is a full-time individual contributor role supporting an internal platform.</p>';
  const url = 'https://jobs.example.com/linux/123';
  const posting = { '@type': 'JobPosting', title: 'Linux Engineer', url, description: jd, hiringOrganization: { name: 'Example' } };
  const render = async records => page.setContent(`<h1>Linux Engineer</h1><script type="application/ld+json">${JSON.stringify(records)}</script>`);
  await render({ '@graph': [{ ...posting, title: 'Sales Engineer', url: 'https://jobs.example.com/sales/999' }, posting] });
  let result = await page.evaluate(extractEmployerDescription, { url, title: 'Linux Engineer' });
  assert.equal(result.title, 'Linux Engineer'); assert.equal(result.company, 'Example'); assert.match(result.jdText, /Terraform/);
  await render({ ...posting, url: 'https://jobs.example.com/linux/999' });
  assert.equal(await page.evaluate(extractEmployerDescription, { url, title: 'Linux Engineer' }), null);
  await render({ ...posting, validThrough: '2000-01-01' });
  await assert.rejects(() => page.evaluate(extractEmployerDescription, { url, title: 'Linux Engineer' }), /expired/);
  await page.setContent(`<h1>Linux Engineer</h1><div id="job-description">${jd}</div>`);
  result = await page.evaluate(extractEmployerDescription, { url, title: 'Linux Engineer' }); assert.match(result.jdText, /Linux/);
  await page.setContent(`<h1>Careers at Example</h1><div id="content">${jd}</div>`);
  assert.equal(await page.evaluate(extractEmployerDescription, { url, title: 'Linux Engineer' }), null);
  await page.setContent(`<h1>Job Position</h1><main><h2>Linux Engineer</h2>${jd}</main>`);
  assert.match((await page.evaluate(extractEmployerDescription, { url, title: 'Linux Engineer' })).jdText,/Terraform/);
  await page.setContent(`<h1>Sales Engineer</h1><main>${jd}</main>`);
  assert.equal(await page.evaluate(extractEmployerDescription, { url, title: 'Linux Engineer' }), null);
  await page.setContent(`<h1>Linux Engineer</h1><p>This job is no longer available.</p><div id="job-description">${jd}</div>`);
  assert.equal(await page.evaluate(extractEmployerDescription, { url, title: 'Linux Engineer' }), null);
  await page.close();
}
