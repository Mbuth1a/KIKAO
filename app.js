import {
  auth,
  signInWithGoogle,
  observeAuthState,
  signOutUser,
  saveUserProfile,
  getUserProfile,
  linkFacebookAccount,
  profileExistsForUser,
  db
} from "./firebase.js";

import {
  collection,
  query,
  where,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

import {
  createPlan as createPlanInFirestore,
  subscribeToPlans,
  subscribeToMyRequests,
  subscribeToHostedRequests,
  requestToJoin,
  decideJoinRequest,
  leavePlan,
  deletePlan,
  subscribeToMessages,
  sendPlanMessage,
  startPresenceSharing,
  stopPresenceSharing,
  subscribeToPresence,
  submitRating,
  getMyRatingForPlan,
  getHostRating,
  distanceBetween,
  NAIROBI_AREAS
} from "./kikao-data.js";

import { TERMS_VERSION, TERMS_TITLE, TERMS_SECTIONS } from "./terms.js";

(() => {
  "use strict";

  const MIN_AGE = 18;
  const STORAGE_KEY = "kikao-pwa-demo-v4";
  const PRESENCE_PREF_KEY = "kikao-presence-pref";
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  const today = new Date();
  const dateISO = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
  const nextFriday = () => { const d = new Date(); const delta = (5 - d.getDay() + 7) % 7 || 7; d.setDate(d.getDate() + delta); return d; };
  const nextSaturday = () => { const d = new Date(); const delta = (6 - d.getDay() + 7) % 7 || 7; d.setDate(d.getDate() + delta); return d; };
  const fmtDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-KE", { weekday: "short", day: "numeric", month: "short" });
  const money = (n) => `KES ${Number(n || 0).toLocaleString("en-KE")}`;
  const escapeHTML = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // const seedPlans = () => [
  //   { id: "seed-party", title: "Rooftop sounds & new faces", type: "party", area: "Westlands", date: dateISO(nextFriday()), time: "19:00", budget: 2200, spots: 5, joined: 2, host: "Amina W.", hostId: "seed-host-1", hostVerified: true, drinks: "Alcohol optional", vibe: "Afrobeats · easy conversations", rules: "Come as you are. Respect boundaries and split your own bill.", destination: "", transportCost: 0, womenOnly: false, status: "open", createdBy: "seed" },
  //   { id: "seed-road", title: "Nairobi → Naivasha day escape", type: "roadtrip", area: "Westlands", date: dateISO(nextSaturday()), time: "07:00", budget: 3800, spots: 4, joined: 2, host: "Brian K.", hostId: "seed-host-2", hostVerified: true, drinks: "Non-alcoholic", vibe: "Road views · lakeside lunch", rules: "Driver stays alcohol-free. Return time and costs agreed before departure.", destination: "Naivasha", transportCost: 1600, womenOnly: false, createdBy: "seed", status: "open", designatedDriver: true },
  //   { id: "seed-chill", title: "Nyama choma & slow Sunday", type: "chill", area: "Kilimani", date: dateISO(addDays(6)), time: "15:00", budget: 1500, spots: 3, joined: 1, host: "Njeri M.", hostId: "seed-host-3", hostVerified: true, drinks: "Alcohol optional", vibe: "Food · music · no pressure", rules: "Good energy only. Everyone is welcome.", destination: "", transportCost: 0, womenOnly: false, createdBy: "seed", status: "open" }
  // ];

  /**
   * Plan templates. Tapping a card in the create form prefills the fields
   * with these values. The host still edits date/time/venue themselves —
   * those are plan-specific. Everything else is a starting point.
   */
  const PLAN_TEMPLATES = {
    rooftop: {
      title: "Rooftop drinks & new faces",
      type: "party",
      area: "Westlands",
      budget: 2500,
      spots: 4,
      drinks: "Alcohol optional",
      vibe: "Afrobeats · rooftop views · new faces",
      rules: "Arrive by 7pm. Split your own bill. Respect boundaries.",
      venueHint: "The Alchemist, Westlands"
    },
    daytrip: {
      title: "Day trip escape",
      type: "roadtrip",
      area: "Westlands",
      budget: 3500,
      spots: 4,
      drinks: "Non-alcoholic",
      vibe: "Road views · lakeside lunch",
      rules: "Designated driver stays alcohol-free. Return time agreed before departure.",
      venueHint: "Pickup point shared after approval",
      destination: "Naivasha",
      transport: "Host has a car",
      transportCost: 1500,
      pickup: "Westlands",
      designatedDriver: true
    },
    sunday: {
      title: "Nyama choma & slow Sunday",
      type: "chill",
      area: "Kilimani",
      budget: 1500,
      spots: 4,
      drinks: "Alcohol optional",
      vibe: "Food · music · no pressure",
      rules: "Good energy only. Everyone is welcome.",
      venueHint: "A public restaurant in Kilimani"
    }
  };

  const initialState = () => ({
    profile: null,
    plans: seedPlans(),
    requests: [],
    hostedRequests: [],
    chats: {},
    trustedContact: null,
    blocked: [],
    reports: [],
    passed: [],
    lastView: "discover",
    ratings: {},
    hostRatings: {}
  });

  let state;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    state = raw ? { ...initialState(), ...JSON.parse(raw) } : initialState();
  } catch {
    state = initialState();
  }
  if (!state.plans || !state.plans.length) state.plans = seedPlans();
  if (!state.passed) state.passed = [];
  if (!state.ratings) state.ratings = {};
  if (!state.hostRatings) state.hostRatings = {};

  let unsubscribePlans = null;
  let unsubscribeMyRequests = null;
  let unsubscribeHostedRequests = null;
  let unsubscribeChat = null;
  let unsubscribeMembers = null;
  let unsubscribePresence = null;
  let presenceWatchId = null;
  let presenceSharingEnabled = true;
  let mapInstance = null;
  let memberMarkers = {};
  let activeChatPlanId = null;
  let viewerCoords = null;
  let renderFeedDepth = 0;
  let countdownTimer = null;

  try {
    const pref = localStorage.getItem(PRESENCE_PREF_KEY);
    if (pref === "off") presenceSharingEnabled = false;
  } catch {}

  // ---------- Location state ----------
  let locationState = "unknown";

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      profile: state.profile,
      trustedContact: state.trustedContact,
      blocked: state.blocked,
      reports: state.reports,
      passed: state.passed,
      lastView: state.lastView
    }));
  }

  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  function initials(name) {
    return (name || "Guest").trim().split(/\s+/).slice(0, 2).map((x) => x[0] || "").join("").toUpperCase() || "?";
  }
  function currentUser() { return state.profile?.name || "You"; }
  function isVerified() { return !!state.profile?.verified; }

  function planById(id) { return state.plans.find((p) => p.id === id); }
  function myRequest(planId) { return state.requests.find((r) => r.planId === planId); }

  function getMyPlans() {
    const uid = state.profile?.uid;
    if (!uid) return [];
    return state.plans.filter((p) => p.hostId === uid);
  }

  function planHasEnded(plan) {
    if (!plan?.date) return false;
    const start = new Date(`${plan.date}T${plan.time || "00:00"}:00`);
    return Date.now() > start.getTime();
  }

  function planHasStarted(plan) {
    return planHasEnded(plan);
  }

  function isLiveNow(plan) {
    return plan?.spontaneous === true && !planHasStarted(plan);
  }

  function liveCountdown(plan) {
    if (!plan?.date) return "";
    const start = new Date(`${plan.date}T${plan.time || "00:00"}:00`).getTime();
    const diff = start - Date.now();
    if (diff <= 0) return "Starting now";
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m left`;
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem === 0 ? `${hours}h left` : `${hours}h ${rem}m left`;
  }

  function statusLabel(status) {
    return ({
      pending: "Awaiting host",
      approved: "Approved · lobby unlocked",
      declined: "Not approved",
      waitlisted: "On waitlist"
    })[status] || status;
  }

  function typeLabel(type) { return type === "roadtrip" ? "Road trip" : type === "party" ? "Party / drinks" : "Chill / food"; }
  function typeSymbol(type) {
    const wrap = (svg) => `<span class="plan-symbol" aria-hidden="true">${svg}</span>`;

    if (type === "party") {
      return wrap(`
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 4h14l-7 8-7-8z"/>
          <path d="M12 12v7"/>
          <path d="M8 20h8"/>
          <circle cx="16.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"/>
        </svg>
      `);
    }

    if (type === "roadtrip") {
      return wrap(`
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 16v-3l2-5a2 2 0 0 1 1.9-1.3h10.2A2 2 0 0 1 19 8l2 5v3"/>
          <path d="M3 16h18"/>
          <path d="M3 16v3h2v-2"/>
          <path d="M19 17v2h2v-3"/>
          <circle cx="7" cy="17" r="2"/>
          <circle cx="17" cy="17" r="2"/>
          <path d="M5 11h14"/>
        </svg>
      `);
    }

    return wrap(`
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="7"/>
        <circle cx="12" cy="12" r="3.5"/>
        <path d="M3 4v5a2 2 0 0 0 2 2h1V4"/>
        <path d="M21 4c-1.5 0-2.5 1.5-2.5 3.5S19 11 19 13v7"/>
      </svg>
    `);
  }

  function renderStars(count, size = 14) {
    const full = "★";
    const empty = "☆";
    const n = Math.max(0, Math.min(5, Math.round(count)));
    return `<span class="stars" style="font-size:${size}px;letter-spacing:1px;color:#c9a227;">${full.repeat(n)}${empty.repeat(5 - n)}</span>`;
  }

  function showModal(html) {
    $("#modal-body").innerHTML = html;
    $("#modal-backdrop").classList.remove("hidden");
  }
  function closeModal() {
    $("#modal-backdrop").classList.add("hidden");
    $("#modal-body").innerHTML = "";
  }

  function teardownPresence() {
    if (presenceWatchId !== null) {
      try { navigator.geolocation.clearWatch(presenceWatchId); } catch {}
      presenceWatchId = null;
    }
    if (unsubscribePresence) { unsubscribePresence(); unsubscribePresence = null; }
    const planId = window.activeLobbyId;
    if (planId) stopPresenceSharing(planId);
    if (mapInstance) {
      try { mapInstance.remove(); } catch {}
      mapInstance = null;
      memberMarkers = {};
    }
  }

  function teardownCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function go(view) {
    if (view !== "lobby") {
      teardownPresence();
      if (unsubscribeChat) { unsubscribeChat(); unsubscribeChat = null; }
      if (unsubscribeMembers) { unsubscribeMembers(); unsubscribeMembers = null; }
      activeChatPlanId = null;
    }
    if (view !== "discover") {
      teardownCountdown();
    }
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
    $$(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === view));
    state.lastView = view;
    save();
    if (view === "activity") renderActivity();
    if (view === "profile") renderProfile();
    if (view === "discover") renderFeed();
    if (view === "lobby" && window.activeLobbyId) openLobby(window.activeLobbyId);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ---------- Profile ----------

  function renderProfile() {
    const p = state.profile;
    $("#avatar-initials").textContent = initials(p?.name);
    $("#profile-avatar").textContent = initials(p?.name);
    $("#profile-name").textContent = p?.name || "Guest";
    $("#profile-phone").textContent = p?.email || "Sign in with Google to join a plan.";
    $("#verified-label").textContent = p?.verified ? "✓ Google verified" : "○ Not verified";
    $("#verification-status").textContent = p?.verified ? "GOOGLE VERIFIED" : "PENDING";

    const igRow = $("#profile-instagram-row");
    if (igRow) {
      if (p?.instagram?.handle) {
        igRow.innerHTML = `
          <div>
            <b>Instagram</b>
            <small>
              <a href="https://instagram.com/${escapeHTML(p.instagram.handle)}"
                 target="_blank" rel="noopener noreferrer"
                 style="color:var(--green); font-weight:800; text-decoration:none;">
                @${escapeHTML(p.instagram.handle)}
              </a>
              · unverified
            </small>
          </div>
          <button class="text-link" data-action="link-accounts">Change →</button>
        `;
      } else {
        igRow.innerHTML = `
          <div>
            <b>Instagram</b>
            <small>Link your handle so people can verify you before meeting.</small>
          </div>
          <button class="text-link" data-action="link-accounts">Link →</button>
        `;
      }
    }
  }

  // ---------- Location helpers ----------

  async function checkLocationState() {
    if (!("geolocation" in navigator)) {
      locationState = "unsupported";
      return locationState;
    }
    try {
      const status = await navigator.permissions.query({ name: "geolocation" });
      if (status.state === "granted")      locationState = "granted";
      else if (status.state === "denied")  locationState = "denied";
      else                                 locationState = "prompt";
    } catch {
      locationState = "prompt";
    }
    return locationState;
  }

  async function requestViewerCoords() {
    if (viewerCoords) return viewerCoords;
    if (!("geolocation" in navigator)) {
      locationState = "unsupported";
      return null;
    }
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          viewerCoords = [pos.coords.latitude, pos.coords.longitude];
          locationState = "granted";
          resolve(viewerCoords);
        },
        (err) => {
          if (err.code === err.PERMISSION_DENIED) locationState = "denied";
          else locationState = "prompt";
          resolve(null);
        },
        { timeout: 8000, maximumAge: 300000, enableHighAccuracy: false }
      );
    });
  }

  function updateDistanceFilterVisibility() {
    const select = $("#distance-filter");
    if (!select) return;

    if (locationState === "granted") {
      select.style.display = "";
      select.disabled = false;
      select.title = "";
    } else if (locationState === "denied" || locationState === "unsupported") {
      select.style.display = "none";
    } else {
      select.style.display = "";
      select.disabled = true;
      select.title = "Enable location to filter by distance";
    }
  }

  function renderLocationBanner() {
    const container = $("#location-banner");
    if (!container) return;

    if (locationState === "granted" || locationState === "unsupported") {
      container.innerHTML = "";
      return;
    }

    const isDenied = locationState === "denied";
    container.innerHTML = `
      <div class="location-banner ${isDenied ? "denied" : ""}">
        <span class="location-banner-icon">${isDenied ? "⚠" : "⌖"}</span>
        <div class="location-banner-copy">
          <b>${isDenied ? "Location is off" : "See plans near you"}</b>
          <small>${isDenied
            ? "Enable location in browser settings to sort by distance. You can still browse by area."
            : "Enable location to sort plans by distance and see how far each one is."}</small>
        </div>
        ${!isDenied ? `<button class="button button-outline button-small" data-action="enable-location">Enable</button>` : ""}
      </div>
    `;
  }

  // ---------- Terms ----------

  function hasAcceptedCurrentTerms(profile) {
    if (!profile) return false;
    return profile.termsVersion === TERMS_VERSION;
  }

  function openTermsModal(onAccept) {
    const isFirstAcceptance = !state.profile?.termsVersion;
    const sectionsHtml = TERMS_SECTIONS.map(s => `
      <section style="margin-bottom:18px;">
        <h3 style="margin:0 0 6px;font:800 14px Manrope,sans-serif;">${escapeHTML(s.heading)}</h3>
        <p style="margin:0;font-size:12px;line-height:1.55;color:#4a5a50;">${escapeHTML(s.body).replace(/\n/g, "<br>")}</p>
      </section>
    `).join("");

    showModal(`
      <div class="modal-kicker">BEFORE YOU CONTINUE</div>
      <h2>${escapeHTML(TERMS_TITLE)}</h2>
      <p class="modal-sub">Version ${escapeHTML(TERMS_VERSION)}. Scroll to the end to accept.</p>
      <div id="terms-scroll" style="max-height:50vh;overflow-y:auto;padding:14px;border:1px solid var(--line);border-radius:10px;background:#fafbf8;margin-bottom:14px;">
        ${sectionsHtml}
        <p style="margin:6px 0 0;text-align:center;font-size:11px;color:#8a9a8e;">— end of terms —</p>
      </div>
      <label class="check-row">
        <input type="checkbox" id="terms-agree-checkbox" disabled>
        <span>I have read and agree to the ${escapeHTML(TERMS_TITLE)}.</span>
      </label>
      <button class="button button-dark button-wide" id="terms-agree-btn" disabled>
        ${isFirstAcceptance ? "Accept and continue →" : "Accept updated terms →"}
      </button>
    `);

    const scrollEl = $("#terms-scroll");
    const checkbox = $("#terms-agree-checkbox");
    const agreeBtn = $("#terms-agree-btn");

    function enableCheckbox() {
      checkbox.disabled = false;
    }

    function checkScrolled() {
      const atBottom =
        scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 24;
      if (atBottom) {
        enableCheckbox();
        scrollEl.removeEventListener("scroll", checkScrolled);
      }
    }

    scrollEl.addEventListener("scroll", checkScrolled);

    requestAnimationFrame(() => {
      if (scrollEl.scrollHeight <= scrollEl.clientHeight + 4) {
        enableCheckbox();
      } else {
        checkScrolled();
      }

      setTimeout(() => {
        if (checkbox.disabled && scrollEl.scrollHeight <= scrollEl.clientHeight + 8) {
          enableCheckbox();
        }
      }, 100);
    });

    checkbox.addEventListener("change", () => {
      agreeBtn.disabled = !checkbox.checked;
    });

    agreeBtn.addEventListener("click", () => {
      if (!checkbox.checked) return;
      closeModal();
      onAccept();
    });
  }

  async function ensureTermsAccepted() {
    if (hasAcceptedCurrentTerms(state.profile)) return true;

    return new Promise((resolve) => {
      openTermsModal(async () => {
        try {
          const updated = await saveUserProfile({
            ...state.profile,
            uid: state.profile?.uid || auth.currentUser?.uid,
            termsVersion: TERMS_VERSION
          });
          state.profile = updated;
          save();
          renderProfile();
          toast("Terms accepted.");
          resolve(true);
        } catch (err) {
          toast("Could not record acceptance: " + err.message);
          resolve(false);
        }
      });
    });
  }

  // ---------- Swipe stack ----------

  function formatDistance(plan) {
    if (!viewerCoords || !plan.location) {
      return plan.area ? `${plan.area} · distance unavailable` : "Distance unavailable";
    }
    const km = distanceBetween(
      [plan.location.latitude ?? plan.location._lat, plan.location.longitude ?? plan.location._long],
      viewerCoords
    );
    return km < 1 ? "Less than 1 km away" : `${Math.round(km)} km away`;
  }

  function visiblePlans() {
    const query_ = ($("#search-input")?.value || "").toLowerCase().trim();
    const type = $("#type-filter")?.value || "all";
    const budget = $("#budget-filter")?.value || "all";
    const distance = $("#distance-filter")?.value || "all";
    const gender = $("#gender-filter")?.value || "all";
    const blocked = new Set(state.blocked);
    const passed = new Set(state.passed || []);
    const requested = new Set(state.requests.map((r) => r.planId));
    const myUid = state.profile?.uid;
    const isWoman = state.profile?.gender === "woman";

    return state.plans
      .filter((p) => {
        if (blocked.has(p.host)) return false;
        if (passed.has(p.id)) return false;
        if (requested.has(p.id)) return false;
        if (myUid && p.hostId === myUid) return false;
        if (p.status === "locked") return false;

        if (p.spontaneous === true && planHasStarted(p)) return false;

        const hay = `${p.title} ${p.area} ${p.host} ${p.destination || ""}`.toLowerCase();
        if (query_ && !hay.includes(query_)) return false;
        if (type !== "all" && p.type !== type) return false;
        if (budget !== "all" && Number(p.budget) > Number(budget)) return false;
        if (gender === "women-only" && !p.womenOnly) return false;
        if (p.womenOnly && state.profile && !isWoman) return false;

        if (distance !== "all" && viewerCoords && p.location) {
          const lat = p.location.latitude ?? p.location._lat;
          const lng = p.location.longitude ?? p.location._long;
          const km = distanceBetween([lat, lng], viewerCoords);
          if (km > Number(distance)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const aLive = isLiveNow(a);
        const bLive = isLiveNow(b);
        if (aLive && !bLive) return -1;
        if (!aLive && bLive) return 1;
        return a.date.localeCompare(b.date);
      });
  }

  function hostRatingBadge(plan) {
    const cached = state.hostRatings?.[plan.hostId];
    if (!cached || cached.count < 5) return "";
    return `<span class="host-rating-badge" title="${cached.count} ratings">${renderStars(cached.average, 11)} <small>${cached.average.toFixed(1)}</small></span>`;
  }

  function renderFeed() {
    const stack = visiblePlans();
    const el = $("#swipe-stack");
    const empty = $("#swipe-underlay");
    $("#live-count").textContent = stack.length;

    if (!stack.length) {
      el.innerHTML = "";
      empty.classList.remove("hidden");
      teardownCountdown();
      return;
    }
    empty.classList.add("hidden");

    const top = stack.slice(0, 3);
    el.innerHTML = top.map((p, i) => {
      const live = isLiveNow(p);
      const liveBadge = live
        ? `<span class="live-now-badge" data-countdown-for="${escapeHTML(p.id)}">● Live now · ${escapeHTML(liveCountdown(p))}</span>`
        : "";

      return `
      <article class="swipe-card" data-id="${escapeHTML(p.id)}" style="--i:${i}">
        <div class="swipe-cover cover-${escapeHTML(p.type)}">
          <span class="type-label">${escapeHTML(typeLabel(p.type))}</span>
          ${p.womenOnly ? '<span class="women-only-badge">Women only</span>' : ""}
          ${String(p.id).startsWith("seed-") ? '<span class="demo-badge">KIKAO</span>' : ""}
          ${liveBadge}
          <h2>${escapeHTML(p.title)}</h2>
        </div>
        <div class="swipe-body">
          <div class="host-line"><span class="host-avatar">${escapeHTML(initials(p.host))}</span><span>Hosted by <b>${escapeHTML(p.host)}</b></span>${p.hostVerified ? '<span class="verified-mini">✓ Verified</span>' : ""}</div>
          ${hostRatingBadge(p)}
          <div class="swipe-distance">${escapeHTML(formatDistance(p))}</div>
          <div class="plan-meta">
            <div class="meta-item"><span class="meta-icon">◷</span>${escapeHTML(fmtDate(p.date))} · ${escapeHTML(p.time)}</div>
            <div class="meta-item"><span class="meta-icon">⌖</span>${escapeHTML(p.area)}</div>
            <div class="meta-item"><span class="meta-icon">♧</span>${escapeHTML(p.drinks || "Social plan")}</div>
            <div class="meta-item"><span class="meta-icon">✦</span>${escapeHTML(p.vibe || "Meet new people")}</div>
          </div>
          <div class="plan-footer">
            <div class="budget"><strong>${money(p.budget)}</strong><small>estimated per person</small></div>
            <div class="spots"><b>${Math.max(0, p.spots - (p.joined || 0))}</b> / ${escapeHTML(p.spots)} spots left</div>
          </div>
        </div>
        <div class="swipe-actions">
          <button class="swipe-btn pass" data-action="swipe-pass" data-id="${escapeHTML(p.id)}" aria-label="Pass">✕</button>
          <button class="swipe-btn info" data-action="swipe-info" data-id="${escapeHTML(p.id)}" aria-label="Details">ⓘ</button>
          <button class="swipe-btn like" data-action="swipe-like" data-id="${escapeHTML(p.id)}" aria-label="Join">♥</button>
        </div>
        <div class="swipe-label pass-label">PASS</div>
        <div class="swipe-label like-label">JOIN</div>
      </article>
    `;
    }).join("");

    attachSwipeGestures(el);
    updateDistanceFilterVisibility();
    startCountdownTicker();

    if (renderFeedDepth === 0) {
      renderFeedDepth++;
      fetchHostRatingsForStack(top).finally(() => {
        renderFeedDepth = Math.max(0, renderFeedDepth - 1);
      });
    }
  }

  function startCountdownTicker() {
    teardownCountdown();
    countdownTimer = setInterval(() => {
      const badges = $$(".live-now-badge[data-countdown-for]");
      if (!badges.length) {
        teardownCountdown();
        return;
      }
      let anyStarted = false;
      for (const el of badges) {
        const planId = el.dataset.countdownFor;
        const plan = planById(planId);
        if (!plan) continue;
        if (planHasStarted(plan)) {
          anyStarted = true;
          continue;
        }
        el.textContent = `● Live now · ${liveCountdown(plan)}`;
      }
      if (anyStarted) {
        teardownCountdown();
        renderFeed();
      }
    }, 60000);
  }

  async function fetchHostRatingsForStack(plans) {
    let fetched = 0;

    for (const p of plans) {
      if (state.hostRatings?.[p.hostId] !== undefined) continue;
      try {
        const rating = await getHostRating(p.hostId);
        state.hostRatings = state.hostRatings || {};
        state.hostRatings[p.hostId] = rating || { average: 0, count: 0 };
      } catch {
        state.hostRatings = state.hostRatings || {};
        state.hostRatings[p.hostId] = { average: 0, count: 0 };
      }
      fetched++;
    }

    if (fetched > 0) {
      const el = $("#swipe-stack");
      if (el && el.children.length) {
        renderFeed();
      }
    }
  }

  function attachSwipeGestures(root) {
    const card = root.querySelector(".swipe-card");
    if (!card) return;

    let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;

    const down = (e) => {
      dragging = true;
      const pt = e.touches ? e.touches[0] : e;
      startX = pt.clientX; startY = pt.clientY;
      card.style.transition = "none";
    };
    const move = (e) => {
      if (!dragging) return;
      const pt = e.touches ? e.touches[0] : e;
      dx = pt.clientX - startX;
      dy = pt.clientY - startY;
      const rot = dx * 0.06;
      card.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
      card.style.setProperty("--like-opacity", Math.max(0, dx / 120));
      card.style.setProperty("--pass-opacity", Math.max(0, -dx / 120));
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      card.style.transition = "transform .25s ease, opacity .25s ease";
      if (dx > 100) return commitSwipe(card.dataset.id, "right", card);
      if (dx < -100) return commitSwipe(card.dataset.id, "left", card);
      card.style.transform = "";
      card.style.setProperty("--like-opacity", 0);
      card.style.setProperty("--pass-opacity", 0);
    };

    card.addEventListener("pointerdown", down);
    card.addEventListener("pointermove", move);
    card.addEventListener("pointerup", up);
    card.addEventListener("pointercancel", up);
    card.addEventListener("pointerleave", up);
  }

  function commitSwipe(planId, direction, cardEl) {
    if (!cardEl) return;

    if (direction === "right") {
      if (String(planId).startsWith("seed-")) {
        cardEl.style.transform = "translate(120vw, 0) rotate(20deg)";
        cardEl.style.opacity = "0";
        toast("Demo plans can’t be joined — try a real plan.");
        setTimeout(renderFeed, 220);
        return;
      }

      const p = planById(planId);
      if (p?.spontaneous === true && planHasStarted(p)) {
        cardEl.style.transform = "translate(120vw, 0) rotate(20deg)";
        cardEl.style.opacity = "0";
        toast("This spontaneous plan has already started.");
        setTimeout(renderFeed, 220);
        return;
      }

      cardEl.style.transform = "translate(120vw, 0) rotate(20deg)";
      cardEl.style.opacity = "0";
      beginJoin(planId).finally(() => setTimeout(renderFeed, 220));
      return;
    }

    if (!state.passed.includes(planId)) state.passed.push(planId);
    save();

    cardEl.style.transform = "translate(-120vw, 0) rotate(-20deg)";
    cardEl.style.opacity = "0";
    setTimeout(renderFeed, 220);
  }

  // ---------- Activity ----------

  function renderActivity(tab = "joining") {
    const joining = state.requests;
    const hosting = getMyPlans();

    $("#joining-count").textContent = joining.length;
    $("#hosting-count").textContent = hosting.length;
    $$(".activity-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    $("#joining-panel").classList.toggle("hidden", tab !== "joining");
    $("#hosting-panel").classList.toggle("hidden", tab !== "hosting");

    if (!joining.length) {
      $("#joining-panel").innerHTML = '<div class="empty-panel"><b>No join requests yet</b>Swipe right on a plan in Discover to request a spot.<br><br><button class="button button-outline button-small" data-action="go" data-view="discover">Explore plans</button></div>';
    } else {
      $("#joining-panel").innerHTML = joining.map((r) => {
        const p = planById(r.planId);
        if (!p) return "";

        let buttons = "";
        let rateButton = "";

        if (r.status === "approved") {
          buttons = `
            <button class="button button-dark button-small" data-action="open-lobby" data-id="${p.id}">Open lobby</button>
            <button class="button button-outline button-small" data-action="leave-plan" data-id="${p.id}">Leave plan</button>
          `;

          
        } else if (r.status === "waitlisted") {
          buttons = `<button class="button button-outline button-small" disabled>Waiting for a spot</button>`;
        }

        const liveChip = isLiveNow(p) ? '<span class="live-chip">● Live now</span>' : "";

        return `<article class="activity-card">
          <div class="activity-thumb cover-${p.type}">${typeSymbol(p.type)}</div>
          <div class="activity-details">
            <h3>${escapeHTML(p.title)} ${liveChip}</h3>
            <p>${escapeHTML(p.area)} · ${escapeHTML(fmtDate(p.date))} · Host: ${escapeHTML(p.host)}</p>
            <span class="activity-status ${r.status}">${escapeHTML(statusLabel(r.status))}</span>
            <div class="activity-actions">${buttons}${rateButton}<button class="text-link" data-action="report" data-id="${p.id}">Report</button></div>
          </div>
        </article>`;
      }).join("");
    }

    if (!hosting.length) {
      $("#hosting-panel").innerHTML = '<div class="empty-panel"><b>You have not hosted a plan</b>Create a plan and invite people to join your lobby.<br><br><button class="button button-outline button-small" data-action="go" data-view="create">Create a plan</button></div>';
    } else {
      $("#hosting-panel").innerHTML = hosting.map((p) => {
        const incoming = state.hostedRequests.filter((r) => r.planId === p.id && r.status === "pending");
        const spotsLeft = Math.max(0, p.spots - (p.joined || 0));
        const statusChip = p.status === "locked" ? "Lobby locked" : "Published";
        const rating = state.hostRatings?.[p.hostId];
        const ratingLine = (rating && rating.count >= 5)
          ? `<span class="host-rating-line">${renderStars(rating.average, 12)} <small>${rating.average.toFixed(1)} · ${rating.count} ratings</small></span>`
          : "";
        const liveChip = isLiveNow(p) ? '<span class="live-chip">● Live now</span>' : "";

        return `<article class="activity-card">
          <div class="activity-thumb cover-${p.type}">${typeSymbol(p.type)}</div>
          <div class="activity-details">
            <h3>${escapeHTML(p.title)} ${liveChip}</h3>
            <p>${escapeHTML(p.area)} · ${escapeHTML(fmtDate(p.date))} · ${spotsLeft} spots left</p>
            <span class="activity-status approved">${statusChip}</span>
            ${ratingLine}
            <div class="activity-actions">
              <button class="button button-dark button-small" data-action="open-lobby" data-id="${p.id}">Open lobby</button>
              <button class="button button-danger button-small" data-action="delete-plan" data-id="${p.id}">Delete</button>
            </div>
            ${incoming.map((r) => `<div class="incoming-request">
              <b>${escapeHTML(r.requesterName)}</b>
              <span>· ${escapeHTML(r.requesterGender || "")}</span>
              <div class="activity-actions">
                <button class="button button-dark button-small" data-action="host-approve" data-id="${r.id}">Approve</button>
                <button class="button button-outline button-small" data-action="host-decline" data-id="${r.id}">Decline</button>
              </div>
            </div>`).join("")}
          </div>
        </article>`;
      }).join("");
    }

    $("#nav-activity-dot").classList.toggle(
      "hidden",
      !joining.some((r) => r.status === "pending") &&
      !state.hostedRequests.some((r) => r.status === "pending")
    );
  }

  // ---------- Rating modal ----------

 

  // ---------- Lobby ----------

  async function openLobby(planId) {
    window.activeLobbyId = planId;
    if (unsubscribeChat) { unsubscribeChat(); unsubscribeChat = null; }
    if (unsubscribeMembers) { unsubscribeMembers(); unsubscribeMembers = null; }
    activeChatPlanId = planId;
    try {
      await renderLobby(planId);
      subscribeLobbyStreams(planId);
    } catch (e) {
      toast(e.message);
      go("activity");
    }
  }

  function subscribeLobbyStreams(planId) {
    unsubscribeChat = subscribeToMessages(
      planId,
      (messages) => {
        state.chats[planId] = messages;
        renderLobby(planId);
      },
      () => {}
    );

    unsubscribeMembers = onSnapshot(
      query(collection(db, "planMembers"), where("planId", "==", planId)),
      (snap) => {
        state.members = state.members || {};
        state.members[planId] = snap.docs.map((d) => d.data());
        renderMembersList(planId);
      },
      (err) => {
        console.error("Members subscription failed:", err);
        const el = $("#lobby-members");
        if (el) el.innerHTML = '<div class="lobby-info-row"><span>Members unavailable.</span></div>';
      }
    );
  }

  function renderMembersList(planId) {
    const el = $("#lobby-members");
    if (!el) return;
    const p = planById(planId);
    const members = (state.members?.[planId]) || [];

    const rows = [
      `<div class="lobby-info-row"><span>${escapeHTML(p?.host || "Host")}</span><b>Host</b></div>`
    ];
    for (const m of members) {
      if (m.uid === p?.hostId) continue;
      const handle = m.instagram?.handle;
      const handleLink = handle
        ? ` <a href="https://instagram.com/${escapeHTML(handle)}"
             target="_blank" rel="noopener noreferrer"
             style="color:var(--green); font-weight:700; text-decoration:none; font-size:12px;">@${escapeHTML(handle)}</a>`
        : "";
      rows.push(`<div class="lobby-info-row"><span>${escapeHTML(m.name || "Member")}${handleLink}</span><b>Member</b></div>`);
    }
    el.innerHTML = rows.join("");
  }

  async function renderLobby(planId) {
    const p = planById(planId);
    if (!p) { go("activity"); return; }
    const isHost = p.hostId === state.profile?.uid;
    const r = myRequest(planId);
    const confirmed = isHost || r?.status === "approved";

    if (!confirmed) {
      go("activity");
      toast("Your spot must be approved before opening the lobby.");
      return;
    }

    const messages = state.chats[planId] || [];
    const participantCount = p.joined || 1;
    const liveBadge = isLiveNow(p)
      ? `<span class="live-now-badge">● Live now · ${escapeHTML(liveCountdown(p))}</span>`
      : "";

    $("#lobby-content").innerHTML = `
      <div class="lobby-head">
        <button class="back-button" data-action="go" data-view="activity">‹</button>
        <div class="lobby-title"><h2>${escapeHTML(p.title)}</h2><p>${escapeHTML(p.area)} · ${escapeHTML(fmtDate(p.date))} · ${escapeHTML(p.time)}</p></div>
        ${liveBadge}
        <span class="status-chip">${p.status === "locked" ? "FULL / LOCKED" : "ACTIVE LOBBY"}</span>
      </div>
      ${p.status === "locked" ? '<div class="locked-banner">🔒 This lobby is full. New join requests are closed.</div>' : ""}

      <div class="lobby-map-wrap">
        <div id="lobby-map"></div>
        <label class="presence-toggle">
          <input type="checkbox" id="presence-toggle-checkbox" ${presenceSharingEnabled ? "checked" : ""}>
          <span>Share my location with this crew</span>
        </label>
        <div id="presence-note" class="presence-note"></div>
      </div>

      <div class="lobby-layout">
        <section class="chat-panel">
          <div class="chat-top"><div><b>Plan conversation</b><br><small>${participantCount} confirmed participant(s) · Host: ${escapeHTML(p.host)}</small></div><span class="verified-mini">● Private</span></div>
          <div class="chat-messages" id="chat-messages">
            ${messages.length ? messages.map((m) => `<div class="chat-message ${m.uid === state.profile?.uid ? "mine" : ""}"><b>${escapeHTML(m.name || "Guest")}</b><span class="chat-bubble">${escapeHTML(m.text)}</span></div>`).join("") : '<div class="chat-message"><span class="chat-bubble">Say hello — messages are only visible to approved members.</span></div>'}
          </div>
          <form class="chat-compose" id="chat-form"><input name="message" maxlength="300" placeholder="Message your crew…" autocomplete="off" required><button type="submit">Send</button></form>
        </section>
        <aside class="lobby-info">
          <h3>Plan details</h3>
          <div class="lobby-info-row"><span>Area</span><b>${escapeHTML(p.area)}</b></div>
          <div class="lobby-info-row"><span>Venue</span><b>${escapeHTML(p.venue || "—")}</b></div>
          <div class="lobby-info-row"><span>Budget estimate</span><b>${money(p.budget)}</b></div>
          <div class="lobby-info-row"><span>Drinks</span><b>${escapeHTML(p.drinks || "N/A")}</b></div>
          ${p.womenOnly ? '<div class="lobby-info-row"><span>Audience</span><b>Women only</b></div>' : ""}
          ${p.type === "roadtrip" ? `<div class="lobby-info-row"><span>Destination</span><b>${escapeHTML(p.destination || "TBC")}</b></div><div class="lobby-info-row"><span>Driver rule</span><b>Alcohol-free</b></div>` : ""}
          ${p.spontaneous ? `<div class="lobby-info-row"><span>Plan type</span><b>Live now</b></div>` : ""}
          <p>${escapeHTML(p.rules || "Respect the group and the venue.")}</p>

          <h3>Who's coming</h3>
          <div id="lobby-members"><div class="lobby-info-row"><span>Loading members…</span></div></div>

          <h3>Actions</h3>
          <button class="button button-outline button-small" data-action="check-in" data-id="${p.id}">✓ Check in</button>
          <button class="button button-outline button-small" data-action="share-plan" data-id="${p.id}">↗ Share plan</button>
          <button class="button button-danger button-small" data-action="report" data-id="${p.id}">Report / block</button>
          ${!isHost ? `<button class="button button-outline button-small" data-action="leave-plan" data-id="${p.id}">Leave plan</button>` : ""}
          ${isHost ? `<button class="button button-danger button-small" data-action="delete-plan" data-id="${p.id}">Delete plan</button>` : ""}
        </aside>
      </div>`;

    const box = $("#chat-messages");
    if (box) box.scrollTop = box.scrollHeight;

    $("#chat-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = e.currentTarget.elements.message;
      const msg = input.value.trim();
      if (!msg) return;
      input.disabled = true;
      try {
        await sendPlanMessage(planId, msg);
        input.value = "";
      } catch (err) {
        toast(err.message);
      } finally {
        input.disabled = false;
        input.focus();
      }
    });

    if (state.members?.[planId]) renderMembersList(planId);

    initLobbyMap(planId);
    wirePresenceToggle(planId);
  }

  // ---------- Live presence map ----------

  function initLobbyMap(planId) {
    const container = $("#lobby-map");
    if (!container) return;
    if (typeof L === "undefined") {
      container.innerHTML = '<div class="map-unavailable">Map unavailable — Leaflet did not load.</div>';
      return;
    }

    const p = planById(planId);
    if (!p) return;

    const planStart = new Date(`${p.date}T${p.time || "00:00"}:00`);
    if (Date.now() > planStart.getTime()) {
      const note = $("#presence-note");
      if (note) note.textContent = "This plan has started. Live location sharing is closed.";
      const toggle = $("#presence-toggle-checkbox");
      if (toggle) { toggle.checked = false; toggle.disabled = true; }
      return;
    }

    const venueLat = p.location?.latitude ?? p.location?._lat ?? -1.2864;
    const venueLng = p.location?.longitude ?? p.location?._long ?? 36.8172;

    if (mapInstance) {
      try { mapInstance.remove(); } catch {}
      mapInstance = null;
      memberMarkers = {};
    }

    mapInstance = L.map(container, {
      zoomControl: true,
      attributionControl: true
    }).setView([venueLat, venueLng], 13);

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(mapInstance);

    const venueIcon = L.divIcon({
      className: "venue-marker",
      html: '<div class="venue-marker-pin">⌖</div>',
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
    L.marker([venueLat, venueLng], { icon: venueIcon })
      .addTo(mapInstance)
      .bindPopup(`<b>${escapeHTML(p.venue || "Venue")}</b><br>${escapeHTML(p.area || "")}`);

    if (unsubscribePresence) unsubscribePresence();
    unsubscribePresence = subscribeToPresence(
      planId,
      (members) => renderPresenceMarkers(members),
      (err) => {
        console.warn("Presence subscription failed:", err);
        const note = $("#presence-note");
        if (note) note.textContent = "Live locations unavailable.";
      }
    );

    startMyPresence(planId);
  }

  function startMyPresence(planId) {
    if (presenceWatchId !== null) {
      try { navigator.geolocation.clearWatch(presenceWatchId); } catch {}
      presenceWatchId = null;
    }

    if (!presenceSharingEnabled) {
      stopPresenceSharing(planId);
      updatePresenceNote("Location sharing is off.");
      return;
    }

    const name = state.profile?.name || "Member";
    presenceWatchId = startPresenceSharing(
      planId,
      name,
      (msg) => {
        console.warn("Presence:", msg);
        updatePresenceNote(msg);
      }
    );

    if (presenceWatchId === null) {
      presenceSharingEnabled = false;
      const cb = $("#presence-toggle-checkbox");
      if (cb) cb.checked = false;
      updatePresenceNote("Location sharing unavailable on this device.");
    } else {
      updatePresenceNote("");
    }
  }

  function updatePresenceNote(text) {
    const el = $("#presence-note");
    if (el) el.textContent = text || "";
  }

  function wirePresenceToggle(planId) {
    const checkbox = $("#presence-toggle-checkbox");
    if (!checkbox) return;

    checkbox.addEventListener("change", async () => {
      presenceSharingEnabled = checkbox.checked;
      try {
        localStorage.setItem(PRESENCE_PREF_KEY, presenceSharingEnabled ? "on" : "off");
      } catch {}

      if (presenceSharingEnabled) {
        startMyPresence(planId);
      } else {
        if (presenceWatchId !== null) {
          try { navigator.geolocation.clearWatch(presenceWatchId); } catch {}
          presenceWatchId = null;
        }
        await stopPresenceSharing(planId);
        updatePresenceNote("Location sharing is off. Others can't see you on the map.");
      }
    });
  }

  function renderPresenceMarkers(members) {
    if (!mapInstance) return;

    const visible = members.filter((m) => m.sharing !== false);

    for (const m of visible) {
      const lat = m.latitude;
      const lng = m.longitude;
      if (typeof lat !== "number" || typeof lng !== "number") continue;

      const isMe = m.uid === state.profile?.uid;
      const label = isMe ? "You" : (m.name || "Member");

      if (memberMarkers[m.uid]) {
        memberMarkers[m.uid].setLatLng([lat, lng]);
        memberMarkers[m.uid].setPopupContent(`<b>${escapeHTML(label)}</b>`);
      } else {
        const icon = L.divIcon({
          className: "presence-marker",
          html: `<div class="presence-pin${isMe ? " me" : ""}">${escapeHTML(initials(label))}</div>`,
          iconSize: [32, 32],
          iconAnchor: [16, 16]
        });
        memberMarkers[m.uid] = L.marker([lat, lng], { icon })
          .addTo(mapInstance)
          .bindPopup(`<b>${escapeHTML(label)}</b>`);
      }
    }

    const visibleUids = new Set(visible.map((m) => m.uid));
    for (const uid of Object.keys(memberMarkers)) {
      if (!visibleUids.has(uid)) {
        try { mapInstance.removeLayer(memberMarkers[uid]); } catch {}
        delete memberMarkers[uid];
      }
    }
  }

  // ---------- Join / host actions ----------

  async function beginJoin(planId) {
    if (!state.profile?.verified) {
      openSignIn("Sign in to request a spot.");
      return;
    }
    const p = planById(planId);
    if (!p) return;

    if (p.womenOnly && state.profile.gender !== "woman") {
      toast("This plan is women-only. Update your profile to continue.");
      return;
    }

    if (p.spontaneous === true && planHasStarted(p)) {
      toast("This spontaneous plan has already started.");
      renderFeed();
      return;
    }

    try {
      await requestToJoin(planId, state.profile.name, state.profile);
      toast("Join request sent to the host.");
      go("activity");
    } catch (e) {
      toast(e.message);
    }
  }

  async function hostDecision(requestId, approve) {
    try {
      await decideJoinRequest(requestId, approve);
      toast(approve ? "Join request approved." : "Request declined.");

      if (approve) {
        const planId = String(requestId).split("_")[0];
        if (planId && planById(planId)) {
          openLobby(planId);
          go("lobby");
        }
      }
    } catch (e) {
      toast(e.message);
    }
  }

  function checkIn(planId) {
    const key = `checkin-${planId}`;
    const already = state[key];
    state[key] = already ? "checked_out" : "checked_in";
    save();
    toast(already ? "Check-out recorded in this plan." : "Check-in recorded. Stay with your crew.");
  }

  async function sharePlan(planId) {
    const p = planById(planId) || state.plans[0];
    if (!p) return;
    const text = `Kikao plan: ${p.title}\n${p.area} · ${fmtDate(p.date)} · ${p.time}\nHost: ${p.host}\nBudget estimate: ${money(p.budget)} per person\nExact meetup details are shared with approved participants only.`;
    try {
      if (navigator.share) await navigator.share({ title: "Kikao plan", text });
      else if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); toast("Plan details copied."); }
      else showModal(`<h2>Share this plan</h2><p class="modal-sub">Copy these details to your trusted contact.</p><div class="share-box">${escapeHTML(text).replace(/\n/g, "<br>")}</div><button class="button button-dark button-wide" data-action="close-modal">Done</button>`);
    } catch (e) { if (e.name !== "AbortError") toast("Could not open sharing on this device."); }
  }

  function reportConcern(planId) {
    const reportedPlan = planById(planId);
    const reportedHost = reportedPlan?.host || "Unknown profile";
    showModal(`<div class="modal-kicker">COMMUNITY SAFETY</div><h2>Report a concern</h2><p class="modal-sub">Choose the issue. This stores the report locally on your device.</p>
      <form id="report-form">
        <label class="field"><span>Reason</span><select name="reason">
          <option>Unsafe behaviour</option>
          <option>Harassment or unwanted contact</option>
          <option>Fake profile or impersonation</option>
          <option>Scam or payment request</option>
          <option>Drink-spiking concern</option>
          <option>Joined a women-only plan inappropriately</option>
          <option>Other</option>
        </select></label>
        <label class="field"><span>Details (optional)</span><textarea name="details" rows="3" maxlength="300" placeholder="Tell us what happened."></textarea></label>
        <label class="check-row"><input type="checkbox" name="block"><span><b>Also block ${escapeHTML(reportedHost)}</b><small>Blocked hosts' plans will be hidden from Discover on this device.</small></span></label>
        <button class="button button-danger button-wide" type="submit">Submit report</button>
      </form>`);
    $("#report-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      state.reports.push({ planId, reason: f.get("reason"), details: f.get("details"), at: Date.now() });
      if (f.get("block") && reportedHost !== "Unknown profile" && !state.blocked.includes(reportedHost)) {
        state.blocked.push(reportedHost);
      }
      save();
      closeModal();
      renderFeed();
      toast(f.get("block") ? "Report saved; profile blocked locally." : "Report saved locally.");
    });
  }

  function sos() {
    showModal(`<div class="modal-kicker">URGENT SAFETY</div><h2>Get to a safe place.</h2>
      <p class="modal-sub">If you are in immediate danger, move to a staffed public place, alert someone you trust and contact local emergency services.</p>
      <div class="warning">In Kenya, commonly used emergency numbers include <b>999</b> and <b>112</b>. Confirm current local guidance before launch. This app cannot place an emergency call or track your location.</div>
      <button class="button button-dark button-wide" data-action="close-modal">I understand</button>`);
  }

  function trustedContact() {
    showModal(`<div class="modal-kicker">SAFETY SETUP</div><h2>Add a trusted contact.</h2>
      <p class="modal-sub">This person can receive your plan details when you share them. The plan stores this information only in this browser.</p>
      <form id="trusted-form">
        <label class="field"><span>Contact name</span><input name="name" maxlength="40" value="${escapeHTML(state.trustedContact?.name || "")}" required></label>
        <label class="field"><span>Phone number</span><input name="phone" type="tel" value="${escapeHTML(state.trustedContact?.phone || "")}" placeholder="07XX XXX XXX" required></label>
        <button class="button button-dark button-wide" type="submit">Save trusted contact</button>
      </form>`);
    $("#trusted-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      state.trustedContact = { name: String(f.get("name")).trim(), phone: String(f.get("phone")).trim() };
      save();
      closeModal();
      toast("Trusted contact saved on this device.");
    });
  }

  function editProfile() {
    if (!state.profile) { openCompleteProfile(); return; }
    showModal(`<div class="modal-kicker">PROFILE DETAILS</div><h2>Edit your profile.</h2>
      <form id="edit-form">
        <label class="field"><span>Name</span><input name="name" value="${escapeHTML(state.profile.name)}" required maxlength="40"></label>
        <label class="field"><span>Age</span><input name="age" type="number" min="${MIN_AGE}" value="${escapeHTML(state.profile.age)}" required></label>
        <label class="field"><span>Gender (self-declared)</span>
          <select name="gender">
            ${["woman","man","nonbinary","prefer_not_to_say"].map((g) => `<option value="${g}" ${state.profile.gender === g ? "selected" : ""}>${g.replace(/_/g," ")}</option>`).join("")}
          </select>
          <small class="field-help">Self-declared. Required to join women-only plans.</small>
        </label>
        <button class="button button-dark button-wide" type="submit">Save changes</button>
      </form>`);
    $("#edit-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      try {
        const updated = await saveUserProfile({
          ...state.profile,
          name: String(f.get("name")).trim(),
          age: Number(f.get("age")),
          gender: String(f.get("gender"))
        });
        state.profile = updated;
        save();
        closeModal();
        renderProfile();
        renderFeed();
        toast("Profile updated.");
      } catch (err) {
        toast(err.message);
      }
    });
  }

  function resetDemo() {
    showModal(`<h2>Reset local data?</h2>
      <p class="modal-sub">This clears your saved preferences (trusted contact, blocked list, passes). Your server profile and plans are untouched.</p>
      <div class="modal-actions"><button class="button button-outline" data-action="close-modal">Cancel</button><button class="button button-danger" data-action="confirm-reset">Reset local</button></div>`);
  }
  function confirmReset() {
    const profile = state.profile;
    state = { ...initialState(), profile };
    save();
    closeModal();
    renderProfile();
    renderFeed();
    go("discover");
    toast("Local preferences reset.");
  }

  // ---------- Auth error mapping ----------

  function authErrorMessage(error) {
    const messages = {
      "auth/popup-closed-by-user": "Sign-in was cancelled. Try again when you're ready.",
      "auth/popup-blocked": "Your browser blocked the sign-in popup. Allow popups and try again.",
      "auth/cancelled-popup-request": "Sign-in was interrupted. Try again.",
      "auth/network-request-failed": "Network error. Check your internet connection.",
      "auth/unauthorized-domain": "This website domain is not authorised in Firebase.",
      "auth/operation-not-allowed": "Google sign-in is not enabled in Firebase.",
      "auth/account-exists-with-different-credential": "An account already exists with a different sign-in method.",
      "auth/internal-error": "Something went wrong. Please try again."
    };
    return messages[error?.code] || error?.message || "Sign-in failed. Please try again.";
  }

  // ---------- Sign-in (Google) ----------

  function openSignIn(message = "Sign in to Kikao.") {
    showModal(`
      <div class="modal-kicker">SIGN IN</div>
      <h2>Welcome to Kikao.</h2>
      <p class="modal-sub">${escapeHTML(message)}</p>

      <button class="button button-dark button-wide" id="google-signin-btn" style="display:flex; align-items:center; justify-content:center; gap:10px;">
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
          <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
        </svg>
        Continue with Google
      </button>

      <p class="inline-note" style="text-align:center; margin-top:14px;">
        By continuing you agree to Kikao's community rules.
      </p>
    `);

    $("#google-signin-btn").addEventListener("click", async () => {
      const btn = $("#google-signin-btn");
      btn.disabled = true;
      const original = btn.innerHTML;
      btn.textContent = "Connecting…";

      try {
        const user = await signInWithGoogle();
        const remote = await getUserProfile(user.uid);

        if (remote) {
          state.profile = remote;
          save();
          closeModal();
          renderProfile();
          renderFeed();
          subscribeUserData();

          if (!hasAcceptedCurrentTerms(remote)) {
            const accepted = await ensureTermsAccepted();
            if (!accepted) {
              await signOutUser();
              state = initialState();
              save();
              renderProfile();
              renderFeed();
              openSignIn("Accept the terms to use Kikao.");
              return;
            }
          }

          toast(`Welcome back, ${remote.name.split(/\s+/)[0]}.`);
          go("discover");
        } else {
          closeModal();
          toast("Signed in. Finish creating your profile.");
          openCompleteProfile();
        }
      } catch (error) {
        console.error("Google sign-in failed:", error);
        toast(authErrorMessage(error));
        btn.disabled = false;
        btn.innerHTML = original;
      }
    });
  }

  // ---------- Complete profile (new Google user) ----------

  function openCompleteProfile() {
    showModal(`
      <div class="modal-kicker">WELCOME TO KIKAO</div>
      <h2>Complete your profile.</h2>
      <p class="modal-sub">Just a few details to get you started.</p>
      <form id="complete-profile-form">
        <label class="field"><span>Your name</span>
          <input name="name" maxlength="40" placeholder="e.g. Alex M." required></label>
        <label class="field"><span>Age</span>
          <input name="age" type="number" min="${MIN_AGE}" max="100" placeholder="${MIN_AGE} or above" required></label>
        <label class="field"><span>Gender (optional, self-declared)</span>
          <select name="gender">
            <option value="prefer_not_to_say">Prefer not to say</option>
            <option value="woman">Woman</option>
            <option value="man">Man</option>
            <option value="nonbinary">Non-binary</option>
          </select>
          <small class="field-help">Required if you want to join women-only plans.</small></label>
        <label class="check-row"><input type="checkbox" name="consent" required>
          <span>I agree to the community rules.</span></label>
        <p id="complete-error" class="inline-note" role="alert"></p>
        <button class="button button-dark button-wide" type="submit">Create my profile →</button>
      </form>
    `);

    $("#complete-profile-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const button = form.querySelector('button[type="submit"]');
      const data = new FormData(form);
      const age = Number(data.get("age"));
      if (age < MIN_AGE) { toast(`You must be ${MIN_AGE}+.`); return; }

      const user = auth.currentUser;
      if (!user) throw new Error("You must be signed in.");

      const draft = {
        uid: user.uid,
        name: String(data.get("name")).trim(),
        age,
        gender: String(data.get("gender") || "prefer_not_to_say")
      };

      openTermsModal(async () => {
        button.disabled = true;
        button.textContent = "Saving…";

        try {
          const saved = await saveUserProfile({ ...draft, termsVersion: TERMS_VERSION });
          state.profile = saved;
          save();
          closeModal();
          renderProfile();
          renderFeed();
          subscribeUserData();
          toast("Profile created. Welcome to Kikao.");
          go("discover");
        } catch (error) {
          console.error("Profile save failed:", error);
          $("#complete-error").textContent = error.message || "Could not save profile.";
          button.disabled = false;
          button.textContent = "Create my profile →";
        }
      });
    });
  }

  // ---------- Linked accounts ----------

  async function linkAccounts() {
    if (!state.profile) { openSignIn(); return; }

    const fb = state.profile.facebook;
    const ig = state.profile.instagram;

    showModal(`
      <div class="modal-kicker">LINKED ACCOUNTS</div>
      <h2>Connect your socials.</h2>
      <p class="modal-sub">Linked accounts help people trust that you're a real person.</p>

      <div class="link-row">
        <div>
          <b>Facebook</b>
          <small>${fb?.linked ? `Linked as ${escapeHTML(fb.name || fb.id || "Facebook user")}` : "Not linked"}</small>
        </div>
        ${fb?.linked
          ? '<span class="status-chip">LINKED</span>'
          : '<button class="button button-outline button-small" id="link-fb">Link</button>'}
      </div>

      <div class="link-row">
        <div>
          <b>Instagram</b>
          <small>${ig?.handle ? `@${escapeHTML(ig.handle)} · unverified` : "Not linked"}</small>
        </div>
        ${ig?.handle ? '<span class="status-chip">UNVERIFIED</span>' : ''}
      </div>

      <form id="ig-form">
        <label class="field"><span>Instagram handle</span>
          <input name="handle" maxlength="30" placeholder="yourhandle" value="${escapeHTML(ig?.handle || "")}"></label>
        <small class="field-help">Instagram has no official login for third-party apps. Your handle is shown as unverified.</small>
        <button class="button button-dark button-wide" type="submit">Save Instagram handle</button>
      </form>
    `);

    const fbBtn = $("#link-fb");
    if (fbBtn) {
      fbBtn.addEventListener("click", async () => {
        fbBtn.disabled = true;
        fbBtn.textContent = "Opening…";
        try {
          const facebook = await linkFacebookAccount();
          const updated = await saveUserProfile({ ...state.profile, facebook });
          state.profile = updated;
          save();
          closeModal();
          toast("Facebook linked.");
        } catch (err) {
          toast(err.message || "Facebook linking failed.");
          fbBtn.disabled = false;
          fbBtn.textContent = "Link";
        }
      });
    }

    $("#ig-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const handle = String(f.get("handle") || "").trim().replace(/^@/, "");
      if (!handle) { toast("Enter your Instagram handle."); return; }
      try {
        const instagram = { handle, verified: false, linkedAt: Date.now() };
        const updated = await saveUserProfile({ ...state.profile, instagram });
        state.profile = updated;
        save();
        closeModal();
        toast("Instagram handle saved (unverified).");
      } catch (err) {
        toast(err.message);
      }
    });
  }

  // ---------- Create plan ----------

  async function submitPlan(form) {
    if (!state.profile?.verified) { openSignIn("Sign in to publish a plan."); return; }
    const f = new FormData(form);
    const type = String(f.get("type"));
    if (type === "roadtrip" && !f.get("designatedDriver")) {
      toast("Road trips require a confirmed alcohol-free designated driver.");
      return;
    }
    const spots = Number(f.get("spots"));
    const budget = Number(f.get("budget"));
    if (!Number.isFinite(spots) || spots < 2 || spots > 20 || !Number.isFinite(budget) || budget < 100) {
      toast("Check the spots and budget fields.");
      return;
    }

    const button = $("#create-submit");
    button.disabled = true;
    button.textContent = "Publishing…";

    try {
      await createPlanInFirestore({
        host: state.profile.name,
        title: String(f.get("title")).trim(),
        type,
        area: String(f.get("area")),
        date: String(f.get("date")),
        time: String(f.get("time")),
        budget,
        spots,
        drinks: type === "roadtrip" ? "Non-alcoholic" : String(f.get("drinks") || "Alcohol optional"),
        vibe: String(f.get("vibe") || "Meet new people"),
        rules: String(f.get("rules") || "Respect the group and venue."),
        destination: String(f.get("destination") || ""),
        transport: String(f.get("transport") || ""),
        transportCost: Number(f.get("transportCost") || 0),
        pickup: String(f.get("pickup") || ""),
        designatedDriver: Boolean(f.get("designatedDriver")),
        womenOnly: Boolean(f.get("womenOnly")),
        venue: String(f.get("venue") || "").trim()
      });
      form.reset();
      $("#create-date").min = dateISO(today);
      $("#create-type").dispatchEvent(new Event("change"));
      go("activity");
      renderActivity("hosting");
      toast("Your plan is live.");
    } catch (err) {
      toast(err.message || "Could not publish plan.");
    } finally {
      button.disabled = false;
      button.textContent = "Publish my plan →";
    }
  }

  // ---------- Plan templates ----------

  function applyPlanTemplate(templateKey) {
    const template = PLAN_TEMPLATES[templateKey];
    if (!template) return;

    const form = $("#create-form");
    if (!form) return;

    form.elements.title.value = template.title;
    form.elements.type.value = template.type;
    form.elements.area.value = template.area;
    form.elements.budget.value = template.budget;
    form.elements.spots.value = template.spots;
    form.elements.drinks.value = template.drinks;
    form.elements.vibe.value = template.vibe;
    form.elements.rules.value = template.rules;
    form.elements.venue.value = template.venueHint;

    if (template.type === "roadtrip") {
      form.elements.destination.value = template.destination || "";
      form.elements.transport.value = template.transport || "Host has a car";
      form.elements.transportCost.value = template.transportCost || "";
      form.elements.pickup.value = template.pickup || "";
      form.elements.designatedDriver.checked = Boolean(template.designatedDriver);
    }

    // Reveal the road-trip fields if the template changed the type
    $("#create-type").dispatchEvent(new Event("change"));

    // Highlight the active template card
    $$("#template-row .template-card").forEach((card) => {
      card.classList.toggle("active", card.dataset.template === templateKey);
    });

    // Focus the venue field so the user knows where to continue
    form.elements.venue.focus();

    toast("Template applied — adjust the details and publish.");
  }

  // ---------- Firestore subscriptions ----------

  function subscribePlans() {
    if (unsubscribePlans) unsubscribePlans();
    unsubscribePlans = subscribeToPlans(
      (plans) => {
        state.plans = [...seedPlans(), ...plans];
        renderFeed();
        renderActivity();
      },
      (err) => toast("Plans failed to load: " + err.message)
    );
  }

  function subscribeUserData() {
    if (!state.profile?.uid) return;
    if (unsubscribeMyRequests) unsubscribeMyRequests();
    if (unsubscribeHostedRequests) unsubscribeHostedRequests();

    unsubscribeMyRequests = subscribeToMyRequests(
      state.profile.uid,
      (reqs) => { state.requests = reqs; renderActivity(); renderFeed(); },
      (err) => toast("Your requests failed to load.")
    );
    unsubscribeHostedRequests = subscribeToHostedRequests(
      state.profile.uid,
      (reqs) => { state.hostedRequests = reqs; renderActivity(); },
      (err) => toast("Incoming requests failed to load.")
    );
  }

  // ---------- Global click handling ----------

  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-action]");
    if (!b) return;
    const a = b.dataset.action;
    const id = b.dataset.id;

    if (a === "go") go(b.dataset.view);
    else if (a === "close-modal") closeModal();
    else if (a === "enable-location") {
      const coords = await requestViewerCoords();
      if (coords) {
        toast("Location enabled.");
        renderLocationBanner();
        updateDistanceFilterVisibility();
        renderFeed();
      } else if (locationState === "denied") {
        toast("Location permission denied. Enable it in your browser settings.");
        renderLocationBanner();
        updateDistanceFilterVisibility();
      } else {
        toast("Could not get your location. Try again.");
      }
    }
    else if (a === "open-rating") {
      await openRatingModal(id);
    }
    else if (a === "swipe-like") {
      const card = $(`.swipe-card[data-id="${id}"]`);
      if (card) commitSwipe(id, "right", card);
      else beginJoin(id);
    }
    else if (a === "swipe-pass") {
      const card = $(`.swipe-card[data-id="${id}"]`);
      if (card) commitSwipe(id, "left", card);
    }
    else if (a === "swipe-info") {
      const p = planById(id);
      if (!p) return;
      const rating = state.hostRatings?.[p.hostId];
      const ratingLine = (rating && rating.count >= 5)
        ? `<div class="lobby-info-row"><span>Host rating</span><b>${renderStars(rating.average, 12)} ${rating.average.toFixed(1)} (${rating.count})</b></div>`
        : `<div class="lobby-info-row"><span>Host rating</span><b>New host</b></div>`;
      const liveLine = isLiveNow(p)
        ? `<div class="lobby-info-row"><span>Plan type</span><b>● Live now · ${escapeHTML(liveCountdown(p))}</b></div>`
        : "";
      showModal(`
        <div class="modal-kicker">PLAN DETAILS</div>
        <h2>${escapeHTML(p.title)}</h2>
        <p class="modal-sub">${escapeHTML(p.area)} · ${escapeHTML(fmtDate(p.date))} · ${escapeHTML(p.time)} · ${escapeHTML(formatDistance(p))}</p>
        ${p.womenOnly ? '<div class="demo-warning">Women-only plan.</div>' : ""}
        ${liveLine}
        <div class="lobby-info-row"><span>Host</span><b>${escapeHTML(p.host)}</b></div>
        ${ratingLine}
        <div class="lobby-info-row"><span>Venue</span><b>${escapeHTML(p.venue || "—")}</b></div>
        <div class="lobby-info-row"><span>Budget</span><b>${money(p.budget)}</b></div>
        <div class="lobby-info-row"><span>Spots</span><b>${Math.max(0, p.spots - (p.joined || 0))} / ${escapeHTML(p.spots)}</b></div>
        <div class="lobby-info-row"><span>Vibe</span><b>${escapeHTML(p.vibe || "—")}</b></div>
        <p>${escapeHTML(p.rules || "")}</p>
        <button class="button button-outline button-wide" data-action="close-modal">Close</button>
      `);
    }
    else if (a === "open-lobby") { openLobby(id); go("lobby"); }
    else if (a === "activity-tab") renderActivity(b.dataset.tab);
    else if (a === "host-approve") hostDecision(id, true);
    else if (a === "host-decline") hostDecision(id, false);
    else if (a === "check-in") checkIn(id);
    else if (a === "share-plan") sharePlan(id);
    else if (a === "sos") sos();
    else if (a === "report") reportConcern(id);
    else if (a === "trusted-contact") trustedContact();
    else if (a === "edit-profile") editProfile();
    else if (a === "link-accounts") linkAccounts();
    else if (a === "reset-demo") resetDemo();
    else if (a === "confirm-reset") confirmReset();
    else if (a === "leave-plan") {
      if (!confirm("Leave this plan? Your spot will open up for someone else.")) return;
      try {
        teardownPresence();
        await leavePlan(id);
        toast("You left the plan. Your spot is open again.");
        if (activeChatPlanId === id) {
          if (unsubscribeChat) { unsubscribeChat(); unsubscribeChat = null; }
          if (unsubscribeMembers) { unsubscribeMembers(); unsubscribeMembers = null; }
          activeChatPlanId = null;
          go("activity");
        }
      } catch (err) {
        toast(err.message);
      }
    }
    else if (a === "delete-plan") {
      if (!confirm("Delete this plan? Members will lose access to the lobby and chat. This cannot be undone.")) return;
      try {
        teardownPresence();
        await deletePlan(id);
        toast("Plan deleted.");
        if (activeChatPlanId === id) {
          if (unsubscribeChat) { unsubscribeChat(); unsubscribeChat = null; }
          if (unsubscribeMembers) { unsubscribeMembers(); unsubscribeMembers = null; }
          activeChatPlanId = null;
          window.activeLobbyId = null;
          go("activity");
        }
      } catch (err) {
        toast(err.message);
      }
    }
    else if (a === "sign-out") {
      try {
        teardownPresence();
        teardownCountdown();
        if (unsubscribeChat) { unsubscribeChat(); unsubscribeChat = null; }
        if (unsubscribeMembers) { unsubscribeMembers(); unsubscribeMembers = null; }
        if (unsubscribePlans) { unsubscribePlans(); unsubscribePlans = null; }
        if (unsubscribeMyRequests) { unsubscribeMyRequests(); unsubscribeMyRequests = null; }
        if (unsubscribeHostedRequests) { unsubscribeHostedRequests(); unsubscribeHostedRequests = null; }
        activeChatPlanId = null;

        await signOutUser();
        state = initialState();
        save();
        renderProfile();
        renderFeed();
        openSignIn("You've been signed out. Sign in to continue.");
      } catch (err) { toast(err.message); }
    }
    else if (a === "clear-filters") {
      $("#search-input").value = "";
      $("#type-filter").value = "all";
      $("#budget-filter").value = "all";
      $("#distance-filter").value = "all";
      $("#gender-filter").value = "all";
      state.passed = [];
      save();
      renderFeed();
    }
  });

  // ---------- Form wiring ----------

  $("#create-form").addEventListener("submit", (e) => { e.preventDefault(); submitPlan(e.currentTarget); });
  ["search-input","type-filter","budget-filter","distance-filter","gender-filter"].forEach((id) =>
    $("#" + id).addEventListener("input", renderFeed)
  );
  $("#create-type").addEventListener("change", (e) => {
    const isRoad = e.target.value === "roadtrip";
    $("#roadtrip-fields").classList.toggle("hidden", !isRoad);
    $("#drink-field").classList.toggle("hidden", isRoad);
    $("#designated-driver").required = isRoad;
  });

  // Plan templates — dedicated listener separate from the global dispatcher
  // so it reads/writes the form directly and doesn't collide with data-action.
  const templateRow = $("#template-row");
  if (templateRow) {
    templateRow.addEventListener("click", (e) => {
      const card = e.target.closest(".template-card");
      if (!card) return;
      const key = card.dataset.template;
      if (key) applyPlanTemplate(key);
    });
  }

  $("#modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "modal-backdrop") closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

  $("#create-date").min = dateISO(today);
  $("#create-date").value = dateISO(nextSaturday());

  // ---------- Startup ----------

  renderProfile();
  renderFeed();
  subscribePlans();

  checkLocationState().then(() => {
    renderLocationBanner();
    updateDistanceFilterVisibility();

    if (locationState === "granted") {
      requestViewerCoords().then(() => {
        updateDistanceFilterVisibility();
        renderFeed();
      });
    } else {
      renderFeed();
    }
  });

  observeAuthState(async (user) => {
    if (user) {
      try {
        const remote = await getUserProfile(user.uid);
        if (remote) {
          state.profile = remote;
          save();
          renderProfile();
          renderFeed();

          if (!hasAcceptedCurrentTerms(remote)) {
            const accepted = await ensureTermsAccepted();
            if (!accepted) {
              await signOutUser();
              state = initialState();
              save();
              renderProfile();
              renderFeed();
              openSignIn("Accept the terms to use Kikao.");
              return;
            }
          }

          subscribeUserData();
        } else {
          state.profile = null;
          save();
          renderProfile();
          renderFeed();
          openCompleteProfile();
        }
      } catch (error) {
        console.error("Profile restoration failed:", error);
        toast("Unable to load your profile.");
      }
    } else {
      state.profile = null;
      save();
      renderProfile();
      renderFeed();
      openSignIn("Sign in to start planning.");
    }
  });

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch((error) => {
        console.error("Service worker registration failed:", error);
      });
    });
  }
})();