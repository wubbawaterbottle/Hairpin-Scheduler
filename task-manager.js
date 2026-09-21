/* Project Hairpin production manager — spreadsheet-first workspace.
   The public scheduler remains unchanged; this private page loads only after the
   existing edit code is verified.

   Three views over the private production database:
     To-do      — one table grouped by assignee, inline edits, drag ordering
     Sequences  — one row per sequence, linked chips for every requirement
     People     — one row per person, contract state, filters

   Every write is one small JSONP call. The backend returns the saved row, which is
   merged into memory and re-rendered in place. The database is downloaded once per
   unlock, never after a checkbox. */
var production={people:[],items:[],requirements:[],staffing:[],tasks:[],notes:[]};
var tmLoaded=false,tmLoading=false,tmView="sequences",tmQuery="",tmDrag=null;   // Sequences opens first (Mr. John, 2026-09-17) and is the data authority.
var tmPeopleFilter="all",tmShowDone=false,tmShowRemoved=false,tmPending=0,tmSavedTimer=null;
var TM_GROUPS=["Cast","Crew","Producer","Extras","Stunts","HMU","Wardrobe"];
var tmJustDone={};   // tasks ticked this session stay visible, struck through, until the view is reopened
var tmIx={items:{},people:{},reqsByScene:{},staffByScene:{},tasksByScene:{},tasksByItem:{},reqsByItem:{},staffByPerson:{}};
var TM_STATUSES=["Red","Orange","Yellow","Green"];
var TM_PROJECT=["Candidate","Contacted","Listed","Formally Attached","Released"];
var TM_CONTRACT=["","Not Sent","Sent","Signed","Not Required"];
/* Optional To-do columns behind "+ Add column". The sheet's Production Tasks tab
   defines the available fields; a brand-new field needs a column there and in
   TASK_FIELDS in Code.gs before the app can write it. */
var TM_OPTIONAL_COLS=[["TASK_TYPE","Type"],["DUE_NOTE","Due note"],["SCOPE_TYPE","Scope"],["CREATED_AT","Created"],["UPDATED_AT","Updated"]];
var tmCols=[];
try{tmCols=JSON.parse(localStorage.getItem("hairpinTodoCols")||"[]")}catch(e){tmCols=[]}

// ── shell ────────────────────────────────────────────────────
function centralToday(){
  return new Intl.DateTimeFormat("en-US",{timeZone:"America/Chicago",weekday:"short",month:"short",day:"numeric",year:"numeric"}).format(new Date());
}
function updateToday(){var el=document.getElementById("todayDate");if(el)el.innerHTML=centralToday().replace(", ","<br>")}
function showAppPage(page){
  var task=page==="tasks";
  document.getElementById("schedulerPage").hidden=task;
  document.getElementById("taskManagerPage").hidden=!task;
  document.getElementById("schedulerTab").classList.toggle("active",!task);
  document.getElementById("tasksTab").classList.toggle("active",task);
  document.getElementById("sbToggle").style.display=task?"none":"";
  document.getElementById("newSceneBtn").style.display=!task&&canEdit()?"":"none";
  if(task){if(canEdit())loadProduction();else renderTaskManager();}
  else tmRenderSchedulerIfDirty();
}
function tmBool(v){return v===true||String(v).toLowerCase()==="true"}
function tmNum(v,d){var n=Number(v);return isNaN(n)||v===""||v===null||v===undefined?d:n}
function tmById(list,key,id){for(var i=0;i<list.length;i++)if(String(list[i][key])===String(id))return list[i];return null}
function tmScene(uid){return getScene(uid)||{uid:uid,seqLabel:uid,seq:"",title:"Unknown scene",shootDay:""}}
function tmStatus(value){value=String(value||"Red");return /^(Red|Orange|Yellow|Green)$/.test(value)?value:"Red"}
function tmStatusRank(value){return {Red:0,Orange:1,Yellow:2,Green:3}[tmStatus(value)]}
function tmInherited(req){var item=tmIx.items[req.ITEM_ID];return tmStatus(req.STATUS_OVERRIDE||item&&item.STATUS)}
function tmSplitIds(v){return String(v||"").split(/[;,\n]+/).map(function(s){return s.trim()}).filter(Boolean)}
function tmPerson(id){return tmIx.people[id]||null}
function tmPersonName(id){var p=tmPerson(id);return p?p.NAME:id}
function tmFirstName(s){return String(s||"").split(" ")[0]}
function tmDaysUntil(date){if(!date)return null;var now=new Date(),today=new Date(now.getFullYear(),now.getMonth(),now.getDate());var due=new Date(String(date).slice(0,10)+"T12:00:00");if(isNaN(due))return null;return Math.ceil((due-today)/86400000)}
function tmDueClass(date){var d=tmDaysUntil(date);if(d===null)return"";if(d<0)return"due-over";if(d<=7)return"due-soon";return""}
function tmFmtDate(k){if(!k)return"";var p=String(k).slice(0,10).split("-");if(p.length!==3)return String(k);var M=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];return M[parseInt(p[1],10)-1]+" "+parseInt(p[2],10)}
function tmMatch(text){return !tmQuery||String(text||"").toLowerCase().indexOf(tmQuery.toLowerCase())>=0}
/* esc() covers &, < and >. Attribute values also need both quote styles escaped,
   or a title like Need to find the "Above Ground" area. gets cut at the quote. */
function tmAttr(s){return esc(s).replace(/"/g,"&quot;").replace(/'/g,"&#39;")}

function tmActive(p){return !!p&&!(String(p.ACTIVE)!==""&&tmBool(p.ACTIVE)===false)}
function tmActivePeople(){return production.people.filter(tmActive).sort(function(a,b){return String(a.NAME).localeCompare(String(b.NAME))})}
/** IDs follow the imported pattern (PER-PERS-FIRST-LAST-XXXX) so the sheet stays uniform. */
function tmNewPersonId(name){
  var slug=String(name||"person").toUpperCase().replace(/[^A-Z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,40)||"PERSON";
  var hex=Math.floor(Math.random()*65536).toString(16).toUpperCase();while(hex.length<4)hex="0"+hex;
  return"PER-PERS-"+slug+"-"+hex;
}
/** Person contract state → one colour. Green means signed or not required. */
function tmPersonState(p){
  if(!p)return"red";
  if(!tmActive(p))return"muted";
  var c=p.CONTRACT_STATUS||"";
  if(c==="Signed"||c==="Not Required")return"green";
  if(c==="Sent")return"yellow";
  if(p.PROJECT_STATUS==="Formally Attached"||p.PROJECT_STATUS==="Listed")return"orange";
  return"red";
}

// ── indexes ──────────────────────────────────────────────────
function tmIndex(){
  var ix={items:{},people:{},reqsByScene:{},staffByScene:{},tasksByScene:{},tasksByItem:{},reqsByItem:{},staffByPerson:{}};
  function push(map,k,v){if(!k)return;(map[k]=map[k]||[]).push(v)}
  production.items.forEach(function(i){ix.items[i.ITEM_ID]=i});
  production.people.forEach(function(p){ix.people[p.PERSON_ID]=p});
  production.requirements.forEach(function(r){push(ix.reqsByScene,r.SCENE_UID,r);push(ix.reqsByItem,r.ITEM_ID,r)});
  production.staffing.forEach(function(s){push(ix.staffByScene,s.SCENE_UID,s);tmSplitIds(s.ASSIGNED_PERSON_IDS).forEach(function(pid){push(ix.staffByPerson,pid,s)})});
  production.tasks.forEach(function(t){push(ix.tasksByScene,t.SCENE_UID,t);push(ix.tasksByItem,t.ITEM_ID,t)});
  tmIx=ix;
}
/** Keep the Scheduler's in-memory scene model on the same canonical links as the
    Sequences workspace. No page reload and no second database. */
function tmSyncSceneModel(uid){
  var s=getScene(uid);if(!s)return;
  var raw={locations:[],props:[],vehicles:[],wardrobe:[],hairMakeup:[],vfx:[],stunts:[],cast:[],extras:[]},canon={locations:[],props:[]};
  function add(a,v){v=String(v||"").trim();if(v&&a.indexOf(v)<0)a.push(v)}
  (tmIx.reqsByScene[uid]||[]).forEach(function(r){
    var it=tmIx.items[r.ITEM_ID];if(!it||!tmActive(it))return;var w=r.SCENE_WORDING||it.NAME;
    if(it.TYPE==="Location"){add(raw.locations,w);add(canon.locations,it.NAME)}
    else if(it.TYPE==="Prop"){add(raw.props,w);add(canon.props,it.NAME)}
    else if(it.TYPE==="Vehicle"){add(raw.vehicles,w);add(raw.props,w);add(canon.props,it.NAME)}
    else if(it.TYPE==="Wardrobe")add(raw.wardrobe,w);
    else if(it.TYPE==="Hair & Makeup")add(raw.hairMakeup,w);
    else if(it.TYPE==="VFX / SFX")add(raw.vfx,w);
    else if(it.TYPE==="Stunt")add(raw.stunts,w);
  });
  (tmIx.staffByScene[uid]||[]).forEach(function(st){
    if(st.DEPARTMENT==="Cast"){
      add(raw.cast,st.ROLE);
      var ids=tmSplitIds(st.ASSIGNED_PERSON_IDS),cat=typeof getCat==="function"?getCat("cast"):null;
      if(ids.length===1&&cat&&cat.meta&&cat.meta[st.ROLE])cat.meta[st.ROLE].note=tmPersonName(ids[0]);
    }else if(st.DEPARTMENT==="Extras")add(raw.extras,st.ROLE);
  });
  s.raw=s.raw||{};
  Object.keys(raw).forEach(function(k){s.raw[k]=raw[k]});
  s.locations=canon.locations;s.props=canon.props;s.cast=raw.cast.slice();s.extras=raw.extras.slice();
  s.hasStunts=raw.stunts.length>0;s.hasVfx=raw.vfx.length>0;
}
/* The Scheduler's calendar/sidebar are hidden while the Task Manager is open, so a
   full Scheduler render on every save is wasted work that only causes jank. Mark it
   dirty and render once when the tab is next shown. */
var tmSchedulerDirty=false;
function tmSyncAffected(uids){
  (uids||[]).filter(function(x,i,a){return x&&a.indexOf(x)===i}).forEach(tmSyncSceneModel);
  tmSchedulerDirty=true;
}
function tmRenderSchedulerIfDirty(){if(tmSchedulerDirty&&typeof render==="function"){tmSchedulerDirty=false;render()}}
function tmMerge(list,key,record){
  if(!record)return null;
  for(var i=0;i<list.length;i++)if(String(list[i][key])===String(record[key])){list[i]=Object.assign({},list[i],record);tmIndex();return list[i]}
  list.push(record);tmIndex();return record;
}
function tmRemove(list,key,id){for(var i=0;i<list.length;i++)if(String(list[i][key])===String(id)){list.splice(i,1);break}tmIndex()}

// ── loading ──────────────────────────────────────────────────
function tmLoadError(msg){document.getElementById("taskManagerPage").innerHTML='<div class="tm-lock"><h2>Task Manager</h2><p>'+esc(msg)+'</p><button class="mbtn gold" onclick="promptEditKey(function(){loadProduction(true)})">Unlock</button></div>'}
function syncProductionLock(){
  if(canEdit())return;
  tmLoaded=false;
  production={people:[],items:[],requirements:[],staffing:[],tasks:[],notes:[]};tmIndex();
  var page=document.getElementById("taskManagerPage");
  if(page&&!page.hidden)renderTaskManager();
}
/** Downloads the private database. Shows a loading panel only the first time;
    a later sync keeps the current table on screen until the new data arrives. */
function loadProduction(force){
  if(!canEdit()){tmLoadError("Unlock editing to view private production details, contracts, assignments and notes.");return Promise.resolve(false)}
  if(tmLoaded&&!force){renderTaskManager();return Promise.resolve(true)}
  if(tmLoading)return Promise.resolve(false);
  tmLoading=true;
  if(!tmLoaded)document.getElementById("taskManagerPage").innerHTML='<div class="tm-lock"><h2>Loading production data…</h2><p>One download. Edits after this save in place.</p></div>';
  else tmSaveState("syncing");
  return api("action=getProduction&key="+encodeURIComponent(editKey)).then(function(data){
    tmLoading=false;
    if(!data||data.error){if(data&&data.error==="locked"){editKey="";applyLock()}if(!tmLoaded)tmLoadError(data&&data.message||data&&data.error||"Could not load production data.");else tmSaveState("error","Sync failed");return false}
    // never clobber an edit that is still on its way to the sheet
    if(tmPending>0||(typeof writesInFlight!=="undefined"&&writesInFlight>0)){tmRefreshWanted=true;tmSaveState("");return false}
    production=data;["people","items","requirements","staffing","tasks","notes"].forEach(function(k){production[k]=production[k]||[]});
    tmIndex();
    var wasLoaded=tmLoaded;tmLoaded=true;
    if(wasLoaded&&document.getElementById("tmBody"))renderTaskBody();   // quiet: keep toolbar, search box and scroll
    else renderTaskManager();
    if(force)tmSaveState("saved","Synced");return true;
  });
}
/* A refresh that had to wait (edits in flight, a popover or drawer open, a cell being
   typed in) runs once things go quiet. */
var tmRefreshWanted=false;
function tmBusyEditing(){
  var page=document.getElementById("taskManagerPage");
  if(document.getElementById("tmPop")||document.getElementById("tmModalMount"))return true;
  var a=document.activeElement;
  return !!(a&&page&&page.contains(a)&&(a.isContentEditable||/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)));
}
setInterval(function(){
  if(!tmRefreshWanted||!tmLoaded||!canEdit())return;
  if(tmPending>0||(typeof writesInFlight!=="undefined"&&writesInFlight>0)||tmBusyEditing())return;
  var page=document.getElementById("taskManagerPage");if(!page||page.hidden)return;
  tmRefreshWanted=false;loadProduction(true);
},4000);
/* Called by the scheduler when the sheet's revision changes under us. Refreshes
   quietly unless Mr. John is mid-edit in a cell. */
function tmOnSheetRefresh(){
  if(!tmLoaded||!canEdit())return;
  var page=document.getElementById("taskManagerPage");if(!page||page.hidden){tmRefreshWanted=true;return}
  if(tmPending>0||(typeof writesInFlight!=="undefined"&&writesInFlight>0)||tmBusyEditing()){tmRefreshWanted=true;return}
  loadProduction(true);
}

// ── saving ───────────────────────────────────────────────────
function tmSaveState(state,msg){
  var el=document.getElementById("tmSaveState");if(!el)return;
  clearTimeout(tmSavedTimer);
  if(state==="saving"){el.className="tm-save saving";el.textContent=msg||"Saving…"}
  else if(state==="syncing"){el.className="tm-save saving";el.textContent="Syncing…"}
  else if(state==="error"){el.className="tm-save error";el.textContent=msg||"Save failed"}
  else if(state==="saved"){el.className="tm-save saved";el.textContent=msg||"Saved";tmSavedTimer=setTimeout(function(){if(el.className.indexOf("saved")>=0){el.className="tm-save";el.textContent=""}},2500)}
  else{el.className="tm-save";el.textContent=""}
}
/** One write. Resolves with the backend result; the caller merges result.record. */
var tmChainLabel="";
function tmSave(payload,opts){
  tmPending++;tmSaveState("saving",tmChainLabel||"Saving…");
  return apiWrite(payload).then(function(r){
    tmPending--;
    if(r&&r.error&&opts&&opts.quietNotFound&&/Record not found/i.test(r.error)){if(!tmPending)tmSaveState("saved");return r}
    if(!r||r.error){
      var msg=tmErrorText(r);
      tmSaveState("error",msg);toast(msg,"err");
      clearTimeout(tmSavedTimer);tmSavedTimer=setTimeout(function(){var el=document.getElementById("tmSaveState");if(el&&el.className.indexOf("error")>=0){el.className="tm-save";el.textContent=""}},8000);
      return r||{error:"no response"};
    }
    if(!tmPending)tmSaveState("saved");
    return r;
  });
}
/** Turns backend errors into something Mr. John can act on. */
function tmErrorText(r){
  var e=r&&r.error?String(r.error):"no response";
  if(/Unknown write action:\s*delete/i.test(e))return"Removing needs the new Code.gs — do Part 1 of the deployment steps (paste, then Deploy → New version)";
  if(/Unknown write action/i.test(e))return"The live Code.gs is older than the app — do Part 1 of the deployment steps";
  if(/locked/i.test(e))return"Editing is locked — tap the lock and enter the code";
  if(/Timeout/i.test(e))return"The sheet didn't answer in time — the change is undone here; try again";
  return"Save failed: "+e;
}
/* Optimistic saves. The record goes into memory first and the screen updates at
   once; the write runs in the background. If the sheet refuses, the previous
   state is put back and the error is shown. IDs are generated here so a brand-new
   row never has to be swapped for a server id. */
var TM_LISTS={task:["tasks","TASK_ID","TSK"],item:["items","ITEM_ID","ITM"],person:["people","PERSON_ID","PER"],staffing:["staffing","STAFFING_ID","STF"],requirement:["requirements","REQUIREMENT_ID","REQ"],note:["notes","NOTE_ID","NOTE"]};
var TM_ACTIONS={task:"saveTask",item:"saveItem",person:"savePerson",staffing:"saveStaffing",requirement:"saveRequirement",note:"saveNote"};
function tmEnsureId(kind,record){var k=TM_LISTS[kind];if(!record[k[1]])record[k[1]]=k[2]+"-"+tmHex(4)+"-"+tmHex(4);return record}
function tmOptimistic(kind,record,after){
  var list=production[TM_LISTS[kind][0]],key=TM_LISTS[kind][1];
  tmEnsureId(kind,record);
  var prev=tmById(list,key,record[key]);prev=prev?Object.assign({},prev):null;
  tmMerge(list,key,record);
  if(after)after();
  return tmSave({action:TM_ACTIONS[kind],record:record}).then(function(r){
    if(r&&!r.error){if(r.record)tmMerge(list,key,r.record);return r}
    if(prev)tmMerge(list,key,prev);else tmRemove(list,key,record[key]);   // roll back
    if(after)after();
    return r;
  });
}
function tmOptimisticDelete(kind,id,action,after){
  var list=production[TM_LISTS[kind][0]],key=TM_LISTS[kind][1];
  var prev=tmById(list,key,id);if(!prev)return Promise.resolve({success:true});
  var at=list.indexOf(prev);prev=Object.assign({},prev);tmRemove(list,key,id);
  if(after)after();
  return tmSave({action:action,id:id},{quietNotFound:true}).then(function(r){
    if(r&&!r.error)return r;
    // "Record not found" means the sheet already lost this row (an earlier attempt that
    // looked like it failed actually went through). The removal stands; resync quietly.
    if(r&&/Record not found/i.test(r.error)){tmRefreshWanted=true;tmSaveState("saved","Already removed");return {success:true,alreadyGone:true}}
    list.splice(Math.min(at,list.length),0,prev);tmIndex();if(after)after();   // roll back, same position
    return r;
  });
}
function tmSaveTask(record,after){return tmOptimistic("task",record,after)}
function tmSaveItem(record,after){
  var reqs=tmIx.reqsByItem[record.ITEM_ID]||[],uids=reqs.map(function(r){return r.SCENE_UID});
  // a rename carries along scene wording that was just a copy of the old name (the
  // backend does the same in one write), so call sheets read the new name too
  var prev=tmIx.items[record.ITEM_ID];
  if(prev&&String(prev.NAME)!==String(record.NAME))reqs.forEach(function(r){if(!r.SCENE_WORDING||tmNameKey(r.SCENE_WORDING)===tmNameKey(prev.NAME))r.SCENE_WORDING=record.NAME});
  return tmOptimistic("item",record,function(){tmSyncAffected(uids);if(after)after()});
}
function tmSavePerson(record,after){return tmOptimistic("person",record,after)}
function tmSaveStaffing(record,after){
  var related=record.DEPARTMENT==="Cast"?production.staffing.filter(function(st){return st.DEPARTMENT==="Cast"&&tmNameKey(st.ROLE)===tmNameKey(record.ROLE)}):[record];
  var uids=related.map(function(st){return st.SCENE_UID});
  // mirror the backend: one actor per character. A new row with no actor inherits
  // the character's existing actor; only an existing row saved empty un-casts.
  if(record.DEPARTMENT==="Cast"){
    var isNew=!tmById(production.staffing,"STAFFING_ID",record.STAFFING_ID);
    if(!record.ASSIGNED_PERSON_IDS&&isNew){var sib=related.filter(function(st){return st.ASSIGNED_PERSON_IDS})[0];if(sib)record.ASSIGNED_PERSON_IDS=sib.ASSIGNED_PERSON_IDS}
    if(record.ASSIGNED_PERSON_IDS||!isNew)related.forEach(function(st){st.ASSIGNED_PERSON_IDS=record.ASSIGNED_PERSON_IDS;st.CONFIRMED_COUNT=record.ASSIGNED_PERSON_IDS?1:0;st.GAP=record.ASSIGNED_PERSON_IDS?0:tmNum(st.NEEDED,1)});
  }
  return tmOptimistic("staffing",record,function(){tmIndex();tmSyncAffected(uids);if(after)after()}).then(function(r){if(r&&r.error)loadProduction(true);return r});
}
function tmSaveRequirement(record,after){
  return tmOptimistic("requirement",record,function(){tmSyncAffected([record.SCENE_UID]);if(after)after()});
}
function tmSaveNote(record,after){return tmOptimistic("note",record,after)}
/** Several small writes in a row (one per scene), with "Saving 3/9…" progress. Stops at the first failure. */
function tmSaveChain(jobs,label){
  var done=0,failed=null,chain=Promise.resolve();
  jobs.forEach(function(job){chain=chain.then(function(){if(failed)return;tmChainLabel=(label||"Saving")+" "+(done+1)+"/"+jobs.length+"…";tmSaveState("saving",tmChainLabel);return job().then(function(r){if(!r||r.error)failed=r||{error:"no response"};else done++})})});
  return chain.then(function(){tmChainLabel="";if(!failed&&!tmPending)tmSaveState("saved",label?label+" done":"Saved");return {done:done,total:jobs.length,failed:failed}});
}

/** Inline field edit: patch one field on one record, save, re-render the view. */
function tmPatch(kind,id,field,value){
  var list={task:production.tasks,item:production.items,person:production.people}[kind];
  var key={task:"TASK_ID",item:"ITEM_ID",person:"PERSON_ID"}[kind];
  var rec=tmById(list,key,id);if(!rec)return Promise.resolve(null);
  if(String(rec[field]===undefined||rec[field]===null?"":rec[field])===String(value))return Promise.resolve(rec);
  var record=Object.assign({},rec);record[field]=value;
  if(kind==="task"&&field==="DONE"){if(value){record.STATUS_COLOR="Green";tmJustDone[id]=true}else delete tmJustDone[id]}
  var save={task:tmSaveTask,item:tmSaveItem,person:tmSavePerson}[kind];
  return save(record,renderTaskBody);
}
function tmEditText(el,kind,id,field){
  var v=el.innerText.replace(/ /g," ").trim();
  tmPatch(kind,id,field,v);
}
function tmEditKey(e,el){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();el.blur()}if(e.key==="Escape"){el.blur()}}

// ── frame ────────────────────────────────────────────────────
function tmSetView(view){tmView=view;tmJustDone={};renderTaskManager()}
function tmSetQuery(value){tmQuery=value;renderTaskBody()}
function renderTaskManager(){
  updateToday();
  if(!canEdit()){tmLoadError("Unlock editing to view private production details, contracts, assignments and notes.");return}
  if(!tmLoaded){loadProduction();return}
  var tabs=[["sequences","Sequences · Master"],["todo","To-do"],["people","People & Contracts"]];
  var h='<div class="tm-shell"><div class="tm-toolbar"><div class="tm-subtabs">';
  for(var i=0;i<tabs.length;i++)h+='<button class="tm-subtab '+(tmView===tabs[i][0]?"active":"")+'" onclick="tmSetView(\''+tabs[i][0]+'\')">'+tabs[i][1]+'</button>';
  h+='</div><span class="tm-authority" title="Sequence records drive Scheduler and Calendar">Sequences → Scheduler → Calendar</span><span id="tmSaveState" class="tm-save"></span><input class="tm-search" value="'+tmAttr(tmQuery)+'" placeholder="Search" oninput="tmSetQuery(this.value)">';
  h+='<button class="hbtn" onclick="loadProduction(true)" title="Re-download from the sheet">&#8635; Sync</button></div><div id="tmBody"></div></div>';
  document.getElementById("taskManagerPage").innerHTML=h;renderTaskBody();
}
/* The page (#taskManagerPage) is the scroll container, not #tmBody — so keep and
   restore ITS position around a re-render, or every save jumps to the top. */
function tmKeepScroll(fn){
  var page=document.getElementById("taskManagerPage"),y=page?page.scrollTop:0;
  fn();
  if(page){page.scrollTop=y;requestAnimationFrame(function(){page.scrollTop=y})}
}
function renderTaskBody(){
  var mount=document.getElementById("tmBody");if(!mount)return;
  tmKeepScroll(function(){
    if(tmView==="sequences")mount.innerHTML=tmRenderSequences();
    else if(tmView==="people")mount.innerHTML=tmRenderPeople();
    else mount.innerHTML=tmRenderTodo();
  });
}

// ── chips ────────────────────────────────────────────────────
/** Item chip. With a requirement (scene context) it opens the small in-scene
    popover; on its own it opens the full master record. */
function tmItemChip(item,req){
  if(!item)return'<span class="tm-chip st-red" title="Missing item record">'+esc(req?req.SCENE_WORDING||req.ITEM_ID:"?")+'</span>';
  var st=req?tmInherited(req):tmStatus(item.STATUS);
  var tip=item.NAME+(req&&req.SCENE_WORDING&&req.SCENE_WORDING!==item.NAME?' — in this scene: '+req.SCENE_WORDING:'')+(req&&req.NOTES?' — '+req.NOTES:'')+(item.NOTES?' — '+item.NOTES:'');
  var sub=req&&item.TYPE==="Location"&&req.SCENE_WORDING&&tmNameKey(req.SCENE_WORDING)!==tmNameKey(item.NAME)?'<span class="tm-chip-sub">'+esc(req.SCENE_WORDING)+'</span>':'';
  var click=req?'tmOpenReqPop(event,\''+tmAttr(req.REQUIREMENT_ID)+'\')':'openItemEditor(\''+tmAttr(item.ITEM_ID)+'\')';
  return'<span class="tm-chip st-'+st.toLowerCase()+'" draggable="true" ondragstart="tmStartDrag(event,\'Item\',\''+tmAttr(item.ITEM_ID)+'\')" onclick="event.stopPropagation();'+click+'" title="'+tmAttr(tip)+'"><i class="tm-dot '+st.toLowerCase()+'"></i><span>'+esc(item.NAME)+sub+'</span>'+(req&&req.NOTES?'<i class="tm-notemark" title="Has a scene note">•</i>':'')+'</span>';
}
function tmPersonChip(p,label){
  var st=tmPersonState(p);
  var text=label||(p?p.NAME:"Unassigned");
  var tip=p?p.NAME+' · '+(p.PROJECT_STATUS||"Listed")+' · contract '+(p.CONTRACT_STATUS||"unknown"):"No person record";
  return'<span class="tm-chip st-'+st+'" '+(p?'draggable="true" ondragstart="tmStartDrag(event,\'Person\',\''+tmAttr(p.PERSON_ID)+'\')" onclick="event.stopPropagation();openPersonEditor(\''+tmAttr(p.PERSON_ID)+'\')"':'')+' title="'+tmAttr(tip)+'"><i class="tm-dot '+st+'"></i>'+esc(text)+'</span>';
}
function tmSceneChip(s){
  return'<span class="tm-chip st-scene" draggable="true" ondragstart="tmStartDrag(event,\'Scene\',\''+tmAttr(s.uid)+'\')" onclick="event.stopPropagation();openSceneProduction(\''+tmAttr(s.uid)+'\')" title="'+tmAttr((s.seqLabel||s.seq)+' — '+s.title+(s.shootDay?' · '+s.shootDay:''))+'">'+esc(s.seqLabel||s.seq)+' '+esc(s.title)+'</span>';
}
/** A role in a scene: "Tom · Diego Sanchez", "1st AC · Bryson Sparks", "Bar patrons ×6". */
function tmStaffChip(st){
  var ids=tmSplitIds(st.ASSIGNED_PERSON_IDS),names=ids.map(tmPersonName);
  var p=ids.length===1?tmPerson(ids[0]):null,extras=st.DEPARTMENT==="Extras",need=tmNum(st.NEEDED,1);
  var color=extras?"extra":ids.length?(p?tmPersonState(p):"yellow"):"red";
  var label=extras?st.ROLE+(need>1?' ×'+need:''):st.ROLE+(names.length?' · '+names.join(", "):' · no one yet');
  var tip=st.DEPARTMENT+(extras?' — '+need+' needed':'')+(st.NOTES?' — '+st.NOTES:'');
  return'<span class="tm-chip st-'+color+'" onclick="event.stopPropagation();tmOpenStaffPop(event,\''+tmAttr(st.STAFFING_ID)+'\')" title="'+tmAttr(tip)+'"><i class="tm-dot '+color+'"></i>'+esc(label)+'</span>';
}
/** A task's links: its record (item or person) and, separately, its sequence. */
function tmLinkChip(task){
  var parts=[];
  if(task.ITEM_ID&&tmIx.items[task.ITEM_ID])parts.push(tmItemChip(tmIx.items[task.ITEM_ID]));
  else if(task.PERSON_ID&&tmPerson(task.PERSON_ID))parts.push(tmPersonChip(tmPerson(task.PERSON_ID)));
  if(task.SCENE_UID&&getScene(task.SCENE_UID))parts.push(tmSceneChip(tmScene(task.SCENE_UID)));
  if(parts.length)return parts.join("");
  return task.TASK_ID?'<button type="button" class="tm-chip-add" title="Link this task to a prop, location, person or sequence" onclick="event.stopPropagation();openTaskEditor(\''+tmAttr(task.TASK_ID)+'\')">+ link</button>':'<span class="tm-muted">—</span>';
}
function tmStatusSelect(kind,id,field,current){
  current=tmStatus(current);
  return'<select class="tm-status-sel st-'+current.toLowerCase()+'" onchange="tmPatch(\''+kind+'\',\''+tmAttr(id)+'\',\''+field+'\',this.value)" onclick="event.stopPropagation()">'+TM_STATUSES.map(function(s){return'<option'+(s===current?' selected':'')+'>'+s+'</option>'}).join("")+'</select>';
}

// ── TO-DO ────────────────────────────────────────────────────
function tmGroupKey(t){var ids=tmSplitIds(t.ASSIGNEE_IDS);return ids.length?ids[0]:""}
function tmTaskSort(a,b){
  var ad=tmBool(a.DONE),bd=tmBool(b.DONE);if(ad!==bd)return ad?1:-1;
  var ao=tmNum(a.MANUAL_ORDER,1e9),bo=tmNum(b.MANUAL_ORDER,1e9);if(ao!==bo)return ao-bo;
  return String(a.DUE_DATE||"9999").localeCompare(String(b.DUE_DATE||"9999"));
}
function tmRenderTodo(){
  var groups={},order=[];
  production.tasks.forEach(function(t){
    if(!tmShowDone&&tmBool(t.DONE)&&!tmJustDone[t.TASK_ID])return;
    if(!tmMatch([t.TITLE,t.NOTES,t.TASK_TYPE,tmPersonName(tmGroupKey(t)),t.DUE_DATE].join(" ")))return;
    var k=tmGroupKey(t);if(!groups[k]){groups[k]=[];order.push(k)}groups[k].push(t);
  });
  order.sort(function(a,b){if(!a)return 1;if(!b)return -1;return tmPersonName(a).localeCompare(tmPersonName(b))});
  // people with no open task still get a drop target so a task can be handed to them
  production.people.forEach(function(p){if(!groups[p.PERSON_ID]&&(p.GROUPS||"").indexOf("Producer")>=0&&!tmQuery){groups[p.PERSON_ID]=[];order.push(p.PERSON_ID)}});
  var open=production.tasks.filter(function(t){return !tmBool(t.DONE)}).length,done=production.tasks.length-open;
  var h='<div class="tm-todo-head"><span class="tm-muted">'+open+' open · '+done+' done</span><label class="tm-muted tm-toggle"><input type="checkbox" '+(tmShowDone?'checked':'')+' onchange="tmShowDone=this.checked;renderTaskBody()"> show done</label><span class="tm-spacer"></span>'+tmAddColumnMenu()+'<button class="hbtn gold" onclick="openTaskEditor(null)">+ Task</button></div>';
  h+='<div class="tm-split"><div class="tm-todo-groups">';
  order.forEach(function(k){h+=tmRenderGroup(k,groups[k])});
  if(!order.length)h+='<div class="tm-empty">No tasks match.</div>';
  h+='</div>'+tmRenderPalette()+'</div>';
  return h;
}
function tmAddColumnMenu(){
  var h='<details class="tm-addcol"><summary>+ Add column</summary><div class="tm-addcol-menu">';
  TM_OPTIONAL_COLS.forEach(function(c){h+='<label><input type="checkbox" '+(tmCols.indexOf(c[0])>=0?'checked':'')+' onchange="tmToggleCol(\''+c[0]+'\',this.checked)"> '+c[1]+'</label>'});
  h+='<div class="tm-muted tm-addcol-note">A new field needs a column on the Production Tasks tab and in Code.gs first.</div></div></details>';
  return h;
}
function tmToggleCol(key,on){tmCols=tmCols.filter(function(c){return c!==key});if(on)tmCols.push(key);try{localStorage.setItem("hairpinTodoCols",JSON.stringify(tmCols))}catch(e){}renderTaskBody()}
function tmRenderGroup(personId,tasks){
  tasks=tasks.slice().sort(tmTaskSort);
  var p=tmPerson(personId),name=personId?tmPersonName(personId):"Unassigned";
  var h='<section class="tm-group" data-person="'+tmAttr(personId)+'" ondragover="tmDragOver(event)" ondragleave="tmDragLeave(event)" ondrop="tmDropGroup(event,\''+tmAttr(personId)+'\')">';
  h+='<header class="tm-group-head">'+(p?tmPersonChip(p,name):'<span class="tm-chip st-muted">'+esc(name)+'</span>')+'<span class="tm-muted">'+tasks.length+'</span><span class="tm-spacer"></span><button class="hbtn tm-mini" onclick="openTaskEditor(null,null,\''+tmAttr(personId)+'\')">+ task</button></header>';
  h+='<div class="tm-table-wrap"><table class="tm-table tm-todo"><thead><tr><th class="tm-col-drag"></th><th class="tm-col-check"></th><th>Task</th><th class="tm-col-status">Status</th><th class="tm-col-date">Due</th><th>Linked</th><th>Notes</th>';
  tmCols.forEach(function(c){var d=tmById(TM_OPTIONAL_COLS.map(function(x){return{k:x[0],l:x[1]}}),"k",c);h+='<th>'+esc(d?d.l:c)+'</th>'});
  h+='<th class="tm-col-more"></th></tr></thead><tbody>';
  if(!tasks.length)h+='<tr class="tm-drop-hint"><td colspan="'+(8+tmCols.length)+'">Drop a task, person, sequence or item here.</td></tr>';
  tasks.forEach(function(t){h+=tmTaskRow(t)});
  return h+'</tbody></table></div></section>';
}
function tmTaskRow(t){
  var id=t.TASK_ID,done=tmBool(t.DONE);
  var h='<tr class="tm-row'+(done?' done':'')+'" data-task="'+tmAttr(id)+'" ondragover="tmRowDragOver(event)" ondrop="tmDropRow(event,\''+tmAttr(id)+'\')">';
  h+='<td class="tm-col-drag"><span class="tm-handle" draggable="true" ondragstart="tmStartDrag(event,\'Task\',\''+tmAttr(id)+'\')" title="Drag to reorder or hand to someone">⋮⋮</span></td>';
  h+='<td class="tm-col-check"><input class="tm-check" type="checkbox" '+(done?'checked':'')+' onchange="tmPatch(\'task\',\''+tmAttr(id)+'\',\'DONE\',this.checked)"></td>';
  h+='<td class="tm-cell-title"><div class="tm-edit" contenteditable="true" spellcheck="false" onkeydown="tmEditKey(event,this)" onblur="tmEditText(this,\'task\',\''+tmAttr(id)+'\',\'TITLE\')">'+esc(t.TITLE)+'</div></td>';
  h+='<td class="tm-col-status">'+tmStatusSelect("task",id,"STATUS_COLOR",t.STATUS_COLOR)+'</td>';
  h+='<td class="tm-col-date '+tmDueClass(done?"":t.DUE_DATE)+'"><input class="tm-date" type="date" value="'+tmAttr(String(t.DUE_DATE||"").slice(0,10))+'" onchange="tmPatch(\'task\',\''+tmAttr(id)+'\',\'DUE_DATE\',this.value)"></td>';
  h+='<td class="tm-cell-link">'+tmLinkChip(t)+'</td>';
  h+='<td class="tm-cell-notes"><div class="tm-edit" contenteditable="true" spellcheck="false" onkeydown="tmEditKey(event,this)" onblur="tmEditText(this,\'task\',\''+tmAttr(id)+'\',\'NOTES\')">'+esc(t.NOTES||"")+'</div></td>';
  tmCols.forEach(function(c){
    var editable=c==="TASK_TYPE"||c==="DUE_NOTE";
    h+='<td>'+(editable?'<div class="tm-edit" contenteditable="true" spellcheck="false" onkeydown="tmEditKey(event,this)" onblur="tmEditText(this,\'task\',\''+tmAttr(id)+'\',\''+c+'\')">'+esc(t[c]||"")+'</div>':'<span class="tm-muted">'+esc(String(t[c]||"").slice(0,10))+'</span>')+'</td>';
  });
  h+='<td class="tm-col-more"><button class="tm-more" title="Open task" onclick="openTaskEditor(\''+tmAttr(id)+'\')">⋯</button></td></tr>';
  return h;
}
/** The palette: everything that can be dragged into a list to become a linked task. */
var tmPalType="People",tmPalQuery="";
function tmRenderPalette(){
  var types=["People","Sequences","Location","Prop","Vehicle","Wardrobe","Hair & Makeup","VFX / SFX","Stunt"];
  var h='<aside class="tm-palette"><div class="tm-palette-head"><b>Drag into a list</b><span class="tm-muted">makes a linked task</span></div>';
  h+='<div class="tm-palette-tools"><select class="tm-select" onchange="tmPalType=this.value;renderTaskBody()">'+types.map(function(t){return'<option'+(t===tmPalType?' selected':'')+'>'+t+'</option>'}).join("")+'</select><input class="tm-input" placeholder="Filter" value="'+tmAttr(tmPalQuery)+'" oninput="tmPalQuery=this.value;tmRenderPaletteList()"></div>';
  h+='<div class="tm-palette-list" id="tmPaletteList">'+tmPaletteItems()+'</div></aside>';
  return h;
}
function tmRenderPaletteList(){var el=document.getElementById("tmPaletteList");if(el)el.innerHTML=tmPaletteItems()}
function tmPaletteItems(){
  var q=tmPalQuery.toLowerCase(),out=[];
  function ok(s){return !q||String(s).toLowerCase().indexOf(q)>=0}
  if(tmPalType==="People")tmActivePeople().forEach(function(p){if(ok(p.NAME+" "+p.ROLES_CHARACTERS+" "+p.GROUPS))out.push(tmPersonChip(p))});
  else if(tmPalType==="Sequences")scenes.slice().sort(function(a,b){return seqNum(a)-seqNum(b)}).forEach(function(s){if(ok(s.seqLabel+" "+s.title))out.push(tmSceneChip(s))});
  else production.items.filter(function(i){return i.TYPE===tmPalType&&ok(i.NAME)}).sort(function(a,b){return tmStatusRank(a.STATUS)-tmStatusRank(b.STATUS)||String(a.NAME).localeCompare(String(b.NAME))}).forEach(function(i){out.push(tmItemChip(i))});
  return out.length?out.join(""):'<div class="tm-muted">Nothing matches.</div>';
}

// drag & drop
function tmStartDrag(e,type,id){tmDrag={type:type,id:id};try{e.dataTransfer.setData("text/plain",type+":"+id);e.dataTransfer.effectAllowed="move"}catch(x){}}
function tmDragOver(e){if(!tmDrag)return;e.preventDefault();e.currentTarget.classList.add("dragover")}
function tmDragLeave(e){if(e.currentTarget.contains(e.relatedTarget))return;e.currentTarget.classList.remove("dragover")}
function tmRowDragOver(e){if(!tmDrag||tmDrag.type!=="Task")return;e.preventDefault();e.stopPropagation();var r=e.currentTarget.getBoundingClientRect();e.currentTarget.classList.toggle("drop-before",e.clientY<r.top+r.height/2);e.currentTarget.classList.toggle("drop-after",e.clientY>=r.top+r.height/2)}
function tmClearDropMarks(){Array.prototype.forEach.call(document.querySelectorAll(".dragover,.drop-before,.drop-after"),function(el){el.classList.remove("dragover","drop-before","drop-after")})}
/** Drop on a group with no specific row: hand a task to that person, or make a new linked task. */
function tmDropGroup(e,personId){
  e.preventDefault();tmClearDropMarks();var d=tmDrag;tmDrag=null;if(!d)return;
  if(d.type==="Task"){
    var t=tmById(production.tasks,"TASK_ID",d.id);if(!t)return;
    var group=production.tasks.filter(function(x){return tmGroupKey(x)===personId&&!tmBool(x.DONE)&&x.TASK_ID!==d.id}).sort(tmTaskSort);
    var last=group.length?tmNum(group[group.length-1].MANUAL_ORDER,group.length):0;
    tmSaveTask(Object.assign({},t,{ASSIGNEE_IDS:personId,MANUAL_ORDER:last+1}),renderTaskBody);
    return;
  }
  openTaskEditor(null,{type:d.type,id:d.id},personId);
}
/** Drop on a row: place the dragged task before/after it, in that row's group. One write. */
function tmDropRow(e,targetId){
  e.preventDefault();e.stopPropagation();var before=e.currentTarget.classList.contains("drop-before");tmClearDropMarks();
  var d=tmDrag;tmDrag=null;if(!d)return;
  var target=tmById(production.tasks,"TASK_ID",targetId);if(!target)return;
  var personId=tmGroupKey(target);
  if(d.type!=="Task"){openTaskEditor(null,{type:d.type,id:d.id},personId);return}
  if(d.id===targetId)return;
  var t=tmById(production.tasks,"TASK_ID",d.id);if(!t)return;
  var group=production.tasks.filter(function(x){return tmGroupKey(x)===personId&&tmBool(x.DONE)===tmBool(target.DONE)&&x.TASK_ID!==d.id}).sort(tmTaskSort);
  // normalise orders to 1..n in memory only, so midpoints are always well defined
  var pos=group.indexOf(target),orders=group.map(function(x,i){return tmNum(x.MANUAL_ORDER,i+1)});
  for(var i=1;i<orders.length;i++)if(orders[i]<=orders[i-1])orders[i]=orders[i-1]+1;
  var idx=before?pos:pos+1;
  var lo=idx>0?orders[idx-1]:orders[0]-1,hi=idx<orders.length?orders[idx]:orders[orders.length-1]+1;
  var newOrder=(lo+hi)/2;
  tmSaveTask(Object.assign({},t,{ASSIGNEE_IDS:personId,MANUAL_ORDER:newOrder}),renderTaskBody);
}

// ── SEQUENCES ────────────────────────────────────────────────
/* One column per department. Every cell ends in a "+" that opens a toggle list —
   the same tick-to-add idea as the Scheduler's scene editor. */
var TM_CELLS=[
  {key:"loc",label:"Location",types:["Location"]},
  {key:"cast",label:"Cast",staff:"Cast"},
  {key:"crew",label:"Crew & Extras",staff:"Crew"},
  {key:"props",label:"Props & Vehicles",types:["Prop","Vehicle"]},
  {key:"hmu",label:"Hair, Makeup & Wardrobe",types:["Hair & Makeup","Wardrobe"]},
  {key:"fx",label:"VFX & Stunts",types:["VFX / SFX","Stunt"]}
];
var TM_ITEM_PREFIX={"Prop":"PROP","Location":"LOC","Vehicle":"VEH","Wardrobe":"WARD","Hair & Makeup":"HMU","VFX / SFX":"VFX","Stunt":"STNT"};
function tmHex(n){var s=Math.floor(Math.random()*Math.pow(16,n)).toString(16).toUpperCase();while(s.length<n)s="0"+s;return s}
function tmNewItemId(type,name){var slug=String(name||"item").toUpperCase().replace(/[^A-Z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,40)||"ITEM";return"ITM-"+(TM_ITEM_PREFIX[type]||"ITEM")+"-"+slug+"-"+tmHex(4)}
function tmNewReqId(){return"REQ-"+tmHex(4)+"-"+tmHex(4)}
function tmCell(key){for(var i=0;i<TM_CELLS.length;i++)if(TM_CELLS[i].key===key)return TM_CELLS[i];return null}
function tmReqsOfType(uid,types){return (tmIx.reqsByScene[uid]||[]).filter(function(r){var it=tmIx.items[r.ITEM_ID];var ty=it?it.TYPE:r.ITEM_TYPE;return types.indexOf(ty)>=0})}
function tmStaffOf(uid,dept){return (tmIx.staffByScene[uid]||[]).filter(function(x){return dept==="Cast"?x.DEPARTMENT==="Cast":x.DEPARTMENT!=="Cast"})}
function tmCellChips(uid,cell){
  var reqs=cell.types?tmReqsOfType(uid,cell.types):null,staff=cell.types?null:tmStaffOf(uid,cell.staff);
  // when the table is sorted by this column, show its chips alphabetically too, so the sort is visible
  if(tmSeqSort.key===cell.key){
    if(reqs)reqs=reqs.slice().sort(function(a,b){var na=(tmIx.items[a.ITEM_ID]||{}).NAME||a.SCENE_WORDING||"",nb=(tmIx.items[b.ITEM_ID]||{}).NAME||b.SCENE_WORDING||"";return String(na).localeCompare(String(nb))});
    else staff=staff.slice().sort(function(a,b){return String(a.ROLE).localeCompare(String(b.ROLE))});
  }
  var chips=reqs?reqs.map(function(r){return tmItemChip(tmIx.items[r.ITEM_ID],r)}):staff.map(tmStaffChip);
  return chips.join("")+'<button class="tm-plus" title="Add to this scene" onclick="event.stopPropagation();tmOpenAddPop(event,\''+tmAttr(uid)+'\',\''+cell.key+'\')">+</button>';
}
/* Sorting. Default is scene order. Click a column header to sort by it (click again
   to flip); the dropdown offers the same choices plus shoot date. */
var tmSeqSort={key:"seq",dir:1};
try{var _ss=JSON.parse(localStorage.getItem("hairpinSeqSort")||"null");if(_ss&&_ss.key)tmSeqSort=_ss}catch(e){}
var TM_SORTS=[["seq","Scene order"],["day","Shoot date — filming first"],["loc","Location A→Z"],["cast","Cast A→Z"],["crew","Crew & Extras A→Z"],["props","Props & Vehicles A→Z"],["hmu","Hair, Makeup & Wardrobe A→Z"],["fx","VFX & Stunts A→Z"],["tasks","Tasks — most first"]];
function tmSetSeqSort(key,dir){
  if(dir===undefined)dir=tmSeqSort.key===key?-tmSeqSort.dir:1;
  tmSeqSort={key:key,dir:dir};try{localStorage.setItem("hairpinSeqSort",JSON.stringify(tmSeqSort))}catch(e){}
  renderTaskBody();
}
/** What a cell "says" for sorting: its chip names, alphabetical, joined. Empty cells sort last. */
function tmCellSortText(s,cell){
  var names=cell.types?tmReqsOfType(s.uid,cell.types).map(function(r){var it=tmIx.items[r.ITEM_ID];return it?it.NAME:r.SCENE_WORDING||""}):tmStaffOf(s.uid,cell.staff).map(function(st){return st.ROLE});
  names=names.map(function(n){return String(n).toLowerCase()}).sort();
  return names.join(" | ");
}
function tmSeqComparator(){
  var key=tmSeqSort.key,dir=tmSeqSort.dir;
  function bySeq(a,b){return seqNum(a)-seqNum(b)}
  if(key==="seq")return function(a,b){return dir*bySeq(a,b)};
  if(key==="day")return function(a,b){var da=a.shootDay||"",db=b.shootDay||"";if(!da&&!db)return bySeq(a,b);if(!da)return 1;if(!db)return -1;return da<db?-dir:da>db?dir:bySeq(a,b)};
  if(key==="tasks")return function(a,b){var na=tmSceneOpenTasks(a.uid).length,nb=tmSceneOpenTasks(b.uid).length;return na!==nb?dir*(nb-na):bySeq(a,b)};
  var cell=tmCell(key);if(!cell)return function(a,b){return bySeq(a,b)};
  return function(a,b){var ta=tmCellSortText(a,cell),tb=tmCellSortText(b,cell);if(!ta&&!tb)return bySeq(a,b);if(!ta)return 1;if(!tb)return -1;return ta<tb?-dir:ta>tb?dir:bySeq(a,b)};
}
/** Open tasks that touch a scene: linked to it directly, or to an item it needs. Same set the Tasks cell shows. */
function tmSceneOpenTasks(uid){
  var out=(tmIx.tasksByScene[uid]||[]).filter(function(t){return !tmBool(t.DONE)});
  (tmIx.reqsByScene[uid]||[]).forEach(function(r){(tmIx.tasksByItem[r.ITEM_ID]||[]).forEach(function(t){if(!tmBool(t.DONE)&&out.indexOf(t)<0)out.push(t)})});
  return out;
}
function tmSortArrow(key){return tmSeqSort.key===key?'<span class="tm-sortarrow">'+(tmSeqSort.dir>0?'▲':'▼')+'</span>':''}
function tmRenderSequences(){
  var rows=scenes.filter(function(s){
    if(!tmQuery)return true;
    var text=[s.seqLabel,s.title,s.shootDay].concat((tmIx.reqsByScene[s.uid]||[]).map(function(r){var it=tmIx.items[r.ITEM_ID];return it?it.NAME:r.SCENE_WORDING})).concat((tmIx.staffByScene[s.uid]||[]).map(function(st){return st.ROLE+" "+tmSplitIds(st.ASSIGNED_PERSON_IDS).map(tmPersonName).join(" ")})).join(" ");
    return tmMatch(text);
  }).sort(tmSeqComparator());
  if(!rows.length)return'<div class="tm-empty">No sequences match.</div>';
  var h='<div class="tm-todo-head"><label class="tm-muted">Sort</label><select class="tm-select" onchange="tmSetSeqSort(this.value,1)">'+TM_SORTS.map(function(o){return'<option value="'+o[0]+'"'+(tmSeqSort.key===o[0]?' selected':'')+'>'+esc(o[1])+'</option>'}).join("")+'</select>';
  h+='<button class="hbtn" title="Flip direction" onclick="tmSetSeqSort(tmSeqSort.key,-tmSeqSort.dir)">'+(tmSeqSort.dir>0?'▲ ascending':'▼ descending')+'</button>';
  if(tmSeqSort.key!=="seq")h+='<button class="hbtn" onclick="tmSetSeqSort(\'seq\',1)">Back to scene order</button>';
  h+='<span class="tm-muted">'+rows.length+' sequences · click a column header to sort by it</span></div>';
  h+='<table class="tm-table tm-seq"><thead><tr><th class="tm-seqhead tm-sortable" onclick="tmSetSeqSort(tmSeqSort.key===\'seq\'?\'day\':\'seq\',1)" title="Click: scene order ↔ shoot date">Sequence'+(tmSeqSort.key==="day"?' <span class="tm-faint">by shoot date</span>':'')+tmSortArrow(tmSeqSort.key==="day"?"day":"seq")+'</th>';
  TM_CELLS.forEach(function(c){h+='<th class="tm-sortable" onclick="tmSetSeqSort(\''+c.key+'\')" title="Sort by '+tmAttr(c.label)+'">'+esc(c.label)+tmSortArrow(c.key)+'</th>'});
  h+='<th class="tm-sortable" onclick="tmSetSeqSort(\'tasks\')" title="Sort by open tasks">Tasks'+tmSortArrow("tasks")+'</th></tr></thead><tbody>';
  rows.forEach(function(s){
    var tasks=(tmIx.tasksByScene[s.uid]||[]).filter(function(t){return !tmBool(t.DONE)});
    var itemTasks=[];(tmIx.reqsByScene[s.uid]||[]).forEach(function(r){(tmIx.tasksByItem[r.ITEM_ID]||[]).forEach(function(t){if(!tmBool(t.DONE)&&itemTasks.indexOf(t)<0&&tasks.indexOf(t)<0)itemTasks.push(t)})});
    h+='<tr class="tm-row'+tmFlagClasses(s)+'" data-scene="'+tmAttr(s.uid)+'">';
    h+='<td class="tm-seqcell" onclick="openSceneProduction(\''+tmAttr(s.uid)+'\')">'+tmSeqCellInner(s)+'</td>';
    TM_CELLS.forEach(function(c){h+='<td class="tm-cell" data-cell="'+c.key+'">'+tmCellChips(s.uid,c)+'</td>'});
    h+='<td class="tm-cell tm-taskcell">'+tasks.map(function(t){return tmMiniTask(t,false)}).join("")+itemTasks.map(function(t){return tmMiniTask(t,true)}).join("")+'<button class="tm-plus" title="New task for this sequence" onclick="event.stopPropagation();openTaskEditor(null,{type:\'Scene\',id:\''+tmAttr(s.uid)+'\'})">+</button></td></tr>';
  });
  return h+'</tbody></table>';
}
/* Shot / Pickup are the Scheduler's flags (index.html: isShot, needsPickup,
   toggleFlag). The Task Manager reads the same scenes[] and calls the same toggle,
   so one click updates both tabs and writes the one STATUS cell. */
function tmFlagClasses(s){return (typeof isShot==="function"&&isShot(s)?" shot":"")+(typeof needsPickup==="function"&&needsPickup(s)?" pickup":"")}
function tmSeqCellInner(s){
  var shot=typeof isShot==="function"&&isShot(s),pk=typeof needsPickup==="function"&&needsPickup(s),note=pk&&typeof pickupNote==="function"?pickupNote(s):"";
  var h='<div class="tm-seqflags"><button class="fa'+(shot?' on':'')+'" title="'+(shot?'Shot — click to unmark':'Mark as shot')+'" onclick="event.stopPropagation();toggleFlag(\''+tmAttr(s.uid)+'\',SHOT)">&#10003;</button><button class="fa pk'+(pk?' on':'')+'" title="'+(pk?'Pickup owed'+(note?': '+tmAttr(note):'')+' — click to clear':'Flag a pickup')+'" onclick="event.stopPropagation();toggleFlag(\''+tmAttr(s.uid)+'\',PICKUP)">&#9685;</button></div>';
  h+='<b>'+(shot?'&#10003; ':'')+esc(s.seqLabel||s.seq)+'</b>'+(pk?'<span class="pk-tag" title="'+tmAttr(note||"Pickup owed")+'">pickup</span>':'')+'<div class="tm-seqtitle">'+esc(s.title)+'</div><div class="tm-seqday '+(shot?'':tmDueClass(s.shootDay))+'">'+(s.shootDay?esc(tmFmtDate(s.shootDay)):'unscheduled')+'</div>';
  if(pk&&note)h+='<div class="tm-pknote">'+esc(note)+'</div>';
  return h;
}
/** Called by the Scheduler's toggleFlag so the Sequences row follows immediately. */
function tmOnSceneFlag(uid){
  var tr=document.querySelector('tr[data-scene="'+uid+'"]');if(!tr)return;
  var s=tmScene(uid);tr.className="tm-row"+tmFlagClasses(s);
  var td=tr.querySelector(".tm-seqcell");if(td)td.innerHTML=tmSeqCellInner(s);
}
/** Re-render just one sequence row after a change inside it. */
function tmRefreshSceneRow(uid){
  var tr=document.querySelector('tr[data-scene="'+uid+'"]');
  if(tr){
    TM_CELLS.forEach(function(c){var td=tr.querySelector('td[data-cell="'+c.key+'"]');if(td)td.innerHTML=tmCellChips(uid,c)});
    var sc=tr.querySelector(".tm-seqcell");if(sc)sc.innerHTML=tmSeqCellInner(tmScene(uid));
    tr.className="tm-row"+tmFlagClasses(tmScene(uid));
  }
  else if(tmView==="sequences")renderTaskBody();
  var modal=document.querySelector('.tm-scene-grid[data-scene-modal="'+uid+'"]');
  if(modal)TM_CELLS.forEach(function(c){var box=modal.querySelector('[data-cell="'+c.key+'"]');if(box)box.innerHTML=tmCellChips(uid,c)});
}

// ── POPOVERS ─────────────────────────────────────────────────
/* A small card anchored to whatever was clicked. One popover at a time; it
   re-renders itself after each write so ticks update in place. */
var tmPopState=null;
function tmPopClose(){var el=document.getElementById("tmPop");if(el)el.parentNode.removeChild(el);tmPopState=null}
function tmPopOpen(anchor,render){
  tmPopClose();
  var el=document.createElement("div");el.id="tmPop";el.className="tm-pop";el.onclick=function(e){e.stopPropagation()};
  document.body.appendChild(el);
  tmPopState={anchor:anchor,render:render};
  tmPopRender();
  var r=anchor.getBoundingClientRect(),w=el.offsetWidth,hgt=el.offsetHeight;
  var left=Math.max(8,Math.min(r.left,window.innerWidth-w-8));
  var top=r.bottom+6;if(top+hgt>window.innerHeight-8)top=Math.max(8,r.top-hgt-6);
  el.style.left=left+"px";el.style.top=top+"px";
  setTimeout(function(){var f=el.querySelector("[autofocus]");if(f)f.focus()},30);
}
function tmPopRender(){var el=document.getElementById("tmPop");if(!el||!tmPopState)return;var q=el.querySelector(".tm-pop-search");var qv=q?q.value:null,sel=q?q.selectionStart:0;el.innerHTML=tmPopState.render();var q2=el.querySelector(".tm-pop-search");if(q2&&qv!==null){q2.value=qv;try{q2.setSelectionRange(sel,sel)}catch(e){}q2.focus()}}
document.addEventListener("click",function(e){var p=document.getElementById("tmPop");if(p&&!p.contains(e.target))tmPopClose()});
document.addEventListener("keydown",function(e){if(e.key==="Escape")tmPopClose()});
var tmPopQuery="";
function tmPopSetQuery(v){tmPopQuery=v;tmPopRender()}
function tmNameKey(s){return String(s||"").toLowerCase().replace(/\s+/g," ").trim()}
function tmFindPersonByName(name){var k=tmNameKey(name);if(!k)return null;for(var i=0;i<production.people.length;i++)if(tmActive(production.people[i])&&tmNameKey(production.people[i].NAME)===k)return production.people[i];return null}
function tmTog(on,label,onclick,color,sub){return'<button type="button" class="tm-tog'+(on?' on':'')+(color?' c-'+color:'')+'" onclick="'+onclick+'">'+(on?'✓ ':'')+esc(label)+(sub?'<span class="tm-tog-sub">'+esc(sub)+'</span>':'')+'</button>'}

/** "+" in a Sequences cell. */
function tmOpenAddPop(e,uid,key){
  e.stopPropagation();tmPopQuery="";
  var cell=tmCell(key),s=tmScene(uid);
  tmPopOpen(e.currentTarget,function(){
    var q=tmPopQuery.toLowerCase();function ok(t){return !q||String(t).toLowerCase().indexOf(q)>=0}
    var h='<div class="tm-pop-head"><b>'+esc(s.seqLabel||s.seq)+'</b> · '+esc(cell.label)+'<button class="tm-more" onclick="tmPopClose()">✕</button></div>';
    h+='<input class="tm-input tm-pop-search" placeholder="Search or type a new name" autofocus oninput="tmPopSetQuery(this.value)">';
    if(cell.types){
      var have={};(tmIx.reqsByScene[uid]||[]).forEach(function(r){have[r.ITEM_ID]=r.REQUIREMENT_ID});
      var opts=production.items.filter(function(i){return cell.types.indexOf(i.TYPE)>=0&&tmActive(i)&&ok(i.NAME)}).sort(function(a,b){return (have[b.ITEM_ID]?1:0)-(have[a.ITEM_ID]?1:0)||String(a.NAME).localeCompare(String(b.NAME))});
      h+='<div class="tm-tog-row">'+opts.slice(0,80).map(function(i){var on=!!have[i.ITEM_ID];return tmTog(on,i.NAME,on?'tmPopRemoveReq(\''+tmAttr(have[i.ITEM_ID])+'\',\''+tmAttr(uid)+'\')':'tmPopAddReq(\''+tmAttr(uid)+'\',\''+tmAttr(i.ITEM_ID)+'\')',tmStatus(i.STATUS).toLowerCase())}).join("")+'</div>';
      if(opts.length>80)h+='<div class="tm-muted">'+(opts.length-80)+' more — keep typing</div>';
      if(tmPopQuery.trim()&&!opts.some(function(i){return tmNameKey(i.NAME)===tmNameKey(tmPopQuery)}))h+='<div class="tm-pop-new">'+cell.types.map(function(t){return'<button class="hbtn gold" onclick="tmPopNewItem(\''+tmAttr(uid)+'\',\''+tmAttr(t)+'\')">+ New '+esc(t.toLowerCase())+': “'+esc(tmPopQuery.trim())+'”</button>'}).join("")+'</div>';
    }else if(cell.staff==="Cast"){
      var inScene=tmStaffOf(uid,"Cast"),byRole={},byPerson={};
      inScene.forEach(function(st){byRole[tmNameKey(st.ROLE)]=st.STAFFING_ID;tmSplitIds(st.ASSIGNED_PERSON_IDS).forEach(function(pid){byPerson[pid]=st.STAFFING_ID})});
      var cat=typeof getCat==="function"?getCat("cast"):null,chars=cat?cat.options.slice():[];
      chars=chars.filter(function(c){var note=cat.meta[c]&&cat.meta[c].note||"";return ok(c+" "+note)});
      h+='<div class="tm-pop-label">Characters</div><div class="tm-tog-row">'+chars.map(function(c){var on=!!byRole[tmNameKey(c)],note=cat.meta[c]&&cat.meta[c].note||"",actor=tmFindPersonByName(note);return tmTog(on,c,on?'tmPopRemoveStaff(\''+tmAttr(byRole[tmNameKey(c)])+'\',\''+tmAttr(uid)+'\')':'tmPopAddCast(\''+tmAttr(uid)+'\',\''+tmAttr(c)+'\',\''+tmAttr(actor?actor.PERSON_ID:"")+'\')',actor?tmPersonState(actor):"",actor?actor.NAME:(/^NEW/i.test(note)?"no actor yet":note))}).join("")+'</div>';
      var people=tmActivePeople().filter(function(p){return ok(p.NAME+" "+(p.ROLES_CHARACTERS||""))}).sort(function(a,b){var ac=(a.GROUPS||"").indexOf("Cast")>=0?0:1,bc=(b.GROUPS||"").indexOf("Cast")>=0?0:1;return ac-bc||String(a.NAME).localeCompare(String(b.NAME))});
      h+='<div class="tm-pop-label">People</div><div class="tm-tog-row">'+people.map(function(p){var on=!!byPerson[p.PERSON_ID];return tmTog(on,p.NAME,on?'tmPopRemoveStaff(\''+tmAttr(byPerson[p.PERSON_ID])+'\',\''+tmAttr(uid)+'\')':'tmPopAddCast(\''+tmAttr(uid)+'\',\''+tmAttr(p.ROLES_CHARACTERS?p.ROLES_CHARACTERS.split(/[;,\/]/)[0].trim():p.NAME)+'\',\''+tmAttr(p.PERSON_ID)+'\')',tmPersonState(p),p.ROLES_CHARACTERS||p.GROUPS)}).join("")+'</div>';
      if(tmPopQuery.trim())h+='<div class="tm-pop-new"><button class="hbtn gold" onclick="tmPopAddCast(\''+tmAttr(uid)+'\',\''+tmAttr(tmPopQuery.trim())+'\',\'\')">+ New character “'+esc(tmPopQuery.trim())+'” (no actor yet)</button><button class="hbtn" onclick="tmPopNewPerson(\''+tmAttr(uid)+'\',\'Cast\')">+ New person “'+esc(tmPopQuery.trim())+'”</button></div>';
    }else{
      var crew=tmStaffOf(uid,"Crew"),byP={},byRoleX={};
      crew.forEach(function(st){tmSplitIds(st.ASSIGNED_PERSON_IDS).forEach(function(pid){byP[pid]=st.STAFFING_ID});if(st.DEPARTMENT==="Extras")byRoleX[tmNameKey(st.ROLE)]=st.STAFFING_ID});
      var ppl=tmActivePeople().filter(function(p){return ok(p.NAME+" "+(p.ROLES_CHARACTERS||"")+" "+(p.GROUPS||""))}).sort(function(a,b){var ac=/Crew|Producer/.test(a.GROUPS||"")?0:1,bc=/Crew|Producer/.test(b.GROUPS||"")?0:1;return ac-bc||String(a.NAME).localeCompare(String(b.NAME))});
      h+='<div class="tm-pop-label">Crew</div><div class="tm-tog-row">'+ppl.map(function(p){var on=!!byP[p.PERSON_ID];return tmTog(on,p.NAME,on?'tmPopRemoveStaff(\''+tmAttr(byP[p.PERSON_ID])+'\',\''+tmAttr(uid)+'\')':'tmPopAddCrew(\''+tmAttr(uid)+'\',\''+tmAttr(p.PERSON_ID)+'\')',tmPersonState(p),p.ROLES_CHARACTERS||p.GROUPS)}).join("")+'</div>';
      var xcat=typeof getCat==="function"?getCat("extras"):null,xs=xcat?xcat.options.filter(ok):[];
      h+='<div class="tm-pop-label">Extras</div><div class="tm-tog-row">'+xs.map(function(x){var on=!!byRoleX[tmNameKey(x)];return tmTog(on,x,on?'tmPopRemoveStaff(\''+tmAttr(byRoleX[tmNameKey(x)])+'\',\''+tmAttr(uid)+'\')':'tmPopAddExtras(\''+tmAttr(uid)+'\',\''+tmAttr(x)+'\')',"extra")}).join("")+(xs.length?'':'<span class="tm-muted">No extras match</span>')+'</div>';
      if(tmPopQuery.trim())h+='<div class="tm-pop-new"><button class="hbtn gold" onclick="tmPopAddExtras(\''+tmAttr(uid)+'\',\''+tmAttr(tmPopQuery.trim())+'\')">+ Extras: “'+esc(tmPopQuery.trim())+'”</button><button class="hbtn" onclick="tmPopNewPerson(\''+tmAttr(uid)+'\',\'Crew\')">+ New crew member “'+esc(tmPopQuery.trim())+'”</button></div>';
    }
    return h+'<div class="tm-pop-foot tm-muted">Tick to add · tick again to remove · each is one save</div>';
  });
}
function tmAfterScene(uid){tmSyncAffected([uid]);tmRefreshSceneRow(uid);tmPopRender()}
function tmSceneAfter(uid){return function(){tmAfterScene(uid)}}
function tmPopAddReq(uid,itemId){
  var item=tmIx.items[itemId],s=tmScene(uid);if(!item)return;
  tmSaveRequirement({REQUIREMENT_ID:tmNewReqId(),SCENE_UID:uid,SEQ:s.seqLabel||s.seq,ITEM_ID:itemId,ITEM_TYPE:item.TYPE,SCENE_WORDING:item.NAME,STATUS_OVERRIDE:"",QUANTITY_NEEDED:1,QUANTITY_READY:"",OWNER:"",NOTES:""},tmSceneAfter(uid));
}
function tmPopNewItem(uid,type){
  var name=tmPopQuery.trim();if(!name)return;
  var rec={ITEM_ID:tmNewItemId(type,name),TYPE:type,NAME:name,STATUS:"Red",CONTRACT_STATUS:"",OWNER:"",QUANTITY_NEEDED:"",QUANTITY_READY:"",LINK:"",ADDRESS:"",NOTES:"",ALIASES:"",SOURCE_TABS:"Task Manager",ACTIVE:true};
  tmPopQuery="";
  tmSaveItem(rec,tmSceneAfter(uid));      // the item exists in memory now …
  tmPopAddReq(uid,rec.ITEM_ID);            // … so the scene link can go straight after it
}
function tmPopRemoveReq(reqId,uid){tmOptimisticDelete("requirement",reqId,"deleteRequirement",tmSceneAfter(uid))}
function tmPopRemoveStaff(stId,uid){tmOptimisticDelete("staffing",stId,"deleteStaffing",tmSceneAfter(uid))}
function tmPopAddCast(uid,role,personId){
  var s=tmScene(uid);tmPopQuery="";
  tmSaveStaffing({STAFFING_ID:"",SCENE_UID:uid,SEQ:s.seqLabel||s.seq,DEPARTMENT:"Cast",ROLE:role,NEEDED:1,ASSIGNED_PERSON_IDS:personId||"",CONFIRMED_COUNT:personId?1:0,GAP:personId?0:1,NOTES:""},tmSceneAfter(uid));
}
function tmPopAddCrew(uid,personId){
  var s=tmScene(uid),p=tmPerson(personId),role=p&&p.ROLES_CHARACTERS?p.ROLES_CHARACTERS.split(/[;,\/]/)[0].trim():"Crew";
  tmSaveStaffing({STAFFING_ID:"",SCENE_UID:uid,SEQ:s.seqLabel||s.seq,DEPARTMENT:"Crew",ROLE:role,NEEDED:1,ASSIGNED_PERSON_IDS:personId,CONFIRMED_COUNT:1,GAP:0,NOTES:""},tmSceneAfter(uid));
}
function tmPopAddExtras(uid,desc){
  var s=tmScene(uid);tmPopQuery="";
  tmSaveStaffing({STAFFING_ID:"",SCENE_UID:uid,SEQ:s.seqLabel||s.seq,DEPARTMENT:"Extras",ROLE:desc,NEEDED:1,ASSIGNED_PERSON_IDS:"",CONFIRMED_COUNT:0,GAP:1,NOTES:""},tmSceneAfter(uid));
}
function tmPopNewPerson(uid,group){
  var name=tmPopQuery.trim();if(!name)return;
  var rec={PERSON_ID:tmNewPersonId(name),NAME:name,GROUPS:group,ROLES_CHARACTERS:"",PROJECT_STATUS:"Candidate",CONTRACT_STATUS:"Not Sent",ACTIVE:true,SOURCE_TABS:"Task Manager"};
  tmPopQuery="";
  tmSavePerson(rec,tmSceneAfter(uid));
  if(group==="Cast")tmPopAddCast(uid,name,rec.PERSON_ID);else tmPopAddCrew(uid,rec.PERSON_ID);
}

/** Click on an item chip inside a scene: status, scene note, remove, full record. */
function tmOpenReqPop(e,reqId){
  e.stopPropagation();
  var req=tmById(production.requirements,"REQUIREMENT_ID",reqId);if(!req)return;
  var uid=req.SCENE_UID;
  tmPopOpen(e.currentTarget,function(){
    var r=tmById(production.requirements,"REQUIREMENT_ID",reqId);if(!r)return'<div class="tm-muted">Removed.</div>';
    var item=tmIx.items[r.ITEM_ID]||{NAME:r.SCENE_WORDING,TYPE:r.ITEM_TYPE,STATUS:"Red"},uses=(tmIx.reqsByItem[r.ITEM_ID]||[]).length;
    var h='<div class="tm-pop-head"><b>'+esc(item.NAME)+'</b><span class="tm-muted">'+esc(item.TYPE)+' · in '+uses+' scene'+(uses===1?'':'s')+'</span><button class="tm-more" onclick="tmPopClose()">✕</button></div>';
    h+='<div class="tm-pop-label">Master ID name <span class="tm-muted">— renames it everywhere</span></div><input class="tm-input" value="'+tmAttr(item.NAME)+'" onkeydown="if(event.key===\'Enter\')this.blur()" onblur="tmPopRenameItem(\''+tmAttr(item.ITEM_ID)+'\',this.value)">';
    h+='<div class="tm-pop-label">Status (everywhere it appears)</div><div class="tm-tog-row">'+TM_STATUSES.map(function(st){return tmTog(tmStatus(item.STATUS)===st,st,'tmPopSetItemStatus(\''+tmAttr(item.ITEM_ID)+'\',\''+st+'\')',st.toLowerCase())}).join("")+'</div>';
    h+='<div class="tm-pop-label">Wording / subarea in this sequence</div><input class="tm-input" value="'+tmAttr(r.SCENE_WORDING||item.NAME)+'" placeholder="'+tmAttr(item.NAME)+'" onkeydown="if(event.key===\'Enter\')this.blur()" onblur="tmPopSetReqField(\''+tmAttr(reqId)+'\',\'SCENE_WORDING\',this.value)">';
    h+='<div class="tm-pop-label">Note for this scene only</div><input class="tm-input" value="'+tmAttr(r.NOTES||"")+'" placeholder="'+tmAttr(r.SCENE_WORDING&&r.SCENE_WORDING!==item.NAME?'Script says: '+r.SCENE_WORDING:'e.g. needs to be the dented one')+'" onkeydown="if(event.key===\'Enter\')this.blur()" onblur="tmPopSetReqNote(\''+tmAttr(reqId)+'\',this.value)">';
    h+='<div class="tm-pop-actions"><button class="hbtn tm-danger" onclick="tmPopRemoveReq(\''+tmAttr(reqId)+'\',\''+tmAttr(uid)+'\');tmPopClose()">Remove from scene</button><span class="tm-spacer"></span><button class="hbtn" onclick="tmPopClose();openItemEditor(\''+tmAttr(item.ITEM_ID)+'\')">Full record…</button></div>';
    return h;
  });
}
/** Re-render only the rows that use an item (in any view that shows scenes). */
function tmRefreshItemRows(itemId){
  if(tmView!=="sequences"){renderTaskBody();return}
  var uids={};(tmIx.reqsByItem[itemId]||[]).forEach(function(r){uids[r.SCENE_UID]=true});
  Object.keys(uids).forEach(tmRefreshSceneRow);
  var pal=document.getElementById("tmPaletteList");if(pal)pal.innerHTML=tmPaletteItems();
}
function tmPopRenameItem(itemId,value){
  var it=tmIx.items[itemId];value=String(value||"").trim();
  if(!it)return;if(!value){tmPopRender();return}if(value===String(it.NAME||""))return;
  tmSaveItem(Object.assign({},it,{NAME:value}),function(){tmRefreshItemRows(itemId);tmPopRender()});
  toast('Renamed everywhere to “'+value+'”',"ok");
}
function tmPopSetItemStatus(itemId,st){var it=tmIx.items[itemId];if(!it||tmStatus(it.STATUS)===st)return;tmSaveItem(Object.assign({},it,{STATUS:st}),function(){tmRefreshItemRows(itemId);tmPopRender()})}
function tmPopSetReqField(reqId,field,value){var r=tmById(production.requirements,"REQUIREMENT_ID",reqId);value=String(value||"").trim();if(!r||String(r[field]||"")===value)return;var rec=Object.assign({},r);rec[field]=value;tmSaveRequirement(rec,function(){tmRefreshSceneRow(r.SCENE_UID);tmPopRender()})}
function tmPopSetReqNote(reqId,v){var r=tmById(production.requirements,"REQUIREMENT_ID",reqId);if(!r||String(r.NOTES||"")===v.trim())return;tmSaveRequirement(Object.assign({},r,{NOTES:v.trim()}),function(){tmRefreshSceneRow(r.SCENE_UID)})}

/** Click on a cast / crew / extras chip: who plays it, how many, remove. */
function tmOpenStaffPop(e,stId){
  e.stopPropagation();
  var st=tmById(production.staffing,"STAFFING_ID",stId);if(!st)return;
  var uid=st.SCENE_UID;
  tmPopOpen(e.currentTarget,function(){
    var x=tmById(production.staffing,"STAFFING_ID",stId);if(!x)return'<div class="tm-muted">Removed.</div>';
    var extras=x.DEPARTMENT==="Extras",ids=tmSplitIds(x.ASSIGNED_PERSON_IDS);
    var h='<div class="tm-pop-head"><b>'+esc(x.ROLE)+'</b><span class="tm-muted">'+esc(x.DEPARTMENT)+'</span><button class="tm-more" onclick="tmPopClose()">✕</button></div>';
    h+='<div class="tm-pop-label">'+(extras?'Description':'Role / character')+'</div><input class="tm-input" value="'+tmAttr(x.ROLE)+'" onkeydown="if(event.key===\'Enter\')this.blur()" onblur="tmPopSetStaff(\''+tmAttr(stId)+'\',\'ROLE\',this.value)">';
    if(extras){
      h+='<div class="tm-pop-label">How many</div><input class="tm-input" type="number" min="1" style="max-width:90px" value="'+tmAttr(tmNum(x.NEEDED,1))+'" onchange="tmPopSetStaff(\''+tmAttr(stId)+'\',\'NEEDED\',this.value)">';
    }else{
      var people=tmActivePeople();ids.forEach(function(id){if(!people.some(function(p){return p.PERSON_ID===id})&&tmPerson(id))people.push(tmPerson(id))});
      h+='<div class="tm-pop-label">'+(x.DEPARTMENT==="Cast"?'Played by':'Who')+'</div><select class="tm-input" onchange="if(this.value===\'__new\'){tmPopNewPersonFor(\''+tmAttr(stId)+'\')}else tmPopSetStaff(\''+tmAttr(stId)+'\',\'ASSIGNED_PERSON_IDS\',this.value)"><option value=""'+(ids.length?'':' selected')+'>— no one yet —</option>'+people.map(function(p){return'<option value="'+tmAttr(p.PERSON_ID)+'"'+(ids[0]===p.PERSON_ID?' selected':'')+'>'+esc(p.NAME)+(p.ROLES_CHARACTERS?' · '+esc(p.ROLES_CHARACTERS):'')+'</option>'}).join("")+'<option value="__new">+ New person…</option></select>';
    }
    h+='<div class="tm-pop-actions"><button class="hbtn tm-danger" onclick="tmPopRemoveStaff(\''+tmAttr(stId)+'\',\''+tmAttr(uid)+'\');tmPopClose()">Remove from scene</button><span class="tm-spacer"></span>'+(ids.length?'<button class="hbtn" onclick="tmPopClose();openPersonEditor(\''+tmAttr(ids[0])+'\')">Person…</button>':'')+'</div>';
    return h;
  });
}
function tmPopSetStaff(stId,field,value){
  var st=tmById(production.staffing,"STAFFING_ID",stId);if(!st)return;
  if(field==="ROLE")value=String(value).trim();if(field==="NEEDED")value=Math.max(1,Number(value)||1);
  if(String(st[field]===undefined||st[field]===null?"":st[field])===String(value))return;
  var rec=Object.assign({},st);rec[field]=value;
  var n=tmNum(rec.NEEDED,1),c=tmSplitIds(rec.ASSIGNED_PERSON_IDS).length;rec.CONFIRMED_COUNT=Math.min(n,c);rec.GAP=Math.max(0,n-c);
  tmSaveStaffing(rec,function(){tmRefreshSceneRow(st.SCENE_UID);tmPopRender()});
}
function tmPopNewPersonFor(stId){
  var st=tmById(production.staffing,"STAFFING_ID",stId);if(!st)return;
  var name=prompt("New person's name:");if(!name||!name.trim())return;
  var rec={PERSON_ID:tmNewPersonId(name.trim()),NAME:name.trim(),GROUPS:st.DEPARTMENT==="Cast"?"Cast":"Crew",ROLES_CHARACTERS:st.ROLE,PROJECT_STATUS:"Candidate",CONTRACT_STATUS:"Not Sent",ACTIVE:true,SOURCE_TABS:"Task Manager"};
  tmSavePerson(rec);
  tmPopSetStaff(stId,"ASSIGNED_PERSON_IDS",rec.PERSON_ID);
}
function tmMiniTask(t,viaItem){
  var st=tmStatus(t.STATUS_COLOR).toLowerCase();
  return'<span class="tm-chip st-'+st+(viaItem?' via':'')+'" onclick="event.stopPropagation();openTaskEditor(\''+tmAttr(t.TASK_ID)+'\')" title="'+tmAttr((viaItem?'Via linked item · ':'')+(t.DUE_DATE?'due '+t.DUE_DATE+' · ':'')+tmPersonName(tmGroupKey(t)))+'"><i class="tm-dot '+st+'"></i>'+esc(t.TITLE)+'</span>';
}

// ── PEOPLE & CONTRACTS ───────────────────────────────────────
function tmRenderPeople(){
  var filters=[["all","Everyone"],["unsigned","Unsigned only"],["cast","Cast only"],["crew","Crew only"],["producers","Producers"]];
  var rows=production.people.filter(function(p){
    if(!tmActive(p)&&!tmShowRemoved)return false;
    var g=String(p.GROUPS||"");
    if(tmPeopleFilter==="unsigned"&&(p.CONTRACT_STATUS==="Signed"||p.CONTRACT_STATUS==="Not Required"))return false;
    if(tmPeopleFilter==="cast"&&g.indexOf("Cast")<0)return false;
    if(tmPeopleFilter==="crew"&&g.indexOf("Crew")<0)return false;
    if(tmPeopleFilter==="producers"&&g.indexOf("Producer")<0)return false;
    return tmMatch([p.NAME,g,p.ROLES_CHARACTERS,p.PROJECT_STATUS,p.CONTRACT_STATUS,p.NOTES,p.EMAIL,p.PHONE].join(" "));
  }).sort(function(a,b){return String(a.NAME).localeCompare(String(b.NAME))});
  var removed=production.people.filter(function(p){return !tmActive(p)}).length;
  var h='<div class="tm-todo-head"><div class="tm-filters">'+filters.map(function(f){return'<button class="tm-subtab small '+(tmPeopleFilter===f[0]?'active':'')+'" onclick="tmPeopleFilter=\''+f[0]+'\';renderTaskBody()">'+f[1]+'</button>'}).join("")+'</div><span class="tm-muted">'+rows.length+' people</span>'+(removed?'<label class="tm-muted tm-toggle"><input type="checkbox" '+(tmShowRemoved?'checked':'')+' onchange="tmShowRemoved=this.checked;renderTaskBody()"> show removed ('+removed+')</label>':'')+'<span class="tm-spacer"></span><button class="hbtn gold" onclick="openPersonEditor(null)">+ Add person</button></div>';
  h+='<table class="tm-table tm-people"><thead><tr><th class="tm-col-name">Name</th><th class="tm-col-group">Group</th><th>Role / character</th><th class="tm-col-sel">Attachment</th><th class="tm-col-sel">Contract</th><th>Contact</th><th class="tm-col-num">Scenes</th><th>Availability</th><th>Notes</th><th class="tm-col-more"></th></tr></thead><tbody>';
  rows.forEach(function(p){
    var id=p.PERSON_ID,st=tmPersonState(p),sc=tmIx.staffByPerson[id]||[],active=tmActive(p);
    var seqs=[];sc.forEach(function(x){var s=tmScene(x.SCENE_UID);if(seqs.indexOf(s.seqLabel)<0)seqs.push(s.seqLabel)});
    h+='<tr class="tm-row'+(active?'':' removed')+'" data-person="'+tmAttr(id)+'">';
    h+='<td class="tm-namecell"><span class="tm-chip st-'+st+'" draggable="true" ondragstart="tmStartDrag(event,\'Person\',\''+tmAttr(id)+'\')" title="Open"><i class="tm-dot '+st+'"></i><span class="tm-edit tm-inline" contenteditable="true" spellcheck="false" onclick="event.stopPropagation()" onkeydown="tmEditKey(event,this)" onblur="tmEditText(this,\'person\',\''+tmAttr(id)+'\',\'NAME\')">'+esc(p.NAME)+'</span></span>'+(active?'':'<div class="tm-faint">removed</div>')+'</td>';
    h+='<td><select class="tm-mini-select" onchange="tmPatch(\'person\',\''+tmAttr(id)+'\',\'GROUPS\',this.value)">'+tmGroupOptions(p.GROUPS)+'</select></td>';
    h+='<td><div class="tm-edit" contenteditable="true" spellcheck="false" onkeydown="tmEditKey(event,this)" onblur="tmEditText(this,\'person\',\''+tmAttr(id)+'\',\'ROLES_CHARACTERS\')">'+esc(p.ROLES_CHARACTERS||"")+'</div></td>';
    h+='<td><select class="tm-mini-select" onchange="tmPatch(\'person\',\''+tmAttr(id)+'\',\'PROJECT_STATUS\',this.value)">'+TM_PROJECT.map(function(v){return'<option'+(p.PROJECT_STATUS===v?' selected':'')+'>'+v+'</option>'}).join("")+'</select></td>';
    h+='<td><select class="tm-mini-select ct-'+st+'" onchange="tmPatch(\'person\',\''+tmAttr(id)+'\',\'CONTRACT_STATUS\',this.value)">'+TM_CONTRACT.map(function(v){return'<option value="'+v+'"'+((p.CONTRACT_STATUS||"")===v?' selected':'')+'>'+(v||"—")+'</option>'}).join("")+'</select><div class="tm-edit tm-sub" contenteditable="true" spellcheck="false" data-ph="version" onkeydown="tmEditKey(event,this)" onblur="tmEditText(this,\'person\',\''+tmAttr(id)+'\',\'CONTRACT_VERSION\')">'+esc(p.CONTRACT_VERSION||"")+'</div></td>';
    h+='<td><div class="tm-edit tm-sub" contenteditable="true" spellcheck="false" data-ph="phone" onkeydown="tmEditKey(event,this)" onblur="tmEditText(this,\'person\',\''+tmAttr(id)+'\',\'PHONE\')">'+esc(p.PHONE||"")+'</div><div class="tm-edit tm-sub" contenteditable="true" spellcheck="false" data-ph="email" onkeydown="tmEditKey(event,this)" onblur="tmEditText(this,\'person\',\''+tmAttr(id)+'\',\'EMAIL\')">'+esc(p.EMAIL||"")+'</div></td>';
    h+='<td class="tm-muted tm-col-num" title="'+tmAttr(seqs.join(", "))+'">'+(seqs.length?seqs.length:'—')+'</td>';
    h+='<td class="tm-wide"><div class="tm-edit" contenteditable="true" spellcheck="false" onkeydown="tmEditKey(event,this)" onblur="tmEditText(this,\'person\',\''+tmAttr(id)+'\',\'AVAILABILITY\')">'+esc(p.AVAILABILITY||"")+'</div></td>';
    h+='<td class="tm-wide"><div class="tm-edit" contenteditable="true" spellcheck="false" onkeydown="tmEditKey(event,this)" onblur="tmEditText(this,\'person\',\''+tmAttr(id)+'\',\'NOTES\')">'+esc(p.NOTES||"")+'</div></td>';
    h+='<td class="tm-col-more"><button class="tm-more" title="Open · replace · remove" onclick="openPersonEditor(\''+tmAttr(id)+'\')">⋯</button></td></tr>';
  });
  h+='</tbody></table>';
  if(!rows.length)h+='<div class="tm-empty">No one matches this filter.</div>';
  return h;
}
/** Group dropdown: the standard groups, common combinations, and whatever the row already says. */
function tmGroupOptions(current){
  current=String(current||"");
  var opts=TM_GROUPS.concat(["Producer; Crew","Cast; Crew"]);
  if(current&&opts.indexOf(current)<0)opts.push(current);
  if(!current)opts.unshift("");
  return opts.map(function(v){return'<option value="'+tmAttr(v)+'"'+(v===current?' selected':'')+'>'+esc(v||"—")+'</option>'}).join("");
}

// ── modals ───────────────────────────────────────────────────
function tmStatusButtons(current,prefix){return'<div class="tm-statuses">'+TM_STATUSES.map(function(s){return'<button type="button" class="tm-status '+(current===s?'active':'')+'" data-status="'+s+'" onclick="tmChooseStatus(\''+prefix+'\',\''+s+'\')">'+s+'</button>'}).join("")+'</div><input type="hidden" id="'+prefix+'" value="'+tmAttr(current)+'">'}
function tmChooseStatus(prefix,status){document.getElementById(prefix).value=status;var root=document.getElementById(prefix).previousElementSibling;Array.prototype.forEach.call(root.children,function(b){b.classList.toggle("active",b.dataset.status===status)})}
function tmClose(){var m=document.getElementById("tmModalMount");if(m)m.parentNode.removeChild(m);if(window.tmPopClose)tmPopClose()}
function tmModal(html){tmClose();var d=document.createElement("div");d.id="tmModalMount";d.innerHTML='<div class="tm-modal-bg" onclick="tmClose()"><div class="tm-modal" onclick="event.stopPropagation();if(window.tmPopClose)tmPopClose()">'+html+'</div></div>';document.body.appendChild(d)}
function tmVal(id){var el=document.getElementById(id);return el?el.value.trim():""}
function tmChecked(id){var el=document.getElementById(id);return !!(el&&el.checked)}
function tmSelect(id,options,current,labels){return'<select class="tm-input" id="'+id+'">'+options.map(function(v,i){return'<option value="'+tmAttr(v)+'"'+(String(current||"")===String(v)?' selected':'')+'>'+esc(labels?labels[i]:(v||"—"))+'</option>'}).join("")+'</select>'}
function tmPeopleOptions(current){
  var ids=[""],labels=["Unassigned"];
  tmActivePeople().forEach(function(p){ids.push(p.PERSON_ID);labels.push(p.NAME+(p.GROUPS?' · '+p.GROUPS:''))});
  if(current&&ids.indexOf(current)<0){ids.push(current);labels.push(current)}
  return tmSelect("taskAssignee",ids,current,labels);
}

/** One master record. Saving re-renders every sequence that uses it. */
function openItemEditor(id){
  var item=tmIx.items[id];if(!item)return;
  var reqs=(tmIx.reqsByItem[id]||[]).slice().sort(function(a,b){return seqNum(tmScene(a.SCENE_UID))-seqNum(tmScene(b.SCENE_UID))});
  var h='<h2>'+esc(item.NAME)+'</h2><div class="tm-modal-sub">'+esc(item.TYPE)+' · used in '+reqs.length+' sequence'+(reqs.length===1?'':'s')+' · one record</div>';
  h+='<div class="tm-field full"><label>Overall status</label>'+tmStatusButtons(tmStatus(item.STATUS),"itemStatus")+'</div><div class="tm-form-grid">';
  h+='<div class="tm-field"><label>Name</label><input class="tm-input" id="itemName" value="'+tmAttr(item.NAME||"")+'"></div>';
  h+='<div class="tm-field"><label>Contract / permission</label>'+tmSelect("itemContract",TM_CONTRACT,item.CONTRACT_STATUS)+'</div>';
  h+='<div class="tm-field"><label>Owner</label><input class="tm-input" id="itemOwner" value="'+tmAttr(item.OWNER||"")+'"></div>';
  h+='<div class="tm-field"><label>Needed / ready</label><div class="tm-pair"><input class="tm-input" id="itemNeeded" value="'+tmAttr(item.QUANTITY_NEEDED||"")+'" placeholder="need"><input class="tm-input" id="itemReady" value="'+tmAttr(item.QUANTITY_READY||"")+'" placeholder="ready"></div></div>';
  if(item.TYPE==="Location")h+='<div class="tm-field full"><label>Address</label><input class="tm-input" id="itemAddress" value="'+tmAttr(item.ADDRESS||"")+'"></div>';
  h+='<div class="tm-field full"><label>Link</label><input class="tm-input" id="itemLink" value="'+tmAttr(item.LINK||"")+'" placeholder="Vendor, photo, contract or reference link"></div>';
  h+='<div class="tm-field full"><label>Notes (apply everywhere this appears)</label><textarea class="tm-textarea" id="itemNotes">'+esc(item.NOTES||"")+'</textarea></div></div>';
  h+='<div class="tm-field"><label>Where it appears · scene-only override and note</label>';
  reqs.forEach(function(r){var s=tmScene(r.SCENE_UID);h+='<div class="tm-scene-link"><b>'+esc(s.seqLabel||s.seq)+' — '+esc(s.title)+'</b>'+(s.shootDay?' <span class="tm-muted">'+esc(tmFmtDate(s.shootDay))+'</span>':'')+'<input class="tm-input" id="reqw-'+tmAttr(r.REQUIREMENT_ID)+'" value="'+tmAttr(r.SCENE_WORDING||item.NAME)+'" placeholder="Scene wording / subarea" style="margin-top:5px"><div class="tm-pair" style="margin-top:5px"><select class="tm-mini-select" id="req-'+tmAttr(r.REQUIREMENT_ID)+'"><option value="">Inherit</option>'+TM_STATUSES.map(function(v){return'<option'+(r.STATUS_OVERRIDE===v?' selected':'')+'>'+v+'</option>'}).join("")+'</select><input class="tm-input" id="reqn-'+tmAttr(r.REQUIREMENT_ID)+'" value="'+tmAttr(r.NOTES||"")+'" placeholder="Scene-specific note"></div></div>'});
  var linked=(tmIx.tasksByItem[id]||[]);
  h+='</div>'+(linked.length?'<div class="tm-field"><label>Tasks</label>'+linked.map(function(t){return tmMiniTask(t,false)}).join("")+'</div>':'');
  h+='<div class="tm-actions"><button class="mbtn ghost" onclick="tmClose();openTaskEditor(null,{type:\'Item\',id:\''+tmAttr(id)+'\'})">+ Task</button><button class="mbtn ghost" onclick="openMergeItem(\''+tmAttr(id)+'\')">Merge duplicate…</button><span class="tm-spacer"></span><button class="mbtn ghost" onclick="tmClose()">Cancel</button><button class="mbtn gold" onclick="saveItemEditor(\''+tmAttr(id)+'\')">Save</button></div>';tmModal(h);
}
function saveItemEditor(id){
  var item=tmIx.items[id];if(!item)return;
  var record=Object.assign({},item,{NAME:tmVal("itemName")||item.NAME,STATUS:tmVal("itemStatus"),CONTRACT_STATUS:tmVal("itemContract"),OWNER:tmVal("itemOwner"),QUANTITY_NEEDED:tmVal("itemNeeded"),QUANTITY_READY:tmVal("itemReady"),LINK:tmVal("itemLink"),NOTES:tmVal("itemNotes")});
  if(item.TYPE==="Location")record.ADDRESS=tmVal("itemAddress");
  var reqJobs=(tmIx.reqsByItem[id]||[]).filter(function(r){return String(r.SCENE_WORDING||"")!==tmVal("reqw-"+r.REQUIREMENT_ID)||String(r.STATUS_OVERRIDE||"")!==tmVal("req-"+r.REQUIREMENT_ID)||String(r.NOTES||"")!==tmVal("reqn-"+r.REQUIREMENT_ID)}).map(function(r){return Object.assign({},r,{SCENE_WORDING:tmVal("reqw-"+r.REQUIREMENT_ID),STATUS_OVERRIDE:tmVal("req-"+r.REQUIREMENT_ID),NOTES:tmVal("reqn-"+r.REQUIREMENT_ID)})});
  tmClose();
  tmSaveItem(record,function(){tmRefreshItemRows(id)});
  // scene overrides are separate rows; write only the ones that changed
  reqJobs.forEach(function(rec){tmSaveRequirement(rec,renderTaskBody)});
}
function openMergeItem(id){
  var item=tmIx.items[id];if(!item)return;
  var options=production.items.filter(function(i){return i.ITEM_ID!==id&&i.TYPE===item.TYPE&&tmActive(i)}).sort(function(a,b){return String(a.NAME).localeCompare(String(b.NAME))});
  var h='<h2>Merge duplicate '+esc(item.TYPE.toLowerCase())+'</h2><div class="tm-modal-sub">Move every sequence, task and note from <b>'+esc(item.NAME)+'</b> into one canonical record. The old ID stays as inactive history.</div>';
  h+='<div class="tm-field"><label>Keep this record</label><select class="tm-input" id="mergeItemInto">'+options.map(function(i){return'<option value="'+tmAttr(i.ITEM_ID)+'">'+esc(i.NAME)+' · '+(tmIx.reqsByItem[i.ITEM_ID]||[]).length+' sequences</option>'}).join("")+'</select></div>';
  h+='<div class="tm-actions"><button class="mbtn ghost" onclick="openItemEditor(\''+tmAttr(id)+'\')">Back</button><span class="tm-spacer"></span><button class="mbtn gold" '+(options.length?'':'disabled')+' onclick="runMergeItem(\''+tmAttr(id)+'\')">Merge records</button></div>';tmModal(h);
}
function runMergeItem(fromId){
  var intoId=tmVal("mergeItemInto"),from=tmIx.items[fromId],into=tmIx.items[intoId];if(!intoId||!from||!into)return;
  if(!confirm('Merge "'+from.NAME+'" into "'+into.NAME+'"?\n\nAll linked scenes and tasks will use the kept record.'))return;
  tmClose();tmSave({action:"mergeItem",fromId:fromId,intoId:intoId}).then(function(r){
    if(!r||r.error)return;loadProduction(true).then(function(){return loadFromSheet(true)}).then(function(){toast(from.NAME+' merged into '+into.NAME,"ok")});
  });
}

/** Scene panel: what this one sequence needs, who is in it, and its scene-only notes. */
function openSceneProduction(uid){
  var s=tmScene(uid),reqs=tmIx.reqsByScene[uid]||[],staff=tmIx.staffByScene[uid]||[],notes=production.notes.filter(function(n){return n.SCOPE_TYPE==="Scene"&&n.SCOPE_ID===uid&&!tmBool(n.RESOLVED)}),tasks=tmIx.tasksByScene[uid]||[];
  var h='<h2>'+esc(s.seqLabel||s.seq)+' — '+esc(s.title)+'</h2><div class="tm-modal-sub">'+(s.shootDay?'Shoots '+esc(tmFmtDate(s.shootDay)):'Unscheduled')+' · '+reqs.length+' requirements · '+staff.length+' roles'+(s.shortSummary?'<div class="tm-summary-text">'+esc(s.shortSummary)+'</div>':'')+'</div>';
  h+='<div class="tm-sequence-edit"><div class="tm-form-grid"><div class="tm-field"><label>Sequence label</label><input class="tm-input" id="sceneSeq" value="'+tmAttr(s.seqLabel||s.seq)+'" placeholder="SEQ 25"></div><div class="tm-field"><label>Scene title</label><input class="tm-input" id="sceneTitle" value="'+tmAttr(s.title||"")+'"></div><div class="tm-field"><label>Shoot date</label><input class="tm-input" type="date" id="sceneShootDay" value="'+tmAttr(String(s.shootDay||"").slice(0,10))+'"></div><div class="tm-field"><label>Day order</label><input class="tm-input" type="number" id="sceneDayOrder" value="'+tmAttr(s.dayOrder===null||s.dayOrder===undefined?"":s.dayOrder)+'" placeholder="1"></div><div class="tm-field full"><label>Short summary</label><textarea class="tm-textarea" id="sceneSummary">'+esc(s.shortSummary||"")+'</textarea></div></div><div class="tm-record-id">Stable scene ID: '+esc(uid)+'</div></div>';
  h+='<div class="tm-scene-grid" data-scene-modal="'+tmAttr(uid)+'">';
  TM_CELLS.forEach(function(c){h+='<div class="tm-field"><label>'+esc(c.label)+'</label><div class="tm-chips" data-cell="'+c.key+'">'+tmCellChips(uid,c)+'</div></div>'});
  h+='</div>';
  h+='<div class="tm-field"><label>Tasks</label><div class="tm-chips">'+tasks.map(function(t){return tmMiniTask(t,false)}).join("")+'<button class="tm-plus" onclick="tmClose();openTaskEditor(null,{type:\'Scene\',id:\''+tmAttr(uid)+'\'})">+</button></div></div>';
  h+='<div class="tm-field"><label>Scene-only notes</label><div id="sceneNotesList">'+tmSceneNotesHtml(uid)+'</div>';
  h+='<div class="tm-pair" style="margin-top:6px"><select class="tm-input" id="sceneNoteCategory" style="max-width:130px"><option>Logistics</option><option>Creative</option><option>Safety</option><option>Schedule</option><option>General</option></select><input class="tm-input" id="sceneNoteBody" placeholder="Add a note that belongs only to this scene" onkeydown="if(event.key===\'Enter\')saveSceneNote(\''+tmAttr(uid)+'\')"><button class="hbtn gold" onclick="saveSceneNote(\''+tmAttr(uid)+'\')">Add</button></div></div>';
  h+='<div class="tm-actions"><button class="mbtn ghost" onclick="tmClose()">Close</button><span class="tm-spacer"></span><button class="mbtn gold" onclick="saveSceneProduction(\''+tmAttr(uid)+'\')">Save sequence</button></div>';tmModal(h);
}
function saveSceneProduction(uid){
  var s=getScene(uid);if(!s)return;
  var label=tmVal("sceneSeq")||s.seqLabel||s.seq,title=tmVal("sceneTitle"),date=tmVal("sceneShootDay"),order=tmVal("sceneDayOrder"),summary=tmVal("sceneSummary");
  if(!title){toast("The sequence needs a title","err");return}
  var before={seq:s.seq,seqLabel:s.seqLabel,title:s.title,shootDay:s.shootDay,dayOrder:s.dayOrder,shortSummary:s.shortSummary,name:s.name};
  var changed=before.seqLabel!==label||before.title!==title||String(before.shootDay||"")!==date||String(before.dayOrder===null||before.dayOrder===undefined?"":before.dayOrder)!==order||String(before.shortSummary||"")!==summary;
  if(!changed){tmSaveState("saved","Nothing changed");return}
  s.seqLabel=label;s.seq=String(label).replace(/SEQ/i,"").trim();s.title=title;s.shootDay=date;s.dayOrder=order===""?null:Number(order);s.shortSummary=summary;s.name=label+" — "+title;
  // update in place: the row, the drawer heading — no full re-render, no reopening
  tmSchedulerDirty=true;
  tmRefreshSceneRow(uid);
  var head=document.querySelector("#tmModalMount h2");if(head)head.textContent=(s.seqLabel||s.seq)+" — "+s.title;
  tmSave({action:"saveScene",scene:{uid:uid,seqLabel:label,title:title,fields:{"SEQ":label,"SCENE TITLE":title,"SCENE SHORT SUMMARY":summary,"SHOOTING DAY":date,"DAY ORDER":order}}}).then(function(r){
    if(!r||r.error){Object.keys(before).forEach(function(k){s[k]=before[k]});tmRefreshSceneRow(uid);var h2=document.querySelector("#tmModalMount h2");if(h2)h2.textContent=(s.seqLabel||s.seq)+" — "+s.title;return}
    toast(label+" saved","ok");
  });
}
function tmSceneNotesHtml(uid){
  var notes=production.notes.filter(function(n){return n.SCOPE_TYPE==="Scene"&&n.SCOPE_ID===uid&&!tmBool(n.RESOLVED)});
  return notes.map(function(n){return'<div class="tm-scene-link"><b>'+esc(n.CATEGORY||"Note")+'</b> '+esc(n.BODY)+' <button class="tm-more" title="Resolve" onclick="tmResolveNote(\''+tmAttr(n.NOTE_ID)+'\',\''+tmAttr(uid)+'\')">✓</button></div>'}).join("");
}
/* Notes update only their own list inside the drawer — the rest of the drawer, the
   fields you may be typing in, and the scroll position stay exactly where they were. */
function tmRefreshSceneNotes(uid){var el=document.getElementById("sceneNotesList");if(el&&document.querySelector('.tm-scene-grid[data-scene-modal="'+uid+'"]'))el.innerHTML=tmSceneNotesHtml(uid)}
function saveSceneNote(uid){var body=tmVal("sceneNoteBody");if(!body){toast("Write the note first","err");return}var inp=document.getElementById("sceneNoteBody");if(inp)inp.value="";tmSaveNote({NOTE_ID:"",SCOPE_TYPE:"Scene",SCOPE_ID:uid,CATEGORY:tmVal("sceneNoteCategory")||"General",BODY:body,PINNED:false,RESOLVED:false,SOURCE:"Task Manager"},function(){tmRefreshSceneNotes(uid)})}
function tmResolveNote(id,uid){var n=tmById(production.notes,"NOTE_ID",id);if(!n)return;tmSaveNote(Object.assign({},n,{RESOLVED:true}),function(){tmRefreshSceneNotes(uid)})}

function openStaffingEditor(id,uid){
  var st=id?tmById(production.staffing,"STAFFING_ID",id):null,s=tmScene(uid);
  st=st||{STAFFING_ID:"",SCENE_UID:uid,SEQ:s.seqLabel||s.seq,DEPARTMENT:"Crew",ROLE:"",NEEDED:1,ASSIGNED_PERSON_IDS:"",CONFIRMED_COUNT:0,GAP:1,NOTES:""};
  var assigned=tmSplitIds(st.ASSIGNED_PERSON_IDS);
  var h='<h2>'+(id?'Edit role':'New role')+'</h2><div class="tm-modal-sub">'+esc(s.seqLabel||s.seq)+' — '+esc(s.title)+'</div><div class="tm-form-grid">';
  h+='<div class="tm-field"><label>Department</label>'+tmSelect("staffDept",["Cast","Crew","Extras","Stunts","HMU","Wardrobe","Camera","Sound","Art","Production"],st.DEPARTMENT||"Crew")+'</div>';
  h+='<div class="tm-field"><label>Role</label><input class="tm-input" id="staffRole" value="'+tmAttr(st.ROLE||"")+'"></div>';
  h+='<div class="tm-field"><label>Needed</label><input class="tm-input" id="staffNeeded" type="number" min="0" value="'+tmAttr(tmNum(st.NEEDED,1))+'"></div>';
  h+='<div class="tm-field"><label>Confirmed</label><input class="tm-input" id="staffConfirmed" type="number" min="0" value="'+tmAttr(tmNum(st.CONFIRMED_COUNT,0))+'"></div>';
  h+='<div class="tm-field full"><label>Assigned people</label><div class="tm-checklist">'+production.people.filter(function(p){return tmActive(p)||assigned.indexOf(p.PERSON_ID)>=0}).sort(function(a,b){return String(a.NAME).localeCompare(String(b.NAME))}).map(function(p){return'<label><input type="checkbox" class="staffPerson" value="'+tmAttr(p.PERSON_ID)+'" '+(assigned.indexOf(p.PERSON_ID)>=0?'checked':'')+'> '+esc(p.NAME)+'<span class="tm-faint"> '+esc(p.ROLES_CHARACTERS||p.GROUPS||"")+'</span></label>'}).join("")+'</div></div>';
  h+='<div class="tm-field full"><label>Notes</label><textarea class="tm-textarea" id="staffNotes">'+esc(st.NOTES||"")+'</textarea></div></div>';
  h+='<div class="tm-actions"><button class="mbtn ghost" onclick="openSceneProduction(\''+tmAttr(uid)+'\')">Back</button><button class="mbtn gold" onclick="saveStaffingEditor(\''+tmAttr(st.STAFFING_ID||"")+'\',\''+tmAttr(uid)+'\',\''+tmAttr(st.SEQ||"")+'\')">Save</button></div>';tmModal(h);
}
function saveStaffingEditor(id,uid,seq){
  var needed=Math.max(0,Number(tmVal("staffNeeded"))||0),confirmed=Math.max(0,Number(tmVal("staffConfirmed"))||0);
  var people=Array.prototype.filter.call(document.querySelectorAll(".staffPerson"),function(c){return c.checked}).map(function(c){return c.value});
  var record={STAFFING_ID:id,SCENE_UID:uid,SEQ:seq,DEPARTMENT:tmVal("staffDept")||"Crew",ROLE:tmVal("staffRole"),NEEDED:needed,ASSIGNED_PERSON_IDS:people.join("; "),CONFIRMED_COUNT:confirmed,GAP:Math.max(0,needed-confirmed),NOTES:tmVal("staffNotes")};
  if(!record.ROLE){toast("Give the role a name","err");return}
  tmSaveStaffing(record,function(){tmRefreshSceneRow(uid)});
  openSceneProduction(uid);   // back to the drawer, once
}

/** Existing person, or a blank form when id is null. */
function openPersonEditor(id){
  var isNew=!id,p=isNew?{PERSON_ID:"",NAME:"",GROUPS:"Cast",ROLES_CHARACTERS:"",PROJECT_STATUS:"Candidate",CONTRACT_STATUS:"Not Sent",ACTIVE:true}:tmPerson(id);if(!p)return;
  var scenesFor=isNew?[]:(tmIx.staffByPerson[id]||[]).map(function(x){return tmScene(x.SCENE_UID)}).sort(function(a,b){return seqNum(a)-seqNum(b)});
  var h='<h2>'+(isNew?'New person':esc(p.NAME))+'</h2><div class="tm-modal-sub">'+(isNew?'Added to People &amp; Contracts. Put them in scenes afterwards with Replace, or per scene from the Sequences table.':esc(p.GROUPS||"")+(p.ROLES_CHARACTERS?' · '+esc(p.ROLES_CHARACTERS):'')+(tmActive(p)?'':' · <b>removed from project</b>'))+'</div><div class="tm-form-grid">';
  h+='<div class="tm-field"><label>Name</label><input class="tm-input" id="personName" value="'+tmAttr(p.NAME||"")+'" placeholder="Full name"></div>';
  h+='<div class="tm-field"><label>Group</label><select class="tm-input" id="personGroups">'+tmGroupOptions(p.GROUPS)+'</select></div>';
  h+='<div class="tm-field"><label>Attachment</label>'+tmSelect("personProject",TM_PROJECT,p.PROJECT_STATUS||"Listed")+'</div>';
  h+='<div class="tm-field"><label>Contract</label>'+tmSelect("personContract",TM_CONTRACT,p.CONTRACT_STATUS)+'</div>';
  h+='<div class="tm-field"><label>Contract version</label><input class="tm-input" id="personVersion" value="'+tmAttr(p.CONTRACT_VERSION||"")+'"></div>';
  h+='<div class="tm-field"><label>Role / character</label><input class="tm-input" id="personRole" value="'+tmAttr(p.ROLES_CHARACTERS||"")+'"></div>';
  h+='<div class="tm-field"><label>Phone</label><input class="tm-input" id="personPhone" value="'+tmAttr(p.PHONE||"")+'"></div>';
  h+='<div class="tm-field"><label>Email</label><input class="tm-input" id="personEmail" value="'+tmAttr(p.EMAIL||"")+'"></div>';
  h+='<div class="tm-field full"><label>Availability</label><textarea class="tm-textarea" id="personAvail">'+esc(p.AVAILABILITY||"")+'</textarea></div>';
  h+='<div class="tm-field full"><label>Costume notes</label><textarea class="tm-textarea" id="personCostume">'+esc(p.COSTUME_NOTES||"")+'</textarea></div>';
  h+='<div class="tm-field full"><label>Notes</label><textarea class="tm-textarea" id="personNotes">'+esc(p.NOTES||"")+'</textarea></div></div>';
  if(!isNew)h+='<div class="tm-field"><label>In '+scenesFor.length+' sequence'+(scenesFor.length===1?'':'s')+'</label><div class="tm-chips">'+(scenesFor.length?scenesFor.map(tmSceneChip).join(""):'<span class="tm-muted">Not in any scene yet</span>')+'</div></div>';
  h+='<div class="tm-actions">';
  if(!isNew){
    h+='<button class="mbtn ghost" onclick="tmClose();openTaskEditor(null,{type:\'Person\',id:\''+tmAttr(id)+'\'},\''+tmAttr(id)+'\')">+ Task</button>';
    h+='<button class="mbtn ghost" onclick="openReplacePerson(\''+tmAttr(id)+'\')" title="Hand every scene to someone else">Replace in all scenes…</button>';
    h+='<button class="mbtn ghost" onclick="openMergePerson(\''+tmAttr(id)+'\')" title="Combine accidental duplicate records">Merge duplicate…</button>';
    h+=tmActive(p)?'<button class="mbtn ghost tm-danger" onclick="tmRemovePerson(\''+tmAttr(id)+'\')">Remove from project</button>':'<button class="mbtn ghost" onclick="tmRestorePerson(\''+tmAttr(id)+'\')">Restore</button>';
  }
  h+='<span class="tm-spacer"></span><button class="mbtn ghost" onclick="tmClose()">Cancel</button><button class="mbtn gold" onclick="savePersonEditor(\''+tmAttr(id||"")+'\')">'+(isNew?'Add person':'Save')+'</button></div>';
  tmModal(h);if(isNew)setTimeout(function(){var el=document.getElementById("personName");if(el)el.focus()},60);
}
function tmReadPersonForm(base){
  return Object.assign({},base,{NAME:tmVal("personName"),GROUPS:tmVal("personGroups"),PROJECT_STATUS:tmVal("personProject"),CONTRACT_STATUS:tmVal("personContract"),CONTRACT_VERSION:tmVal("personVersion"),ROLES_CHARACTERS:tmVal("personRole"),PHONE:tmVal("personPhone"),EMAIL:tmVal("personEmail"),AVAILABILITY:tmVal("personAvail"),COSTUME_NOTES:tmVal("personCostume"),NOTES:tmVal("personNotes")});
}
function savePersonEditor(id){
  var p=id?tmPerson(id):{PERSON_ID:"",ACTIVE:true,SOURCE_TABS:"Task Manager"};if(!p)return;
  var record=tmReadPersonForm(p);
  if(!record.NAME){toast("The person needs a name","err");return}
  if(!id)record.PERSON_ID=tmNewPersonId(record.NAME);
  tmClose();tmSavePerson(record,renderTaskBody);if(!id)toast(record.NAME+" added","ok");
}
function openMergePerson(id){
  var person=tmPerson(id);if(!person)return;
  var options=tmActivePeople().filter(function(p){return p.PERSON_ID!==id}).sort(function(a,b){return String(a.NAME).localeCompare(String(b.NAME))});
  var h='<h2>Merge duplicate person</h2><div class="tm-modal-sub">Move all scene assignments, tasks and notes from <b>'+esc(person.NAME)+'</b> into the canonical person. The old row remains inactive history.</div>';
  h+='<div class="tm-field"><label>Keep this person</label><select class="tm-input" id="mergePersonInto">'+options.map(function(p){return'<option value="'+tmAttr(p.PERSON_ID)+'">'+esc(p.NAME)+(p.ROLES_CHARACTERS?' · '+esc(p.ROLES_CHARACTERS):'')+'</option>'}).join("")+'</select></div>';
  h+='<div class="tm-actions"><button class="mbtn ghost" onclick="openPersonEditor(\''+tmAttr(id)+'\')">Back</button><span class="tm-spacer"></span><button class="mbtn gold" '+(options.length?'':'disabled')+' onclick="runMergePerson(\''+tmAttr(id)+'\')">Merge records</button></div>';tmModal(h);
}
function runMergePerson(fromId){
  var intoId=tmVal("mergePersonInto"),from=tmPerson(fromId),into=tmPerson(intoId);if(!intoId||!from||!into)return;
  if(!confirm('Merge "'+from.NAME+'" into "'+into.NAME+'"?\n\nEvery staffing assignment and linked task will move to the kept person.'))return;
  tmClose();tmSave({action:"mergePerson",fromId:fromId,intoId:intoId}).then(function(r){
    if(!r||r.error)return;loadProduction(true).then(function(){return loadFromSheet(true)}).then(function(){toast(from.NAME+' merged into '+into.NAME,"ok")});
  });
}

/** Soft removal: the row stays in the sheet, marked Released and inactive, and
    disappears from every list. Their scene assignments are cleared on request. */
function tmRemovePerson(id){
  var p=tmPerson(id);if(!p)return;
  var rows=tmIx.staffByPerson[id]||[];
  var msg="Remove "+p.NAME+" from the project?\n\nThey stay in the sheet marked Released (history kept) and leave every list.";
  if(rows.length)msg+="\n\nThey are cast or crew in "+rows.length+" scene"+(rows.length===1?"":"s")+". Those roles will be left unassigned.\nTo hand the scenes to someone else instead, cancel and use Replace in all scenes.";
  if(!confirm(msg))return;
  tmClose();
  var jobs=[function(){return tmSavePerson(Object.assign({},p,{ACTIVE:false,PROJECT_STATUS:"Released"}))}];
  rows.forEach(function(st){jobs.push(function(){var ids=tmSplitIds(st.ASSIGNED_PERSON_IDS).filter(function(x){return x!==id});return tmSaveStaffing(Object.assign({},st,{ASSIGNED_PERSON_IDS:ids.join("; ")}))})});
  tmSaveChain(jobs,"Removing").then(function(res){renderTaskBody();if(res.failed)toast("Stopped after "+res.done+" of "+res.total+" — "+(res.failed.error||"error"),"err");else toast(p.NAME+" removed"+(rows.length?" · "+rows.length+" roles now unassigned":""),"ok")});
}
function tmRestorePerson(id){
  var p=tmPerson(id);if(!p)return;tmClose();
  tmSavePerson(Object.assign({},p,{ACTIVE:true,PROJECT_STATUS:p.PROJECT_STATUS==="Released"?"Listed":p.PROJECT_STATUS}),renderTaskBody);toast(p.NAME+" restored","ok");
}

/** Recast: every scene role held by `oldId` goes to an existing person or a new
    one. Optionally releases the old person and fixes the Scheduler's cast roster
    note (the actor name shown next to the character in Settings). */
function tmRosterNoteMatches(oldName){
  var cat=typeof getCat==="function"?getCat("cast"):null;if(!cat||!cat.meta||!oldName)return [];
  var out=[];for(var nm in cat.meta){if(String(cat.meta[nm].note||"").toLowerCase().indexOf(String(oldName).toLowerCase())>=0)out.push(nm)}return out;
}
function openReplacePerson(oldId){
  var old=tmPerson(oldId);if(!old)return;
  var rows=(tmIx.staffByPerson[oldId]||[]).slice().sort(function(a,b){return seqNum(tmScene(a.SCENE_UID))-seqNum(tmScene(b.SCENE_UID))});
  var roles=[];rows.forEach(function(st){if(roles.indexOf(st.ROLE)<0)roles.push(st.ROLE)});
  var others=tmActivePeople().filter(function(p){return p.PERSON_ID!==oldId});
  var rosterHits=tmRosterNoteMatches(old.NAME);
  var h='<h2>Replace '+esc(old.NAME)+'</h2><div class="tm-modal-sub">'+(rows.length?rows.length+' scene role'+(rows.length===1?'':'s')+' as '+esc(roles.join(", ")):'Not in any scene')+'</div>';
  h+='<div class="tm-field"><label>Who takes over</label><div class="tm-radio"><label><input type="radio" name="rpMode" value="existing" '+(others.length?'checked':'')+' onchange="tmReplaceMode()"> Someone already listed</label><label><input type="radio" name="rpMode" value="new" '+(others.length?'':'checked')+' onchange="tmReplaceMode()"> A new person</label></div></div>';
  h+='<div id="rpExisting" class="tm-field"><select class="tm-input" id="rpPerson">'+others.map(function(p){return'<option value="'+tmAttr(p.PERSON_ID)+'">'+esc(p.NAME)+(p.ROLES_CHARACTERS?' · '+esc(p.ROLES_CHARACTERS):'')+'</option>'}).join("")+'</select></div>';
  h+='<div id="rpNew" class="tm-form-grid"><div class="tm-field"><label>Name</label><input class="tm-input" id="rpName" placeholder="New actor\'s name"></div><div class="tm-field"><label>Group</label><select class="tm-input" id="rpGroups">'+tmGroupOptions(old.GROUPS||"Cast")+'</select></div><div class="tm-field"><label>Role / character</label><input class="tm-input" id="rpRole" value="'+tmAttr(old.ROLES_CHARACTERS||roles.join(", "))+'"></div><div class="tm-field"><label>Phone</label><input class="tm-input" id="rpPhone"></div><div class="tm-field full"><label>Email</label><input class="tm-input" id="rpEmail"></div></div>';
  h+='<div class="tm-field"><label>Also</label><div class="tm-checks">';
  h+='<label><input type="checkbox" id="rpRelease" checked> Remove '+esc(tmFirstName(old.NAME))+' from the project (kept in the sheet as Released)</label>';
  h+='<label><input type="checkbox" id="rpCopyRole" checked> Give the new person '+esc(tmFirstName(old.NAME))+'\'s role text ('+esc(old.ROLES_CHARACTERS||roles.join(", ")||"none")+')</label>';
  if(rosterHits.length)h+='<label><input type="checkbox" id="rpRoster" checked> Update the Scheduler cast roster: '+esc(rosterHits.join(", "))+' → new name</label>';
  h+='</div></div>';
  h+='<div class="tm-scene-link tm-muted">'+(rows.length?'Scenes: '+esc(rows.map(function(st){return tmScene(st.SCENE_UID).seqLabel}).join(", ")):'No scene rows to change.')+'</div>';
  h+='<div class="tm-actions"><button class="mbtn ghost" onclick="openPersonEditor(\''+tmAttr(oldId)+'\')">Back</button><span class="tm-spacer"></span><button class="mbtn gold" onclick="runReplacePerson(\''+tmAttr(oldId)+'\')">Replace'+(rows.length?' in '+rows.length+' scene'+(rows.length===1?'':'s'):'')+'</button></div>';
  tmModal(h);tmReplaceMode();
}
function tmReplaceMode(){var m=document.querySelector('input[name=rpMode]:checked');var isNew=m&&m.value==="new";document.getElementById("rpExisting").style.display=isNew?"none":"";document.getElementById("rpNew").style.display=isNew?"":"none";if(isNew)setTimeout(function(){var el=document.getElementById("rpName");if(el)el.focus()},40)}
function runReplacePerson(oldId){
  var old=tmPerson(oldId);if(!old)return;
  var m=document.querySelector('input[name=rpMode]:checked'),isNew=m&&m.value==="new";
  var newRec=null,newId=isNew?"":tmVal("rpPerson");
  if(isNew){var name=tmVal("rpName");if(!name){toast("Name the new person first","err");return}newId=tmNewPersonId(name);newRec={PERSON_ID:newId,NAME:name,GROUPS:tmVal("rpGroups")||old.GROUPS||"Cast",ROLES_CHARACTERS:tmVal("rpRole"),PROJECT_STATUS:"Candidate",CONTRACT_STATUS:"Not Sent",PHONE:tmVal("rpPhone"),EMAIL:tmVal("rpEmail"),ACTIVE:true,SOURCE_TABS:"Task Manager",NOTES:"Replaced "+old.NAME+" on "+new Date().toISOString().slice(0,10)}}
  else if(!newId||newId===oldId){toast("Pick who takes over","err");return}
  var release=tmChecked("rpRelease"),copyRole=tmChecked("rpCopyRole"),roster=tmChecked("rpRoster");
  var rows=(tmIx.staffByPerson[oldId]||[]).slice();
  tmClose();
  var jobs=[];
  if(newRec)jobs.push(function(){return tmSavePerson(newRec)});
  else if(copyRole&&old.ROLES_CHARACTERS){jobs.push(function(){var np=tmPerson(newId);var role=np.ROLES_CHARACTERS?(np.ROLES_CHARACTERS.indexOf(old.ROLES_CHARACTERS)>=0?np.ROLES_CHARACTERS:np.ROLES_CHARACTERS+"; "+old.ROLES_CHARACTERS):old.ROLES_CHARACTERS;return tmSavePerson(Object.assign({},np,{ROLES_CHARACTERS:role}))})}
  rows.forEach(function(st){jobs.push(function(){var ids=tmSplitIds(st.ASSIGNED_PERSON_IDS).map(function(x){return x===oldId?newId:x});ids=ids.filter(function(x,i){return ids.indexOf(x)===i});return tmSaveStaffing(Object.assign({},st,{ASSIGNED_PERSON_IDS:ids.join("; "),NOTES:String(st.NOTES||"").replace(/\s*$/,"")+(st.NOTES?" · ":"")+"Recast from "+old.NAME}))})});
  if(release)jobs.push(function(){return tmSavePerson(Object.assign({},old,{ACTIVE:false,PROJECT_STATUS:"Released"}))});
  if(roster)jobs.push(function(){return tmUpdateRosterNote(old.NAME,newRec?newRec.NAME:tmPersonName(newId))});
  tmSaveChain(jobs,"Replacing").then(function(res){
    renderTaskBody();
    var newName=newRec?newRec.NAME:tmPersonName(newId);
    if(res.failed)toast("Stopped after "+res.done+" of "+res.total+" — "+(res.failed.error||"error")+". Sync and check the People and Sequences tables.","err");
    else toast(newName+" now holds "+rows.length+" scene role"+(rows.length===1?"":"s")+(release?" · "+old.NAME+" removed":""),"ok");
  });
}
/** Rosters tab NOTES column carries the actor name next to each character. */
function tmUpdateRosterNote(oldName,newName){
  var hits=tmRosterNoteMatches(oldName),cat=getCat("cast");
  if(!hits.length||!cat)return Promise.resolve({success:true,skipped:true});
  hits.forEach(function(nm){cat.meta[nm].note=String(cat.meta[nm].note).replace(new RegExp(oldName.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"ig"),newName)});
  tmPending++;
  return saveRosters().then(function(){tmPending--;return {success:true}});
}

function tmLinkInfo(seed){
  if(!seed)return {type:"Project",id:"HAIRPIN",title:"",item:"",scene:"",person:"",taskType:"General"};
  if(seed.type==="Item"){var i=tmIx.items[seed.id];return {type:"Item",id:seed.id,title:i?i.NAME:"",item:seed.id,scene:"",person:"",taskType:i?i.TYPE:"General"}}
  if(seed.type==="Scene"){var s=tmScene(seed.id);return {type:"Scene",id:seed.id,title:(s.seqLabel||s.seq)+" — "+s.title,item:"",scene:seed.id,person:"",taskType:"Scene"}}
  var p=tmPerson(seed.id);return {type:"Person",id:seed.id,title:p?p.NAME:"",item:"",scene:"",person:seed.id,taskType:p&&(p.GROUPS||"").indexOf("Cast")>=0?"Cast":"Crew"};
}
/* ── task link picker ──
   A task can point at one record (a prop, location, vehicle, wardrobe, HMU, VFX,
   stunt or person) and, separately, at one sequence. "Get the rifle for SEQ 44"
   is both. The picker is a type dropdown, a search box and a short list. */
var TM_LINK_TYPES=["Prop","Location","Vehicle","Wardrobe","Hair & Makeup","VFX / SFX","Stunt","Person"];
var tmLinkDraft={type:"",id:""};
function tmLinkOptions(type,q){
  q=String(q||"").toLowerCase();
  function ok(s){return !q||String(s).toLowerCase().indexOf(q)>=0}
  if(!type)return [];
  if(type==="Person")return tmActivePeople().filter(function(p){return ok(p.NAME+" "+(p.ROLES_CHARACTERS||"")+" "+(p.GROUPS||""))}).map(function(p){return {id:p.PERSON_ID,label:p.NAME+(p.ROLES_CHARACTERS?" · "+p.ROLES_CHARACTERS:""),st:tmPersonState(p)}});
  return production.items.filter(function(i){return i.TYPE===type&&ok(i.NAME+" "+(i.ALIASES||""))}).sort(function(a,b){return String(a.NAME).localeCompare(String(b.NAME))}).map(function(i){var uses=(tmIx.reqsByItem[i.ITEM_ID]||[]).length;return {id:i.ITEM_ID,label:i.NAME+(uses?" · "+uses+" scene"+(uses===1?"":"s"):""),st:tmStatus(i.STATUS).toLowerCase()}});
}
function tmRenderLinkList(){
  var type=tmVal("taskLinkType"),q=tmVal("taskLinkSearch"),list=document.getElementById("taskLinkList");if(!list)return;
  var opts=tmLinkOptions(type,q);
  if(!type){list.innerHTML='<div class="tm-muted">Pick a type to link this task to a record.</div>';return}
  if(!opts.length){list.innerHTML='<div class="tm-muted">Nothing matches'+(q?' "'+esc(q)+'"':'')+'.</div>';return}
  list.innerHTML=opts.slice(0,60).map(function(o){return'<button type="button" class="tm-pick'+(tmLinkDraft.id===o.id?' active':'')+'" onclick="tmPickLink(\''+tmAttr(type)+'\',\''+tmAttr(o.id)+'\')"><i class="tm-dot '+o.st+'"></i>'+esc(o.label)+'</button>'}).join("")+(opts.length>60?'<div class="tm-muted">'+(opts.length-60)+' more — keep typing</div>':'');
}
function tmPickLink(type,id){tmLinkDraft={type:type,id:id};tmRenderLinkList();tmRenderLinkNow()}
function tmClearLink(){tmLinkDraft={type:"",id:""};tmRenderLinkList();tmRenderLinkNow()}
function tmLinkTypeChanged(){var t=tmVal("taskLinkType");if(t!==tmLinkDraft.type)tmLinkDraft={type:t,id:""};var s=document.getElementById("taskLinkSearch");if(s){s.value="";s.focus()}tmRenderLinkList();tmRenderLinkNow()}
function tmRenderLinkNow(){
  var el=document.getElementById("taskLinkNow");if(!el)return;
  var scene=tmVal("taskScene");
  var parts=[];
  if(tmLinkDraft.id){var fake={ITEM_ID:tmLinkDraft.type==="Person"?"":tmLinkDraft.id,PERSON_ID:tmLinkDraft.type==="Person"?tmLinkDraft.id:"",SCENE_UID:""};parts.push(tmLinkChip(fake)+'<button type="button" class="tm-more" title="Unlink" onclick="tmClearLink()">✕</button>')}
  if(scene)parts.push(tmSceneChip(tmScene(scene)));
  el.innerHTML=parts.length?parts.join(" "):'<span class="tm-muted">Not linked — the task is project-wide.</span>';
}
/** New or existing task. `seed` links it to a record; `assignee` preselects who owns it. */
function openTaskEditor(id,seed,assignee){
  var existing=id?tmById(production.tasks,"TASK_ID",id):null,link=tmLinkInfo(seed);
  var t=existing||{TASK_ID:"",TITLE:"",STATUS_COLOR:"Red",DONE:false,TASK_TYPE:link.taskType,ASSIGNEE_IDS:assignee||"",SCOPE_TYPE:link.type,SCOPE_ID:link.id,SCENE_UID:link.scene,ITEM_ID:link.item,PERSON_ID:link.person,DUE_DATE:"",DUE_NOTE:"",MANUAL_ORDER:production.tasks.length+1,NOTES:""};
  var item=t.ITEM_ID&&tmIx.items[t.ITEM_ID];
  tmLinkDraft=item?{type:item.TYPE,id:t.ITEM_ID}:t.PERSON_ID&&tmPerson(t.PERSON_ID)?{type:"Person",id:t.PERSON_ID}:{type:"",id:""};
  var h='<h2>'+(existing?'Task':'New task')+'</h2><div class="tm-modal-sub" id="taskLinkNow"></div>';
  h+='<div class="tm-field"><label>Status</label>'+tmStatusButtons(tmStatus(t.STATUS_COLOR),"taskStatus")+'</div><div class="tm-form-grid">';
  h+='<div class="tm-field full"><label>Task</label><input class="tm-input" id="taskTitle" value="'+tmAttr(t.TITLE||"")+'" placeholder="'+tmAttr(link.title?'e.g. Send contract to '+link.title:'What needs doing')+'" onkeydown="if(event.key===\'Enter\')document.getElementById(\'taskSaveBtn\').click()"></div>';
  h+='<div class="tm-field"><label>Assigned to</label>'+tmPeopleOptions(tmGroupKey(t))+'</div>';
  h+='<div class="tm-field"><label>Due</label><input class="tm-input" id="taskDue" type="date" value="'+tmAttr(String(t.DUE_DATE||"").slice(0,10))+'"></div>';
  // link picker
  h+='<div class="tm-field full tm-linkbox"><label>Linked record</label><div class="tm-pair"><select class="tm-input" id="taskLinkType" style="max-width:160px" onchange="tmLinkTypeChanged()"><option value="">— none —</option>'+TM_LINK_TYPES.map(function(v){return'<option'+(tmLinkDraft.type===v?' selected':'')+'>'+v+'</option>'}).join("")+'</select><input class="tm-input" id="taskLinkSearch" placeholder="Search…" oninput="tmRenderLinkList()"></div><div class="tm-picklist" id="taskLinkList"></div></div>';
  h+='<div class="tm-field full"><label>For sequence (optional)</label><select class="tm-input" id="taskScene" onchange="tmRenderLinkNow()"><option value="">— none —</option>'+scenes.slice().sort(function(a,b){return seqNum(a)-seqNum(b)}).map(function(s){return'<option value="'+tmAttr(s.uid)+'"'+(t.SCENE_UID===s.uid?' selected':'')+'>'+esc(s.seqLabel||s.seq)+' — '+esc(s.title)+(s.shootDay?' · '+esc(tmFmtDate(s.shootDay)):'')+'</option>'}).join("")+'</select></div>';
  h+='<div class="tm-field"><label>Type</label><input class="tm-input" id="taskType" value="'+tmAttr(t.TASK_TYPE||"General")+'"></div>';
  h+='<div class="tm-field"><label>Due note</label><input class="tm-input" id="taskDueNote" value="'+tmAttr(t.DUE_NOTE||"")+'" placeholder="e.g. before Sep 21 shoot"></div>';
  h+='<div class="tm-field full"><label>Notes</label><textarea class="tm-textarea" id="taskNotes">'+esc(t.NOTES||"")+'</textarea></div>';
  h+='<div class="tm-field"><label class="tm-toggle"><input id="taskDone" type="checkbox" '+(tmBool(t.DONE)?'checked':'')+'> Done</label></div></div>';
  h+='<div class="tm-actions">'+(existing?'<button class="mbtn ghost tm-danger" onclick="deleteTaskEditor(\''+tmAttr(t.TASK_ID)+'\')">Delete</button>':'')+'<span class="tm-spacer"></span><button class="mbtn ghost" onclick="tmClose()">Cancel</button><button class="mbtn gold" id="taskSaveBtn" onclick="saveTaskEditor(\''+tmAttr(t.TASK_ID||"")+'\')">Save</button></div>';
  tmModal(h);tmRenderLinkList();tmRenderLinkNow();
  setTimeout(function(){var el=document.getElementById("taskTitle");if(el&&!existing)el.focus()},60);
}
function saveTaskEditor(id){
  var current=id?tmById(production.tasks,"TASK_ID",id):{};
  var itemId=tmLinkDraft.type&&tmLinkDraft.type!=="Person"?tmLinkDraft.id:"",personId=tmLinkDraft.type==="Person"?tmLinkDraft.id:"",sceneId=tmVal("taskScene");
  var scopeType=itemId?"Item":personId?"Person":sceneId?"Scene":"Project",scopeId=itemId||personId||sceneId||"HAIRPIN";
  var type=tmVal("taskType")||"General";
  if(!id&&(type==="General"||type==="Scene")&&itemId&&tmIx.items[itemId])type=tmIx.items[itemId].TYPE;
  var record=Object.assign({},current,{TASK_ID:id,TITLE:tmVal("taskTitle"),STATUS_COLOR:tmVal("taskStatus"),DONE:tmChecked("taskDone"),TASK_TYPE:type,ASSIGNEE_IDS:tmVal("taskAssignee"),SCOPE_TYPE:scopeType,SCOPE_ID:scopeId,SCENE_UID:sceneId,ITEM_ID:itemId,PERSON_ID:personId,DUE_DATE:tmVal("taskDue"),DUE_NOTE:tmVal("taskDueNote"),MANUAL_ORDER:current.MANUAL_ORDER||production.tasks.length+1,NOTES:tmVal("taskNotes")});
  if(record.DONE&&!id)record.STATUS_COLOR="Green";
  if(!record.TITLE){toast("Task needs a title","err");return}
  tmClose();tmSaveTask(record,renderTaskBody);
}
function deleteTaskEditor(id){
  if(!confirm("Delete this task?"))return;
  tmClose();tmOptimisticDelete("task",id,"deleteTask",renderTaskBody);
}

updateToday();setInterval(updateToday,60000);
