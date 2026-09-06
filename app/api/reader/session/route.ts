import {env} from "cloudflare:workers";
import {createReaderTelegramSession,logoutReader,previewReaderInvite,readerSessionCookie,readerTelegramRequest,redeemReaderInvite,requireReaderSession} from "@/lib/reader-auth";
import {getReaderProfile} from "@/lib/reader-profile-store";
import {limitReaderAuth,readerApiError,readerJson,readerWriteBody} from "@/lib/reader-api";
import {readerFail,type ReaderDatabase} from "@/lib/reader-core";
import {telegramMiniAppPublicConfiguration,validateTelegramMiniAppInitData} from "@/lib/telegram-mini-app-auth";
import {createVisitTeacherTelegramSession,telegramTeacherSessionCookie} from "@/lib/visit-teacher-auth";
export const dynamic="force-dynamic";
export async function GET(request:Request){try{const db=env.DB as unknown as ReaderDatabase;const identity=await requireReaderSession(db,request);return readerJson({success:true,profile:await getReaderProfile(db,identity),telegram:telegramMiniAppPublicConfiguration()});}catch(error){return readerApiError(error);}}
export async function POST(request:Request){try{
  const body=await readerWriteBody(request,24000),db=env.DB as unknown as ReaderDatabase;
  await limitReaderAuth(db,request);
  if(Object.keys(body).some(key=>!["action","token","initData","confirmation","purpose"].includes(key)))readerFail("login_fields","Некоректна форма входу.");
  if(body.action==="preview"&&typeof body.token==="string")return readerJson({success:true,preview:await previewReaderInvite(db,body.token,String(body.purpose))});
  let result:{token:string;expiresAt:string};let telegram=false;
  if(body.action==="invite"&&typeof body.token==="string"&&body.confirmation==="CONNECT_MY_READER_PROFILE")result=await redeemReaderInvite(db,body.token);
  else if(body.action==="telegram"&&typeof body.initData==="string"){
    telegram=true;const identity=await validateTelegramMiniAppInitData(body.initData);
    if(typeof body.token==="string"&&body.token){if(body.confirmation!=="CONNECT_MY_READER_PROFILE")readerFail("login_confirm","Підтвердьте приєднання свого читацького профілю.");result=await redeemReaderInvite(db,body.token,identity);}
    else {
      const teacher=await db.prepare("SELECT 1 ok FROM telegram_connections WHERE telegram_user_id=? AND status='active'").bind(identity.telegramUserId).first();
      if(teacher){const session=await createVisitTeacherTelegramSession(db,request,{telegramUserId:identity.telegramUserId,initDataHash:identity.initDataHash,authDate:identity.authDate,receiptExpiresAt:identity.expiresAt});
        if(session.kind==="activation"||session.identity.mustChangePin)readerFail("teacher_activation","Спочатку завершіть вхід у кабінеті вчителя.",401);
        const linked=await db.prepare("SELECT 1 ok FROM library_readers WHERE linked_teacher_user_id=? AND kind!='student' AND status='active' AND access_status='active'").bind(session.identity.teacherUserId).first();
        if(!linked)readerFail("teacher_reader_link","Бібліотекар ще має звірити й приєднати ваш читацький квиток до кабінету вчителя.",409);
        const headers=new Headers();headers.append("Set-Cookie",readerSessionCookie("",true));if(session.token)headers.append("Set-Cookie",telegramTeacherSessionCookie(session.token));return readerJson({success:true,expiresAt:session.identity.expiresAt},{headers});
      }
      result=await createReaderTelegramSession(db,identity);
    }
  }else readerFail("login_invalid","Відкрийте персональне запрошення або кабінет у Telegram.");
  return readerJson({success:true,expiresAt:result.expiresAt},{headers:{"Set-Cookie":readerSessionCookie(result.token,telegram)}});
}catch(error){return readerApiError(error);}}
export async function DELETE(request:Request){try{await readerWriteBody(request);const db=env.DB as unknown as ReaderDatabase;await requireReaderSession(db,request);await logoutReader(db,request);return readerJson({success:true},{headers:{"Set-Cookie":readerSessionCookie("",readerTelegramRequest(request))}});}catch(error){return readerApiError(error);}}
