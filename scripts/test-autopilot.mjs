import assert from 'node:assert/strict';
import { assessCanary, assessLiveHealth } from '../lib/autopilotPolicy.js';
import { selectLifoRows } from '../lib/masterTracker.js';

const base = {selected:3,boardAutomatable:3,atsAutomatable:0,
  engine:{dryRun:2,errors:1,deferred:0,loginRequired:[],rateLimited:[],uiUnavailable:[]},
  ats:{dryRun:0,errors:0}};
assert.equal(assessCanary(base).ready,true);
assert.equal(assessCanary({...base,engine:{...base.engine,dryRun:1}}).ready,false);
assert.equal(assessCanary({...base,engine:{...base.engine,loginRequired:['linkedin']}}).ready,false);
assert.equal(assessCanary({...base,engine:{...base.engine,rateLimited:['linkedin']}}).ready,false);
assert.equal(assessCanary({...base,engine:{...base.engine,uiUnavailable:['linkedin']}}).ready,false);
assert.equal(assessCanary({...base,engine:{...base.engine,errors:2}}).ready,false);
assert.equal(assessCanary({...base,selected:2,engine:{...base.engine,dryRun:1,errors:0}}).ready,true);
assert.equal(assessCanary({selected:0}).ready,false);
assert.equal(assessCanary({...base,engine:{...base.engine,dryRun:0,errors:0},ats:{dryRun:2,errors:0}}).ready,true);
assert.equal(assessLiveHealth({engine:{errors:3}}).quarantine,true);
assert.equal(assessLiveHealth({engine:{errors:1,loginRequired:['linkedin']}}).quarantine,true);
assert.equal(assessLiveHealth({engine:{errors:0,uiUnavailable:['linkedin']}}).quarantine,true);
assert.equal(assessLiveHealth({engine:{errors:1,loginRequired:[]}}).quarantine,false);

const profile={keywords:'Brand Marketing, Strategy Consulting',locations:'Delhi NCR, Jaipur, Remote, Dubai'};
const rows=[
 {record_id:'1',status:'NOT_APPLIED',source:'linkedin',connector:'linkedin',role:'Marketing Manager',location:'Paris, France',queued_at_ms:9000,sheet_row:5,url:'https://linkedin.com/jobs/view/1234567891'},
 {record_id:'2',status:'NOT_APPLIED',source:'linkedin',connector:'linkedin',role:'AI Engineer',location:'Jaipur',queued_at_ms:8000,sheet_row:6,url:'https://linkedin.com/jobs/view/1234567892'},
 {record_id:'3',status:'NOT_APPLIED',source:'linkedin',connector:'linkedin',role:'Growth Marketing Lead',location:'Jaipur, India',queued_at_ms:7000,sheet_row:7,url:'https://linkedin.com/jobs/view/1234567893'},
 {record_id:'4',status:'NOT_APPLIED',source:'linkedin',connector:'linkedin',role:'GTM Strategy Consultant',location:'Dubai, UAE',queued_at_ms:6000,sheet_row:8,url:'https://linkedin.com/jobs/view/1234567894'},
];
assert.deepEqual(selectLifoRows(rows,10,{armed:false,profile}).map(r=>r.record_id),['3','4']);
assert.deepEqual(selectLifoRows(rows,10,{armed:false}).map(r=>r.record_id),['1','2','3','4']);
// SAFE canaries prioritize never-tested jobs. LIVE preserves newest-first.
const canaryRows = [
  {...rows[2], status:'NOT_APPLIED', last_attempt_at:'2026-10-25T09:00:00Z'},
  {...rows[3], status:'NOT_APPLIED', last_attempt_at:'2026-10-25T09:10:00Z'},
  {record_id:'5',status:'NOT_APPLIED',role:'Marketing Director',location:'Jaipur, India',source:'linkedin',
    url:'https://linkedin.com/jobs/view/1234567895',queued_at_ms:5000,sheet_row:9,last_attempt_at:''},
];
assert.deepEqual(selectLifoRows(canaryRows,2,{armed:false,profile,preferUntested:true})
  .map(r=>r.record_id),['5','3']);
assert.deepEqual(selectLifoRows(canaryRows,2,{armed:true,profile,preferUntested:true})
  .map(r=>r.record_id),['3','4']);
console.log('AUTOPILOT safety gate, LIVE rollback, queue rotation, and relevance checks: PASS');
