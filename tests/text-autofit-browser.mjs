import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {main} from "../cli.mjs";
import {loadConfig} from "../lib/config.mjs";
import {applyOperation, getBoardSnapshot} from "../lib/workspace.mjs";
import {closeAppServer, createAppServer} from "../server.mjs";

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:"playwright");
const root=await mkdtemp(path.join(os.tmpdir(),"tinka-auto-text-"));
const boardId="auto-text";
let server,browser;

try {
  const configFile=path.join(root,"local","config.json");
  await main(["init","--config",configFile,"--boards",path.join(root,"boards")]);
  const config=await loadConfig(configFile);
  const op=(type,values)=>applyOperation(config,{type,boardId,...values});
  const create=decoration=>op("createDecoration",{decoration});
  const text=(id,x,y,extra={})=>create({id,type:"text",text:id,x,y,width:235,height:62,color:"palette:neutral",...extra});
  await op("createBoard",{id:boardId,title:"Automatic height"});
  await text("legacy",500,20);
  await text("child",600,330,{textSizing:"auto"});
  await text("next",600,415);
  await create({id:"container",type:"region",x:585,y:305,width:270,height:180,text:"",color:"palette:sage",
    container:{layout:"vertical",children:["child","next"]}});

  server=createAppServer(config);
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1400,height:950},reducedMotion:"reduce"});
  page.setDefaultTimeout(8000);
  const errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/boards/${boardId}/`);
  const snapshot=()=>getBoardSnapshot(config,boardId);
  const saved=async id=>(await snapshot()).decorations.find(d=>d.id===id);
  const element=id=>page.locator(`[data-decoration="${id}"]`);
  const label=id=>element(id).locator("[data-decoration-label]");
  const edit=page.getByRole("textbox",{name:"Text block",exact:true});
  const bar=page.locator(".whiteboard-toolbar");
  const sizeButton=bar.getByRole("button",{name:"Text size",exact:true});
  const sizePanel=page.getByRole("dialog",{name:"Text size",exact:true});
  const more=bar.getByRole("button",{name:"More options",exact:true});
  const waitSaved=async(id,predicate)=>{
    for(let attempt=0;attempt<100;attempt++){
      const d=await saved(id);
      if(predicate(d))return d;
      await page.waitForTimeout(40);
    }
    assert.fail(`Expected state for ${id} was not saved: ${JSON.stringify(await saved(id))}`);
  };
  const logicalHeight=id=>element(id).evaluate(node=>Number.parseFloat(node.style.height));
  const idle=()=>page.waitForFunction(()=>document.getElementById("workspace-paste")?.disabled===false);
  const draft=Array.from({length:8},(_,i)=>`Line ${i+1} has enough plain text for wrapping.`).join("\n");

  await label("legacy").waitFor();
  await page.mouse.move(245,215);
  await page.keyboard.press("t");
  await edit.waitFor();
  const id=await edit.evaluate(node=>node.closest("[data-decoration]").dataset.decoration);
  const created=await saved(id);
  assert.equal(created.textSizing,"auto");
  const newRevision=(await snapshot()).revision;
  await edit.fill(draft);
  await page.waitForFunction(({id,height})=>parseFloat(document.querySelector(`[data-decoration="${id}"]`).style.height)>height+100,
    {id,height:created.height});
  assert.equal((await snapshot()).revision,newRevision,"live drafting does not write");
  assert.equal((await saved(id)).text,created.text);
  await edit.press("ControlOrMeta+Enter");
  const autosized=await waitSaved(id,d=>d.text===draft);
  assert.equal(autosized.width,created.width);
  assert.ok(autosized.height>created.height+100);
  assert.equal((await snapshot()).revision,newRevision+1,"text and geometry save together");

  await idle();
  await sizeButton.click();
  assert.equal(await sizePanel.locator("[data-auto-height]").count(),0);
  const scrub=sizePanel.getByRole("slider",{name:"Adjust text size"});
  const control=await scrub.boundingBox();
  const sizeRevision=(await snapshot()).revision;
  const scrubX=control.x+control.width/2,scrubY=control.y+control.height/2;
  await page.mouse.move(scrubX,scrubY);await page.mouse.down();
  await page.mouse.move(scrubX+34,scrubY,{steps:7});
  assert.equal(await scrub.getAttribute("aria-valuenow"),"38");
  assert.ok((await logicalHeight(id))>autosized.height);
  assert.equal((await snapshot()).revision,sizeRevision);
  await page.mouse.up();
  const large=await waitSaved(id,d=>d.textSize===38);
  assert.ok(large.height>autosized.height);
  assert.equal(large.width,autosized.width);
  await page.keyboard.press("Escape");

  const edge=await element(id).locator("[data-decoration-resize=e]").boundingBox();
  const x=edge.x+edge.width/2,y=edge.y+Math.min(edge.height/4,65);
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+95,y,{steps:6});await page.mouse.up();
  const fixed=await waitSaved(id,d=>d.textSizing==="fixed");
  assert.ok(fixed.width>large.width);
  assert.equal(fixed.height,large.height);
  await idle();
  await page.keyboard.press("ControlOrMeta+z");
  await waitSaved(id,d=>d.textSizing==="auto"&&d.width===large.width);
  await idle();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await waitSaved(id,d=>d.textSizing==="fixed"&&d.width===fixed.width);

  await idle();
  await label(id).dblclick({position:{x:42,y:42}});
  await edit.fill("Shorter");
  assert.equal(await logicalHeight(id),fixed.height);
  await edit.press("Escape");
  assert.equal((await waitSaved(id,d=>d.text==="Shorter")).height,fixed.height);
  await idle();await bar.getByRole("button",{name:"Text box",exact:true}).click();
  const boxPanel=page.getByRole("dialog",{name:"Text box",exact:true});
  await boxPanel.getByRole("button",{name:"Fit height once",exact:true}).click();
  const fittedOnce=await waitSaved(id,d=>d.height<fixed.height);
  assert.equal(fittedOnce.textSizing,"fixed");
  await boxPanel.getByRole("button",{name:"Enable auto height"}).click();
  const restored=await waitSaved(id,d=>d.textSizing==="auto");
  assert.ok(restored.height<fixed.height);
  assert.equal(restored.width,fixed.width);
  await page.keyboard.press("Escape");

  await idle();
  assert.equal(await more.count(),0,"a loose Text block has no empty overflow");
  await page.keyboard.press("Delete");
  await waitSaved(id,d=>!d);
  await idle();
  await page.keyboard.press("ControlOrMeta+z");
  await waitSaved(id,d=>d?.textSizing==="auto");

  await idle();
  await label("legacy").click();await sizeButton.click();
  assert.equal(await sizePanel.locator("[data-auto-height]").count(),0);
  await scrub.press("End");
  const legacy=await waitSaved("legacy",d=>d.textSize===144);
  assert.equal(legacy.height,62);
  assert.ok(!("textSizing" in legacy));
  await page.keyboard.press("Escape");

  const nextY=(await saved("next")).y;
  const parentHeight=(await saved("container")).height;
  await idle();await label("child").dblclick();
  await edit.fill(draft);await edit.press("ControlOrMeta+Enter");
  await waitSaved("child",d=>d.text===draft&&d.height>62);
  assert.ok((await saved("next")).y>nextY);
  assert.ok((await saved("container")).height>parentHeight);

  await page.reload();
  await label("legacy").waitFor();
  assert.equal(await logicalHeight("legacy"),62);
  assert.equal(await logicalHeight(id),restored.height);
  assert.deepEqual(errors,[]);
  console.log("Native Text auto-height drafting, sizing, manual resize, Undo/Redo, overflow keys, legacy compatibility and container reflow passed.");
} finally {
  await browser?.close();
  if(server)await closeAppServer(server);
  await rm(root,{recursive:true,force:true});
}
