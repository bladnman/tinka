// `inbox` without the app lock or the full CLI: only config loading and the inbox reader.
import {loadConfig} from './config.mjs';
import {inboxCommand} from './inbox.mjs';
const FLAGS=new Set(['brief','json','watch']),VALUES=new Set(['config','since','actor','timeout','label']);
export async function inboxMain(args){
  const options={};
  for(let index=1;index<args.length;index++){
    const key=args[index].startsWith('--')?args[index].slice(2):null;
    if(!key||options[key]!==undefined||!FLAGS.has(key)&&!VALUES.has(key))throw new Error('Usage: inbox --config PATH [--brief | --watch [--timeout SECONDS] [--label TEXT]] [--since TOKEN] [--actor ID] [--json]');
    if(FLAGS.has(key)){options[key]=true;continue;}
    if(index===args.length-1)throw new Error(`Provide a value for --${key}.`);options[key]=args[++index];
  }
  if(!options.config)throw new Error('Usage: inbox --config PATH [--brief | --watch [--timeout SECONDS] [--label TEXT]] [--since TOKEN] [--actor ID] [--json]');
  return inboxCommand(await loadConfig(options.config),options);
}
