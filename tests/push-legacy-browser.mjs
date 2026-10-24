import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {main} from '../cli.mjs';
import {loadConfig} from '../lib/config.mjs';
import {listen,closeAppServer} from '../server.mjs';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href),run=promisify(execFile);
const root=await mkdtemp(path.join(os.tmpdir(),'tinka-push-legacy-')),configPath=path.join(root,'config.json'),boards=path.join(root,'boards');let server,browser;
try{
 await main(['init','--config',configPath,'--boards',boards,'--label','Legacy push']);await main(['board','create','legacy','--config',configPath,'--title','Legacy']);
 const dir=path.join(boards,'legacy');await mkdir(path.join(dir,'prototype'));await writeFile(path.join(dir,'prototype/index.html'),'<h1>Legacy prototype</h1>');
 await writeFile(path.join(dir,'rounds.json'),JSON.stringify({rounds:[{id:'one',title:'One',concepts:[{id:'first',name:'First',path:'prototype/index.html'}]}],revisions:{}}));
 await main(['status','--config',configPath,'--board','legacy','one/first','ready','Ready']);
 const config=await loadConfig(configPath);server=await listen(config,{port:0});const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});const home=await browser.newPage(),page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[],requests=[];
 for(const p of [home,page]){p.on('pageerror',error=>errors.push(error.message));p.on('request',r=>requests.push(r.url()));}
 await home.goto(base+'/');await home.locator('.board-card').first().waitFor();
 await run(process.execPath,['cli.mjs','board','create','later','--config',configPath,'--title','Later board'],{cwd:path.resolve(import.meta.dirname,'..')});await home.locator('.board-card h3').filter({hasText:'Later board'}).waitFor({timeout:10000});
 await page.goto(base+'/boards/legacy/');await page.locator('.concept-card iframe').waitFor();await page.waitForTimeout(1200);await page.evaluate(()=>window.retained=document.querySelector('.concept-card iframe'));
 const viewport=await page.locator('#viewport').boundingBox();await page.mouse.move(viewport.x+viewport.width-80,viewport.y+viewport.height-80);await page.mouse.down();await page.mouse.move(viewport.x+viewport.width-110,viewport.y+viewport.height-100);
 const metadata=JSON.parse(await readFile(path.join(dir,'board.json'),'utf8'));await writeFile(path.join(dir,'board.json'),JSON.stringify({...metadata,title:'Legacy pushed title'}));
 await page.waitForTimeout(1200);assert.equal(await page.locator('#board-title').textContent(),'Legacy');await page.mouse.up();
 await page.waitForFunction(()=>document.querySelector('#board-title').textContent==='Legacy pushed title');assert.equal(await page.evaluate(()=>window.retained===document.querySelector('.concept-card iframe')),true,'legacy metadata keeps mounted preview');
 const note=page.locator('[data-note="one/first"]');await note.fill('Keep this note');await note.evaluate(el=>el.setSelectionRange(3,7));
 const manifest=JSON.parse(await readFile(path.join(dir,'rounds.json'),'utf8'));manifest.rounds[0].title='Live heading with focused note';await writeFile(path.join(dir,'rounds.json'),JSON.stringify(manifest));
 await page.locator('#round-heading-one').filter({hasText:'Live heading with focused note'}).waitFor();assert.deepEqual(await note.evaluate(el=>[el===document.activeElement,el.value,el.selectionStart,el.selectionEnd]),[true,'Keep this note',3,7]);assert.equal(await page.evaluate(()=>window.retained===document.querySelector('.concept-card iframe')),true,'focused note reconciliation keeps mounted preview');
 await writeFile(path.join(dir,'prototype/index.html'),'<h1>Changed legacy resource</h1>');await page.waitForFunction(()=>document.querySelector('.concept-card iframe')?.contentDocument?.body?.textContent.includes('Changed legacy resource'));
 requests.length=0;await page.waitForTimeout(2500);assert.equal(requests.filter(url=>url.includes('/live')||url.includes('view=header')||url.endsWith('/api/boards')).length,0);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks:['legacy Home CLI creation','legacy board metadata push','legacy pan defers update','legacy mounted iframe','focused legacy note value/cursor/heading','legacy resource push','no legacy polling']}));
}finally{await browser?.close();if(server)await closeAppServer(server);await rm(root,{recursive:true,force:true});}
