import assert from 'node:assert/strict';
import { chooseLinkedInApplyControl as choose } from '../lib/linkedinApplyControl.js';

const id='4455206621';
const a={visible:true,disabled:false,inMain:true,primary:false,applyButton:false,aria:'',contextJobId:''};
const other={...a,index:0,text:'Easy Apply',href:'https://linkedin.com/jobs/view/9999999999/apply'};
const correct={...a,index:2,text:'Easy Apply',primary:true,href:'/jobs/view/'+id+'/apply'};
assert.equal(choose([other,correct],id)?.index,2);
assert.equal(choose([other],id),null);
assert.equal(choose([{...a,index:1,text:'Easy Apply',inSidebar:true}],id),null);
assert.equal(choose([{...a,index:1,text:'Easy Apply',contextJobId:'9999999999'}],id),null);
assert.equal(choose([{...a,index:1,text:'Easy Apply',contextJobId:'urn:li:jobPosting:9999999999'}],id),null);
assert.equal(choose([{...a,index:1,text:'Easy Apply',disabled:true}],id),null);
assert.equal(choose([{...a,index:4,text:'',aria:'Easy Apply to Company',applyButton:true}],id)?.kind,'easy');
assert.equal(choose([{...a,index:4,text:'Apply',primary:true}],id)?.kind,'external');
assert.equal(choose([{...a,index:4,text:'Apply',primary:true,href:'/jobs/view/1111111111/'}],id),null);
assert.equal(choose([{...a,index:4,text:'Easy Apply',primary:true,href:'/jobs/view/'+id+'/'}],id)?.kind,'easy');
assert.equal(choose([{...a,index:2,text:'Easy Apply',primary:true},
                     {...a,index:3,text:'Apply',primary:true}],id)?.kind,'easy');
assert.equal(choose([correct], 'invalid'),null);
console.log('LinkedIn job-specific apply-control selection: PASS');
