import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { parseDocxInBrowser, formatDocxInBrowser } from '../app/docx-browser.ts';
const dom=new JSDOM(''); globalThis.DOMParser=dom.window.DOMParser; globalThis.XMLSerializer=dom.window.XMLSerializer;
const root=process.argv[2], out=process.argv[3]; await mkdir(out,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8'));
for(const item of manifest){
  const data=await readFile(path.join(root,item.file)); const input=data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength);
  const model=parseDocxInBrowser(input,item.type); const result=formatDocxInBrowser(input,model,{sessionLabel:'',submittingCountry:'',version:'v1'});
  await writeFile(path.join(out,item.file),new Uint8Array(await result.blob.arrayBuffer()));
  console.log(item.file,model.language,result.validations.map(v=>`${v.code}:${v.status}`).join(' '));
}
