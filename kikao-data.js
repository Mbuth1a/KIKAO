
import { auth, db } from "./firebase.js";

import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

function requireUser() {
  const user = auth.currentUser;

  if (!user) {
    throw new Error("You must be signed in to perform this action.");
  }

  return user;
}

function mapDocument(snapshot) {
  return {
    ...snapshot.data(),
    id: snapshot.id
  };
}

function subscribeToCollection(collectionName, onData, onError) {
  return onSnapshot(
    collection(db, collectionName),
    snapshot => onData(snapshot.docs.map(mapDocument)),
    error => {
      console.error(`Firestore ${collectionName} subscription failed:`, error);
      onError?.(error);
    }
  );
}

/**
 * Create a public plan and its private venue details atomically.
 * The venue must never be included in the public plan document.
 */
export async function createPlan(plan, privateDetails = {}) {
  const user = requireUser();

  if (!plan || typeof plan !== "object") {
    throw new Error("Invalid plan details.");
  }

  const title = String(plan.title || "").trim();
  const area = String(plan.area || "").trim();
  const venue = String(privateDetails.venue || "").trim();

  if (!title || !area) {
    throw new Error("A plan title and area are required.");
  }

  if (!venue) {
    throw new Error("A private venue is required.");
  }

  const spots = Number(plan.spots);
  const budget = Number(plan.budget);

  if (!Number.isInteger(spots) || spots < 2 || spots > 20) {
    throw new Error("Plan capacity must be between 2 and 20 people.");
  }

  if (!Number.isFinite(budget) || budget < 100) {
    throw new Error("The budget must be at least KSh 100.");
  }

  const planRef = doc(collection(db, "plans"));
  const privateRef = doc(db, "planPrivateDetails", planRef.id);

  const publicPlan = {
    hostId: user.uid,
    host: String(plan.host || "").trim(),
    title,
    type: String(plan.type || "social"),
    area,
    date: String(plan.date || ""),
    time: String(plan.time || ""),
    budget,
    spots,
    joined: 1,
    hostVerified: true,
    drinks: Boolean(plan.drinks),
    vibe: String(plan.vibe || ""),
    rules: String(plan.rules || ""),
    destination: String(plan.destination || ""),
    transport: String(plan.transport || ""),
    transportCost: String(plan.transportCost || ""),
    pickup: String(plan.pickup || ""),
    designatedDriver: Boolean(plan.designatedDriver),
    status: "open",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  await runTransaction(db, async transaction => {
    transaction.set(planRef, publicPlan);

    transaction.set(privateRef, {
      hostId: user.uid,
      venue,
      createdAt: serverTimestamp()
    });
  });

  return {
    id: planRef.id,
    ...publicPlan,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

export function subscribeToPlans(onData, onError) {
  return subscribeToCollection("plans", onData, onError);
}

export function subscribeToMyRequests(uid, onData, onError) {
  const user = requireUser();

  if (uid !== user.uid) {
    throw new Error("You can only subscribe to your own join requests.");
  }

  const requestsQuery = query(
    collection(db, "joinRequests"),
    where("requesterId", "==", user.uid)
  );

  return onSnapshot(
    requestsQuery,
    snapshot => onData(snapshot.docs.map(mapDocument)),
    error => {
      console.error("Your join-request subscription failed:", error);
      onError?.(error);
    }
  );
}

export function subscribeToHostedRequests(uid, onData, onError) {
  const user = requireUser();

  if (uid !== user.uid) {
    throw new Error("You can only subscribe to requests for your own plans.");
  }

  const requestsQuery = query(
    collection(db, "joinRequests"),
    where("hostId", "==", user.uid)
  );

  return onSnapshot(
    requestsQuery,
    snapshot => onData(snapshot.docs.map(mapDocument)),
    error => {
      console.error("Hosted join-request subscription failed:", error);
      onError?.(error);
    }
  );
}

/**
 * A join request is free. No deposit or payment is collected.
 * A full plan may accept a waitlisted request.
 */
export async function requestToJoin(planId, requesterName) {
  const user = requireUser();
  const name = String(requesterName || "").trim();

  if (!planId) {
    throw new Error("The selected plan is invalid.");
  }

  if (!name || name.length > 40) {
    throw new Error("Your name must contain between 1 and 40 characters.");
  }

  const planRef = doc(db, "plans", planId);
  const requestRef = doc(db, "joinRequests", `${planId}_${user.uid}`);

  return runTransaction(db, async transaction => {
    const planSnapshot = await transaction.get(planRef);

    if (!planSnapshot.exists()) {
      throw new Error("This plan no longer exists.");
    }

    const plan = planSnapshot.data();

    if (plan.hostId === user.uid) {
      throw new Error("You cannot request to join your own plan.");
    }

    if (!["open", "locked"].includes(plan.status)) {
      throw new Error("This plan is not accepting join requests.");
    }

    const requestSnapshot = await transaction.get(requestRef);

    if (requestSnapshot.exists()) {
      const existing = requestSnapshot.data();

      if (["pending", "approved", "waitlisted"].includes(existing.status)) {
        throw new Error("You already have an active request for this plan.");
      }

      if (existing.status !== "declined") {
        throw new Error("This join request cannot be reopened.");
      }
    }

    const joined = Number(plan.joined || 0);
    const spots = Number(plan.spots);

    if (!Number.isInteger(spots) || spots < 1 || joined < 0) {
      throw new Error("This plan has invalid capacity information.");
    }

    const full = joined >= spots;
    const status = full ? "waitlisted" : "pending";

    const requestData = {
      planId,
      hostId: plan.hostId,
      requesterId: user.uid,
      requesterName: name,
      status,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    transaction.set(requestRef, requestData);

    return {
      id: requestRef.id,
      ...requestData,
      status
    };
  });
}

/**
 * Host-only approval or decline.
 * Approval atomically updates the request, membership and plan capacity.
 */
export async function decideJoinRequest(requestId, approve) {
  const user = requireUser();

  if (!requestId || typeof approve !== "boolean") {
    throw new Error("Invalid join-request decision.");
  }

  const requestRef = doc(db, "joinRequests", requestId);

  return runTransaction(db, async transaction => {
    const requestSnapshot = await transaction.get(requestRef);

    if (!requestSnapshot.exists()) {
      throw new Error("This join request no longer exists.");
    }

    const request = requestSnapshot.data();

    if (request.hostId !== user.uid) {
      throw new Error("Only the plan host can decide this request.");
    }

    if (!["pending", "waitlisted"].includes(request.status)) {
      throw new Error("This request has already been processed.");
    }

    const planRef = doc(db, "plans", request.planId);
    const planSnapshot = await transaction.get(planRef);

    if (!planSnapshot.exists()) {
      throw new Error("The associated plan no longer exists.");
    }

    const plan = planSnapshot.data();

    if (plan.hostId !== user.uid || plan.status === "cancelled") {
      throw new Error("You cannot manage requests for this plan.");
    }

    if (!approve) {
      transaction.update(requestRef, {
        status: "declined",
        updatedAt: serverTimestamp()
      });

      return {
        id: requestId,
        status: "declined"
      };
    }

    const joined = Number(plan.joined || 0);
    const spots = Number(plan.spots);

    if (!Number.isInteger(spots) || joined >= spots) {
      throw new Error("The plan is full. This request cannot be approved yet.");
    }

    const memberRef = doc(
      db,
      "planMembers",
      `${request.planId}_${request.requesterId}`
    );

    const memberSnapshot = await transaction.get(memberRef);

    if (memberSnapshot.exists()) {
      throw new Error("This person is already a member of the plan.");
    }

    const nextJoined = joined + 1;

    transaction.set(memberRef, {
      planId: request.planId,
      uid: request.requesterId,
      name: request.requesterName,
      role: "member",
      joinedAt: serverTimestamp()
    });

    transaction.update(requestRef, {
      status: "approved",
      updatedAt: serverTimestamp()
    });

    transaction.update(planRef, {
      joined: nextJoined,
      status: nextJoined >= spots ? "locked" : "open",
      updatedAt: serverTimestamp()
    });

    return {
      id: requestId,
      planId: request.planId,
      requesterId: request.requesterId,
      status: "approved"
    };
  });
}

/**
 * Private venue details are retrieved separately.
 * Firestore security rules must restrict access to the host and approved members.
 */
export async function getPlanPrivateDetails(planId) {
  requireUser();

  if (!planId) {
    throw new Error("A plan ID is required.");
  }

  const privateRef = doc(db, "planPrivateDetails", planId);
  const snapshot = await getDoc(privateRef);

  if (!snapshot.exists()) {
    throw new Error("Private venue details are unavailable.");
  }

  return snapshot.data();
}
