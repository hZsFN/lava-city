import fs from 'node:fs';
import {parseItemManifest} from '../shared/item-manifest.mjs';
try { const file=process.argv[2]||new URL('../global-items.json',import.meta.url);const result=parseItemManifest(fs.readFileSync(file,'utf8'));console.log('道具声明校验通过：'+result.items.length+' 件全局道具。'); } catch(error) { console.error('道具声明校验失败：'+error.message);process.exitCode=1; }
