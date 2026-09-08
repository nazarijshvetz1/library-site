import {readerJson} from "@/lib/reader-api";
import {LIBRARIKA_CATALOG_URL,LIBRARIKA_DASHBOARD_URL} from "@/lib/librarika";
export const dynamic="force-dynamic";

function retiredReaderBooks(){return readerJson({
  success:false,
  code:"librarika_authoritative",
  error:"Актуальні видачі, строки повернення, резервування, оцінки й відгуки ведуться у Librarika.",
  syncState:"circulation_source_not_connected",
  links:{account:LIBRARIKA_DASHBOARD_URL,catalog:LIBRARIKA_CATALOG_URL},
},{status:410});}

export const GET=retiredReaderBooks;
export const POST=retiredReaderBooks;
export const PUT=retiredReaderBooks;
export const PATCH=retiredReaderBooks;
export const DELETE=retiredReaderBooks;
