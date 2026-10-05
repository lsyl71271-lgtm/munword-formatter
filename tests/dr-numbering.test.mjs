import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {zipSync,unzipSync} from 'fflate';
import {parseDocxInBrowser,formatDocxInBrowser} from '../app/docx-browser.ts';
import {validMarkerChange,planHierarchy,markerOf,markerText,nativeRangeReason} from '../app/dr-numbering.ts';
const dom=new JSDOM(''); globalThis.DOMParser=dom.window.DOMParser; globalThis.XMLSerializer=dom.window.XMLSerializer;
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main', enc=new TextEncoder(),dec=new TextDecoder();
const p=text=>`<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const input=lines=>zipSync({'[Content_Types].xml':enc.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),'word/document.xml':enc.encode(`<w:document xmlns:w="${W}"><w:body>${['决议草案1.1','联合国大会','议题：测试','起草国：中国','回顾原则，',...lines].map(p).join('')}<w:sectPr/></w:body></w:document>`)});
async function format(bytes){const source=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength); const result=formatDocxInBrowser(source,parseDocxInBrowser(source,'draft-resolution'),{sessionLabel:'',submittingCountry:'',version:'v1'}); const output=new Uint8Array(await result.blob.arrayBuffer());const parts=unzipSync(output);const xml=new DOMParser().parseFromString(dec.decode(parts['word/document.xml']),'application/xml');return {output,parts,xml,result,paragraphs:[...xml.getElementsByTagNameNS(W,'p')]};}
const text=p=>[...p.getElementsByTagNameNS(W,'t')].map(t=>t.textContent).join('');
test('DR: neatly wrong foreign markers are normalized by parent context, ordinal unchanged',async()=>{
 const a=await format(input(['第一条 要求合作：','（a）建立机构：','（一）建立秘书处：','（甲）保存原始记录；','（二）提交报告；','（b）监督执行。']));
 const body=a.paragraphs.map(text).filter(t=>/^(第|（)/.test(t));
 assert.deepEqual(body,['第一条 要求合作：','（一）建立机构：','（子）建立秘书处：','（甲）保存原始记录；','（丑）提交报告；','（二）监督执行。']);
 assert.deepEqual(a.paragraphs.filter(p=>/^(第|（)/.test(text(p))).map(p=>p.getElementsByTagNameNS(W,'ind')[0]?.getAttributeNS(W,'left')),['0','960','1350','1740','1350','960']);
 const b=await format(a.output);assert.deepEqual(b.parts['word/document.xml'],a.parts['word/document.xml']);
 assert.ok(a.result.validations.some(v=>v.code==='dr-numbering' && /编号/.test(v.detail)));
});
test('DR: shared native list definitions are not rewritten for unrelated lists',async()=>{
 const parts=unzipSync(input(['第一条 要求合作：']));let xml=dec.decode(parts['word/document.xml']).replace('<w:sectPr/>','<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>提交报告。</w:t></w:r></w:p><w:sectPr/>');parts['word/document.xml']=enc.encode(xml);
 parts['word/numbering.xml']=enc.encode(`<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="(%1)"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="0"/></w:num></w:numbering>`);
 const a=await format(zipSync(parts));const n=new DOMParser().parseFromString(dec.decode(a.parts['word/numbering.xml']),'application/xml');const nums=[...n.getElementsByTagNameNS(W,'num')];assert.equal(nums[1].getElementsByTagNameNS(W,'lvlOverride').length,0);
 assert.equal(nums[0].getElementsByTagNameNS(W,'numFmt')[0]?.getAttributeNS(W,'val'),'chineseCounting');
 assert.equal(nums[0].getElementsByTagNameNS(W,'start')[0]?.getAttributeNS(W,'val'),'3');
 const b=await format(a.output);assert.deepEqual(b.parts['word/numbering.xml'],a.parts['word/numbering.xml']);
});
test('DR guard rejects changed values and changed body words',()=>{assert.equal(validMarkerChange('(b)正文；','（二）正文。'),true);assert.equal(validMarkerChange('(b)正文；','（三）正文；'),false);assert.equal(validMarkerChange('(b)正文；','（二）别的正文；'),false);assert.equal(validMarkerChange('(i)正文','（一）正文'),false);assert.equal(validMarkerChange('(i)正文','（九）正文'),true);});
test('DR refuses to guess when a series is its own child',()=>{const plan=planHierarchy([{text:'第一条 方案：',family:'article',value:1,level:0,top:true},{text:'（一）方案：',family:'chinese',value:1,level:1},{text:'（一）子项。',family:'chinese',value:1,level:1}],'zh');assert.match(plan[2].reason,/冲突/);});
test('DR: canonical ranks remain correct after returning from a grandchild',async()=>{
 const a=await format(input(['第一条 方案：','（一）机构：','（子）秘书处：','（甲）存档；','（丑）审查；','（二）监督。']));
 assert.deepEqual(a.paragraphs.map(text).filter(t=>/^(第|（)/.test(t)),['第一条 方案：','（一）机构：','（子）秘书处：','（甲）存档；','（丑）审查；','（二）监督。']);
 assert.equal(a.result.validations.some(v=>v.code==='dr-numbering' && /冲突/.test(v.detail)),false);
});
test('DR: jumps and article numbers are preserved, not silently renumbered',async()=>{
 const a=await format(input(['第三条 方案：','（c）记录；','（e）核查。']));
 assert.deepEqual(a.paragraphs.map(text).filter(t=>/^(第|（)/.test(t)),['第三条 方案：','（三）记录；','（五）核查。']);
});
test('DR: identical native families can have distinct ranks only with distinct list identity and parent evidence',()=>{
 const items=[{text:'第一条 方案：',family:'article',value:1,level:0,top:true},{text:'机构：',family:'letter',value:null,level:1,key:'1:0'},{text:'秘书处。',family:'letter',value:null,level:1,key:'2:0'},{text:'监督。',family:'letter',value:null,level:1,key:'1:0'}];
 assert.deepEqual(planHierarchy(items,'zh').map(p=>p.level),[0,1,2,1]);
});
test('DR: mixed series without a parent separator are flagged, not presumed correct',()=>{
 const p=planHierarchy([{text:'第一条 方案。',family:'article',value:1,level:0,top:true},{text:'(a)机构；',family:'letter',value:1,level:1},{text:'（一）秘书处；',family:'chinese',value:1,level:1}],'zh');
 assert.match(p[2].reason,/缺少明确父子关系/);
});
test('DR: English and extended handbook markers preserve ordinal identity',()=>{
 assert.equal(markerText('en',0,3),'3.');assert.equal(markerText('en',1,3),'(c)');assert.equal(markerText('en',2,4),'(iv)');assert.equal(markerText('en',3,4),'iv.');
 assert.equal(markerText('zh',2,13),'（子子）');assert.equal(markerText('zh',3,11),'（甲甲）');
 assert.equal(markerOf('（子子）内容').value,13);assert.equal(markerOf('(i)内容',false).value,9);assert.equal(markerOf('(i)内容',true).value,1);
});
test('DR: native cycling formats cannot represent an extended series',()=>{
 const xml=new DOMParser().parseFromString(`<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="12"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="(%1)"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,'application/xml');
 assert.equal(nativeRangeReason(xml,{id:'1',ilvl:'0',level:2,language:'zh'},1),'');
 assert.match(nativeRangeReason(xml,{id:'1',ilvl:'0',level:2,language:'zh'},2),/循环格式/);
});
test('DR: a missing committee subject cannot turn article text into preamble',async()=>{
 const a=await format(input(['第一条呼吁合作：','（a）设立机构。']));
 assert.ok(a.paragraphs.some(p=>text(p)==='第一条呼吁合作：'));
 assert.ok(a.paragraphs.some(p=>text(p)==='（一）设立机构。'));
});
test('DR: ambiguity stays visible on a second pass; its parent colon is not erased',async()=>{
 const a=await format(input(['第一条 方案：','（一）机构：','（一）秘书处：','（二）监督。']));
 const b=await format(a.output);
 assert.ok(a.paragraphs.some(p=>text(p)==='（一）机构：'));
 for(const r of [a,b]) assert.ok(r.result.validations.some(v=>v.code==='dr-numbering' && /冲突/.test(v.detail)));
 assert.deepEqual(a.parts['word/document.xml'],b.parts['word/document.xml']);
});
