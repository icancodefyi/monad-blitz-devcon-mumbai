import type { Metadata } from "next";

import { ChatShell } from "@/components/chat-shell";

export const metadata: Metadata = {
  title: "DONADS app",
  description: "Ask DONADS to move money on Monad. You approve in Telegram and sign in your wallet.",
};

export default function AppPage() {
  return <ChatShell />;
}
