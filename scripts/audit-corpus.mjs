import { readFile,writeFile } from 'node:fs/promises';
import { auditCorpus } from '../src/lib/desk/corpus-audit.ts';
const [input,output]=process.argv.slice(2);
if(!input || !output) throw new Error('Usage: node --experimental-strip-types scripts/audit-corpus.mjs INPUT.json OUTPUT.json');
const data=JSON.parse(await readFile(input,'utf8'));
if(!Array.isArray(data.records)) throw new Error('Expected {epoch,asOf,records} with separate frozen decisions and full outcomes');
const result=auditCorpus(data.records,data.epoch,data.asOf);
await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({accepted:result.acceptedRows,total:result.inputRows,uniqueTokens:result.uniqueTokens,sha256:result.sha256,trainingEnabled:false}));
