import {env} from "cloudflare:workers";
import {authorizeLibrarianApi,isSameOriginRequest,librarianError,librarianJson} from "@/lib/librarian-api";
import {readBoundedJson} from "@/lib/bounded-json";
import {ReaderError,readerFail,type ReaderDatabase} from "@/lib/reader-core";
import {issueReaderInvite} from "@/lib/reader-auth";
import {telegramMiniAppPublicConfiguration} from "@/lib/telegram-mini-app-auth";
import * as admin from "@/lib/library-reader-admin";
export const dynamic="force-dynamic";
export async function GET(request:Request){const auth=await authorizeLibrarianApi();if(!auth.ok)return auth.response;try{const db=env.DB as unknown as ReaderDatabase,url=new URL(request.url),view=url.searchParams.get("view")||"readers";let result:unknown;
  if(view==="readers")result=await admin.listLibraryReaders(db,url);
  else if(view==="options")result={...await admin.libraryReaderOptions(db),telegram:telegramMiniAppPublicConfiguration()};
  else if(view==="dashboard")result=await admin.libraryReaderDashboard(db);
  else if(["circulations","copies","requests","moderation","edition","entities","activation","editions"].includes(view))readerFail("librarika_authoritative","Ці дані художньої та наукової літератури ведуться лише у Librarika.",410);
  else readerFail("reader_view","Невідомий розділ.");return librarianJson({success:true,result});
}catch(error){return failure(error);}}
export async function POST(request:Request){const auth=await authorizeLibrarianApi();if(!auth.ok)return auth.response;const {user,access}=auth.value;if(!access.writesEnabled||!user.d1UserId)return librarianError(503,"writes_disabled","Запис тимчасово вимкнено.",false);if(!isSameOriginRequest(request))return librarianError(403,"origin","Запит має надійти з цього сайту.",true);
  try{const body=await readBoundedJson(request,400000),input=body.input;if(!input||typeof input!=="object"||Array.isArray(input))readerFail("reader_input","Некоректна форма дії.");const db=env.DB as unknown as ReaderDatabase,actor={id:user.d1UserId,email:user.email||""};let result:unknown;
    if(body.action==="save")result=await admin.saveLibraryReader(db,actor,input as Parameters<typeof admin.saveLibraryReader>[2]);
    else if(body.action==="invite")result=await issueReaderInvite(db,actor,input as Parameters<typeof issueReaderInvite>[2]);
    else if(body.action==="access")result=await admin.changeReaderAccess(db,actor,input as Parameters<typeof admin.changeReaderAccess>[2]);
    else if(body.action==="teacher_link")result=await admin.linkReaderTeacher(db,actor,input as Parameters<typeof admin.linkReaderTeacher>[2]);
    else if(["issue","return","due","copy_register","copy_move","edition_save","entity_save","activate","request_status","moderate"].includes(String(body.action)))
      readerFail("librarika_authoritative","Каталог, примірники, видачі, повернення, резервування, оцінки й відгуки художньої літератури ведуться лише у Librarika.",410);
    else readerFail("reader_action","Невідома дія.");return librarianJson({success:true,result});
  }catch(error){return failure(error);}}
function failure(error:unknown){return error instanceof ReaderError?librarianError(error.status,error.code,error.message,true):librarianError(503,"readers_unavailable","Не вдалося підтвердити дію. Оновіть дані; повтор тієї самої підтвердженої дії не дублює облік.",true);}
