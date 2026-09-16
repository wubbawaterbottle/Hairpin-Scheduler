/* Project Hairpin production manager. The public scheduler remains unchanged;
   this private page loads only after the existing edit code is verified. */
var production={people:[],items:[],requirements:[],staffing:[],tasks:[],notes:[]};
var tmLoaded=false,tmView="attention",tmQuery="",tmType="All",tmDrag=null;

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
function tmById(list,key,id){for(var i=0;i<list.length;i++)if(String(list[i][key])===String(id))return list[i];return null}
function tmScene(uid){return getScene(uid)||{uid:uid,seqLabel:uid,title:"Unknown scene",shootDay:""}}
function tmStatus(value){value=String(value||"Red");return /^(Red|Orange|Yellow|Green)$/.test(value)?value:"Red"}
function tmStatusRank(value){return {Red:0,Orange:1,Yellow:2,Green:3}[tmStatus(value)]}
function tmInherited(req){var item=tmById(production.items,"ITEM_ID",req.ITEM_ID);return tmStatus(req.STATUS_OVERRIDE||item&&item.STATUS)}
function tmDaysUntil(date){if(!date)return null;var now=new Date(),today=new Date(now.getFullYear(),now.getMonth(),now.getDate());var due=new Date(String(date).slice(0,10)+"T12:00:00");return Math.ceil((due-today)/86400000)}
function tmUrgency(date,isLocation){
  var d=tmDaysUntil(date);if(d===null)return {label:"No date",cls:"gold",score:99};
  var threshold=isLocation?21:14,very=isLocation?14:7;
  if(d<0)return {label:"Overdue "+Math.abs(d)+"d",cls:"red",score:-1000+d};
  if(d<=very)return {label:d+"d · very urgent",cls:"red",score:d};
  if(d<=threshold)return {label:d+"d · urgent",cls:"orange",score:d};
  return {label:d+"d",cls:"gold",score:d};
}
function tmRelatedDate(item){
  var dates=production.requirements.filter(function(r){return r.ITEM_ID===item.ITEM_ID}).map(function(r){return tmScene(r.SCENE_UID).shootDay}).filter(Boolean).sort();
  return dates[0]||"";
}
function tmLoadError(msg){document.getElementById("taskManagerPage").innerHTML='<div class="tm-lock"><h2>Task Manager</h2><p>'+esc(msg)+'</p><button class="mbtn gold" onclick="promptEditKey(function(){loadProduction(true)})">Unlock</button></div>'}
function syncProductionLock(){
  if(canEdit())return;
  tmLoaded=false;
  production={people:[],items:[],requirements:[],staffing:[],tasks:[],notes:[]};
  var page=document.getElementById("taskManagerPage");
  if(page&&!page.hidden)renderTaskManager();
}
function loadProduction(force){
  if(!canEdit()){tmLoadError("Unlock editing to view private production details, contracts, assignments and notes.");return Promise.resolve(false)}
  if(tmLoaded&&!force){renderTaskManager();return Promise.resolve(true)}
  document.getElementById("taskManagerPage").innerHTML='<div class="tm-lock"><h2>Loading production data…</h2></div>';
  return api("action=getProduction&key="+encodeURIComponent(editKey)).then(function(data){
    if(!data||data.error){if(data&&data.error==="locked"){editKey="";applyLock()}tmLoadError(data&&data.message||data&&data.error||"Could not load production data.");return false}
    production=data;production.people=production.people||[];production.items=production.items||[];production.requirements=production.requirements||[];production.staffing=production.staffing||[];production.tasks=production.tasks||[];production.notes=production.notes||[];
    tmLoaded=true;renderTaskManager();return true;
  });
}
function tmSetView(view){tmView=view;renderTaskManager()}
function tmSetQuery(value){tmQuery=value;renderTaskBody()}
function tmSetType(value){tmType=value;renderTaskBody()}
function tmCardStatus(status){status=tmStatus(status);return '<span class="tm-pill"><span class="tm-dot '+status.toLowerCase()+'"></span>'+status+'</span>'}
function tmMatch(text){return !tmQuery||String(text||"").toLowerCase().indexOf(tmQuery.toLowerCase())>=0}
function tmSummary(){
  var open=production.tasks.filter(function(t){return !t.DONE}).length;
  var red=production.items.filter(function(i){return tmStatus(i.STATUS)==="Red"}).length;
  var contracts=production.people.filter(function(p){return p.CONTRACT_STATUS!=="Signed"&&p.CONTRACT_STATUS!=="Not Required"}).length;
  var gaps=production.staffing.reduce(function(sum,s){return sum+Math.max(0,Number(s.GAP)||0)},0);
  return '<div class="tm-summary"><div class="tm-stat"><b>'+open+'</b><span>Open tasks</span></div><div class="tm-stat"><b>'+red+'</b><span>Zero-progress items</span></div><div class="tm-stat"><b>'+contracts+'</b><span>Contracts unresolved</span></div><div class="tm-stat"><b>'+gaps+'</b><span>Scene staffing gaps</span></div></div>';
}
function renderTaskManager(){
  updateToday();
  if(!canEdit()){tmLoadError("Unlock editing to view private production details, contracts, assignments and notes.");return}
  if(!tmLoaded){loadProduction();return}
  var tabs=[["attention","Needs Attention"],["tasks","Tasks"],["scenes","Scenes"],["items","Items"],["people","People"],["data","Data"]];
  var h='<div class="tm-shell"><div class="tm-toolbar"><h2>Production Task Manager</h2><input class="tm-search" value="'+esc(tmQuery)+'" placeholder="Search everything" oninput="tmSetQuery(this.value)"><button class="hbtn gold" onclick="openTaskEditor(null)">+ Task</button><button class="hbtn" onclick="loadProduction(true)">&#8635; Sync</button></div>';
  h+='<div class="tm-subtabs">';for(var i=0;i<tabs.length;i++)h+='<button class="tm-subtab '+(tmView===tabs[i][0]?"active":"")+'" onclick="tmSetView(\''+tabs[i][0]+'\')">'+tabs[i][1]+'</button>';h+='</div>';
  h+=tmSummary()+'<div id="tmBody"></div></div>';
  document.getElementById("taskManagerPage").innerHTML=h;renderTaskBody();
}
function renderTaskBody(){
  var mount=document.getElementById("tmBody");if(!mount)return;
  if(tmView==="tasks")mount.innerHTML=tmRenderTasks();
  else if(tmView==="scenes")mount.innerHTML=tmRenderScenes();
  else if(tmView==="items")mount.innerHTML=tmRenderItems();
  else if(tmView==="people")mount.innerHTML=tmRenderPeople();
  else if(tmView==="data")mount.innerHTML=tmRenderData();
  else mount.innerHTML=tmRenderAttention();
}
function tmRenderAttention(){
  var entries=[];
  production.tasks.filter(function(t){return !t.DONE}).forEach(function(t){var u=tmUrgency(t.DUE_DATE,t.TASK_TYPE==="Locations");entries.push({score:u.score-30,html:tmTaskCard(t,u)})});
  production.items.forEach(function(item){var status=tmStatus(item.STATUS);if(status!=="Green"){var u=tmUrgency(tmRelatedDate(item),item.TYPE==="Location");entries.push({score:u.score+tmStatusRank(status)*5,html:tmItemCard(item,u)})}});
  entries.sort(function(a,b){return a.score-b.score});
  var shown=entries.filter(function(e){return tmMatch(e.html)}).slice(0,100);
  return shown.length?'<div class="tm-grid">'+shown.map(function(e){return e.html}).join("")+'</div>':'<div class="tm-empty">Nothing needs attention in this filter.</div>';
}
function tmTypes(){var set={All:1};production.items.forEach(function(i){set[i.TYPE]=1});return Object.keys(set).sort()}
function tmRenderItems(){
  var types=tmTypes(),items=production.items.filter(function(i){return (tmType==="All"||i.TYPE===tmType)&&tmMatch([i.NAME,i.TYPE,i.ITEM_ID,i.NOTES,i.ALIASES].join(" "))});
  items.sort(function(a,b){return tmStatusRank(a.STATUS)-tmStatusRank(b.STATUS)||String(a.TYPE).localeCompare(String(b.TYPE))||String(a.NAME).localeCompare(String(b.NAME))});
  var h='<div class="tm-toolbar"><select class="tm-select" onchange="tmSetType(this.value)">';types.forEach(function(t){h+='<option'+(t===tmType?' selected':'')+'>'+esc(t)+'</option>'});h+='</select><span class="tm-meta">'+items.length+' items · drag any card into Tasks</span></div>';
  return h+(items.length?'<div class="tm-grid">'+items.map(function(i){return tmItemCard(i,null,true)}).join("")+'</div>':'<div class="tm-empty">No matching items.</div>');
}
function tmItemCard(item,urgency,draggable){
  var uses=production.requirements.filter(function(r){return r.ITEM_ID===item.ITEM_ID}).length;
  var u=urgency||tmUrgency(tmRelatedDate(item),item.TYPE==="Location");
  return '<div class="tm-card status-'+tmStatus(item.STATUS).toLowerCase()+'" '+(draggable?'draggable="true" ondragstart="tmStartDrag(\'Item\',\''+esc(item.ITEM_ID)+'\')"':'')+' onclick="openItemEditor(\''+esc(item.ITEM_ID)+'\')"><div class="tm-card-top"><div class="tm-card-title">'+esc(item.NAME)+'</div><span class="tm-urgent '+u.cls+'">'+esc(u.label)+'</span></div><div>'+tmCardStatus(item.STATUS)+'<span class="tm-pill">'+esc(item.TYPE)+'</span><span class="tm-pill">'+uses+' scene'+(uses===1?'':'s')+'</span></div><div class="tm-meta">'+esc(item.NOTES||item.ADDRESS||"No note yet")+'</div><div class="tm-id">'+esc(item.ITEM_ID)+'</div></div>';
}
function tmRenderTasks(){
  var tasks=production.tasks.filter(function(t){return tmMatch([t.TITLE,t.TASK_TYPE,t.NOTES,t.ASSIGNEE_IDS,t.SCOPE_ID].join(" "))});
  tasks.sort(function(a,b){return Number(a.DONE)-Number(b.DONE)||tmUrgency(a.DUE_DATE,a.TASK_TYPE==="Locations").score-tmUrgency(b.DUE_DATE,b.TASK_TYPE==="Locations").score||Number(a.MANUAL_ORDER)-Number(b.MANUAL_ORDER)});
  var h='<div class="tm-split"><div><div class="tm-drop" ondragover="tmDragOver(event)" ondragleave="this.classList.remove(\'dragover\')" ondrop="tmDropTask(event)">Drop an item, scene or person here to make a linked task.</div><div class="tm-meta">Open an Items, Scenes or People card and drag it here. The link stays connected to the sheet record.</div></div><div>';
  h+=tasks.length?tasks.map(function(t){return tmTaskCard(t)}).join(""):'<div class="tm-empty">No tasks yet.</div>';return h+'</div></div>';
}
function tmTaskCard(task,urgency){
  var u=urgency||tmUrgency(task.DUE_DATE,task.TASK_TYPE==="Locations");
  return '<div class="tm-card status-'+tmStatus(task.STATUS_COLOR).toLowerCase()+' tm-task" onclick="openTaskEditor(\''+esc(task.TASK_ID)+'\')"><input class="tm-check" type="checkbox" '+(task.DONE?'checked':'')+' onclick="event.stopPropagation();tmToggleTask(\''+esc(task.TASK_ID)+'\',this.checked)"><div><div class="tm-card-title">'+esc(task.TITLE)+'</div><div><span class="tm-pill">'+esc(task.TASK_TYPE||"General")+'</span>'+(task.SCOPE_TYPE&&task.SCOPE_TYPE!=="Project"?'<span class="tm-pill">'+esc(task.SCOPE_TYPE)+'</span>':'')+'</div><div class="tm-meta">'+esc(task.NOTES||task.ASSIGNEE_IDS||"No notes")+'</div></div><span class="tm-urgent '+u.cls+'">'+esc(u.label)+'</span></div>';
}
function tmRenderScenes(){
  var rows=scenes.filter(function(s){return tmMatch([s.seqLabel,s.title,s.shootDay,s.locations].join(" "))}).sort(function(a,b){return (a.shootDay||"9999").localeCompare(b.shootDay||"9999")||seqNum(a)-seqNum(b)});
  return rows.length?'<div class="tm-grid">'+rows.map(function(s){var reqs=production.requirements.filter(function(r){return r.SCENE_UID===s.uid});var unresolved=reqs.filter(function(r){return tmInherited(r)!=="Green"}).length;var gaps=production.staffing.filter(function(st){return st.SCENE_UID===s.uid}).reduce(function(n,st){return n+(Number(st.GAP)||0)},0);return '<div class="tm-card '+(unresolved?'status-orange':'status-green')+'" draggable="true" ondragstart="tmStartDrag(\'Scene\',\''+esc(s.uid)+'\')" onclick="openSceneProduction(\''+esc(s.uid)+'\')"><div class="tm-card-top"><div class="tm-card-title">'+esc(s.seqLabel||s.seq)+' — '+esc(s.title)+'</div><span class="tm-urgent '+tmUrgency(s.shootDay,false).cls+'">'+esc(s.shootDay||"Unscheduled")+'</span></div><div><span class="tm-pill">'+reqs.length+' requirements</span><span class="tm-pill">'+unresolved+' unresolved</span><span class="tm-pill">'+gaps+' staffing gaps</span></div></div>'}).join("")+'</div>':'<div class="tm-empty">No matching scenes.</div>';
}
function tmRenderPeople(){
  var rows=production.people.filter(function(p){return tmMatch([p.NAME,p.GROUPS,p.ROLES_CHARACTERS,p.PROJECT_STATUS,p.CONTRACT_STATUS,p.NOTES].join(" "))}).sort(function(a,b){return String(a.NAME).localeCompare(String(b.NAME))});
  return rows.length?'<div class="tm-grid">'+rows.map(function(p){var good=p.PROJECT_STATUS==="Formally Attached"&&(p.CONTRACT_STATUS==="Signed"||p.CONTRACT_STATUS==="Not Required");return '<div class="tm-card status-'+(good?'green':p.PROJECT_STATUS==="Candidate"?'red':'yellow')+'" draggable="true" ondragstart="tmStartDrag(\'Person\',\''+esc(p.PERSON_ID)+'\')" onclick="openPersonEditor(\''+esc(p.PERSON_ID)+'\')"><div class="tm-card-title">'+esc(p.NAME)+'</div><div><span class="tm-pill">'+esc(p.PROJECT_STATUS||"Listed")+'</span><span class="tm-pill">Contract: '+esc(p.CONTRACT_STATUS||"Unknown")+'</span></div><div class="tm-meta">'+esc(p.ROLES_CHARACTERS||p.GROUPS||"No role")+'</div></div>'}).join("")+'</div>':'<div class="tm-empty">No matching people.</div>';
}
function tmRenderData(){
  var rows=production.items.filter(function(i){return tmMatch([i.ITEM_ID,i.TYPE,i.NAME,i.STATUS,i.NOTES].join(" "))}).slice(0,500);
  return '<div class="tm-meta" style="margin-bottom:8px">Clean database view. Repeated scene appearances link to one Item ID.</div><div style="overflow:auto;max-height:65vh"><table class="tm-table"><thead><tr><th>Item ID</th><th>Type</th><th>Name</th><th>Status</th><th>Scenes</th><th>Note</th></tr></thead><tbody>'+rows.map(function(i){return '<tr onclick="openItemEditor(\''+esc(i.ITEM_ID)+'\')"><td>'+esc(i.ITEM_ID)+'</td><td>'+esc(i.TYPE)+'</td><td>'+esc(i.NAME)+'</td><td>'+esc(i.STATUS)+'</td><td>'+production.requirements.filter(function(r){return r.ITEM_ID===i.ITEM_ID}).length+'</td><td>'+esc(i.NOTES||"")+'</td></tr>'}).join("")+'</tbody></table></div>';
}
function tmStartDrag(type,id){tmDrag={type:type,id:id}}
function tmDragOver(e){e.preventDefault();e.currentTarget.classList.add("dragover")}
function tmDropTask(e){e.preventDefault();e.currentTarget.classList.remove("dragover");if(!tmDrag)return;openTaskEditor(null,tmDrag);tmDrag=null}
function tmStatusButtons(current,prefix){return '<div class="tm-statuses">'+["Red","Orange","Yellow","Green"].map(function(s){return '<button type="button" class="tm-status '+(current===s?'active':'')+'" data-status="'+s+'" onclick="tmChooseStatus(\''+prefix+'\',\''+s+'\')">'+s+'</button>'}).join("")+'</div><input type="hidden" id="'+prefix+'" value="'+esc(current)+'">'}
function tmChooseStatus(prefix,status){document.getElementById(prefix).value=status;var root=document.getElementById(prefix).previousElementSibling;Array.prototype.forEach.call(root.children,function(b){b.classList.toggle("active",b.dataset.status===status)})}
function tmClose(){document.getElementById("tmModalMount")?.remove()}
function tmModal(html){tmClose();var d=document.createElement("div");d.id="tmModalMount";d.innerHTML='<div class="tm-modal-bg" onclick="tmClose()"><div class="tm-modal" onclick="event.stopPropagation()">'+html+'</div></div>';document.body.appendChild(d)}
function tmVal(id){var el=document.getElementById(id);return el?el.value.trim():""}
function tmChecked(id){var el=document.getElementById(id);return !!(el&&el.checked)}
function tmFinishSave(result,msg){if(result&&result.error){toast("Save failed: "+result.error,"err");return}toast(msg||"Saved","ok");tmClose();loadProduction(true)}

function openItemEditor(id){
  var item=tmById(production.items,"ITEM_ID",id);if(!item)return;
  var reqs=production.requirements.filter(function(r){return r.ITEM_ID===id}).sort(function(a,b){return seqNum(tmScene(a.SCENE_UID))-seqNum(tmScene(b.SCENE_UID))});
  var h='<h2>'+esc(item.NAME)+'</h2><div class="tm-modal-sub">'+esc(item.ITEM_ID)+' · '+esc(item.TYPE)+' · '+reqs.length+' linked scene'+(reqs.length===1?'':'s')+'</div><div class="tm-field full"><label>Overall status</label>'+tmStatusButtons(tmStatus(item.STATUS),"itemStatus")+'</div><div class="tm-form-grid"><div class="tm-field"><label>Contract / permission</label><select class="tm-input" id="itemContract"><option></option>'+["Not Sent","Sent","Signed","Not Required"].map(function(v){return '<option'+(item.CONTRACT_STATUS===v?' selected':'')+'>'+v+'</option>'}).join("")+'</select></div><div class="tm-field"><label>Owner</label><input class="tm-input" id="itemOwner" value="'+esc(item.OWNER||"")+'"></div><div class="tm-field"><label>Needed</label><input class="tm-input" id="itemNeeded" value="'+esc(item.QUANTITY_NEEDED||"")+'"></div><div class="tm-field"><label>Ready</label><input class="tm-input" id="itemReady" value="'+esc(item.QUANTITY_READY||"")+'"></div><div class="tm-field full"><label>Link</label><input class="tm-input" id="itemLink" value="'+esc(item.LINK||"")+'" placeholder="Vendor, photo, contract or reference link"></div><div class="tm-field full"><label>Specific note</label><textarea class="tm-textarea" id="itemNotes">'+esc(item.NOTES||"")+'</textarea></div></div><div class="tm-field"><label>Scene uses and optional overrides</label>';
  reqs.forEach(function(r){var s=tmScene(r.SCENE_UID);h+='<div class="tm-scene-link"><b>'+esc(s.seqLabel||s.seq)+' — '+esc(s.title)+'</b><div style="display:flex;gap:6px;align-items:center;margin-top:5px"><select class="tm-mini-select" id="req-'+esc(r.REQUIREMENT_ID)+'"><option value="">Inherit '+esc(item.STATUS)+'</option>'+["Red","Orange","Yellow","Green"].map(function(v){return '<option'+(r.STATUS_OVERRIDE===v?' selected':'')+'>'+v+'</option>'}).join("")+'</select><span>'+esc(r.NOTES||r.SCENE_WORDING||"")+'</span></div></div>'});
  h+='</div><div class="tm-actions"><button class="mbtn ghost" onclick="tmClose()">Cancel</button><button class="mbtn gold" onclick="saveItemEditor(\''+esc(id)+'\')">Save item</button></div>';tmModal(h);
}
function saveItemEditor(id){
  var item=tmById(production.items,"ITEM_ID",id),reqs=production.requirements.filter(function(r){return r.ITEM_ID===id});
  var record=Object.assign({},item,{STATUS:tmVal("itemStatus"),CONTRACT_STATUS:tmVal("itemContract"),OWNER:tmVal("itemOwner"),QUANTITY_NEEDED:tmVal("itemNeeded"),QUANTITY_READY:tmVal("itemReady"),LINK:tmVal("itemLink"),NOTES:tmVal("itemNotes")});
  apiWrite({action:"saveItem",record:record}).then(function(result){if(result&&result.error){tmFinishSave(result);return}var jobs=reqs.filter(function(r){return String(r.STATUS_OVERRIDE||"")!==tmVal("req-"+r.REQUIREMENT_ID)}).map(function(r){var copy=Object.assign({},r,{STATUS_OVERRIDE:tmVal("req-"+r.REQUIREMENT_ID)});return apiWrite({action:"saveRequirement",record:copy})});Promise.all(jobs).then(function(){tmFinishSave(result,"Item and scene links saved")})});
}
function openSceneProduction(uid){
  var s=tmScene(uid),reqs=production.requirements.filter(function(r){return r.SCENE_UID===uid}),staff=production.staffing.filter(function(r){return r.SCENE_UID===uid}),notes=production.notes.filter(function(n){return n.SCOPE_TYPE==="Scene"&&n.SCOPE_ID===uid&&!n.RESOLVED});
  var h='<h2>'+esc(s.seqLabel||s.seq)+' — '+esc(s.title)+'</h2><div class="tm-modal-sub">'+esc(s.shootDay||"Unscheduled")+' · '+reqs.length+' requirements</div><div class="tm-field"><label>Requirements</label>'+reqs.map(function(r){var item=tmById(production.items,"ITEM_ID",r.ITEM_ID);return '<div class="tm-scene-link" onclick="tmClose();openItemEditor(\''+esc(r.ITEM_ID)+'\')"><b>'+esc(item?item.NAME:r.ITEM_ID)+'</b> · '+tmCardStatus(tmInherited(r))+'<div>'+esc(r.NOTES||r.SCENE_WORDING||"")+'</div></div>'}).join("")+'</div><div class="tm-field"><label>Staffing</label>'+staff.map(function(st){return '<div class="tm-scene-link" onclick="openStaffingEditor(\''+esc(st.STAFFING_ID)+'\',\''+esc(uid)+'\')"><b>'+esc(st.ROLE)+'</b> · need '+esc(st.NEEDED)+' · confirmed '+esc(st.CONFIRMED_COUNT)+' · gap '+esc(st.GAP)+'</div>'}).join("")+'<button class="hbtn" style="margin-top:6px" onclick="openStaffingEditor(null,\''+esc(uid)+'\')">+ Staffing need</button></div><div class="tm-field"><label>Scene notes</label>'+notes.map(function(n){return '<div class="tm-scene-link"><b>'+esc(n.CATEGORY||"Note")+'</b><div>'+esc(n.BODY)+'</div></div>'}).join("")+'<select class="tm-input" id="sceneNoteCategory" style="margin-top:6px"><option>Logistics</option><option>Creative</option><option>Safety</option><option>Schedule</option><option>General</option></select><textarea class="tm-textarea" id="sceneNoteBody" placeholder="Add a note specific to this scene"></textarea><button class="hbtn" onclick="saveSceneNote(\''+esc(uid)+'\')">Add note</button></div><div class="tm-actions"><button class="mbtn ghost" onclick="tmClose()">Close</button><button class="mbtn gold" onclick="tmClose();openTaskEditor(null,{type:\'Scene\',id:\''+esc(uid)+'\'})">Create linked task</button></div>';tmModal(h);
}
function saveSceneNote(uid){var body=tmVal("sceneNoteBody");if(!body){toast("Write the note first","err");return}apiWrite({action:"saveNote",record:{NOTE_ID:"",SCOPE_TYPE:"Scene",SCOPE_ID:uid,CATEGORY:tmVal("sceneNoteCategory")||"General",BODY:body,PINNED:false,RESOLVED:false,SOURCE:"Task Manager"}}).then(function(r){if(r&&r.error){toast("Save failed: "+r.error,"err");return}loadProduction(true).then(function(){openSceneProduction(uid)});toast("Scene note saved","ok")})}
function openStaffingEditor(id,uid){
  var st=id?tmById(production.staffing,"STAFFING_ID",id):null,s=tmScene(uid);st=st||{STAFFING_ID:"",SCENE_UID:uid,SEQ:s.seq||s.seqLabel,DEPARTMENT:"Crew",ROLE:"",NEEDED:1,ASSIGNED_PERSON_IDS:"",CONFIRMED_COUNT:0,GAP:1,NOTES:""};
  var h='<h2>'+(id?'Edit staffing':'New staffing need')+'</h2><div class="tm-modal-sub">'+esc(s.seqLabel||s.seq)+' — '+esc(s.title)+'</div><div class="tm-form-grid"><div class="tm-field"><label>Department</label><input class="tm-input" id="staffDept" value="'+esc(st.DEPARTMENT||"Crew")+'"></div><div class="tm-field"><label>Role</label><input class="tm-input" id="staffRole" value="'+esc(st.ROLE||"")+'"></div><div class="tm-field"><label>Needed</label><input class="tm-input" id="staffNeeded" type="number" min="0" value="'+esc(st.NEEDED||0)+'"></div><div class="tm-field"><label>Confirmed</label><input class="tm-input" id="staffConfirmed" type="number" min="0" value="'+esc(st.CONFIRMED_COUNT||0)+'"></div><div class="tm-field full"><label>Assigned person IDs</label><input class="tm-input" id="staffAssigned" value="'+esc(st.ASSIGNED_PERSON_IDS||"")+'"></div><div class="tm-field full"><label>Notes</label><textarea class="tm-textarea" id="staffNotes">'+esc(st.NOTES||"")+'</textarea></div></div><div class="tm-actions"><button class="mbtn ghost" onclick="openSceneProduction(\''+esc(uid)+'\')">Cancel</button><button class="mbtn gold" onclick="saveStaffingEditor(\''+esc(st.STAFFING_ID||"")+'\',\''+esc(uid)+'\',\''+esc(st.SEQ||"")+'\')">Save staffing</button></div>';tmModal(h);
}
function saveStaffingEditor(id,uid,seq){var needed=Math.max(0,Number(tmVal("staffNeeded"))||0),confirmed=Math.max(0,Number(tmVal("staffConfirmed"))||0);var record={STAFFING_ID:id,SCENE_UID:uid,SEQ:seq,DEPARTMENT:tmVal("staffDept")||"Crew",ROLE:tmVal("staffRole"),NEEDED:needed,ASSIGNED_PERSON_IDS:tmVal("staffAssigned"),CONFIRMED_COUNT:confirmed,GAP:Math.max(0,needed-confirmed),NOTES:tmVal("staffNotes")};if(!record.ROLE){toast("Staffing need requires a role","err");return}apiWrite({action:"saveStaffing",record:record}).then(function(r){if(r&&r.error){toast("Save failed: "+r.error,"err");return}loadProduction(true).then(function(){openSceneProduction(uid)});toast("Staffing saved","ok")})}
function openPersonEditor(id){
  var p=tmById(production.people,"PERSON_ID",id);if(!p)return;
  var statuses=["Candidate","Contacted","Listed","Formally Attached","Released"],contracts=["","Not Sent","Sent","Signed","Not Required"];
  var h='<h2>'+esc(p.NAME)+'</h2><div class="tm-modal-sub">'+esc(p.PERSON_ID)+'</div><div class="tm-form-grid"><div class="tm-field"><label>Project status</label><select class="tm-input" id="personProject">'+statuses.map(function(v){return '<option'+(p.PROJECT_STATUS===v?' selected':'')+'>'+v+'</option>'}).join("")+'</select></div><div class="tm-field"><label>Contract status</label><select class="tm-input" id="personContract">'+contracts.map(function(v){return '<option'+(p.CONTRACT_STATUS===v?' selected':'')+'>'+v+'</option>'}).join("")+'</select></div><div class="tm-field"><label>Contract version</label><input class="tm-input" id="personVersion" value="'+esc(p.CONTRACT_VERSION||"")+'"></div><div class="tm-field"><label>Role</label><input class="tm-input" id="personRole" value="'+esc(p.ROLES_CHARACTERS||"")+'"></div><div class="tm-field full"><label>Availability</label><textarea class="tm-textarea" id="personAvail">'+esc(p.AVAILABILITY||"")+'</textarea></div><div class="tm-field full"><label>Notes</label><textarea class="tm-textarea" id="personNotes">'+esc(p.NOTES||"")+'</textarea></div></div><div class="tm-actions"><button class="mbtn ghost" onclick="tmClose()">Cancel</button><button class="mbtn gold" onclick="savePersonEditor(\''+esc(id)+'\')">Save person</button></div>';tmModal(h);
}
function savePersonEditor(id){var p=tmById(production.people,"PERSON_ID",id),record=Object.assign({},p,{PROJECT_STATUS:tmVal("personProject"),CONTRACT_STATUS:tmVal("personContract"),CONTRACT_VERSION:tmVal("personVersion"),ROLES_CHARACTERS:tmVal("personRole"),AVAILABILITY:tmVal("personAvail"),NOTES:tmVal("personNotes")});apiWrite({action:"savePerson",record:record}).then(function(r){tmFinishSave(r,"Person saved")})}
function tmLinkInfo(seed){
  if(!seed)return {type:"Project",id:"HAIRPIN",title:"",item:"",scene:"",person:""};
  if(seed.type==="Item"){var i=tmById(production.items,"ITEM_ID",seed.id);return {type:"Item",id:seed.id,title:i?i.NAME:"",item:seed.id,scene:"",person:""}}
  if(seed.type==="Scene"){var s=tmScene(seed.id);return {type:"Scene",id:seed.id,title:(s.seqLabel||s.seq)+" — "+s.title,item:"",scene:seed.id,person:""}}
  var p=tmById(production.people,"PERSON_ID",seed.id);return {type:"Person",id:seed.id,title:p?p.NAME:"",item:"",scene:"",person:seed.id};
}
function openTaskEditor(id,seed){
  var existing=id?tmById(production.tasks,"TASK_ID",id):null,link=tmLinkInfo(seed);
  var t=existing||{TASK_ID:"",TITLE:link.title?"Follow up: "+link.title:"",STATUS_COLOR:"Red",DONE:false,TASK_TYPE:link.type==="Item"?(tmById(production.items,"ITEM_ID",link.item)||{}).TYPE||"General":"General",ASSIGNEE_IDS:"",SCOPE_TYPE:link.type,SCOPE_ID:link.id,SCENE_UID:link.scene,ITEM_ID:link.item,PERSON_ID:link.person,DUE_DATE:"",DUE_NOTE:"",MANUAL_ORDER:production.tasks.length+1,NOTES:""};
  var h='<h2>'+(existing?'Edit task':'New task')+'</h2><div class="tm-modal-sub">'+esc(t.SCOPE_TYPE||"Project")+' · '+esc(t.SCOPE_ID||"HAIRPIN")+'</div><div class="tm-field"><label>Status</label>'+tmStatusButtons(tmStatus(t.STATUS_COLOR),"taskStatus")+'</div><div class="tm-form-grid"><div class="tm-field full"><label>Task</label><input class="tm-input" id="taskTitle" value="'+esc(t.TITLE||"")+'"></div><div class="tm-field"><label>Type</label><input class="tm-input" id="taskType" value="'+esc(t.TASK_TYPE||"General")+'"></div><div class="tm-field"><label>Complete by</label><input class="tm-input" id="taskDue" type="date" value="'+esc(String(t.DUE_DATE||"").slice(0,10))+'"></div><div class="tm-field full"><label>Assigned person IDs or names</label><input class="tm-input" id="taskAssignee" value="'+esc(t.ASSIGNEE_IDS||"")+'"></div><div class="tm-field full"><label>Notes</label><textarea class="tm-textarea" id="taskNotes">'+esc(t.NOTES||"")+'</textarea></div><div class="tm-field"><label><input id="taskDone" type="checkbox" '+(t.DONE?'checked':'')+'> Complete</label></div></div><div class="tm-actions">'+(existing?'<button class="mbtn ghost tm-danger" onclick="deleteTaskEditor(\''+esc(t.TASK_ID)+'\')">Delete</button>':'')+'<button class="mbtn ghost" onclick="tmClose()">Cancel</button><button class="mbtn gold" onclick="saveTaskEditor(\''+esc(t.TASK_ID||"")+'\',\''+esc(t.SCOPE_TYPE||"Project")+'\',\''+esc(t.SCOPE_ID||"HAIRPIN")+'\',\''+esc(t.SCENE_UID||"")+'\',\''+esc(t.ITEM_ID||"")+'\',\''+esc(t.PERSON_ID||"")+'\')">Save task</button></div>';tmModal(h);
}
function saveTaskEditor(id,scopeType,scopeId,sceneId,itemId,personId){
  var current=id?tmById(production.tasks,"TASK_ID",id):{},record=Object.assign({},current,{TASK_ID:id,TITLE:tmVal("taskTitle"),STATUS_COLOR:tmVal("taskStatus"),DONE:tmChecked("taskDone"),TASK_TYPE:tmVal("taskType"),ASSIGNEE_IDS:tmVal("taskAssignee"),SCOPE_TYPE:scopeType,SCOPE_ID:scopeId,SCENE_UID:sceneId,ITEM_ID:itemId,PERSON_ID:personId,DUE_DATE:tmVal("taskDue"),DUE_NOTE:"",MANUAL_ORDER:current.MANUAL_ORDER||production.tasks.length+1,NOTES:tmVal("taskNotes")});
  if(!record.TITLE){toast("Task needs a title","err");return}apiWrite({action:"saveTask",record:record}).then(function(r){tmFinishSave(r,"Task saved")});
}
function deleteTaskEditor(id){if(!confirm("Delete this task?"))return;apiWrite({action:"deleteTask",id:id}).then(function(r){tmFinishSave(r,"Task deleted")})}
function tmToggleTask(id,done){var t=tmById(production.tasks,"TASK_ID",id);if(!t)return;apiWrite({action:"saveTask",record:Object.assign({},t,{DONE:done,STATUS_COLOR:done?"Green":t.STATUS_COLOR})}).then(function(r){if(r&&r.error)toast("Save failed: "+r.error,"err");else loadProduction(true)})}

updateToday();setInterval(updateToday,60000);
