import type { Metadata } from "next";
import "./autosend.css";
import { MicroworksNav } from "@/components/landing/microworks-nav";
import { MicroworksHero } from "@/components/landing/microworks-hero";
import { MicroworksFeatures } from "@/components/landing/microworks-features";
import { MicroworksShowcase } from "@/components/landing/microworks-showcase";
import { MicroworksMultiCampaign } from "@/components/landing/microworks-multi-campaign";
import { MicroworksSocialFaq } from "@/components/landing/microworks-social-faq";
import { MicroworksFooter } from "@/components/landing/microworks-footer";

export const metadata: Metadata = {
  title: "DONADS: the agent that can't be talked into stealing your money",
  description:
    "Tell DONADS what to pay on Monad. It prepares the exact transaction, checks it for scams, and asks you in Telegram. Your wallet signs. The chain confirms.",
};

export default function HomePage() {
  return (
    <div className="font-sans bg-stone-50 min-h-screen text-stone-900 antialiased selection:bg-stone-900 selection:text-white">
      <div>
        <div className="w-full flex flex-col items-center bg-stone-50 h-full">
          <MicroworksNav />
          <div className="max-w-6xl w-full">
            <div className="w-full px-4 md:px-6 pb-10">
              <div className="flex flex-col">
                <MicroworksHero />
                <MicroworksFeatures />
                <MicroworksShowcase />
                <MicroworksMultiCampaign />
                <MicroworksSocialFaq />
                <MicroworksFooter />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
