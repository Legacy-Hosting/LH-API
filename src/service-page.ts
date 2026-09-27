export function renderServicePage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#0b0c10">
  <meta name="color-scheme" content="dark">
  <meta name="description" content="Secure application programming interface for Legacy Hosting services.">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <link rel="canonical" href="https://api.legacyhosting.xyz/">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="shortcut icon" href="/favicon.ico">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Legacy Hosting">
  <meta property="og:title" content="Legacy Hosting API">
  <meta property="og:description" content="Secure service API for the Legacy Hosting platform.">
  <meta property="og:url" content="https://api.legacyhosting.xyz/">
  <meta property="og:image" content="https://api.legacyhosting.xyz/social-card.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Legacy Hosting API">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Legacy Hosting API">
  <meta name="twitter:description" content="Secure service API for the Legacy Hosting platform.">
  <meta name="twitter:image" content="https://api.legacyhosting.xyz/social-card.png">
  <title>API · Legacy Hosting</title>
  <link rel="stylesheet" href="/assets/service.css">
</head>
<body>
  <main class="service-card">
    <img class="mark" src="/favicon-192.png" alt="Legacy Hosting logo">
    <p class="eyebrow">Legacy Hosting API</p>
    <h1>Platform services</h1>
    <p class="intro">Secure application programming interface for Legacy Hosting products and internal services.</p>
    <div class="status-pill"><i></i>API service operational</div>
    <p class="help">This endpoint is intended for authorized Legacy Hosting applications and agents.</p>
  </main>
</body>
</html>`;
}

export const servicePageCss = `
@import url("/fonts/fonts.css");
:root { color-scheme: dark; font-family: "DM Sans", sans-serif; background: #0b0c10; color: #e9eaf2; --border: #25262f; --surface: #131419; --purple: #7561ff; }
* { box-sizing: border-box; }
body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at 50% 0%, #211d3b 0, #0b0c10 42%); }
.service-card { width: min(430px, 100%); padding: 38px; border: 1px solid var(--border); border-radius: 16px; background: var(--surface); box-shadow: 0 30px 90px rgba(0,0,0,.36); }
.mark { width: 44px; height: 44px; display: block; border-radius: 12px; object-fit: cover; }
.eyebrow { margin: 24px 0 8px; color: #a99aff; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
h1 { margin: 0; font-family: "Space Grotesk", sans-serif; font-size: 28px; letter-spacing: -.03em; }
.intro { margin: 10px 0 27px; color: #999baa; line-height: 1.55; font-size: 14px; }
.status-pill { display: inline-flex; align-items: center; gap: 9px; padding: 11px 13px; border: 1px solid rgba(66,213,139,.3); border-radius: 9px; color: #a7f3d0; background: rgba(66,213,139,.07); font-size: 12px; font-weight: 650; }
.status-pill i { width: 7px; height: 7px; border-radius: 50%; background: #42d58b; box-shadow: 0 0 14px rgba(66,213,139,.7); }
.help { margin: 25px 0 0; padding-top: 20px; border-top: 1px solid #272832; color: #737583; font-size: 11px; line-height: 1.55; }
@media (max-width: 520px) { body { padding: 16px; } .service-card { padding: 28px 23px; } }
`;
