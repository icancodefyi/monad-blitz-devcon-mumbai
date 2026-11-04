import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "DONADS",
    short_name: "DONADS",
    description: "Approval-gated agents for verifiable Monad tasks.",
    start_url: "/app",
    display: "standalone",
    background_color: "#faf8f5",
    theme_color: "#402e25",
    icons: [{ src: "/brand/donads-mascot-tile.png", sizes: "2048x2048", type: "image/png", purpose: "maskable" }],
  };
}
