# Trip-Hold Notice — Re-implementation Guide

Use this whenever you need to put the site back on hold. It has two independent parts:

- **Part A** — homepage (`index.html`): a storm/lightning overlay with your message, that fades out after ~6.5s and lets the homepage load normally.
- **Part B** — the other three pages (`itinerary.html`, `goa-wallet.html`, `boarding-pass.html`): a hard redirect to a standalone "site unavailable" page.

You can do either part alone, or both together.

---

## Part A — Homepage storm overlay

### A1. Add this CSS

Paste this right before the closing `</style>` tag in `index.html`:

```css
/* ================= TRIP HOLD OVERLAY + THUNDERSTORM ================= */
.trip-hold-overlay{
  position:fixed; inset:0; z-index:9999;
  display:flex; align-items:center; justify-content:center;
  background:radial-gradient(1200px 700px at 50% 18%, rgba(16,58,54,.96), rgba(6,26,24,.98) 72%);
  overflow:hidden;
  opacity:1; transition:opacity 1.8s ease;
  padding-top:var(--sat); padding-left:var(--sal); padding-right:var(--sar);
}
.trip-hold-overlay.hold-fade{opacity:0; pointer-events:none;}
.trip-hold-overlay.hold-hidden{display:none;}

.storm-rain{
  position:absolute; inset:-15% -10% -10% -10%; z-index:0; pointer-events:none; opacity:.14;
  background-image:repeating-linear-gradient(102deg, rgba(220,233,228,.55) 0px, rgba(220,233,228,.55) 1px, transparent 1px, transparent 46px);
  animation:rainFall 6s linear infinite;
}
@keyframes rainFall{ 0%{transform:translateY(-3%);} 100%{transform:translateY(3%);} }

.storm-flash{
  position:absolute; inset:0; z-index:1; pointer-events:none; mix-blend-mode:screen; opacity:0;
  background:radial-gradient(circle at 28% 12%, rgba(230,240,255,.95), rgba(230,240,255,0) 46%);
  animation:lightningA 3.1s ease-in-out infinite;
}
.storm-flash-2{
  background:radial-gradient(circle at 76% 8%, rgba(197,222,255,.8), rgba(197,222,255,0) 42%);
  animation:lightningB 4s ease-in-out infinite; animation-delay:.9s;
}
.storm-flash-3{
  background:radial-gradient(circle at 50% 30%, rgba(210,230,255,.55), rgba(210,230,255,0) 55%);
  animation:lightningC 5.3s ease-in-out infinite; animation-delay:1.8s;
}
/* each layer's flash lands early in its own (short) cycle, so it's
   guaranteed to fire multiple times during the visible window rather
   than only near the tail end of a long, mostly-idle cycle */
@keyframes lightningA{
  0%,44%,100%{opacity:0;} 44.4%{opacity:.9;} 44.9%{opacity:.1;} 45.4%{opacity:.75;} 46%{opacity:0;}
}
@keyframes lightningB{
  0%,53%,100%{opacity:0;} 53.3%{opacity:.65;} 53.8%{opacity:0;} 54.3%{opacity:.5;} 54.8%{opacity:0;}
}
@keyframes lightningC{
  0%,32%,100%{opacity:0;} 32.3%{opacity:.45;} 32.8%{opacity:0;}
}

.hold-content{
  position:relative; z-index:2; max-width:560px; margin:0 24px; text-align:center; color:var(--sand);
  padding:42px 32px; border:1px solid rgba(255,255,255,.14); border-radius:20px;
  background:rgba(11,61,58,.35); -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px);
  box-shadow:0 30px 70px -30px rgba(0,0,0,.6);
  animation:heroIntro 1s cubic-bezier(.22,1,.36,1) both;
}
.hold-icon{width:52px; height:52px; margin:0 auto 16px; color:var(--mango); animation:holdIconPulse 2.4s ease-in-out infinite;}
@keyframes holdIconPulse{0%,100%{opacity:.85; transform:scale(1);} 50%{opacity:1; transform:scale(1.08);}}
.hold-eyebrow{font-family:'Space Mono',monospace; font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:var(--mango-2); margin-bottom:10px;}
.hold-content h2{font-family:'Fraunces',serif; font-size:clamp(21px,4vw,28px); margin:0 0 16px; color:var(--sand); letter-spacing:-0.01em;}
.hold-content p{font-size:14.5px; line-height:1.8; color:#DCE9E4; opacity:.92; margin:0;}
```

> Note: `.storm-flash-3` uses `heroIntro` for `.hold-content` entrance — that keyframe already exists elsewhere in `index.html`'s stylesheet from the hero section. If you ever move this CSS to a page that doesn't define `heroIntro`, either copy that keyframe over too or drop the `animation:heroIntro...` line from `.hold-content`.

### A2. Add this markup + script

Paste this as the very first thing inside `<body>` (before the `<!-- NAV -->` comment):

```html
<!-- ============ TRIP HOLD OVERLAY ============ -->
<div id="tripHoldOverlay" class="trip-hold-overlay" role="alert" aria-live="assertive">
  <div class="storm-rain"></div>
  <div class="storm-flash"></div>
  <div class="storm-flash storm-flash-2"></div>
  <div class="storm-flash storm-flash-3"></div>
  <div class="hold-content">
    <svg class="hold-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 16a4.5 4.5 0 0 1 .5-8.98A5.5 5.5 0 0 1 17 9.5a4 4 0 0 1-.5 7.99"/>
      <path d="M13 12l-2.5 4h3L11 20"/>
    </svg>
    <div class="hold-eyebrow">Notice · The Goa Run</div>
    <h2>Trip Planning is Currently on Hold</h2>
    <p>
      Due to some unforeseen reason, Trip planning is on Hold.<br>
      Coordinators are actively monitoring the case and trying to address.<br>
      Apologies for the inconvenience caused.<br>
      Website will be on Hold till the time.
    </p>
  </div>
</div>
<script>
(function(){
  var overlay = document.getElementById('tripHoldOverlay');
  if(!overlay) return;

  var HOLD_KEY = 'tripHoldSeen_v1';
  var SHOW_MS  = 6500;  // how long the storm notice stays fully visible
  var FADE_MS  = 1800;  // must match the CSS opacity transition above

  var alreadySeen = false;
  try { alreadySeen = sessionStorage.getItem(HOLD_KEY) === '1'; } catch(e){}

  if (alreadySeen){
    overlay.classList.add('hold-hidden');
    return;
  }

  setTimeout(function(){
    overlay.classList.add('hold-fade');
    setTimeout(function(){
      overlay.classList.add('hold-hidden');
      try { sessionStorage.setItem(HOLD_KEY, '1'); } catch(e){}
    }, FADE_MS);
  }, SHOW_MS);
})();
</script>
```

### A3. Gotchas

- **Testing again after you've already seen it once**: the overlay only shows once per browser *session* (`sessionStorage`). If you reload the page to re-check the animation and see nothing, either open a new incognito window or run `sessionStorage.removeItem('tripHoldSeen_v1')` in the console, then reload.
- **To take it down later**: delete the `<div id="tripHoldOverlay">…</div>` block and its `<script>`, plus the CSS block — or just wrap them in a single HTML comment (`<!-- ... -->`) so you can restore quickly.

---

## Part B — Redirect the other pages

### B1. Create `site-hold.html`

Save this as `site-hold.html` in the same folder as `index.html` / `shared.css`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<title>The Goa Run — Site On Hold</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600&family=Space+Grotesk:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="shared.css">
<style>
  *{box-sizing:border-box;}
  html,body{height:100%; margin:0;}
  body{
    font-family:'Space Grotesk', sans-serif; -webkit-font-smoothing:antialiased;
    display:flex; align-items:center; justify-content:center; padding:24px;
    background:radial-gradient(1200px 700px at 50% 18%, rgba(16,58,54,.97), rgba(6,26,24,.98) 72%);
  }
  .hold-content{
    max-width:480px; text-align:center; color:var(--sand, #F3ECD9);
    background:rgba(11,61,58,.35); border:1px solid rgba(255,255,255,.14); border-radius:20px;
    padding:42px 32px; -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px);
    box-shadow:0 30px 70px -30px rgba(0,0,0,.6);
  }
  .hold-icon{width:52px; height:52px; margin:0 auto 16px; color:var(--mango, #FF7A45);}
  .hold-eyebrow{
    font-family:'Space Mono', monospace; font-size:11px; letter-spacing:.16em; text-transform:uppercase;
    color:var(--mango-2, #E85D2A); margin-bottom:10px;
  }
  h1{font-family:'Fraunces', serif; font-size:clamp(21px,4vw,28px); margin:0 0 14px; letter-spacing:-0.01em; color:var(--sand, #F3ECD9);}
  p{font-size:14.5px; line-height:1.7; opacity:.92; margin:0; color:#DCE9E4;}
</style>
</head>
<body>
  <div class="hold-content" role="alert" aria-live="assertive">
    <svg class="hold-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 16a4.5 4.5 0 0 1 .5-8.98A5.5 5.5 0 0 1 17 9.5a4 4 0 0 1-.5 7.99"/>
      <path d="M13 12l-2.5 4h3L11 20"/>
    </svg>
    <div class="hold-eyebrow">Notice · The Goa Run</div>
    <h1>Site Unavailable</h1>
    <p>Site is currently non-operational, kindly check with the coordinators.</p>
  </div>
</body>
</html>
```

### B2. Redirect each of the other pages

In `itinerary.html`, `goa-wallet.html`, and `boarding-pass.html`, paste this as the **very first line inside `<head>`**, before any other `<link>`/`<script>` tag:

```html
<script>location.replace('site-hold.html');</script>
```

Why this way:
- `location.replace()` (not `location.href`) swaps the current history entry, so the browser's Back button won't loop the visitor back into the redirect.
- Being first inside `<head>` means the browser redirects before it starts downloading that page's images/video/CSS — no flash of real content first.

### B3. To bring a page back online

Delete that one `<script>` line from its `<head>`. Nothing else on the page was touched, so no other cleanup is needed.

---

## Quick checklist

- [ ] Part A CSS pasted before `</style>` in `index.html`
- [ ] Part A markup + script pasted right after `<body>` in `index.html`
- [ ] `site-hold.html` saved next to `index.html` / `shared.css`
- [ ] Redirect `<script>` line added to `itinerary.html`, `goa-wallet.html`, `boarding-pass.html`
