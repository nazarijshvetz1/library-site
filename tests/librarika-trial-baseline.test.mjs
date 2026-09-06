import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {captureTrialBaseline,verifyTrialBaseline,applyPendingTrialMigrations,rowsDigest} from '../scripts/librarika-trial-baseline.mjs';

test('trial permits only initially empty import tables and audit append, protecting all original rows and DDL',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec("CREATE TABLE library_import_runs(id TEXT);CREATE TABLE reader_class_enrollments(id TEXT);INSERT INTO reader_class_enrollments VALUES('existing');CREATE TABLE audit_events(id TEXT,body TEXT);INSERT INTO audit_events VALUES('old','preserve');");
  const before=captureTrialBaseline(db,{allowAuditAppend:true});db.exec("INSERT INTO library_import_runs VALUES('new');INSERT INTO audit_events VALUES('new','allowed')");assert.equal(verifyTrialBaseline(db,before),true);
  assert.throws(()=>captureTrialBaseline(db),/empty existing import/);
  db.exec("UPDATE audit_events SET body='changed' WHERE id='old'");assert.throws(()=>verifyTrialBaseline(db,before),/audit row changed/);db.exec("UPDATE audit_events SET body='preserve' WHERE id='old'");
  db.exec("DELETE FROM reader_class_enrollments");assert.throws(()=>verifyTrialBaseline(db,before),/data changed/);db.exec("INSERT INTO reader_class_enrollments VALUES('existing');ALTER TABLE library_import_runs ADD COLUMN extra TEXT");assert.throws(()=>verifyTrialBaseline(db,before),/DDL changed/);
 }finally{db.close();}
 assert.equal(rowsDigest([{b:2,a:1},{a:3}]),rowsDigest([{a:3},{a:1,b:2}]));
});

test('trial uses exact migration filenames, rejects unknown/gapped ledger and never masks existing schema errors',()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'library-trial-migrations-')),db=new DatabaseSync(':memory:');
 try{
  fs.writeFileSync(path.join(folder,'0043_old.sql'),'CREATE TABLE already_present(id TEXT);');fs.writeFileSync(path.join(folder,'0044_new.sql'),'CREATE TABLE new_table(id TEXT);');
  assert.throws(()=>applyPendingTrialMigrations(db,folder),/ledger is required/);
  db.exec("CREATE TABLE __appgarden_migrations(id INTEGER,name TEXT);INSERT INTO __appgarden_migrations VALUES(999,'0043_old.sql');CREATE TABLE already_present(id TEXT)");
  assert.deepEqual(applyPendingTrialMigrations(db,folder),['0044_new.sql']);assert.equal(db.prepare('SELECT count(*) n FROM __appgarden_migrations').get().n,1);
  assert.throws(()=>applyPendingTrialMigrations(db,folder),/already exists/);
  db.exec("DELETE FROM __appgarden_migrations;INSERT INTO __appgarden_migrations VALUES(1,'0044_new.sql')");assert.throws(()=>applyPendingTrialMigrations(db,folder),/Non-contiguous/);
  db.exec("INSERT INTO __appgarden_migrations VALUES(2,'0045_unknown.sql')");assert.throws(()=>applyPendingTrialMigrations(db,folder),/Unknown applied/);
 }finally{db.close();fs.rmSync(folder,{recursive:true,force:true});}
});
