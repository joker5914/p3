/* ── Brand assets ───────────────────────────────────────
   Inline React versions of the canonical brand SVGs that live in
   /public/brand/.  We inline (rather than `<img src="/brand/...svg">`)
   so the glyph's `fill="currentColor"` flows from the parent's text
   color — letting the same asset paint white on the dark sidebar and
   navy on a light hero without a per-theme override.

   The static files at /public/brand/ remain the source of truth for
   contexts where currentColor doesn't apply (favicon, apple-touch
   icon, email <img>) — keep these JSX components in sync if a path
   in the asset ever changes.

   Both SVGs share the gradient `dRule` underline (teal → gold).  The
   id is namespaced (`brand-icon-rule`, `brand-wordmark-rule`) to
   avoid collisions when multiple instances sit on the same page.
   ────────────────────────────────────────────────────── */

import React, { useId } from "react";

export function BrandIcon({ title = "Dismissal", className, style, ...rest }) {
  const ruleId = useId().replace(/[:]/g, "") + "-rule";
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 256 256"
      role="img"
      aria-label={title}
      className={className}
      style={style}
      {...rest}
    >
      <defs>
        <linearGradient id={ruleId} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="#14B8A6" />
          <stop offset="100%" stopColor="#D4A843" />
        </linearGradient>
      </defs>
      <g transform="translate(66.970 187.212) scale(0.190718 -0.190718)">
        <path
          fill="currentColor"
          d="M298 560Q352 560 404.5 536.5Q457 513 488 474V740H603V0H488V83Q460 43 410.5 17.0Q361 -9 297 -9Q225 -9 165.5 27.5Q106 64 71.5 129.5Q37 195 37 278Q37 361 71.5 425.0Q106 489 165.5 524.5Q225 560 298 560ZM321 461Q277 461 239.0 439.5Q201 418 177.5 376.5Q154 335 154 278Q154 221 177.5 178.0Q201 135 239.5 112.5Q278 90 321 90Q365 90 403.0 112.0Q441 134 464.5 176.5Q488 219 488 276Q488 333 464.5 375.0Q441 417 403.0 439.0Q365 461 321 461Z"
        />
      </g>
      <rect x="67.55" y="204.29" width="120.90" height="5.63" fill={`url(#${ruleId})`} />
    </svg>
  );
}

export function BrandWordmark({ title = "Dismissal", className, style, ...rest }) {
  const ruleId = useId().replace(/[:]/g, "") + "-rule";
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1365.36 317.00"
      role="img"
      aria-label={title}
      className={className}
      style={style}
      {...rest}
    >
      <defs>
        <linearGradient id={ruleId} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="#14B8A6" />
          <stop offset="100%" stopColor="#D4A843" />
        </linearGradient>
      </defs>
      <g transform="translate(32.00 284.00) scale(0.240000 -0.240000)" fill="currentColor">
        <path transform="translate(0.00 0)"    d="M298 560Q352 560 404.5 536.5Q457 513 488 474V740H603V0H488V83Q460 43 410.5 17.0Q361 -9 297 -9Q225 -9 165.5 27.5Q106 64 71.5 129.5Q37 195 37 278Q37 361 71.5 425.0Q106 489 165.5 524.5Q225 560 298 560ZM321 461Q277 461 239.0 439.5Q201 418 177.5 376.5Q154 335 154 278Q154 221 177.5 178.0Q201 135 239.5 112.5Q278 90 321 90Q365 90 403.0 112.0Q441 134 464.5 176.5Q488 219 488 276Q488 333 464.5 375.0Q441 417 403.0 439.0Q365 461 321 461Z" />
        <path transform="translate(757.17 0)"  d="M60 697Q60 728 81.0 749.0Q102 770 133 770Q163 770 184.0 749.0Q205 728 205 697Q205 666 184.0 645.0Q163 624 133 624Q102 624 81.0 645.0Q60 666 60 697ZM189 551V0H75V551Z" />
        <path transform="translate(1100.33 0)" d="M45 169H163Q166 134 196.5 110.5Q227 87 273 87Q321 87 347.5 105.5Q374 124 374 153Q374 184 344.5 199.0Q315 214 251 232Q189 249 150.0 265.0Q111 281 82.5 314.0Q54 347 54 401Q54 445 80.0 481.5Q106 518 154.5 539.0Q203 560 266 560Q360 560 417.5 512.5Q475 465 479 383H365Q362 420 335.0 442.0Q308 464 262 464Q217 464 193.0 447.0Q169 430 169 402Q169 380 185.0 365.0Q201 350 224.0 341.5Q247 333 292 320Q352 304 390.5 287.5Q429 271 457.0 239.0Q485 207 486 154Q486 107 460.0 70.0Q434 33 386.5 12.0Q339 -9 275 -9Q210 -9 158.5 14.5Q107 38 77.0 78.5Q47 119 45 169Z" />
        <path transform="translate(1713.50 0)" d="M969 325V0H856V308Q856 382 819.0 421.5Q782 461 718 461Q654 461 616.5 421.5Q579 382 579 308V0H466V308Q466 382 429.0 421.5Q392 461 328 461Q264 461 226.5 421.5Q189 382 189 308V0H75V551H189V488Q217 522 260.0 541.0Q303 560 352 560Q418 560 470.0 532.0Q522 504 550 451Q575 501 628.0 530.5Q681 560 742 560Q807 560 858.5 533.0Q910 506 939.5 453.0Q969 400 969 325Z" />
        <path transform="translate(2831.67 0)" d="M60 697Q60 728 81.0 749.0Q102 770 133 770Q163 770 184.0 749.0Q205 728 205 697Q205 666 184.0 645.0Q163 624 133 624Q102 624 81.0 645.0Q60 666 60 697ZM189 551V0H75V551Z" />
        <path transform="translate(3174.83 0)" d="M45 169H163Q166 134 196.5 110.5Q227 87 273 87Q321 87 347.5 105.5Q374 124 374 153Q374 184 344.5 199.0Q315 214 251 232Q189 249 150.0 265.0Q111 281 82.5 314.0Q54 347 54 401Q54 445 80.0 481.5Q106 518 154.5 539.0Q203 560 266 560Q360 560 417.5 512.5Q475 465 479 383H365Q362 420 335.0 442.0Q308 464 262 464Q217 464 193.0 447.0Q169 430 169 402Q169 380 185.0 365.0Q201 350 224.0 341.5Q247 333 292 320Q352 304 390.5 287.5Q429 271 457.0 239.0Q485 207 486 154Q486 107 460.0 70.0Q434 33 386.5 12.0Q339 -9 275 -9Q210 -9 158.5 14.5Q107 38 77.0 78.5Q47 119 45 169Z" />
        <path transform="translate(3788.00 0)" d="M45 169H163Q166 134 196.5 110.5Q227 87 273 87Q321 87 347.5 105.5Q374 124 374 153Q374 184 344.5 199.0Q315 214 251 232Q189 249 150.0 265.0Q111 281 82.5 314.0Q54 347 54 401Q54 445 80.0 481.5Q106 518 154.5 539.0Q203 560 266 560Q360 560 417.5 512.5Q475 465 479 383H365Q362 420 335.0 442.0Q308 464 262 464Q217 464 193.0 447.0Q169 430 169 402Q169 380 185.0 365.0Q201 350 224.0 341.5Q247 333 292 320Q352 304 390.5 287.5Q429 271 457.0 239.0Q485 207 486 154Q486 107 460.0 70.0Q434 33 386.5 12.0Q339 -9 275 -9Q210 -9 158.5 14.5Q107 38 77.0 78.5Q47 119 45 169Z" />
        <path transform="translate(4401.17 0)" d="M297 560Q362 560 410.5 534.5Q459 509 488 471V551H603V0H488V82Q459 43 409.0 17.0Q359 -9 295 -9Q224 -9 165.0 27.5Q106 64 71.5 129.5Q37 195 37 278Q37 361 71.5 425.0Q106 489 165.5 524.5Q225 560 297 560ZM321 461Q277 461 239.0 439.5Q201 418 177.5 376.5Q154 335 154 278Q154 221 177.5 178.0Q201 135 239.5 112.5Q278 90 321 90Q365 90 403.0 112.0Q441 134 464.5 176.5Q488 219 488 276Q488 333 464.5 375.0Q441 417 403.0 439.0Q365 461 321 461Z" />
        <path transform="translate(5158.33 0)" d="M189 740V0H75V740Z" />
      </g>
      <rect x="32.00" y="312.00" width="1301.36" height="5" fill={`url(#${ruleId})`} />
    </svg>
  );
}
