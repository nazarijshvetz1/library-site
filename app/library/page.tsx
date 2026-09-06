import type {Metadata} from "next";
import ReaderPortal from "../reader/reader-portal";
export const metadata:Metadata={title:"Книжкова полиця ліцею",description:"Художня та наукова література, підручники й посібники Єдиної бібліотеки Міжнародного ліцею МАУП.",referrer:"same-origin"};
export default function LibraryPage(){return <ReaderPortal/>;}
