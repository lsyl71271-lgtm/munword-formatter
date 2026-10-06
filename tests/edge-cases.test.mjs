import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync } from 'fflate';
import { parseDocxInBrowser, formatDocxInBrowser } from '../app/docx-browser.ts';
import { markerOf, validMarkerChange } from '../app/numbering.ts';

const dom = new JSDOM('');
globalThis.DOMParser = dom.window.DOMParser;
globalThis.XMLSerializer = dom.window.XMLSerializer;
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const enc = new TextEncoder(), dec = new TextDecoder();
const p = text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const types = ['position-paper', 'working-paper', 'draft-directive', 'draft-resolution', 'friendly-amendment', 'unfriendly-amendment'];
const titles = ['立场文件', '工作文件', '指令草案', '决议草案', '友好修正案', '非友好修正案'];
const numbering = `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
function pack(type, body, extras = {}) {
  return zipSync({
    '[Content_Types].xml': enc.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'word/document.xml': enc.encode(`<w:document xmlns:w="${W}"><w:body>${[titles[types.indexOf(type)], '委员会：联合国大会', '议题：合作', '国家：中国', '代表：测试', '起草国：中国', '附议国：法国'].map(p).join('')}${body}<w:sectPr/></w:body></w:document>`),
    ...extras,
  }).buffer;
}
async function format(input, type) {
  const result = formatDocxInBrowser(input, parseDocxInBrowser(input, type), {sessionLabel: '', submittingCountry: '', version: 'v1'});
  const bytes = await result.blob.arrayBuffer();
  const parts = unzipSync(new Uint8Array(bytes));
  const xml = new DOMParser().parseFromString(dec.decode(parts['word/document.xml']), 'application/xml');
  const paragraphs = [...xml.getElementsByTagNameNS(W, 'p')];
  return {result, bytes, xml, paragraphs, texts: paragraphs.map(el => [...el.getElementsByTagNameNS(W, 't')].map(t => t.textContent).join(''))};
}
for (const type of types) test(`${type}: decimal quantities and compound outlines never become single ordinals`, async () => {
  const lines = ['1.5 亿美元用于合作。', '1.1 资金安排', '1.2.3 项目说明', '2．5 吨物资。'];
  const a = await format(pack(type, [...lines, '3. 要求落实。'].map(p).join('')), type);
  for (const text of lines) assert.ok(a.texts.includes(text), a.texts.join('\n'));
  const b = await format(a.bytes, type);
  assert.deepEqual(b.texts, a.texts);
  assert.equal(validMarkerChange('1.5 亿美元。', '第一条5 亿美元。'), false);
});
for (const tag of ['bookmarkEnd', 'commentRangeStart', 'commentRangeEnd', 'permEnd', 'moveFromRangeEnd']) {
  test(`blank-looking paragraph retains ${tag} and exports successfully`, async () => {
    const body = p('第一条 要求合作。') + `<w:p><w:${tag} w:id="7"/></w:p>`;
    const a = await format(pack('draft-resolution', body), 'draft-resolution');
    const b = await format(a.bytes, 'draft-resolution');
    for (const output of [a, b]) assert.equal(output.xml.getElementsByTagNameNS(W, tag).length, 1);
  });
}
test('empty native list items preserve subsequent counters; marked whitespace is retained', async () => {
  const item = text => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const body = item('提交计划。') + item('') + item('提交报告。') + '<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t xml:space="preserve"> </w:t></w:r></w:p>';
  const a = await format(pack('working-paper', body, {'word/numbering.xml': enc.encode(numbering)}), 'working-paper');
  const b = await format(a.bytes, 'working-paper');
  for (const output of [a, b]) {
    assert.equal(output.xml.getElementsByTagNameNS(W, 'numId').length, 3);
    assert.equal(output.xml.getElementsByTagNameNS(W, 'vanish').length, 1);
  }
});
for (const mode of ['direct-level', 'derived-level', 'disabled']) test(`list properties inherit independently: ${mode}`, async () => {
  const styles = `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="List"><w:name w:val="List"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Derived"><w:name w:val="Derived"/><w:basedOn w:val="List"/><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr></w:style></w:styles>`;
  const own = mode === 'derived-level' ? '' : `<w:numPr>${mode === 'disabled' ? '<w:numId w:val="0"/>' : '<w:ilvl w:val="0"/>'}</w:numPr>`;
  const body = `<w:p><w:pPr><w:pStyle w:val="${mode === 'derived-level' ? 'Derived' : 'List'}"/>${own}</w:pPr><w:r><w:t>正文列表内容。</w:t></w:r></w:p>`;
  const a = await format(pack('working-paper', body, {'word/styles.xml': enc.encode(styles), 'word/numbering.xml': enc.encode(numbering)}), 'working-paper');
  const b = await format(a.bytes, 'working-paper');
  for (const output of [a, b]) {
    const paragraph = output.paragraphs.find(el => el.textContent.includes('正文列表内容'));
    const id = paragraph.getElementsByTagNameNS(W, 'numId')[0]?.getAttributeNS(W, 'val');
    assert.equal(id, mode === 'disabled' ? '0' : '1');
  }
});
test('very long numeric prefixes are bounded and do not crash recognition', () => {
  assert.equal(markerOf('9'.repeat(5000) + '. text'), null);
  assert.equal(markerOf('0'.repeat(5000) + '3. text')?.value, 3);
});

test('ZIP local filenames, sizes and CRC must agree with the central directory', async () => {
  const {readPackage} = await import('../app/docx-safety.ts');
  for (const mode of ['name', 'crc', 'compressed-size', 'expanded-size']) {
    const bytes = new Uint8Array(pack('working-paper', p('正文。')));
    const view = new DataView(bytes.buffer);
    if (mode === 'name') bytes[30] ^= 1;
    else { const offset = {crc: 14, 'compressed-size': 18, 'expanded-size': 22}[mode]; view.setUint32(offset, view.getUint32(offset, true) + 1, true); }
    assert.throws(() => readPackage(bytes.buffer), /不一致/, mode);
  }
});

test('ZIP data-descriptor archives remain supported', async () => {
  const {Zip, ZipPassThrough} = await import('fflate');
  const {readPackage} = await import('../app/docx-safety.ts');
  const chunks = [];
  const zip = new Zip((error, bytes) => { if (error) throw error; chunks.push(bytes); });
  const parts = unzipSync(new Uint8Array(pack('working-paper', p('正文。'))));
  for (const [name, bytes] of Object.entries(parts)) { const part = new ZipPassThrough(name); zip.add(part); part.push(bytes, true); }
  zip.end();
  const data = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0; for (const chunk of chunks) { data.set(chunk, at); at += chunk.length; }
  assert.deepEqual(readPackage(data.buffer)['word/document.xml'], parts['word/document.xml']);
});
