import { env } from "cloudflare:workers";
import { authorizeLibrarianApi, isSameOriginRequest, librarianError, librarianJson } from "@/lib/librarian-api";
import { readBoundedJson } from "@/lib/bounded-json";
import { ReaderError, readerFail, type ReaderDatabase } from "@/lib/reader-core";
import {literatureClassPlan,applyLiteratureClasses} from "@/lib/literature-class-alignment";
import * as literature from "@/lib/literature-admin";
import { saveLibraryEdition } from "@/lib/library-editor";
import { issueReaderCopy, returnReaderCopy, changeReaderDueDate, registerLibraryCopy } from "@/lib/library-copy-store";
import {previewLiteratureSourceItem,applyLiteratureSourceItem} from "@/lib/literature-source-refresh";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const auth = await authorizeLibrarianApi(); if (!auth.ok) return auth.response;
  try {
    const db = env.DB as unknown as ReaderDatabase, url = new URL(request.url), view = url.searchParams.get("view") || "dashboard", id = url.searchParams.get("id") || "";
    if (view === "export") { const bytes = await literature.literatureReaderExcel(db,url); return new Response(bytes,{headers:{"Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","Content-Disposition":"attachment; filename=reader-books.xlsx","Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}}); }
    if(view==="class_plan"&&auth.value.access.role!=="admin")readerFail("admin_required","Звірка класів доступна адміністратору.",403);
    const result = view === "class_plan" ? await literatureClassPlan(db) : view === "dashboard" ? await literature.literatureDashboard(db,url)
      : view === "books" ? await literature.literatureBooks(db,url)
      : view === "book" ? await literature.literatureBook(db,id)
      : view === "readers" ? await literature.literatureReaders(db,url)
      : view === "reader" ? await literature.literatureReader(db,id)
      : view === "loans" ? await literature.literatureLoans(db,url)
      : view === "entities" ? await literature.literatureEntities(db,url)
      : view === "options" ? await literature.literatureOptions(db)
      : view === "reviews" ? await literature.literatureReviews(db,url)
      : readerFail("view","Невідомий розділ.");
    return librarianJson({success:true,result});
  } catch(error) { return failure(error); }
}
export async function POST(request: Request) {
  const auth = await authorizeLibrarianApi(); if (!auth.ok) return auth.response;
  if(!auth.value.access.writesEnabled || !auth.value.user.d1UserId) return librarianError(503,"writes_disabled","Запис тимчасово вимкнено.",false);
  if(!isSameOriginRequest(request)) return librarianError(403,"origin","Запит має надійти з цього сайту.",true);
  try {
    const body = await readBoundedJson(request,128000);
    if(!body.input || typeof body.input !== "object" || Array.isArray(body.input)) readerFail("input","Некоректна форма.");
    if(typeof (body.input as Record<string,unknown>).requestId!=="string")readerFail("request_id","Оновіть форму перед збереженням."); const input = body.input as Record<string,unknown> & {requestId:string}, db=env.DB as unknown as ReaderDatabase, actor={id:auth.value.user.d1UserId,email:auth.value.user.email||""}; let result:unknown;
    if(body.action==="class_assign"){if(auth.value.access.role!=="admin")readerFail("admin_required","Призначення доступне адміністратору.",403);result=await applyLiteratureClasses(db,actor,input as Parameters<typeof applyLiteratureClasses>[2]);} else if(body.action==="source_preview"||body.action==="source_apply"){if(auth.value.access.role!=="admin")readerFail("admin_required","Перенесення доступне адміністратору.",403);result=body.action==="source_preview"?await previewLiteratureSourceItem(db,input as Parameters<typeof previewLiteratureSourceItem>[1]):await applyLiteratureSourceItem(db,actor,input as Parameters<typeof applyLiteratureSourceItem>[2]);} else if(body.action==="edition_save") {
      if(input.id) await literature.assertLiterature(db,input.id);
      const meta=input.metadata as Record<string,unknown>|undefined;
      if(meta?.url && !literature.safeLiteratureUrl(String(meta.url))) readerFail("url","Перевірте URL книги.");
      result=await saveLibraryEdition(db,actor,input as Parameters<typeof saveLibraryEdition>[2]);
    } else if(body.action==="entity_save") result=await literature.saveLiteratureEntity(db,actor,input);
    else if(body.action==="reader_save") result=await literature.saveLiteratureReader(db,actor,input);
    else if(body.action==="archive") result=await literature.archiveLiteratureRecord(db,actor,input);
    else if(body.action==="reserve") result=await literature.reserveLiteratureCopy(db,actor,input);
    else if(body.action==="cancel") result=await literature.cancelLiteratureReservation(db,actor,input);
    else if(body.action==="review_hide") result=await literature.hideLiteratureReview(db,actor,input);
    else if(body.action==="copy_add") {
      await literature.assertLiterature(db,input.editionId);
      result=await registerLibraryCopy(db,actor,{...input,accessionNo:typeof input.accessionNo==="string"&&input.accessionNo.trim()?input.accessionNo:"LIT-"+input.requestId.replaceAll("-","").slice(0,16).toUpperCase()} as Parameters<typeof registerLibraryCopy>[2]);
    } else if(body.action==="issue") { await literature.assertLiterature(db,input.copyId,"copy"); result=await issueReaderCopy(db,actor,input as Parameters<typeof issueReaderCopy>[2]); }
    else if(body.action==="return") { await literature.assertLiterature(db,input.circulationId,"loan"); result=await returnReaderCopy(db,actor,input as Parameters<typeof returnReaderCopy>[2]); }
    else if(body.action==="due") { await literature.assertLiterature(db,input.circulationId,"loan"); result=await changeReaderDueDate(db,actor,input as Parameters<typeof changeReaderDueDate>[2]); }
    else readerFail("action","Невідома дія.");
    return librarianJson({success:true,result});
  } catch(error) { return failure(error); }
}
function failure(error:unknown) { return error instanceof ReaderError ? librarianError(error.status,error.code,error.message,true) : librarianError(503,"literature_unavailable","Не вдалося підтвердити дію. Повторіть її; повторне надсилання тієї самої форми не дублює запис.",true); }
