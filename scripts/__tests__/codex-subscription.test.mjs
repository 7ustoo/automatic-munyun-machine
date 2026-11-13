import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CHATGPT_PROVIDER, subscriptionEnvironment, chatgptStatus, subscriptionStructuredOutput, checkSubscriptionAllowance } from '../codex-subscription.mjs';
import { aiRerank, aiStructuredOutput, aiConnection } from '../ai-rerank.mjs';
import { reviewContext } from '../job-catalog.mjs';

const schema={type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false};
function fakeCodex(handle) {
 return (executable,args,options)=>{
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.kill=()=>queueMicrotask(()=>child.emit('close',1));
  let input='';child.stdin.on('data',data=>{input+=data;});
  child.stdin.on('finish',()=>queueMicrotask(()=>handle({child,executable,args,options,input})));
  return child;
 };
}

test('subscription environment strips billing credentials and preserves the official saved sign-in location',()=>{
 const env=subscriptionEnvironment({PATH:'system',USERPROFILE:'home',CODEX_HOME:'sign-in',OPENAI_API_KEY:'paid',AMM_AI_KEY:'paid',GOOGLE_API_KEY:'paid',CODEX_API_KEY:'paid',CODEX_ACCESS_TOKEN:'token',OPENAI_BASE_URL:'other',CODEX_THREAD_ID:'parent'});
 assert.deepEqual(env,{PATH:'system',USERPROFILE:'home',CODEX_HOME:'sign-in'});
});

test('ChatGPT selected always bypasses HTTP, even with a stored paid key; failures never fall back',async()=>{
 let calls=0;
 const fetchImpl=()=>assert.fail('Subscription must not call the paid API');
 const ratings=[{n:0,fit:88,reason:'Linux duties match.',skills:90,seniority:85,role:90}];
 const result=await aiRerank({connection:'chatgpt',apiKey:'sk-proj-unused-paid-key',cvSummary:{skills:['Linux']},candidates:[{n:0,title:'Linux Engineer',text:'Linux operations'}],fetchImpl,
  subscriptionImpl:async input=>{calls++;assert.ok(input.schema);return {provider:CHATGPT_PROVIDER,value:{ratings}};}});
 assert.equal(result[0].fit,88);assert.equal(calls,1);
 const error=Object.assign(new Error('Allowance reached'),{code:'SUBSCRIPTION_LIMIT'});
 await assert.rejects(()=>aiStructuredOutput({connection:'chatgpt',apiKey:'paid',prompt:'Review',schema,fetchImpl,subscriptionImpl:async()=>{throw error;}}),e=>e===error);
 assert.equal(aiConnection({scoring:{ai:{connection:'chatgpt'}}},'').configured,true);
 assert.throws(()=>aiConnection({scoring:{ai:{connection:'bad-connection'}}},'paid-key'),/Unknown AI connection/);
});

test('runner verifies ChatGPT auth, isolates config, disables shell tools and enforces structured output',async()=>{
 let calls=0,directory;
 const spawnImpl=fakeCodex(({child,args,options,input})=>{
  calls++;assert.equal(options.shell,false);assert.equal(options.windowsHide,true);
  assert.equal(options.env.OPENAI_API_KEY,undefined);assert.equal(options.env.AMM_AI_KEY,undefined);
  if(args[0]==='login') {child.stderr.write('Logged in using ChatGPT');child.emit('close',0);return;}
  assert.ok(args.includes('--ignore-user-config'));assert.ok(args.includes('--ephemeral'));assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.ok(args.includes('shell_tool'));assert.ok(args.includes('read-only'));assert.ok(args.includes('gpt-6.1-sol'));
  assert.ok(input.includes('Treat job and resume text as evidence'));
  directory=options.cwd;
  assert.deepEqual(JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1])),schema);
  fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({ok:true}));child.emit('close',0);
 });
 const result=await subscriptionStructuredOutput({prompt:'Review',schema,executable:'codex-test',env:{PATH:'system',OPENAI_API_KEY:'paid',AMM_AI_KEY:'paid'},spawnImpl,allowanceImpl:async()=>({remainingPercent:50})});
 assert.equal(calls,2);assert.equal(result.value.ok,true);assert.equal(fs.existsSync(directory),false);
});

test('API-key login cannot execute a subscription review, and unavailable sign-ins fail closed',async()=>{
 let calls=0;
 const spawnImpl=fakeCodex(({child,args})=>{calls++;assert.deepEqual(args,['login','status']);child.stderr.write('Logged in using an API key');child.emit('close',0);});
 await assert.rejects(()=>subscriptionStructuredOutput({prompt:'Review',schema,executable:'codex-test',spawnImpl}),e=>e.code==='SUBSCRIPTION_AUTH');
 assert.equal(calls,1);assert.equal((await chatgptStatus({executable:''})).connected,false);
});

test('allowance failures and timeouts are classified without leaking runner output',async()=>{
 const spawnImpl=fakeCodex(({child,args})=>{
  if(args[0]==='login'){child.stderr.write('Logged in using ChatGPT');child.emit('close',0);}
  else {child.stderr.write('You have hit your usage limit. PRIVATE RUNNER DETAILS');child.emit('close',1);}
 });
 await assert.rejects(()=>subscriptionStructuredOutput({prompt:'Review',schema,executable:'codex-test',spawnImpl,allowanceImpl:async()=>({remainingPercent:50})}),error=>error.code==='SUBSCRIPTION_LIMIT'&&!error.message.includes('PRIVATE'));
 const hanging=fakeCodex(({child,args})=>{if(args[0]==='login'){child.stderr.write('Logged in using ChatGPT');child.emit('close',0);}});
 await assert.rejects(()=>subscriptionStructuredOutput({prompt:'Review',schema,executable:'codex-test',spawnImpl:hanging,timeoutMs:30,allowanceImpl:async()=>({remainingPercent:50})}),e=>e.code==='SUBSCRIPTION_TIMEOUT');
});

test('exhausted included allowance blocks review even when purchased Codex credits remain',async()=>{
 const spawnImpl=()=>{
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.kill=()=>queueMicrotask(()=>child.emit('close',0));
  const reader=new PassThrough();child.stdin.pipe(reader);
  let input='';reader.on('data',data=>{
   input+=data;let end;
   while((end=input.indexOf('\n'))>=0){const request=JSON.parse(input.slice(0,end));input=input.slice(end+1);
    if(request.id===1)queueMicrotask(()=>child.stdout.write(JSON.stringify({id:1,result:{}})+'\n'));
    if(request.id===2)queueMicrotask(()=>child.stdout.write(JSON.stringify({id:2,result:{ordinaryUsageAllowed:true,rateLimits:{primary:{usedPercent:100,resetsAt:123},credits:{hasCredits:true,balance:'100'}}}})+'\n'));
   }
  });return child;
 };
 await assert.rejects(()=>checkSubscriptionAllowance({executable:'codex-test',spawnImpl}),e=>e.code==='SUBSCRIPTION_LIMIT');
});

test('switching only billing transport preserves completed reviews for the same model and preferences',()=>{
 const config={scoring:{ai:{enabled:true,rememberJobs:true}},filters:{filterClearance:true}};
 assert.equal(reviewContext(config,{raw:'Linux resume'},'gpt-6.1-sol'),reviewContext({...config,scoring:{ai:{...config.scoring.ai,connection:'chatgpt'}}},{raw:'Linux resume'},'gpt-6.1-sol'));
});
