import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const publicDirectory = resolve(process.cwd(), "public");

export const publicAssets = {
  appleTouchIcon: readFileSync(resolve(publicDirectory, "apple-touch-icon.png")),
  favicon: readFileSync(resolve(publicDirectory, "favicon.svg")),
  faviconIco: readFileSync(resolve(publicDirectory, "favicon.ico")),
  favicon192: readFileSync(resolve(publicDirectory, "favicon-192.png")),
  favicon512: readFileSync(resolve(publicDirectory, "favicon-512.png")),
  fontsCss: readFileSync(resolve(publicDirectory, "fonts/fonts.css")),
  dmSans: readFileSync(resolve(publicDirectory, "fonts/dm-sans-latin.woff2")),
  spaceGrotesk: readFileSync(resolve(publicDirectory, "fonts/space-grotesk-latin.woff2")),
  manifest: readFileSync(resolve(publicDirectory, "site.webmanifest")),
  robots: readFileSync(resolve(publicDirectory, "robots.txt")),
  socialCard: readFileSync(resolve(publicDirectory, "social-card.png")),
  socialCardSource: readFileSync(resolve(publicDirectory, "social-card.svg")),
};
