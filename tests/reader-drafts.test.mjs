import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the exact storage/dirty primitives used by React, without a DOM or a fake browser.
function engine(){
 const source=fs.readFileSync('app/librarian/literature/literature-navigation.tsx','utf8');
 const primitives=source.slice(source.indexOf('const same='),source.indexOf('export function useRetainedState')).replaceAll('export function','function');
 const memory=new Map(),context={Blob,File,Uint8Array,btoa,atob,sessionStorage:{getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)},result:null};
 const code='const draftRegistry=new Map(),drafts=new Map();'+primitives+';globalThis.result={same,saveDraft,readDraft,discardDraft,clearLiteratureDraft,acceptLiteratureFields,refreshParents,draftRegistry};';
 vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,context);
 return {...context.result,memory,context};
}
function draft(key,values=[],parent=null){return {key,values:new Map(values),dirty:values.length>0,parent,fields:new Map()};}

test('untouched and restored-to-original values are clean; distinct selected photos are not equal',()=>{
 const e=engine();assert.equal(e.same({name:'Учень',about:''},{name:'Учень',about:''}),true);assert.equal(e.same({about:'Текст'},{about:''}),false);
 assert.equal(e.same(new File(['a'],'a.jpg'),new File(['b'],'b.jpg')),false);
});
test('photo draft preserves bytes, file identity metadata and crop settings through storage',async()=>{
 const e=engine(),photo=new File([new Uint8Array([0,128,255,10])],'camera.jpg',{type:'image/jpeg',lastModified:1234}),d=draft('photo',[['file',photo],['crop',{zoom:1.5,rotation:90}]]);
 e.draftRegistry.set(d.key,d);await e.saveDraft(d);const restored=e.readDraft('photo');
 assert.equal(restored.get('file').name,'camera.jpg');assert.equal(restored.get('file').type,'image/jpeg');assert.equal(restored.get('file').lastModified,1234);assert.deepEqual([...new Uint8Array(await restored.get('file').arrayBuffer())],[0,128,255,10]);assert.equal(restored.get('crop').rotation,90);
});
test('parent save and discard include retained nested forms even after their page unmounts',async()=>{
 const e=engine(),parent=draft('return'),child=draft('loan-1',[['location','loc-2']],parent);e.draftRegistry.set(parent.key,parent);e.draftRegistry.set(child.key,child);e.refreshParents(child);assert.equal(parent.dirty,true);
 await e.saveDraft(parent);assert.equal(e.readDraft('loan-1').get('location'),'loc-2');e.discardDraft(parent);assert.equal(e.readDraft('loan-1').size,0);assert.equal(child.dirty,false);assert.equal(parent.dirty,false);
});
test('discarding only a photo never discards its parent book title; accepting a field updates baseline',async()=>{
 const e=engine(),parent=draft('book',[['title','Моя книга']]),child=draft('book-photo',[['zoom',2]],parent);e.draftRegistry.set(parent.key,parent);e.draftRegistry.set(child.key,child);let restored;
 parent.fields.set('title',{baseline:'',current:'Моя книга',reset:value=>restored=value});e.discardDraft(child);assert.equal(parent.values.get('title'),'Моя книга');assert.equal(parent.dirty,true);
 e.acceptLiteratureFields(parent,['title']);assert.equal(parent.dirty,false);assert.equal(parent.fields.get('title').baseline,'Моя книга');e.discardDraft(parent);assert.equal(restored,'Моя книга');
});
test('storage failure rejects save and preserves all edited data',async()=>{
 const e=engine(),d=draft('account',[['about','Залишити цей текст']]);e.draftRegistry.set(d.key,d);e.context.sessionStorage.setItem=()=>{throw Error('quota');};await assert.rejects(e.saveDraft(d),/quota/);assert.equal(d.dirty,true);assert.equal(d.values.get('about'),'Залишити цей текст');
});
