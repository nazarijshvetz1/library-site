import type {Metadata} from "next";
import ReaderPortal from "./reader-portal";
export const metadata:Metadata={title:"Кабінет читача",robots:{index:false,follow:false},referrer:"same-origin"};
export default function ReaderPage(){return <ReaderPortal/>;}
