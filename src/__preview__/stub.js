
const d=(n)=>{const x=new Date();x.setDate(x.getDate()+n);return x.toISOString().slice(0,10);};
const ts=(n,h=0)=>{const x=new Date();x.setDate(x.getDate()+n);x.setHours(x.getHours()-h);return x.toISOString();};
export const MEMBERS=[{id:'u-peter',display_name:'Peter',email:'peter@posup.co.uk',role:'owner'},{id:'u-sarah',display_name:'Sarah',email:'sarah@posup.co.uk',role:'editor'},{id:'u-james',display_name:'James',email:'james@posup.co.uk',role:'editor'}];
export const COMPANIES=[{id:'c1',name:'Coffee Boy — Barnsley'}];
export const DEALS=[{id:'d1',name:'Coffee Boy — Barnsley Train Station',company_id:'c1'}];
export const PROJECTS=[{id:'p1',name:'Adyen Onboarding',status:'active',subject_type:'deal',subject_id:'d1',owner_id:'u-peter',due_date:d(9),created_at:ts(-6),updated_at:ts(0),phases:['Account setup','Go live']}];
export const TASKS=[
 {id:'t1',title:'Create Adyen company account',status:'done',priority:'P2',project_id:'p1',phase:'Account setup',owner_id:'u-peter',due_date:d(-4),completed_at:ts(-4),created_at:ts(-6),updated_at:ts(-4),sort_order:0},
 {id:'t2',title:'Upload KYC documents',status:'done',priority:'P2',project_id:'p1',phase:'Account setup',owner_id:'u-sarah',due_date:d(-2),completed_at:ts(-1),created_at:ts(-6),updated_at:ts(-1),sort_order:1},
 {id:'t3',title:'Unable to add sub account',status:'in_progress',priority:'P1',project_id:'p1',phase:'Account setup',owner_id:'u-peter',due_date:d(0),description:'Cannot add sub account — the button is missing from my account. Likely a permissions scope on the parent.',created_by:'u-sarah',created_at:ts(-5),updated_at:ts(0,1),sort_order:2},
 {id:'t4',title:'Get access to live account',status:'blocked',priority:'P1',project_id:'p1',phase:'Go live',owner_id:'u-peter',due_date:d(-2),blocked_reason:'Adyen support ticket',created_at:ts(-5),updated_at:ts(0,3),sort_order:3},
 {id:'t5',title:'First live transaction test',status:'todo',priority:'P2',project_id:'p1',phase:'Go live',owner_id:'u-sarah',due_date:d(9),depends_on_id:'t4',created_at:ts(-5),updated_at:ts(-5),sort_order:4},
 {id:'s1',title:'Check parent verification',status:'done',project_id:'p1',parent_task_id:'t3',owner_id:'u-peter',completed_at:ts(-1),created_at:ts(-2),updated_at:ts(-1),sort_order:0},
 {id:'s3',title:'Raise Adyen support ticket',status:'todo',project_id:'p1',parent_task_id:'t3',owner_id:'u-peter',created_at:ts(-2),updated_at:ts(-2),sort_order:2},
];
const W=(o)=>({type:'task',source_table:'tasks',blocked_reason:null,created_by:'u-peter',link:{},...o});
export const WORK=[
 W({type:'ticket',source_table:'tickets',source_id:'k1',title:'Card machine offline at lunch',subtitle:'Verde — Macclesfield · 2.4 mi away',owner_id:'u-peter',status:'in_progress',priority:'P1',due_at:new Date(Date.now()-40*60e3).toISOString(),updated_at:ts(0)}),
 W({type:'onboarding',source_table:'onboardings',source_id:'o1',title:'Fourelephants — hardware not shipped',subtitle:'Stage 4 of 9',owner_id:'u-peter',status:'blocked',priority:'P2',due_at:d(-11)+'T00:00:00Z',updated_at:ts(-2)}),
 W({type:'approval',source_table:'expenses',source_id:'e1',title:'Bill — Lightspeed POS UK Ltd',subtitle:'£2,480',owner_id:null,created_by:'u-james',status:'todo',priority:'P2',due_at:d(0)+'T09:00:00Z',updated_at:ts(0)}),
 W({source_id:'t3',title:'Unable to add sub account',subtitle:'Evuna — Northern Quarter · timer running',owner_id:'u-peter',status:'in_progress',priority:'P1',due_at:d(0)+'T00:00:00Z',updated_at:ts(0)}),
 W({source_id:'t9',title:'Hare and Hounds — menu sign-off',subtitle:'Onboarding stage 6 of 9',owner_id:'u-peter',status:'todo',priority:'P2',due_at:d(0)+'T00:00:00Z',updated_at:ts(0)}),
 W({source_id:'t10',title:'Book install — Leeds',subtitle:'Cafe Brigante',owner_id:'u-peter',status:'todo',priority:'P2',due_at:d(0)+'T00:00:00Z',updated_at:ts(-1)}),
];
export const ACTIVITIES=[{id:'a1',type:'note',subject:'Cannot add sub account button is missing from my account',body:'Cannot add sub account button is missing from my account',actor_id:'u-peter',occurred_at:ts(0,0.05),subject_type:'task',subject_id:'t3'}];
function pick(t){return t==='work_items'?WORK:t==='profiles'?MEMBERS:t==='crm_projects'?PROJECTS:t==='tasks'?TASKS:t==='companies'?COMPANIES:t==='deals'?DEALS:t==='crm_activities'?ACTIVITIES:[];}
function q(t){let rows=pick(t).slice();let head=false;const api={select(_c,o){if(o?.head)head=true;return api;},eq(k,v){rows=rows.filter(r=>r[k]===v);return api;},neq(k,v){rows=rows.filter(r=>r[k]!==v);return api;},is(k,v){rows=rows.filter(r=>v===null?r[k]==null:r[k]===v);return api;},in(k,a){rows=rows.filter(r=>a.includes(r[k]));return api;},not(){return api;},or(){return api;},order(){return api;},limit(n){rows=rows.slice(0,n);return api;},gte(){return api;},single(){return Promise.resolve({data:rows[0]||null,error:null});},maybeSingle(){return Promise.resolve({data:rows[0]||null,error:null});},then(r){return Promise.resolve(head?{data:null,error:null,count:rows.length}:{data:rows,error:null,count:rows.length}).then(r);}};return api;}
export const supabase={from:(t)=>({...q(t),insert:()=>({select:()=>({single:()=>Promise.resolve({data:{id:'new',title:'New'},error:null})}),then:(r)=>Promise.resolve({data:null,error:null}).then(r)}),update:()=>({eq:()=>Promise.resolve({data:null,error:null}),in:()=>Promise.resolve({data:null,error:null})}),delete:()=>({eq:()=>Promise.resolve({data:null,error:null})})}),channel:()=>({on(){return this;},subscribe(){return this;}}),removeChannel:()=>{},auth:{getSession:()=>Promise.resolve({data:{session:null}})}};
