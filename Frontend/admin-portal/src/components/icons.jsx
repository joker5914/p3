/* ── Icons ──────────────────────────────────────────────
   Inline SVG icon set for the Dismissal admin portal refresh.
   Replaces `react-icons/fa` (heavier dependency, Font Awesome 5
   visual style) with a geometric vocabulary that matches the new
   design language: 24×24 viewBox, 1.6px stroke, currentColor, round
   line joins.

   Usage:
     import { I, Icon } from "./components/icons";
     <I.dashboard />                 // default 18px, 1.6 stroke
     <I.dashboard size={20} />       // resize
     <I.dashboard className="..." /> // className lands on <svg>
     <I.alert aria-hidden="true" /> // a11y attrs forwarded

   The named export `I` is a namespace object so call sites read
   `<I.dashboard />` rather than importing each icon individually —
   keeps imports small and the visual category obvious at a glance.

   Sourced from design_handoff_dismissal_refresh/components/icons.jsx
   and extended with the additional glyphs the existing portal needs
   (chevrons in all directions, arrows, edit/trash/eye/copy, building,
   key, image, info, download, sync, ...).  Codemod the FA consumers
   to this module incrementally — each redesign step (sidebar, topbar,
   pickup card, login, tables) pulls icons from here naturally; the
   remaining FA references get swept at the end of the refresh.
   ────────────────────────────────────────────────────── */

const Icon = ({
  d,
  size = 18,
  stroke = 1.6,
  fill = "none",
  className,
  style,
  ...rest
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill}
    stroke="currentColor"
    strokeWidth={stroke}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={style}
    {...rest}
  >
    {typeof d === "string" ? <path d={d} /> : d}
  </svg>
);

export const I = {
  /* ── Nav (sidebar) ──────────────────────────────────── */
  dashboard: (p) => (
    <Icon
      {...p}
      d={
        <>
          <rect x="3" y="3" width="7" height="9" rx="1.5" />
          <rect x="14" y="3" width="7" height="5" rx="1.5" />
          <rect x="14" y="12" width="7" height="9" rx="1.5" />
          <rect x="3" y="16" width="7" height="5" rx="1.5" />
        </>
      }
    />
  ),
  history: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M3 12a9 9 0 1 0 3-6.7" />
          <path d="M3 4v5h5" />
          <path d="M12 8v4l3 2" />
        </>
      }
    />
  ),
  insights: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M3 20h18" />
          <path d="M6 16l4-5 3 3 5-7" />
        </>
      }
    />
  ),
  car: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M5 17h14" />
          <path d="M5 17l1.5-5.5a2 2 0 0 1 2-1.5h7a2 2 0 0 1 2 1.5L19 17" />
          <circle cx="8" cy="17.5" r="1.7" />
          <circle cx="16" cy="17.5" r="1.7" />
        </>
      }
    />
  ),
  student: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M2 9l10-4 10 4-10 4z" />
          <path d="M6 11v4c0 1.5 2.7 3 6 3s6-1.5 6-3v-4" />
        </>
      }
    />
  ),
  guardians: (p) => (
    <Icon
      {...p}
      d={
        <>
          <circle cx="9" cy="8" r="3" />
          <path d="M3 19c0-3 2.7-5 6-5s6 2 6 5" />
          <circle cx="17" cy="9" r="2.5" />
          <path d="M15 18.5c.5-2 1.7-3 3-3s2.5 1 3 3" />
        </>
      }
    />
  ),
  users: (p) => (
    <Icon
      {...p}
      d={
        <>
          <circle cx="12" cy="8" r="3.5" />
          <path d="M4 20c0-3.5 3.5-6 8-6s8 2.5 8 6" />
        </>
      }
    />
  ),
  user: (p) => (
    <Icon
      {...p}
      d={
        <>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c0-4 3.5-7 8-7s8 3 8 7" />
        </>
      }
    />
  ),
  globe: (p) => (
    <Icon
      {...p}
      d={
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a14 14 0 0 1 0 18" />
          <path d="M12 3a14 14 0 0 0 0 18" />
        </>
      }
    />
  ),
  device: (p) => (
    <Icon
      {...p}
      d={
        <>
          <rect x="6" y="6" width="12" height="12" rx="2" />
          <path d="M9 3v3M12 3v3M15 3v3M9 18v3M12 18v3M15 18v3M3 9h3M3 12h3M3 15h3M18 9h3M18 12h3M18 15h3" />
        </>
      }
    />
  ),
  shield: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M12 3l8 3v5c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6z" />
        </>
      }
    />
  ),
  audit: (p) => (
    <Icon
      {...p}
      d={
        <>
          <rect x="5" y="4" width="14" height="17" rx="2" />
          <path d="M9 4v3h6V4" />
          <path d="M9 11h6M9 15h4" />
        </>
      }
    />
  ),
  /* Chain-of-custody pickup receipt — page-with-shield mark used on
     History row "Receipt" actions and on the public Verify page. */
  receipt: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M6 3h9l3 3v12a2 2 0 0 1-2 2H6z" />
          <path d="M14 3v4h4" />
          <path d="M9 12l2 2 4-4" />
        </>
      }
    />
  ),
  puzzle: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M14 4a2 2 0 0 0-4 0v2H6a2 2 0 0 0-2 2v3h2a2 2 0 0 1 0 4H4v3a2 2 0 0 0 2 2h3v-2a2 2 0 0 1 4 0v2h3a2 2 0 0 0 2-2v-3h2a2 2 0 0 0 0-4h-2V8a2 2 0 0 0-2-2h-2z" />
        </>
      }
    />
  ),
  cog: (p) => (
    <Icon
      {...p}
      d={
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1A2 2 0 1 1 4.3 17l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1A2 2 0 1 1 7 4.3l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1A2 2 0 1 1 19.7 7l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </>
      }
    />
  ),
  signOut: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <path d="M16 17l5-5-5-5" />
          <path d="M21 12H9" />
        </>
      }
    />
  ),
  signIn: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
          <path d="M10 17l-5-5 5-5" />
          <path d="M15 12H3" />
        </>
      }
    />
  ),
  building: (p) => (
    <Icon
      {...p}
      d={
        <>
          <rect x="4" y="3" width="16" height="18" rx="1.5" />
          <path d="M9 8h2M13 8h2M9 12h2M13 12h2M9 16h2M13 16h2" />
          <path d="M10 21v-3h4v3" />
        </>
      }
    />
  ),
  key: (p) => (
    <Icon
      {...p}
      d={
        <>
          <circle cx="8" cy="15" r="3" />
          <path d="M10.5 12.5L21 2" />
          <path d="M17 6l3 3" />
          <path d="M14 9l3 3" />
        </>
      }
    />
  ),

  /* ── UI primitives ──────────────────────────────────── */
  search: (p) => (
    <Icon
      {...p}
      d={
        <>
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </>
      }
    />
  ),
  filter: (p) => <Icon {...p} d={<path d="M4 5h16M7 12h10M10 19h4" />} />,
  bell: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M6 8a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7" />
          <path d="M10 19a2 2 0 0 0 4 0" />
        </>
      }
    />
  ),
  bellSlash: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M18 8a6 6 0 0 0-9.5-4.9" />
          <path d="M6 8c0 6-2 7-2 7h13" />
          <path d="M10 19a2 2 0 0 0 4 0" />
          <path d="M3 3l18 18" />
        </>
      }
    />
  ),
  sun: (p) => (
    <Icon
      {...p}
      d={
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </>
      }
    />
  ),
  moon: (p) => <Icon {...p} d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  check: (p) => <Icon {...p} d="M5 12l5 5 9-11" />,
  checkCircle: (p) => (
    <Icon
      {...p}
      d={
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M8 12.5l3 3 5-6" />
        </>
      }
    />
  ),
  x: (p) => <Icon {...p} d="M6 6l12 12M18 6L6 18" />,
  xCircle: (p) => (
    <Icon
      {...p}
      d={
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M9 9l6 6M15 9l-6 6" />
        </>
      }
    />
  ),
  alert: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M12 3l10 18H2z" />
          <path d="M12 10v5" />
          <circle cx="12" cy="18" r="0.6" fill="currentColor" />
        </>
      }
    />
  ),
  info: (p) => (
    <Icon
      {...p}
      d={
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5" />
          <circle cx="12" cy="8" r="0.6" fill="currentColor" />
        </>
      }
    />
  ),
  question: (p) => (
    <Icon
      {...p}
      d={
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7" />
          <circle cx="12" cy="17" r="0.6" fill="currentColor" />
        </>
      }
    />
  ),

  /* ── Chevrons & arrows ──────────────────────────────── */
  chevronUp:    (p) => <Icon {...p} d="M6 15l6-6 6 6" />,
  chevronDown:  (p) => <Icon {...p} d="M6 9l6 6 6-6" />,
  chevronLeft:  (p) => <Icon {...p} d="M15 6l-6 6 6 6" />,
  chevronRight: (p) => <Icon {...p} d="M9 6l6 6-6 6" />,
  caretDown: (p) => (
    <Icon {...p} fill="currentColor" stroke="none" d="M7 10l5 5 5-5z" />
  ),
  arrowUp: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M12 19V5" />
          <path d="M6 11l6-6 6 6" />
        </>
      }
    />
  ),
  arrowDown: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M12 5v14" />
          <path d="M6 13l6 6 6-6" />
        </>
      }
    />
  ),
  arrowLeft: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M19 12H5" />
          <path d="M11 6l-6 6 6 6" />
        </>
      }
    />
  ),
  arrowRight: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M5 12h14" />
          <path d="M13 6l6 6-6 6" />
        </>
      }
    />
  ),

  /* ── Actions ────────────────────────────────────────── */
  plus:  (p) => <Icon {...p} d="M12 5v14M5 12h14" />,
  minus: (p) => <Icon {...p} d="M5 12h14" />,
  more: (p) => (
    <Icon
      {...p}
      d={
        <>
          <circle cx="6" cy="12" r="1.4" fill="currentColor" />
          <circle cx="12" cy="12" r="1.4" fill="currentColor" />
          <circle cx="18" cy="12" r="1.4" fill="currentColor" />
        </>
      }
    />
  ),
  bars: (p) => <Icon {...p} d="M3 6h18M3 12h18M3 18h18" />,
  edit: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
          <path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z" />
        </>
      }
    />
  ),
  trash: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M3 6h18" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <path d="M10 11v6M14 11v6" />
        </>
      }
    />
  ),
  eye: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" />
          <circle cx="12" cy="12" r="3" />
        </>
      }
    />
  ),
  copy: (p) => (
    <Icon
      {...p}
      d={
        <>
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </>
      }
    />
  ),
  download: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="M7 10l5 5 5-5" />
          <path d="M12 15V3" />
        </>
      }
    />
  ),
  upload: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="M17 8l-5-5-5 5" />
          <path d="M12 3v12" />
        </>
      }
    />
  ),
  refresh: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
          <path d="M21 4v4h-4" />
          <path d="M3 20v-4h4" />
        </>
      }
    />
  ),
  link: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11 7" />
          <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7L13 17" />
        </>
      }
    />
  ),
  unlink: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M16 12.5l3-3a4 4 0 0 0-5.7-5.7L11 6" />
          <path d="M8 11.5l-3 3a4 4 0 0 0 5.7 5.7L13 18" />
          <path d="M3 3l18 18" />
        </>
      }
    />
  ),

  /* ── Domain ─────────────────────────────────────────── */
  camera: (p) => (
    <Icon
      {...p}
      d={
        <>
          <rect x="3" y="6" width="18" height="13" rx="2" />
          <circle cx="12" cy="12.5" r="3.5" />
          <path d="M9 6l1.5-2h3L15 6" />
        </>
      }
    />
  ),
  pin: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M12 22s7-7 7-12a7 7 0 0 0-14 0c0 5 7 12 7 12z" />
          <circle cx="12" cy="10" r="2.5" />
        </>
      }
    />
  ),
  zap: (p) => <Icon {...p} d="M13 2L3 14h7l-1 8 10-12h-7z" />,
  layers: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M12 2l10 6-10 6L2 8z" />
          <path d="M2 13l10 6 10-6" />
          <path d="M2 18l10 6 10-6" />
        </>
      }
    />
  ),
  panel: (p) => (
    <Icon
      {...p}
      d={
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
        </>
      }
    />
  ),
  squares: (p) => (
    <Icon
      {...p}
      d={
        <>
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </>
      }
    />
  ),
  list: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M8 6h13M8 12h13M8 18h13" />
          <circle cx="4" cy="6" r="1" fill="currentColor" />
          <circle cx="4" cy="12" r="1" fill="currentColor" />
          <circle cx="4" cy="18" r="1" fill="currentColor" />
        </>
      }
    />
  ),
  image: (p) => (
    <Icon
      {...p}
      d={
        <>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="9" cy="9" r="2" />
          <path d="M21 16l-5-5-9 9" />
        </>
      }
    />
  ),
  envelope: (p) => (
    <Icon
      {...p}
      d={
        <>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M3 7l9 6 9-6" />
        </>
      }
    />
  ),
  phone: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M22 17v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L7.9 9.8a16 16 0 0 0 6 6l1.4-1.2a2 2 0 0 1 2.1-.5c.8.3 1.7.5 2.6.6A2 2 0 0 1 22 17z" />
        </>
      }
    />
  ),
  database: (p) => (
    <Icon
      {...p}
      d={
        <>
          <ellipse cx="12" cy="5" rx="8" ry="3" />
          <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
          <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
        </>
      }
    />
  ),
  ban: (p) => (
    <Icon
      {...p}
      d={
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M5.6 5.6l12.8 12.8" />
        </>
      }
    />
  ),
  certificate: (p) => (
    <Icon
      {...p}
      d={
        <>
          <circle cx="12" cy="9" r="6" />
          <path d="M8.5 13.5L7 21l5-3 5 3-1.5-7.5" />
        </>
      }
    />
  ),
  bolt: (p) => <Icon {...p} d="M13 2L3 14h7l-1 8 10-12h-7z" />,
  calendar: (p) => (
    <Icon
      {...p}
      d={
        <>
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 10h18" />
          <path d="M8 3v4M16 3v4" />
          <circle cx="8.5" cy="14.5" r="0.9" fill="currentColor" />
          <circle cx="12" cy="14.5" r="0.9" fill="currentColor" />
          <circle cx="15.5" cy="14.5" r="0.9" fill="currentColor" />
        </>
      }
    />
  ),
  spinner: (p) => (
    <Icon
      {...p}
      d={
        <>
          <path d="M12 3a9 9 0 1 0 9 9" />
        </>
      }
    />
  ),
};

export { Icon };
export default I;
