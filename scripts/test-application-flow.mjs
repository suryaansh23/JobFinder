import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
// Match Next's server-side CommonJS bridge while running source modules in Node.
globalThis.require = createRequire(import.meta.url);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jf-flow-'));
process.env.JOBFINDER_DATA = work;
const { run } = await import('../lib/db.js');
const { autoApplyJob } = await import('../lib/autoApply.js');
const { OBSERVER_SCRIPT } = await import('../lib/observer.js');
const { saveResume } = await import('../lib/resume.js');
const profile = {id:'fixture',name:'Fixture - Brand Marketing',email:'fixture@example.test',keywords:'Brand Marketing',locations:'Delhi NCR',filters:'{}'};
await run('INSERT INTO profiles (id,name,email,filters,created_at) VALUES (?,?,?,?,?)',[profile.id,profile.name,profile.email,'{}',Date.now()]);
await run('INSERT INTO answers (profile_id,field_key,label,value,type,last_seen,status) VALUES (?,?,?,?,?,?,?)',[profile.id,'email','Email','fixture@example.test','email',Date.now(),'approved']);
await saveResume(profile.id, {name:'Fixture CV.pdf',arrayBuffer:async()=>Buffer.from('%PDF-1.4 fixture CV')});
const browser = await chromium.launch({headless:true});
const ctx = await browser.newContext();
await ctx.addInitScript({content:OBSERVER_SCRIPT});
const id='4482060285';
const job={id:'fixture-job',connector:'linkedin',url:'https://www.linkedin.com/jobs/view/'+id+'/',title:'Marketing Manager',company:'Fixture',location:'Delhi'};
let submitted=0; let uploaded=''; let capturedEmail='';
let unknown=false; let confirmation=true;
ctx.on('page', (page) => {
 const close=page.close.bind(page);
 page.close=async(opts)=>{capturedEmail=await page.locator('input[type=email]').inputValue().catch(()=>capturedEmail);return close(opts);};
});
await ctx.exposeBinding('fixtureSubmit',()=>{submitted++;});
await ctx.exposeBinding('fixturePrepared',(_source,email,filename)=>{capturedEmail=email;uploaded=filename;});
await ctx.route('**/*',async(route)=>{
 const contact = unknown ? '<label for="q">Unknown required licence code *</label><input id="q" name="licence_code" required>' : '<label for="email">Email *</label><input id="email" name="email" type="email" required>';
 const html = '<button onclick="document.querySelector(\'section\').hidden=false">Easy Apply</button><section role="dialog" hidden><h2>Apply to Fixture</h2>'+contact+'<input type="file" aria-label="Upload resume" onchange="window.fixturePrepared(document.querySelector(\'input:not([type=file])\').value,this.files[0]?.name)"><button onclick="window.fixtureSubmit();' + (confirmation ? 'document.body.append(\'Your application was sent\')' : '') + '">Submit application</button></section>';
 await route.fulfill({contentType:'text/html',body:html});
});
try {
 const safe = await autoApplyJob(ctx,profile,job,{armed:false});
 assert.equal(safe.state,'dry_run',JSON.stringify(safe));
 assert.equal(safe.preparationValidated,true);
 assert.equal(submitted,0,'SAFE never clicks final Submit');
 assert.match(uploaded,/\d{2} [A-Za-z]{3} Fixture Brand Marketing\.pdf/,'current dated CV is attached inside the application');
 assert.equal(capturedEmail,'fixture@example.test','approved factual answer was filled by the real observer');
 unknown=true;
 const blocked = await autoApplyJob(ctx,profile,{...job,id:'unknown-question'},{armed:false});
 assert.equal(blocked.state,'needs_input',JSON.stringify(blocked));
 assert.ok(blocked.missing?.length,'unknown mandatory facts are parked');
 assert.equal(submitted,0);
 unknown=false;
 const live=await autoApplyJob(ctx,profile,{...job,id:'confirmed-fixture'},{armed:true});
 assert.equal(live.state,'applied',JSON.stringify(live));
 assert.equal(submitted,1,'LIVE fixture submits exactly once');
 confirmation=false;
 const ambiguous=await autoApplyJob(ctx,profile,{...job,id:'unconfirmed-fixture'},{armed:true});
 assert.equal(ambiguous.state,'submit_clicked',JSON.stringify(ambiguous));
 assert.equal(submitted,2,'unconfirmed click is quarantined and never repeated');
 console.log('Application flow: real observer fill + scoped dated CV + SAFE stop + mandatory-answer parking + LIVE confirmation/quarantine: PASS');
} finally {
 await browser.close();
 fs.rmSync(work,{recursive:true,force:true});
}

