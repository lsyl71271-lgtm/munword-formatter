import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {zipSync,unzipSync} from 'fflate';
import {parseDocxInBrowser,formatDocxInBrowser} from '../app/docx-browser.ts';
import {nativeLevel,sequenceIssues} from '../app/numbering.ts';
import {verifyPackage} from '../app/content-guard.ts';
const dom=new JSDOM('');globalThis.DOMParser=dom.window.DOMParser;globalThis.XMLSerializer=dom.window.XMLSerializer;
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main', enc=new TextEncoder(),dec=new TextDecoder();
const types=['position-paper','working-paper','draft-directive','draft-resolution','friendly-amendment','unfriendly-amendment'];
const titles=['立场文件','工作文件','指令草案','决议草案','友好修正案','非友好修正案'];
const p=t=>`<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
function source(type,lines,en=false) {
 const header=en ? ['Committee: General Assembly','Topic: Cooperation','Country: China','Sponsors: China','Signatories: France'] : ['委员会：联合国大会','议题：合作','国家：中国','起草国：中国','附议国：法国'];
 const title=en ? ['Position Paper','Working Paper','Draft Directive','Draft Resolution','Friendly Amendment','Unfriendly Amendment'][types.indexOf(type)] : titles[types.indexOf(type)];
 return zipSync({'[Content_Types].xml':enc.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),'word/document.xml':enc.encode(`<w:document xmlns:w="${W}"><w:body>${[title,...header,...lines].map(p).join('')}<w:sectPr/></w:body></w:document>`)});
}
async function run(bytes,type) {
 const input=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
 const result=formatDocxInBrowser(input,parseDocxInBrowser(input,type),{sessionLabel:'',submittingCountry:'',version:'v1'});
 const output=new Uint8Array(await result.blob.arrayBuffer()),parts=unzipSync(output),xml=new DOMParser().parseFromString(dec.decode(parts['word/document.xml']),'application/xml');
 const texts=[...xml.getElementsByTagNameNS(W,'p')].map(p=>[...p.getElementsByTagNameNS(W,'t')].map(t=>t.textContent).join(''));
 return {result,output,parts,xml,texts};
}
for(const type of types) test(`${type}: every type reports its own numbering check, even without a list`,async()=>{
 const a=await run(source(type,['普通正文提到第一条和（一），不应改写。']),type);
 const check=a.result.validations.find(v=>v.code==='numbering-policy');assert.ok(check);assert.match(check.detail,/未发现/);
 assert.ok(a.texts.includes('普通正文提到第一条和（一），不应改写。'));
});
test('working paper: foreign article markers normalize, PART numbering can restart, body references survive',async()=>{
 const a=await run(source('working-paper',['Part I: Cooperation','第三条 提交方案：','（一）保留“第一条”引用。','Part II: Review','第一条 审查。']),'working-paper');
 assert.ok(a.texts.includes('3. 提交方案：'));assert.ok(a.texts.includes('(a)保留“第一条”引用。'));assert.ok(a.texts.includes('1. 审查。'));
 const b=await run(a.output,'working-paper');assert.deepEqual(b.parts['word/document.xml'],a.parts['word/document.xml']);
});
for(const en of [false,true]) test(`directive ${en?'en':'zh'}: subtype markers follow directive profile, not DR profile`,async()=>{
 const lines=en ? ['1. Requests cooperation:','(a) Provide resources.'] : ['第一条 要求合作：','(a) 提交方案。'];
 const a=await run(source('draft-directive',lines,en),'draft-directive');
 assert.ok(a.texts.some(t=>en ? t.startsWith('a. Provide') : t.startsWith('（一） 提交')));
 assert.ok(a.texts.some(t=>en ? t.startsWith('1. Requests') : t.startsWith('1. 要求')));
 const b=await run(a.output,'draft-directive');assert.deepEqual(b.parts['word/document.xml'],a.parts['word/document.xml']);
});
test('position paper: section numbering stays distinct; bracketed suggestion children normalize',async()=>{
 const a=await run(source('position-paper',['（一）议题背景','普通论述。','一、国际措施','1. 建议：','(a) 提供资源。']),'position-paper');
 assert.ok(a.texts.includes('（一）议题背景'));assert.ok(a.texts.includes('一、国际措施'));assert.ok(a.texts.includes('a) 提供资源。'));
 const b=await run(a.output,'position-paper');assert.deepEqual(b.parts['word/document.xml'],a.parts['word/document.xml']);
});
for(const type of types.filter(t=>t.includes('amendment'))) test(`${type}: operation numbering corrects, referenced and nested target clauses never rewrite`,async()=>{
 const a=await run(source(type,['第一条 修改第五条第（一）款（子）：“原文”；','2. 加入如下条款：','（a）引用的待新增内容。']),type);
 assert.ok(a.texts.some(t=>t.startsWith('1. 修改第五条第（一）款（子）：“原文”')));
 assert.ok(a.texts.some(t=>t.startsWith('（a）引用的待新增内容')));
 assert.ok(a.result.validations.some(v=>v.code==='list-numbering' && /目标草案/.test(v.detail)));
 const b=await run(a.output,type);assert.deepEqual(b.parts['word/document.xml'],a.parts['word/document.xml']);
});
test('native non-DR presentation uses per-type profile and cannot exempt counter tampering',async()=>{
 const type='working-paper',parts=unzipSync(source(type,['1. 方案：']));
 parts['word/document.xml']=enc.encode(dec.decode(parts['word/document.xml']).replace('<w:sectPr/>',`<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>资源。</w:t></w:r></w:p><w:sectPr/>`));
 parts['word/numbering.xml']=enc.encode(`<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="（%1）"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`);
 const before=zipSync(parts),a=await run(before,type),n=new DOMParser().parseFromString(dec.decode(a.parts['word/numbering.xml']),'application/xml');
 const level=nativeLevel(n,'1','0');assert.equal(level.getElementsByTagNameNS(W,'numFmt')[0].getAttributeNS(W,'val'),'lowerLetter');
 assert.equal(level.getElementsByTagNameNS(W,'start')[0].getAttributeNS(W,'val'),'3');
 const rules=[{id:'1',ilvl:'0',language:'zh',level:1,type}];assert.deepEqual(verifyPackage(before,a.output,rules),[]);
 level.getElementsByTagNameNS(W,'start')[0].setAttributeNS(W,'w:val','4');a.parts['word/numbering.xml']=enc.encode(new XMLSerializer().serializeToString(n));assert.ok(verifyPackage(before,zipSync(a.parts),rules).length);
 const b=await run(a.output,type);assert.deepEqual(b.parts['word/numbering.xml'],unzipSync(a.output)['word/numbering.xml']);
});
test('protected hyperlink markers and unprovable hierarchy warn instead of guessing',async()=>{
 const type='working-paper',parts=unzipSync(source(type,['1. 方案：','（一）资源。']));
 parts['word/document.xml']=enc.encode(dec.decode(parts['word/document.xml']).replace(p('（一）资源。'),`<w:p><w:hyperlink w:anchor="target"><w:r><w:t>（一）资源。</w:t></w:r></w:hyperlink></w:p>`));
 const a=await run(zipSync(parts),type);assert.ok(a.texts.includes('（一）资源。'));assert.ok(a.result.validations.some(v=>v.code==='content-protected'));
 const b=await run(source(type,['(a) 没有父项。']),type);assert.ok(b.texts.includes('(a) 没有父项。'));assert.ok(b.result.validations.some(v=>/无明确顶层/.test(v.detail)));
});
test('numbering sequence checks include Roman values, duplicate ones and valid PART restarts',()=>{
 const items=[{text:'1. Parent:',family:'decimal',value:1,level:0},{text:'(i) a',family:'roman',value:1,level:2},{text:'(iii) b',family:'roman',value:3,level:2},{text:'Part II',family:'',value:null,level:0,reset:true},{text:'1. Start again',family:'decimal',value:1,level:0}];
 assert.deepEqual(sequenceIssues(items),[{index:2,previous:1}]);
 assert.deepEqual(sequenceIssues([{text:'1. a',family:'decimal',value:1,level:0},{text:'1. b',family:'decimal',value:1,level:0}]),[{index:1,previous:1}]);
});
test('WP foreign child family follows its proven parent, not the DR glyph rank; repeat is stable',async()=>{
 const a=await run(source('working-paper',['1. 方案：','（子）资源。']),'working-paper');
 assert.ok(a.texts.includes('(a)资源。'));
 const b=await run(a.output,'working-paper');assert.deepEqual(b.parts['word/document.xml'],a.parts['word/document.xml']);
});
