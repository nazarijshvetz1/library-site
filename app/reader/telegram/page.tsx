import type {Metadata} from "next";
import ReaderPortal from "../reader-portal";
export const metadata:Metadata={title:"Читацький кабінет у Telegram",robots:{index:false,follow:false},referrer:"same-origin"};
export default function ReaderTelegramPage(){return <ReaderPortal telegram/>;}
