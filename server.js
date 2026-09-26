const express = require('express');

const app = express();
app.use(express.json({ limit: '600kb' }));

const PORT = process.env.PORT || 8080;
const START = Date.now();

const contexts = {
  category: new Map(),
  merchant: new Map(),
  customer: new Map(),
  trigger: new Map()
};

// Conversation state and operational memory.
const conversations = new Map();
const sentSuppression = new Set();
const sentBodies = new Map();

function nowIso() { return new Date().toISOString(); }
function pct(x) { return `${Math.round(Math.abs(Number(x) || 0) * 100)}%`; }
function signedPct(x) {
  const n = Number(x) || 0;
  return `${n > 0 ? '+' : ''}${Math.round(n * 100)}%`;
}
function firstName(identity = {}) {
  if (identity.owner_first_name) return identity.owner_first_name;
  const n = identity.name || '';
  return n.replace(/^Dr\.\s*/i, '').split(/\s+/)[0] || 'there';
}
function merchantGreeting(merchant, category) {
  const f = firstName(merchant.identity || {});
  if (category?.slug === 'dentists') return `Dr. ${f}`;
  return f;
}
function clean(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }
function getCtx(scope, id) { return contexts[scope]?.get(id)?.payload || null; }
function getCategory(merchant) { return getCtx('category', merchant?.category_slug); }
function getCustomer(trigger) { return trigger?.customer_id ? getCtx('customer', trigger.customer_id) : null; }
function getDigestItem(category, id) {
  return (category?.digest || []).find(x => x.id === id) || null;
}
function activeOffer(merchant, terms = []) {
  const offers = (merchant?.offers || []).filter(o => String(o.status || 'active').toLowerCase() === 'active');
  if (!terms.length) return offers[0] || null;
  return offers.find(o => terms.some(t => String(o.title || '').toLowerCase().includes(t))) || offers[0] || null;
}
function signalText(merchant, needle) {
  return (merchant?.signals || []).find(s => String(s).toLowerCase().includes(needle));
}
function recentHistory(merchant) { return merchant?.conversation_history || []; }
function hasRecentMerchantReply(merchant) {
  return recentHistory(merchant).some(x => x.engagement === 'merchant_replied');
}
function language(customer, merchant) {
  return customer?.identity?.language_pref || (merchant?.identity?.languages || ['en'])[0];
}
function codeMix(customer, merchant, text) {
  const lang = language(customer, merchant).toLowerCase();
  if (lang.includes('hi') && !lang.includes('english')) return text;
  return text;
}

function offerTitle(category, merchant, preferredTerms = []) {
  const o = activeOffer(merchant, preferredTerms);
  if (o?.title) return o.title;
  const catOffer = (category?.offer_catalog || []).find(o => preferredTerms.some(t => String(o.title || '').toLowerCase().includes(t)));
  return catOffer?.title || null;
}

function compose(category, merchant, trigger, customer = null) {
  const k = trigger.kind;
  const p = trigger.payload || {};
  const name = merchantGreeting(merchant, category);
  const locality = merchant.identity?.locality || merchant.identity?.city || '';
  const customerName = customer?.identity?.name || 'there';
  const customerMode = trigger.scope === 'customer' || !!customer;
  let body = '';
  let cta = 'open_ended';
  let rationale = '';

  // Customer-facing flows.
  if (customerMode) {
    const pref = customer?.preferences?.preferred_slots || '';
    if (k === 'recall_due') {
      const slots = p.available_slots || [];
      const slotText = slots.slice(0, 2).map(s => s.label).join(' or ');
      const svc = String(p.service_due || 'your follow-up').replace(/_/g, ' ');
      body = `Hi ${customerName} 👋 ${merchant.identity?.name || 'The clinic'} here. Your ${svc} is due around ${p.due_date || 'now'}. ${slotText ? `I have ${slotText} available` : pref ? `I can work around your ${pref.replace(/_/g, ' ')} preference` : 'I can help find a convenient slot'}. Reply YES and I’ll help confirm it.`;
      cta = 'YES/NO';
      rationale = `Recall reminder anchored to the due date and the customer's recorded appointment preference/available slots.`;
    } else if (k === 'wedding_package_followup') {
      const days = p.days_to_wedding ?? '';
      body = `Hi ${customerName} 👋 ${merchant.identity?.name || 'Studio11'} here. Your wedding is on ${p.wedding_date || 'the saved date'}${days !== '' ? ` (${days} days away)` : ''}. Since your bridal trial is already done, this is a good window to start the ${String(p.next_step_window_open || '30-day prep').replace(/_/g, ' ')}. Want me to hold a slot and share the plan?`;
      cta = 'YES/NO';
      rationale = `Bridal follow-up uses the saved wedding date, completed trial, and next-step window.`;
    } else if (k === 'customer_lapsed_hard') {
      const days = p.days_since_last_visit;
      const focus = String(p.previous_focus || 'your previous goal').replace(/_/g, ' ');
      const trial = offerTitle(category, merchant, ['trial', 'first month']);
      body = `Hi ${customerName} 👋 ${merchant.identity?.name || 'the gym'} here. It’s been about ${days ?? 'a while'} days — no pressure, lapses happen. You were working on ${focus}; ${trial ? `we currently have ${trial}` : 'we can restart with a low-pressure session'}. Want me to help you pick a restart slot?`;
      cta = 'YES/NO';
      rationale = `Winback acknowledges the lapse without guilt and reconnects to the customer's recorded goal.`;
    } else if (k === 'trial_followup') {
      const opts = p.next_session_options || [];
      const slot = opts[0]?.label || 'the next available session';
      body = `Hi ${customerName} 👋 ${merchant.identity?.name || 'the studio'} here. You tried the session on ${p.trial_date || 'your trial date'}. The next recorded option is ${slot}. Want me to hold it for you?`;
      cta = 'YES/NO';
      rationale = `Trial follow-up uses the completed trial date and an actual next-session option.`;
    } else if (k === 'chronic_refill_due') {
      const meds = (p.molecule_list || []).join(', ');
      const address = p.delivery_address_saved ? ' Your saved delivery address is on file.' : '';
      body = `Namaste ${customerName}. ${merchant.identity?.name || 'Pharmacy'} here. Your monthly refill for ${meds || 'your regular medicines'} is due${p.stock_runs_out_iso ? ` by ${p.stock_runs_out_iso.slice(0,10)}` : ''}.${address} Reply CONFIRM if you want us to prepare the refill, or reply CHANGE if anything in the prescription has changed.`;
      cta = 'CONFIRM/CHANGE';
      rationale = `Refill reminder names the recorded molecules and due date, while avoiding any invented dosage or price.`;
    } else {
      body = `Hi ${customerName}, ${merchant.identity?.name || 'the business'} here. I have an update related to your recent visit. Would you like me to share the next step?`;
      cta = 'open_ended';
      rationale = `Customer message is limited to the available trigger context rather than inventing missing details.`;
    }
    return { body, cta, send_as: 'merchant_on_behalf', suppression_key: trigger.suppression_key || trigger.id, rationale };
  }

  // Merchant-facing flows.
  switch (k) {
    case 'research_digest': {
      const item = getDigestItem(category, p.top_item_id) || category?.digest?.[0];
      if (item) {
        const anchor = item.trial_n ? ` (n=${item.trial_n})` : '';
        body = `${name}, worth a look: ${item.title}. Source: ${item.source}${anchor}. ${item.actionable ? `Action: ${item.actionable}.` : ''} ${signalText(merchant, 'high_risk') ? 'This is especially relevant to the cohort flagged in your profile.' : ''} Want me to turn this into a 3-line patient/team note?`;
        rationale = `Uses the category digest's cited source and actionable item, then connects it to a merchant signal when present.`;
      } else {
        body = `${name}, I have a new ${category?.display_name || 'category'} research update. Want the key takeaway and practical action?`;
        rationale = 'Research trigger present but no digest item was supplied, so no citation was fabricated.';
      }
      break;
    }
    case 'regulation_change': {
      const item = getDigestItem(category, p.top_item_id) || category?.digest?.find(x => x.kind === 'compliance');
      const deadline = p.deadline_iso ? ` Deadline: ${p.deadline_iso}.` : '';
      body = `${name}, compliance heads-up: ${item?.title || 'a regulation update affects your category'}.${deadline} ${item?.source ? `Source: ${item.source}.` : ''} ${item?.summary || ''} Want me to turn the change into a short checklist for your team?`;
      rationale = `Compliance message leads with the supplied deadline and source, then offers a concrete implementation artifact.`;
      break;
    }
    case 'perf_dip': {
  const metric = p.metric || 'performance';

  const rawDelta =
    p.delta_pct ??
    p.drop_pct ??
    (
      p.current_value != null && p.previous_value != null
        ? (p.previous_value - p.current_value) / p.previous_value
        : null
    );

  const delta = rawDelta == null
    ? ''
    : `${Math.round(Math.abs(rawDelta) <= 1 ? rawDelta * 100 : rawDelta)}%`;

  const window = p.window
    ? String(p.window)
        .replace(/^last_/, '')
        .replace(/_/g, ' ')
    : 'recently';

  const base =
    p.previous_value != null
      ? ` (from ${p.previous_value} to ${p.current_value})`
      : '';

  body = `${name}, quick performance check: ${metric} is down ${delta} over the last ${window}${base}. I’d fix the largest friction point before adding spend. Want me to identify the most relevant profile/offer action from your current data?`;

  rationale =
    'Addresses the exact declining metric and supplied comparison window without inventing a cause.';
  break;
}
    case 'renewal_due': {
      body = `${name}, your ${p.plan || merchant.subscription?.plan || 'subscription'} renews in ${p.days_remaining ?? merchant.subscription?.days_remaining ?? 'a few'} days${p.renewal_amount ? ` at ₹${Number(p.renewal_amount).toLocaleString('en-IN')}` : ''}. If you want to continue, I can help you review what changed before renewal.`;
      cta = 'open_ended';
      rationale = 'Renewal nudge uses the supplied days remaining, plan and amount; no fabricated discount is offered.';
      break;
    }
    case 'festival_upcoming': {
      const offer = offerTitle(category, merchant, ['bridal', 'hair', 'spa', 'meal', 'pizza']);
      body = `${name}, ${p.festival || 'the upcoming festival'} is ${p.days_until != null ? `${p.days_until} days away` : 'coming up'} (${p.date || 'date not supplied'}). ${offer ? `You already have ${offer} active.` : 'I only see the offers currently in your profile.'} Want me to turn one existing service into a festival-ready WhatsApp message?`;
      rationale = 'Festival message anchors on the supplied date and only references an existing merchant offer.';
      break;
    }
    case 'curious_ask_due': {
      const sig = (category?.trend_signals || [])[0];
      body = sig ? `${name}, quick market pulse: “${sig.query}” is moving ${signedPct(sig.delta_yoy)} YoY${sig.segment_age ? ` for ${sig.segment_age}` : ''}. Worth testing against your current menu/profile. Want me to turn that signal into one concrete post idea?` : `${name}, quick question for this week: want one category-specific demand signal you can act on?`;
      rationale = 'Curiosity nudge uses a current category trend signal when available and asks for one low-friction next step.';
      break;
    }
    case 'winback_eligible': {
      body = `${name}, your winback window is active: ${p.lapsed_customers_added_since_expiry ?? 'some'} lapsed customers have been added since expiry, while performance is ${p.perf_dip_pct != null ? signedPct(p.perf_dip_pct) : 'down'}. I’d test a service-led reactivation message rather than a blanket discount. Want me to draft one using an existing offer?`;
      rationale = 'Winback combines the supplied lapse count and performance change and proposes a service-led reactivation.';
      break;
    }
    case 'ipl_match_today': {
      const weekday = p.is_weeknight ? 'weekday' : 'weekend';
      const offer = offerTitle(category, merchant, ['pizza', 'combo', 'meal']);
      body = `${name}, ${p.match || 'today’s match'} is at ${p.venue || 'the stadium'}${p.match_time_iso ? ` at ${p.match_time_iso.slice(11,16)}` : ''} — ${weekday}. ${offer ? `You have ${offer} active.` : 'I don’t see a match-specific offer in the current profile.'} I’d only push an IPL message if you can fulfill the expected dinner-time demand. Want a concise match-day post?`;
      rationale = 'Match trigger is treated as a demand opportunity, but the message avoids inventing a promotion and includes a fulfillment caveat.';
      break;
    }
    case 'review_theme_emerged': {
      body = `${name}, one review pattern is now recurring: “${p.theme || 'a service issue'}” appeared ${p.occurrences_30d ?? 'several'} times in 30d and the trend is ${p.trend || 'emerging'}. The quote is: “${p.common_quote || 'customer feedback'}”. Want me to draft a reply template plus one operational fix?`;
      rationale = 'Review message uses the exact theme, frequency and supplied customer quote, turning the signal into a response artifact.';
      break;
    }
    case 'milestone_reached': {
      body = `${name}, you’re at ${p.value_now ?? 'the current'} ${p.metric || 'milestone'}${p.milestone_value ? ` — only ${Math.max(0, Number(p.milestone_value) - Number(p.value_now || 0))} to reach ${p.milestone_value}` : ''}. That’s a useful point to refresh the profile proof around your strongest service. Want me to draft the update?`;
      rationale = 'Milestone message uses the exact current value and remaining gap when supplied.';
      break;
    }
    case 'active_planning_intent': {
      const topic = String(p.intent_topic || 'the idea').replace(/_/g, ' ');
      if (topic.includes('corporate_bulk_thali')) {
        const priceOffer = offerTitle(category, merchant, ['thali', 'meal', 'dosa']);
        body = `${name}, yes — here’s a starter structure for the ${topic}: define 2–3 quantity tiers, a clear per-head price, delivery/pickup cutoff, and one office-friendly add-on. ${priceOffer ? `You can anchor it around your existing ${priceOffer}.` : ''} Want me to turn this into a ready-to-send 4-line office WhatsApp?`;
      } else {
        body = `${name}, yes — let’s turn the ${topic} into something launchable. I’d define the audience, session/service format, price, capacity and a simple trial CTA first. Want me to draft the actual offer copy from your current catalog?`;
      }
      rationale = 'Merchant explicitly expressed planning intent, so the response advances directly to an actionable draft instead of asking another qualification question.';
      break;
    }
    case 'seasonal_perf_dip': {
      body = `${name}, your ${p.metric || 'views'} are ${signedPct(p.delta_pct)} this week, but the trigger marks this as an expected seasonal dip (${p.season_note || 'current seasonal window'}). I’d protect retention and avoid reacting with unnecessary spend. Want a simple retention campaign built around your existing membership base?`;
      rationale = 'Reframes an explicitly expected seasonal decline and recommends a lower-risk retention action.';
      break;
    }
    case 'supply_alert': {
      const batches = (p.affected_batches || []).join(', ');
      const agg = merchant.customer_aggregate?.total_unique_ytd;
      body = `${name}, supply alert: ${p.molecule || 'a medicine'} — batches ${batches || 'listed in the alert'} from ${p.manufacturer || 'the supplied manufacturer'} are affected. Check stock and dispensing records for those batch numbers before further action. ${agg ? `Your profile shows ${agg} unique customers YTD.` : ''} Want me to draft a customer notice + internal batch-check checklist?`;
      rationale = 'Compliance-oriented pharmacy message uses the supplied molecule, manufacturer and batch numbers and avoids inventing a risk level.';
      break;
    }
    case 'category_seasonal': {
      const trends = (p.trends || []).join(', ');
      body = `${name}, summer shelf signal: ${trends || 'seasonal demand is shifting'}. The trigger recommends a shelf action. I’d prioritize the rising categories before the falling cold/cough demand. Want me to turn this into a 3-point shelf checklist?`;
      rationale = 'Uses the supplied seasonal demand movements and follows the explicit shelf-action recommendation.';
      break;
    }
    case 'gbp_unverified': {
      body = `${name}, your Google Business Profile is still unverified. The available verification path is ${p.verification_path || 'the recorded verification flow'}${p.estimated_uplift_pct ? `; the trigger estimates up to ${pct(p.estimated_uplift_pct)} uplift.` : '.'} Want me to walk you through the verification steps?`;
      rationale = 'GBP message states the exact verification status and supplied path without presenting the uplift estimate as guaranteed.';
      break;
    }
    case 'cde_opportunity': {
      body = `${name}, there’s a category-development opportunity: ${p.digest_item_id || 'a new digest item'} offers ${p.credits ?? ''} credits and is ${p.fee || 'available'}. If this fits your practice, I can turn the details into a short action checklist.`;
      rationale = 'Uses the supplied opportunity, credits and fee rather than inventing event details.';
      break;
    }
    case 'competitor_opened': {
      body = `${name}, a new nearby competitor is listed: ${p.competitor_name || 'a competitor'} at ${p.distance_km ?? '?'} km, opened ${p.opened_date || 'recently'}, with ${p.their_offer || 'an offer shown in the trigger'}. I wouldn’t copy it blindly; want me to compare it with your current active offer and identify one defensible positioning angle?`;
      rationale = 'Competitive alert is factual and anchored to the supplied distance, date and offer; it avoids unsupported claims about the competitor.';
      break;
    }
    case 'perf_spike': {
      body = `${name}, ${p.metric || 'performance'} are up ${pct(p.delta_pct)} over ${p.window || 'the current window'} vs baseline ${p.vs_baseline ?? 'the recorded baseline'}. The trigger points to ${p.likely_driver || 'a likely driver'}. Want me to turn that driver into one repeatable post/offer?`;
      rationale = 'Celebrates the measured spike while preserving the supplied likely driver and baseline.';
      break;
    }
    case 'dormant_with_vera': {
      body = `${name}, it’s been ${p.days_since_last_merchant_message ?? 'a while'} days since we last spoke${p.last_topic ? ` — last time we were on ${String(p.last_topic).replace(/_/g, ' ')}` : ''}. I’ve got a fresh, concrete next step rather than another generic check-in. Want it?`;
      rationale = 'Re-engagement references the recorded dormancy interval and prior topic, creating curiosity without pretending new facts.';
      break;
    }
    default: {
      const metric = p.metric || merchant.performance?.views != null ? 'performance' : 'business';
      body = `${name}, I have a ${String(k || 'new').replace(/_/g, ' ')} update for ${merchant.identity?.name || 'your business'}${locality ? ` in ${locality}` : ''}. Want me to turn the available context into one concrete next step?`;
      rationale = `Generic fallback for trigger ${k || 'unknown'}; only supplied context is referenced.`;
    }
  }

  return { body: clean(body), cta, send_as: 'vera', suppression_key: trigger.suppression_key || trigger.id, rationale };
}

function conversationId(merchantId, triggerId, customerId) {
  return `conv_${merchantId}_${customerId || 'merchant'}_${triggerId}`;
}

function isAutoReply(msg) {
  const s = String(msg || '').trim().toLowerCase();

  if (!s || s.length < 10) return false;

  const markers = [
    'thank you for contacting',
    'thanks for contacting',
    'will get back to you',
    'currently unavailable',
    'automated reply',
    'automatic reply',
    'auto reply',
    'do not reply',
    "don't reply",
    'do not respond',
    "don't respond",
    'no reply',
    'please do not reply',
    'please do not respond',
    'this is an automated message'
  ];

  return markers.some(m => s.includes(m));
}
function classifyReply(msg) {
  const s = String(msg || '').trim().toLowerCase();
  if (!s) return 'empty';
  if (isAutoReply(s)) return 'auto';
  if (/^(no|nope|nah|not interested|stop|don't|dont|leave me alone|unsubscribe)\b/.test(s) || s.includes('not interested')) return 'no';
  if (/\b(ok|okay|yes|yep|yeah|sure|do it|let's do it|lets do it|go ahead|send it|confirm|confirmed|book it)\b/.test(s)) return 'yes';
  if (/\b(what|how|why|when|where|price|cost|details|can you explain|tell me more)\b/.test(s) || s.endsWith('?')) return 'question';
  if (/\b(wait|later|busy|tomorrow|next week|give me time)\b/.test(s)) return 'wait';
  if (/\b(gst|tax|unrelated|different question)\b/.test(s)) return 'offtopic';
  return 'other';
}

function replyFor(conv, input) {
  const kind = classifyReply(input.message);
  const state = conversations.get(input.conversation_id) || {};
  const last = state.lastAction || {};
  const merchant = getCtx('merchant', input.merchant_id) || {};
  const category = getCategory(merchant) || {};

  if (kind === 'auto') {
    const count = (state.autoReplies || 0) + 1;
    state.autoReplies = count;
    if (count >= 2) return { action: 'end', rationale: 'Detected repeated WhatsApp canned auto-replies; stopping instead of burning turns.' };
    return { action: 'wait', wait_seconds: 3600, rationale: 'Detected a likely canned WhatsApp auto-reply; backing off instead of treating it as merchant intent.' };
  }
  if (kind === 'no') {
    return { action: 'end', rationale: 'Merchant/customer declined; conversation ends without pressure.' };
  }
  if (kind === 'wait') {
    return { action: 'wait', wait_seconds: 1800, rationale: 'The recipient asked for time; respecting the request and backing off.' };
  }
  if (kind === 'offtopic') {
    return { action: 'send', body: `I can help with the ${category.display_name || 'merchant-growth'} task we were discussing. For the unrelated request, I don’t have enough context here. Want to continue with the current task?`, cta: 'open_ended', rationale: 'Stayed on the active merchant-growth mission without inventing capability or facts.' };
  }
  if (kind === 'yes') {
    if (last.intent === 'active_planning_intent') {
      return { action: 'send', body: `Perfect — I’ll treat that as a go-ahead. I’ll keep the next step focused on the concrete draft we just discussed rather than asking another qualification question.`, cta: 'open_ended', rationale: 'Explicit yes after planning intent is converted immediately into action.' };
    }
    return { action: 'send', body: `Perfect — got it. I’ll keep this focused on the next concrete step from the ${category.display_name || 'current'} context.`, cta: 'open_ended', rationale: 'Acknowledged explicit acceptance and advanced the conversation instead of re-qualifying.' };
  }
  if (kind === 'question') {
    return { action: 'send', body: `Good question. Based on the context I have for ${merchant.identity?.name || 'your business'}, I can answer the part supported by your current data. Tell me which detail you want first — price, timing, or the next step.`, cta: 'open_ended', rationale: 'Answers within available context and asks one focused clarification rather than fabricating details.' };
  }
  return { action: 'send', body: `Got it. For ${merchant.identity?.name || 'your business'}, I’d keep the next step tied to the trigger we just discussed. Want me to make the draft/action more specific?`, cta: 'open_ended', rationale: 'Acknowledged the response and advanced the active task without inventing missing facts.' };
}

app.get('/v1/healthz', (req, res) => {
  const counts = {};
  for (const s of Object.keys(contexts)) counts[s] = contexts[s].size;
  res.status(200).json({ status: 'ok', uptime_seconds: Math.floor((Date.now() - START) / 1000), contexts_loaded: counts });
});

app.get('/v1/metadata', (req, res) => {
  res.status(200).json({
    team_name: 'Ishita',
    team_members: ['Ishita'],
    model: 'deterministic-context-engine',
    approach: 'deterministic trigger-aware merchant/customer composer with stateful reply handling',
    contact_email: '',
    version: '1.0.0',
    submitted_at: nowIso()
  });
});

app.post('/v1/context', (req, res) => {
  const { scope, context_id, version, payload, delivered_at } = req.body || {};
  if (!scope || !context_id || !Number.isInteger(version) || payload === undefined) {
    return res.status(400).json({ accepted: false, reason: 'invalid_context', details: 'scope, context_id, integer version and payload are required' });
  }
  if (!contexts[scope]) return res.status(400).json({ accepted: false, reason: 'invalid_scope', details: scope });
  const existing = contexts[scope].get(context_id);
  if (existing && version < existing.version) {
  return res.status(409).json({
    accepted: false,
    reason: 'stale_version',
    current_version: existing.version
  });
}

if (existing && version === existing.version) {
  return res.status(200).json({
    accepted: true,
    ack_id: `ack_${context_id}_v${version}`,
    stored_at: new Date().toISOString(),
    no_op: true
  });
}
  contexts[scope].set(context_id, { version, payload, delivered_at });
  return res.status(200).json({ accepted: true, ack_id: `ack_${context_id}_v${version}`, stored_at: nowIso() });
});

app.post('/v1/tick', (req, res) => {
  const { now, available_triggers = [] } = req.body || {};
  const actions = [];
  for (const triggerId of available_triggers.slice(0, 20)) {
    const trigger = getCtx('trigger', triggerId);
    if (!trigger) continue;
    const merchantId = trigger.merchant_id || trigger.payload?.merchant_id;
    const merchant = getCtx('merchant', merchantId);
    if (!merchant) continue;
    const category = getCategory(merchant);
    if (!category) continue;
    const customer = trigger.customer_id ? getCtx('customer', trigger.customer_id) : null;
    const suppression = trigger.suppression_key || trigger.id;
    if (sentSuppression.has(suppression)) continue;
    const composed = compose(category, merchant, trigger, customer);
    if (!composed.body) continue;
    const cid = conversationId(merchantId, trigger.id, trigger.customer_id);
    if (conversations.has(cid)) continue;
    conversations.set(cid, { merchantId, customerId: trigger.customer_id || null, triggerId: trigger.id, lastAction: { intent: trigger.kind, body: composed.body }, history: [], autoReplies: 0 });
    sentSuppression.add(suppression);
    sentBodies.set(cid, [composed.body]);
    actions.push({
      conversation_id: cid,
      merchant_id: merchantId,
      customer_id: trigger.customer_id || null,
      send_as: composed.send_as,
      trigger_id: trigger.id,
      template_name: trigger.scope === 'customer' ? 'merchant_customer_v1' : 'vera_context_v1',
      template_params: [customer?.identity?.name || merchant.identity?.name || '', trigger.kind, suppression],
      body: composed.body,
      cta: composed.cta,
      suppression_key: composed.suppression_key,
      rationale: composed.rationale
    });
    if (actions.length >= 20) break;
  }
  res.status(200).json({ actions });
});

app.post('/v1/reply', (req, res) => {
  const b = req.body || {};
  if (!b.conversation_id || typeof b.message !== 'string') return res.status(400).json({ action: 'end', rationale: 'Invalid reply payload.' });
  const state = conversations.get(b.conversation_id) || { history: [], autoReplies: 0 };
  conversations.set(b.conversation_id, state);
  state.history = state.history || [];
  state.history.push({ from: b.from_role, body: b.message, ts: b.received_at || nowIso() });
  const out = replyFor(state, b);
  if (out.action === 'send') {
    const prev = sentBodies.get(b.conversation_id) || [];
    if (prev.includes(out.body)) {
      out.body = `Understood. I’ll keep the next step specific to the current task for ${state.merchantId || 'your business'}.`;
    }
    prev.push(out.body);
    sentBodies.set(b.conversation_id, prev);
    state.lastAction = { intent: 'reply', body: out.body };
  }
  conversations.set(b.conversation_id, state);
  res.status(200).json(out);
});

app.post('/v1/teardown', (req, res) => {
  for (const scope of Object.keys(contexts)) contexts[scope].clear();
  conversations.clear(); sentSuppression.clear(); sentBodies.clear();
  res.status(200).json({ ok: true });
});

app.use((req, res) => res.status(404).json({ error: 'not_found' }));

app.listen(PORT, '0.0.0.0', () => console.log(`Vera bot running on port ${PORT}`));
