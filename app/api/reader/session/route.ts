import {ensureTeacherReader} from "@/lib/reader-teacher-link";
import {env} from "cloudflare:workers";
import {createReaderTelegramSession,logoutReader,previewReaderInvite,readerSessionCookie,readerTelegramRequest,redeemReaderInvite,requireReaderSession} from "@/lib/reader-auth";
import {getReaderProfile} from "@/lib/reader-profile-store";
import {limitReaderAuth,readerApiError,readerJson,readerWriteBody} from "@/lib/reader-api";
import {readerFail,type ReaderDatabase} from "@/lib/reader-core";
import {authenticateReaderTelegramWithPin,beginReaderSignIn,completeReaderPinSetup,redeemReaderWebInviteWithPin} from "@/lib/reader-pin-auth";
import {telegramMiniAppPublicConfiguration,validateTelegramMiniAppInitData} from "@/lib/telegram-mini-app-auth";
import {createVisitTeacherTelegramSession,requireVisitTeacherSession,telegramTeacherSessionCookie} from "@/lib/visit-teacher-auth";
export const dynamic="force-dynamic";
export async function GET(request:Request){try{const db=env.DB as unknown as ReaderDatabase;const identity=await requireReaderSession(db,request);return readerJson({success:true,profile:await getReaderProfile(db,identity),telegram:telegramMiniAppPublicConfiguration()});}catch(error){return readerApiError(error);}}
export async function POST(request:Request){try{
  const body=await readerWriteBody(request,24000),db=env.DB as unknown as ReaderDatabase;
  if(Object.keys(body).some(key=>!["action","token","initData","confirmation","purpose","loginId","code","setupToken","pin","pinConfirm","mode","notifyLoans"].includes(key)))readerFail("login_fields","Некоректна форма входу.");
  if(body.action==="preview"&&typeof body.token==="string"){await limitReaderAuth(db,request);return readerJson({success:true,preview:await previewReaderInvite(db,body.token,String(body.purpose))});}
  if(body.action==="telegram_pin"&&typeof body.initData==="string"){
    await limitReaderAuth(db,request);const identity=await validateTelegramMiniAppInitData(body.initData);
    const result=await authenticateReaderTelegramWithPin(db,request,{loginId:String(body.loginId||''),code:String(body.code||''),mode:body.mode as any,pin:body.pin as string,pinConfirm:body.pinConfirm as string,notifyLoans:body.notifyLoans as boolean},identity);
    return readerJson({success:true,expiresAt:result.expiresAt},{headers:{"Set-Cookie":readerSessionCookie(result.token,true)}});
  }
  if(body.action==="login"&&typeof body.loginId==="string"&&typeof body.code==="string"){
    const login=await beginReaderSignIn(db,request,{loginId:body.loginId,code:body.code});
    if(login.kind==="setup")return readerJson({success:true,requiresPinSetup:true,setupToken:login.setupToken,expiresAt:login.expiresAt});
    return readerJson({success:true,expiresAt:login.expiresAt},{headers:{"Set-Cookie":readerSessionCookie(login.token)}});
  }
  if(body.action==="set_pin"&&typeof body.setupToken==="string"&&typeof body.pin==="string"&&typeof body.pinConfirm==="string"){
    await limitReaderAuth(db,request);const result=await completeReaderPinSetup(db,{setupToken:body.setupToken,pin:body.pin,pinConfirm:body.pinConfirm});
    return readerJson({success:true,expiresAt:result.expiresAt},{headers:{"Set-Cookie":readerSessionCookie(result.token)}});
  }
  let result:{token:string;expiresAt:string};let telegram=false;
  if(body.action==="invite"&&typeof body.token==="string"&&body.confirmation==="CONNECT_MY_READER_PROFILE"&&typeof body.pin==="string"&&typeof body.pinConfirm==="string"){
    await limitReaderAuth(db,request);result=await redeemReaderWebInviteWithPin(db,{token:body.token,pin:body.pin,pinConfirm:body.pinConfirm});
  }
  else if(body.action==="telegram"&&typeof body.initData==="string"){
    await limitReaderAuth(db,request);telegram=true;const identity=await validateTelegramMiniAppInitData(body.initData);
    if(typeof body.token==="string"&&body.token){if(body.confirmation!=="CONNECT_MY_READER_PROFILE")readerFail("login_confirm","Підтвердьте приєднання свого читацького профілю.");result=await redeemReaderInvite(db,body.token,identity);}
    else {
      const teacher=await db.prepare("SELECT tc.user_id FROM telegram_connections tc JOIN users u ON u.id=tc.user_id AND u.status='active' JOIN teacher_profiles p ON p.teacher_user_id=u.id AND p.closed_at IS NULL WHERE tc.telegram_user_id=? AND tc.status='active'").bind(identity.telegramUserId).first();
      if(teacher){try{
          const existing=await requireVisitTeacherSession(db,request);
          const linked=existing.teacherUserId===String(teacher.user_id)?await ensureTeacherReader(db,existing.teacherUserId):null;
          if(linked)return readerJson({success:true},{headers:{"Set-Cookie":readerSessionCookie("",true)}});
        }catch{/* A fresh launch is required when no matching teacher session exists. */}
        const session=await createVisitTeacherTelegramSession(db,request,{telegramUserId:identity.telegramUserId,initDataHash:identity.initDataHash,authDate:identity.authDate,receiptExpiresAt:identity.expiresAt});
        if(session.kind==="activation"||session.identity.mustChangePin)readerFail("teacher_activation","Спочатку завершіть вхід у кабінеті вчителя.",401);
        const linked=await ensureTeacherReader(db,session.identity.teacherUserId);
        if(!linked)readerFail("teacher_reader_link","Бібліотекар ще має звірити й приєднати ваш читацький квиток до кабінету вчителя.",409);
        const headers=new Headers();headers.append("Set-Cookie",readerSessionCookie("",true));if(session.token)headers.append("Set-Cookie",telegramTeacherSessionCookie(session.token));return readerJson({success:true,expiresAt:session.identity.expiresAt},{headers});
      }
      try{
        const existing=await requireReaderSession(db,new Request(request.url,{headers:request.headers}));
        const bound=await db.prepare("SELECT 1 ok FROM reader_sessions s JOIN reader_telegram_connections c ON c.reader_id=s.reader_id WHERE s.token_hash=? AND s.telegram_user_id=? AND c.telegram_user_id=? AND c.status='active'").bind(existing.tokenHash,identity.telegramUserId,identity.telegramUserId).first();
        if(existing.sessionKind==='reader'&&bound)return readerJson({success:true});
      }catch{/* Fall through to one-use exchange. */}
      result=await createReaderTelegramSession(db,identity);
    }
  }else readerFail("login_invalid","Відкрийте персональне запрошення або кабінет у Telegram.");
  return readerJson({success:true,expiresAt:result.expiresAt},{headers:{"Set-Cookie":readerSessionCookie(result.token,telegram)}});
}catch(error){return readerApiError(error);}}
export async function DELETE(request:Request){try{await readerWriteBody(request);const db=env.DB as unknown as ReaderDatabase;await requireReaderSession(db,request);await logoutReader(db,request);return readerJson({success:true},{headers:{"Set-Cookie":readerSessionCookie("",readerTelegramRequest(request))}});}catch(error){return readerApiError(error);}}
