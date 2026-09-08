import {librarianJson} from '@/lib/librarian-api';
import {LIBRARIKA_CATALOG_URL} from '@/lib/librarika';
export const dynamic='force-dynamic';

function retiredCoverImport(){return librarianJson({
  success:false,
  code:'librarika_authoritative',
  error:'Обкладинки художньої та наукової літератури більше не копіюються на цей сайт.',
  catalogUrl:LIBRARIKA_CATALOG_URL,
},{status:410});}

export const GET=retiredCoverImport;
export const POST=retiredCoverImport;
export const PUT=retiredCoverImport;
export const PATCH=retiredCoverImport;
export const DELETE=retiredCoverImport;
