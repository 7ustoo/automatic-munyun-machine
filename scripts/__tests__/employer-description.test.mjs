import test from 'node:test';
import assert from 'node:assert/strict';
import { employerPostingApi, employerBoardPosting, staticEmployerDescription, readEmployerDescription, createBoardDescriptionReader } from '../employer-description.mjs';

const text = 'Build and operate Linux infrastructure, Terraform automation and CI/CD pipelines. '.repeat(6);
const job = { title: 'Cloud Engineer', directUrl: 'https://careers.example.com/jobs/123' };
const html = posting => `<html><script type="application/ld+json">${JSON.stringify(posting)}</script></html>`;

test('branded Greenhouse pages require matching source and URL posting identities', async()=>{
 const url='https://block.xyz/careers/jobs/123?gh_jid=123';
 assert.equal(employerBoardPosting(url,'grnhse___block___123').url,'https://boards-api.greenhouse.io/v1/boards/block/jobs?content=true');
 assert.equal(employerBoardPosting(url,'grnhse___block___456'),null);
 assert.equal(employerBoardPosting(url),null);
 const read=createBoardDescriptionReader(async()=>({status:200,body:Buffer.from(JSON.stringify({jobs:[{id:123,content:text,title:'Cloud Engineer'}]}))}));
 assert.equal((await read({directUrl:url,sourceId:'grnhse___block___123'})).jdText,text.trim());
});

test('parallel roles at one employer share a full-description board request and keep exact identities',async()=>{
 let requests=0;
 const read=createBoardDescriptionReader(async url=>{
  requests++;assert.equal(url,'https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true');
  await new Promise(resolve=>setTimeout(resolve,5));
  return {status:200,body:Buffer.from(JSON.stringify({jobs:[{id:123,title:'Linux Engineer',content:'<p>'+text+'</p>'},{id:456,title:'Sales Engineer',content:'<p>Sales responsibilities. '+text+'</p>'}]}))};
 });
 const results=await Promise.all([123,456,123].map(id=>read({directUrl:`https://job-boards.greenhouse.io/example/jobs/${id}`})));
 assert.equal(requests,1);assert.equal(results[0].title,'Linux Engineer');assert.equal(results[1].title,'Sales Engineer');
 assert.equal(await read({directUrl:'https://job-boards.greenhouse.io/example/jobs/999'}),null);
 assert.equal(await read(job),null);
});

test('static JobPosting reads the exact role without a browser, decodes HTML and rejects expired or recommended roles', () => {
 const posting = { '@type': 'JobPosting', title: job.title, url: job.directUrl, description: `<p>${text}&amp; monitoring</p>`, hiringOrganization: { name: 'Example' } };
 const result = staticEmployerDescription(html(posting), {url:job.directUrl,title:job.title});
 assert.equal(result.company,'Example'); assert.match(result.jdText,/& monitoring/); assert.equal(result.descriptionQuality,'full');
 assert.equal(staticEmployerDescription(html({...posting,url:'https://careers.example.com/jobs/other'}),{url:job.directUrl,title:job.title}),null);
 assert.throws(()=>staticEmployerDescription(html({...posting,validThrough:'2001-01-01'}),{url:job.directUrl,title:job.title}),/expired/);
 assert.equal(staticEmployerDescription(html({...posting,description:'Short summary'}),{url:job.directUrl,title:job.title}),null);
});

test('known employer ATS links use the exact public posting API', async () => {
 const directUrl='https://job-boards.greenhouse.io/example/jobs/123';
 const result=await readEmployerDescription({...job,directUrl},async url=>{
  assert.equal(url,'https://boards-api.greenhouse.io/v1/boards/example/jobs/123');
  return {status:200,body:Buffer.from(JSON.stringify({title:job.title,content:`<p>${text}</p>`})),headers:{}};
 });
 assert.equal(result.result.directUrl,directUrl);assert.match(result.result.jdText,/Terraform/);
 assert.equal(employerPostingApi('https://jobs.lever.co/example/11111111-2222-3333-4444-555555555555').type,'lever');
 assert.equal(employerPostingApi(job.directUrl),null);
});

test('HTTP failures stop immediately, redirects are bounded, and static descriptions bypass browser work', async () => {
 let reads=0;
 const result=await readEmployerDescription(job,async()=>{reads++;return {status:200,body:Buffer.from(html({'@type':'JobPosting',title:job.title,description:text})),headers:{}};});
 assert.equal(reads,1);assert.equal(result.result.descriptionQuality,'full');
 await assert.rejects(()=>readEmployerDescription(job,async()=>({status:403,body:Buffer.alloc(0),headers:{}})),/HTTP 403/);
 await assert.rejects(()=>readEmployerDescription(job,async()=>({status:302,headers:{location:'http://localhost/secret'}})),/unsupported/);
 await assert.rejects(()=>readEmployerDescription(job,async()=>({status:302,headers:{location:'/again'}})),/too many/);
 const fallback=await readEmployerDescription(job,async()=>({status:200,body:Buffer.from('<html>Dynamic application</html>'),headers:{}}));
 assert.equal(fallback.url,job.directUrl);assert.equal(fallback.result,undefined);
});
