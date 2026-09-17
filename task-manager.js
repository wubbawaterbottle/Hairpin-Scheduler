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
var tmLoaded=false,tmLoading=false,tmView="todo",tmQuery="",tmDrag=null;
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
    production=data;["people","items","requirements","staffing","tasks","notes"].forEach(function(k){production[k]=production[k]||[]});
    tmIndex();tmLoaded=true;renderTaskManager();if(force)tmSaveState("saved","Synced");return true;
  });
}
/* Called by the scheduler when the sheet's revision changes under us. Refreshes
   quietly unless Mr. John is mid-edit in a cell. */
function tmOnSheetRefresh(){
  if(!tmLoaded||!canEdit()||tmPending>0)return;
  var page=document.getElementById("taskManagerPage");if(!page||page.hidden)return;
  var a=document.activeElement;if(a&&page.contains(a)&&(a.isContentEditable||/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)))return;
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
function tmSave(payload){
  tmPending++;tmSaveState("saving",tmChainLabel||"Saving…");
  return apiWrite(payload).then(function(r){
    tmPending--;
    if(!r||r.error){tmSaveState("error","Save failed: "+(r&&r.error||"no response"));toast("Save failed: "+(r&&r.error||"no response"),"err");return r||{error:"no response"}}
    if(!tmPending)tmSaveState("saved");
    return r;
  });
}
function tmSaveTask(record){return tmSave({action:"saveTask",record:record}).then(function(r){if(r&&!r.error)tmMerge(production.tasks,"TASK_ID",r.record||record);return r})}
function tmSaveItem(record){return tmSave({action:"saveItem",record:record}).then(function(r){if(r&&!r.error)tmMerge(production.items,"ITEM_ID",r.record||record);return r})}
function tmSavePerson(record){return tmSave({action:"savePerson",record:record}).then(function(r){if(r&&!r.error)tmMerge(production.people,"PERSON_ID",r.record||record);return r})}
function tmSaveStaffing(record){return tmSave({action:"saveStaffing",record:record}).then(function(r){if(r&&!r.error)tmMerge(production.staffing,"STAFFING_ID",r.record||record);return r})}
function tmSaveRequirement(record){return tmSave({action:"saveRequirement",record:record}).then(function(r){if(r&&!r.error)tmMerge(production.requirements,"REQUIREMENT_ID",r.record||record);return r})}
function tmSaveNote(record){return tmSave({action:"saveNote",record:record}).then(function(r){if(r&&!r.error)tmMerge(production.notes,"NOTE_ID",r.record||record);return r})}
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
  return save(record).then(function(r){if(r&&!r.error)renderTaskBody();return r});
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
  var tabs=[["todo","To-do"],["sequences","Sequences"],["people","People & Contracts"]];
  var h='<div class="tm-shell"><div class="tm-toolbar"><div class="tm-subtabs">';
  for(var i=0;i<tabs.length;i++)h+='<button class="tm-subtab '+(tmView===tabs[i][0]?"active":"")+'" onclick="tmSetView(\''+tabs[i][0]+'\')">'+tabs[i][1]+'</button>';
  h+='</div><span id="tmSaveState" class="tm-save"></span><input class="tm-search" value="'+tmAttr(tmQuery)+'" placeholder="Search" oninput="tmSetQuery(this.value)">';
  h+='<button class="hbtn" onclick="loadProduction(true)" title="Re-download from the sheet">&#8635; Sync</button></div><div id="tmBody"></div></div>';
  document.getElementById("taskManagerPage").innerHTML=h;renderTaskBody();
}
function renderTaskBody(){
  var mount=document.getElementById("tmBody");if(!mount)return;
  var y=mount.scrollTop;
  if(tmView==="sequences")mount.innerHTML=tmRenderSequences();
  else if(tmView==="people")mount.innerHTML=tmRenderPeople();
  else mount.innerHTML=tmRenderTodo();
  mount.scrollTop=y;
}

// ── chips ────────────────────────────────────────────────────
function tmItemChip(item,req){
  if(!item)return'<span class="tm-chip st-red" title="Missing item record">'+esc(req?req.SCENE_WORDING||req.ITEM_ID:"?")+'</span>';
  var st=req?tmInherited(req):tmStatus(item.STATUS);
  var tip=item.NAME+(req&&req.SCENE_WORDING&&req.SCENE_WORDING!==item.NAME?' — in this scene: '+req.SCENE_WORDING:'')+(req&&req.NOTES?' — '+req.NOTES:'')+(item.NOTES?' — '+item.NOTES:'');
  return'<span class="tm-chip st-'+st.toLowerCase()+'" draggable="true" ondragstart="tmStartDrag(event,\'Item\',\''+tmAttr(item.ITEM_ID)+'\')" onclick="event.stopPropagation();openItemEditor(\''+tmAttr(item.ITEM_ID)+'\')" title="'+tmAttr(tip)+'"><i class="tm-dot '+st.toLowerCase()+'"></i>'+esc(item.NAME)+'</span>';
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
function tmStaffChip(st){
  var ids=tmSplitIds(st.ASSIGNED_PERSON_IDS),names=ids.map(tmPersonName);
  var p=ids.length===1?tmPerson(ids[0]):null;
  var color=ids.length?(p?tmPersonState(p):"yellow"):"red";
  var label=st.ROLE+(names.length?' · '+names.join(", "):' · unassigned');
  var tip=st.DEPARTMENT+' — need '+tmNum(st.NEEDED,0)+', confirmed '+tmNum(st.CONFIRMED_COUNT,0)+(st.NOTES?' — '+st.NOTES:'');
  return'<span class="tm-chip st-'+color+'" onclick="event.stopPropagation();openStaffingEditor(\''+tmAttr(st.STAFFING_ID)+'\',\''+tmAttr(st.SCENE_UID)+'\')" title="'+tmAttr(tip)+'"><i class="tm-dot '+color+'"></i>'+esc(label)+'</span>';
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
    tmSaveTask(Object.assign({},t,{ASSIGNEE_IDS:personId,MANUAL_ORDER:last+1})).then(function(r){if(r&&!r.error)renderTaskBody()});
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
  tmSaveTask(Object.assign({},t,{ASSIGNEE_IDS:personId,MANUAL_ORDER:newOrder})).then(function(r){if(r&&!r.error)renderTaskBody()});
}

// ── SEQUENCES ────────────────────────────────────────────────
function tmReqsOfType(uid,types){return (tmIx.reqsByScene[uid]||[]).filter(function(r){var it=tmIx.items[r.ITEM_ID];var ty=it?it.TYPE:r.ITEM_TYPE;return types.indexOf(ty)>=0})}
function tmChipsFor(uid,types){var rs=tmReqsOfType(uid,types);if(!rs.length)return'<span class="tm-muted">—</span>';return rs.map(function(r){return tmItemChip(tmIx.items[r.ITEM_ID],r)}).join("")}
function tmRenderSequences(){
  var rows=scenes.filter(function(s){
    if(!tmQuery)return true;
    var text=[s.seqLabel,s.title,s.shootDay].concat((tmIx.reqsByScene[s.uid]||[]).map(function(r){var it=tmIx.items[r.ITEM_ID];return it?it.NAME:r.SCENE_WORDING})).concat((tmIx.staffByScene[s.uid]||[]).map(function(st){return st.ROLE+" "+tmSplitIds(st.ASSIGNED_PERSON_IDS).map(tmPersonName).join(" ")})).join(" ");
    return tmMatch(text);
  }).sort(function(a,b){return seqNum(a)-seqNum(b)});
  var h='<div class="tm-muted tm-hint">Click a chip to edit its one master record — every sequence that uses it updates. Click a sequence for its scene-only notes.</div>';
  h+='<div class="tm-table-wrap tm-sheet"><table class="tm-table tm-seq"><thead><tr><th class="tm-sticky">SEQ</th><th>Day</th><th>Location</th><th>Cast</th><th>Crew</th><th>Props &amp; Vehicles</th><th>HMU &amp; Wardrobe</th><th>VFX &amp; Stunts</th><th>Tasks</th></tr></thead><tbody>';
  rows.forEach(function(s){
    var staff=tmIx.staffByScene[s.uid]||[],cast=staff.filter(function(x){return x.DEPARTMENT==="Cast"}),crew=staff.filter(function(x){return x.DEPARTMENT!=="Cast"});
    var tasks=(tmIx.tasksByScene[s.uid]||[]).filter(function(t){return !tmBool(t.DONE)});
    var itemTasks=[];(tmIx.reqsByScene[s.uid]||[]).forEach(function(r){(tmIx.tasksByItem[r.ITEM_ID]||[]).forEach(function(t){if(!tmBool(t.DONE)&&itemTasks.indexOf(t)<0&&tasks.indexOf(t)<0)itemTasks.push(t)})});
    h+='<tr class="tm-row" onclick="openSceneProduction(\''+tmAttr(s.uid)+'\')">';
    h+='<td class="tm-sticky tm-seqcell"><b>'+esc(s.seqLabel||s.seq)+'</b><div>'+esc(s.title)+'</div></td>';
    h+='<td class="tm-daycell">'+(s.shootDay?'<span class="'+tmDueClass(s.shootDay)+'">'+esc(tmFmtDate(s.shootDay))+'</span>':'<span class="tm-muted">unscheduled</span>')+'</td>';
    h+='<td>'+tmChipsFor(s.uid,["Location"])+'</td>';
    h+='<td>'+(cast.length?cast.map(tmStaffChip).join(""):'<span class="tm-muted">—</span>')+'</td>';
    h+='<td>'+crew.map(tmStaffChip).join("")+'<button class="tm-chip-add" title="Add a crew need" onclick="event.stopPropagation();openStaffingEditor(null,\''+tmAttr(s.uid)+'\')">+</button></td>';
    h+='<td>'+tmChipsFor(s.uid,["Prop","Vehicle"])+'</td>';
    h+='<td>'+tmChipsFor(s.uid,["Hair & Makeup","Wardrobe"])+'</td>';
    h+='<td>'+tmChipsFor(s.uid,["VFX / SFX","Stunt"])+'</td>';
    h+='<td class="tm-taskcell">'+tasks.map(function(t){return tmMiniTask(t,false)}).join("")+itemTasks.map(function(t){return tmMiniTask(t,true)}).join("")+'<button class="tm-chip-add" title="New task for this sequence" onclick="event.stopPropagation();openTaskEditor(null,{type:\'Scene\',id:\''+tmAttr(s.uid)+'\'})">+</button></td></tr>';
  });
  h+='</tbody></table></div>';
  if(!rows.length)h='<div class="tm-empty">No sequences match.</div>';
  return h;
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
  h+='<div class="tm-table-wrap tm-sheet"><table class="tm-table tm-people"><thead><tr><th class="tm-sticky">Name</th><th>Group</th><th>Role / character</th><th>Attachment</th><th>Contract</th><th>Ver.</th><th>Phone</th><th>Email</th><th>Scenes</th><th>Availability</th><th>Notes</th><th class="tm-col-more"></th></tr></thead><tbody>';
  rows.forEach(function(p){
    var id=p.PERSON_ID,st=tmPersonState(p),sc=tmIx.staffByPerson[id]||[],active=tmActive(p);
    var seqs=[];sc.forEach(function(x){var s=tmScene(x.SCENE_UID);if(seqs.indexOf(s.seqLabel)<0)seqs.push(s.seqLabel)});
    h+='<tr class="tm-row'+(active?'':' removed')+'" data-person="'+tmAttr(id)+'">';
    h+='<td class="tm-sticky tm-namecell"><span class="tm-chip st-'+st+'" draggable="true" ondragstart="tmStartDrag(event,\'Person\',\''+tmAttr(id)+'\')" title="Open"><i class="tm-dot '+st+'"></i><span class="tm-edit tm-inline" contenteditable="true" spellcheck="false" onclick="event.stopPropagation()" onkeydown="tmEditKey(event,this)" onblur="tmEditText(this,\'person\',\''+tmAttr(id)+'\',\'NAME\')">'+esc(p.NAME)+'</span></span>'+(active?'':'<div class="tm-faint">removed</div>')+'</td>';
    h+='<td><select class="tm-mini-select" onchange="tmPatch(\'person\',\''+tmAttr(id)+'\',\'GROUPS\',this.value)">'+tmGroupOptions(p.GROUPS)+'</select></td>';
    h+='<td><div class="tm-edit" contenteditable="true" spellcheck="false" onkeydown="tmEditKey(event,this)" onblur="tmEditText(this,\'person\',\''+tmAttr(id)+'\',\'ROLES_CHARACTERS\')">'+esc(p.ROLES_CHARACTERS||"")+'</div></td>';
    h+='<td><select class="tm-mini-select" onchange="tmPatch(\'person\',\''+tmAttr(id)+'\',\'PROJECT_STATUS\',this.value)">'+TM_PROJECT.map(function(v){return'<option'+(p.PROJECT_STATUS===v?' selected':'')+'>'+v+'</option>'}).join("")+'</select></td>';
    h+='<td><select class="tm-mini-select ct-'+st+'" onchange="tmPatch(\'person\',\''+tmAttr(id)+'\',\'CONTRACT_STATUS\',this.value)">'+TM_CONTRACT.map(function(v){return'<option value="'+v+'"'+((p.CONTRACT_STATUS||"")===v?' selected':'')+'>'+(v||"—")+'</option>'}).join("")+'</select></td>';
    h+='<td><div class="tm-edit tm-narrow" contenteditable="true" spellcheck="false" onkeydown="tmEditKey(event,this)" onblur="tmEditText(this,\'person\',\''+tmAttr(id)+'\',\'CONTRACT_VERSION\')">'+esc(p.CONTRACT_VERSION||"")+'</div></td>';
    h+='<td><div class="tm-edit tm-narrow" contenteditable="true" spellcheck="false" onkeydown="tmEditKey(event,this)" onblur="tmEditText(this,\'person\',\''+tmAttr(id)+'\',\'PHONE\')">'+esc(p.PHONE||"")+'</div></td>';
    h+='<td><div class="tm-edit" contenteditable="true" spellcheck="false" onkeydown="tmEditKey(event,this)" onblur="tmEditText(this,\'person\',\''+tmAttr(id)+'\',\'EMAIL\')">'+esc(p.EMAIL||"")+'</div></td>';
    h+='<td class="tm-muted" title="'+tmAttr(seqs.join(", "))+'">'+(seqs.length?seqs.length+' <span class="tm-faint">'+esc(seqs.slice(0,4).join(", "))+(seqs.length>4?'…':'')+'</span>':'—')+'</td>';
    h+='<td class="tm-wide"><div class="tm-edit" contenteditable="true" spellcheck="false" onkeydown="tmEditKey(event,this)" onblur="tmEditText(this,\'person\',\''+tmAttr(id)+'\',\'AVAILABILITY\')">'+esc(p.AVAILABILITY||"")+'</div></td>';
    h+='<td class="tm-wide"><div class="tm-edit" contenteditable="true" spellcheck="false" onkeydown="tmEditKey(event,this)" onblur="tmEditText(this,\'person\',\''+tmAttr(id)+'\',\'NOTES\')">'+esc(p.NOTES||"")+'</div></td>';
    h+='<td class="tm-col-more"><button class="tm-more" title="Open · replace · remove" onclick="openPersonEditor(\''+tmAttr(id)+'\')">⋯</button></td></tr>';
  });
  h+='</tbody></table></div>';
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
function tmClose(){var m=document.getElementById("tmModalMount");if(m)m.parentNode.removeChild(m)}
function tmModal(html){tmClose();var d=document.createElement("div");d.id="tmModalMount";d.innerHTML='<div class="tm-modal-bg" onclick="tmClose()"><div class="tm-modal" onclick="event.stopPropagation()">'+html+'</div></div>';document.body.appendChild(d)}
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
  reqs.forEach(function(r){var s=tmScene(r.SCENE_UID);h+='<div class="tm-scene-link"><b>'+esc(s.seqLabel||s.seq)+' — '+esc(s.title)+'</b>'+(s.shootDay?' <span class="tm-muted">'+esc(tmFmtDate(s.shootDay))+'</span>':'')+'<div class="tm-pair" style="margin-top:5px"><select class="tm-mini-select" id="req-'+tmAttr(r.REQUIREMENT_ID)+'"><option value="">Inherit</option>'+TM_STATUSES.map(function(v){return'<option'+(r.STATUS_OVERRIDE===v?' selected':'')+'>'+v+'</option>'}).join("")+'</select><input class="tm-input" id="reqn-'+tmAttr(r.REQUIREMENT_ID)+'" value="'+tmAttr(r.NOTES||"")+'" placeholder="'+tmAttr(r.SCENE_WORDING||"Scene-specific note")+'"></div></div>'});
  var linked=(tmIx.tasksByItem[id]||[]);
  h+='</div>'+(linked.length?'<div class="tm-field"><label>Tasks</label>'+linked.map(function(t){return tmMiniTask(t,false)}).join("")+'</div>':'');
  h+='<div class="tm-actions"><button class="mbtn ghost" onclick="tmClose();openTaskEditor(null,{type:\'Item\',id:\''+tmAttr(id)+'\'})">+ Task</button><span class="tm-spacer"></span><button class="mbtn ghost" onclick="tmClose()">Cancel</button><button class="mbtn gold" onclick="saveItemEditor(\''+tmAttr(id)+'\')">Save</button></div>';tmModal(h);
}
function saveItemEditor(id){
  var item=tmIx.items[id];if(!item)return;
  var record=Object.assign({},item,{NAME:tmVal("itemName")||item.NAME,STATUS:tmVal("itemStatus"),CONTRACT_STATUS:tmVal("itemContract"),OWNER:tmVal("itemOwner"),QUANTITY_NEEDED:tmVal("itemNeeded"),QUANTITY_READY:tmVal("itemReady"),LINK:tmVal("itemLink"),NOTES:tmVal("itemNotes")});
  if(item.TYPE==="Location")record.ADDRESS=tmVal("itemAddress");
  var reqJobs=(tmIx.reqsByItem[id]||[]).filter(function(r){return String(r.STATUS_OVERRIDE||"")!==tmVal("req-"+r.REQUIREMENT_ID)||String(r.NOTES||"")!==tmVal("reqn-"+r.REQUIREMENT_ID)}).map(function(r){return Object.assign({},r,{STATUS_OVERRIDE:tmVal("req-"+r.REQUIREMENT_ID),NOTES:tmVal("reqn-"+r.REQUIREMENT_ID)})});
  tmClose();
  tmSaveItem(record).then(function(r){
    if(r&&r.error)return;
    renderTaskBody();
    // scene overrides are separate rows; write only the ones that changed, in sequence
    var chain=Promise.resolve();
    reqJobs.forEach(function(rec){chain=chain.then(function(){return tmSaveRequirement(rec)})});
    chain.then(function(){if(reqJobs.length)renderTaskBody()});
  });
}

/** Scene panel: what this one sequence needs, who is in it, and its scene-only notes. */
function openSceneProduction(uid){
  var s=tmScene(uid),reqs=tmIx.reqsByScene[uid]||[],staff=tmIx.staffByScene[uid]||[],notes=production.notes.filter(function(n){return n.SCOPE_TYPE==="Scene"&&n.SCOPE_ID===uid&&!tmBool(n.RESOLVED)}),tasks=tmIx.tasksByScene[uid]||[];
  var h='<h2>'+esc(s.seqLabel||s.seq)+' — '+esc(s.title)+'</h2><div class="tm-modal-sub">'+(s.shootDay?'Shoots '+esc(tmFmtDate(s.shootDay)):'Unscheduled')+' · '+reqs.length+' requirements · '+staff.length+' roles</div>';
  h+='<div class="tm-field"><label>Requirements — click to edit the master record</label><div class="tm-chips">'+(reqs.length?reqs.map(function(r){return tmItemChip(tmIx.items[r.ITEM_ID],r)}).join(""):'<span class="tm-muted">None recorded</span>')+'</div></div>';
  h+='<div class="tm-field"><label>Cast &amp; crew</label><div class="tm-chips">'+staff.map(tmStaffChip).join("")+'<button class="tm-chip-add" onclick="openStaffingEditor(null,\''+tmAttr(uid)+'\')">+ need</button></div></div>';
  h+='<div class="tm-field"><label>Tasks</label><div class="tm-chips">'+tasks.map(function(t){return tmMiniTask(t,false)}).join("")+'<button class="tm-chip-add" onclick="tmClose();openTaskEditor(null,{type:\'Scene\',id:\''+tmAttr(uid)+'\'})">+ task</button></div></div>';
  h+='<div class="tm-field"><label>Scene-only notes</label>'+notes.map(function(n){return'<div class="tm-scene-link"><b>'+esc(n.CATEGORY||"Note")+'</b> '+esc(n.BODY)+' <button class="tm-more" title="Resolve" onclick="tmResolveNote(\''+tmAttr(n.NOTE_ID)+'\',\''+tmAttr(uid)+'\')">✓</button></div>'}).join("");
  h+='<div class="tm-pair" style="margin-top:6px"><select class="tm-input" id="sceneNoteCategory" style="max-width:130px"><option>Logistics</option><option>Creative</option><option>Safety</option><option>Schedule</option><option>General</option></select><input class="tm-input" id="sceneNoteBody" placeholder="Add a note that belongs only to this scene" onkeydown="if(event.key===\'Enter\')saveSceneNote(\''+tmAttr(uid)+'\')"><button class="hbtn gold" onclick="saveSceneNote(\''+tmAttr(uid)+'\')">Add</button></div></div>';
  h+='<div class="tm-actions"><button class="mbtn ghost" onclick="tmClose()">Close</button></div>';tmModal(h);
}
function saveSceneNote(uid){var body=tmVal("sceneNoteBody");if(!body){toast("Write the note first","err");return}tmSaveNote({NOTE_ID:"",SCOPE_TYPE:"Scene",SCOPE_ID:uid,CATEGORY:tmVal("sceneNoteCategory")||"General",BODY:body,PINNED:false,RESOLVED:false,SOURCE:"Task Manager"}).then(function(r){if(r&&!r.error)openSceneProduction(uid)})}
function tmResolveNote(id,uid){var n=tmById(production.notes,"NOTE_ID",id);if(!n)return;tmSaveNote(Object.assign({},n,{RESOLVED:true})).then(function(r){if(r&&!r.error)openSceneProduction(uid)})}

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
  tmSaveStaffing(record).then(function(r){if(r&&r.error)return;renderTaskBody();openSceneProduction(uid)});
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
  tmClose();tmSavePerson(record).then(function(r){if(r&&!r.error){renderTaskBody();if(!id)toast(record.NAME+" added","ok")}});
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
  tmSavePerson(Object.assign({},p,{ACTIVE:true,PROJECT_STATUS:p.PROJECT_STATUS==="Released"?"Listed":p.PROJECT_STATUS})).then(function(r){if(r&&!r.error){renderTaskBody();toast(p.NAME+" restored","ok")}});
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
  tmClose();tmSaveTask(record).then(function(r){if(r&&!r.error)renderTaskBody()});
}
function deleteTaskEditor(id){
  if(!confirm("Delete this task?"))return;
  tmClose();tmSave({action:"deleteTask",id:id}).then(function(r){if(r&&!r.error){tmRemove(production.tasks,"TASK_ID",id);renderTaskBody()}});
}

updateToday();setInterval(updateToday,60000);
