import {redirect} from "next/navigation";

export const dynamic="force-dynamic";
export const metadata={title:"Librarika · Єдина бібліотека",robots:{index:false,follow:false}};

export default function MigrationPage(){
  redirect("/librarian/literature");
}
