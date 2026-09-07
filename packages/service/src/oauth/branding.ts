/**
 * Shared branded shell for the authorization server's user-facing HTML pages (consent, customer sign-in,
 * error). It reproduces the public Noodle Seed website's look — the always-dark stone-950 surface, the warm
 * orange→amber→rose "Mars" ramp, a single Geist typeface, the real Noodle Seed wordmark, a frosted glass
 * card, and the site's dark-pill glow CTA — as a self-contained page (all CSS/JS inline, no build step).
 *
 * Background: the marketing hero animates a WebGL grain-gradient via `@paper-design/shaders`, but loading
 * that at runtime proved unreliable on this security page (CDN cold-build / cross-origin module fetch meant
 * it only appeared after a refresh). So these pages ship an original, dependency-free WebGL grain-gradient
 * (our own GLSL) tuned to the same warm palette, inlined as a plain script — no import/fetch, so it renders
 * on first paint every time — with an on-brand CSS radial-gradient fallback for no-WebGL. Callers pass
 * already-escaped `contentHtml`; the shell escapes the trusted static `title`/`kicker`/`heading`.
 */

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The Noodle Seed favicon (white disc + black seed-leaf) as a self-contained data URI. */
const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"><rect width="16" height="16" rx="8" fill="white"/><path d="M8.58023 12.8485C6.27833 12.8463 4.41315 11.0141 4.42117 8.75681L4.43588 4.61714L8.66254 4.62118C10.9644 4.62339 12.8296 6.45561 12.8216 8.71287C12.8135 10.9975 10.9128 12.8507 8.58023 12.8485Z" fill="black"/><path d="M8.82627 4.76869C11.1282 4.7709 12.9933 6.60312 12.9853 8.86038L12.9706 13L8.74395 12.996C6.44206 12.9938 4.57687 11.1616 4.5849 8.90432C4.59302 6.6197 6.49364 4.76646 8.82627 4.76869Z" fill="black"/><ellipse cx="3.69536" cy="3.68106" rx="0.695363" ry="0.681056" fill="black"/></svg>',
)}`;

/** The actual Noodle Seed wordmark, inlined verbatim from the site's `noodle-seed-logo.svg` (white paths). */
const WORDMARK = `<svg class="ns-logo" role="img" aria-label="Noodle Seed" viewBox="0 0 250 39" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M21.7542 38.4096C12.7805 38.401 5.5093 31.2553 5.54057 22.4521L5.59793 6.30742L22.0751 6.32319C31.0488 6.33178 38.32 13.4774 38.2887 22.2807C38.2571 31.1907 30.8477 38.4183 21.7542 38.4096Z" fill="white"/>
<path d="M22.7136 6.89786C31.6873 6.90645 38.9585 14.0521 38.9272 22.8553L38.8699 39L22.3927 38.9842C13.419 38.9756 6.14782 31.83 6.17909 23.0267C6.21074 14.1168 13.6201 6.88915 22.7136 6.89786Z" fill="white"/>
<path d="M5.42159 2.65611C5.42159 4.12303 4.20793 5.31221 2.7108 5.31221C1.21366 5.31221 0 4.12303 0 2.65611C0 1.18918 1.21366 0 2.7108 0C4.20793 0 5.42159 1.18918 5.42159 2.65611Z" fill="white"/>
<path d="M66.0046 34.7514H61.413L51.0161 19.2083V34.7514H46.4244V12.0695H51.0161L61.413 27.6451V12.0695H66.0046V34.7514Z" fill="white"/>
<path fill-rule="evenodd" clip-rule="evenodd" d="M78.6105 35.0435C76.8613 35.0435 75.287 34.6649 73.8876 33.9078C72.4882 33.129 71.3841 32.0365 70.575 30.6304C69.7879 29.2243 69.3943 27.6018 69.3943 25.763C69.3943 23.9243 69.7988 22.3018 70.6078 20.8957C71.4387 19.4896 72.5648 18.4079 73.986 17.6508C75.4072 16.872 76.9925 16.4826 78.7417 16.4826C80.4909 16.4826 82.0761 16.872 83.4973 17.6508C84.9186 18.4079 86.0337 19.4896 86.8427 20.8957C87.6736 22.3018 88.089 23.9243 88.089 25.763C88.089 26.0267 88.0802 26.2858 88.0627 26.5405C87.1071 26.6866 86.1759 27.0279 85.3346 27.565C84.9617 27.7947 84.6054 28.0624 84.271 28.3683L79.0297 33.1637L80.6152 34.8685C79.9739 34.9851 79.3057 35.0435 78.6105 35.0435ZM78.6105 31.0847C79.4413 31.0847 80.2176 30.89 80.9391 30.5006C81.6825 30.0896 82.2729 29.4839 82.7102 28.6835C83.1475 27.883 83.3661 26.9096 83.3661 25.763C83.3661 24.0541 82.907 22.7453 81.9886 21.8367C81.0922 20.9065 79.988 20.4414 78.6761 20.4414C77.3642 20.4414 76.26 20.9065 75.3635 21.8367C74.4889 22.7453 74.0516 24.0541 74.0516 25.763C74.0516 27.472 74.478 28.7916 75.3307 29.7218C76.2053 30.6304 77.2986 31.0847 78.6105 31.0847Z" fill="white"/>
<path fill-rule="evenodd" clip-rule="evenodd" d="M99.1606 33.6043L97.813 34.9139C98.3638 35.0003 98.9346 35.0435 99.5254 35.0435C101.296 35.0435 102.893 34.6649 104.314 33.9078C105.757 33.129 106.894 32.0365 107.725 30.6304C108.578 29.2243 109.004 27.6018 109.004 25.763C109.004 23.9243 108.588 22.3018 107.758 20.8957C106.949 19.4896 105.833 18.4079 104.412 17.6508C102.991 16.872 101.406 16.4826 99.6566 16.4826C97.9074 16.4826 96.3221 16.872 94.9009 17.6508C93.4797 18.4079 92.3536 19.4896 91.5228 20.8957C90.7137 22.3018 90.3092 23.9243 90.3092 25.763C90.3092 26.033 90.3177 26.2982 90.3347 26.5588C91.7444 26.7976 93.094 27.4628 94.1709 28.553L99.1606 33.6043ZM99.5254 31.0847C100.356 31.0847 101.132 30.89 101.854 30.5006C102.597 30.0896 103.188 29.4839 103.625 28.6835C104.062 27.883 104.281 26.9096 104.281 25.763C104.281 24.0541 103.822 22.7453 102.904 21.8367C102.007 20.9065 100.903 20.4414 99.591 20.4414C98.2791 20.4414 97.1749 20.9065 96.2784 21.8367C95.4038 22.7453 94.9665 24.0541 94.9665 25.763C94.9665 27.472 95.3929 28.7916 96.2456 29.7218C97.1202 30.6304 98.2135 31.0847 99.5254 31.0847Z" fill="white"/>
<path fill-rule="evenodd" clip-rule="evenodd" d="M111.191 25.6981C111.191 23.881 111.552 22.2694 112.274 20.8632C113.017 19.4571 114.023 18.3755 115.291 17.6183C116.559 16.8612 117.97 16.4826 119.522 16.4826C120.703 16.4826 121.829 16.7422 122.9 17.2614C123.972 17.7589 124.824 18.4296 125.458 19.2732V10.7391H130.116V34.7514H125.458V32.0906C124.89 32.9776 124.092 33.6914 123.064 34.2323C122.036 34.7731 120.845 35.0435 119.489 35.0435C117.959 35.0435 116.559 34.6541 115.291 33.8753C114.023 33.0965 113.017 32.0041 112.274 30.598C111.552 29.1702 111.191 27.5369 111.191 25.6981ZM125.491 25.763C125.491 24.6598 125.272 23.7188 124.835 22.94C124.398 22.1396 123.808 21.5339 123.064 21.1228C122.321 20.6902 121.523 20.4738 120.67 20.4738C119.817 20.4738 119.03 20.6794 118.308 21.0904C117.587 21.5014 116.997 22.1071 116.537 22.9075C116.1 23.6863 115.881 24.6165 115.881 25.6981C115.881 26.7798 116.1 27.7316 116.537 28.5537C116.997 29.3541 117.587 29.9706 118.308 30.4033C119.052 30.8359 119.839 31.0522 120.67 31.0522C121.523 31.0522 122.321 30.8467 123.064 30.4357C123.808 30.0031 124.398 29.3973 124.835 28.6186C125.272 27.8182 125.491 26.8663 125.491 25.763Z" fill="white"/>
<path d="M139.192 10.7391V34.7514H134.6V10.7391H139.192Z" fill="white"/>
<path fill-rule="evenodd" clip-rule="evenodd" d="M160.619 25.3737C160.619 26.0226 160.575 26.6067 160.488 27.1259H147.205C147.314 28.4239 147.773 29.4406 148.582 30.1761C149.391 30.9116 150.386 31.2794 151.567 31.2794C153.273 31.2794 154.486 30.5547 155.208 29.1053H160.16C159.635 30.8359 158.629 32.2637 157.143 33.3886C155.656 34.4918 153.83 35.0435 151.665 35.0435C149.916 35.0435 148.342 34.6649 146.943 33.9078C145.565 33.129 144.483 32.0365 143.696 30.6304C142.93 29.2243 142.548 27.6018 142.548 25.763C142.548 23.9026 142.93 22.2694 143.696 20.8632C144.461 19.4571 145.532 18.3755 146.91 17.6183C148.287 16.8612 149.873 16.4826 151.665 16.4826C153.393 16.4826 154.934 16.8504 156.29 17.5859C157.667 18.3214 158.728 19.3706 159.471 20.7334C160.237 22.0747 160.619 23.6214 160.619 25.3737ZM155.864 24.0757C155.842 22.9075 155.415 21.9773 154.584 21.2851C153.754 20.5712 152.737 20.2143 151.534 20.2143C150.397 20.2143 149.435 20.5604 148.648 21.2526C147.883 21.9232 147.413 22.8643 147.238 24.0757H155.864Z" fill="white"/>
<path d="M179.69 34.9786C178.094 34.9786 176.651 34.7082 175.361 34.1674C174.093 33.6265 173.087 32.8478 172.343 31.831C171.6 30.8143 171.217 29.6137 171.195 28.2292H176.115C176.181 29.1594 176.509 29.8949 177.099 30.4357C177.711 30.9765 178.542 31.2469 179.592 31.2469C180.663 31.2469 181.505 30.9982 182.117 30.5006C182.729 29.9814 183.035 29.3108 183.035 28.4888C183.035 27.8182 182.828 27.2665 182.412 26.8339C181.997 26.4012 181.472 26.0659 180.838 25.8279C180.226 25.5684 179.373 25.2871 178.28 24.9843C176.793 24.5516 175.579 24.1298 174.639 23.7188C173.721 23.2861 172.923 22.6479 172.245 21.8043C171.589 20.939 171.261 19.7924 171.261 18.3647C171.261 17.0234 171.6 15.8553 172.278 14.8602C172.956 13.8651 173.907 13.1079 175.131 12.5887C176.356 12.0479 177.755 11.7775 179.329 11.7775C181.691 11.7775 183.604 12.3508 185.069 13.4973C186.556 14.6222 187.376 16.2014 187.529 18.2349H182.478C182.434 17.4561 182.095 16.8179 181.461 16.3204C180.849 15.8012 180.029 15.5416 179.001 15.5416C178.105 15.5416 177.383 15.7687 176.837 16.223C176.312 16.6773 176.049 17.3371 176.049 18.2024C176.049 18.8081 176.246 19.3165 176.64 19.7275C177.055 20.1169 177.558 20.4414 178.149 20.701C178.761 20.939 179.614 21.2202 180.707 21.5447C182.194 21.9773 183.407 22.41 184.347 22.8426C185.287 23.2753 186.097 23.9243 186.774 24.7896C187.452 25.6549 187.791 26.7906 187.791 28.1967C187.791 29.4082 187.474 30.5331 186.84 31.5714C186.206 32.6098 185.277 33.4427 184.052 34.07C182.828 34.6757 181.374 34.9786 179.69 34.9786Z" fill="white"/>
<path fill-rule="evenodd" clip-rule="evenodd" d="M208.663 25.3737C208.663 26.0226 208.619 26.6067 208.531 27.1259H195.248C195.358 28.4239 195.817 29.4406 196.626 30.1761C197.435 30.9116 198.43 31.2794 199.611 31.2794C201.316 31.2794 202.529 30.5547 203.251 29.1053H208.203C207.679 30.8359 206.673 32.2637 205.186 33.3886C203.699 34.4918 201.874 35.0435 199.709 35.0435C197.96 35.0435 196.385 34.6649 194.986 33.9078C193.609 33.129 192.526 32.0365 191.739 30.6304C190.974 29.2243 190.591 27.6018 190.591 25.763C190.591 23.9026 190.974 22.2694 191.739 20.8632C192.504 19.4571 193.576 18.3755 194.953 17.6183C196.331 16.8612 197.916 16.4826 199.709 16.4826C201.436 16.4826 202.978 16.8504 204.333 17.5859C205.711 18.3214 206.771 19.3706 207.515 20.7334C208.28 22.0747 208.663 23.6214 208.663 25.3737ZM203.907 24.0757C203.885 22.9075 203.459 21.9773 202.628 21.2851C201.797 20.5712 200.78 20.2143 199.578 20.2143C198.441 20.2143 197.479 20.5604 196.692 21.2526C195.926 21.9232 195.456 22.8643 195.281 24.0757H203.907Z" fill="white"/>
<path fill-rule="evenodd" clip-rule="evenodd" d="M228.905 25.3737C228.905 26.0226 228.861 26.6067 228.774 27.1259H215.491C215.6 28.4239 216.059 29.4406 216.868 30.1761C217.677 30.9116 218.672 31.2794 219.853 31.2794C221.558 31.2794 222.772 30.5547 223.493 29.1053H228.446C227.921 30.8359 226.915 32.2637 225.428 33.3886C223.942 34.4918 222.116 35.0435 219.951 35.0435C218.202 35.0435 216.628 34.6649 215.228 33.9078C213.851 33.129 212.769 32.0365 211.981 30.6304C211.216 29.2243 210.833 27.6018 210.833 25.763C210.833 23.9026 211.216 22.2694 211.981 20.8632C212.747 19.4571 213.818 18.3755 215.196 17.6183C216.573 16.8612 218.158 16.4826 219.951 16.4826C221.679 16.4826 223.22 16.8504 224.576 17.5859C225.953 18.3214 227.014 19.3706 227.757 20.7334C228.522 22.0747 228.905 23.6214 228.905 25.3737ZM224.149 24.0757C224.127 22.9075 223.701 21.9773 222.87 21.2851C222.039 20.5712 221.023 20.2143 219.82 20.2143C218.683 20.2143 217.721 20.5604 216.934 21.2526C216.169 21.9232 215.698 22.8643 215.524 24.0757H224.149Z" fill="white"/>
<path fill-rule="evenodd" clip-rule="evenodd" d="M231.076 25.6981C231.076 23.881 231.437 22.2694 232.158 20.8632C232.901 19.4571 233.907 18.3755 235.175 17.6183C236.444 16.8612 237.854 16.4826 239.406 16.4826C240.587 16.4826 241.713 16.7422 242.785 17.2614C243.856 17.7589 244.709 18.4296 245.343 19.2732V10.7391H250V34.7514H245.343V32.0906C244.774 32.9776 243.976 33.6914 242.949 34.2323C241.921 34.7731 240.729 35.0435 239.374 35.0435C237.843 35.0435 236.444 34.6541 235.175 33.8753C233.907 33.0965 232.901 32.0041 232.158 30.598C231.437 29.1702 231.076 27.5369 231.076 25.6981ZM245.376 25.763C245.376 24.6598 245.157 23.7188 244.72 22.94C244.282 22.1396 243.692 21.5339 242.949 21.1228C242.205 20.6902 241.407 20.4738 240.554 20.4738C239.702 20.4738 238.914 20.6794 238.193 21.0904C237.471 21.5014 236.881 22.1071 236.422 22.9075C235.984 23.6863 235.766 24.6165 235.766 25.6981C235.766 26.7798 235.984 27.7316 236.422 28.5537C236.881 29.3541 237.471 29.9706 238.193 30.4033C238.936 30.8359 239.723 31.0522 240.554 31.0522C241.407 31.0522 242.205 30.8467 242.949 30.4357C243.692 30.0031 244.282 29.3973 244.72 28.6186C245.157 27.8182 245.376 26.8663 245.376 25.763Z" fill="white"/>
</svg>`;

/**
 * Original, dependency-free WebGL grain-gradient (our own GLSL) tuned to the warm hero palette. It runs as a
 * plain inline script with no import/fetch, so it renders on first paint every time (no CDN, no cold build,
 * no cross-origin module load) and sizes the canvas to the viewport each frame. CSS .ns-bg is the no-WebGL
 * fallback; .ns-bottom adds the warm bottom blob over it.
 */
const SHADER_SCRIPT = `<script>
(function () {
  var canvas = document.getElementById('ns-canvas');
  if (!canvas) return;
  var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  if (!gl) return;
  var vs = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}';
  var fs = [
    'precision highp float;',
    'uniform vec2 u_res; uniform float u_time;',
    'float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }',
    'float noise(vec2 p){ vec2 i=floor(p),f=fract(p); float a=hash(i),b=hash(i+vec2(1.,0.)),c=hash(i+vec2(0.,1.)),d=hash(i+vec2(1.,1.)); vec2 u=f*f*(3.-2.*f); return mix(mix(a,b,u.x),mix(c,d,u.x),u.y); }',
    'float fbm(vec2 p){ float v=0.,a=0.5; mat2 m=mat2(1.6,1.2,-1.2,1.6); for(int i=0;i<5;i++){ v+=a*noise(p); p=m*p; a*=0.5; } return v; }',
    'void main(){',
    '  vec2 uv=gl_FragCoord.xy/u_res.xy;',
    '  float aspect=u_res.x/max(u_res.y,1.0);',
    '  vec2 p=vec2(uv.x*aspect,uv.y);',
    '  float t=u_time*0.045;',
    '  vec2 q=vec2(fbm(p*1.6+t),fbm(p*1.6-t+5.2));',
    '  float n=fbm(p*2.1+q*1.4);',
    '  vec3 orange=vec3(0.976,0.451,0.086), amber=vec3(0.961,0.620,0.043), rose=vec3(0.957,0.247,0.369);',
    '  vec3 warm=orange;',
    '  warm=mix(warm,amber,smoothstep(0.34,0.52,n));',
    '  warm=mix(warm,rose,smoothstep(0.60,0.82,n));',
    '  float d=distance(uv,vec2(0.80,0.86));',
    '  float glow=smoothstep(1.20,0.10,d);',
    '  float field=glow*(0.45+0.55*n);',
    '  vec3 col=mix(vec3(0.015,0.012,0.010),warm,clamp(field,0.0,1.0)*0.92);',
    '  col+=(hash(gl_FragCoord.xy+t*60.0)-0.5)*0.045;',
    '  gl_FragColor=vec4(max(col,0.0),1.0);',
    '}'
  ].join('\\n');
  function sh(type, src){ var s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s); return s; }
  var prog=gl.createProgram();
  gl.attachShader(prog,sh(gl.VERTEX_SHADER,vs));
  gl.attachShader(prog,sh(gl.FRAGMENT_SHADER,fs));
  gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog,gl.LINK_STATUS)) return;
  gl.useProgram(prog);
  var buf=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,buf);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  var loc=gl.getAttribLocation(prog,'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
  var uRes=gl.getUniformLocation(prog,'u_res'), uTime=gl.getUniformLocation(prog,'u_time');
  var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var start=null;
  function frame(ts){
    if(start===null)start=ts;
    var dpr=Math.min(window.devicePixelRatio||1,2);
    var w=Math.max(1,Math.round(canvas.clientWidth*dpr)), h=Math.max(1,Math.round(canvas.clientHeight*dpr));
    if(canvas.width!==w||canvas.height!==h){ canvas.width=w; canvas.height=h; }
    gl.viewport(0,0,canvas.width,canvas.height);
    gl.uniform2f(uRes,canvas.width,canvas.height);
    gl.uniform1f(uTime,(ts-start)/1000);
    gl.drawArrays(gl.TRIANGLES,0,3);
    if(!reduce) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
</script>`;

/** The self-contained stylesheet — website tokens, shader canvas + CSS fallback, glass card, glow CTA. */
const STYLES = `
*,*::before,*::after{box-sizing:border-box}
@property --ns-angle{syntax:'<angle>';initial-value:0deg;inherits:false}
:root{
  --bg:#0c0a09;--fg:#fafaf9;--muted:#a1a1a1;
  --card:rgba(23,23,23,.55);--border:rgba(255,255,255,.10);
  --orange:#F97316;--amber:#F59E0B;--rose:#F43F5E;
  color-scheme:dark;
}
html,body{height:100%}
body{
  margin:0;min-height:100dvh;background:var(--bg);color:var(--fg);
  font-family:"Geist",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  display:flex;justify-content:center;align-items:flex-start;padding:24px;position:relative;overflow:auto;
}
/* WebGL grain-gradient canvas over an on-brand CSS radial-gradient fallback. */
.ns-canvas{position:fixed;inset:0;width:100%;height:100%;z-index:-4;display:block;pointer-events:none}
.ns-bg{position:fixed;inset:-25%;z-index:-5;background:
  radial-gradient(46% 46% at 74% 16%,rgba(249,115,22,.55),rgba(244,63,94,.28) 46%,transparent 72%),
  radial-gradient(42% 42% at 18% 84%,rgba(245,158,11,.30),transparent 66%),#000}
/* Warm blob hugging the full bottom edge, screen-blended over the shader. */
.ns-bottom{position:fixed;left:0;right:0;bottom:0;height:46vh;z-index:-3;pointer-events:none;mix-blend-mode:screen;
  background:radial-gradient(92% 78% at 50% 128%,rgba(249,115,22,.62),rgba(244,63,94,.30) 44%,transparent 65%)}
.ns-grain{position:fixed;inset:0;z-index:-2;pointer-events:none;opacity:.045;mix-blend-mode:overlay;
  background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
.ns-scrim{position:fixed;inset:0;z-index:-1;pointer-events:none;
  background:radial-gradient(120% 80% at 50% 0%,transparent 0%,rgba(12,10,9,.45) 72%,var(--bg) 100%)}
.ns-card{
  position:relative;width:min(100% - 8px,28rem);
  border:1px solid var(--border);border-radius:1.1rem;background:var(--card);
  -webkit-backdrop-filter:blur(16px) saturate(1.2);backdrop-filter:blur(16px) saturate(1.2);
  padding:1.9rem;
  margin:auto 0;
  box-shadow:0 30px 90px -45px rgba(0,0,0,.9),0 0 0 1px rgba(255,255,255,.02),inset 0 1px 0 0 rgba(255,255,255,.06);
}
.ns-head{display:flex;align-items:center;margin-bottom:1.6rem}
.ns-logo{height:20px;width:auto;display:block;filter:drop-shadow(0 2px 12px rgba(0,0,0,.5))}
.ns-kicker{
  display:flex;align-items:center;gap:.5rem;margin:0 0 .5rem;
  font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.16em;color:var(--muted);
}
.ns-kicker::before{content:"";width:1.4rem;height:1px;background:linear-gradient(100deg,var(--orange),var(--amber) 50%,var(--rose))}
.ns-title{font-weight:600;font-size:clamp(1.05rem,4.2vw,1.35rem);line-height:1.2;letter-spacing:-.02em;margin:.1rem 0 .9rem;color:var(--fg);white-space:nowrap}
.ns-lede{color:var(--muted);line-height:1.55;margin:0;font-size:.95rem}
.ns-lede strong{color:var(--fg);font-weight:600}
.ns-error{color:#fca5a5}
.ns-dl{display:grid;gap:.9rem;margin:1.35rem 0 0}
.ns-dt{margin:0 0 .2rem;font-size:.68rem;font-weight:500;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}
.ns-dd{margin:0;font-size:.95rem;font-weight:500;color:var(--fg);word-break:break-all}
.ns-note{color:var(--muted);font-size:.82rem;line-height:1.5;margin:1.35rem 0 0;padding-top:1.15rem;border-top:1px solid var(--border)}
.ns-row{display:flex;gap:.7rem;margin-top:1.5rem}
.btn{
  flex:1;display:inline-flex;align-items:center;justify-content:center;gap:.5rem;
  height:2.9rem;padding:0 1.25rem;border-radius:9999px;border:1px solid transparent;
  font:inherit;font-weight:600;font-size:.95rem;cursor:pointer;color:var(--fg);
  transition:transform .2s,border-color .2s,background .2s,box-shadow .2s;
}
.btn:focus-visible{outline:2px solid var(--orange);outline-offset:2px}
.btn-ghost{background:rgba(255,255,255,.02);border-color:var(--border)}
.btn-ghost:hover{background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.2)}
.btn-glow{position:relative;flex:1;display:flex;border-radius:9999px}
.btn-glow::before{
  content:"";position:absolute;inset:-2px;z-index:0;border-radius:inherit;
  background:conic-gradient(from var(--ns-angle),var(--orange),var(--amber),var(--rose),var(--orange));
  filter:blur(7px);opacity:.7;animation:ns-rotate 4.5s linear infinite;
}
.btn-glow:hover::before{opacity:.95}
.btn-glow .btn{position:relative;z-index:1;width:100%}
.btn-primary{background:#0c0a09;color:#fff;outline:1px solid rgba(255,255,255,.14);box-shadow:inset 0 1px 0 0 rgba(255,255,255,.08)}
.btn-primary:hover{transform:translateY(-1px)}
.btn:disabled{cursor:not-allowed;opacity:.55;transform:none}
@keyframes ns-rotate{to{--ns-angle:360deg}}
@media (prefers-reduced-motion:reduce){.btn-glow::before{animation:none}}`;

export interface OAuthPageInput {
  /** Document title (also used for the SEO/tab title). */
  readonly title: string;
  /** Small uppercase eyebrow above the headline (e.g. "Authorize"). */
  readonly kicker: string;
  /** The headline. */
  readonly heading: string;
  /** Pre-escaped inner HTML (lede, detail list, form). Callers own their own escaping. */
  readonly contentHtml: string;
  /** Optional trusted static CSS appended after the shared OAuth styles. */
  readonly additionalStyles?: string;
  /** Optional pre-built `<script>` block appended before `</body>` (e.g. the customer sign-in module). */
  readonly scriptHtml?: string;
}

/** Render one branded authorization-server page around caller-supplied, already-escaped content. */
export function renderOAuthPage(input: OAuthPageInput): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#0c0a09" />
<meta name="robots" content="noindex" />
<title>${esc(input.title)}</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>${STYLES}${input.additionalStyles ?? ''}</style>
</head>
<body>
<canvas id="ns-canvas" class="ns-canvas" aria-hidden="true"></canvas>
<div class="ns-bg" aria-hidden="true"></div>
<div class="ns-bottom" aria-hidden="true"></div>
<div class="ns-grain" aria-hidden="true"></div>
<div class="ns-scrim" aria-hidden="true"></div>
<main class="ns-card">
  <div class="ns-head">${WORDMARK}</div>
  <p class="ns-kicker">${esc(input.kicker)}</p>
  <h1 class="ns-title">${esc(input.heading)}</h1>
  ${input.contentHtml}
</main>
${SHADER_SCRIPT}
${input.scriptHtml ?? ''}
</body>
</html>`;
}

/** A branded 500/error interstitial for the authorization-server catch handler. */
export function renderOAuthErrorPage(): string {
  return renderOAuthPage({
    title: 'Sign-in error — Noodle Seed',
    kicker: 'Error',
    heading: 'We hit a snag',
    contentHtml:
      '<p class="ns-lede">The sign-in request could not be completed. Close this window and start again from your application.</p>',
  });
}
