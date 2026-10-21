import http from 'node:http';
import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {HttpError} from './paths.mjs';

const HTML_LIMIT=512*1024,JSON_LIMIT=128*1024;
const REDIRECTS=new Set([301,302,303,307,308]);
const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',hellip:'…',ndash:'–',mdash:'—',rsquo:'’',lsquo:'‘',ldquo:'“',rdquo:'”',copy:'©'};
function decode(value){return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi,(match,key)=>{
  if(key[0]!=='#')return entities[key.toLowerCase()]??match;
  const code=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));
  return code>0&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):'';
});}
function plain(value,max=2000){return typeof value==='string'?decode(value).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,' ').replace(/<[^>]*>/g,' ').replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max):'';}
function parseUrl(value){
  if(typeof value!=='string'||value.length>8192||/[\u0000-\u0020\u007f]/.test(value.trim()))throw new HttpError(400,'Provide a valid HTTP(S) URL.');
  let url;try{url=new URL(value.trim());}catch{throw new HttpError(400,'Provide a valid HTTP(S) URL.');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new HttpError(400,'Provide an HTTP(S) URL without credentials.');
  return url;
}
function hostname(url){return url.hostname.replace(/^\[|\]$/g,'').toLowerCase();}
function ipv6Number(address){
  const sides=address.toLowerCase().split('::');
  const left=sides[0]?sides[0].split(':'):[],right=sides[1]?sides[1].split(':'):[];
  const parts=sides.length===2?[...left,...Array(8-left.length-right.length).fill('0'),...right]:left;
  return parts.reduce((value,part)=>(value<<16n)|BigInt(`0x${part}`),0n);
}
function inV6(value,prefix,bits){return value>>BigInt(128-bits)===ipv6Number(prefix)>>BigInt(128-bits);}
export function isPublicAddress(address){
  if(isIP(address)===4){
    const [a,b,c]=address.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||a===100&&b>=64&&b<=127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0&&c<=2||b===88&&c===99)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
  }
  if(isIP(address)!==6||address.includes('.')||address.includes('%'))return false;
  const value=ipv6Number(address);
  // Only global unicast, excluding IETF special-use, documentation and 6to4.
  return inV6(value,'2000::',3)&&!inV6(value,'2001::',23)&&!inV6(value,'2001:db8::',32)&&!inV6(value,'2002::',16)&&!inV6(value,'3fff::',20);
}
async function publicTarget(url,resolver,signal){
  signal.throwIfAborted();
  const host=hostname(url);
  if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||!host.includes('.')&&!isIP(host))throw new Error('Non-public host.');
  const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await resolver(host,{all:true,verbatim:true});
  signal.throwIfAborted();
  if(!Array.isArray(addresses)||!addresses.length||addresses.some(record=>!isPublicAddress(record.address)))throw new Error('Non-public address.');
  const {address}=addresses[0];return {address,family:isIP(address)};
}
function requestDocument(url,{address,family,signal,maxBytes,kind}){
  return new Promise((resolve,reject)=>{
    const request=(url.protocol==='https:'?https:http).request(url,{
      method:'GET',agent:false,signal,maxHeaderSize:16384,
      lookup:(_host,options,callback)=>options?.all?callback(null,[{address,family}]):callback(null,address,family),
      headers:{'User-Agent':'Tinka-Link-Preview/1.0','Accept':kind==='json'?'application/json':'text/html, application/xhtml+xml','Accept-Encoding':'identity'}
    },response=>{
      const headers=response.headers,status=response.statusCode;
      if(REDIRECTS.has(status)){resolve({status,headers,body:''});response.destroy();return;}
      const contentType=String(headers['content-type']||'').split(';')[0].trim().toLowerCase();
      const allowed=kind==='json'?['application/json','text/json']:['text/html','application/xhtml+xml'];
      if(status!==200||!allowed.includes(contentType)||headers['content-encoding']&&headers['content-encoding']!=='identity'||Number(headers['content-length'])>maxBytes){response.destroy();reject(new Error('Unsupported preview response.'));return;}
      let size=0;const chunks=[];
      response.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){response.destroy(new Error('Preview response too large.'));return;}chunks.push(chunk);});
      response.once('error',reject);
      response.once('end',()=>resolve({status,headers,body:Buffer.concat(chunks).toString('utf8')}));
    });
    request.once('error',reject);request.end();
  });
}
function attributes(tag){
  const result={};
  for(const match of tag.matchAll(/([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g))result[match[1].toLowerCase()]=decode(match[2]??match[3]??match[4]??'');
  return result;
}
function metadata(html){
  const meta={},links=[];
  // Ignore fake metadata inside scripts/comments; HTML is parsed as data only.
  const source=html.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
  for(const match of source.matchAll(/<(meta|link)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)){
    const attrs=attributes(match[0]);
    if(match[1].toLowerCase()==='link')links.push(attrs);
    else{const key=(attrs.property||attrs.name||'').toLowerCase();if(key&&!meta[key])meta[key]=attrs.content||'';}
  }
  return {title:plain(meta['og:title']||meta['twitter:title']||source.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1],300),description:plain(meta['og:description']||meta['twitter:description']||meta.description),siteName:plain(meta['og:site_name'],120),author:plain(meta.author||meta['twitter:creator'],160),image:meta['og:image:secure_url']||meta['og:image']||meta['twitter:image']||meta['twitter:image:src'],oembed:links.find(link=>link.rel?.toLowerCase().split(/\s+/).includes('alternate')&&link.type?.toLowerCase()==='application/json+oembed')?.href};
}
function knownOembed(url){
  if(!['twitter.com','www.twitter.com','x.com','www.x.com','mobile.twitter.com'].includes(hostname(url))||!/^\/[^/]+\/status\/\d+\/?$/.test(url.pathname))return null;
  return `https://publish.twitter.com/oembed?omit_script=true&dnt=true&url=${encodeURIComponent(url.href)}`;
}
function oembedMetadata(data){
  if(!data||typeof data!=='object'||Array.isArray(data))return {};
  // Tweet text is useful; no embed markup, script or iframe is ever returned.
  const quote=typeof data.html==='string'?data.html.match(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/i)?.[1]:'';
  const text=plain(quote);
  return {title:plain(data.title,300)||(text?text.slice(0,300):''),description:plain(data.description)||text,siteName:plain(data.provider_name,120),author:plain(data.author_name,160),image:typeof data.thumbnail_url==='string'?data.thumbnail_url:undefined};
}

/** One explicit paste request; never called by ordinary board reads. */
export async function createLinkPreview(input,{resolver=lookup,transport=requestDocument,timeoutMs=6000}={}){
  const original=parseUrl(input),host=hostname(original);
  const fallback={url:original.href,title:`${host}${original.pathname==='/'?'':original.pathname}`.slice(0,300),description:'',siteName:host};
  const controller=new AbortController(),{signal}=controller;
  let timer;
  const deadline=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(fallback);},timeoutMs);});
  async function fetchDocument(value,kind='html'){
    let url=parseUrl(value);
    for(let redirects=0;redirects<=3;redirects++){
      const target=await publicTarget(url,resolver,signal);
      const maxBytes=kind==='json'?JSON_LIMIT:HTML_LIMIT;
      const response=await transport(url,{...target,signal,maxBytes,kind});
      signal.throwIfAborted();
      if(REDIRECTS.has(response.status)){
        if(redirects===3||typeof response.headers?.location!=='string')throw new Error('Preview redirect limit.');
        url=parseUrl(new URL(response.headers.location,url).href);continue;
      }
      const type=String(response.headers?.['content-type']||'').split(';')[0].trim().toLowerCase();
      if(response.status!==200||!(kind==='json'?['application/json','text/json']:['text/html','application/xhtml+xml']).includes(type)||response.headers?.['content-encoding']&&response.headers['content-encoding']!=='identity'||typeof response.body!=='string'||Buffer.byteLength(response.body)>maxBytes||Number(response.headers?.['content-length'])>maxBytes)throw new Error('Unsupported preview response.');
      return {url,body:response.body};
    }
  }
  const work=(async()=>{
    let page,meta={};
    try{page=await fetchDocument(original.href);meta=metadata(page.body);}catch{}
    const known=knownOembed(original);
    // Auth/interstitial metadata is not tweet content. oEmbed can still supply it.
    if(/^(?:log\s?in|sign\s?(?:in|up)|javascript (?:is |required|disabled))/i.test(meta.title||'')||known&&(!meta.description||/^(?:x|twitter)(?:\s*[|/–—-].*)?$/i.test(meta.title||'')))meta={};
    let endpoint=known;
    if(!endpoint&&meta.oembed)try{endpoint=new URL(meta.oembed,page.url).href;}catch{}
    if(endpoint)try{
      const response=await fetchDocument(endpoint,'json'),extra=oembedMetadata(JSON.parse(response.body));
      meta={...meta,...Object.fromEntries(Object.entries(extra).filter(([,value])=>value))};
    }catch{}
    let image;
    if(meta.image)try{const imageUrl=parseUrl(new URL(meta.image,page?.url||original).href);await publicTarget(imageUrl,resolver,signal);image=imageUrl.href;}catch{}
    return {...fallback,...Object.fromEntries(['title','description','siteName','author'].filter(key=>meta[key]).map(key=>[key,meta[key]])),...(image?{image}:{})};
  })().catch(()=>fallback);
  try{return await Promise.race([work,deadline]);}finally{clearTimeout(timer);controller.abort();}
}
