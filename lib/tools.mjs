import {readFile,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {readWorkspace,workspaceHeader,workspaceView,getBoardSnapshot,getItemSnapshot,getBoardGeometry,applyOperation,applyFileImport} from './workspace.mjs';
import {searchWorkspace,rebuildDiscovery,inspectWorkspace} from './discovery.mjs';
import {feedbackToolDefinitions,dispatchFeedbackTool} from './feedback.mjs';
import {highlightToolDefinitions,dispatchHighlightTool} from './highlights.mjs';
import {migrateLegacy} from './migrate.mjs';
import {createLinkPreview} from './link-preview.mjs';
import {storeError} from './store.mjs';
const catalog=JSON.parse(await readFile(new URL('./tools.json',import.meta.url),'utf8'));
// The checked-in file includes these definitions for immediate offline reading;
// the owning module remains the runtime definition source and is parity-tested.
const ownedDefinitions=[...feedbackToolDefinitions,...highlightToolDefinitions];
const definitions=[...catalog.tools.filter(t=>!ownedDefinitions.some(f=>f.name===t.name)),...ownedDefinitions];
export function listTools(){return {...catalog,tools:structuredClone(definitions)};}
export function toolDefinition(name){return definitions.find(tool=>tool.name===name);}
function validate(value,schema,label='arguments'){
  if(schema.oneOf){if(schema.oneOf.filter(part=>{try{validate(value,part,label);return true;}catch{return false;}}).length!==1)throw storeError(400,`${label} must match one supported shape.`);return;}
  if(schema.enum&&!schema.enum.some(option=>Object.is(option,value)))throw storeError(400,`Invalid ${label}.`);
  if(Object.hasOwn(schema,'const')&&!Object.is(schema.const,value))throw storeError(400,`Invalid ${label}.`);
  if(schema.type){const valid=schema.type==='null'?value===null:schema.type==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):schema.type==='array'?Array.isArray(value):schema.type==='integer'?Number.isSafeInteger(value):schema.type==='number'?typeof value==='number'&&Number.isFinite(value):typeof value===schema.type;if(!valid)throw storeError(400,`${label} must be ${schema.type}.`);}
  if(typeof value==='number'&&(schema.minimum!==undefined&&value<schema.minimum||schema.maximum!==undefined&&value>schema.maximum||schema.exclusiveMinimum!==undefined&&value<=schema.exclusiveMinimum))throw storeError(400,`${label} is out of range.`);
  if(typeof value==='string'&&(schema.minLength!==undefined&&value.length<schema.minLength||schema.maxLength!==undefined&&value.length>schema.maxLength||schema.pattern&&!new RegExp(schema.pattern).test(value)))throw storeError(400,`Invalid ${label}.`);
  if(Array.isArray(value)){if(schema.minItems!==undefined&&value.length<schema.minItems||schema.maxItems!==undefined&&value.length>schema.maxItems)throw storeError(400,`Invalid ${label} length.`);if(schema.items)value.forEach((entry,index)=>validate(entry,schema.items,`${label}[${index}]`));}
  if(value&&typeof value==='object'&&!Array.isArray(value)){
    for(const key of schema.required||[])if(!Object.hasOwn(value,key))throw storeError(400,`${label}.${key} is required.`);
    if(schema.additionalProperties===false&&Object.keys(value).some(key=>!Object.hasOwn(schema.properties||{},key)))throw storeError(400,`Unknown ${label} field.`);
    for(const [key,entry] of Object.entries(value))if(schema.properties?.[key])validate(entry,schema.properties[key],`${label}.${key}`);
  }
}
export async function callTool(config,name,input={}, {transport='cli'}={}){
  const tool=toolDefinition(name);if(!tool)throw storeError(404,'Unknown Tinka tool.');
  if(tool.transports&&!tool.transports.includes(transport))throw storeError(400,'This tool is available through the CLI only.');
  validate(input,tool.inputSchema);
  if(feedbackToolDefinitions.some(t=>t.name===name))return dispatchFeedbackTool(config,name,input);
  if(highlightToolDefinitions.some(t=>t.name===name))return dispatchHighlightTool(config,name,input);
  if(tool.operation)return applyOperation(config,{type:tool.operation,...input});
  switch(name){
    case 'workspace.search':return searchWorkspace(config,input);
    case 'workspace.recent':return searchWorkspace(config,{...input,sort:'updatedAt',direction:'desc'});
    case 'workspace.show':return readWorkspace(config);
    case 'workspace.view':return input.view==='header'?workspaceHeader(config):workspaceView(config,input.view,{covers:input.covers!==false});
    case 'workspace.rebuildIndex':return rebuildDiscovery(config);
    case 'workspace.inspect':return inspectWorkspace(config);
    case 'workspace.migrate':return migrateLegacy(config,input);
    case 'workspace.apply':return applyOperation(config,input.operation);
    case 'item.get':{const item=await getItemSnapshot(config,input.itemId);if(!item)throw storeError(404,'Item not found.');return item;}
    case 'board.get':{const board=await getBoardSnapshot(config,input.boardId);if(!board)throw storeError(404,'Board not found.');return board;}
    case 'board.geometry':return getBoardGeometry(config,input.boardId);
    case 'link.preview':return createLinkPreview(input.url);
    case 'files.import':{
      const {paths,...metadata}=input;const files=[];
      let total=0;
      for(const file of paths){
        const handle=await open(path.resolve(file),constants.O_RDONLY|constants.O_NONBLOCK);
        try{
          const details=await handle.stat();
          if(!details.isFile()||!details.size)throw storeError(400,'Import paths must name nonempty regular files.');
          total+=details.size;
          if(details.size>20*1024*1024||total>50*1024*1024)throw storeError(413,'Files may be up to 20 MiB each and 50 MiB per batch.');
          // Bound even a concurrently growing file; never read devices or pipes.
          const bytes=Buffer.alloc(details.size+1);let length=0;
          while(length<bytes.length){const result=await handle.read(bytes,length,bytes.length-length,null);if(!result.bytesRead)break;length+=result.bytesRead;}
          if(length!==details.size)throw storeError(409,'Import source changed while reading. Retry from a stable file.');
          files.push({name:path.basename(file),bytes:bytes.subarray(0,length)});
        }finally{await handle.close();}
      }
      return applyFileImport(config,metadata,files);
    }
    default:throw storeError(404,'Tool dispatch is unavailable.');
  }
}
