import { auth, db } from "./firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
  orderBy,
  startAt,
  endAt,
  setDoc,
  Timestamp
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
import { GeoPoint } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

// --- Inline geofire replacements (no CDN dependency) ---
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

function geohashForLocation([lat, lng], precision = 9) {
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  let hash = "", bits = 0, bit = 0, even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) { bits = (bits << 1) | 1; lngMin = mid; } else { bits = bits << 1; lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { bits = (bits << 1) | 1; latMin = mid; } else { bits = bits << 1; latMax = mid; }
    }
    even = !even;
    if (++bit === 5) { hash += BASE32[bits]; bits = 0; bit = 0; }
  }
  return hash;
}

export function distanceBetween([lat1, lng1], [lat2, lng2]) {
  const R = 6371e3;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * R) / 1000;
}

function geohashQueryBounds(center, radiusInM) {
  const lat = center[0], lng = center[1];
  const latDelta = radiusInM / 111320;
  const lngDelta = radiusInM / (111320 * Math.cos((lat * Math.PI) / 180));
  const precision = 6;
  const sw = geohashForLocation([lat - latDelta, lng - lngDelta], precision);
  const ne = geohashForLocation([lat + latDelta, lng + lngDelta], precision);
  return [[sw, ne]];
}

export const NAIROBI_AREAS = {
  "Westlands":     { lat: -1.2670, lng: 36.8080 },
  "Kilimani":      { lat: -1.2920, lng: 36.7830 },
  "CBD":           { lat: -1.2833, lng: 36.8167 },
  "Lavington":     { lat: -1.2770, lng: 36.7720 },
  "Ngong Road":    { lat: -1.2970, lng: 36.7700 },
  "Karen":         { lat: -1.3210, lng: 36.7100 },
  "Ruaka":         { lat: -1.2130, lng: 36.7830 },
  "Gigiri":        { lat: -1.2290, lng: 36.8040 },
  "Other Nairobi": { lat: -1.2864, lng: 36.8172 }
};

const VALID_TYPES = ["party", "roadtrip", "chill"];
const VALID_DRINKS = ["Alcohol optional","Alcohol-focused","Non-alcoholic","Bring your own"];

/**
 * A plan is "spontaneous" if it starts within the next 2 hours.
 * Used by createPlan to set the flag, and by the client (via the returned
 * plan object) to know whether to show the "Live now" badge immediately.
 * The server enforces the same window in firestore.rules.
 */
function computeSpontaneous(dateStr, timeStr) {
  try {
    const start = new Date(`${dateStr}T${timeStr || "00:00"}:00`).getTime();
    const now = Date.now();
    const twoHours = 2 * 60 * 60 * 1000;
    return start > now && start - now <= twoHours;
  } catch {
    return false;
  }
}

function requireUser() {
  const user = auth.currentUser;
  if (!user) throw new Error("You must be signed in to perform this action.");
  return user;
}

function mapDocument(snapshot) { return { ...snapshot.data(), id: snapshot.id }; }

/**
 * Create a plan. Everything — including the exact venue — lives on the
 * public plan document. No private sub-document, no transaction needed.
 */
export async function createPlan(plan) {
  const user = requireUser();

  if (!plan || typeof plan !== "object") throw new Error("Invalid plan details.");

  const title = String(plan.title || "").trim();
  const area  = String(plan.area || "").trim();
  const venue = String(plan.venue || "").trim();
  const date  = String(plan.date || "").trim();
  const time  = String(plan.time || "").trim();

  if (!title || !area) throw new Error("A plan title and area are required.");
  if (!venue || venue.length > 200) {
    throw new Error("Enter a public venue (1–200 characters).");
  }
  if (!date || !time) {
    throw new Error("A plan date and time are required.");
  }

  // Reject plans in the past before the server rule fires, so the user
  // gets a clear error instead of a silent permission-denied.
  const startMs = new Date(`${date}T${time}:00`).getTime();
  if (Number.isNaN(startMs)) throw new Error("Invalid date or time.");
  if (startMs < Date.now() - 60_000) {
    throw new Error("A plan cannot start in the past.");
  }

  const spots  = Number(plan.spots);
  const budget = Number(plan.budget);
  if (!Number.isInteger(spots) || spots < 2 || spots > 20) {
    throw new Error("Plan capacity must be between 2 and 20 people.");
  }
  if (!Number.isFinite(budget) || budget < 100) {
    throw new Error("The budget must be at least KSh 100.");
  }

  const type   = VALID_TYPES.includes(plan.type) ? plan.type : "chill";
  const drinks = VALID_DRINKS.includes(plan.drinks) ? plan.drinks : "Alcohol optional";

  const centroid = NAIROBI_AREAS[area] || NAIROBI_AREAS["Other Nairobi"];
  const location = new GeoPoint(centroid.lat, centroid.lng);
  const geohash  = geohashForLocation([centroid.lat, centroid.lng]);

  const spontaneous = computeSpontaneous(date, time);

  // TTL: expire at 00:00 UTC on the day AFTER the plan date.
  // `date` is "YYYY-MM-DD". A plan dated 14 Nov expires 15 Nov 00:00 UTC.
  // Date.UTC normalises month/year rollover (e.g. 31 Dec -> 1 Jan).
  const [expY, expM, expD] = date.split("-").map(Number);
  const expireAt = Timestamp.fromDate(
    new Date(Date.UTC(expY, expM - 1, expD + 1, 0, 0, 0))
  );

  const planRef = doc(collection(db, "plans"));

  const publicPlan = {
    hostId: user.uid,
    host: String(plan.host || "").trim(),
    title,
    type,
    area,
    date,
    time,
    budget,
    spots,
    joined: 1,
    hostVerified: true,
    drinks,
    vibe: String(plan.vibe || ""),
    rules: String(plan.rules || ""),
    destination: String(plan.destination || ""),
    transport: String(plan.transport || ""),
    transportCost: Number(plan.transportCost || 0),
    pickup: String(plan.pickup || ""),
    designatedDriver: Boolean(plan.designatedDriver),
    womenOnly: Boolean(plan.womenOnly),
    venue,
    location,
    geohash,
    spontaneous,
    status: "open",
    expireAt,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  await setDoc(planRef, publicPlan);
  return { id: planRef.id, ...publicPlan };
}

export function subscribeToPlans(onData, onError) {
  return onSnapshot(
    collection(db, "plans"),
    (snapshot) => onData(snapshot.docs.map(mapDocument)),
    (error) => {
      console.error("Plans subscription failed:", error);
      onError?.(error);
    }
  );
}

export function subscribeToMyRequests(uid, onData, onError) {
  const user = requireUser();
  if (uid !== user.uid) throw new Error("You can only subscribe to your own join requests.");
  const q = query(collection(db, "joinRequests"), where("requesterId", "==", user.uid));
  return onSnapshot(
    q,
    (snapshot) => onData(snapshot.docs.map(mapDocument)),
    (error) => {
      console.error("Join-request subscription failed:", error);
      onError?.(error);
    }
  );
}

export function subscribeToHostedRequests(uid, onData, onError) {
  const user = requireUser();
  if (uid !== user.uid) throw new Error("You can only subscribe to requests for your own plans.");
  const q = query(collection(db, "joinRequests"), where("hostId", "==", user.uid));
  return onSnapshot(
    q,
    (snapshot) => onData(snapshot.docs.map(mapDocument)),
    (error) => {
      console.error("Hosted join-request subscription failed:", error);
      onError?.(error);
    }
  );
}

export async function requestToJoin(planId, requesterName, requesterProfile) {
  const user = requireUser();
  const name = String(requesterName || "").trim();

  if (!planId) throw new Error("The selected plan is invalid.");
  if (String(planId).startsWith("seed-")) {
    throw new Error("Demo plans cannot be joined. Try a real plan.");
  }
  if (!name || name.length > 40) {
    throw new Error("Your name must contain between 1 and 40 characters.");
  }

  const planRef = doc(db, "plans", planId);
  const requestRef = doc(db, "joinRequests", `${planId}_${user.uid}`);

  // Pre-read the request WITHOUT rules-side errors on a missing doc.
  // Firestore rules can't evaluate `resource.data.requesterId` on a
  // nonexistent doc, so a denied get here means "no request exists".
  let existing = null;
  try {
    const existingSnap = await getDoc(requestRef);
    if (existingSnap.exists()) existing = existingSnap.data();
  } catch (err) {
    if (err?.code !== "permission-denied") throw err;
  }

  if (existing) {
    if (["pending", "approved", "waitlisted"].includes(existing.status)) {
      throw new Error("You already have an active request for this plan.");
    }
    if (!["declined", "cancelled"].includes(existing.status)) {
      throw new Error("This join request cannot be reopened.");
    }
  }

  return runTransaction(db, async (transaction) => {
    const planSnapshot = await transaction.get(planRef);
    if (!planSnapshot.exists()) throw new Error("This plan no longer exists.");
    const plan = planSnapshot.data();

    if (plan.hostId === user.uid) throw new Error("You cannot request to join your own plan.");
    if (!["open", "locked"].includes(plan.status)) {
      throw new Error("This plan is not accepting join requests.");
    }
    if (plan.womenOnly && requesterProfile?.gender !== "woman") {
      throw new Error("This plan is women-only. Update your profile to continue.");
    }

    // Spontaneous plans are only joinable until they start. After that,
    // the plan is considered done even if it's still "open" on the doc.
    if (plan.spontaneous) {
      const startMs = new Date(`${plan.date}T${plan.time || "00:00"}:00`).getTime();
      if (Number.isFinite(startMs) && Date.now() >= startMs) {
        throw new Error("This spontaneous plan has already started.");
      }
    }

    const joined = Number(plan.joined || 0);
    const spots = Number(plan.spots);
    if (!Number.isInteger(spots) || spots < 1 || joined < 0) {
      throw new Error("This plan has invalid capacity information.");
    }

    const status = joined >= spots ? "waitlisted" : "pending";
    const requestData = {
      planId,
      hostId: plan.hostId,
      requesterId: user.uid,
      requesterName: name,
      requesterGender: requesterProfile?.gender || "prefer_not_to_say",
      requesterInstagram: requesterProfile?.instagram || null,
      status,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    transaction.set(requestRef, requestData);
    return { id: requestRef.id, ...requestData };
  });
}

export async function decideJoinRequest(requestId, approve) {
  const user = requireUser();
  if (!requestId || typeof approve !== "boolean") throw new Error("Invalid join-request decision.");
  if (String(requestId).startsWith("seed-")) throw new Error("Demo requests cannot be decided.");

  const requestRef = doc(db, "joinRequests", requestId);
  const memberRef  = doc(db, "planMembers", requestId); // requestId is "{planId}_{uid}"

  // Pre-read membership outside the transaction — same rules limitation as before.
  // A permission-denied here means the doc doesn't exist, which is the normal case.
  let alreadyMember = false;
  try {
    const memberSnap = await getDoc(memberRef);
    alreadyMember = memberSnap.exists();
  } catch (err) {
    if (err?.code !== "permission-denied") throw err;
  }

  if (alreadyMember && approve) {
    // Already a member — silently treat as success on the client (the host may
    // have tapped twice, or the request state is stale).
    return { id: requestId, status: "approved" };
  }

  return runTransaction(db, async (transaction) => {
    const requestSnapshot = await transaction.get(requestRef);
    if (!requestSnapshot.exists()) throw new Error("This join request no longer exists.");
    const request = requestSnapshot.data();

    if (request.hostId !== user.uid) throw new Error("Only the plan host can decide this request.");
    if (!["pending","waitlisted"].includes(request.status)) {
      throw new Error("This request has already been processed.");
    }

    const planRef = doc(db, "plans", request.planId);
    const planSnapshot = await transaction.get(planRef);
    if (!planSnapshot.exists()) throw new Error("The associated plan no longer exists.");
    const plan = planSnapshot.data();
    if (plan.hostId !== user.uid || plan.status === "cancelled") {
      throw new Error("You cannot manage requests for this plan.");
    }

    if (!approve) {
      transaction.update(requestRef, { status: "declined", updatedAt: serverTimestamp() });
      return { id: requestId, status: "declined" };
    }

    const joined = Number(plan.joined || 0);
    const spots  = Number(plan.spots);
    if (joined >= spots) throw new Error("The plan is full. This request cannot be approved yet.");

    const nextJoined = joined + 1;

    // Create the member doc by its deterministic ID — no read needed.
    transaction.set(memberRef, {
      planId: request.planId,
      uid: request.requesterId,
      name: request.requesterName,
      role: "member",
      instagram: request.requesterInstagram || null,
      joinedAt: serverTimestamp()
    });
    transaction.update(requestRef, { status: "approved", updatedAt: serverTimestamp() });
    transaction.update(planRef, {
      joined: nextJoined,
      status: nextJoined >= spots ? "locked" : "open",
      updatedAt: serverTimestamp()
    });

    return { id: requestId, planId: request.planId, requesterId: request.requesterId, status: "approved" };
  });
}

/**
 * A member leaves a confirmed plan. In one transaction:
 * - delete their planMembers doc
 * - decrement plans.joined and un-lock the plan
 * - mark their joinRequest as "cancelled" so they can request again later
 */
export async function leavePlan(planId) {
  const user = requireUser();
  if (!planId) throw new Error("Plan ID required.");
  if (String(planId).startsWith("seed-")) throw new Error("Demo plans cannot be left.");

  const planRef = doc(db, "plans", planId);
  const memberRef = doc(db, "planMembers", `${planId}_${user.uid}`);
  const requestRef = doc(db, "joinRequests", `${planId}_${user.uid}`);

  // Pre-read the request outside the transaction — same rules-side
  // limitation as requestToJoin. A denied get means "no request exists".
  let requestExists = false;
  try {
    const snap = await getDoc(requestRef);
    requestExists = snap.exists();
  } catch (err) {
    if (err?.code !== "permission-denied") throw err;
  }

  return runTransaction(db, async (transaction) => {
    const memberSnap = await transaction.get(memberRef);
    if (!memberSnap.exists()) throw new Error("You are not a member of this plan.");

    const planSnap = await transaction.get(planRef);
    if (!planSnap.exists()) throw new Error("This plan no longer exists.");
    const plan = planSnap.data();

    if (plan.hostId === user.uid) throw new Error("The host cannot leave their own plan.");

    const nextJoined = Math.max(1, Number(plan.joined || 2) - 1);

    transaction.delete(memberRef);
    transaction.update(planRef, {
      joined: nextJoined,
      status: "open",
      updatedAt: serverTimestamp()
    });

    if (requestExists) {
      transaction.update(requestRef, {
        status: "cancelled",
        updatedAt: serverTimestamp()
      });
    }

    return { planId, joined: nextJoined };
  });
}

export async function getNearbyPlans(lat, lng, radiusKm = 10) {
  const center = [lat, lng];
  const radiusInM = radiusKm * 1000;
  const bounds = geohashQueryBounds(center, radiusInM);

  const snapshots = await Promise.all(
    bounds.map((b) => {
      const q = query(
        collection(db, "plans"),
        orderBy("geohash"),
        startAt(b[0]),
        endAt(b[1])
      );
      return getDocs(q);
    })
  );

  const seen = new Set();
  const hits = [];
  for (const snap of snapshots) {
    for (const d of snap.docs) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const data = d.data();
      if (!data.location) continue;
      const km = distanceBetween([data.location.latitude, data.location.longitude], center);
      if (km <= radiusKm) hits.push({ ...data, id: d.id, distanceKm: km });
    }
  }
  return hits.sort((a, b) => a.distanceKm - b.distanceKm);
}

export function subscribeToMessages(planId, onData, onError) {
  requireUser();
  const q = query(
    collection(db, "planChats", planId, "messages"),
    orderBy("createdAt", "asc")
  );
  return onSnapshot(
    q,
    (snapshot) => onData(snapshot.docs.map(mapDocument)),
    (error) => {
      console.error("Chat subscription failed:", error);
      onError?.(error);
    }
  );
}

export async function sendPlanMessage(planId, text) {
  const user = requireUser();
  const clean = String(text || "").trim().slice(0, 500);
  if (!clean) throw new Error("Message cannot be empty.");
  if (String(planId).startsWith("seed-")) throw new Error("Demo plans have no lobby.");

  const planSnap = await getDoc(doc(db, "plans", planId));
  if (!planSnap.exists()) throw new Error("This plan no longer exists.");

  const isHost = planSnap.data().hostId === user.uid;

  if (!isHost) {
    // Only check planMembers when NOT the host — the host path skips
    // this read, which would otherwise 403 on a missing member doc.
    let memberExists = false;
    try {
      const memberSnap = await getDoc(doc(db, "planMembers", `${planId}_${user.uid}`));
      memberExists = memberSnap.exists();
    } catch (err) {
      if (err?.code !== "permission-denied") throw err;
    }
    if (!memberExists) {
      throw new Error("Only the host and approved members can use the lobby.");
    }
  }

  const userSnap = await getDoc(doc(db, "users", user.uid));
  const name = userSnap.exists() ? userSnap.data().name : "Guest";

  const msgRef = doc(collection(db, "planChats", planId, "messages"));
  await setDoc(msgRef, {
    uid: user.uid,
    name,
    text: clean,
    createdAt: serverTimestamp()
  });

  return { id: msgRef.id };
}

export function startPresenceSharing(planId, memberName, onError) {
  const user = requireUser();
  if (!planId) throw new Error("Plan ID required.");
  if (!("geolocation" in navigator)) {
    onError?.("Geolocation not supported on this device.");
    return null;
  }

  const presenceRef = doc(db, "planPresence", planId, "members", user.uid);

  const watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      try {
        await setDoc(presenceRef, {
          uid: user.uid,
          name: memberName || "Member",
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: Number(pos.coords.accuracy || 0),
          sharing: true,
          lastUpdated: serverTimestamp()
        }, { merge: true });
      } catch (err) {
        console.error("Presence write failed:", err);
        onError?.(err.message);
      }
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        onError?.("Location permission denied.");
      } else {
        onError?.(err.message);
      }
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
  );

  return watchId;
}

export async function stopPresenceSharing(planId) {
  const user = auth.currentUser;
  if (!user || !planId) return;
  const presenceRef = doc(db, "planPresence", planId, "members", user.uid);
  try {
    const { deleteDoc } = await import("https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js");
    await deleteDoc(presenceRef);
  } catch (err) {
    if (err?.code !== "permission-denied" && err?.code !== "not-found") {
      console.warn("stopPresenceSharing:", err.message);
    }
  }
}

export async function setPresenceSharingFlag(planId, sharing) {
  const user = requireUser();
  const presenceRef = doc(db, "planPresence", planId, "members", user.uid);
  await setDoc(presenceRef, {
    sharing: Boolean(sharing),
    lastUpdated: serverTimestamp()
  }, { merge: true });
}

export function subscribeToPresence(planId, onData, onError) {
  requireUser();
  const q = collection(db, "planPresence", planId, "members");
  return onSnapshot(
    q,
    (snap) => onData(snap.docs.map((d) => d.data())),
    (err) => {
      console.error("Presence subscription failed:", err);
      onError?.(err);
    }
  );
}

export async function submitRating(planId, hostUid, stars, comment = "") {
  const user = requireUser();
  if (!planId) throw new Error("Plan ID required.");
  if (!hostUid) throw new Error("Host ID required.");
  if (String(planId).startsWith("seed-")) throw new Error("Demo plans cannot be rated.");
  if (hostUid === user.uid) throw new Error("You cannot rate your own plan.");

  const starsNum = Number(stars);
  if (!Number.isInteger(starsNum) || starsNum < 1 || starsNum > 5) {
    throw new Error("Rating must be between 1 and 5 stars.");
  }
  const cleanComment = String(comment || "").trim().slice(0, 500);
  if (starsNum <= 3 && !cleanComment) {
    throw new Error("Please add a comment when rating below 4 stars.");
  }

  const ratingRef = doc(db, "planRatings", `${planId}_${user.uid}`);
  const hostRef = doc(db, "users", hostUid);

  return runTransaction(db, async (transaction) => {
    const planRef = doc(db, "plans", planId);
    const planSnap = await transaction.get(planRef);
    if (!planSnap.exists()) throw new Error("This plan no longer exists.");
    const plan = planSnap.data();
    if (plan.hostId !== hostUid) throw new Error("The host does not match this plan.");

    const planStart = new Date(`${plan.date}T${plan.time || "00:00"}:00`);
    if (Date.now() < planStart.getTime()) {
      throw new Error("You can rate this plan only after it has taken place.");
    }

    const memberRef = doc(db, "planMembers", `${planId}_${user.uid}`);
    const memberSnap = await transaction.get(memberRef);
    if (!memberSnap.exists()) throw new Error("Only approved members can rate this plan.");

    const existingRating = await transaction.get(ratingRef);
    if (existingRating.exists()) throw new Error("You have already rated this plan.");

    const hostSnap = await transaction.get(hostRef);
    if (!hostSnap.exists()) throw new Error("Host profile not found.");
    const host = hostSnap.data();
    const prevAvg = Number(host.hostRating?.average || 0);
    const prevCount = Number(host.hostRating?.count || 0);

    const newCount = prevCount + 1;
    const newAvg = (prevAvg * prevCount + starsNum) / newCount;

    transaction.set(ratingRef, {
      planId,
      raterUid: user.uid,
      hostUid,
      stars: starsNum,
      comment: cleanComment,
      createdAt: serverTimestamp()
    });

    transaction.set(hostRef, {
      hostRating: {
        average: Math.round(newAvg * 100) / 100,
        count: newCount
      }
    }, { merge: true });

    return { average: newAvg, count: newCount };
  });
}

export async function getMyRatingForPlan(planId) {
  const user = requireUser();
  if (!planId) return null;
  const ref = doc(db, "planRatings", `${planId}_${user.uid}`);
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    return snap.data();
  } catch (err) {
    if (err?.code === "permission-denied") return null;
    throw err;
  }
}

export async function getHostRating(hostUid) {
  requireUser();
  if (!hostUid) return null;
  try {
    const snap = await getDoc(doc(db, "users", hostUid));
    if (!snap.exists()) return null;
    const rating = snap.data()?.hostRating;
    if (!rating || !rating.count || rating.count < 5) return null;
    return {
      average: Number(rating.average || 0),
      count: Number(rating.count || 0)
    };
  } catch (err) {
    if (err?.code === "permission-denied") return null;
    throw err;
  }
}

export async function deletePlan(planId) {
  const user = requireUser();
  if (!planId) throw new Error("Plan ID required.");
  if (String(planId).startsWith("seed-")) throw new Error("Demo plans cannot be deleted.");

  const { collection, getDocs, query, where, deleteDoc } =
    await import("https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js");

  const planRef = doc(db, "plans", planId);
  const planSnap = await getDoc(planRef);
  if (!planSnap.exists()) throw new Error("This plan no longer exists.");
  if (planSnap.data().hostId !== user.uid) throw new Error("Only the host can delete this plan.");

  const messages = await getDocs(collection(db, "planChats", planId, "messages"));
  for (const d of messages.docs) await deleteDoc(d.ref);

  const requests = await getDocs(
    query(collection(db, "joinRequests"),
          where("hostId", "==", user.uid),
          where("planId", "==", planId))
  );
  for (const d of requests.docs) await deleteDoc(d.ref);

  try {
    const members = await getDocs(
      query(collection(db, "planMembers"), where("planId", "==", planId))
    );
    for (const d of members.docs) await deleteDoc(d.ref);
  } catch (e) {
    if (e.code !== "permission-denied") throw e;
    console.warn("planMembers cleanup skipped — no provable read:", e.message);
  }

  try {
    const presence = await getDocs(collection(db, "planPresence", planId, "members"));
    for (const d of presence.docs) await deleteDoc(d.ref);
  } catch (e) {
    if (e.code !== "permission-denied") throw e;
    console.warn("planPresence cleanup skipped:", e.message);
  }

  await deleteDoc(planRef);

  return { planId };
}