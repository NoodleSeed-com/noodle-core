import { DESIGN_STYLE_PROPERTIES } from './devtools-design-contract.js';

/**
 * Same-origin browser helper for capturing privacy-safe widget element evidence and resolving it after
 * reload. Kept dependency-free so it can run inside the classic devtools harness and widget iframe.
 */
export const DEVTOOLS_DESIGN_ELEMENT_CLIENT_JS = `
(function(){
  var STYLE_PROPERTIES=${JSON.stringify(DESIGN_STYLE_PROPERTIES)};
  var RESOLVE_THRESHOLD=55;
  var GENERATED_ID=/^(?::r\\d+:|react[-_:]|radix[-_:]|headlessui[-_:]|[a-f0-9]{12,}|[A-Za-z_-]*\\d{7,})$/i;
  var INTERACTIVE_TAGS={button:"button",a:"link",textarea:"textbox",select:"combobox"};

  function clean(value,max){
    if(typeof value!=="string") return "";
    return value.replace(/\\s+/g," ").trim().slice(0,max||160);
  }
  function stableId(value){
    var id=clean(value,120);
    return id&&!GENERATED_ID.test(id)?id:undefined;
  }
  function visibleText(element){
    var parts=[];
    function visit(node){
      if(node.nodeType===3){ parts.push(node.nodeValue||""); return; }
      if(node.nodeType!==1) return;
      var current=node;
      var tag=(current.tagName||"").toLowerCase();
      if(tag==="script"||tag==="style"||tag==="template"||current.hidden||current.getAttribute("aria-hidden")==="true") return;
      var style=current.ownerDocument&&current.ownerDocument.defaultView
        ? current.ownerDocument.defaultView.getComputedStyle(current)
        : null;
      if(style&&(style.display==="none"||style.visibility==="hidden")) return;
      for(var i=0;i<current.childNodes.length;i++) visit(current.childNodes[i]);
    }
    visit(element);
    return clean(parts.join(" "),160);
  }
  function roleFor(element){
    var explicit=clean(element.getAttribute("role")||"",80);
    if(explicit) return explicit;
    var tag=(element.tagName||"").toLowerCase();
    if(tag==="input"){
      var type=(element.getAttribute("type")||"text").toLowerCase();
      if(type==="button"||type==="submit"||type==="reset") return "button";
      if(type==="checkbox") return "checkbox";
      if(type==="radio") return "radio";
      if(type==="range") return "slider";
      return "textbox";
    }
    return INTERACTIVE_TAGS[tag];
  }
  function accessibleName(element){
    var labelled=clean(element.getAttribute("aria-label")||"",160);
    if(labelled) return labelled;
    var labelledBy=element.getAttribute("aria-labelledby");
    if(labelledBy&&element.ownerDocument){
      var label=element.ownerDocument.getElementById(labelledBy);
      var labelText=label?visibleText(label):"";
      if(labelText) return labelText;
    }
    var text=visibleText(element);
    return text||undefined;
  }
  function classNames(element){
    return Array.prototype.slice.call(element.classList||[])
      .map(function(item){return clean(item,120);})
      .filter(Boolean)
      .sort()
      .slice(0,20);
  }
  function authorHints(element){
    var result={};
    var testId=clean(element.getAttribute("data-testid")||"",160);
    var test=clean(element.getAttribute("data-test")||"",160);
    var component=clean(element.getAttribute("data-component")||"",160);
    if(testId) result.testId=testId;
    if(test) result.test=test;
    if(component) result.component=component;
    return result;
  }
  function nthOfType(element){
    var index=1;
    var sibling=element.previousElementSibling;
    while(sibling){
      if(sibling.tagName===element.tagName) index++;
      sibling=sibling.previousElementSibling;
    }
    return index;
  }
  function segment(element){
    var result={
      tagName:(element.tagName||"").toLowerCase(),
      classNames:classNames(element),
      nthOfType:nthOfType(element)
    };
    var role=roleFor(element);
    var id=stableId(element.id);
    if(role) result.role=role;
    if(id) result.stableId=id;
    return result;
  }
  function ancestry(element){
    var result=[];
    var current=element.parentElement;
    while(current&&result.length<6&&current!==element.ownerDocument.documentElement){
      result.unshift(segment(current));
      current=current.parentElement;
    }
    return result;
  }
  function computedStyles(element){
    var result={};
    var view=element.ownerDocument&&element.ownerDocument.defaultView;
    var style=view?view.getComputedStyle(element):null;
    for(var i=0;i<STYLE_PROPERTIES.length;i++){
      var property=STYLE_PROPERTIES[i];
      var value=style?style.getPropertyValue(property):"";
      if(value) result[property]=clean(value,500);
    }
    return result;
  }
  function siblingIndex(element){
    return element.parentElement
      ? Array.prototype.indexOf.call(element.parentElement.children,element)
      : 0;
  }
  function capture(element){
    var rect=element.getBoundingClientRect();
    var result={
      tagName:(element.tagName||"").toLowerCase(),
      classNames:classNames(element),
      authorHints:authorHints(element),
      ancestry:ancestry(element),
      siblingIndex:siblingIndex(element),
      siblingCount:element.parentElement?element.parentElement.children.length:1,
      rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
      computedStyles:computedStyles(element),
      resolution:{confidence:100,evidence:["captured in current widget"],status:"resolved"}
    };
    var role=roleFor(element);
    var name=accessibleName(element);
    var text=visibleText(element);
    var id=stableId(element.id);
    if(role) result.role=role;
    if(name) result.accessibleName=name;
    if(text) result.visibleText=text;
    if(id) result.stableId=id;
    return result;
  }
  function hintsMatch(element,hints){
    if(!hints) return false;
    return Boolean(
      (hints.testId&&element.getAttribute("data-testid")===hints.testId)||
      (hints.test&&element.getAttribute("data-test")===hints.test)||
      (hints.component&&element.getAttribute("data-component")===hints.component)
    );
  }
  function ancestryScore(element,expected){
    if(!Array.isArray(expected)||expected.length===0) return 0;
    var actual=ancestry(element);
    var matches=0;
    var limit=Math.min(actual.length,expected.length);
    for(var i=1;i<=limit;i++){
      var left=actual[actual.length-i];
      var right=expected[expected.length-i];
      if(!left||!right||left.tagName!==right.tagName) break;
      matches++;
      if(right.stableId&&left.stableId===right.stableId) matches++;
      if(right.role&&left.role===right.role) matches++;
    }
    return Math.min(15,Math.round((matches/Math.max(1,expected.length))*15));
  }
  function scored(element,fingerprint){
    var score=0,evidence=[];
    if(fingerprint.stableId&&stableId(element.id)===fingerprint.stableId){
      score+=40; evidence.push("stable id");
    }
    if(hintsMatch(element,fingerprint.authorHints)){
      score+=30; evidence.push("author hint");
    }
    var role=roleFor(element);
    var name=accessibleName(element);
    if(fingerprint.role&&role===fingerprint.role&&fingerprint.accessibleName&&name===fingerprint.accessibleName){
      score+=20; evidence.push("role and accessible name");
    }else if(fingerprint.role&&role===fingerprint.role){
      score+=8; evidence.push("semantic role");
    }
    var text=visibleText(element);
    if(fingerprint.visibleText&&text===fingerprint.visibleText){
      score+=15; evidence.push("visible text");
    }
    var tree=ancestryScore(element,fingerprint.ancestry);
    if(tree){ score+=tree; evidence.push("ancestry"); }
    if(Number(fingerprint.siblingIndex)===siblingIndex(element)){
      score+=5; evidence.push("sibling position");
    }
    return {element:element,confidence:Math.min(100,score),evidence:evidence};
  }
  function candidates(doc,fingerprint){
    var pool=[];
    if(fingerprint&&fingerprint.stableId){
      var escapeValue=doc.defaultView&&doc.defaultView.CSS&&doc.defaultView.CSS.escape
        ? doc.defaultView.CSS.escape(fingerprint.stableId)
        : fingerprint.stableId.replace(/[^a-zA-Z0-9_-]/g,"\\\\$&");
      try{
        var exact=doc.querySelector("#"+escapeValue);
        if(exact){
          var exactScore=scored(exact,fingerprint||{});
          if(exactScore.confidence>=RESOLVE_THRESHOLD) return [exactScore];
          pool.push(exact);
        }
      }catch(error){}
    }
    var nodes=doc.querySelectorAll(fingerprint&&fingerprint.tagName?fingerprint.tagName:"*");
    for(var i=0;i<nodes.length;i++) if(pool.indexOf(nodes[i])<0) pool.push(nodes[i]);
    return pool.map(function(element){return scored(element,fingerprint||{});})
      .sort(function(a,b){return b.confidence-a.confidence;});
  }
  function resolve(doc,fingerprint){
    var ranked=candidates(doc,fingerprint);
    var best=ranked[0];
    var second=ranked[1];
    if(!best||best.confidence<RESOLVE_THRESHOLD){
      return {element:null,confidence:best?best.confidence:0,evidence:best?best.evidence:[],reason:"not_found"};
    }
    if(second&&best.confidence-second.confidence<10){
      return {element:null,confidence:best.confidence,evidence:best.evidence,reason:"ambiguous"};
    }
    return best;
  }
  window.NoodleDesignElement={capture:capture,candidates:candidates,resolve:resolve};
})();`;
