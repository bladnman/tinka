import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createLinkPreview,isPublicAddress} from '../lib/link-preview.mjs';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {listen,closeAppServer} from '../server.mjs';

const publicIp='93.184.216.34';
const html=body=>({status:200,headers:{'content-type':'text/html; charset=utf-8'},body});
const json=data=>({status:200,headers:{'content-type':'application/json'},body:JSON.stringify(data)});
function fixture(routes,resolver=async()=>[{address:publicIp,family:4}]){
  const calls=[];
  return {calls,options:{resolver,transport:async(url,options)=>{calls.push({url:url.href,...options});const response=routes[url.href];if(response instanceof Error)throw response;return response||{status:404,headers:{},body:''};}}};
}

test('metadata prefers Open Graph, decodes text, resolves image and ignores scripts',async()=>{
  const f=fixture({'https://example.com/article#section':html(`<!-- <meta property="og:title" content="Comment"> --><script>const x='<meta property="og:title" content="Fake">';</script><title>Fallback</title><meta content='A &amp; B' property='og:title'><meta name="description" content="Ordinary"><meta property="og:description" content="Useful &quot;description&quot;"><meta property="og:site_name" content="Example"><meta property="og:image" content="/art.png"><meta name="author" content="An Author">`)});
  assert.deepEqual(await createLinkPreview('https://example.com/article#section',f.options),{url:'https://example.com/article#section',title:'A & B',description:'Useful "description"',siteName:'Example',author:'An Author',image:'https://example.com/art.png'});
  assert.equal(f.calls.length,1,'image metadata never downloads an image');
  assert.equal(f.calls[0].address,publicIp);assert.equal(f.calls[0].family,4);assert.equal(f.calls[0].maxBytes,512*1024);
});

test('Twitter cards and title/meta description produce useful capped plain data',async()=>{
  const f=fixture({'https://example.com/':html('<title>Page &#x1f680;</title><meta name="description" content="A small summary"><meta name="twitter:title" content="Card title"><meta name="twitter:description" content="Card summary"><meta name="twitter:image" content="https://cdn.example.com/card.jpg">')});
  const result=await createLinkPreview('https://example.com',f.options);
  assert.equal(result.title,'Card title');assert.equal(result.description,'Card summary');assert.equal(result.image,'https://cdn.example.com/card.jpg');
  f.options.transport=async()=>html(`<title>${'a'.repeat(400)}</title><meta name="description" content="${'b'.repeat(2200)}">`);
  const capped=await createLinkPreview('https://example.com/',f.options);assert.equal(capped.title.length,300);assert.equal(capped.description.length,2000);
});

test('discovered JSON oEmbed yields metadata without exposing HTML or executing scripts',async()=>{
  const f=fixture({'https://example.com/story':html('<title>Page title</title><link href="/embed.json" type="application/json+oembed" rel="alternate">'),'https://example.com/embed.json':json({type:'rich',title:'Embedded story',author_name:'Writer',provider_name:'Publisher',thumbnail_url:'https://images.example.com/story.png',html:'<iframe src="http://localhost/secret"></iframe><script>throw Error()</script>'})});
  assert.deepEqual(await createLinkPreview('https://example.com/story',f.options),{url:'https://example.com/story',title:'Embedded story',description:'',siteName:'Publisher',author:'Writer',image:'https://images.example.com/story.png'});
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].kind,'json');assert.equal(f.calls[1].maxBytes,128*1024);
});

test('tweet oEmbed supplies quoted text and degrades to original URL without login metadata',async()=>{
  const url='https://x.com/someone/status/1234',endpoint=`https://publish.twitter.com/oembed?omit_script=true&dnt=true&url=${encodeURIComponent(url)}`;
  const f=fixture({[url]:html('<meta property="og:title" content="Log in to X"><meta property="og:description" content="Join the conversation">'),[endpoint]:json({type:'rich',provider_name:'Twitter',author_name:'Someone',html:'<blockquote class="twitter-tweet"><p>A useful thought &amp; a second line.</p><script>bad()</script></blockquote><script src="https://platform.twitter.com/widgets.js"></script>'})});
  const result=await createLinkPreview(url,f.options);assert.equal(result.title,'A useful thought & a second line.');assert.equal(result.author,'Someone');assert(!JSON.stringify(result).includes('<'));assert.equal(f.calls.length,2);
});

test('unavailable tweets retain recognizable URL rather than authentication metadata',async()=>{
  const url='https://twitter.com/someone/status/123';
  const f=fixture({[url]:html('<title>X</title><meta name="description" content="Sign up to continue">')});
  assert.deepEqual(await createLinkPreview(url,f.options),{url,title:'twitter.com/someone/status/123',description:'',siteName:'twitter.com'});
});

test('private/reserved IPv4, IPv6, mapped IPv6 and local hostnames never reach transport',async()=>{
  const blocked=['0.0.0.0','10.1.2.3','100.64.0.1','127.0.0.1','169.254.169.254','172.16.2.3','192.168.1.1','192.0.0.9','192.0.2.4','192.88.99.2','198.18.0.1','198.51.100.3','203.0.113.2','224.0.0.1','240.0.0.1','255.255.255.255','::','::1','::ffff:127.0.0.1','::ffff:7f00:1','fc00::1','fe80::1','ff02::1','2001::1','2001:db8::1','2002:7f00:1::','3fff::1'];
  for(const address of blocked){assert.equal(isPublicAddress(address),false,address);const url=`http://${address.includes(':')?`[${address}]`:address}/`;const f=fixture({});assert.equal((await createLinkPreview(url,f.options)).url,new URL(url).href);assert.equal(f.calls.length,0,address);}
  for(const host of ['localhost','sub.localhost','machine.local','machine.internal','machine']){const f=fixture({});await createLinkPreview(`http://${host}/`,f.options);assert.equal(f.calls.length,0,host);}
  for(const address of [publicIp,'8.8.8.8','2606:4700:4700::1111','2001:4860:4860::8888'])assert.equal(isPublicAddress(address),true,address);
});

test('mixed DNS and DNS rebinding are rejected or pinned before every connection',async()=>{
  const mixed=fixture({},async()=>[{address:publicIp,family:4},{address:'127.0.0.1',family:4}]);await createLinkPreview('https://example.com/',mixed.options);assert.equal(mixed.calls.length,0);
  let lookups=0;
  const f=fixture({'https://example.com/':{status:302,headers:{location:'/next'},body:''}},async()=>[{address:++lookups===1?publicIp:'127.0.0.1',family:4}]);
  const result=await createLinkPreview('https://example.com/',f.options);assert.equal(f.calls.length,1);assert.equal(f.calls[0].address,publicIp);assert.equal(result.title,'example.com');
});

test('redirects revalidate public destinations and enforce the three-hop bound',async()=>{
  for(const destination of ['http://127.0.0.1/secret','http://[::ffff:127.0.0.1]/','file:///etc/passwd','https://user:password@example.com/']){
    const f=fixture({'https://example.com/':{status:302,headers:{location:destination},body:''}});await createLinkPreview('https://example.com/',f.options);assert.equal(f.calls.length,1,destination);
  }
  const routes={};for(let i=0;i<5;i++)routes[`https://example.com/${i}`]={status:302,headers:{location:`/${i+1}`},body:''};
  const f=fixture(routes);assert.equal((await createLinkPreview('https://example.com/0',f.options)).title,'example.com/0');assert.equal(f.calls.length,4);
  const ok=fixture({'https://example.com/start':{status:301,headers:{location:'/end'},body:''},'https://example.com/end':html('<title>Arrived</title>')});assert.equal((await createLinkPreview('https://example.com/start',ok.options)).title,'Arrived');
});

test('private image/oEmbed metadata cannot initiate secondary private requests',async()=>{
  const f=fixture({'https://example.com/':html('<title>Public page</title><meta property="og:image" content="http://127.0.0.1/private.png"><link rel="alternate" type="application/json+oembed" href="http://169.254.169.254/secret">')});
  const result=await createLinkPreview('https://example.com/',f.options);assert.equal(result.title,'Public page');assert.equal(result.image,undefined);assert.equal(f.calls.length,1);
});

test('HTTP failure, wrong type, compressed or oversized bodies yield a plain fallback',async()=>{
  const responses=[new Error('offline'),{status:401,headers:{'content-type':'text/html'},body:'<title>Login</title>'},{status:404,headers:{'content-type':'text/html'},body:'<title>Not found</title>'},{status:200,headers:{'content-type':'application/pdf'},body:'<title>PDF</title>'},{...html('<title>compressed</title>'),headers:{'content-type':'text/html','content-encoding':'gzip'}},html('x'.repeat(512*1024+1)),{...html('<title>too much</title>'),headers:{'content-type':'text/html','content-length':'999999'}}];
  for(const response of responses){const f=fixture({'https://example.com/a':response});assert.deepEqual(await createLinkPreview('https://example.com/a',f.options),{url:'https://example.com/a',title:'example.com/a',description:'',siteName:'example.com'});}
});

test('total deadline covers hanging DNS and transport, aborts active work',async()=>{
  let signal;
  const started=Date.now();const result=await createLinkPreview('https://example.com/',{timeoutMs:25,resolver:async()=>[{address:publicIp,family:4}],transport:async(_url,options)=>{signal=options.signal;return new Promise(()=>{});}});
  assert.equal(result.title,'example.com');assert.equal(signal.aborted,true);assert(Date.now()-started<500);
  const dns=await createLinkPreview('https://example.com/',{timeoutMs:25,resolver:()=>new Promise(()=>{}),transport:()=>{throw Error('must not run');}});assert.equal(dns.title,'example.com');
});

test('invalid inputs fail before resolving or requesting a URL',async()=>{
  const f=fixture({});for(const url of [undefined,1,'invalid','ftp://example.com','file:///etc/passwd','https://a:b@example.com/','https://example.com/a\nb'])await assert.rejects(createLinkPreview(url,f.options),{status:400});assert.equal(f.calls.length,0);
});

test('HTTP endpoint requires current workspace, same origin and JSON without changing graph state',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'tinka-link-preview-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const configPath=path.join(root,'config.json');await main(['init','--config',configPath,'--boards',path.join(root,'boards'),'--label','Link fixture']);
  const config=await loadConfig(configPath),server=await listen(config,{port:0});t.after(()=>closeAppServer(server));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(body,headers={})=>fetch(`${base}/api/link-preview`,{method:'POST',headers:{'content-type':'application/json','x-tinka-workspace':config.workspaceId,...headers},body:JSON.stringify(body)});
  assert.equal((await request({url:'http://127.0.0.1/'},{'x-tinka-workspace':'wrong'})).status,403);
  assert.equal((await request({url:'http://127.0.0.1/'},{origin:'https://attacker.example'})).status,403);
  assert.equal((await request({url:'http://127.0.0.1/'},{'content-type':'text/plain'})).status,415);
  assert.equal((await request({url:'file:///secret'})).status,400);
  const response=await request({url:'http://127.0.0.1/private'});assert.equal(response.status,200);assert.deepEqual(await response.json(),{url:'http://127.0.0.1/private',title:'127.0.0.1/private',description:'',siteName:'127.0.0.1'});
  assert.deepEqual(await (await fetch(`${base}/api/workspace`)).json(),{enabled:false,revision:0});
});
