import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

function sourceTree(file){const text=fs.readFileSync(file,'utf8');return ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);}
function findNode(tree,predicate){let result;function visit(node){if(!result&&predicate(node))result=node;ts.forEachChild(node,visit);}visit(tree);assert.ok(result);return result;}
function javascript(node,tree){return ts.transpileModule(node.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext}}).outputText;}

test('reader scanner ignores delayed previous results and navigation invalidation',async()=>{
 const tree=sourceTree('app/reader/catalog-panel.tsx'),node=findNode(tree,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='scan');
 const pending=[],opens=[],state={},scanGeneration={current:0};
 const scan=new Function('active','scanGeneration','setScanCode','setMessage','readerFetch','setScanResults','openBook',javascript(node,tree)+';return scan;')(true,scanGeneration,v=>state.code=v,v=>state.message=v,()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),v=>state.results=v,v=>opens.push(v));
 const first=scan('old'),second=scan('new');pending[1].resolve({result:{matches:[{edition_id:'new'}]}});await second;
 pending[0].resolve({result:{matches:[{edition_id:'old'}]}});await first;assert.deepEqual(opens,['new']);assert.equal(state.results[0].edition_id,'new');
 const third=scan('leaving');scanGeneration.current++;pending[2].resolve({result:{matches:[{edition_id:'hidden'}]}});await third;assert.deepEqual(opens,['new']);
 const fourth=scan('bad-old');scanGeneration.current++;pending[3].reject(Error('stale'));await fourth;assert.notEqual(state.message,'stale');
});

test('photo profile refresh preserves dirty fields but switching reader resets drafts',()=>{
 const file='app/reader/profile-panel.tsx',tree=sourceTree(file),node=findNode(tree,n=>ts.isCallExpression(n)&&n.expression.getText(tree)==='useEffect');
 const callback=javascript(node.arguments[0],tree),draft={current:{readerId:'reader-a',dirty:true}},intent={current:'old-request'},state={name:'Незбережений псевдонім',phone:'0123456789'};
 const run=profile=>new Function('profile','draft','intent','setName','setPhone','setCommunity','setLoans','setBooks','return '+callback)(profile,draft,intent,v=>state.name=v,v=>state.phone=v,()=>{},()=>{},()=>{})();
 run({id:'reader-a',displayName:'Читач',phone:'',communityEnabled:false,notifyLoans:false,notifyBooks:false});assert.equal(state.name,'Незбережений псевдонім');assert.equal(state.phone,'0123456789');assert.equal(intent.current,null);
 run({id:'reader-b',displayName:'Інший читач',phone:''});assert.equal(state.name,'Інший читач');assert.equal(state.phone,'');assert.equal(draft.current.dirty,false);
 assert.match(fs.readFileSync(file,'utf8'),/<fieldset disabled=\{busy\}/);assert.match(fs.readFileSync(file,'utf8'),/draft\.current\.dirty=false;onProfile\(response\.profile\)/);
});
