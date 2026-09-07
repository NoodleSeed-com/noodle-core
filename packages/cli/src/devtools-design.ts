import { DEVTOOLS_DESIGN_ELEMENT_CLIENT_JS } from './devtools-design-element.js';
import { DEVTOOLS_DESIGN_PREVIEW_CLIENT_JS } from './devtools-design-preview.js';

const cursorIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M5 3.5v15l4.1-4 2.8 6 3.1-1.5-2.7-5.9H18L5 3.5Z"/></svg>';
const chevronIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m7 10 5 5 5-5"/></svg>';
const undoIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7 4 12l5 5"/><path d="M20 17a8 8 0 0 0-13.8-5.5L4 12"/></svg>';
const redoIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 7 5 5-5 5"/><path d="M4 17a8 8 0 0 1 13.8-5.5L20 12"/></svg>';

function textControl(label: string, property: string, placeholder: string): string {
  return (
    `<div class="design-control-row"><label for="design-${property}">${label}</label>` +
    `<input id="design-${property}" class="design-input" data-design-property="${property}" ` +
    `type="text" placeholder="${placeholder}" spellcheck="false"></div>`
  );
}

function colorControl(label: string, property: string): string {
  return (
    `<div class="design-control-row"><label for="design-${property}">${label}</label>` +
    '<span class="design-color-input">' +
    `<input data-color-for="${property}" type="color" value="#f97316" aria-label="${label} picker">` +
    `<input id="design-${property}" class="design-input" data-design-property="${property}" ` +
    `type="text" placeholder="Unchanged" spellcheck="false"></span></div>`
  );
}

export const DEVTOOLS_DESIGN_HTML = [
  '<div id="design-view" class="design-view hidden" role="tabpanel" aria-labelledby="mode-design">',
  '<section id="design-empty" class="design-empty">',
  `<span class="design-empty__mark" aria-hidden="true">${cursorIcon}</span>`,
  '<h3>Open a widget to start designing</h3>',
  '<p>Choose a widget tool in Preview, then return here to select and fine-tune its elements.</p>',
  '<button id="design-choose-widget" class="design-action" type="button">Choose a widget</button>',
  '</section>',
  '<section id="design-workspace" class="design-workspace" hidden>',
  '<div class="design-canvas">',
  '<div class="design-canvas__bar">',
  `<button id="design-select-toggle" class="design-select-toggle" type="button" aria-pressed="false">${cursorIcon}<span>Annotations off</span></button>`,
  '<div class="design-canvas__meta">',
  '<span id="design-unsaved" class="design-unsaved" hidden>Unsaved</span>',
  `<button id="design-tweaks-toggle" class="design-count" type="button" aria-expanded="false" aria-controls="design-tweaks-panel"><span id="design-count">0 tweaks</span>${chevronIcon}</button>`,
  '</div>',
  '</div>',
  '<section id="design-tweaks-panel" class="design-tweaks-popover" role="region" aria-label="Saved design tweaks" hidden>',
  '<header class="design-tweaks-popover__head"><span>Saved tweaks</span><span class="design-tweaks-popover__hint">Design history</span></header>',
  '<div id="design-changes" class="design-changes"><p class="design-changes-empty">Saved tweaks will appear here.</p></div>',
  '</section>',
  '<div id="design-frame-slot"></div>',
  '</div>',
  '<aside class="design-inspector" role="region" aria-label="Design inspector">',
  '<header class="design-inspector__head">',
  '<div><span class="design-inspector__eyebrow">Selected element</span>',
  '<p id="design-target" class="design-target">Nothing selected</p>',
  '<span id="design-target-path" class="design-target-path">Pick an element directly in the widget</span></div>',
  '<button id="design-clear" class="design-icon-button" type="button" aria-label="Clear selection" title="Clear selection">×</button>',
  '</header>',
  '<div class="design-scroll">',
  '<section class="design-section">',
  '<label class="design-section__label" for="design-intent">Describe</label>',
  '<textarea id="design-intent" aria-label="Describe this change" placeholder="Describe how this element should look or feel..."></textarea>',
  '</section>',
  '<section class="design-section"><span class="design-section__label">Type</span>',
  '<div class="design-control-group">',
  colorControl('Text color', 'color'),
  textControl('Font size', 'font-size', 'e.g. 16px'),
  textControl('Font weight', 'font-weight', 'e.g. 600'),
  textControl('Line height', 'line-height', 'e.g. 1.4'),
  '<div class="design-control-row"><label>Text align</label><div class="design-segment" data-design-segment="text-align">',
  '<button type="button" data-value="left" aria-pressed="false">Left</button>',
  '<button type="button" data-value="center" aria-pressed="false">Center</button>',
  '<button type="button" data-value="right" aria-pressed="false">Right</button>',
  '</div></div></div></section>',
  '<section class="design-section"><span class="design-section__label">Surface and shape</span>',
  '<div class="design-control-group">',
  colorControl('Background color', 'background-color'),
  textControl('Opacity', 'opacity', 'e.g. 0.9'),
  colorControl('Border color', 'border-color'),
  textControl('Border width', 'border-width', 'e.g. 1px'),
  textControl('Border radius', 'border-radius', 'e.g. 12px'),
  '</div></section>',
  '<section class="design-section"><span class="design-section__label">Space and layout</span>',
  '<div class="design-control-group">',
  textControl('Padding', 'padding-top', 'e.g. 12px'),
  textControl('Margin', 'margin-top', 'e.g. 0'),
  textControl('Gap', 'row-gap', 'e.g. 8px'),
  textControl('Width', 'width', 'e.g. 100%'),
  textControl('Height', 'height', 'e.g. auto'),
  '</div></section>',
  '</div>',
  '<footer class="design-inspector__footer">',
  '<div class="design-history">',
  `<button id="design-undo" class="design-icon-button" type="button" disabled>${undoIcon}<span>Undo</span></button>`,
  `<button id="design-redo" class="design-icon-button" type="button" disabled>${redoIcon}<span>Redo</span></button>`,
  '</div>',
  '<div class="design-actions">',
  '<button id="design-save" class="design-action" type="button" disabled>Save annotation</button>',
  '<button id="design-send" class="design-action design-action--send" type="button" disabled>Send to agent</button>',
  '</div>',
  '<div id="design-status" class="design-status" role="status" aria-live="polite"></div>',
  '<div id="design-copy-fallback" class="design-copy-fallback">',
  '<input id="design-copy-value" class="design-input" type="text" readonly aria-label="Agent instruction">',
  '<button id="design-copy" class="design-action" type="button">Copy instruction</button>',
  '</div>',
  '</footer>',
  '</aside>',
  '</section>',
  '</div>',
].join('');

export const DEVTOOLS_DESIGN_CLIENT_JS = [
  DEVTOOLS_DESIGN_ELEMENT_CLIENT_JS,
  DEVTOOLS_DESIGN_PREVIEW_CLIENT_JS,
  `
(function(){
  var ui={configured:false,active:false,frame:null,getContext:null,previewParent:null,previewNext:null,inspectorParent:null,inspectorNext:null,activityLabel:null};
  var empty=document.getElementById("design-empty");
  var workspace=document.getElementById("design-workspace");
  var slot=document.getElementById("design-frame-slot");
  var inspector=document.querySelector(".design-inspector");
  var activity=document.getElementById("log");
  var targetLabel=document.getElementById("design-target");
  var targetPath=document.getElementById("design-target-path");
  var intent=document.getElementById("design-intent");
  var count=document.getElementById("design-count");
  var selectToggle=document.getElementById("design-select-toggle");
  var selectToggleLabel=selectToggle.querySelector("span");
  var tweaksToggle=document.getElementById("design-tweaks-toggle");
  var tweaksPanel=document.getElementById("design-tweaks-panel");
  var unsaved=document.getElementById("design-unsaved");
  var changes=document.getElementById("design-changes");
  var saveButton=document.getElementById("design-save");
  var sendButton=document.getElementById("design-send");
  var undoButton=document.getElementById("design-undo");
  var redoButton=document.getElementById("design-redo");
  var statusElement=document.getElementById("design-status");
  var fallback=document.getElementById("design-copy-fallback");
  var fallbackValue=document.getElementById("design-copy-value");
  var propertyInputs=document.querySelectorAll("[data-design-property]");
  var draftDirty=false;
  var tweaksCloseTimer=0;
  function openTweaks(){
    if(tweaksToggle.disabled) return;
    window.clearTimeout(tweaksCloseTimer);
    tweaksPanel.hidden=false;
    tweaksToggle.setAttribute("aria-expanded","true");
    window.requestAnimationFrame(function(){tweaksPanel.classList.add("is-open");});
  }
  function closeTweaks(returnFocus,immediate){
    window.clearTimeout(tweaksCloseTimer);
    tweaksToggle.setAttribute("aria-expanded","false");
    tweaksPanel.classList.remove("is-open");
    if(immediate) tweaksPanel.hidden=true;
    else tweaksCloseTimer=window.setTimeout(function(){tweaksPanel.hidden=true;},170);
    if(returnFocus) tweaksToggle.focus();
  }
  function toggleTweaks(){
    if(tweaksToggle.getAttribute("aria-expanded")==="true") closeTweaks(false,false);
    else openTweaks();
  }
  function message(text,isError){
    statusElement.textContent=text||"";
    statusElement.classList.toggle("is-error",Boolean(isError));
  }
  function targetName(target){
    if(!target) return "Nothing selected";
    return target.accessibleName||target.visibleText||target.role||target.tagName;
  }
  function targetBreadcrumb(target){
    if(!target) return "Pick an element directly in the widget";
    var path=(target.ancestry||[]).map(function(item){return item.tagName+(item.stableId?"#"+item.stableId:"");});
    path.push(target.tagName+(target.stableId?"#"+target.stableId:""));
    return path.join(" › ");
  }
  function setDraftDirty(value){
    draftDirty=Boolean(value);
    unsaved.hidden=!draftDirty;
  }
  function rgbHex(value){
    if(!value) return "#f97316";
    if(/^#[0-9a-f]{6}$/i.test(value)) return value;
    var match=value.match(/rgba?\\(\\s*(\\d+)\\D+(\\d+)\\D+(\\d+)/i);
    if(!match) return "#f97316";
    return "#"+[match[1],match[2],match[3]].map(function(part){return Number(part).toString(16).padStart(2,"0");}).join("");
  }
  function populateControls(target){
    for(var i=0;i<propertyInputs.length;i++){
      var property=propertyInputs[i].dataset.designProperty;
      propertyInputs[i].value="";
      propertyInputs[i].placeholder=target&&target.computedStyles&&target.computedStyles[property]
        ? target.computedStyles[property]
        : "Unchanged";
    }
    var pickers=document.querySelectorAll("[data-color-for]");
    for(var p=0;p<pickers.length;p++){
      var colorProperty=pickers[p].dataset.colorFor;
      pickers[p].value=rgbHex(target&&target.computedStyles&&target.computedStyles[colorProperty]);
    }
    var segments=document.querySelectorAll("[data-design-segment] button");
    for(var s=0;s<segments.length;s++) segments[s].setAttribute("aria-pressed","false");
  }
  function renderChanges(session){
    var annotations=session&&session.annotations?session.annotations:[];
    count.textContent=annotations.length+" tweak"+(annotations.length===1?"":"s");
    tweaksToggle.disabled=!annotations.length;
    if(!annotations.length){
      closeTweaks(false,true);
    }
    changes.innerHTML="";
    if(!annotations.length){
      changes.innerHTML='<p class="design-changes-empty">Saved tweaks will appear here.</p>';
      return;
    }
    annotations.forEach(function(annotation,index){
      var item=document.createElement("article"); item.className="design-change";
      var heading=document.createElement("div"); heading.className="design-change__heading";
      var number=document.createElement("span"); number.className="design-change__number"; number.textContent="Tweak "+String(index+1).padStart(2,"0");
      var title=document.createElement("strong"); title.textContent=targetName(annotation.target);
      heading.appendChild(number); heading.appendChild(title);
      var details=document.createElement("dl"); details.className="design-change__details";
      function detail(label,value){
        var row=document.createElement("div");
        var term=document.createElement("dt"); term.textContent=label;
        var description=document.createElement("dd"); description.textContent=value;
        row.appendChild(term); row.appendChild(description); details.appendChild(row);
      }
      detail("Target",targetName(annotation.target));
      detail("Selector",targetBreadcrumb(annotation.target));
      detail("Request",annotation.intent||"Visual controls only");
      var visual=(annotation.changes||[]).map(function(change){
        return change.property+": "+(change.from||"unset")+" → "+change.to;
      }).join("\\n");
      detail("Visual changes",visual||"No direct style values");
      var actions=document.createElement("div"); actions.className="design-change__actions";
      var copy=document.createElement("button"); copy.type="button"; copy.textContent="Copy tweak";
      copy.addEventListener("click",function(){copyTweak(annotation,index);});
      var remove=document.createElement("button"); remove.type="button"; remove.className="is-danger"; remove.textContent="Remove";
      remove.addEventListener("click",function(){window.NoodleDesign.removeAnnotation(annotation.id);});
      actions.appendChild(copy); actions.appendChild(remove);
      item.appendChild(heading); item.appendChild(details); item.appendChild(actions); changes.appendChild(item);
    });
  }
  function render(state){
    var selected=state.selected&&state.selected.target;
    selectToggle.setAttribute("aria-pressed",state.selecting?"true":"false");
    selectToggleLabel.textContent=state.selecting?"Annotations on":"Annotations off";
    targetLabel.textContent=targetName(selected);
    targetPath.textContent=selected
      ? targetBreadcrumb(selected)
      : state.selecting?"Select an element directly in the widget":"Turn on annotations to select an element";
    saveButton.disabled=!selected;
    undoButton.disabled=state.historyLength===0;
    redoButton.disabled=state.futureLength===0;
    sendButton.disabled=!(state.session&&state.session.annotations&&state.session.annotations.length);
    renderChanges(state.session);
    if(selected&&intent.dataset.targetId!==String(state.selectionId)){
      intent.value="";
      intent.dataset.targetId=String(state.selectionId);
      populateControls(selected);
      setDraftDirty(false);
    }
    if(!selected&&intent.dataset.targetId){
      intent.value="";
      intent.dataset.targetId="";
      populateControls(null);
      setDraftDirty(false);
    }
  }
  function currentChanges(selected){
    var output=[];
    for(var i=0;i<propertyInputs.length;i++){
      var input=propertyInputs[i];
      var value=input.value.trim();
      if(!value) continue;
      var property=input.dataset.designProperty;
      output.push({property:property,from:selected.computedStyles[property]||"",to:value});
      if(property==="padding-top"){
        ["padding-right","padding-bottom","padding-left"].forEach(function(side){
          output.push({property:side,from:selected.computedStyles[side]||"",to:value});
        });
      }
      if(property==="margin-top"){
        ["margin-right","margin-bottom","margin-left"].forEach(function(side){
          output.push({property:side,from:selected.computedStyles[side]||"",to:value});
        });
      }
      if(property==="row-gap"){
        output.push({property:"column-gap",from:selected.computedStyles["column-gap"]||"",to:value});
      }
    }
    var pressed=document.querySelector('[data-design-segment="text-align"] button[aria-pressed="true"]');
    if(pressed){
      output.push({property:"text-align",from:selected.computedStyles["text-align"]||"",to:pressed.dataset.value});
    }
    return output;
  }
  function preview(){
    var state=window.NoodleDesign.state();
    var selected=state.selected&&state.selected.target;
    window.NoodleDesign.previewChanges(selected?currentChanges(selected):[]);
  }
  function save(){
    var state=window.NoodleDesign.state();
    var selected=state.selected&&state.selected.target;
    if(!selected) return;
    var description=intent.value.trim();
    var visual=currentChanges(selected);
    if(!description&&!visual.length){message("Describe a change or tune a visual property.",true);return;}
    var id=window.crypto&&window.crypto.randomUUID?window.crypto.randomUUID():"annotation-"+Date.now();
    window.NoodleDesign.saveAnnotation({
      id:id,
      intent:description,
      target:selected,
      changes:visual,
      acceptanceCriteria:[
        "The requested change is visible at the captured viewport and theme.",
        "The selected element remains readable and usable."
      ],
      preserve:["Keep the element text, semantics, and existing behavior unless the request says otherwise."]
    });
    intent.value=""; populateControls(null); setDraftDirty(false);
  }
  function copyTweak(annotation,index){
    var lines=[
      "Tweak "+String(index+1).padStart(2,"0"),
      "Target: "+targetName(annotation.target),
      "Selector: "+targetBreadcrumb(annotation.target),
      "Request: "+(annotation.intent||"Visual controls only"),
      "Visual changes:"
    ];
    (annotation.changes||[]).forEach(function(change){
      lines.push("- "+change.property+": "+(change.from||"unset")+" → "+change.to);
    });
    if(!(annotation.changes||[]).length) lines.push("- No direct style values");
    var operation=navigator.clipboard&&navigator.clipboard.writeText
      ? navigator.clipboard.writeText(lines.join("\\n"))
      : Promise.reject(new Error("clipboard unavailable"));
    operation.then(function(){message("Tweak copied.",false);}).catch(function(){
      fallbackValue.value=lines.join("\\n");
      fallback.classList.add("is-visible");
      message("Copy the tweak details below.",true);
    });
  }
  function copyInstruction(instruction){
    var operation=navigator.clipboard&&navigator.clipboard.writeText
      ? navigator.clipboard.writeText(instruction)
      : Promise.reject(new Error("clipboard unavailable"));
    return operation.then(function(){
      fallback.classList.remove("is-visible");
      message("Agent instruction copied. Paste it into your coding agent.",false);
    }).catch(function(){
      fallbackValue.value=instruction;
      fallback.classList.add("is-visible");
      message("The brief is ready. Copy the instruction and paste it into your coding agent.",true);
    });
  }
  function send(){
    sendButton.disabled=true; message("Preparing the implementation brief...",false);
    window.NoodleDesign.finalize().then(function(body){
      return copyInstruction(body.delivery.instruction);
    }).catch(function(error){
      message(error.message||"Could not prepare the design brief.",true);
    }).then(function(){render(window.NoodleDesign.state());});
  }
  function mountFrame(){
    if(!ui.frame||ui.frame.parentNode===slot) return;
    ui.previewParent=ui.frame.parentNode; ui.previewNext=ui.frame.nextSibling;
    slot.appendChild(ui.frame);
  }
  function restoreFrame(){
    if(!ui.frame||!ui.previewParent||ui.frame.parentNode!==slot) return;
    if(ui.previewNext&&ui.previewNext.parentNode===ui.previewParent) ui.previewParent.insertBefore(ui.frame,ui.previewNext);
    else ui.previewParent.appendChild(ui.frame);
  }
  function mountInspector(){
    if(!inspector||!activity||inspector.parentNode===activity) return;
    ui.inspectorParent=inspector.parentNode; ui.inspectorNext=inspector.nextSibling;
    ui.activityLabel=activity.getAttribute("aria-label");
    activity.appendChild(inspector);
    activity.setAttribute("aria-label","Design tools");
  }
  function restoreInspector(){
    if(!inspector||!ui.inspectorParent||inspector.parentNode!==activity) return;
    if(ui.inspectorNext&&ui.inspectorNext.parentNode===ui.inspectorParent) ui.inspectorParent.insertBefore(inspector,ui.inspectorNext);
    else ui.inspectorParent.appendChild(inspector);
    activity.setAttribute("aria-label",ui.activityLabel||"MCP calls");
  }
  function enter(){
    ui.active=true;
    mountInspector();
    var current=ui.getContext&&ui.getContext();
    var ready=Boolean(current&&current.toolName);
    empty.hidden=ready; workspace.hidden=!ready;
    if(!ready){message("Open a widget in Preview, then return to Design.",true);return Promise.resolve();}
    mountFrame();
    return window.NoodleDesign.enter();
  }
  function leave(){ui.active=false;closeTweaks(false,true);restoreFrame();restoreInspector();return window.NoodleDesign.leave();}
  function frameLoaded(){if(ui.active) window.NoodleDesign.rehydrate();}
  function configure(options){
    ui.frame=options.frame; ui.getContext=options.getContext; ui.configured=true;
    window.NoodleDesign.configure({
      frame:ui.frame,
      getContext:ui.getContext,
      onChange:render,
      onStatus:message
    });
  }
  document.getElementById("design-choose-widget").addEventListener("click",function(){document.getElementById("mode-preview").click();});
  document.getElementById("design-clear").addEventListener("click",function(){
    var state=window.NoodleDesign.state();
    if(state.selected&&state.selected.element) state.selected.element.ownerDocument.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));
  });
  selectToggle.addEventListener("click",function(){
    var state=window.NoodleDesign.state();
    window.NoodleDesign.setSelecting(!state.selecting);
  });
  tweaksToggle.addEventListener("click",function(){
    if(tweaksToggle.disabled) return;
    toggleTweaks();
  });
  document.addEventListener("pointerdown",function(event){
    if(tweaksToggle.getAttribute("aria-expanded")!=="true") return;
    if(tweaksPanel.contains(event.target)||tweaksToggle.contains(event.target)) return;
    closeTweaks(false,false);
  });
  document.addEventListener("keydown",function(event){
    if(event.key==="Escape"&&tweaksToggle.getAttribute("aria-expanded")==="true"){
      event.stopPropagation();
      closeTweaks(true,false);
    }
  });
  saveButton.addEventListener("click",save);
  sendButton.addEventListener("click",send);
  undoButton.addEventListener("click",function(){window.NoodleDesign.undo();});
  redoButton.addEventListener("click",function(){window.NoodleDesign.redo();});
  document.getElementById("design-copy").addEventListener("click",function(){copyInstruction(fallbackValue.value);});
  intent.addEventListener("input",function(){setDraftDirty(Boolean(window.NoodleDesign.state().selected));});
  for(var i=0;i<propertyInputs.length;i++){
    propertyInputs[i].addEventListener("input",function(){
      setDraftDirty(Boolean(window.NoodleDesign.state().selected));
      saveButton.disabled=!window.NoodleDesign.state().selected;
      preview();
    });
  }
  var pickers=document.querySelectorAll("[data-color-for]");
  for(var p=0;p<pickers.length;p++){
    pickers[p].addEventListener("input",function(){
      var input=document.querySelector('[data-design-property="'+this.dataset.colorFor+'"]');
      if(input){input.value=this.value;input.dispatchEvent(new Event("input",{bubbles:true}));}
    });
  }
  var segmentButtons=document.querySelectorAll("[data-design-segment] button");
  for(var s=0;s<segmentButtons.length;s++){
    segmentButtons[s].addEventListener("click",function(){
      var siblings=this.parentNode.querySelectorAll("button");
      for(var n=0;n<siblings.length;n++) siblings[n].setAttribute("aria-pressed",siblings[n]===this?"true":"false");
      setDraftDirty(Boolean(window.NoodleDesign.state().selected));
      preview();
    });
  }
  window.NoodleDesignUI={configure:configure,enter:enter,leave:leave,frameLoaded:frameLoaded,state:function(){return {active:ui.active};}};
})();`,
].join('\n');
