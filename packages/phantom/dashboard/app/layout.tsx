import type { ReactNode } from "react";
import "./style.css";
export const metadata = {
  title: "PHANTOM · On-chain observer",
  description: "Actual Solana transactions and separately labeled paper strategy activity.",
};
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
