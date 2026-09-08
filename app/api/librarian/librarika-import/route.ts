import {LIBRARIKA_CATALOG_URL} from "@/lib/librarika";

export const dynamic="force-dynamic";

function retiredImport():Response{
  return Response.json({
    success:false,
    error:{
      code:"librarika_import_retired",
      message:"Повне перенесення каталогу Librarika до нашої бази вимкнено. Через окремий центр синхронізуються лише службові дані читачів.",
    },
    librarikaUrl:LIBRARIKA_CATALOG_URL,
    syncUrl:"/librarian/sync",
  },{status:410,headers:{"Cache-Control":"private, no-store"}});
}

export const GET=retiredImport;
export const POST=retiredImport;
export const PUT=retiredImport;
export const PATCH=retiredImport;
export const DELETE=retiredImport;
