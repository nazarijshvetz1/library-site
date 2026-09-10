import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {parseLibrarikaCsv} from '../lib/librarika-csv.ts';
const [richPath,csvDirectory,snapshotPath,outputPath]=process.argv.slice(2);
if(!outputPath||!path.resolve(outputPath).split(path.sep).includes('.migration-private')||fs.existsSync(outputPath))throw Error('Provide rich metadata, CSV directory, verified snapshot and a new private output path.');
const rich=JSON.parse(fs.readFileSync(richPath,'utf8')),snapshot=JSON.parse(fs.readFileSync(snapshotPath,'utf8'));
if(snapshot.format!=='library-d1-recovery')throw Error('Verified recovery snapshot required.');
const table=name=>snapshot.tables.find(t=>t.name===name).rows;
const csv=name=>parseLibrarikaCsv(fs.readFileSync(path.join(csvDirectory,name+'-1.csv'),'utf8'));
const titles=csv('catalog-titles'),copies=csv('catalog-copies'),circulations=csv('circulations'),authors=csv('authors'),publishers=csv('publishers');
const unique=(rows,fn)=>{const found=rows.filter(fn);if(found.length!==1)throw Error('Source match is not unique.');return found[0];};
const uuid=value=>{const h=crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
const items=[],images=[];
for(const [kind,row,rows] of [['author',rich.newAuthor,authors],['publisher',rich.newPublisher,publishers]]){
 const sourceRow=unique(rows,x=>x.Name===row.name),metadata=kind==='author'?{firstName:'Андрій',lastName:'Зелінський',biography:row.biography,country:row.country,yearBorn:row.yearBornFromList,dateOfBirth:'',dateOfDeath:''}:{address:row.address,email:row.email,phone:row.phone,website:row.website,country:sourceRow.Country||''};
 const item={kind:'entity',entityKind:kind,sourceId:row.sourceId,name:row.name,sourceRow,metadata};items.push({...item,requestId:uuid(item)});
}
for(const book of rich.books){
 const sourceRow=unique(titles,x=>x.Id===book.sourceMediaId),copyRow=unique(copies,x=>x.Id===book.sourceCopyId),entities={};
 for(const [kind,ref]of [['author',book.author],['publisher',book.publisher],['genre',book.category]]){
  const found=table('library_catalog_entities').filter(x=>x.kind===kind&&x.name===ref.name);if(found.length>1)throw Error('Ambiguous dictionary match.');entities[kind]=found[0]?.id||ref.sourceId;
 }
 const metadata={type:'Книга',author:sourceRow.Authors,publisher:sourceRow.Publisher,genre:sourceRow.Category,isbn10:sourceRow.ISBN,isbn13:sourceRow.ISBN13,issn:sourceRow.ISSN,edition:sourceRow.Edition,year:sourceRow.Year,series:sourceRow.Series,tags:sourceRow.Tags,volume:sourceRow.Volume,pages:String(book.pages),annotation:book.annotation,url:sourceRow.URL||book.sourceUrl};
 const item={kind:'book',sourceId:book.sourceMediaId,title:book.title,metadata,entities,sourceRow,copy:{sourceId:book.sourceCopyId,accessionNo:book.accessionNo,copyNo:book.copyNo,sourceRow:copyRow}};items.push({...item,requestId:uuid(item)});
 const base64=fs.readFileSync(book.coverPath).toString('base64');images.push({sourceId:book.sourceMediaId,base64,requestId:uuid({sourceId:book.sourceMediaId,base64})});
}
for(const mapping of rich.circulationDeltaMappings){
 const sourceRow=unique(circulations,x=>x.ID===mapping.sourceCirculationId),existing=table('reader_circulations').find(x=>x.source_circulation_id===mapping.sourceCirculationId),copy=unique(table('library_copies'),x=>x.source_copy_id===mapping.sourceCopyId),reader=unique(table('library_readers'),x=>x.source_member_id===mapping.sourceMemberId);
 if(Boolean(existing)===mapping.new)throw Error('Source/new flag conflicts with current target.');
 const item={kind:'loan',sourceId:mapping.sourceCirculationId,sourceCopyId:mapping.sourceCopyId,sourceMemberId:mapping.sourceMemberId,sourceRow,expectedCopyVersion:copy.version,expectedReaderVersion:reader.version,...existing?{expectedVersion:existing.version,previousSourceRow:JSON.parse(existing.source_json)}:{}};items.push({...item,requestId:uuid(item)});
}
fs.mkdirSync(path.dirname(path.resolve(outputPath)),{recursive:true});fs.writeFileSync(outputPath,JSON.stringify({format:'literature-reviewed-delta-v1',capturedAt:rich.capturedDateUtc,items,images}),{flag:'wx'});console.log(JSON.stringify({items:items.length,images:images.length,books:rich.books.length,sourceLoans:circulations.length,bytes:fs.statSync(outputPath).size}));
