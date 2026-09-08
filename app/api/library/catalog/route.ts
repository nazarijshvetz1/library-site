import {LIBRARIKA_CATALOG_URL} from "@/lib/librarika";

export const dynamic="force-dynamic";

function retiredCatalog():Response{
  return Response.json({
    success:false,
    error:{code:"librarika_authoritative",message:"Каталог художньої та наукової літератури ведеться в Librarika."},
    librarikaUrl:LIBRARIKA_CATALOG_URL,
  },{status:410,headers:{"Cache-Control":"public, max-age=300"}});
}

export const GET=retiredCatalog;
export const POST=retiredCatalog;
export const PUT=retiredCatalog;
export const PATCH=retiredCatalog;
export const DELETE=retiredCatalog;
