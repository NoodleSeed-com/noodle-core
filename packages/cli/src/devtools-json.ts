/** Syntax colours for structured output in preview, chat tool calls, and the MCP activity rail. */
export const DEVTOOLS_JSON_STYLES = String.raw`
.json-key{color:#F97316}
.json-string{color:#F5C0A8}
.json-number{color:#F59E0B}
.json-literal{color:#F43F5E}
.json-punctuation{color:#7C7470}
.json-fallback{color:#EDE8E6}
.json-error{color:#FB7185}
`;

/**
 * A dependency-free JSON renderer for the classic devtools client.
 *
 * Values are first serialized with native JSON formatting, then lexed into text-only spans. Tool data
 * never reaches `innerHTML`, so strings such as `</script>` and `<img onerror=…>` remain inert output.
 */
export const DEVTOOLS_JSON_CLIENT_JS = [
  'function jsonSource(value){ if(typeof value==="string"){ var trimmed=value.trim(); if((trimmed.charAt(0)==="{"&&trimmed.charAt(trimmed.length-1)==="}")||(trimmed.charAt(0)==="["&&trimmed.charAt(trimmed.length-1)==="]")){ try{return JSON.stringify(JSON.parse(value),null,2);}catch(e){} } return value; } try{ var encoded=JSON.stringify(value,null,2); return encoded===undefined?String(value):encoded; }catch(e){ return String(value); } }',
  'function jsonClass(token,source,end){ if(token.charAt(0)==="\\""){ return /^\\s*:/.test(source.slice(end))?"json-key":"json-string"; } if(/^-?\\d/.test(token)) return "json-number"; if(/^(true|false|null)$/.test(token)) return "json-literal"; return "json-punctuation"; }',
  'function appendJsonText(parent,text,cls){ if(!text) return; if(!cls){ parent.appendChild(document.createTextNode(text)); return; } var span=document.createElement("span"); span.className=cls; span.textContent=text; parent.appendChild(span); }',
  'function renderJson(pre,value){ var source=jsonSource(value); var pattern=/"(?:\\\\.|[^"\\\\])*"|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?|\\b(?:true|false|null)\\b|[{}\\[\\],:]/g; var fragment=document.createDocumentFragment(); var cursor=0; var match; while((match=pattern.exec(source))!==null){ appendJsonText(fragment,source.slice(cursor,match.index),""); appendJsonText(fragment,match[0],jsonClass(match[0],source,pattern.lastIndex)); cursor=pattern.lastIndex; } appendJsonText(fragment,source.slice(cursor),""); pre.replaceChildren(fragment); pre.setAttribute("aria-label","JSON output"); }',
].join('\n');
