import type { Metadata } from "next";
import SuggestBookForm from "./suggest-book-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Запропонувати книгу бібліотеці", description: "Публічна форма пропозицій учнів для бібліотеки.", robots: { index: true, follow: true } };
export default function SuggestBookPage(){return <SuggestBookForm/>;}
