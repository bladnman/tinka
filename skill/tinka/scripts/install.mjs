#!/usr/bin/env node
// Compatibility for source callers of the old installer location. The optional
// skill ZIP contains only SKILL.md; current installs use the app or release helper.
import {main} from '../../../scripts/install.mjs';
import {realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export * from '../../../scripts/install.mjs';
if(process.argv[1]&&await realpath(path.resolve(process.argv[1])).catch(()=>null)===fileURLToPath(import.meta.url)){
  try{process.stdout.write(`${await main()}\n`);}catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=1;}
}
