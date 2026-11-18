import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {main} from "../cli.mjs";
import {loadConfig} from "../lib/config.mjs";
import {applyOperation,getBoardSnapshot} from "../lib/workspace.mjs";
import {createAppServer,closeAppServer} from "../server.mjs";
import {resolveLine} from "../public/whiteboard-geometry.js";

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:"playwright");
const root=await mkdtemp(path.join(os.tmpdir(),"tinka-text-style-"));
const boardId="style-board";
let server,browser;

async function waitFor(check) {
  for(let attempt=0;attempt<65;attempt++){
    if(await check())return;
    await new Promise(resolve=>setTimeout(resolve,75));
  }
  assert.fail("Expected saved board state did not settle.");
}

try {
  const configFile=path.join(root,"local","config.json");
  await main(["init","--config",configFile,"--boards",path.join(root,"boards"),"--label","Text appearance check"]);
  const config=await loadConfig(configFile);
  const operation=(type,data)=>applyOperation(config,{type,boardId,...data});
  await operation("createBoard",{id:boardId,title:"Style test"});
  await operation("createDecoration",{decoration:{id:"section",type:"region",x:0,y:0,width:710,height:525,color:"#e4e9da",text:""}});
  await operation("createDecoration",{decoration:{id:"copy",type:"text",x:36,y:60,width:278,height:85,color:"#687654",text:"## A title\nText wraps naturally in its box."}});
  await operation("createDecoration",{decoration:{id:"outside",type:"text",x:730,y:70,width:175,height:96,color:"#455544",text:"Outside"}});
  await operation("createDecoration",{decoration:{id:"arrow",type:"line",x:100,y:145,width:1,height:155,color:"#536044",text:"",endArrow:true,
    from:{decorationId:"copy",side:"bottom"},to:{x:100,y:300}}});
  let item=await operation("createItem",{item:{title:"Supporting material"},placement:{x:370,y:100,width:240,height:120}});
  const [placementId]=item.result.placementIds;

  server=createAppServer(config);
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1280,height:850},colorScheme:"dark",reducedMotion:"reduce"});
  page.setDefaultTimeout(8000);
  const errors=[];page.on("pageerror",error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/boards/${boardId}/`);
  const state=()=>getBoardSnapshot(config,boardId);
  const saved=async id=>(await state()).decorations.find(decoration=>decoration.id===id);
  const text=page.locator('[data-decoration="copy"]');
  const label=text.locator("[data-decoration-label]");
  const toolbar=page.locator(".whiteboard-toolbar");
  const more=toolbar.getByRole("button",{name:"More options"});
  await text.getByRole("heading",{name:"A title"}).click();
  await page.evaluate(()=>document.documentElement.dataset.appearance="dark");
  assert.equal(await toolbar.locator('[data-whiteboard-action=color],[data-whiteboard-action=size],[data-whiteboard-action=edit],[data-whiteboard-action=wrap-container]').count(),0);
  assert.equal(await toolbar.locator('[data-whiteboard-action=align]').count(),3);
  const sizeButton=toolbar.getByRole("button",{name:"Text size",exact:true});
  await sizeButton.click();
  const sizePanel=page.getByRole("dialog",{name:"Text size",exact:true});
  const fontSize=sizePanel.getByRole("slider",{name:"Adjust text size",exact:true});
  const sizePreset=name=>sizePanel.getByRole("button",{name,exact:true});
  assert.equal(await sizePanel.locator("[data-scrub-value]").count(),1);
  assert.equal(await fontSize.getAttribute("aria-valuemax"),"144");
  assert.equal(await sizePanel.locator("[data-padding-scrub],[data-swatch],input").count(),0);
  assert.equal(await sizePreset("Medium").getAttribute("aria-pressed"),"true");
  await sizePreset("Large").click();
  await waitFor(async()=>(await saved("copy")).textSize==="large");
  assert.equal(await fontSize.getAttribute("aria-valuenow"),"36");
  await fontSize.press("Home");
  await fontSize.press("PageUp");
  await fontSize.press("ArrowRight");
  await waitFor(async()=>(await saved("copy")).textSize===21);
  assert.equal(await sizePreset("Medium").getAttribute("aria-pressed"),"false");
  assert.equal(await sizePanel.locator(".preset-scrub-custom").getAttribute("data-active"),"true");
  await sizePreset("Large").click();
  await fontSize.press("ArrowRight");
  await waitFor(async()=>(await saved("copy")).textSize===37);
  await sizeButton.click();
  await sizePanel.waitFor({state:"hidden"});
  await toolbar.getByRole("button",{name:"Ink color",exact:true}).click();
  const inkPanel=page.getByRole("dialog",{name:"Ink",exact:true});
  assert.equal(await inkPanel.locator("[data-swatch]").count(),15);
  assert.equal(await inkPanel.locator("[data-scrub-value]").count(),0);
  await inkPanel.locator('[data-swatch="palette:rose"]').click();
  await waitFor(async()=>(await saved("copy")).color==="palette:rose");
  await toolbar.getByRole("button",{name:"Advanced text",exact:true}).click();
  const appearance=page.getByRole("dialog",{name:"Advanced text",exact:true});
  assert.equal(await appearance.locator("select").count(),0);
  assert.equal(await appearance.getByRole("button",{name:"Apply",exact:true}).count(),0);
  assert.equal(await appearance.locator('[data-text-size-scrub],[data-role=ink],[data-align]').count(),0);
  const padding=appearance.getByRole("slider",{name:"Adjust padding",exact:true});
  const paddingPreset=name=>appearance.getByRole("button",{name,exact:true});
  assert.equal(await padding.isVisible(),true);
  assert.equal(await appearance.locator("[data-scrub-value]").count(),1);
  assert.equal(await padding.getAttribute("aria-valuemin"),"0");
  assert.equal(await padding.getAttribute("aria-valuemax"),"64");
  assert.equal(await paddingPreset("Medium").getAttribute("aria-pressed"),"true");
  await paddingPreset("Large").click();
  await waitFor(async()=>(await saved("copy")).textPadding===24);
  assert.equal(await padding.getAttribute("aria-valuenow"),"24");
  await appearance.locator("[data-face=mono]").click();
  await appearance.locator("[data-role=fill]").click();
  await appearance.locator('[data-swatch="palette:blue"]').click();
  await appearance.locator("[data-role=border]").click();
  await appearance.locator("[data-border=dashed]").click();
  await appearance.locator('[data-swatch="palette:clay"]').click();
  await padding.press("PageDown");
  await padding.press("ArrowRight");
  await waitFor(async()=>(await saved("copy")).textPadding===15);
  await padding.press("ArrowRight");
  await waitFor(async()=>(await saved("copy")).textPadding===16);
  await page.keyboard.press("Escape");
  await appearance.waitFor({state:"hidden"});
  await waitFor(async()=>(await saved("copy")).textSize===37);
  assert.deepEqual(await saved("copy"),{id:"copy",type:"text",x:36,y:60,width:278,height:85,color:"palette:rose",
    text:"## A title\nText wraps naturally in its box.",textSize:37,textFace:"mono",textFill:"palette:blue",textBorder:{style:"dashed",color:"palette:clay"},textPadding:16});
  await waitFor(()=>label.evaluate(node=>getComputedStyle(node).paddingTop==="16px"));
  assert.deepEqual(await label.evaluate(node=>{
    const style=getComputedStyle(node);
    return [style.fontSize,style.fontFamily.includes("monospace"),style.borderTopStyle,style.paddingTop];
  }),["37px",true,"dashed","16px"]);
  await page.keyboard.press("Control+z");
  await waitFor(async()=>(await saved("copy")).textPadding===15);
  await page.keyboard.press("Control+Shift+z");
  await waitFor(async()=>(await saved("copy")).textPadding===16);
  const background=await label.evaluate(node=>getComputedStyle(node).backgroundColor);
  await page.evaluate(()=>document.documentElement.dataset.appearance="light");
  assert.notEqual(await label.evaluate(node=>getComputedStyle(node).backgroundColor),background);
  assert.equal(await page.locator('[data-decoration="section"] [data-decoration-label]').evaluate(node=>getComputedStyle(node).display),"none");

  await more.click();
  assert.equal(await page.getByRole("menuitem",{name:"Position & size…"}).count(),0);
  await page.getByRole("menuitem",{name:"Fit height to text"}).click();
  await waitFor(async()=>(await saved("copy")).height>85);
  const fitted=await saved("copy");
  await waitFor(()=>text.evaluate((node,height)=>parseFloat(node.style.height)===height,fitted.height));
  assert.equal(fitted.width,278);
  assert.deepEqual(await label.evaluate(node=>[node.scrollHeight,node.clientHeight]),await label.evaluate(node=>[node.clientHeight,node.clientHeight]));
  const snapshot=await state();
  assert.equal(resolveLine(snapshot.decorations.find(d=>d.id==="arrow"),snapshot).from.y,fitted.y+fitted.height);

  await text.getByRole("heading",{name:"A title"}).dblclick();
  const field=page.getByRole("textbox",{name:"Text block",exact:true});
  assert.deepEqual(await field.evaluate(node=>{
    const css=getComputedStyle(node);
    return [css.fontSize,css.fontFamily.includes("monospace"),!!node.closest("[data-decoration]"),css.outlineStyle];
  }),["37px",true,true,"none"]);
  await field.press("Escape");
  await page.locator('[data-decoration="section"]').click({position:{x:36,y:3}});
  await toolbar.getByRole("button",{name:"Region options"}).click();
  await page.getByRole("button",{name:"Select section contents"}).click();
  await page.keyboard.press("ArrowRight");
  await waitFor(async()=>(await saved("section")).x===1);
  assert.equal((await saved("copy")).x,37);
  assert.equal((await state()).placements.find(p=>p.id===placementId).x,371);
  assert.equal((await saved("outside")).x,730);
  await page.keyboard.press("Control+z");
  await waitFor(async()=>(await saved("section")).x===0);
  assert.equal((await saved("copy")).x,36);
  assert.deepEqual(errors,[]);
  console.log("Text styling, inline editing, measured fitting and mixed section selection passed.");
} finally {
  await browser?.close();
  if(server)await closeAppServer(server);
  await rm(root,{recursive:true,force:true});
}
