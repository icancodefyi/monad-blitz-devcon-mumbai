export interface FaqItem {
  question: string;
  answer: string;
}

export const FAQS: FaqItem[] = [
  {
    question: "What is DONADS?",
    answer:
      "An AI agent for moving money on Monad. You describe a payment in plain language; DONADS prepares the exact transaction, checks it for scams, and asks you in Telegram. Your wallet signs, and DONADS confirms the receipt on-chain.",
  },
  {
    question: "Can the AI send my funds on its own?",
    answer:
      "No. The model never sets an amount or an address and has no signing power. Every value-moving action needs your approval in Telegram and a signature in your own wallet.",
  },
  {
    question: "What stops a prompt injection like the Grok wallet case?",
    answer:
      "Untrusted text cannot create a payment. Messages, web pages and model output are kept away from the payment path, and an attack replay suite tests Morse, base64, hidden markup and forged Telegram buttons on every test run.",
  },
  {
    question: "Where do the offers in the best-offer finder come from?",
    answer:
      "From three clearly labelled test sellers on Monad Testnet. Ranking is plain code: price first, then delivery time, then completed deals. Go opens an escrow you sign; Skip creates nothing.",
  },
  {
    question: "Is this on mainnet?",
    answer:
      "No. DONADS runs on Monad Testnet. Mainnet stays off until the contracts are independently audited.",
  },
  {
    question: "Is the code open?",
    answer:
      "Yes. The app, contracts, tests and deployment record are in the public repository, including the attack replay suite.",
  },
];

export interface FooterLink {
  label: string;
  href: string;
  external?: boolean;
}

export interface FooterSection {
  title: string;
  links: FooterLink[];
}

export const FOOTER_SECTIONS: FooterSection[] = [
  {
    title: "Product",
    links: [
      { label: "Open the app", href: "/app" },
      { label: "Approve a payment", href: "/app" },
      { label: "Attack replay", href: "#features" },
    ],
  },
  {
    title: "On Monad",
    links: [
      { label: "Faucet", href: "https://faucet.monad.xyz", external: true },
      { label: "Testnet Explorer", href: "https://testnet.monadscan.com", external: true },
      { label: "Monad Docs", href: "https://docs.monad.xyz", external: true },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "How It Works", href: "#showcase" },
      { label: "FAQ", href: "#faq" },
      { label: "GitHub", href: "https://github.com/Aditya-linux/donadss", external: true },
      { label: "Telegram bot", href: "https://t.me/doonads_bot", external: true },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy Policy", href: "#" },
      { label: "Terms of Service", href: "#" },
    ],
  },
];