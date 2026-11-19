import assert from "node:assert/strict";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {main} from "../cli.mjs";
import {loadConfig} from "../lib/config.mjs";
import {applyOperation,getBoardSnapshot} from "../lib/workspace.mjs";
import {createAppServer,closeAppServer} from "../server.mjs";

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:"playwright");
const fixture=await mkdtemp(path.join(os.tmpdir(),"tinka-ink-preview-"));
const evidence=process.env.TINKA_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),"tinka-ink-preview-evidence-"));
const boardId="painted-ink";
let server,browser;
try {
  const configFile=path.join(fixture,"config.json");
  await main(["init","--config",configFile,"--boards",path.join(fixture,"boards"),"--label","Painted ink"]);
  const config=await loadConfig(configFile);
  const op=(type,data)=>applyOperation(config,{type,boardId,...data});
  await op("createBoard",{id:boardId,title:"Ink follows the surface"});
  const defaults={type:"text",width:270,height:105,color:"palette:blue",textSize:24};
  await op("createDecoration",{decoration:{...defaults,id:"strong",x:0,y:0,text:"Blue ink on Strong fill",textFill:"strong"}});
  await op("createDecoration",{decoration:{...defaults,id:"plain",x:340,y:0,text:"The same chosen Blue"}});
  await op("createDecoration",{decoration:{id:"backdrop",type:"region",shape:"rounded",x:0,y:190,width:270,height:130,color:"#4867a4",text:""}});
  await op("createDecoration",{decoration:{...defaults,id:"underlying",x:10,y:200,width:240,text:"Ink over local blue",color:"#5176c1"}});
  let before=await getBoardSnapshot(config,boardId);
  server=createAppServer(config);
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:960},reducedMotion:"reduce"});
  page.setDefaultTimeout(8000);
  const errors=[],writes=[],checks=[];
  page.on("pageerror",error=>errors.push(error.message));
  page.on("request",request=>{if(!["GET","HEAD"].includes(request.method()))writes.push({method:request.method(),url:request.url()});});
  await page.goto(`http://127.0.0.1:${server.address().port}/boards/${boardId}/`);
  const text=id=>page.locator(`[data-decoration="${id}"]`);
  const ink=()=>page.locator(".whiteboard-toolbar [data-whiteboard-action=text-ink]");
  const waitDot=async id=>{
    await page.waitForFunction(id=>{
      const button=document.querySelector(".whiteboard-toolbar [data-whiteboard-action=text-ink]");
      const dot=button?.querySelector("[data-text-ink-preview]");
      const target=document.querySelector(`[data-decoration="${id}"]`);
      return dot&&target&&getComputedStyle(dot).backgroundColor===getComputedStyle(target).color;
    },id);
    return page.evaluate(id=>{
      const button=document.querySelector(".whiteboard-toolbar [data-whiteboard-action=text-ink]");
      return {id,theme:document.documentElement.dataset.appearance,ink:getComputedStyle(document.querySelector(`[data-decoration="${id}"]`)).color,
        dot:getComputedStyle(button.querySelector("[data-text-ink-preview]")).backgroundColor,description:button.getAttribute("aria-description"),title:button.title};
    },id);
  };
  await text("strong").click();
  for(const theme of ["light","dark","light"]){
    await page.evaluate(theme=>document.documentElement.dataset.appearance=theme,theme);
    const check=await waitDot("strong");
    assert.match(check.description,/Chosen Blue/);
    assert.match(check.description,/Adjusted for contrast/);
    checks.push(check);
    await ink().click();
    assert.equal(await page.locator('.whiteboard-menu [data-swatch="palette:blue"]').getAttribute("aria-pressed"),"true");
    await page.screenshot({path:path.join(evidence,`strong-${theme}.png`)});
    await ink().click();
  }
  await text("underlying").click();
  for(const theme of ["light","dark"]){
    await page.evaluate(theme=>document.documentElement.dataset.appearance=theme,theme);
    const check=await waitDot("underlying");
    assert.match(check.description,/Chosen #5176C1/);
    checks.push(check);
  }
  await text("strong").click();
  await text("plain").click({modifiers:["Shift"]});
  const mixed=page.locator('.whiteboard-toolbar [data-whiteboard-action=drawing-color]');
  await mixed.waitFor({state:"visible"});
  assert.equal(await mixed.locator("[data-text-ink-preview]").getAttribute("data-ink-mixed"),"true");
  assert.match(await mixed.getAttribute("aria-description"),/Displayed ink varies/);
  await page.screenshot({path:path.join(evidence,"mixed-dark.png")});
  await text("strong").click();
  await op("updateDecoration",{decorationId:"strong",patch:{textFill:"paper"}});
  before=await getBoardSnapshot(config,boardId);
  await page.waitForFunction(()=>{
    const text=document.querySelector('[data-decoration="strong"]');
    return text?.style.getPropertyValue("--text-fill-light")==="#fdfdfb";
  });
  checks.push(await waitDot("strong"));
  assert.equal(before.decorations.find(drawing=>drawing.id==="strong").color,"palette:blue");
  const after=await getBoardSnapshot(config,boardId);
  assert.deepEqual(after,before,"Selection and theme changes retain authored board data.");
  assert.deepEqual(writes,[]);
  assert.deepEqual(errors,[]);
  await writeFile(path.join(evidence,"report.json"),JSON.stringify({passed:true,checks,intendedFillUpdates:1,writes,errors},null,2)+"\n");
  console.log(JSON.stringify({passed:true,evidence,checks:checks.length,writes:writes.length,errors}));
} finally {
  await browser?.close();
  if(server)await closeAppServer(server);
  await rm(fixture,{recursive:true,force:true});
}
