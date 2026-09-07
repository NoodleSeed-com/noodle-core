import { DESIGN_STYLE_PROPERTIES } from './devtools-design-contract.js';

/**
 * Browser state machine for local Design mode. It owns selection interception, reversible annotation
 * history, preview-only CSS, debounced persistence, and ready-brief finalization.
 */
export const DEVTOOLS_DESIGN_PREVIEW_CLIENT_JS = `
(function(){
  var STYLE_PROPERTIES=${JSON.stringify(DESIGN_STYLE_PROPERTIES)};
  var config=null;
  var data={
    active:false,
    selecting:false,
    session:null,
    selected:null,
    hovered:null,
    history:[],
    future:[],
    dirty:false,
    unresolved:0
  };
  data.selectionId=0;
  var saveTimer=null;
  var overlay=null;
  var styleElement=null;
  var draftStyleElement=null;
  var wiredDocument=null;

  function snapshot(){
    return {
      active:data.active,
      selecting:data.selecting,
      selectionId:data.selectionId,
      session:data.session,
      selected:data.selected,
      hovered:data.hovered,
      historyLength:data.history.length,
      futureLength:data.future.length,
      dirty:data.dirty,
      unresolved:data.unresolved
    };
  }
  function changed(){
    if(config&&typeof config.onChange==="function") config.onChange(snapshot());
  }
  function status(message,isError){
    if(config&&typeof config.onStatus==="function") config.onStatus(message,Boolean(isError));
  }
  function frameDocument(){
    try{return config&&config.frame&&config.frame.contentDocument;}catch(error){return null;}
  }
  function context(){
    return config&&typeof config.getContext==="function"?config.getContext():null;
  }
  function query(){
    var current=context()||{};
    var params=new URLSearchParams();
    params.set("toolName",current.toolName||"widget");
    if(current.resourceUri) params.set("resourceUri",current.resourceUri);
    params.set("width",String(current.width||820));
    params.set("height",String(current.height||640));
    params.set("device",current.device==="mobile"?"mobile":"desktop");
    params.set("theme",current.theme==="dark"?"dark":"light");
    return params.toString();
  }
  function requestJson(url,options){
    return fetch(url,options).then(function(response){
      return response.json().then(function(body){
        if(!response.ok||!body||body.ok===false){
          var message=body&&body.error&&body.error.message?body.error.message:"Design request failed.";
          var error=new Error(message); error.status=response.status; throw error;
        }
        return body;
      });
    });
  }
  function ensureOverlay(doc){
    if(overlay&&overlay.ownerDocument===doc) return overlay;
    overlay=doc.createElement("div");
    overlay.id="noodle-design-overlay";
    overlay.setAttribute("aria-hidden","true");
    overlay.style.cssText="position:fixed;top:0;left:0;display:none;z-index:2147483646;pointer-events:none;overflow:visible;border:2px solid #f97316;border-radius:3px;background:rgba(249,115,22,.12);box-shadow:0 0 0 1px rgba(255,255,255,.3),0 0 22px rgba(249,115,22,.2);transition:transform 100ms cubic-bezier(.23,1,.32,1),width 100ms cubic-bezier(.23,1,.32,1),height 100ms cubic-bezier(.23,1,.32,1);";
    overlay.innerHTML='<span data-design-overlay-dot style="position:absolute;left:50%;top:-7px;width:12px;height:12px;transform:translateX(-50%);border-radius:999px;background:#f97316;box-shadow:0 0 0 2px #fff"></span><span data-design-overlay-label style="position:absolute;left:-2px;min-width:200px;max-width:300px;padding:7px 9px;border-radius:7px;background:#29292c;color:#fafafa;box-shadow:0 8px 28px rgba(0,0,0,.38);font:600 11px/1.4 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;letter-spacing:0;white-space:nowrap;text-align:left"></span>';
    (doc.body||doc.documentElement).appendChild(overlay);
    return overlay;
  }
  function paintOverlay(element,state){
    var doc=frameDocument();
    if(!doc||!element){if(overlay) overlay.style.display="none";return;}
    var box=element.getBoundingClientRect();
    var layer=ensureOverlay(doc);
    var view=doc.defaultView;
    var computed=view&&view.getComputedStyle?view.getComputedStyle(element):null;
    var tag=String(element.tagName||"element").toLowerCase();
    var width=Math.max(0,Math.round(box.width));
    var height=Math.max(0,Math.round(box.height));
    var color=computed&&computed.color?computed.color:"unknown";
    var fontSize=computed&&computed.fontSize?computed.fontSize:"unknown";
    var fontFamily=computed&&computed.fontFamily?computed.fontFamily.split(",")[0].replace(/[\\"']/g,"").trim():"system";
    var label=layer.querySelector("[data-design-overlay-label]");
    if(label){
      label.textContent=tag+"   "+width+"×"+height+"\\ncolor "+color+"   font "+fontSize+" "+fontFamily.slice(0,28);
      label.style.top=box.top>72?"-58px":height+8+"px";
      label.style.whiteSpace="pre";
    }
    layer.dataset.state=state==="selected"?"selected":"hover";
    layer.style.background=state==="selected"?"rgba(249,115,22,.18)":"rgba(249,115,22,.1)";
    layer.style.display="block";
    layer.style.transform="translate("+Math.round(box.left)+"px,"+Math.round(box.top)+"px)";
    layer.style.width=width+"px";
    layer.style.height=height+"px";
  }
  function validValue(doc,property,value){
    if(STYLE_PROPERTIES.indexOf(property)<0) return false;
    if(typeof value!=="string"||!value.trim()) return false;
    var probe=doc.createElement("div").style;
    probe.setProperty(property,value);
    return Boolean(probe.getPropertyValue(property));
  }
  function clearTargets(doc){
    var targets=doc.querySelectorAll("[data-noodle-design-target]");
    for(var i=0;i<targets.length;i++) targets[i].removeAttribute("data-noodle-design-target");
    var draftTargets=doc.querySelectorAll("[data-noodle-design-draft]");
    for(var d=0;d<draftTargets.length;d++) draftTargets[d].removeAttribute("data-noodle-design-draft");
    var existing=doc.getElementById("noodle-design-preview-styles");
    if(existing) existing.remove();
    var existingDraft=doc.getElementById("noodle-design-draft-styles");
    if(existingDraft) existingDraft.remove();
    styleElement=null;
    draftStyleElement=null;
  }
  function clearDraftPreview(){
    var doc=frameDocument();
    if(!doc) return;
    var targets=doc.querySelectorAll("[data-noodle-design-draft]");
    for(var i=0;i<targets.length;i++) targets[i].removeAttribute("data-noodle-design-draft");
    var existing=doc.getElementById("noodle-design-draft-styles");
    if(existing) existing.remove();
    draftStyleElement=null;
  }
  function previewChanges(changes){
    var doc=frameDocument();
    clearDraftPreview();
    if(!doc||!data.selected||!data.selected.element||!Array.isArray(changes)) return;
    var declarations=[];
    for(var i=0;i<changes.length;i++){
      var change=changes[i];
      if(change&&validValue(doc,change.property,change.to)){
        declarations.push(change.property+":"+change.to+"!important");
      }
    }
    if(!declarations.length) return;
    data.selected.element.setAttribute("data-noodle-design-draft","true");
    draftStyleElement=doc.createElement("style");
    draftStyleElement.id="noodle-design-draft-styles";
    draftStyleElement.textContent='[data-noodle-design-draft="true"]{'+declarations.join(";")+'}';
    doc.head.appendChild(draftStyleElement);
  }
  function applyAnnotations(){
    var doc=frameDocument();
    if(!doc||!window.NoodleDesignElement||!data.session) return;
    clearTargets(doc);
    var rules=[];
    var unresolved=0;
    var annotations=data.session.annotations||[];
    for(var i=0;i<annotations.length;i++){
      var annotation=annotations[i];
      var resolution=window.NoodleDesignElement.resolve(doc,annotation.target);
      if(!resolution.element){unresolved++;continue;}
      var targetId="annotation-"+i;
      resolution.element.setAttribute("data-noodle-design-target",targetId);
      var declarations=[];
      for(var j=0;j<annotation.changes.length;j++){
        var change=annotation.changes[j];
        if(validValue(doc,change.property,change.to)){
          declarations.push(change.property+":"+change.to+"!important");
        }
      }
      if(declarations.length){
        rules.push('[data-noodle-design-target="'+targetId+'"]{'+declarations.join(";")+'}');
      }
    }
    styleElement=doc.createElement("style");
    styleElement.id="noodle-design-preview-styles";
    styleElement.textContent=rules.join("\\n");
    doc.head.appendChild(styleElement);
    data.unresolved=unresolved;
  }
  function selectableElement(element){
    if(!element||!element.closest) return element;
    var interactive=element.closest("button,a[href],input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem]");
    if(interactive) return interactive;
    var inlineTags={span:true,strong:true,em:true,small:true,b:true,i:true,u:true,svg:true,path:true,g:true,use:true};
    var current=element;
    var body=wiredDocument&&wiredDocument.body;
    while(current&&current.parentElement&&current.parentElement!==body&&inlineTags[String(current.tagName||"").toLowerCase()]){
      current=current.parentElement;
    }
    return current||element;
  }
  function select(element){
    element=selectableElement(element);
    if(!element||!window.NoodleDesignElement) return null;
    clearDraftPreview();
    data.selected={
      element:element,
      target:window.NoodleDesignElement.capture(element)
    };
    data.selectionId+=1;
    paintOverlay(element,"selected");
    changed();
    return data.selected.target;
  }
  function pointerOver(event){
    if(!data.active||!data.selecting||!event.target||event.target===overlay) return;
    var element=selectableElement(event.target);
    if(data.hovered===element) return;
    data.hovered=element;
    paintOverlay(element,"hover");
  }
  function pointerOut(event){
    if(!data.active||!data.selecting||event.relatedTarget) return;
    data.hovered=null;
    paintOverlay(data.selected&&data.selected.element,"selected");
  }
  function repaintOverlay(){
    var element=data.hovered||(data.selected&&data.selected.element);
    paintOverlay(element,data.hovered?"hover":"selected");
  }
  function click(event){
    if(!data.active||!data.selecting||!event.target||event.target===overlay) return;
    event.preventDefault();
    event.stopPropagation();
    if(event.stopImmediatePropagation) event.stopImmediatePropagation();
    select(event.target);
  }
  function keydown(event){
    if(!data.active||!data.selecting) return;
    if(event.key==="Escape"){
      clearDraftPreview(); data.selected=null; data.hovered=null; paintOverlay(null); changed(); return;
    }
    if(event.key==="Enter"&&event.target&&event.target!==wiredDocument.body){
      event.preventDefault(); event.stopPropagation(); select(event.target);
    }
  }
  function wire(){
    var doc=frameDocument();
    if(!doc||wiredDocument===doc) return;
    unwire();
    wiredDocument=doc;
    doc.addEventListener("pointerover",pointerOver,true);
    doc.addEventListener("mousemove",pointerOver,true);
    doc.addEventListener("pointerout",pointerOut,true);
    doc.addEventListener("click",click,true);
    doc.addEventListener("keydown",keydown,true);
    if(doc.defaultView){
      doc.defaultView.addEventListener("resize",repaintOverlay);
      doc.defaultView.addEventListener("scroll",repaintOverlay,true);
    }
    ensureOverlay(doc);
    updateCursor();
  }
  function updateCursor(){
    if(!wiredDocument) return;
    wiredDocument.documentElement.style.cursor=data.selecting
      ? 'url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22%3E%3Cpath d=%22M4 2.8v15.6l4.2-4.1 2.9 6.2 3.2-1.5-2.8-6.1h5.8L4 2.8Z%22 fill=%22%23f97316%22 stroke=%22%23fff%22 stroke-width=%221.2%22 stroke-linejoin=%22round%22/%3E%3C/svg%3E") 4 3, pointer'
      :"";
  }
  function setSelecting(enabled){
    data.selecting=Boolean(enabled);
    if(!data.selecting){
      clearDraftPreview();
      data.selected=null;
      data.hovered=null;
      paintOverlay(null);
    }
    updateCursor();
    status(data.selecting?"Select an element in the widget.":"Annotations are off.",false);
    changed();
  }
  function unwire(){
    if(!wiredDocument) return;
    wiredDocument.removeEventListener("pointerover",pointerOver,true);
    wiredDocument.removeEventListener("mousemove",pointerOver,true);
    wiredDocument.removeEventListener("pointerout",pointerOut,true);
    wiredDocument.removeEventListener("click",click,true);
    wiredDocument.removeEventListener("keydown",keydown,true);
    if(wiredDocument.defaultView){
      wiredDocument.defaultView.removeEventListener("resize",repaintOverlay);
      wiredDocument.defaultView.removeEventListener("scroll",repaintOverlay,true);
    }
    wiredDocument.documentElement.style.cursor="";
    if(overlay) overlay.remove();
    overlay=null;
    wiredDocument=null;
  }
  function nextUpdatedAt(previous){
    var now=new Date();
    if(previous&&now.toISOString()<=previous) now=new Date(Date.parse(previous)+1);
    return now.toISOString();
  }
  function persist(){
    if(saveTimer){clearTimeout(saveTimer);saveTimer=null;}
    if(!data.session||!data.dirty) return Promise.resolve(data.session);
    var previous=data.session.updatedAt;
    var pending=Object.assign({},data.session,{updatedAt:nextUpdatedAt(previous)});
    data.session=pending;
    return requestJson("/design/session",{
      method:"PUT",
      headers:{"content-type":"application/json","if-unmodified-since":previous},
      body:JSON.stringify(pending)
    }).then(function(body){
      data.session=body.session; data.dirty=false; status("Design draft saved.",false); changed();
      return data.session;
    }).catch(function(error){
      data.session=Object.assign({},data.session,{updatedAt:previous});
      data.dirty=true; status(error.message||"Could not save the design draft.",true); changed(); throw error;
    });
  }
  function schedulePersist(){
    if(saveTimer) clearTimeout(saveTimer);
    saveTimer=setTimeout(function(){persist().catch(function(){});},250);
  }
  function pushHistory(){
    if(!data.session) return;
    data.history.push(JSON.stringify(data.session.annotations||[]));
    if(data.history.length>50) data.history.shift();
    data.future=[];
  }
  function replaceAnnotations(annotations){
    if(!data.session) return;
    data.session=Object.assign({},data.session,{annotations:annotations});
    data.dirty=true;
    applyAnnotations();
    schedulePersist();
    changed();
  }
  function saveAnnotation(annotation){
    if(!data.session||!annotation) return;
    clearDraftPreview();
    pushHistory();
    var annotations=(data.session.annotations||[]).slice();
    var index=annotations.findIndex(function(item){return item.id===annotation.id;});
    if(index>=0) annotations[index]=annotation; else annotations.push(annotation);
    replaceAnnotations(annotations);
    data.selected=null;
    data.hovered=null;
    paintOverlay(null);
    changed();
    status("Annotation saved.",false);
  }
  function removeAnnotation(id){
    if(!data.session) return;
    pushHistory();
    replaceAnnotations((data.session.annotations||[]).filter(function(item){return item.id!==id;}));
    status("Annotation removed.",false);
  }
  function undo(){
    if(!data.session||!data.history.length) return;
    data.future.push(JSON.stringify(data.session.annotations||[]));
    replaceAnnotations(JSON.parse(data.history.pop()));
    status("Undid the last design change.",false);
  }
  function redo(){
    if(!data.session||!data.future.length) return;
    data.history.push(JSON.stringify(data.session.annotations||[]));
    replaceAnnotations(JSON.parse(data.future.pop()));
    status("Restored the design change.",false);
  }
  function rehydrate(){
    if(!data.active) return Promise.resolve();
    wire();
    applyAnnotations();
    if(data.selected&&data.selected.target){
      var doc=frameDocument();
      var resolved=doc&&window.NoodleDesignElement.resolve(doc,data.selected.target);
      data.selected=resolved&&resolved.element?{element:resolved.element,target:data.selected.target}:null;
      paintOverlay(data.selected&&data.selected.element,"selected");
    }
    changed();
    return Promise.resolve();
  }
  function enter(){
    data.active=true;
    data.selecting=false;
    var current=context();
    if(!current||!current.toolName){
      data.session=null; status("Open a widget in Preview, then return to Design.",true); changed();
      return Promise.resolve(null);
    }
    return requestJson("/design/session?"+query()).then(function(body){
      data.session=body.session;
      data.dirty=false;
      wire();
      applyAnnotations();
      status("Turn on annotations when you are ready to select an element.",false);
      changed();
      return data.session;
    }).catch(function(error){
      status(error.message||"Could not open Design.",true); changed(); throw error;
    });
  }
  function leave(){
    return persist().catch(function(){}).then(function(){
      data.active=false; data.selected=null; data.hovered=null;
      data.selecting=false;
      var doc=frameDocument(); if(doc) clearTargets(doc);
      unwire(); changed();
    });
  }
  function finalize(){
    return persist().then(function(){
      if(!data.session) throw new Error("Open a widget before sending design feedback.");
      return requestJson("/design/finalize",{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({expectedUpdatedAt:data.session.updatedAt})
      });
    });
  }
  function configure(next){config=next;}
  window.NoodleDesign={
    configure:configure,
    enter:enter,
    leave:leave,
    select:select,
    setSelecting:setSelecting,
    previewChanges:previewChanges,
    saveAnnotation:saveAnnotation,
    removeAnnotation:removeAnnotation,
    undo:undo,
    redo:redo,
    rehydrate:rehydrate,
    persist:persist,
    finalize:finalize,
    state:snapshot
  };
})();`;
