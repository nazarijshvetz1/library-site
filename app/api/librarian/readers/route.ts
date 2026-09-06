import {getLibrarikaActivation,requireLibrarikaActivationEdition} from "@/lib/librarika-activation";
import {env} from "cloudflare:workers";
import {authorizeLibrarianApi,isSameOriginRequest,librarianError,librarianJson} from "@/lib/librarian-api";
import {readBoundedJson} from "@/lib/bounded-json";
import {ReaderError,readerFail,type ReaderDatabase} from "@/lib/reader-core";
import {issueReaderInvite} from "@/lib/reader-auth";
import {telegramMiniAppPublicConfiguration} from "@/lib/telegram-mini-app-auth";
import * as admin from "@/lib/library-reader-admin";
import * as copies from "@/lib/library-copy-store";
import * as editor from "@/lib/library-editor";
export const dynamic="force-dynamic";
export async function GET(request:Request){const auth=await authorizeLibrarianApi();if(!auth.ok)return auth.response;try{const db=env.DB as unknown as ReaderDatabase,url=new URL(request.url),view=url.searchParams.get("view")||"readers";let result:unknown;
  if(view==="readers")result=await admin.listLibraryReaders(db,url);
  else if(view==="options")result={...await admin.libraryReaderOptions(db),telegram:telegramMiniAppPublicConfiguration()};
  else if(view==="dashboard")result=await admin.libraryReaderDashboard(db);
  else if(view==="circulations")result=await admin.listReaderCirculations(db,url);
  else if(view==="copies")result=await admin.listLibrarianCopies(db,url);
  else if(view==="requests")result=await admin.listReaderRequests(db);
  else if(view==="moderation")result=await admin.libraryModerationQueue(db);
  else if(view==="edition")result=await editor.getLibrarianEdition(db,url.searchParams.get("id")||"");
  else if(view==="entities")result=(await db.prepare("SELECT id,kind,name,public_metadata_json,version FROM library_catalog_entities WHERE kind IN ('author','publisher','genre') ORDER BY kind,name,id LIMIT 3000").all()).results||[];
  else if(view==="activation"){if(auth.value.access.role!=="admin")readerFail("admin_required","Потрібні права адміністратора.",403);result=await getLibrarikaActivation(db,url.searchParams.get("runId")||"",url.searchParams.get("planSha256")||"");}
  else if(view==="editions")result=(await db.prepare("SELECT id,title,material_id,publication_state,version,json_extract(public_metadata_json,'$.isbn13') isbn13 FROM library_editions ORDER BY title,id LIMIT 2000").all()).results||[];
  else readerFail("reader_view","Невідомий розділ.");return librarianJson({success:true,result});
}catch(error){return failure(error);}}
export async function POST(request:Request){const auth=await authorizeLibrarianApi();if(!auth.ok)return auth.response;const {user,access}=auth.value;if(!access.writesEnabled||!user.d1UserId)return librarianError(503,"writes_disabled","Запис тимчасово вимкнено.",false);if(!isSameOriginRequest(request))return librarianError(403,"origin","Запит має надійти з цього сайту.",true);
  try{const body=await readBoundedJson(request,400000),input=body.input;if(!input||typeof input!=="object"||Array.isArray(input))readerFail("reader_input","Некоректна форма дії.");const db=env.DB as unknown as ReaderDatabase,actor={id:user.d1UserId,email:user.email||""};let result:unknown;
    if(body.action==="save")result=await admin.saveLibraryReader(db,actor,input as Parameters<typeof admin.saveLibraryReader>[2]);
    else if(body.action==="invite")result=await issueReaderInvite(db,actor,input as Parameters<typeof issueReaderInvite>[2]);
    else if(body.action==="access")result=await admin.changeReaderAccess(db,actor,input as Parameters<typeof admin.changeReaderAccess>[2]);
    else if(body.action==="teacher_link")result=await admin.linkReaderTeacher(db,actor,input as Parameters<typeof admin.linkReaderTeacher>[2]);
    else if(body.action==="issue")result=await copies.issueReaderCopy(db,actor,input as Parameters<typeof copies.issueReaderCopy>[2]);
    else if(body.action==="return")result=await copies.returnReaderCopy(db,actor,input as Parameters<typeof copies.returnReaderCopy>[2]);
    else if(body.action==="due")result=await copies.changeReaderDueDate(db,actor,input as Parameters<typeof copies.changeReaderDueDate>[2]);
    else if(body.action==="copy_register")result=await copies.registerLibraryCopy(db,actor,input as Parameters<typeof copies.registerLibraryCopy>[2]);
    else if(body.action==="copy_move")result=await copies.moveLibraryCopy(db,actor,input as Parameters<typeof copies.moveLibraryCopy>[2]);
    else if(body.action==="edition_save")result=await editor.saveLibraryEdition(db,actor,input as Parameters<typeof editor.saveLibraryEdition>[2]);
    else if(body.action==="entity_save")result=await editor.saveLibraryEntity(db,actor,input as Parameters<typeof editor.saveLibraryEntity>[2]);
    else if(body.action==="activate"){if(access.role!=="admin")readerFail("admin_required","Активація імпорту доступна адміністратору.",403);const data=input as Record<string,unknown>;await requireLibrarikaActivationEdition(db,String(data.runId||""),String(data.planSha256||""),String(data.editionId||""));result=await copies.activateImportedEdition(db,actor,input as Parameters<typeof copies.activateImportedEdition>[2]);}
    else if(body.action==="request_status")result=await admin.setReaderRequestStatus(db,actor,input as Parameters<typeof admin.setReaderRequestStatus>[2]);
    else if(body.action==="moderate")result=await admin.moderateReaderContent(db,actor,input as Parameters<typeof admin.moderateReaderContent>[2]);
    else readerFail("reader_action","Невідома дія.");return librarianJson({success:true,result});
  }catch(error){return failure(error);}}
function failure(error:unknown){return error instanceof ReaderError?librarianError(error.status,error.code,error.message,true):librarianError(503,"readers_unavailable","Не вдалося підтвердити дію. Оновіть дані; повтор тієї самої підтвердженої дії не дублює облік.",true);}
