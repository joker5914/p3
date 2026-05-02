import { lazy, Suspense, useEffect, useState, useRef, useCallback } from "react";
import { onIdTokenChanged, signOut } from "firebase/auth";
import { collection, onSnapshot, query, orderBy } from "firebase/firestore";
import { auth, db } from "./firebase-config";
import { createApiClient } from "./api";
import Login from "./Login";
import Layout from "./Layout";
import SessionTimeoutWarning from "./SessionTimeoutWarning";
import ArrivalToasts, { useArrivalAlerts } from "./ArrivalToast";
import SearchPalette from "./SearchPalette";
import "./App.css";

/* ── Lazy page chunks ──────────────────────────────────────
   Every page-level component is loaded on demand instead of upfront.
   Why this matters for accessibility and the guardian product:

   - A guardian on a 4G phone in the pickup line previously downloaded
     the full ~840 KB JS bundle including Dashboard, AuditLog,
     PermissionSettings, PlatformAdmin, etc. — admin code they can
     never reach. Lazy loading drops the guardian path to Login →
     BenefactorPortal → AccountProfile and skips the rest.

   - Admin users skip paying for views they don't visit in this session.
     Per-route chunks also let CDN caching work at finer granularity.

   - The "above bar" a11y posture (per-deficiency CB presets, session
     timeout, etc.) is unchanged — code-splitting affects how chunks
     ship to the browser, not what they do once loaded.

   Login + Layout + SessionTimeoutWarning + ArrivalToasts stay eager:
   they're on the critical render path for every authenticated session
   and lazy-loading them would just add a flash of nothing on initial
   sign-in. Website + Trust are also lazy because authenticated users
   never see them (and vice-versa). */
const Website            = lazy(() => import("./Website"));
const Trust              = lazy(() => import("./Trust"));
const Accessibility      = lazy(() => import("./Accessibility"));
const Verify             = lazy(() => import("./Verify"));
const BenefactorPortal   = lazy(() => import("./BenefactorPortal"));
const Dashboard          = lazy(() => import("./Dashboard"));
const DataImporter       = lazy(() => import("./DataImporter"));
const Integrations       = lazy(() => import("./Integrations"));
const Insights           = lazy(() => import("./Insights"));
const History            = lazy(() => import("./History"));
const VehicleRegistry    = lazy(() => import("./VehicleRegistry"));
const UserManagement     = lazy(() => import("./UserManagement"));
const StudentManagement  = lazy(() => import("./StudentManagement"));
const GuardianManagement = lazy(() => import("./GuardianManagement"));
const AccountProfile     = lazy(() => import("./AccountProfile"));
const PermissionSettings = lazy(() => import("./PermissionSettings"));
const PlatformAdmin      = lazy(() => import("./PlatformAdmin"));
const PlatformDistricts  = lazy(() => import("./PlatformDistricts"));
const PlatformUsers      = lazy(() => import("./PlatformUsers"));
const DevicesList        = lazy(() => import("./DevicesList"));
const Firmware           = lazy(() => import("./Firmware"));
const SsoSettings        = lazy(() => import("./SsoSettings"));
const AuditLog           = lazy(() => import("./AuditLog"));

/* Suspense fallback for any in-flight page chunk.  Uses role="status"
   + aria-live="polite" so screen readers announce the load state.
   Visually a centered minimal label — pages typically arrive in
   under a frame on a warm cache, so a spinner would just flash. */
function PageChunkFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
        color: "var(--text-tertiary)",
        fontSize: "13px",
      }}
    >
      Loading…
    </div>
  );
}

/* ── Public-site routes ───────────────────────────────────────────────
   "/"             → marketing landing page (Website.jsx)
   "/trust"        → public trust posture (Trust.jsx) — linked from the
                     marketing security section and customer security teams
   "/accessibility"→ public accessibility statement (Accessibility.jsx) —
                     mirrors the Trust pattern; satisfies the "publish a
                     conformance report" expectation that procurement and
                     district disability-services offices look for
   anything else   → /portal flow (Login → authenticated app shell)

   Bookmarked /portal URLs and SSO redirects keep working because the
   default branch is the existing app.  Using window.location keeps the
   marketing/trust split free of react-router for one extra branch. */
function getPublicRoute() {
  if (typeof window === "undefined") return null;
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/")              return "marketing";
  if (path === "/trust")         return "trust";
  if (path === "/accessibility") return "accessibility";
  // Chain-of-custody pickup-receipt verifier (issue #72).  Reached by
  // anyone scanning the QR code on a printed receipt — must work
  // without a Dismissal account, so it routes here pre-Login.
  if (path.startsWith("/verify/")) return "verify";
  return null;
}
const PUBLIC_ROUTE = getPublicRoute();

/* ── Theme hook (global) ───────────────────────────────── */
function useTheme() {
  const [dark, setDark] = useState(() => {
    const stored = localStorage.getItem("dismissal-theme");
    if (stored) return stored === "dark";
    // Default to light mode for first-time visitors; the citrus accents
    // were designed against the light surface scale and read as the
    // canonical look.  Saved preferences (including dark) still win.
    return false;
  });

  useEffect(() => {
    document.body.setAttribute("data-theme", dark ? "dark" : "light");
    localStorage.setItem("dismissal-theme", dark ? "dark" : "light");
  }, [dark]);

  const toggle = useCallback(() => setDark((d) => !d), []);
  // Imperative setter exposed so the server-sync layer can hydrate the
  // value without going through the toggle path.
  const setFromServer = useCallback((value) => {
    if (value === "dark") setDark(true);
    else if (value === "light") setDark(false);
  }, []);
  return { dark, toggle, setFromServer };
}

/* ── Colorblind-safe palette hook (global) ────────────────
   Three-way state: "default" / "protanopia-deuteranopia" / "tritanopia"
   — matches the GitHub / Slack per-deficiency model.  Sets
   body[data-palette="…"], which index.css uses to override the status
   hue tokens with the appropriate Okabe-Ito (red-green CVD) or
   Tol-style (blue-yellow CVD) preset.  Persisted in localStorage so
   the choice survives reloads and applies before React paints.

   The legacy "colorblind" value is normalized to
   "protanopia-deuteranopia" on read — the original Okabe-Ito tuning
   was for red-green CVD specifically, so users who opted into the
   single legacy toggle land on the correct preset automatically. */
const PALETTE_VALUES = ["default", "protanopia-deuteranopia", "tritanopia"];

function _normalizePalette(value) {
  if (value === "colorblind") return "protanopia-deuteranopia";
  if (PALETTE_VALUES.includes(value)) return value;
  return "default";
}

function usePalette() {
  const [palette, setPaletteState] = useState(
    () => _normalizePalette(localStorage.getItem("dismissal-palette")),
  );

  useEffect(() => {
    if (palette === "default") document.body.removeAttribute("data-palette");
    else document.body.setAttribute("data-palette", palette);
    localStorage.setItem("dismissal-palette", palette);
  }, [palette]);

  const set = useCallback((value) => {
    const next = _normalizePalette(value);
    setPaletteState(next);
  }, []);
  const setFromServer = set;
  return { palette, set, setFromServer };
}

/* ── Density hook (global) ─────────────────────────────────
   Toggles body[data-density="compact|comfortable|spacious"], which
   index.css uses to scale --density and the page/card padding +
   grid-gap tokens that depend on it.  Persisted in localStorage so
   the choice survives reloads and applies before React paints. */
const DENSITY_VALUES = ["compact", "comfortable", "spacious"];

function useDensity() {
  const [density, setDensity] = useState(() => {
    const stored = localStorage.getItem("dismissal-density");
    return DENSITY_VALUES.includes(stored) ? stored : "comfortable";
  });

  useEffect(() => {
    document.body.setAttribute("data-density", density);
    localStorage.setItem("dismissal-density", density);
  }, [density]);

  const set = useCallback((value) => {
    if (DENSITY_VALUES.includes(value)) setDensity(value);
  }, []);
  return { density, set, setFromServer: set };
}

// Persist the current view + school/district context in sessionStorage so a
// browser refresh lands the user back where they were instead of the default
// role landing page.  sessionStorage (not localStorage) scopes this to the
// tab — opening a fresh tab still shows the role-default landing view.
const VIEW_STORAGE_KEY     = "dismissal-view";
const SCHOOL_STORAGE_KEY   = "dismissal-active-school";
const DISTRICT_STORAGE_KEY = "dismissal-active-district";

function _readStoredJson(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function _clearViewStorage() {
  sessionStorage.removeItem(VIEW_STORAGE_KEY);
  sessionStorage.removeItem(SCHOOL_STORAGE_KEY);
  sessionStorage.removeItem(DISTRICT_STORAGE_KEY);
}

function App() {
  const [authLoading, setAuthLoading] = useState(true);
  const [token, setToken] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [queue, setQueue] = useState([]);
  // hostname (lowercased) -> current admin-set location for the active
  // school's devices.  Sourced from /api/v1/dashboard so the listener
  // path can remap historical scans tagged with the hostname fallback.
  const [deviceLocations, setDeviceLocations] = useState({});
  const [view, setView] = useState(
    () => sessionStorage.getItem(VIEW_STORAGE_KEY) || "dashboard",
  );
  const [wsStatus, setWsStatus] = useState(null);
  const [activeSchool, setActiveSchool] = useState(
    () => _readStoredJson(SCHOOL_STORAGE_KEY),
  );
  const [activeDistrict, setActiveDistrict] = useState(
    () => _readStoredJson(DISTRICT_STORAGE_KEY),
  );
  const [scanVersion, setScanVersion] = useState(0);
  // Audit log actor filter: when set by "View activity" on a user card, the
  // nav click that follows loads AuditLog prefiltered by this uid/label.
  // Cleared once the user navigates away from the audit view.
  const [auditFilter, setAuditFilter] = useState(null); // { uid, label } | null

  // Global search palette open state + the one-shot navigation intent
  // it produces.  When the user picks a result the palette sets a
  // `pendingSearch` of `{ view, search, key }`; the destination page
  // reads it as an initial value for its own search input.  The key
  // is just a monotonically-increasing counter so the destination
  // page can re-seed when the user picks another result for the same
  // view (otherwise re-using the same query would be a no-op).
  const [searchOpen, setSearchOpen] = useState(false);
  const [pendingSearch, setPendingSearch] = useState(null); // { view, search, key } | null

  useEffect(() => {
    if (view) sessionStorage.setItem(VIEW_STORAGE_KEY, view);
    // Clear audit actor-filter state when the user navigates away from the
    // audit view — otherwise coming back via the nav would re-apply the
    // per-user filter that was set by "View activity".
    if (view !== "audit") setAuditFilter(null);
    // Same shape for the global-search seed: drop it once the user
    // has navigated past the page it was meant for, so revisiting
    // that page later doesn't auto-filter to a stale query.
    if (pendingSearch && view !== pendingSearch.view) setPendingSearch(null);
  }, [view, pendingSearch]);

  const handleGlobalSearchNavigate = useCallback(({ view: targetView, search }) => {
    // Bump the key on every pick so the destination page re-seeds even
    // when the user picks another result that happens to produce the
    // same string — without this, the page's useEffect would no-op.
    setPendingSearch({ view: targetView, search, key: Date.now() });
    setView(targetView);
  }, []);

  useEffect(() => {
    if (activeSchool) sessionStorage.setItem(SCHOOL_STORAGE_KEY, JSON.stringify(activeSchool));
    else sessionStorage.removeItem(SCHOOL_STORAGE_KEY);
  }, [activeSchool]);

  useEffect(() => {
    if (activeDistrict) sessionStorage.setItem(DISTRICT_STORAGE_KEY, JSON.stringify(activeDistrict));
    else sessionStorage.removeItem(DISTRICT_STORAGE_KEY);
  }, [activeDistrict]);

  const { dark, toggle: toggleTheme, setFromServer: setThemeFromServer } = useTheme();
  const { palette, set: setPalette, setFromServer: setPaletteFromServer } = usePalette();
  const { density, set: setDensity, setFromServer: setDensityFromServer } = useDensity();

  // ── Preference sync (server ↔ client) ──────────────────
  // Hydrate the three UI prefs from currentUser.preferences on first
  // load so they follow the user across browsers/devices.  After that,
  // any local change debounce-PATCHes /me so server state stays in
  // sync with what the user is actually seeing.
  const prefsHydratedRef = useRef(false);
  useEffect(() => {
    if (!currentUser || prefsHydratedRef.current) return;
    prefsHydratedRef.current = true;
    const prefs = currentUser.preferences || {};
    if (prefs.theme)   setThemeFromServer(prefs.theme);
    if (prefs.palette) setPaletteFromServer(prefs.palette);
    if (prefs.density) setDensityFromServer(prefs.density);
  }, [currentUser, setThemeFromServer, setPaletteFromServer, setDensityFromServer]);

  const prefsPushTimerRef = useRef(null);
  useEffect(() => {
    // Skip until /me has been loaded and hydration has run, otherwise
    // the very first render would push the localStorage defaults up to
    // the server and clobber whatever the user set on another device.
    if (!token || !prefsHydratedRef.current) return;
    clearTimeout(prefsPushTimerRef.current);
    prefsPushTimerRef.current = setTimeout(() => {
      const body = {
        preferences: {
          theme:   dark ? "dark" : "light",
          palette,
          density,
        },
      };
      createApiClient(token).patch("/api/v1/me", body).catch((err) => {
        // Non-fatal — local UI already reflects the change; server will
        // pick it up on the next toggle.  Log for visibility but do not
        // surface a toast (would interrupt rapid theme toggling).
        console.debug("preferences sync failed:", err?.message || err);
      });
    }, 800);
    return () => clearTimeout(prefsPushTimerRef.current);
  }, [dark, palette, density, token]);

  const mountedRef = useRef(true);

  const arrivalAlerts = useArrivalAlerts();
  const arrivalNotifyRef = useRef(arrivalAlerts.notify);
  arrivalNotifyRef.current = arrivalAlerts.notify;

  const seenHashesRef = useRef(new Set());
  const initialLoadDoneRef = useRef(false);
  // Track the UID we've already recorded an auth.signin.success audit
  // event for.  Firebase's onIdTokenChanged fires on every token refresh,
  // not just sign-in — we only want one sign-in event per actual session.
  const sessionRecordedForUidRef = useRef(null);

  const handleDismiss = useCallback((plateToken) => {
    setQueue((prev) => {
      for (const e of prev) {
        if (e.plate_token === plateToken && e.hash) {
          seenHashesRef.current.delete(e.hash);
        }
      }
      return prev.filter((e) => e.plate_token !== plateToken);
    });
  }, []);

  const handleLogout = useCallback(async () => {
    await signOut(auth);
  }, []);

  const handleProfileUpdate = useCallback((updatedUser) => {
    setCurrentUser(updatedUser);
  }, []);

  useEffect(() => {
    const unsubscribe = onIdTokenChanged(auth, async (fbUser) => {
      if (fbUser) {
        try {
          const idToken = await fbUser.getIdToken();
          setToken(idToken);
          // Pass the drilled-in school (if any) as context on the /me
          // call.  The backend uses it to self-heal historical records
          // whose ``district_id`` was never stamped (e.g. users elevated
          // to district_admin before the district_id plumbing existed).
          // Reading activeSchool from sessionStorage directly — the
          // closure might not have the latest React state on the first
          // firing of onIdTokenChanged.
          const storedSchool = _readStoredJson(SCHOOL_STORAGE_KEY);
          const res = await createApiClient(idToken, storedSchool?.id ?? null).get("/api/v1/me");
          setCurrentUser(res.data);
          // Audit: record the sign-in event exactly once per session.  We
          // know this is a new session rather than a silent token refresh
          // because the uid differs from the one we last recorded.  The
          // provider comes off the Firebase user metadata so the audit
          // log captures "signed in with Google" vs. "with password".
          if (sessionRecordedForUidRef.current !== fbUser.uid) {
            sessionRecordedForUidRef.current = fbUser.uid;
            const providerData = fbUser.providerData || [];
            const provider = providerData[0]?.providerId || "password";
            createApiClient(idToken)
              .post("/api/v1/auth/session-start", { provider })
              .catch((err) => {
                // Non-fatal — auth audit is telemetry, not a gate.
                console.debug("session-start audit failed:", err?.message || err);
              });
          }
          // Only apply the role-default landing view on a fresh login — if
          // the user refreshed the tab, sessionStorage already has their
          // last view and we shouldn't yank them back to the role landing.
          if (!sessionStorage.getItem(VIEW_STORAGE_KEY)) {
            if (res.data.is_guardian) setView("benefactor");
            else if (res.data.is_super_admin) setView("districts");
            else if (res.data.role === "district_admin") setView("platformAdmin");
          }
        } catch (err) {
          if (err.response?.status === 401) {
            await signOut(auth);
          } else {
            console.error("Failed to load user profile:", err);
          }
        }
      } else {
        // Clear persisted view before resetting state so the next login
        // lands on its role-default view instead of the last user's page.
        _clearViewStorage();
        sessionRecordedForUidRef.current = null;
        setToken(null);
        setCurrentUser(null);
        setQueue([]);
        setView("dashboard");
        setWsStatus("disconnected");
        setActiveSchool(null);
        setActiveDistrict(null);
        initialLoadDoneRef.current = false;
        seenHashesRef.current = new Set();
      }
      setAuthLoading(false);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!token || (view !== "dashboard" && view !== "reports")) return;
    // Pickup Queue is per-school: skip the fetch until an elevated admin
    // has actually chosen a campus, otherwise we'd either query the wrong
    // bucket (old UID fallback) or spam 400s.
    if (
      (currentUser?.role === "super_admin" || currentUser?.role === "district_admin")
      && !activeSchool
    ) {
      setQueue([]);
      setDeviceLocations({});
      initialLoadDoneRef.current = true;
      return;
    }
    createApiClient(token, activeSchool?.id ?? null)
      .get("/api/v1/dashboard")
      .then((res) => {
        if (!mountedRef.current) return;
        const items = res.data.queue || [];
        items.forEach((e) => { if (e.hash) seenHashesRef.current.add(e.hash); });
        setQueue(items);
        setDeviceLocations(res.data.device_locations || {});
        initialLoadDoneRef.current = true;
      })
      .catch((err) => {
        if (err.response?.status === 401) handleLogout();
        else console.error("Dashboard fetch error:", err);
        initialLoadDoneRef.current = true;
      });
  }, [token, view, activeSchool, currentUser, handleLogout]);

  useEffect(() => {
    mountedRef.current = true;
    const liveView = view === "dashboard" || view === "reports";
    if (!token || !liveView || currentUser === null) return;
    // The live dashboard only makes sense inside a specific school.
    // Super/district admins at platform/district level skip the listener.
    if ((currentUser.role === "super_admin" || currentUser.role === "district_admin") && !activeSchool) return;

    const schoolId = activeSchool?.id ?? currentUser?.school_id;
    if (!schoolId) return;

    setWsStatus("connecting");

    // Subscribe to live_queue/{schoolId}/events.  Adds become new
    // queue cards; removes drop them.  onSnapshot has built-in
    // retry/backoff and offline buffering so we no longer need the
    // hand-rolled reconnect/heartbeat/stale-timer machinery the
    // WebSocket flow used.
    const eventsQuery = query(
      collection(db, "live_queue", schoolId, "events"),
      orderBy("timestamp", "asc"),
    );

    const unsubscribe = onSnapshot(
      eventsQuery,
      (snapshot) => {
        if (!mountedRef.current) return;
        setWsStatus("connected");
        snapshot.docChanges().forEach((change) => {
          const data = change.doc.data();
          // Firestore returns Timestamps; normalise to ISO so the rest
          // of the app keeps treating timestamps as the WS used to.
          if (data.timestamp && typeof data.timestamp.toDate === "function") {
            data.timestamp = data.timestamp.toDate().toISOString();
          }
          if (change.type === "added") {
            const alreadySeen = data.hash && seenHashesRef.current.has(data.hash);
            if (data.hash) seenHashesRef.current.add(data.hash);
            setQueue((prev) => {
              if (data.hash && prev.some((e) => e.hash === data.hash)) return prev;
              if (prev.some((e) => e.firestore_id === change.doc.id)) return prev;
              return [...prev, data];
            });
            // Skip the firehose of toasts on initial subscribe — the
            // /api/v1/dashboard seed populates seenHashes for any
            // pre-existing rows so we only chime on genuinely new ones.
            if (!alreadySeen && initialLoadDoneRef.current) {
              arrivalNotifyRef.current(data);
            }
            setScanVersion((v) => v + 1);
          } else if (change.type === "removed") {
            setQueue((prev) => {
              for (const e of prev) {
                if (e.firestore_id === change.doc.id && e.hash) {
                  seenHashesRef.current.delete(e.hash);
                }
              }
              return prev.filter((e) => e.firestore_id !== change.doc.id);
            });
            setScanVersion((v) => v + 1);
          } else if (change.type === "modified") {
            setQueue((prev) => prev.map((e) =>
              e.firestore_id === change.doc.id ? { ...e, ...data } : e
            ));
            setScanVersion((v) => v + 1);
          }
        });
      },
      (err) => {
        console.error("live_queue listener error:", err);
        setWsStatus("disconnected");
      },
    );

    return () => {
      mountedRef.current = false;
      unsubscribe();
      setWsStatus(null);
    };
  }, [token, view, currentUser, activeSchool]);

  useEffect(() => {
    if (!token || (view !== "dashboard" && view !== "reports")) return;
    if (wsStatus === "connected") return;
    // Same guard as the initial fetch — poll only when we have a concrete
    // campus to scope to.
    if (
      (currentUser?.role === "super_admin" || currentUser?.role === "district_admin")
      && !activeSchool
    ) return;

    const poll = () => {
      createApiClient(token, activeSchool?.id ?? null)
        .get("/api/v1/dashboard")
        .then((res) => {
          if (!mountedRef.current) return;
          const items = res.data.queue || [];
          let hasNew = false;
          items.forEach((e) => {
            if (!e.hash) return;
            if (!seenHashesRef.current.has(e.hash)) {
              seenHashesRef.current.add(e.hash);
              if (initialLoadDoneRef.current) arrivalNotifyRef.current(e);
              hasNew = true;
            }
          });
          setQueue(items);
          setDeviceLocations(res.data.device_locations || {});
          if (hasNew) setScanVersion((v) => v + 1);
        })
        .catch((err) => {
          if (err?.response?.status === 401) handleLogout();
        });
    };

    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [token, view, wsStatus, activeSchool, currentUser, handleLogout]);

  if (authLoading) {
    return (
      <div
        role="status"
        aria-live="polite"
        style={{
          minHeight: "100vh",
          background: "#f5f5f7",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
          color: "#6e6e73",
          fontSize: "14px",
        }}
      >
        Loading…
      </div>
    );
  }

  if (!token) return <Login />;

  if (currentUser?.is_guardian) {
    return (
      <>
        <Suspense fallback={<PageChunkFallback />}>
          <BenefactorPortal
            token={token}
            currentUser={currentUser}
            handleLogout={handleLogout}
          />
        </Suspense>
        <SessionTimeoutWarning token={token} onSignOut={handleLogout} />
      </>
    );
  }

  const schoolId = activeSchool?.id ?? null;
  const isSuperAdmin = currentUser?.role === "super_admin";
  const isDistrictAdmin = currentUser?.role === "district_admin";
  const platformRole = isSuperAdmin || isDistrictAdmin;
  const isAdminNoSchool = platformRole && !activeSchool;
  // Super admins must pick a district before they can reach location-scoped
  // views; otherwise they'd bypass the district -> location drill-down that
  // keeps data scoped correctly.  District admins have an implicit district
  // (their assignment), so they skip this gate.
  const superAdminNeedsDistrict = isSuperAdmin && !activeDistrict;

  const districtSelectionPrompt = (
    <div className="school-selection-required">
      <div className="school-selection-required-card">
        <h3 className="school-selection-required-title">District Selection Required</h3>
        <p className="school-selection-required-desc">
          Pick a district first — locations, devices, and school-scoped
          views belong to a specific district.
        </p>
        <button
          className="school-selection-required-btn"
          onClick={() => setView("districts")}
        >
          Go to Districts
        </button>
      </div>
    </div>
  );

  const schoolSelectionPrompt = (
    <div className="school-selection-required">
      <div className="school-selection-required-card">
        <h3 className="school-selection-required-title">School Selection Required</h3>
        <p className="school-selection-required-desc">
          Select a school from the Locations page to access this section.
        </p>
        <button
          className="school-selection-required-btn"
          onClick={() => setView(superAdminNeedsDistrict ? "districts" : "platformAdmin")}
        >
          {superAdminNeedsDistrict ? "Go to Districts" : "Go to Locations"}
        </button>
      </div>
    </div>
  );

  const SCHOOL_SCOPED_VIEWS = new Set([
    "dashboard", "students", "guardians", "users", "permissions",
    "registry", "reports", "history",
  ]);
  // Platform-level views that require a district to be selected first.
  // Super admins hitting these without a district see the district-picker
  // prompt.  Devices stays accessible at the platform top so Dismissal
  // staff can manage unassigned hardware across all customers.
  const DISTRICT_SCOPED_VIEWS = new Set(["platformAdmin", "sso", "integrations"]);

  const content = {
    dashboard: (
      <Dashboard
        queue={queue}
        deviceLocations={deviceLocations}
        onClearQueue={() => { seenHashesRef.current.clear(); setQueue([]); }}
        onDismiss={handleDismiss}
        token={token}
        schoolId={schoolId}
      />
    ),
    integrations: (
      <Integrations
        token={token}
        currentUser={currentUser}
        activeDistrict={activeDistrict}
        schoolId={schoolId}
        setView={setView}
      />
    ),
    dataImporter: <DataImporter token={token} schoolId={schoolId} />,
    reports: <Insights token={token} schoolId={schoolId} scanVersion={scanVersion} />,
    history: <History token={token} schoolId={schoolId} />,
    registry: (
      <VehicleRegistry
        token={token}
        currentUser={currentUser}
        schoolId={schoolId}
        initialSearch={pendingSearch?.view === "registry" ? pendingSearch : null}
      />
    ),
    students: (
      <StudentManagement
        token={token}
        schoolId={schoolId}
        currentUser={currentUser}
        initialSearch={pendingSearch?.view === "students" ? pendingSearch : null}
      />
    ),
    guardians: (
      <GuardianManagement
        token={token}
        schoolId={schoolId}
        currentUser={currentUser}
        initialSearch={pendingSearch?.view === "guardians" ? pendingSearch : null}
      />
    ),
    users: (
      <UserManagement
        token={token}
        currentUser={currentUser}
        schoolId={schoolId}
        onViewActivity={(uid, label) => {
          setAuditFilter({ uid, label });
          setView("audit");
        }}
      />
    ),
    profile: (
      <AccountProfile
        token={token}
        currentUser={currentUser}
        onProfileUpdate={handleProfileUpdate}
        schoolId={schoolId}
        dark={dark}
        onToggleTheme={toggleTheme}
        palette={palette}
        onSetPalette={setPalette}
        density={density}
        onSetDensity={setDensity}
      />
    ),
    permissions: <PermissionSettings token={token} schoolId={schoolId} />,
    platformAdmin: (
      <PlatformAdmin
        token={token}
        setActiveSchool={setActiveSchool}
        setView={setView}
        activeDistrict={activeDistrict}
        setActiveDistrict={setActiveDistrict}
      />
    ),
    districts: (
      <PlatformDistricts
        token={token}
        setActiveDistrict={setActiveDistrict}
        setView={setView}
      />
    ),
    platformUsers: <PlatformUsers token={token} currentUser={currentUser} />,
    devices: <DevicesList token={token} currentUser={currentUser} />,
    firmware: <Firmware token={token} currentUser={currentUser} />,
    sso: (
      <SsoSettings
        token={token}
        currentUser={currentUser}
        activeDistrict={activeDistrict}
      />
    ),
    audit: (
      <AuditLog
        token={token}
        currentUser={currentUser}
        schoolId={schoolId}
        initialActorUid={auditFilter?.uid ?? null}
        initialActorLabel={auditFilter?.label ?? null}
      />
    ),
  };

  let resolvedView;
  if (superAdminNeedsDistrict && DISTRICT_SCOPED_VIEWS.has(view)) {
    resolvedView = districtSelectionPrompt;
  } else if (isAdminNoSchool && SCHOOL_SCOPED_VIEWS.has(view)) {
    resolvedView = schoolSelectionPrompt;
  } else {
    resolvedView = content[view] ?? <h2 style={{ padding: "2rem" }}>Select an option from the navigation.</h2>;
  }

  return (
    <>
      <Layout
        view={view}
        setView={setView}
        handleLogout={handleLogout}
        token={token}
        currentUser={currentUser}
        activeSchool={activeSchool}
        setActiveSchool={setActiveSchool}
        activeDistrict={activeDistrict}
        setActiveDistrict={setActiveDistrict}
        arrivalAlerts={arrivalAlerts}
        onOpenSearch={() => setSearchOpen(true)}
      >
        {/* Suspense wraps the page chunk only — TopBar / sidebar /
            alerts shell stays mounted and interactive while the next
            view's chunk loads, so navigation never feels janky. */}
        <Suspense fallback={<PageChunkFallback />}>
          {resolvedView}
        </Suspense>
        <ArrivalToasts toasts={arrivalAlerts.toasts} removeToast={arrivalAlerts.removeToast} />
      </Layout>
      {/* Session-timeout warning sits outside Layout so it overlays
          everything (including any in-page modal) and isn't constrained
          by the layout-main scroll container. */}
      <SessionTimeoutWarning token={token} onSignOut={handleLogout} />
      <SearchPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        token={token}
        schoolId={schoolId}
        onNavigate={handleGlobalSearchNavigate}
      />
    </>
  );
}

function Root() {
  if (PUBLIC_ROUTE === "marketing") {
    return (
      <Suspense fallback={<PageChunkFallback />}>
        <Website />
      </Suspense>
    );
  }
  if (PUBLIC_ROUTE === "trust") {
    return (
      <Suspense fallback={<PageChunkFallback />}>
        <Trust />
      </Suspense>
    );
  }
  if (PUBLIC_ROUTE === "accessibility") {
    return (
      <Suspense fallback={<PageChunkFallback />}>
        <Accessibility />
      </Suspense>
    );
  }
  if (PUBLIC_ROUTE === "verify") {
    return (
      <Suspense fallback={<PageChunkFallback />}>
        <Verify />
      </Suspense>
    );
  }
  return <App />;
}

export default Root;
