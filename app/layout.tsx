import type { Metadata } from "next";
import "./globals.css";
import { CREATOR_NAME } from "@/lib/public-data";
export const metadata:Metadata={authors:[{name:CREATOR_NAME}],creator:CREATOR_NAME,title:"ヨコハマの声｜政策について考える",description:"横浜の政策課題に意見を重ね、異なる立場の共通点を見つける対話サービスのβ版。",icons:{icon:"/favicon.svg",shortcut:"/favicon.svg"}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ja"><body>{children}</body></html>}