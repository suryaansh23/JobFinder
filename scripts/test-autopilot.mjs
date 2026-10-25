import assert from 'node:assert/strict';
import { assessCanary, assessLiveHealth } from '../lib/autopilotPolicy.js';
import { selectLifoRows } from '../lib/masterTracker.js';

const { PREPARATION_VERSION, processOrderedApplications, selectCanaryRows, retryAttempts } = await import('../lib/orderedApplications.js');
const channel = {channel:'linkedin',selected:3,prepared:2,errors:0,unconfirmed:0,blocked:[]};
const base = {selected:3,preparationVersion:PREPARATION_VERSION,channels:[channel]};
assert.equal(assessCanary(base).ready,true);
assert.equal(assessCanary({...base,channels:[{...channel,prepared:1}]}).ready,false);
for (const blocked of ['auth_required','rate_limited','ui_unavailable']) {
 assert.equal(assessCanary({...base,channels:[{...channel,blocked:[blocked]}]}).ready,false);
}
assert.equal(assessCanary({...base,channels:[{...channel,errors:2}]}).ready,false);
assert.equal(assessCanary({...base,channels:[{...channel,unconfirmed:1}]}).ready,false);
assert.equal(assessCanary({...base,channels:[{...channel,selected:2,prepared:1}]}).ready,false);
assert.equal(assessCanary({...base,channels:[{...channel,selected:1,prepared:1}]}).ready,true);
assert.equal(assessCanary({selected:0,preparationVersion:PREPARATION_VERSION}).ready,false);
assert.equal(assessCanary({...base,preparationVersion:'old-engine'}).ready,false);
assert.equal(assessCanary({selected:3,engine:{dryRun:3}}).ready,false,'legacy aggregate counts cannot arm LIVE');
const mixed = {...base,channels:[{...channel,prepared:0,blocked:['ui_unavailable']},{...channel,channel:'naukri',selected:1,prepared:1}]};
assert.deepEqual(assessCanary(mixed).qualifiedChannels,['naukri'],'Naukri success cannot authorize LinkedIn');
assert.equal(assessLiveHealth({...base,channels:[{...channel,errors:3}]}).quarantine,true);
assert.equal(assessLiveHealth({...base,channels:[{...channel,unconfirmed:1}]}).quarantine,true);
assert.equal(assessLiveHealth(base).quarantine,false);
const queue=[
 {job_id:'first',connector:'linkedin',url:'https://linkedin.com/jobs/view/1234567891'},
 {job_id:'second',connector:'tracker',url:'https://jobs.lever.co/example/12345678-1234'},
 {job_id:'third',connector:'linkedin',url:'https://linkedin.com/jobs/view/1234567893'},
 {job_id:'fourth',connector:'naukri',url:'https://naukri.com/job-listings-example'},
];
assert.equal(retryAttempts(2,'dry_run'),2);
assert.equal(retryAttempts(2,'needs_input'),2);
assert.equal(retryAttempts(2,'ui_unavailable'),2);
assert.equal(retryAttempts(2,'error'),3);
assert.deepEqual(selectCanaryRows([...queue.slice(0,1),...Array.from({length:20},(_,i)=>({...queue[0],job_id:'bulk'+i})),...queue.slice(1)],10).map(r=>r.job_id),['first','bulk0','second','fourth']);
const calls=[];let active=0;
const processed=await processOrderedApplications(queue,{
 onStart:async(r)=>{calls.push('start:'+r.job_id);assert.equal(active,0);active++;},
 execute:async(r)=>{calls.push('apply:'+r.job_id);return r.job_id==='first'?{state:'ui_unavailable'}:{state:'dry_run',preparationValidated:true};},
 onResult:async(r)=>{calls.push('saved:'+r.job_id);active--;},
});
assert.deepEqual(calls,['start:first','apply:first','saved:first','start:second','apply:second','saved:second','start:fourth','apply:fourth','saved:fourth']);
assert.equal(processed.channels.find(c=>c.channel==='linkedin').blocked[0],'ui_unavailable');
assert.equal(processed.channels.find(c=>c.channel==='lever').prepared,1);
assert.equal(processed.results.some(r=>r.job_id==='third'),false,'remaining blocked-provider jobs stay untouched');

const profile={keywords:'Brand Marketing, Strategy Consulting',locations:'Delhi NCR, Jaipur, Remote, Dubai'};
const rows=[
 {record_id:'1',status:'NOT_APPLIED',source:'linkedin',connector:'linkedin',role:'Marketing Manager',location:'Paris, France',queued_at_ms:9000,sheet_row:5,url:'https://linkedin.com/jobs/view/1234567891'},
 {record_id:'2',status:'NOT_APPLIED',source:'linkedin',connector:'linkedin',role:'AI Engineer',location:'Jaipur',queued_at_ms:8000,sheet_row:6,url:'https://linkedin.com/jobs/view/1234567892'},
 {record_id:'3',status:'NOT_APPLIED',source:'linkedin',connector:'linkedin',role:'Growth Marketing Lead',location:'Jaipur, India',queued_at_ms:7000,sheet_row:7,url:'https://linkedin.com/jobs/view/1234567893'},
 {record_id:'4',status:'NOT_APPLIED',source:'linkedin',connector:'linkedin',role:'GTM Strategy Consultant',location:'Dubai, UAE',queued_at_ms:6000,sheet_row:8,url:'https://linkedin.com/jobs/view/1234567894'},
];
assert.deepEqual(selectLifoRows(rows,10,{armed:false,profile}).map(r=>r.record_id),['3','4']);
assert.deepEqual(selectLifoRows(rows,10,{armed:false}).map(r=>r.record_id),['1','2','3','4']);
console.log('AUTOPILOT: provider evidence, version invalidation, serial LIFO, failure isolation and relevance: PASS');
