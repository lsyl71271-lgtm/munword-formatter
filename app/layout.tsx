import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "PKUNMUN 2026 文件自动排版系统";
const description = "将内容已完成但格式混乱的模拟联合国 DOCX 自动转换为符合 PKUNMUN 2026 学标示范格式的可编辑成品。";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "127.0.0.1:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("127.") || host.startsWith("localhost") ? "http" : "https");
  const base = new URL(`${protocol}://${host}`);
  const image = new URL("/og.png", base).toString();
  return {
    metadataBase: base,
    title,
    description,
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: { title, description, type: "website", images: [{ url: image, width: 1200, height: 630, alt: title }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
