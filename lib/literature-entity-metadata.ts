type RecordValue=Record<string,unknown>;
const object=(v:unknown):RecordValue=>v&&typeof v==='object'&&!Array.isArray(v)?v as RecordValue:{};
const parse=(v:unknown)=>{try{return typeof v==='string'?JSON.parse(v):v;}catch{return {};}};

/** Read preserved source fields without overwriting local edits or source provenance. */
export function literatureEntityMetadata(record:RecordValue):RecordValue {
 const own={...object(parse(record.public_metadata_json))};
 if(record.kind!=='publisher')return own;
 const source=parse(record.source_json),packets=Array.isArray(source)?source:[source];
 const rows:RecordValue[]=[];
 for(const raw of packets.slice(0,100)){const p=object(raw);if(Array.isArray(p.csvRows))rows.push(...p.csvRows.slice(0,100).map(object));if(p.row)rows.push(object(p.row));if(p.capture)rows.push(object(p.capture));if(!p.csvRows&&!p.row&&!p.capture)rows.push(p);}
 const fields:Record<string,string[]>={address:['Address','address'],city:['City','city'],location:['Location','location','Location / Address'],country:['Country','country'],email:['Email','email','E-mail'],phone:['Phone','phone','Telephone'],website:['Website','website','Webpage']};
 for(const[key,names]of Object.entries(fields)){
  if(Object.hasOwn(own,key)&&!(key==='website'&&record.version===1&&!own[key]))continue;
  const values=Array.from(new Set(rows.flatMap(r=>names.map(n=>r[n])).filter(v=>typeof v==='string').map(v=>String(v).trim()).filter(Boolean)));
  if(values.length===1)own[key]=values[0];
 }
 return own;
}
