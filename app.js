import {
  sendPhoneOtp,
  verifyPhoneOtp,
  observeAuthState,
  getCurrentUser,
  signOutUser,
  saveUserProfile,
  getUserProfile
} from "./firebase.js";
import { auth } from "./firebase.js";
import {
  createPlan as createPlanInFirestore,
  subscribeToPlans,
  subscribeToMyRequests,
  subscribeToHostedRequests,
  requestToJoin,
  decideJoinRequest,
  getPlanPrivateDetails
} from "./kikao-data.js";
(() => {
  "use strict";
  const MIN_AGE = 18; // Change to 21 if required by the final legal position.
  const STORAGE_KEY = "kikao-pwa-demo-v1";
  const $ = (s, root=document) => root.querySelector(s);
  const $$ = (s, root=document) => [...root.querySelectorAll(s)];
  const today = new Date();
  const dateISO = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  const addDays = (n) => { const d = new Date(); d.setDate(d.getDate()+n); return d; };
  const nextFriday = () => { const d=new Date(); const delta=(5-d.getDay()+7)%7 || 7; d.setDate(d.getDate()+delta); return d; };
  const nextSaturday = () => { const d=new Date(); const delta=(6-d.getDay()+7)%7 || 7; d.setDate(d.getDate()+delta); return d; };
  const fmtDate = iso => new Date(`${iso}T12:00:00`).toLocaleDateString("en-KE",{weekday:"short",day:"numeric",month:"short"});
  const money = n => `KES ${Number(n||0).toLocaleString("en-KE")}`;
  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const uid = () => "k" + Math.random().toString(36).slice(2,10);

  const seedPlans = () => [
    {id:"seed-party",title:"Rooftop sounds & new faces",type:"party",area:"Westlands",date:dateISO(nextFriday()),time:"19:00",budget:2200,spots:5,joined:2,host:"Amina W.",hostVerified:true,drinks:"Alcohol optional",vibe:"Afrobeats · easy conversations",venue:"A public rooftop venue in Westlands",rules:"Come as you are. Respect boundaries and split your own bill.",destination:"",transportCost:0,createdBy:"seed",status:"open",members:["Amina W.","Kevin M."]},
    {id:"seed-road",title:"Nairobi → Naivasha day escape",type:"roadtrip",area:"Westlands",date:dateISO(nextSaturday()),time:"07:00",budget:3800,spots:4,joined:2,host:"Brian K.",hostVerified:true,drinks:"Non-alcoholic",vibe:"Road views · lakeside lunch",venue:"Pickup point shared after approval",rules:"Driver stays alcohol-free. Return time and costs agreed before departure.",destination:"Naivasha",transportCost:1600,createdBy:"seed",status:"open",members:["Brian K.","Joy N."],designatedDriver:true},
    {id:"seed-chill",title:"Nyama choma & slow Sunday",type:"chill",area:"Kilimani",date:dateISO(addDays(6)),time:"15:00",budget:1500,spots:3,joined:1,host:"Njeri M.",hostVerified:true,drinks:"Alcohol optional",vibe:"Food · music · no pressure",venue:"A public restaurant in Kilimani",rules:"Good energy only. Everyone is welcome.",destination:"",transportCost:0,createdBy:"seed",status:"open",members:["Njeri M."]}
  ];

  const initialState = () => ({
    profile:null,
    plans:seedPlans(),
    requests:[],
    hostedRequests:[],
    payments:[],
    chats:{},
    trustedContact:null,
    blocked:[],
    reports:[],
    lastView:"discover"
  });
  let state;
  try { state = JSON.parse(localStorage.getItem(STORAGE_KEY)) || initialState(); }
  catch { state = initialState(); }
  if (!state.plans || !state.plans.length) state.plans = seedPlans();

  let unsubscribePlans = null;
  let unsubscribeMyRequests = null;
  let unsubscribeHostedRequests = null;

  function save(){
    const localState = {
      ...state,
      plans: seedPlans(),
      requests: [],
      hostedRequests: [],
      payments: []
    };
    localStorage.setItem(STORAGE_KEY,JSON.stringify(localState));
  }
  function toast(message){
    const el=$("#toast"); el.textContent=message; el.classList.add("show");
    clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.remove("show"),2600);
  }
  function initials(name){ return (name||"Guest").trim().split(/\s+/).slice(0,2).map(x=>x[0]||"").join("").toUpperCase() || "?"; }
  function currentUser(){ return state.profile?.name || "You"; }
  function isVerified(){ return !!state.profile?.verified; }
  function planById(id){ return state.plans.find(p=>p.id===id); }
  function myRequest(planId){ return state.requests.find(r=>r.planId===planId); }
  function getMyPlans(){
    const uid = state.profile?.uid;
    return uid ? state.plans.filter(p=>p.hostId===uid) : [];
  }
  function statusLabel(status){
    return ({
      pending:"Awaiting host",
      approved:"Approved · lobby unlocked",
      declined:"Not approved",
      waitlisted:"On waitlist"
    })[status] || status;
  }  function typeLabel(type){ return type==="roadtrip"?"Road trip":type==="party"?"Party / drinks":"Chill / food"; }
  function typeSymbol(type){ return type==="roadtrip"?"↗":type==="party"?"♫":"✳"; }
  function showModal(html){ $("#modal-body").innerHTML=html; $("#modal-backdrop").classList.remove("hidden"); }
  function closeModal(){ $("#modal-backdrop").classList.add("hidden"); $("#modal-body").innerHTML=""; }
  function go(view){
    $$(".view").forEach(v=>v.classList.toggle("active",v.id===`view-${view}`));
    $$(".nav-item").forEach(n=>n.classList.toggle("active",n.dataset.view===view));
    state.lastView=view; save();
    if(view==="activity") renderActivity();
    if(view==="profile") renderProfile();
    if(view==="discover") renderFeed();
    if(view==="lobby") renderLobby(window.activeLobbyId);
    window.scrollTo({top:0,behavior:"smooth"});
  }
  function renderProfile(){
    const p=state.profile;
    $("#avatar-initials").textContent=initials(p?.name);
    $("#profile-avatar").textContent=initials(p?.name);
    $("#profile-name").textContent=p?.name||"Guest";
    $("#profile-phone").textContent=p?.phone||"Complete onboarding to join a plan.";
    $("#verified-label").textContent=p?.verified?"✓ Phone verified":"○ Not verified";
    $("#verification-status").textContent=p?.verified?"PHONE VERIFIED":"PENDING";
  }
  function planCard(p){
    const left=Math.max(0,Number(p.spots)-Number(p.joined||0));
    const req=myRequest(p.id);
    const isDemo=p.createdBy==="seed" || String(p.id).startsWith("seed-");
    const isHost=!!state.profile?.uid && p.hostId===state.profile.uid;

    let action="join";
    let actionText="Request to join";
    let disabled=false;

    if(isDemo){
      action="none";
      actionText="Demo plan · joining disabled";
      disabled=true;
    } else if(isHost){
      action="none";
      actionText="Your plan";
      disabled=true;
    } else if(req?.status==="approved"){
      action="open-lobby";
      actionText="Open lobby";
    } else if(req?.status==="pending"){
      action="none";
      actionText="Request pending";
      disabled=true;
    } else if(req?.status==="waitlisted"){
      action="none";
      actionText="On waitlist";
      disabled=true;
    } else if(req?.status==="declined"){
      action="join";
      actionText="Request again";
    }

    return `<article class="plan-card">
      <div class="plan-cover cover-${escapeHTML(p.type)}"><span class="type-label">${escapeHTML(typeLabel(p.type))}</span><span class="cover-symbol">${typeSymbol(p.type)}</span><h3>${escapeHTML(p.title)}</h3></div>
      <div class="plan-card-body">
        <div class="host-line"><span class="host-avatar">${escapeHTML(initials(p.host))}</span><span>Hosted by <b>${escapeHTML(p.host)}</b></span>${p.hostVerified?'<span class="verified-mini">✓ Verified</span>':''}</div>
        <div class="plan-meta">
          <div class="meta-item"><span class="meta-icon">◷</span>${escapeHTML(fmtDate(p.date))} · ${escapeHTML(p.time)}</div>
          <div class="meta-item"><span class="meta-icon">⌖</span>${escapeHTML(p.area)}</div>
          <div class="meta-item"><span class="meta-icon">♧</span>${escapeHTML(p.drinks||"Social plan")}</div>
          <div class="meta-item"><span class="meta-icon">✦</span>${escapeHTML(p.vibe||"Meet new people")}</div>
        </div>
        ${p.type==="roadtrip"?`<div class="meta-item"><span class="meta-icon">↗</span>Destination: ${escapeHTML(p.destination||"To be confirmed")} · Driver stays alcohol-free</div>`:""}
        <div class="plan-footer"><div class="budget"><strong>${money(p.budget)}</strong><small>estimated per person</small></div><div class="spots"><b>${left}</b> / ${escapeHTML(p.spots)} spots left</div></div>
        <button class="card-action" data-action="${action}" data-id="${escapeHTML(p.id)}" ${disabled?"disabled":""}>${escapeHTML(actionText)} ${!disabled&&action!=="none"?"→":""}</button>
      </div>
    </article>`;
  }
  function renderFeed(){
    const query=($("#search-input")?.value||"").toLowerCase().trim();
    const type=$("#type-filter")?.value||"all";
    const budget=$("#budget-filter")?.value||"all";
    const plans=state.plans.filter(p=>{
      const q=`${p.title} ${p.area} ${p.host} ${p.destination||""}`.toLowerCase();
      return !state.blocked.includes(p.host)&&(!query||q.includes(query))&&(type==="all"||p.type===type)&&(budget==="all"||Number(p.budget)<=Number(budget));
    }).sort((a,b)=>a.date.localeCompare(b.date));
    $("#plan-feed").innerHTML=plans.map(planCard).join("");
    $("#live-count").textContent=plans.length;
    $("#empty-feed").classList.toggle("hidden",plans.length>0);
  }
  function renderActivity(tab="joining"){
    const joining=state.requests;
    const hosting=getMyPlans();
    $("#joining-count").textContent=joining.length;
    $("#hosting-count").textContent=hosting.length;
    $$(".activity-tab").forEach(b=>b.classList.toggle("active",b.dataset.tab===tab));
    $("#joining-panel").classList.toggle("hidden",tab!=="joining");
    $("#hosting-panel").classList.toggle("hidden",tab!=="hosting");
    if(!joining.length){
      $("#joining-panel").innerHTML='<div class="empty-panel"><b>No join requests yet</b>When you request a spot, its approval and deposit status will appear here.<br><br><button class="button button-outline button-small" data-action="go" data-view="discover">Explore plans</button></div>';
    } else {
      $("#joining-panel").innerHTML=joining.map(r=>{
        const p=planById(r.planId); if(!p)return "";
        let buttons="";
        if(r.status==="pending") buttons=`<button class="button button-outline button-small" data-action="simulate-approval" data-id="${p.id}">Simulate host approval</button>`;
        if(r.status==="approved") buttons=`<button class="button button-dark button-small" data-action="pay-deposit" data-id="${p.id}">Pay ${money(r.deposit||DEFAULT_DEPOSIT)} deposit</button>`;
        if(r.status==="confirmed") buttons=`<button class="button button-dark button-small" data-action="open-lobby" data-id="${p.id}">Open lobby</button>`;
        if(r.status==="waitlisted") buttons=`<button class="button button-outline button-small" disabled>Waiting for a spot</button>`;
        return `<article class="activity-card"><div class="activity-thumb cover-${p.type}">${typeSymbol(p.type)}</div><div class="activity-details"><h3>${escapeHTML(p.title)}</h3><p>${escapeHTML(p.area)} · ${escapeHTML(fmtDate(p.date))} · Host: ${escapeHTML(p.host)}</p><span class="activity-status ${r.status}">${escapeHTML(statusLabel(r.status))}</span><div class="activity-actions">${buttons}<button class="text-link" data-action="report" data-id="${p.id}">Report</button></div></div></article>`;
      }).join("");
    }
    if(!hosting.length){
      $("#hosting-panel").innerHTML='<div class="empty-panel"><b>You have not hosted a plan</b>Create a plan and invite people to join your lobby.<br><br><button class="button button-outline button-small" data-action="go" data-view="create">Create a plan</button></div>';
    } else {
      $("#hosting-panel").innerHTML=hosting.map(p=>{
        const incoming=state.hostedRequests.filter(r=>r.planId===p.id&&r.status==="pending");
        return `<article class="activity-card"><div class="activity-thumb cover-${p.type}">${typeSymbol(p.type)}</div><div class="activity-details"><h3>${escapeHTML(p.title)}</h3><p>${escapeHTML(p.area)} · ${escapeHTML(fmtDate(p.date))} · ${Math.max(0,p.spots-p.joined)} spots left</p><span class="activity-status approved">${p.status==="locked"?"Lobby locked":"Published"}</span><div class="activity-actions"><button class="button button-outline button-small" data-action="add-demo-request" data-id="${p.id}">＋ Add demo request</button><button class="button button-dark button-small" data-action="open-lobby" data-id="${p.id}">Open lobby</button></div>
        ${incoming.map(r=>`<div class="incoming-request"><b>${escapeHTML(r.name)}</b> <span>· ${escapeHTML(r.note||"Wants to join")}</span><div class="activity-actions"><button class="button button-dark button-small" data-action="host-approve" data-id="${r.id}">Approve</button><button class="button button-outline button-small" data-action="host-decline" data-id="${r.id}">Decline</button></div></div>`).join("")}
        </div></article>`;
      }).join("");
    }
    $("#nav-activity-dot").classList.toggle("hidden",!joining.some(r=>r.status==="pending")&&!state.hostedRequests.some(r=>r.status==="pending"));
  }
  function renderLobby(planId){
    const p=planById(planId); if(!p){go("activity");return;}
    const isHost=p.createdBy==="me";
    const r=myRequest(planId);
    const confirmed=isHost || r?.status==="confirmed";
    if(!confirmed){go("activity");toast("Your spot must be confirmed before opening the lobby.");return;}
    const messages=state.chats[planId]||[
      {name:p.host,text:"Welcome to the Kikao lobby. Please confirm arrival details and keep the group updated.",mine:false},
      {name:"Kikao Safety",text:"Keep the exact meetup details within this approved lobby. Never share payment PINs.",mine:false}
    ];
    state.chats[planId]=messages; save();
    $("#lobby-content").innerHTML=`<div class="lobby-head"><button class="back-button" data-action="go" data-view="activity">‹</button><div class="lobby-title"><h2>${escapeHTML(p.title)}</h2><p>${escapeHTML(p.area)} · ${escapeHTML(fmtDate(p.date))} · ${escapeHTML(p.time)}</p></div><span class="status-chip">${p.status==="locked"?"FULL / LOCKED":"ACTIVE LOBBY"}</span></div>
      ${p.status==="locked"?'<div class="locked-banner">🔒 This lobby is full. New join requests are closed; additional users can join the waitlist.</div>':""}
      <div class="lobby-layout"><section class="chat-panel"><div class="chat-top"><div><b>Plan conversation</b><br><small>${p.joined} confirmed participant(s) · Host: ${escapeHTML(p.host)}</small></div><span class="verified-mini">● Private</span></div>
      <div class="chat-messages" id="chat-messages">${messages.map(m=>`<div class="chat-message ${m.mine?"mine":""}"><b>${escapeHTML(m.name)}</b><span class="chat-bubble">${escapeHTML(m.text)}</span></div>`).join("")}</div>
      <form class="chat-compose" id="chat-form"><input name="message" maxlength="300" placeholder="Message your crew…" autocomplete="off" required><button type="submit">Send</button></form></section>
      <aside class="lobby-info"><h3>Plan details</h3>
        <div class="lobby-info-row"><span>Area</span><b>${escapeHTML(p.area)}</b></div>
        <div class="lobby-info-row"><span>Exact venue</span><b>${escapeHTML(p.venue||"Shared by host")}</b></div>
        <div class="lobby-info-row"><span>Budget estimate</span><b>${money(p.budget)}</b></div>
        <div class="lobby-info-row"><span>Drinks</span><b>${escapeHTML(p.drinks||"N/A")}</b></div>
        ${p.type==="roadtrip"?`<div class="lobby-info-row"><span>Destination</span><b>${escapeHTML(p.destination||"TBC")}</b></div><div class="lobby-info-row"><span>Driver rule</span><b>Alcohol-free</b></div>`:""}
        <p>${escapeHTML(p.rules||"Respect the group and the venue.")}</p>
        <button class="button button-outline button-small" data-action="check-in" data-id="${p.id}">✓ Check in</button>
        <button class="button button-outline button-small" data-action="share-plan" data-id="${p.id}">↗ Share plan</button>
        <button class="button button-danger button-small" data-action="report" data-id="${p.id}">Report / block</button>
      </aside></div>`;
    const box=$("#chat-messages"); if(box)box.scrollTop=box.scrollHeight;
    $("#chat-form").addEventListener("submit",e=>{
      e.preventDefault(); const input=e.currentTarget.elements.message; const msg=input.value.trim(); if(!msg)return;
      state.chats[planId].push({name:currentUser(),text:msg,mine:true}); save(); renderLobby(planId);
    });
  }
  function beginJoin(planId){
    if(!state.profile?.verified){openOnboarding("Verify your profile before requesting a spot.");return;}
    const p=planById(planId); if(!p)return;
    const left=p.spots-p.joined;
    const status=left<=0?"waitlisted":"pending";
    if(myRequest(planId))return;
    state.requests.push({id:uid(),planId,status,deposit:DEFAULT_DEPOSIT,createdAt:Date.now()});
    save(); renderFeed(); renderActivity();
    toast(status==="waitlisted"?"You are on the waitlist.":"Join request sent to the host.");
    go("activity");
  }
  
function authErrorMessage(error) {
  const messages = {
    "auth/invalid-phone-number": "Enter a valid Kenyan phone number.",
    "auth/missing-phone-number": "Enter your phone number first.",
    "auth/too-many-requests": "Too many attempts. Please wait before trying again.",
    "auth/quota-exceeded": "The SMS verification quota has been reached. Try again later.",
    "auth/captcha-check-failed": "The security check failed. Refresh and try again.",
    "auth/invalid-app-credential": "Firebase could not validate this request. Check the authorised domain and reCAPTCHA.",
    "auth/invalid-verification-code": "That code is incorrect. Check the SMS and try again.",
    "auth/code-expired": "That verification code has expired. Request a new one.",
    "auth/network-request-failed": "Network error. Check your internet connection.",
    "auth/operation-not-allowed": "Phone authentication is not enabled in Firebase.",
    "auth/unauthorized-domain": "This website domain is not authorised in Firebase."
  };

  return messages[error?.code] ||
    error?.message ||
    "Phone verification failed. Please try again.";
}

function openOnboarding(message = "Create your profile to join Kikao.") {
  const existing = state.profile || {};
  const draft = {};

  showModal(`
    <div class="modal-kicker">WELCOME TO KIKAO</div>
    <h2>Meet your next crew.</h2>
    <p class="modal-sub">${escapeHTML(message)}
      Verify your phone number to create your profile.
    </p>

    <form id="onboard-form">
      <label class="field">
        <span>Your name</span>
        <input name="name" maxlength="40"
          value="${escapeHTML(existing.name || "")}"
          placeholder="e.g. Alex M." required>
      </label>

      <label class="field">
        <span>Phone number</span>
        <input name="phone" type="tel"
          value="${escapeHTML(existing.phone || "")}"
          placeholder="07XX XXX XXX"
          pattern="[+]?[0-9]{9,16}" required> 
      </label>

      <label class="field">
        <span>Age</span>
        <input name="age" type="number" min="${MIN_AGE}" max="100"
          value="${existing.age || ""}"
          placeholder="${MIN_AGE} or above" required>
      </label>

      <label class="check-row">
        <input type="checkbox" name="consent" required>
        <span>I agree to the community rules and consent to phone number verification.</span>
      </label>

      <div id="recaptcha-container"></div>
      <p id="auth-error" class="inline-note" role="alert"></p>

      <button class="button button-dark button-wide" type="submit">
        Send verification code →
      </button>
    </form>

    <p class="inline-note">
      Phone verification confirms control of your number. It does not establish legal identity.
    </p>
  `);

  $("#onboard-form").addEventListener("submit", async e => {
    e.preventDefault();

    const form = e.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const data = new FormData(form);
    const age = Number(data.get("age"));

    if (age < MIN_AGE) {
      toast(`You must be ${MIN_AGE}+ to use Kikao.`);
      return;
    }

    draft.name = String(data.get("name")).trim();
    draft.phone = String(data.get("phone")).trim();
    draft.age = age;

    button.disabled = true;
    button.textContent = "Sending verification code...";

    try {
      const result = await sendPhoneOtp(
        draft.phone,
        "recaptcha-container"
      );

      if (!result?.success) {
        throw new Error("Firebase could not send the verification code.");
      }

      showModal(`
        <div class="modal-kicker">PHONE VERIFICATION</div>
        <h2>Check your phone.</h2>
        <p class="modal-sub">
          Enter the six-digit code sent to
          <b>${escapeHTML(draft.phone)}</b>.
        </p>

        <form id="otp-form">
          <label class="field">
            <span>Verification code</span>
            <input name="code" type="text" inputmode="numeric"
              autocomplete="one-time-code" maxlength="6"
              pattern="[0-9]{6}" placeholder="000000" required>
          </label>

          <p id="otp-error" class="inline-note" role="alert"></p>

          <button class="button button-dark button-wide" type="submit">
            Verify phone number →
          </button>

          <button class="button button-outline button-wide"
            type="button" id="change-phone">
            Change phone number
          </button>
        </form>
      `);

      $("#change-phone").addEventListener("click", () => {
        openOnboarding("Update your details or use a different phone number.");
      });
      let authenticatedUser = null;
      $("#otp-form").addEventListener("submit", async otpEvent => {
        otpEvent.preventDefault();

        const otpForm = otpEvent.currentTarget;
        const otpButton = otpForm.querySelector('button[type="submit"]');
        const codeInput = otpForm.elements.code;
        const code = codeInput.value;

        otpButton.disabled = true;
        otpButton.textContent = authenticatedUser
          ? "Saving profile..."
          : "Verifying...";

        try {
          // Verify only once. Retain the authenticated user if saving fails.
          if (!authenticatedUser) {
            authenticatedUser = await verifyPhoneOtp(code);
          }

          otpButton.textContent = "Saving profile...";

          const savedProfile = await saveUserProfile({
            uid: authenticatedUser.uid,
            name: draft.name,
            phone: authenticatedUser.phoneNumber || draft.phone,
            age: draft.age
          });

          state.profile = savedProfile;
          save();

          closeModal();
          renderProfile();
          renderFeed();

          toast("Phone verified and profile saved successfully.");
        } catch (error) {
          console.error("Phone verification/profile save failed:", error);

          if (authenticatedUser) {
            // OTP succeeded; only the Firestore save needs retrying.
            codeInput.required = false;
            codeInput.disabled = true;

            $("#otp-error").textContent =
              `Phone verified, but profile saving failed: ${error.message}`;

            otpButton.disabled = false;
            otpButton.textContent = "Retry saving profile →";
          } else {
            $("#otp-error").textContent = authErrorMessage(error);

            otpButton.disabled = false;
            otpButton.textContent = "Verify phone number →";
          }
        }
      });

    } catch (error) {
      console.error("Phone OTP request failed:", error);
      $("#auth-error").textContent = authErrorMessage(error);

      if (button.isConnected) {
        button.disabled = false;
        button.textContent = "Send verification code →";
      }
    }
  });
}

  function openPayment({kind,amount,phone,onSuccess,planId}){
    const label=kind==="verification"?"Profile verification fee":"Refundable commitment deposit";
    showModal(`<div class="payment-brand">M-PESA · DEMO CHECKOUT</div><div class="modal-kicker">SECURE PAYMENT FLOW PREVIEW</div><h2>${label}</h2><div class="payment-amount">${money(amount)}</div><div class="payment-caption">${kind==="verification"?"One-time demo verification charge.":"Refund policy is a prototype placeholder; production terms must be explicit."}</div>
      <div class="payment-phone">STK Push destination: ${escapeHTML(phone||state.profile?.phone||"07XX XXX XXX")}</div>
      <div class="demo-warning"><b>Simulation only.</b> No STK Push will be sent and no money will move. This screen demonstrates the intended user flow only.</div>
      <button class="button button-dark button-wide" id="simulate-stk">Simulate STK Push <span>→</span></button>
      <p class="inline-note">In production, connect a licensed payment provider and verify the payment callback server-side. Never trust a client-side success state.</p>`);
    $("#simulate-stk").addEventListener("click",()=>{
      $("#modal-body").innerHTML=`<div class="payment-brand">M-PESA · DEMO PROMPT</div><div class="modal-success"><div class="success-mark">✓</div><h2>STK prompt simulated</h2><p class="modal-sub">A real integration would now ask the user to enter their M-Pesa PIN on their phone. This prototype does not contact Safaricom.</p><div class="payment-phone">${money(amount)} · ${escapeHTML(phone||state.profile?.phone||"phone number")}</div><button class="button button-dark button-wide" id="complete-payment">Simulate successful payment <span>→</span></button><button class="text-link" id="cancel-payment">Cancel</button></div>`;
      $("#complete-payment").addEventListener("click",()=>{
        state.payments.push({id:uid(),kind,amount,phone:phone||state.profile?.phone,status:"simulated_success",at:Date.now(),planId:planId||null});
        if(kind==="deposit"&&planId){
          const r=myRequest(planId); if(r)r.status="confirmed";
          const p=planById(planId); if(p){p.joined=Math.min(p.spots,p.joined+1);if(p.joined>=p.spots)p.status="locked";}
          state.chats[planId]=state.chats[planId]||[{name:"Kikao Safety",text:"You are confirmed. Keep your exact meetup details within this group.",mine:false}];
        }
        save(); closeModal(); if(onSuccess)onSuccess(); renderFeed(); renderActivity(); toast("Demo payment marked successful — no money was moved.");
      });
      $("#cancel-payment").addEventListener("click",closeModal);
    });
  }
  
  function createPlan(form){
    if(!state.profile?.verified){openOnboarding("Verify your profile before publishing a plan.");return;}
    const f=new FormData(form), type=String(f.get("type"));
    if(type==="roadtrip"&&!f.get("designatedDriver")){toast("Road trips require a confirmed alcohol-free designated driver.");return;}
    const spots=Number(f.get("spots")), budget=Number(f.get("budget"));
    if(!Number.isFinite(spots)||spots<2||spots>20||!Number.isFinite(budget)||budget<100){toast("Check the spots and budget fields.");return;}
    const p={id:uid(),title:String(f.get("title")).trim(),type,area:String(f.get("area")),date:String(f.get("date")),time:String(f.get("time")),budget,spots,joined:1,host:state.profile.name,hostVerified:true,drinks:type==="roadtrip"?"Non-alcoholic":String(f.get("drinks")),vibe:String(f.get("vibe")||"Meet new people"),venue:String(f.get("venue")||"Exact venue shared by host"),rules:String(f.get("rules")||"Respect the group and venue."),destination:String(f.get("destination")||""),transport:String(f.get("transport")||""),transportCost:Number(f.get("transportCost")||0),pickup:String(f.get("pickup")||""),designatedDriver:!!f.get("designatedDriver"),createdBy:"me",status:"open",members:[state.profile.name]};
    state.plans.unshift(p); save(); form.reset(); $("#create-date").min=dateISO(today); $("#create-type").dispatchEvent(new Event("change")); go("activity"); renderActivity("hosting"); toast("Your plan is live. Add a demo request to test host approval.");
  }
  function addDemoRequest(planId){
    const p=planById(planId); if(!p)return;
    if(state.hostedRequests.some(r=>r.planId===planId&&r.status==="pending")){toast("There is already a pending demo request.");return;}
    state.hostedRequests.push({id:uid(),planId,name:"Amina W.",note:"Verified profile · interested in joining",status:"pending"});
    save(); renderActivity("hosting"); toast("A demo join request arrived.");
  }
  function hostDecision(requestId,approve){
    const r=state.hostedRequests.find(x=>x.id===requestId); if(!r)return;
    const p=planById(r.planId); if(!p)return;
    if(approve&&p.joined>=p.spots){toast("This plan is full. Add the person to the waitlist instead.");return;}
    r.status=approve?"approved":"declined";
    if(approve){p.joined+=1;p.members.push(r.name);if(p.joined>=p.spots)p.status="locked";}
    save(); renderActivity("hosting"); renderFeed(); toast(approve?"Join request approved.":"Request declined.");
  }
  function simulateApproval(planId){
    const r=myRequest(planId); if(!r||r.status!=="pending")return;
    r.status="approved"; save(); renderActivity(); renderFeed(); toast("Demo host approved your request. Pay the deposit to confirm.");
  }
  function checkIn(planId){
    const p=planById(planId); if(!p)return;
    const r=myRequest(planId); const key=`checkin-${planId}`;
    const already=state[key];
    state[key]=already?"checked_out":"checked_in"; save();
    toast(already?"Check-out recorded in this demo.":"Check-in recorded. Stay with your crew.");
  }
  async function sharePlan(planId){
    const p=planById(planId)||state.plans[0]; if(!p)return;
    const text=`Kikao plan: ${p.title}\n${p.area} · ${fmtDate(p.date)} · ${p.time}\nHost: ${p.host}\nBudget estimate: ${money(p.budget)} per person\nExact meetup details are shared with approved participants only.`;
    try{
      if(navigator.share) await navigator.share({title:"Kikao plan",text});
      else if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);toast("Plan details copied.");}
      else showModal(`<h2>Share this plan</h2><p class="modal-sub">Copy these details to your trusted contact.</p><div class="share-box">${escapeHTML(text).replace(/\n/g,"<br>")}</div><button class="button button-dark button-wide" data-action="close-modal">Done</button>`);
    }catch(e){ if(e.name!=="AbortError")toast("Could not open sharing on this device."); }
  }
  function reportConcern(planId){
    const reportedPlan=planById(planId);
    const reportedHost=reportedPlan?.host||"Unknown profile";
    showModal(`<div class="modal-kicker">COMMUNITY SAFETY</div><h2>Report a concern</h2><p class="modal-sub">Choose the issue. This demo stores the report locally; it does not contact a moderation team.</p><form id="report-form"><label class="field"><span>Reason</span><select name="reason"><option>Unsafe behaviour</option><option>Harassment or unwanted contact</option><option>Fake profile or impersonation</option><option>Scam or payment request</option><option>Drink-spiking concern</option><option>Other</option></select></label><label class="field"><span>Details (optional)</span><textarea name="details" rows="3" maxlength="300" placeholder="Tell us what happened."></textarea></label><label class="check-row"><input type="checkbox" name="block"><span><b>Also block ${escapeHTML(reportedHost)}</b><small>Blocked hosts' plans will be hidden from your Discover feed on this device.</small></span></label><button class="button button-danger button-wide" type="submit">Submit demo report</button></form>`);
    $("#report-form").addEventListener("submit",e=>{e.preventDefault();const f=new FormData(e.currentTarget);state.reports.push({planId,reason:f.get("reason"),details:f.get("details"),at:Date.now()});if(f.get("block")&&reportedHost!=="Unknown profile"&&!state.blocked.includes(reportedHost))state.blocked.push(reportedHost);save();closeModal();renderFeed();toast(f.get("block")?"Report saved; profile blocked locally.":"Demo report saved locally.");});
  }
  function sos(){
    showModal(`<div class="modal-kicker">URGENT SAFETY</div><h2>Get to a safe place.</h2><p class="modal-sub">If you are in immediate danger, move to a staffed public place, alert someone you trust and contact local emergency services.</p><div class="demo-warning">In Kenya, commonly used emergency numbers include <b>999</b> and <b>112</b>. Confirm current local guidance before launch. This prototype cannot place an emergency call or track your location.</div><button class="button button-dark button-wide" data-action="close-modal">I understand</button>`);
  }
  function trustedContact(){
    showModal(`<div class="modal-kicker">SAFETY SETUP</div><h2>Add a trusted contact.</h2><p class="modal-sub">This person can receive your plan details when you share them. The demo stores this information only in this browser.</p><form id="trusted-form"><label class="field"><span>Contact name</span><input name="name" maxlength="40" value="${escapeHTML(state.trustedContact?.name||"")}" required></label><label class="field"><span>Phone number</span><input name="phone" type="tel" value="${escapeHTML(state.trustedContact?.phone||"")}" placeholder="07XX XXX XXX" required></label><button class="button button-dark button-wide" type="submit">Save trusted contact</button></form>`);
    $("#trusted-form").addEventListener("submit",e=>{e.preventDefault();const f=new FormData(e.currentTarget);state.trustedContact={name:String(f.get("name")).trim(),phone:String(f.get("phone")).trim()};save();closeModal();toast("Trusted contact saved on this device.");});
  }
  function editProfile(){
    if(!state.profile){openOnboarding();return;}
    showModal(`<div class="modal-kicker">PROFILE DETAILS</div><h2>Edit your profile.</h2><form id="edit-form"><label class="field"><span>Name</span><input name="name" value="${escapeHTML(state.profile.name)}" required maxlength="40"></label><label class="field"><span>Phone</span><input name="phone" value="${escapeHTML(state.profile.phone)}" required></label><label class="field"><span>Age</span><input name="age" type="number" min="${MIN_AGE}" value="${escapeHTML(state.profile.age)}" required></label><button class="button button-dark button-wide" type="submit">Save changes</button></form>`);
    $("#edit-form").addEventListener("submit",e=>{e.preventDefault();const f=new FormData(e.currentTarget);state.profile.name=String(f.get("name")).trim();state.profile.phone=String(f.get("phone")).trim();state.profile.age=Number(f.get("age"));save();closeModal();renderProfile();toast("Profile updated.");});
  }
  function resetDemo(){
    showModal(`<h2>Reset prototype data?</h2><p class="modal-sub">This clears your local profile, plans, requests, chat messages and simulated payments, then restores the sample Nairobi plans.</p><div class="modal-actions"><button class="button button-outline" data-action="close-modal">Cancel</button><button class="button button-danger" data-action="confirm-reset">Reset demo</button></div>`);
  }
  function confirmReset(){state=initialState();save();closeModal();renderProfile();renderFeed();go("discover");toast("Prototype reset.");}

  document.addEventListener("click",e=>{
    const b=e.target.closest("[data-action]"); if(!b)return;
    const a=b.dataset.action,id=b.dataset.id;
    if(a==="go")go(b.dataset.view);
    else if(a==="close-modal")closeModal();
    else if(a==="join")beginJoin(id);
    else if(a==="join-waitlist"){if(!state.profile?.verified){openOnboarding("Verify your profile before joining the waitlist.");return;}if(!myRequest(id)){state.requests.push({id:uid(),planId:id,status:"waitlisted",deposit:DEFAULT_DEPOSIT});save();renderFeed();renderActivity();toast("You have joined the waitlist.");}}
    else if(a==="simulate-approval")simulateApproval(id);
    else if(a==="pay-deposit")payDeposit(id);
    else if(a==="open-lobby"){window.activeLobbyId=id;go("lobby");}
    else if(a==="activity-tab")renderActivity(b.dataset.tab);
    else if(a==="add-demo-request")addDemoRequest(id);
    else if(a==="host-approve")hostDecision(id,true);
    else if(a==="host-decline")hostDecision(id,false);
    else if(a==="check-in")checkIn(id);
    else if(a==="share-plan")sharePlan(id);
    else if(a==="sos")sos();
    else if(a==="report")reportConcern(id);
    else if(a==="trusted-contact")trustedContact();
    else if(a==="edit-profile")editProfile();
    else if(a==="reset-demo")resetDemo();
    else if(a==="confirm-reset")confirmReset();
    else if(a==="clear-filters"){$("#search-input").value="";$("#type-filter").value="all";$("#budget-filter").value="all";renderFeed();}
  });
  $("#create-form").addEventListener("submit",e=>{e.preventDefault();createPlan(e.currentTarget);});
  ["search-input","type-filter","budget-filter"].forEach(id=>$("#"+id).addEventListener("input",renderFeed));
  $("#create-type").addEventListener("change",e=>{
    const isRoad=e.target.value==="roadtrip";
    $("#roadtrip-fields").classList.toggle("hidden",!isRoad);
    $("#drink-field").classList.toggle("hidden",isRoad);
    $("#designated-driver").required=isRoad;
  });
  $("#modal-backdrop").addEventListener("click",e=>{if(e.target.id==="modal-backdrop")closeModal();});
  document.addEventListener("keydown",e=>{if(e.key==="Escape")closeModal();});
  $("#create-date").min=dateISO(today); $("#create-date").value=dateISO(nextSaturday());
  if (state.profile?.verified && !state.profile?.uid) {
  state.profile.verified = false;
  save();
}
  // Render the current local state while Firebase restores authentication.
  renderProfile();
  renderFeed();

  // Restore the authenticated user's profile from Firestore.
  (async function restoreProfileOnStartup() {
    try {
      const user = await new Promise(resolve => {
        let unsubscribe = () => {};

        unsubscribe = observeAuthState(authUser => {
          unsubscribe();
          resolve(authUser);
        });
      });

      // No Firebase session: clear any locally cached verification.
      if (!user) {
        if (state.profile) {
          state.profile = null;
          save();
        }

        renderProfile();
        renderFeed();

        setTimeout(() => {
          openOnboarding(
            "Verify your phone number to unlock your Kikao profile."
          );
        }, 350);

        return;
      }

      // Firestore is the authoritative source for user profiles.
      const remoteProfile = await getUserProfile(user.uid);

      if (remoteProfile) {
        state.profile = remoteProfile;
        save();

        renderProfile();
        renderFeed();
        return;
      }

      // Migrate a previously verified local profile belonging
      // to the currently authenticated Firebase user.
      if (
        state.profile?.uid === user.uid &&
        state.profile?.verified
      ) {
        state.profile = await saveUserProfile(state.profile);
        save();

        renderProfile();
        renderFeed();
        return;
      }

      // Authenticated user without a Firestore profile.
      state.profile = null;
      save();

      renderProfile();
      renderFeed();

      setTimeout(() => {
        openOnboarding("Complete your Kikao profile.");
      }, 350);

    } catch (error) {
      console.error("Kikao profile restoration failed:", error);

      toast(
        "Unable to load your profile. Check your connection and reload."
      );
    }
  })();

  // Register the service worker.
  if (
    "serviceWorker" in navigator &&
    location.protocol !== "file:"
  ) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("./sw.js")
        .catch(error => {
          console.error("Service worker registration failed:", error);
        });
    });
  }
})();